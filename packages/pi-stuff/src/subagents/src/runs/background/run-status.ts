import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { type AgentRow, CurrentAgents } from "../../session/current-agents.ts";
import { isTerminalAgentStatus } from "../../session/current-agents-projection.ts";
import { compactAbsolutePaths } from "../../shared/display-description.ts";
import type { Details, SubagentState } from "../../shared/types.ts";
import { classifyAgentFailure } from "../shared/terminal-outcome.ts";

const MAX_LIST_TASK_CHARS = 160;
const MAX_DETAIL_TASK_CHARS = 300;
const MAX_FAILURE_CHARS = 800;
const MAX_PROGRESS_CHARS = 800;

export interface RunStatusParams {
	readonly action?: "status";
	readonly id?: string;
	readonly index?: number;
}

export interface AgentTarget {
	readonly id: string;
	readonly index?: number;
}

export type RunStatusState = Pick<
	SubagentState,
	"currentSessionId" | "asyncJobs" | "recentAgentJobs" | "foregroundControls" | "foregroundRuns"
>;

export interface RunStatusDeps {
	readonly state?: RunStatusState;
	readonly now?: () => number;
}

export type RunStatusResult = AgentToolResult<Details> & { readonly isError?: boolean };

function statusResult(text: string, isError = false): RunStatusResult {
	const result: RunStatusResult = {
		content: [{ type: "text", text }],
		details: { mode: "management", results: [] },
	};
	if (isError) Object.assign(result, { isError: true });
	return result;
}

function compactText(value: string, limit: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length <= limit) return text;
	return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function compactChildText(value: string, limit: number): string {
	return compactText(compactAbsolutePaths(value), limit);
}

function formatElapsed(elapsedMs: number | null): string | undefined {
	if (elapsedMs === null) return undefined;
	const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function rowHeading(row: AgentRow): string {
	const elapsed = formatElapsed(row.elapsedMs);
	return [`id=${row.runId}`, `index=${String(row.childIndex)}`, row.name, row.status, elapsed]
		.filter(Boolean)
		.join(" · ");
}

function rowSummary(row: AgentRow): string {
	const heading = rowHeading(row);
	const task = compactChildText(row.task, MAX_LIST_TASK_CHARS);
	return task ? `- ${heading}\n  ${task}` : `- ${heading}`;
}

function terminalReference(row: AgentRow): string {
	if (row.savedOutputPath) return `Output: ${row.savedOutputPath}`;
	if (row.transcriptPath) return `Transcript: ${row.transcriptPath}`;
	if (row.sessionFile) return `Session: ${row.sessionFile}`;
	return "Reference: none retained.";
}

function rowsSummary(rows: readonly AgentRow[], heading: string): string {
	return [heading, ...rows.map(rowSummary)].join("\n");
}

function rowDetail(row: AgentRow): string {
	const lines = [rowHeading(row)];
	const task = compactChildText(row.task, MAX_DETAIL_TASK_CHARS);
	if (task) lines.push(`Task: ${task}`);
	if (row.terminalOutcome) {
		lines.push(
			`Outcome [${row.terminalOutcome.class}/${row.terminalOutcome.state}]: ${compactChildText(row.terminalOutcome.reason, MAX_FAILURE_CHARS)}`,
		);
	} else if (row.error) {
		lines.push(`Failure [${classifyAgentFailure(row.error)}]: ${compactChildText(row.error, MAX_FAILURE_CHARS)}`);
	}
	if (row.cumulativeUsage) {
		const usage = row.cumulativeUsage;
		const cost = usage.reportedCostUsd === undefined ? "unreported" : `$${usage.reportedCostUsd.toFixed(6)}`;
		lines.push(
			`Usage: ${usage.turns} turns · ${usage.toolCalls} Tools · ${usage.inputTokens} input + ${usage.outputTokens} output tokens · reported cost ${cost} · ${usage.modelAttempts} attempts · ${usage.resumes} resumes`,
		);
	}
	if (row.terminalOutcome) {
		const { continuation } = row.terminalOutcome;
		lines.push(
			`Recovery: id=${continuation.target.id} · index=${String(continuation.target.index)} · ${continuation.resumeSupported ? "resumable" : "not resumable"}${continuation.acknowledgementRequired ? " · acknowledgement required" : ""}`,
		);
	}
	if (isTerminalAgentStatus(row.status)) lines.push(terminalReference(row));
	if (row.partialResult) {
		const label = isTerminalAgentStatus(row.status) ? "Progress (excerpt)" : "Progress";
		lines.push(`${label}: ${compactChildText(row.partialResult, MAX_PROGRESS_CHARS)}`);
	}
	return lines.join("\n");
}

function currentRows(deps: RunStatusDeps): readonly AgentRow[] {
	if (!deps.state?.currentSessionId) return [];
	const rejectControl = () => false;
	const options: ConstructorParameters<typeof CurrentAgents>[1] = {
		inspect: rejectControl,
		steer: rejectControl,
		stop: rejectControl,
		resume: rejectControl,
	};
	if (deps.now) Object.assign(options, { now: deps.now });
	const current = new CurrentAgents(deps.state, options);
	try {
		return current.snapshot().rows;
	} finally {
		current.dispose();
	}
}

const LEGACY_AGENT_TARGET = /:\d+$/u;

function resolveTargetFromRows(target: AgentTarget, rows: readonly AgentRow[]): AgentTarget {
	if (!LEGACY_AGENT_TARGET.test(target.id)) return target;
	const canonical = rows.some((row) => row.runId === target.id);
	const matches = rows.filter(
		(row) => row.key === target.id && (target.index === undefined || row.childIndex === target.index),
	);
	if (canonical && matches.length > 0) {
		throw new Error(`Agent Target '${target.id}' is ambiguous in the current session.`);
	}
	if (canonical) return target;
	if (matches.length === 0) return target;
	if (matches.length > 1) {
		throw new Error(`Agent Target '${target.id}' is ambiguous in the current session.`);
	}
	const [row] = matches;
	if (!row) throw new Error(`Agent Target '${target.id}' is not available in the current session.`);
	return { id: row.runId, index: row.childIndex };
}

/** Resolve one legacy roster key to the public run-id/child-index pair. */
export function resolveLegacyAgentTarget(target: AgentTarget, deps: RunStatusDeps = {}): AgentTarget {
	if (!LEGACY_AGENT_TARGET.test(target.id)) return target;
	return resolveTargetFromRows(target, currentRows(deps));
}

function selectRows(rows: readonly AgentRow[], id: string, index: number | undefined): readonly AgentRow[] {
	const runRows = rows.filter((row) => row.runId === id);
	if (index === undefined) return runRows;
	const child = runRows.find((row) => row.childIndex === index);
	return child ? [child] : [];
}

export function inspectSubagentStatus(params: RunStatusParams, deps: RunStatusDeps = {}): RunStatusResult {
	if (params.index !== undefined && (!Number.isInteger(params.index) || params.index < 0)) {
		return statusResult("Agent status index must be a non-negative integer.", true);
	}
	if (params.index !== undefined && !params.id) {
		return statusResult("Agent status index requires an id.", true);
	}

	const rows = currentRows(deps);
	if (!params.id) {
		if (rows.length === 0) return statusResult("No Agents are available in the current session.");
		return statusResult(rowsSummary(rows, `Current Agents (${rows.length})`));
	}

	const requested: AgentTarget =
		params.index === undefined ? { id: params.id } : { id: params.id, index: params.index };
	let target: AgentTarget;
	try {
		target = resolveTargetFromRows(requested, rows);
	} catch (error) {
		return statusResult(error instanceof Error ? error.message : String(error), true);
	}
	const selected = selectRows(rows, target.id, target.index);
	if (selected.length === 0) {
		const suffix = target.index === undefined ? "" : ` at index ${target.index}`;
		return statusResult(`Agent '${target.id}'${suffix} is not available in the current session.`, true);
	}
	const [selectedRow] = selected;
	if (selected.length === 1 && selectedRow) return statusResult(rowDetail(selectedRow));
	return statusResult(rowsSummary(selected, `Agents in ${target.id} (${selected.length})`));
}
