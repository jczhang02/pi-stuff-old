import { type Static, type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import { type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import { isFiniteRuntimeNumber as isFiniteNumber } from "../../../../shared/runtime-type.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import { readBoundedOwnedFile } from "../../shared/private-directory.ts";
import type { AsyncStatus, NestedRunSummary } from "../../shared/types.ts";
import { getErrorMessage, isNotFoundError } from "../../shared/utils.ts";
import {
	parseSubagentCapabilityCeiling,
	type ResolvedSubagentCapabilityCeiling,
} from "../shared/capability-ceiling.ts";
import { attachRootChildrenToSteps, nestedWorkIncludesUser } from "../shared/nested-events.ts";
import { sanitizeCost, sanitizeSummary, sanitizeToolBudget, sanitizeTurnBudget } from "../shared/nested-summary.ts";
import type { BackgroundTaskResult } from "../shared/parallel-utils.ts";
import type { CompletionNotification } from "./notify.ts";
import type { BackgroundCompletion } from "./runner-state.ts";

export const MAX_ASYNC_RESULT_BYTES = 32 * 1024 * 1024;

export interface AsyncResultChild extends Partial<BackgroundTaskResult> {
	state?: string;
	children?: NestedRunSummary[];
}

export type AsyncResultFile = Partial<Omit<BackgroundCompletion, "mode" | "results" | "sessionId" | "state">> & {
	agent?: string;
	mode?: string;
	state?: string;
	sessionId?: string;
	model?: string;
	thinking?: string;
	launchContractDigest?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	exitCode?: number | null;
	results?: AsyncResultChild[];
};

export type ResultFileChild = Partial<BackgroundTaskResult> & {
	state?: string;
	children?: JsonValue;
};

export type ResultFileData = CompletionNotification & {
	runId?: string;
	mode?: string;
	results?: ResultFileChild[];
	nestedChildren?: JsonValue;
	asyncDir?: string;
	intercomTarget?: string;
};

const MODEL_USAGE_SCHEMA = Type.Object(
	{
		input: Type.Number(),
		output: Type.Number(),
		cacheRead: Type.Number(),
		cacheWrite: Type.Number(),
		cost: Type.Number(),
		turns: Type.Number(),
	},
	{ additionalProperties: false },
);
const JSON_VALUE_SCHEMA = Type.Unsafe<JsonValue>({});
const MODEL_ATTEMPT_SCHEMA = Type.Object(
	{
		model: Type.String(),
		success: Type.Boolean(),
		exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
		error: Type.Optional(Type.String()),
		usage: Type.Optional(MODEL_USAGE_SCHEMA),
		costReported: Type.Optional(Type.Literal(true)),
	},
	{ additionalProperties: false },
);
const CUMULATIVE_USAGE_SCHEMA = Type.Object(
	{
		turns: Type.Integer({ minimum: 0 }),
		toolCalls: Type.Integer({ minimum: 0 }),
		inputTokens: Type.Integer({ minimum: 0 }),
		outputTokens: Type.Integer({ minimum: 0 }),
		reportedCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
		modelAttempts: Type.Integer({ minimum: 0 }),
		resumes: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
const TERMINAL_OUTCOME_SCHEMA = Type.Object(
	{
		state: Type.Union([Type.Literal("completed"), Type.Literal("incomplete"), Type.Literal("failed")]),
		class: Type.Union([
			Type.Literal("completed"),
			Type.Literal("timeout"),
			Type.Literal("stopped"),
			Type.Literal("interrupted"),
			Type.Literal("provider"),
			Type.Literal("context"),
			Type.Literal("storage"),
			Type.Literal("protocol"),
			Type.Literal("explicit_budget"),
			Type.Literal("cost_guard"),
			Type.Literal("process"),
			Type.Literal("unknown"),
		]),
		reason: Type.String(),
		continuation: Type.Object(
			{
				target: Type.Object(
					{ id: Type.String(), index: Type.Integer({ minimum: 0 }) },
					{ additionalProperties: false },
				),
				resumeSupported: Type.Boolean(),
				acknowledgementRequired: Type.Optional(Type.Literal(true)),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);
const RESULT_CHILD_SCHEMA = Type.Object(
	{
		agent: Type.Optional(Type.String()),
		state: Type.Optional(Type.String()),
		error: Type.Optional(Type.String()),
		sessionFile: Type.Optional(Type.String()),
		intercomTarget: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.String()),
		transcriptPath: Type.Optional(Type.String()),
		transcriptError: Type.Optional(Type.String()),
		launchContractDigest: Type.Optional(Type.String()),
		success: Type.Optional(Type.Boolean()),
		interrupted: Type.Optional(Type.Boolean()),
		stopped: Type.Optional(Type.Boolean()),
		timedOut: Type.Optional(Type.Boolean()),
		turnBudgetExceeded: Type.Optional(Type.Boolean()),
		wrapUpRequested: Type.Optional(Type.Boolean()),
		toolBudgetBlocked: Type.Optional(Type.Boolean()),
		exitCode: Type.Optional(Type.Union([Type.Number(), Type.Null()])),
		attemptedModels: Type.Optional(Type.Array(Type.String())),
		modelAttempts: Type.Optional(Type.Array(MODEL_ATTEMPT_SCHEMA)),
		cumulativeUsage: Type.Optional(CUMULATIVE_USAGE_SCHEMA),
		terminalOutcome: Type.Optional(TERMINAL_OUTCOME_SCHEMA),
		turnBudget: Type.Optional(Type.Unknown()),
		toolBudget: Type.Optional(Type.Unknown()),
		totalCost: Type.Optional(Type.Unknown()),
		capabilityCeiling: Type.Optional(Type.Unknown()),
		children: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);
const ASYNC_RESULT_SCHEMA = Type.Object(
	{
		id: Type.Optional(Type.String()),
		runId: Type.Optional(Type.String()),
		agent: Type.Optional(Type.String()),
		mode: Type.Optional(Type.String()),
		state: Type.Optional(Type.String()),
		cwd: Type.Optional(Type.String()),
		sessionId: Type.Optional(Type.String()),
		sessionFile: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
		thinking: Type.Optional(Type.String()),
		launchContractDigest: Type.Optional(Type.String()),
		success: Type.Optional(Type.Boolean()),
		capabilityCeiling: Type.Optional(Type.Unknown()),
		parentRunOrigin: Type.Optional(Type.Unknown()),
		startedAt: Type.Optional(Type.Unknown()),
		endedAt: Type.Optional(Type.Unknown()),
		exitCode: Type.Optional(Type.Unknown()),
		timedOut: Type.Optional(Type.Unknown()),
		results: Type.Optional(Type.Array(JSON_VALUE_SCHEMA)),
		nestedChildren: Type.Optional(Type.Unknown()),
	},
	{ additionalProperties: false },
);

export const COMPLETION_FIELDS = [
	"source",
	"parentRunOrigin",
	"agent",
	"success",
	"summary",
	"exitCode",
	"state",
	"timestamp",
	"durationMs",
	"cwd",
	"sessionFile",
	"taskIndex",
	"totalTasks",
	"sessionId",
	"stopped",
	"timedOut",
	"interrupted",
	"startedAt",
	"endedAt",
	"asyncDir",
	"worktree",
	"launchContractDigest",
	"capabilityCeiling",
] as const;

export const RESULT_CHILD_FIELDS = [
	"context",
	"output",
	"success",
	"exitCode",
	"error",
	"interrupted",
	"timedOut",
	"stopped",
	"turnBudget",
	"turnBudgetExceeded",
	"wrapUpRequested",
	"toolBudget",
	"toolBudgetBlocked",
	"sessionFile",
	"intercomTarget",
	"model",
	"thinking",
	"attemptedModels",
	"modelAttempts",
	"cumulativeUsage",
	"terminalOutcome",
	"totalCost",
	"artifactPaths",
	"transcriptPath",
	"transcriptError",
	"launchContractDigest",
	"capabilityCeiling",
	"capabilityAudit",
	"writerProcesses",
	"writerAttemptCount",
] as const;

export function sanitizeNestedResultChildren(
	value: JsonValue | undefined,
	resultPath: string,
	label: string,
): NestedRunSummary[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		reportAgentDiagnostic(
			`Ignoring invalid nested children in subagent result file '${resultPath}' at ${label}: expected an array.`,
		);
		return undefined;
	}
	const children = value
		.map((child) => sanitizeSummary(child))
		.filter((child): child is NestedRunSummary => Boolean(child));
	if (children.length !== value.length) {
		reportAgentDiagnostic(
			`Ignoring ${value.length - children.length} invalid nested child record(s) in subagent result file '${resultPath}' at ${label}.`,
		);
	}
	return children.length ? children : undefined;
}

function invalidResult(resultPath: string, message: string): Error {
	return new Error(`Invalid async result file '${resultPath}': ${message}.`);
}

function cleanResult<Schema extends TSchema>(
	schema: Schema,
	value: JsonValue,
	resultPath: string,
	field = "",
): Static<Schema> {
	const cleaned = Value.Clean(schema, structuredClone(value));
	if (Value.Check(schema, cleaned)) return cleaned;
	const error = Value.Errors(schema, cleaned)[0];
	if (!error) throw invalidResult(resultPath, "result did not match its schema");
	const nested = error.instancePath.slice(1).replaceAll("/", ".");
	const location = [field, nested].filter(Boolean).join(".") || "result";
	throw invalidResult(resultPath, `${location} ${error.message}`);
}

function parseResultChild(value: JsonValue, resultPath: string, index: number): AsyncResultChild {
	const parsed = cleanResult(RESULT_CHILD_SCHEMA, value, resultPath, `results[${index}]`);
	const {
		turnBudget: rawTurnBudget,
		toolBudget: rawToolBudget,
		totalCost: rawTotalCost,
		capabilityCeiling: rawCapabilityCeiling,
		children: rawChildren,
		...plain
	} = parsed;
	const child: AsyncResultChild = plain;
	const turnBudget = sanitizeTurnBudget(rawTurnBudget);
	if (rawTurnBudget !== undefined && !turnBudget) {
		throw invalidResult(resultPath, `results[${index}].turnBudget is malformed`);
	}
	if (turnBudget) child.turnBudget = turnBudget;
	const toolBudget = sanitizeToolBudget(rawToolBudget);
	if (rawToolBudget !== undefined && !toolBudget) {
		throw invalidResult(resultPath, `results[${index}].toolBudget is malformed`);
	}
	if (toolBudget) child.toolBudget = toolBudget;
	const totalCost = sanitizeCost(rawTotalCost);
	if (rawTotalCost !== undefined && !totalCost) {
		throw invalidResult(resultPath, `results[${index}].totalCost is malformed`);
	}
	if (totalCost) child.totalCost = totalCost;
	if (rawCapabilityCeiling !== undefined) {
		child.capabilityCeiling = parseSubagentCapabilityCeiling(
			rawCapabilityCeiling,
			`async result file '${resultPath}' results[${index}].capabilityCeiling`,
		);
	}
	if (Array.isArray(rawChildren)) {
		const children = rawChildren.map(sanitizeSummary).filter((entry): entry is NestedRunSummary => Boolean(entry));
		if (children.length) child.children = children;
	}
	return child;
}

export function parseAsyncResultFile(value: JsonValue, resultPath: string): AsyncResultFile {
	const parsed = cleanResult(ASYNC_RESULT_SCHEMA, value, resultPath);
	const {
		capabilityCeiling: rawCapabilityCeiling,
		parentRunOrigin,
		startedAt,
		endedAt,
		exitCode,
		timedOut,
		results,
		nestedChildren,
		...plain
	} = parsed;
	const result: AsyncResultFile = plain;
	if (rawCapabilityCeiling !== undefined) {
		result.capabilityCeiling = parseSubagentCapabilityCeiling(
			rawCapabilityCeiling,
			`async result file '${resultPath}' capabilityCeiling`,
		);
	}
	if (parentRunOrigin === "automatic" || parentRunOrigin === "user") {
		result.parentRunOrigin = parentRunOrigin;
	}
	if (isFiniteNumber(startedAt) && startedAt >= 0) result.startedAt = startedAt;
	if (isFiniteNumber(endedAt) && endedAt >= 0) result.endedAt = endedAt;
	if (exitCode === null || isFiniteNumber(exitCode)) result.exitCode = exitCode;
	if (timedOut === true) result.timedOut = true;
	if (results) result.results = results.map((entry, index) => parseResultChild(entry, resultPath, index));
	if (Array.isArray(nestedChildren)) {
		result.nestedChildren = nestedChildren
			.map(sanitizeSummary)
			.filter((entry): entry is NestedRunSummary => Boolean(entry));
	}
	return result;
}

type ResultRepairData = Pick<BackgroundCompletion, "state"> &
	Partial<
		Pick<BackgroundCompletion, "parentRunOrigin" | "startedAt" | "endedAt" | "timedOut" | "nestedChildren"> & {
			results: AsyncResultChild[];
		}
	>;

function readResultRepairData(
	resultPath: string,
	expectedRunId: string,
	resultContent?: string,
): ResultRepairData | undefined {
	try {
		const data = parseAsyncResultFile(
			parseJsonValue(resultContent ?? readBoundedOwnedFile(resultPath, MAX_ASYNC_RESULT_BYTES)),
			resultPath,
		);
		if (
			(data.id !== undefined && data.id !== expectedRunId) ||
			(data.runId !== undefined && data.runId !== expectedRunId)
		) {
			throw new Error(`Async result file '${resultPath}' does not match run '${expectedRunId}'.`);
		}
		const state = data.success
			? "complete"
			: data.state === "stopped"
				? "stopped"
				: data.state === "paused" || data.exitCode === 0
					? "paused"
					: "failed";
		const repair: ResultRepairData = { state };
		if (data.parentRunOrigin) repair.parentRunOrigin = data.parentRunOrigin;
		if (data.startedAt !== undefined) repair.startedAt = data.startedAt;
		if (data.endedAt !== undefined) repair.endedAt = data.endedAt;
		if (data.timedOut === true || data.results?.some((child) => child.timedOut === true)) repair.timedOut = true;
		if (data.results) repair.results = data.results;
		if (data.nestedChildren) repair.nestedChildren = data.nestedChildren;
		return repair;
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function childState(
	overallState: ResultRepairData["state"],
	child: AsyncResultChild | undefined,
): "complete" | "failed" | "paused" | "stopped" {
	if (child?.stopped === true) return "stopped";
	if (child?.interrupted === true) return "paused";
	if (child?.success === true) return "complete";
	if (child?.success === false) return "failed";
	return overallState;
}

export function terminalStatusFromResult(
	status: AsyncStatus,
	resultPath: string,
	runId: string,
	now: number,
	resultContent?: string,
): AsyncStatus | undefined {
	const repair = readResultRepairData(resultPath, runId, resultContent);
	if (!repair) return undefined;
	const endedAt = repair.endedAt ?? now;
	const steps = (status.steps ?? []).map((step, index) => {
		if (step.status !== "running" && step.status !== "pending") return step;
		const child = repair.results?.[index];
		const state = childState(repair.state, child);
		const model = child?.model ?? step.model;
		const thinking = resolveEffectiveThinking(model, child?.thinking ?? step.thinking);
		return {
			...step,
			status: state === "complete" ? ("complete" as const) : state,
			endedAt: step.endedAt ?? endedAt,
			durationMs:
				step.startedAt !== undefined && step.durationMs === undefined
					? Math.max(0, endedAt - step.startedAt)
					: step.durationMs,
			exitCode: child?.exitCode ?? step.exitCode ?? (state === "complete" ? 0 : 1),
			error: child?.error ?? step.error,
			stopped: state === "stopped" ? true : undefined,
			timedOut: child?.timedOut === true ? true : undefined,
			turnBudget: child?.turnBudget ?? step.turnBudget,
			turnBudgetExceeded: child?.turnBudgetExceeded === true ? true : undefined,
			wrapUpRequested: child?.wrapUpRequested === true ? true : undefined,
			toolBudget: child?.toolBudget ?? step.toolBudget,
			toolBudgetBlocked: child?.toolBudgetBlocked === true ? true : undefined,
			sessionFile: step.sessionFile ?? child?.sessionFile,
			model,
			thinking,
			attemptedModels: child?.attemptedModels ?? step.attemptedModels,
			modelAttempts: child?.modelAttempts ?? step.modelAttempts,
			cumulativeUsage: child?.cumulativeUsage ?? step.cumulativeUsage,
			terminalOutcome: child?.terminalOutcome ?? step.terminalOutcome,
			totalCost: child?.totalCost ?? step.totalCost,
			transcriptPath: child?.transcriptPath ?? step.transcriptPath,
			transcriptError: child?.transcriptError ?? step.transcriptError,
			children: child?.children ?? step.children,
			activityState: undefined,
			currentTool: undefined,
			currentToolArgs: undefined,
			currentToolStartedAt: undefined,
			currentPath: undefined,
		};
	});
	if (repair.nestedChildren !== undefined) attachRootChildrenToSteps(runId, steps, repair.nestedChildren);
	const stateDrivingFailure =
		repair.state === "failed"
			? repair.results?.find((child) => !child.success && !child.stopped && !child.interrupted)
			: repair.state === "stopped"
				? repair.results?.find((child) => child.stopped)
				: repair.state === "paused"
					? repair.results?.find((child) => child.interrupted)
					: undefined;
	const error = stateDrivingFailure?.error ?? repair.results?.find((child) => child.error)?.error;
	const parentRunOrigin =
		status.parentRunOrigin === "user" ||
		repair.parentRunOrigin === "user" ||
		nestedWorkIncludesUser(repair.nestedChildren)
			? "user"
			: (status.parentRunOrigin ?? repair.parentRunOrigin);
	const terminalStatus: AsyncStatus = {
		...status,
		startedAt: repair.startedAt ?? status.startedAt,
		state: repair.state,
		error: repair.state === "complete" ? undefined : (error ?? status.error),
		stopped: repair.state === "stopped" ? true : undefined,
		timedOut: repair.timedOut === true ? true : undefined,
		activityState: undefined,
		currentTool: undefined,
		currentToolStartedAt: undefined,
		currentPath: undefined,
		lastUpdate: endedAt,
		endedAt: status.endedAt ?? endedAt,
		steps,
	};
	if (parentRunOrigin) terminalStatus.parentRunOrigin = parentRunOrigin;
	if (
		status.lifecycleArtifactVersion === 3 &&
		(!status.processTerminal || status.processTerminal.state === "pending")
	) {
		terminalStatus.processTerminal = {
			version: 1,
			state: "unknown",
			runId: status.runId,
			runnerProcessInstanceId: "observer-unavailable",
			reason: "observer-unavailable",
		};
	}
	return terminalStatus;
}
