import { visibleWidth } from "@earendil-works/pi-tui";
import type { JsonValue } from "../../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import { boundTerminalLine, boundTerminalText } from "../../../tool-display/index.ts";
import { resolveNestedAsyncDir } from "../runs/shared/nested-events.ts";
import { sanitizeSummary } from "../runs/shared/nested-summary.ts";
import type { AgentWorkUsage } from "../runtime/session-governor.ts";
import { resolveDisplayDescription } from "../shared/display-description.ts";
import type {
	AgentContextUsage,
	AgentTerminalOutcome,
	AsyncJobState,
	AsyncJobStep,
	AsyncStatus,
	ForegroundChildControl,
	ForegroundResumeChild,
	ForegroundRunControl,
	NestedRunSummary,
	NestedStepSummary,
	PiWriterProcessInstanceExitV1,
	ProcessTerminalV1,
	SingleResult,
} from "../shared/types.ts";
export type AgentStatus =
	| "queued"
	| "running"
	| "waiting_supervisor"
	| "stopping"
	| "completed"
	| "failed"
	| "agent_stopped"
	| "user_cancelled"
	| "crashed"
	| "resuming";

export interface AgentTranscriptTarget {
	readonly key: string;
	readonly error: string | null;
	readonly name?: string;
	readonly task: string;
	/** Trusted deterministic nested run directory used only as a locator fallback. */
	readonly asyncDir?: string | null;
	readonly childIndex?: number;
	readonly sessionFile: string | null;
	readonly transcriptPath: string | null;
	readonly savedOutputPath: string | null;
	readonly partialResult: string | null;
}

export interface AgentNestedDetail extends AgentTranscriptTarget {
	readonly runId: string;
	readonly childIndex: number;
	readonly parentRunId: string | null;
	readonly depth: number;
	readonly name: string;
	readonly description: string;
	readonly status: AgentStatus;
	readonly nestedCount: number;
}
export type AgentProjectionValue = boolean | null | number | object | string | undefined;

type AgentProjectionKey =
	| keyof AgentContextUsage
	| keyof AgentWorkUsage
	| keyof AgentTerminalOutcome
	| keyof AgentTerminalOutcome["continuation"]
	| keyof AgentTerminalOutcome["continuation"]["target"]
	| keyof AsyncJobState
	| keyof AsyncJobStep
	| keyof AsyncStatus
	| keyof ForegroundChildControl
	| keyof ForegroundResumeChild
	| keyof ForegroundRunControl
	| keyof NestedRunSummary
	| keyof NestedStepSummary
	| keyof PiWriterProcessInstanceExitV1
	| keyof ProcessTerminalV1
	| keyof Extract<ProcessTerminalV1, { state: "observed" }>
	| keyof Extract<ProcessTerminalV1, { state: "unknown" }>
	| keyof SingleResult;
type RawProjectionFields = { readonly [Key in AgentProjectionKey]?: JsonValue };

export type AgentProjectionRecord = RawProjectionFields & {
	readonly attentionKind?: JsonValue;
	readonly cancelledBy?: JsonValue;
	readonly execution?: JsonValue;
	readonly outputPath?: JsonValue;
	readonly output?: JsonValue;
	readonly resuming?: JsonValue;
	readonly stoppedBy?: JsonValue;
	readonly stopping?: JsonValue;
	readonly summary?: JsonValue;
	readonly uiStatus?: JsonValue;
	readonly waitReason?: JsonValue;
	readonly waitingFor?: JsonValue;
};
export const ACTIVE_SOURCE_STATUSES = new Set(["queued", "running"]);
export const TERMINAL_SOURCE_STATUSES = new Set(["complete", "completed", "failed", "paused", "stopped"]);
export const TERMINAL_STATUSES = new Set<AgentStatus>([
	"completed",
	"failed",
	"agent_stopped",
	"user_cancelled",
	"crashed",
]);
export const RESUMABLE_STATUSES = new Set<AgentStatus>(["completed", "failed", "agent_stopped", "crashed"]);
export const STATUS_ORDER = {
	waiting_supervisor: 0,
	stopping: 1,
	resuming: 2,
	running: 3,
	queued: 4,
	crashed: 5,
	failed: 6,
	user_cancelled: 7,
	agent_stopped: 8,
	completed: 9,
} satisfies Record<AgentStatus, number>;
const MAX_PARTIAL_RESULT_CHARS = 4_000;
const MAX_TERMINAL_ERROR_CHARS = 1_000;
const MAX_TASK_CHARS = 4_000;
const MAX_DYNAMIC_SOURCE_CODE_UNITS = 4_096;

export function asRecord<Value>(value: Value): AgentProjectionRecord {
	if (!isRuntimeObject(value) || value === null || Array.isArray(value)) return {};
	// SAFETY: projection consumers read only the declared raw fields and validate them before display.
	return value as Value & AgentProjectionRecord;
}

export function finiteNumber<Value>(value: Value): number | null {
	return isRuntimeNumber(value) && Number.isFinite(value) ? value : null;
}

export function projectedContextUsage(...values: AgentProjectionValue[]): AgentContextUsage | null {
	for (const value of values) {
		const usage = asRecord(asRecord(value)["contextUsage"]);
		const tokens = usage["tokens"];
		const contextWindow = usage["contextWindow"];
		if (
			isRuntimeNumber(tokens) &&
			Number.isSafeInteger(tokens) &&
			tokens >= 0 &&
			isRuntimeNumber(contextWindow) &&
			Number.isSafeInteger(contextWindow) &&
			contextWindow > 0
		) {
			return { tokens, contextWindow };
		}
	}
	return null;
}

export function projectedCumulativeUsage(...values: AgentProjectionValue[]): AgentWorkUsage | null {
	for (const value of values) {
		const usage = asRecord(asRecord(value)["cumulativeUsage"]);
		const turns = nonNegativeInteger(usage["turns"]);
		const toolCalls = nonNegativeInteger(usage["toolCalls"]);
		const inputTokens = nonNegativeInteger(usage["inputTokens"]);
		const outputTokens = nonNegativeInteger(usage["outputTokens"]);
		const modelAttempts = nonNegativeInteger(usage["modelAttempts"]);
		const resumes = nonNegativeInteger(usage["resumes"]);
		if (
			turns === undefined ||
			toolCalls === undefined ||
			inputTokens === undefined ||
			outputTokens === undefined ||
			modelAttempts === undefined ||
			resumes === undefined
		) {
			continue;
		}
		const cumulative: AgentWorkUsage = { turns, toolCalls, inputTokens, outputTokens, modelAttempts, resumes };
		const reportedCostUsd = usage["reportedCostUsd"];
		if (reportedCostUsd !== undefined) {
			if (!isRuntimeNumber(reportedCostUsd) || !Number.isFinite(reportedCostUsd) || reportedCostUsd < 0) continue;
			cumulative.reportedCostUsd = reportedCostUsd;
		}
		return cumulative;
	}
	return null;
}

const TERMINAL_CLASSES: ReadonlySet<string> = new Set([
	"completed",
	"timeout",
	"stopped",
	"interrupted",
	"provider",
	"context",
	"storage",
	"protocol",
	"explicit_budget",
	"cost_guard",
	"process",
	"unknown",
]);

function isTerminalClass<Value>(value: Value): value is Value & AgentTerminalOutcome["class"] {
	return isRuntimeString(value) && TERMINAL_CLASSES.has(value);
}

export function projectedTerminalOutcome(...values: AgentProjectionValue[]): AgentTerminalOutcome | null {
	for (const value of values) {
		const outcome = asRecord(asRecord(value)["terminalOutcome"]);
		const state = outcome["state"];
		const terminalClass = outcome["class"];
		const reason = boundedText(optionalString(outcome["reason"]), MAX_TERMINAL_ERROR_CHARS);
		const continuation = asRecord(outcome["continuation"]);
		const target = asRecord(continuation["target"]);
		const id = optionalString(target["id"]);
		const index = nonNegativeInteger(target["index"]);
		const resumeSupported = continuation["resumeSupported"];
		if (
			(state !== "completed" && state !== "incomplete" && state !== "failed") ||
			!isTerminalClass(terminalClass) ||
			!reason ||
			!id ||
			index === undefined ||
			!isRuntimeBoolean(resumeSupported)
		) {
			continue;
		}
		const projected: AgentTerminalOutcome = {
			state,
			class: terminalClass,
			reason,
			continuation: { target: { id, index }, resumeSupported },
		};
		if (continuation["acknowledgementRequired"] === true) {
			projected.continuation.acknowledgementRequired = true;
		}
		return projected;
	}
	return null;
}

function nonNegativeInteger<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalString<Value>(value: Value): string | null {
	if (!isRuntimeString(value)) return null;
	const bounded = value.slice(0, MAX_DYNAMIC_SOURCE_CODE_UNITS);
	return bounded.trim() ? bounded : null;
}

function locatorString<Value>(value: Value): string | null {
	if (!isRuntimeString(value) || !value.trim()) return null;
	return value.length <= MAX_DYNAMIC_SOURCE_CODE_UNITS ? value : null;
}

export function firstLocator(...values: AgentProjectionValue[]): string | null {
	for (const value of values) {
		const locator = locatorString(value);
		if (locator) return locator;
	}
	return null;
}

function boundedText<Value>(value: Value, limit: number): string | null {
	const text = boundTerminalLine(value, limit);
	if (!text) return null;
	return text;
}

export function boundedTask(value: string | null): string {
	return value ? boundTerminalText(value, MAX_TASK_CHARS).trim() : "";
}

export function terminalError(status: AgentStatus, ...values: AgentProjectionValue[]): string | null {
	if (status !== "failed" && status !== "crashed") return null;
	for (const value of values) {
		const record = asRecord(value);
		for (const candidate of [record["error"], asRecord(record["execution"])["error"]]) {
			const safe = boundedText(optionalString(candidate), MAX_TERMINAL_ERROR_CHARS);
			if (safe) return safe;
		}
	}
	return null;
}

export function firstString(...values: AgentProjectionValue[]): string | null {
	for (const value of values) {
		const text = optionalString(value);
		if (text) return text;
	}
	return null;
}

export function taskForDisplay(...values: AgentProjectionValue[]): string | null {
	for (const value of values) {
		const text = optionalString(value);
		if (!text) continue;
		const trimmed = text.trimStart();
		if (trimmed.startsWith("<pi-stuff-context ")) continue;
		return text;
	}
	return null;
}

export function rowKey(runId: string, childIndex: number): string {
	return `${runId}:${childIndex}`;
}

export function sourceStatus<Value>(value: Value): string {
	return isRuntimeString(value) ? value : "running";
}

function isSupervisorWait(record: AgentProjectionRecord): boolean {
	const waitingFor = firstString(record["waitingFor"], record["attentionKind"], record["waitReason"])?.toLowerCase();
	const currentTool = optionalString(record["currentTool"])?.toLowerCase();
	return (
		waitingFor === "supervisor" ||
		currentTool === "contact_supervisor" ||
		currentTool === "intercom" ||
		record["activityState"] === "needs_attention"
	);
}

function processHasExternalSignal(record: AgentProjectionRecord): boolean {
	const terminal = asRecord(record["processTerminal"]);
	const writers = (Array.isArray(terminal["instances"]) ? terminal["instances"] : [])
		.map(asRecord)
		.filter(
			(instance) =>
				instance["kind"] === "pi-writer" &&
				isRuntimeNumber(instance["attempt"]) &&
				Number.isInteger(instance["attempt"]),
		);
	const finalAttempt = writers.reduce(
		(latest, instance) => Math.max(latest, isRuntimeNumber(instance["attempt"]) ? instance["attempt"] : -1),
		Number.NEGATIVE_INFINITY,
	);
	return writers.some(
		(instance) => instance["attempt"] === finalAttempt && instance["terminationOrigin"] === "external",
	);
}

function legacyFinalDrainHasCompleteReport(record: AgentProjectionRecord): boolean {
	return record["legacyFinalReportComplete"] === true;
}

function processTerminalIsStaleRepair(record: AgentProjectionRecord): boolean {
	const terminal = asRecord(record["processTerminal"]);
	return terminal["state"] === "unknown" && terminal["reason"] === "stale-repair";
}

function isLegacyRunnerDisappearance(error: string): boolean {
	return /async runner process .* exited or disappeared before writing a result/i.test(error);
}

function isAgentStatus<Value>(value: Value): value is Value & AgentStatus {
	return isRuntimeString(value) && value in STATUS_ORDER;
}

export function deriveStatus<Value>(value: Value, fallback: string): AgentStatus {
	const record = asRecord(value);
	const explicit = firstString(record["agentStatus"], record["uiStatus"]);
	if (isAgentStatus(explicit)) return explicit;
	if (record["stopping"] === true || fallback === "stopping") return "stopping";
	if (record["resuming"] === true || fallback === "resuming") return "resuming";

	const status = sourceStatus(record["status"] ?? fallback);
	switch (status) {
		case "pending":
		case "queued":
			return "queued";
		case "running":
		case "detached":
			if (isSupervisorWait(record)) return "waiting_supervisor";
			return "running";
		case "complete":
		case "completed":
			return "completed";
		case "paused":
			return "agent_stopped";
		case "stopped":
			return record["cancelledBy"] === "agent" || record["stoppedBy"] === "agent"
				? "agent_stopped"
				: "user_cancelled";
		case "failed": {
			const error = optionalString(record["error"]) ?? "";
			const expectedTermination =
				record["interrupted"] === true ||
				record["timedOut"] === true ||
				record["stopped"] === true ||
				record["turnBudgetExceeded"] === true ||
				record["toolBudgetBlocked"] === true;
			const crashEvidence =
				record["crashed"] === true ||
				processTerminalIsStaleRepair(record) ||
				isLegacyRunnerDisappearance(error) ||
				processHasExternalSignal(record);
			if (!expectedTermination && !crashEvidence && legacyFinalDrainHasCompleteReport(record)) return "completed";
			return !expectedTermination && crashEvidence ? "crashed" : "failed";
		}
		default:
			return "running";
	}
}

export function countNestedRuns<Value>(value: Value): number {
	if (!Array.isArray(value)) return 0;
	let count = 0;
	for (const nested of value) {
		const record = asRecord(nested);
		count += 1;
		count += countNestedRuns(record["children"]);
		if (Array.isArray(record["steps"])) {
			for (const step of record["steps"]) count += countNestedRuns(asRecord(step)["children"]);
		}
	}
	return count;
}

export function nestedForChild<Value>(value: Value, childIndex: number, directCount: number): AgentProjectionValue[] {
	if (!Array.isArray(value)) return [];
	const exact = value.filter((nested) => asRecord(nested)["parentStepIndex"] === childIndex);
	if (exact.length > 0) return exact;
	return directCount === 1 ? value : [];
}

export function projectNestedAgents<Value>(value: Value): AgentNestedDetail[] {
	if (!Array.isArray(value)) return [];
	const details: AgentNestedDetail[] = [];
	const seenRuns = new Set<string>();
	const walk = (runs: AgentProjectionValue[], inheritedDepth: number): void => {
		for (const candidate of runs) {
			if (details.length >= 200) return;
			const run = asRecord(candidate);
			const sanitizedRun = sanitizeSummary(candidate);
			const runId = optionalString(run["id"]);
			if (!runId || seenRuns.has(runId)) continue;
			seenRuns.add(runId);
			const depthValue = finiteNumber(run["depth"]);
			const depth = Math.max(1, Math.min(3, depthValue === null ? inheritedDepth : Math.floor(depthValue)));
			const runStatus = sourceStatus(run["state"] ?? run["status"]);
			const steps = Array.isArray(run["steps"]) ? run["steps"] : [];
			const runChildren = Array.isArray(run["children"]) ? run["children"] : [];
			const parentRunId = optionalString(run["parentRunId"]);
			const rootRunId =
				sanitizedRun?.path[0]?.runId ?? (sanitizedRun?.depth === 1 ? sanitizedRun.parentRunId : undefined);
			const asyncDir = rootRunId && sanitizedRun ? (resolveNestedAsyncDir(rootRunId, sanitizedRun) ?? null) : null;
			if (steps.length === 0) {
				const status = deriveStatus(run, runStatus);
				const task = boundedTask(taskForDisplay(run["delegatedTask"], run["task"]));
				details.push(
					Object.freeze({
						key: `nested:${runId}:0`,
						asyncDir,
						runId,
						childIndex: 0,
						parentRunId,
						depth,
						name: firstString(run["agent"], runId) ?? "agent",
						description: resolveDisplayDescription(undefined, task),
						task,
						status,
						error: terminalError(status, run),
						nestedCount: countNestedRuns(runChildren),
						sessionFile: firstLocator(run["sessionFile"]),
						transcriptPath: firstLocator(run["transcriptPath"]),
						savedOutputPath: firstLocator(run["savedOutputPath"]),
						partialResult: partialResult(status, run),
					}),
				);
			}
			const assignedRunChildren = new Set<string>();
			for (const [index, rawStep] of steps.slice(0, 20).entries()) {
				if (details.length >= 200) return;
				const step = asRecord(rawStep);
				const explicitStepChildren = Array.isArray(step["children"]) ? step["children"] : [];
				const attributedRunChildren = nestedForChild(runChildren, index, steps.length);
				for (const child of attributedRunChildren) {
					const childId = optionalString(asRecord(child)["id"]);
					if (childId) assignedRunChildren.add(childId);
				}
				const stepChildren = [...explicitStepChildren, ...attributedRunChildren].filter((child, position, all) => {
					const childId = optionalString(asRecord(child)["id"]);
					return (
						!childId ||
						all.findIndex((candidate) => optionalString(asRecord(candidate)["id"]) === childId) === position
					);
				});
				const task = boundedTask(taskForDisplay(step["delegatedTask"], step["task"]));
				const description = resolveDisplayDescription(firstString(step["description"]), task);
				const status = deriveStatus(step, sourceStatus(step["status"] ?? runStatus));
				details.push(
					Object.freeze({
						key: `nested:${runId}:${index}`,
						asyncDir,
						runId,
						childIndex: index,
						parentRunId,
						depth,
						name: firstString(step["agent"], run["agent"], runId) ?? "agent",
						description,
						task,
						status,
						error: terminalError(status, step, run),
						nestedCount: countNestedRuns(stepChildren),
						sessionFile: firstLocator(step["sessionFile"], run["sessionFile"]),
						transcriptPath: firstLocator(step["transcriptPath"]),
						savedOutputPath: firstLocator(step["savedOutputPath"]),
						partialResult: partialResult(status, step, run),
					}),
				);
				walk(stepChildren, depth + 1);
			}
			walk(
				runChildren.filter((child) => {
					const childId = optionalString(asRecord(child)["id"]);
					return !childId || !assignedRunChildren.has(childId);
				}),
				depth + 1,
			);
		}
	};
	walk(value, 1);
	return details;
}

function boundedRecentOutput<Value>(value: Value): string | null {
	if (!Array.isArray(value)) return null;
	const lines: string[] = [];
	let usedWidth = 0;
	for (let index = 0; index < value.length; index += 1) {
		const line = value[index];
		if (!isRuntimeString(line)) continue;
		const remaining = MAX_PARTIAL_RESULT_CHARS - usedWidth;
		if (remaining <= 0) break;
		const bounded = boundTerminalText(line, remaining);
		lines.push(bounded);
		usedWidth += visibleWidth(bounded);
		if (line.length >= remaining || visibleWidth(line) > remaining) break;
	}
	return lines.join("\n") || null;
}

export function partialResult(status: AgentStatus, ...values: AgentProjectionValue[]): string | null {
	for (const value of values) {
		const record = asRecord(value);
		const candidate = record["finalOutput"] ?? record["summary"] ?? record["output"];
		const direct = isRuntimeString(candidate)
			? boundTerminalText(candidate, MAX_PARTIAL_RESULT_CHARS).trim() || null
			: null;
		if (direct) return direct;
		if (TERMINAL_STATUSES.has(status)) continue;
		const recent = boundedRecentOutput(record["recentOutput"]);
		if (recent) return recent;
	}
	return null;
}
