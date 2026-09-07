import { existsSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { isJsonInputValue, type JsonInputObject, type JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import { readSettingsFileSync, writeSettingsFileSync } from "../../shared/settings-io/file.ts";
import { resolveSettingsLockPath } from "../../shared/settings-io/paths.ts";
import { isNonNegativeFiniteNumber, nonNegativeFiniteNumber, normalizeTokenBudget } from "./accounting.ts";
import type { GoalStatus } from "./prompts.ts";

const GOAL_STATE_ENTRY_TYPE = "goal-state";
const LEGACY_GOALS_STATE_ENTRY_TYPE = "goals-state";
const STATE_FILE = join(getAgentDir(), "pi-goal-state.json");
export const MAX_QUEUED_GOALS = 64;

type LegacyStateLock = (path: string, owner: string) => Effect.Effect<void, Error, Scope.Scope>;

export type SafetyPauseCause = "continuation_limit" | "no_progress" | "runaway_backstop";

interface GoalBlockerAttempt {
	iteration: number;
	attempt: string;
	attemptFingerprint: string;
	evidence: string;
}

export interface GoalBlockerAudit {
	reasonFingerprint: string;
	lastIteration: number;
	consecutiveTurns: number;
	attempts: GoalBlockerAttempt[];
}

export interface ActiveGoal {
	id: string;
	text: string;
	status: GoalStatus;
	startedAt: number;
	updatedAt: number;
	iteration: number;
	tokenBudget?: number | undefined;
	tokensUsed: number;
	timeUsedSeconds: number;
	baselineTokens: number;
	activeStartedAt?: number | undefined;
	automaticModelTurns: number;
	toolFreeRepeatCount: number;
	lastToolFreeOutputFingerprint?: string | undefined;
	blockerAudit?: GoalBlockerAudit | undefined;
	safetyPauseCause?: SafetyPauseCause | undefined;
	safetyResetPending?: boolean | undefined;
}

export type PendingQueueAction =
	| {
			kind: "prioritize";
			objective: string;
			tokenBudget?: number | undefined;
			displacedUsageFinalized?: boolean | undefined;
	  }
	| {
			kind: "advance";
			goalId: string;
			reason: "complete" | "skip";
			completedText: string;
	  };

export interface GoalStateEntryData {
	goal: ActiveGoal | null;
	queue?: ActiveGoal[];
	pendingAction?: PendingQueueAction;
}

export interface LoadedGoalState {
	goal: ActiveGoal | undefined;
	queue: ActiveGoal[];
	pendingAction: PendingQueueAction | undefined;
	hasExperimentalQueueState: boolean;
	source: "none" | "canonical" | "legacy-goals";
}

interface SessionEntry {
	type?: string;
	customType?: string;
	data?: unknown;
}

interface SessionContext {
	sessionManager?: {
		getBranch?: () => SessionEntry[];
		getEntries?: () => SessionEntry[];
	};
}

export function serializeGoalState(
	goal: ActiveGoal | undefined,
	queue: readonly ActiveGoal[],
	pendingAction: PendingQueueAction | undefined,
): GoalStateEntryData {
	if (queue.length > MAX_QUEUED_GOALS) {
		throw new RangeError(`Goal queue exceeds its ${MAX_QUEUED_GOALS}-goal limit.`);
	}
	const optional: Pick<GoalStateEntryData, "pendingAction" | "queue"> = {};
	if (queue.length > 0) optional.queue = [...queue];
	if (pendingAction) optional.pendingAction = pendingAction;
	return {
		goal: goal ?? null,
		...optional,
	};
}

export function loadGoalStateFromSession(ctx: SessionContext): LoadedGoalState {
	const entries = ctx.sessionManager?.getBranch?.() ?? ctx.sessionManager?.getEntries?.() ?? [];
	let legacyEntry: SessionEntry | undefined;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "custom") continue;
		if (entry.customType === GOAL_STATE_ENTRY_TYPE) {
			return loadCanonicalGoalState(isJsonInputValue(entry.data) ? entry.data : undefined);
		}
		if (!legacyEntry && entry.customType === LEGACY_GOALS_STATE_ENTRY_TYPE) legacyEntry = entry;
	}
	return legacyEntry
		? loadLegacyGoalsState(isJsonInputValue(legacyEntry.data) ? legacyEntry.data : undefined)
		: emptyGoalState("none");
}

function loadCanonicalGoalState(data: JsonInputValue): LoadedGoalState {
	if (!isRecord(data)) return emptyGoalState("canonical");
	const rawGoal = data["goal"];
	if (rawGoal !== null && !isGoal(rawGoal)) return emptyGoalState("canonical");
	const rawQueue = Object.hasOwn(data, "queue") ? data["queue"] : [];
	if (!Array.isArray(rawQueue) || rawQueue.length > MAX_QUEUED_GOALS || !rawQueue.every(isQueueGoal)) {
		return emptyGoalState("canonical");
	}
	const pendingAction = normalizePendingQueueAction(data["pendingAction"]);
	if (Object.hasOwn(data, "pendingAction") && !pendingAction) {
		return emptyGoalState("canonical");
	}

	const queue = rawQueue.map(normalizeQueuedGoal);
	let goal = rawGoal === null ? undefined : normalizeLoadedGoal(rawGoal);
	if (goal?.status === "complete" && !pendingAction) goal = undefined;
	if (pendingAction?.kind === "prioritize" && goal?.status !== "complete" && queue.length >= MAX_QUEUED_GOALS) {
		return emptyGoalState("canonical");
	}
	if (!goal && (queue.length > 0 || pendingAction)) return emptyGoalState("canonical");
	return {
		goal,
		queue,
		pendingAction,
		hasExperimentalQueueState: goal?.status === "queued" || queue.length > 0 || pendingAction !== undefined,
		source: "canonical",
	};
}

function loadLegacyGoalsState(data: JsonInputValue): LoadedGoalState {
	if (!isRecord(data)) return emptyGoalState("legacy-goals");
	let rawGoals: ActiveGoal[];
	if (Array.isArray(data["goals"])) {
		if (data["goals"].length > MAX_QUEUED_GOALS + 1 || !data["goals"].every(isGoal)) {
			return emptyGoalState("legacy-goals");
		}
		rawGoals = data["goals"].filter((goal) => goal.status !== "complete");
	} else if (isGoal(data["goal"]) && data["goal"].status !== "complete") {
		rawGoals = [data["goal"]];
	} else {
		rawGoals = [];
	}
	const goals = rawGoals.map((goal, index) => (index === 0 ? normalizeLoadedGoal(goal) : normalizeQueuedGoal(goal)));
	const pendingAction = normalizeLegacyPendingPrioritize(data["pendingUnshift"]);
	if (goals.length === 0) return emptyGoalState("legacy-goals");
	if (pendingAction && goals.length > MAX_QUEUED_GOALS) return emptyGoalState("legacy-goals");
	return {
		goal: goals[0],
		queue: goals.slice(1),
		pendingAction,
		hasExperimentalQueueState: goals[0]?.status === "queued" || goals.length > 1 || pendingAction !== undefined,
		source: "legacy-goals",
	};
}

function normalizePendingQueueAction(value: JsonInputValue): PendingQueueAction | undefined {
	if (!isRecord(value)) return undefined;
	if (value["kind"] === "prioritize") {
		if (
			!validObjective(value["objective"]) ||
			(Object.hasOwn(value, "displacedUsageFinalized") && !isRuntimeBoolean(value["displacedUsageFinalized"]))
		) {
			return undefined;
		}
		const action: Extract<PendingQueueAction, { kind: "prioritize" }> = {
			kind: "prioritize",
			objective: value["objective"],
			tokenBudget: normalizeTokenBudget(value["tokenBudget"]),
		};
		if (value["displacedUsageFinalized"] === true) action.displacedUsageFinalized = true;
		return action;
	}
	if (value["kind"] === "advance") {
		if (
			!isRuntimeString(value["goalId"]) ||
			!value["goalId"] ||
			value["goalId"] !== value["goalId"].trim() ||
			(value["reason"] !== "complete" && value["reason"] !== "skip") ||
			!validObjective(value["completedText"])
		) {
			return undefined;
		}
		return {
			kind: "advance",
			goalId: value["goalId"],
			reason: value["reason"],
			completedText: value["completedText"],
		};
	}
	return undefined;
}

function normalizeLegacyPendingPrioritize(value: JsonInputValue): PendingQueueAction | undefined {
	if (!isRecord(value) || !validObjective(value["objective"])) return undefined;
	return {
		kind: "prioritize",
		objective: value["objective"],
		tokenBudget: normalizeTokenBudget(value["tokenBudget"]),
	};
}

function validObjective(value: JsonInputValue): value is string {
	return isRuntimeString(value) && Boolean(value.trim()) && value.length <= 4_000;
}

function normalizeQueuedGoal(goal: ActiveGoal): ActiveGoal {
	const normalized = normalizeLoadedGoal(goal);
	return normalized.status === "active"
		? { ...normalized, status: "queued", activeStartedAt: undefined }
		: { ...normalized, activeStartedAt: undefined };
}

function normalizeLoadedGoal(goal: ActiveGoal): ActiveGoal {
	const now = Date.now();
	const iteration = Math.max(0, Math.floor(nonNegativeFiniteNumber(goal.iteration)));
	return {
		...goal,
		startedAt: isNonNegativeFiniteNumber(goal.startedAt) ? goal.startedAt : now,
		updatedAt: isNonNegativeFiniteNumber(goal.updatedAt) ? goal.updatedAt : now,
		iteration,
		tokenBudget: normalizeTokenBudget(goal.tokenBudget),
		tokensUsed: nonNegativeFiniteNumber(goal.tokensUsed),
		timeUsedSeconds: nonNegativeFiniteNumber(goal.timeUsedSeconds),
		baselineTokens: nonNegativeFiniteNumber(goal.baselineTokens),
		activeStartedAt: goal.status === "active" ? now : undefined,
		automaticModelTurns: normalizeSafetyCounter(goal.automaticModelTurns),
		toolFreeRepeatCount: normalizeSafetyCounter(goal.toolFreeRepeatCount),
		lastToolFreeOutputFingerprint: normalizeOutputFingerprint(goal.lastToolFreeOutputFingerprint),
		blockerAudit: normalizeBlockerAudit(goal.blockerAudit, iteration),
		safetyPauseCause: normalizeSafetyPauseCause(goal.safetyPauseCause),
		safetyResetPending: goal.safetyResetPending === true ? true : undefined,
	};
}

function normalizeBlockerAudit(
	value: GoalBlockerAudit | JsonInputValue,
	iteration: number,
): GoalBlockerAudit | undefined {
	if (!isRecord(value)) return undefined;
	const reasonFingerprint = normalizeOutputFingerprint(value.reasonFingerprint);
	const lastIteration = normalizeSafetyCounter(value.lastIteration);
	const consecutiveTurns = normalizeSafetyCounter(value.consecutiveTurns);
	const attempts = normalizeBlockerAttempts(value.attempts);
	if (
		!reasonFingerprint ||
		consecutiveTurns < 1 ||
		lastIteration > iteration ||
		consecutiveTurns > lastIteration + 1 ||
		attempts.length !== consecutiveTurns ||
		attempts.at(-1)?.iteration !== lastIteration
	) {
		return undefined;
	}
	return { reasonFingerprint, lastIteration, consecutiveTurns, attempts };
}

function normalizeBlockerAttempts(value: readonly GoalBlockerAttempt[] | JsonInputValue): GoalBlockerAttempt[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 3) return [];
	const attempts: GoalBlockerAttempt[] = [];
	for (const candidate of value) {
		if (!isRecord(candidate)) return [];
		const iteration = normalizeSafetyCounter(candidate.iteration);
		const attemptFingerprint = normalizeOutputFingerprint(candidate.attemptFingerprint);
		if (
			!isRuntimeString(candidate.attempt) ||
			!candidate.attempt.trim() ||
			candidate.attempt.length > 4_000 ||
			!isRuntimeString(candidate.evidence) ||
			!candidate.evidence.trim() ||
			candidate.evidence.length > 4_000 ||
			!attemptFingerprint ||
			(attempts.at(-1)?.iteration ?? -1) >= iteration ||
			attempts.some((attempt) => attempt.attemptFingerprint === attemptFingerprint)
		) {
			return [];
		}
		attempts.push({
			iteration,
			attempt: candidate.attempt,
			attemptFingerprint,
			evidence: candidate.evidence,
		});
	}
	return attempts;
}

function normalizeSafetyCounter(value: JsonInputValue): number {
	return isRuntimeNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeOutputFingerprint(value: JsonInputValue): string | undefined {
	return isRuntimeString(value) && /^[a-f0-9]{64}$/u.test(value) ? value : undefined;
}

function normalizeSafetyPauseCause(value: JsonInputValue): SafetyPauseCause | undefined {
	return value === "continuation_limit" || value === "no_progress" || value === "runaway_backstop" ? value : undefined;
}

export function clearLegacyPersistedGoal(
	cwd: string,
	stateFile = STATE_FILE,
	withLock?: LegacyStateLock,
): Effect.Effect<void, Error> {
	const acquire = withLock ?? legacyStateLock;
	return Effect.scoped(
		Effect.gen(function* () {
			yield* acquire(stateFile, "Goal legacy state");
			yield* Effect.uninterruptible(
				Effect.try({
					try: () => {
						if (!existsSync(stateFile)) return;
						const goals = readSettingsFileSync(stateFile);
						if (!Object.hasOwn(goals, cwd)) return;
						delete goals[cwd];
						writeSettingsFileSync(stateFile, goals);
					},
					catch: (error) => (error instanceof Error ? error : new Error(String(error))),
				}),
			);
		}),
	);
}

function legacyStateLock(path: string, owner: string): Effect.Effect<void, Error, Scope.Scope> {
	if (!Object.hasOwn(process.versions, "bun")) return Effect.void;
	return Effect.flatMap(
		Effect.tryPromise({
			try: () => import("../../shared/settings-io/lock.ts"),
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		}),
		({ acquireSettingsLockEffect }) => acquireSettingsLockEffect(resolveSettingsLockPath(path), owner),
	);
}

function isGoal(value: JsonInputValue): value is JsonInputValue & ActiveGoal {
	if (!isRecord(value)) return false;
	return (
		isRuntimeString(value["id"]) &&
		Boolean(value["id"]) &&
		value["id"] === value["id"].trim() &&
		validObjective(value["text"]) &&
		["active", "queued", "paused", "blocked", "usage_limited", "budget_limited", "complete"].includes(
			String(value["status"]),
		) &&
		isRuntimeNumber(value["startedAt"]) &&
		isRuntimeNumber(value["updatedAt"]) &&
		isRuntimeNumber(value["iteration"]) &&
		isRuntimeNumber(value["tokensUsed"]) &&
		isRuntimeNumber(value["timeUsedSeconds"]) &&
		isRuntimeNumber(value["baselineTokens"]) &&
		(value["activeStartedAt"] === undefined || isRuntimeNumber(value["activeStartedAt"])) &&
		(value["safetyResetPending"] === undefined || isRuntimeBoolean(value["safetyResetPending"]))
	);
}

function isQueueGoal(value: JsonInputValue): value is JsonInputValue & ActiveGoal {
	return isGoal(value) && value.status !== "complete";
}

function isRecord<Value>(value: Value): value is Value & JsonInputObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function emptyGoalState(source: LoadedGoalState["source"]): LoadedGoalState {
	return {
		goal: undefined,
		queue: [],
		pendingAction: undefined,
		hasExperimentalQueueState: false,
		source,
	};
}
