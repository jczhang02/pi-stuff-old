import { describe, expect, test } from "bun:test";
import {
	type AgentToolResult,
	createEventBus,
	type ExtensionContext,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { EffectFoundation } from "../../../packages/pi-stuff/src/shared/effect-foundation.js";
import {
	createWebAdapterApi,
	runWebContentOperation,
	type WebAdapterHost,
} from "../../../packages/pi-stuff/src/web/adapter.js";
import { WebContentSessionError } from "../../../packages/pi-stuff/src/web/runtime/implementation.js";

const Parameters = Type.Object({}, { additionalProperties: true });
const SearchParameters = Type.Object(
	{
		properties: Type.Object(
			{
				includeContent: Type.Optional(Type.Unknown()),
				workflow: Type.Optional(Type.Unknown()),
			},
			{ additionalProperties: true },
		),
	},
	{ additionalProperties: true },
);
const ErrorDetails = Type.Object({ error: Type.String() }, { additionalProperties: true });
const ContinuationParameters = Type.Object(
	{
		properties: Type.Object(
			{
				limit: Type.Object({ maximum: Type.Number() }, { additionalProperties: true }),
				offset: Type.Object({ minimum: Type.Number() }, { additionalProperties: true }),
				responseId: Type.Object({ maxLength: Type.Number() }, { additionalProperties: true }),
			},
			{ additionalProperties: true },
		),
	},
	{ additionalProperties: true },
);
type Tool = ToolDefinition<typeof Parameters, unknown>;

function harness() {
	const tools = new Map<string, ToolDefinition>();
	const pi: WebAdapterHost = {
		events: createEventBus(),
		getActiveTools: () => [],
		on: () => undefined,
		registerTool: (tool) => {
			// SAFETY: the test registry erases only generic renderer state and retains the original Tool object.
			tools.set(tool.name, tool as ToolDefinition);
		},
		setActiveTools: () => undefined,
	};
	return {
		pi,
		tools,
	};
}

function upstreamTool(
	name: string,
	label: string,
	execute: Tool["execute"] = async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
): Tool {
	return { description: label, execute, label, name, parameters: Parameters };
}

describe("Pi Stuff Web fork boundary", () => {
	test("retains only search, HTTP(S) fetch, and continuation Tools", () => {
		const fixture = harness();
		const adapter = createWebAdapterApi(fixture.pi);
		adapter.registerTool(upstreamTool("web_search", "Web Search"));
		adapter.registerTool(upstreamTool("source_check", "Source Check"));
		adapter.registerTool(upstreamTool("fetch_content", "Fetch Content"));
		adapter.registerTool(upstreamTool("get_search_content", "Get Search Content"));

		expect([...fixture.tools.keys()]).toEqual(["web_search", "fetch_content", "get_search_content"]);
		for (const tool of fixture.tools.values()) expect(tool.renderShell).toBe("self");
	});

	test("keeps the narrow non-browser search schema", async () => {
		const fixture = harness();
		let received: unknown;
		const execute: Tool["execute"] = async (_id, params): Promise<AgentToolResult<unknown>> => {
			received = params;
			return { content: [{ type: "text", text: "cited" }], details: { totalResults: 3 } };
		};
		createWebAdapterApi(fixture.pi).registerTool(upstreamTool("web_search", "Web Search", execute));
		const tool = fixture.tools.get("web_search");
		if (!tool) throw new Error("web_search was not registered");
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		await tool.execute("search-1", { query: "Pi 0.83" }, undefined, undefined, {} as never);

		expect(received).toEqual({ query: "Pi 0.83" });
		if (!Check(SearchParameters, tool.parameters)) throw new Error("web search parameters were malformed");
		const properties = tool.parameters.properties;
		expect(properties).not.toHaveProperty("workflow");
		expect(properties).not.toHaveProperty("includeContent");
	});

	test("blocks local fetches before calling the owned fork", async () => {
		const fixture = harness();
		let calls = 0;
		const execute: Tool["execute"] = async () => {
			calls += 1;
			return { content: [{ type: "text", text: "unexpected" }], details: {} };
		};
		createWebAdapterApi(fixture.pi).registerTool(upstreamTool("fetch_content", "Fetch Content", execute));
		const tool = fixture.tools.get("fetch_content");
		if (!tool) throw new Error("fetch_content was not registered");
		const result = await tool.execute(
			"fetch-1",
			{ url: "http://127.0.0.1/private" },
			undefined,
			undefined,
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			{} as never,
		);

		expect(calls).toBe(0);
		if (!Check(ErrorDetails, result.details)) throw new Error("fetch error details were malformed");
		expect(result.details.error).toContain("Local and private");
	});

	test("bounds continuation selectors and returned slices", () => {
		const fixture = harness();
		createWebAdapterApi(fixture.pi).registerTool(upstreamTool("get_search_content", "Get Search Content"));
		const tool = fixture.tools.get("get_search_content");
		if (!tool) throw new Error("get_search_content was not registered");
		if (!Check(ContinuationParameters, tool.parameters)) {
			throw new Error("web continuation parameters were malformed");
		}
		const properties = tool.parameters.properties;

		expect(properties.responseId.maxLength).toBe(256);
		expect(properties.limit.maximum).toBe(30_000);
		expect(properties.offset.minimum).toBe(0);
		expect(tool.renderShell).toBe("self");
	});
});

test("runs Web work in the current Session operation and guards result projection", async () => {
	const foundation = new EffectFoundation();
	// SAFETY: Foundation ownership uses Session Manager identity only; no Session methods are exercised here.
	const sessionManager = {} as ExtensionContext["sessionManager"];
	await foundation.startSession(sessionManager);
	// SAFETY: The runner reads only sessionManager from this focused Host context fixture.
	const ctx = { sessionManager } as ExtensionContext;
	try {
		await expect(
			runWebContentOperation(foundation, ctx, Effect.succeed("ok"), { success: (value) => value }),
		).resolves.toBe("ok");
		const controller = new AbortController();
		const cancelled = runWebContentOperation(
			foundation,
			ctx,
			Effect.never,
			{ success: (value) => value },
			controller.signal,
		);
		controller.abort();
		await expect(cancelled).rejects.toThrow("aborted");

		const projectedController = new AbortController();
		const projected = runWebContentOperation(
			foundation,
			ctx,
			Effect.never,
			{ interrupted: () => "cancelled", success: (value) => value },
			projectedController.signal,
		);
		projectedController.abort();
		await expect(projected).resolves.toBe("cancelled");

		let published = false;
		const stale = runWebContentOperation(foundation, ctx, Effect.never, {
			interrupted: () => {
				published = true;
			},
			success: () => {
				published = true;
			},
		});
		// SAFETY: Foundation ownership uses Session Manager identity only; no Session methods are exercised here.
		await foundation.startSession({} as ExtensionContext["sessionManager"]);
		await expect(stale).rejects.toBeInstanceOf(WebContentSessionError);
		expect(published).toBe(false);
	} finally {
		await foundation.shutdown();
	}
});
