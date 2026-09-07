import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRuntimeBoolean, isRuntimeFunction, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.js";

const GOAL_COORDINATION_QUERY_EVENT = "@jczhang02/pi-stuff-goal/coordination-query/v1";

export interface GoalCoordinationSnapshot {
	readonly goalId: string | undefined;
	readonly continuationPermitted: boolean;
	readonly pendingResultDelivery: boolean;
}

interface GoalCoordinationQuery {
	goalId: string | undefined;
	continuationPermitted: boolean;
	pendingResultDelivery: boolean;
}

/** Register one Goal-owned answer and leave the delivery field to Agents. */
export function listenForGoalCoordinationQueries(
	pi: Pick<ExtensionAPI, "events">,
	readGoal: () => Pick<GoalCoordinationSnapshot, "goalId" | "continuationPermitted">,
): () => void {
	const unsubscribe = pi.events.on(GOAL_COORDINATION_QUERY_EVENT, (value) => {
		if (!isRuntimeObject(value) || value === null || !("goalId" in value) || !("continuationPermitted" in value))
			return;
		const goal = readGoal();
		value.goalId = goal.goalId;
		value.continuationPermitted = goal.continuationPermitted;
	});
	return isRuntimeFunction(unsubscribe) ? unsubscribe : () => {};
}

/** Register Agents' current bounded-result delivery state for Goal's idle gate. */
export function listenForPendingGoalResultQueries(
	pi: Pick<ExtensionAPI, "events">,
	readPending: () => boolean,
): () => void {
	const unsubscribe = pi.events.on(GOAL_COORDINATION_QUERY_EVENT, (value) => {
		if (!isRuntimeObject(value) || value === null || !("pendingResultDelivery" in value)) return;
		value.pendingResultDelivery = readPending();
	});
	return isRuntimeFunction(unsubscribe) ? unsubscribe : () => {};
}

/** Read Goal identity/permission and Agents' pending delivery state synchronously. */
export function readGoalCoordination(pi: { readonly events?: ExtensionAPI["events"] }): GoalCoordinationSnapshot {
	const query: GoalCoordinationQuery = {
		goalId: undefined,
		continuationPermitted: false,
		pendingResultDelivery: false,
	};
	try {
		pi.events?.emit(GOAL_COORDINATION_QUERY_EVENT, query);
	} catch {
		return { goalId: undefined, continuationPermitted: false, pendingResultDelivery: true };
	}
	return {
		goalId: isRuntimeString(query.goalId) ? query.goalId : undefined,
		continuationPermitted: isRuntimeBoolean(query.continuationPermitted) && query.continuationPermitted,
		pendingResultDelivery: isRuntimeBoolean(query.pendingResultDelivery) && query.pendingResultDelivery,
	};
}
