import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeString } from "../../../shared/runtime-type.js";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor.ts";
import { scanAgentReport } from "../runtime/final-report-scanner.ts";
import { resolveDisplayDescription } from "../shared/display-description.ts";
import type { Details, SingleResult } from "../shared/types.ts";

const MAX_CHILD_SUMMARY_CHARS = 4_000;
const MAX_PARENT_RESULT_CHARS = 12_000;

export interface PublicAgentTask {
	readonly agent: string;
	readonly description?: string;
	readonly task: string;
	readonly cwd?: string;
	readonly model?: string;
	readonly skill?: string | readonly string[] | boolean;
	readonly toolBudget?: { readonly soft?: number; readonly hard: number; readonly block?: readonly string[] | "*" };
	readonly toolTimeoutMs?: number;
	readonly context?: "fork" | "fresh";
	readonly isolation?: "shared" | "worktree";
	readonly foreground?: boolean;
}

const CONTROL_ONLY_FIELDS = new Set(["acknowledgeCost", "action", "id", "index", "message"]);
const LAUNCH_ONLY_FIELDS = [
	"agent",
	"context",
	"cwd",
	"description",
	"foreground",
	"isolation",
	"model",
	"skill",
	"task",
	"tasks",
	"thinking",
	"timeoutMs",
	"toolBudget",
	"toolTimeoutMs",
] as const;

function hasOwn(params: PublicAgentParams, field: keyof PublicAgentParams): boolean {
	return Object.hasOwn(params, field);
}

function sharedTaskValue<K extends "context" | "isolation" | "foreground">(
	params: PublicAgentParams,
	field: K,
): PublicAgentParams[K] {
	const taskValues = (params.tasks ?? []).filter((task) => Object.hasOwn(task, field)).map((task) => task[field]);
	if (taskValues.length === 0) return params[field];
	const first = taskValues[0];
	if (taskValues.some((value) => value !== first)) {
		throw new Error(`Parallel Agent tasks must use one shared ${field} value.`);
	}
	if (hasOwn(params, field) && params[field] !== first) {
		throw new Error(`Top-level ${field} conflicts with the shared task ${field} value.`);
	}
	// SAFETY: field is the same generic key for every task value and the selected top-level value.
	return (hasOwn(params, field) ? params[field] : first) as PublicAgentParams[K];
}

/**
 * Enforce the product contract without provider-hostile JSON Schema branches.
 * Some OpenAI-compatible providers reject boolean schemas inside oneOf before
 * the model can call the tool, so shape exclusivity belongs at this boundary.
 */
export function normalizePublicAgentParams(params: PublicAgentParams): PublicAgentParams {
	if (params.action) {
		const mixed = LAUNCH_ONLY_FIELDS.find((field) => hasOwn(params, field));
		if (mixed) {
			const recovery =
				mixed === "agent"
					? " Use id to target an Agent; status omits id for an overview. agent selects an Agent definition only when launching with task."
					: "";
			throw new Error(`Agent control action '${params.action}' cannot include launch field '${mixed}'.${recovery}`);
		}
		if (params.acknowledgeCost === true && params.action !== "resume") {
			throw new Error("acknowledgeCost is supported only for action='resume'.");
		}
		return { ...params };
	}
	const control = [...CONTROL_ONLY_FIELDS].find((field) => field !== "action" && Object.hasOwn(params, field));
	if (control) throw new Error(`Agent launch cannot include control field '${control}'.`);
	const hasSingleField = hasOwn(params, "agent") || hasOwn(params, "task") || hasOwn(params, "description");
	const hasParallel = Array.isArray(params.tasks) && params.tasks.length > 0;
	if (hasSingleField && hasParallel) throw new Error("Provide either agent plus task or tasks, not both.");
	if (hasParallel) {
		const context = sharedTaskValue(params, "context");
		const isolation = sharedTaskValue(params, "isolation");
		const foreground = sharedTaskValue(params, "foreground");
		const normalized = {
			...params,
			tasks: params.tasks?.map(
				({ context: _context, isolation: _isolation, foreground: _foreground, ...task }) => task,
			),
		};
		if (context !== undefined) normalized.context = context;
		if (isolation !== undefined) normalized.isolation = isolation;
		if (foreground !== undefined) normalized.foreground = foreground;
		return normalized;
	}
	if (!params.agent?.trim() || !params.task?.trim()) {
		throw new Error(
			"Single Agent launch requires non-blank agent + task. Inspect the current Tool description for available Agent definitions, or provide a non-empty tasks list for parallel work.",
		);
	}
	return { ...params };
}

export interface PublicAgentParams {
	readonly acknowledgeCost?: boolean;
	readonly action?: "resume" | "status" | "steer" | "stop";
	readonly agent?: string;
	readonly context?: "fork" | "fresh";
	readonly cwd?: string;
	readonly description?: string;
	readonly foreground?: boolean;
	readonly id?: string;
	readonly index?: number;
	readonly isolation?: "shared" | "worktree";
	readonly message?: string;
	readonly model?: string;
	readonly skill?: string | readonly string[] | boolean;
	readonly task?: string;
	readonly tasks?: readonly PublicAgentTask[];
	readonly thinking?: string;
	readonly timeoutMs?: number;
	readonly toolBudget?: { readonly soft?: number; readonly hard: number; readonly block?: readonly string[] | "*" };
	readonly toolTimeoutMs?: number;
}

function mutableSkill(
	value: Exclude<PublicAgentParams["skill"], undefined>,
): Exclude<SubagentParamsLike["skill"], undefined> {
	if (isRuntimeString(value) || isRuntimeBoolean(value)) return value;
	return [...value];
}

function mutableToolBudget(
	value: NonNullable<PublicAgentParams["toolBudget"]>,
): NonNullable<SubagentParamsLike["toolBudget"]> {
	const budget: NonNullable<SubagentParamsLike["toolBudget"]> = {
		hard: value.hard,
	};
	if (value.soft !== undefined) budget.soft = value.soft;
	if (Array.isArray(value.block)) budget.block = [...value.block];
	else if (value.block === "*") budget.block = "*";
	return budget;
}

function mapTask(task: PublicAgentTask): NonNullable<SubagentParamsLike["tasks"]>[number] {
	const mapped: NonNullable<SubagentParamsLike["tasks"]>[number] = {
		agent: task.agent,
		description: resolveDisplayDescription(task.description, task.task),
		task: task.task,
	};
	if (task.cwd) mapped.cwd = task.cwd;
	if (task.model) mapped.model = task.model;
	if (task.skill !== undefined) mapped.skill = mutableSkill(task.skill);
	if (task.toolBudget) mapped.toolBudget = mutableToolBudget(task.toolBudget);
	if (task.toolTimeoutMs !== undefined) mapped.toolTimeoutMs = task.toolTimeoutMs;
	return mapped;
}

/**
 * Keep the public Claude-style contract small while retaining the mature fork's
 * execution engine behind this boundary.
 */
export function toEngineParams(input: PublicAgentParams): SubagentParamsLike {
	const params = normalizePublicAgentParams(input);
	if (params.action) {
		const control: SubagentParamsLike = { action: params.action };
		if (params.id) control.id = params.id;
		if (params.index !== undefined) control.index = params.index;
		if (params.message) control.message = params.message;
		return control;
	}

	const worktree = params.isolation === "worktree";
	const common: SubagentParamsLike = {
		async: params.foreground !== true,
		context: params.context ?? "fresh",
	};
	if (worktree) common.worktree = true;
	if (params.cwd) common.cwd = params.cwd;
	if (params.model) common.model = params.model;
	if (params.thinking) common.thinking = params.thinking;
	if (params.skill !== undefined) common.skill = mutableSkill(params.skill);
	if (params.timeoutMs !== undefined) common.timeoutMs = params.timeoutMs;
	if (params.toolBudget) common.toolBudget = mutableToolBudget(params.toolBudget);
	if (params.toolTimeoutMs !== undefined) common.toolTimeoutMs = params.toolTimeoutMs;

	if (params.tasks?.length) {
		return { ...common, tasks: params.tasks.map(mapTask) };
	}
	if (worktree && params.agent && params.task) {
		const task: PublicAgentTask = { agent: params.agent, task: params.task };
		if (params.description) Object.assign(task, { description: params.description });
		if (params.model) Object.assign(task, { model: params.model });
		if (params.skill !== undefined) Object.assign(task, { skill: params.skill });
		if (params.toolBudget) Object.assign(task, { toolBudget: params.toolBudget });
		if (params.toolTimeoutMs !== undefined) Object.assign(task, { toolTimeoutMs: params.toolTimeoutMs });
		return {
			...common,
			tasks: [mapTask(task)],
		};
	}
	if (params.agent) common.agent = params.agent;
	if (params.task) {
		common.description = resolveDisplayDescription(params.description, params.task);
		common.task = params.task;
	}
	return common;
}

function bounded(value: string, limit: number): string {
	if (value.length <= limit) return value;
	return `${value.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function boundedReport(value: string, limit: number, fullReportPath?: string): string {
	if (value.length <= limit) return value;
	const location = fullReportPath ? `Full report: ${fullReportPath}` : "Inspect the complete report with /agents.";
	const marker = `\n\n[Middle omitted from ${value.length}-character report. ${location}]\n\n`;
	if (marker.length >= limit) return bounded("[Report truncated. Inspect the complete report with /agents.]", limit);
	const remaining = limit - marker.length;
	const headLength = Math.ceil(remaining / 2);
	const tailLength = Math.floor(remaining / 2);
	return `${value.slice(0, headLength).trimEnd()}${marker}${value.slice(-tailLength).trimStart()}`;
}

function resultStatus(result: SingleResult): "completed" | "failed" | "stopped" | "status unknown" {
	if (result.interrupted || result.stopped || result.detached) return "stopped";
	if (result.crashed || result.error || (isRuntimeNumber(result.exitCode) && result.exitCode !== 0)) return "failed";
	if (result.exitCode === 0) return "completed";
	return "status unknown";
}

function childSummary(result: SingleResult, limit: number): string {
	const output = result.finalOutput?.trim() ?? "";
	const error = result.error?.trim();
	const raw = error
		? `Runtime error: ${error}${output ? `\nPartial child report:\n${output}` : ""}`
		: output || "(no report)";
	const fullReportPath = result.artifactPaths?.outputPath;
	return boundedReport(scanAgentReport(raw).text, limit, fullReportPath);
}

function foregroundContent(results: readonly SingleResult[]): string {
	const entries = results.map((result, index) => {
		const heading =
			results.length === 1
				? `Agent ${result.agent} ${resultStatus(result)}.`
				: `${index + 1}. ${result.agent} — ${resultStatus(result)}`;
		const contextNudge = result.contextNudgeObserved
			? "\nContext housekeeping observed: magic-context:ceiling-nudge."
			: "";
		return { heading: `${heading}${contextNudge}`, result };
	});
	const fixedChars =
		entries.reduce((total, entry) => total + entry.heading.length + 1, 0) + Math.max(0, entries.length - 1) * 2;
	const summaryLimit = Math.min(
		MAX_CHILD_SUMMARY_CHARS,
		Math.max(0, Math.floor((MAX_PARENT_RESULT_CHARS - fixedChars) / entries.length)),
	);
	return entries
		.map(({ heading, result }) => `${heading}\n${childSummary(result, summaryLimit)}`.trimEnd())
		.join("\n\n");
}

export function agentResultText(result: AgentToolResult<Details>): string {
	return result.content
		.filter((entry): entry is Extract<(typeof result.content)[number], { type: "text" }> => entry.type === "text")
		.map((entry) => entry.text)
		.join("\n")
		.trim();
}

export type AgentEngineResult = AgentToolResult<Details> & { readonly isError?: boolean };

/** Parent-facing projection: direct summaries only, never engine bookkeeping paths. */
export function projectEngineResult(params: PublicAgentParams, result: AgentEngineResult): AgentEngineResult {
	const { lifecycleBinding: _lifecycleBinding, ...publicDetails } = result.details;
	const childFailed =
		!params.action &&
		params.foreground === true &&
		publicDetails.results.some(
			(child) =>
				(isRuntimeNumber(child.exitCode) && child.exitCode !== 0) || Boolean(child.error) || child.crashed === true,
		);
	const publicResult: AgentEngineResult = {
		...result,
		details: publicDetails,
	};
	if (childFailed) Object.assign(publicResult, { isError: true });
	if (params.action) {
		const text = bounded(
			scanAgentReport(agentResultText(publicResult) || "Agent action finished.").text,
			MAX_PARENT_RESULT_CHARS,
		);
		return { ...publicResult, content: [{ type: "text", text }] };
	}

	if (params.foreground !== true && publicResult.isError !== true) {
		const id = publicResult.details.asyncId ?? publicResult.details.runId;
		const names = params.tasks?.map(({ agent }) => agent) ?? (params.agent ? [params.agent] : []);
		const subject = names.length > 1 ? `${names.length} Agents` : `Agent ${names[0] ?? "task"}`;
		return {
			...publicResult,
			content: [
				{
					type: "text",
					text: `${subject} started in the background${id ? ` (${id})` : ""}. Continue independent work; results return automatically so you can finish the original task. Inspect progress with /agents.`,
				},
			],
		};
	}

	if (publicResult.details.results.length > 0) {
		return {
			...publicResult,
			content: [{ type: "text", text: foregroundContent(publicResult.details.results) }],
		};
	}
	const text = bounded(
		scanAgentReport(agentResultText(publicResult) || "Agent execution failed.").text,
		MAX_PARENT_RESULT_CHARS,
	);
	return { ...publicResult, content: [{ type: "text", text }] };
}
