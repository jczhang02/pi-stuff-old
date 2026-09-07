import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { registerSuiteOwnedTool } from "../../tool-display/registration.ts";
import { formatDuration, formatTokenCount } from "./accounting.ts";
import type { ActiveGoal } from "./persistence.ts";
import {
	abortCurrentTurn,
	GOAL_BLOCKED_TOOL,
	GOAL_COMPLETE_TOOL,
	type GoalRuntime,
	goalIdRejectionReason,
	isContradictoryCompletionSummary,
	transitionGoal,
} from "./runtime.ts";
import { blockerReportRejectionReason, completionEvidenceRejectionReason, recordGoalBlockerAttempt } from "./safety.ts";
import {
	GOAL_COMPLETION_EVIDENCE_INPUT_SCHEMA,
	type GoalBlockedDetails,
	type GoalCompleteDetails,
	goalBlockedPresentation,
	goalCompletePresentation,
	MAX_COMPLETION_EVIDENCE_TEXT_LENGTH,
} from "./tool-contract.ts";

const MAX_BLOCKER_REASON_LENGTH = 1_000;
const MAX_BLOCKER_EVIDENCE_LENGTH = 4_000;
const MAX_COMPLETION_EVIDENCE_ITEMS = 50;

const GOAL_COMPLETE_PARAMETERS = Type.Object({
	goal_id: Type.String({
		description:
			"The exact goal_id shown in the current active /goal prompt. Used only to reject stale completion calls from older turns.",
	}),
	summary: Type.String({
		minLength: 1,
		maxLength: MAX_COMPLETION_EVIDENCE_TEXT_LENGTH,
		description:
			"State what was completed and what evidence verified it. Do not use this tool to report partial progress, blockers, failures, or remaining work.",
	}),
	evidence: Type.Array(
		Type.Object({
			requirement: Type.String({
				minLength: 1,
				maxLength: MAX_COMPLETION_EVIDENCE_TEXT_LENGTH,
				description: "One concrete requirement from the active goal, in the language of the objective.",
			}),
			proof: Type.String({
				minLength: 1,
				maxLength: MAX_COMPLETION_EVIDENCE_TEXT_LENGTH,
				description:
					"The observed verification result, including an exact output or value, command exit status, file path, test count, URL response, or hash. Any language is accepted.",
			}),
		}),
		{
			minItems: 1,
			maxItems: MAX_COMPLETION_EVIDENCE_ITEMS,
			description:
				"Requirement-by-requirement concrete proof from current files, commands, tests, outputs, or external state.",
		},
	),
});

const GOAL_BLOCKED_PARAMETERS = Type.Object({
	goal_id: Type.String({ description: "The exact goal_id shown in the current active /goal prompt." }),
	reason: Type.String({
		minLength: 1,
		maxLength: MAX_BLOCKER_REASON_LENGTH,
		description: "The specific user or external action required to unblock the goal.",
	}),
	attempt: Type.String({
		minLength: 1,
		maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
		description: "The concrete action tried during this Goal turn; it must differ from earlier audit turns.",
	}),
	evidence: Type.String({
		minLength: 1,
		maxLength: MAX_BLOCKER_EVIDENCE_LENGTH,
		description: "The concrete observed failure produced by this turn's attempted action.",
	}),
	repeated_turns: Type.Integer({
		minimum: 1,
		description:
			"Your count of consecutive Goal turns spent trying to resolve this same blocker. The runtime independently records and verifies the count.",
	}),
});

type GoalCompleteParams = Static<typeof GOAL_COMPLETE_PARAMETERS>;
type GoalBlockedParams = Static<typeof GOAL_BLOCKED_PARAMETERS>;

interface GoalTerminalToolOptions {
	readonly run: <A>(ctx: ExtensionContext, program: Effect.Effect<A, unknown>) => Promise<A>;
	readonly showCompletionStatus: (ctx: ExtensionContext, timeUsedSeconds: number) => void;
}

function hasPendingSkipForGoal(runtime: GoalRuntime, goalId: string): boolean {
	return (
		runtime.pendingQueueAction?.kind === "advance" &&
		runtime.pendingQueueAction.reason === "skip" &&
		runtime.pendingQueueAction.goalId === goalId
	);
}

function goalCompletionResult(
	text: string,
	completed: ActiveGoal,
	details: GoalCompleteDetails,
	budgetWrapUp: boolean,
) {
	const terminate =
		budgetWrapUp || (completed.tokenBudget !== undefined && completed.tokensUsed >= completed.tokenBudget);
	const facts: string[] = [];
	if (completed.tokenBudget !== undefined) {
		facts.push(
			`Token budget used: ${formatTokenCount(completed.tokensUsed)}/${formatTokenCount(completed.tokenBudget)}.`,
		);
	} else if (completed.tokensUsed > 0) {
		facts.push(`Tokens used: ${formatTokenCount(completed.tokensUsed)}.`);
	}
	if (completed.timeUsedSeconds > 0) facts.push(`Elapsed time: ${formatDuration(completed.timeUsedSeconds)}.`);
	const finalResponse = terminate
		? []
		: [
				"",
				"The Goal is complete. Send the user a concise final response now with the result, verification, any remaining risk, and every usage fact above.",
			];
	const result = {
		content: [{ type: "text" as const, text: [text, ...facts, ...finalResponse].join("\n") }],
		details,
	};
	return terminate ? { ...result, terminate: true as const } : result;
}

function executeGoalComplete(
	runtime: GoalRuntime,
	params: GoalCompleteParams,
	ctx: ExtensionContext,
	showCompletionStatus: GoalTerminalToolOptions["showCompletionStatus"],
) {
	return Effect.gen(function* () {
		const completedGoal = runtime.activeGoal;
		const goal = completedGoal?.text ?? "unknown goal";
		const requestedGoalId = isRuntimeString(params.goal_id) ? params.goal_id.trim() : "";
		const summary = isRuntimeString(params.summary) ? params.summary.trim() : "";
		const evidence = Array.isArray(params.evidence)
			? params.evidence.map((item) =>
					Check(GOAL_COMPLETION_EVIDENCE_INPUT_SCHEMA, item)
						? { requirement: item.requirement.trim(), proof: item.proof.trim() }
						: { requirement: "", proof: "" },
				)
			: [];
		const details = { goal, goal_id: requestedGoalId, summary, evidence } satisfies GoalCompleteDetails;
		const reject = (reason: string, terminate = false) => {
			const rejection = `Goal completion rejected: ${reason}.`;
			ctx.ui.notify(rejection, "warning");
			const result = { content: [{ type: "text" as const, text: rejection }], details };
			return terminate ? { ...result, terminate: true as const } : result;
		};
		if (!completedGoal) return reject("no active goal");
		const completingDuringBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
		if (!runtime.canRecordGoalUsage() && !completingDuringBudgetWrapUp) {
			return reject("current run does not own the active goal");
		}
		if (hasPendingSkipForGoal(runtime, completedGoal.id)) {
			runtime.recordGoalUsage(completedGoal, ctx);
			runtime.persistGoal(completedGoal);
			runtime.clearBudgetWrapUp();
			return reject("goal is queued to be skipped", true);
		}
		const staleGoalRejection = goalIdRejectionReason(completedGoal, requestedGoalId);
		if (staleGoalRejection) {
			if (completingDuringBudgetWrapUp) {
				runtime.recordGoalUsage(completedGoal, ctx);
				runtime.persistGoal(completedGoal);
				runtime.clearBudgetWrapUp();
			}
			return reject(staleGoalRejection, completingDuringBudgetWrapUp);
		}
		if (completedGoal.status !== "active" && !completingDuringBudgetWrapUp) {
			return reject(`goal is ${completedGoal.status}, not active`);
		}

		const rejectionReason = !summary
			? "summary is empty"
			: summary.length > MAX_COMPLETION_EVIDENCE_TEXT_LENGTH
				? "summary is too long"
				: isContradictoryCompletionSummary(summary)
					? "summary says the goal is not complete"
					: evidence.length > MAX_COMPLETION_EVIDENCE_ITEMS
						? "too many completion evidence entries"
						: evidence.some(
									(item) =>
										item.requirement.length > MAX_COMPLETION_EVIDENCE_TEXT_LENGTH ||
										item.proof.length > MAX_COMPLETION_EVIDENCE_TEXT_LENGTH,
								)
							? "completion evidence is too long"
							: completionEvidenceRejectionReason(summary, evidence);
		if (rejectionReason) {
			runtime.recordGoalUsage(completedGoal, ctx);
			runtime.persistGoal(completedGoal);
			if (completingDuringBudgetWrapUp) runtime.clearBudgetWrapUp();
			return reject(rejectionReason, completingDuringBudgetWrapUp);
		}

		runtime.recordGoalUsage(completedGoal, ctx);
		runtime.activeGoal = transitionGoal(completedGoal, "complete");
		runtime.setCompletionSummary(runtime.activeGoal.id, summary);
		if (runtime.pendingQueueAction?.kind === "prioritize") {
			runtime.persistGoal(runtime.activeGoal);
			runtime.publishPresentationStatus(runtime.activeGoal);
			return goalCompletionResult(
				`Goal complete: ${summary}`,
				runtime.activeGoal,
				details,
				completingDuringBudgetWrapUp,
			);
		}
		if (runtime.queuedGoals.length > 0) {
			runtime.pendingQueueAction = {
				kind: "advance",
				goalId: runtime.activeGoal.id,
				reason: "complete",
				completedText: goal,
			};
			runtime.persistGoal(runtime.activeGoal);
			runtime.publishPresentationStatus(runtime.activeGoal);
			return goalCompletionResult(
				`Goal complete: ${summary}\nNext goal queued: ${runtime.queuedGoals[0]?.text}`,
				runtime.activeGoal,
				details,
				completingDuringBudgetWrapUp,
			);
		}
		const completedTimeUsedSeconds = runtime.activeGoal.timeUsedSeconds;
		const result = goalCompletionResult(
			`Goal complete: ${summary}`,
			runtime.activeGoal,
			details,
			completingDuringBudgetWrapUp,
		);
		runtime.persistGoal(runtime.activeGoal);
		runtime.publishPresentationStatus(runtime.activeGoal);
		yield* runtime.clearActiveGoal(ctx);
		showCompletionStatus(ctx, completedTimeUsedSeconds);
		return result;
	});
}

function executeGoalBlocked(runtime: GoalRuntime, params: GoalBlockedParams, ctx: ExtensionContext) {
	const blockedGoal = runtime.activeGoal;
	const goal = blockedGoal?.text ?? "unknown goal";
	const requestedGoalId = isRuntimeString(params.goal_id) ? params.goal_id.trim() : "";
	const reason = isRuntimeString(params.reason) ? params.reason.trim() : "";
	const attemptedAction = isRuntimeString(params.attempt) ? params.attempt.trim() : "";
	const evidence = isRuntimeString(params.evidence) ? params.evidence.trim() : "";
	const repeatedTurns = isRuntimeNumber(params.repeated_turns) ? params.repeated_turns : Number.NaN;
	const reject = (rejectionReason: string, terminate = false) => {
		const rejection = `goal_blocked rejected: ${rejectionReason}.`;
		ctx.ui.notify(rejection, "warning");
		const result = {
			content: [{ type: "text" as const, text: rejection }],
			details: {
				goal,
				goal_id: requestedGoalId,
				reason: reason.slice(0, MAX_BLOCKER_REASON_LENGTH),
				attempt: attemptedAction.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
				evidence: evidence.slice(0, MAX_BLOCKER_EVIDENCE_LENGTH),
				repeated_turns: Number.isFinite(repeatedTurns) ? repeatedTurns : 0,
			} satisfies GoalBlockedDetails,
		};
		return terminate ? { ...result, terminate: true as const } : result;
	};

	if (!blockedGoal) return reject("no active goal");
	if (!runtime.canRecordGoalUsage()) return reject("current run does not own the active goal");
	if (hasPendingSkipForGoal(runtime, blockedGoal.id)) {
		runtime.recordGoalUsage(blockedGoal, ctx);
		runtime.persistGoal(blockedGoal);
		runtime.clearBudgetWrapUp();
		return reject("goal is queued to be skipped", true);
	}
	const staleGoalRejection = goalIdRejectionReason(blockedGoal, requestedGoalId);
	if (staleGoalRejection) return reject(staleGoalRejection);
	if (blockedGoal.status !== "active") return reject(`goal is ${blockedGoal.status}, not active`);
	if (!reason) return reject("reason is empty");
	if (reason.length > MAX_BLOCKER_REASON_LENGTH) return reject("reason is too long");
	if (!attemptedAction) return reject("attempt is empty");
	if (attemptedAction.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("attempt is too long");
	if (!evidence) return reject("evidence is empty");
	if (evidence.length > MAX_BLOCKER_EVIDENCE_LENGTH) return reject("evidence is too long");
	if (!Number.isInteger(repeatedTurns)) return reject("repeated_turns must be a whole number");
	if (repeatedTurns < 1) return reject("repeated_turns must be at least 1");
	const blockerRejection = blockerReportRejectionReason(blockedGoal, reason, attemptedAction, evidence);
	if (blockerRejection) return reject(blockerRejection);

	blockedGoal.blockerAudit = recordGoalBlockerAttempt(blockedGoal, reason, attemptedAction, evidence);
	runtime.persistGoal(blockedGoal);
	if (blockedGoal.blockerAudit.consecutiveTurns < 3) {
		return reject(
			`blocker audit recorded for ${blockedGoal.blockerAudit.consecutiveTurns}/3 consecutive Goal turns; keep working and report the same stable blocker on a later Goal turn only if it persists`,
		);
	}
	if (repeatedTurns < 3) return reject("repeated_turns must acknowledge at least 3 consecutive Goal turns");

	runtime.recordGoalUsage(blockedGoal, ctx);
	runtime.prompts.cancelContinuationWork();
	runtime.clearBudgetWrapUp();
	runtime.clearGoalRecoveryForGoal(blockedGoal.id);
	runtime.activeGoal = transitionGoal(blockedGoal, "blocked");
	runtime.setTerminalReason(runtime.activeGoal.id, reason);
	runtime.persistGoal(runtime.activeGoal);
	const terminate = blockedGoal.tokenBudget !== undefined && blockedGoal.tokensUsed >= blockedGoal.tokenBudget;
	const result = {
		content: [
			{
				type: "text" as const,
				text: `Goal blocked: ${reason}${terminate ? "" : "\n\nThe Goal is blocked. Send the user a concise final response now with the blocker, evidence, and exact user or external action needed."}`,
			},
		],
		details: {
			goal,
			goal_id: requestedGoalId,
			reason,
			attempt: attemptedAction,
			evidence,
			repeated_turns: repeatedTurns,
		} satisfies GoalBlockedDetails,
	};
	return terminate ? { ...result, terminate: true as const } : result;
}

export function registerGoalTerminalTools(
	pi: ExtensionAPI,
	runtime: GoalRuntime,
	options: GoalTerminalToolOptions,
): void {
	const goalCompleteTool = defineTool({
		name: GOAL_COMPLETE_TOOL,
		label: "Goal Complete",
		description:
			"Mark the active /goal as complete after all required work is done and verified, using the current goal_id stale-turn guard. Do not use for partial progress, blockers, failing, or unverified work.",
		promptSnippet:
			"Mark the active /goal as complete after fully finishing and verifying it, with the current goal_id",
		promptGuidelines: [
			"When a /goal is active, keep working until the goal is complete; do not stop with only a plan or partial progress.",
			"Before calling goal_complete, audit the active goal requirement by requirement against the current files, command output, tests, or external state.",
			"Pass the exact goal_id shown in the current /goal prompt; never reuse a goal_id from an older, stopped, replaced, or cleared turn.",
			"Call goal_complete only after the requested goal is fully implemented, verified, and no known required work remains; otherwise keep working.",
		],
		parameters: GOAL_COMPLETE_PARAMETERS,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const result = await options.run(ctx, executeGoalComplete(runtime, params, ctx, options.showCompletionStatus));
			// Pi aggregates terminate across the whole Tool batch; abort also covers mixed batches.
			if ("terminate" in result && result.terminate) abortCurrentTurn(ctx);
			return result;
		},
	});

	const goalBlockedTool = defineTool({
		name: GOAL_BLOCKED_TOOL,
		label: "Goal Blocked",
		description:
			"Report a true external blocker on each consecutive Goal turn. The runtime stops the active /goal only after three distinct failed actions establish the same blocker and required user or external action. Do not use for ordinary clarification, uncertainty, or recoverable failures.",
		promptSnippet:
			"Report a true external blocker each turn; the runtime stops only after the same blocker passes a three-turn audit",
		promptGuidelines: [
			"For a true impasse, call goal_blocked on each consecutive Goal turn with the same stable reason, a distinct attempted action, and its concrete observed failure. The first two reports only record audit progress; continue trying reasonable alternatives afterward.",
			"The runtime, not repeated_turns alone, verifies that the same blocker was reported on at least three consecutive Goal turns before stopping the Goal.",
			"After a blocked goal is resumed, start a fresh three-turn blocker audit before using goal_blocked again.",
			"Do not use goal_blocked for ordinary clarification, incomplete work, uncertainty, difficult tasks, or recoverable tool/provider failures.",
			"Pass goal_blocked the exact current goal_id; never reuse a goal_id from an older, stopped, replaced, or cleared goal turn.",
		],
		parameters: GOAL_BLOCKED_PARAMETERS,
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const result = await options.run(
				ctx,
				Effect.sync(() => executeGoalBlocked(runtime, params, ctx)),
			);
			if ("terminate" in result && result.terminate) abortCurrentTurn(ctx);
			return result;
		},
	});

	registerSuiteOwnedTool(pi, goalCompleteTool, goalCompletePresentation());
	registerSuiteOwnedTool(pi, goalBlockedTool, goalBlockedPresentation());
}
