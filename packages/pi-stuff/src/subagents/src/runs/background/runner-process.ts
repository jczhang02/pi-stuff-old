/** Own the detached background runner process startup and settlement protocol. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { ensurePrivateDirectory, errnoCode, readBoundedOwnedFile } from "../../shared/private-directory.ts";
import {
	type ProcessStartIdentityPollOptions,
	processExists,
	readProcessStartIdentity,
} from "../../shared/process-identity.ts";
import {
	getAsyncConfigPath,
	type ProcessTerminalV1,
	SUBAGENT_ASYNC_STATUS_EVENT,
	TEMP_ROOT_DIR,
} from "../../shared/types.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";
import { resolveBunRuntimeCommand } from "../shared/bun-runtime.ts";
import { nestedSummaryFromAsyncStatus, writeNestedEvent } from "../shared/nested-events.ts";
import type { BackgroundRunnerConfig } from "../shared/parallel-utils.ts";
import { resolvePiPackageRoot } from "../shared/pi-spawn.ts";
import { createInitialStatus } from "./initial-status.ts";
import { finalizeProcessTerminal, readProcessTerminal } from "./process-terminal.ts";
import { resolveNestedTerminalStatus } from "./terminal-status.ts";
import {
	initializeWriterProcessRegistry,
	inspectWriterProcessLiveness,
	terminateOrphanWriterProcesses,
} from "./writer-process-registry.ts";

const MAX_RUNNER_STARTUP_FILE_BYTES = 64 * 1024;
const piPackageRoot = resolvePiPackageRoot();

interface RunnerStatusMessage {
	type?: unknown;
	asyncDir?: unknown;
	status?: unknown;
}

type ProcessTerminalNotice = ProcessTerminalV1 & { asyncDir: string; sessionId?: string | null };

interface AsyncStatusNotice {
	id: string;
	asyncDir: string;
	sessionId?: string | null;
	status: object;
}
export interface SpawnedRunnerLifecycle {
	pid?: number;
	processStartIdentity?: string;
	acknowledgeStart?: () => void;
	abortStart?: () => boolean;
}

interface SpawnRunnerResult extends SpawnedRunnerLifecycle {
	error?: string;
	safeToCleanup?: boolean;
}
/** Resolve the certified Bun runtime without starting a subprocess at import. */
export function resolveAsyncRunnerBunCommand(): string | undefined {
	return resolveBunRuntimeCommand();
}
export function isAsyncAvailable(): boolean {
	return resolveAsyncRunnerBunCommand() !== undefined;
}

export function resolveAsyncRunnerLogPaths(cfg: Pick<BackgroundRunnerConfig, "asyncDir">) {
	return {
		stdoutPath: path.join(cfg.asyncDir, "runner.stdout.log"),
		stderrPath: path.join(cfg.asyncDir, "runner.stderr.log"),
	};
}

function closeFd(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		fs.closeSync(fd);
	} catch {
		// The child already owns its duplicated descriptor.
	}
}

const RUNNER_STARTUP_TIMEOUT_MS = 10_000;

type RunnerStartupState = "ready" | "acknowledged";
type RunnerStartupWaitResult = { ok: true; token: string } | { ok: false; error: string };

function readRunnerStartup(
	startupPath: string,
	expectedState: RunnerStartupState,
	expectedToken?: string,
): RunnerStartupWaitResult | undefined {
	if (!fs.existsSync(startupPath)) return undefined;
	try {
		const payload = parseJsonValue(readBoundedOwnedFile(startupPath, MAX_RUNNER_STARTUP_FILE_BYTES));
		if (!isRuntimeObject(payload) || payload === null || Array.isArray(payload)) return undefined;
		if (payload["state"] === "error" && isRuntimeString(payload["error"])) {
			return { ok: false, error: payload["error"] };
		}
		if (payload["state"] !== expectedState) return undefined;
		if (!isRuntimeString(payload["token"]) || (expectedToken !== undefined && payload["token"] !== expectedToken)) {
			return {
				ok: false,
				error: `Async runner wrote an invalid ${expectedState} startup handshake: ${startupPath}`,
			};
		}
		return { ok: true, token: payload["token"] };
	} catch (error) {
		return {
			ok: false,
			error: `Failed to read async runner startup handshake '${startupPath}': ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

function waitForRunnerStartup(
	startupPath: string,
	expectedState: RunnerStartupState,
	timeoutMs: number,
	expectedToken?: string,
	runnerPid?: number,
	runnerProcessStartIdentity?: string,
): Effect.Effect<RunnerStartupWaitResult> {
	return Effect.gen(function* () {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const result = readRunnerStartup(startupPath, expectedState, expectedToken);
			if (result) return result;
			if (
				runnerPid !== undefined &&
				runnerProcessStartIdentity !== undefined &&
				runnerIdentityState(runnerPid, runnerProcessStartIdentity) === false
			) {
				return {
					ok: false as const,
					error: `Background runner ${runnerPid} exited before startup reached '${expectedState}'.`,
				};
			}
			if (Date.now() >= deadline) break;
			yield* Effect.sleep(Math.min(20, Math.max(1, deadline - Date.now())));
		}
		return (
			readRunnerStartup(startupPath, expectedState, expectedToken) ?? {
				ok: false as const,
				error: `Timed out after ${timeoutMs}ms waiting for async runner state '${expectedState}'.`,
			}
		);
	});
}

function writeRunnerStartupControl(filePath: string, payload: { action: "ack" | "proceed"; token: string }): void {
	const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	try {
		fs.writeFileSync(temporaryPath, JSON.stringify(payload), { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(temporaryPath, filePath);
	} catch (error) {
		fs.rmSync(temporaryPath, { force: true });
		throw error;
	}
}

function runnerIsAlive(pid: number): boolean {
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
			const commandEnd = stat.lastIndexOf(")");
			const state = commandEnd >= 0 ? stat.slice(commandEnd + 1).trimStart()[0] : undefined;
			if (state === "Z" || state === "X") return false;
		} catch {
			// Fall through to kill(0), which also handles non-/proc environments.
		}
	}
	return processExists(pid);
}

function runnerIdentityState(pid: number, expectedProcessStartIdentity: string): boolean | undefined {
	const currentIdentity = readProcessStartIdentity(pid);
	if (currentIdentity) return currentIdentity === expectedProcessStartIdentity;
	return runnerIsAlive(pid) ? undefined : false;
}

export function acquireRunnerProcessStartIdentity(
	pid: number,
	options: ProcessStartIdentityPollOptions = {},
): Effect.Effect<string | undefined> {
	return Effect.gen(function* () {
		const read = options.read ?? readProcessStartIdentity;
		const deadline = Date.now() + (options.timeoutMs ?? 250);
		do {
			const identity = read(pid);
			if (identity) return identity;
			if (!runnerIsAlive(pid) || Date.now() >= deadline) return undefined;
			yield* Effect.sleep(options.intervalMs ?? 20);
		} while (Date.now() <= deadline);
		return undefined;
	});
}

function waitForRunnerClose(proc: ReturnType<typeof spawn>, timeoutMs: number): Effect.Effect<boolean> {
	if (proc.exitCode !== null || proc.signalCode !== null) return Effect.succeed(true);
	const closed = Effect.callback<void>((resume) => {
		const onClose = () => resume(Effect.void);
		proc.once("close", onClose);
		return Effect.sync(() => proc.removeListener("close", onClose));
	});
	return Effect.raceFirst(closed.pipe(Effect.as(true)), Effect.sleep(timeoutMs).pipe(Effect.as(false)));
}

function terminateExactSpawnedRunner(proc: ReturnType<typeof spawn>): Effect.Effect<boolean> {
	return Effect.gen(function* () {
		if (proc.exitCode !== null || proc.signalCode !== null) return true;
		try {
			proc.kill("SIGTERM");
		} catch {}
		if (yield* waitForRunnerClose(proc, 250)) return true;
		try {
			proc.kill("SIGKILL");
		} catch {}
		return yield* waitForRunnerClose(proc, 1_000);
	});
}

export function terminateRunnerBeforeProceed(pid: number, expectedProcessStartIdentity?: string): boolean {
	if (!expectedProcessStartIdentity) return false;
	// This callback can run on Pi's UI/session event path. Signal the exact,
	// still-gated process group immediately, but never synchronously wait for OS
	// reaping. A caller may release authority only if absence is already proven;
	// otherwise the close observer/reconciler retains and settles the lease.
	for (const signal of ["SIGTERM", "SIGKILL"] as const) {
		const before = runnerIdentityState(pid, expectedProcessStartIdentity);
		if (before === false) return true;
		if (before === undefined) return false;
		try {
			// Detached runners lead their process group. Signalling the group also
			// reaps any writer that crossed its own exec gate before cancellation.
			process.kill(process.platform === "win32" ? pid : -pid, signal);
		} catch {
			if (runnerIdentityState(pid, expectedProcessStartIdentity) === false) return true;
			return false;
		}
	}
	return runnerIdentityState(pid, expectedProcessStartIdentity) === false;
}

export function removeRunnerStartupMarkerBestEffort(
	startupPath: string,
	rm: (filePath: string, options: { force: boolean }) => void = fs.rmSync,
): void {
	try {
		rm(startupPath, { force: true });
	} catch (error) {
		reportAgentDiagnostic(`Failed to remove acknowledged Agent runner startup marker '${startupPath}':`, error);
	}
}

export function finalizeSpawnedRunnerClose(input: {
	readonly launchConfig: BackgroundRunnerConfig;
	readonly runnerProcessInstanceId: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;
	readonly onProcessTerminal?: ((proof: ProcessTerminalNotice) => void) | undefined;
}): void {
	try {
		finalizeProcessTerminal(input.launchConfig.asyncDir, input.launchConfig.id, {
			processInstanceId: input.runnerProcessInstanceId,
			closeObservedAt: Date.now(),
			exitCode: input.exitCode,
			signal: input.signal,
		});
		const persisted = readProcessTerminal(input.launchConfig.asyncDir, {
			runId: input.launchConfig.id,
			runnerProcessInstanceId: input.runnerProcessInstanceId,
		});
		if (!persisted) return;
		if (input.launchConfig.nestedRoute && input.launchConfig.nestedSelf) {
			try {
				const status = resolveNestedTerminalStatus(input.launchConfig, persisted);
				const fallback: Parameters<typeof nestedSummaryFromAsyncStatus>[2] = {
					id: input.launchConfig.id,
					parentRunId: input.launchConfig.nestedSelf.parentRunId,
					depth: input.launchConfig.nestedSelf.depth,
					mode: status.mode,
					ts: Date.now(),
				};
				if (input.launchConfig.nestedSelf.parentStepIndex !== undefined)
					fallback.parentStepIndex = input.launchConfig.nestedSelf.parentStepIndex;
				if (input.launchConfig.nestedSelf.path !== undefined) fallback.path = input.launchConfig.nestedSelf.path;
				const child = nestedSummaryFromAsyncStatus(status, input.launchConfig.asyncDir, fallback);
				const event: Parameters<typeof writeNestedEvent>[1] = {
					type: "subagent.nested.completed",
					ts: Date.now(),
					parentRunId: input.launchConfig.nestedSelf.parentRunId,
					child,
				};
				if (input.launchConfig.nestedSelf.parentStepIndex !== undefined)
					event.parentStepIndex = input.launchConfig.nestedSelf.parentStepIndex;
				writeNestedEvent(input.launchConfig.nestedRoute, event);
			} catch (error) {
				if (errnoCode(error) !== "ENOENT") {
					reportAgentDiagnostic("Failed to emit final nested Agent state:", error);
				}
			}
		}
		try {
			const notice: ProcessTerminalNotice = {
				...persisted,
				asyncDir: input.launchConfig.asyncDir,
			};
			if (input.launchConfig.sessionId !== undefined) notice.sessionId = input.launchConfig.sessionId;
			input.onProcessTerminal?.(notice);
		} catch (error) {
			reportAgentDiagnostic(`Process-terminal observer failed for '${input.launchConfig.id}':`, error);
		}
	} catch (error) {
		// Close listeners execute outside the launch promise. Filesystem failure
		// must leave evidence for stale reconciliation, never crash the parent Pi.
		reportAgentDiagnostic(
			`Failed to finalize background runner '${input.launchConfig.id}' after process close:`,
			error,
		);
	}
}

/** Persist writer absence while a parent-owned startup gate still blocks every writer. */
export function initializePreIdentityWriterAbsenceProof(config: BackgroundRunnerConfig, runnerPid: number): boolean {
	if (!config.startupGateToken && !config.revivalLease) return false;
	initializeWriterProcessRegistry(
		config.asyncDir,
		config.id,
		runnerPid,
		config.work.mode === "single" ? 1 : config.work.group.tasks.length,
	);
	return true;
}

interface RunnerStartupPaths {
	readonly startupPath: string | undefined;
	readonly startupAckPath: string | undefined;
	readonly startupProceedPath: string | undefined;
	readonly startupGatePath: string | undefined;
}

interface RunnerLaunchState {
	readonly bunCommand: string;
	readonly cwd: string;
	readonly launchConfig: BackgroundRunnerConfig;
	readonly runnerProcessInstanceId: string;
	readonly startupPaths: RunnerStartupPaths;
	readonly onProcessTerminal: ((proof: ProcessTerminalNotice) => void) | undefined;
	readonly onStatus: ((status: AsyncStatusNotice) => void) | undefined;
	launchAborted: boolean;
	configPath?: string | undefined;
	proc?: ReturnType<typeof spawn> | undefined;
	processStartIdentity?: string | undefined;
	stdoutFd?: number | undefined;
	stderrFd?: number | undefined;
}

interface StartedRunner {
	readonly pid: number;
	readonly processStartIdentity: string;
}

interface StartupAuthorization {
	readonly path: string | undefined;
	readonly token: string | undefined;
	readonly markerToRemove: string | undefined;
}

function resolveRunnerStartupPaths(config: BackgroundRunnerConfig): RunnerStartupPaths {
	const startupPath = config.revivalLease ? path.join(config.asyncDir, "runner-startup.json") : undefined;
	return {
		startupPath,
		startupAckPath: startupPath ? path.join(config.asyncDir, "runner-startup-ack.json") : undefined,
		startupProceedPath: startupPath ? path.join(config.asyncDir, "runner-startup-proceed.json") : undefined,
		startupGatePath: config.startupGateToken ? path.join(config.asyncDir, "runner-startup-gate.json") : undefined,
	};
}

function writeFailedStartupStatus(
	config: BackgroundRunnerConfig,
	pid: number,
	error: string,
	processStartIdentity?: string,
): void {
	const status = createInitialStatus(config, config.startedAt ?? Date.now(), pid, processStartIdentity);
	const endedAt = Date.now();
	status.state = "failed";
	status.endedAt = endedAt;
	status.lastUpdate = endedAt;
	status.error = error;
	for (const step of status.steps) {
		step.status = "failed";
		step.endedAt = endedAt;
		step.exitCode = 1;
		step.error = error;
	}
	writePrivateAtomicJson(path.join(config.asyncDir, "status.json"), status);
}

function abortRunnerAndWriters(asyncDir: string, pid: number, processStartIdentity: string): boolean {
	if (!terminateRunnerBeforeProceed(pid, processStartIdentity)) return false;
	terminateOrphanWriterProcesses(asyncDir);
	return inspectWriterProcessLiveness(asyncDir) === false;
}

function startRunnerProcess(state: RunnerLaunchState, suffix: string): Effect.Effect<StartedRunner, unknown> {
	return Effect.gen(function* () {
		const { launchConfig } = state;
		const proc = yield* Effect.try({
			try: () => {
				ensurePrivateDirectory(TEMP_ROOT_DIR);
				ensurePrivateDirectory(launchConfig.asyncDir);
				state.configPath = getAsyncConfigPath(suffix);
				fs.writeFileSync(state.configPath, JSON.stringify(launchConfig), { encoding: "utf-8", mode: 0o600 });
				for (const filePath of Object.values(state.startupPaths)) {
					if (filePath) fs.rmSync(filePath, { force: true });
				}
				const logPaths = resolveAsyncRunnerLogPaths(launchConfig);
				ensurePrivateDirectory(path.dirname(logPaths.stdoutPath));
				state.stdoutFd = fs.openSync(logPaths.stdoutPath, "a", 0o600);
				state.stderrFd = fs.openSync(logPaths.stderrPath, "a", 0o600);
				const env = Object.assign({}, process.env);
				env["PI_STUFF_BACKGROUND_RUNNER"] = "1";
				env["PI_STUFF_BACKGROUND_RUNNER_CONFIG"] = state.configPath;
				if (piPackageRoot) env[PI_CODING_AGENT_PACKAGE_ROOT_ENV] = piPackageRoot;
				const runner = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-runner.ts");
				const spawned = spawn(state.bunCommand, [runner, state.configPath], {
					cwd: state.cwd,
					detached: true,
					stdio: ["ignore", state.stdoutFd, state.stderrFd, "ipc"],
					windowsHide: true,
					env,
				});
				state.proc = spawned;
				closeFd(state.stdoutFd);
				closeFd(state.stderrFd);
				spawned.on("error", (error) => {
					reportAgentDiagnostic(`[pi-stuff-agents] background runner spawn failed: ${error.message}`);
				});
				spawned.once("close", (exitCode, signal) => {
					if (state.launchAborted) return;
					finalizeSpawnedRunnerClose({
						launchConfig,
						runnerProcessInstanceId: state.runnerProcessInstanceId,
						exitCode,
						signal,
						onProcessTerminal: state.onProcessTerminal,
					});
				});
				spawned.on("message", (message) => {
					if (!message || !isRuntimeObject(message)) return;
					// SAFETY: Node's IPC callback and the object guard establish an inspectable runner-status envelope.
					const update = message as RunnerStatusMessage;
					if (
						update.type !== SUBAGENT_ASYNC_STATUS_EVENT ||
						update.asyncDir !== launchConfig.asyncDir ||
						!update.status ||
						!isRuntimeObject(update.status) ||
						!("runId" in update.status) ||
						update.status.runId !== launchConfig.id
					)
						return;
					try {
						const notice: AsyncStatusNotice = {
							id: launchConfig.id,
							asyncDir: launchConfig.asyncDir,
							status: update.status,
						};
						if (launchConfig.sessionId !== undefined) notice.sessionId = launchConfig.sessionId;
						state.onStatus?.(notice);
					} catch (error) {
						reportAgentDiagnostic(`Agent status observer failed for '${launchConfig.id}':`, error);
					}
				});
				if (!isRuntimeNumber(spawned.pid)) {
					state.launchAborted = true;
					throw new Error(`background runner has no pid for cwd: ${state.cwd}`);
				}
				initializePreIdentityWriterAbsenceProof(launchConfig, spawned.pid);
				return spawned;
			},
			catch: (error) => error,
		});
		const pid = proc.pid;
		if (!isRuntimeNumber(pid))
			return yield* Effect.fail(new Error(`background runner has no pid for cwd: ${state.cwd}`));
		const processStartIdentity = yield* acquireRunnerProcessStartIdentity(pid);
		if (!processStartIdentity) {
			state.launchAborted = true;
			return yield* Effect.fail(new Error(`background runner ${pid} has no stable process-start identity`));
		}
		state.processStartIdentity = processStartIdentity;
		proc.unref();
		proc.channel?.unref?.();
		return { pid, processStartIdentity };
	});
}

function failBeforeRunnerProceed(state: RunnerLaunchState, runner: StartedRunner, error: string): never {
	state.launchAborted = true;
	terminateRunnerBeforeProceed(runner.pid, runner.processStartIdentity);
	throw new Error(error);
}

function authorizeRunnerStartup(
	state: RunnerLaunchState,
	runner: StartedRunner,
): Effect.Effect<StartupAuthorization, unknown> {
	return Effect.gen(function* () {
		const { launchConfig, startupPaths } = state;
		if (launchConfig.startupGateToken && startupPaths.startupGatePath) {
			try {
				writePrivateAtomicJson(
					path.join(launchConfig.asyncDir, "status.json"),
					createInitialStatus(
						launchConfig,
						launchConfig.startedAt ?? Date.now(),
						runner.pid,
						runner.processStartIdentity,
					),
				);
				initializeWriterProcessRegistry(
					launchConfig.asyncDir,
					launchConfig.id,
					runner.pid,
					launchConfig.work.mode === "single" ? 1 : launchConfig.work.group.tasks.length,
				);
			} catch (error) {
				state.launchAborted = true;
				terminateRunnerBeforeProceed(runner.pid, runner.processStartIdentity);
				try {
					writeFailedStartupStatus(launchConfig, runner.pid, "Background runner startup could not be committed.");
				} catch {
					// The caller owns exact directory cleanup after the runner is reaped.
				}
				return yield* Effect.fail(
					new Error(
						`Failed to commit background runner startup: ${error instanceof Error ? error.message : String(error)}`,
					),
				);
			}
		}
		let authorizationPath = startupPaths.startupGatePath;
		let authorizationToken = launchConfig.startupGateToken;
		let markerToRemove: string | undefined;
		if (startupPaths.startupPath && startupPaths.startupAckPath && startupPaths.startupProceedPath) {
			const ready = yield* waitForRunnerStartup(
				startupPaths.startupPath,
				"ready",
				RUNNER_STARTUP_TIMEOUT_MS,
				undefined,
				runner.pid,
				runner.processStartIdentity,
			);
			if (!ready.ok) failBeforeRunnerProceed(state, runner, ready.error);
			try {
				writeRunnerStartupControl(startupPaths.startupAckPath, { action: "ack", token: ready.token });
			} catch (error) {
				failBeforeRunnerProceed(
					state,
					runner,
					`Failed to acknowledge background runner startup: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
			const acknowledged = yield* waitForRunnerStartup(
				startupPaths.startupPath,
				"acknowledged",
				RUNNER_STARTUP_TIMEOUT_MS,
				ready.token,
				runner.pid,
				runner.processStartIdentity,
			);
			if (!acknowledged.ok) failBeforeRunnerProceed(state, runner, acknowledged.error);
			authorizationPath = startupPaths.startupProceedPath;
			authorizationToken = ready.token;
			markerToRemove = startupPaths.startupPath;
		}
		return { path: authorizationPath, token: authorizationToken, markerToRemove };
	});
}

function createCommittedRunnerLifecycle(
	state: RunnerLaunchState,
	runner: StartedRunner,
	authorization: StartupAuthorization,
): SpawnRunnerResult {
	const lifecycle: SpawnRunnerResult = {
		pid: runner.pid,
		processStartIdentity: runner.processStartIdentity,
	};
	if (!authorization.path || !authorization.token) return lifecycle;
	const authorizationPath = authorization.path;
	const authorizationToken = authorization.token;
	let acknowledged = false;
	let aborted = false;
	lifecycle.acknowledgeStart = () => {
		if (aborted) throw new Error("Background runner startup was already aborted.");
		if (acknowledged) return;
		writeRunnerStartupControl(authorizationPath, { action: "proceed", token: authorizationToken });
		if (authorization.markerToRemove) removeRunnerStartupMarkerBestEffort(authorization.markerToRemove);
		acknowledged = true;
	};
	lifecycle.abortStart = () => {
		if (aborted) {
			return (
				runnerIdentityState(runner.pid, runner.processStartIdentity) === false &&
				inspectWriterProcessLiveness(state.launchConfig.asyncDir) === false
			);
		}
		if (!abortRunnerAndWriters(state.launchConfig.asyncDir, runner.pid, runner.processStartIdentity)) return false;
		aborted = true;
		state.launchAborted = true;
		fs.rmSync(authorizationPath, { force: true });
		if (authorization.markerToRemove) fs.rmSync(authorization.markerToRemove, { force: true });
		if (state.configPath) fs.rmSync(state.configPath, { force: true });
		writeFailedStartupStatus(
			state.launchConfig,
			runner.pid,
			"Background runner startup was cancelled before ownership committed.",
		);
		return true;
	};
	return lifecycle;
}

function recoverRunnerLaunch(state: RunnerLaunchState, message: string): Effect.Effect<SpawnRunnerResult> {
	return Effect.gen(function* () {
		const safeToCleanup = state.proc ? yield* terminateExactSpawnedRunner(state.proc) : true;
		state.launchAborted = safeToCleanup;
		closeFd(state.stdoutFd);
		closeFd(state.stderrFd);
		if (state.configPath) {
			try {
				fs.rmSync(state.configPath, { force: true });
			} catch {
				// A failed launch already returns the primary setup error.
			}
		}
		const pid = state.proc?.pid;
		const processStartIdentity = state.processStartIdentity;
		if (!safeToCleanup && isRuntimeNumber(pid) && processStartIdentity) {
			try {
				writeFailedStartupStatus(
					state.launchConfig,
					pid,
					`Background runner startup failed while process recovery remained pending: ${message}`,
					processStartIdentity,
				);
			} catch {
				// The retained lifecycle binding and preparation marker remain the
				// authority when status persistence itself caused the launch error.
			}
			let aborted = false;
			return {
				error: message,
				safeToCleanup: false,
				pid,
				processStartIdentity,
				abortStart: () => {
					if (aborted) return true;
					if (!abortRunnerAndWriters(state.launchConfig.asyncDir, pid, processStartIdentity)) return false;
					aborted = true;
					state.launchAborted = true;
					return true;
				},
			};
		}
		const failure: SpawnRunnerResult = { error: message, safeToCleanup };
		if (isRuntimeNumber(pid)) failure.pid = pid;
		return failure;
	});
}

export function spawnRunner(
	cfg: BackgroundRunnerConfig,
	suffix: string,
	cwd: string,
	onProcessTerminal?: (proof: ProcessTerminalNotice) => void,
	onStatus?: (status: AsyncStatusNotice) => void,
): Effect.Effect<SpawnRunnerResult> {
	const bunCommand = resolveAsyncRunnerBunCommand();
	if (!bunCommand) {
		return Effect.succeed({
			error: "Bun is required to launch background Agents but no executable was found on PATH or BUN_INSTALL",
		});
	}
	try {
		if (!fs.statSync(cwd).isDirectory()) return Effect.succeed({ error: `cwd is not a directory: ${cwd}` });
	} catch {
		return Effect.succeed({ error: `cwd does not exist: ${cwd}` });
	}
	const runnerProcessInstanceId = randomUUID();
	const startedAt = Date.now();
	const startupGateToken = cfg.revivalLease ? undefined : randomUUID();
	const launchConfig: BackgroundRunnerConfig = { ...cfg, runnerProcessInstanceId, startedAt };
	if (startupGateToken) launchConfig.startupGateToken = startupGateToken;
	const state: RunnerLaunchState = {
		bunCommand,
		cwd,
		launchConfig,
		runnerProcessInstanceId,
		startupPaths: resolveRunnerStartupPaths(launchConfig),
		onProcessTerminal,
		onStatus,
		launchAborted: false,
	};
	return Effect.gen(function* () {
		const launched = yield* Effect.gen(function* () {
			const runner = yield* startRunnerProcess(state, suffix);
			const authorization = yield* authorizeRunnerStartup(state, runner);
			return createCommittedRunnerLifecycle(state, runner, authorization);
		}).pipe(
			Effect.catch((error) => recoverRunnerLaunch(state, error instanceof Error ? error.message : String(error))),
		);
		return launched;
	});
}
