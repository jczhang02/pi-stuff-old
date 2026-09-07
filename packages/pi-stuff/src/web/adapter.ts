import type { AgentToolResult, ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { TSchema } from "typebox";
import { type EffectFoundation, installEffectFoundation } from "../shared/effect-foundation.ts";
import { readHostProxyProperty } from "../shared/host-proxy.ts";
import { registerSuiteOwnedTool, type SuiteToolRegistrationHost } from "../tool-display/index.ts";
import { FakeIpCompatibility } from "./fake-ip.ts";
import { WEB_CONTENT_PRESENTATION, WEB_FETCH_PRESENTATION, WEB_SEARCH_PRESENTATION } from "./presentation.ts";
import piWebAccess, { type PiWebAccessHost, WebContentSessionError } from "./runtime/index.js";
import { WebSettingsStore } from "./settings.ts";
import { WEB_CONTENT_PARAMETERS, WEB_FETCH_PARAMETERS, WEB_SEARCH_PARAMETERS } from "./tool-contracts.ts";
import { validateWebFetchInput } from "./url-policy.ts";

type CapturedTool = ToolDefinition<TSchema, unknown, unknown>;
type SharedToolFields = Pick<CapturedTool, "label" | "name"> &
	Partial<Pick<CapturedTool, "constrainedSampling" | "executionMode">>;
export type WebAdapterHost = SuiteToolRegistrationHost;
export type WebCapabilityHost = WebAdapterHost & PiWebAccessHost & Pick<ExtensionAPI, "events" | "on">;

function errorResult(error: string): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: `Error: ${error}` }],
		details: { error },
	};
}

function sharedToolFields(upstream: CapturedTool) {
	const fields: SharedToolFields = {
		label: upstream.label,
		name: upstream.name,
	};
	if (upstream.constrainedSampling !== undefined) fields.constrainedSampling = upstream.constrainedSampling;
	if (upstream.executionMode !== undefined) fields.executionMode = upstream.executionMode;
	return fields;
}

function registerSearch(pi: SuiteToolRegistrationHost, upstream: CapturedTool): void {
	const tool: ToolDefinition<typeof WEB_SEARCH_PARAMETERS, unknown> = {
		...sharedToolFields(upstream),
		description:
			"Search the web with one to four focused queries. Returns synthesized answers and source URLs. Provider may be selected explicitly; omit it to use configured routing.",
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			upstream.execute(toolCallId, params, signal, onUpdate, ctx),
		parameters: WEB_SEARCH_PARAMETERS,
		promptSnippet: "Search current public web sources; use 2-4 distinct queries when multiple angles matter.",
	};
	registerSuiteOwnedTool(pi, tool, WEB_SEARCH_PRESENTATION);
}

function registerFetch(pi: SuiteToolRegistrationHost, upstream: CapturedTool): void {
	const tool: ToolDefinition<typeof WEB_FETCH_PARAMETERS, unknown> = {
		...sharedToolFields(upstream),
		description:
			"Read one or more public HTTP(S) pages as bounded text. PDFs are converted to a temporary Markdown file whose path is returned for the read Tool. Use raw only for exact textual HTTP response bodies.",
		execute: async (toolCallId, params, signal, onUpdate, ctx) => {
			const validation = validateWebFetchInput(params);
			if (!validation.ok) return errorResult(validation.error);
			return await upstream.execute(toolCallId, validation.input, signal, onUpdate, ctx);
		},
		parameters: WEB_FETCH_PARAMETERS,
		promptSnippet:
			"Read public HTTP(S) pages and PDFs; use read on a returned PDF Markdown path, or get_search_content for later page slices.",
	};
	registerSuiteOwnedTool(pi, tool, WEB_FETCH_PRESENTATION);
}

function registerContinuation(pi: SuiteToolRegistrationHost, upstream: CapturedTool): void {
	const tool: ToolDefinition<typeof WEB_CONTENT_PARAMETERS, unknown> = {
		...sharedToolFields(upstream),
		description: "Retrieve one bounded slice or matching passage from a previous web search or document read result.",
		execute: (toolCallId, params, signal, onUpdate, ctx) =>
			upstream.execute(toolCallId, params, signal, onUpdate, ctx),
		parameters: WEB_CONTENT_PARAMETERS,
		promptSnippet: "Continue a previous web result by responseId; prefer findText over manual paging.",
	};
	registerSuiteOwnedTool(pi, tool, WEB_CONTENT_PRESENTATION);
}

function registerSelectedTool(pi: SuiteToolRegistrationHost, tool: CapturedTool): void {
	switch (tool.label) {
		case "Web Search":
			registerSearch(pi, tool);
			break;
		case "Fetch Content":
			registerFetch(pi, tool);
			break;
		case "Get Search Content":
			registerContinuation(pi, tool);
			break;
		default:
			// Source Check and future broad surfaces are intentionally not Suite Tools.
			break;
	}
}

/** Build the narrow host facade supplied to the pinned fork. */
export function createWebAdapterApi<Host extends WebAdapterHost>(pi: Host): Host {
	// SAFETY: the fork calls registerTool with ToolDefinition values; this facade only narrows which labels are installed.
	const registerTool = ((tool: CapturedTool) => registerSelectedTool(pi, tool)) as ExtensionAPI["registerTool"];
	return new Proxy(pi, {
		get(target, property) {
			if (property === "registerTool") return registerTool;
			return readHostProxyProperty(target, property);
		},
	});
}

export async function runWebContentOperation<A, E, Result>(
	foundation: EffectFoundation,
	ctx: ExtensionContext,
	program: Effect.Effect<A, E>,
	handlers: { readonly interrupted?: () => Result; readonly success: (value: A) => Result },
	signal?: AbortSignal | undefined,
): Promise<Result> {
	const session = foundation.sessionFor(ctx.sessionManager);
	if (!session || !foundation.isCurrent(session)) {
		throw new WebContentSessionError("Web operation is unavailable before Session start.");
	}
	const operation = foundation.forkOperation(session);
	const exit = await foundation.run(operation, program, { signal });
	await foundation.close(operation, exit);
	if (!foundation.isCurrent(session)) throw new WebContentSessionError("Web operation belongs to a stale Session.");
	if (signal?.aborted || (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))) {
		if (handlers.interrupted) return handlers.interrupted();
		throw new DOMException("This operation was aborted", "AbortError");
	}
	if (Exit.isFailure(exit)) {
		throw Cause.squash(exit.cause);
	}
	return handlers.success(exit.value);
}

/** Installation performs configuration reads only; all external work stays Tool-triggered. */
export async function installWebCapability(pi: WebCapabilityHost): Promise<void> {
	const settings = await Effect.runPromise(WebSettingsStore.load());
	// SAFETY: this Capability facade supplies the event bus and lifecycle registration used by the Foundation installer.
	const foundation = installEffectFoundation(pi as ExtensionAPI);
	const fakeIpCompatibility = new FakeIpCompatibility();
	piWebAccess(createWebAdapterApi(pi), {
		prepareFetch: (input) => fakeIpCompatibility.prepare(input),
		readSettings: () => settings.get(),
		runContentOperation: (ctx, program, handlers, signal) =>
			runWebContentOperation(foundation, ctx, program, handlers, signal),
	});
}
