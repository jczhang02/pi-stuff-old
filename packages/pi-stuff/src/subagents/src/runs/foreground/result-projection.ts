import * as path from "node:path";
import type { AgentToolResult as CoreAgentToolResult } from "@earendil-works/pi-agent-core";
import { isRuntimeNumber } from "../../../../shared/runtime-type.js";
import type { ArtifactPaths, AsyncStatus, Details, NestedRunSummary, SingleResult, Usage } from "../../shared/types.ts";
import type { BackgroundRunnerConfig, BackgroundTaskResult, RunnerAgentTask } from "../shared/parallel-utils.ts";

type AgentToolResult<T> = CoreAgentToolResult<T> & { isError?: boolean };

export interface ForegroundCompletion {
	id: string;
	runId: string;
	mode: "single" | "parallel";
	state: "complete" | "failed" | "stopped" | "paused";
	success: boolean;
	stopped?: boolean;
	timedOut?: boolean;
	interrupted?: boolean;
	results: BackgroundTaskResult[];
	nestedChildren?: NestedRunSummary[];
}

function runnerTasks(config: BackgroundRunnerConfig): RunnerAgentTask[] {
	return config.work.mode === "single" ? [config.work.task] : config.work.group.tasks;
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function resultUsage(result: BackgroundTaskResult): Usage {
	const usage = emptyUsage();
	for (const attempt of result.modelAttempts ?? []) {
		if (!attempt.usage) continue;
		usage.input += attempt.usage.input;
		usage.output += attempt.usage.output;
		usage.cacheRead += attempt.usage.cacheRead;
		usage.cacheWrite += attempt.usage.cacheWrite;
		usage.cost += attempt.usage.cost;
		usage.turns += attempt.usage.turns;
	}
	return usage;
}

function childrenForResult(
	nestedChildren: NestedRunSummary[] | undefined,
	index: number,
	directCount: number,
): NestedRunSummary[] | undefined {
	if (!nestedChildren?.length) return undefined;
	const exact = nestedChildren.filter((child) => child.parentStepIndex === index);
	if (exact.length > 0) return exact;
	return directCount === 1 ? nestedChildren : undefined;
}

function resultWasExternalCrash(result: BackgroundTaskResult): boolean {
	if (
		result.success ||
		result.interrupted ||
		result.timedOut ||
		result.stopped ||
		result.turnBudgetExceeded ||
		result.toolBudgetBlocked
	) {
		return false;
	}
	const writers = result.writerProcesses ?? [];
	const finalAttempt = writers.reduce(
		(latest, process) => Math.max(latest, process.attempt),
		Number.NEGATIVE_INFINITY,
	);
	return writers.some((process) => process.attempt === finalAttempt && process.terminationOrigin === "external");
}

function toSingleResult(
	result: BackgroundTaskResult,
	task: RunnerAgentTask,
	index: number,
	directCount: number,
	nestedChildren: NestedRunSummary[] | undefined,
): SingleResult {
	const childResults = childrenForResult(nestedChildren, index, directCount);
	const crashed = resultWasExternalCrash(result);
	const projected: SingleResult = {
		agent: result.agent,
		task: task.task,
		exitCode: result.exitCode ?? 1,
		usage: resultUsage(result),
		finalOutput: result.output,
	};
	if (task.cwd) projected.cwd = task.cwd;
	if (result.context) projected.context = result.context;
	if (result.contextUsage) projected.contextUsage = result.contextUsage;
	if (result.interrupted) projected.interrupted = true;
	if (result.timedOut) projected.timedOut = true;
	if (result.stopped) projected.stopped = true;
	if (crashed) projected.crashed = true;
	if (result.turnBudget) projected.turnBudget = result.turnBudget;
	if (result.turnBudgetExceeded) projected.turnBudgetExceeded = true;
	if (result.wrapUpRequested) projected.wrapUpRequested = true;
	if (result.contextNudgeObserved) projected.contextNudgeObserved = true;
	if (result.toolBudget) projected.toolBudget = result.toolBudget;
	if (result.toolBudgetBlocked) projected.toolBudgetBlocked = true;
	if (result.model) projected.model = result.model;
	if (result.thinking) projected.thinking = result.thinking;
	if (result.attemptedModels) projected.attemptedModels = [...result.attemptedModels];
	if (result.modelAttempts) projected.modelAttempts = result.modelAttempts.map((attempt) => ({ ...attempt }));
	if (result.cumulativeUsage) projected.cumulativeUsage = { ...result.cumulativeUsage };
	if (result.terminalOutcome) projected.terminalOutcome = structuredClone(result.terminalOutcome);
	if (result.error) projected.error = result.error;
	if (result.sessionFile) projected.sessionFile = result.sessionFile;
	if (result.artifactPaths) projected.artifactPaths = { ...result.artifactPaths };
	if (result.transcriptPath) projected.transcriptPath = result.transcriptPath;
	if (result.transcriptError) projected.transcriptError = result.transcriptError;
	if (result.launchContractDigest) projected.launchContractDigest = result.launchContractDigest;
	if (result.capabilityCeiling) projected.capabilityCeiling = result.capabilityCeiling;
	if (result.capabilityAudit) projected.capabilityAudit = result.capabilityAudit;
	if (childResults) projected.children = childResults;
	return projected;
}

function contextSummary(results: readonly SingleResult[]): Details["context"] {
	const contexts = new Set(results.map((result) => result.context).filter(Boolean));
	if (contexts.size === 0) return undefined;
	if (contexts.size > 1) return "mixed";
	return contexts.values().next().value;
}

function artifactDetails(results: readonly SingleResult[]): Details["artifacts"] {
	const files = results
		.map((result) => result.artifactPaths)
		.filter((value): value is ArtifactPaths => value !== undefined);
	if (files.length === 0) return undefined;
	return { dir: configArtifactDir(files), files };
}

function configArtifactDir(files: readonly ArtifactPaths[]): string {
	const first = files[0];
	if (!first) return "";
	return path.dirname(first.outputPath);
}

function formatResult(results: readonly SingleResult[]): string {
	return results
		.map((result, index) => {
			const state = result.detached
				? "detached"
				: result.stopped
					? "stopped"
					: result.interrupted
						? "paused"
						: result.crashed
							? "crashed"
							: result.exitCode === 0
								? "completed"
								: "failed";
			const heading =
				results.length === 1 ? `Agent ${result.agent} ${state}.` : `${index + 1}. ${result.agent} — ${state}`;
			const contextNudge = result.contextNudgeObserved
				? "\nContext housekeeping observed: magic-context:ceiling-nudge."
				: "";
			return `${heading}${contextNudge}\n${result.finalOutput || result.error || "(no report)"}`;
		})
		.join("\n\n");
}

export function foregroundStatusIsTerminal(status: AsyncStatus): boolean {
	return (
		status.state === "complete" ||
		status.state === "failed" ||
		status.state === "paused" ||
		status.state === "stopped"
	);
}

function stepWasExternalCrash(step: NonNullable<AsyncStatus["steps"]>[number]): boolean {
	if (step.agentStatus === "crashed") return true;
	return Boolean(
		step.processTerminal?.state === "observed" &&
			step.processTerminal.instances.some(
				(instance) => instance.kind === "pi-writer" && instance.terminationOrigin === "external",
			),
	);
}

export function projectForegroundStatus(
	config: BackgroundRunnerConfig,
	status: AsyncStatus,
	detachedReason?: string,
): AgentToolResult<Details> {
	const configuredTasks = runnerTasks(config);
	const runIsTerminal = foregroundStatusIsTerminal(status);
	const results = (status.steps ?? []).map((step, index): SingleResult => {
		const task = configuredTasks[index];
		if (!task) throw new Error("Foreground Agent status has no configured task.");
		const detached = !runIsTerminal && (step.status === "pending" || step.status === "running");
		const paused = step.status === "paused";
		const stopped = step.status === "stopped" || step.stopped === true;
		const completed = step.status === "complete" || step.status === "completed";
		const output = step.finalOutput ?? step.recentOutput?.join("\n") ?? "";
		const projected: SingleResult = {
			agent: step.agent,
			task: step.task ?? task.task,
			cwd: task.cwd,
			exitCode: isRuntimeNumber(step.exitCode) ? step.exitCode : completed ? 0 : 1,
			usage: {
				input: step.tokens?.input ?? 0,
				output: step.tokens?.output ?? 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				turns: step.turnCount ?? 0,
			},
			finalOutput: output,
		};
		if (step.context) projected.context = step.context;
		if (step.contextUsage) projected.contextUsage = step.contextUsage;
		if (detached) {
			projected.detached = true;
			projected.detachedReason = detachedReason ?? "Foreground owner recovery pending.";
		}
		if (paused) projected.interrupted = true;
		if (stopped) projected.stopped = true;
		if (step.timedOut) projected.timedOut = true;
		if (stepWasExternalCrash(step)) projected.crashed = true;
		if (step.turnBudget) projected.turnBudget = step.turnBudget;
		if (step.turnBudgetExceeded) projected.turnBudgetExceeded = true;
		if (step.wrapUpRequested) projected.wrapUpRequested = true;
		if (step.toolBudget) projected.toolBudget = step.toolBudget;
		if (step.toolBudgetBlocked) projected.toolBudgetBlocked = true;
		if (step.model) projected.model = step.model;
		if (step.thinking) projected.thinking = step.thinking;
		if (step.attemptedModels) projected.attemptedModels = [...step.attemptedModels];
		if (step.modelAttempts) projected.modelAttempts = step.modelAttempts.map((attempt) => ({ ...attempt }));
		if (step.cumulativeUsage) projected.cumulativeUsage = { ...step.cumulativeUsage };
		if (step.terminalOutcome) projected.terminalOutcome = structuredClone(step.terminalOutcome);
		if (step.error) projected.error = step.error;
		else if (!detached && status.error) projected.error = status.error;
		if (step.sessionFile) projected.sessionFile = step.sessionFile;
		if (step.transcriptPath) projected.transcriptPath = step.transcriptPath;
		if (step.transcriptError) projected.transcriptError = step.transcriptError;
		if (step.launchContractDigest) projected.launchContractDigest = step.launchContractDigest;
		if (step.capabilityCeiling) projected.capabilityCeiling = step.capabilityCeiling;
		if (step.capabilityAudit) projected.capabilityAudit = step.capabilityAudit;
		if (step.children?.length) projected.children = step.children;
		return projected;
	});
	const artifacts = artifactDetails(results);
	const context = contextSummary(results);
	const details: Details = {
		mode: config.work.mode,
		runId: config.id,
		cwd: config.cwd,
		results,
	};
	if (context) details.context = context;
	if (artifacts) details.artifacts = artifacts;
	if (status.timedOut) details.timedOut = true;
	if (status.stopped) details.stopped = true;
	if (config.timeoutMs !== undefined) details.timeoutMs = config.timeoutMs;
	if (config.deadlineAt !== undefined) details.deadlineAt = config.deadlineAt;
	if (config.capabilityCeiling) details.capabilityCeiling = config.capabilityCeiling;
	const projected: AgentToolResult<Details> = {
		content: [{ type: "text", text: formatResult(results) }],
		details,
	};
	if (status.state !== "complete") projected.isError = true;
	return projected;
}

export function projectForegroundCompletion(
	config: BackgroundRunnerConfig,
	completion: ForegroundCompletion,
): AgentToolResult<Details> {
	const configuredTasks = runnerTasks(config);
	const results = completion.results.map((result, index) => {
		const configuredTask = configuredTasks[index] ?? configuredTasks[0];
		if (!configuredTask) throw new Error("Foreground Agent result has no configured task.");
		return toSingleResult(result, configuredTask, index, completion.results.length, completion.nestedChildren);
	});
	const artifacts = artifactDetails(results);
	const context = contextSummary(results);
	const details: Details = {
		mode: completion.mode,
		runId: completion.runId,
		cwd: config.cwd,
		results,
	};
	if (context) details.context = context;
	if (artifacts) details.artifacts = artifacts;
	if (completion.timedOut) details.timedOut = true;
	if (completion.stopped) details.stopped = true;
	if (config.timeoutMs !== undefined) details.timeoutMs = config.timeoutMs;
	if (config.deadlineAt !== undefined) details.deadlineAt = config.deadlineAt;
	if (config.capabilityCeiling) details.capabilityCeiling = config.capabilityCeiling;
	const projected: AgentToolResult<Details> = {
		content: [{ type: "text", text: formatResult(results) }],
		details,
	};
	if (!completion.success) projected.isError = true;
	return projected;
}
