import { expect, test } from "bun:test";
import {
	apiHarness,
	assistant,
	bashCall,
	CachedToolRow,
	call,
	createSuiteToolRegistrationTracker,
	getToolUiRuntime,
	presentation,
	registerSuiteToolEnvelope,
	renderContext,
	renderLines,
	result,
	type SuiteToolEnvelopeOperation,
	settle,
	ToolUiRuntime,
	ToolUiSettingsStore,
	Type,
	theme,
	toolFromHarness,
} from "../../tools/contract-fixtures.js";

test("live Retrieval Groups hold a target for 700 ms before advancing", async () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	const firstState = {};
	const firstContext = renderContext(firstState, { value: "first.ts" }, { toolCallId: "r1" });
	runtime.startTurn([assistant(call("r1", "read", "first.ts"))]);
	const first = read.renderCall?.({ value: "first.ts" }, theme, firstContext);
	if (!first) throw new Error("missing first component");
	expect(renderLines(first).join("\n")).not.toContain("first.ts");
	await Bun.sleep(720);
	read.renderCall?.({ value: "first.ts" }, theme, firstContext);
	expect(renderLines(first).join("\n")).toContain("first.ts");
	runtime.indexMessage(result("r1"));
	runtime.indexMessage(assistant(call("r2", "read", "second.ts")));
	read.renderCall?.({ value: "second.ts" }, theme, renderContext({}, { value: "second.ts" }, { toolCallId: "r2" }));
	expect(renderLines(first).join("\n")).toContain("first.ts");
	await Bun.sleep(650);
	read.renderCall?.({ value: "first.ts" }, theme, firstContext);
	expect(renderLines(first).join("\n")).toContain("first.ts");
	await Bun.sleep(80);
	read.renderCall?.({ value: "first.ts" }, theme, firstContext);
	expect(renderLines(first).join("\n")).toContain("second.ts");
	runtime.clear();
});

test("settling an earlier group member preserves the latest source-order target", async () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn([assistant(call("r1", "read", "first.ts"), call("r2", "read", "second.ts"))]);
	const firstState = {};
	const firstContext = renderContext(firstState, { value: "first.ts" }, { toolCallId: "r1" });
	const first = read.renderCall?.({ value: "first.ts" }, theme, firstContext);
	if (!first) throw new Error("missing first component");
	read.renderCall?.({ value: "second.ts" }, theme, renderContext({}, { value: "second.ts" }, { toolCallId: "r2" }));
	read.renderResult?.(
		{ content: [{ type: "text", text: "MODEL_VISIBLE" }], details: { source: "first.ts" } },
		{ expanded: false, isPartial: false },
		theme,
		{ ...firstContext, lastComponent: first },
	);
	expect(renderLines(first).join("\n")).not.toContain("second.ts");
	await Bun.sleep(720);
	runtime.syncTimers();
	read.renderCall?.({ value: "first.ts" }, theme, firstContext);
	expect(renderLines(first).join("\n")).toContain("second.ts");
	runtime.clear();
});

test("a later Thinking run splits Retrieval Groups before prose closes the tail", () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const grep = toolFromHarness(harness, "grep", "search-pattern");
	const runtime = getToolUiRuntime(harness.api);
	const messages = [
		assistant({ type: "thinking", thinking: "inspect" }, call("r1", "read", "a.ts")),
		result("r1"),
		assistant({ type: "thinking", thinking: "search" }, call("g1", "grep", "needle")),
	];
	runtime.startTurn(messages);
	const first = settle(read, "r1", "a.ts");
	const second = settle(grep, "g1", "needle");
	expect(first.callLines.join("\n")).toContain("Read 1 file");
	expect(second.callLines.join("\n")).toContain("Searching 1 pattern");

	runtime.indexMessage(assistant({ type: "text", text: "Done." }));
	expect(renderLines(second.callComponent).join("\n")).toContain("Searched 1 pattern");
});

test("multiple Bash calls render as separate operation blocks in native order", () => {
	const harness = apiHarness();
	const bash = toolFromHarness(harness, "bash", "run-command");
	const read = toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	const messages = [
		assistant(call("r1", "read", "before.ts"), bashCall("b1", "printf 'one\\ntwo\\n'")),
		result("r1", "READ"),
		result("b1", "one\ntwo"),
		assistant(bashCall("b2", "printf 'three\\n' && printf 'four\\n'"), call("r2", "read", "after.ts")),
		result("b2", "three\nfour"),
		result("r2", "READ"),
	];
	runtime.indexMessages(messages, true);

	const before = settle(read, "r1", "before.ts");
	const first = settle(bash, "b1", "printf 'one\\ntwo\\n'", false, false, "one\ntwo");
	const second = settle(bash, "b2", "printf 'three\\n' && printf 'four\\n'", false, false, "three\nfour");
	const after = settle(read, "r2", "after.ts");

	expect(before.callLines.join("\n")).toContain("Read 1 file");
	expect(first.callLines).toEqual([" • Bash(printf 'one\\ntwo\\n')", "  ⎿  one", "     two"]);
	expect(second.callLines).toEqual([" • Bash(printf 'three\\n' && printf 'four\\n')", "  ⎿  three", "     four"]);
	expect(after.callLines.join("\n")).toContain("Read 1 file");
	expect([before, first, second, after].flatMap((entry) => entry.callLines).join("\n")).not.toContain("commands");
	expect(runtime.listGroups().map((group) => group.memberIds)).toEqual([["r2"], ["b2"], ["b1"], ["r1"]]);

	runtime.resetProjection(messages);
	expect(settle(bash, "b1", "printf 'one\\ntwo\\n'", false, false, "one\ntwo").callLines).toEqual(first.callLines);
});

test("Bash partial results update in place and the final output wins", () => {
	const harness = apiHarness();
	const bash = toolFromHarness(harness, "bash", "run-command");
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages([assistant(bashCall("stream-bash", "printf 'first\\nsecond\\n'"))], false);
	runtime.observeToolExecutionStart("stream-bash");
	const context = renderContext(
		{},
		{ value: "printf 'first\\nsecond\\n'" },
		{
			toolCallId: "stream-bash",
		},
	);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const callComponent = bash.renderCall?.({ value: "printf 'first\\nsecond\\n'" }, theme, context as never);
	if (!callComponent) throw new Error("missing running Bash component");
	expect(renderLines(callComponent)).toEqual([" • Bash(printf 'first\\nsecond\\n')", "  ⎿  Running…"]);

	const partial = { content: [{ type: "text" as const, text: "first\nsecond" }], details: { source: "bash" } };
	runtime.observeToolExecutionUpdate("stream-bash", partial);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	bash.renderCall?.({ value: "printf 'first\\nsecond\\n'" }, theme, context as never);
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	bash.renderResult?.(partial, { expanded: false, isPartial: true }, theme, {
		...context,
		lastComponent: callComponent,
	} as never);
	expect(renderLines(callComponent)).toEqual([" • Bash(printf 'first\\nsecond\\n')", "  ⎿  first", "     second"]);

	const finalResult = {
		content: [{ type: "text" as const, text: "failed\n\nCommand exited with code 7" }],
		details: { source: "bash" },
		isError: true,
	};
	runtime.observeToolExecutionEnd("stream-bash", finalResult);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	bash.renderCall?.({ value: "printf 'first\\nsecond\\n'" }, theme, context as never);
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	bash.renderResult?.(finalResult, { expanded: false, isPartial: false }, theme, {
		...context,
		isError: true,
		lastComponent: callComponent,
	} as never);
	expect(renderLines(callComponent)).toEqual([
		" • Bash(printf 'first\\nsecond\\n')",
		"  ⎿  Error: Exit code 7",
		"     failed",
	]);
});

test("an adjacent empty Host abort settles only the in-flight Bash and retains partial output", () => {
	const harness = apiHarness();
	const bash = toolFromHarness(harness, "bash", "run-command");
	const runtime = getToolUiRuntime(harness.api);
	const command = "printf partial; sleep 30";
	const args = { value: command };
	const state = {};
	const context = renderContext(state, args, { toolCallId: "cancelled-bash" });
	runtime.indexMessages([assistant(bashCall("cancelled-bash", command))], false);
	runtime.observeToolExecutionStart("cancelled-bash");
	const component = bash.renderCall?.(args, theme, context);
	if (!component) throw new Error("missing cancellable Bash component");
	const partial = { content: [{ type: "text" as const, text: "partial" }], details: { source: "bash" } };
	runtime.observeToolExecutionUpdate("cancelled-bash", partial);
	const interrupted = {
		content: [{ type: "text" as const, text: "partial\n\nCommand exited with code 128" }],
		details: { source: "bash" },
		isError: true,
	};
	runtime.observeToolExecutionEnd("cancelled-bash", interrupted);
	runtime.indexMessage(result("cancelled-bash", "partial\n\nCommand exited with code 128", true));
	runtime.indexMessage({
		role: "assistant",
		content: [],
		stopReason: "error",
		errorMessage: "The operation was aborted.",
	});

	expect(renderLines(component)).toEqual([" • Bash(printf partial; sleep 30)", "  ⎿  Interrupted", "     partial"]);
	expect(runtime.resolveGroup("cancelled-bash")).toMatchObject({ state: "cancelled" });
	expect(runtime.groupActivities("cancelled-bash")[0]).toMatchObject({ state: "cancelled" });
	bash.renderCall?.(args, theme, { ...context, expanded: true });
	expect(
		renderLines(component)
			.join("\n")
			.match(/Interrupted/gu),
	).toHaveLength(1);
	expect(renderLines(component).join("\n")).not.toContain("Error:");

	const replay = new ToolUiRuntime();
	replay.registerActivity("bash", presentation("run-command").activity);
	replay.markRendererAttached("bash");
	replay.indexMessages(
		[
			assistant(bashCall("replayed-cancel", command)),
			result("replayed-cancel", "partial\n\nCommand exited with code 128", true),
			{
				role: "assistant",
				content: [],
				stopReason: "error",
				errorMessage: "The operation was aborted.",
			},
		],
		true,
	);
	expect(replay.resolveGroup("replayed-cancel")).toMatchObject({ state: "cancelled" });
});

test("Bash exit code 128 remains an error without adjacent Host abort evidence", () => {
	const harness = apiHarness();
	const bash = toolFromHarness(harness, "bash", "run-command");
	const runtime = getToolUiRuntime(harness.api);
	const command = "exit 128";
	runtime.indexMessages(
		[assistant(bashCall("exit-128", command)), result("exit-128", "Command exited with code 128", true)],
		true,
	);
	const rendered = settle(bash, "exit-128", command, true, true, "Command exited with code 128");
	expect(rendered.callLines.join("\n")).toContain("Error: Exit code 128");
	expect(rendered.callLines.join("\n")).not.toContain("Interrupted");
	expect(runtime.resolveGroup("exit-128")).toMatchObject({ state: "error" });
});

test("replaying Pi's Bash partial renderer pass settles after one invalidation", async () => {
	const harness = apiHarness();
	const bash = toolFromHarness(harness, "bash", "run-command");
	const runtime = getToolUiRuntime(harness.api);
	const toolCallId = "stable-partial";
	const args = { value: "sleep 2; printf done" };
	const state = {};
	const partial = { content: [{ type: "text" as const, text: "still working" }], details: { source: "bash" } };
	let invalidations = 0;
	let renderPass = (): void => {};
	const context = renderContext(state, args, {
		invalidate: () => {
			invalidations += 1;
			if (invalidations <= 10) renderPass();
		},
		toolCallId,
	});

	runtime.indexMessages([assistant(bashCall(toolCallId, args.value))], false);
	runtime.observeToolExecutionStart(toolCallId);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const component = bash.renderCall?.(args, theme, context as never);
	if (!component) throw new Error("missing running Bash component");
	renderPass = () => {
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		bash.renderCall?.(args, theme, context as never);
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		bash.renderResult?.(partial, { expanded: false, isPartial: true }, theme, {
			...context,
			lastComponent: component,
		} as never);
	};

	runtime.observeToolExecutionUpdate(toolCallId, partial);
	renderPass();
	for (let turn = 0; turn < 12; turn += 1) await Promise.resolve();

	expect(invalidations).toBe(1);
	expect(renderLines(component)).toEqual([" • Bash(sleep 2; printf done)", "  ⎿  still working"]);
	runtime.suspend();
});

test("Ctrl+O expands Bash command and output inside the same operation block", () => {
	const harness = apiHarness();
	const bash = toolFromHarness(harness, "bash", "run-command");
	const runtime = getToolUiRuntime(harness.api);
	const command = "printf 'first\\nsecond\\nthird\\n'";
	runtime.indexMessages(
		[assistant(bashCall("expanded-bash", command)), result("expanded-bash", "1\n2\n3\n4\n5")],
		true,
	);
	const expanded = settle(bash, "expanded-bash", command, false, true, "1\n2\n3\n4\n5");

	expect(expanded.callLines).toEqual([
		" • Bash(printf 'first\\nsecond\\nthird\\n')",
		"  ⎿  1",
		"     2",
		"     3",
		"     4",
		"     5",
	]);
	expect(expanded.resultLines).toEqual([]);
	expect(expanded.callLines.join("\n")).not.toContain("Call\n");
	expect(expanded.callLines.join("\n")).not.toContain("Result\n");
});

test("Code Mode preserves standalone Bash operation blocks in compact and expanded views", () => {
	const directHarness = apiHarness();
	const directBash = toolFromHarness(directHarness, "bash", "run-command");
	getToolUiRuntime(directHarness.api).indexMessages(
		[assistant(bashCall("direct-bash", "printf 'ok\\n'")), result("direct-bash", "1\n2\n3\n4\n5")],
		true,
	);
	const directCompact = settle(directBash, "direct-bash", "printf 'ok\\n'", false, false, "1\n2\n3\n4\n5").callLines;
	const directExpanded = settle(directBash, "direct-bash", "printf 'ok\\n'", false, true, "1\n2\n3\n4\n5").callLines;

	const envelopeHarness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(envelopeHarness.api);
	toolFromHarness({ ...envelopeHarness, api: registrations.api }, "bash", "run-command");
	const operation: SuiteToolEnvelopeOperation = {
		args: { value: "printf 'ok\\n'" },
		id: "nested-bash",
		name: "bash",
		result: { content: [{ type: "text", text: "1\n2\n3\n4\n5" }], details: {} },
		state: "success",
	};
	registerSuiteToolEnvelope(
		registrations.api,
		{
			description: "Code Mode",
			execute: async () => ({ content: [], details: { operations: [operation] } }),
			label: "Code Mode",
			name: "codemode",
			parameters: Type.Object({ code: Type.String() }),
		},
		{ decode: () => [operation], registry: registrations.registry },
	);
	const envelope = envelopeHarness.tools.get("codemode");
	if (!envelope) throw new Error("missing Code Mode envelope");
	getToolUiRuntime(envelopeHarness.api).indexMessages(
		[
			assistant({ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "bash" } }),
			{ role: "toolResult", toolCallId: "outer", content: [], details: { operations: [operation] } },
		],
		true,
	);
	for (const [expanded, expected] of [
		[false, directCompact],
		[true, directExpanded],
	] as const) {
		const context = renderContext({}, { value: "unused" }, { expanded, toolCallId: "outer" });
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		const callComponent = envelope.renderCall?.({ code: "bash" }, theme, context as never);
		const body = envelope.renderResult?.(
			{ content: [], details: { operations: [operation] } },
			{ expanded, isPartial: false },
			theme,
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			{ ...context, lastComponent: callComponent } as never,
		);
		if (!body) throw new Error("missing Code Mode Bash body");
		expect(body.render(120)).toEqual(expected);
		expect(body.render(120).join("\n")).not.toContain("Call\n");
		expect(body.render(120).join("\n")).not.toContain("Result\n");
	}
});

test("non-retrieval image and web Tools stay independent boundaries", () => {
	const harness = apiHarness();
	const view = toolFromHarness(harness, "view", "view-image");
	const fetch = toolFromHarness(harness, "fetch", "fetch-page");
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn([
		assistant(
			call("v1", "view", "./images/sample.png"),
			call("v2", "view", "/project/images/sample.png"),
			call("f1", "fetch", "HTTPS://EXAMPLE.COM:443/a/../page#first"),
			call("f2", "fetch", "https://example.com/page#second"),
		),
	]);
	const first = settle(view, "v1", "./images/sample.png");
	settle(view, "v2", "/project/images/sample.png");
	settle(fetch, "f1", "HTTPS://EXAMPLE.COM:443/a/../page#first");
	settle(fetch, "f2", "https://example.com/page#second");
	runtime.endTurn();

	expect(renderLines(first.callComponent).join("\n")).toContain("view-image");
	expect(runtime.listGroups().map((group) => group.memberIds)).toEqual([["f2"], ["f1"], ["v2"], ["v1"]]);
});

test("projection rebuild rebinds grouped models to fresh Host row components", () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const grep = toolFromHarness(harness, "grep", "search-pattern");
	const runtime = getToolUiRuntime(harness.api);
	const messages = [assistant(call("r1", "read", "a.ts"), call("g1", "grep", "needle")), result("r1"), result("g1")];
	runtime.indexMessages(messages, true);
	settle(read, "r1", "a.ts");
	settle(grep, "g1", "needle");

	runtime.resetProjection(messages);
	const rebuiltLeader = settle(read, "r1", "a.ts");
	const rebuiltFollower = settle(grep, "g1", "needle");
	expect(renderLines(rebuiltLeader.callComponent).join("\n")).toContain("Searched 1 pattern, read 1 file");
	expect(renderLines(rebuiltFollower.callComponent)).toEqual([]);
});

test("projection replacement isolates reused IDs from stale rows, callbacks, and timers", async () => {
	const runtime = new ToolUiRuntime(ToolUiSettingsStore.memory());
	runtime.registerActivity("read", presentation("read-file").activity);
	runtime.registerActivity("edit", presentation("change-file").activity);
	runtime.markRendererAttached("read");
	runtime.markRendererAttached("edit");
	runtime.indexMessages([assistant(call("same", "read", "old.ts")), result("same")], true);
	const oldModel = {
		durationMs: undefined,
		label: "read",
		state: "success" as const,
		summary: "done",
		target: "old.ts",
	};
	const oldRow = new CachedToolRow(theme, oldModel);
	let oldInvalidations = 0;
	runtime.presentRow("same", oldRow, oldModel, true, () => oldInvalidations++, false, {
		args: { value: "old.ts" },
		name: "read",
	});
	await Promise.resolve();
	expect(oldInvalidations).toBe(1);
	runtime.startTimer("same", () => oldInvalidations++);
	runtime.setRowExpanded("same", true);
	runtime.suspend();

	const newModel = { ...oldModel, label: "edit", target: "new.ts" };
	const newRow = new CachedToolRow(theme, newModel);
	let newInvalidations = 0;
	runtime.presentRow("same", newRow, newModel, true, () => newInvalidations++, false, {
		args: { value: "new.ts" },
		name: "edit",
	});
	runtime.resetProjection([assistant(call("same", "edit", "new.ts")), result("same")]);
	await Promise.resolve();

	expect(oldInvalidations).toBe(1);
	expect(newInvalidations).toBe(1);
	expect(runtime.hasToolTimers()).toBe(false);
	expect(renderLines(oldRow).join("\n")).not.toContain("Changed");
	expect(renderLines(newRow).join("\n")).toContain("Edit(new.ts)");
	expect(renderLines(newRow).join("\n")).toContain("diff evidence unavailable");
});

test("a user input boundary prevents the next turn from reusing the previous group", () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn([assistant(call("r1", "read", "a.ts"))]);
	const first = settle(read, "r1", "a.ts");

	runtime.observeUserBoundary();
	runtime.startTurn();
	runtime.indexMessage(assistant(call("r2", "read", "b.ts")));
	const second = settle(read, "r2", "b.ts");
	expect(renderLines(first.callComponent).join("\n")).toContain("Read 1 file");
	expect(renderLines(second.callComponent).join("\n")).toContain("Reading 1 file");
	expect(runtime.resolveGroup("r1")).toMatchObject({ memberIds: ["r1"] });
	expect(runtime.resolveGroup("r2")).toMatchObject({ memberIds: ["r2"] });
});

test("turn end closes retrieval before an automatic continuation", () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn([assistant(call("r1", "read", "a.ts"))]);
	const leader = settle(read, "r1", "a.ts");
	runtime.endTurn();

	runtime.startTurn();
	runtime.indexMessage(assistant(call("r2", "read", "b.ts")));
	settle(read, "r2", "b.ts");
	expect(runtime.resolveGroup("r1")).toMatchObject({ memberIds: ["r1"] });
	expect(runtime.resolveGroup("r2")).toMatchObject({ memberIds: ["r2"] });
	expect(renderLines(leader.callComponent).join("\n")).toContain("Read 1 file");
});

test("Tool results and hidden Custom Messages stay transparent while Thinking closes the live group", () => {
	const harness = apiHarness();
	toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn([assistant(call("r1", "read", "a.ts"))]);
	runtime.indexMessage(result("r1"));
	runtime.indexMessage(assistant({ type: "thinking", thinking: "continue" }));
	runtime.indexMessage({
		role: "custom",
		customType: "state",
		content: "hidden",
		display: false,
	});
	const afterThinking = runtime.resolveGroup("r1");
	if (!afterThinking || afterThinking === "ambiguous") throw new Error("closed group missing");
	expect(afterThinking.summary).toContain("Read 1 file");

	runtime.indexMessage({
		role: "custom",
		customType: "notice",
		content: "visible",
		display: true,
	});
	const closed = runtime.resolveGroup("r1");
	if (!closed || closed === "ambiguous") throw new Error("closed group missing");
	expect(closed.summary).toContain("Read 1 file");
});

test("only the first visible update in a streamed Thinking run closes the Retrieval Group", () => {
	const harness = apiHarness();
	toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	const partial = assistant();
	const emitRead = (id: string, value: string) =>
		runtime.observeAssistantEvent({
			contentIndex: 0,
			// SAFETY: this test double implements the exact Pi members exercised by this case.
			partial: partial as never,
			toolCall: { type: "toolCall", id, name: "read", arguments: { value } },
			type: "toolcall_end",
		});

	runtime.startTurn();
	emitRead("r1", "a.ts");
	runtime.observeAssistantEvent({
		contentIndex: 1,
		delta: "inspect the next files",
		// SAFETY: this test double implements the exact Pi members exercised by this case.
		partial: partial as never,
		type: "thinking_delta",
	});
	emitRead("r2", "b.ts");
	runtime.observeAssistantEvent({
		contentIndex: 1,
		delta: " more",
		// SAFETY: this test double implements the exact Pi members exercised by this case.
		partial: partial as never,
		type: "thinking_delta",
	});
	emitRead("r3", "c.ts");

	expect(runtime.resolveGroup("r1")).toMatchObject({ memberIds: ["r1"] });
	expect(runtime.resolveGroup("r2")).toMatchObject({ memberIds: ["r2", "r3"] });
});

test("streaming Tool argument deltas do not rescan the accumulated argument", () => {
	const harness = apiHarness();
	toolFromHarness(harness, "write", "change-file");
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn();
	const pending = assistant();
	const started = performance.now();
	for (let index = 0; index < 800; index += 1) {
		runtime.observeAssistantEvent({
			type: "toolcall_delta",
			contentIndex: 0,
			delta: "x".repeat(10_000),
			// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
			partial: pending as never,
		});
	}
	runtime.observeAssistantEvent({
		type: "toolcall_end",
		contentIndex: 0,
		toolCall: { type: "toolCall", id: "large-write", name: "write", arguments: { value: "large.ts" } },
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		partial: pending as never,
	});

	expect(performance.now() - started).toBeLessThan(100);
	expect(runtime.resolveGroup("large-write")).toMatchObject({ memberIds: ["large-write"] });
});

test("an aborted final assistant message settles an unexecuted streamed Tool call", () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	const pending = assistant(call("r1", "read", "a.ts"));
	const aborted = {
		role: "assistant",
		content: [call("r1", "read", "a.ts")],
		stopReason: "aborted",
	};

	runtime.startTurn();
	runtime.observeAssistantEvent({
		contentIndex: 0,
		// SAFETY: this test double implements the exact Pi members exercised by this case.
		partial: pending as never,
		toolCall: { type: "toolCall", id: "r1", name: "read", arguments: { value: "a.ts" } },
		type: "toolcall_end",
	});
	const component = read.renderCall?.(
		{ value: "a.ts" },
		theme,
		renderContext({}, { value: "a.ts" }, { toolCallId: "r1" }),
	);
	if (!component) throw new Error("missing streamed call component");
	expect(renderLines(component).join("\n")).toContain("Reading 1 file");

	runtime.indexMessage(aborted);
	runtime.endTurn();
	const group = runtime.resolveGroup("r1");
	if (!group || group === "ambiguous") throw new Error("aborted group missing");
	expect(group.state).toBe("cancelled");
	expect(group.summary).toContain("cancelled");
	expect(group.summary).not.toContain("Reading");
	expect(renderLines(component).join("\n")).toContain("cancelled");
	runtime.clear();
});

test("unsupported Tool results never enter the owned pending-result cache or leak across projection resets", () => {
	const harness = apiHarness();
	toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessage(result("reused-id", "UNRELATED FAILURE", true));
	runtime.startTurn();
	runtime.indexMessage(assistant(call("reused-id", "read", "safe.ts")));
	const group = runtime.resolveGroup("reused-id");
	if (!group || group === "ambiguous") throw new Error("owned group missing after projection reset");
	expect(group.summary).toContain("Reading 1 file");
	expect(group.summary).not.toContain("failed");
});

test("Ctrl+O restores every member and bounded result detail", () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const grep = toolFromHarness(harness, "grep", "search-pattern");
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages(
		[assistant(call("r1", "read", "a.ts"), call("g1", "grep", "needle")), result("r1"), result("g1")],
		true,
	);

	const compactRead = settle(read, "r1", "a.ts");
	const compactGrep = settle(grep, "g1", "needle");
	expect(compactRead.callLines.join("\n")).toContain("Searched 1 pattern, read 1 file");
	expect(compactGrep.callLines).toEqual([]);

	const expandedRead = settle(read, "r1", "a.ts", false, true);
	const expandedGrep = settle(grep, "g1", "needle", false, true);
	expect(expandedRead.callLines.join("\n")).toContain("read-file");
	expect(expandedGrep.callLines.join("\n")).toContain("search-pattern");
	expect(expandedRead.resultLines.join("\n")).toContain("MODEL_VISIBLE");
	const formatted = [...expandedRead.resultLines, ...expandedGrep.resultLines].join("\n");
	expect(formatted).not.toContain("Call ID:");
	expect(formatted).not.toContain("Arguments");
	expect(formatted).not.toContain("Result content");
	expect(formatted).not.toContain("Details");
});
