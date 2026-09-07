/** Own one Agent writer process from spawn through verified group teardown. */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { isRuntimeNumber } from "../../../../shared/runtime-type.js";
import type { ChildTranscriptWriter } from "../../shared/child-transcript.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import type { AgentContextUsage, ProtocolOutputLimit, Usage } from "../../shared/types.ts";
import type { ChildProtocolMessage } from "../shared/child-protocol.ts";
import type { BackgroundRunnerConfig, BackgroundTaskResult, RunnerAgentTask } from "../shared/parallel-utils.ts";
import { buildPiArgs, cleanupTempDir } from "../shared/pi-args.ts";
import { getPiSpawnCommand, type PiSpawnDeps } from "../shared/pi-spawn.ts";
import { readChildToolDiagnosticError } from "../shared/tool-availability.ts";
import { ChildProtocolRuntime, type ChildProtocolSnapshot } from "./child-protocol-runtime.ts";
import { steerAcksDir, steerCapabilityPath, stepSteerInboxDir } from "./control-channel.ts";
import type {
	BackgroundRunnerStatus as RunnerStatus,
	BackgroundRunnerStatusStep as RunnerStatusStep,
} from "./initial-status.ts";
import {
	buildWriterProcessEnv,
	buildWriterSpawnCommand,
	captureWriterProcessStartIdentity,
	closeWriterProcessGroup,
	ponytailWriterEnvironmentOverrides,
	readWriterSupervisorDisposition,
	trySignalChild,
} from "./writer-process-lifecycle.ts";
import { reapOrphanWriterProcesses, type WriterRuntimeState } from "./writer-process-registry.ts";

export interface ChildProcessResult {
	exitCode: number | null;
	signal: string | null;
	stderr: string;
	messages: ChildProtocolMessage[];
	output: string;
	error?: string | undefined;
	protocolError?: ProtocolOutputLimit | undefined;
	usage: Usage;
	costReported?: boolean;
	toolCount: number;
	toolBudgetBlockedTool?: string | undefined;
	durationMs: number;
	model?: string | undefined;
	contextUsage?: AgentContextUsage | undefined;
	interrupted?: boolean | undefined;
	timedOut?: boolean | undefined;
	stopped?: boolean | undefined;
	contextNudgeObserved?: boolean | undefined;
	process?: WriterProcess | undefined;
}

export type WriterProcess = NonNullable<BackgroundTaskResult["writerProcesses"]>[number];

export interface ChildRuntimeControl {
	state: "running" | "paused" | "timed-out" | "stopped" | "failed";
	interrupt(kind: "pause" | "timeout" | "stop"): void;
	revokeFinalization(): void;
}

type ChildTerminalCause = "pause" | "timeout" | "stop" | "tool-timeout" | "protocol" | "setup";
type WriterControlCommand = "cancel-finalize" | "finalize" | "proceed" | "terminate-sigint" | "terminate-sigterm";
type ChildLifecycleEvent =
	| { readonly type: "close"; readonly exitCode: number | null; readonly signal: NodeJS.Signals | null }
	| { readonly type: "wake" };

export interface ChildProcessEngineInput {
	config: BackgroundRunnerConfig;
	task: RunnerAgentTask;
	index: number;
	model?: string | undefined;
	taskCwd: string;
	sessionDir?: string | undefined;
	outputFile: string;
	transcript: ChildTranscriptWriter;
	artifactJsonlPath?: string | undefined;
	statusStep: RunnerStatusStep;
	statusPath: string;
	status: RunnerStatus;
	activeControls: Map<number, ChildRuntimeControl>;
	consumeScheduledStop: () => boolean;
	preStartTerminalCause?: () => "pause" | "timeout" | "stop" | undefined;
	onWriterProcess?: ((writer: WriterRuntimeState) => void) | undefined;
}

function buildChildLaunch(input: ChildProcessEngineInput) {
	const built = buildPiArgs({
		governorSessionId: input.task.governorSessionId,
		physicalSessionId: input.task.physicalSessionId,
		parentSessionId: input.task.parentSessionId,
		baseArgs: ["--mode", "json", "-p"],
		task: input.task.task,
		sessionEnabled: Boolean(input.task.sessionFile || input.sessionDir),
		sessionDir: input.task.sessionFile ? undefined : input.sessionDir,
		sessionFile: input.task.sessionFile,
		model: input.model,
		thinking: input.task.thinking,
		inheritProjectContext: input.task.inheritProjectContext,
		inheritSkills: input.task.inheritSkills,
		codeModeEnabled: input.config.codeModeEnabled,
		codeModeProviderTools: input.config.codeModeProviderTools,
		childBaseExtensionPath: input.task.childBaseExtensionPath,
		requireReadTool: input.task.inheritSkills || Boolean(input.task.skills?.length),
		tools: input.task.tools,
		excludeTools: input.task.excludeTools,
		extensions: input.task.extensions,
		subagentOnlyExtensions: input.task.subagentOnlyExtensions,
		systemPrompt: input.task.systemPrompt,
		systemPromptMode: input.task.systemPromptMode,
		mcpDirectTools: input.task.mcpDirectTools,
		capabilityCeiling: input.task.capabilityCeiling ?? input.config.capabilityCeiling,
		cwd: input.taskCwd,
		promptFileStem: input.task.agent,
		intercomSessionName: input.config.childIntercomTargets?.[input.index],
		orchestratorIntercomTarget: input.config.controlIntercomTarget,
		enableNativeSupervisor: input.config.nativeSupervisor === true,
		runId: input.config.id,
		logicalAgentPathComponent: input.task.logicalAgentPathComponent,
		childAgentName: input.task.agent,
		childIndex: input.index,
		parentEventSink: input.config.nestedRoute?.eventSink,
		parentControlInbox: input.config.nestedRoute?.controlInbox,
		parentRootRunId: input.config.nestedRoute?.rootRunId,
		parentCapabilityToken: input.config.nestedRoute?.capabilityToken,
		steerInboxDir: stepSteerInboxDir(input.config.asyncDir, input.index),
		steerCapabilityPath: steerCapabilityPath(input.config.asyncDir, input.index),
		steerAckDir: steerAcksDir(input.config.asyncDir, input.index),
		toolBudget: input.task.toolBudget,
	});
	const deps: PiSpawnDeps = {};
	if (input.config.piPackageRoot) deps.piPackageRoot = input.config.piPackageRoot;
	if (input.config.piArgv1) deps.argv1 = input.config.piArgv1;
	if (input.config.piExecutable) deps.execPath = input.config.piExecutable;
	return { built, spawnSpec: getPiSpawnCommand(built.args, deps) };
}

function bestEffort(action: () => void): void {
	try {
		action();
	} catch {}
}

export class ChildProcessEngine {
	private readonly input: ChildProcessEngineInput;
	private readonly startedAt = Date.now();
	private readonly processInstanceId = randomUUID();
	private readonly built: ReturnType<typeof buildPiArgs>;
	private readonly spawnSpec: ReturnType<typeof getPiSpawnCommand>;
	private readonly supervisorDispositionPath: string;
	private readonly groupMemberProofFile: string;
	private readonly groupMemberProofPath: string;
	private readonly writerControl: { readonly path: string; readonly token: string } | undefined;
	private writerControlSequence = 0;
	private writerControlError: Error | undefined;
	private child!: ReturnType<typeof spawn>;
	private childStdin!: NonNullable<ReturnType<typeof spawn>["stdin"]>;
	private childStdout!: NonNullable<ReturnType<typeof spawn>["stdout"]>;
	private childStderr!: NonNullable<ReturnType<typeof spawn>["stderr"]>;
	private writerSpawn!: ReturnType<typeof buildWriterSpawnCommand>;
	private writerPid!: number;
	private writerProcessStartIdentity!: string;
	private protocol!: ChildProtocolRuntime;
	private lifecycleEvents!: Queue.Queue<ChildLifecycleEvent>;
	private runtimeControl: ChildRuntimeControl | undefined;
	private writerProcessBindingError: unknown;
	private terminalCause: ChildTerminalCause | undefined;
	private forcedError: string | undefined;
	private settled = false;
	private childExited = false;
	private finalDrainEvidence = false;
	private finalDrainSignalSent = false;
	private finalDrainHardKillSignalSent = false;
	private finalDrainAt: number | undefined;
	private finalDrainHardKillAt: number | undefined;
	private terminationHardKillAt: number | undefined;
	private stdioIdleAt: number | undefined;
	private stdioHardAt: number | undefined;
	private stdoutEnded = false;
	private stderrEnded = false;

	constructor(input: ChildProcessEngineInput) {
		this.input = input;
		({ built: this.built, spawnSpec: this.spawnSpec } = buildChildLaunch(input));
		this.supervisorDispositionPath = path.join(
			this.built.tempDir ?? input.config.asyncDir,
			`writer-supervisor-terminal-${input.index}-${this.processInstanceId}.json`,
		);
		this.groupMemberProofFile = `writer-group-member-${input.index}-${this.processInstanceId}.json`;
		this.groupMemberProofPath = path.join(input.config.asyncDir, this.groupMemberProofFile);
		this.writerControl =
			process.platform === "win32"
				? undefined
				: {
						path: path.join(
							input.config.asyncDir,
							`writer-supervisor-control-${input.index}-${this.processInstanceId}.jsonl`,
						),
						token: randomUUID(),
					};
	}

	run(): Effect.Effect<ChildProcessResult, unknown> {
		return Effect.gen({ self: this }, function* () {
			this.lifecycleEvents = yield* Queue.unbounded<ChildLifecycleEvent>();
			yield* Effect.try({ try: () => this.spawnWriter(), catch: (error) => error });
			yield* this.captureWriterIdentity();
			this.bindWriter();
			this.installRuntime();
			yield* Effect.try({ try: () => this.releaseStartupGate(), catch: (error) => error });
			return yield* this.awaitClose();
		}).pipe(Effect.ensuring(Effect.sync(() => this.teardown())));
	}

	private removeWriterControl(): void {
		if (!this.writerControl) return;
		try {
			fs.rmSync(this.writerControl.path, { force: true });
		} catch {
			// The private run directory is retained for bounded maintenance.
		}
	}

	private rollBackLaunch(): void {
		this.removeWriterControl();
		try {
			this.input.onWriterProcess?.({ state: "none" });
		} catch (error) {
			reportAgentDiagnostic(
				`Failed to roll back Agent writer process identity for child ${this.input.index}:`,
				error,
			);
		}
		cleanupTempDir(this.built.tempDir);
	}

	private spawnWriter(): void {
		try {
			this.input.onWriterProcess?.({ state: "spawning" });
		} catch (error) {
			this.rollBackLaunch();
			throw error;
		}
		try {
			if (this.writerControl) {
				fs.writeFileSync(this.writerControl.path, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
			}
			this.writerSpawn = buildWriterSpawnCommand(
				this.spawnSpec.command,
				this.spawnSpec.args,
				process.platform,
				this.supervisorDispositionPath,
				this.groupMemberProofPath,
				undefined,
				this.writerControl,
			);
			this.child = spawn(this.writerSpawn.command, this.writerSpawn.args, {
				cwd: this.input.taskCwd,
				detached: process.platform !== "win32",
				stdio: ["pipe", "pipe", "pipe"],
				env: buildWriterProcessEnv(
					process.env,
					{ ...this.built.env, ...ponytailWriterEnvironmentOverrides(this.input.config.ponytailMode) },
					this.input.task.maxSubagentDepth,
				),
				windowsHide: true,
			});
			this.child.on("error", (error) => {
				this.forcedError ??= `Agent writer supervisor failed to start: ${error.message}`;
				this.clearStdioDeadlines();
				this.wakeLifecycle();
			});
		} catch (error) {
			this.rollBackLaunch();
			throw error;
		}
	}

	private captureWriterIdentity(): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			const pid = this.child.pid;
			const identity = isRuntimeNumber(pid) ? yield* captureWriterProcessStartIdentity(pid) : undefined;
			if (!isRuntimeNumber(pid) || !identity) {
				bestEffort(() => this.child.kill("SIGKILL"));
				this.rollBackLaunch();
				return yield* Effect.fail(new Error("Agent writer process has no stable process-start identity."));
			}
			this.writerPid = pid;
			this.writerProcessStartIdentity = identity;
			const { stdin, stdout, stderr } = this.child;
			if (!stdin || !stdout || !stderr) {
				trySignalChild(this.child, "SIGTERM", identity);
				this.rollBackLaunch();
				return yield* Effect.fail(new Error("Agent writer process did not expose stdout and stderr pipes."));
			}
			this.childStdin = stdin;
			this.childStdout = stdout;
			this.childStderr = stderr;
			this.childStdin.on("error", (error: Error) => {
				this.writerControlError ??= error;
			});
		});
	}

	private bindWriter(): void {
		try {
			const writerState: WriterRuntimeState = {
				state: "running",
				pid: this.writerPid,
				processStartIdentity: this.writerProcessStartIdentity,
			};
			if (this.writerSpawn.gated) writerState.groupMemberProofFile = this.groupMemberProofFile;
			this.input.onWriterProcess?.(writerState);
		} catch (error) {
			this.writerProcessBindingError = error;
		}
	}

	private sendSupervisorControl(
		command: WriterControlCommand,
		settleDelivery?: (delivered: boolean) => void,
	): boolean {
		if (!this.writerSpawn.gated) return false;
		try {
			if (this.writerControl) {
				this.writerControlSequence += 1;
				fs.appendFileSync(
					this.writerControl.path,
					`${JSON.stringify({
						version: 1,
						token: this.writerControl.token,
						sequence: this.writerControlSequence,
						command,
					})}\n`,
					{ encoding: "utf8" },
				);
				settleDelivery?.(true);
				return true;
			}
			if (this.childStdin.destroyed || this.childStdin.writableEnded) return false;
			this.childStdin.write(`${command}\n`, (error?: Error | null) => {
				if (error) this.writerControlError ??= error;
				settleDelivery?.(!error);
			});
			return true;
		} catch (error) {
			if (error instanceof Error) this.writerControlError ??= error;
			settleDelivery?.(false);
			return false;
		}
	}

	private requestTermination(signal: "SIGINT" | "SIGTERM"): boolean {
		if (!this.writerSpawn.gated) {
			return trySignalChild(this.child, signal, this.writerProcessStartIdentity);
		}
		const queued = this.sendSupervisorControl(
			signal === "SIGINT" ? "terminate-sigint" : "terminate-sigterm",
			(delivered) => {
				if (!delivered && !this.settled) {
					trySignalChild(this.child, signal, this.writerProcessStartIdentity);
				}
			},
		);
		return queued || trySignalChild(this.child, signal, this.writerProcessStartIdentity);
	}

	private cancelFinalDrain(preserveSemanticEvidence = false): void {
		this.finalDrainAt = undefined;
		const signalWasSent = this.finalDrainSignalSent || this.finalDrainHardKillSignalSent;
		if (signalWasSent && this.writerSpawn.gated) {
			const queued = this.sendSupervisorControl("cancel-finalize", (delivered) => {
				if (!delivered || this.settled) return;
				this.finalDrainHardKillAt = undefined;
				if (!preserveSemanticEvidence)
					this.finalDrainEvidence = this.finalDrainSignalSent = this.finalDrainHardKillSignalSent = false;
				this.wakeLifecycle();
			});
			if (queued) {
				this.wakeLifecycle();
				return;
			}
		}
		if (preserveSemanticEvidence && signalWasSent) {
			this.wakeLifecycle();
			return;
		}
		this.finalDrainHardKillAt = undefined;
		this.finalDrainEvidence = this.finalDrainSignalSent = this.finalDrainHardKillSignalSent = false;
		this.wakeLifecycle();
	}

	private armTerminationHardKill(): void {
		this.terminationHardKillAt = Date.now() + 8_000;
		this.wakeLifecycle();
	}

	private claimTerminalCause(cause: ChildTerminalCause): boolean {
		if (this.settled || this.terminalCause) return false;
		this.terminalCause = cause;
		if (this.runtimeControl) {
			this.runtimeControl.state =
				cause === "pause" ? "paused" : cause === "timeout" ? "timed-out" : cause === "stop" ? "stopped" : "failed";
		}
		return true;
	}

	private terminate(kind: "pause" | "timeout" | "stop"): void {
		if (!this.claimTerminalCause(kind)) return;
		this.cancelFinalDrain();
		this.forcedError =
			kind === "pause" ? "Agent paused." : kind === "timeout" ? "Agent timed out." : "Agent stopped by user.";
		this.requestTermination(kind === "pause" ? "SIGINT" : "SIGTERM");
		this.armTerminationHardKill();
	}

	private startFinalDrain(evidence: boolean): void {
		this.finalDrainEvidence = evidence;
		if (this.childExited || this.finalDrainAt || this.finalDrainSignalSent || this.settled || this.terminalCause)
			return;
		this.finalDrainAt = Date.now() + 1_000;
		this.wakeLifecycle();
	}

	private requestFinalDrain(): void {
		this.finalDrainAt = undefined;
		if (this.settled) return;
		const requested = this.writerSpawn.gated
			? this.sendSupervisorControl("finalize", (delivered) => {
					if (this.settled) return;
					if (!delivered) {
						this.finalDrainEvidence = false;
						return;
					}
					this.finalDrainSignalSent = true;
					this.armFinalDrainWatchdog();
				})
			: trySignalChild(this.child, "SIGTERM", this.writerProcessStartIdentity);
		if (!requested) {
			this.finalDrainEvidence = false;
			return;
		}
		if (!this.writerSpawn.gated) {
			this.finalDrainSignalSent = true;
			this.armFinalDrainWatchdog();
		}
	}

	private armFinalDrainWatchdog(): void {
		this.finalDrainHardKillAt = Date.now() + (this.writerSpawn.gated ? 8_000 : 3_000);
		this.wakeLifecycle();
	}

	private terminateProtocol(cause: "protocol" | "tool-timeout", error: string, signal: "SIGINT" | "SIGTERM"): boolean {
		if (!this.claimTerminalCause(cause)) return false;
		this.forcedError = error;
		this.cancelFinalDrain();
		const requested = this.requestTermination(signal);
		if (requested) this.armTerminationHardKill();
		return true;
	}

	private installRuntime(): void {
		this.runtimeControl = {
			state: "running",
			interrupt: (kind) => this.terminate(kind),
			revokeFinalization: () => this.cancelFinalDrain(true),
		};
		this.input.activeControls.set(this.input.index, this.runtimeControl);
		const terminalCause = this.input.preStartTerminalCause?.();
		if (terminalCause) this.terminate(terminalCause);
		else if (this.input.consumeScheduledStop()) this.terminate("stop");
		this.protocol = new ChildProtocolRuntime({
			config: this.input.config,
			task: this.input.task,
			index: this.input.index,
			model: this.input.model,
			transcript: this.input.transcript,
			artifactJsonlPath: this.input.artifactJsonlPath,
			statusStep: this.input.statusStep,
			statusPath: this.input.statusPath,
			status: this.input.status,
			startFinalDrain: (evidence) => this.startFinalDrain(evidence),
			cancelFinalDrain: () => this.cancelFinalDrain(),
			scheduleTimeout: (delayMs, action) => {
				const timer = setTimeout(action, delayMs);
				timer.unref();
				return () => clearTimeout(timer);
			},
			terminate: (cause, error, signal) => this.terminateProtocol(cause, error, signal),
		});
		this.childStdout.on("data", (chunk: Buffer) => {
			this.protocol.pushStdout(chunk);
			this.recordStdioActivity();
		});
		this.childStderr.on("data", (chunk: Buffer) => {
			this.protocol.pushStderr(chunk);
			this.recordStdioActivity();
		});
		this.childStdout.on("end", () => this.markStdioEnd("stdout"));
		this.childStderr.on("end", () => this.markStdioEnd("stderr"));
		this.child.on("exit", () => {
			this.childExited = true;
			const exitedAt = Date.now();
			this.stdioIdleAt = exitedAt + 2_000;
			this.stdioHardAt = exitedAt + 8_000;
			this.wakeLifecycle();
		});
		this.child.on("close", (exitCode, signal) => {
			this.clearStdioDeadlines();
			Queue.offerUnsafe(this.lifecycleEvents, { type: "close", exitCode, signal });
		});
	}

	private wakeLifecycle(): void {
		if (this.lifecycleEvents) Queue.offerUnsafe(this.lifecycleEvents, { type: "wake" });
	}

	private recordStdioActivity(): void {
		if (!this.childExited) return;
		this.stdioIdleAt = Date.now() + 2_000;
		this.wakeLifecycle();
	}

	private markStdioEnd(stream: "stdout" | "stderr"): void {
		if (stream === "stdout") this.stdoutEnded = true;
		else this.stderrEnded = true;
		if (this.stdoutEnded && this.stderrEnded) this.clearStdioDeadlines();
		this.wakeLifecycle();
	}

	private clearStdioDeadlines(): void {
		this.stdioIdleAt = undefined;
		this.stdioHardAt = undefined;
	}

	private destroyUnendedStdio(): void {
		if (!this.stdoutEnded) bestEffort(() => this.childStdout.destroy());
		if (!this.stderrEnded) bestEffort(() => this.childStderr.destroy());
	}

	private nextLifecycleDeadline(): number | undefined {
		let deadline: number | undefined;
		for (const candidate of [
			this.finalDrainAt,
			this.finalDrainHardKillAt,
			this.terminationHardKillAt,
			this.stdioIdleAt,
			this.stdioHardAt,
		]) {
			if (candidate !== undefined && (deadline === undefined || candidate < deadline)) deadline = candidate;
		}
		return deadline;
	}

	private processLifecycleDeadlines(): void {
		const now = Date.now();
		if (this.finalDrainAt !== undefined && this.finalDrainAt <= now) {
			this.finalDrainAt = undefined;
			this.requestFinalDrain();
		}
		if (this.finalDrainHardKillAt !== undefined && this.finalDrainHardKillAt <= now) {
			this.finalDrainHardKillAt = undefined;
			const signal = this.writerSpawn.gated ? "SIGTERM" : "SIGKILL";
			if (!this.settled && trySignalChild(this.child, signal, this.writerProcessStartIdentity)) {
				this.finalDrainHardKillSignalSent = signal === "SIGKILL";
			}
		}
		if (this.terminationHardKillAt !== undefined && this.terminationHardKillAt <= now) {
			this.terminationHardKillAt = undefined;
			if (!this.settled) {
				const signal = this.writerSpawn.gated ? "SIGTERM" : "SIGKILL";
				trySignalChild(this.child, signal, this.writerProcessStartIdentity);
			}
		}
		if (this.stdioIdleAt !== undefined && this.stdioIdleAt <= now) {
			this.stdioIdleAt = undefined;
			this.destroyUnendedStdio();
		}
		if (this.stdioHardAt !== undefined && this.stdioHardAt <= now) {
			this.stdioHardAt = undefined;
			this.destroyUnendedStdio();
		}
	}

	private awaitClose(): Effect.Effect<ChildProcessResult> {
		return Effect.gen({ self: this }, function* () {
			for (;;) {
				const deadline = this.nextLifecycleDeadline();
				const event =
					deadline === undefined
						? yield* Queue.take(this.lifecycleEvents)
						: yield* Effect.raceFirst(
								Queue.take(this.lifecycleEvents),
								Effect.sleep(Math.max(0, deadline - Date.now())).pipe(
									Effect.as<ChildLifecycleEvent>({ type: "wake" }),
								),
							);
				if (event.type === "close") return yield* this.handleClose(event.exitCode, event.signal);
				this.processLifecycleDeadlines();
			}
		});
	}

	private releaseStartupGate(): void {
		if (this.terminalCause) return;
		if (this.writerProcessBindingError && this.claimTerminalCause("setup")) {
			this.forcedError = `Failed to bind Agent writer process identity: ${
				this.writerProcessBindingError instanceof Error
					? this.writerProcessBindingError.message
					: String(this.writerProcessBindingError)
			}`;
			this.requestTermination("SIGTERM");
			this.armTerminationHardKill();
			this.childStdin.destroy();
			return;
		}
		if (!this.writerSpawn.gated) {
			this.childStdin.end();
			return;
		}
		const queued = this.sendSupervisorControl("proceed", (delivered) => {
			if (!delivered && !this.settled && !this.childExited) this.failStartupGate();
		});
		if (!queued) this.failStartupGate();
	}

	private failStartupGate(): void {
		if (!this.claimTerminalCause("setup")) return;
		this.forcedError = `Failed to release Agent writer supervisor startup gate: ${this.writerControlError?.message ?? "control pipe closed"}.`;
		this.requestTermination("SIGTERM");
		this.armTerminationHardKill();
	}

	private recoverWriterGroup(): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			let groupClosed = yield* closeWriterProcessGroup(this.writerPid, this.writerProcessStartIdentity);
			if (!groupClosed && this.writerSpawn.gated) {
				groupClosed = (yield* reapOrphanWriterProcesses(this.input.config.asyncDir)).remaining === 0;
			}
			if (!groupClosed) {
				this.forcedError ??= "Agent writer process group did not terminate; recovery ownership was retained.";
				return;
			}
			try {
				this.input.onWriterProcess?.({ state: "none" });
			} catch (error) {
				reportAgentDiagnostic(
					`Failed to clear writer process identity for Agent child ${this.input.index}:`,
					error,
				);
			}
			try {
				fs.rmSync(this.groupMemberProofPath, { force: true });
			} catch {
				// The registry is already clear; proof cleanup is best effort.
			}
		});
	}

	private readSupervisorDisposition() {
		const disposition = this.writerSpawn.gated
			? readWriterSupervisorDisposition(
					this.supervisorDispositionPath,
					this.writerPid,
					this.writerProcessStartIdentity,
				)
			: undefined;
		try {
			fs.rmSync(this.supervisorDispositionPath, { force: true });
		} catch {
			// The containing temporary directory is cleaned below when available.
		}
		return disposition;
	}

	private observeTerminal(exitCode: number | null, signal: NodeJS.Signals | null, snapshot: ChildProtocolSnapshot) {
		const disposition = this.readSupervisorDisposition();
		const observedExitCode = disposition ? disposition.exitCode : exitCode;
		const observedSignal = disposition ? disposition.signal : signal;
		const semanticError =
			this.forcedError ??
			readChildToolDiagnosticError(this.built.toolDiagnosticPath) ??
			snapshot.assistantError ??
			disposition?.outputForwardingError ??
			(this.writerSpawn.gated && !disposition
				? "Agent writer supervisor terminal disposition was unavailable; termination provenance could not be verified."
				: undefined) ??
			(disposition?.reaped === false
				? "Agent writer supervisor could not reap the complete process group."
				: undefined);
		const finalDrainTerminationObserved = this.writerSpawn.gated
			? disposition?.origin === "manager-final-drain"
			: (this.finalDrainSignalSent &&
					(observedSignal === "SIGTERM" || (observedSignal === null && observedExitCode === 143))) ||
				(this.finalDrainHardKillSignalSent &&
					(observedSignal === "SIGKILL" || (observedSignal === null && observedExitCode === 137)));
		const completedByInternalFinalDrain = this.finalDrainEvidence && !semanticError && finalDrainTerminationObserved;
		const error =
			semanticError ??
			(!completedByInternalFinalDrain && observedExitCode && snapshot.stderr.trim()
				? snapshot.stderr.trim()
				: undefined);
		const signalledExit =
			observedSignal !== null ||
			(observedSignal === null &&
				isRuntimeNumber(observedExitCode) &&
				observedExitCode > 128 &&
				observedExitCode <= 255);
		const terminationOrigin = this.writerSpawn.gated
			? (disposition?.origin ?? undefined)
			: !signalledExit
				? undefined
				: finalDrainTerminationObserved
					? ("manager-final-drain" as const)
					: this.terminalCause
						? ("manager-request" as const)
						: ("external" as const);
		return { observedExitCode, observedSignal, completedByInternalFinalDrain, error, terminationOrigin };
	}

	private buildResult(
		snapshot: ChildProtocolSnapshot,
		observed: ReturnType<ChildProcessEngine["observeTerminal"]>,
	): ChildProcessResult {
		try {
			fs.writeFileSync(this.input.outputFile, snapshot.output || observed.error || "", "utf-8");
		} catch {
			// The transcript and result remain authoritative if this convenience file fails.
		}
		const writerProcess: WriterProcess = {
			processInstanceId: this.processInstanceId,
			kind: "pi-writer",
			attempt: 0,
			closeObservedAt: Date.now(),
			exitCode: observed.observedExitCode,
			signal: observed.observedSignal,
		};
		if (observed.terminationOrigin) writerProcess.terminationOrigin = observed.terminationOrigin;
		return {
			exitCode:
				this.terminalCause === "pause" ||
				this.terminalCause === "timeout" ||
				this.terminalCause === "stop" ||
				this.terminalCause === "tool-timeout"
					? 1
					: observed.completedByInternalFinalDrain
						? 0
						: observed.observedSignal !== null
							? 1
							: observed.observedExitCode,
			signal: observed.observedSignal,
			stderr: snapshot.stderr,
			messages: snapshot.messages,
			output: snapshot.output,
			error: observed.error,
			protocolError: snapshot.protocolError,
			usage: snapshot.usage,
			costReported: snapshot.costReported,
			toolCount: snapshot.toolCount,
			toolBudgetBlockedTool: snapshot.toolBudgetBlockedTool,
			durationMs: Date.now() - this.startedAt,
			model: snapshot.model,
			contextUsage: this.input.statusStep.contextUsage,
			interrupted: this.terminalCause === "pause" || undefined,
			timedOut: this.terminalCause === "timeout" || this.terminalCause === "tool-timeout" || undefined,
			stopped: this.terminalCause === "stop" || undefined,
			contextNudgeObserved: snapshot.contextNudgeObserved || undefined,
			process: writerProcess,
		};
	}

	private handleClose(exitCode: number | null, signal: NodeJS.Signals | null): Effect.Effect<ChildProcessResult> {
		return Effect.gen({ self: this }, function* () {
			this.input.activeControls.delete(this.input.index);
			yield* this.recoverWriterGroup();
			this.protocol.end();
			this.settled = true;
			const snapshot = this.protocol.snapshot();
			return this.buildResult(snapshot, this.observeTerminal(exitCode, signal, snapshot));
		});
	}

	private teardown(): void {
		this.input.activeControls.delete(this.input.index);
		this.finalDrainAt = undefined;
		this.finalDrainHardKillAt = undefined;
		this.terminationHardKillAt = undefined;
		this.clearStdioDeadlines();
		bestEffort(() => this.protocol.end());
		bestEffort(() => cleanupTempDir(this.built.tempDir));
		this.removeWriterControl();
		this.settled = true;
	}
}
