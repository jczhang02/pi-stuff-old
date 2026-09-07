import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { isFiniteRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import type { AgentEffectOwner, AgentEffectTask } from "../../runtime/agent-effect-owner.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { sessionArtifactMatches } from "../../shared/session-identity.ts";
import {
	type AsyncJobState,
	type AsyncStartedEvent,
	type AsyncStatus,
	POLL_INTERVAL_MS,
	type ProcessTerminalV1,
	type SubagentState,
} from "../../shared/types.ts";
import { isTerminalAsyncState as isTerminalJobStatus, readStatusAsync } from "../../shared/utils.ts";
import { hasLiveNestedDescendants } from "../shared/nested-events.ts";
import { AsyncJobObserver } from "./async-job-observer.ts";
import { type AsyncStatusReader, MAX_RECENT_AGENT_JOBS, scanRestorableAsyncJobs } from "./async-job-recovery.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";

interface AsyncJobTrackerOptions {
	completionRetentionMs?: number;
	effects: AgentEffectOwner;
	/** Used only when native file observation is unavailable. */
	pollIntervalMs?: number;
	onRefresh?: () => void;
	readRunStatus?: (asyncDir: string) => Promise<AsyncStatus | null> | AsyncStatus | null;
}

interface RestoreInFlight {
	readonly generation: number;
	readonly task: AgentEffectTask<void, unknown>;
}

function rememberRecentAgentJob(state: SubagentState, job: AsyncJobState): void {
	state.recentAgentJobs ??= new Map();
	state.recentAgentJobs.set(job.asyncId, job);
	const terminal = [...state.recentAgentJobs.values()]
		.filter((candidate) => isTerminalJobStatus(candidate.status))
		.sort((left, right) => (right.updatedAt ?? right.startedAt ?? 0) - (left.updatedAt ?? left.startedAt ?? 0));
	for (const stale of terminal.slice(MAX_RECENT_AGENT_JOBS)) state.recentAgentJobs.delete(stale.asyncId);
}

function contextSummary(steps: NonNullable<AsyncStatus["steps"]>): AsyncJobState["context"] {
	const contexts = new Set(steps.map((step) => step.context).filter((value) => value !== undefined));
	if (contexts.size > 1) return "mixed";
	return contexts.values().next().value;
}

class AsyncJobTracker {
	private readonly pi: Pick<ExtensionAPI, "events">;
	private readonly state: SubagentState;
	private readonly asyncDirRoot: string;
	private readonly completionRetentionMs: number;
	private readonly effects: AgentEffectOwner;
	private readonly onRefresh: (() => void) | undefined;
	private readonly observer: AsyncJobObserver;
	private readonly readRunStatus: AsyncStatusReader;
	private trackerGeneration = 0;
	private refreshScheduled = false;
	private readonly cleanupTasks = new Map<string, AgentEffectTask<void, never>>();
	private restoreInFlight: RestoreInFlight | undefined;
	private restoredGeneration = -1;

	constructor(
		pi: Pick<ExtensionAPI, "events">,
		state: SubagentState,
		asyncDirRoot: string,
		options: AsyncJobTrackerOptions,
	) {
		this.pi = pi;
		this.state = state;
		this.asyncDirRoot = asyncDirRoot;
		this.completionRetentionMs = options.completionRetentionMs ?? 10_000;
		this.effects = options.effects;
		this.onRefresh = options.onRefresh;
		const readRunStatus = options.readRunStatus ?? readStatusAsync;
		this.readRunStatus = (asyncDir) =>
			Effect.tryPromise({ try: async () => readRunStatus(asyncDir), catch: (error) => error });
		this.observer = new AsyncJobObserver({
			acceptSessionId: (sessionId, runId) => {
				if (!this.state.currentSessionId) return undefined;
				return this.normalizeAcceptedSessionId(sessionId, runId) ?? false;
			},
			emitLifecycleEvent: (event, payload) => this.emitLifecycleEvent(event, payload),
			generation: () => this.trackerGeneration,
			isCurrentJob: (job) => this.state.asyncJobs.get(job.asyncId) === job,
			onRefresh: () => this.scheduleRefresh(),
			onStatus: (job, status) => this.applyStatus(job, status),
			pollIntervalMs: options.pollIntervalMs ?? Math.max(3_000, POLL_INTERVAL_MS),
			readRunStatus: this.readRunStatus,
			effects: this.effects,
		});
	}

	private normalizeAcceptedSessionId<SessionId, RunId>(sessionId: SessionId, runId: RunId): string | undefined {
		const { state } = this;
		if (!state.currentSessionId || !isRuntimeString(sessionId)) return undefined;
		if (sessionId === state.currentSessionId) return state.currentSessionId;
		const artifactRunId = isRuntimeString(runId) ? runId : undefined;
		return state.currentSessionScope && sessionArtifactMatches(state.currentSessionScope, sessionId, artifactRunId)
			? state.currentSessionId
			: undefined;
	}

	private emitLifecycleEvent<Payload extends object>(event: string, payload: Payload): void {
		try {
			this.pi.events.emit(event, payload);
		} catch (error) {
			reportAgentDiagnostic(`Agent lifecycle observer '${event}' failed:`, error);
		}
	}

	private scheduleRefresh(): void {
		if (this.refreshScheduled) return;
		this.refreshScheduled = true;
		queueMicrotask(() => {
			this.refreshScheduled = false;
			this.onRefresh?.();
		});
	}

	private cancelCleanup(asyncId: string): void {
		const task = this.cleanupTasks.get(asyncId);
		if (!task) return;
		this.cleanupTasks.delete(asyncId);
		void task.interrupt();
	}

	private scheduleCleanup(job: AsyncJobState): void {
		this.cancelCleanup(job.asyncId);
		const expectedGeneration = this.trackerGeneration;
		let task!: AgentEffectTask<void, never>;
		task = this.effects.start(
			Effect.sleep(this.completionRetentionMs).pipe(
				Effect.andThen(
					Effect.sync(() => {
						if (this.cleanupTasks.get(job.asyncId) !== task) return;
						this.cleanupTasks.delete(job.asyncId);
						if (this.trackerGeneration !== expectedGeneration || this.state.asyncJobs.get(job.asyncId) !== job)
							return;
						this.observer.stop(job.asyncId);
						this.state.asyncJobs.delete(job.asyncId);
						this.scheduleRefresh();
					}),
				),
			),
		);
		this.cleanupTasks.set(job.asyncId, task);
	}

	private maybeScheduleCleanup(job: AsyncJobState): void {
		if (
			!isTerminalJobStatus(job.status) ||
			(job.processTerminal !== undefined && job.processTerminal.state !== "observed") ||
			hasLiveNestedDescendants(job.nestedChildren)
		)
			return;
		if (!this.cleanupTasks.has(job.asyncId)) this.scheduleCleanup(job);
	}

	private applyStatus(job: AsyncJobState, status: AsyncStatus): void {
		const { state } = this;
		const previousStatus = job.status;
		const preserveTerminalState = isTerminalJobStatus(previousStatus) && !isTerminalJobStatus(status.state);
		if (!preserveTerminalState) job.status = status.state;
		job.error = status.error;
		job.pid = status.pid ?? job.pid;
		if (job.processTerminal?.state !== "observed" || status.processTerminal?.state === "observed") {
			job.processTerminal = status.processTerminal ?? job.processTerminal;
		}
		job.activityState = status.activityState;
		job.lastActivityAt = status.lastActivityAt ?? job.lastActivityAt;
		job.currentTool = status.currentTool;
		job.currentToolStartedAt = status.currentToolStartedAt;
		job.currentPath = status.currentPath;
		job.turnCount = status.turnCount ?? job.turnCount;
		job.toolCount = status.toolCount ?? job.toolCount;
		job.steering = status.steering ?? job.steering;
		job.mode = status.mode;
		job.cwd = status.cwd ?? job.cwd;
		job.currentStep = status.currentStep ?? job.currentStep;
		job.startedAt = status.startedAt ?? job.startedAt;
		job.updatedAt = status.lastUpdate ?? job.updatedAt;
		if (status.nestedRoute) job.nestedRoute = status.nestedRoute;
		else if (isTerminalJobStatus(status.state)) job.nestedRoute = undefined;
		if (status.steps?.length) {
			const groups = normalizeParallelGroups(status.parallelGroups, status.steps.length);
			const currentStep = status.currentStep;
			const activeGroup =
				currentStep !== undefined
					? groups.find((group) => currentStep >= group.start && currentStep < group.start + group.count)
					: undefined;
			const visibleSteps = activeGroup
				? status.steps
						.slice(activeGroup.start, activeGroup.start + activeGroup.count)
						.map((step, index) => ({ ...step, index: activeGroup.start + index }))
				: status.steps.map((step, index) => ({ ...step, index }));
			job.parallelGroups = groups;
			job.hasParallelGroups = groups.length > 0;
			job.activeParallelGroup = Boolean(activeGroup);
			job.agents = visibleSteps.map((step) => step.agent);
			job.steps = visibleSteps;
			job.stepsTotal = visibleSteps.length;
			job.completedSteps = visibleSteps.filter(
				(step) => step.status === "complete" || step.status === "completed",
			).length;
			if (status.state === "complete") job.completedSteps = visibleSteps.length;
			job.context = contextSummary(status.steps);
			job.nestedChildren = status.steps.flatMap((step) => step.children ?? []);
		}
		job.sessionDir = status.sessionDir ?? job.sessionDir;
		job.outputFile = status.outputFile ?? job.outputFile;
		job.totalTokens = status.totalTokens ?? job.totalTokens;
		job.totalCost = status.totalCost ?? job.totalCost;
		job.timeoutMs = status.timeoutMs ?? job.timeoutMs;
		job.deadlineAt = status.deadlineAt ?? job.deadlineAt;
		job.timedOut = status.timedOut ?? job.timedOut;
		job.stopped = status.stopped ?? job.stopped;
		job.turnBudget = status.turnBudget ?? job.turnBudget;
		job.turnBudgetExceeded = status.turnBudgetExceeded ?? job.turnBudgetExceeded;
		job.wrapUpRequested = status.wrapUpRequested ?? job.wrapUpRequested;
		job.toolBudget = status.toolBudget ?? job.toolBudget;
		job.toolBudgetBlocked = status.toolBudgetBlocked ?? job.toolBudgetBlocked;
		job.sessionFile = status.sessionFile ?? job.sessionFile;
		if (isTerminalJobStatus(job.status)) {
			rememberRecentAgentJob(state, job);
			this.maybeScheduleCleanup(job);
		} else {
			this.cancelCleanup(job.asyncId);
		}
	}

	private jobFromStatus(
		asyncDir: string,
		status: AsyncStatus,
		sessionId: string | undefined,
		restored: boolean,
	): AsyncJobState {
		const job: AsyncJobState = {
			asyncId: status.runId,
			asyncDir,
			status: status.state,
			mode: status.mode,
			startedAt: status.startedAt,
			updatedAt: status.lastUpdate ?? status.startedAt,
			...(restored ? { controlEventCursorPending: true } : { controlEventCursor: 0 }),
		};
		if (sessionId) job.sessionId = sessionId;
		this.applyStatus(job, status);
		return job;
	}

	readonly ensureObserver = (): void => {
		for (const job of this.state.asyncJobs.values()) this.observer.ensure(job);
	};

	readonly handleStarted = <Data>(data: Data): void => {
		const { state } = this;
		if (!isRuntimeObject(data) || data === null || Array.isArray(data)) return;
		// SAFETY: this callback is bound to the Suite-owned async-started event; id is checked before state mutation.
		const info = data as AsyncStartedEvent;
		if (!info.id) return;
		const normalizedSessionId = this.normalizeAcceptedSessionId(info.sessionId, info.id);
		if (state.currentSessionId && !normalizedSessionId) return;
		this.cancelCleanup(info.id);
		const now = Date.now();
		const asyncDir = info.asyncDir ?? path.join(this.asyncDirRoot, info.id);
		const rawAgents = info.agents?.length ? info.agents : info.agent ? [info.agent] : undefined;
		const validParallelGroups = normalizeParallelGroups(info.parallelGroups, rawAgents?.length ?? 0);
		const firstGroup = validParallelGroups.find((group) => group.start === 0);
		const firstGroupCount = firstGroup?.count;
		const agents = firstGroupCount && firstGroupCount > 0 ? rawAgents?.slice(0, firstGroupCount) : rawAgents;
		const existing = state.asyncJobs.get(info.id);
		const job: AsyncJobState = existing ?? {
			asyncId: info.id,
			asyncDir,
			status: "queued",
			mode:
				info.mode === "parallel" || (info.mode !== "single" && (rawAgents?.length ?? 0) > 1)
					? "parallel"
					: "single",
			startedAt: now,
			updatedAt: now,
			controlEventCursor: 0,
		};
		job.asyncDir = asyncDir;
		job.cwd = isRuntimeString(info.cwd) ? path.resolve(info.cwd) : job.cwd;
		job.pid = isFiniteRuntimeNumber(info.pid) ? info.pid : job.pid;
		job.sessionId = normalizedSessionId ?? job.sessionId;
		job.description = info.description ?? info.goal ?? info.task ?? job.description;
		job.descriptions = info.descriptions ?? job.descriptions;
		job.tasks = info.tasks ?? job.tasks;
		job.agents = agents ?? job.agents;
		job.parallelGroups = validParallelGroups.length > 0 ? validParallelGroups : job.parallelGroups;
		job.nestedRoute = info.nestedRoute ?? job.nestedRoute;
		job.stepsTotal = firstGroupCount ?? agents?.length ?? job.stepsTotal;
		job.hasParallelGroups = validParallelGroups.length > 0 || job.hasParallelGroups;
		job.activeParallelGroup = Boolean(firstGroupCount && firstGroupCount > 0) || job.activeParallelGroup;
		job.timeoutMs = info.timeoutMs ?? job.timeoutMs;
		job.deadlineAt = info.deadlineAt ?? job.deadlineAt;
		job.turnBudget = info.turnBudget ?? job.turnBudget;
		state.asyncJobs.set(info.id, job);
		rememberRecentAgentJob(state, job);
		this.observer.ensure(job);
		void this.observer.observe(job, { status: true, control: true });
		this.scheduleRefresh();
	};

	readonly handleStatus = <Data>(data: Data): void => {
		const { state } = this;
		if (!data || !isRuntimeObject(data) || Array.isArray(data)) return;
		// SAFETY: this callback is bound to the Suite-owned status event; envelope fields are checked below.
		const update = data as { id?: unknown; asyncDir?: unknown; sessionId?: unknown; status?: unknown };
		if (
			!isRuntimeString(update.id) ||
			!isRuntimeString(update.asyncDir) ||
			!update.status ||
			!isRuntimeObject(update.status)
		)
			return;
		// SAFETY: the status event producer emits AsyncStatus and the run/directory identities are checked immediately after.
		const status = update.status as AsyncStatus;
		if (status.runId !== update.id || path.basename(update.asyncDir) !== update.id) return;
		const normalizedSessionId = this.normalizeAcceptedSessionId(update.sessionId ?? status.sessionId, update.id);
		if (state.currentSessionId && !normalizedSessionId) return;
		let job = state.asyncJobs.get(update.id);
		if (!job) {
			job = this.jobFromStatus(update.asyncDir, status, normalizedSessionId, false);
			state.asyncJobs.set(update.id, job);
		} else {
			if (path.resolve(update.asyncDir) !== path.resolve(job.asyncDir)) return;
			this.applyStatus(job, status);
		}
		this.observer.noteIpcStatus(update.id);
		rememberRecentAgentJob(state, job);
		this.observer.ensure(job);
		this.scheduleRefresh();
	};

	readonly handleComplete = <Data>(data: Data): void => {
		const { state } = this;
		if (!isRuntimeObject(data) || data === null || Array.isArray(data)) return;
		// SAFETY: this callback is bound to the Suite-owned completion event; id gates all state mutation.
		const result = data as {
			id?: string;
			success?: boolean;
			state?: AsyncJobState["status"];
			asyncDir?: string;
			sessionId?: string;
			stopped?: boolean;
		};
		if (!result.id) return;
		if (state.currentSessionId && !this.normalizeAcceptedSessionId(result.sessionId, result.id)) return;
		const job = state.asyncJobs.get(result.id);
		if (!job) return;
		job.status = result.state ?? (result.success ? "complete" : "failed");
		job.stopped = result.stopped ?? job.stopped;
		job.updatedAt = Date.now();
		if (result.asyncDir && result.asyncDir !== job.asyncDir) {
			this.observer.stop(job.asyncId);
			job.asyncDir = result.asyncDir;
			this.observer.ensure(job);
		}
		rememberRecentAgentJob(state, job);
		this.maybeScheduleCleanup(job);
		void this.observer.observe(job, { status: true, control: true });
		this.scheduleRefresh();
	};

	readonly handleProcessTerminal = <Data>(data: Data): void => {
		if (!data || !isRuntimeObject(data) || Array.isArray(data)) return;
		// SAFETY: this callback is bound to the Suite-owned process-terminal event; proof identity fields are checked below.
		const proof = data as Partial<ProcessTerminalV1> & { asyncDir?: unknown };
		if (
			!isRuntimeString(proof.runId) ||
			proof.state !== "observed" ||
			!isFiniteRuntimeNumber(proof.observedAt) ||
			!isRuntimeString(proof.runnerProcessInstanceId) ||
			!proof.runnerProcessInstanceId
		)
			return;
		const job = this.state.asyncJobs.get(proof.runId);
		if (!job) return;
		if (isRuntimeString(proof.asyncDir) && path.resolve(proof.asyncDir) !== path.resolve(job.asyncDir)) return;
		if (
			job.processTerminal?.runnerProcessInstanceId &&
			job.processTerminal.runnerProcessInstanceId !== proof.runnerProcessInstanceId
		)
			return;
		// SAFETY: the process-terminal producer emits the full discriminated proof and the observed variant's identity was checked above.
		job.processTerminal = proof as ProcessTerminalV1;
		job.updatedAt = Math.max(job.updatedAt ?? 0, proof.observedAt);
		this.maybeScheduleCleanup(job);
		void this.observer.observe(job, { status: true, control: true });
		this.scheduleRefresh();
	};

	readonly resetJobs = (): void => {
		this.trackerGeneration += 1;
		this.observer.clear();
		for (const task of this.cleanupTasks.values()) void task.interrupt();
		this.cleanupTasks.clear();
		this.state.asyncJobs.clear();
		this.state.recentAgentJobs?.clear();
		this.state.foregroundControls?.clear();
		this.state.lastForegroundControlId = null;
		if (this.restoreInFlight) void this.restoreInFlight.task.interrupt();
		this.restoreInFlight = undefined;
		this.restoredGeneration = -1;
	};

	readonly restoreActiveJobs = (asyncDirectories?: readonly string[]): Promise<void> => {
		const { state } = this;
		const targeted = asyncDirectories !== undefined;
		if (!targeted && this.restoredGeneration === this.trackerGeneration) return Promise.resolve();
		if (this.restoreInFlight?.generation === this.trackerGeneration) {
			return this.restorePromise(this.restoreInFlight.task);
		}
		const generation = this.trackerGeneration;
		const sessionId = state.currentSessionId;
		if (!sessionId) return Promise.resolve();
		const task = this.effects.start(
			scanRestorableAsyncJobs(this.asyncDirRoot, asyncDirectories, this.readRunStatus, (candidateSessionId, runId) =>
				this.normalizeAcceptedSessionId(candidateSessionId, runId),
			).pipe(
				Effect.flatMap((jobs) =>
					Effect.sync(() => {
						if (this.trackerGeneration !== generation || state.currentSessionId !== sessionId) return;
						for (const { asyncDir, status, sessionId: normalized } of jobs) {
							const existing = state.asyncJobs.get(status.runId);
							const job = existing ?? this.jobFromStatus(asyncDir, status, normalized, true);
							if (existing) this.applyStatus(existing, status);
							rememberRecentAgentJob(state, job);
							if (
								status.state === "queued" ||
								status.state === "running" ||
								(status.processTerminal !== undefined && status.processTerminal.state !== "observed")
							) {
								state.asyncJobs.set(status.runId, job);
								this.observer.ensure(job);
								this.observer.observe(job, { control: true });
							}
						}
						this.scheduleRefresh();
						if (!targeted) this.restoredGeneration = generation;
					}),
				),
			),
		);
		this.restoreInFlight = { generation, task };
		void task.result.then(() => {
			if (this.restoreInFlight?.task === task) this.restoreInFlight = undefined;
		});
		return this.restorePromise(task);
	};

	private restorePromise(task: AgentEffectTask<void, unknown>): Promise<void> {
		return task.result.then((exit) => {
			if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
			throw Cause.squash(exit.cause);
		});
	}
}

export function createAsyncJobTracker(
	pi: Pick<ExtensionAPI, "events">,
	state: SubagentState,
	asyncDirRoot: string,
	options: AsyncJobTrackerOptions,
) {
	return new AsyncJobTracker(pi, state, asyncDirRoot, options);
}
