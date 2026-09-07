import assert from "node:assert/strict";
import test from "node:test";
import type { GoalStateEntryData } from "../../../packages/pi-stuff/src/goal/src/persistence.js";
import { MAX_QUEUED_GOALS } from "../../../packages/pi-stuff/src/goal/src/persistence.js";
import {
	assistantUsageEntry,
	completionReport,
	completionTool,
	createHarness,
	lastState,
	settled,
	stateGoals,
	storedGoal,
	summary,
} from "../../goal-upstream/goal-queue-support.js";

test("experimental mode keeps singular registration and exposes canonical queue completions", async () => {
	const harness = await createHarness();
	assert.deepEqual([...harness.mock.commands.keys()], ["goal"]);
	assert.deepEqual(
		harness.mock.tools.map(({ name }) => name),
		["goal_complete", "goal_blocked"],
	);
	assert.equal(harness.mock.commands.has("goals"), false);
	assert.deepEqual(
		// SAFETY: this test controls the value and supplies every Array member exercised by this case.
		(harness.mock.commands.get("goal")?.getArgumentCompletions?.("") as Array<{ label: string }> | undefined)?.map(
			({ label }) => label,
		),
		["pause", "resume", "clear", "edit", "status", "add", "prioritize", "drop-last", "skip", "--tokens"],
	);
	assert.ok(
		harness.notifications.some(({ message, level }) => level === "warning" && /experimental.*goals/i.test(message)),
	);
});

test("add, prioritize, drop-last, and skip mutate one singular goal queue", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("first goal");
	await harness.command("add --tokens 2k last goal");
	assert.deepEqual(stateGoals(harness.mock).map(summary), [
		{ text: "first goal", status: "active", tokenBudget: undefined },
		{ text: "last goal", status: "queued", tokenBudget: 2_000 },
	]);

	await harness.command("prioritize urgent goal");
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["first goal", "last goal"],
	);

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "first goal", status: "queued" },
			{ text: "last goal", status: "queued" },
		],
	);

	await harness.command("drop-last");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["urgent goal", "first goal"],
	);

	idle = false;
	await harness.command("skip");
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "advance");
	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "first goal", status: "active" }],
	);
});

test("compatibility aliases route through the canonical queue operations", async () => {
	const harness = await createHarness();
	await harness.command("head");
	await harness.command("push tail");
	await harness.command("unshift urgent");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["urgent", "head", "tail"],
	);
	await harness.command("pop");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["urgent", "head"],
	);
	await harness.command("shift");
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text }) => text),
		["head"],
	);
});

test("the Goal queue rejects additions and priorities beyond its persisted bound", async () => {
	const harness = await createHarness();
	await harness.command("head");
	for (let index = 0; index < MAX_QUEUED_GOALS; index += 1) {
		await harness.command(`add queued ${index}`);
	}

	await harness.command("add overflow");
	assert.equal(lastState(harness.mock)?.queue?.length, MAX_QUEUED_GOALS);
	assert.match(harness.notifications.at(-1)?.message ?? "", /queue is full.*remove one/i);

	await harness.command("prioritize overflow");
	assert.equal(lastState(harness.mock)?.pendingAction, undefined);
	assert.match(harness.notifications.at(-1)?.message ?? "", /queue is full.*remove one/i);
});

test("goal_complete advances only after the finishing run settles", async () => {
	const branch = [assistantUsageEntry(500)];
	const harness = await createHarness({ sessionManager: { getBranch: () => branch, getEntries: () => branch } });
	await harness.command("--tokens 10k first goal");
	await harness.command("add second goal");
	const first = stateGoals(harness.mock)[0];
	assert.ok(first);

	branch.push(assistantUsageEntry(1_250));
	const result = await completionTool(harness.mock).execute(
		"complete-first",
		completionReport(first.id, "First goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.equal(result.terminate, undefined);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 1_250);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "first goal", status: "complete" },
			{ text: "second goal", status: "queued" },
		],
	);

	branch.push(assistantUsageEntry(400));
	await harness.command("status");
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 1_250);
	await harness.mock.callEvent(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					stopReason: "stop",
					content: [{ type: "text", text: "First goal final response." }],
				},
			],
		},
		harness.ctx,
	);
	assert.equal(stateGoals(harness.mock)[0]?.status, "complete");
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 1_250);
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "second goal", status: "active" }],
	);
	assert.equal(harness.notifications.at(-1)?.message, "Started next goal: second goal");
	assert.equal(
		harness.notifications.some(({ message }) => message.startsWith("Goal complete:")),
		false,
	);
});

test("a failed final response still advances the completed goal queue", async () => {
	const harness = await createHarness();
	await harness.command("first goal");
	await harness.command("add second goal");
	const first = stateGoals(harness.mock)[0];
	assert.ok(first);

	const result = await completionTool(harness.mock).execute(
		"complete-before-final-error",
		completionReport(first.id, "First goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.equal(result.terminate, undefined);
	assert.equal(stateGoals(harness.mock)[0]?.status, "complete");

	await harness.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "error", errorMessage: "final response unavailable" }] },
		harness.ctx,
	);
	assert.equal(stateGoals(harness.mock)[0]?.status, "complete");
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "second goal", status: "active" }],
	);
});

test("automatic queue advance preserves a shelved goal safety epoch", async () => {
	const urgent = storedGoal("urgent goal", "active");
	const shelved = {
		...storedGoal("shelved goal", "queued"),
		automaticModelTurns: 7,
		toolFreeRepeatCount: 2,
		lastToolFreeOutputFingerprint: "a".repeat(64),
	};
	const state: GoalStateEntryData = { goal: urgent, queue: [shelved] };
	const branch = [{ type: "custom", customType: "goal-state", data: state }];
	const harness = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});

	await completionTool(harness.mock).execute(
		"complete-urgent-for-safety",
		completionReport(urgent.id, "Urgent goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	await settled(harness);
	const activated = stateGoals(harness.mock)[0];
	assert.equal(activated?.text, "shelved goal");
	assert.equal(activated?.automaticModelTurns, 7);
	assert.equal(activated?.toolFreeRepeatCount, 2);
	assert.equal(activated?.lastToolFreeOutputFingerprint, "a".repeat(64));

	const prompt = harness.mock.sentUserMessages.at(-1)?.text ?? "";
	harness.mock.callEvent("input", { source: "extension", text: prompt }, harness.ctx);
	harness.mock.callEvent("before_agent_start", { prompt, systemPrompt: "base" }, harness.ctx);
	const started = stateGoals(harness.mock)[0];
	assert.equal(started?.automaticModelTurns, 7);
	assert.equal(started?.toolFreeRepeatCount, 2);
	assert.equal(started?.lastToolFreeOutputFingerprint, "a".repeat(64));
});

test("queued activation consumes promised resume and edit safety resets", async (t) => {
	const safety = {
		automaticModelTurns: 7,
		toolFreeRepeatCount: 2,
		lastToolFreeOutputFingerprint: "b".repeat(64),
		safetyPauseCause: "continuation_limit" as const,
	};
	for (const scenario of ["resume", "edit"] as const) {
		await t.test(scenario, async () => {
			const original = {
				...storedGoal("original goal", scenario === "resume" ? "paused" : "active"),
				...safety,
			};
			const branch = [{ type: "custom", customType: "goal-state", data: { goal: original, queue: [] } }];
			const harness = await createHarness({
				sessionManager: { getBranch: () => branch, getEntries: () => branch },
			});

			await harness.command(scenario === "resume" ? "resume" : "edit revised original goal");
			await harness.command("prioritize urgent goal");
			await harness.command("skip");

			const activated = stateGoals(harness.mock)[0];
			assert.equal(activated?.text, scenario === "resume" ? "original goal" : "revised original goal");
			assert.equal(activated?.status, "active");
			assert.equal(activated?.automaticModelTurns, 0);
			assert.equal(activated?.toolFreeRepeatCount, 0);
			assert.equal(activated?.lastToolFreeOutputFingerprint, undefined);
			assert.equal(activated?.safetyPauseCause, undefined);
			assert.equal(activated?.safetyResetPending, undefined);
		});
	}
});

test("pending completion advance survives reload before settlement", async () => {
	const interrupted = await createHarness({ isIdle: () => false });
	await interrupted.command("first goal");
	await interrupted.command("add second goal");
	const first = stateGoals(interrupted.mock)[0];
	assert.ok(first);
	await completionTool(interrupted.mock).execute(
		"complete-before-reload",
		completionReport(first.id, "First goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		interrupted.ctx,
	);
	const persisted = lastState(interrupted.mock);
	assert.equal(persisted?.pendingAction?.kind, "advance");

	const branch = [{ type: "custom", customType: "goal-state", data: persisted }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "second goal", status: "active" }],
	);
});
