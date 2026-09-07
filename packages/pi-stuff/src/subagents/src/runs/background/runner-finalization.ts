/** Commit worktree, nested-run, result, process, and status evidence for a completed run. */

import * as path from "node:path";
import * as Effect from "effect/Effect";
import { runtimeErrorCode } from "../../../../shared/runtime-type.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import type { NestedRunSummary } from "../../shared/types.ts";
import {
	attachRootChildrenToSteps,
	nestedSummaryFromAsyncStatus,
	nestedWorkIncludesUser,
	projectNestedEventsAuthoritatively,
	writeNestedEvent,
} from "../shared/nested-events.ts";
import type { BackgroundRunnerConfig, BackgroundTaskResult } from "../shared/parallel-utils.ts";
import type { WorktreeSetup } from "../shared/worktree.ts";
import type { WriterProcess } from "./child-process-engine.ts";
import { closeSteerInbox, processSteerAcks, processSteerRequestsFromDir, steerRequestsDir } from "./control-channel.ts";
import type { BackgroundRunnerStatus as RunnerStatus } from "./initial-status.ts";
import { type ProcessTerminalCandidate, writeProcessTerminalCandidate } from "./process-terminal.ts";
import type { BackgroundRunControl } from "./runner-control.ts";
import { appendDiagnosticEvent } from "./runner-output.ts";
import {
	type BackgroundCompletion,
	createBackgroundCompletion,
	failUndeliveredSteering,
	reconcileUnfinishedSteps,
	taskList,
	writeStatus,
} from "./runner-state.ts";

export interface RunFinalizationHooks {
	beforeFinalPersistence?: (() => void | Promise<void>) | undefined;
	beforeWorktreeEvidence?: (() => void) | undefined;
	beforeResultPersistence?: (() => void) | undefined;
}

export interface PreparedWorktrees {
	setup: WorktreeSetup;
	operations: Pick<
		typeof import("../shared/worktree.ts"),
		"cleanupWorktrees" | "diffWorktrees" | "formatWorktreeDiffSummary" | "resolveWorktreeTaskCwd"
	>;
}

interface FinalizationInput {
	config: BackgroundRunnerConfig;
	status: RunnerStatus;
	statusPath: string;
	eventsPath: string;
	startedAt: number;
	results: BackgroundTaskResult[];
	worktreeSetup: PreparedWorktrees | undefined;
	control: BackgroundRunControl;
	hooks: RunFinalizationHooks;
}

function collectWorktreeEvidence(input: FinalizationInput): BackgroundCompletion["worktree"] {
	if (!input.worktreeSetup) return undefined;
	const {
		setup,
		operations: { cleanupWorktrees, diffWorktrees, formatWorktreeDiffSummary },
	} = input.worktreeSetup;
	const errors: string[] = [];
	let diffs: ReturnType<typeof diffWorktrees> = [];
	try {
		input.hooks.beforeWorktreeEvidence?.();
		diffs = diffWorktrees(
			setup,
			input.config.work.mode === "parallel" ? input.config.work.group.tasks.map((task) => task.agent) : [],
			path.join(input.config.asyncDir, "worktree-diffs"),
		);
	} catch (error) {
		errors.push(`Worktree evidence capture failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	let cleanup: ReturnType<typeof cleanupWorktrees> = { state: "partial", tasks: [], pruned: false };
	try {
		cleanup = cleanupWorktrees(setup);
	} catch (error) {
		errors.push(`Worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const evidence: NonNullable<BackgroundCompletion["worktree"]> = {
		diffs,
		summary: formatWorktreeDiffSummary(diffs),
		cleanup,
	};
	if (errors.length) evidence.error = errors.join("\n");
	return evidence;
}

function projectNestedCompletion(
	config: BackgroundRunnerConfig,
	status: RunnerStatus,
): Effect.Effect<{ nestedChildren: NestedRunSummary[] | undefined; committed: boolean }> {
	const nestedRoute = config.nestedRoute;
	if (!nestedRoute) return Effect.succeed({ nestedChildren: undefined, committed: false });
	return Effect.tryPromise({
		try: () => projectNestedEventsAuthoritatively(nestedRoute),
		catch: (error) => error,
	}).pipe(
		Effect.map((registry) => {
			const nestedChildren = registry.children.filter((child) => child.parentRunId === config.id);
			if (nestedWorkIncludesUser(nestedChildren)) {
				config.parentRunOrigin = "user";
				status.parentRunOrigin = "user";
			}
			attachRootChildrenToSteps(config.id, status.steps, nestedChildren);
			return { nestedChildren, committed: true };
		}),
		Effect.catch(() => Effect.succeed({ nestedChildren: undefined, committed: false })),
	);
}

function applyCompletionStatus(input: FinalizationInput, completion: BackgroundCompletion, endedAt: number): void {
	const { status, results, config } = input;
	status.state = completion.state;
	status.endedAt = endedAt;
	status.lastUpdate = endedAt;
	status.timedOut = completion.timedOut;
	status.stopped = completion.stopped;
	const failure =
		results.find((result) => !result.success && !result.stopped && !result.interrupted) ??
		results.find((result) => result.stopped && completion.stopped) ??
		results.find((result) => result.interrupted && completion.interrupted) ??
		results.find((result) => result.error);
	status.error = completion.success ? undefined : failure?.error;
	status.sessionFile = completion.sessionFile;
	status.outputFile = taskList(config.work).length === 1 ? path.join(config.asyncDir, "output-0.log") : undefined;
}

function commitResult(
	input: FinalizationInput,
	completion: BackgroundCompletion,
	endedAt: number,
): Effect.Effect<void, unknown> {
	const { config, status, control, hooks } = input;
	return Effect.gen(function* () {
		if (hooks.beforeFinalPersistence) {
			yield* Effect.tryPromise({ try: async () => hooks.beforeFinalPersistence?.(), catch: (error) => error });
		}
		yield* Effect.try({
			try: () => {
				try {
					closeSteerInbox(config.asyncDir, completion.state);
				} catch (error) {
					reportAgentDiagnostic(`Failed to close steering inbox for '${config.id}' during finalization:`, error);
				}
				try {
					processSteerRequestsFromDir(steerRequestsDir(config.asyncDir), (request) => {
						control.onSteer(request);
						return undefined;
					});
				} catch (error) {
					reportAgentDiagnostic(`Failed to scan final steering requests for '${config.id}':`, error);
				}
				if (status.parentRunOrigin === "user") completion.parentRunOrigin = "user";
				try {
					processSteerAcks(config.asyncDir, (ack) => control.onSteerAck(ack));
				} catch (error) {
					reportAgentDiagnostic(`Failed to scan final steering acknowledgments for '${config.id}':`, error);
				}
				failUndeliveredSteering(status, input.eventsPath, completion.state, endedAt);
				hooks.beforeResultPersistence?.();
				writePrivateAtomicJson(config.resultPath, completion);
			},
			catch: (error) => error,
		});
	});
}

function writeTerminalCandidate(config: BackgroundRunnerConfig, results: BackgroundTaskResult[]): void {
	if (!config.runnerProcessInstanceId) return;
	const writers: Record<string, WriterProcess[]> = {};
	const expectedWriters: Record<string, number> = {};
	for (const [index, result] of results.entries()) {
		writers[String(index)] = result.writerProcesses ?? [];
		expectedWriters[String(index)] = result.writerAttemptCount ?? 0;
	}
	const candidate: ProcessTerminalCandidate = {
		version: 1,
		runId: config.id,
		runnerProcessInstanceId: config.runnerProcessInstanceId,
		writers,
		expectedWriters,
	};
	if (config.revivalLease?.sessionFile) candidate.sessionFile = config.revivalLease.sessionFile;
	if (config.revivalLeaseToken) candidate.revivalLeaseToken = config.revivalLeaseToken;
	try {
		writeProcessTerminalCandidate(config.asyncDir, candidate);
	} catch (error) {
		reportAgentDiagnostic(`Failed to write process-terminal candidate for '${config.id}':`, error);
	}
}

function persistTerminalStatus(input: FinalizationInput, completion: BackgroundCompletion, endedAt: number): void {
	try {
		writeStatus(input.statusPath, input.status);
		appendDiagnosticEvent(input.eventsPath, {
			type: "subagent.run.completed",
			ts: endedAt,
			runId: input.config.id,
			state: completion.state,
			success: completion.success,
		});
	} catch (error) {
		reportAgentDiagnostic(
			`Failed to persist terminal Agent status for '${input.config.id}' after result commit:`,
			error,
		);
	}
}

function settleNestedRoute(input: FinalizationInput, endedAt: number): void {
	const { config, status } = input;
	if (!config.nestedRoute || !config.nestedSelf) return;
	try {
		const fallback: Parameters<typeof nestedSummaryFromAsyncStatus>[2] = {
			id: config.id,
			parentRunId: config.nestedSelf.parentRunId,
			depth: config.nestedSelf.depth,
			mode: status.mode,
			ts: endedAt,
		};
		if (config.nestedSelf.parentStepIndex !== undefined) fallback.parentStepIndex = config.nestedSelf.parentStepIndex;
		if (config.nestedSelf.path !== undefined) fallback.path = config.nestedSelf.path;
		const event: Parameters<typeof writeNestedEvent>[1] = {
			type: "subagent.nested.completed",
			ts: endedAt,
			parentRunId: config.nestedSelf.parentRunId,
			child: nestedSummaryFromAsyncStatus(status, config.asyncDir, fallback),
		};
		if (config.nestedSelf.parentStepIndex !== undefined) event.parentStepIndex = config.nestedSelf.parentStepIndex;
		writeNestedEvent(config.nestedRoute, event);
	} catch (error) {
		if (runtimeErrorCode(error) !== "ENOENT") {
			reportAgentDiagnostic(`Failed to settle nested route after '${config.id}' completed:`, error);
		}
	}
}

export function finalizeConfiguredRun(
	input: FinalizationInput,
): Effect.Effect<{ nestedProjectionCommitted: boolean }, unknown> {
	return Effect.gen(function* () {
		const worktree = collectWorktreeEvidence(input);
		const endedAt = Date.now();
		reconcileUnfinishedSteps(input.status, input.results, input.eventsPath, endedAt);
		const nested = yield* projectNestedCompletion(input.config, input.status);
		const extras: Pick<BackgroundCompletion, "nestedChildren" | "worktree"> = {};
		if (nested.committed) extras.nestedChildren = nested.nestedChildren ?? [];
		if (worktree) extras.worktree = worktree;
		const completion = createBackgroundCompletion(input.config, input.results, input.startedAt, endedAt, extras);
		applyCompletionStatus(input, completion, endedAt);
		yield* commitResult(input, completion, endedAt);
		writeTerminalCandidate(input.config, input.results);
		persistTerminalStatus(input, completion, endedAt);
		settleNestedRoute(input, endedAt);
		return { nestedProjectionCommitted: nested.committed };
	});
}
