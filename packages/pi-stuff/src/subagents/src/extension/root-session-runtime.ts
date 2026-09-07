import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { isRuntimeFunction } from "../../../shared/runtime-type.ts";
import { hasLiveNestedDescendants } from "../runs/shared/nested-events.ts";
import {
	PI_STUFF_AGENT_PATH_ENV,
	SUBAGENT_PARENT_PHYSICAL_SESSION_ENV,
	SUBAGENT_PARENT_SESSION_ENV,
} from "../runs/shared/pi-args.ts";
import type { AgentEffectOwner, AgentEffectTask } from "../runtime/agent-effect-owner.ts";
import { type AgentExecutionCoordinatorPort, parseAgentOwnerPath } from "../runtime/agent-execution-coordinator.ts";
import type { PrepareSessionGovernorCompatibilityInput } from "../runtime/session-governor-compatibility.ts";
import {
	mergeForegroundRuns,
	recoverForegroundRuntimeRunsAsync,
	replayForegroundRuns,
} from "../session/foreground-replay.ts";
import { reportAgentDiagnostic } from "../shared/diagnostics.ts";
import {
	buildSessionCompatibilityScope,
	buildSessionGovernorCompatibilityScope,
	resolveCurrentSessionIdentity,
} from "../shared/session-identity.ts";
import { ASYNC_DIR, RESULTS_DIR, type SubagentState, TEMP_ROOT_DIR } from "../shared/types.ts";
import type { CompactCompletionNotifier } from "./completion-handling.ts";
import type { PiStuffAgentsConfig } from "./config.ts";

const MAINTENANCE_SUCCESS_INTERVAL_MS = 60 * 60 * 1_000;
const MAINTENANCE_FAILURE_RETRY_MS = 60 * 1_000;

export interface RootTracker {
	ensureObserver(): void;
	handleComplete<Data>(data: Data): void;
	handleProcessTerminal<Data>(data: Data): void;
	handleStarted<Data>(data: Data): void;
	handleStatus<Data>(data: Data): void;
	resetJobs(): void;
	restoreActiveJobs(asyncDirectories?: readonly string[]): Promise<void>;
}

export interface RootWatcher {
	primeExistingResults(options?: { triggerTurn?: boolean }): void;
	startResultWatcher(): boolean;
	stopResultWatcher(): void;
}

export interface RootSupervisor {
	dispose(): void;
	pause?(): void;
	start(): void | Promise<void>;
}

interface RootSessionRuntimeInput {
	readonly effects: AgentEffectOwner;
	readonly bindContext: (ctx: ExtensionContext) => void;
	readonly clearGlobalCleanup: () => void;
	readonly config: PiStuffAgentsConfig;
	readonly disposeRuntimeEvents: () => void;
	readonly disposeSurface: () => void;
	readonly ensureDirectory: (directory: string) => void;
	readonly governor: AgentExecutionCoordinatorPort;
	readonly maintainRuntime: () => Promise<void> | void;
	readonly monotonicNow: () => number;
	readonly notifier: CompactCompletionNotifier;
	readonly prepareGovernorCompatibility: (
		input: Omit<PrepareSessionGovernorCompatibilityInput, "inspectWriterLiveness">,
	) => Promise<{ readonly ok: boolean; readonly message?: string }>;
	readonly previousCleanup: Promise<void>;
	readonly refresh: () => void;
	readonly resetAgentRoster: () => void;
	readonly state: SubagentState;
	readonly supervisor: RootSupervisor;
	readonly tracker: RootTracker;
	readonly watcher: RootWatcher;
}

function hasLiveWork(state: SubagentState): boolean {
	if (state.foregroundControls.size > 0) return true;
	if (
		[...state.asyncJobs.values()].some(
			(job) =>
				job.status === "queued" ||
				job.status === "running" ||
				(job.processTerminal !== undefined && job.processTerminal.state !== "observed") ||
				hasLiveNestedDescendants(job.nestedChildren),
		)
	)
		return true;
	return [...(state.foregroundRuns?.values() ?? [])].some(
		(run) =>
			Boolean(run.nestedRoute) ||
			(Boolean(run.asyncDir) && run.children.some((child) => child.status === "detached")) ||
			run.children.some((child) => hasLiveNestedDescendants(child.children)),
	);
}

/** Owns current-Session activation, recovery, compatibility, and teardown state. */
export class RootSessionRuntime {
	private readonly input: RootSessionRuntimeInput;
	private active = true;
	private watcherStarted = false;
	private sessionEpoch = 0;
	private runtimeActivatedEpoch = -1;
	private runtimeActivation: { epoch: number; promise: Promise<void> } | undefined;
	private historyRecoveredEpoch = -1;
	private historyRecovery: { epoch: number; promise: Promise<void> } | undefined;
	private governorCompatibilityReady = false;
	private governorCompatibilityError: string | undefined;
	private governorCompatibilityCheck: { epoch: number; promise: Promise<void> } | undefined;
	private governorCompatibilityScope: ReturnType<typeof buildSessionGovernorCompatibilityScope> | undefined;
	private maintenanceTask: AgentEffectTask<void, never> | undefined;
	private nextMaintenanceAt = 0;
	private ephemeralSessionNonce = randomUUID();

	constructor(input: RootSessionRuntimeInput) {
		this.input = input;
	}

	rootState(): {
		readonly active: boolean;
		readonly sessionEpoch: number;
		readonly ephemeralSessionNonce: string;
		readonly compatibilityReady: boolean;
		readonly compatibilityError?: string;
	} {
		const state = {
			active: this.active,
			sessionEpoch: this.sessionEpoch,
			ephemeralSessionNonce: this.ephemeralSessionNonce,
			compatibilityReady: this.governorCompatibilityReady,
		};
		return this.governorCompatibilityError === undefined
			? state
			: { ...state, compatibilityError: this.governorCompatibilityError };
	}

	async activate(ctx: ExtensionContext): Promise<void> {
		this.input.bindContext(ctx);
		if (!this.input.state.currentSessionId || !this.input.state.currentSessionScope) return;
		const epoch = this.sessionEpoch;
		if (this.runtimeActivatedEpoch === epoch) return;
		if (this.runtimeActivation?.epoch === epoch) return this.runtimeActivation.promise;
		const activation = { epoch, promise: Promise.resolve() };
		activation.promise = (async () => {
			try {
				this.bindExecutionGovernor(ctx);
				await this.input.governor.reconcileExisting();
				if (!this.active || epoch !== this.sessionEpoch) return;
				this.startRunRuntime({ createDirectories: false, primeExisting: true });
				if (hasLiveWork(this.input.state)) this.input.tracker.ensureObserver();
				this.input.refresh();
				await this.input.supervisor.start();
				this.runtimeActivatedEpoch = epoch;
			} finally {
				if (this.runtimeActivation === activation) this.runtimeActivation = undefined;
			}
		})();
		this.runtimeActivation = activation;
		return activation.promise;
	}

	async recoverHistory(ctx: ExtensionContext): Promise<void> {
		this.input.bindContext(ctx);
		const state = this.input.state;
		if (!state.currentSessionId || !state.currentSessionScope) return;
		const epoch = this.sessionEpoch;
		const sessionScope = state.currentSessionScope;
		if (this.historyRecoveredEpoch === epoch) return;
		if (this.historyRecovery?.epoch === epoch) return this.historyRecovery.promise;
		const recovery = { epoch, promise: Promise.resolve() };
		recovery.promise = (async () => {
			try {
				const recovered = await recoverForegroundRuntimeRunsAsync(
					path.join(TEMP_ROOT_DIR, "foreground-runs"),
					sessionScope,
				);
				await this.input.tracker.restoreActiveJobs();
				if (!this.active || epoch !== this.sessionEpoch) return;
				state.foregroundRuns = mergeForegroundRuns(state.foregroundRuns ?? new Map(), recovered);
				this.input.refresh();
				this.historyRecoveredEpoch = epoch;
			} finally {
				if (this.historyRecovery === recovery) this.historyRecovery = undefined;
			}
		})();
		this.historyRecovery = recovery;
		return recovery.promise;
	}

	async refreshGovernorCompatibility(_ctx: ExtensionContext): Promise<void> {
		const epoch = this.sessionEpoch;
		if (this.governorCompatibilityCheck?.epoch === epoch) return this.governorCompatibilityCheck.promise;
		const check = { epoch, promise: Promise.resolve() };
		check.promise = (async () => {
			try {
				const scope = this.governorCompatibilityScope;
				if (!scope) throw new Error("Agent governor compatibility has no current Session snapshot.");
				const result = await this.input.prepareGovernorCompatibility({
					scope,
					limits: {
						maxDepth: this.input.config.maxSubagentDepth,
						maxRunning: this.input.config.maxRunningAgents,
					},
				});
				if (this.active && epoch === this.sessionEpoch) {
					this.governorCompatibilityReady = result.ok;
					this.governorCompatibilityError = result.ok ? undefined : result.message;
				}
			} catch (error) {
				if (this.active && epoch === this.sessionEpoch) {
					this.governorCompatibilityReady = false;
					this.governorCompatibilityError = `Agent launches are paused because governor compatibility could not be verified: ${
						error instanceof Error ? error.message : String(error)
					}`;
				}
			} finally {
				if (this.governorCompatibilityCheck === check) this.governorCompatibilityCheck = undefined;
			}
		})();
		this.governorCompatibilityCheck = check;
		return check.promise;
	}

	startRunRuntime(options: { createDirectories: boolean; primeExisting: boolean }): void {
		if (options.createDirectories) {
			this.input.ensureDirectory(RESULTS_DIR);
			this.input.ensureDirectory(ASYNC_DIR);
		}
		if (!this.watcherStarted) this.watcherStarted = this.input.watcher.startResultWatcher();
		if (options.primeExisting) this.input.watcher.primeExistingResults({ triggerTurn: false });
	}

	scheduleMaintenance(): void {
		if (this.maintenanceTask || !this.active) return;
		if (this.input.monotonicNow() < this.nextMaintenanceAt) return;
		let task!: AgentEffectTask<void, never>;
		try {
			task = this.input.effects.start(
				Effect.sleep(0).pipe(
					Effect.andThen(
						Effect.tryPromise({
							try: async () => this.input.maintainRuntime(),
							catch: (error) => error,
						}).pipe(
							Effect.tap(() =>
								Effect.sync(() => {
									this.nextMaintenanceAt = this.input.monotonicNow() + MAINTENANCE_SUCCESS_INTERVAL_MS;
								}),
							),
							Effect.catch((error) =>
								Effect.sync(() => {
									this.nextMaintenanceAt = this.input.monotonicNow() + MAINTENANCE_FAILURE_RETRY_MS;
									reportAgentDiagnostic("Failed to maintain completed Agent runtime data:", error);
								}),
							),
						),
					),
					Effect.ensuring(
						Effect.sync(() => {
							if (this.maintenanceTask === task) this.maintenanceTask = undefined;
						}),
					),
				),
			);
			this.maintenanceTask = task;
		} catch (error) {
			reportAgentDiagnostic("Failed to schedule Agent runtime maintenance:", error);
		}
	}

	async startSession(ctx: ExtensionContext): Promise<void> {
		if (!this.active) return;
		await this.input.previousCleanup;
		if (!this.active) return;
		this.resetSessionRuntime();
		await this.input.effects.startSession(ctx.sessionManager);
		if (!this.active) return;
		const epoch = this.sessionEpoch;
		const state = this.input.state;
		state.baseCwd = ctx.cwd;
		this.ephemeralSessionNonce = randomUUID();
		const identity = resolveCurrentSessionIdentity(ctx.sessionManager, ctx.cwd, this.ephemeralSessionNonce);
		state.currentSessionId = identity.sessionId;
		state.currentGovernorSessionId = identity.governorSessionId;
		const entries = isRuntimeFunction(ctx.sessionManager.getBranch)
			? ctx.sessionManager.getBranch()
			: ctx.sessionManager.getEntries();
		this.input.notifier.reset(entries);
		const sessionScope = buildSessionCompatibilityScope(identity, entries);
		state.currentSessionScope = sessionScope;
		this.governorCompatibilityScope = buildSessionGovernorCompatibilityScope(identity, entries);
		state.foregroundRuns = state.currentSessionId ? replayForegroundRuns(entries, state.currentSessionId) : new Map();
		state.parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
		this.input.bindContext(ctx);
		this.bindExecutionGovernor(ctx);
		try {
			await this.restoreSessionRuns(epoch, sessionScope);
		} catch (error) {
			if (this.active && epoch === this.sessionEpoch) throw error;
			return;
		}
		if (!this.active || epoch !== this.sessionEpoch) return;
		this.input.refresh();
	}

	async dispose(): Promise<void> {
		if (!this.active) return;
		this.active = false;
		this.sessionEpoch += 1;
		this.input.watcher.stopResultWatcher();
		this.watcherStarted = false;
		this.input.disposeRuntimeEvents();
		this.input.tracker.resetJobs();
		await this.input.effects.stop();
		const state = this.input.state;
		state.asyncJobs.clear();
		state.recentAgentJobs?.clear();
		state.foregroundRuns?.clear();
		state.foregroundControls.clear();
		state.currentSessionId = null;
		state.currentSessionScope = null;
		state.currentGovernorSessionId = null;
		this.governorCompatibilityReady = false;
		this.governorCompatibilityError = undefined;
		this.governorCompatibilityScope = undefined;
		state.parentSessionFile = null;
		state.lastUiContext = null;
		this.input.notifier.dispose();
		this.input.governor.dispose();
		this.input.supervisor.dispose();
		this.input.disposeSurface();
		delete process.env[SUBAGENT_PARENT_SESSION_ENV];
		delete process.env[SUBAGENT_PARENT_PHYSICAL_SESSION_ENV];
		this.input.clearGlobalCleanup();
	}

	private bindExecutionGovernor(ctx: ExtensionContext): void {
		const state = this.input.state;
		const identity =
			state.currentSessionScope ??
			resolveCurrentSessionIdentity(ctx.sessionManager, ctx.cwd, this.ephemeralSessionNonce);
		const ownerAgentPath = parseAgentOwnerPath(process.env[PI_STUFF_AGENT_PATH_ENV]);
		const ledgerSessionId = state.currentGovernorSessionId?.trim() || identity.governorSessionId;
		process.env[SUBAGENT_PARENT_SESSION_ENV] = ledgerSessionId;
		process.env[SUBAGENT_PARENT_PHYSICAL_SESSION_ENV] = identity.sessionId;
		this.input.governor.bindSession({ sessionId: ledgerSessionId, ownerAgentPath });
	}

	private resetSessionRuntime(): void {
		this.sessionEpoch += 1;
		this.input.resetAgentRoster();
		this.runtimeActivatedEpoch = -1;
		this.runtimeActivation = undefined;
		this.historyRecoveredEpoch = -1;
		this.historyRecovery = undefined;
		this.input.watcher.stopResultWatcher();
		this.watcherStarted = false;
		this.input.supervisor.pause?.();
		this.input.tracker.resetJobs();
		this.governorCompatibilityReady = false;
		this.governorCompatibilityError = undefined;
	}

	private async restoreSessionRuns(
		epoch: number,
		sessionScope: ReturnType<typeof buildSessionCompatibilityScope>,
	): Promise<void> {
		const leases = (await this.input.governor.inspectExistingRuntimeLeases?.()) ?? [];
		if (!this.active || epoch !== this.sessionEpoch) return;
		const foregroundRoot = path.resolve(path.join(TEMP_ROOT_DIR, "foreground-runs"));
		const backgroundRoot = path.resolve(ASYNC_DIR);
		const foregroundDirectories: string[] = [];
		const backgroundDirectories: string[] = [];
		for (const lease of leases) {
			if (!lease.asyncDir) continue;
			const directory = path.resolve(lease.asyncDir);
			if (path.dirname(directory) === foregroundRoot) foregroundDirectories.push(directory);
			else if (path.dirname(directory) === backgroundRoot) backgroundDirectories.push(directory);
		}
		const recoveredForeground = await recoverForegroundRuntimeRunsAsync(
			path.join(TEMP_ROOT_DIR, "foreground-runs"),
			sessionScope,
			foregroundDirectories,
		);
		if (!this.active || epoch !== this.sessionEpoch) return;
		const state = this.input.state;
		state.foregroundRuns = mergeForegroundRuns(state.foregroundRuns ?? new Map(), recoveredForeground);
		await this.input.tracker.restoreActiveJobs(backgroundDirectories);
	}
}
