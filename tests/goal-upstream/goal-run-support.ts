import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";
import goal from "../../packages/pi-stuff/src/goal/src/goal.js";
import type { ActiveGoal } from "../../packages/pi-stuff/src/goal/src/persistence.js";
import { recordGoalBlockerAttempt } from "../../packages/pi-stuff/src/goal/src/safety.js";
import { createMockContext, createMockPi } from "./support.js";

export const START_CHANNEL = "pi-goal:start";
export const CANCEL_CHANNEL = "pi-goal:cancel";

export const SETTINGS_DIRECTORY = mkdtempSync(join(tmpdir(), "pi-goal-run-settings-"));
export const ENABLED_SETTINGS_PATH = join(SETTINGS_DIRECTORY, "enabled.json");
export const DISABLED_SETTINGS_PATH = join(SETTINGS_DIRECTORY, "disabled.json");
export const INVALID_SETTINGS_PATH = join(SETTINGS_DIRECTORY, "invalid.json");
export const MISSING_SETTINGS_PATH = join(SETTINGS_DIRECTORY, "missing.json");
const runtimeByPi = new WeakMap<object, ReturnType<typeof goal>>();
writeFileSync(ENABLED_SETTINGS_PATH, '{"goal":{"toolVisibility":"always","rpc":{"enabled":true}}}\n');
writeFileSync(DISABLED_SETTINGS_PATH, '{"goal":{"toolVisibility":"always","rpc":{"enabled":false}}}\n');
writeFileSync(INVALID_SETTINGS_PATH, '{"rpc":{"enabled":"yes"}}\n');
after(() => rmSync(SETTINGS_DIRECTORY, { recursive: true, force: true }));

export type RunStatus = "active" | "complete" | "blocked" | "paused" | "usage_limited" | "budget_limited" | "cleared";

export type RunStateEvent = {
	type: "state";
	runId: string;
	goalId: string;
	status: RunStatus;
	summary?: string;
	reason?: string;
};

export type RunErrorCode =
	| "RPC_DISABLED"
	| "INVALID_REQUEST"
	| "NO_ACTIVE_SESSION"
	| "RUN_ID_IN_USE"
	| "RUN_NOT_FOUND"
	| "GOAL_ALREADY_EXISTS"
	| "ACTIVATION_FAILED"
	| "SUPERSEDED";

export type RunErrorEvent = {
	type: "error";
	runId: string;
	operation: "start" | "cancel";
	error: { code: RunErrorCode; message: string };
};

export type RunEvent = RunStateEvent | RunErrorEvent;

export interface StartRunOverrides {
	readonly objective?: number | string;
	readonly tokenBudget?: number | string;
}

export interface CancelRunOverrides {
	readonly reason?: number | string;
}

export type GoalTool = {
	name?: string;
	execute: (...args: unknown[]) => Promise<{
		content?: Array<{ type: string; text: string }>;
		terminate?: boolean;
	}>;
};

export async function flush() {
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));
}

export function registerGoal(mock: ReturnType<typeof createMockPi>, settingsPath = ENABLED_SETTINGS_PATH) {
	mock.rawPi.setActiveTools([...new Set([...mock.rawPi.getActiveTools(), "goal_complete", "goal_blocked"])]);
	runtimeByPi.set(mock.pi, goal(mock.pi, { settingsPath }));
}

export async function bindSession(mock: ReturnType<typeof createMockPi>, context = createMockContext()) {
	await mock.callEvent("session_start", {}, context.ctx);
	return context;
}

export async function createRunHarness(context = createMockContext(), settingsPath = ENABLED_SETTINGS_PATH) {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock, settingsPath);
	return [mock, await bindSession(mock, context)] as const;
}

export function runEventChannel(runId: string) {
	return `pi-goal:event:${runId}`;
}

export function observeRun(mock: ReturnType<typeof createMockPi>, runId: string) {
	const events: RunEvent[] = [];
	// SAFETY: this test controls the value and supplies every RunEvent member exercised by this case.
	mock.eventBus.on(runEventChannel(runId), (data) => events.push(data as RunEvent));
	return events;
}

export function startRun(mock: ReturnType<typeof createMockPi>, runId: string, overrides: StartRunOverrides = {}) {
	mock.eventBus.emit(START_CHANNEL, {
		runId,
		objective: "ship the managed run",
		...overrides,
	});
}

export function cancelRun(mock: ReturnType<typeof createMockPi>, runId: string, overrides: CancelRunOverrides = {}) {
	mock.eventBus.emit(CANCEL_CHANNEL, { runId, ...overrides });
}

export function states(events: RunEvent[]) {
	return events.filter((event): event is RunStateEvent => event.type === "state");
}

export function errors(events: RunEvent[]) {
	return events.filter((event): event is RunErrorEvent => event.type === "error");
}

export function lastPersistedGoal(mock: ReturnType<typeof createMockPi>) {
	const current = runtimeByPi.get(mock.pi)?.activeGoal;
	if (current) return current;
	const entry = mock.entries.filter((candidate) => candidate.customType === "goal-state").at(-1);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	return (entry?.data as { goal?: ActiveGoal })?.goal;
}

export function primeBlockerAudit(goal: ActiveGoal, reason: string) {
	const finalIteration = Math.max(2, goal.iteration);
	goal.iteration = finalIteration - 2;
	goal.blockerAudit = recordGoalBlockerAttempt(
		goal,
		reason,
		"Checked the configured credential store for a production signing key.",
		"The credential store returned an explicit access-denied response with no usable signing key.",
	);
	goal.iteration = finalIteration - 1;
	goal.blockerAudit = recordGoalBlockerAttempt(
		goal,
		reason,
		"Queried the alternate environment credential source for a production signing key.",
		"The environment source returned no configured key and reported the signer unavailable.",
	);
	goal.iteration = finalIteration;
}

export function requireGoalTool(mock: ReturnType<typeof createMockPi>, name: string) {
	const tool = mock.tools.find((candidate) => candidate.name === name);
	assert.ok(tool, `expected ${name} to be registered`);
	// SAFETY: this test controls the value and supplies every GoalTool member exercised by this case.
	return tool as GoalTool;
}

export function assistantUsageEntry(totalTokens: number) {
	return { type: "message", message: { role: "assistant", usage: { totalTokens } } };
}

export function completionReport(goalId: string, summary: string) {
	return {
		goal_id: goalId,
		summary,
		evidence: [
			{
				requirement: "Complete and verify the managed Goal",
				proof: "The managed-run test observed the verified terminal state and emitted lifecycle event.",
			},
		],
	};
}
