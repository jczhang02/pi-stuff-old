import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { isJsonSourceValue } from "../shared/json-value.ts";
import type { CodemodeValue } from "./cloudflare/codec.ts";
import type { Snippet } from "./cloudflare/snippet.ts";
import { stableStringify } from "./cloudflare/stable-stringify.ts";
import {
	applyEvent,
	type CallPendingEvent,
	type CallSettledEvent,
	type CallStartedEvent,
	type CallState,
	type CodeModeCompensationTarget,
	type CodeModeExecutionHistoryItem,
	type CodeModeExecutionStatus,
	type CodeModePendingAction,
	createLedgerSnapshot,
	durableInputValue,
	durableValue,
	type ExecutionSettledEvent,
	type ExecutionState,
	eventFrom,
	executionHistory,
	type LedgerEvent,
	type LedgerSnapshot,
	optionalPresentationValue,
	type ReplayPolicy,
	trimTerminalExecutions,
} from "./ledger-state.ts";
import type { RuntimeToolCallPlan, RuntimeToolCallSettlement, RuntimeToolReplay } from "./protocol.ts";

export type {
	CodeModeCompensationTarget,
	CodeModeExecutionHistoryItem,
	CodeModeExecutionStatus,
	CodeModePendingAction,
};

export const CODE_MODE_LEDGER_ENTRY_TYPE = "pi-stuff-code-mode-ledger";
const MAX_CODE_MODE_SOURCE_BYTES = 1_000_000;
const PAUSED_TTL_MS = 24 * 60 * 60 * 1_000;

export type CodeModeStepDecision =
	| { readonly kind: "execute"; readonly plan: RuntimeToolCallPlan }
	| { readonly kind: "replay"; readonly result: CodemodeValue };

export interface CodeModeHistoryPage {
	readonly displayedCount: number;
	readonly items: readonly CodeModeExecutionHistoryItem[];
	readonly retainedCount: number;
	readonly totalCount: number;
	readonly truncated: boolean;
}

interface SessionScope {
	readonly context: ExtensionContext;
	readonly sessionId?: string;
}

interface LedgerSnapshotCache {
	readonly leafId: string | null;
	readonly sessionId: string | undefined;
	readonly sessionManager: ExtensionContext["sessionManager"];
	readonly state: LedgerSnapshot;
}

function sessionScope(context: ExtensionContext): SessionScope {
	const id = context.sessionManager.getSessionId();
	return id ? { context, sessionId: id } : { context };
}

function isLedgerEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
	return entry.type === "custom" && entry.customType === CODE_MODE_LEDGER_ENTRY_TYPE;
}

function loadSnapshot(context: ExtensionContext): LedgerSnapshot {
	const state = createLedgerSnapshot();
	for (const entry of context.sessionManager.getBranch?.() ?? context.sessionManager.getEntries()) {
		applyEntry(state, entry);
	}
	trimTerminalExecutions(state);
	return state;
}

function applyEntry(state: LedgerSnapshot, entry: SessionEntry): void {
	if (!isLedgerEntry(entry) || !isJsonSourceValue(entry.data)) return;
	const event = eventFrom(entry.data);
	if (event) applyEvent(state, event);
}

function appendedEntries(
	manager: ExtensionContext["sessionManager"],
	leafId: string | null,
	previousLeafId: string | null,
): SessionEntry[] | undefined {
	const entries: SessionEntry[] = [];
	let cursor = leafId;
	while (cursor !== previousLeafId) {
		if (cursor === null) return undefined;
		const entry = manager.getEntry?.(cursor);
		if (!entry) return undefined;
		entries.push(entry);
		cursor = entry.parentId;
	}
	return entries.reverse();
}

export class CodeModeIncompleteExecutionError extends Error {
	readonly executionId: string;

	constructor(executionId: string, message: string) {
		super(message);
		this.name = "CodeModeIncompleteExecutionError";
		this.executionId = executionId;
	}
}

export class CodeModeSessionLedger {
	private cache: LedgerSnapshotCache | undefined;
	private readonly pi: Pick<ExtensionAPI, "appendEntry">;

	constructor(pi: Pick<ExtensionAPI, "appendEntry">) {
		this.pi = pi;
	}

	begin(
		context: ExtensionContext,
		outerToolCallId: string,
		code: string,
		policies: ReadonlyMap<string, ReplayPolicy>,
		requiresApproval: ReadonlySet<string> = new Set(),
	): CodeModeExecutionController {
		const codeBytes = Buffer.byteLength(code);
		if (codeBytes > MAX_CODE_MODE_SOURCE_BYTES) {
			throw new Error(
				`Code Mode source is too large to record durably (${String(codeBytes)} bytes > ${String(MAX_CODE_MODE_SOURCE_BYTES)} byte limit). Move large data out of the program and keep the source small.`,
			);
		}
		const scope = sessionScope(context);
		const state = this.snapshot(scope);
		this.expireState(scope, state, Date.now(), PAUSED_TTL_MS);
		const executionId = `cm_${randomUUID()}`;
		this.append(scope, state, {
			at: Date.now(),
			code,
			cwd: context.cwd,
			executionId,
			kind: "execution-started",
			outerToolCallId,
			schemaVersion: 1,
		});
		const execution = state.executions.get(executionId);
		if (!execution) throw new Error("Code Mode execution ledger failed to initialize");
		return new CodeModeExecutionController(this, scope, state, execution, policies, requiresApproval);
	}

	pending(context: ExtensionContext, executionId?: string): readonly CodeModePendingAction[] {
		return [...this.snapshot(sessionScope(context)).executions.values()]
			.filter(
				(execution) => execution.status === "paused" && (!executionId || execution.executionId === executionId),
			)
			.sort((left, right) => right.updatedAt - left.updatedAt)
			.flatMap((execution) =>
				[...execution.calls.values()]
					.filter((call) => call.status === "pending")
					.sort((left, right) => left.sequence - right.sequence)
					.map((call) => ({
						args: call.args,
						connector: "tools" as const,
						executionId: execution.executionId,
						method: call.name,
						seq: call.sequence,
					})),
			);
	}

	resume(
		context: ExtensionContext,
		executionId: string,
		policies: ReadonlyMap<string, ReplayPolicy>,
		requiresApproval: ReadonlySet<string> = new Set(),
	): CodeModeExecutionController | undefined {
		const scope = sessionScope(context);
		const state = this.snapshot(scope);
		const execution = state.executions.get(executionId);
		const pending = execution ? [...execution.calls.values()].filter((call) => call.status === "pending") : [];
		if (execution?.status !== "paused" || pending.length === 0) return undefined;
		if (execution.cwd !== undefined && execution.cwd !== context.cwd) {
			throw new Error(
				`Code Mode execution started in ${JSON.stringify(execution.cwd)}; current working directory is ${JSON.stringify(context.cwd)}. Return to the original directory before approving it.`,
			);
		}
		const missing = pending.find((call) => !policies.has(call.name));
		if (missing) {
			throw new Error(
				`Code Mode pending Tool ${JSON.stringify(missing.name)} is no longer active. Restore it before approving the execution.`,
			);
		}
		this.append(scope, state, {
			at: Date.now(),
			attempt: execution.attempt + 1,
			executionId,
			kind: "execution-resumed",
			schemaVersion: 1,
		});
		return new CodeModeExecutionController(this, scope, state, execution, policies, requiresApproval);
	}

	reject(context: ExtensionContext, executionId: string, sequence: number): boolean {
		const scope = sessionScope(context);
		const state = this.snapshot(scope);
		const execution = state.executions.get(executionId);
		if (execution?.status !== "paused" || execution.calls.get(sequence)?.status !== "pending") return false;
		this.settleExecution(
			scope,
			state,
			execution,
			"rejected",
			`Rejected by the user before ${execution.calls.get(sequence)?.name ?? "pending Tool"}`,
		);
		return true;
	}

	historyPage(context: ExtensionContext, limit = 20): CodeModeHistoryPage {
		const state = this.snapshot(sessionScope(context));
		const retained = executionHistory(state);
		const items = retained.slice(0, Math.max(0, Math.floor(limit)));
		return {
			displayedCount: items.length,
			items,
			retainedCount: retained.length,
			totalCount: state.totalExecutions,
			truncated: items.length < state.totalExecutions,
		};
	}

	history(context: ExtensionContext, limit = 20): readonly CodeModeExecutionHistoryItem[] {
		return this.historyPage(context, limit).items;
	}

	snippets(context: ExtensionContext): readonly Snippet[] {
		return [...this.snapshot(sessionScope(context)).snippets.values()].sort((left, right) =>
			left.name.localeCompare(right.name),
		);
	}

	saveSnippet(context: ExtensionContext, executionId: string, name: string, description = ""): Snippet {
		const normalizedName = name.trim();
		if (!normalizedName || normalizedName.length > 120)
			throw new Error("Code Mode snippet name must be 1-120 characters");
		const scope = sessionScope(context);
		const state = this.snapshot(scope);
		const execution = state.executions.get(executionId);
		if (!execution) throw new Error(`No Code Mode execution ${JSON.stringify(executionId)} exists in this Session`);
		if (execution.status !== "success") throw new Error("Only a successful Code Mode execution can become a snippet");
		const snippet: Snippet = {
			code: execution.code,
			connectors: ["tools"],
			description,
			name: normalizedName,
			savedAt: Date.now(),
		};
		this.append(scope, state, { at: snippet.savedAt, kind: "snippet-saved", schemaVersion: 1, snippet });
		return snippet;
	}

	deleteSnippet(context: ExtensionContext, name: string): boolean {
		const scope = sessionScope(context);
		const state = this.snapshot(scope);
		if (!state.snippets.has(name)) return false;
		this.append(scope, state, { at: Date.now(), kind: "snippet-deleted", name, schemaVersion: 1 });
		return true;
	}

	expire(context: ExtensionContext, maxAgeMs = PAUSED_TTL_MS): readonly string[] {
		if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0)
			throw new Error("Code Mode expiry age must be a non-negative number");
		const scope = sessionScope(context);
		return this.expireState(scope, this.snapshot(scope), Date.now(), maxAgeMs);
	}

	abandon(context: ExtensionContext, executionId: string): boolean {
		const scope = sessionScope(context);
		const state = this.snapshot(scope);
		const execution = state.executions.get(executionId);
		if (!execution || (execution.status !== "running" && execution.status !== "incomplete")) return false;
		this.settleExecution(scope, state, execution, "abandoned", "Abandoned by explicit user decision");
		return true;
	}

	compensationTargets(context: ExtensionContext, executionId: string): readonly CodeModeCompensationTarget[] {
		const execution = this.snapshot(sessionScope(context)).executions.get(executionId);
		if (!execution) throw new Error(`No Code Mode execution ${JSON.stringify(executionId)} exists in this Session`);
		return [...execution.calls.values()]
			.filter((call) => call.status === "success" && call.valuePresent && !call.compensated)
			.sort((left, right) => right.sequence - left.sequence)
			.map((call) => ({
				callId: call.callId,
				input: call.args,
				name: call.name,
				sequence: call.sequence,
				value: call.value,
			}));
	}

	markCompensated(context: ExtensionContext, executionId: string, callId: string): void {
		const scope = sessionScope(context);
		const state = this.snapshot(scope);
		const execution = state.executions.get(executionId);
		const call = execution
			? [...execution.calls.values()].find((candidate) => candidate.callId === callId)
			: undefined;
		if (call?.status !== "success") {
			throw new Error(`No applied Code Mode call ${JSON.stringify(callId)} exists in execution ${executionId}`);
		}
		if (call.compensated) return;
		this.append(scope, state, { at: Date.now(), callId, executionId, kind: "call-compensated", schemaVersion: 1 });
	}

	markCompensationComplete(context: ExtensionContext, executionId: string): boolean {
		const scope = sessionScope(context);
		const state = this.snapshot(scope);
		const execution = state.executions.get(executionId);
		if (!execution) throw new Error(`No Code Mode execution ${JSON.stringify(executionId)} exists in this Session`);
		if (execution.status === "rolled_back") return true;
		const calls = [...execution.calls.values()];
		if (
			!calls.some((call) => call.compensated) ||
			calls.some((call) => call.status === "success" && call.valuePresent && !call.compensated)
		)
			return false;
		this.settleExecution(scope, state, execution, "rolled_back");
		return true;
	}

	append(scope: SessionScope, state: LedgerSnapshot, event: LedgerEvent): void {
		if (scope.sessionId && scope.context.sessionManager.getSessionId() !== scope.sessionId) {
			throw new Error("Code Mode Session changed before its execution ledger could be updated");
		}
		this.pi.appendEntry(CODE_MODE_LEDGER_ENTRY_TYPE, event);
		applyEvent(state, event);
		trimTerminalExecutions(state);
		this.rememberSnapshot(scope, state);
	}

	private settleExecution(
		scope: SessionScope,
		state: LedgerSnapshot,
		execution: ExecutionState,
		status: CodeModeExecutionStatus,
		error?: string,
	): void {
		const event: ExecutionSettledEvent = {
			at: Date.now(),
			attempt: execution.attempt,
			executionId: execution.executionId,
			kind: "execution-settled",
			schemaVersion: 1,
			status,
		};
		if (error) Object.assign(event, { error });
		this.append(scope, state, event);
	}

	private snapshot(scope: SessionScope): LedgerSnapshot {
		let leafId: string | null | undefined;
		try {
			leafId = scope.context.sessionManager.getLeafId?.();
		} catch {
			this.cache = undefined;
			return loadSnapshot(scope.context);
		}
		if (
			leafId !== undefined &&
			this.cache?.sessionManager === scope.context.sessionManager &&
			this.cache.sessionId === scope.sessionId
		) {
			if (this.cache.leafId === leafId) return this.cache.state;
			const entries = appendedEntries(scope.context.sessionManager, leafId, this.cache.leafId);
			if (entries) {
				const state = this.cache.state;
				for (const entry of entries) applyEntry(state, entry);
				trimTerminalExecutions(state);
				this.storeCache(scope, state, leafId);
				return state;
			}
		}
		this.cache = undefined;
		const state = loadSnapshot(scope.context);
		if (leafId !== undefined) this.storeCache(scope, state, leafId);
		return state;
	}

	private rememberSnapshot(scope: SessionScope, state: LedgerSnapshot): void {
		try {
			const leafId = scope.context.sessionManager.getLeafId?.();
			if (leafId === undefined) this.cache = undefined;
			else this.storeCache(scope, state, leafId);
		} catch {
			// The ledger append is already durable; a failed cache probe only disables the optimization.
			this.cache = undefined;
		}
	}

	private storeCache(scope: SessionScope, state: LedgerSnapshot, leafId: string | null): void {
		this.cache = { leafId, sessionId: scope.sessionId, sessionManager: scope.context.sessionManager, state };
	}

	private expireState(scope: SessionScope, state: LedgerSnapshot, now: number, maxAgeMs: number): string[] {
		const expired: string[] = [];
		const ageLimit = maxAgeMs === PAUSED_TTL_MS ? "24 hours" : "the configured age limit";
		for (const execution of state.executions.values()) {
			if (!["running", "incomplete", "paused"].includes(execution.status) || now - execution.updatedAt < maxAgeMs)
				continue;
			const paused = execution.status === "paused";
			this.settleExecution(
				scope,
				state,
				execution,
				paused ? "rejected" : "expired",
				`${paused ? "Code Mode approval" : "Code Mode execution"} expired after ${ageLimit}`,
			);
			expired.push(execution.executionId);
		}
		return expired;
	}
}

export class CodeModeExecutionController {
	private cursor = 0;
	private readonly execution: ExecutionState;
	private readonly ledger: CodeModeSessionLedger;
	private passAttempt = 0;
	private readonly policies: ReadonlyMap<string, ReplayPolicy>;
	private readonly requiresApproval: ReadonlySet<string>;
	private readonly scope: SessionScope;
	private readonly state: LedgerSnapshot;
	incompleteError?: CodeModeIncompleteExecutionError;

	constructor(
		ledger: CodeModeSessionLedger,
		scope: SessionScope,
		state: LedgerSnapshot,
		execution: ExecutionState,
		policies: ReadonlyMap<string, ReplayPolicy>,
		requiresApproval: ReadonlySet<string>,
	) {
		this.ledger = ledger;
		this.scope = scope;
		this.state = state;
		this.execution = execution;
		this.policies = policies;
		this.requiresApproval = requiresApproval;
	}

	get executionId(): string {
		return this.execution.executionId;
	}
	get attempt(): number {
		return this.execution.attempt;
	}
	get code(): string {
		return this.execution.code;
	}
	get outerToolCallId(): string {
		return this.execution.outerToolCallId;
	}
	get isPaused(): boolean {
		return this.execution.status === "paused";
	}

	beginPass(attempt: number): void {
		this.passAttempt = attempt;
		this.cursor = 0;
	}

	beginToolCall = (name: string, input: CodemodeValue): RuntimeToolCallPlan => this.planCall(name, input);

	beginStep(name: string): CodeModeStepDecision {
		const plan = this.planCall(`codemode.step:${name}`, undefined, "record");
		if (!plan.replay) return { kind: "execute", plan };
		if (plan.replay.kind === "error") throw new Error(plan.replay.message);
		return { kind: "replay", result: plan.replay.value };
	}

	completeStep(plan: RuntimeToolCallPlan, value: CodemodeValue): void {
		if (plan.executionId !== this.execution.executionId)
			throw new Error("Code Mode step belongs to another execution");
		const call = this.execution.calls.get(plan.sequence);
		if (!call?.name.startsWith("codemode.step:")) throw new Error("Code Mode step record has no matching decision");
		this.completeToolCall(plan, { status: "success", value });
	}

	private planCall(name: string, input: CodemodeValue, policy?: ReplayPolicy): RuntimeToolCallPlan {
		if (this.incompleteError) throw this.incompleteError;
		const sequence = this.cursor++;
		const plan: RuntimeToolCallPlan = {
			attempt: this.passAttempt,
			executionId: this.execution.executionId,
			id: `${this.execution.executionId}:${String(sequence)}`,
			sequence,
		};
		if (this.execution.status !== "running") {
			return {
				...plan,
				pause: { message: `Code Mode execution ${this.execution.executionId} is paused for user approval` },
			};
		}
		const replay = policy ?? this.policies.get(name) ?? "never";
		const args = durableInputValue(`Arguments to ${name}`, input);
		const serializedArgs = stableStringify(input);
		if (serializedArgs === undefined && input !== undefined) {
			throw new Error(`Code Mode Tool ${JSON.stringify(name)} received non-serializable input`);
		}
		const argsKey = serializedArgs ?? "undefined";
		const existing = this.execution.calls.get(sequence);
		const prior = existing ? this.replayExisting(plan, existing, name, args, argsKey, replay) : undefined;
		if (prior) return prior;
		if (this.requiresApproval.has(name)) {
			if (replay === "reexecute") {
				throw new Error(
					`Code Mode Tool ${JSON.stringify(name)} cannot combine requiresApproval with replay: reexecute`,
				);
			}
			this.appendCall(plan, name, args, argsKey, replay, "call-pending");
			return {
				...plan,
				pause: {
					message: `Code Mode execution ${this.execution.executionId} paused before ${name}; user approval is required`,
				},
			};
		}
		this.appendCall(plan, name, args, argsKey, replay, "call-started", false);
		return plan;
	}

	private replayExisting(
		plan: RuntimeToolCallPlan,
		existing: CallState,
		name: string,
		args: CallStartedEvent["args"],
		argsKey: string,
		replay: ReplayPolicy,
	): RuntimeToolCallPlan | undefined {
		if (existing.name !== name || existing.argsKey !== argsKey) {
			const message = `Code Mode replay divergence at step ${String(plan.sequence)}: expected ${existing.name} with the recorded arguments, received ${name}.`;
			this.finish("error", message);
			throw new Error(message);
		}
		if (existing.status === "error") {
			const replayResult: RuntimeToolReplay = { kind: "error", message: existing.error ?? `${name} failed` };
			if (existing.result) Object.assign(replayResult, { result: existing.result });
			return { ...plan, replay: replayResult };
		}
		if (existing.status === "pending") {
			this.appendCall(plan, name, args, argsKey, existing.replay, "call-started", true);
			return plan;
		}
		if (existing.status === "success" && replay !== "reexecute" && existing.valuePresent) {
			const replayResult: RuntimeToolReplay = { kind: "result", value: existing.value };
			if (existing.result) Object.assign(replayResult, { result: existing.result });
			return { ...plan, replay: replayResult };
		}
		if (replay === "reexecute") return undefined;
		const message = `Code Mode execution ${this.execution.executionId} stopped after Runtime loss at unsettled Tool ${JSON.stringify(name)} with replay policy ${JSON.stringify(replay)}. The external effect may have happened; inspect it and explicitly decide whether to repeat or abandon the work.`;
		this.incompleteError = new CodeModeIncompleteExecutionError(this.execution.executionId, message);
		this.finish("incomplete", message);
		throw this.incompleteError;
	}

	private appendCall(
		plan: RuntimeToolCallPlan,
		name: string,
		args: CallStartedEvent["args"],
		argsKey: string,
		replay: ReplayPolicy,
		kind: "call-pending" | "call-started",
		requiresApproval?: boolean,
	): void {
		const common: Omit<CallPendingEvent, "kind"> = {
			args,
			argsKey,
			at: Date.now(),
			attempt: plan.attempt,
			callId: plan.id,
			executionId: plan.executionId,
			name,
			replay,
			schemaVersion: 1,
			sequence: plan.sequence,
		};
		let event: CallPendingEvent | CallStartedEvent;
		if (kind === "call-pending") event = { ...common, kind };
		else {
			event = { ...common, kind };
			if (requiresApproval !== undefined) Object.assign(event, { requiresApproval });
		}
		this.ledger.append(this.scope, this.state, event);
	}

	completeToolCall = (plan: RuntimeToolCallPlan, settlement: RuntimeToolCallSettlement): void => {
		if (this.incompleteError) throw this.incompleteError;
		const call = this.execution.calls.get(plan.sequence);
		if (
			plan.executionId !== this.execution.executionId ||
			!call ||
			call.callId !== plan.id ||
			call.attempt !== plan.attempt ||
			call.status !== "running"
		)
			throw new Error("Code Mode Tool result has no matching running ledger call");
		if (settlement.status === "incomplete") {
			throw this.markIncomplete(settlement.message ?? "Tool completion could not be recorded");
		}
		try {
			const result = settlement.result ? optionalPresentationValue(call.name, settlement.result) : undefined;
			const value =
				settlement.status === "success" && !result
					? durableValue(`The result of ${call.name}`, settlement.value)
					: undefined;
			const event: CallSettledEvent = {
				at: Date.now(),
				callId: plan.id,
				executionId: this.execution.executionId,
				kind: "call-settled",
				schemaVersion: 1,
				status: settlement.status,
			};
			if (settlement.message) Object.assign(event, { error: settlement.message });
			if (result) Object.assign(event, { result });
			if (value) Object.assign(event, { value });
			this.ledger.append(this.scope, this.state, event);
		} catch (cause) {
			throw this.markIncomplete(cause);
		}
	};

	private markIncomplete(cause: unknown): CodeModeIncompleteExecutionError {
		this.incompleteError ??= new CodeModeIncompleteExecutionError(
			this.executionId,
			`Code Mode completion could not be recorded after a possible effect: ${cause instanceof Error ? cause.message : String(cause)}. Inspect the effect before explicitly repeating or abandoning the work.`,
		);
		return this.incompleteError;
	}

	finish(status: CodeModeExecutionStatus, error?: string): void {
		if (this.incompleteError) {
			status = "incomplete";
			error = this.incompleteError.message;
		}
		if (this.execution.status === status && this.execution.error === error) return;
		const event: ExecutionSettledEvent = {
			at: Date.now(),
			attempt: this.passAttempt,
			executionId: this.execution.executionId,
			kind: "execution-settled",
			schemaVersion: 1,
			status,
		};
		if (error) Object.assign(event, { error });
		this.ledger.append(this.scope, this.state, event);
	}
}
