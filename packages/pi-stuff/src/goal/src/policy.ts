import { randomUUID } from "node:crypto";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { checkpointGoalActiveTime, formatDuration, formatTokenCount, type UsageContext } from "./accounting.ts";
import type { ActiveGoal, PendingQueueAction } from "./persistence.ts";
import type { GoalStatus } from "./prompts.ts";

export interface StatusContext extends UsageContext {
	cwd: string;
	mode?: "tui" | "rpc" | "json" | "print";
	ui: {
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		theme?: Pick<Theme, "bold" | "fg">;
	};
	isIdle?: () => boolean;
	hasPendingMessages?: () => boolean;
	waitForIdle?: () => Promise<void>;
	abort?: () => void;
}

/** Canonical Goal state passed to the in-process managed-run publisher. */
export type GoalStateSnapshotStatus = GoalStatus | "cleared";

export interface GoalStateSnapshot {
	goalId: string;
	status: GoalStateSnapshotStatus;
	summary?: string;
	reason?: string;
}

/** Terminal statuses for Goal persistence and managed-run lifecycle publication. */
export function isTerminalGoalStatus(status: GoalStateSnapshotStatus): boolean {
	return status !== "active" && status !== "queued";
}

export function buildGoalStateSnapshot(
	goal: ActiveGoal,
	summary: string | undefined,
	reason: string | undefined,
): GoalStateSnapshot {
	const snapshot: GoalStateSnapshot = { goalId: goal.id, status: goal.status };
	if (goal.status === "complete" && summary) snapshot.summary = summary;
	else if (goal.status !== "complete" && isTerminalGoalStatus(goal.status) && reason) {
		snapshot.reason = reason;
	}
	return snapshot;
}

const CONTRADICTORY_COMPLETION_PATTERNS = [
	/(?<!could\s)\bnot\s+(?:yet\s+)?(?:complete|completed|done|finished)\b/i,
	/\bstill\s+(?:incomplete|failing|failing\s+tests?|fails?)\b/i,
	/\btests?\s+(?:still\s+)?fail(?:ing)?\b/i,
] as const;

export function createGoal(text: string, tokenBudget: number | undefined, baselineTokens: number): ActiveGoal {
	const now = Date.now();
	return {
		id: randomUUID(),
		text,
		status: "active",
		startedAt: now,
		updatedAt: now,
		iteration: 0,
		tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens,
		activeStartedAt: now,
		automaticModelTurns: 0,
		toolFreeRepeatCount: 0,
	};
}

export function transitionGoal(goal: ActiveGoal, requestedStatus: GoalStatus): ActiveGoal {
	const now = Date.now();
	const status =
		requestedStatus === "active" && goal.tokenBudget !== undefined && goal.tokensUsed >= goal.tokenBudget
			? "budget_limited"
			: requestedStatus;
	const next = { ...goal, status, updatedAt: now };
	checkpointGoalActiveTime(next, now, status === "active");
	return next;
}

export function nextGoalInstance(goal: ActiveGoal): ActiveGoal {
	return { ...goal, id: randomUUID(), updatedAt: Date.now() };
}

export function editedGoalStatus(status: GoalStatus): GoalStatus {
	if (status === "paused" || status === "blocked" || status === "usage_limited") return status;
	return "active";
}

export function incrementGoal(goal: ActiveGoal): ActiveGoal {
	return { ...goal, iteration: goal.iteration + 1, updatedAt: Date.now() };
}

export function formatStatus(goal: ActiveGoal | undefined): string | undefined {
	if (!goal) return undefined;
	if (goal.status === "complete") return "complete";
	if (goal.status === "queued") return "queued";
	if (goal.status === "paused") return "paused";
	if (goal.status === "blocked") return "blocked";
	if (goal.status === "usage_limited") return "usage";
	if (goal.status === "budget_limited") return `budget ${formatBudget(goal)}`;
	if (goal.tokenBudget !== undefined) return `active ${formatBudget(goal)}`;
	return `active ${formatDuration(goal.timeUsedSeconds)}`;
}

export function formatBudget(goal: ActiveGoal): string {
	return `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget ?? 0)}`;
}

export function goalSummary(
	goal: ActiveGoal,
	queuedGoals: readonly ActiveGoal[] = [],
	experimentalGoals = false,
	queueFrozen = false,
	pendingAction?: PendingQueueAction,
): string {
	const summary = [
		`Goal: ${goal.text}`,
		`Status: ${queueFrozen ? "queue off" : goal.status}`,
		`Iteration: ${goal.iteration}`,
		`Automatic model responses: ${goal.automaticModelTurns}`,
		`Active elapsed: ${formatDuration(goal.timeUsedSeconds)}`,
		`Tokens: ${goal.tokenBudget === undefined ? formatTokenCount(goal.tokensUsed) : formatBudget(goal)}`,
	];
	if (goal.safetyPauseCause) {
		summary.push(
			`Safety pause: ${goal.safetyPauseCause === "continuation_limit" ? "automatic response limit" : "no progress"}`,
		);
	}
	if (experimentalGoals || queuedGoals.length > 0 || queueFrozen || pendingAction) {
		const orderedGoals = [
			`[${goal.status}] ${goal.text}`,
			...(pendingAction?.kind === "prioritize" ? [`[pending] ${pendingAction.objective}`] : []),
			...queuedGoals.map((queuedGoal) => `[${queuedGoal.status}] ${queuedGoal.text}`),
		];
		summary.push(
			`Goals (${orderedGoals.length}):`,
			...orderedGoals.map((queuedGoal, index) => `${index + 1}. ${queuedGoal}`),
		);
	}
	if (pendingAction?.kind === "advance") {
		summary.push(
			`Pending queue action: ${pendingAction.reason === "complete" ? "complete" : "skip"} current goal when Pi settles.`,
		);
	}
	if (queueFrozen) {
		summary.push(
			"Queue is frozen. Re-enable experimental.goals and run /reload, or use /goal clear.",
			"Commands: /goal, /goal clear",
		);
	} else {
		summary.push(`Commands: ${goalCommandHint(goal.status, experimentalGoals)}`);
	}
	return summary.join("\n");
}

export function hasPendingMessages(ctx: StatusContext): boolean {
	return ctx.hasPendingMessages?.() ?? false;
}

export function abortCurrentTurn(ctx: StatusContext): void {
	try {
		ctx.abort?.();
	} catch {
		// Best effort: stale goal guards still prevent follow-on tool calls.
	}
}

export function blocksStaleGoalToolCalls(status: GoalStatus): boolean {
	return status === "paused" || status === "blocked" || status === "usage_limited";
}

export function isResumableGoalStatus(status: GoalStatus): boolean {
	return blocksStaleGoalToolCalls(status) || status === "budget_limited";
}

export function stoppedStatusLabel(status: GoalStatus): string {
	if (status === "usage_limited") return "usage-limited";
	if (status === "budget_limited") return "budget-limited";
	return status;
}

export function isContradictoryCompletionSummary(summary: string): boolean {
	return CONTRADICTORY_COMPLETION_PATTERNS.some((pattern) => pattern.test(summary));
}

export function goalIdRejectionReason(goal: ActiveGoal, requestedGoalId: string): string | undefined {
	if (!requestedGoalId) return "missing goal_id";
	if (requestedGoalId !== goal.id) return "goal_id does not match the active goal";
	return undefined;
}

function goalCommandHint(status: GoalStatus, experimentalGoals = false): string {
	const queueCommands = experimentalGoals
		? ", /goal add <objective>, /goal prioritize <objective>, /goal drop-last, /goal skip"
		: "";
	if (status === "active") return `/goal edit <objective>, /goal pause, /goal clear${queueCommands}`;
	if (isResumableGoalStatus(status)) return `/goal edit <objective>, /goal resume, /goal clear${queueCommands}`;
	return `/goal edit <objective>, /goal clear${queueCommands}`;
}
