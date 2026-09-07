import { randomUUID } from "node:crypto";
import { checkpointGoalActiveTime } from "./accounting.ts";
import { type ActiveGoal, MAX_QUEUED_GOALS, type PendingQueueAction } from "./persistence.ts";
import { resetGoalSafetyEpoch } from "./safety.ts";

export interface GoalQueueResult {
	goal: ActiveGoal | undefined;
	queue: ActiveGoal[];
}

export interface DropLastGoalResult extends GoalQueueResult {
	removed: ActiveGoal | undefined;
}

export function goalQueueIdentity(
	goal: ActiveGoal | undefined,
	queue: readonly ActiveGoal[],
	pendingAction: PendingQueueAction | undefined,
) {
	const pendingIdentity =
		pendingAction?.kind === "prioritize"
			? [
					pendingAction.kind,
					pendingAction.objective,
					pendingAction.tokenBudget,
					pendingAction.displacedUsageFinalized,
				]
			: pendingAction
				? [pendingAction.kind, pendingAction.goalId, pendingAction.reason, pendingAction.completedText]
				: undefined;
	return JSON.stringify([goal?.id, queue.map((queuedGoal) => queuedGoal.id), pendingIdentity]);
}

export function createQueuedGoal(text: string, tokenBudget: number | undefined, now = Date.now()): ActiveGoal {
	return {
		id: randomUUID(),
		text,
		status: "queued",
		startedAt: now,
		updatedAt: now,
		iteration: 0,
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
	};
}

export function appendGoal(queue: readonly ActiveGoal[], goal: ActiveGoal): ActiveGoal[] {
	assertGoalQueueCapacity(queue);
	return [...queue, goal];
}

export function prioritizeGoal(
	currentGoal: ActiveGoal,
	queue: readonly ActiveGoal[],
	prioritizedGoal: ActiveGoal,
	now = Date.now(),
): GoalQueueResult {
	assertGoalQueueCapacity(queue);
	return {
		goal: prioritizedGoal,
		queue: [shelveGoal(currentGoal, now), ...queue],
	};
}

function assertGoalQueueCapacity(queue: readonly ActiveGoal[]): void {
	if (queue.length >= MAX_QUEUED_GOALS) {
		throw new RangeError(`Goal queue is full (${MAX_QUEUED_GOALS} queued goals).`);
	}
}

export function dropLastGoal(currentGoal: ActiveGoal, queue: readonly ActiveGoal[]): DropLastGoalResult {
	if (queue.length === 0) {
		return { goal: undefined, queue: [], removed: currentGoal };
	}
	return {
		goal: currentGoal,
		queue: queue.slice(0, -1),
		removed: queue.at(-1),
	};
}

export function skipGoal(queue: readonly ActiveGoal[]): GoalQueueResult {
	return { goal: queue[0], queue: queue.slice(1) };
}

function shelveGoal(goal: ActiveGoal, now = Date.now()): ActiveGoal {
	if (goal.status !== "active") return { ...goal, activeStartedAt: undefined, updatedAt: now };
	const shelved = { ...goal, status: "queued" as const, updatedAt: now };
	checkpointGoalActiveTime(shelved, now, false);
	return shelved;
}

export function activateQueuedGoal(goal: ActiveGoal, currentTokenTotal: number, now = Date.now()): ActiveGoal {
	const rebased = {
		...goal,
		baselineTokens: Math.max(0, currentTokenTotal - goal.tokensUsed),
		activeStartedAt: undefined,
		updatedAt: now,
	};
	if (goal.status !== "queued") return rebased;
	const activated = {
		...rebased,
		id: randomUUID(),
		status: "active" as const,
	};
	checkpointGoalActiveTime(activated, now, true);
	if (activated.tokenBudget !== undefined && activated.tokensUsed >= activated.tokenBudget) {
		return { ...activated, status: "budget_limited", activeStartedAt: undefined };
	}
	return activated.safetyResetPending ? resetGoalSafetyEpoch(activated) : activated;
}
