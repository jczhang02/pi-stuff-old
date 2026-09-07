import { isRuntimeNumber, isRuntimeObject } from "../../shared/runtime-type.ts";

export interface GoalAccountingState {
	status: string;
	baselineTokens: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	activeStartedAt?: number | undefined;
	updatedAt: number;
}

export interface UsageContext {
	readonly sessionManager?: {
		getBranch?(): readonly object[];
	};
}

export function checkpointGoalActiveTime(goal: GoalAccountingState, now: number, continueClock: boolean) {
	const accumulated = nonNegativeFiniteNumber(goal.timeUsedSeconds);
	const startedAt = goal.activeStartedAt;
	if (isRuntimeNumber(startedAt) && Number.isFinite(startedAt)) {
		goal.timeUsedSeconds = accumulated + Math.max(0, now - startedAt) / 1000;
	} else {
		goal.timeUsedSeconds = accumulated;
	}
	goal.activeStartedAt = continueClock ? now : undefined;
}

export function updateGoalUsage(
	goal: GoalAccountingState,
	ctx: UsageContext,
	continueClock = goal.status === "active",
) {
	const now = Date.now();
	const baselineTokens = nonNegativeFiniteNumber(goal.baselineTokens);
	goal.baselineTokens = baselineTokens;
	goal.tokensUsed = Math.max(0, currentTokenTotal(ctx) - baselineTokens);
	checkpointGoalActiveTime(goal, now, continueClock);
	goal.updatedAt = now;
}

export function formatDuration(seconds: number) {
	const wholeSeconds = Math.max(0, Math.floor(nonNegativeFiniteNumber(seconds)));
	if (wholeSeconds < 60) return `${wholeSeconds}s`;
	const minutes = Math.floor(wholeSeconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h${minutes % 60}m`;
}

export function formatTokenCount(value: number) {
	if (value < 1_000) return `${value}`;
	if (value < 1_000_000) {
		return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
	}
	return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}

export function isNonNegativeFiniteNumber<Value>(value: Value): value is Value & number {
	return isRuntimeNumber(value) && Number.isFinite(value) && value >= 0;
}

export function nonNegativeFiniteNumber<Value>(value: Value): number {
	return isNonNegativeFiniteNumber(value) ? value : 0;
}

export function normalizeTokenBudget<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function assistantUsageTokens<Value>(value: Value): number {
	if (!value || !isRuntimeObject(value)) return 0;
	const totalTokens = "totalTokens" in value ? value.totalTokens : undefined;
	if (isNonNegativeFiniteNumber(totalTokens)) return totalTokens;
	return Math.min(
		Number.MAX_SAFE_INTEGER,
		nonNegativeFiniteNumber("input" in value ? value.input : undefined) +
			nonNegativeFiniteNumber("output" in value ? value.output : undefined) +
			nonNegativeFiniteNumber("cacheRead" in value ? value.cacheRead : undefined) +
			nonNegativeFiniteNumber("cacheWrite" in value ? value.cacheWrite : undefined),
	);
}

export function cumulativeAssistantTokens<Entry>(entries: readonly Entry[]): number {
	let total = 0;
	for (const entry of entries) {
		if (!entry || !isRuntimeObject(entry) || !("type" in entry) || entry.type !== "message") continue;
		const message = "message" in entry ? entry.message : undefined;
		if (!message || !isRuntimeObject(message) || !("role" in message) || message.role !== "assistant") continue;
		const usage = "usage" in message ? message.usage : undefined;
		total = Math.min(Number.MAX_SAFE_INTEGER, total + assistantUsageTokens(usage));
	}
	return total;
}

export function currentTokenTotal(ctx: UsageContext): number {
	return cumulativeAssistantTokens(ctx.sessionManager?.getBranch?.() ?? []);
}
