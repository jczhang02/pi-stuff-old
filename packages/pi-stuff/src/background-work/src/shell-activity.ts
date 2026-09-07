import { rmSync } from "node:fs";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type JsonValue, parseJsonValue } from "../../shared/json-value.js";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.js";
import { CommandMonitorEvidence } from "./command-monitor-evidence.js";
import { reportWorkDiagnostic } from "./diagnostics.js";
import type { BackgroundWorkEffectOwner } from "./effect-owner.js";
import { DEFAULT_MODEL_OUTPUT_LIMIT, tryReadBoundedTail } from "./output.js";
import {
	consumeCommandAcknowledgement,
	identityMatches,
	type ProcessIdentity,
	publishCommandAuthorization,
	reapOwnedProcessGroup,
} from "./process.js";
import type {
	BackgroundWorkBashDetails,
	BackgroundWorkKind,
	BackgroundWorkOutcome,
	BackgroundWorkSnapshot,
	BashExecutionInput,
} from "./runtime.js";
import {
	prepareShellLaunch,
	type ShellActivityDependencies,
	type ShellLaunchInput,
	type ShellLaunchState,
} from "./shell-activity-launch.js";
import {
	durableShellOutputPath,
	executeShellTool,
	projectShellSnapshot,
	type ShellStopReason,
	shellActivityTitle,
	shellOutcomeSummary,
	shellTerminalStatus,
} from "./shell-activity-presentation.js";
import type { StoredProcessTask } from "./storage.js";

export type { ShellActivityDependencies, ShellLaunchInput };

const SUPERVISOR_STARTUP_TIMEOUT_MS = 10_000;

export interface ShellActivityOwner {
	changed(): void;
	disposed(): boolean;
	readonly effects: BackgroundWorkEffectOwner;
	persist(): void;
	settled(outcome: BackgroundWorkOutcome, wake: boolean | undefined): void;
	unregister(activity: ShellActivity, receipt: BackgroundWorkOutcome | undefined): void;
}

export class ShellActivity {
	private backgrounded: boolean;
	private commandGroupReaped = false;
	private commandIdentity: ProcessIdentity | undefined;
	private readonly completion = Deferred.makeUnsafe<BackgroundWorkOutcome>();
	private controlBuffer = "";
	private readonly dependencies: ShellActivityDependencies;
	private readonly detached = Deferred.makeUnsafe<"manual" | "timeout">();
	private finalization: "done" | "open" | "running" = "open";
	readonly id: string;
	readonly kind: BackgroundWorkKind;
	private readonly launch: ShellLaunchState;
	private readonly monitorEvidence: CommandMonitorEvidence;
	private launchAuthorized = false;
	private readonly owner: ShellActivityOwner;
	private readonly supervisorReady = Deferred.makeUnsafe<void>();
	readonly startedAt = Date.now();
	private stopPromise: Promise<BackgroundWorkOutcome> | undefined;
	private stopReason: ShellStopReason | undefined;
	private cancelTimeout: (() => void) | undefined;
	private readonly title: string;

	private constructor(state: ShellLaunchState, dependencies: ShellActivityDependencies, owner: ShellActivityOwner) {
		this.backgrounded = state.input.backgrounded;
		this.dependencies = dependencies;
		this.id = state.id;
		this.kind = state.input.kind ?? "shell";
		this.launch = state;
		this.monitorEvidence = new CommandMonitorEvidence(state.input.monitorSuccessText, state.input.monitorFailureText);
		this.owner = owner;
		this.title = shellActivityTitle(state.input);
	}

	static async spawn(
		input: ShellLaunchInput,
		id: string,
		dependencies: ShellActivityDependencies,
		owner: ShellActivityOwner,
	): Promise<ShellActivity> {
		const state = await owner.effects.run(
			Effect.tryPromise({
				try: () => prepareShellLaunch(input, id, dependencies, () => owner.disposed()),
				catch: (error) => error,
			}),
		);
		return new ShellActivity(state, dependencies, owner);
	}

	get visible(): boolean {
		return this.launchAuthorized;
	}

	isActiveForeground(): boolean {
		return this.launchAuthorized && this.kind === "shell" && !this.backgrounded && !this.stopReason;
	}

	bind(): void {
		const append = (chunk: Buffer) => {
			this.monitorEvidence.append(chunk);
			this.launch.output.append(chunk);
		};
		this.launch.supervisor.output.on("data", append);
		this.launch.supervisor.control.on("data", (chunk: Buffer) => this.consumeControl(chunk));
		const completion = Effect.tryPromise({
			try: () => this.launch.supervisor.completion,
			catch: (error) => error,
		}).pipe(
			Effect.flatMap(({ code, error, signal }) => {
				if (error) append(Buffer.from(`Background supervisor failed: ${error.message}\n`, "utf-8"));
				return this.finalize(code, signal);
			}),
			Effect.catch((error) => {
				reportWorkDiagnostic("Task finalization failed; retrying", error, { key: "finalization-retry" });
				if (this.finalization === "done") return Effect.void;
				append(Buffer.from(`Background finalization failed: ${String(error)}\n`, "utf-8"));
				return this.finalize(1, null).pipe(
					Effect.catch((retryError) =>
						Effect.sync(() => {
							reportWorkDiagnostic("A task could not be finalized", retryError, {
								action: "/tasks",
								key: "finalization-failed",
								notice: true,
							});
						}),
					),
				);
			}),
			Effect.onInterrupt(() => this.stopAfterScopeInterrupt()),
		);
		void this.owner.effects.open(completion).exit;
	}

	private stopAfterScopeInterrupt(): Effect.Effect<void> {
		if (this.finalization === "done") return Effect.void;
		this.stopReason ??= "shutdown";
		return this.stopNow().pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					reportWorkDiagnostic("A task could not stop during Effect Scope shutdown", error, {
						action: "/tasks",
						key: "scope-shutdown-stop",
						notice: true,
					});
				}),
			),
			Effect.asVoid,
		);
	}

	async authorize(): Promise<void> {
		let inputFailed = false;
		const failInput = (cause: unknown) => {
			if (inputFailed) return;
			inputFailed = true;
			this.launch.output.append(
				Buffer.from(
					`Background supervisor input failed: ${cause instanceof Error ? cause.message : String(cause)}\n`,
					"utf-8",
				),
			);
			// The supervisor may already have spawned the command in its own group.
			// Preserve durable ownership and let its graceful TERM handler reap that
			// group instead of SIGKILLing the supervisor alone.
			this.requestStop("abort", "supervisor input failure");
		};
		try {
			await this.owner.effects.run(this.waitForSupervisorReadiness());
			if (this.owner.disposed() || this.stopReason) throw new Error("Background Work session is shutting down");
		} catch (error) {
			await this.rollback();
			throw error;
		}
		try {
			publishCommandAuthorization(
				this.launch.authorizationPath,
				this.launch.authorizationToken,
				this.launch.input.command,
			);
		} catch (error) {
			failInput(error);
			throw error;
		}
		this.launch.supervisor.unref();
		await this.owner.effects.run(this.waitForCommandAcknowledgement());
		this.owner.changed();
	}

	rollback(): Promise<void> {
		return this.owner.effects.run(
			Effect.gen({ self: this }, function* () {
				yield* Effect.sync(() => {
					this.finalization = "running";
					this.owner.unregister(this, undefined);
					try {
						// Persist failed before command input was released. Kill the exact Bun
						// subprocess handle first; ending stdin while it is alive would authorize
						// the supervisor to launch the command we are trying to roll back.
						this.launch.supervisor.kill("SIGKILL");
					} catch {
						// Completion below remains the authoritative exact-handle observation.
					}
					this.removeLaunchArtifact(this.launch.authorizationPath);
					this.removeLaunchArtifact(this.launch.acknowledgementPath);
					this.launch.supervisor.output.destroy();
					this.launch.supervisor.closeControl();
					this.launch.supervisor.unref();
				});
				yield* Effect.tryPromise({
					try: () => this.launch.supervisor.completion,
					catch: (error) => error,
				});
				yield* Effect.sync(() => {
					this.finalization = "done";
					this.launch.output.remove();
					try {
						this.owner.persist();
					} catch (error) {
						reportWorkDiagnostic("Launch rollback state could not be saved", error, {
							key: "launch-rollback-persist",
						});
					}
				});
			}),
		);
	}

	async execute(
		input: BashExecutionInput,
		backgroundAfterMs: number,
	): Promise<AgentToolResult<BackgroundWorkBashDetails | undefined>> {
		if (input.timeoutSeconds !== undefined) this.armTimeout(input.timeoutSeconds, "timeout");
		const onAbort = () => {
			if (!this.backgrounded) this.requestStop("abort", "abort signal");
		};
		return this.owner.effects.run(
			executeShellTool(input, backgroundAfterMs, {
				completion: Deferred.await(this.completion),
				detach: (reason) => {
					this.detach(reason);
				},
				detached: Deferred.await(this.detached),
				id: this.id,
				onAbort,
				output: this.launch.output,
				outputPath: () => this.durableOutputPath(),
			}),
		);
	}

	startMonitor(timeoutSeconds: number): {
		readonly id: string;
		readonly outcome: Promise<BackgroundWorkOutcome>;
		readonly outputPath?: string;
	} {
		this.armTimeout(timeoutSeconds, "monitor timeout");
		const started = { id: this.id, outcome: this.owner.effects.run(Deferred.await(this.completion)) };
		const outputPath = this.durableOutputPath();
		return outputPath ? { ...started, outputPath } : started;
	}

	detach(reason: "manual" | "timeout"): boolean {
		if (this.finalization === "done" || this.backgrounded || this.stopReason) return false;
		this.backgrounded = true;
		Deferred.doneUnsafe(this.detached, Effect.succeed(reason));
		this.owner.changed();
		return true;
	}

	readOutput(maxBytes = DEFAULT_MODEL_OUTPUT_LIMIT): string {
		const outputPath = this.durableOutputPath();
		return outputPath
			? (tryReadBoundedTail(outputPath, maxBytes) ?? "(no output yet)")
			: this.launch.output.recentText(maxBytes) || "(no output yet)";
	}

	snapshot(): BackgroundWorkSnapshot {
		return projectShellSnapshot({
			id: this.id,
			input: this.launch.input,
			kind: this.kind,
			outputPath: this.durableOutputPath(),
			recentOutput: this.launch.output.recentText(4_000),
			startedAt: this.startedAt,
			stopReason: this.stopReason,
			title: this.title,
		});
	}

	storedTask(): StoredProcessTask {
		const task: StoredProcessTask = { id: this.id, supervisor: this.launch.supervisorIdentity };
		if (this.commandIdentity) Object.assign(task, { command: this.commandIdentity });
		return task;
	}

	closeOutput(): void {
		this.launch.output.close();
	}

	stop(reason: ShellStopReason): Promise<BackgroundWorkOutcome> {
		if (this.finalization === "done") return this.owner.effects.run(Deferred.await(this.completion));
		if (this.stopPromise) return this.stopPromise;
		this.stopReason = reason;
		this.owner.changed();
		const stopAttempt = this.owner.effects.run(this.stopNow());
		this.stopPromise = stopAttempt;
		return stopAttempt.finally(() => {
			// A failed proof of termination intentionally preserves the durable activity,
			// but it must not permanently cache that rejected attempt. A later explicit
			// stop or shutdown gets a fresh chance to verify and reap the same identity.
			if (this.stopPromise === stopAttempt) this.stopPromise = undefined;
		});
	}

	private stopNow(): Effect.Effect<BackgroundWorkOutcome, unknown> {
		return Effect.gen({ self: this }, function* () {
			const { supervisor, supervisorIdentity } = this.launch;
			const signalState = yield* Effect.try({
				try: () => this.dependencies.signalSupervisor(supervisor, supervisorIdentity, "SIGTERM"),
				catch: (error) => {
					this.owner.persist();
					return error;
				},
			});
			if (signalState === "unresolved") {
				this.owner.persist();
				return yield* Effect.fail(
					new Error(
						`Background Work '${this.id}' supervisor could not be proven stopped; recovery ownership was retained.`,
					),
				);
			}
			const terminal = yield* Effect.raceFirst(
				Deferred.await(this.completion).pipe(Effect.map(Option.some)),
				Effect.sleep(this.dependencies.stopCompletionGraceMs).pipe(Effect.as(Option.none())),
			);
			if (Option.isSome(terminal)) return terminal.value;
			if (identityMatches(supervisorIdentity)) {
				this.owner.persist();
				return yield* Effect.fail(
					new Error(
						`Background Work '${this.id}' supervisor is still reaping its process group; recovery ownership was retained.`,
					),
				);
			}
			yield* this.finalize(null, "SIGTERM");
			return yield* Deferred.await(this.completion);
		});
	}

	private armTimeout(seconds: number, source: string): void {
		const milliseconds = Math.round(seconds * 1_000);
		if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
			throw new Error("Bash timeout must be a positive, representable duration");
		}
		this.cancelTimeout?.();
		const task = this.owner.effects.open(
			Effect.gen({ self: this }, function* () {
				let remaining = milliseconds;
				let observedAt = performance.now();
				while (remaining > 0) {
					yield* Effect.sleep(Math.min(remaining, this.dependencies.maxTimeoutSliceMs));
					const now = performance.now();
					remaining -= Math.max(1, now - observedAt);
					observedAt = now;
				}
				this.requestStop("timeout", source);
			}),
		);
		this.cancelTimeout = () => {
			void task.interrupt();
		};
	}

	private requestStop(reason: ShellStopReason, source: string): void {
		void this.stop(reason).catch((error) => {
			reportWorkDiagnostic(`A task could not stop after ${source}`, error, {
				action: "/tasks",
				key: `stop-${source}`,
				notice: true,
			});
		});
	}

	private waitForCommandAcknowledgement(): Effect.Effect<void, unknown> {
		let acknowledgementAccepted = false;
		const acceptAcknowledgement = () => {
			if (!acknowledgementAccepted) {
				acknowledgementAccepted = consumeCommandAcknowledgement(
					this.launch.acknowledgementPath,
					this.launch.authorizationToken,
					this.launch.supervisorIdentity,
				);
			}
			if (acknowledgementAccepted) this.launchAuthorized = true;
			return acknowledgementAccepted;
		};
		const acknowledged = Effect.gen({ self: this }, function* () {
			const deadline = Date.now() + 3_000;
			for (;;) {
				const accepted = yield* Effect.try({
					try: acceptAcknowledgement,
					catch: (error) => error,
				});
				if (accepted) return;
				if (Date.now() >= deadline) {
					return yield* Effect.fail(
						new Error("Background Work supervisor did not acknowledge its command within 3 seconds."),
					);
				}
				yield* Effect.sleep(20);
			}
		});
		const supervisorExit = Effect.tryPromise({
			try: () => this.launch.supervisor.completion,
			catch: (error) => error,
		}).pipe(
			Effect.match({
				onFailure: (error) => error,
				onSuccess: (result) =>
					result.error ?? new Error("Background Work supervisor exited before accepting its command."),
			}),
			Effect.flatMap((error) =>
				Effect.try({
					try: () => {
						if (!acceptAcknowledgement()) throw error;
					},
					catch: (cause) => cause,
				}),
			),
		);
		return Effect.raceFirst(acknowledged, supervisorExit).pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					this.launchAuthorized = true;
					this.requestStop("abort", "command acknowledgement failure");
				}).pipe(Effect.andThen(Effect.fail(error))),
			),
			Effect.ensuring(
				Effect.sync(() => {
					this.removeLaunchArtifact(this.launch.authorizationPath);
					this.removeLaunchArtifact(this.launch.acknowledgementPath);
				}),
			),
		);
	}

	private waitForSupervisorReadiness(): Effect.Effect<void, unknown> {
		const supervisorExit = Effect.tryPromise({
			try: () => this.launch.supervisor.completion,
			catch: (error) => error,
		}).pipe(
			Effect.flatMap((result) =>
				Effect.fail(result.error ?? new Error("Background Work supervisor exited before becoming ready.")),
			),
		);
		const timeout = Effect.sleep(SUPERVISOR_STARTUP_TIMEOUT_MS).pipe(
			Effect.andThen(Effect.fail(new Error("Background Work supervisor did not become ready within 10 seconds."))),
		);
		return Effect.raceFirst(Deferred.await(this.supervisorReady), Effect.raceFirst(supervisorExit, timeout));
	}

	private removeLaunchArtifact(filePath: string): void {
		try {
			rmSync(filePath, { force: true });
		} catch (error) {
			reportWorkDiagnostic("A launch artifact could not be removed", error, {
				key: "launch-artifact-remove",
			});
		}
	}

	private consumeControl(chunk: Buffer): void {
		this.controlBuffer += chunk.toString("utf-8");
		for (;;) {
			const newline = this.controlBuffer.indexOf("\n");
			if (newline === -1) return;
			const line = this.controlBuffer.slice(0, newline);
			this.controlBuffer = this.controlBuffer.slice(newline + 1);
			let event: JsonValue;
			try {
				event = parseJsonValue(line);
			} catch {
				this.launch.output.append(Buffer.from("Invalid supervisor control record.\n", "utf-8"));
				continue;
			}
			if (!isRuntimeObject(event) || event === null || Array.isArray(event)) {
				this.launch.output.append(Buffer.from("Invalid supervisor control record.\n", "utf-8"));
				continue;
			}
			if (event["type"] === "ready") {
				Deferred.doneUnsafe(this.supervisorReady, Effect.void);
			} else if (
				event["type"] === "started" &&
				event["groupPid"] === this.launch.supervisorIdentity.pid &&
				event["groupStarted"] === this.launch.supervisorIdentity.started
			) {
				this.commandIdentity = this.launch.supervisorIdentity;
				try {
					this.owner.persist();
				} catch (error) {
					reportWorkDiagnostic("Task recovery metadata could not be saved", error, {
						action: "/tasks",
						key: "running-command-identity",
						notice: true,
					});
				}
			} else if (event["type"] === "spawn-error" && isRuntimeString(event["message"])) {
				this.launch.output.append(Buffer.from(`Command spawn failed: ${event["message"]}\n`, "utf-8"));
			} else if (event["type"] === "exit") {
				this.commandGroupReaped = event["groupReaped"] === true;
			}
		}
	}

	private finalize(code: number | null, signal: NodeJS.Signals | null): Effect.Effect<void, unknown> {
		if (this.finalization !== "open") return Effect.void;
		this.finalization = "running";
		const commandIdentity = this.commandIdentity;
		const reap =
			commandIdentity && !this.commandGroupReaped
				? Effect.tryPromise({
						try: () => reapOwnedProcessGroup(commandIdentity),
						catch: (error) => error,
					})
				: Effect.void;
		return reap.pipe(
			Effect.catch((error) =>
				Effect.sync(() => {
					this.finalization = "open";
					try {
						this.owner.persist();
					} catch (persistError) {
						reportWorkDiagnostic("Unresolved process recovery state could not be saved", persistError, {
							action: "/tasks",
							key: "unresolved-process-recovery",
							notice: true,
						});
					}
				}).pipe(Effect.andThen(Effect.fail(error))),
			),
			Effect.andThen(Effect.sync(() => this.completeFinalization(code, signal))),
			Effect.onInterrupt(() =>
				Effect.sync(() => {
					if (this.finalization === "running") this.finalization = "open";
				}),
			),
		);
	}

	private completeFinalization(code: number | null, signal: NodeJS.Signals | null): void {
		this.finalization = "done";
		this.cancelTimeout?.();
		this.cancelTimeout = undefined;
		try {
			this.launch.supervisor.output.destroy();
		} catch {
			// Stream teardown cannot change the process result.
		}
		try {
			this.launch.supervisor.closeControl();
		} catch {
			// The control descriptor is already terminal from the supervisor's perspective.
		}
		this.launch.output.close();
		const recentOutput = this.launch.output.recentText(DEFAULT_MODEL_OUTPUT_LIMIT);
		const status = shellTerminalStatus(this.stopReason, code, signal, this.monitorEvidence.finish());
		const outcome: BackgroundWorkOutcome = {
			endedAt: Date.now(),
			id: this.id,
			kind: this.kind,
			parentRunOrigin: this.launch.input.parentRunOrigin ?? "automatic",
			startedAt: this.startedAt,
			status,
			summary: shellOutcomeSummary(this.kind, this.title, status, code),
			title: this.title,
		};
		if (isRuntimeNumber(code)) Object.assign(outcome, { exitCode: code });
		const outputPath = this.durableOutputPath();
		if (outputPath) Object.assign(outcome, { outputPath });
		if (recentOutput) Object.assign(outcome, { recentOutput });
		this.owner.unregister(this, this.backgrounded ? outcome : undefined);
		try {
			this.owner.persist();
		} catch (error) {
			reportWorkDiagnostic("Completed task state could not be saved", error, { key: "terminal-state-persist" });
		}
		Deferred.doneUnsafe(this.completion, Effect.succeed(outcome));
		const shouldNotify =
			this.backgrounded &&
			!this.owner.disposed() &&
			this.stopReason !== "shutdown" &&
			this.stopReason !== "abort" &&
			this.stopReason !== "user";
		this.owner.settled(
			outcome,
			shouldNotify ? this.kind === "monitor" || !this.launch.input.backgrounded : undefined,
		);
	}

	private durableOutputPath(): string | undefined {
		return durableShellOutputPath(this.launch.output);
	}
}
