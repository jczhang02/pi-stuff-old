import assert from "node:assert/strict";
import test from "node:test";
import {
	assertPromptHasGoalId,
	assistantUsageEntry,
	assistantUsageTokens,
	buildGoalSystemPrompt,
	completeGoalArguments,
	completionReport,
	cumulativeAssistantTokens,
	EMERGENCY_AUTOMATIC_TURN_LIMIT,
	findPersistedGoal,
	formatDuration,
	formatStatus,
	formatTokenCount,
	goalStatusSnapshot,
	LOW_LIMITS_SETTINGS_PATH,
	lastGoalStatus,
	parseCommand,
	parseTokenBudget,
	requireGoalTool,
	requireLastGoal,
	restoreGoalForTest,
	restoreStoredGoalForTest,
	type StoredGoal,
	startGoalForTest,
} from "../../goal-upstream/goal-test-support.js";

test("completeGoalArguments suggests /goal subcommands and token options", () => {
	assert.deepEqual(
		completeGoalArguments("")?.map((item) => item.label),
		["pause", "resume", "clear", "edit", "status", "--tokens"],
	);
	assert.deepEqual(
		completeGoalArguments("")?.map((item) => item.description),
		[
			"Pause the active goal",
			"Resume a stopped or budget-limited goal",
			"Clear the current goal",
			"Edit the current goal objective",
			"Show the current goal",
			"Set a token budget before the goal",
		],
	);
	assert.deepEqual(
		completeGoalArguments("pa")?.map((item) => item.value),
		["pause"],
	);
	assert.deepEqual(
		completeGoalArguments("pause")?.map((item) => item.value),
		["pause"],
	);
	assert.deepEqual(
		completeGoalArguments("--t")?.map((item) => item.value),
		["--tokens "],
	);
	assert.deepEqual(
		completeGoalArguments("edit ")?.map((item) => item.value),
		["edit --tokens "],
	);
	assert.deepEqual(
		completeGoalArguments("edit --t")?.map((item) => item.value),
		["edit --tokens "],
	);
	assert.equal(completeGoalArguments("ship objective"), null);
	assert.equal(completeGoalArguments("edit objective"), null);
});

test("parseCommand parses budgets, quoted objectives, and management commands", () => {
	assert.deepEqual(parseCommand('--tokens 1.5k "ship tests"'), {
		kind: "start",
		objective: "ship tests",
		tokenBudget: 1500,
	});
	assert.deepEqual(parseCommand("edit --tokens 2m revise scope"), {
		kind: "edit",
		objective: "revise scope",
		tokenBudget: 2_000_000,
	});
	assert.deepEqual(parseCommand("pause"), { kind: "pause" });
	assert.equal(parseCommand("pause now"), "Usage: /goal pause");
});

test("assistant token accounting prefers totalTokens and uses a cache-inclusive fallback", () => {
	assert.equal(
		assistantUsageTokens({
			totalTokens: 100,
			input: 40,
			output: 10,
			cacheRead: 30,
			cacheWrite: 20,
		}),
		100,
	);
	assert.equal(assistantUsageTokens({ input: 10, output: 5, cacheRead: 20, cacheWrite: 3 }), 38);
	assert.equal(
		assistantUsageTokens({
			totalTokens: -1,
			input: 10,
			output: Number.NaN,
			cacheRead: -20,
			cacheWrite: 3,
		}),
		13,
	);
	assert.equal(assistantUsageTokens({ totalTokens: Number.POSITIVE_INFINITY }), 0);
	assert.equal(
		assistantUsageTokens({
			input: Number.MAX_SAFE_INTEGER,
			output: Number.MAX_SAFE_INTEGER,
			cacheRead: Number.MAX_SAFE_INTEGER,
			cacheWrite: Number.MAX_SAFE_INTEGER,
		}),
		Number.MAX_SAFE_INTEGER,
	);
	assert.equal(assistantUsageTokens(undefined), 0);

	assert.equal(
		cumulativeAssistantTokens([
			{ type: "message", message: { role: "assistant", usage: { totalTokens: 25 } } },
			{ type: "message", message: { role: "user", usage: { totalTokens: 500 } } },
			{
				type: "message",
				message: {
					role: "assistant",
					usage: { input: 5, output: 2, cacheRead: 7, cacheWrite: 1 },
				},
			},
			{ type: "custom", data: { usage: { totalTokens: 999 } } },
		]),
		40,
	);
	assert.equal(
		cumulativeAssistantTokens([
			{
				type: "message",
				message: { role: "assistant", usage: { totalTokens: Number.MAX_SAFE_INTEGER } },
			},
			{ type: "message", message: { role: "assistant", usage: { totalTokens: 1 } } },
		]),
		Number.MAX_SAFE_INTEGER,
	);
});

test("goal token usage subtracts its baseline and clamps branch rewinds", async () => {
	const branch: unknown[] = [assistantUsageEntry({ totalTokens: 100 })];
	const tracked = await startGoalForTest({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});

	branch.push(assistantUsageEntry({ totalTokens: 40, input: 999, output: 999 }));
	await tracked.mock.commands.get("goal")?.handler("", tracked.ctx);
	assert.equal(requireLastGoal(tracked.mock).tokensUsed, 40);

	branch.splice(0, branch.length, assistantUsageEntry({ totalTokens: 50 }));
	await tracked.mock.commands.get("goal")?.handler("", tracked.ctx);
	assert.equal(requireLastGoal(tracked.mock).tokensUsed, 0);

	branch.push(assistantUsageEntry({ input: 20, output: 10, cacheRead: 30, cacheWrite: 20 }));
	await tracked.mock.commands.get("goal")?.handler("", tracked.ctx);
	assert.equal(requireLastGoal(tracked.mock).tokensUsed, 30);
});

test("active elapsed time excludes stopped waits and survives active edits", async (t) => {
	let now = 10_000;
	t.mock.method(Date, "now", () => now);
	const timed = await startGoalForTest();
	assert.equal(requireLastGoal(timed.mock).activeStartedAt, now);

	now += 4_250;
	await timed.mock.commands.get("goal")?.handler("pause", timed.ctx);
	assert.equal(requireLastGoal(timed.mock).timeUsedSeconds, 4.25);
	assert.equal(requireLastGoal(timed.mock).activeStartedAt, undefined);

	now += 100_000;
	await timed.mock.commands.get("goal")?.handler("", timed.ctx);
	assert.equal(requireLastGoal(timed.mock).timeUsedSeconds, 4.25);
	assert.match(timed.notifications.at(-1)?.message ?? "", /Active elapsed: 4s/);

	await timed.mock.commands.get("goal")?.handler("resume", timed.ctx);
	assert.equal(requireLastGoal(timed.mock).activeStartedAt, now);
	now += 2_750;
	await timed.mock.commands.get("goal")?.handler("edit revised timed objective", timed.ctx);
	assert.equal(requireLastGoal(timed.mock).timeUsedSeconds, 7);
	assert.equal(requireLastGoal(timed.mock).activeStartedAt, now);

	now += 1_500;
	await timed.mock.commands.get("goal")?.handler("pause", timed.ctx);
	assert.equal(requireLastGoal(timed.mock).timeUsedSeconds, 8.5);
	assert.equal(formatDuration(requireLastGoal(timed.mock).timeUsedSeconds ?? 0), "8s");
});

test("goal completion settles the active clock before clearing state", async (t) => {
	let now = 50_000;
	t.mock.method(Date, "now", () => now);
	const completed = await startGoalForTest();
	const goalId = requireLastGoal(completed.mock).id;
	now += 3_500;

	await requireGoalTool(completed.mock, "goal_complete").execute(
		"timed-completion",
		completionReport(goalId, "The Goal completed with verified lifecycle evidence."),
		new AbortController().signal,
		() => undefined,
		completed.ctx,
	);

	const completedGoal = findPersistedGoal(completed.mock, "complete");
	assert.ok(completedGoal);
	assert.equal(completedGoal.timeUsedSeconds, 3.5);
	assert.equal(completedGoal.activeStartedAt, undefined);
	assert.equal(lastGoalStatus(completed.mock), null);
	assert.deepEqual(goalStatusSnapshot(completed.mock.pi), {
		status: "complete",
		timeUsedSeconds: 3.5,
		tokensUsed: 0,
	});
});

test("session reload immediately limits an active goal whose persisted usage is exhausted", async () => {
	const sessionGoal: StoredGoal = {
		id: "restored-exhausted-active",
		text: "restore exhausted active",
		status: "active",
		startedAt: 1,
		updatedAt: 2,
		iteration: 3,
		tokenBudget: 10,
		tokensUsed: 5,
		timeUsedSeconds: 4,
		baselineTokens: 0,
	};
	const restored = await restoreStoredGoalForTest(sessionGoal, [assistantUsageEntry({ totalTokens: 12 })]);
	assert.equal(lastGoalStatus(restored.mock), "budget_limited");
	assert.equal(requireLastGoal(restored.mock).tokensUsed, 12);
	assert.equal(restored.mock.sentMessages.length, 0);
});

test("session reload pauses an active goal already at the automatic response limit", async () => {
	const sessionGoal: StoredGoal = {
		id: "restored-at-automatic-limit",
		text: "restore bounded active goal",
		status: "active",
		startedAt: 1,
		updatedAt: 2,
		iteration: 3,
		tokensUsed: 5,
		timeUsedSeconds: 4,
		baselineTokens: 0,
		automaticModelTurns: 3,
		toolFreeRepeatCount: 0,
	};
	const restored = await restoreStoredGoalForTest(sessionGoal, [], "always", {}, LOW_LIMITS_SETTINGS_PATH);
	assert.equal(lastGoalStatus(restored.mock), "paused");
	assert.equal(requireLastGoal(restored.mock).safetyPauseCause, "continuation_limit");
	assert.equal(restored.mock.sentUserMessages.length, 0);
});

test("active idle Goal automatically continues after reload", async () => {
	const sessionGoal: StoredGoal = {
		id: "restored-active-reload",
		text: "continue automatically after reload",
		status: "active",
		startedAt: 1,
		updatedAt: 2,
		iteration: 3,
		tokensUsed: 5,
		timeUsedSeconds: 4,
		baselineTokens: 0,
	};
	const restored = await restoreStoredGoalForTest(sessionGoal, [], "always", {
		isIdle: () => true,
		hasPendingMessages: () => false,
	});
	assert.equal(restored.mock.sentUserMessages.length, 0);
	await restored.mock.callEvent("session_start", { reason: "reload" }, restored.ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(restored.mock.sentUserMessages.length, 1);
	assert.match(restored.mock.sentUserMessages[0]?.text ?? "", /pi-goal-continuation:/);
	assertPromptHasGoalId(restored.mock.sentUserMessages[0]?.text ?? "", sessionGoal.id);
});

test("unlimited settings retain a non-disableable emergency automatic-turn backstop", async () => {
	const sessionGoal: StoredGoal = {
		id: "restored-at-emergency-limit",
		text: "stop catastrophic automatic runaway",
		status: "active",
		startedAt: 1,
		updatedAt: 2,
		iteration: EMERGENCY_AUTOMATIC_TURN_LIMIT,
		tokensUsed: 5,
		timeUsedSeconds: 4,
		baselineTokens: 0,
		automaticModelTurns: EMERGENCY_AUTOMATIC_TURN_LIMIT,
		toolFreeRepeatCount: 0,
	};
	const restored = await restoreStoredGoalForTest(sessionGoal);
	assert.equal(lastGoalStatus(restored.mock), "paused");
	assert.equal(requireLastGoal(restored.mock).safetyPauseCause, "runaway_backstop");
	assert.equal(restored.mock.sentUserMessages.length, 0);
});

test("session reload pauses an active goal already at the no-progress limit", async () => {
	const sessionGoal: StoredGoal = {
		id: "restored-at-no-progress-limit",
		text: "restore stalled active goal",
		status: "active",
		startedAt: 1,
		updatedAt: 2,
		iteration: 3,
		tokensUsed: 5,
		timeUsedSeconds: 4,
		baselineTokens: 0,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 3,
		lastToolFreeOutputFingerprint: "d".repeat(64),
	};
	const restored = await restoreStoredGoalForTest(sessionGoal, [], "always", {}, LOW_LIMITS_SETTINGS_PATH);
	assert.equal(lastGoalStatus(restored.mock), "paused");
	assert.equal(requireLastGoal(restored.mock).safetyPauseCause, "no_progress");
	assert.equal(restored.mock.sentUserMessages.length, 0);
});

test("session reload drops malformed persisted budgets instead of limiting the goal", async () => {
	const restored = await restoreStoredGoalForTest({
		id: "restored-malformed-budget",
		text: "restore malformed budget",
		status: "active",
		startedAt: 0,
		updatedAt: 2,
		iteration: 3,
		tokenBudget: -1,
		tokensUsed: 5,
		timeUsedSeconds: 4,
		baselineTokens: 0,
	});
	assert.equal(lastGoalStatus(restored.mock), "active");
	assert.equal(requireLastGoal(restored.mock).tokenBudget, undefined);
	assert.equal(requireLastGoal(restored.mock).startedAt, 0);
});

test("legacy active-time state migrates without counting offline or reload time", async (t) => {
	let now = 100_000;
	t.mock.method(Date, "now", () => now);
	const legacy = await restoreGoalForTest("active", { timeUsedSeconds: 4 });

	now += 2_000;
	await legacy.mock.commands.get("goal")?.handler("", legacy.ctx);
	assert.equal(requireLastGoal(legacy.mock).timeUsedSeconds, 6);
	assert.equal(requireLastGoal(legacy.mock).activeStartedAt, now);

	now += 3_000;
	legacy.mock.emitHostEvent("session_shutdown", {}, legacy.ctx);
	const suspended = requireLastGoal(legacy.mock);
	assert.equal(suspended.timeUsedSeconds, 9);
	assert.equal(suspended.activeStartedAt, undefined);

	now += 100_000;
	const reloaded = await restoreStoredGoalForTest(suspended);
	now += 2_000;
	await reloaded.mock.commands.get("goal")?.handler("", reloaded.ctx);
	assert.equal(requireLastGoal(reloaded.mock).timeUsedSeconds, 11);
});

test("parseTokenBudget and format helpers use compact units", () => {
	assert.equal(parseTokenBudget("250"), 250);
	assert.equal(parseTokenBudget("2.5k"), 2500);
	assert.equal(parseTokenBudget("0"), undefined);
	assert.equal(parseTokenBudget("0.1"), undefined);
	assert.equal(parseTokenBudget("9007199254740992"), undefined);
	assert.equal(parseTokenBudget(String(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
	assert.equal(formatTokenCount(1500), "1.5k");
	assert.equal(formatTokenCount(2_000_000), "2m");
	assert.equal(formatDuration(59), "59s");
	assert.equal(formatDuration(3660), "1h1m");
});

test("formatStatus reports active, stopped, budget-limited, complete, and empty states", () => {
	const activeGoal = {
		id: "g1",
		text: "finish",
		status: "active",
		startedAt: 0,
		updatedAt: 0,
		iteration: 1,
		tokenBudget: 2000,
		tokensUsed: 500,
		timeUsedSeconds: 90,
		baselineTokens: 0,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
	} as const;

	assert.equal(formatStatus(undefined), undefined);
	assert.equal(formatStatus(activeGoal), "active 500/2k");
	assert.equal(formatStatus({ ...activeGoal, status: "paused" }), "paused");
	assert.equal(formatStatus({ ...activeGoal, status: "blocked" }), "blocked");
	assert.equal(formatStatus({ ...activeGoal, status: "usage_limited" }), "usage");
	assert.equal(formatStatus({ ...activeGoal, status: "budget_limited" }), "budget 500/2k");
	assert.equal(formatStatus({ ...activeGoal, status: "complete" }), "complete");
});

test("buildGoalSystemPrompt escapes objective XML and includes goal_id guard rules", () => {
	const prompt = buildGoalSystemPrompt({
		id: "g<1&2>",
		text: "fix <all> & verify",
		status: "active",
		startedAt: 0,
		updatedAt: 0,
		iteration: 2,
		tokenBudget: 1000,
		tokensUsed: 250,
		timeUsedSeconds: 0,
		baselineTokens: 0,
	});

	assert.match(prompt, /fix &lt;all&gt; &amp; verify/);
	assert.match(prompt, /g&lt;1&amp;2&gt;/);
	assert.match(prompt, /Respect the goal token budget \(250\/1k used\)/);
	assert.match(prompt, /Only call the goal_complete tool after/);
	assert.match(prompt, /pass this exact goal_id/);
	assert.match(prompt, /stale-turn guard/);
});
