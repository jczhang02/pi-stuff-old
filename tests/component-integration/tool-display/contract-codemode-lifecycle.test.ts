import { expect, test } from "bun:test";
import {
	apiHarness,
	assistant,
	BashParams,
	Check,
	call,
	classifyBashActivity,
	createSuiteToolRegistrationTracker,
	getToolUiRuntime,
	Params,
	presentation,
	registerSuiteOwnedTool,
	registerSuiteToolEnvelope,
	registerSuiteToolEnvelopeCompanion,
	renderContext,
	renderLines,
	result,
	type SuiteToolEnvelopeOperation,
	ToolUiRuntime,
	Type,
	theme,
	toolFromHarness,
} from "../../tools/contract-fixtures.js";

test("a completed nested Tool settles in place while the outer Code Mode result is still partial", () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	toolFromHarness({ ...harness, api: registrations.api }, "read", "read-file");
	let operations: readonly SuiteToolEnvelopeOperation[] = [
		{ args: { value: "live.ts" }, id: "nested-live", name: "read", state: "running" },
	];
	registerSuiteToolEnvelope(
		registrations.api,
		{
			description: "Code Mode",
			execute: async () => ({ content: [], details: { operations } }),
			label: "Code Mode",
			name: "codemode",
			parameters: Type.Object({ code: Type.String() }),
		},
		{ decode: () => operations, registry: registrations.registry },
	);
	const envelope = harness.tools.get("codemode");
	if (!envelope) throw new Error("missing Code Mode envelope");
	const runtime = getToolUiRuntime(harness.api);
	const state = {};
	const context = renderContext(state, { value: "unused" }, { toolCallId: "outer-live" });
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const callComponent = envelope.renderCall?.({ code: "read" }, theme, context as never);
	runtime.observeEnvelopeResult("codemode", "outer-live", { operations });
	const running = envelope.renderResult?.(
		{ content: [], details: { operations } },
		{ expanded: false, isPartial: true },
		theme,
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		{ ...context, lastComponent: callComponent } as never,
	);
	if (!running) throw new Error("missing running envelope result");
	expect(running.render(120).join("\n")).toContain("Reading 1 file");

	operations = [
		{
			args: { value: "live.ts" },
			id: "nested-live",
			name: "read",
			result: { content: [{ type: "text", text: "MODEL_VISIBLE" }], details: { source: "live.ts" } },
			state: "success",
		},
	];
	runtime.observeEnvelopeResult("codemode", "outer-live", { operations });
	expect(runtime.resolveGroup("nested-live")).toMatchObject({ state: "success" });
	expect(runtime.groupActivities("nested-live")[0]).toMatchObject({ state: "success" });
	expect(runtime.toolActivityDetail("nested-live", "formatted")?.activity).toMatchObject({ state: "success" });
	const settled = envelope.renderResult?.(
		{ content: [], details: { operations } },
		{ expanded: false, isPartial: true },
		theme,
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		{ ...context, lastComponent: running } as never,
	);
	if (!settled) throw new Error("missing settled envelope result");
	expect(settled.render(120).join("\n")).toContain("Read 1 file");
	expect(settled.render(120).join("\n")).not.toContain("Reading 1 file");
});

test("envelope terminal operations without results keep their explicit outcome", () => {
	const harness = apiHarness();
	toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	const operations: readonly SuiteToolEnvelopeOperation[] = [
		{ args: { value: "done.ts" }, id: "nested-success", name: "read", state: "success" },
		{ args: { value: "blocked.ts" }, id: "nested-rejected", name: "read", state: "rejected" },
	];
	runtime.registerEnvelope("codemode", () => operations);
	runtime.observeEnvelopeResult("codemode", "outer", { operations });

	expect(runtime.resolveGroup("nested-success")).toMatchObject({ state: "success" });
	expect(runtime.resolveGroup("nested-rejected")).toMatchObject({ state: "rejected" });
});

test("a settled envelope restores nested Tools to the outer call's source order", () => {
	const harness = apiHarness();
	toolFromHarness(harness, "read", "read-file");
	toolFromHarness(harness, "bash", "run-command");
	toolFromHarness(harness, "background", "fetch-page");
	toolFromHarness(harness, "subagent", "fetch-page");
	const runtime = getToolUiRuntime(harness.api);
	const operations: readonly SuiteToolEnvelopeOperation[] = [
		{ args: { value: "a.ts" }, id: "nested-read", name: "read", state: "success" },
		{ args: { value: "printf ok" }, id: "nested-bash", name: "bash", state: "success" },
	];
	runtime.registerEnvelope("codemode", () => operations);
	runtime.startTurn();
	runtime.indexMessage(
		assistant(
			{ arguments: { code: "read then bash" }, id: "outer", name: "codemode", type: "toolCall" },
			call("direct-background", "background", "list"),
			call("direct-subagent", "subagent", "status"),
		),
	);
	runtime.observeEnvelopeResult("codemode", "outer", { operations });
	runtime.indexMessage({
		content: [],
		details: { operations },
		role: "toolResult",
		toolCallId: "outer",
		toolName: "codemode",
	});

	expect(runtime.listGroups().map((group) => group.memberIds)).toEqual([
		["direct-subagent"],
		["direct-background"],
		["nested-bash"],
		["nested-read"],
	]);
});

test("streaming, rebuild, and Code Mode share retrieval eligibility", () => {
	const configure = (runtime: ToolUiRuntime) => {
		runtime.registerActivity<Params, unknown>("read", {
			categories: ["read-file"],
			classify: ({ args }) => [{ category: "read-file", countKeys: [String(args["value"])] }],
		});
		runtime.registerActivity<Params, unknown>("edit", {
			categories: ["change-file"],
			classify: ({ args }) => [{ category: "change-file", countKeys: [String(args["value"])] }],
		});
		runtime.registerActivity("bash", {
			categories: ["run-command", "read-file", "search-pattern", "list-directory"],
			classify: classifyBashActivity,
		});
		for (const name of ["read", "edit", "bash"]) runtime.markRendererAttached(name);
	};
	const calls = [
		{ id: "read-before", name: "read", arguments: { path: "a.ts", value: "a.ts" } },
		{
			id: "skill",
			name: "read",
			arguments: { path: "skills/demo/SKILL.md", value: "skills/demo/SKILL.md" },
		},
		{ id: "bash-read", name: "bash", arguments: { command: "cat a.ts", value: "cat a.ts" } },
		{ id: "edit", name: "edit", arguments: { value: "a.ts" } },
		{ id: "read-after", name: "read", arguments: { path: "b.ts", value: "b.ts" } },
	] as const;
	const persisted = [
		assistant(...calls.map((entry) => ({ ...entry, type: "toolCall" }))),
		...calls.map((entry) => result(entry.id)),
	];
	const rebuilt = new ToolUiRuntime();
	configure(rebuilt);
	rebuilt.indexMessages(persisted, true);

	const streaming = new ToolUiRuntime();
	configure(streaming);
	streaming.startTurn();
	for (const entry of calls) {
		streaming.observeAssistantEvent({
			contentIndex: 0,
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			partial: assistant() as never,
			toolCall: { ...entry, type: "toolCall" },
			type: "toolcall_end",
		});
		streaming.indexMessage(result(entry.id));
	}
	streaming.endTurn();

	const operations: readonly SuiteToolEnvelopeOperation[] = calls.map((entry) => ({
		args: entry.arguments,
		id: entry.id,
		name: entry.name,
		result: { content: [{ type: "text", text: "ok" }], details: {} },
		state: "success",
	}));
	const codeMode = new ToolUiRuntime();
	configure(codeMode);
	codeMode.registerEnvelope("codemode", () => operations);
	codeMode.indexMessages(
		[
			assistant({ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "inspect" } }),
			{ role: "toolResult", toolCallId: "outer", content: [], details: { operations } },
		],
		true,
	);

	const groupMemberIds = (runtime: ToolUiRuntime) => runtime.listGroups().map((group) => group.memberIds);
	const expected = [["read-after"], ["edit"], ["bash-read"], ["skill"], ["read-before"]];
	expect(groupMemberIds(rebuilt)).toEqual(expected);
	expect(groupMemberIds(streaming)).toEqual(expected);
	expect(groupMemberIds(codeMode)).toEqual(expected);
});

test("the Code Mode surface hides every active Suite Tool without changing the virtual active Tool set", () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	toolFromHarness({ ...harness, api: registrations.api }, "read", "read-file", {
		replay: "record",
	});
	toolFromHarness({ ...harness, api: registrations.api }, "bash", "run-command", {
		replay: "never",
	});
	toolFromHarness({ ...harness, api: registrations.api }, "write", "change-file");
	harness.api.setActiveTools(["read", "outside", "bash", "write"]);
	registerSuiteToolEnvelope(
		registrations.api,
		{
			description: "Code Mode",
			execute: async () => ({ content: [], details: {} }),
			label: "Code Mode",
			name: "codemode",
			parameters: Type.Object({ code: Type.String() }),
		},
		{ decode: () => [], registry: registrations.registry },
	);
	registerSuiteToolEnvelopeCompanion(
		registrations.api,
		"codemode",
		{
			description: "Search Code Mode Tools",
			execute: async () => ({ content: [], details: {} }),
			label: "Tool Search",
			name: "tool_search",
			parameters: Type.Object({ query: Type.String() }),
		},
		{
			activity: {
				categories: ["search-tool"],
				classify: ({ args }) => [{ category: "search-tool", countKeys: [args.query], target: args.query }],
				silentSuccess: true,
			},
		},
	);
	expect(harness.tools.get("tool_search")?.renderShell).toBe("self");
	expect(harness.tools.get("tool_search")?.renderCall).toBeTypeOf("function");
	expect(harness.tools.get("tool_search")?.renderResult).toBeTypeOf("function");
	const searchTool = harness.tools.get("tool_search");
	if (!searchTool) throw new Error("missing tool_search companion");
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn([
		assistant({ type: "toolCall", id: "search-1", name: "tool_search", arguments: { query: "read file" } }),
	]);
	const state = {};
	const args = { query: "read file" };
	const context = renderContext(state, { value: "" }, { toolCallId: "search-1" });
	const callComponent = searchTool.renderCall?.(args, theme, context);
	if (!callComponent) throw new Error("missing tool_search call component");
	expect(renderLines(callComponent)).toEqual([]);
	searchTool.renderCall?.(args, theme, { ...context, expanded: true });
	expect(renderLines(callComponent).join("\n")).toContain("Tool Search");
	searchTool.renderCall?.(args, theme, context);
	expect(renderLines(callComponent)).toEqual([]);
	const resultComponent = searchTool.renderResult?.(
		{
			content: [{ type: "text", text: '{"results":[{"path":"tools.read"}],"definitions":["LARGE"]}' }],
			details: {},
		},
		{ expanded: false, isPartial: false },
		theme,
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		{ ...context, lastComponent: callComponent } as never,
	);
	expect(renderLines(callComponent)).toEqual([]);
	expect(resultComponent ? renderLines(resultComponent) : []).toEqual([]);
	runtime.endTurn();
	const compact = renderLines(callComponent).join("\n");
	expect(compact).toBe("");
	expect(compact).not.toContain("definitions");
	expect(runtime.resolveGroup("search-1")).toMatchObject({ memberIds: ["search-1"] });

	registrations.surface.enableEnvelope("codemode");
	expect(harness.api.getActiveTools()).toEqual(["codemode", "tool_search", "outside"]);
	expect(registrations.api.getActiveTools()).toEqual(["read", "outside", "bash", "write"]);
	expect(registrations.registry.catalog().map(({ definition }) => definition.name)).toEqual(["read", "bash", "write"]);

	registrations.api.setActiveTools(["outside", "bash", "write"]);
	expect(harness.api.getActiveTools()).toEqual(["outside", "codemode", "tool_search"]);
	expect(registrations.api.getActiveTools()).toEqual(["outside", "bash", "write"]);
	toolFromHarness({ ...harness, api: registrations.api }, "late", "read-file");
	expect(harness.api.getActiveTools()).toEqual(["outside", "codemode", "tool_search"]);
	expect(registrations.api.getActiveTools()).toEqual(["outside", "bash", "write", "late"]);

	registrations.surface.disableEnvelope("codemode");
	expect(harness.api.getActiveTools()).toEqual(["outside", "bash", "write", "late"]);
});

test("a disabled-by-default Code Mode surface removes only its envelope Tool", () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	toolFromHarness({ ...harness, api: registrations.api }, "read", "read-file");
	harness.api.setActiveTools(["outside", "read"]);
	registerSuiteToolEnvelope(
		registrations.api,
		{
			description: "Code Mode",
			execute: async () => ({ content: [], details: {} }),
			label: "Code Mode",
			name: "codemode",
			parameters: Type.Object({ code: Type.String() }),
		},
		{ decode: () => [], registry: registrations.registry },
	);
	expect(harness.api.getActiveTools()).toEqual(["outside", "read", "codemode"]);

	registrations.surface.disableEnvelope("codemode");
	expect(harness.api.getActiveTools()).toEqual(["outside", "read"]);
	expect(registrations.api.getActiveTools()).toEqual(["outside", "read"]);
});

test("an active Suite Tool needs no per-Tool caller policy to run through Code Mode", async () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	toolFromHarness({ ...harness, api: registrations.api }, "write", "change-file");
	harness.api.setActiveTools(["write"]);

	expect(registrations.registry.catalog()).toMatchObject([{ definition: { name: "write" } }]);
	const result = await registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { value: "file.ts" },
		name: "write",
		toolCallId: "nested-write",
	});
	expect(result.isError).toBe(false);
});

test("nested invocation keeps Tool error metadata aligned with result hooks", async () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	registerSuiteOwnedTool(
		registrations.api,
		{
			description: "explicit error fixture",
			execute: async () => ({
				content: [{ type: "text", text: "nested failure" }],
				details: {},
				isError: true,
			}),
			label: "Explicit error",
			name: "explicit_error",
			parameters: Params,
		},
		presentation("run-command"),
	);
	const outcome = await registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { value: "value" },
		name: "explicit_error",
		toolCallId: "nested-explicit-error",
	});

	expect(outcome.isError).toBe(true);
	expect(outcome.result).toMatchObject({ content: [{ text: "nested failure", type: "text" }], isError: true });

	registrations.api.on("tool_result", () => ({ isError: false }));
	const recovered = await registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { value: "value" },
		name: "explicit_error",
		toolCallId: "nested-recovered-error",
	});
	expect(recovered.isError).toBe(false);
	expect("isError" in recovered.result).toBeFalse();
});

test("Code Mode compensation runs only an explicitly declared inverse operation", async () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	const compensated: unknown[] = [];
	toolFromHarness({ ...harness, api: registrations.api }, "reversible", "change-file", {
		compensate: (invocation) => {
			compensated.push(invocation);
		},
		replay: "never",
	});
	toolFromHarness({ ...harness, api: registrations.api }, "read", "read-file", {
		replay: "record",
	});
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const context = { cwd: "/project" } as never;
	expect(
		await registrations.registry.compensate({
			context,
			executionId: "cm-1",
			input: { value: "before" },
			name: "reversible",
			result: { version: 2 },
			sequence: 3,
		}),
	).toBe(true);
	expect(
		await registrations.registry.compensate({
			context,
			executionId: "cm-1",
			input: { value: "read" },
			name: "read",
			result: "data",
			sequence: 2,
		}),
	).toBe(false);
	expect(compensated).toMatchObject([
		{ executionId: "cm-1", input: { value: "before" }, name: "reversible", result: { version: 2 }, sequence: 3 },
	]);
});

test("nested invocation preserves Pi preparation, lifecycle hooks, updates, and result hooks", async () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	const order: string[] = [];
	registrations.api.on("tool_execution_start", () => {
		order.push("start");
	});
	registrations.api.on("tool_call", (event) => {
		order.push("call");
		// SAFETY: this test controls the value and supplies every Params member exercised by this case.
		(event.input as Params).value += "-hook";
	});
	registrations.api.on("tool_execution_update", () => {
		order.push("update");
	});
	registrations.api.on("tool_result", (event) => {
		order.push("result");
		return {
			content: [{ type: "text", text: `${event.content[0]?.type === "text" ? event.content[0].text : ""}-hooked` }],
		};
	});
	registrations.api.on("tool_execution_end", () => {
		order.push("end");
	});
	registerSuiteOwnedTool(
		registrations.api,
		{
			description: "lifecycle fixture",
			execute: async (_id, args, _signal, onUpdate) => {
				order.push(`execute:${args.value}`);
				onUpdate?.({ content: [{ type: "text", text: "partial" }], details: {} });
				return { content: [{ type: "text", text: args.value }], details: {} };
			},
			label: "Lifecycle",
			name: "lifecycle",
			parameters: Params,
			// SAFETY: this test controls the value and supplies every Params member exercised by this case.
			prepareArguments: (input) => ({
				...(input as Params),
				value: (input as Params).value.trim(),
			}),
		},
		presentation("run-command"),
	);
	const updates: string[] = [];
	const invocation = await registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { value: "  value  " },
		name: "lifecycle",
		onUpdate: (update) => {
			const first = update.content[0];
			if (first?.type === "text") updates.push(first.text);
		},
		toolCallId: "nested-1",
	});

	expect(invocation.isError).toBe(false);
	expect(invocation.result.content).toEqual([{ type: "text", text: "value-hook-hooked" }]);
	expect(updates).toEqual(["partial"]);
	expect(order).toEqual(["start", "call", "execute:value-hook", "update", "result", "end"]);
});

test("nested invocation bounds update handlers to one active and one latest pending update", async () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	const { promise: firstBlocked, resolve: releaseFirst } = Promise.withResolvers<void>();
	const { promise: firstStarted, resolve: firstEntered } = Promise.withResolvers<void>();
	const entered: string[] = [];
	const completed: string[] = [];
	registrations.api.on("tool_execution_update", async (event) => {
		const content = event.partialResult.content[0];
		const update = content?.type === "text" ? content.text : "";
		entered.push(update);
		if (entered.length === 1) {
			firstEntered();
			await firstBlocked;
		}
		completed.push(update);
	});
	registerSuiteOwnedTool(
		registrations.api,
		{
			description: "ordered update fixture",
			execute: async (_id, _args, _signal, onUpdate) => {
				onUpdate?.({ content: [{ type: "text", text: "first" }], details: {} });
				onUpdate?.({ content: [{ type: "text", text: "second" }], details: {} });
				onUpdate?.({ content: [{ type: "text", text: "latest" }], details: {} });
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
			label: "Ordered updates",
			name: "ordered_updates",
			parameters: Params,
		},
		presentation("run-command"),
	);

	const invocation = registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { value: "value" },
		name: "ordered_updates",
		toolCallId: "nested-ordered-updates",
	});
	await firstStarted;
	await Bun.sleep(0);
	expect(entered).toEqual(["first"]);
	releaseFirst();
	await invocation;
	expect(entered).toEqual(["first", "latest"]);
	expect(completed).toEqual(["first", "latest"]);
});

test("nested invocation keeps Tool control reminders out of Code Mode business results", async () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	registrations.api.on("tool_result", (event) => ({
		content: [
			...event.content,
			{
				type: "text",
				text: "<system-reminder>reduce old Tool output</system-reminder>",
			},
		],
	}));
	registerSuiteOwnedTool(
		registrations.api,
		{
			description: "control metadata fixture",
			execute: async () => ({ content: [{ type: "text", text: "business result" }], details: {} }),
			label: "Control fixture",
			name: "control_fixture",
			parameters: Params,
		},
		presentation("run-command"),
	);
	const invocation = await registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { value: "fixture" },
		name: "control_fixture",
		toolCallId: "nested-control",
	});

	expect(invocation.result.content).toEqual([{ type: "text", text: "business result" }]);
});

test("a Code Mode Bash call still reaches RTK's normal tool_call rewrite seam", async () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	let executed = "";
	registrations.api.on("tool_call", (event) => {
		if (event.toolName === "bash" && Check(BashParams, event.input)) event.input.command = "rtk git status";
	});
	registerSuiteOwnedTool(
		registrations.api,
		{
			description: "Bash fixture",
			execute: async (_id, args) => {
				executed = args.command;
				return { content: [{ type: "text", text: executed }], details: {} };
			},
			label: "Bash",
			name: "bash",
			parameters: BashParams,
		},
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		presentation("run-command") as never,
		{ replay: "never" },
	);
	harness.api.setActiveTools(["bash"]);
	await registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { command: "git status" },
		name: "bash",
		toolCallId: "nested-bash-rtk",
	});
	expect(executed).toBe("rtk git status");
});

test("a failing nested tool_call hook still emits Pi's terminal lifecycle event", async () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	const lifecycle: string[] = [];
	registrations.api.on("tool_execution_start", () => {
		lifecycle.push("start");
	});
	registrations.api.on("tool_call", () => {
		lifecycle.push("call");
		throw new Error("hook failed");
	});
	registrations.api.on("tool_execution_end", (event) => {
		lifecycle.push(event.isError ? "end:error" : "end:success");
	});
	registerSuiteOwnedTool(
		registrations.api,
		{
			description: "never executes",
			execute: async () => {
				lifecycle.push("execute");
				return { content: [], details: {} };
			},
			label: "Hook failure",
			name: "hook_failure",
			parameters: Params,
		},
		presentation("run-command"),
	);

	const outcome = await registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { value: "value" },
		name: "hook_failure",
		toolCallId: "nested-hook-failure",
	});

	expect(outcome.isError).toBe(true);
	expect(outcome.result.content).toEqual([{ type: "text", text: "hook failed" }]);
	expect(lifecycle).toEqual(["start", "call", "end:error"]);
});

test("a permission-style nested tool_call rejection blocks execution and preserves termination", async () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	let executions = 0;
	registrations.api.on("tool_call", () => ({ block: true, reason: "Approval denied", terminate: true }));
	registerSuiteOwnedTool(
		registrations.api,
		{
			description: "permission fixture",
			execute: async () => {
				executions += 1;
				return { content: [], details: {} };
			},
			label: "Permission",
			name: "permission_fixture",
			parameters: Params,
		},
		presentation("run-command"),
	);

	const outcome = await registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { value: "value" },
		name: "permission_fixture",
		toolCallId: "nested-permission",
	});

	expect(executions).toBe(0);
	expect(outcome.isError).toBe(true);
	expect(outcome.result).toMatchObject({
		content: [{ text: "Approval denied", type: "text" }],
		terminate: true,
	});
});

test("nested invocation matches Pi cancellation and ignores updates after execution settles", async () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	const lifecycle: string[] = [];
	registrations.api.on("tool_execution_start", () => {
		lifecycle.push("start");
	});
	registrations.api.on("tool_call", () => {
		lifecycle.push("call");
	});
	registrations.api.on("tool_execution_update", () => {
		lifecycle.push("update");
	});
	registrations.api.on("tool_result", () => {
		lifecycle.push("result");
	});
	registrations.api.on("tool_execution_end", () => {
		lifecycle.push("end");
	});
	let executions = 0;
	registerSuiteOwnedTool(
		registrations.api,
		{
			description: "late update fixture",
			execute: async (_id, _args, _signal, onUpdate) => {
				executions += 1;
				setTimeout(() => onUpdate?.({ content: [{ type: "text", text: "late" }], details: {} }), 0);
				return { content: [{ type: "text", text: "done" }], details: {} };
			},
			label: "Late update",
			name: "late_update",
			parameters: Params,
		},
		presentation("run-command"),
	);

	const updates: string[] = [];
	const completed = await registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { value: "value" },
		name: "late_update",
		onUpdate: () => updates.push("update"),
		toolCallId: "nested-late",
	});
	await Bun.sleep(0);
	expect(completed.isError).toBe(false);
	expect(updates).toEqual([]);
	expect(lifecycle).toEqual(["start", "call", "result", "end"]);

	lifecycle.splice(0);
	const controller = new AbortController();
	controller.abort();
	const cancelled = await registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { value: "cancelled" },
		name: "late_update",
		signal: controller.signal,
		toolCallId: "nested-cancelled",
	});
	expect(cancelled.isError).toBe(true);
	expect(cancelled.result.content).toEqual([{ type: "text", text: "Operation aborted" }]);
	expect(executions).toBe(1);
	expect(lifecycle).toEqual(["start", "call", "end"]);
});

test("nested invocation records Tools activated by the original Pi Tool", async () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	registerSuiteOwnedTool(
		registrations.api,
		{
			description: "deferred fixture",
			execute: async () => ({ content: [], details: {} }),
			label: "Deferred",
			name: "deferred",
			parameters: Params,
		},
		presentation("read-file"),
	);
	registerSuiteOwnedTool(
		registrations.api,
		{
			description: "activator fixture",
			execute: async () => {
				registrations.api.setActiveTools([...registrations.api.getActiveTools(), "deferred"]);
				return { content: [{ type: "text", text: "activated" }], details: {} };
			},
			label: "Activator",
			name: "activator",
			parameters: Params,
		},
		presentation("run-command"),
	);
	registrations.api.setActiveTools(["activator"]);

	const invocation = await registrations.registry.invoke({
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		context: { cwd: "/project" } as never,
		input: { value: "value" },
		name: "activator",
		toolCallId: "nested-activator",
	});

	expect(invocation.result.addedToolNames).toEqual(["deferred"]);
});
