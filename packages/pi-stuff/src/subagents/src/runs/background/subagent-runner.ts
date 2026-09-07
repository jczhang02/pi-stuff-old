/** Detached runner for one Agent or one parallel Agent batch. */

import * as fs from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import { normalizePonytailMode } from "../../../../ponytail/types.js";
import { type JsonObject, type JsonValue, parseJsonValue } from "../../../../shared/json-value.js";
import {
	isRuntimeBoolean,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
	runtimeErrorCode,
} from "../../../../shared/runtime-type.js";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { readBoundedOwnedFile } from "../../shared/private-directory.ts";
import { assertModelCandidateLimit } from "../shared/model-fallback.ts";
import { finalizeNestedRouteRoot } from "../shared/nested-events.ts";
import {
	type BackgroundRunnerConfig,
	type BackgroundRunnerWork,
	MAX_BACKGROUND_TASKS,
	type RunnerAgentTask,
} from "../shared/parallel-utils.ts";
import { acquireSessionLease } from "../shared/session-lease.ts";
import { createWorktrees, resolveWorktreeTaskCwd, type WorktreeSetup } from "../shared/worktree.ts";
import { runResolvedTask } from "./child-task-runner.ts";
import { createInitialStatus, type BackgroundRunnerStatus as RunnerStatus } from "./initial-status.ts";
import { markProcessTerminalCandidateLeaseRelease } from "./process-terminal.ts";
import { BackgroundRunControl } from "./runner-control.ts";
import { finalizeConfiguredRun } from "./runner-finalization.ts";
import { appendDiagnosticEvent, boundRunResultOutputs } from "./runner-output.ts";
import {
	failedResult,
	installStatusPublisher,
	runBackgroundWork,
	setStatusUpdateObserver,
	taskList,
	terminalizeRejectedStep,
	writeStatus,
} from "./runner-state.ts";
import { BACKGROUND_RUNNER_CONFIG_ENV, BACKGROUND_RUNNER_SENTINEL_ENV } from "./writer-process-lifecycle.ts";
import {
	initializeWriterProcessRegistry,
	inspectWriterProcessLiveness,
	updateWriterProcessRegistry,
	type WriterRuntimeState,
} from "./writer-process-registry.ts";

function persistWorktreeRecoveryCwd(config: BackgroundRunnerConfig, setup: WorktreeSetup): void {
	if (config.work.mode !== "parallel") return;
	const descriptorPath = fs.existsSync(path.join(config.asyncDir, "recovery-descriptors.json"))
		? path.join(config.asyncDir, "recovery-descriptors.json")
		: path.join(config.asyncDir, "recovery-descriptor.json");
	const parsed = parseJsonValue(fs.readFileSync(descriptorPath, "utf8"));
	if (
		config.work.group.tasks.length === 1 &&
		isRuntimeObject(parsed) &&
		parsed !== null &&
		!Array.isArray(parsed) &&
		!Array.isArray(parsed["children"])
	) {
		const task = config.work.group.tasks[0];
		if (!task) throw new Error(`Async recovery descriptor '${descriptorPath}' has no task.`);
		parsed["cwd"] = resolveWorktreeTaskCwd(setup.worktrees[0], setup.cwd, task.cwd);
		writePrivateAtomicJson(descriptorPath, parsed);
		return;
	}
	if (!isRuntimeObject(parsed) || parsed === null || Array.isArray(parsed) || !Array.isArray(parsed["children"])) {
		throw new Error(`Async recovery descriptor '${descriptorPath}' is missing its children.`);
	}
	const children = parsed["children"];
	for (const [index, child] of children.entries()) {
		if (!isRuntimeObject(child) || child === null || Array.isArray(child)) {
			throw new Error(`Async recovery descriptor '${descriptorPath}' child ${index} is invalid.`);
		}
		const task = config.work.group.tasks[index];
		if (!task) throw new Error(`Async recovery descriptor '${descriptorPath}' child ${index} has no task.`);
		child["cwd"] = resolveWorktreeTaskCwd(setup.worktrees[index], setup.cwd, task.cwd);
	}
	writePrivateAtomicJson(descriptorPath, parsed);
}

export { createInitialStatus } from "./initial-status.ts";
export { createBackgroundCompletion, runBackgroundWork } from "./runner-state.ts";
export {
	buildWriterProcessEnv,
	buildWriterSpawnCommand,
	captureWriterProcessStartIdentity,
	ponytailWriterEnvironmentOverrides,
} from "./writer-process-lifecycle.ts";

function runConfiguredWork(
	config: BackgroundRunnerConfig,
	onWriterProcess?: (index: number, writer: WriterRuntimeState) => void,
	beforeFinalPersistence?: () => void | Promise<void>,
	beforeWorktreeEvidence?: () => void,
	beforeResultPersistence?: () => void,
): Promise<{ nestedProjectionCommitted: boolean }> {
	const startedAt = config.startedAt ?? Date.now();
	const statusPath = path.join(config.asyncDir, "status.json");
	const eventsPath = path.join(config.asyncDir, "events.jsonl");
	const status = createInitialStatus(config, startedAt);
	const control = new BackgroundRunControl(config, status, statusPath, eventsPath);
	return Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* installStatusPublisher();
				yield* Effect.try({
					try: () => {
						fs.mkdirSync(config.asyncDir, { recursive: true });
						writeStatus(statusPath, status);
						appendDiagnosticEvent(eventsPath, {
							type: "subagent.run.started",
							ts: startedAt,
							runId: config.id,
							mode: config.work.mode,
							agents: taskList(config.work).map((task) => task.agent),
						});
					},
					catch: (error) => error,
				});
				yield* control.install();
				let worktreeSetup: WorktreeSetup | undefined;
				const results = yield* Effect.gen(function* () {
					if (config.work.mode === "parallel" && config.work.group.worktree) {
						const group = config.work.group;
						const createdWorktrees = yield* Effect.try({
							try: () =>
								createWorktrees(config.cwd, config.id, group.tasks.length, {
									agents: group.tasks.map((task) => task.agent),
								}),
							catch: (error) => error,
						});
						worktreeSetup = createdWorktrees;
						yield* Effect.try({
							try: () => persistWorktreeRecoveryCwd(config, createdWorktrees),
							catch: (error) => error,
						});
					}
					const taskResults = yield* runBackgroundWork(
						config.work,
						(task, index) =>
							Effect.tryPromise({
								try: () =>
									runResolvedTask({
										config,
										task,
										index,
										taskCwd: worktreeSetup
											? resolveWorktreeTaskCwd(worktreeSetup.worktrees[index], worktreeSetup.cwd, task.cwd)
											: task.cwd,
										status,
										statusPath,
										eventsPath,
										activeControls: control.activeControls,
										consumeScheduledStop: (index) => control.consumeScheduledStop(index),
										preStartTerminalCause: () => control.preStartTerminalCause(),
										onWriterProcess: onWriterProcess ? (writer) => onWriterProcess(index, writer) : undefined,
									}),
								catch: (error) => error,
							}).pipe(
								Effect.tapError((error) =>
									Effect.sync(() => terminalizeRejectedStep(status, statusPath, eventsPath, index, error)),
								),
							),
						{ runId: config.id, terminalCause: () => control.preStartTerminalCause() },
					);
					return yield* Effect.try({ try: () => boundRunResultOutputs(taskResults), catch: (error) => error });
				}).pipe(
					Effect.catch((error) => {
						const message = error instanceof Error ? error.message : String(error);
						return Effect.succeed(
							taskList(config.work).map((task, index) => failedResult(task, message, config.id, index)),
						);
					}),
				);
				return yield* finalizeConfiguredRun({
					config,
					status,
					statusPath,
					eventsPath,
					startedAt,
					results,
					worktreeSetup,
					control,
					hooks: { beforeFinalPersistence, beforeWorktreeEvidence, beforeResultPersistence },
				});
			}),
		),
	);
}

function waitForStartupControlEffect(
	controlPath: string,
	token: string,
	action: "ack" | "proceed",
	timeoutMs = 30_000,
	readControl: (path: string) => string = (path) => fs.readFileSync(path, "utf-8"),
): Effect.Effect<void, unknown> {
	return Effect.gen(function* () {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() <= deadline) {
			const ready = yield* Effect.try({
				try: () => {
					const payload = parseJsonValue(readControl(controlPath));
					if (!isRuntimeObject(payload) || payload === null || Array.isArray(payload)) {
						throw new Error("Runner startup control payload is invalid.");
					}
					if (payload["token"] !== token) {
						throw new Error("Runner startup token does not match the session lease.");
					}
					if (payload["action"] === action) return true;
					if (payload["action"] !== "ack" && payload["action"] !== "proceed") {
						throw new Error("Runner startup control action is invalid.");
					}
					return false;
				},
				catch: (error) => error,
			}).pipe(
				Effect.catch((error) =>
					runtimeErrorCode(error) === "ENOENT" ? Effect.succeed(false) : Effect.fail(error),
				),
			);
			if (ready) return;
			yield* Effect.sleep(Math.min(20, Math.max(1, deadline - Date.now())));
		}
		return yield* Effect.fail(new Error(`Timed out after ${timeoutMs}ms waiting for runner startup '${action}'.`));
	});
}

export function waitForStartupControl(
	controlPath: string,
	token: string,
	action: "ack" | "proceed",
	timeoutMs = 30_000,
	readControl: (path: string) => string = (path) => fs.readFileSync(path, "utf-8"),
): Promise<void> {
	return Effect.runPromise(waitForStartupControlEffect(controlPath, token, action, timeoutMs, readControl));
}

async function completeRevivalHandshake(
	config: BackgroundRunnerConfig,
	startupPath: string,
	lease: ReturnType<typeof acquireSessionLease>,
): Promise<void> {
	config.revivalLeaseToken = lease.owner.token;
	writePrivateAtomicJson(startupPath, {
		state: "ready",
		token: lease.owner.token,
		pid: process.pid,
		owner: lease.owner,
	});
	const ackPath = path.join(config.asyncDir, "runner-startup-ack.json");
	await waitForStartupControl(ackPath, lease.owner.token, "ack");
	writePrivateAtomicJson(startupPath, {
		state: "acknowledged",
		token: lease.owner.token,
		pid: process.pid,
	});
	const proceedPath = path.join(config.asyncDir, "runner-startup-proceed.json");
	await waitForStartupControl(proceedPath, lease.owner.token, "proceed");
	fs.rmSync(ackPath, { force: true });
	fs.rmSync(proceedPath, { force: true });
}

export async function runConfiguredBackground(
	config: BackgroundRunnerConfig,
	hooks: {
		afterStatusUpdate?: (status: RunnerStatus) => void;
		afterWriterProcessUpdate?: (index: number, writer: WriterRuntimeState) => void;
		beforeFinalPersistence?: () => void | Promise<void>;
		beforeWorktreeEvidence?: () => void;
		beforeResultPersistence?: () => void;
	} = {},
): Promise<void> {
	if (config.version !== 2) throw new Error("Background runner config version must be 2.");
	if (taskList(config.work).length > MAX_BACKGROUND_TASKS) {
		throw new Error(`Background runner supports at most ${MAX_BACKGROUND_TASKS} tasks per launch.`);
	}
	for (const task of taskList(config.work)) assertModelCandidateLimit(task.modelCandidates ?? []);
	let lease: ReturnType<typeof acquireSessionLease> | undefined;
	let terminalCommitted = false;
	let startupCommitted = !config.revivalLease && !config.startupGateToken;
	const startupPath = path.join(config.asyncDir, "runner-startup.json");
	const gatePath = path.join(config.asyncDir, "runner-startup-gate.json");
	const statusPath = path.join(config.asyncDir, "status.json");
	setStatusUpdateObserver(statusPath, hooks.afterStatusUpdate);
	const releaseOnExit = () => {
		try {
			if (lease && inspectWriterProcessLiveness(config.asyncDir) === false) lease.release();
		} catch {
			// A dead-owner lease is reclaimed by the next recovery attempt.
		}
	};
	process.once("exit", releaseOnExit);
	try {
		if (config.startupGateToken) {
			await waitForStartupControl(gatePath, config.startupGateToken, "proceed");
			startupCommitted = true;
			fs.rmSync(gatePath, { force: true });
		}
		initializeWriterProcessRegistry(config.asyncDir, config.id, process.pid, taskList(config.work).length);
		if (config.revivalLease) {
			lease = acquireSessionLease(config.revivalLease, { inspectWriterLiveness: inspectWriterProcessLiveness });
			await completeRevivalHandshake(config, startupPath, lease);
			startupCommitted = true;
		}
		await runConfiguredWork(
			config,
			(index, writer) => {
				updateWriterProcessRegistry(config.asyncDir, index, writer);
				if (lease && index === 0) lease.updateWriter(writer);
				hooks.afterWriterProcessUpdate?.(index, writer);
			},
			hooks.beforeFinalPersistence,
			hooks.beforeWorktreeEvidence,
			hooks.beforeResultPersistence,
		);
		// `runConfiguredWork` has committed the terminal result/status at this
		// point. A transient first projection failure must not suppress the
		// authoritative route settlement retry below.
		terminalCommitted = true;
	} catch (error) {
		if (config.revivalLease && !startupCommitted) {
			try {
				writePrivateAtomicJson(startupPath, {
					state: "error",
					pid: process.pid,
					error: error instanceof Error ? error.message : String(error),
				});
			} catch {
				// The launcher will time out and terminate an unacknowledged runner.
			}
		}
		throw error;
	} finally {
		setStatusUpdateObserver(statusPath, undefined);
		process.off("exit", releaseOnExit);
		if (lease) {
			let acknowledged = false;
			try {
				// A writer supervisor can close while an authenticated Pi member of
				// its process group survives. Never free the canonical session until
				// the registry positively proves that every writer group is absent.
				if (inspectWriterProcessLiveness(config.asyncDir) === false) acknowledged = lease.release();
			} catch (error) {
				reportAgentDiagnostic("Failed to release Agent session lease:", error);
			}
			try {
				markProcessTerminalCandidateLeaseRelease(config.asyncDir, lease.owner.token, acknowledged);
			} catch (error) {
				reportAgentDiagnostic("Failed to record Agent session lease release:", error);
			}
		}
		if (terminalCommitted && config.nestedRoute?.rootRunId === config.id) {
			try {
				await finalizeNestedRouteRoot(config.nestedRoute, config.asyncDir);
			} catch (error) {
				if (runtimeErrorCode(error) !== "ENOENT") {
					reportAgentDiagnostic(`Failed to settle terminal nested route for '${config.id}':`, error);
				}
			}
		}
	}
}

function startConfiguredBackground(config: BackgroundRunnerConfig): void {
	runConfiguredBackground(config).catch((error) => {
		reportAgentDiagnostic("Background Agent runner error:", error);
		process.exitCode = 1;
	});
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function isRunnerAgentTask(value: JsonValue): value is JsonObject & RunnerAgentTask {
	return (
		isJsonObject(value) &&
		isRuntimeString(value["agent"]) &&
		isRuntimeString(value["task"]) &&
		isRuntimeString(value["cwd"]) &&
		isRuntimeBoolean(value["inheritProjectContext"]) &&
		isRuntimeBoolean(value["inheritSkills"])
	);
}

function isBackgroundRunnerWork(value: JsonValue): value is JsonObject & BackgroundRunnerWork {
	if (!isJsonObject(value)) return false;
	const task = value["task"];
	if (value["mode"] === "single") return task !== undefined && isRunnerAgentTask(task);
	const group = value["group"];
	return (
		value["mode"] === "parallel" &&
		group !== undefined &&
		isJsonObject(group) &&
		Array.isArray(group["tasks"]) &&
		group["tasks"].every(isRunnerAgentTask) &&
		isRuntimeNumber(group["concurrency"]) &&
		Number.isSafeInteger(group["concurrency"]) &&
		group["concurrency"] > 0 &&
		isRuntimeBoolean(group["worktree"])
	);
}

function parseBackgroundRunnerConfig(text: string): BackgroundRunnerConfig {
	const value = parseJsonValue(text);
	const work = isJsonObject(value) ? value["work"] : undefined;
	if (
		!isRuntimeObject(value) ||
		value === null ||
		Array.isArray(value) ||
		value["version"] !== 2 ||
		!isRuntimeString(value["id"]) ||
		!value["id"] ||
		!isRuntimeString(value["resultPath"]) ||
		!value["resultPath"] ||
		!isRuntimeString(value["cwd"]) ||
		!value["cwd"] ||
		!isRuntimeString(value["asyncDir"]) ||
		!value["asyncDir"] ||
		(value["ponytailMode"] !== undefined && normalizePonytailMode(value["ponytailMode"]) === undefined) ||
		work === undefined ||
		!isBackgroundRunnerWork(work)
	) {
		throw new Error("Background runner config is invalid.");
	}
	return Object.assign({}, value, {
		version: 2 as const,
		id: value["id"],
		resultPath: value["resultPath"],
		cwd: value["cwd"],
		asyncDir: value["asyncDir"],
		work,
	});
}

function startFromConfigPath(configPath: string): void {
	const config = parseBackgroundRunnerConfig(readBoundedOwnedFile(configPath, 8 * 1024 * 1024));
	try {
		fs.unlinkSync(configPath);
	} catch {
		// Temporary config cleanup is best effort.
	}
	startConfiguredBackground(config);
}

const runnerConfigPath = process.env[BACKGROUND_RUNNER_CONFIG_ENV];
if (
	process.env[BACKGROUND_RUNNER_SENTINEL_ENV] === "1" &&
	runnerConfigPath !== undefined &&
	process.argv[2] === runnerConfigPath
) {
	try {
		startFromConfigPath(runnerConfigPath);
	} catch (error) {
		reportAgentDiagnostic("Background Agent runner error:", error);
		process.exitCode = 1;
	}
}
