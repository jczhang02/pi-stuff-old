/** Foreground adapter for the same resolved child engine used by background Agents. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import * as Effect from "effect/Effect";
import { type JsonObject, type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import {
	isRuntimeBoolean,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
} from "../../../../shared/runtime-type.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { tryAcquireStatusMutationClaim } from "../../shared/status-mutation.ts";
import type { AsyncStatus, Details, NestedRunSummary } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { deliverStopRequest } from "../background/control-channel.ts";
import type { BackgroundRunnerStatus } from "../background/initial-status.ts";
import type { BackgroundRunnerConfig, BackgroundTaskResult, RunnerAgentTask } from "../shared/parallel-utils.ts";
import { recordForegroundOwnerExit } from "./owner-exit.ts";
import {
	type ForegroundCompletion,
	foregroundStatusIsTerminal,
	projectForegroundCompletion,
	projectForegroundStatus,
} from "./result-projection.ts";
import { runForegroundWorker } from "./worker.ts";

export interface ForegroundExecutionDependencies {
	acquireStatusClaim(asyncDir: string): { release(): void } | undefined;
	onStatus(status: AsyncStatus): void;
	runConfigured(
		config: BackgroundRunnerConfig,
		onStatus: (status: AsyncStatus) => void,
		committedStatus?: BackgroundRunnerStatus,
	): Effect.Effect<void, unknown>;
	readCompletion(filePath: string): ForegroundCompletion;
	readNestedChildren(asyncDir: string, runId: string): NestedRunSummary[] | undefined;
	requestStop(asyncDir: string): void;
	reapWriters(asyncDir: string): Effect.Effect<{ remaining: number; terminated: number }, unknown>;
	writeStatus(filePath: string, status: AsyncStatus): void;
}

const DEFAULT_DEPENDENCIES: ForegroundExecutionDependencies = {
	acquireStatusClaim: tryAcquireStatusMutationClaim,
	onStatus() {},
	runConfigured: runForegroundWorker,
	readCompletion(filePath) {
		const value = parseJsonValue(fs.readFileSync(filePath, "utf8"));
		return validateCompletion(value, filePath);
	},
	readNestedChildren(asyncDir, runId) {
		const status = readStatus(asyncDir);
		if (!status || status.runId !== runId) return undefined;
		const children = status.steps?.flatMap((step) => step.children ?? []) ?? [];
		if (children.length > 0) return children;
		return !status.nestedRoute &&
			(status.state === "complete" ||
				status.state === "failed" ||
				status.state === "paused" ||
				status.state === "stopped")
			? []
			: undefined;
	},
	requestStop(asyncDir) {
		deliverStopRequest({ asyncDir, source: "foreground-cancel" });
	},
	reapWriters: (asyncDir) =>
		Effect.tryPromise({
			try: () => import("../background/writer-process-registry.ts"),
			catch: (error) => error,
		}).pipe(Effect.flatMap(({ reapOrphanWriterProcesses }) => reapOrphanWriterProcesses(asyncDir))),
	writeStatus: writePrivateAtomicJson,
};

function jsonObject(value: JsonValue): JsonObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value) ? value : {};
}

function validateTaskResult(value: JsonValue, source: string): BackgroundTaskResult {
	const candidate = jsonObject(value);
	if (
		!isRuntimeString(candidate["agent"]) ||
		!isRuntimeString(candidate["output"]) ||
		!isRuntimeBoolean(candidate["success"]) ||
		!(candidate["exitCode"] === null || isRuntimeNumber(candidate["exitCode"]))
	) {
		throw new Error(`Foreground Agent task result is malformed: ${source}`);
	}
	// SAFETY: the foreground result is runner-owned JSON whose required task fields were validated above.
	return {
		...candidate,
		agent: candidate["agent"],
		exitCode: candidate["exitCode"],
		output: candidate["output"],
		success: candidate["success"],
	} as BackgroundTaskResult;
}

function validateCompletion(value: JsonValue, source: string): ForegroundCompletion {
	const candidate = jsonObject(value);
	if (
		!isRuntimeString(candidate["id"]) ||
		!isRuntimeString(candidate["runId"]) ||
		(candidate["mode"] !== "single" && candidate["mode"] !== "parallel") ||
		!Array.isArray(candidate["results"]) ||
		!isRuntimeBoolean(candidate["success"])
	) {
		throw new Error(`Foreground Agent result is malformed: ${source}`);
	}
	const state = candidate["state"];
	if (state !== "complete" && state !== "failed" && state !== "stopped" && state !== "paused") {
		throw new Error(`Foreground Agent result has an invalid state: ${source}`);
	}
	// SAFETY: the runner-owned completion fields and every child result were validated above.
	return {
		...candidate,
		id: candidate["id"],
		mode: candidate["mode"],
		results: candidate["results"].map((result) => validateTaskResult(result, source)),
		runId: candidate["runId"],
		state,
		success: candidate["success"],
	} as ForegroundCompletion;
}

function tasks(config: BackgroundRunnerConfig): RunnerAgentTask[] {
	return config.work.mode === "single" ? [config.work.task] : config.work.group.tasks;
}

function statusMatchesConfig(status: AsyncStatus | null, config: BackgroundRunnerConfig): status is AsyncStatus {
	if (!status || status.runId !== config.id || status.mode !== config.work.mode) return false;
	const configuredTasks = tasks(config);
	if (!status.steps || status.steps.length !== configuredTasks.length) return false;
	return status.steps.every((step, index) => step.agent === configuredTasks[index]?.agent);
}

function terminalizeForegroundOwnerFailure(status: AsyncStatus, message: string): AsyncStatus {
	if (foregroundStatusIsTerminal(status)) return status;
	const endedAt = Date.now();
	return {
		...status,
		state: "failed",
		error: message,
		endedAt,
		lastUpdate: endedAt,
		activityState: undefined,
		currentTool: undefined,
		currentToolStartedAt: undefined,
		currentPath: undefined,
		steps: status.steps?.map((step) =>
			step.status === "pending" || step.status === "running"
				? {
						...step,
						status: "failed" as const,
						exitCode: 1,
						error: message,
						endedAt,
						activityState: undefined,
						currentTool: undefined,
						currentToolStartedAt: undefined,
						currentPath: undefined,
					}
				: step,
		),
	};
}

function readMatchingStatus(config: BackgroundRunnerConfig): AsyncStatus | undefined {
	try {
		const status = readStatus(config.asyncDir);
		return statusMatchesConfig(status, config) ? status : undefined;
	} catch {
		return undefined;
	}
}

function recoverForegroundRun(
	config: BackgroundRunnerConfig,
	deps: ForegroundExecutionDependencies,
	notifyStatus: ForegroundExecutionDependencies["onStatus"],
	ownerFailure: string,
): Effect.Effect<{ status: AsyncStatus | undefined; terminalOverlay: AsyncStatus | undefined }, never> {
	return Effect.gen(function* () {
		let status = readMatchingStatus(config);
		// The execution frame has ended whether status.json is readable or not.
		// Persist that semantic boundary first so the long-lived Pi PID cannot be
		// mistaken for proof that this foreground frame is still active.
		try {
			recordForegroundOwnerExit(config.asyncDir, config.id, ownerFailure);
		} catch (markerError) {
			reportAgentDiagnostic(`Failed to persist foreground owner exit for '${config.id}':`, markerError);
		}
		const remainingWriters = yield* deps.reapWriters(config.asyncDir).pipe(
			Effect.map((result) => result.remaining),
			Effect.catch((reapError) =>
				Effect.sync(() => {
					reportAgentDiagnostic(`Failed to reap foreground writers for '${config.id}':`, reapError);
					return 1;
				}),
			),
		);
		let terminalOverlay: AsyncStatus | undefined;
		if (!status || foregroundStatusIsTerminal(status) || remainingWriters !== 0) return { status, terminalOverlay };
		let claim: ReturnType<ForegroundExecutionDependencies["acquireStatusClaim"]>;
		try {
			claim = deps.acquireStatusClaim(config.asyncDir);
		} catch (claimError) {
			reportAgentDiagnostic(`Failed to acquire foreground status claim for '${config.id}':`, claimError);
		}
		if (!claim) return { status, terminalOverlay };
		try {
			const current = readMatchingStatus(config);
			if (current) {
				status = terminalizeForegroundOwnerFailure(current, ownerFailure);
				terminalOverlay = status;
				if (!foregroundStatusIsTerminal(current)) {
					deps.writeStatus(path.join(config.asyncDir, "status.json"), status);
					notifyStatus(status);
				}
			}
		} catch (statusError) {
			reportAgentDiagnostic(`Failed to persist foreground owner failure for '${config.id}':`, statusError);
		} finally {
			try {
				claim.release();
			} catch (releaseError) {
				reportAgentDiagnostic(`Failed to release foreground status claim for '${config.id}':`, releaseError);
			}
		}
		return { status, terminalOverlay };
	});
}

export function runForegroundConfig(
	config: BackgroundRunnerConfig,
	signal?: AbortSignal,
	dependencies: Partial<ForegroundExecutionDependencies> = {},
	committedStatus?: BackgroundRunnerStatus,
): Effect.Effect<AgentToolResult<Details> & { isError?: boolean }, unknown> {
	const deps = { ...DEFAULT_DEPENDENCIES, ...dependencies };
	const notifyStatus = (status: AsyncStatus) => {
		try {
			deps.onStatus(status);
		} catch (error) {
			reportAgentDiagnostic(`Foreground Agent status observer failed for '${config.id}':`, error);
		}
	};
	if (signal?.aborted) {
		return Effect.succeed({
			content: [{ type: "text" as const, text: "Foreground Agent cancelled before launch." }],
			isError: true,
			details: { mode: config.work.mode, runId: config.id, cwd: config.cwd, results: [], stopped: true },
		});
	}

	let stopRequestError: unknown;
	const stop = () => {
		try {
			deps.requestStop(config.asyncDir);
		} catch (error) {
			stopRequestError = error;
			reportAgentDiagnostic(`Failed to request foreground Agent cancellation for '${config.id}':`, error);
		}
	};
	const execute = Effect.gen(function* () {
		yield* deps.runConfigured(config, notifyStatus, committedStatus);
		const projected = yield* Effect.try({
			try: () => {
				const completion = deps.readCompletion(config.resultPath);
				const nestedChildren = deps.readNestedChildren(config.asyncDir, config.id);
				return projectForegroundCompletion(
					config,
					nestedChildren === undefined ? completion : { ...completion, nestedChildren },
				);
			},
			catch: (error) => error,
		});
		if (stopRequestError === undefined) return projected;
		const message = stopRequestError instanceof Error ? stopRequestError.message : String(stopRequestError);
		return {
			...projected,
			content: [...projected.content, { type: "text" as const, text: `Cancellation request warning: ${message}` }],
		};
	}).pipe(
		Effect.catch((error) =>
			Effect.gen(function* () {
				const message = error instanceof Error ? error.message : String(error);
				const ownerFailure = `Foreground Agent execution owner ended unexpectedly: ${message}`;
				const stopMessage =
					stopRequestError === undefined
						? undefined
						: stopRequestError instanceof Error
							? stopRequestError.message
							: String(stopRequestError);
				const { status, terminalOverlay } = yield* recoverForegroundRun(config, deps, notifyStatus, ownerFailure);
				if (status) {
					const latest = terminalOverlay ?? readMatchingStatus(config) ?? status;
					const projected = projectForegroundStatus(
						config,
						latest,
						foregroundStatusIsTerminal(latest) ? undefined : ownerFailure,
					);
					if (!stopMessage) return projected;
					return {
						...projected,
						content: [
							...projected.content,
							{ type: "text" as const, text: `Cancellation transport also failed: ${stopMessage}` },
						],
					};
				}
				const details: Details = {
					mode: config.work.mode,
					runId: config.id,
					cwd: config.cwd,
					results: [],
				};
				if (signal?.aborted) details.stopped = true;
				return {
					content: [
						{
							type: "text" as const,
							text: stopMessage
								? `Foreground Agent failed: ${message}\nCancellation transport also failed: ${stopMessage}`
								: message,
						},
					],
					isError: true,
					details,
				};
			}),
		),
		Effect.onInterrupt(() =>
			recoverForegroundRun(config, deps, notifyStatus, "Foreground Agent execution owner was interrupted.").pipe(
				Effect.asVoid,
			),
		),
	);
	if (!signal) return execute;
	return Effect.acquireUseRelease(
		Effect.sync(() => signal.addEventListener("abort", stop, { once: true })),
		() => execute,
		() => Effect.sync(() => signal.removeEventListener("abort", stop)),
	);
}
