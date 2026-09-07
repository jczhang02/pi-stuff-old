import { expect, test } from "bun:test";
import { createAgentToolPresentation } from "../../../packages/pi-stuff/src/subagents/src/extension/agent-tool-presentation.js";
import { SubagentParams } from "../../../packages/pi-stuff/src/subagents/src/extension/schemas.js";
import {
	apiHarness,
	assistant,
	call,
	createSuiteToolRegistrationTracker,
	getToolUiRuntime,
	Params,
	presentation,
	registerSuiteOwnedTool,
	registerSuiteToolEnvelope,
	renderContext,
	renderLines,
	result,
	type SuiteToolEnvelopeOperation,
	settle,
	type ToolDefinition,
	Type,
	theme,
	toolFromHarness,
} from "../../tools/contract-fixtures.js";

test("decoration preserves execution and projects one Tool immediately", async () => {
	const harness = apiHarness();
	const tool = toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn([assistant(call("r1", "read", "a.ts"))]);

	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const execution = await tool.execute("r1", { value: "a.ts" }, undefined, undefined, {} as never);
	expect(execution.content).toEqual([{ type: "text", text: "MODEL_VISIBLE" }]);
	const rendered = settle(tool, "r1", "a.ts");
	expect(rendered.callLines.join("\n")).toContain("Reading 1 file");
	expect(rendered.callLines.join("\n")).not.toContain("a.ts · done");
	expect(rendered.resultLines).toEqual([]);

	runtime.endTurn();
	expect(renderLines(rendered.callComponent).join("\n")).toContain("Read 1 file");
});

test("first Tool projection does not traverse unrelated arguments", () => {
	const keys = Array.from({ length: 1_000 }, (_, index) => `field-${String(index)}`);
	let argumentPropertyVisits = 0;
	const args = new Proxy<Record<string, number>>(
		{},
		{
			get: () => {
				argumentPropertyVisits += 1;
				return 1;
			},
			getOwnPropertyDescriptor: () => {
				argumentPropertyVisits += 1;
				return { configurable: true, enumerable: true };
			},
			ownKeys: () => keys,
		},
	);
	const harness = apiHarness();
	registerSuiteOwnedTool(
		harness.api,
		{
			description: "wide argument fixture",
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			label: "Wide",
			name: "wide",
			parameters: Type.Record(Type.String(), Type.Number()),
		},
		{
			activity: { categories: ["run-command"], classify: () => [{ category: "run-command", count: 1 }] },
			runningSummary: "working",
			summarize: () => "done",
		},
	);
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn([assistant({ type: "toolCall", id: "wide-1", name: "wide", arguments: args })]);
	const tool = harness.tools.get("wide");
	if (!tool?.renderCall) throw new Error("missing wide Tool renderer");
	// SAFETY: the fixture supplies the exact Host context and argument shape exercised by this renderer.
	const component = tool.renderCall(args, theme, {
		...renderContext({}, { value: "" }, { toolCallId: "wide-1" }),
		args,
	} as never);

	expect(renderLines(component).join("\n")).toContain("Wide");
	expect(argumentPropertyVisits).toBeLessThanOrEqual(192);
});

test("the shared Agent Tool row bounds arguments at the real presentation seam", () => {
	const harness = apiHarness();
	registerSuiteOwnedTool(
		harness.api,
		{
			description: "Agent fixture",
			execute: async () => ({ content: [], details: { mode: "single" as const, results: [] } }),
			label: "Agent",
			name: "subagent",
			parameters: SubagentParams,
		},
		createAgentToolPresentation(),
	);
	let keyScans = 0;
	const args = new Proxy(
		{ agent: "reviewer", task: "x".repeat(8 * 1024 * 1024) },
		{
			ownKeys: (target) => {
				keyScans += 1;
				return Reflect.ownKeys(target);
			},
		},
	);
	const tool = harness.tools.get("subagent");
	if (!tool?.renderCall) throw new Error("missing Agent Tool renderer");
	const component = tool.renderCall(args, theme, {
		...renderContext({}, { value: "" }, { toolCallId: "agent-wide" }),
		args,
	});

	expect(renderLines(component).join("\n")).toContain("Agent");
	expect(keyScans).toBe(0);
});

test("silent-success Tools stay compact while running but remain expandable", () => {
	const harness = apiHarness();
	registerSuiteOwnedTool(
		harness.api,
		{
			description: "quiet infrastructure fixture",
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
			label: "Quiet",
			name: "quiet",
			parameters: Params,
		},
		{
			...presentation("read-file"),
			activity: { ...presentation("read-file").activity, silentSuccess: true },
		},
	);
	const tool = harness.tools.get("quiet");
	if (!tool) throw new Error("missing quiet Tool");
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn([assistant(call("quiet-1", "quiet", "context"))]);
	const args = { value: "context" };
	const state = {};
	const collapsed = renderContext(state, args, { toolCallId: "quiet-1" });
	const component = tool.renderCall?.(args, theme, collapsed);
	if (!component) throw new Error("missing quiet call component");
	expect(renderLines(component)).toEqual([]);

	tool.renderCall?.(args, theme, { ...collapsed, expanded: true });
	expect(renderLines(component)).not.toEqual([]);
	tool.renderCall?.(args, theme, collapsed);
	expect(renderLines(component)).toEqual([]);
	expect(runtime.listGroups()).toHaveLength(1);
});

test("settled Host redraws build detail only while globally expanded", () => {
	const harness = apiHarness();
	let detailBuilds = 0;
	registerSuiteOwnedTool(
		harness.api,
		{
			description: "lazy detail fixture",
			execute: async () => ({ content: [{ type: "text", text: "MODEL_VISIBLE" }], details: { source: "read" } }),
			label: "Read",
			name: "read",
			parameters: Params,
		},
		{
			...presentation("read-file"),
			detailLines: () => {
				detailBuilds += 1;
				return ["PRESENTATION_DETAIL"];
			},
		},
	);
	// SAFETY: this test controls the value and supplies every ToolDefinition member exercised by this case.
	const tool = harness.tools.get("read") as ToolDefinition<typeof Params, { source: string }>;
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages([assistant(call("lazy-read", "read", "a.ts")), result("lazy-read", "MODEL_VISIBLE")], true);
	const state = {};
	const args = { value: "a.ts" };
	const base = renderContext(state, args, { executionStarted: false, toolCallId: "lazy-read" });
	const component = tool.renderCall?.(args, theme, base);
	if (!component) throw new Error("missing lazy detail component");
	const finalResult = {
		content: [{ type: "text" as const, text: "MODEL_VISIBLE" }],
		details: { source: "read" },
	};
	const redraw = (expanded: boolean): string[] => {
		const context = { ...base, expanded, lastComponent: component };
		tool.renderCall?.(args, theme, context);
		const body = tool.renderResult?.(finalResult, { expanded, isPartial: false }, theme, context);
		return body ? renderLines(body) : [];
	};

	redraw(false);
	redraw(false);
	expect(detailBuilds).toBe(0);
	expect(runtime.groupActivities("lazy-read")[0]?.detailLines).toEqual([]);
	expect(redraw(true).join("\n")).toContain("PRESENTATION_DETAIL");
	expect(detailBuilds).toBe(1);
	redraw(true);
	expect(detailBuilds).toBe(1);
	redraw(false);
	expect(redraw(true).join("\n")).toContain("PRESENTATION_DETAIL");
	expect(detailBuilds).toBe(2);
});

test("throwing presentation hooks retain a standard direct Tool row", () => {
	const harness = apiHarness();
	registerSuiteOwnedTool(
		harness.api,
		{
			description: "fragile presentation fixture",
			execute: async () => ({ content: [{ type: "text", text: "direct failure" }], details: {} }),
			label: "Fragile",
			name: "fragile_direct",
			parameters: Params,
		},
		{
			activity: presentation("change-file").activity,
			detailLines: () => {
				throw new Error("detail failed");
			},
			label: () => {
				throw new Error("label failed");
			},
			runningSummary: () => {
				throw new Error("running summary failed");
			},
			summarize: () => {
				throw new Error("summary failed");
			},
			target: () => {
				throw new Error("target failed");
			},
		},
	);
	const decorated = harness.tools.get("fragile_direct");
	if (!decorated) throw new Error("missing direct fragile Tool");
	getToolUiRuntime(harness.api).indexMessages(
		[
			assistant(call("direct-fragile", "fragile_direct", "fixture")),
			result("direct-fragile", "direct failure", true),
		],
		true,
	);
	// SAFETY: the fixture's schema is Params and the assertion exercises only the registered renderer.
	const rendered = settle(
		decorated as ToolDefinition<typeof Params, { source: string }>,
		"direct-fragile",
		"fixture",
		true,
		true,
		"direct failure",
	);
	expect(rendered.callLines.join("\n")).toContain("Fragile · direct failure");
	expect(rendered.resultLines).toEqual([]);
	const runtime = getToolUiRuntime(harness.api);
	expect(runtime.toolActivityDetail("direct-fragile", "formatted")?.lines).toEqual(["direct failure"]);
	expect(runtime.toolActivityDetail("direct-fragile", "raw")?.lines.join("\n")).toContain("direct failure");
});

test("collapsed and expanded historical replay skip the synthetic running pass", () => {
	const harness = apiHarness();
	let runningSummaries = 0;
	let terminalSummaries = 0;
	registerSuiteOwnedTool(
		harness.api,
		{
			description: "historical replay fixture",
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
			label: "Read",
			name: "read",
			parameters: Params,
		},
		{
			...presentation("read-file"),
			runningSummary: () => {
				runningSummaries += 1;
				return "reading";
			},
			summarize: () => {
				terminalSummaries += 1;
				return "done";
			},
		},
	);
	// SAFETY: this test controls the value and supplies every ToolDefinition member exercised by this case.
	const tool = harness.tools.get("read") as ToolDefinition<typeof Params, { source: string }>;
	const runtime = getToolUiRuntime(harness.api);
	for (const expanded of [false, true]) {
		const toolCallId = expanded ? "replay-read-expanded" : "replay-read";
		runtime.indexMessages([assistant(call(toolCallId, "read", "a.ts")), result(toolCallId, "done")], true);
		const args = { value: "a.ts" };
		const context = renderContext({}, args, { executionStarted: false, expanded, toolCallId });
		const component = tool.renderCall?.(args, theme, context);
		if (!component) throw new Error("missing historical replay component");
		tool.renderResult?.(
			{ content: [{ type: "text", text: "done" }], details: { source: "a.ts" } },
			{ expanded, isPartial: false },
			theme,
			{ ...context, lastComponent: component },
		);
	}

	expect(runningSummaries).toBe(0);
	// The collapsed replay is represented by the already-built Group projection.
	// Its per-row terminal summary is materialized only when the user expands it.
	expect(terminalSummaries).toBe(1);
});

test("renderer binding does not aggregate Tools before the Session event", () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn();
	const first = settle(read, "event-owned-read-1", "a.ts");
	settle(read, "event-owned-read-2", "b.ts");

	expect(runtime.listGroups().map((group) => group.memberIds)).toEqual([
		["event-owned-read-2"],
		["event-owned-read-1"],
	]);
	runtime.indexMessage(
		assistant(call("event-owned-read-1", "read", "a.ts"), call("event-owned-read-2", "read", "b.ts")),
	);
	runtime.indexMessage(result("event-owned-read-1", "MODEL_VISIBLE"));
	runtime.indexMessage(result("event-owned-read-2", "MODEL_VISIBLE"));
	runtime.endTurn();
	expect(runtime.resolveGroup("event-owned-read-1")).toMatchObject({
		memberIds: ["event-owned-read-1", "event-owned-read-2"],
		state: "success",
	});
	expect(renderLines(first.callComponent).join("\n")).toContain("Read 2 files");
});

test("a Code Mode envelope renders the same compact Tool Activity as a direct Tool call", () => {
	const directHarness = apiHarness();
	const directRead = toolFromHarness(directHarness, "read", "read-file");
	const directRuntime = getToolUiRuntime(directHarness.api);
	directRuntime.indexMessages([assistant(call("r1", "read", "a.ts")), result("r1")], true);
	const direct = settle(directRead, "r1", "a.ts").callLines;

	const envelopeHarness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(envelopeHarness.api);
	const nestedRead = toolFromHarness({ api: registrations.api, tools: envelopeHarness.tools }, "read", "read-file");
	const operation: SuiteToolEnvelopeOperation = {
		args: { value: "a.ts" },
		id: "exec-1:read-1",
		name: "read",
		result: {
			content: [{ type: "text", text: "MODEL_VISIBLE" }],
			details: { source: "a.ts" },
		},
		state: "success",
	};
	registerSuiteToolEnvelope(
		registrations.api,
		{
			description: "Execute Suite Tools through Code Mode",
			execute: async () => ({
				content: [{ type: "text", text: "MODEL_VISIBLE" }],
				details: { operations: [operation] },
			}),
			label: "Code Mode",
			name: "codemode",
			parameters: Type.Object({ code: Type.String() }),
		},
		{
			decode: () => [operation],
			registry: registrations.registry,
		},
	);
	const envelope = envelopeHarness.tools.get("codemode");
	if (!envelope) throw new Error("missing Code Mode envelope");
	const envelopeRuntime = getToolUiRuntime(envelopeHarness.api);
	envelopeRuntime.indexMessages(
		[
			assistant({ type: "toolCall", id: "exec-1", name: "codemode", arguments: { code: "read" } }),
			{
				role: "toolResult",
				toolCallId: "exec-1",
				content: [{ type: "text", text: "MODEL_VISIBLE" }],
				details: { operations: [operation] },
			},
		],
		true,
	);
	const state = {};
	const context = renderContext(state, { value: "unused" }, { toolCallId: "exec-1" });
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const callComponent = envelope.renderCall?.({ code: "read" }, theme, context as never);
	if (!callComponent) throw new Error("missing Code Mode call component");
	const resultComponent = envelope.renderResult?.(
		{
			content: [{ type: "text", text: "MODEL_VISIBLE" }],
			details: { operations: [operation] },
		},
		{ expanded: false, isPartial: false },
		theme,
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		{ ...context, lastComponent: callComponent } as never,
	);
	if (!resultComponent) throw new Error("missing Code Mode result component");

	expect(resultComponent.render(120)).toEqual(direct);
	expect(nestedRead.name).toBe("read");
});
