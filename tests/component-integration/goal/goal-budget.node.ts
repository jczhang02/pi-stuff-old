import assert from "node:assert/strict";
import test from "node:test";
import {
	assertPromptHasGoalId,
	assistantUsageEntry,
	completionReport,
	goalStatusSnapshot,
	goalToolText,
	isRuntimeObject,
	lastGoalStatus,
	readAgentWorkOrigin,
	registerSuiteAgentMessagePreparation,
	requireGoalTool,
	requireLastGoal,
	STALE_GOAL_TOOL_REASON,
	startGoalForTest,
} from "../../goal-upstream/goal-test-support.js";

test("pause aborts the current turn, blocks stale tools, and persists paused state", async () => {
	let pauseAborts = 0;
	const paused = await startGoalForTest({ abort: () => pauseAborts++ });
	await paused.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, paused.ctx);
	await paused.mock.callEvent("agent_settled", {}, paused.ctx);
	const staleContinuation = paused.mock.sentUserMessages.at(-1)?.text ?? "";
	assert.match(staleContinuation, /pi-goal-continuation/);

	await paused.mock.commands.get("goal")?.handler("pause", paused.ctx);

	assert.equal(pauseAborts, 1);
	assert.equal(lastGoalStatus(paused.mock), "paused");
	assert.equal(goalStatusSnapshot(paused.mock.pi)?.status, "paused");
	assert.deepEqual(paused.mock.callEvent("input", { source: "extension", text: staleContinuation }, paused.ctx), {
		action: "handled",
	});
	assert.deepEqual(paused.mock.callEvent("tool_call", { toolName: "bash", toolCallId: "t1", input: {} }, paused.ctx), {
		block: true,
		reason: STALE_GOAL_TOOL_REASON,
	});
});

test("clear removes goal state without aborting or blocking stale tools", async () => {
	let clearAborts = 0;
	const cleared = await startGoalForTest({ abort: () => clearAborts++ });
	const beforeClearGoal = requireLastGoal(cleared.mock);
	await cleared.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, cleared.ctx);
	await cleared.mock.callEvent("agent_settled", {}, cleared.ctx);
	const staleContinuation = cleared.mock.sentUserMessages.at(-1)?.text ?? "";
	assert.match(staleContinuation, /pi-goal-continuation/);

	await cleared.mock.commands.get("goal")?.handler("clear", cleared.ctx);

	assert.equal(clearAborts, 0);
	assert.equal(lastGoalStatus(cleared.mock), null);
	assert.equal(goalStatusSnapshot(cleared.mock.pi), undefined);
	assert.deepEqual(cleared.mock.callEvent("input", { source: "extension", text: staleContinuation }, cleared.ctx), {
		action: "handled",
	});
	assert.equal(
		cleared.mock.callEvent("tool_call", { toolName: "edit", toolCallId: "t-clear", input: {} }, cleared.ctx),
		undefined,
	);

	const tool = requireGoalTool(cleared.mock, "goal_complete");
	const staleCompletion = await tool.execute(
		"call-after-clear",
		{ goal_id: beforeClearGoal.id, summary: "Implemented and verified." },
		new AbortController().signal,
		() => undefined,
		cleared.ctx,
	);

	assert.equal(staleCompletion.terminate, undefined);
	assert.match(staleCompletion.content?.[0]?.text ?? "", /no active goal/i);
});

test("clear releases stale tool-call block from a paused goal", async () => {
	let pauseAborts = 0;
	const paused = await startGoalForTest({ abort: () => pauseAborts++ });
	await paused.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, paused.ctx);

	await paused.mock.commands.get("goal")?.handler("pause", paused.ctx);

	assert.equal(pauseAborts, 1);
	assert.equal(lastGoalStatus(paused.mock), "paused");
	assert.deepEqual(
		paused.mock.callEvent("tool_call", { toolName: "bash", toolCallId: "t-paused", input: {} }, paused.ctx),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);

	await paused.mock.commands.get("goal")?.handler("clear", paused.ctx);

	assert.equal(lastGoalStatus(paused.mock), null);
	assert.equal(goalStatusSnapshot(paused.mock.pi), undefined);
	assert.equal(
		paused.mock.callEvent("tool_call", { toolName: "bash", toolCallId: "t-after-clear", input: {} }, paused.ctx),
		undefined,
	);
});

test("state changes between agent_end and agent_settled cancel stale continuation intent", async () => {
	for (const action of ["pause", "clear", "replace", "complete"] as const) {
		let aborts = 0;
		const changed = await startGoalForTest({ abort: () => aborts++ });
		const originalGoal = requireLastGoal(changed.mock);
		await changed.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, changed.ctx);

		if (action === "pause" || action === "clear") {
			await changed.mock.commands.get("goal")?.handler(action, changed.ctx);
		} else if (action === "replace") {
			await changed.mock.commands.get("goal")?.handler("replacement objective", changed.ctx);
		} else {
			await requireGoalTool(changed.mock, "goal_complete").execute(
				"complete-before-settled",
				completionReport(originalGoal.id, "The original Goal was implemented and verified."),
				new AbortController().signal,
				() => undefined,
				changed.ctx,
			);
		}

		const messagesBeforeSettled = changed.mock.sentUserMessages.length;
		await changed.mock.callEvent("agent_settled", {}, changed.ctx);
		assert.equal(
			changed.mock.sentUserMessages.length,
			messagesBeforeSettled,
			`${action} must not dispatch the stale continuation`,
		);
	}
});

test("tool_execution_end pauses a goal before another turn when terminal tools disappear", async () => {
	let aborts = 0;
	const active = await startGoalForTest({ abort: () => aborts++ });
	const kickoffPrompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.callEvent("before_agent_start", { prompt: kickoffPrompt, systemPrompt: "base" }, active.ctx);
	active.mock.rawPi.setActiveTools(["read", "bash"]);

	active.mock.callEvent(
		"tool_execution_end",
		{ toolCallId: "restricted-tool", toolName: "read", result: {}, isError: false },
		active.ctx,
	);

	assert.equal(lastGoalStatus(active.mock), "paused");
	assert.equal(aborts, 1);
	assert.deepEqual(
		active.mock.callEvent("tool_call", { toolName: "read", toolCallId: "next-tool", input: {} }, active.ctx),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);
});

test("tool_execution_end enforces budget once and injects one bounded wrap-up", async () => {
	const branch: unknown[] = [];
	let aborts = 0;
	const budgeted = await startGoalForTest(
		{
			abort: () => aborts++,
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
		},
		"--tokens 10 finish",
	);
	const goalId = requireLastGoal(budgeted.mock).id;
	branch.push(assistantUsageEntry({ totalTokens: 12 }));

	const toolEnd = budgeted.mock.events.get("tool_execution_end")?.[0];
	await toolEnd?.({ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false }, budgeted.ctx);
	await toolEnd?.({ toolCallId: "tool-2", toolName: "read", result: {}, isError: false }, budgeted.ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");
	assert.equal(requireLastGoal(budgeted.mock).tokensUsed, 12);
	assert.deepEqual(goalStatusSnapshot(budgeted.mock.pi), {
		status: "budget_limited",
		timeUsedSeconds: requireLastGoal(budgeted.mock).timeUsedSeconds,
		tokenBudget: 10,
		tokensUsed: 12,
	});
	assert.equal(budgeted.mock.sentMessages.length, 1);
	const wrapUp = budgeted.mock.sentMessages[0];
	assert.ok(wrapUp);
	assert.deepEqual(wrapUp.options, { deliverAs: "steer" });
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const wrapUpMessage = wrapUp.message as { customType?: string; content?: string };
	assert.equal(wrapUpMessage.customType, "goal-budget-wrap-up");
	assert.equal(readAgentWorkOrigin(wrapUpMessage), "automatic");
	assert.match(String(wrapUpMessage.content), /stop substantive work/i);
	assert.match(String(wrapUpMessage.content), /do not call substantive tools/i);
	assert.match(String(wrapUpMessage.content), /summarize progress/i);
	assert.match(String(wrapUpMessage.content), /goal_complete.*evidence/i);
	assert.match(String(wrapUpMessage.content), /completion as unproven/i);
	assert.match(String(wrapUpMessage.content), /weak, indirect, or missing evidence/i);
	assert.match(String(wrapUpMessage.content), /budget exhaustion.*not completion/i);
	assert.ok(String(wrapUpMessage.content).length < 1_000);

	await budgeted.mock.callEvent("agent_settled", {}, budgeted.ctx);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);
	assert.deepEqual(
		budgeted.mock.callEvent(
			"tool_call",
			{ toolName: "bash", toolCallId: "substantive-after-budget", input: {} },
			budgeted.ctx,
		),
		{
			block: true,
			reason: "Goal token budget is exhausted; only goal_complete is allowed during wrap-up.",
		},
	);
	assert.equal(aborts, 1);
	assert.equal(
		budgeted.mock.callEvent(
			"tool_call",
			{ toolName: "goal_complete", toolCallId: "complete-after-budget", input: {} },
			budgeted.ctx,
		),
		undefined,
	);

	const completion = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"complete-after-budget",
		completionReport(goalId, "All requirements were already implemented and verified."),
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.equal(completion.terminate, true);
	assert.doesNotMatch(goalToolText(completion), /send the user a concise final response/i);
	assert.equal(lastGoalStatus(budgeted.mock), null);
});

test("rejected completion closes a budget wrap-up without another model call", async () => {
	const branch: unknown[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	const goalId = requireLastGoal(budgeted.mock).id;
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.callEvent(
		"tool_execution_end",
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);

	const rejected = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"rejected-budget-completion",
		{ goal_id: goalId, summary: "Tests are still failing." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.equal(rejected.terminate, true);
	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");

	const retry = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"retry-budget-completion",
		{ goal_id: goalId, summary: "Everything is now complete." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.equal(retry.terminate, undefined);
	assert.match(retry.content?.[0]?.text ?? "", /budget_limited, not active/i);
});

test("stale completion also closes a budget wrap-up after recording final usage", async () => {
	const branch: unknown[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	const goalId = requireLastGoal(budgeted.mock).id;
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.callEvent(
		"tool_execution_end",
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);
	branch.push(assistantUsageEntry({ totalTokens: 3 }));

	const rejected = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"stale-budget-completion",
		{ goal_id: "stale-goal-id", summary: "Everything is complete." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.equal(rejected.terminate, true);
	assert.match(rejected.content?.[0]?.text ?? "", /goal_id does not match/i);
	assert.equal(requireLastGoal(budgeted.mock).tokensUsed, 15);

	const retry = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"retry-after-stale-budget-completion",
		{ goal_id: goalId, summary: "Everything is complete." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.match(retry.content?.[0]?.text ?? "", /budget_limited, not active/i);
});

test("failed budget wrap-up delivery retries once without duplicate accepted messages", async () => {
	const branch: unknown[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	const sendMessage = budgeted.mock.rawPi.sendMessage.bind(budgeted.mock.rawPi);
	let attempts = 0;
	budgeted.mock.rawPi.sendMessage = (message, options) => {
		attempts++;
		if (attempts === 1) throw new Error("queue unavailable");
		sendMessage(message, options);
	};

	const toolEnd = budgeted.mock.events.get("tool_execution_end")?.[0];
	await toolEnd?.({ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false }, budgeted.ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");
	assert.equal(budgeted.mock.sentMessages.length, 0);
	assert.match(budgeted.notifications.at(-1)?.message ?? "", /queue unavailable/i);

	await toolEnd?.({ toolCallId: "tool-2", toolName: "read", result: {}, isError: false }, budgeted.ctx);
	await toolEnd?.({ toolCallId: "tool-3", toolName: "read", result: {}, isError: false }, budgeted.ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(attempts, 2);
	assert.equal(budgeted.mock.sentMessages.length, 1);
});

test("a cleared Goal cannot deliver a budget wrap-up still awaiting Suite preparation", async () => {
	const branch: unknown[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	const preparation = Promise.withResolvers<void>();
	const unregister = registerSuiteAgentMessagePreparation(budgeted.mock.pi, { prepare: () => preparation.promise });
	branch.push(assistantUsageEntry({ totalTokens: 12 }));

	await budgeted.mock.callEvent(
		"tool_execution_end",
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	await budgeted.mock.commands.get("goal")?.handler("clear", budgeted.ctx);
	preparation.resolve();
	await new Promise<void>((resolve) => setImmediate(resolve));

	assert.equal(lastGoalStatus(budgeted.mock), null);
	assert.equal(budgeted.mock.sentMessages.length, 0);
	unregister();
});

test("budget wrap-up permission closes at agent_end and stale context is filtered", async () => {
	const branch: unknown[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	const goalId = requireLastGoal(budgeted.mock).id;
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.callEvent(
		"tool_execution_end",
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);
	await budgeted.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, budgeted.ctx);

	const rejected = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"late-completion",
		{ goal_id: goalId, summary: "Late stale completion." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.match(rejected.content?.[0]?.text ?? "", /budget_limited, not active/i);
	assert.equal(rejected.terminate, undefined);

	// SAFETY: the Goal context hook owns this result and returns only its optional filtered messages projection.
	const contextResult = budgeted.mock.callEvent(
		"context",
		{
			messages: [
				{ role: "user", content: "keep" },
				{ role: "custom", customType: "goal-budget-wrap-up", content: "stale" },
			],
		},
		budgeted.ctx,
	) as { messages?: unknown[] } | undefined;
	assert.deepEqual(contextResult?.messages, [{ role: "user", content: "keep" }]);
});

test("budget wrap-up does not consume a pending transformed follow-up", async () => {
	const branch: unknown[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	const goalId = requireLastGoal(budgeted.mock).id;
	budgeted.mock.callEvent(
		"input",
		{ source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
		budgeted.ctx,
	);
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.callEvent(
		"tool_execution_end",
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);

	budgeted.mock.callEvent("before_agent_start", { prompt: "budget wrap-up", systemPrompt: "base" }, budgeted.ctx);

	assert.deepEqual(
		budgeted.mock.callEvent("tool_call", { toolName: "read", toolCallId: "wrap-up-read", input: {} }, budgeted.ctx),
		{
			block: true,
			reason: "Goal token budget is exhausted; only goal_complete is allowed during wrap-up.",
		},
	);
	assert.equal(
		budgeted.mock.callEvent(
			"tool_call",
			{ toolName: "goal_complete", toolCallId: "wrap-up-complete", input: {} },
			budgeted.ctx,
		),
		undefined,
	);
	const completion = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"wrap-up-complete",
		completionReport(goalId, "All requirements were implemented and verified."),
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.equal(completion.terminate, true);
});

test("budget wrap-up custom message retains goal ownership through agent_end", async () => {
	const branch: unknown[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.callEvent(
		"tool_execution_end",
		{ toolCallId: "tool-1", toolName: "bash", result: {}, isError: false },
		budgeted.ctx,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const queuedWrapUp = budgeted.mock.sentMessages[0]?.message;
	assert.ok(isRuntimeObject(queuedWrapUp) && queuedWrapUp !== null && !Array.isArray(queuedWrapUp));
	const wrapUpMessage = { role: "custom", ...queuedWrapUp };

	budgeted.mock.callEvent("before_agent_start", { prompt: "budget wrap-up", systemPrompt: "base" }, budgeted.ctx);
	budgeted.mock.callEvent("message_start", { message: wrapUpMessage }, budgeted.ctx);
	await budgeted.mock.callEvent(
		"agent_end",
		{ messages: [wrapUpMessage, { role: "assistant", stopReason: "stop", content: [] }] },
		budgeted.ctx,
	);

	assert.equal(
		budgeted.mock.callEvent("tool_call", { toolName: "read", toolCallId: "after-wrap-up", input: {} }, budgeted.ctx),
		undefined,
	);
});

test("compaction cancels before retry when persisted usage has exhausted the budget", async () => {
	const branch: unknown[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	branch.push(assistantUsageEntry({ totalTokens: 12 }));

	const result = await budgeted.mock.callEvent(
		"session_before_compact",
		{ reason: "overflow", willRetry: true },
		budgeted.ctx,
	);
	assert.deepEqual(result, { cancel: true });
	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");
	assert.equal(budgeted.mock.sentMessages.length, 0);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);

	await budgeted.mock.callEvent("session_compact", { reason: "overflow", willRetry: true }, budgeted.ctx);
	await budgeted.mock.callEvent("agent_settled", {}, budgeted.ctx);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);
});

test("budget edits require an actual increase before reactivating and rotate stale ids", async () => {
	const branch: unknown[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	branch.push(assistantUsageEntry({ totalTokens: 10 }));
	await budgeted.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, budgeted.ctx);
	const exhaustedGoal = requireLastGoal(budgeted.mock);
	assert.equal(exhaustedGoal.status, "budget_limited");

	await budgeted.mock.commands.get("goal")?.handler("edit unchanged budget", budgeted.ctx);
	const unchanged = requireLastGoal(budgeted.mock);
	assert.equal(unchanged.status, "budget_limited");
	assert.notEqual(unchanged.id, exhaustedGoal.id);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);

	const staleCompletion = await requireGoalTool(budgeted.mock, "goal_complete").execute(
		"stale-budget-completion",
		{ goal_id: exhaustedGoal.id, summary: "Stale completion." },
		new AbortController().signal,
		() => undefined,
		budgeted.ctx,
	);
	assert.match(staleCompletion.content?.[0]?.text ?? "", /goal_id/i);

	await budgeted.mock.commands.get("goal")?.handler("edit --tokens 20 increased budget", budgeted.ctx);
	const increased = requireLastGoal(budgeted.mock);
	assert.equal(increased.status, "active");
	assert.equal(increased.tokenBudget, 20);
	assert.notEqual(increased.id, unchanged.id);
	assert.equal(budgeted.mock.sentUserMessages.length, 2);
	assertPromptHasGoalId(budgeted.mock.sentUserMessages.at(-1)?.text ?? "", increased.id);
});

test("failed budget-increase edit delivery restores the limited goal and stale id", async () => {
	const branch: unknown[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 original objective",
	);
	branch.push(assistantUsageEntry({ totalTokens: 10 }));
	await budgeted.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, budgeted.ctx);
	const limited = requireLastGoal(budgeted.mock);
	budgeted.mock.rawPi.sendUserMessage = () => {
		throw new Error("edit delivery failed");
	};

	await budgeted.mock.commands.get("goal")?.handler("edit --tokens 20 changed objective", budgeted.ctx);
	const restored = requireLastGoal(budgeted.mock);
	assert.equal(restored.id, limited.id);
	assert.equal(restored.text, limited.text);
	assert.equal(restored.tokenBudget, limited.tokenBudget);
	assert.equal(restored.status, "budget_limited");
	assert.match(budgeted.notifications.at(-1)?.message ?? "", /edit delivery failed/i);
});

test("budget exhaustion between agent_end and agent_settled cancels continuation intent", async () => {
	const branch = [
		{
			type: "message",
			message: { role: "assistant", usage: { input: 0, output: 0 } },
		},
	];
	const budgeted = await startGoalForTest(
		{
			sessionManager: { getBranch: () => branch, getEntries: () => [] },
		},
		"--tokens 1 finish",
	);

	branch.push({
		type: "message",
		message: { role: "assistant", usage: { input: 1, output: 0 } },
	});
	await budgeted.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, budgeted.ctx);
	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");
	assert.equal(budgeted.mock.sentMessages.length, 0);

	await budgeted.mock.callEvent("agent_settled", {}, budgeted.ctx);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);
});
