import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as Effect from "effect/Effect";
import {
	type ActiveGoal,
	clearLegacyPersistedGoal,
	loadGoalStateFromSession,
	MAX_QUEUED_GOALS,
	serializeGoalState,
} from "../../../packages/pi-stuff/src/goal/src/persistence.js";

const active = storedGoal("active", "active");
const queued = storedGoal("queued", "queued");

function branch(...entries: Array<{ customType: string; data: unknown }>) {
	return {
		sessionManager: {
			getBranch: () => entries.map((entry) => ({ type: "custom", ...entry })),
		},
	};
}

test("legacy file cleanup preserves sibling projects and fails closed on malformed state", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-goal-legacy-"));
	const stateFile = join(directory, "pi-goal-state.json");
	const lockCalls: Array<{ owner: string; path: string }> = [];
	try {
		writeFileSync(stateFile, JSON.stringify({ "/project-a": { text: "a" }, "/project-b": { text: "b" } }));
		await Effect.runPromise(
			clearLegacyPersistedGoal("/project-a", stateFile, (path, owner) =>
				Effect.sync(() => {
					lockCalls.push({ owner, path });
				}),
			),
		);
		assert.deepEqual(lockCalls, [{ owner: "Goal legacy state", path: stateFile }]);
		assert.deepEqual(JSON.parse(readFileSync(stateFile, "utf8")), { "/project-b": { text: "b" } });

		writeFileSync(stateFile, "{ invalid", "utf8");
		await assert.rejects(
			Effect.runPromise(clearLegacyPersistedGoal("/project-b", stateFile)),
			/contains invalid JSON/,
		);
		assert.equal(readFileSync(stateFile, "utf8"), "{ invalid");
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("canonical persistence keeps the legacy single-goal shape when queue metadata is empty", () => {
	assert.deepEqual(serializeGoalState(active, [], undefined), { goal: active });
	assert.deepEqual(serializeGoalState(undefined, [], undefined), { goal: null });
});

test("canonical persistence restores queue and pending prioritize safely", () => {
	const pendingAction = {
		kind: "prioritize" as const,
		objective: "urgent",
		tokenBudget: 2_000,
		displacedUsageFinalized: true,
	};
	const loaded = loadGoalStateFromSession(
		branch({
			customType: "goal-state",
			data: serializeGoalState(active, [queued], pendingAction),
		}),
	);

	assert.equal(loaded.source, "canonical");
	assert.equal(loaded.goal?.text, "active");
	assert.deepEqual(
		loaded.queue.map(({ text, status }) => ({ text, status })),
		[{ text: "queued", status: "queued" }],
	);
	assert.deepEqual(loaded.pendingAction, pendingAction);
	assert.equal(loaded.hasExperimentalQueueState, true);
});

test("a queued head is experimental state even without a queued tail", () => {
	for (const [customType, data] of [
		["goal-state", { goal: queued }],
		["goals-state", { goals: [queued] }],
	] as const) {
		const loaded = loadGoalStateFromSession(branch({ customType, data }));
		assert.equal(loaded.goal?.status, "queued");
		assert.deepEqual(loaded.queue, []);
		assert.equal(loaded.hasExperimentalQueueState, true);
	}
});

test("canonical state retains a completed head until pending priority can settle", () => {
	const completed = { ...active, status: "complete" as const };
	const pendingAction = {
		kind: "prioritize" as const,
		objective: "urgent after completion",
		tokenBudget: 2_000,
	};
	const loaded = loadGoalStateFromSession(
		branch({
			customType: "goal-state",
			data: serializeGoalState(completed, [queued], pendingAction),
		}),
	);

	assert.equal(loaded.goal?.status, "complete");
	assert.equal(loaded.goal?.text, "active");
	assert.deepEqual(
		loaded.queue.map(({ text }) => text),
		["queued"],
	);
	assert.deepEqual(loaded.pendingAction, pendingAction);
	assert.equal(loaded.hasExperimentalQueueState, true);
});

test("canonical entries take precedence over older plural state, including explicit clear", () => {
	const plural = { goals: [storedGoal("legacy", "active"), storedGoal("later", "queued")] };
	const loaded = loadGoalStateFromSession(
		branch({ customType: "goals-state", data: plural }, { customType: "goal-state", data: { goal: null } }),
	);

	assert.equal(loaded.source, "canonical");
	assert.equal(loaded.goal, undefined);
	assert.deepEqual(loaded.queue, []);
});

test("legacy plural state migrates only without canonical history", () => {
	const pendingUnshift = { objective: "urgent", tokenBudget: 3_000 };
	const loaded = loadGoalStateFromSession(
		branch({
			customType: "goals-state",
			data: { goals: [active, queued], pendingUnshift },
		}),
	);

	assert.equal(loaded.source, "legacy-goals");
	assert.equal(loaded.goal?.text, "active");
	assert.deepEqual(
		loaded.queue.map(({ text }) => text),
		["queued"],
	);
	assert.deepEqual(loaded.pendingAction, { kind: "prioritize", ...pendingUnshift });
	assert.equal(loaded.hasExperimentalQueueState, true);
});

test("a legacy single goal becomes ordinary singular state", () => {
	const legacyGoal = {
		...active,
		automaticModelTurns: undefined,
		toolFreeRepeatCount: undefined,
		lastToolFreeOutputFingerprint: undefined,
		safetyPauseCause: undefined,
	};
	const loaded = loadGoalStateFromSession(branch({ customType: "goals-state", data: { goals: [legacyGoal] } }));

	assert.equal(loaded.source, "legacy-goals");
	assert.equal(loaded.goal?.text, "active");
	assert.equal(loaded.goal?.automaticModelTurns, 0);
	assert.equal(loaded.goal?.toolFreeRepeatCount, 0);
	assert.equal(loaded.goal?.lastToolFreeOutputFingerprint, undefined);
	assert.equal(loaded.goal?.safetyPauseCause, undefined);
	assert.deepEqual(loaded.queue, []);
	assert.equal(loaded.pendingAction, undefined);
	assert.equal(loaded.hasExperimentalQueueState, false);
});

test("canonical persistence normalizes bounded safety state independently per queued goal", () => {
	const fingerprint = "a".repeat(64);
	const loaded = loadGoalStateFromSession(
		branch({
			customType: "goal-state",
			data: {
				goal: {
					...active,
					status: "paused",
					iteration: 4,
					automaticModelTurns: 12,
					toolFreeRepeatCount: 2,
					lastToolFreeOutputFingerprint: fingerprint,
					safetyPauseCause: "no_progress",
					blockerAudit: {
						reasonFingerprint: "c".repeat(64),
						lastIteration: 3,
						consecutiveTurns: 2,
						attempts: [
							{
								iteration: 2,
								attempt: "Checked the configured repository credential store.",
								attemptFingerprint: "d".repeat(64),
								evidence: "Attempt one checked access and received an explicit denied response.",
							},
							{
								iteration: 3,
								attempt: "Queried the environment for an alternate credential.",
								attemptFingerprint: "e".repeat(64),
								evidence: "Attempt two queried credentials and confirmed none were configured.",
							},
						],
					},
				},
				queue: [
					{
						...queued,
						automaticModelTurns: 7,
						toolFreeRepeatCount: 1,
						lastToolFreeOutputFingerprint: "b".repeat(64),
					},
				],
			},
		}),
	);

	assert.equal(loaded.goal?.automaticModelTurns, 12);
	assert.equal(loaded.goal?.toolFreeRepeatCount, 2);
	assert.equal(loaded.goal?.lastToolFreeOutputFingerprint, fingerprint);
	assert.equal(loaded.goal?.safetyPauseCause, "no_progress");
	assert.deepEqual(loaded.goal?.blockerAudit, {
		reasonFingerprint: "c".repeat(64),
		lastIteration: 3,
		consecutiveTurns: 2,
		attempts: [
			{
				iteration: 2,
				attempt: "Checked the configured repository credential store.",
				attemptFingerprint: "d".repeat(64),
				evidence: "Attempt one checked access and received an explicit denied response.",
			},
			{
				iteration: 3,
				attempt: "Queried the environment for an alternate credential.",
				attemptFingerprint: "e".repeat(64),
				evidence: "Attempt two queried credentials and confirmed none were configured.",
			},
		],
	});
	assert.equal(loaded.queue[0]?.automaticModelTurns, 7);
	assert.equal(loaded.queue[0]?.toolFreeRepeatCount, 1);
	assert.equal(loaded.queue[0]?.lastToolFreeOutputFingerprint, "b".repeat(64));
	assert.equal(loaded.queue[0]?.safetyPauseCause, undefined);
});

test("a pending active reactivation retains its safety cause until prompt start", () => {
	const loaded = loadGoalStateFromSession(
		branch({
			customType: "goal-state",
			data: {
				goal: {
					...active,
					automaticModelTurns: 2,
					toolFreeRepeatCount: 3,
					lastToolFreeOutputFingerprint: "c".repeat(64),
					safetyPauseCause: "no_progress",
				},
			},
		}),
	);

	assert.equal(loaded.goal?.status, "active");
	assert.equal(loaded.goal?.safetyPauseCause, "no_progress");
	assert.equal(loaded.goal?.toolFreeRepeatCount, 3);
});

test("malformed persisted safety fields reset without discarding the goal", () => {
	const loaded = loadGoalStateFromSession(
		branch({
			customType: "goal-state",
			data: {
				goal: {
					...active,
					automaticModelTurns: -2,
					toolFreeRepeatCount: Number.MAX_SAFE_INTEGER + 1,
					lastToolFreeOutputFingerprint: "not-a-fingerprint",
					blockerAudit: {
						reasonFingerprint: "not-a-fingerprint",
						lastIteration: -1,
						consecutiveTurns: 99,
						attempts: [],
					},
					safetyPauseCause: "other",
				},
			},
		}),
	);

	assert.equal(loaded.goal?.automaticModelTurns, 0);
	assert.equal(loaded.goal?.toolFreeRepeatCount, 0);
	assert.equal(loaded.goal?.lastToolFreeOutputFingerprint, undefined);
	assert.equal(loaded.goal?.blockerAudit, undefined);
	assert.equal(loaded.goal?.safetyPauseCause, undefined);
});

test("malformed canonical or plural queue state fails closed", () => {
	for (const [customType, data] of [
		["goal-state", { goal: { ...active, id: "" } }],
		["goal-state", { goal: { ...active, text: "   " } }],
		["goal-state", { goal: active, queue: [{ nope: true }] }],
		[
			"goal-state",
			{
				goal: active,
				pendingAction: { kind: "advance", goalId: " ", reason: "skip", completedText: "active" },
			},
		],
		[
			"goal-state",
			{
				goal: active,
				pendingAction: { kind: "advance", goalId: active.id, reason: "skip", completedText: "" },
			},
		],
		[
			"goal-state",
			{
				goal: active,
				pendingAction: {
					kind: "prioritize",
					objective: "urgent",
					displacedUsageFinalized: "yes",
				},
			},
		],
		["goal-state", { goal: active, queue: [storedGoal("done", "complete")] }],
		["goals-state", { goals: [active, { nope: true }] }],
	] as const) {
		const loaded = loadGoalStateFromSession(branch({ customType, data }));
		assert.equal(loaded.goal, undefined);
		assert.deepEqual(loaded.queue, []);
		assert.equal(loaded.pendingAction, undefined);
	}
});

test("Goal persistence rejects oversized current and restored queues", () => {
	const oversizedQueue = Array.from({ length: MAX_QUEUED_GOALS + 1 }, (_, index) =>
		storedGoal(`queued-${index}`, "queued"),
	);
	assert.throws(() => serializeGoalState(active, oversizedQueue, undefined), /64-goal limit/);

	for (const [customType, data] of [
		["goal-state", { goal: active, queue: oversizedQueue }],
		["goals-state", { goals: [active, ...oversizedQueue] }],
	] as const) {
		const loaded = loadGoalStateFromSession(branch({ customType, data }));
		assert.equal(loaded.goal, undefined);
		assert.deepEqual(loaded.queue, []);
	}
});

function storedGoal(text: string, status: ActiveGoal["status"]): ActiveGoal {
	const goal: ActiveGoal = {
		id: `${text}-id`,
		text,
		status,
		startedAt: 1,
		updatedAt: 1,
		iteration: 0,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
	};
	if (status === "active") goal.activeStartedAt = 1;
	return goal;
}
