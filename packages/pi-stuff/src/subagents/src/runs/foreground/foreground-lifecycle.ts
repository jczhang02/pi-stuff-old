import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult as CoreAgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import {
	type AsyncStatus,
	type Details,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	type SubagentState,
} from "../../shared/types.ts";
import { type BackgroundRunnerStatus, createInitialStatus } from "../background/initial-status.ts";
import { persistRecoveries } from "../background/recovery-writer.ts";
import type { BackgroundRecoveryDescriptor } from "../background/resolved-task.ts";
import { initializeWriterProcessRegistry } from "../background/writer-process-registry.ts";
import type { BackgroundRunnerConfig } from "../shared/parallel-utils.ts";
import type { runForegroundConfig } from "./execution.ts";
import {
	createForegroundControl,
	emitNestedLifecycle,
	type ForegroundProjectionData,
	type ForegroundTask,
	refreshForegroundNestedProjection,
	rememberForegroundResult,
	updateForegroundControl,
} from "./foreground-projection.ts";
import type { ForegroundRunDirectoryClaim } from "./foreground-run-claim.ts";

type AgentToolResult<T> = CoreAgentToolResult<T> & { isError?: boolean };

export interface ForegroundLaunchData extends ForegroundProjectionData {
	readonly sessionRoot: string;
}

interface ForegroundLifecycleRuntime {
	readonly pi: Pick<ExtensionAPI, "events">;
	readonly state: SubagentState;
	readonly onForegroundStatus?: (() => void) | undefined;
}

interface ForegroundLifecycleHooks {
	readonly beforeForegroundStart?:
		| ((binding: {
				readonly runId: string;
				readonly asyncDir: string;
				readonly writerCount: number;
				readonly abortStart: () => boolean;
		  }) => void | Promise<void>)
		| undefined;
}

export interface PreparedForegroundConfig {
	readonly config: BackgroundRunnerConfig;
	readonly directoryClaim: ForegroundRunDirectoryClaim;
	readonly recoveries: BackgroundRecoveryDescriptor[];
}

function commitForegroundStart(
	data: ForegroundLaunchData,
	tasks: readonly ForegroundTask[],
	prepared: PreparedForegroundConfig,
	hooks?: ForegroundLifecycleHooks,
	onLifecycleCommitted?: (() => void) | undefined,
): Effect.Effect<BackgroundRunnerStatus, unknown> {
	const { config, directoryClaim, recoveries } = prepared;
	return Effect.gen(function* () {
		const initialStatus = yield* Effect.try({
			try: () => {
				persistRecoveries(config.asyncDir, recoveries);
				initializeWriterProcessRegistry(config.asyncDir, config.id, process.pid, tasks.length);
				const status = createInitialStatus(config, config.startedAt ?? Date.now());
				writePrivateAtomicJson(path.join(config.asyncDir, "status.json"), status);
				return status;
			},
			catch: (error) => error,
		});
		if (hooks?.beforeForegroundStart) {
			yield* Effect.tryPromise({
				try: async () =>
					hooks.beforeForegroundStart?.({
						runId: data.runId,
						asyncDir: config.asyncDir,
						writerCount: tasks.length,
						abortStart: directoryClaim.abortIfUnstarted,
					}),
				catch: (error) => error,
			});
		}
		yield* Effect.try({
			try: () => {
				if (!directoryClaim.commit()) {
					throw new Error(`Foreground Agent runtime ownership changed before '${data.runId}' could start.`);
				}
				onLifecycleCommitted?.();
			},
			catch: (error) => error,
		});
		return initialStatus;
	}).pipe(
		Effect.catch((error) =>
			Effect.sync(() => {
				// Remove only the exact unstarted inode; collisions remain recovery evidence.
				directoryClaim.cleanup();
				try {
					fs.rmdirSync(data.sessionRoot);
				} catch {
					// A non-empty session root may contain a prepared fork and remains recovery evidence.
				}
			}).pipe(Effect.andThen(Effect.fail(error))),
		),
	);
}

function emitForegroundCompletionEvents(
	data: ForegroundLaunchData,
	runtime: ForegroundLifecycleRuntime,
	result: AgentToolResult<Details>,
): void {
	for (const [index, child] of result.details.results.entries()) {
		if (child.detached) continue;
		try {
			runtime.pi.events.emit(SUBAGENT_FOREGROUND_COMPLETE_EVENT, {
				id: `${data.runId}:${index}`,
				runId: data.runId,
				source: "foreground",
				mode: data.mode,
				agent: child.agent,
				success: child.exitCode === 0,
				summary: child.finalOutput || child.error || "(no report)",
				exitCode: child.exitCode,
				state: child.stopped
					? "stopped"
					: child.interrupted
						? "paused"
						: child.exitCode === 0
							? "complete"
							: "failed",
				timestamp: Date.now(),
				cwd: data.effectiveCwd,
				sessionFile: child.sessionFile,
				sessionId: data.executionContext.currentSessionId,
				taskIndex: index,
			});
		} catch (error) {
			reportAgentDiagnostic(`Foreground Agent completion observer failed for '${data.runId}:${index}':`, error);
		}
	}
}

export function executeForegroundLifecycle(
	data: ForegroundLaunchData,
	tasks: readonly ForegroundTask[],
	prepared: PreparedForegroundConfig,
	runtime: ForegroundLifecycleRuntime,
	engine: typeof runForegroundConfig,
	signal: AbortSignal,
	onUpdate?: ((result: AgentToolResult<Details>) => void) | undefined,
	hooks?: ForegroundLifecycleHooks,
	onLifecycleCommitted?: (() => void) | undefined,
): Effect.Effect<AgentToolResult<Details>, unknown, Scope.Scope> {
	return Effect.gen(function* () {
		const { config, directoryClaim } = prepared;
		const initialStatus = yield* commitForegroundStart(data, tasks, prepared, hooks, onLifecycleCommitted);
		const emitUpdate = (update: AgentToolResult<Details>) => {
			try {
				onUpdate?.(update);
			} catch (error) {
				reportAgentDiagnostic(`Foreground Agent progress observer failed for '${data.runId}':`, error);
			}
		};
		const control = createForegroundControl(data, config, tasks);
		runtime.state.foregroundControls.set(data.runId, control);
		runtime.state.lastForegroundControlId = data.runId;
		let liveStatus: AsyncStatus = initialStatus;
		let activity: Fiber.Fiber<void, never> | undefined;
		const run = Effect.gen(function* () {
			activity = yield* Effect.forkScoped(
				Effect.forever(
					Effect.sleep(500).pipe(
						Effect.andThen(
							Effect.sync(() => {
								refreshForegroundNestedProjection(control);
								if (data.inheritedNestedRoute) {
									emitNestedLifecycle(data, config, control.startedAt, liveStatus, undefined, true);
								}
								runtime.onForegroundStatus?.();
							}),
						),
					),
				),
			);
			emitNestedLifecycle(data, config, control.startedAt, liveStatus);
			emitUpdate({
				content: [
					{ type: "text", text: `${data.mode === "parallel" ? "Agents" : "Agent"} running in foreground.` },
				],
				details: { mode: data.mode, runId: data.runId, results: [], context: data.context },
			});
			let abortedBeforeStart = false;
			const result = yield* engine(
				config,
				signal,
				{
					onStatus(status) {
						liveStatus = { ...liveStatus, ...status };
						updateForegroundControl(control, status);
						runtime.onForegroundStatus?.();
					},
				},
				initialStatus,
			).pipe(
				Effect.catch((error) => {
					if (!directoryClaim.abortIfUnstarted()) return Effect.fail(error);
					abortedBeforeStart = true;
					return Effect.succeed({
						content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
						isError: true,
						details: { mode: data.mode, results: [], runId: data.runId, cwd: data.effectiveCwd },
					});
				}),
			);
			if (result.details.results.length === 0 && directoryClaim.abortIfUnstarted()) {
				abortedBeforeStart = true;
			}
			return { abortedBeforeStart, result };
		}).pipe(
			Effect.ensuring(
				Effect.gen(function* () {
					if (activity) yield* Fiber.interrupt(activity);
					yield* Effect.sync(() => {
						refreshForegroundNestedProjection(control);
						runtime.state.foregroundControls.delete(data.runId);
						if (runtime.state.lastForegroundControlId === data.runId)
							runtime.state.lastForegroundControlId = null;
					});
				}),
			),
		);
		const { abortedBeforeStart, result } = yield* run;
		if (abortedBeforeStart) {
			emitNestedLifecycle(data, config, control.startedAt, liveStatus, result);
			emitUpdate(result);
			return result;
		}
		rememberForegroundResult(runtime.state, data, result, tasks, control.startedAt, config.asyncDir);
		emitNestedLifecycle(data, config, control.startedAt, liveStatus, result);
		emitForegroundCompletionEvents(data, runtime, result);
		emitUpdate(result);
		return result;
	});
}
