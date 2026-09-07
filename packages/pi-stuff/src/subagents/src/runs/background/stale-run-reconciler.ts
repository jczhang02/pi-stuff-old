import * as fs from "node:fs";
import * as path from "node:path";
import { isRuntimeNumber, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { writeAtomicJson } from "../../shared/atomic-json.ts";
import { assertPrivateDirectory, errnoCode, validateOwnedRegularFile } from "../../shared/private-directory.ts";
import { type ProcessKillFn, probeProcessLiveness, readProcessStartIdentity } from "../../shared/process-identity.ts";
import { tryAcquireStatusMutationClaim } from "../../shared/status-mutation.ts";
import {
	type AsyncParallelGroupStatus,
	type AsyncStatus,
	type NestedRunSummary,
	RESULTS_DIR,
	type SubagentRunMode,
} from "../../shared/types.ts";
import { isNotFoundError, readStatus, isTerminalAsyncState as terminal } from "../../shared/utils.ts";
import {
	type NestedRoute,
	nestedSummaryFromAsyncStatus,
	projectNestedEvents,
	resolveNestedAsyncDir,
	writeNestedEvent,
} from "../shared/nested-events.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import {
	persistRecoveredProcessTerminal,
	processTerminalPath,
	processTerminalResumeDisposition,
	readProcessTerminal,
} from "./process-terminal.ts";
import { MAX_ASYNC_RESULT_BYTES, terminalStatusFromResult } from "./result-file.ts";
import { appendDiagnosticEvent } from "./runner-output.ts";
import { terminateOrphanWriterProcesses } from "./writer-process-registry.ts";

export type PidLiveness = "alive" | "dead" | "unknown";

interface StartedRunMetadata {
	runId: string;
	pid?: number;
	sessionId?: string;
	mode?: SubagentRunMode;
	agents?: string[];
	parallelGroups?: AsyncParallelGroupStatus[];
	startedAt?: number;
	sessionFile?: string;
	nestedRoute?: AsyncStatus["nestedRoute"];
}

interface ReconcileAsyncRunOptions {
	resultsDir?: string | undefined;
	kill?: ProcessKillFn | undefined;
	now?: (() => number) | undefined;
	startedRun?: StartedRunMetadata;
	missingStatusGraceMs?: number;
	staleAlivePidMs?: number;
	readProcessStartIdentity?: (pid: number) => string | undefined;
	runnerTerminationGraceMs?: number;
}

interface ReconcileAsyncRunResult {
	status: AsyncStatus | null;
	repaired: boolean;
	resultPath?: string;
	message?: string;
}

function readRunnerStartupDiagnostics(asyncDir: string): string | undefined {
	const stderrPath = path.join(asyncDir, "runner.stderr.log");
	const maxBytes = 64 * 1024;
	let content: string;
	try {
		const stat = fs.statSync(stderrPath);
		if (stat.size <= 0) return undefined;
		const fd = fs.openSync(stderrPath, "r");
		try {
			const bytesToRead = Math.min(stat.size, maxBytes);
			const start = Math.max(0, stat.size - bytesToRead);
			const buffer = Buffer.alloc(bytesToRead);
			fs.readSync(fd, buffer, 0, bytesToRead, start);
			content = buffer.toString("utf-8").trim();
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
	if (!content) return undefined;
	const lines = content.split(/\r?\n/).slice(-30).join("\n");
	return lines.length > 4000 ? `${lines.slice(-4000)}\n[stderr tail truncated]` : lines;
}

function safeRunId<Value>(value: Value): value is Value & string {
	return (
		isRuntimeString(value) &&
		value.length > 0 &&
		value.trim() === value &&
		!path.isAbsolute(value) &&
		!/[\\/]/.test(value) &&
		!value.includes("..")
	);
}

function safeDirectory(directory: string): boolean {
	try {
		const stat = fs.lstatSync(directory);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw error;
	}
}

function safeRegularFile(root: string, target: string, label: string, maxBytes: number): "missing" | "present" {
	const resolvedRoot = path.resolve(root);
	const resolvedTarget = path.resolve(target);
	if (path.dirname(resolvedTarget) !== resolvedRoot) {
		throw new Error(`${label} '${target}' is not a direct child of '${root}'.`);
	}
	try {
		validateOwnedRegularFile(resolvedTarget, maxBytes);
	} catch (error) {
		if (isNotFoundError(error)) return "missing";
		throw new Error(`${label} '${target}' is not a safe bounded regular file.`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		assertPrivateDirectory(resolvedRoot);
	} catch (error) {
		if (isNotFoundError(error)) return "missing";
		throw new Error(`${label} root '${root}' is not a safe directory.`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (path.dirname(fs.realpathSync(resolvedTarget)) !== fs.realpathSync(resolvedRoot)) {
		throw new Error(`${label} '${target}' escapes its storage root.`);
	}
	return "present";
}

/**
 * Make a committed semantic result durable in status.json before a result
 * watcher is allowed to delete the delivery artifact. Returns undefined while
 * either artifact is missing so the caller can retain and retry the result.
 */
export function repairTerminalStatusFromResult(
	asyncDir: string,
	resultPath: string,
	now = Date.now(),
	resultContent?: string,
): AsyncStatus | undefined {
	if (!safeDirectory(asyncDir)) return undefined;
	const claim = tryAcquireStatusMutationClaim(asyncDir);
	if (!claim) return undefined;
	try {
		const status = readStatus(asyncDir);
		if (!status) return undefined;
		const runId = path.basename(asyncDir);
		if (!safeRunId(runId) || status.runId !== runId || path.basename(resultPath) !== `${runId}.json`) {
			throw new Error(`Async result/status identity does not match run directory '${runId}'.`);
		}
		if (
			resultContent === undefined &&
			safeRegularFile(path.dirname(resultPath), resultPath, "Async result file", MAX_ASYNC_RESULT_BYTES) ===
				"missing"
		) {
			return undefined;
		}
		let proof: ReturnType<typeof readProcessTerminal>;
		if (status.lifecycleArtifactVersion === 3) {
			proof = readProcessTerminal(asyncDir, {
				runId,
				runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId,
			});
			if (proof?.state !== "observed") return status;
		}
		if (status.state !== "running" && status.state !== "queued") {
			if (!proof || status.processTerminal?.state === "observed") return status;
			const finalized = { ...status, processTerminal: proof };
			writeAtomicJson(path.join(asyncDir, "status.json"), finalized);
			return finalized;
		}
		const terminalStatus = terminalStatusFromResult(status, resultPath, runId, now, resultContent);
		if (!terminalStatus) return undefined;
		const finalized = proof ? { ...terminalStatus, processTerminal: proof } : terminalStatus;
		writeAtomicJson(path.join(asyncDir, "status.json"), finalized);
		return finalized;
	} finally {
		claim.release();
	}
}

function buildStartedStatus(asyncDir: string, startedRun: StartedRunMetadata, now: number): AsyncStatus {
	const startedAt = startedRun.startedAt ?? now;
	const agents = startedRun.agents?.length ? startedRun.agents : ["subagent"];
	const parallelGroups = normalizeParallelGroups(startedRun.parallelGroups, agents.length);
	const status: AsyncStatus = {
		runId: startedRun.runId || path.basename(asyncDir),
		mode: startedRun.mode ?? (agents.length > 1 ? "parallel" : "single"),
		state: "running",
		startedAt,
		lastUpdate: now,
		currentStep: 0,
		steps: agents.map((agent) => ({
			agent,
			status: "running" as const,
			startedAt,
		})),
	};
	if (startedRun.pid !== undefined) status.pid = startedRun.pid;
	if (startedRun.sessionId) status.sessionId = startedRun.sessionId;
	if (startedRun.nestedRoute) status.nestedRoute = startedRun.nestedRoute;
	if (parallelGroups.length) status.parallelGroups = parallelGroups;
	if (startedRun.sessionFile) status.sessionFile = startedRun.sessionFile;
	return status;
}

function buildFailedRepair(status: AsyncStatus, asyncDir: string, now: number, reason?: string) {
	const runId = status.runId || path.basename(asyncDir);
	const pid = isRuntimeNumber(status.pid) ? status.pid : "unknown";
	const baseMessage =
		reason ??
		`Async runner process ${pid} exited or disappeared before writing a result. Marked run failed by stale-run reconciliation.`;
	const diagnostics = readRunnerStartupDiagnostics(asyncDir);
	const message = diagnostics ? `${baseMessage}\n\nRunner stderr tail:\n${diagnostics}` : baseMessage;
	const steps = status.steps?.length ? status.steps : [{ agent: "subagent", status: "running" as const }];
	const repairedSteps = steps.map((step) =>
		step.status === "running" || step.status === "pending"
			? {
					...step,
					status: "failed" as const,
					activityState: undefined,
					currentTool: undefined,
					currentToolArgs: undefined,
					currentToolStartedAt: undefined,
					currentPath: undefined,
					endedAt: step.endedAt ?? now,
					durationMs:
						step.startedAt !== undefined && step.durationMs === undefined
							? Math.max(0, now - step.startedAt)
							: step.durationMs,
					exitCode: step.exitCode ?? 1,
					error: step.error ?? message,
				}
			: step,
	);
	const repairedStatus: AsyncStatus = {
		...status,
		state: "failed",
		activityState: undefined,
		currentTool: undefined,
		currentToolStartedAt: undefined,
		currentPath: undefined,
		lastUpdate: now,
		endedAt: now,
		steps: repairedSteps,
	};
	if (
		status.lifecycleArtifactVersion === 3 &&
		(!status.processTerminal || status.processTerminal.state === "pending")
	) {
		repairedStatus.processTerminal = {
			version: 1,
			state: "unknown",
			runId,
			runnerProcessInstanceId: "observer-unavailable",
			reason: "stale-repair",
		};
	}
	const resultAgent = repairedSteps[status.currentStep ?? 0]?.agent ?? repairedSteps[0]?.agent ?? "subagent";
	const result = {
		id: runId,
		agent: resultAgent,
		mode: status.mode,
		success: false,
		state: "failed" as const,
		summary: message,
		results: repairedSteps.map((step) => ({
			agent: step.agent,
			output: step.status === "complete" || step.status === "completed" ? "" : message,
			error: step.status === "complete" || step.status === "completed" ? undefined : (step.error ?? message),
			success: step.status === "complete" || step.status === "completed",
			model: step.model,
			attemptedModels: step.attemptedModels,
			modelAttempts: step.modelAttempts,
			sessionFile: step.sessionFile,
		})),
		exitCode: 1,
		timestamp: now,
		durationMs: Math.max(0, now - status.startedAt),
		asyncDir,
		sessionId: status.sessionId,
		sessionFile: status.sessionFile,
	};
	if (status.parentRunOrigin) Object.assign(result, { parentRunOrigin: status.parentRunOrigin });
	return {
		status: repairedStatus,
		message,
		result,
	};
}

function writeFailedRepair(
	asyncDir: string,
	status: AsyncStatus,
	resultPath: string,
	now: number,
	reason?: string,
): ReconcileAsyncRunResult {
	const repair = buildFailedRepair(status, asyncDir, now, reason);
	if (repair.status.lifecycleArtifactVersion === 3) {
		// Persist the physical proof against the semantic state we are about to
		// commit. Building it from the stale running status would incorrectly mark a
		// recoverable failed session as unavailable.
		const proof = persistRecoveredProcessTerminal(asyncDir, repair.status, now);
		repair.status = { ...repair.status, processTerminal: proof };
	}
	writeAtomicJson(resultPath, repair.result);
	writeAtomicJson(path.join(asyncDir, "status.json"), repair.status);
	appendDiagnosticEvent(path.join(asyncDir, "events.jsonl"), {
		type: "subagent.run.repaired_stale",
		ts: now,
		runId: repair.status.runId,
		pid: status.pid,
		resultPath,
		message: repair.message,
	});
	return { status: repair.status, repaired: true, resultPath, message: repair.message };
}

function alignProcessTerminalWithStatus(
	asyncDir: string,
	proof: NonNullable<AsyncStatus["processTerminal"]>,
	status: AsyncStatus,
): NonNullable<AsyncStatus["processTerminal"]> {
	const resumeDisposition = processTerminalResumeDisposition(status.state, status.sessionFile);
	if (proof.resumeDisposition === resumeDisposition) return proof;
	const aligned = { ...proof, resumeDisposition };
	writeAtomicJson(processTerminalPath(asyncDir), aligned);
	return aligned;
}

function* nestedRuns(children: NestedRunSummary[] | undefined): Generator<NestedRunSummary> {
	for (const child of children ?? []) {
		yield child;
		yield* nestedRuns(child.children);
		yield* nestedRuns(child.steps?.flatMap((step) => step.children ?? []));
	}
}

export function reconcileNestedAsyncDescendants(route: NestedRoute, options: ReconcileAsyncRunOptions = {}): void {
	const registry = projectNestedEvents(route);
	for (const run of nestedRuns(registry.children)) {
		if (run.state !== "running" && run.state !== "queued") continue;
		const asyncDir = resolveNestedAsyncDir(route.rootRunId, run);
		if (!asyncDir) continue;
		const result = reconcileAsyncRun(asyncDir, {
			...options,
			resultsDir: path.join(options.resultsDir ?? RESULTS_DIR, "nested", route.rootRunId),
		});
		const status = result.status;
		if (!status) continue;
		if (!result.repaired && !terminal(status.state)) continue;
		const ts = options.now?.() ?? Date.now();
		const fallback: Parameters<typeof nestedSummaryFromAsyncStatus>[2] = {
			id: run.id,
			parentRunId: run.parentRunId,
			depth: run.depth,
			ts,
		};
		if (run.mode !== undefined) fallback.mode = run.mode;
		if (run.parentStepIndex !== undefined) fallback.parentStepIndex = run.parentStepIndex;
		if (run.path !== undefined) fallback.path = run.path;
		const child = nestedSummaryFromAsyncStatus(status, asyncDir, fallback);
		const event: Parameters<typeof writeNestedEvent>[1] = {
			type: terminal(status.state) ? "subagent.nested.completed" : "subagent.nested.updated",
			ts,
			parentRunId: run.parentRunId,
			child,
		};
		if (run.parentStepIndex !== undefined) event.parentStepIndex = run.parentStepIndex;
		writeNestedEvent(route, event);
	}
}

export function checkPidLiveness(pid: number, kill: ProcessKillFn = process.kill): PidLiveness {
	const state = probeProcessLiveness(pid, kill);
	return state === true ? "alive" : state === false ? "dead" : "unknown";
}

export function reconcileAsyncRun(asyncDir: string, options: ReconcileAsyncRunOptions = {}): ReconcileAsyncRunResult {
	if (!safeDirectory(asyncDir)) return { status: null, repaired: false };
	const claim = tryAcquireStatusMutationClaim(asyncDir);
	if (!claim) {
		return {
			status: readStatus(asyncDir) ?? null,
			repaired: false,
			message: `Agent lifecycle status for '${path.basename(asyncDir)}' is being updated; recovery will retry.`,
		};
	}
	try {
		return reconcileAsyncRunWithStatusClaim(asyncDir, options);
	} finally {
		claim.release();
	}
}

type RetainRun = (message?: string, current?: AsyncStatus | null) => ReconcileAsyncRunResult;

function validatedRunId(asyncDir: string, status: AsyncStatus): string {
	const statusPath = path.join(asyncDir, "status.json");
	for (const [index, step] of (status.steps ?? []).entries()) {
		if (step.model !== undefined && !isRuntimeString(step.model))
			throw new Error(`Invalid async status file '${statusPath}': steps[${index}].model must be a string.`);
		if (step.thinking !== undefined && !isRuntimeString(step.thinking))
			throw new Error(`Invalid async status file '${statusPath}': steps[${index}].thinking must be a string.`);
	}
	const runId = path.basename(asyncDir);
	if (!safeRunId(runId) || status.runId !== runId)
		throw new Error(`Async status runId must exactly match its directory '${runId}'.`);
	return runId;
}

function reconcileLiveProcesses(
	asyncDir: string,
	effectiveStatus: AsyncStatus,
	statusExists: boolean,
	needsProcessRecovery: boolean,
	options: ReconcileAsyncRunOptions,
	now: number,
	retained: RetainRun,
): ReconcileAsyncRunResult | undefined {
	if ((!needsProcessRecovery && effectiveStatus.state !== "running") || !isRuntimeNumber(effectiveStatus.pid)) {
		return retained();
	}
	if (!statusExists) {
		const startedAt = options.startedRun?.startedAt ?? effectiveStatus.startedAt;
		if (now - startedAt < (options.missingStatusGraceMs ?? 1000)) return retained();
	}

	const runId = effectiveStatus.runId;
	const statusPath = path.join(asyncDir, "status.json");
	const kill = options.kill ?? process.kill;
	const readIdentity = options.readProcessStartIdentity ?? readProcessStartIdentity;
	let liveness = checkPidLiveness(effectiveStatus.pid, kill);
	if (liveness === "alive") {
		const currentIdentity = readIdentity(effectiveStatus.pid);
		if (!effectiveStatus.processStartIdentity || !currentIdentity) {
			return retained(
				`Runner '${runId}' has a live PID, but its process identity cannot be proven; retaining the run.`,
			);
		}
		if (currentIdentity !== effectiveStatus.processStartIdentity) liveness = "dead";
	}
	if (liveness === "unknown") return retained(`Runner '${runId}' process liveness is unknown; retaining the run.`);
	if (liveness === "alive") {
		const staleAfterMs = options.staleAlivePidMs ?? 24 * 60 * 60 * 1000;
		const lastUpdate = effectiveStatus.lastUpdate ?? effectiveStatus.startedAt;
		if (now - lastUpdate <= staleAfterMs) return retained();
		const requestedAt = effectiveStatus.runnerTerminationRequestedAt;
		if (requestedAt === undefined) {
			const identityBeforeTerm = readIdentity(effectiveStatus.pid);
			if (identityBeforeTerm !== effectiveStatus.processStartIdentity) {
				const currentLiveness = checkPidLiveness(effectiveStatus.pid, kill);
				if (identityBeforeTerm === undefined && currentLiveness !== "dead")
					return retained(`Runner '${runId}' identity became unverifiable before SIGTERM; retaining the run.`);
				liveness = "dead";
			}
			try {
				if (liveness !== "dead") kill(effectiveStatus.pid, "SIGTERM");
			} catch (error) {
				if (errnoCode(error) === "ESRCH") liveness = "dead";
				else return retained(`Unable to terminate stale runner '${runId}'; retaining the run.`);
			}
			if (liveness !== "dead") {
				const terminatingStatus = { ...effectiveStatus, runnerTerminationRequestedAt: now };
				writeAtomicJson(statusPath, terminatingStatus);
				return retained(`Requested graceful termination of stale runner '${runId}'.`, terminatingStatus);
			}
		} else if (now - requestedAt < (options.runnerTerminationGraceMs ?? 2_000)) {
			return retained(`Waiting for stale runner '${runId}' to exit after SIGTERM.`);
		} else {
			const identityBeforeKill = readIdentity(effectiveStatus.pid);
			if (identityBeforeKill !== effectiveStatus.processStartIdentity) {
				const currentLiveness = checkPidLiveness(effectiveStatus.pid, kill);
				if (identityBeforeKill === undefined && currentLiveness !== "dead")
					return retained(`Runner '${runId}' identity became unverifiable before SIGKILL; retaining the run.`);
				liveness = "dead";
			}
			try {
				if (liveness !== "dead") kill(effectiveStatus.pid, "SIGKILL");
			} catch (error) {
				if (errnoCode(error) !== "ESRCH")
					return retained(`Unable to kill stale runner '${runId}'; retaining the run.`);
			}
			const afterKill = liveness === "dead" ? "dead" : checkPidLiveness(effectiveStatus.pid, kill);
			const afterIdentity = afterKill === "alive" ? readIdentity(effectiveStatus.pid) : undefined;
			if (
				afterKill !== "dead" &&
				!(afterKill === "alive" && afterIdentity && afterIdentity !== effectiveStatus.processStartIdentity)
			) {
				return retained(`Stale runner '${runId}' has not exited after SIGKILL; retaining the run.`);
			}
		}
	}

	const writers = terminateOrphanWriterProcesses(asyncDir, kill);
	if (writers.remaining > 0)
		return retained(
			`Runner '${runId}' exited, but ${writers.remaining} writer process(es) remain live or unverifiable; the run stays active and counted.`,
		);
	return undefined;
}

function reconcileAsyncRunWithStatusClaim(
	asyncDir: string,
	options: ReconcileAsyncRunOptions,
): ReconcileAsyncRunResult {
	const now = options.now?.() ?? Date.now();
	const status = readStatus(asyncDir);
	const startedStatus =
		!status && options.startedRun ? buildStartedStatus(asyncDir, options.startedRun, now) : undefined;
	const effectiveStatus = status ?? startedStatus;
	if (!effectiveStatus) return { status: null, repaired: false };
	const runId = validatedRunId(asyncDir, effectiveStatus);
	const resultsDir = options.resultsDir ?? RESULTS_DIR;
	const resultPath = path.join(resultsDir, `${runId}.json`);
	const retained = (message?: string, current: AsyncStatus | null = status ?? null): ReconcileAsyncRunResult => {
		const result: ReconcileAsyncRunResult = { status: current, repaired: false, resultPath };
		if (message !== undefined) result.message = message;
		return result;
	};
	const resultPresent =
		safeRegularFile(resultsDir, resultPath, "Async result file", MAX_ASYNC_RESULT_BYTES) === "present";
	let durableProcessTerminal =
		effectiveStatus.lifecycleArtifactVersion === 3
			? readProcessTerminal(asyncDir, {
					runId,
					runnerProcessInstanceId: effectiveStatus.processTerminal?.runnerProcessInstanceId,
				})
			: undefined;
	if (durableProcessTerminal?.state === "observed" && terminal(effectiveStatus.state)) {
		durableProcessTerminal = alignProcessTerminalWithStatus(asyncDir, durableProcessTerminal, effectiveStatus);
		const finalized = { ...effectiveStatus, processTerminal: durableProcessTerminal };
		const changed = JSON.stringify(effectiveStatus.processTerminal) !== JSON.stringify(durableProcessTerminal);
		if (changed) writeAtomicJson(path.join(asyncDir, "status.json"), finalized);
		const result: ReconcileAsyncRunResult = {
			status: finalized,
			repaired: changed,
		};
		if (resultPresent) result.resultPath = resultPath;
		if (changed) result.message = "Merged durable Agent process-terminal proof into terminal status.";
		return result;
	}
	if (resultPresent) {
		const terminalStatus =
			effectiveStatus.state === "running" || effectiveStatus.state === "queued"
				? effectiveStatus.lifecycleArtifactVersion !== 3 || durableProcessTerminal?.state === "observed"
					? terminalStatusFromResult(effectiveStatus, resultPath, runId, now)
					: undefined
				: undefined;
		if (terminalStatus) {
			const alignedProof = durableProcessTerminal
				? alignProcessTerminalWithStatus(asyncDir, durableProcessTerminal, terminalStatus)
				: undefined;
			const finalized = alignedProof ? { ...terminalStatus, processTerminal: alignedProof } : terminalStatus;
			writeAtomicJson(path.join(asyncDir, "status.json"), finalized);
			return {
				status: finalized,
				repaired: true,
				resultPath,
				message: "Existing async result file was used to repair stale running status.",
			};
		}
		if (effectiveStatus.lifecycleArtifactVersion !== 3 || durableProcessTerminal?.state === "observed") {
			return retained(
				undefined,
				durableProcessTerminal && effectiveStatus.processTerminal?.state !== "observed"
					? { ...effectiveStatus, processTerminal: durableProcessTerminal }
					: effectiveStatus,
			);
		}
	}

	const needsProcessRecovery =
		effectiveStatus.lifecycleArtifactVersion === 3 && durableProcessTerminal?.state !== "observed";
	const retainedRun = reconcileLiveProcesses(
		asyncDir,
		effectiveStatus,
		status !== null,
		needsProcessRecovery,
		options,
		now,
		retained,
	);
	if (retainedRun) return retainedRun;
	// The runner may commit its semantic result while liveness/reaping checks are
	// in progress. Re-read the exact result now, immediately before any synthetic
	// failure could overwrite it, and always prefer a valid semantic result.
	const latestResultPresent =
		safeRegularFile(resultsDir, resultPath, "Async result file", MAX_ASYNC_RESULT_BYTES) === "present";
	if (latestResultPresent) {
		const semantic =
			effectiveStatus.state === "running" || effectiveStatus.state === "queued"
				? terminalStatusFromResult(effectiveStatus, resultPath, runId, now)
				: effectiveStatus;
		if (!semantic) return retained(undefined, effectiveStatus);
		if (effectiveStatus.lifecycleArtifactVersion === 3) {
			durableProcessTerminal = persistRecoveredProcessTerminal(asyncDir, semantic, now);
		}
		const finalized = durableProcessTerminal ? { ...semantic, processTerminal: durableProcessTerminal } : semantic;
		writeAtomicJson(path.join(asyncDir, "status.json"), finalized);
		return {
			status: finalized,
			repaired: true,
			resultPath,
			message: durableProcessTerminal
				? "Recovered terminal Agent process proof after confirming runner and writers were gone."
				: "A concurrently committed Agent result was used instead of stale failure repair.",
		};
	}
	if (effectiveStatus.lifecycleArtifactVersion === 3 && terminal(effectiveStatus.state)) {
		durableProcessTerminal = persistRecoveredProcessTerminal(asyncDir, effectiveStatus, now);
	}
	if (durableProcessTerminal && terminal(effectiveStatus.state)) {
		const finalized = { ...effectiveStatus, processTerminal: durableProcessTerminal };
		writeAtomicJson(path.join(asyncDir, "status.json"), finalized);
		return { status: finalized, repaired: true, resultPath };
	}
	return writeFailedRepair(asyncDir, effectiveStatus, resultPath, now);
}
