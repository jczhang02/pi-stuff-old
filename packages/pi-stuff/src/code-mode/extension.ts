import type { AgentToolResult, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonInputObject, JsonInputValue } from "../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolArguments } from "../tool-display/activity.ts";
import type { SuiteToolEnvelopeOperation, SuiteToolPresentation } from "../tool-display/contract.ts";
import { TOOL_DISPLAY_ITEM_LIMIT } from "../tool-display/limits.ts";
import { registerSuiteToolEnvelope, registerSuiteToolEnvelopeCompanion } from "../tool-display/registration.ts";
import { SuiteCodeModeConnector } from "./connector.ts";
import { CODE_MODE_TOOL_NAME, CodeModeControls, type CodeModeHost, type PiStuffCodeModeOptions } from "./controls.ts";
import { INVALID_CODE_MODE_IMAGE_MESSAGE, sanitizeCodeModeContent } from "./image-content.ts";
import { CodeModeSessionLedger } from "./ledger.ts";
import {
	captureCodeModeModelContent,
	decodeCodeModeMediaSegments,
	isCodeModeModelContentOwner,
	isCodeModeToolContent,
	rehydrateCodeModeMessages,
	separateCodeModeMediaForUi,
} from "./presentation.ts";
import { CodeModeRuntime, type PiStuffCodeModeDetails } from "./runtime.ts";
import { projectCodeModeSearchResponse } from "./search-response.ts";
import { registerCodeModeSkillDiscovery } from "./skill-discovery.ts";
import { V8CodeModeExecutor } from "./v8-executor.ts";

export type { CodeModeHost, PiStuffCodeModeOptions } from "./controls.ts";
export { CODE_MODE_TOOL_NAME, compensateCodeModeExecution } from "./controls.ts";
export const CODE_MODE_SEARCH_TOOL_NAME = "tool_search";
export const CODE_MODE_PROVIDER_TOOL_NAMES = [CODE_MODE_TOOL_NAME, CODE_MODE_SEARCH_TOOL_NAME] as const;

const CODE_MODE_PARAMETERS = Type.Object(
	{
		code: Type.String({ description: "JavaScript source only; no JSON wrapper or Markdown fence" }),
	},
	{ additionalProperties: false },
);

const CODE_MODE_SEARCH_PARAMETERS = Type.Object(
	{ query: Type.String({ description: 'Short intent phrase, e.g. "view image"' }) },
	{ additionalProperties: false },
);

const CODE_MODE_DESCRIPTION = `Run JavaScript in isolated V8 and compose eligible Pi Stuff Tools through tools.*.
Rules:
- Write plain JavaScript with top-level await and await every tools.* call.
- Call only listed/searched methods, e.g. codemode.search("view image"). After context compaction, or if a name or field is unclear, call codemode.describe("tools.name"); never guess.
- Tool results are unwrapped to structured JSON when available, parsed JSON when valid, or text.
- Structured results are already unwrapped; do not pass them to JSON.parse. Example: const pkg = await tools.read({ path: "package.json" }); text(pkg.packageManager);
- Await ordinary Tool work normally. For one concrete observable command, file, log, or HTTP condition with a deadline, call tools.monitor(...) once; continue useful work and do not poll with Bash, sleep, status checks, or repeated turns.
- For an image Tool result, return await tools.view_image(...); never call image(result). image(...) is only for generated data URLs, image_url objects, or raw image blocks. Do not pass image Base64 through Bash.
Cloudflare-style async arrow functions with return and the legacy suite.* alias are accepted. tools.* and explicit helpers for non-Tool output are canonical. console is unavailable. The sandbox has no direct filesystem, network, process, Node, Bun, require, fetch, or credentials; I/O is only through tools.*. Other helpers include generatedImage, store, load, notify, exit, setTimeout, and clearTimeout.`;

export interface CodeModeSearchDetails {
	readonly paths: readonly string[];
	readonly query: string;
	readonly total: number;
	readonly truncated: boolean;
}

function matchSummary(total: number): string {
	return total === 1 ? "1 match" : `${String(total)} matches`;
}

export const CODE_MODE_SEARCH_PRESENTATION: SuiteToolPresentation<{ readonly query: string }, CodeModeSearchDetails> = {
	activity: {
		categories: ["search-tool"],
		classify: ({ args }) => [{ category: "search-tool", countKeys: [args.query], target: args.query }],
		silentSuccess: true,
	},
	detailLines: (_args, result) => {
		const paths = result.details.paths;
		const omitted = Math.max(0, result.details.total - paths.length);
		return [matchSummary(result.details.total), ...paths, ...(omitted > 0 ? [`… ${String(omitted)} more`] : [])];
	},
	label: "Tool search",
	runningSummary: "searching",
	summarize: (_args, result) => matchSummary(result.details.total),
	target: (args) => args.query,
};

type ToolUsage = NonNullable<AgentToolResult<unknown>["usage"]>;

function isRuntimeRecord<Value>(value: Value): value is Value & JsonInputObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function decodeToolUsage<Value>(value: Value): ToolUsage | undefined {
	if (!isRuntimeRecord(value)) return undefined;
	const { cacheRead, cacheWrite, cacheWrite1h, cost, input, output, reasoning, totalTokens } = value;
	if (!isRuntimeRecord(cost)) return undefined;
	const { cacheRead: costCacheRead, cacheWrite: costCacheWrite, input: costInput, output: costOutput, total } = cost;
	if (
		!isRuntimeNumber(cacheRead) ||
		!isRuntimeNumber(cacheWrite) ||
		!isRuntimeNumber(input) ||
		!isRuntimeNumber(output) ||
		!isRuntimeNumber(totalTokens) ||
		!isRuntimeNumber(costCacheRead) ||
		!isRuntimeNumber(costCacheWrite) ||
		!isRuntimeNumber(costInput) ||
		!isRuntimeNumber(costOutput) ||
		!isRuntimeNumber(total) ||
		(cacheWrite1h !== undefined && !isRuntimeNumber(cacheWrite1h)) ||
		(reasoning !== undefined && !isRuntimeNumber(reasoning))
	)
		return undefined;
	const usage: ToolUsage = {
		cacheRead,
		cacheWrite,
		cost: {
			cacheRead: costCacheRead,
			cacheWrite: costCacheWrite,
			input: costInput,
			output: costOutput,
			total,
		},
		input,
		output,
		totalTokens,
	};
	if (cacheWrite1h !== undefined) Object.assign(usage, { cacheWrite1h });
	if (reasoning !== undefined) Object.assign(usage, { reasoning });
	return usage;
}

function decodeToolResult<Value>(value: Value): AgentToolResult<unknown> | undefined {
	if (!isRuntimeRecord(value)) return undefined;
	const { addedToolNames, content, details, terminate, usage: rawUsage } = value;
	if (!Array.isArray(content)) return undefined;
	const visibleContent: AgentToolResult<unknown>["content"] = [];
	for (let index = 0; index < Math.min(content.length, TOOL_DISPLAY_ITEM_LIMIT); index += 1) {
		const item = content[index];
		if (!isCodeModeToolContent([item])) return undefined;
		visibleContent.push(item);
	}
	if (visibleContent.length < content.length) {
		visibleContent.push({ type: "text", text: "… nested result content omitted" });
	}
	const result: AgentToolResult<unknown> = {
		content: visibleContent,
		details,
	};
	const usage = decodeToolUsage(rawUsage);
	if (usage) Object.assign(result, { usage });
	if (Array.isArray(addedToolNames)) {
		const names = addedToolNames.slice(0, TOOL_DISPLAY_ITEM_LIMIT);
		if (names.every(isRuntimeString)) Object.assign(result, { addedToolNames: names });
	}
	if (isRuntimeBoolean(terminate)) Object.assign(result, { terminate });
	return result;
}

function decodeOperationState(value: JsonInputValue): SuiteToolEnvelopeOperation["state"] | undefined {
	return value === "cancelled" ||
		value === "error" ||
		value === "rejected" ||
		value === "running" ||
		value === "success"
		? value
		: undefined;
}

function decodeMediaPlacement<Value>(
	value: Value,
): { readonly afterContentIndex: number; readonly mediaIndex: number } | undefined {
	if (!isRuntimeRecord(value)) return undefined;
	const { afterContentIndex, mediaIndex } = value;
	return isRuntimeNumber(afterContentIndex) && isRuntimeNumber(mediaIndex)
		? { afterContentIndex, mediaIndex }
		: undefined;
}

function decodeOperation<Value>(value: Value): SuiteToolEnvelopeOperation | undefined {
	if (!isRuntimeRecord(value)) return undefined;
	const {
		args,
		attempt,
		executionId,
		id,
		mediaPlacements,
		name,
		replayed,
		result: rawResult,
		sequence,
		state: rawState,
	} = value;
	if (!isRuntimeRecord(args) || Array.isArray(args) || !isRuntimeString(id) || !isRuntimeString(name)) {
		return undefined;
	}
	const state = decodeOperationState(rawState);
	if (!state) return undefined;
	const operation: SuiteToolEnvelopeOperation = {
		// SAFETY: this display decoder retains the validated record by reference; child renderers receive a bounded view.
		args,
		id,
		name,
		state,
	};
	if (isRuntimeNumber(attempt)) Object.assign(operation, { attempt });
	if (isRuntimeString(executionId)) Object.assign(operation, { executionId });
	if (Array.isArray(mediaPlacements)) {
		const decodedPlacements = [];
		for (let index = 0; index < Math.min(mediaPlacements.length, TOOL_DISPLAY_ITEM_LIMIT); index += 1) {
			const decoded = decodeMediaPlacement(mediaPlacements[index]);
			if (decoded) decodedPlacements.push(decoded);
		}
		if (decodedPlacements.length > 0) Object.assign(operation, { mediaPlacements: decodedPlacements });
	}
	if (isRuntimeBoolean(replayed)) Object.assign(operation, { replayed });
	const result = decodeToolResult(rawResult);
	if (result) Object.assign(operation, { result });
	if (isRuntimeNumber(sequence)) Object.assign(operation, { sequence });
	return operation;
}

export function decodeCodeModeOperations<Value>(details: Value): readonly SuiteToolEnvelopeOperation[] {
	if (!isRuntimeRecord(details)) return [];
	const { kind, operations } = details;
	if (kind !== "pi-stuff-code-mode" || !Array.isArray(operations)) return [];
	const visibleLimit = TOOL_DISPLAY_ITEM_LIMIT - 1;
	const start = Math.max(0, operations.length - visibleLimit);
	const decoded: SuiteToolEnvelopeOperation[] = [];
	if (start > 0) {
		decoded.push({
			args: {},
			displayOnly: "overflow",
			id: "code-mode-display-overflow",
			name: "code-mode-display-overflow",
			state: "success",
		});
	}
	for (let index = start; index < operations.length; index += 1) {
		const operation = decodeOperation(operations[index]);
		if (operation) decoded.push(operation);
	}
	return decoded;
}

function showCodeModeFallback(
	_args: ToolArguments,
	result: AgentToolResult<unknown>,
	state: "cancelled" | "error" | "rejected" | "running" | "success",
): boolean {
	for (let index = 0; index < Math.min(result.content.length, TOOL_DISPLAY_ITEM_LIMIT); index += 1) {
		if (result.content[index]?.type === "image") return false;
	}
	return state !== "running" && state !== "success";
}

export function createCodeModeDefinition(
	runtime: CodeModeRuntime,
): ToolDefinition<typeof CODE_MODE_PARAMETERS, PiStuffCodeModeDetails> {
	return {
		description: CODE_MODE_DESCRIPTION,
		executionMode: "sequential",
		async execute(toolCallId, input, signal, onUpdate, context) {
			return runtime.execute(toolCallId, input.code, context, signal, onUpdate);
		},
		label: "Code Mode",
		name: CODE_MODE_TOOL_NAME,
		parameters: CODE_MODE_PARAMETERS,
		promptSnippet: "Use codemode to compose Pi Stuff Tools with JavaScript while returning only needed output",
	};
}

export function createCodeModeSearchDefinition(
	connector: Pick<SuiteCodeModeConnector, "describe" | "search">,
	ledger?: CodeModeSessionLedger,
): ToolDefinition<typeof CODE_MODE_SEARCH_PARAMETERS, CodeModeSearchDetails> {
	return {
		description:
			"Search Code Mode's active programmatic Tool catalog. Returns ranked matches and TypeScript signatures from the same catalog used by codemode.search/describe.",
		executionMode: "sequential",
		async execute(_toolCallId, input, _signal, _onUpdate, context) {
			const snippets = ledger?.snippets(context) ?? [];
			const search = connector.search(input.query, snippets);
			const projection = projectCodeModeSearchResponse(search, (result) =>
				connector.describe(result.path, snippets),
			);
			return {
				content: [
					{
						text: projection.text,
						type: "text",
					},
				],
				details: {
					paths: projection.paths,
					query: input.query,
					total: search.total,
					truncated: projection.truncated,
				},
			};
		},
		label: "Tool Search",
		name: CODE_MODE_SEARCH_TOOL_NAME,
		parameters: CODE_MODE_SEARCH_PARAMETERS,
		promptSnippet: "Use tool_search for Code Mode Tool discovery; call returned methods through codemode",
	};
}

/** Register before context managers so they receive the provider-visible result, not the TUI projection. */
export function registerCodeModeContextProjection(pi: Pick<ExtensionAPI, "on">): void {
	pi.on("context", (event) => {
		const messages = rehydrateCodeModeMessages(event.messages);
		return messages ? { messages } : undefined;
	});
}

export default function piStuffCodeMode(pi: CodeModeHost, options: PiStuffCodeModeOptions): void {
	const connector = new SuiteCodeModeConnector(options.registry);
	const ledger = new CodeModeSessionLedger(pi);
	const runtime = new CodeModeRuntime(connector, new V8CodeModeExecutor(options.effects), ledger);
	const controls = new CodeModeControls(pi, options, connector, ledger, runtime);
	registerCodeModeSkillDiscovery(pi, options);
	registerSuiteToolEnvelope(pi, createCodeModeDefinition(runtime), {
		decode: decodeCodeModeOperations,
		media: decodeCodeModeMediaSegments,
		registry: options.registry,
		showFallback: showCodeModeFallback,
	});
	registerSuiteToolEnvelopeCompanion(
		pi,
		CODE_MODE_TOOL_NAME,
		createCodeModeSearchDefinition(connector, ledger),
		CODE_MODE_SEARCH_PRESENTATION,
	);
	controls.register();
	pi.on("session_start", async (_event, context) => {
		await controls.bindProject(context, true);
	});
	pi.on("model_select", () => controls.apply());
	pi.on("before_agent_start", async (_event, context) => {
		await controls.bindProject(context);
		controls.apply();
	});
	pi.on("tool_result", (event) => {
		if (event.toolName !== CODE_MODE_TOOL_NAME) return undefined;
		const details = event.details;
		if (!isCodeModeModelContentOwner(details)) return undefined;
		const sanitized = sanitizeCodeModeContent(event.content);
		if (sanitized.rejected > 0) {
			const failedDetails = {
				...details,
				error: INVALID_CODE_MODE_IMAGE_MESSAGE,
				status: "error" as const,
			};
			captureCodeModeModelContent(failedDetails, sanitized.content);
			return { content: sanitized.content, details: failedDetails, isError: true };
		}
		captureCodeModeModelContent(details, event.content);
		if (
			"status" in details &&
			(details.status === "error" || details.status === "cancelled" || details.status === "incomplete")
		) {
			return { isError: true };
		}
		return undefined;
	});
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== CODE_MODE_TOOL_NAME) return;
		const separated = separateCodeModeMediaForUi(event.result);
		if (!separated) return;
		event.result.content = separated.content;
		event.result.details = separated.details;
	});
	pi.on("session_shutdown", async () => {
		await runtime.shutdown();
	});
}
