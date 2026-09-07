import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { withAgentWorkOrigin } from "../../conversation-ui/agent-run-origin.js";
import { readGoalCoordination, sendSuiteAgentMessage } from "../../conversation-ui/index.js";
import { type GoalStatusSnapshot, getGoalStatusChannel } from "../../conversation-ui/statusline.js";
import { isJsonInputObject } from "../../shared/json-value.js";
import { isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.js";
import { formatTokenCount, updateGoalUsage } from "./accounting.js";
import { formatError, truncateNotification } from "./errors.js";
import {
	type ActiveGoal,
	clearLegacyPersistedGoal,
	type GoalStateEntryData,
	type PendingQueueAction,
	type SafetyPauseCause,
	serializeGoalState,
} from "./persistence.js";
import {
	abortCurrentTurn,
	buildGoalStateSnapshot,
	formatBudget,
	type GoalStateSnapshot,
	hasPendingMessages,
	isTerminalGoalStatus,
	type StatusContext,
	transitionGoal,
} from "./policy.js";
import {
	type GoalPromptDeliveryOptions,
	GoalPromptOwnership,
	type GoalPromptOwnershipSnapshot,
	type GoalRunOrigin,
	sendHiddenGoalPrompt,
} from "./prompt-ownership.js";
import { nextToolFreeRepeatState, resetGoalSafetyEpoch } from "./safety.js";
import { GoalToolPolicy, type GoalToolVisibilitySnapshot } from "./tool-policy.js";

export type { StatusContext } from "./policy.js";
export {
	abortCurrentTurn,
	blocksStaleGoalToolCalls,
	createGoal,
	editedGoalStatus,
	formatBudget,
	formatStatus,
	type GoalStateSnapshot,
	type GoalStateSnapshotStatus,
	goalIdRejectionReason,
	goalSummary,
	hasPendingMessages,
	incrementGoal,
	isContradictoryCompletionSummary,
	isResumableGoalStatus,
	isTerminalGoalStatus,
	nextGoalInstance,
	stoppedStatusLabel,
	transitionGoal,
} from "./policy.js";
export {
	type ContinuationTicket,
	GOAL_PROMPT_MESSAGE_TYPE,
	type GoalPromptDeliveryOptions,
	type GoalRunOrigin,
} from "./prompt-ownership.js";
export { queueGoalSafetyReset, resetGoalSafetyEpoch } from "./safety.js";
export {
	GOAL_BLOCKED_TOOL,
	GOAL_COMPLETE_TOOL,
	type GoalToolVisibilitySnapshot,
} from "./tool-policy.js";

import { DEFAULT_GOAL_SETTINGS, type GoalSettings, type GoalSettingsLoadIssue } from "./settings.js";

export interface BudgetWrapUp {
	goalId: string;
	delivered: boolean;
}

type GoalRecoveryKind = "provider_retry" | "compaction_retry";

export interface GoalRecovery {
	goalId: string;
	kind: GoalRecoveryKind;
	automaticOwner: boolean;
	errorMessage?: string | undefined;
}

export interface CompletedGoalRun {
	goalId?: string | null | undefined;
	origin?: GoalRunOrigin | undefined;
	toolAttempted: boolean;
}

export interface GoalCompactionEvent {
	readonly reason?: "manual" | "overflow" | "threshold";
	readonly willRetry?: boolean;
}

interface GoalMessageCandidate {
	readonly customType?: unknown;
	readonly details?: unknown;
	readonly role?: unknown;
	readonly stopReason?: unknown;
}

const GOAL_STATE_ENTRY_TYPE = "goal-state";
export const EMERGENCY_AUTOMATIC_TURN_LIMIT = 10_000;

interface GoalTerminalDetails {
	goalId: string;
	summary?: string;
	reason?: string;
}

export interface GoalSettingsRuntimeSnapshot {
	settings: GoalSettings;
	activeGoal?: ActiveGoal | undefined;
	queueFrozen: boolean;
	queueFreezeAwaitingSettle: boolean;
	promptOwnership: GoalPromptOwnershipSnapshot;
	goalRecovery?: GoalRecovery | undefined;
	budgetWrapUp?: BudgetWrapUp | undefined;
	guardAbortGoalId?: string | undefined;
	staleGoalToolCallsBlocked: boolean;
	terminalDetails?: GoalTerminalDetails | undefined;
	toolVisibility: GoalToolVisibilitySnapshot;
}

const BUDGET_WRAP_UP_MESSAGE_TYPE = "goal-budget-wrap-up";
export const GOAL_CONTEXT_MESSAGE_TYPE = "pi-stuff-goal-context";
const BUDGET_WRAP_UP_PROMPT =
	"The active /goal token budget is exhausted. Stop substantive work and do not call substantive tools. Summarize progress, verified results, remaining work, and blockers concisely. Treat completion as unproven. Do not call goal_complete unless authoritative, requirement-by-requirement evidence already proves every requirement is complete. Weak, indirect, or missing evidence is not enough. Budget exhaustion is not completion.";
// One instance belongs to one extension factory. It owns all mutable session state
// and the ordering-sensitive invariants used by command and lifecycle orchestration.
// Prompt correlation lives in GoalPromptOwnership; this runtime coordinates it with
// queue, budget, safety, persistence, and tool-policy transitions.
export class GoalRuntime extends GoalToolPolicy {
	settings: GoalSettings = DEFAULT_GOAL_SETTINGS;
	settingsLoadIssue: GoalSettingsLoadIssue | undefined;
	activeGoal: ActiveGoal | undefined;
	/** Terminal details captured for the matching persisted-state snapshot. */
	private terminalDetails: GoalTerminalDetails | undefined;
	private cancelCompletionStatus: () => void = () => undefined;
	private goalStateSink: ((snapshot: GoalStateSnapshot) => void) | undefined;
	private deferredSessionStartState: GoalStateEntryData | undefined;
	private sessionStartReadOnly = false;
	queuedGoals: ActiveGoal[] = [];
	pendingQueueAction: PendingQueueAction | undefined;
	queueFrozen = false;
	queueFreezeAwaitingSettle = false;
	goalRecovery: GoalRecovery | undefined;
	budgetWrapUp: BudgetWrapUp | undefined;
	/** `null` marks a run that must not be charged to the active goal. */
	agentRunGoalId: string | null | undefined;
	agentRunOrigin: GoalRunOrigin | undefined;
	agentRunToolAttempted = false;
	guardAbortGoalId: string | undefined;
	staleGoalToolCallsBlocked = false;
	menuGeneration = 0;

	readonly prompts: GoalPromptOwnership;

	constructor(pi: ExtensionAPI) {
		super(pi);
		this.prompts = new GoalPromptOwnership(pi);
	}

	setGoalStateSink(sink: ((snapshot: GoalStateSnapshot) => void) | undefined) {
		this.goalStateSink = sink;
	}

	setCompletionStatusCancellation(cancel: () => void) {
		this.cancelCompletionStatus = cancel;
	}

	beginReadOnlySessionStart() {
		this.sessionStartReadOnly = true;
		this.deferredSessionStartState = undefined;
	}

	endReadOnlySessionStart() {
		this.sessionStartReadOnly = false;
	}

	flushDeferredSessionStartState() {
		const state = this.deferredSessionStartState;
		if (!state || this.sessionStartReadOnly) return;
		this.deferredSessionStartState = undefined;
		this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE, state);
	}

	private publishGoalState(snapshot: GoalStateSnapshot) {
		try {
			this.goalStateSink?.(snapshot);
		} catch {
			// Protocol publication must not interrupt canonical Goal persistence.
		}
	}

	invalidateMenuSession() {
		this.menuGeneration += 1;
	}

	canRecordGoalUsage(goalId?: string) {
		return (
			this.agentRunGoalId !== null &&
			(goalId === undefined || this.agentRunGoalId === undefined || this.agentRunGoalId === goalId) &&
			!(this.pendingQueueAction?.kind === "prioritize" && this.pendingQueueAction.displacedUsageFinalized === true)
		);
	}

	hasActiveBudgetWrapUp() {
		return (
			this.activeGoal?.status === "budget_limited" &&
			this.budgetWrapUp?.goalId === this.activeGoal.id &&
			this.budgetWrapUp.delivered
		);
	}

	beginAgentRun(goalId: string | null | undefined, origin: GoalRunOrigin | undefined) {
		this.agentRunGoalId = goalId;
		this.agentRunOrigin = origin;
		this.agentRunToolAttempted = false;
	}

	beginRecoveryRunIfNeeded() {
		if (this.agentRunGoalId !== undefined || !this.activeGoal) return;
		const recovery = this.goalRecovery;
		if (!recovery || recovery.goalId !== this.activeGoal.id) return;
		this.beginAgentRun(recovery.goalId, recovery.automaticOwner ? "automatic" : "manual");
	}

	markAgentToolAttempted() {
		if (this.agentRunGoalId !== undefined) this.agentRunToolAttempted = true;
	}

	finishAgentRun(): CompletedGoalRun {
		const run = {
			goalId: this.agentRunGoalId,
			origin: this.agentRunOrigin,
			toolAttempted: this.agentRunToolAttempted,
		};
		this.clearAgentRun();
		return run;
	}

	clearAgentRun() {
		this.agentRunGoalId = undefined;
		this.agentRunOrigin = undefined;
		this.agentRunToolAttempted = false;
	}

	reclassifyAgentRunAsManual() {
		if (this.agentRunGoalId !== undefined) this.agentRunOrigin = "manual";
	}

	isAutomaticRunForGoal(goalId: string) {
		return this.agentRunGoalId === goalId && this.agentRunOrigin === "automatic";
	}

	coordinationState() {
		const goal = this.activeGoal;
		return {
			goalId: goal?.id,
			continuationPermitted: goal?.status === "active" && !this.queueFrozen && this.pendingQueueAction === undefined,
		};
	}

	recordGoalUsage(goal: ActiveGoal, ctx: StatusContext, checkpointActiveTime = goal.status === "active") {
		if (goal.status === "complete" || goal.status === "blocked" || !this.canRecordGoalUsage(goal.id)) return false;
		updateGoalUsage(goal, ctx, checkpointActiveTime);
		return true;
	}

	dispatchContinuationIfSettled(ctx: StatusContext): Effect.Effect<boolean> {
		return Effect.suspend(() => {
			const intent = this.prompts.continuationIntent;
			if (!intent) return Effect.succeed(false);
			if (this.activeGoal?.status === "active" && !this.goalToolsAvailable()) {
				this.pauseGoalForUnavailableTools(ctx);
				return Effect.succeed(false);
			}
			if (!this.activeGoal || this.activeGoal.id !== intent.goalId || this.activeGoal.status !== "active") {
				this.prompts.continuationIntent = undefined;
				return Effect.succeed(false);
			}
			if (this.enforceAutomaticTurnLimit(ctx, false) || this.enforceNoProgressLimit(ctx)) {
				return Effect.succeed(false);
			}
			if (ctx.isIdle?.() !== true || hasPendingMessages(ctx) || readGoalCoordination(this.pi).pendingResultDelivery)
				return Effect.succeed(false);

			this.prompts.continuationIntent = undefined;
			this.prompts.continuationDelivery = intent;
			return sendHiddenGoalPrompt(
				this.pi,
				intent.prompt,
				false,
				() => this.activeGoal?.id === intent.goalId && this.activeGoal.status === "active",
				() =>
					ctx.isIdle?.() === true &&
					!hasPendingMessages(ctx) &&
					!readGoalCoordination(this.pi).pendingResultDelivery,
			).pipe(
				Effect.map((delivered) => {
					if (delivered) return true;
					if (this.prompts.continuationDelivery?.marker === intent.marker) {
						this.prompts.continuationDelivery = undefined;
					}
					return false;
				}),
				Effect.catch((error) =>
					Effect.sync(() => {
						if (this.prompts.continuationDelivery?.marker === intent.marker) {
							this.prompts.continuationDelivery = undefined;
						}
						if (this.activeGoal?.id === intent.goalId && this.activeGoal.status === "active") {
							this.prompts.continuationIntent = intent;
						}
						ctx.ui.notify(`Goal prompt failed: ${formatError(error)}`, "error");
						return false;
					}),
				),
			);
		});
	}

	publishPresentationStatus(goal: ActiveGoal | undefined) {
		if (!goal || goal.status === "queued") {
			this.clearPresentationStatus();
			return;
		}
		const snapshot: GoalStatusSnapshot = {
			status: goal.status,
			timeUsedSeconds: goal.timeUsedSeconds,
			tokensUsed: goal.tokensUsed,
		};
		if (goal.activeStartedAt !== undefined) Object.assign(snapshot, { activeStartedAt: goal.activeStartedAt });
		if (goal.tokenBudget !== undefined) Object.assign(snapshot, { tokenBudget: goal.tokenBudget });
		getGoalStatusChannel(this.pi).publish(snapshot);
	}

	clearPresentationStatus() {
		getGoalStatusChannel(this.pi).clear();
	}

	blockStaleGoalToolCalls() {
		this.staleGoalToolCallsBlocked = true;
	}

	clearStaleGoalToolCallBlock() {
		this.staleGoalToolCallsBlocked = false;
	}

	clearBudgetWrapUp() {
		this.budgetWrapUp = undefined;
	}

	setCompletionSummary(goalId: string, summary: string) {
		this.terminalDetails = { goalId, summary };
	}

	setTerminalReason(goalId: string, reason: string) {
		this.terminalDetails = { goalId, reason };
	}

	clearTerminalDetails() {
		this.terminalDetails = undefined;
	}

	isActiveBudgetWrapUpMessage(message: GoalMessageCandidate | null | undefined) {
		if (!message || !isRuntimeObject(message)) return false;
		const details = isJsonInputObject(message.details) ? message.details : undefined;
		return (
			message.role === "custom" &&
			message.customType === BUDGET_WRAP_UP_MESSAGE_TYPE &&
			isRuntimeString(details?.["goalId"]) &&
			details["goalId"] === this.budgetWrapUp?.goalId &&
			details["goalId"] === this.activeGoal?.id
		);
	}

	keepBudgetWrapUpMessage(message: GoalMessageCandidate | null | undefined) {
		if (!message || !isRuntimeObject(message)) return true;
		if (message.role !== "custom" || message.customType !== BUDGET_WRAP_UP_MESSAGE_TYPE) {
			return true;
		}
		return this.isActiveBudgetWrapUpMessage(message);
	}

	queueBudgetWrapUp(ctx: StatusContext, goal: ActiveGoal): Effect.Effect<void> {
		if (!this.budgetWrapUp || this.budgetWrapUp.goalId !== goal.id) {
			this.budgetWrapUp = { goalId: goal.id, delivered: false };
		}
		if (this.budgetWrapUp.delivered) return Effect.void;
		const pendingWrapUp = this.budgetWrapUp;
		pendingWrapUp.delivered = true;
		const isCurrent = () =>
			this.budgetWrapUp === pendingWrapUp &&
			this.activeGoal?.id === goal.id &&
			this.activeGoal.status === "budget_limited";
		return Effect.tryPromise({
			try: () =>
				sendSuiteAgentMessage(
					this.pi,
					withAgentWorkOrigin(
						{
							customType: BUDGET_WRAP_UP_MESSAGE_TYPE,
							content: BUDGET_WRAP_UP_PROMPT,
							display: true,
							details: { goalId: goal.id },
						},
						"automatic",
					),
					{ deliverAs: "steer" },
					isCurrent,
				),
			catch: (error) => error,
		}).pipe(
			Effect.tap((accepted) =>
				Effect.sync(() => {
					if (!accepted && this.budgetWrapUp === pendingWrapUp) pendingWrapUp.delivered = false;
				}),
			),
			Effect.catch((error) =>
				Effect.sync(() => {
					if (!isCurrent()) return;
					pendingWrapUp.delivered = false;
					ctx.ui.notify(`Goal budget wrap-up failed: ${formatError(error)}`, "error");
				}),
			),
			Effect.asVoid,
		);
	}

	limitActiveGoalForBudget(ctx: StatusContext) {
		const goal = this.activeGoal;
		if (goal?.status !== "active" || goal.tokenBudget === undefined || goal.tokensUsed < goal.tokenBudget) {
			return false;
		}

		this.prompts.cancelContinuationWork();
		this.clearGoalRecoveryForGoal(goal.id);
		this.clearBudgetWrapUp();
		this.activeGoal = transitionGoal(goal, "budget_limited");
		this.setTerminalReason(this.activeGoal.id, `token budget reached (${formatBudget(this.activeGoal)})`);
		this.persistGoal(this.activeGoal);
		ctx.ui.notify(`Goal token budget reached: ${formatBudget(this.activeGoal)}`, "warning");
		return true;
	}

	recordAutomaticTurn(ctx: StatusContext, message: GoalMessageCandidate | null | undefined) {
		const goal = this.activeGoal;
		if (goal?.status !== "active" || !this.isAutomaticRunForGoal(goal.id)) return false;
		if (message?.role === "assistant" && message.stopReason === "aborted") return false;
		goal.automaticModelTurns = Math.min(Number.MAX_SAFE_INTEGER, goal.automaticModelTurns + 1);
		this.recordGoalUsage(goal, ctx);
		this.persistGoal(goal);
		// Terminal errors need agent_end classification before a safety pause can
		// choose between usage_limited, blocked, or retryable cleanup.
		if (message?.role === "assistant" && message.stopReason === "error") return false;
		return this.enforceAutomaticTurnLimit(ctx, true);
	}

	recordAutomaticRunProgress(
		ctx: StatusContext,
		goalId: string,
		messages: readonly unknown[],
		toolAttempted: boolean,
	) {
		const goal = this.activeGoal;
		if (goal?.id !== goalId || goal.status !== "active") return false;
		const next = nextToolFreeRepeatState(goal, messages, toolAttempted);
		goal.toolFreeRepeatCount = next.toolFreeRepeatCount;
		goal.lastToolFreeOutputFingerprint = next.lastToolFreeOutputFingerprint;
		this.persistGoal(goal);
		const limit = this.settings.continuationLimits.noProgressTurns;
		if (limit === null || goal.toolFreeRepeatCount < limit) return false;
		return this.pauseGoalForSafety(ctx, "no_progress", false);
	}

	enforceAutomaticTurnLimit(ctx: StatusContext, abortTurn: boolean) {
		const goal = this.activeGoal;
		const configuredLimit = this.settings.continuationLimits.automaticTurns;
		const limit = Math.min(configuredLimit ?? Number.POSITIVE_INFINITY, EMERGENCY_AUTOMATIC_TURN_LIMIT);
		if (goal?.status !== "active" || goal.automaticModelTurns < limit) {
			return false;
		}
		return this.pauseGoalForSafety(
			ctx,
			configuredLimit === null || configuredLimit > EMERGENCY_AUTOMATIC_TURN_LIMIT
				? "runaway_backstop"
				: "continuation_limit",
			abortTurn,
		);
	}

	enforceNoProgressLimit(ctx: StatusContext, abortTurn = false) {
		const goal = this.activeGoal;
		const limit = this.settings.continuationLimits.noProgressTurns;
		if (goal?.status !== "active" || limit === null || goal.toolFreeRepeatCount < limit) {
			return false;
		}
		return this.pauseGoalForSafety(ctx, "no_progress", abortTurn);
	}

	pauseGoalForSafety(ctx: StatusContext, cause: SafetyPauseCause, abortTurn: boolean) {
		const goal = this.activeGoal;
		if (goal?.status !== "active") return false;
		this.prompts.cancelContinuationWork();
		this.clearGoalRecoveryForGoal(goal.id);
		this.clearBudgetWrapUp();
		this.blockStaleGoalToolCalls();
		if (abortTurn) {
			this.guardAbortGoalId = goal.id;
			abortCurrentTurn(ctx);
		}
		this.activeGoal = transitionGoal({ ...goal, safetyPauseCause: cause }, "paused");
		const count =
			cause === "continuation_limit" || cause === "runaway_backstop"
				? `${this.activeGoal.automaticModelTurns} automatic model responses`
				: `no progress across ${this.activeGoal.toolFreeRepeatCount} automatic runs`;
		this.setTerminalReason(
			this.activeGoal.id,
			`${cause} (${count}; ${formatTokenCount(this.activeGoal.tokensUsed)} tokens)`,
		);
		this.persistGoal(this.activeGoal);
		ctx.ui.notify(
			`Goal paused: ${count}; ${formatTokenCount(this.activeGoal.tokensUsed)} cumulative tokens. Run /goal resume to continue.`,
			"warning",
		);
		return true;
	}

	resetActiveSafetyEpoch() {
		const goal = this.activeGoal;
		if (goal?.status !== "active") return false;
		this.activeGoal = resetGoalSafetyEpoch(goal);
		this.reclassifyAgentRunAsManual();
		this.persistGoal(this.activeGoal);
		return true;
	}

	finalizeSettledRecovery(ctx: StatusContext) {
		const recovery = this.goalRecovery;
		if (!recovery) return false;
		this.goalRecovery = undefined;
		const goal = this.activeGoal;
		if (goal?.id !== recovery.goalId || goal.status !== "active") return false;
		this.prompts.cancelContinuationWork();
		this.clearBudgetWrapUp();
		const details = recovery.errorMessage ? `: ${truncateNotification(recovery.errorMessage)}` : "";
		this.clearStaleGoalToolCallBlock();
		this.persistGoal(goal);
		ctx.ui.notify(
			`Goal provider retry was exhausted${details}. The Goal remains active and will continue from the next settled boundary.`,
			"warning",
		);
		this.prompts.requestContinuation(goal);
		return true;
	}

	clearSettledSafetyTracking() {
		this.guardAbortGoalId = undefined;
		this.prompts.clearSettledClaims();
		this.clearAgentRun();
	}

	clearGoalRecoveryForGoal(goalId: string) {
		if (this.goalRecovery?.goalId === goalId) this.goalRecovery = undefined;
	}

	isPiOwnedCompactionRetry(event: GoalCompactionEvent, goalId: string) {
		if (event.willRetry === true) return true;
		return (
			this.goalRecovery?.goalId === goalId &&
			this.goalRecovery.kind === "compaction_retry" &&
			(event.reason === undefined || event.reason === "overflow")
		);
	}

	sendOwnedGoalPrompt(ctx: StatusContext, goalId: string, prompt: string, options: GoalPromptDeliveryOptions = {}) {
		return this.prompts.sendOwnedGoalPrompt(
			ctx,
			goalId,
			prompt,
			options,
			() => this.activeGoal?.id === goalId && this.activeGoal.status === "active",
		);
	}

	consumeStaleOwnedGoalPrompt(prompt: string) {
		return this.prompts.consumeStaleOwnedGoalPrompt(
			prompt,
			(goalId) =>
				!this.queueFrozen &&
				!this.pendingQueueAction &&
				this.activeGoal?.id === goalId &&
				this.activeGoal.status === "active",
		);
	}

	persistGoal(goal: ActiveGoal) {
		this.cancelCompletionStatus();
		if (!isTerminalGoalStatus(goal.status) || this.terminalDetails?.goalId !== goal.id) {
			this.clearTerminalDetails();
		}
		this.persistGoalState(serializeGoalState(goal, this.queuedGoals, this.pendingQueueAction));
		this.publishGoalState(buildGoalStateSnapshot(goal, this.terminalDetails?.summary, this.terminalDetails?.reason));
		// A synchronous managed-run listener may pause, clear, or replace the Goal
		// while the state event is being published. Never let the older transition
		// overwrite the presentation snapshot produced by that nested mutation.
		if (this.activeGoal?.id === goal.id && this.activeGoal.status === goal.status) {
			this.publishPresentationStatus(goal);
		}
	}

	clearPersistedGoal(cwd: string, clearedGoal?: ActiveGoal, reason = "goal cleared"): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			this.persistGoalState(serializeGoalState(undefined, [], undefined));
			if (clearedGoal) {
				this.publishGoalState({
					goalId: clearedGoal.id,
					status: "cleared",
					reason,
				});
			}
			this.clearTerminalDetails();
			this.clearPresentationStatus();
			yield* clearLegacyPersistedGoal(cwd);
		});
	}

	private persistGoalState(state: GoalStateEntryData) {
		if (this.sessionStartReadOnly) {
			this.deferredSessionStartState = state;
			return;
		}
		this.deferredSessionStartState = undefined;
		this.pi.appendEntry(GOAL_STATE_ENTRY_TYPE, state);
	}

	clearActiveGoal(ctx: StatusContext, reason = "goal cleared"): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			const clearedGoal = this.activeGoal;
			this.prompts.cancelContinuationWork();
			this.goalRecovery = undefined;
			this.clearBudgetWrapUp();
			this.clearStaleGoalToolCallBlock();
			this.activeGoal = undefined;
			this.queuedGoals = [];
			this.pendingQueueAction = undefined;
			this.queueFrozen = false;
			this.queueFreezeAwaitingSettle = false;
			yield* this.clearPersistedGoal(ctx.cwd, clearedGoal, reason);
			// Do not clear goalToolsUnlocked: after first activation, keep tools visible
			// for the rest of this extension runtime to avoid repeated goal-tool schema
			// churn within the same runtime.
		});
	}

	prepareGoalToolsForActivation(ctx: StatusContext) {
		this.prepareGoalToolsForVisibility(this.settings.toolVisibility, ctx);
	}

	snapshotSettingsApplicationState(): GoalSettingsRuntimeSnapshot {
		return {
			settings: structuredClone(this.settings),
			activeGoal: this.activeGoal ? structuredClone(this.activeGoal) : undefined,
			queueFrozen: this.queueFrozen,
			queueFreezeAwaitingSettle: this.queueFreezeAwaitingSettle,
			promptOwnership: this.prompts.snapshot(),
			goalRecovery: this.goalRecovery ? structuredClone(this.goalRecovery) : undefined,
			budgetWrapUp: this.budgetWrapUp ? structuredClone(this.budgetWrapUp) : undefined,
			guardAbortGoalId: this.guardAbortGoalId,
			staleGoalToolCallsBlocked: this.staleGoalToolCallsBlocked,
			terminalDetails: this.terminalDetails ? structuredClone(this.terminalDetails) : undefined,
			toolVisibility: this.snapshotGoalToolVisibility(),
		};
	}

	restoreSettingsApplicationState(snapshot: GoalSettingsRuntimeSnapshot) {
		this.settings = structuredClone(snapshot.settings);
		this.activeGoal = snapshot.activeGoal ? structuredClone(snapshot.activeGoal) : undefined;
		this.queueFrozen = snapshot.queueFrozen;
		this.queueFreezeAwaitingSettle = snapshot.queueFreezeAwaitingSettle;
		this.prompts.restore(snapshot.promptOwnership);
		this.goalRecovery = snapshot.goalRecovery ? structuredClone(snapshot.goalRecovery) : undefined;
		this.budgetWrapUp = snapshot.budgetWrapUp ? structuredClone(snapshot.budgetWrapUp) : undefined;
		this.guardAbortGoalId = snapshot.guardAbortGoalId;
		this.staleGoalToolCallsBlocked = snapshot.staleGoalToolCallsBlocked;
		this.terminalDetails = snapshot.terminalDetails ? structuredClone(snapshot.terminalDetails) : undefined;
		this.restoreGoalToolVisibility(snapshot.toolVisibility);
	}

	pauseGoalForUnavailableTools(ctx: StatusContext, abortTurn = true, recordUsage = true) {
		const goal = this.activeGoal;
		if (goal?.status !== "active") return false;
		if (recordUsage) this.recordGoalUsage(goal, ctx);
		this.prompts.cancelContinuationWork();
		this.clearGoalRecoveryForGoal(goal.id);
		this.clearBudgetWrapUp();
		if (abortTurn) {
			this.blockStaleGoalToolCalls();
			abortCurrentTurn(ctx);
		} else {
			this.clearStaleGoalToolCallBlock();
		}
		this.activeGoal = transitionGoal(goal, "paused");
		this.persistGoal(this.activeGoal);
		ctx.ui.notify(
			"Goal tools are unavailable, so the active goal was paused. Restore the tools and run /goal resume.",
			"warning",
		);
		return true;
	}

	showCompletionStatus(timeUsedSeconds = 0) {
		this.cancelCompletionStatus();
		getGoalStatusChannel(this.pi).publish({ status: "complete", timeUsedSeconds, tokensUsed: 0 });
	}
}

export type { AssistantMessageLike } from "./errors.js";
export {
	findFinalAssistantMessage,
	formatError,
	isExternallyBlockedGoalInterruption,
	isGoalContextOverflow,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
	truncateNotification,
} from "./errors.js";
