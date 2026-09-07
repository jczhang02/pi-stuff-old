import { afterEach, expect, test } from "bun:test";
import {
	apiFor,
	Check,
	cleanupContextCoreFixtures,
	context,
	createExtensionRuntime,
	createSyntheticSourceInfo,
	type Extension,
	type ExtensionAPI,
	ExtensionRunner,
	type Handlers,
	magicModule,
	piStuffContext,
	SYSTEM_PROMPT_EVENT_SCHEMA,
} from "../../context/core-fixtures.js";

afterEach(cleanupContextCoreFixtures);

test("keeps the provider-facing Magic Context contract compact before upstream injection", async () => {
	const handlers: Handlers = new Map();
	let upstreamSawMarker = false;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				magicApi.on("context", (event) => event);
				magicApi.on("before_agent_start", (event) => {
					if (!Check(SYSTEM_PROMPT_EVENT_SCHEMA, event)) return;
					const upstreamSystemPrompt = event.systemPrompt;
					upstreamSawMarker = upstreamSystemPrompt.includes("## Magic Context");
					return {
						systemPrompt: upstreamSawMarker
							? upstreamSystemPrompt
							: `${upstreamSystemPrompt}\n\n## Magic Context\n\nVERBOSE_UPSTREAM_GUIDANCE`,
					};
				});
			},
		}),
	});
	const extension: Extension = {
		path: "<inline:context-compact-prompt>",
		resolvedPath: "<inline:context-compact-prompt>",
		sourceInfo: createSyntheticSourceInfo("<inline:context-compact-prompt>", {
			source: "context-compact-prompt",
		}),
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		handlers: handlers as Extension["handlers"],
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	const runner = new ExtensionRunner(
		[extension],
		createExtensionRuntime(),
		"/workspace/project-a",
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context().sessionManager as never,
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		{} as never,
	);

	await runner.emitInput("prompt", undefined, "rpc");
	const result = await runner.emitBeforeAgentStart("prompt", undefined, "base", {
		cwd: "/workspace/project-a",
	});
	if (!result?.systemPrompt) throw new Error("Magic Context did not return a provider-facing system prompt");
	const systemPrompt = result.systemPrompt;

	expect(upstreamSawMarker).toBe(true);
	expect(systemPrompt).toStartWith("base\n\n## Magic Context\n");
	expect(systemPrompt).not.toContain("VERBOSE_UPSTREAM_GUIDANCE");
	for (const tool of ["ctx_search", "ctx_expand", "ctx_reduce", "ctx_memory", "ctx_note"]) {
		expect(systemPrompt).toContain(tool);
	}
	expect(systemPrompt.length).toBeLessThan(2_000);
});

test("runs a Magic handler appended during before_agent_start in the same host event", async () => {
	const handlers: Handlers = new Map();
	let appendedHandlerRan = false;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => magicModule({ registerBeforeStart: () => (appendedHandlerRan = true) }),
	});
	const extension: Extension = {
		path: "<inline:context-contract>",
		resolvedPath: "<inline:context-contract>",
		sourceInfo: createSyntheticSourceInfo("<inline:context-contract>", { source: "context-contract" }),
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		handlers: handlers as Extension["handlers"],
		tools: new Map(),
		messageRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
	const runner = new ExtensionRunner(
		[extension],
		createExtensionRuntime(),
		"/workspace/project-a",
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context().sessionManager as never,
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		{} as never,
	);

	await runner.emitInput("prompt", undefined, "rpc");
	await runner.emitBeforeAgentStart("prompt", undefined, "system", { cwd: "/workspace/project-a" });
	expect(appendedHandlerRan).toBe(true);
});
