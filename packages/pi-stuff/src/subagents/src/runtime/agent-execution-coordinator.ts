import * as Effect from "effect/Effect";
import { isRuntimeFunction, isRuntimeString } from "../../../shared/runtime-type.ts";
import { readProcessStartIdentity, readSystemBootIdentity } from "../shared/process-identity.ts";
import type { AgentEffectOwner } from "./agent-effect-owner.ts";
import type {
	AgentExecutionReservation,
	AgentExecutionReservationResult,
	AgentExecutionSettlement,
	AgentExecutionSettlementResult,
	AgentRuntimeCompletionEvent,
	AgentRuntimeCompletionResult,
	ReserveAgentResumeInput,
	ReserveAgentSpawnInput,
} from "./agent-execution-governor.ts";
import {
	explicitProcessPidState,
	nonNegativeSafeInteger,
	optionalPositiveSafeInteger,
	optionalText,
	parseAgentOwnerPath,
	record,
	requiredText,
	runtimeCompletionAddresses,
} from "./agent-runtime-event.ts";
import { createRuntimeProcessState, type RuntimeProcessState } from "./agent-runtime-liveness.ts";
import {
	type DurableAgentOperation,
	runDurableAgentOperation,
	scheduleDurableAgentOperation,
	stopDurableAgentOperation,
} from "./durable-agent-operation.ts";
import type {
	AgentGovernorLease,
	RebindAgentRuntimeRequest,
	SessionGovernorRebindResult,
	SessionGovernorSnapshot,
} from "./session-governor.ts";
import { samePath } from "./session-governor-contracts.ts";

export { explicitProcessPidState, parseAgentOwnerPath, runtimeCompletionAddresses };

export interface AgentExecutionGovernorPort {
	reserveSpawn(input: ReserveAgentSpawnInput): Promise<AgentExecutionReservationResult>;
	reserveResume(input: ReserveAgentResumeInput): Promise<AgentExecutionReservationResult>;
	rebindChild(
		reservation: AgentExecutionReservation,
		reservationIndex: number,
		request: RebindAgentRuntimeRequest,
	): Promise<SessionGovernorRebindResult>;
	settle(
		reservation: AgentExecutionReservation,
		settlement: AgentExecutionSettlement,
	): Promise<AgentExecutionSettlementResult>;
	findRuntimeLease(event: AgentRuntimeCompletionEvent): Promise<AgentGovernorLease | undefined>;
	completeRuntime(event: AgentRuntimeCompletionEvent): Promise<AgentRuntimeCompletionResult>;
}

export interface AgentExecutionCoordinatorSession {
	readonly governor: AgentExecutionGovernorPort;
	hasLedger?(): Promise<boolean>;
	inspectExistingSnapshot?(): Promise<SessionGovernorSnapshot | undefined>;
	reconcile(isPidAlive: (pid: number, lease: AgentGovernorLease) => boolean | undefined): Promise<void>;
}

export interface AgentExecutionSessionIdentity {
	readonly sessionId: string;
	readonly ownerAgentPath: readonly string[];
}

export interface GovernedAgentParams {
	readonly action?: "resume" | "status" | "steer" | "stop";
	readonly agent?: unknown;
	readonly id?: string;
	readonly index?: number;
	readonly task?: unknown;
	readonly tasks?: readonly unknown[];
}

export interface GovernedEngineResult {
	readonly isError?: boolean;
	readonly details: {
		readonly asyncId?: string;
		readonly runId?: string;
		readonly results?: readonly unknown[];
		readonly lifecycleBinding?: {
			readonly pid: number;
			readonly processStartIdentity?: string;
			readonly asyncDir: string;
			readonly acknowledgeStart?: () => void;
			readonly abortStart?: () => boolean;
		};
	};
}

export interface AgentExecutionInvocation {
	readonly launchRunId: string;
	readonly reservation: AgentExecutionReservation;
}

export type AgentExecutionPrepareResult =
	| { readonly ok: true; readonly invocation?: AgentExecutionInvocation }
	| { readonly ok: false; readonly message: string };

export interface AgentExecutionCoordinatorPort {
	bindSession(identity: AgentExecutionSessionIdentity): void;
	prepare(input: {
		readonly launchRunId: string;
		readonly params: GovernedAgentParams;
		readonly resumeTargetRunId?: string;
		readonly acknowledgeCost?: boolean;
	}): Promise<AgentExecutionPrepareResult>;
	observeAsyncStarted<Event>(event: Event): Promise<void>;
	settle(invocation: AgentExecutionInvocation, result: GovernedEngineResult): Promise<void>;
	fail(invocation: AgentExecutionInvocation): Promise<void>;
	complete<Event>(event: Event): Promise<void>;
	reconcileDead(): Promise<void>;
	reconcileExisting(): Promise<void>;
	inspectExistingRuntimeLeases?(): Promise<readonly AgentGovernorLease[]>;
	dispose(): void;
}

export interface AgentExecutionCoordinatorOptions {
	readonly createSession: (identity: AgentExecutionSessionIdentity) => AgentExecutionCoordinatorSession;
	readonly effects: AgentEffectOwner;
	readonly isPidAlive?: ((pid: number) => boolean | undefined) | undefined;
	readonly readProcessStartIdentity?: ((pid: number) => string | undefined) | undefined;
	readonly readSystemBootIdentity?: (() => string | undefined) | undefined;
}

interface AsyncStart {
	runtimeRunId: string;
	pid?: number;
	processStartIdentity?: string;
	asyncDir?: string;
	acknowledgeStart?: () => void;
	abortStart?: () => boolean;
}

export class AgentRuntimeBindingRejectedError extends Error {
	readonly code = "agent_runtime_binding_rejected";

	constructor(message: string) {
		super(message);
		this.name = "AgentRuntimeBindingRejectedError";
	}
}

interface BoundInvocation {
	readonly invocation: AgentExecutionInvocation;
	readonly session: AgentExecutionCoordinatorSession;
	readonly generation: number;
	readonly starts: Map<string, AsyncStart>;
	settled: boolean;
	pending?: PendingSettlement;
}

interface PendingSettlement extends DurableAgentOperation {
	readonly owner?: BoundInvocation;
	readonly session: AgentExecutionCoordinatorSession;
	readonly reservation: AgentExecutionReservation;
	readonly runtimeRunId: string;
	readonly start?: AsyncStart;
	readonly bindRuntime: boolean;
	readonly settlement: AgentExecutionSettlement;
}

interface PendingSettlementInput {
	readonly owner?: BoundInvocation;
	readonly session: AgentExecutionCoordinatorSession;
	readonly reservation: AgentExecutionReservation;
	readonly runtimeRunId: string;
	start?: AsyncStart | undefined;
	readonly bindRuntime: boolean;
	readonly settlement: AgentExecutionSettlement;
}

interface PendingCompletion extends DurableAgentOperation {
	readonly address: AgentRuntimeCompletionEvent;
	readonly session: AgentExecutionCoordinatorSession;
	readonly generation: number;
	readonly bindingCandidates: Set<BoundInvocation>;
}

/** Pure lifecycle coordinator shared by the root extension and fanout children. */
export class AgentExecutionCoordinator implements AgentExecutionCoordinatorPort {
	private readonly active = new Map<string, BoundInvocation>();
	private readonly asyncStarts = new Map<string, AsyncStart>();
	private readonly createSession: AgentExecutionCoordinatorOptions["createSession"];
	private readonly effects: AgentEffectOwner;
	private readonly readProcessStartIdentity: (pid: number) => string | undefined;
	private readonly runtimeProcessState: RuntimeProcessState;
	private readonly invocationRecords = new WeakMap<AgentExecutionInvocation, BoundInvocation>();
	private readonly pendingCompletions = new Map<string, PendingCompletion>();
	private readonly pendingSettlements = new Set<PendingSettlement>();
	private boundIdentity: AgentExecutionSessionIdentity | undefined;
	private boundSession: AgentExecutionCoordinatorSession | undefined;
	private generation = 0;

	constructor(options: AgentExecutionCoordinatorOptions) {
		this.createSession = options.createSession;
		this.effects = options.effects;
		this.readProcessStartIdentity = options.readProcessStartIdentity ?? readProcessStartIdentity;
		this.runtimeProcessState = createRuntimeProcessState({
			isPidAlive: options.isPidAlive ?? explicitProcessPidState,
			readProcessStartIdentity: this.readProcessStartIdentity,
			readSystemBootIdentity: options.readSystemBootIdentity ?? readSystemBootIdentity,
		});
	}

	bindSession(identity: AgentExecutionSessionIdentity): void {
		const sessionId = requiredText("sessionId", identity.sessionId);
		const ownerAgentPath = identity.ownerAgentPath.map((component) => requiredText("ownerAgentPath", component));
		if (this.boundIdentity?.sessionId === sessionId && samePath(this.boundIdentity.ownerAgentPath, ownerAgentPath)) {
			return;
		}
		this.generation += 1;
		this.clearEphemeralState();
		this.boundIdentity = Object.freeze({ sessionId, ownerAgentPath: Object.freeze(ownerAgentPath) });
		this.boundSession = undefined;
		for (const pending of this.pendingSettlements) {
			stopDurableAgentOperation(pending, true);
			this.scheduleSettlementRetry(pending);
		}
		for (const pending of this.pendingCompletions.values()) {
			stopDurableAgentOperation(pending, true);
			this.scheduleCompletionRetry(pending);
		}
	}

	async prepare(input: {
		readonly launchRunId: string;
		readonly params: GovernedAgentParams;
		readonly resumeTargetRunId?: string;
		readonly acknowledgeCost?: boolean;
	}): Promise<AgentExecutionPrepareResult> {
		const launchRunId = requiredText("launchRunId", input.launchRunId);
		if (input.params.action && input.params.action !== "resume") return { ok: true };
		const session = this.sessionOrFailure();
		if (isRuntimeString(session)) return { ok: false, message: session };
		const generation = this.generation;
		try {
			// A nested background completion may outlive the fanout Host that
			// launched it. Reclaim only OS-proven dead leases before enforcing the
			// next capacity reservation, so sequential work cannot exhaust running.
			await session.reconcile(this.runtimeProcessState);
		} catch (error) {
			return {
				ok: false,
				message: `Cannot verify Agent capacity before launch: ${
					error instanceof Error ? error.message : String(error)
				}`,
			};
		}
		if (this.generation !== generation) {
			return { ok: false, message: "Agent launch cancelled because the parent session ended or changed." };
		}

		let reserved: AgentExecutionReservationResult;
		if (input.params.action === "resume") {
			const targetRunId = input.resumeTargetRunId?.trim() || input.params.id?.trim();
			if (!targetRunId) return { ok: false, message: "Cannot resume an Agent without its run id." };
			reserved = await session.governor.reserveResume({
				launchRunId,
				targetRunId,
				childIndex: nonNegativeSafeInteger("index", input.params.index ?? 0),
				acknowledgeCost: input.acknowledgeCost === true,
			});
		} else {
			reserved = await session.governor.reserveSpawn({
				launchRunId,
				childCount: input.params.tasks?.length || 1,
			});
		}
		if (!reserved.ok) return { ok: false, message: reserved.message };
		const invocation = Object.freeze({ launchRunId, reservation: reserved.reservation });
		if (this.generation !== generation) {
			const rollback = this.createPendingSettlement({
				session,
				reservation: reserved.reservation,
				runtimeRunId: launchRunId,
				bindRuntime: false,
				settlement: { kind: "start-error" },
			});
			try {
				await this.attemptPendingSettlement(rollback);
			} catch {
				this.scheduleSettlementRetry(rollback);
			}
			return {
				ok: false,
				message: "Agent launch cancelled because the parent session ended or changed during reservation.",
			};
		}
		const bound: BoundInvocation = {
			invocation,
			session,
			generation,
			starts: new Map(),
			settled: false,
		};
		this.active.set(launchRunId, bound);
		this.invocationRecords.set(invocation, bound);
		return { ok: true, invocation };
	}

	async observeAsyncStarted<Event>(event: Event): Promise<void> {
		const value = record(event);
		const runtimeRunId = optionalText(value.id) ?? optionalText(value.runId);
		if (!runtimeRunId) return;
		const pid = optionalPositiveSafeInteger(value.pid);
		const processStartIdentity =
			optionalText(value.processStartIdentity) ??
			(pid === undefined ? undefined : this.readProcessStartIdentity(pid));
		const asyncDir = optionalText(value.asyncDir);
		const acknowledgeStartCandidate = value.acknowledgeStart;
		const rawAcknowledgeStart = isRuntimeFunction(acknowledgeStartCandidate)
			? () => acknowledgeStartCandidate()
			: undefined;
		const abortStartCandidate = value.abortStart;
		const abortStart = isRuntimeFunction(abortStartCandidate) ? () => abortStartCandidate() === true : undefined;
		let startupAcknowledged = false;
		const acknowledgeStart = rawAcknowledgeStart
			? () => {
					if (startupAcknowledged) return;
					rawAcknowledgeStart();
					startupAcknowledged = true;
				}
			: undefined;
		const start: AsyncStart = { runtimeRunId };
		if (pid !== undefined) start.pid = pid;
		if (processStartIdentity !== undefined) start.processStartIdentity = processStartIdentity;
		if (asyncDir !== undefined) start.asyncDir = asyncDir;
		if (acknowledgeStart !== undefined) start.acknowledgeStart = acknowledgeStart;
		if (abortStart !== undefined) start.abortStart = abortStart;
		this.asyncStarts.set(runtimeRunId, start);
		const exact = this.active.get(runtimeRunId);
		const resumeCandidates = exact
			? []
			: [...this.active.values()].filter(
					(candidate) =>
						candidate.generation === this.generation && candidate.invocation.reservation.kind === "resume",
				);
		// A resume runtime id is assigned by the engine. Attach an ambiguous start
		// to every viable resume; only the invocation whose result names this id
		// will consume it during settlement.
		for (const candidate of resumeCandidates) candidate.starts.set(runtimeRunId, start);
		const owner = exact ?? (resumeCandidates.length === 1 ? resumeCandidates[0] : undefined);
		if (!owner) return;
		owner.starts.set(runtimeRunId, start);
		await this.bindReservationRuntime(owner.session, owner.invocation.reservation, runtimeRunId, start);
	}

	async settle(invocation: AgentExecutionInvocation, result: GovernedEngineResult): Promise<void> {
		const owner = this.invocationRecords.get(invocation);
		if (!owner || owner.settled) return;
		if (owner.pending) {
			await this.attemptPendingSettlement(owner.pending);
			return;
		}
		const runtimeRunId =
			optionalText(result.details.asyncId) ?? optionalText(result.details.runId) ?? invocation.launchRunId;
		const lifecycleBinding = result.details.lifecycleBinding;
		let resultStart: AsyncStart | undefined;
		if (lifecycleBinding) {
			resultStart = {
				runtimeRunId,
				pid: lifecycleBinding.pid,
				asyncDir: lifecycleBinding.asyncDir,
			};
			if (lifecycleBinding.processStartIdentity) {
				resultStart.processStartIdentity = lifecycleBinding.processStartIdentity;
			}
			if (lifecycleBinding.acknowledgeStart) resultStart.acknowledgeStart = lifecycleBinding.acknowledgeStart;
			if (lifecycleBinding.abortStart) resultStart.abortStart = lifecycleBinding.abortStart;
		}
		let settlement: AgentExecutionSettlement;
		let bindRuntime = true;
		const start = owner.starts.get(runtimeRunId) ?? this.asyncStarts.get(runtimeRunId) ?? resultStart;
		if (optionalText(result.details.asyncId)) {
			settlement = { kind: "background-started" };
		} else {
			const results = Array.isArray(result.details.results) ? result.details.results : [];
			if (results.length === 0) {
				const startupFailure = classifyStartupFailure(start);
				settlement = startupFailure.settlement;
				bindRuntime = startupFailure.bindRuntime;
			} else {
				const terminalChildIndexes = results
					.slice(0, invocation.reservation.leases.length)
					.flatMap((child, index) => (record(child).detached === true ? [] : [index]));
				settlement = { kind: "foreground", terminalChildIndexes };
				// Fully foreground work is already terminal when the engine returns.
				// Rebinding it creates a completion-before-settle race: the durable
				// completion event may have released the provisional lease first.
				// Only a mixed result with retained detached children needs a runtime
				// mapping before foreground children are released.
				bindRuntime = terminalChildIndexes.length < invocation.reservation.leases.length;
			}
		}
		const pending = this.createPendingSettlement({
			owner,
			session: owner.session,
			reservation: invocation.reservation,
			runtimeRunId,
			start,
			bindRuntime,
			settlement,
		});
		owner.pending = pending;
		try {
			await this.attemptPendingSettlement(pending);
		} catch (error) {
			this.scheduleSettlementRetry(pending);
			throw error;
		}
	}

	async fail(invocation: AgentExecutionInvocation): Promise<void> {
		const owner = this.invocationRecords.get(invocation);
		if (!owner || owner.settled) return;
		if (owner.pending) {
			await this.attemptPendingSettlement(owner.pending);
			return;
		}
		const starts = [...owner.starts.values()];
		const start = owner.starts.get(invocation.launchRunId) ?? (starts.length === 1 ? starts[0] : undefined);
		const startupFailure = classifyStartupFailure(start, starts.length > 0);
		const pendingInput: PendingSettlementInput = {
			owner,
			session: owner.session,
			reservation: invocation.reservation,
			runtimeRunId: start?.runtimeRunId ?? invocation.launchRunId,
			bindRuntime: startupFailure.bindRuntime,
			settlement: startupFailure.settlement,
		};
		if (start) pendingInput.start = start;
		const pending = this.createPendingSettlement(pendingInput);
		owner.pending = pending;
		try {
			await this.attemptPendingSettlement(pending);
		} catch (error) {
			this.scheduleSettlementRetry(pending);
			throw error;
		}
	}

	async complete<Event>(event: Event): Promise<void> {
		if (!this.boundIdentity) return;
		const session = this.session();
		const generation = this.generation;
		let firstError: unknown;
		for (const address of runtimeCompletionAddresses(event)) {
			const pending = this.pendingCompletion(address, session, generation);
			try {
				await this.attemptPendingCompletion(pending);
			} catch (error) {
				firstError ??= error;
				this.scheduleCompletionRetry(pending);
			}
		}
		if (firstError !== undefined) throw firstError;
	}

	async reconcileDead(): Promise<void> {
		if (!this.boundIdentity) return;
		await this.session().reconcile(this.runtimeProcessState);
	}

	async reconcileExisting(): Promise<void> {
		if (!this.boundIdentity) return;
		const session = this.session();
		if (session.hasLedger && !(await session.hasLedger())) return;
		await session.reconcile(this.runtimeProcessState);
	}

	async inspectExistingRuntimeLeases(): Promise<readonly AgentGovernorLease[]> {
		if (!this.boundIdentity) return [];
		return (await this.session().inspectExistingSnapshot?.())?.leases ?? [];
	}

	dispose(): void {
		this.generation += 1;
		this.clearEphemeralState();
		this.boundIdentity = undefined;
		this.boundSession = undefined;
	}

	private createPendingSettlement(input: PendingSettlementInput): PendingSettlement {
		const { start, ...settlement } = input;
		const pending: PendingSettlement =
			start === undefined ? { ...settlement, retryIndex: 0 } : { ...settlement, start, retryIndex: 0 };
		this.pendingSettlements.add(pending);
		return pending;
	}

	private attemptPendingSettlement(pending: PendingSettlement): Promise<void> {
		return this.effects.run(this.pendingSettlementEffect(pending));
	}

	private pendingSettlementEffect(pending: PendingSettlement): Effect.Effect<void, unknown> {
		const bind = pending.bindRuntime
			? promiseEffect(() =>
					this.bindReservationRuntime(pending.session, pending.reservation, pending.runtimeRunId, pending.start),
				).pipe(
					Effect.andThen(
						// Reconcile after binding when process completion raced the provisional Host lease.
						pending.settlement.kind === "background-started"
							? promiseEffect(() => pending.session.reconcile(this.runtimeProcessState))
							: Effect.void,
					),
					Effect.catch((error) => {
						if (!(error instanceof AgentRuntimeBindingRejectedError)) return Effect.fail(error);
						let safelyAborted = pending.start === undefined;
						try {
							safelyAborted = pending.start?.abortStart?.() === true;
						} catch {
							safelyAborted = false;
						}
						if (!safelyAborted) {
							// Ownership was rejected, but the runner may still be alive. Keep
							// the lease reserved so reconciliation retains authority to reap it.
							return Effect.fail(error);
						}
						return promiseEffect(() =>
							pending.session.governor.settle(pending.reservation, { kind: "start-error" }),
						).pipe(
							Effect.tap(() => Effect.sync(() => this.finishPendingSettlement(pending))),
							Effect.andThen(Effect.fail(error)),
						);
					}),
				)
			: Effect.void;
		return runDurableAgentOperation(
			pending,
			() => this.pendingSettlements.has(pending),
			() =>
				bind.pipe(
					Effect.andThen(
						promiseEffect(() => pending.session.governor.settle(pending.reservation, pending.settlement)),
					),
					Effect.tap(() => Effect.sync(() => this.finishPendingSettlement(pending))),
					Effect.asVoid,
				),
		);
	}

	private scheduleSettlementRetry(pending: PendingSettlement): void {
		scheduleDurableAgentOperation(
			this.effects,
			pending,
			() => this.pendingSettlements.has(pending),
			() => this.pendingSettlementEffect(pending),
		);
	}

	private finishPendingSettlement(pending: PendingSettlement): void {
		if (!this.pendingSettlements.delete(pending)) return;
		stopDurableAgentOperation(pending);
		const owner = pending.owner;
		if (owner) {
			owner.settled = true;
			if (owner.pending === pending) delete owner.pending;
			if (this.active.get(owner.invocation.launchRunId) === owner) {
				this.active.delete(owner.invocation.launchRunId);
			}
			owner.starts.delete(pending.runtimeRunId);
			if (owner.generation === this.generation) this.asyncStarts.delete(pending.runtimeRunId);
			for (const completion of this.pendingCompletions.values()) {
				if (completion.bindingCandidates.has(owner)) this.scheduleCompletionRetry(completion);
			}
		}
		if (!pending.bindRuntime) {
			for (const completion of Array.from(this.pendingCompletions.values())) {
				if (completion.session === pending.session && completion.address.runtimeRunId === pending.runtimeRunId) {
					this.finishPendingCompletion(completion);
				}
			}
		}
	}

	private async bindReservationRuntime(
		session: AgentExecutionCoordinatorSession,
		reservation: AgentExecutionReservation,
		runtimeRunId: string,
		start?: AsyncStart,
	): Promise<void> {
		for (let reservationIndex = 0; reservationIndex < reservation.leases.length; reservationIndex += 1) {
			const request = {
				runtimeRunId,
				childIndex: reservation.kind === "resume" ? 0 : reservationIndex,
			} satisfies RebindAgentRuntimeRequest;
			if (start?.pid !== undefined) Object.assign(request, { pid: start.pid });
			if (start?.processStartIdentity !== undefined) {
				Object.assign(request, { processStartIdentity: start.processStartIdentity });
			}
			if (start?.asyncDir !== undefined) Object.assign(request, { asyncDir: start.asyncDir });
			const rebound = await session.governor.rebindChild(reservation, reservationIndex, request);
			if (!rebound.rebound) {
				throw new AgentRuntimeBindingRejectedError(
					`Agent runtime binding was rejected for child ${reservationIndex} (${rebound.reason}).`,
				);
			}
		}
		// The detached runner remains behind its startup gate until every child
		// lease durably names the runner and recovery directory.
		start?.acknowledgeStart?.();
		await this.drainPendingCompletions(runtimeRunId, session);
	}

	private pendingCompletion(
		address: AgentRuntimeCompletionEvent,
		session: AgentExecutionCoordinatorSession,
		generation: number,
	): PendingCompletion {
		const key = completionKey(address, generation);
		const existing = this.pendingCompletions.get(key);
		if (existing?.session === session) return existing;
		if (existing) this.finishPendingCompletion(existing);
		const exact = this.active.get(address.runtimeRunId);
		const bindingCandidates = new Set<BoundInvocation>();
		if (exact?.session === session && exact.generation === generation) bindingCandidates.add(exact);
		for (const candidate of this.active.values()) {
			if (
				candidate.session === session &&
				candidate.generation === generation &&
				candidate.invocation.reservation.kind === "resume"
			) {
				bindingCandidates.add(candidate);
			}
		}
		const pending: PendingCompletion = { address, session, generation, bindingCandidates, retryIndex: 0 };
		this.pendingCompletions.set(key, pending);
		return pending;
	}

	private attemptPendingCompletion(pending: PendingCompletion): Promise<void> {
		return this.effects.run(this.pendingCompletionEffect(pending));
	}

	private pendingCompletionEffect(pending: PendingCompletion): Effect.Effect<void, unknown> {
		const key = completionKey(pending.address, pending.generation);
		return runDurableAgentOperation(
			pending,
			() => this.pendingCompletions.get(key) === pending,
			() =>
				promiseEffect(() => pending.session.governor.findRuntimeLease(pending.address)).pipe(
					Effect.flatMap((lease) => {
						if (lease && this.runtimeProcessState(lease.pid, lease) !== false) {
							// A semantic completion event is not process-terminal proof. Retain
							// the lease and retry until its writer group is absent or safely reaped.
							return Effect.sync(() => this.scheduleCompletionRetry(pending));
						}
						return promiseEffect(() => pending.session.governor.completeRuntime(pending.address)).pipe(
							Effect.tap((result) =>
								Effect.sync(() => {
									if (
										result.released === false &&
										result.reason === "not_found" &&
										this.completionMayNeedRuntimeBinding(pending)
									) {
										return;
									}
									this.finishPendingCompletion(pending);
								}),
							),
							Effect.asVoid,
						);
					}),
				),
		);
	}

	private completionMayNeedRuntimeBinding(pending: PendingCompletion): boolean {
		if (
			[...this.pendingSettlements].some(
				(settlement) =>
					settlement.session === pending.session &&
					settlement.bindRuntime &&
					settlement.runtimeRunId === pending.address.runtimeRunId,
			)
		) {
			return true;
		}
		return [...pending.bindingCandidates].some((candidate) => !candidate.settled);
	}

	private scheduleCompletionRetry(pending: PendingCompletion): void {
		const key = completionKey(pending.address, pending.generation);
		scheduleDurableAgentOperation(
			this.effects,
			pending,
			() => this.pendingCompletions.get(key) === pending,
			() => this.pendingCompletionEffect(pending),
		);
	}

	private finishPendingCompletion(pending: PendingCompletion): void {
		const key = completionKey(pending.address, pending.generation);
		if (this.pendingCompletions.get(key) !== pending) return;
		this.pendingCompletions.delete(key);
		stopDurableAgentOperation(pending);
	}

	private async drainPendingCompletions(
		runtimeRunId: string,
		session: AgentExecutionCoordinatorSession,
	): Promise<void> {
		const pending = [...this.pendingCompletions.values()].filter(
			(completion) => completion.session === session && completion.address.runtimeRunId === runtimeRunId,
		);
		for (const completion of pending) {
			try {
				await this.attemptPendingCompletion(completion);
			} catch {
				this.scheduleCompletionRetry(completion);
			}
		}
	}

	private session(): AgentExecutionCoordinatorSession {
		if (this.boundSession) return this.boundSession;
		if (!this.boundIdentity) throw new Error("Agent execution governor has no bound parent session.");
		this.boundSession = this.createSession(this.boundIdentity);
		return this.boundSession;
	}

	private sessionOrFailure(): AgentExecutionCoordinatorSession | string {
		if (!this.boundIdentity) {
			return "Cannot start an Agent because the parent Pi session has no stable session id.";
		}
		return this.session();
	}

	private clearEphemeralState(): void {
		this.active.clear();
		this.asyncStarts.clear();
		// Pending settlements and completions retain their original durable
		// session authority. A late engine result after session switch/dispose must
		// still finish that old ledger instead of leaking a running lease.
	}
}

function completionKey(address: AgentRuntimeCompletionEvent, generation: number): string {
	return `${generation}\u0000${address.runtimeRunId}\u0000${address.childIndex}`;
}

function promiseEffect<A>(run: () => Promise<A>): Effect.Effect<A, unknown> {
	return Effect.tryPromise({ try: run, catch: (error) => error });
}

interface StartupFailureClassification {
	readonly bindRuntime: boolean;
	readonly settlement: AgentExecutionSettlement;
}

function classifyStartupFailure(
	start: AsyncStart | undefined,
	hasAmbiguousObservedStart = false,
): StartupFailureClassification {
	if (!start && !hasAmbiguousObservedStart) {
		return { bindRuntime: false, settlement: { kind: "start-error" } };
	}
	if (start?.abortStart) {
		try {
			if (start.abortStart() === true) {
				return { bindRuntime: false, settlement: { kind: "start-error" } };
			}
		} catch {
			// An abort callback is only authority to release when it positively
			// proves that no started writer remains. Unknown failure stays retained.
		}
	}
	return {
		bindRuntime: start !== undefined,
		settlement: { kind: "background-started" },
	};
}
