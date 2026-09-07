import { afterEach, expect, test } from "bun:test";
import {
	type AgentKeybindingsManager,
	apiFor,
	cleanupContextCoreFixtures,
	commandMagicModule,
	context,
	contextActivityData,
	createExtensionCommandContext,
	type ExtensionAPI,
	emit,
	getContextCapability,
	type Handlers,
	isRuntimeObject,
	KeybindingsManager,
	magicModule,
	maintenanceHarness,
	piStuffContext,
	TestTui,
	type ToolDefinition,
	TUI_KEYBINDINGS,
	Type,
	testTheme,
	UI_RENDER_REQUEST_EVENT,
} from "../../context/core-fixtures.js";

afterEach(cleanupContextCoreFixtures);

test("reports unavailable maintenance through a Pi Stuff activity", async () => {
	const { api, commandDefinitions, entries, handlers } = maintenanceHarness();
	const renderRequests: Array<{ force?: unknown; handled?: unknown }> = [];
	api.events.on(UI_RENDER_REQUEST_EVENT, (value) => {
		if (!isRuntimeObject(value) || value === null) return;
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		const request = value as { force?: unknown; handled?: unknown };
		request.handled = true;
		renderRequests.push(request);
	});
	piStuffContext(api, {
		loadMagicContext: async () => {
			throw new Error("Magic module unavailable");
		},
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await commandDefinitions.get("ctx")?.handler?.("flush", ctx);

	expect(entries.map((entry) => contextActivityData(entry.data).summary)).toEqual([
		"applying queued drops",
		"unavailable",
	]);
	expect(contextActivityData(entries.at(-1)?.data).state).toBe("error");
	expect(contextActivityData(entries.at(-1)?.data).detail).toBe("Magic module unavailable");
	expect(renderRequests).toEqual([{ force: false, handled: true }]);
});

test("executes a rebuild confirmed in the Context dialog without asking the user to repeat the command", async () => {
	const { api, commandDefinitions, entries, handlers } = maintenanceHarness();
	let recompCalls = 0;
	let publishRecompComplete: (() => void) | undefined;
	await piStuffContext(api, {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				publishRecompComplete = () => {
					magicApi.appendEntry("ctx-status", {
						level: "success",
						text: "## Magic Recomp — Complete\n\nPersisted 4 compartments.",
						title: "/ctx-recomp",
					});
				};
				magicApi.on("context", (event) => event);
				magicApi.registerCommand("ctx-status", {
					handler: async () => {
						magicApi.appendEntry("ctx-status", {
							details: {
								activeTags: 0,
								compartmentCount: 0,
								droppedTags: 0,
								historian: { inProgress: false },
								memoryCount: 0,
								noteCount: 0,
								pendingOps: 0,
							},
							level: "info",
							text: "## Magic Status\n\n### Cache TTL\n- Remaining: 5m",
							title: "/ctx-status",
						});
					},
				});
				magicApi.registerCommand("ctx-recomp", {
					handler: async (args) => {
						recompCalls++;
						magicApi.appendEntry("ctx-status", {
							level: recompCalls === 1 ? "warning" : "info",
							text:
								recompCalls === 1
									? "## Recomp Confirmation Required\n\nRun the same command again within 60 seconds."
									: `## Magic Recomp\n\nPartial recomp started for range ${args}.`,
							title: "/ctx-recomp",
						});
					},
				});
			},
		}),
	});
	// SAFETY: this test dialog uses only TUI-level matching inherited by the Agent keybindings manager.
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS) as AgentKeybindingsManager;
	const ctx = createExtensionCommandContext({
		...context(),
		getContextUsage: () => ({ contextWindow: 200_000, percent: 5, tokens: 10_000 }),
		hasUI: true,
		mode: "tui",
		ui: {
			custom: (factory) =>
				new Promise((resolve) => {
					void Promise.resolve(factory(new TestTui(28), testTheme, keybindings, resolve)).then((component) => {
						queueMicrotask(() => {
							component.handleInput?.("\u001b[B");
							component.handleInput?.("\r");
							component.handleInput?.("\u001b[B");
							component.handleInput?.("\r");
							component.handleInput?.("1-500");
							component.handleInput?.("\r");
							component.handleInput?.("\u001b[B");
							component.handleInput?.("\r");
						});
					});
				}),
			getEditorText: () => "saved draft",
			notify: () => undefined,
			setEditorText: () => undefined,
			setFooter: () => undefined,
			setWorkingVisible: () => undefined,
		},
	});

	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await commandDefinitions.get("ctx")?.handler?.("", ctx);

	expect(recompCalls).toBe(2);
	expect(entries.map((entry) => contextActivityData(entry.data).summary)).toEqual([
		"rebuilding range 1-500",
		"confirmation required",
		"rebuilding range 1-500",
	]);
	expect(contextActivityData(entries.at(-1)?.data).state).toBe("running");
	if (!publishRecompComplete) throw new Error("Expected deferred recomp completion callback");
	publishRecompComplete();
	expect(entries.map((entry) => contextActivityData(entry.data).summary)).toEqual([
		"rebuilding range 1-500",
		"confirmation required",
		"rebuilding range 1-500",
		"rebuilt 4 compartments",
	]);
	expect(contextActivityData(entries.at(-1)?.data).state).toBe("success");
});

test("keeps Magic's internal Historian agent native and recursion-free", async () => {
	const handlers: Handlers = new Map();
	let loads = 0;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => {
			loads++;
			return magicModule();
		},
		magicSubagent: () => true,
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	expect(loads).toBe(0);
	expect(getContextCapability(ctx).status().state).toBe("native");
});

test("routes Magic Context tools through the shared Tool row renderer", async () => {
	const handlers: Handlers = new Map();
	const tools: ToolDefinition[] = [];
	const api = apiFor(handlers, tools);
	piStuffContext(api, {
		loadMagicContext: async () => magicModule({ registerTool: true }),
	});
	const ctx = context();

	await emit(handlers, "session_start", { type: "session_start", resumed: false }, ctx);
	await emit(handlers, "input", { type: "input", text: "direct", source: "rpc" }, ctx);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	expect(tools).toHaveLength(5);
	const search = tools.find((tool) => tool.name === "ctx_search");
	expect(search?.renderShell).toBe("self");
	expect(search?.renderCall).toBeFunction();
	expect(search?.renderResult).toBeFunction();
	expect(api.getActiveTools()).toContain("ctx_search");
});

test("adapts command progress into one model-hidden Pi Stuff activity", async () => {
	const { api, commandDefinitions, entries, handlers, registrations } = maintenanceHarness();
	piStuffContext(api, {
		loadMagicContext: async () =>
			commandMagicModule("ctx-wrapup", (magicApi) => {
				for (const details of [
					{
						level: "info",
						text: "## Magic Wrapup\n\nEligible history is about 12,000 tokens.",
						title: "/ctx-wrapup",
					},
					{
						level: "success",
						text: "## Magic Wrapup\n\nWrapped up 84 messages into 3 compartments.",
						title: "/ctx-wrapup",
					},
				]) {
					magicApi.appendEntry("ctx-status", details);
				}
			}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await commandDefinitions.get("ctx")?.handler?.("wrapup 20", ctx);

	expect(registrations.entryRenderers).toEqual(["pi-stuff-context-activity"]);
	expect(entries).toHaveLength(3);
	expect(entries.every((entry) => entry.customType === "pi-stuff-context-activity")).toBeTrue();
	expect(entries.map((entry) => contextActivityData(entry.data).summary)).toEqual([
		"keeping 20 recent messages",
		"planning history compaction",
		"wrapped up 84 messages into 3 compartments",
	]);
	expect(entries.map((entry) => contextActivityData(entry.data).kind)).toEqual(["anchor", "update", "update"]);
});

test("routes detached maintenance completion back to its running activity", async () => {
	const { api, commandDefinitions, entries, handlers } = maintenanceHarness();
	let finishRecomp: (() => void) | undefined;
	piStuffContext(api, {
		loadMagicContext: async () =>
			commandMagicModule("ctx-recomp", (magicApi) => {
				magicApi.appendEntry("ctx-status", {
					level: "info",
					text: "## Magic Recomp\n\nHistorian recomp started.",
					title: "/ctx-recomp",
				});
				finishRecomp = () =>
					magicApi.appendEntry("ctx-status", {
						level: "success",
						text: "## Magic Recomp — Complete\n\nPersisted 4 compartments from 2 successful passes.",
						title: "/ctx-recomp",
					});
			}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await commandDefinitions.get("ctx")?.handler?.("recomp", ctx);

	expect(entries.map((entry) => contextActivityData(entry.data).summary)).toEqual([
		"preparing full rebuild",
		"rebuilding compartments",
	]);
	expect(contextActivityData(entries.at(-1)?.data).state).toBe("running");

	finishRecomp?.();
	expect(entries.map((entry) => contextActivityData(entry.data).summary)).toEqual([
		"preparing full rebuild",
		"rebuilding compartments",
		"rebuilt 4 compartments",
	]);
	expect(contextActivityData(entries.at(-1)?.data).state).toBe("success");
});

test("does not route detached maintenance updates into a different Session", async () => {
	const { api, commandDefinitions, entries, handlers } = maintenanceHarness();
	let recompCalls = 0;
	let finishRecomp: (() => void) | undefined;
	piStuffContext(api, {
		loadMagicContext: async () =>
			commandMagicModule("ctx-recomp", (magicApi) => {
				recompCalls++;
				magicApi.appendEntry("ctx-status", {
					level: "info",
					text: "## Magic Recomp\n\nHistorian recomp started.",
					title: "/ctx-recomp",
				});
				finishRecomp = () =>
					magicApi.appendEntry("ctx-status", {
						level: "success",
						text: "## Magic Recomp — Complete\n\nPersisted 4 compartments from 2 successful passes.",
						title: "/ctx-recomp",
					});
			}),
	});
	const firstCtx = context([], "/workspace/first", "session-first");
	const secondCtx = context([], "/workspace/second", "session-second");
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, firstCtx);
	await commandDefinitions.get("ctx")?.handler?.("recomp", firstCtx);
	expect(recompCalls).toBe(1);

	await emit(handlers, "session_before_switch", { type: "session_before_switch", reason: "resume" }, firstCtx);
	await emit(handlers, "session_start", { type: "session_start", reason: "resume" }, secondCtx);
	await commandDefinitions.get("ctx")?.handler?.("recomp", secondCtx);
	expect(recompCalls).toBe(1);
	expect(entries.map((entry) => contextActivityData(entry.data).summary)).toEqual([
		"preparing full rebuild",
		"rebuilding compartments",
		"continuing after Session switch",
		"preparing full rebuild",
		"already running in another session",
	]);

	finishRecomp?.();
	expect(entries).toHaveLength(5);
	await commandDefinitions.get("ctx")?.handler?.("recomp", secondCtx);
	expect(recompCalls).toBe(2);
});

test("releases detached maintenance ownership when its handler rejects", async () => {
	const { api, commandDefinitions, entries, handlers } = maintenanceHarness();
	let recompCalls = 0;
	let rejectRecomp: ((error: Error) => void) | undefined;
	piStuffContext(api, {
		loadMagicContext: async () =>
			commandMagicModule("ctx-recomp", async (magicApi) => {
				recompCalls++;
				if (recompCalls > 1) return;
				magicApi.appendEntry("ctx-status", {
					level: "info",
					text: "## Magic Recomp\n\nHistorian recomp started.",
					title: "/ctx-recomp",
				});
				await new Promise<void>((_resolve, reject) => {
					rejectRecomp = reject;
				});
			}),
	});
	const firstCtx = context([], "/workspace/first", "session-first");
	const secondCtx = context([], "/workspace/second", "session-second");
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, firstCtx);
	const firstCommand = commandDefinitions.get("ctx")?.handler?.("recomp", firstCtx);
	await Bun.sleep(0);
	await emit(handlers, "session_before_switch", { type: "session_before_switch", reason: "resume" }, firstCtx);
	await emit(handlers, "session_start", { type: "session_start", reason: "resume" }, secondCtx);
	rejectRecomp?.(new Error("historian unavailable"));
	await firstCommand;

	await commandDefinitions.get("ctx")?.handler?.("recomp", secondCtx);
	expect(recompCalls).toBe(2);
	expect(entries.map((entry) => contextActivityData(entry.data).summary)).toEqual([
		"preparing full rebuild",
		"rebuilding compartments",
		"continuing after Session switch",
		"preparing full rebuild",
	]);
});

test("settles an unexpected maintenance failure into the same activity", async () => {
	const { api, commandDefinitions, entries, handlers } = maintenanceHarness();
	piStuffContext(api, {
		loadMagicContext: async () =>
			commandMagicModule("ctx-flush", () => {
				throw new Error("database unavailable");
			}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await commandDefinitions.get("ctx")?.handler?.("flush", ctx);

	expect(entries).toHaveLength(2);
	expect(entries.map((entry) => contextActivityData(entry.data).summary)).toEqual(["applying queued drops", "failed"]);
	expect(contextActivityData(entries[1]?.data).detail).toBe("database unavailable");
});

test("does not widen a tool policy changed after session start", async () => {
	const handlers: Handlers = new Map();
	const tools: ToolDefinition[] = [];
	const api = apiFor(handlers, tools);
	piStuffContext(api, {
		loadMagicContext: async () => magicModule({ registerTool: true }),
	});
	const ctx = context();

	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	api.setActiveTools(["read"]);
	await emit(handlers, "input", { type: "input", text: "direct", source: "rpc" }, ctx);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);

	expect(api.getActiveTools()).toEqual(["read"]);
});

test("does not auto-activate a Magic tool that had no startup handoff", async () => {
	const handlers: Handlers = new Map();
	const tools: ToolDefinition[] = [];
	const api = apiFor(handlers, tools);
	piStuffContext(api, {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				magicApi.on("context", (event) => event);
				magicApi.registerTool({
					name: "todowrite",
					label: "TodoWrite",
					description: "Write todos",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
				});
			},
		}),
	});
	const ctx = context();

	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await emit(handlers, "input", { type: "input", text: "direct", source: "rpc" }, ctx);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);

	expect(api.getActiveTools()).not.toContain("todowrite");
	expect(tools.some((tool) => tool.name === "todowrite")).toBeFalse();
});
