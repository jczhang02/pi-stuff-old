/** Stateless terminal Goal Tool schemas and Tool Activity projection. */

import { Type } from "typebox";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { activityKey, singleActivity } from "../../tool-display/activity.ts";
import type { SuiteToolPresentation } from "../../tool-display/contract.ts";
import { safeGoalMenuText } from "./menu.ts";
import type { GoalCompletionEvidence } from "./safety.ts";

export interface GoalCompleteDetails {
	goal: string;
	goal_id: string;
	summary: string;
	evidence: GoalCompletionEvidence[];
}

export interface GoalBlockedDetails {
	goal: string;
	goal_id: string;
	reason: string;
	attempt: string;
	evidence: string;
	repeated_turns: number;
}

export interface GoalCompletePresentationArguments {
	goal_id?: string;
	summary?: string;
}

export interface GoalBlockedPresentationArguments {
	goal_id?: string;
	reason?: string;
}

function goalToolText(result: {
	readonly content: readonly { readonly type: string; readonly text?: string }[];
}): string {
	const text = result.content.find((part) => part.type === "text")?.text;
	return isRuntimeString(text) ? text : "";
}

export function goalCompletePresentation(): SuiteToolPresentation<
	GoalCompletePresentationArguments,
	GoalCompleteDetails
> {
	return {
		activity: {
			categories: ["complete-goal"],
			classify: ({ args, state }) => {
				if (state !== "running" && state !== "success") return [];
				const goalId = isRuntimeString(args["goal_id"]) ? args["goal_id"] : "goal";
				const summary = isRuntimeString(args["summary"]) ? args["summary"] : goalId;
				return singleActivity("complete-goal", { key: activityKey(goalId), target: summary });
			},
		},
		detailLines: (_params, result) => {
			if (goalToolText(result).startsWith("Goal completion rejected:")) return [goalToolText(result)];
			return [
				"Summary",
				safeGoalMenuText(result.details.summary, MAX_COMPLETION_EVIDENCE_TEXT_LENGTH),
				"",
				"Evidence",
				...result.details.evidence.flatMap((item, index) => [
					`${String(index + 1)}. ${safeGoalMenuText(item.requirement, MAX_COMPLETION_EVIDENCE_TEXT_LENGTH)}`,
					`   ${safeGoalMenuText(item.proof, MAX_COMPLETION_EVIDENCE_TEXT_LENGTH)}`,
				]),
			];
		},
		label: "Goal complete",
		resultIsError: (_params, result) => goalToolText(result).startsWith("Goal completion rejected:"),
		runningSummary: "checking",
		summarize: (_params, result, state) =>
			state === "success" ? "done" : goalToolText(result).replace(/^Goal completion rejected:\s*/u, "") || state,
	};
}

export function goalBlockedPresentation(): SuiteToolPresentation<GoalBlockedPresentationArguments, GoalBlockedDetails> {
	return {
		activity: {
			categories: ["block-goal"],
			classify: ({ args, state }) => {
				if (state !== "running" && state !== "success") return [];
				const goalId = isRuntimeString(args["goal_id"]) ? args["goal_id"] : "goal";
				const reason = isRuntimeString(args["reason"]) ? args["reason"] : goalId;
				return singleActivity("block-goal", { key: activityKey(goalId), target: reason });
			},
		},
		label: "Goal blocked",
		resultIsError: (_params, result) => goalToolText(result).startsWith("goal_blocked rejected:"),
		runningSummary: "checking",
		summarize: (_params, result, state) =>
			state === "success" ? "blocked" : goalToolText(result).replace(/^goal_blocked rejected:\s*/u, "") || state,
	};
}

export const MAX_COMPLETION_EVIDENCE_TEXT_LENGTH = 4_000;

export const GOAL_COMPLETION_EVIDENCE_INPUT_SCHEMA = Type.Object(
	{ proof: Type.String(), requirement: Type.String() },
	{ additionalProperties: true },
);
