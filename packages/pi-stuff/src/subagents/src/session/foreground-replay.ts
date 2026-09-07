import * as fs from "node:fs";
import * as path from "node:path";
import { type JsonValue, parseJsonValue } from "../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import { terminateOrphanWriterProcesses } from "../runs/background/writer-process-registry.ts";
import { readForegroundOwnerExitAsync } from "../runs/foreground/owner-exit.ts";
import { parseSubagentCapabilityCeiling } from "../runs/shared/capability-ceiling.ts";
import { resolvePersistedNestedRoute } from "../runs/shared/nested-events.ts";
import { sanitizeSummary } from "../runs/shared/nested-summary.ts";
import { mapConcurrent } from "../runs/shared/parallel-utils.ts";
import { writePrivateAtomicJsonAsync } from "../shared/atomic-json.ts";
import { readBoundedOwnedFileSnapshotAsync } from "../shared/private-directory.ts";
import { readProcessStartIdentityAsync } from "../shared/process-identity.ts";
import { type SessionCompatibilityScope, sessionArtifactMatches } from "../shared/session-identity.ts";
import { tryAcquireStatusMutationClaimAsync } from "../shared/status-mutation.ts";
import type {
	AgentContextUsage,
	AsyncJobStep,
	AsyncStatus,
	Details,
	ForegroundResumeChild,
	ForegroundResumeRun,
	SingleResult,
} from "../shared/types.ts";
import { readStatusAsync } from "../shared/utils.ts";
import { projectedCumulativeUsage, projectedTerminalOutcome } from "./current-agents-projection-normalization.ts";

const MAX_REPLAYED_FOREGROUND_RUNS = 200;
const MAX_REPLAYED_CHILDREN = 20;
const MAX_FOREGROUND_COMPLETION_BYTES = 32 * 1024 * 1024;
const FOREGROUND_OWNER_CRASH = "Foreground Agent crashed because its owning Pi process exited.";

type ForegroundReplayKey =
	| keyof AgentContextUsage
	| keyof AsyncJobStep
	| keyof AsyncStatus
	| keyof Details
	| keyof ForegroundResumeChild
	| keyof SingleResult;
type RawReplayFields = { readonly [Key in ForegroundReplayKey]?: JsonValue };

type ForegroundReplayRecord = RawReplayFields & {
	readonly details?: JsonValue;
	readonly id?: JsonValue;
	readonly message?: JsonValue;
	readonly output?: JsonValue;
	readonly role?: JsonValue;
	readonly success?: JsonValue;
	readonly summary?: JsonValue;
	readonly timestamp?: JsonValue;
	readonly toolName?: JsonValue;
	readonly type?: JsonValue;
};

function record<Value>(value: Value): ForegroundReplayRecord {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return {};
	// SAFETY: callers read only the explicitly declared raw fields and validate each before projection.
	return value as Value & ForegroundReplayRecord;
}

function displayString<Value>(value: Value, maxChars: number): string | undefined {
	if (!isRuntimeString(value) || !value.trim()) return undefined;
	return value.length > maxChars ? value.slice(0, maxChars) : value;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x1f || codeUnit === 0x7f) return true;
	}
	return false;
}

function exactString<Value>(value: Value, maxChars: number): string | undefined {
	if (!isRuntimeString(value) || !value.trim() || value.length > maxChars || hasControlCharacter(value)) {
		return undefined;
	}
	return value;
}

function finiteInteger<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) && Number.isInteger(value) ? value : undefined;
}

function agentContextUsage<Value>(value: Value): AgentContextUsage | undefined {
	const usage = record(value);
	const tokens = finiteInteger(usage.tokens);
	const contextWindow = finiteInteger(usage.contextWindow);
	return tokens !== undefined && tokens >= 0 && contextWindow !== undefined && contextWindow > 0
		? { tokens, contextWindow }
		: undefined;
}

function entryTime<Value>(value: Value): number {
	if (!isRuntimeString(value)) return 0;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

function childStatus(child: ForegroundReplayRecord): ForegroundResumeChild["status"] {
	if (child.stopped === true) return "stopped";
	if (child.interrupted === true) return "paused";
	if (child.crashed === true) return "failed";
	return finiteInteger(child.exitCode) === 0 ? "completed" : "failed";
}

function replayChild<Value>(value: Value, index: number, updatedAt: number): ForegroundResumeChild | undefined {
	const child = record(value);
	const agent = exactString(child.agent, 256);
	const task = displayString(child.task, 16 * 1024);
	const exitCode = finiteInteger(child.exitCode);
	if (!agent || !task || exitCode === undefined) return undefined;
	const context = child.context === "fresh" || child.context === "fork" ? child.context : undefined;
	const contextUsage = agentContextUsage(child.contextUsage);
	const cumulativeUsage = projectedCumulativeUsage(child) ?? undefined;
	const terminalOutcome = projectedTerminalOutcome(child) ?? undefined;
	const sessionFile = exactString(child.sessionFile, 4_096);
	if (child.sessionFile !== undefined && !sessionFile) return undefined;
	if (sessionFile && !path.isAbsolute(sessionFile)) return undefined;
	const childCwd = exactString(child.cwd, 4_096);
	if (child.cwd !== undefined && !childCwd) return undefined;
	if (childCwd && !path.isAbsolute(childCwd)) return undefined;
	const model = exactString(child.model, 256);
	if (child.model !== undefined && !model) return undefined;
	const thinking = exactString(child.thinking, 64);
	if (child.thinking !== undefined && !thinking) return undefined;
	const error = displayString(child.error, 8 * 1024);
	const finalOutput = displayString(child.finalOutput, 32 * 1024);
	const transcriptPath = exactString(child.transcriptPath, 4_096);
	if (child.transcriptPath !== undefined && !transcriptPath) return undefined;
	if (transcriptPath && !path.isAbsolute(transcriptPath)) return undefined;
	const transcriptError = displayString(child.transcriptError, 8 * 1024);
	const launchContractDigest = exactString(child.launchContractDigest, 256);
	if (child.launchContractDigest !== undefined && !launchContractDigest) return undefined;
	let capabilityCeiling: ForegroundResumeChild["capabilityCeiling"];
	if (child.capabilityCeiling !== undefined) {
		try {
			capabilityCeiling = parseSubagentCapabilityCeiling(
				child.capabilityCeiling,
				"replayed foreground capability ceiling",
			);
		} catch {
			return undefined;
		}
	}
	const children = Array.isArray(child.children)
		? child.children
				.map((nested) => sanitizeSummary(nested))
				.filter((nested): nested is NonNullable<typeof nested> => Boolean(nested))
		: undefined;
	const replayed: ForegroundResumeChild = {
		agent,
		index,
		task,
		status: childStatus(child),
		exitCode,
		updatedAt,
	};
	if (context) replayed.context = context;
	if (contextUsage) replayed.contextUsage = contextUsage;
	if (cumulativeUsage) replayed.cumulativeUsage = cumulativeUsage;
	if (terminalOutcome) replayed.terminalOutcome = terminalOutcome;
	if (child.crashed === true) replayed.crashed = true;
	if (sessionFile) replayed.sessionFile = sessionFile;
	if (childCwd) replayed.cwd = childCwd;
	if (model) replayed.model = model;
	if (thinking) replayed.thinking = thinking;
	if (error) replayed.error = error;
	if (finalOutput) replayed.finalOutput = finalOutput;
	if (transcriptPath) replayed.transcriptPath = transcriptPath;
	if (transcriptError) replayed.transcriptError = transcriptError;
	if (launchContractDigest) replayed.launchContractDigest = launchContractDigest;
	if (capabilityCeiling) replayed.capabilityCeiling = capabilityCeiling;
	if (children?.length) replayed.children = children;
	return replayed;
}

/** Rebuild bounded foreground resume/report state from subagent tool results on the active session branch. */
export function replayForegroundRuns(entries: Iterable<unknown>, sessionId: string): Map<string, ForegroundResumeRun> {
	const runs = new Map<string, ForegroundResumeRun>();
	for (const value of entries) {
		const entry = record(value);
		if (entry.type !== "message") continue;
		const message = record(entry.message);
		if (message.role !== "toolResult" || message.toolName !== "subagent") continue;
		const details = record(message.details);
		const runId = exactString(details.runId, 256);
		const cwd = exactString(details.cwd, 4_096);
		const mode = details.mode === "single" || details.mode === "parallel" ? details.mode : undefined;
		const results = Array.isArray(details.results) ? details.results : undefined;
		if (
			!runId ||
			!cwd ||
			!path.isAbsolute(cwd) ||
			!mode ||
			!results?.length ||
			results.length > MAX_REPLAYED_CHILDREN
		) {
			continue;
		}
		const updatedAt = entryTime(entry.timestamp);
		const children = results
			.map((child, index) => replayChild(child, index, updatedAt))
			.filter((child): child is ForegroundResumeChild => child !== undefined);
		if (children.length !== results.length) continue;
		runs.set(runId, { runId, mode, cwd, sessionId, updatedAt, children });
	}
	return new Map(
		[...runs.entries()]
			.sort(([, left], [, right]) => right.updatedAt - left.updatedAt || right.runId.localeCompare(left.runId))
			.slice(0, MAX_REPLAYED_FOREGROUND_RUNS),
	);
}

function hasErrorCode<ErrorValue>(error: ErrorValue, code: string): boolean {
	return isRuntimeObject(error) && error !== null && "code" in error && error.code === code;
}

async function ownerLivenessAsync(status: AsyncStatus): Promise<"alive" | "dead" | "unknown"> {
	const pid = status.pid;
	if (!isRuntimeNumber(pid) || !Number.isSafeInteger(pid) || pid <= 0 || !status.processStartIdentity)
		return "unknown";
	const current = await readProcessStartIdentityAsync(pid);
	if (current) return current === status.processStartIdentity ? "alive" : "dead";
	try {
		process.kill(pid, 0);
		return "unknown";
	} catch (error) {
		return hasErrorCode(error, "ESRCH") ? "dead" : "unknown";
	}
}

type RuntimeStep = NonNullable<AsyncStatus["steps"]>[number];
type RuntimeReplayStep = RuntimeStep & { readonly cwd?: unknown };

function foregroundChildStatus(status: RuntimeStep["status"]): ForegroundResumeChild["status"] | undefined {
	if (status === "complete" || status === "completed") return "completed";
	if (status === "paused") return "paused";
	if (status === "stopped") return "stopped";
	if (status === "failed") return "failed";
	if (status === "running" || status === "pending" || status === "queued") return "detached";
	return undefined;
}

function finiteTimestamp<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function runtimeChild(step: RuntimeReplayStep, index: number, updatedAt: number): ForegroundResumeChild | undefined {
	const agent = exactString(step.agent, 256);
	const status = foregroundChildStatus(step.status);
	if (!agent || !status) return undefined;
	const description = displayString(step.label, 4_096);
	const task = displayString(step.task, 16 * 1024) ?? description;
	const context = step.context === "fresh" || step.context === "fork" ? step.context : undefined;
	const contextUsage = agentContextUsage(step.contextUsage);
	const cumulativeUsage = projectedCumulativeUsage(step) ?? undefined;
	const terminalOutcome = projectedTerminalOutcome(step) ?? undefined;
	const childCwd = exactString(step.cwd, 4_096);
	if (step.cwd !== undefined && (!childCwd || !path.isAbsolute(childCwd))) return undefined;
	const sessionFile = exactString(step.sessionFile, 4_096);
	if (step.sessionFile !== undefined && (!sessionFile || !path.isAbsolute(sessionFile))) return undefined;
	const model = exactString(step.model, 256);
	if (step.model !== undefined && !model) return undefined;
	const thinking = exactString(step.thinking, 64);
	if (step.thinking !== undefined && !thinking) return undefined;
	const launchContractDigest = exactString(step.launchContractDigest, 256);
	if (step.launchContractDigest !== undefined && !launchContractDigest) return undefined;
	let capabilityCeiling: ForegroundResumeChild["capabilityCeiling"];
	if (step.capabilityCeiling !== undefined) {
		try {
			capabilityCeiling = parseSubagentCapabilityCeiling(
				step.capabilityCeiling,
				"runtime foreground capability ceiling",
			);
		} catch {
			return undefined;
		}
	}
	const transcriptPath = exactString(step.transcriptPath, 4_096);
	if (step.transcriptPath !== undefined && (!transcriptPath || !path.isAbsolute(transcriptPath))) return undefined;
	const recentOutput = Array.isArray(step.recentOutput)
		? displayString(
				step.recentOutput
					.filter((line): line is string => isRuntimeString(line))
					.slice(-50)
					.join("\n"),
				32 * 1024,
			)
		: undefined;
	const children = Array.isArray(step.children)
		? step.children
				.map((child) => sanitizeSummary(child))
				.filter((child): child is NonNullable<typeof child> => Boolean(child))
		: undefined;
	const activityState =
		step.activityState === "active_long_running" || step.activityState === "needs_attention"
			? step.activityState
			: undefined;
	const currentTool = displayString(step.currentTool, 256);
	const currentPath = displayString(step.currentPath, 4_096);
	const exitCode = finiteInteger(step.exitCode);
	const turnCount = finiteInteger(step.turnCount);
	const toolCount = finiteInteger(step.toolCount);
	const error = displayString(step.error, 8 * 1024);
	const transcriptError = displayString(step.transcriptError, 8 * 1024);
	const lastActivityAt = finiteTimestamp(step.lastActivityAt);
	const currentToolStartedAt = finiteTimestamp(step.currentToolStartedAt);
	const child: ForegroundResumeChild = {
		agent,
		index,
		status,
		updatedAt: finiteTimestamp(step.endedAt) ?? updatedAt,
	};
	if (description) child.description = description;
	if (task) child.task = task;
	if (context) child.context = context;
	if (contextUsage) child.contextUsage = contextUsage;
	if (cumulativeUsage) child.cumulativeUsage = cumulativeUsage;
	if (terminalOutcome) child.terminalOutcome = terminalOutcome;
	if (step.agentStatus === "crashed") child.crashed = true;
	if (sessionFile) child.sessionFile = sessionFile;
	if (childCwd) child.cwd = childCwd;
	if (model) child.model = model;
	if (thinking) child.thinking = thinking;
	if (launchContractDigest) child.launchContractDigest = launchContractDigest;
	if (capabilityCeiling) child.capabilityCeiling = capabilityCeiling;
	if (exitCode !== undefined) child.exitCode = exitCode;
	if (error) child.error = error;
	if (recentOutput) child.finalOutput = recentOutput;
	if (transcriptPath) child.transcriptPath = transcriptPath;
	if (transcriptError) child.transcriptError = transcriptError;
	if (children?.length) child.children = children;
	if (activityState) child.activityState = activityState;
	if (lastActivityAt !== undefined) child.lastActivityAt = lastActivityAt;
	if (currentTool) child.currentTool = currentTool;
	if (currentToolStartedAt !== undefined) child.currentToolStartedAt = currentToolStartedAt;
	if (currentPath) child.currentPath = currentPath;
	if (turnCount !== undefined && turnCount >= 0) child.turnCount = turnCount;
	if (toolCount !== undefined && toolCount >= 0) child.toolCount = toolCount;
	return child;
}

function runFromStatus(status: AsyncStatus, asyncDir: string): ForegroundResumeRun | undefined {
	const runId = exactString(status.runId, 256);
	const mode = status.mode === "single" || status.mode === "parallel" ? status.mode : undefined;
	const cwd = exactString(status.cwd, 4_096);
	const sessionId = exactString(status.sessionId, 4_096);
	const steps = Array.isArray(status.steps) ? status.steps : undefined;
	if (
		!runId ||
		!mode ||
		!cwd ||
		!path.isAbsolute(cwd) ||
		!sessionId ||
		!steps?.length ||
		steps.length > MAX_REPLAYED_CHILDREN
	)
		return undefined;
	const updatedAt =
		finiteTimestamp(status.endedAt) ?? finiteTimestamp(status.lastUpdate) ?? finiteTimestamp(status.startedAt) ?? 0;
	const children = steps
		.map((step, index) => runtimeChild(step, index, updatedAt))
		.filter((child): child is ForegroundResumeChild => child !== undefined);
	if (children.length !== steps.length) return undefined;
	const nestedRoute = resolvePersistedNestedRoute(status.nestedRoute, runId);
	const run: ForegroundResumeRun = {
		runId,
		mode,
		cwd,
		asyncDir,
		sessionId,
		updatedAt,
		children,
	};
	if (nestedRoute) run.nestedRoute = nestedRoute;
	return run;
}

async function applyCompletionToStatusAsync(
	status: AsyncStatus,
	completionPath: string,
): Promise<AsyncStatus | undefined> {
	try {
		const snapshot = await readBoundedOwnedFileSnapshotAsync(completionPath, MAX_FOREGROUND_COMPLETION_BYTES);
		return applyCompletionValue(status, record(parseJsonValue(snapshot.text)), completionPath);
	} catch {
		return undefined;
	}
}

function applyCompletionValue(
	status: AsyncStatus,
	completion: ForegroundReplayRecord,
	completionPath: string,
): AsyncStatus | undefined {
	const identities = [completion.runId, completion.id].filter((value) => value !== undefined);
	if (
		identities.length === 0 ||
		identities.some((value) => value !== status.runId) ||
		!Array.isArray(completion.results) ||
		completion.results.length !== status.steps?.length
	)
		return undefined;
	const completionResults = completion.results;
	for (const value of completionResults) {
		const result = record(value);
		for (const field of ["sessionFile", "transcriptPath"] as const) {
			if (result[field] === undefined) continue;
			const locator = exactString(result[field], 4_096);
			if (!locator || !path.isAbsolute(locator)) return undefined;
		}
	}
	const state =
		completion.state === "complete" ||
		completion.state === "failed" ||
		completion.state === "paused" ||
		completion.state === "stopped"
			? completion.state
			: undefined;
	if (!state) return undefined;
	const endedAt =
		isRuntimeNumber(completion.endedAt) && Number.isFinite(completion.endedAt) ? completion.endedAt : Date.now();
	const steps = (status.steps ?? []).map((step, index) => {
		const result = record(completionResults[index]);
		const displayOutput =
			isRuntimeString(result.output) && result.output ? displayString(result.output, 32 * 1024) : undefined;
		const childState =
			result.stopped === true
				? ("stopped" as const)
				: result.interrupted === true
					? ("paused" as const)
					: result.success === true
						? ("complete" as const)
						: ("failed" as const);
		const children = Array.isArray(result.children)
			? result.children
					.map((child) => sanitizeSummary(child))
					.filter((child): child is NonNullable<typeof child> => Boolean(child))
			: step.children;
		return {
			...step,
			status: childState,
			endedAt: step.endedAt ?? endedAt,
			exitCode: finiteInteger(result.exitCode) ?? (childState === "complete" ? 0 : 1),
			error: displayString(result.error, 8 * 1024) ?? step.error,
			sessionFile: exactString(result.sessionFile, 4_096) ?? step.sessionFile,
			transcriptPath: exactString(result.transcriptPath, 4_096) ?? step.transcriptPath,
			transcriptError: displayString(result.transcriptError, 8 * 1024) ?? step.transcriptError,
			recentOutput: displayOutput ? [displayOutput] : step.recentOutput,
			cumulativeUsage: projectedCumulativeUsage(result) ?? step.cumulativeUsage,
			terminalOutcome: projectedTerminalOutcome(result) ?? step.terminalOutcome,
			children,
			activityState: undefined,
			currentTool: undefined,
			currentToolStartedAt: undefined,
			currentPath: undefined,
		};
	});
	const merged: AsyncStatus = {
		...status,
		state,
		endedAt: status.endedAt ?? endedAt,
		lastUpdate: endedAt,
		error: state === "complete" ? undefined : (displayString(completion.summary, 8 * 1024) ?? status.error),
		steps,
	};
	return runFromStatus(merged, path.dirname(completionPath)) ? merged : undefined;
}

async function recoverCrashedForegroundStatusAsync(
	asyncDir: string,
	status: AsyncStatus,
	terminateWriters: typeof terminateOrphanWriterProcesses = terminateOrphanWriterProcesses,
): Promise<AsyncStatus> {
	if (status.state !== "running" && status.state !== "queued") return status;
	const semanticOwnerExit = await readForegroundOwnerExitAsync(asyncDir, status.runId);
	if (!semanticOwnerExit && (await ownerLivenessAsync(status)) !== "dead") return status;
	const writers = terminateWriters(asyncDir);
	if (writers.remaining !== 0) return status;
	const endedAt = Date.now();
	const failure = semanticOwnerExit?.error ?? FOREGROUND_OWNER_CRASH;
	const recovered: AsyncStatus = {
		...status,
		state: "failed",
		error: failure,
		endedAt,
		lastUpdate: endedAt,
		activityState: undefined,
		currentTool: undefined,
		currentToolStartedAt: undefined,
		currentPath: undefined,
		steps: status.steps?.map((step) =>
			step.status === "running" || step.status === "pending"
				? {
						...step,
						status: "failed" as const,
						agentStatus: "crashed" as const,
						exitCode: 1,
						error: failure,
						endedAt,
						activityState: undefined,
						currentTool: undefined,
						currentToolStartedAt: undefined,
						currentPath: undefined,
					}
				: step,
		),
	};
	await writePrivateAtomicJsonAsync(path.join(asyncDir, "status.json"), recovered);
	return recovered;
}

/**
 * Advance one cold foreground recovery by one nonblocking TERM/KILL/absence
 * step. The tracker calls this repeatedly so an orphan that ignores TERM does
 * not remain detached forever after the one session-start scan.
 */
export async function refreshForegroundRuntimeRunAsync(
	run: ForegroundResumeRun,
	options: { readonly terminateWriters?: typeof terminateOrphanWriterProcesses } = {},
): Promise<boolean> {
	if (!run.asyncDir || path.basename(run.asyncDir) !== run.runId) return false;
	const claim = await tryAcquireStatusMutationClaimAsync(run.asyncDir);
	if (!claim) return false;
	try {
		let status = await readStatusAsync(run.asyncDir);
		if (!status || status.runId !== run.runId || !runFromStatus(status, run.asyncDir)) return false;
		const previousState = status.state;
		const completed = await applyCompletionToStatusAsync(status, path.join(run.asyncDir, "completion.json"));
		if (completed) {
			status = completed;
			if (
				(previousState === "running" || previousState === "queued") &&
				status.state !== "running" &&
				status.state !== "queued"
			)
				await writePrivateAtomicJsonAsync(path.join(run.asyncDir, "status.json"), status);
		} else {
			status = await recoverCrashedForegroundStatusAsync(run.asyncDir, status, options.terminateWriters);
		}
		const refreshed = runFromStatus(status, run.asyncDir);
		if (!refreshed) return false;
		const normalizedSessionId = run.sessionId;
		Object.assign(run, refreshed, normalizedSessionId ? { sessionId: normalizedSessionId } : {});
		return previousState !== status.state;
	} finally {
		await claim.release();
	}
}

/** Async startup projection; disk remains recovery state and never blocks the Host event loop. */
export async function observeForegroundRuntimeRunsAsync(
	rootDirectory: string,
	sessionScope: SessionCompatibilityScope,
	runtimeDirectories?: readonly string[],
): Promise<Map<string, ForegroundResumeRun>> {
	let directories: string[];
	if (runtimeDirectories !== undefined) {
		const root = path.resolve(rootDirectory);
		directories = [...new Set(runtimeDirectories.map((directory) => path.resolve(directory)))].filter(
			(directory) => path.dirname(directory) === root && /^[a-f0-9]{12}$/u.test(path.basename(directory)),
		);
	} else {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(rootDirectory, { withFileTypes: true });
		} catch (error) {
			if (hasErrorCode(error, "ENOENT")) return new Map();
			throw error;
		}
		directories = entries
			.filter((entry) => entry.isDirectory() && /^[a-f0-9]{12}$/u.test(entry.name))
			.map((entry) => path.join(rootDirectory, entry.name));
	}
	const candidates = (
		await mapConcurrent(directories, 16, async (asyncDir) => {
			try {
				const stat = await fs.promises.lstat(asyncDir);
				return stat.isDirectory() && !stat.isSymbolicLink() ? { asyncDir, mtimeMs: stat.mtimeMs } : undefined;
			} catch {
				return undefined;
			}
		})
	)
		.filter((entry): entry is { asyncDir: string; mtimeMs: number } => Boolean(entry))
		.sort((left, right) => right.mtimeMs - left.mtimeMs);
	const runs = new Map<string, ForegroundResumeRun>();
	for (let offset = 0; offset < candidates.length && runs.size < MAX_REPLAYED_FOREGROUND_RUNS; offset += 32) {
		const batch = await mapConcurrent(candidates.slice(offset, offset + 32), 8, async ({ asyncDir }) => {
			try {
				const status = await readStatusAsync(asyncDir);
				if (
					!status ||
					!sessionArtifactMatches(sessionScope, status.sessionId, status.runId) ||
					status.runId !== path.basename(asyncDir)
				)
					return undefined;
				const run = runFromStatus(status, asyncDir);
				return run ? ({ ...run, sessionId: sessionScope.sessionId } satisfies ForegroundResumeRun) : undefined;
			} catch {
				return undefined;
			}
		});
		for (const run of batch) {
			if (run) runs.set(run.runId, run);
			if (runs.size >= MAX_REPLAYED_FOREGROUND_RUNS) break;
		}
	}
	return runs;
}

export async function recoverForegroundRuntimeRunsAsync(
	rootDirectory: string,
	sessionScope: SessionCompatibilityScope,
	runtimeDirectories?: readonly string[],
): Promise<Map<string, ForegroundResumeRun>> {
	const runs = await observeForegroundRuntimeRunsAsync(rootDirectory, sessionScope, runtimeDirectories);
	for (const run of runs.values()) await refreshForegroundRuntimeRunAsync(run);
	return runs;
}

export function mergeForegroundRuns(
	primary: Map<string, ForegroundResumeRun>,
	fallback: Map<string, ForegroundResumeRun>,
): Map<string, ForegroundResumeRun> {
	const merged = new Map(primary);
	for (const [runId, run] of fallback) {
		const existing = merged.get(runId);
		if (!existing || run.updatedAt > existing.updatedAt || (Boolean(run.nestedRoute) && !existing.nestedRoute))
			merged.set(runId, run);
		else if (!existing.asyncDir && run.asyncDir) merged.set(runId, { ...existing, asyncDir: run.asyncDir });
	}
	return new Map(
		[...merged.entries()]
			.sort(([, left], [, right]) => right.updatedAt - left.updatedAt || right.runId.localeCompare(left.runId))
			.slice(0, MAX_REPLAYED_FOREGROUND_RUNS),
	);
}
