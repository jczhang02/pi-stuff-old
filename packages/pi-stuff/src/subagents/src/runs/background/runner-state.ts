/** Project background work, task results, and published run status. */

import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import type { AgentWorkOrigin } from "../../../../conversation-ui/agent-run-origin.ts";
import { isRuntimeFunction } from "../../../../shared/runtime-type.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { type NestedRunSummary, SUBAGENT_ASYNC_STATUS_EVENT } from "../../shared/types.ts";
import {
	type BackgroundRunnerConfig,
	type BackgroundRunnerWork,
	type BackgroundTaskResult,
	MAX_BACKGROUND_TASKS,
	type RunnerAgentTask,
} from "../shared/parallel-utils.ts";
import { terminalOutcome } from "../shared/terminal-outcome.ts";
import type { cleanupWorktrees, diffWorktrees } from "../shared/worktree.ts";
import type {
	BackgroundRunnerStatus as RunnerStatus,
	BackgroundRunnerStatusStep as RunnerStatusStep,
} from "./initial-status.ts";
import { appendDiagnosticEvent, boundResultText, MAX_RESULT_ERROR_BYTES } from "./runner-output.ts";
import { steeringStatus, updateSteeringTarget } from "./steering.ts";

interface ChildCompletedDiagnosticEvent {
	type: "subagent.child.completed";
	ts: number;
	runId: string;
	index: number;
	agent: string;
	success: boolean;
	error?: string;
}
interface RunBackgroundWorkOptions {
	runId: string;
	terminalCause?: () => NonNullable<BackgroundTaskResult["preStartTerminalCause"]> | undefined;
}

export interface BackgroundCompletion {
	id: string;
	runId: string;
	parentRunOrigin?: AgentWorkOrigin;
	sessionId?: string | null;
	mode: "single" | "parallel";
	state: "complete" | "failed" | "stopped" | "paused";
	success: boolean;
	stopped?: boolean;
	timedOut?: boolean;
	interrupted?: boolean;
	summary: string;
	results: BackgroundTaskResult[];
	cwd: string;
	asyncDir: string;
	startedAt: number;
	endedAt: number;
	sessionFile?: string;
	nestedChildren?: NestedRunSummary[];
	worktree?: {
		diffs: ReturnType<typeof diffWorktrees>;
		summary: string;
		cleanup: ReturnType<typeof cleanupWorktrees>;
		error?: string;
	};
}
export function taskList(work: BackgroundRunnerWork): RunnerAgentTask[] {
	return work.mode === "single" ? [work.task] : work.group.tasks;
}

function applyTaskResultMetadata(result: BackgroundTaskResult, task: RunnerAgentTask): BackgroundTaskResult {
	if (task.context) result.context = task.context;
	if (task.sessionFile) result.sessionFile = task.sessionFile;
	if (task.model) result.model = task.model;
	if (task.thinking) result.thinking = task.thinking;
	if (task.launchContractDigest) result.launchContractDigest = task.launchContractDigest;
	return result;
}

export function stoppedResult(
	task: RunnerAgentTask,
	cause: NonNullable<BackgroundTaskResult["preStartTerminalCause"]>,
	runId: string,
	index: number,
): BackgroundTaskResult {
	const message = `Agent ${cause === "timeout" ? "timed out" : cause === "pause" ? "paused" : "stopped"} before it started.`;
	const result: BackgroundTaskResult = {
		agent: task.agent,
		output: message,
		success: false,
		exitCode: 1,
		error: message,
		preStartTerminalCause: cause,
		terminalOutcome: terminalOutcome({
			runId,
			index,
			success: false,
			error: message,
			sessionFile: task.sessionFile,
			interrupted: cause === "pause",
			timedOut: cause === "timeout",
			stopped: cause === "stop",
		}),
	};
	if (cause === "pause") result.interrupted = true;
	else if (cause === "timeout") result.timedOut = true;
	else result.stopped = true;
	return applyTaskResultMetadata(result, task);
}

export function failedResult(
	task: RunnerAgentTask,
	cause: unknown,
	runId: string,
	index: number,
): BackgroundTaskResult {
	const message = boundResultText(cause instanceof Error ? cause.message : String(cause), MAX_RESULT_ERROR_BYTES);
	const result: BackgroundTaskResult = {
		agent: task.agent,
		output: message,
		success: false,
		exitCode: 1,
		error: message,
		terminalOutcome: terminalOutcome({
			runId,
			index,
			success: false,
			error: message,
			sessionFile: task.sessionFile,
		}),
	};
	return applyTaskResultMetadata(result, task);
}

export function terminalizeRejectedStep(
	status: RunnerStatus,
	statusPath: string,
	eventsPath: string,
	index: number,
	cause: unknown,
): void {
	const step = status.steps[index];
	if (!step) return;
	const endedAt = Date.now();
	const message = boundResultText(cause instanceof Error ? cause.message : String(cause), MAX_RESULT_ERROR_BYTES);
	step.status = "failed";
	step.endedAt = endedAt;
	step.durationMs = Math.max(0, endedAt - (step.startedAt ?? endedAt));
	step.exitCode = 1;
	step.error = message;
	step.terminalOutcome = terminalOutcome({
		runId: status.runId,
		index,
		success: false,
		error: message,
		sessionFile: step.sessionFile,
	});
	step.currentTool = undefined;
	step.currentToolArgs = undefined;
	step.currentToolStartedAt = undefined;
	step.currentPath = undefined;
	step.activityState = undefined;
	try {
		writeStatus(statusPath, status);
		appendDiagnosticEvent(eventsPath, {
			type: "subagent.child.completed",
			ts: endedAt,
			runId: status.runId,
			index,
			agent: step.agent,
			success: false,
			error: message,
		});
	} catch (persistError) {
		reportAgentDiagnostic(`Failed to persist rejected Agent step ${String(index)}:`, persistError);
	}
}

export function applyTerminalResultToStep(step: RunnerStatusStep, result: BackgroundTaskResult, endedAt: number): void {
	step.status = result.interrupted ? "paused" : result.stopped ? "stopped" : result.success ? "complete" : "failed";
	step.endedAt = endedAt;
	step.durationMs = Math.max(0, endedAt - (step.startedAt ?? endedAt));
	step.exitCode = result.exitCode;
	step.error = result.error;
	step.sessionFile = result.sessionFile;
	step.model = result.model;
	step.contextUsage = result.contextUsage;
	step.thinking = result.thinking;
	step.attemptedModels = result.attemptedModels;
	step.modelAttempts = result.modelAttempts;
	step.cumulativeUsage = result.cumulativeUsage;
	step.terminalOutcome = result.terminalOutcome;
	step.totalCost = result.totalCost;
	step.timedOut = result.timedOut;
	step.stopped = result.stopped;
	step.turnBudget = result.turnBudget;
	step.turnBudgetExceeded = result.turnBudgetExceeded;
	step.wrapUpRequested = result.wrapUpRequested;
	step.toolBudget = result.toolBudget;
	step.toolBudgetBlocked = result.toolBudgetBlocked;
	step.transcriptPath = result.transcriptPath;
	step.transcriptError = result.transcriptError;
	step.finalOutput = boundResultText(result.output, MAX_RESULT_ERROR_BYTES);
	step.savedOutputPath = result.artifactPaths?.outputPath;
	step.currentTool = undefined;
	step.currentToolArgs = undefined;
	step.currentToolStartedAt = undefined;
	step.currentPath = undefined;
	step.activityState = undefined;
}

export function reconcileUnfinishedSteps(
	status: RunnerStatus,
	results: readonly BackgroundTaskResult[],
	eventsPath: string,
	endedAt: number,
): void {
	for (const [index, result] of results.entries()) {
		const step = status.steps[index];
		if (!step || (step.status !== "pending" && step.status !== "running")) continue;
		applyTerminalResultToStep(step, result, endedAt);
		const event: ChildCompletedDiagnosticEvent = {
			type: "subagent.child.completed",
			ts: endedAt,
			runId: status.runId,
			index,
			agent: step.agent,
			success: result.success,
		};
		if (result.error) event.error = result.error;
		appendDiagnosticEvent(eventsPath, event);
	}
}

export function failUndeliveredSteering(
	status: RunnerStatus,
	eventsPath: string,
	terminalState: BackgroundCompletion["state"],
	endedAt: number,
): void {
	const projection = steeringStatus(status);
	for (const request of projection.recent) {
		for (const target of request.targets) {
			if (target.state !== "scheduled" && target.state !== "routed") continue;
			const previousState = target.state;
			const reason = `Agent run ended as ${terminalState} before steering was delivered.`;
			updateSteeringTarget(projection, request.id, target.index, "failed", endedAt, { reason });
			appendDiagnosticEvent(eventsPath, {
				type: "subagent.steer.failed",
				ts: endedAt,
				runId: status.runId,
				requestId: request.id,
				index: target.index,
				message: reason,
				previousState,
			});
		}
	}
}

/**
 * Execute the resolved runner shape. This is deliberately small: single runs
 * invoke once; parallel runs are one bounded group and never form a sequence.
 */
export function runBackgroundWork(
	work: BackgroundRunnerWork,
	runTask: (task: RunnerAgentTask, index: number) => Effect.Effect<BackgroundTaskResult, unknown>,
	options: RunBackgroundWorkOptions,
): Effect.Effect<BackgroundTaskResult[], unknown> {
	const tasks = taskList(work);
	if (tasks.length > MAX_BACKGROUND_TASKS) {
		return Effect.fail(
			new RangeError(`Background runner supports at most ${MAX_BACKGROUND_TASKS} tasks per launch.`),
		);
	}
	const executeTask = (task: RunnerAgentTask, index: number): Effect.Effect<BackgroundTaskResult> => {
		const cause = options.terminalCause?.();
		if (cause) return Effect.succeed(stoppedResult(task, cause, options.runId, index));
		return runTask(task, index).pipe(
			Effect.catch((error) => Effect.succeed(failedResult(task, error, options.runId, index))),
		);
	};
	if (work.mode === "single") {
		return executeTask(work.task, 0).pipe(Effect.map((result) => [result]));
	}
	return Effect.forEach(tasks, executeTask, { concurrency: work.group.concurrency });
}

function parallelSummary(results: BackgroundTaskResult[]): string {
	return results
		.map((result, index) => {
			const state = result.success
				? "complete"
				: result.interrupted
					? "paused"
					: result.stopped
						? "stopped"
						: result.timedOut
							? "timed out"
							: "failed";
			return `=== Agent ${index + 1} (${result.agent}) · ${state} ===\n${result.output || result.error || "(no output)"}`;
		})
		.join("\n\n");
}

export function createBackgroundCompletion(
	config: BackgroundRunnerConfig,
	results: BackgroundTaskResult[],
	startedAt: number,
	endedAt: number,
	extras: Pick<BackgroundCompletion, "nestedChildren" | "worktree"> = {},
): BackgroundCompletion {
	const success = results.length > 0 && results.every((result) => result.success);
	const failed = results.some((result) => !result.success && !result.stopped && !result.interrupted);
	const stopped = !failed && results.some((result) => result.stopped);
	const interrupted = !failed && !stopped && results.some((result) => result.interrupted);
	const timedOut = results.some((result) => result.timedOut);
	const state = failed ? "failed" : stopped ? "stopped" : interrupted ? "paused" : success ? "complete" : "failed";
	const summary =
		config.work.mode === "single"
			? results[0]?.output || results[0]?.error || "(no output)"
			: parallelSummary(results);
	const completion: BackgroundCompletion = {
		id: config.id,
		runId: config.id,
		mode: config.work.mode,
		state,
		success,
		summary,
		results,
		cwd: config.cwd,
		asyncDir: config.asyncDir,
		startedAt,
		endedAt,
	};
	if (config.parentRunOrigin) completion.parentRunOrigin = config.parentRunOrigin;
	if (config.sessionId !== undefined) completion.sessionId = config.sessionId;
	if (stopped) completion.stopped = true;
	if (timedOut) completion.timedOut = true;
	if (interrupted) completion.interrupted = true;
	if (results.length === 1 && results[0]?.sessionFile) completion.sessionFile = results[0].sessionFile;
	if (extras.nestedChildren) completion.nestedChildren = extras.nestedChildren;
	if (extras.worktree) completion.worktree = extras.worktree;
	return completion;
}

function updateRunProjection(status: RunnerStatus): void {
	const active = status.steps.filter((step) => step.status === "running");
	status.activityState = active.some((step) => step.activityState === "needs_attention")
		? "needs_attention"
		: active.some((step) => step.activityState === "active_long_running")
			? "active_long_running"
			: undefined;
	status.lastActivityAt = active.reduce((latest, step) => Math.max(latest, step.lastActivityAt ?? 0), 0) || undefined;
	status.currentTool = active.length === 1 ? active[0]?.currentTool : undefined;
	status.currentToolStartedAt = active.length === 1 ? active[0]?.currentToolStartedAt : undefined;
	status.currentPath = active.length === 1 ? active[0]?.currentPath : undefined;
	status.turnCount = status.steps.reduce((sum, step) => sum + (step.turnCount ?? 0), 0);
	status.toolCount = status.steps.reduce((sum, step) => sum + (step.toolCount ?? 0), 0);
	const totals = status.steps.reduce(
		(acc, step) => {
			acc.input += step.tokens?.input ?? 0;
			acc.output += step.tokens?.output ?? 0;
			acc.total += step.tokens?.total ?? 0;
			return acc;
		},
		{ input: 0, output: 0, total: 0 },
	);
	status.totalTokens = totals.total > 0 ? totals : undefined;
	const totalCost = status.steps.reduce(
		(acc, step) => {
			acc.inputTokens += step.totalCost?.inputTokens ?? 0;
			acc.outputTokens += step.totalCost?.outputTokens ?? 0;
			acc.costUsd += step.totalCost?.costUsd ?? 0;
			return acc;
		},
		{ inputTokens: 0, outputTokens: 0, costUsd: 0 },
	);
	if (totalCost.inputTokens || totalCost.outputTokens || totalCost.costUsd) status.totalCost = totalCost;
	else delete status.totalCost;
	status.lastUpdate = Date.now();
}

const STATUS_PUBLISH_INTERVAL_MS = 100;
let pendingPublishedStatus: { statusPath: string; status: RunnerStatus } | undefined;
let statusPublishScheduled = false;
let statusPublishWake: (() => void) | undefined;
const statusUpdateObservers = new Map<string, (status: RunnerStatus) => void>();

function sendPublishedStatus(): void {
	const pending = pendingPublishedStatus;
	pendingPublishedStatus = undefined;
	statusPublishScheduled = false;
	if (!pending || !isRuntimeFunction(process.send) || process.connected === false) return;
	try {
		process.send(
			{
				type: SUBAGENT_ASYNC_STATUS_EVENT,
				asyncDir: path.dirname(pending.statusPath),
				status: pending.status,
			},
			() => {},
		);
	} catch {
		// The detached run remains authoritative on disk after its parent disconnects.
	}
}

function publishStatus(statusPath: string, status: RunnerStatus): void {
	if (!isRuntimeFunction(process.send) || process.connected === false) return;
	pendingPublishedStatus = { statusPath, status };
	if (
		status.state === "complete" ||
		status.state === "failed" ||
		status.state === "paused" ||
		status.state === "stopped"
	) {
		sendPublishedStatus();
		return;
	}
	if (statusPublishScheduled) return;
	statusPublishScheduled = true;
	statusPublishWake?.();
}

export function installStatusPublisher(): Effect.Effect<void, never, Scope.Scope> {
	return Effect.gen(function* () {
		if (!isRuntimeFunction(process.send) || process.connected === false) return;
		const wake = yield* Queue.sliding<void>(1);
		const offer = () => Queue.offerUnsafe(wake, undefined);
		yield* Effect.acquireRelease(
			Effect.sync(() => {
				statusPublishWake = offer;
				if (statusPublishScheduled) offer();
			}),
			() =>
				Effect.sync(() => {
					if (statusPublishWake === offer) statusPublishWake = undefined;
					sendPublishedStatus();
				}),
		);
		yield* Effect.forkScoped(
			Effect.forever(
				Queue.take(wake).pipe(
					Effect.andThen(Effect.sleep(STATUS_PUBLISH_INTERVAL_MS)),
					Effect.andThen(Effect.sync(sendPublishedStatus)),
				),
			),
		);
	});
}

export function writeStatus(statusPath: string, status: RunnerStatus): void {
	updateRunProjection(status);
	writePrivateAtomicJson(statusPath, status);
	notifyStatusUpdate(statusPath, status);
}

export function notifyStatusUpdate(statusPath: string, status: RunnerStatus): void {
	publishStatus(statusPath, status);
	try {
		statusUpdateObservers.get(statusPath)?.(status);
	} catch (error) {
		reportAgentDiagnostic(`Foreground Agent status observer failed for '${status.runId}':`, error);
	}
}

export function setStatusUpdateObserver(
	statusPath: string,
	observer: ((status: RunnerStatus) => void) | undefined,
): void {
	if (observer) statusUpdateObservers.set(statusPath, observer);
	else statusUpdateObservers.delete(statusPath);
}
