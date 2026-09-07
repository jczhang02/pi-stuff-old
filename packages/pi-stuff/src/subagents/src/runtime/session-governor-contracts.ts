import type * as nodeFs from "node:fs/promises";
import type { JsonValue } from "../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";

export interface SessionGovernorLimits {
	readonly maxDepth: number;
	readonly maxRunning: number;
	/** Retained for v1 ledger compatibility; cumulative launches are not admission-gated. */
	readonly maxTotal: number;
}

export interface SessionGovernorLimitInput {
	readonly maxDepth?: number;
	readonly maxRunning?: number;
}

export const DEFAULT_SESSION_GOVERNOR_LIMITS: SessionGovernorLimits = {
	maxDepth: 3,
	maxRunning: 20,
	maxTotal: Number.MAX_SAFE_INTEGER,
};

export interface AgentWorkCostPolicy {
	readonly reportedTokenLimit: number;
	readonly reportedCostUsdLimit: number;
}

/** Frozen from the six-reviewer ps-qer baseline: 756,682 tokens and $4.163430 at the high end. */
export const DEFAULT_AGENT_WORK_COST_POLICY: AgentWorkCostPolicy = Object.freeze({
	reportedTokenLimit: 1_000_000,
	reportedCostUsdLimit: 5,
});

export interface AgentWorkUsage {
	turns: number;
	toolCalls: number;
	inputTokens: number;
	outputTokens: number;
	reportedCostUsd?: number;
	modelAttempts: number;
	resumes: number;
}

export function emptyAgentWorkUsage(): AgentWorkUsage {
	return {
		turns: 0,
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		modelAttempts: 0,
		resumes: 0,
	};
}

export interface RecordAgentWorkAttemptRequest {
	readonly logicalAgentId: string;
	readonly turns: number;
	readonly toolCalls: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly reportedCostUsd?: number;
}

export type AgentWorkCostGuardCode = "reported_tokens" | "reported_cost_usd";

export interface AgentWorkUnitSnapshot {
	readonly logicalAgentId: string;
	readonly usage: Readonly<AgentWorkUsage>;
	readonly policy: AgentWorkCostPolicy;
	readonly expansionAllowed: boolean;
	readonly guardReason?: AgentWorkCostGuardCode;
}

export type AgentWorkExpansionResult =
	| { readonly allowed: true; readonly workUnit: AgentWorkUnitSnapshot }
	| {
			readonly allowed: false;
			readonly reason: AgentWorkCostGuardCode;
			readonly message: string;
			readonly workUnit: AgentWorkUnitSnapshot;
	  };

export interface SessionAgentGovernorOptions {
	readonly rootDir: string;
	readonly sessionId: string;
	readonly ownerAgentPath?: readonly string[];
	readonly limits?: SessionGovernorLimitInput | undefined;
	readonly pid?: number;
	readonly now?: () => number;
	readonly token?: () => string;
	readonly lockRetryMs?: number;
	readonly lockTimeoutMs?: number;
	readonly readProcessStartIdentity?: (pid: number) => string | undefined;
	readonly readSystemBootIdentity?: (() => string | undefined) | undefined;
	readonly fs?: SessionGovernorFileSystem;
}

export type SessionGovernorFileSystem = Pick<
	typeof nodeFs,
	"chmod" | "lstat" | "mkdir" | "readFile" | "rename" | "rm" | "stat" | "writeFile"
>;

export interface AcquireAgentRequest {
	readonly logicalAgentId: string;
	readonly runtimeRunId?: string;
	readonly childIndex?: number;
	readonly pid?: number;
	/** Direct user acknowledgement may admit a retained resume without clearing cumulative usage. */
	readonly acknowledgeCost?: boolean;
}

export interface AcquireSpawnRequest extends AcquireAgentRequest {
	readonly childLimits?: SessionGovernorLimitInput;
}

export type AgentGovernorLease = Readonly<Omit<LeaseRecord, "ownerAgentPath" | "agentPath">> & {
	readonly sessionId: string;
	readonly ownerAgentPath: readonly string[];
	readonly agentPath: readonly string[];
};
export type SessionGovernorAgentSnapshot = AgentRecord;

export type SessionGovernorHistoricalAgent = Omit<SessionGovernorAgentSnapshot, "workUsage"> & {
	readonly workUsage?: AgentWorkUsage;
};

export interface SessionGovernorSnapshot {
	readonly sessionId: string;
	readonly limits: SessionGovernorLimits;
	readonly effectiveLimits: SessionGovernorLimits;
	readonly ownerAgentPath: readonly string[];
	readonly total: number;
	readonly running: number;
	readonly agents: readonly SessionGovernorAgentSnapshot[];
	readonly leases: readonly AgentGovernorLease[];
}

export type SessionGovernorLimitCode = "depth_limit" | "running_limit";

export interface SessionGovernorLimitError {
	readonly kind: "limit";
	readonly code: SessionGovernorLimitCode;
	readonly limit: number;
	readonly used: number;
	readonly requested: number;
	readonly logicalAgentId: string;
	readonly message: string;
}

export type SessionGovernorConflictCode =
	| "logical_agent_exists"
	| "logical_agent_running"
	| "logical_agent_unknown"
	| "owner_mismatch"
	| "runtime_address_in_use";

export interface SessionGovernorConflictError {
	readonly kind: "conflict";
	readonly code: SessionGovernorConflictCode;
	readonly logicalAgentId: string;
	readonly message: string;
}

export interface SessionGovernorCostGuardError {
	readonly kind: "cost_guard";
	readonly code: AgentWorkCostGuardCode;
	readonly logicalAgentId: string;
	readonly limit: number;
	readonly used: number;
	readonly message: string;
}

export type SessionGovernorAcquireError =
	| SessionGovernorLimitError
	| SessionGovernorConflictError
	| SessionGovernorCostGuardError;

export type SessionGovernorAcquireResult =
	| {
			readonly ok: true;
			readonly lease: AgentGovernorLease;
			readonly snapshot: SessionGovernorSnapshot;
	  }
	| {
			readonly ok: false;
			readonly error: SessionGovernorAcquireError;
			readonly snapshot: SessionGovernorSnapshot;
	  };

export type SessionGovernorBatchAcquireResult =
	| {
			readonly ok: true;
			readonly leases: readonly AgentGovernorLease[];
			readonly snapshot: SessionGovernorSnapshot;
	  }
	| {
			readonly ok: false;
			readonly error: SessionGovernorAcquireError;
			readonly snapshot: SessionGovernorSnapshot;
	  };

export interface SessionGovernorReleaseResult {
	readonly released: boolean;
	readonly reason?: "already_released" | "ownership_changed";
	readonly snapshot: SessionGovernorSnapshot;
}

export type RebindAgentRuntimeRequest = Partial<
	Pick<LeaseRecord, "runtimeRunId" | "childIndex" | "pid" | "processStartIdentity" | "asyncDir">
>;

export type SessionGovernorRebindResult =
	| {
			readonly rebound: true;
			readonly lease: AgentGovernorLease;
			readonly snapshot: SessionGovernorSnapshot;
	  }
	| {
			readonly rebound: false;
			readonly reason: "already_released" | "ownership_changed" | "runtime_address_in_use";
			readonly snapshot: SessionGovernorSnapshot;
	  };

export type SessionGovernorBatchReleaseReason = "already_released" | "duplicate_logical_agent_id" | "ownership_changed";

export type SessionGovernorBatchReleaseResult =
	| {
			readonly released: true;
			readonly releasedCount: number;
			readonly snapshot: SessionGovernorSnapshot;
	  }
	| {
			readonly released: false;
			readonly releasedCount: 0;
			readonly logicalAgentId: string;
			readonly reason: SessionGovernorBatchReleaseReason;
			readonly snapshot: SessionGovernorSnapshot;
	  };

export interface SessionGovernorReconcileResult {
	readonly reclaimedLogicalAgentIds: readonly string[];
	readonly snapshot: SessionGovernorSnapshot;
}

export class SessionGovernorStateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionGovernorStateError";
	}
}

export interface AgentRecord {
	readonly logicalAgentId: string;
	readonly ownerAgentPath: readonly string[];
	readonly agentPath: readonly string[];
	readonly limits: SessionGovernorLimits;
	readonly createdAtMs: number;
	workUsage: AgentWorkUsage;
}

export interface LeaseRecord {
	logicalAgentId: string;
	runtimeRunId: string;
	childIndex: number;
	leaseId: string;
	ownerAgentPath: string[];
	agentPath: string[];
	pid: number;
	processStartIdentity?: string;
	systemBootIdentity?: string;
	asyncDir?: string;
	mode: "spawn" | "resume";
	acquiredAtMs: number;
}

export function runtimeAddressKey(value: Pick<LeaseRecord, "runtimeRunId" | "childIndex">): string {
	return `${value.runtimeRunId}\0${value.childIndex}`;
}

export interface GovernorLedger {
	version: 1;
	sessionId: string;
	limits: SessionGovernorLimits;
	total: number;
	agents: AgentRecord[];
	leases: LeaseRecord[];
	updatedAtMs: number;
}

export interface TransactionResult<Value> {
	readonly value: Value;
	readonly changed: boolean;
}

export type ValidatedSpawnRequest = Readonly<
	Pick<LeaseRecord, "logicalAgentId" | "runtimeRunId" | "childIndex" | "pid" | "processStartIdentity">
> & {
	readonly childLimits: SessionGovernorLimitInput;
};

export interface ValidatedBatchLease {
	readonly logicalAgentId: string;
	readonly leaseId: string;
	readonly rollback?: {
		readonly acquiredAtMs: number;
		readonly ownerAgentPath: readonly string[];
		readonly agentPath: readonly string[];
	};
}

export function resolveSessionGovernorLimits(input: SessionGovernorLimitInput = {}): SessionGovernorLimits {
	return {
		maxDepth: positiveInteger("maxDepth", input.maxDepth ?? DEFAULT_SESSION_GOVERNOR_LIMITS.maxDepth),
		maxRunning: positiveInteger("maxRunning", input.maxRunning ?? DEFAULT_SESSION_GOVERNOR_LIMITS.maxRunning),
		maxTotal: DEFAULT_SESSION_GOVERNOR_LIMITS.maxTotal,
	};
}

export function tightenSessionGovernorLimits(
	parent: SessionGovernorLimits,
	child: SessionGovernorLimitInput = {},
): SessionGovernorLimits {
	const validatedParent = readCompleteLimits(parent);
	const requested = validateLimitInput(child);
	return {
		maxDepth: Math.min(validatedParent.maxDepth, requested.maxDepth ?? validatedParent.maxDepth),
		maxRunning: Math.min(validatedParent.maxRunning, requested.maxRunning ?? validatedParent.maxRunning),
		maxTotal: validatedParent.maxTotal,
	};
}

export function readCompleteLimits(value: SessionGovernorLimits | JsonValue | undefined): SessionGovernorLimits {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) {
		throw new TypeError("Session governor limits must be an object.");
	}
	return {
		maxDepth: positiveInteger("maxDepth", value["maxDepth"]),
		maxRunning: positiveInteger("maxRunning", value["maxRunning"]),
		maxTotal: positiveInteger("maxTotal", value["maxTotal"]),
	};
}

export function validateLimitInput(value: SessionGovernorLimitInput): SessionGovernorLimitInput {
	let limits: SessionGovernorLimitInput = {};
	if (value.maxDepth !== undefined) limits = { ...limits, maxDepth: positiveInteger("maxDepth", value.maxDepth) };
	if (value.maxRunning !== undefined) {
		limits = { ...limits, maxRunning: positiveInteger("maxRunning", value.maxRunning) };
	}
	return limits;
}

export function stableText<Value>(name: string, value: Value): string {
	if (
		!isRuntimeString(value) ||
		value.length === 0 ||
		value.length > 256 ||
		value.trim() !== value ||
		containsControlCharacter(value)
	) {
		throw new TypeError(`${name} must be a non-empty stable identifier of at most 256 characters.`);
	}
	return value;
}

function containsControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0);
		if (code !== undefined && (code <= 31 || code === 127)) return true;
	}
	return false;
}

export function positiveInteger<Value>(name: string, value: Value): number {
	if (!isRuntimeNumber(value) || !Number.isSafeInteger(value) || value <= 0) {
		throw new TypeError(`${name} must be a positive safe integer; unlimited and zero are not supported.`);
	}
	return value;
}

export function nonNegativeInteger<Value>(name: string, value: Value): number {
	if (!isRuntimeNumber(value) || !Number.isSafeInteger(value) || value < 0) {
		throw new TypeError(`${name} must be a non-negative safe integer.`);
	}
	return value;
}

export function finiteNumber<Value>(name: string, value: Value): number {
	if (!isRuntimeNumber(value) || !Number.isFinite(value)) throw new SessionGovernorStateError(`${name} is invalid.`);
	return value;
}

export function nonNegativeFiniteNumber<Value>(name: string, value: Value): number {
	const number = finiteNumber(name, value);
	if (number < 0) throw new TypeError(`${name} must be a non-negative finite number.`);
	return number;
}

export function samePath(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

export function safeSystemBootIdentity(readIdentity: () => string | undefined): string | undefined {
	try {
		const identity = readIdentity();
		return identity === undefined ? undefined : stableText("systemBootIdentity", identity);
	} catch {
		return undefined;
	}
}

export function checkedUsageTotal(name: string, current: number, delta: number): number {
	return nonNegativeInteger(`cumulative ${name}`, current + delta);
}

function workGuardReason(agent: AgentRecord): AgentWorkCostGuardCode | undefined {
	const usage = agent.workUsage;
	if (usage.inputTokens + usage.outputTokens >= DEFAULT_AGENT_WORK_COST_POLICY.reportedTokenLimit) {
		return "reported_tokens";
	}
	if (
		usage.reportedCostUsd !== undefined &&
		usage.reportedCostUsd >= DEFAULT_AGENT_WORK_COST_POLICY.reportedCostUsdLimit
	) {
		return "reported_cost_usd";
	}
	return undefined;
}

export function snapshotWorkUnit(agent: AgentRecord): AgentWorkUnitSnapshot {
	const guardReason = workGuardReason(agent);
	const snapshot: AgentWorkUnitSnapshot = {
		logicalAgentId: agent.logicalAgentId,
		usage: { ...agent.workUsage },
		policy: { ...DEFAULT_AGENT_WORK_COST_POLICY },
		expansionAllowed: guardReason === undefined,
	};
	return guardReason === undefined ? snapshot : { ...snapshot, guardReason };
}

export function expansionResult(workUnit: AgentWorkUnitSnapshot): AgentWorkExpansionResult {
	const reason = workUnit.guardReason;
	if (!reason) return { allowed: true, workUnit };
	const usage = workUnit.usage;
	const message =
		reason === "reported_tokens"
			? `Automatic Agent expansion needs attention: reported tokens ${String(
					usage.inputTokens + usage.outputTokens,
				)} reached the ${String(workUnit.policy.reportedTokenLimit)}-token limit.`
			: `Automatic Agent expansion needs attention: reported cost $${(usage.reportedCostUsd ?? 0).toFixed(
					6,
				)} reached the $${workUnit.policy.reportedCostUsdLimit.toFixed(2)} limit.`;
	return { allowed: false, reason, message, workUnit };
}

export function costGuardError(
	workUnit: AgentWorkUnitSnapshot,
	reason: AgentWorkCostGuardCode,
): SessionGovernorCostGuardError {
	const tokens = workUnit.usage.inputTokens + workUnit.usage.outputTokens;
	const expansion = expansionResult(workUnit);
	if (expansion.allowed)
		throw new SessionGovernorStateError("A permitted work unit cannot produce a cost guard error.");
	return {
		kind: "cost_guard",
		code: reason,
		logicalAgentId: workUnit.logicalAgentId,
		limit: reason === "reported_tokens" ? workUnit.policy.reportedTokenLimit : workUnit.policy.reportedCostUsdLimit,
		used: reason === "reported_tokens" ? tokens : (workUnit.usage.reportedCostUsd ?? 0),
		message: `${expansion.message} Resume it after direct user acknowledgement to continue with the same cumulative totals.`,
	};
}
