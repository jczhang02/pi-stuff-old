import type { JsonValue } from "../../../../shared/json-value.ts";
import {
	isRuntimeBoolean,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
} from "../../../../shared/runtime-type.ts";
import type { NestedRunState, NestedRunSummary, NestedStepSummary, TurnBudgetState } from "../../shared/types.ts";
import { sanitizeProcessTerminal } from "../background/process-terminal.ts";
import {
	decodeSubagentCapabilityCeiling,
	type ResolvedSubagentCapabilityCeiling,
	type SubagentCapabilityAudit,
} from "./capability-ceiling.ts";
import { isSafeNestedPathId, sanitizeNestedPath } from "./nested-path.ts";
import { MAX_BACKGROUND_TASKS } from "./parallel-utils.ts";

export const MAX_STEPS = MAX_BACKGROUND_TASKS;
export const MAX_CHILDREN = 200;
export const MAX_DEPTH = 3;

type RawFields<Owner> = { [Key in keyof Owner]?: JsonValue };
type RawTokenUsage = RawFields<NonNullable<NestedRunSummary["totalTokens"]>>;
type RawCost = RawFields<NonNullable<NestedRunSummary["totalCost"]>>;
type RawTurnBudget = RawFields<TurnBudgetState>;
type RawToolBudget = RawFields<NonNullable<NestedStepSummary["toolBudget"]>>;
type RawCapabilityAudit = RawFields<SubagentCapabilityAudit>;
type RawParallelGroup = RawFields<NonNullable<NestedRunSummary["parallelGroups"]>[number]>;
type RawNestedStep = RawFields<NestedStepSummary>;
type RawNestedSummary = RawFields<NestedRunSummary>;

function clampNumber<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) ? value : undefined;
}

function stringValue<Value>(value: Value, max = 512): string | undefined {
	return isRuntimeString(value) && value.length > 0 ? value.slice(0, max) : undefined;
}

function sanitizeTokenUsage<Value>(value: Value): NestedRunSummary["totalTokens"] | undefined {
	if (!value || !isRuntimeObject(value)) return undefined;
	// SAFETY: the object guard proves this token-usage candidate has inspectable optional raw fields.
	const raw = value as Value & RawTokenUsage;
	const input = clampNumber(raw.input);
	const output = clampNumber(raw.output);
	const total = clampNumber(raw.total);
	return input !== undefined && output !== undefined && total !== undefined ? { input, output, total } : undefined;
}

export function sanitizeCost<Value>(value: Value): NestedRunSummary["totalCost"] | undefined {
	if (!value || !isRuntimeObject(value)) return undefined;
	// SAFETY: the object guard proves this cost candidate has inspectable optional raw fields.
	const raw = value as Value & RawCost;
	const inputTokens = clampNumber(raw.inputTokens);
	const outputTokens = clampNumber(raw.outputTokens);
	const costUsd = clampNumber(raw.costUsd);
	return inputTokens !== undefined && outputTokens !== undefined && costUsd !== undefined
		? { inputTokens, outputTokens, costUsd }
		: undefined;
}

export function sanitizeTurnBudget<Value>(value: Value): TurnBudgetState | undefined {
	if (!value || !isRuntimeObject(value)) return undefined;
	// SAFETY: the object guard proves this turn-budget candidate has inspectable optional raw fields.
	const raw = value as Value & RawTurnBudget;
	const maxTurns = clampNumber(raw.maxTurns);
	const graceTurns = clampNumber(raw.graceTurns);
	const turnCount = clampNumber(raw.turnCount);
	const outcome =
		raw.outcome === "within-budget" ||
		raw.outcome === "wrap-up-requested" ||
		raw.outcome === "termination-deferred" ||
		raw.outcome === "exceeded"
			? raw.outcome
			: undefined;
	if (maxTurns === undefined || graceTurns === undefined || turnCount === undefined || !outcome) return undefined;
	const budget: TurnBudgetState = { maxTurns, graceTurns, turnCount, outcome };
	const wrapUpRequestedAtTurn = clampNumber(raw.wrapUpRequestedAtTurn);
	const terminationDeferredAtTurn = clampNumber(raw.terminationDeferredAtTurn);
	const exceededAtTurn = clampNumber(raw.exceededAtTurn);
	if (wrapUpRequestedAtTurn !== undefined) budget.wrapUpRequestedAtTurn = wrapUpRequestedAtTurn;
	if (terminationDeferredAtTurn !== undefined) budget.terminationDeferredAtTurn = terminationDeferredAtTurn;
	if (exceededAtTurn !== undefined) budget.exceededAtTurn = exceededAtTurn;
	return budget;
}

export function sanitizeToolBudget<Value>(value: Value): NestedStepSummary["toolBudget"] | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	// SAFETY: the non-array object guard proves this tool-budget candidate has inspectable optional raw fields.
	const raw = value as Value & RawToolBudget;
	const hard = clampNumber(raw.hard);
	const toolCount = clampNumber(raw.toolCount);
	const outcome =
		raw.outcome === "within-budget" || raw.outcome === "soft-reached" || raw.outcome === "hard-blocked"
			? raw.outcome
			: undefined;
	const block =
		raw.block === "*"
			? "*"
			: Array.isArray(raw.block)
				? raw.block
						.map((entry) => stringValue(entry, 128))
						.filter((entry): entry is string => Boolean(entry))
						.slice(0, 256)
				: undefined;
	if (
		hard === undefined ||
		!Number.isInteger(hard) ||
		hard < 0 ||
		toolCount === undefined ||
		!Number.isInteger(toolCount) ||
		toolCount < 0 ||
		!outcome ||
		block === undefined
	) {
		return undefined;
	}
	const soft = clampNumber(raw.soft);
	const budget: NonNullable<NestedStepSummary["toolBudget"]> = { hard, block, outcome, toolCount };
	const softReachedAt = clampNumber(raw.softReachedAt);
	const hardReachedAt = clampNumber(raw.hardReachedAt);
	const blockedTool = stringValue(raw.blockedTool, 128);
	if (soft !== undefined && Number.isInteger(soft) && soft >= 0) budget.soft = soft;
	if (softReachedAt !== undefined) budget.softReachedAt = softReachedAt;
	if (hardReachedAt !== undefined) budget.hardReachedAt = hardReachedAt;
	if (blockedTool) budget.blockedTool = blockedTool;
	return budget;
}

function sanitizeCapabilityCeiling<Value>(value: Value): ResolvedSubagentCapabilityCeiling | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	try {
		return decodeSubagentCapabilityCeiling(Buffer.from(JSON.stringify(value), "utf8").toString("base64url"));
	} catch {
		return undefined;
	}
}

function sanitizeStringList<Value>(value: Value): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value
		.map((entry) => stringValue(entry, 128))
		.filter((entry): entry is string => Boolean(entry))
		.slice(0, 256);
}

function sanitizeCapabilityAudit<Value>(value: Value): SubagentCapabilityAudit | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	// SAFETY: the non-array object guard proves this audit candidate has inspectable optional raw fields.
	const raw = value as Value & RawCapabilityAudit;
	const ceiling = sanitizeCapabilityCeiling(raw.ceiling);
	const effectiveTools = sanitizeStringList(raw.effectiveTools);
	const removedTools = sanitizeStringList(raw.removedTools);
	const internalTools = sanitizeStringList(raw.internalTools);
	const effectiveMcpTools = sanitizeStringList(raw.effectiveMcpTools);
	const removedExtensionCount = clampNumber(raw.removedExtensionCount);
	const requestedMcpToolCount = clampNumber(raw.requestedMcpToolCount);
	if (
		!ceiling ||
		!effectiveTools ||
		!removedTools ||
		!internalTools ||
		!effectiveMcpTools ||
		!isRuntimeBoolean(raw.extensionsDenied) ||
		removedExtensionCount === undefined ||
		!Number.isInteger(removedExtensionCount) ||
		removedExtensionCount < 0 ||
		requestedMcpToolCount === undefined ||
		!Number.isInteger(requestedMcpToolCount) ||
		requestedMcpToolCount < 0
	) {
		return undefined;
	}
	const requestedTools = sanitizeStringList(raw.requestedTools);
	const audit: SubagentCapabilityAudit = {
		ceiling,
		effectiveTools,
		removedTools,
		internalTools,
		extensionsDenied: raw.extensionsDenied,
		removedExtensionCount,
		requestedMcpToolCount,
		effectiveMcpTools,
	};
	if (requestedTools) audit.requestedTools = requestedTools;
	return audit;
}

function sanitizeState<Value>(value: Value, fallback: NestedRunState): NestedRunState {
	if (!isRuntimeString(value)) return fallback;
	switch (value) {
		case "queued":
			return "queued";
		case "running":
			return "running";
		case "complete":
			return "complete";
		case "failed":
			return "failed";
		case "paused":
			return "paused";
		case "stopped":
			return "stopped";
		default:
			return fallback;
	}
}

function sanitizeParallelGroups<Value>(value: Value): NestedRunSummary["parallelGroups"] | undefined {
	if (!Array.isArray(value)) return undefined;
	return value
		.map((entry) => {
			if (!entry || !isRuntimeObject(entry) || Array.isArray(entry)) return undefined;
			// SAFETY: the non-array object guard proves this parallel-group candidate has inspectable optional raw fields.
			const raw = entry as RawParallelGroup;
			const start = clampNumber(raw.start);
			const count = clampNumber(raw.count);
			const stepIndex = clampNumber(raw.stepIndex);
			return start !== undefined &&
				count !== undefined &&
				stepIndex !== undefined &&
				[start, count, stepIndex].every((number) => Number.isInteger(number) && number >= 0)
				? { start, count, stepIndex }
				: undefined;
		})
		.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
		.slice(0, MAX_STEPS);
}

function sanitizeStep<Value>(input: Value, depth: number): NestedStepSummary | undefined {
	if (!input || !isRuntimeObject(input)) return undefined;
	// SAFETY: the object guard proves this nested-step candidate has inspectable optional raw fields.
	const raw = input as Value & RawNestedStep;
	const agent = stringValue(raw.agent, 128);
	if (!agent) return undefined;
	const status =
		raw.status === "pending" ||
		raw.status === "running" ||
		raw.status === "complete" ||
		raw.status === "completed" ||
		raw.status === "failed" ||
		raw.status === "paused" ||
		raw.status === "stopped"
			? raw.status
			: "pending";
	const processTerminal = sanitizeProcessTerminal(raw.processTerminal, {}, "nested step");
	const capabilityCeiling = sanitizeCapabilityCeiling(raw.capabilityCeiling);
	const capabilityAudit = sanitizeCapabilityAudit(raw.capabilityAudit);
	const toolBudget = sanitizeToolBudget(raw.toolBudget);
	const step: Partial<NestedStepSummary> = { agent };
	const delegatedTask = stringValue(raw.delegatedTask, 500);
	const task = stringValue(raw.task, 500);
	const description = stringValue(raw.description, 500);
	const sessionFile = stringValue(raw.sessionFile, 2048);
	const transcriptPath = stringValue(raw.transcriptPath, 2048);
	const transcriptError = stringValue(raw.transcriptError, 1024);
	const lastActivityAt = clampNumber(raw.lastActivityAt);
	const currentTool = stringValue(raw.currentTool, 128);
	const currentToolStartedAt = clampNumber(raw.currentToolStartedAt);
	const currentPath = stringValue(raw.currentPath, 2048);
	const turnCount = clampNumber(raw.turnCount);
	const toolCount = clampNumber(raw.toolCount);
	const startedAt = clampNumber(raw.startedAt);
	const endedAt = clampNumber(raw.endedAt);
	const error = stringValue(raw.error, 1024);
	const turnBudget = sanitizeTurnBudget(raw.turnBudget);
	if (delegatedTask) step.delegatedTask = delegatedTask;
	if (task) step.task = task;
	if (description) step.description = description;
	if (raw.agentStatus === "crashed") step.agentStatus = "crashed";
	step.status = status;
	if (sessionFile) step.sessionFile = sessionFile;
	if (transcriptPath) step.transcriptPath = transcriptPath;
	if (transcriptError) step.transcriptError = transcriptError;
	if (raw.activityState === "active_long_running" || raw.activityState === "needs_attention") {
		step.activityState = raw.activityState;
	}
	if (lastActivityAt !== undefined) step.lastActivityAt = lastActivityAt;
	if (currentTool) step.currentTool = currentTool;
	if (currentToolStartedAt !== undefined) step.currentToolStartedAt = currentToolStartedAt;
	if (currentPath) step.currentPath = currentPath;
	if (turnCount !== undefined) step.turnCount = turnCount;
	if (toolCount !== undefined) step.toolCount = toolCount;
	if (startedAt !== undefined) step.startedAt = startedAt;
	if (endedAt !== undefined) step.endedAt = endedAt;
	if (error) step.error = error;
	if (raw.timedOut === true) step.timedOut = true;
	if (raw.stopped === true) step.stopped = true;
	if (turnBudget) step.turnBudget = turnBudget;
	if (raw.turnBudgetExceeded === true) step.turnBudgetExceeded = true;
	if (raw.wrapUpRequested === true) step.wrapUpRequested = true;
	if (toolBudget) step.toolBudget = toolBudget;
	if (raw.toolBudgetBlocked === true) step.toolBudgetBlocked = true;
	if (processTerminal) step.processTerminal = processTerminal;
	if (capabilityCeiling) step.capabilityCeiling = capabilityCeiling;
	if (capabilityAudit) step.capabilityAudit = capabilityAudit;
	if (depth < MAX_DEPTH && Array.isArray(raw.children)) {
		step.children = raw.children
			.map((child) => sanitizeSummary(child, depth + 1))
			.filter((child): child is NestedRunSummary => Boolean(child))
			.slice(0, MAX_CHILDREN);
	}
	// SAFETY: agent and status are assigned before every return; all optional fields are individually validated.
	return step as NestedStepSummary;
}

export function sanitizeSummary<Value>(input: Value, depth = 0): NestedRunSummary | undefined {
	if (!input || !isRuntimeObject(input)) return undefined;
	// SAFETY: the object guard proves this nested-summary candidate has inspectable optional raw fields.
	const raw = input as Value & RawNestedSummary;
	if (!isSafeNestedPathId(raw.id) || !isSafeNestedPathId(raw.parentRunId)) return undefined;
	const pathParts = sanitizeNestedPath(raw.path);
	const steps = Array.isArray(raw.steps)
		? raw.steps
				.map((step) => sanitizeStep(step, depth + 1))
				.filter((step): step is NestedStepSummary => Boolean(step))
				.slice(0, MAX_STEPS)
		: undefined;
	const totalTokens = sanitizeTokenUsage(raw.totalTokens);
	const totalCost = sanitizeCost(raw.totalCost);
	const pid = clampNumber(raw.pid);
	const processTerminal = sanitizeProcessTerminal(raw.processTerminal, {}, "nested run");
	const capabilityCeiling = sanitizeCapabilityCeiling(raw.capabilityCeiling);
	const capabilityAudit = sanitizeCapabilityAudit(raw.capabilityAudit);
	const parallelGroups = sanitizeParallelGroups(raw.parallelGroups);
	const toolBudget = sanitizeToolBudget(raw.toolBudget);
	const summary: Partial<NestedRunSummary> = { id: raw.id };
	const parentStepIndex = clampNumber(raw.parentStepIndex);
	const parentAgent = stringValue(raw.parentAgent, 128);
	const asyncDir = stringValue(raw.asyncDir, 2048);
	const sessionId = stringValue(raw.sessionId, 256);
	const sessionFile = stringValue(raw.sessionFile, 2048);
	const intercomTarget = stringValue(raw.intercomTarget, 256);
	const ownerIntercomTarget = stringValue(raw.ownerIntercomTarget, 256);
	const leafIntercomTarget = stringValue(raw.leafIntercomTarget, 256);
	const controlInbox = stringValue(raw.controlInbox, 2048);
	const capabilityToken = stringValue(raw.capabilityToken, 128);
	const agent = stringValue(raw.agent, 128);
	const currentStep = clampNumber(raw.currentStep);
	const lastActivityAt = clampNumber(raw.lastActivityAt);
	const currentTool = stringValue(raw.currentTool, 128);
	const currentToolStartedAt = clampNumber(raw.currentToolStartedAt);
	const currentPath = stringValue(raw.currentPath, 2048);
	const turnCount = clampNumber(raw.turnCount);
	const toolCount = clampNumber(raw.toolCount);
	const startedAt = clampNumber(raw.startedAt);
	const endedAt = clampNumber(raw.endedAt);
	const lastUpdate = clampNumber(raw.lastUpdate);
	const timeoutMs = clampNumber(raw.timeoutMs);
	const deadlineAt = clampNumber(raw.deadlineAt);
	const turnBudget = sanitizeTurnBudget(raw.turnBudget);
	const error = stringValue(raw.error, 1024);
	if (raw.agentStatus === "crashed") summary.agentStatus = "crashed";
	if (raw.parentRunOrigin === "automatic" || raw.parentRunOrigin === "user") {
		summary.parentRunOrigin = raw.parentRunOrigin;
	}
	summary.parentRunId = raw.parentRunId;
	if (parentStepIndex !== undefined) summary.parentStepIndex = parentStepIndex;
	if (parentAgent) summary.parentAgent = parentAgent;
	summary.depth = Math.min(Math.max(0, clampNumber(raw.depth) ?? 0), MAX_DEPTH);
	summary.path = pathParts;
	summary.state = sanitizeState(raw.state, "running");
	if (asyncDir) summary.asyncDir = asyncDir;
	if (pid !== undefined && pid > 0 && Number.isInteger(pid)) summary.pid = pid;
	if (sessionId) summary.sessionId = sessionId;
	if (sessionFile) summary.sessionFile = sessionFile;
	if (intercomTarget) summary.intercomTarget = intercomTarget;
	if (ownerIntercomTarget) summary.ownerIntercomTarget = ownerIntercomTarget;
	if (leafIntercomTarget) summary.leafIntercomTarget = leafIntercomTarget;
	if (raw.ownerState === "live" || raw.ownerState === "gone" || raw.ownerState === "unknown") {
		summary.ownerState = raw.ownerState;
	}
	if (controlInbox) summary.controlInbox = controlInbox;
	if (capabilityToken) summary.capabilityToken = capabilityToken;
	if (raw.mode === "single" || raw.mode === "parallel") summary.mode = raw.mode;
	if (agent) summary.agent = agent;
	if (Array.isArray(raw.agents)) {
		summary.agents = raw.agents
			.map((candidate) => stringValue(candidate, 128))
			.filter((candidate): candidate is string => Boolean(candidate))
			.slice(0, MAX_STEPS);
	}
	if (currentStep !== undefined) summary.currentStep = currentStep;
	if (parallelGroups?.length) summary.parallelGroups = parallelGroups;
	if (raw.activityState === "active_long_running" || raw.activityState === "needs_attention") {
		summary.activityState = raw.activityState;
	}
	if (lastActivityAt !== undefined) summary.lastActivityAt = lastActivityAt;
	if (currentTool) summary.currentTool = currentTool;
	if (currentToolStartedAt !== undefined) summary.currentToolStartedAt = currentToolStartedAt;
	if (currentPath) summary.currentPath = currentPath;
	if (turnCount !== undefined) summary.turnCount = turnCount;
	if (toolCount !== undefined) summary.toolCount = toolCount;
	if (totalTokens) summary.totalTokens = totalTokens;
	if (totalCost) summary.totalCost = totalCost;
	if (startedAt !== undefined) summary.startedAt = startedAt;
	if (endedAt !== undefined) summary.endedAt = endedAt;
	if (lastUpdate !== undefined) summary.lastUpdate = lastUpdate;
	if (timeoutMs !== undefined) summary.timeoutMs = timeoutMs;
	if (deadlineAt !== undefined) summary.deadlineAt = deadlineAt;
	if (raw.timedOut === true) summary.timedOut = true;
	if (raw.stopped === true) summary.stopped = true;
	if (turnBudget) summary.turnBudget = turnBudget;
	if (raw.turnBudgetExceeded === true) summary.turnBudgetExceeded = true;
	if (raw.wrapUpRequested === true) summary.wrapUpRequested = true;
	if (toolBudget) summary.toolBudget = toolBudget;
	if (raw.toolBudgetBlocked === true) summary.toolBudgetBlocked = true;
	if (processTerminal) summary.processTerminal = processTerminal;
	if (capabilityCeiling) summary.capabilityCeiling = capabilityCeiling;
	if (capabilityAudit) summary.capabilityAudit = capabilityAudit;
	if (error) summary.error = error;
	if (steps && steps.length > 0) summary.steps = steps;
	if (depth < MAX_DEPTH && Array.isArray(raw.children)) {
		summary.children = raw.children
			.map((child) => sanitizeSummary(child, depth + 1))
			.filter((child): child is NestedRunSummary => Boolean(child))
			.slice(0, MAX_CHILDREN);
	}
	// SAFETY: all required NestedRunSummary fields are assigned after id and parentRunId pass safe-id validation.
	return summary as NestedRunSummary;
}
