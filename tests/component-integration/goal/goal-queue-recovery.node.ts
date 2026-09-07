import assert from "node:assert/strict";
import test from "node:test";
import type { GoalStateEntryData } from "../../../packages/pi-stuff/src/goal/src/persistence.js";
import {
	assistantUsageEntry,
	blockedTool,
	completionReport,
	completionTool,
	createHarness,
	lastState,
	settled,
	stateGoals,
	storedGoal,
} from "../../goal-upstream/goal-queue-support.js";
import { goalStatusSnapshot } from "../../goal-upstream/support.js";

test("pending busy skip survives reload without reactivating the old head", async () => {
	const interrupted = await createHarness({ isIdle: () => false });
	await interrupted.command("old head");
	await interrupted.command("add next head");
	await interrupted.command("skip");
	const persisted = lastState(interrupted.mock);
	assert.equal(persisted?.pendingAction?.kind, "advance");

	const branch = [{ type: "custom", customType: "goal-state", data: persisted }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "next head", status: "active" }],
	);
});

test("restored skip dispatches before the skipped head is budget-limited", async () => {
	const oldHead = { ...storedGoal("budgeted head", "active"), tokenBudget: 10 };
	const state: GoalStateEntryData = {
		goal: oldHead,
		queue: [storedGoal("next head", "queued")],
		pendingAction: {
			kind: "advance",
			goalId: oldHead.id,
			reason: "skip",
			completedText: oldHead.text,
		},
	};
	const branch = [assistantUsageEntry(12), { type: "custom", customType: "goal-state", data: state }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});

	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "next head", status: "active" }],
	);
	assert.equal(lastState(restored.mock)?.pendingAction, undefined);
});

test("a pending busy skip consumes an accepted owned prompt before advancement", async () => {
	let aborts = 0;
	const harness = await createHarness({
		isIdle: () => false,
		abort: () => {
			aborts += 1;
		},
	});
	await harness.command("old head");
	const ownedPrompt = harness.mock.sentUserMessages.at(-1)?.text;
	assert.ok(ownedPrompt);
	await harness.command("add next head");
	await harness.command("skip");

	const result = await harness.mock.callEvent("input", { source: "extension", text: ownedPrompt }, harness.ctx);
	assert.deepEqual(result, { action: "handled" });
	assert.equal(aborts, 0);
});

test("a pending busy skip does not abort unrelated user work before advancement", async () => {
	let aborts = 0;
	const harness = await createHarness({
		isIdle: () => false,
		abort: () => {
			aborts += 1;
		},
	});
	await harness.command("old head");
	await harness.command("add next head");
	await harness.command("skip");

	const beforeStart = harness.mock.events.get("before_agent_start")?.[0];
	const result = await beforeStart?.({ prompt: "newer unrelated work", systemPrompt: "base" }, harness.ctx);
	assert.equal(result, undefined);
	assert.equal(aborts, 0);
});

test("pending skip rejects stale completion without rewriting the skip intent", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("old head");
	await harness.command("add next head");
	const oldHead = stateGoals(harness.mock)[0];
	assert.ok(oldHead);
	await harness.command("skip");

	const result = await completionTool(harness.mock).execute(
		"complete-after-skip",
		completionReport(oldHead.id, "Old head completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.equal(result.terminate, true);
	assert.match(result.content?.[0]?.text ?? "", /queued to be skipped/i);
	assert.equal(lastState(harness.mock)?.goal?.status, "active");
	assert.deepEqual(lastState(harness.mock)?.pendingAction, {
		kind: "advance",
		goalId: oldHead.id,
		reason: "skip",
		completedText: "old head",
	});

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["next head"],
	);
});

test("pending skip terminates completion before missing or mismatched id rejection", async () => {
	const harness = await createHarness({ isIdle: () => false });
	await harness.command("old head");
	await harness.command("add next head");
	const oldHead = stateGoals(harness.mock)[0];
	assert.ok(oldHead);
	await harness.command("skip");

	for (const goalId of ["", "different-goal-id"]) {
		const result = await completionTool(harness.mock).execute(
			`stale-complete-after-skip-${goalId || "missing"}`,
			completionReport(goalId, "Old head completed and verified."),
			new AbortController().signal,
			() => undefined,
			harness.ctx,
		);
		assert.equal(result.terminate, true);
		assert.match(result.content?.[0]?.text ?? "", /queued to be skipped/i);
	}
	assert.equal(lastState(harness.mock)?.goal?.status, "active");
	assert.deepEqual(lastState(harness.mock)?.pendingAction, {
		kind: "advance",
		goalId: oldHead.id,
		reason: "skip",
		completedText: "old head",
	});
});

test("pending skip rejects stale blocked reports without rewriting terminal state", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("old head");
	await harness.command("add next head");
	const oldHead = stateGoals(harness.mock)[0];
	assert.ok(oldHead);
	await harness.command("skip");

	const result = await blockedTool(harness.mock).execute(
		"block-after-skip",
		{
			goal_id: oldHead.id,
			reason: "External access required",
			attempt: "Requested access through the skipped goal's configured remote.",
			evidence: "Three verified attempts require external access.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.equal(result.terminate, true);
	assert.match(result.content?.[0]?.text ?? "", /queued to be skipped/i);
	assert.equal(lastState(harness.mock)?.goal?.status, "active");
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "advance");

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["next head"],
	);
});

test("pending skip terminates blocked reports before missing or mismatched id rejection", async () => {
	const harness = await createHarness({ isIdle: () => false });
	await harness.command("old head");
	await harness.command("add next head");
	const oldHead = stateGoals(harness.mock)[0];
	assert.ok(oldHead);
	await harness.command("skip");

	for (const goalId of ["", "different-goal-id"]) {
		const result = await blockedTool(harness.mock).execute(
			`stale-block-after-skip-${goalId || "missing"}`,
			{
				goal_id: goalId,
				reason: "External access required",
				attempt: "Requested access through the stale goal's configured remote.",
				evidence: "Three verified attempts require external access.",
				repeated_turns: 3,
			},
			new AbortController().signal,
			() => undefined,
			harness.ctx,
		);
		assert.equal(result.terminate, true);
		assert.match(result.content?.[0]?.text ?? "", /queued to be skipped/i);
	}
	assert.equal(lastState(harness.mock)?.goal?.status, "active");
	assert.deepEqual(lastState(harness.mock)?.pendingAction, {
		kind: "advance",
		goalId: oldHead.id,
		reason: "skip",
		completedText: "old head",
	});
});

test("finalized priority dispatches after manual compaction becomes idle", async () => {
	const branch: unknown[] = [assistantUsageEntry(100)];
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("old head");
	await harness.command("prioritize urgent head");
	await harness.mock.callEvent(
		"before_agent_start",
		{ prompt: "unrelated user work", systemPrompt: "base" },
		harness.ctx,
	);
	const finalizedState = lastState(harness.mock);
	branch.push(assistantUsageEntry(25), {
		type: "custom",
		customType: "goal-state",
		data: finalizedState,
	});

	await harness.mock.callEvent("session_compact", { reason: "manual", willRetry: false }, harness.ctx);
	idle = true;
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status, tokensUsed }) => ({ text, status, tokensUsed })),
		[
			{ text: "urgent head", status: "active", tokensUsed: 0 },
			{ text: "old head", status: "queued", tokensUsed: 0 },
		],
	);
});

test("manual compaction dispatches pending priority before old-head budget limiting", async () => {
	const branch: unknown[] = [];
	let idle = true;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("--tokens 10 old head");
	await harness.command("add tail");
	idle = false;
	await harness.command("prioritize urgent head");
	const state = lastState(harness.mock);
	branch.push(assistantUsageEntry(12), { type: "custom", customType: "goal-state", data: state });
	idle = true;
	const beforeCompact = await harness.mock.callEvent(
		"session_before_compact",
		{ reason: "manual", willRetry: false },
		harness.ctx,
	);
	assert.equal(beforeCompact, undefined);
	await harness.mock.callEvent("session_compact", { reason: "manual", willRetry: false }, harness.ctx);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent head", status: "active" },
			{ text: "old head", status: "queued" },
			{ text: "tail", status: "queued" },
		],
	);
	assert.doesNotMatch(harness.mock.sentUserMessages.at(-1)?.text ?? "", /pi-goal-continuation:/i);
});

test("retry and compaction lifecycle snapshots preserve the queued tail", async () => {
	const branch: unknown[] = [assistantUsageEntry(0)];
	const harness = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("head");
	await harness.command("add tail");
	await harness.mock.callEvent(
		"agent_end",
		{
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "rate limit; please retry" }],
		},
		harness.ctx,
	);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "head", status: "active" },
			{ text: "tail", status: "queued" },
		],
	);

	const state = lastState(harness.mock);
	branch.push({ type: "custom", customType: "goal-state", data: state });
	await harness.mock.callEvent("session_compact", { reason: "manual", willRetry: false }, harness.ctx);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["head", "tail"],
	);
});

test("budget limiting the head preserves the queued tail", async () => {
	const branch: unknown[] = [assistantUsageEntry(0)];
	const harness = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("--tokens 10 budgeted head");
	await harness.command("add later goal");
	branch.push(assistantUsageEntry(12));
	await harness.mock.callEvent("tool_execution_end", {}, harness.ctx);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "budgeted head", status: "budget_limited" },
			{ text: "later goal", status: "queued" },
		],
	);
});

test("failed priority delivery restores and pauses the previous active head", async () => {
	const harness = await createHarness();
	await harness.command("original goal");
	harness.mock.rawPi.sendUserMessage = () => {
		throw new Error("priority delivery unavailable");
	};
	await harness.command("prioritize urgent goal");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "original goal", status: "paused" }],
	);
	assert.equal(lastState(harness.mock)?.pendingAction, undefined);
});

test("failed priority tool preparation clears intent and pauses the active head", async () => {
	const harness = await createHarness();
	await harness.command("original goal");
	harness.mock.rawPi.setActiveTools(["goal_complete"]);
	await harness.command("prioritize urgent goal");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "original goal", status: "paused" }],
	);
	assert.equal(lastState(harness.mock)?.pendingAction, undefined);
});

test("an old head id cannot complete the newly activated goal", async () => {
	const harness = await createHarness();
	await harness.command("first goal");
	await harness.command("add second goal");
	const first = stateGoals(harness.mock)[0];
	assert.ok(first);
	await completionTool(harness.mock).execute(
		"complete-first-for-stale-id",
		completionReport(first.id, "First goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	await settled(harness);
	const stale = await completionTool(harness.mock).execute(
		"stale-completion",
		completionReport(first.id, "Second goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(stale.content?.[0]?.text ?? "", /goal_id does not match/i);
	assert.equal(stateGoals(harness.mock)[0]?.text, "second goal");
});

test("failed next-goal delivery pauses the next head without losing it", async () => {
	const harness = await createHarness();
	await harness.command("first goal");
	await harness.command("add second goal");
	const first = stateGoals(harness.mock)[0];
	assert.ok(first);
	await completionTool(harness.mock).execute(
		"complete-first-before-failure",
		completionReport(first.id, "First goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	harness.mock.rawPi.sendUserMessage = () => {
		throw new Error("delivery unavailable");
	};
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "second goal", status: "paused" }],
	);
});

test("a restrictive tool policy pauses the next queued head", async () => {
	const harness = await createHarness();
	await harness.command("first goal");
	await harness.command("add second goal");
	const first = stateGoals(harness.mock)[0];
	assert.ok(first);
	await completionTool(harness.mock).execute(
		"complete-before-policy",
		completionReport(first.id, "First goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	harness.mock.rawPi.setActiveTools(["goal_complete"]);
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "second goal", status: "paused" }],
	);
});

test("separate factory runtimes keep independent queues", async () => {
	const root = await createHarness();
	const child = await createHarness();
	await root.command("root head");
	await root.command("add root tail");
	await child.command("child head");
	await child.command("add child tail");

	const rootHead = stateGoals(root.mock)[0];
	assert.ok(rootHead);
	await completionTool(root.mock).execute(
		"complete-root",
		completionReport(rootHead.id, "Root head completed and verified."),
		new AbortController().signal,
		() => undefined,
		root.ctx,
	);
	await settled(root);
	assert.deepEqual(
		stateGoals(root.mock).map(({ text }) => text),
		["root tail"],
	);
	assert.deepEqual(
		stateGoals(child.mock).map(({ text }) => text),
		["child head", "child tail"],
	);
});

test("disabled settings freeze retained queues without losing state", async () => {
	const frozenState: GoalStateEntryData = {
		goal: storedGoal("head", "active"),
		queue: [storedGoal("later", "queued")],
	};
	const branch = [{ type: "custom", customType: "goal-state", data: frozenState }];
	const harness = await createHarness(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		false,
	);

	assert.equal(goalStatusSnapshot(harness.mock.pi)?.status, "active");
	assert.equal(harness.mock.sentUserMessages.length, 0);
	await harness.command("");
	assert.match(harness.notifications.at(-1)?.message ?? "", /queue.*off|re-enable/i);
	await harness.command("resume");
	assert.match(harness.notifications.at(-1)?.message ?? "", /re-enable.*reload/i);
	assert.equal(lastState(harness.mock)?.queue?.[0]?.text, "later");

	const retained = lastState(harness.mock);
	assert.ok(retained);
	const restoredBranch = [{ type: "custom", customType: "goal-state", data: retained }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => restoredBranch, getEntries: () => restoredBranch },
	});
	assert.equal(goalStatusSnapshot(restored.mock.pi)?.status, "active");
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text }) => text),
		["head", "later"],
	);

	await harness.command("clear");
	assert.deepEqual(lastState(harness.mock), { goal: null });
});
