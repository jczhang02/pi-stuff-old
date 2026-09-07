import { isJsonInputObject, parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../../../shared/runtime-type.ts";
import type { ResolvedToolBudget, ToolBudgetConfig, ToolBudgetState } from "../../shared/types.ts";

export const DEFAULT_TOOL_BUDGET_BLOCK = ["read", "grep", "find", "ls"] as const;
export const TOOL_BUDGET_ENV = "PI_SUBAGENT_TOOL_BUDGET";
export const TOOL_BUDGET_ZERO_AUTH_ENV = "PI_SUBAGENT_TOOL_BUDGET_ZERO_AUTH";

export function normalizeToolBudgetBlock(block: ToolBudgetConfig["block"] | undefined): "*" | string[] {
	if (block === "*") return "*";
	if (block === undefined) return [...DEFAULT_TOOL_BUDGET_BLOCK];
	return [...new Set(block.map((tool) => tool.trim()).filter(Boolean))];
}

export function validateToolBudgetConfig<Raw>(raw: Raw, label = "toolBudget", options: { minimumHard?: 0 | 1 } = {}) {
	if (raw === undefined) return {};
	if (!isJsonInputObject(raw)) return { error: `${label} must be an object with hard and optional soft/block.` };
	const hard = raw["hard"];
	const soft = raw["soft"];
	const block = raw["block"];
	const minimumHard = options.minimumHard ?? 1;
	if (!isRuntimeNumber(hard) || !Number.isInteger(hard) || hard < minimumHard) {
		return { error: `${label}.hard must be an integer >= ${minimumHard}.` };
	}
	if (soft !== undefined && (!isRuntimeNumber(soft) || !Number.isInteger(soft) || soft < 1)) {
		return { error: `${label}.soft must be an integer >= 1 when provided.` };
	}
	if (soft !== undefined && soft > hard) {
		return { error: `${label}.soft must be <= ${label}.hard.` };
	}
	if (block !== undefined && block !== "*") {
		if (!Array.isArray(block)) return { error: `${label}.block must be "*" or an array of tool names.` };
		if (block.length === 0) return { error: `${label}.block must contain at least one tool name.` };
		for (const item of block) {
			if (!isRuntimeString(item) || !item.trim())
				return { error: `${label}.block must contain non-empty tool names.` };
		}
	}
	const budget: ResolvedToolBudget = {
		hard,
		block: normalizeToolBudgetBlock(block),
	};
	if (soft !== undefined) budget.soft = soft;
	return { budget };
}

export function initialToolBudgetState(budget: ResolvedToolBudget): ToolBudgetState {
	return { ...budget, toolCount: 0, outcome: "within-budget" };
}

export function toolBudgetState(budget: ResolvedToolBudget, toolCount: number, blockedTool?: string): ToolBudgetState {
	const overHard = blockedTool !== undefined;
	const overSoft = budget.soft !== undefined && toolCount >= budget.soft;
	const state: ToolBudgetState = {
		...budget,
		toolCount,
		outcome: overHard ? "hard-blocked" : overSoft ? "soft-reached" : "within-budget",
	};
	if (overSoft && budget.soft !== undefined) state.softReachedAt = budget.soft;
	if (overHard) {
		state.hardReachedAt = budget.hard;
		if (blockedTool !== undefined) state.blockedTool = blockedTool;
	}
	return state;
}

export function shouldBlockToolForBudget(budget: ResolvedToolBudget, toolName: string, nextToolCount: number): boolean {
	if (nextToolCount <= budget.hard) return false;
	return budget.block === "*" || budget.block.includes(toolName);
}

export function toolBudgetSoftNudge(budget: ResolvedToolBudget, toolCount: number): string {
	return `Tool budget soft limit reached after ${toolCount} tool call${toolCount === 1 ? "" : "s"} (soft ${budget.soft}, hard ${budget.hard}). Stop starting new browsing/search work and finalize from the context you already have.`;
}

export function toolBudgetBlockedMessage(budget: ResolvedToolBudget, toolName: string, toolCount: number): string {
	return `Tool budget hard limit reached after ${toolCount} tool call${toolCount === 1 ? "" : "s"} (hard ${budget.hard}). The '${toolName}' tool is blocked so you can finalize from the context you already have.`;
}

export function encodeToolBudgetEnv(budget: ResolvedToolBudget | undefined): string | undefined {
	return budget ? JSON.stringify(budget) : undefined;
}

export function decodeToolBudgetEnv(
	value: string | undefined,
	options: { allowZero?: boolean } = {},
): ResolvedToolBudget | undefined {
	if (!value?.trim()) return undefined;
	const parsed = parseJsonValue(value);
	const normalized = validateToolBudgetConfig(
		parsed,
		TOOL_BUDGET_ENV,
		options.allowZero ? { minimumHard: 0 } : undefined,
	);
	if (normalized.error) throw new Error(normalized.error);
	return normalized.budget;
}
