import { randomInt } from "node:crypto";
import { accessSync, constants } from "node:fs";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	BashToolDetails,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
	type AgentWorkOrigin,
	readCurrentAgentWorkOrigin,
	withAgentWorkOrigin,
} from "../../conversation-ui/agent-run-origin.ts";
import { requestStatuslineGitRefreshAfterUserWork, sendSuiteAgentMessage } from "../../conversation-ui/index.ts";
import type { SuiteAgentMessageHost } from "../../conversation-ui/suite-agent-message.ts";
import { settleWithin } from "../../lifecycle-deadline.ts";
import { reportWorkDiagnostic } from "./diagnostics.ts";
import type { BackgroundWorkEffectOwner, BackgroundWorkEffectTask } from "./effect-owner.ts";
import { projectNotificationBatch } from "./notification-projection.ts";
import { BoundedOutputFile, boundedTextTail, DEFAULT_MODEL_OUTPUT_LIMIT, tryReadBoundedTail } from "./output.ts";
import {
	captureProcessIdentityWithRetry,
	resolveSupervisorExecutable,
	signalVerifiedSupervisor,
	spawnSupervisor,
} from "./process.ts";
import {
	ShellActivity,
	type ShellActivityDependencies,
	type ShellActivityOwner,
	type ShellLaunchInput,
} from "./shell-activity.ts";
import { reconcileStaleRuns, WorkRunStorage } from "./storage.ts";

const DEFAULT_BACKGROUND_AFTER_MS = 120_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_CONCURRENT_ACTIVITIES = 16;
const MAX_TERMINAL_RECEIPTS = 64;
const MAX_NOTIFICATION_OUTCOMES = 16;

function assertRepresentableTimeoutSeconds(seconds: number, name: string): void {
	const milliseconds = Math.round(seconds * 1_000);
	if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
		throw new Error(`${name} must be a positive, representable duration`);
	}
}
const NOTIFICATION_BATCH_DELAY_MS = 200;
const NOTIFICATION_RETRY_INITIAL_MS = 250;
const NOTIFICATION_RETRY_MAX_MS = 5_000;
const STOP_COMPLETION_GRACE_MS = 3_000;
const SHUTDOWN_GRACE_MS = 1_000;
const DEFAULT_METADATA_HEARTBEAT_MS = 5_000;
const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export type BackgroundWorkKind = "monitor" | "shell";
export type BackgroundWorkStatus = "running" | "stopping";
export type BackgroundWorkTerminalStatus = "completed" | "failed" | "stopped" | "timed_out";
export { projectNotificationBatch } from "./notification-projection.ts";

export interface BackgroundWorkBashDetails extends BashToolDetails {
	readonly backgroundTaskId?: string;
	readonly omittedBytes?: number;
	readonly retainedOutputPath?: string;
}

export interface BackgroundWorkSnapshot {
	readonly command?: string;
	readonly description?: string;
	readonly id: string;
	readonly kind: BackgroundWorkKind;
	readonly monitorFailureText?: string;
	readonly monitorSource?: "command" | "file" | "http" | "log";
	readonly monitorSuccessText?: string;
	readonly monitorTarget?: string;
	readonly monitorTimeoutSeconds?: number;
	readonly outputPath?: string;
	readonly recentOutput?: string;
	readonly startedAt: number;
	readonly status: BackgroundWorkStatus;
	readonly title: string;
}

export interface BackgroundWorkOutcome {
	readonly endedAt: number;
	readonly exitCode?: number;
	readonly id: string;
	readonly kind: BackgroundWorkKind;
	readonly outputPath?: string;
	/** Parent Agent attribution captured before asynchronous shell launch. */
	readonly parentRunOrigin?: AgentWorkOrigin;
	readonly recentOutput?: string;
	readonly startedAt: number;
	readonly status: BackgroundWorkTerminalStatus;
	readonly summary: string;
	readonly title: string;
}

export interface BashExecutionInput {
	readonly command: string;
	readonly description?: string;
	readonly onUpdate?: AgentToolUpdateCallback<BackgroundWorkBashDetails | undefined>;
	readonly runInBackground?: boolean;
	readonly signal?: AbortSignal;
	readonly timeoutSeconds?: number;
}

export interface BackgroundMonitorActivity {
	cancel(reason: "shutdown" | "user"): Promise<BackgroundWorkOutcome>;
	readonly id: string;
	readonly outcome: Promise<BackgroundWorkOutcome>;
	readOutput(maxBytes?: number): string;
	snapshot(): BackgroundWorkSnapshot;
	start?(): void;
}

export interface CommandMonitorInput {
	readonly command: string;
	readonly description?: string;
	readonly failureText?: string;
	readonly successText?: string;
	readonly timeoutSeconds: number;
}

interface PendingNotification {
	readonly outcome: BackgroundWorkOutcome;
	readonly wake: boolean;
}

interface PendingForegroundLaunch {
	manualDetachRequested: boolean;
}

interface RuntimeOptions extends Partial<ShellActivityDependencies> {
	readonly backgroundAfterMs?: number;
	readonly commandPrefix?: string;
	readonly cwd: string;
	readonly effects: BackgroundWorkEffectOwner;
	readonly pi: SuiteAgentMessageHost;
	/** Test seam for transient stale-runtime recovery failure. */
	readonly reconcileStale?: typeof reconcileStaleRuns;
	readonly sessionId: string;
	/** Test seam; shutdown retains durable recovery ownership after this deadline. */
	readonly shutdownGraceMs?: number;
	/** Test seam; production refreshes authenticated recovery ownership every five seconds. */
	readonly metadataHeartbeatMs?: number;
}

export class BackgroundWorkRuntime {
	private readonly activities = new Map<string, ShellActivity>();
	private readonly backgroundAfterMs: number;
	private readonly commandPrefix: string | undefined;
	private readonly cwd: string;
	private disposed = false;
	readonly effects: BackgroundWorkEffectOwner;
	private readonly launchActivityIds = new Set<string>();
	private launchReservations = 0;
	private readonly launchSettlements = new Set<Promise<void>>();
	private readonly listeners = new Set<() => void>();
	private readonly metadataHeartbeatMs: number;
	private metadataHeartbeatTask: BackgroundWorkEffectTask<void, never> | undefined;
	private readonly monitors = new Map<string, BackgroundMonitorActivity>();
	private readonly notifications: PendingNotification[] = [];
	private readonly pendingForegroundLaunches = new Set<PendingForegroundLaunch>();
	private notificationRetryDelayMs = NOTIFICATION_RETRY_INITIAL_MS;
	private notificationTask: BackgroundWorkEffectTask<void, never> | undefined;
	private preparation: Promise<void> | undefined;
	private readonly pi: SuiteAgentMessageHost;
	private readonly reconcileStale: typeof reconcileStaleRuns;
	private readonly rollbackSettlements = new Set<Promise<void>>();
	private readonly shellDependencies: ShellActivityDependencies;
	private readonly shellOwner: ShellActivityOwner;
	private readonly shutdownGraceMs: number;
	private readonly storage: WorkRunStorage;
	private readonly terminalOutcomes = new Map<string, BackgroundWorkOutcome>();

	constructor(options: RuntimeOptions) {
		this.backgroundAfterMs = options.backgroundAfterMs ?? DEFAULT_BACKGROUND_AFTER_MS;
		if (!Number.isFinite(this.backgroundAfterMs) || this.backgroundAfterMs <= 0) {
			throw new Error("Background Work foreground handoff delay must be positive");
		}
		this.commandPrefix = options.commandPrefix;
		this.cwd = options.cwd;
		this.effects = options.effects;
		this.pi = options.pi;
		this.reconcileStale = options.reconcileStale ?? reconcileStaleRuns;
		this.metadataHeartbeatMs = options.metadataHeartbeatMs ?? DEFAULT_METADATA_HEARTBEAT_MS;
		if (!Number.isFinite(this.metadataHeartbeatMs) || this.metadataHeartbeatMs <= 0) {
			throw new Error("Background Work metadata heartbeat interval must be positive");
		}
		this.shutdownGraceMs = options.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
		this.storage = options.storage ?? new WorkRunStorage(options.cwd, options.sessionId);
		const maxTimeoutSliceMs = options.maxTimeoutSliceMs ?? MAX_TIMER_DELAY_MS;
		if (
			!Number.isSafeInteger(maxTimeoutSliceMs) ||
			maxTimeoutSliceMs <= 0 ||
			maxTimeoutSliceMs > MAX_TIMER_DELAY_MS
		) {
			throw new Error(
				`Background Work timer slice must be a positive safe integer no greater than ${String(MAX_TIMER_DELAY_MS)}`,
			);
		}
		this.shellDependencies = {
			captureSupervisorIdentity: options.captureSupervisorIdentity ?? captureProcessIdentityWithRetry,
			cwd: options.cwd,
			maxTimeoutSliceMs,
			outputFactory: options.outputFactory ?? ((filePath) => new BoundedOutputFile(filePath)),
			shellPath: options.shellPath,
			signalSupervisor: options.signalSupervisor ?? signalVerifiedSupervisor,
			stopCompletionGraceMs: options.stopCompletionGraceMs ?? STOP_COMPLETION_GRACE_MS,
			storage: this.storage,
			supervisorExecutable: resolveSupervisorExecutable(options.supervisorExecutable),
			supervisorFactory: options.supervisorFactory ?? spawnSupervisor,
		};
		this.shellOwner = {
			changed: () => this.emit(),
			disposed: () => this.disposed,
			effects: this.effects,
			persist: () => this.persistRunningProcesses(),
			settled: (outcome, wake) => {
				this.emit();
				if (wake === undefined) return;
				if (outcome.parentRunOrigin === "user") requestStatuslineGitRefreshAfterUserWork(this.pi);
				this.enqueueNotification(outcome, wake);
			},
			unregister: (activity, receipt) => {
				this.activities.delete(activity.id);
				if (receipt) this.rememberTerminalOutcome(receipt);
			},
		};
	}

	scheduleRefresh(callback: () => void, intervalMs: number): () => void {
		const task = this.effects.open(
			Effect.forever(Effect.sleep(Math.max(0, intervalMs)).pipe(Effect.andThen(Effect.sync(callback)))),
		);
		return () => {
			void task.interrupt();
		};
	}

	hasCommandPrefix(): boolean {
		return Boolean(this.commandPrefix?.trim());
	}

	/** Perform process-mutating stale recovery only after an explicit Work action. */
	prepare(): Promise<void> {
		if (!this.preparation) {
			const attempt = this.effects.run(
				Effect.tryPromise({
					try: () => this.reconcileStale(this.cwd),
					catch: (error) => error,
				}).pipe(
					Effect.tap((reconciliation) =>
						Effect.sync(() => {
							if (reconciliation.unresolvedDirectories === 0) return;
							reportWorkDiagnostic(
								`${String(reconciliation.unresolvedDirectories)} unverified stale runtime director${reconciliation.unresolvedDirectories === 1 ? "y was" : "ies were"} left untouched`,
								undefined,
								{ key: "unverified-stale-runtime", severity: "warning" },
							);
						}),
					),
					Effect.asVoid,
				),
			);
			this.preparation = attempt;
			void attempt.catch(() => {
				if (this.preparation === attempt) this.preparation = undefined;
			});
		}
		return this.preparation;
	}

	snapshot(): readonly BackgroundWorkSnapshot[] {
		return [
			...Array.from(this.activities.values())
				.filter((activity) => activity.visible)
				.map((activity) => activity.snapshot()),
			...Array.from(this.monitors.values(), (monitor) => monitor.snapshot()),
		].sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	newMonitorId(): string {
		return this.randomId("monitor");
	}

	registerMonitor(activity: BackgroundMonitorActivity): () => void {
		if (this.disposed) throw new Error("Background Work session is shutting down");
		this.assertCapacity();
		if (this.monitors.has(activity.id) || this.activities.has(activity.id)) {
			throw new Error(`Background Work activity '${activity.id}' already exists`);
		}
		this.monitors.set(activity.id, activity);
		this.emit();
		try {
			activity.start?.();
		} catch (error) {
			this.monitors.delete(activity.id);
			this.emit();
			throw error;
		}
		void activity.outcome.then((outcome) => {
			if (this.monitors.get(activity.id) !== activity) return;
			this.monitors.delete(activity.id);
			this.rememberTerminalOutcome(outcome);
			this.emit();
			if (!this.disposed && outcome.status !== "stopped") this.enqueueNotification(outcome, true);
		});
		return () => {
			if (this.monitors.get(activity.id) !== activity) return;
			this.monitors.delete(activity.id);
			this.emit();
		};
	}

	async executeBash(
		input: BashExecutionInput,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<BackgroundWorkBashDetails | undefined>> {
		if (input.timeoutSeconds !== undefined) assertRepresentableTimeoutSeconds(input.timeoutSeconds, "Bash timeout");
		const parentRunOrigin = readCurrentAgentWorkOrigin(this.pi);
		const pendingForegroundLaunch = input.runInBackground ? undefined : { manualDetachRequested: false };
		if (pendingForegroundLaunch) this.pendingForegroundLaunches.add(pendingForegroundLaunch);
		let activity: ShellActivity;
		try {
			await this.prepare();
			if (!input.command.trim()) throw new Error("Command is empty");
			accessSync(ctx.cwd, constants.F_OK);
			const launch: ShellLaunchInput = {
				backgrounded: input.runInBackground === true,
				command: this.commandPrefix ? `${this.commandPrefix}\n${input.command}` : input.command,
				context: ctx,
				parentRunOrigin,
			};
			if (input.description) Object.assign(launch, { description: input.description });
			activity = await this.spawnProcess(launch);
			if (pendingForegroundLaunch?.manualDetachRequested) activity.detach("manual");
		} finally {
			if (pendingForegroundLaunch) this.pendingForegroundLaunches.delete(pendingForegroundLaunch);
		}
		return activity.execute(input, this.backgroundAfterMs);
	}

	detachActiveForeground(): boolean {
		const active = [...this.activities.values()]
			.filter((activity) => activity.isActiveForeground())
			.sort((left, right) => right.startedAt - left.startedAt)[0];
		if (active) return active.detach("manual");
		const pending = [...this.pendingForegroundLaunches].at(-1);
		if (!pending || pending.manualDetachRequested) return false;
		pending.manualDetachRequested = true;
		return true;
	}

	async startCommandMonitor(
		input: CommandMonitorInput,
		ctx: ExtensionContext,
	): Promise<{
		readonly id: string;
		readonly outcome: Promise<BackgroundWorkOutcome>;
		readonly outputPath?: string;
	}> {
		if (!input.command.trim()) throw new Error("Monitor command is empty");
		assertRepresentableTimeoutSeconds(input.timeoutSeconds, "Monitor timeout");
		const launch: ShellLaunchInput = {
			backgrounded: true,
			command: this.commandPrefix ? `${this.commandPrefix}\n${input.command}` : input.command,
			context: ctx,
			kind: "monitor",
			monitorSource: "command",
			monitorTarget: input.command,
			monitorTimeoutSeconds: input.timeoutSeconds,
		};
		if (input.description) Object.assign(launch, { description: input.description });
		if (input.failureText) Object.assign(launch, { monitorFailureText: input.failureText });
		if (input.successText) Object.assign(launch, { monitorSuccessText: input.successText });
		return (await this.spawnProcess(launch)).startMonitor(input.timeoutSeconds);
	}

	readOutput(id: string, maxBytes = DEFAULT_MODEL_OUTPUT_LIMIT): string {
		const activity = this.activities.get(id);
		if (activity) return activity.readOutput(maxBytes);
		const monitor = this.monitors.get(id);
		if (monitor) return monitor.readOutput(maxBytes);
		const terminal = this.terminalOutcomes.get(id);
		if (terminal) {
			const durable = terminal.outputPath ? tryReadBoundedTail(terminal.outputPath, maxBytes) : undefined;
			const output = durable ?? boundedTextTail(terminal.recentOutput ?? "", maxBytes);
			return output ? `${terminal.summary}\n\n${output}` : terminal.summary;
		}
		throw new Error(`No current or recently finished Background Work activity matches '${id}'`);
	}

	async stop(id: string): Promise<BackgroundWorkOutcome> {
		const shell = this.activities.get(id);
		if (shell) return shell.stop("user");
		const monitor = this.monitors.get(id);
		if (monitor) return monitor.cancel("user");
		const terminal = this.terminalOutcomes.get(id);
		if (terminal) return terminal;
		throw new Error(`No current or recently finished Background Work activity matches '${id}'`);
	}

	async shutdown(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.listeners.clear();
		this.stopMetadataHeartbeat();
		this.notifications.length = 0;
		const cleanup = Promise.allSettled([
			...Array.from(this.activities.values(), (activity) => activity.stop("shutdown")),
			...Array.from(this.monitors.values(), (monitor) => monitor.cancel("shutdown")),
			...this.launchSettlements,
			...this.rollbackSettlements,
		]);
		await settleWithin(cleanup, this.shutdownGraceMs);
		// A stop can fail only while a verified process group is still alive. Keep
		// its recovery identity, but release this Host's output descriptors.
		for (const activity of this.activities.values()) activity.closeOutput();
		this.monitors.clear();
		try {
			this.persistRunningProcesses();
		} catch (error) {
			reportWorkDiagnostic("Shutdown state could not be saved", error, { key: "shutdown-persist" });
		}
		if (this.activities.size === 0) {
			try {
				this.storage.cleanup();
			} catch (error) {
				reportWorkDiagnostic("Shutdown state could not be cleaned up", error, { key: "shutdown-cleanup" });
			}
		}
		this.terminalOutcomes.clear();
		await this.effects.shutdown();
		this.emit();
	}

	private assertCapacity(): void {
		if (this.activities.size + this.monitors.size + this.launchReservations >= MAX_CONCURRENT_ACTIVITIES) {
			throw new Error(`At most ${String(MAX_CONCURRENT_ACTIVITIES)} Background Work activities may run at once`);
		}
	}

	private async spawnProcess(input: ShellLaunchInput): Promise<ShellActivity> {
		if (this.disposed) throw new Error("Background Work session is shutting down");
		this.assertCapacity();
		const id = this.randomId(input.kind ?? "shell");
		this.launchActivityIds.add(id);
		this.launchReservations += 1;
		const reservation = { active: true };
		let launchSettlement!: Promise<void>;
		const launch = this.spawnProcessTransaction(input, reservation, id).finally(() => {
			this.launchActivityIds.delete(id);
			if (reservation.active) {
				reservation.active = false;
				this.launchReservations -= 1;
			}
			this.launchSettlements.delete(launchSettlement);
		});
		launchSettlement = launch.then(
			() => undefined,
			() => undefined,
		);
		this.launchSettlements.add(launchSettlement);
		return launch;
	}

	private async spawnProcessTransaction(
		input: ShellLaunchInput,
		reservation: { active: boolean },
		id: string,
	): Promise<ShellActivity> {
		const activity = await ShellActivity.spawn(input, id, this.shellDependencies, this.shellOwner);
		this.activities.set(id, activity);
		reservation.active = false;
		this.launchReservations -= 1;
		activity.bind();
		try {
			this.persistRunningProcesses();
		} catch (error) {
			this.trackRollback(activity.rollback());
			throw error;
		}
		await activity.authorize();
		return activity;
	}

	private trackRollback(settlement: Promise<void>): void {
		this.rollbackSettlements.add(settlement);
		void settlement.then(
			() => this.rollbackSettlements.delete(settlement),
			(error) => {
				this.rollbackSettlements.delete(settlement);
				reportWorkDiagnostic("Launch rollback did not settle", error, { key: "launch-rollback-settle" });
			},
		);
	}

	private persistRunningProcesses(): void {
		if (!this.storage.directory && this.activities.size === 0) {
			this.stopMetadataHeartbeat();
			return;
		}
		this.storage.persist(Array.from(this.activities.values(), (activity) => activity.storedTask()));
		this.refreshMetadataHeartbeat();
	}

	private refreshMetadataHeartbeat(): void {
		if (this.disposed || this.activities.size === 0) {
			this.stopMetadataHeartbeat();
			return;
		}
		if (this.metadataHeartbeatTask) return;
		const task = this.effects.open(
			Effect.forever(
				Effect.sleep(this.metadataHeartbeatMs).pipe(
					Effect.andThen(
						Effect.sync(() => {
							if (this.disposed || this.activities.size === 0) {
								this.stopMetadataHeartbeat();
								return;
							}
							try {
								this.persistRunningProcesses();
							} catch (error) {
								reportWorkDiagnostic("Task recovery metadata refresh failed", error, {
									action: "/tasks",
									key: "recovery-metadata-refresh",
									notice: true,
								});
							}
						}),
					),
				),
			),
		);
		this.metadataHeartbeatTask = task;
		void task.exit.then(() => {
			if (this.metadataHeartbeatTask === task) this.metadataHeartbeatTask = undefined;
		});
	}

	private stopMetadataHeartbeat(): void {
		const task = this.metadataHeartbeatTask;
		this.metadataHeartbeatTask = undefined;
		if (task) void task.interrupt();
	}

	private enqueueNotification(outcome: BackgroundWorkOutcome, wake: boolean): void {
		this.notifications.push({ outcome, wake });
		this.scheduleNotificationFlush(NOTIFICATION_BATCH_DELAY_MS);
	}

	private scheduleNotificationFlush(delayMs: number): void {
		if (this.disposed || this.notifications.length === 0) return;
		if (this.notificationTask) return;
		const task = this.effects.open(this.notificationLoop(delayMs));
		this.notificationTask = task;
		void task.exit.then(() => {
			if (this.notificationTask !== task) return;
			this.notificationTask = undefined;
			if (!this.disposed && this.notifications.length > 0) {
				this.scheduleNotificationFlush(NOTIFICATION_BATCH_DELAY_MS);
			}
		});
	}

	private notificationLoop(initialDelayMs: number): Effect.Effect<void, never> {
		return Effect.gen({ self: this }, function* () {
			let delayMs = initialDelayMs;
			while (!this.disposed && this.notifications.length > 0) {
				yield* Effect.sleep(delayMs);
				if (this.disposed) return;
				const retryDelay = yield* this.flushNotifications();
				if (this.disposed || this.notifications.length === 0) return;
				delayMs = retryDelay ?? NOTIFICATION_BATCH_DELAY_MS;
			}
		});
	}

	private flushNotifications(): Effect.Effect<number | undefined, never> {
		if (this.disposed || this.notifications.length === 0) return Effect.succeed(undefined);
		const pending = this.notifications.splice(0);
		return Effect.gen({ self: this }, function* () {
			for (let offset = 0; offset < pending.length; offset += MAX_NOTIFICATION_OUTCOMES) {
				const batch = pending.slice(offset, offset + MAX_NOTIFICATION_OUTCOMES);
				const wake = batch.some((item) => item.wake);
				const parentRunOrigin = batch.some((item) => item.outcome.parentRunOrigin === "user")
					? "user"
					: "automatic";
				const projected = projectNotificationBatch(batch.map((item) => item.outcome));
				const delivery = yield* Effect.tryPromise({
					try: () =>
						sendSuiteAgentMessage(
							this.pi,
							withAgentWorkOrigin(
								{
									customType: "pi-stuff-background-work-result",
									content: projected.content,
									details: { outcomes: projected.outcomes },
									display: true,
								},
								parentRunOrigin,
							),
							wake ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "followUp", triggerTurn: false },
							() => !this.disposed,
						),
					catch: (error) => error,
				}).pipe(
					Effect.match({
						onFailure: (error) => ({ error }) as const,
						onSuccess: (accepted) => ({ accepted }) as const,
					}),
				);
				if (this.disposed) return undefined;
				const error =
					"error" in delivery
						? delivery.error
						: delivery.accepted
							? undefined
							: new Error("Background Work session changed before delivery.");
				if (error === undefined) continue;
				reportWorkDiagnostic("Task completion delivery failed; retrying", error, {
					key: "terminal-notification",
				});
				this.notifications.unshift(...pending.slice(offset));
				const retryDelay = this.notificationRetryDelayMs;
				this.notificationRetryDelayMs = Math.min(
					NOTIFICATION_RETRY_MAX_MS,
					Math.max(NOTIFICATION_RETRY_INITIAL_MS, retryDelay * 2),
				);
				return retryDelay;
			}
			this.notificationRetryDelayMs = NOTIFICATION_RETRY_INITIAL_MS;
			return undefined;
		});
	}

	private emit(): void {
		for (const listener of Array.from(this.listeners)) {
			try {
				listener();
			} catch {
				// A renderer must not change Background Work process ownership or outcomes.
			}
		}
	}

	private rememberTerminalOutcome(outcome: BackgroundWorkOutcome): void {
		this.terminalOutcomes.delete(outcome.id);
		this.terminalOutcomes.set(outcome.id, outcome);
		while (this.terminalOutcomes.size > MAX_TERMINAL_RECEIPTS) {
			const oldest = this.terminalOutcomes.keys().next().value;
			if (oldest === undefined) break;
			this.terminalOutcomes.delete(oldest);
		}
	}

	private randomId(kind: BackgroundWorkKind): string {
		const prefix = kind === "shell" ? "b" : "m";
		let id = "";
		do {
			id = prefix;
			for (let index = 0; index < 8; index += 1) id += ID_ALPHABET[randomInt(0, ID_ALPHABET.length)];
		} while (
			this.activities.has(id) ||
			this.launchActivityIds.has(id) ||
			this.monitors.has(id) ||
			this.terminalOutcomes.has(id)
		);
		return id;
	}
}
