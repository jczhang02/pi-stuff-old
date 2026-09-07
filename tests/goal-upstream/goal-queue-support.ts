import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import goal from "../../packages/pi-stuff/src/goal/src/goal.js";
import {
	type ActiveGoal,
	type GoalStateEntryData,
	serializeGoalState,
} from "../../packages/pi-stuff/src/goal/src/persistence.js";
import { createMockContext, createMockPi, type MockContextOverrides } from "./support.js";

const settingsDirectory = mkdtempSync(join(tmpdir(), "pi-goal-queue-settings-"));
const enabledSettingsPath = join(settingsDirectory, "enabled.json");
const disabledSettingsPath = join(settingsDirectory, "disabled.json");
const runtimeByPi = new WeakMap<object, ReturnType<typeof goal>>();
writeFileSync(enabledSettingsPath, '{"goal":{"experimental":{"goals":true}}}\n');
writeFileSync(disabledSettingsPath, "{}\n");

type GoalTool = {
	execute: (...args: unknown[]) => Promise<{
		content?: Array<{ type: string; text: string }>;
		terminate?: boolean;
	}>;
};

export function completionReport(goalId: string, summary: string) {
	return {
		goal_id: goalId,
		summary,
		evidence: [
			{
				requirement: "Complete and verify the active Goal",
				proof: "The test harness observed the expected persisted state after the verified Goal operation.",
			},
		],
	};
}

export async function createHarness(overrides: MockContextOverrides = {}, enabled = true) {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const runtime = goal(mock.pi, { settingsPath: enabled ? enabledSettingsPath : disabledSettingsPath });
	runtimeByPi.set(mock.pi, runtime);
	const context = createMockContext(overrides);
	await mock.callEvent("session_start", {}, context.ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	return {
		mock,
		...context,
		command: async (args: string) => mock.commands.get("goal")?.handler(args, context.ctx),
	};
}

export async function settled(harness: Awaited<ReturnType<typeof createHarness>>) {
	await harness.mock.callEvent("agent_settled", {}, harness.ctx);
}

export function completionTool(mock: ReturnType<typeof createMockPi>) {
	return findGoalTool(mock, "goal_complete");
}

export function blockedTool(mock: ReturnType<typeof createMockPi>) {
	return findGoalTool(mock, "goal_blocked");
}

function findGoalTool(mock: ReturnType<typeof createMockPi>, name: string) {
	const tool = mock.tools.find((candidate) => candidate.name === name);
	assert.ok(tool);
	// SAFETY: this test controls the value and supplies every GoalTool member exercised by this case.
	return tool as GoalTool;
}

export function lastState(mock: ReturnType<typeof createMockPi>) {
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const persisted = mock.entries.filter(({ customType }) => customType === "goal-state").at(-1)?.data as
		| GoalStateEntryData
		| undefined;
	if (persisted) return persisted;
	const runtime = runtimeByPi.get(mock.pi);
	return runtime ? serializeGoalState(runtime.activeGoal, runtime.queuedGoals, runtime.pendingQueueAction) : undefined;
}

export function stateGoals(mock: ReturnType<typeof createMockPi>): ActiveGoal[] {
	const state = lastState(mock);
	assert.ok(state?.goal);
	return [state.goal, ...(state.queue ?? [])];
}

export function summary({ text, status, tokenBudget }: ActiveGoal) {
	return { text, status, tokenBudget };
}

export function assistantUsageEntry(totalTokens: number) {
	return { type: "message", message: { role: "assistant", usage: { totalTokens } } };
}

export function storedGoal(text: string, status: ActiveGoal["status"]): ActiveGoal {
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
