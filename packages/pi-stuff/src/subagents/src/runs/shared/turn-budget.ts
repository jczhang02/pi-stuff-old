import { isRuntimeNumber, isRuntimeObject } from "../../../../shared/runtime-type.ts";

export const DEFAULT_TURN_BUDGET_GRACE_TURNS = 1;

/** Decode legacy recovery descriptors and persisted results. New launches do not accept turn budgets. */
export function resolveTurnBudgetConfig<Value>(raw: Value, label = "turnBudget") {
	if (raw === undefined) return {};
	if (!raw || !isRuntimeObject(raw) || Array.isArray(raw)) {
		return { error: `${label} must be an object with maxTurns and optional graceTurns.` };
	}
	const unknownField = Object.keys(raw).find((key) => key !== "maxTurns" && key !== "graceTurns");
	if (unknownField) return { error: `${label}.${unknownField} is not supported.` };
	if (!("maxTurns" in raw) || !isRuntimeNumber(raw.maxTurns) || !Number.isInteger(raw.maxTurns) || raw.maxTurns < 1) {
		return { error: `${label}.maxTurns must be an integer >= 1.` };
	}
	const graceTurns =
		"graceTurns" in raw ? (raw.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS) : DEFAULT_TURN_BUDGET_GRACE_TURNS;
	if (!isRuntimeNumber(graceTurns) || !Number.isInteger(graceTurns) || graceTurns < 0) {
		return { error: `${label}.graceTurns must be an integer >= 0.` };
	}
	return { turnBudget: { maxTurns: raw.maxTurns, graceTurns } };
}
