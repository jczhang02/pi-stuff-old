import { createHash } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as path from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { parseJsonValue } from "../../../shared/json-value.ts";
import { isRuntimeFunction, isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import { reportAgentDiagnostic } from "../shared/diagnostics.ts";
import { type AsyncDurableClaim, tryAcquireKernelClaimAsync } from "../shared/durable-claim.ts";
import {
	type AgentGovernorLease,
	type AgentRecord,
	emptyAgentWorkUsage,
	type GovernorLedger,
	type LeaseRecord,
	resolveSessionGovernorLimits,
	runtimeAddressKey,
	type SessionGovernorFileSystem,
	type SessionGovernorLimitInput,
	type SessionGovernorLimits,
	type SessionGovernorSnapshot,
	SessionGovernorStateError,
	samePath,
	type TransactionResult,
	tightenSessionGovernorLimits,
} from "./session-governor-contracts.ts";

export * from "./session-governor-contracts.ts";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const LEDGER_VERSION = 1;
const record = <Properties extends Parameters<typeof Type.Object>[0]>(properties: Properties) =>
	Type.Object(properties, { additionalProperties: false });
const STABLE_TEXT_SCHEMA = Type.String({
	minLength: 1,
	maxLength: 256,
	pattern: "^(?!\\s)(?!.*\\s$)[^\\u0000-\\u001f\\u007f]+$",
});
const POSITIVE_INTEGER_SCHEMA = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const NON_NEGATIVE_INTEGER_SCHEMA = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const AGENT_PATH_SCHEMA = Type.Array(STABLE_TEXT_SCHEMA);
const LIMITS_SCHEMA = record({
	maxDepth: POSITIVE_INTEGER_SCHEMA,
	maxRunning: POSITIVE_INTEGER_SCHEMA,
	maxTotal: POSITIVE_INTEGER_SCHEMA,
});
const AGENT_WORK_USAGE_SCHEMA = record({
	turns: NON_NEGATIVE_INTEGER_SCHEMA,
	toolCalls: NON_NEGATIVE_INTEGER_SCHEMA,
	inputTokens: NON_NEGATIVE_INTEGER_SCHEMA,
	outputTokens: NON_NEGATIVE_INTEGER_SCHEMA,
	reportedCostUsd: Type.Optional(Type.Number({ minimum: 0 })),
	modelAttempts: NON_NEGATIVE_INTEGER_SCHEMA,
	resumes: NON_NEGATIVE_INTEGER_SCHEMA,
});
const AGENT_RECORD_SCHEMA = record({
	logicalAgentId: STABLE_TEXT_SCHEMA,
	ownerAgentPath: AGENT_PATH_SCHEMA,
	agentPath: AGENT_PATH_SCHEMA,
	limits: LIMITS_SCHEMA,
	createdAtMs: Type.Number(),
	workUsage: Type.Optional(AGENT_WORK_USAGE_SCHEMA),
});
const LEASE_RECORD_SCHEMA = record({
	logicalAgentId: STABLE_TEXT_SCHEMA,
	runtimeRunId: Type.Optional(STABLE_TEXT_SCHEMA),
	childIndex: Type.Optional(NON_NEGATIVE_INTEGER_SCHEMA),
	leaseId: STABLE_TEXT_SCHEMA,
	ownerAgentPath: AGENT_PATH_SCHEMA,
	agentPath: AGENT_PATH_SCHEMA,
	pid: POSITIVE_INTEGER_SCHEMA,
	processStartIdentity: Type.Optional(STABLE_TEXT_SCHEMA),
	systemBootIdentity: Type.Optional(STABLE_TEXT_SCHEMA),
	asyncDir: Type.Optional(STABLE_TEXT_SCHEMA),
	mode: Type.Union([Type.Literal("spawn"), Type.Literal("resume")]),
	acquiredAtMs: Type.Number(),
});
const GOVERNOR_LEDGER_SCHEMA = record({
	version: Type.Integer(),
	sessionId: Type.String(),
	limits: LIMITS_SCHEMA,
	total: NON_NEGATIVE_INTEGER_SCHEMA,
	agents: Type.Array(AGENT_RECORD_SCHEMA),
	leases: Type.Array(LEASE_RECORD_SCHEMA),
	updatedAtMs: Type.Number(),
});

interface ReadLedgerResult {
	readonly ledger: GovernorLedger;
	readonly migrated: boolean;
}

export interface SessionGovernorLedgerOptions {
	readonly rootDir: string;
	readonly sessionId: string;
	readonly ownerAgentPath: readonly string[];
	readonly configuredLimits: SessionGovernorLimitInput;
	readonly pid: number;
	readonly now: () => number;
	readonly token: () => string;
	readonly lockRetryMs: number;
	readonly lockTimeoutMs: number;
	readonly fs: SessionGovernorFileSystem | undefined;
}

/** Owns durable session state, locking, validation, and atomic commits. */
export class SessionGovernorLedger {
	private readonly rootDir: string;
	private readonly sessionDir: string;
	private readonly ledgerPath: string;
	private readonly sessionId: string;
	private readonly ownerAgentPath: readonly string[];
	private readonly configuredLimits: SessionGovernorLimitInput;
	private readonly pid: number;
	private readonly now: () => number;
	private readonly token: () => string;
	private readonly lockRetryMs: number;
	private readonly lockTimeoutMs: number;
	private readonly fs: SessionGovernorFileSystem;

	constructor(options: SessionGovernorLedgerOptions) {
		this.rootDir = path.resolve(options.rootDir);
		this.sessionId = options.sessionId;
		this.ownerAgentPath = options.ownerAgentPath;
		this.configuredLimits = options.configuredLimits;
		this.pid = options.pid;
		this.now = options.now;
		this.token = options.token;
		this.lockRetryMs = options.lockRetryMs;
		this.lockTimeoutMs = options.lockTimeoutMs;
		this.fs = options.fs ?? nodeFs;

		const sessionKey = createHash("sha256").update(this.sessionId).digest("hex");
		this.sessionDir = path.join(this.rootDir, sessionKey);
		this.ledgerPath = path.join(this.sessionDir, "ledger.json");
	}

	/** Read-only existence probe used to keep ordinary session startup at zero writes. */
	async hasLedger(): Promise<boolean> {
		try {
			const stat = await this.fs.lstat(this.ledgerPath);
			if (stat.isSymbolicLink() || !stat.isFile()) {
				throw new SessionGovernorStateError(`Session governor ledger '${this.ledgerPath}' is not a safe file.`);
			}
			return true;
		} catch (error) {
			if (errorCode(error) === "ENOENT") return false;
			throw error;
		}
	}

	/** Inspect a pre-upgrade ledger without taking the current lock or writing. */
	async inspectExistingSnapshot(): Promise<SessionGovernorSnapshot | undefined> {
		if (!(await inspectExistingPrivateDirectory(this.fs, this.rootDir))) return undefined;
		if (!(await inspectExistingPrivateDirectory(this.fs, this.sessionDir))) return undefined;
		let raw: string;
		try {
			const stat = await this.fs.lstat(this.ledgerPath);
			const currentUid = isRuntimeFunction(process.getuid) ? process.getuid() : undefined;
			if (stat.isSymbolicLink() || !stat.isFile()) {
				throw new SessionGovernorStateError(`Session governor ledger '${this.ledgerPath}' is not a safe file.`);
			}
			if (currentUid !== undefined && stat.uid !== currentUid) {
				throw new SessionGovernorStateError(
					`Session governor ledger '${this.ledgerPath}' is not owned by the current user.`,
				);
			}
			raw = await this.fs.readFile(this.ledgerPath, "utf8");
		} catch (error) {
			if (errorCode(error) === "ENOENT") return undefined;
			throw error;
		}
		const loaded = parseLedger(raw, this.sessionId);
		return snapshotLedger(loaded.ledger, this.resolveOwnerLimits(loaded.ledger), this.ownerAgentPath);
	}

	async snapshot(): Promise<SessionGovernorSnapshot> {
		return this.transact((ledger, effectiveLimits) => ({
			value: snapshotLedger(ledger, effectiveLimits, this.ownerAgentPath),
			changed: false,
		}));
	}

	async transact<Value>(
		operation: (ledger: GovernorLedger, effectiveLimits: SessionGovernorLimits) => TransactionResult<Value>,
	): Promise<Value> {
		await ensurePrivateDirectory(this.fs, this.rootDir);
		await ensurePrivateDirectory(this.fs, this.sessionDir);
		const lock = await this.acquireLock();
		try {
			const loaded = await this.readLedger();
			const existing = loaded?.ledger;
			if (!existing && this.ownerAgentPath.length > 0) {
				throw new SessionGovernorStateError(
					"A child Agent cannot initialize the root session governor ledger; open the root governor first.",
				);
			}
			const ledger = existing ?? this.createLedger();
			const effectiveLimits = this.resolveOwnerLimits(ledger);
			const result = operation(ledger, effectiveLimits);
			if (!existing || result.changed || loaded.migrated) {
				ledger.updatedAtMs = this.now();
				await this.writeLedger(ledger);
			}
			return result.value;
		} finally {
			try {
				await lock.release();
			} catch (error) {
				reportAgentDiagnostic(`Failed to release committed session governor lock '${lock.directory}':`, error);
			}
		}
	}

	private createLedger(): GovernorLedger {
		return {
			version: LEDGER_VERSION,
			sessionId: this.sessionId,
			limits: resolveSessionGovernorLimits(this.configuredLimits),
			total: 0,
			agents: [],
			leases: [],
			updatedAtMs: this.now(),
		};
	}

	private resolveOwnerLimits(ledger: GovernorLedger): SessionGovernorLimits {
		if (this.ownerAgentPath.length === 0) return tightenSessionGovernorLimits(ledger.limits, this.configuredLimits);
		const owner = ledger.agents.find((agent) => samePath(agent.agentPath, this.ownerAgentPath));
		if (!owner) {
			throw new SessionGovernorStateError(
				`Owner Agent path '${this.ownerAgentPath.join(" / ")}' is not registered in session '${this.sessionId}'.`,
			);
		}
		return tightenSessionGovernorLimits(owner.limits, this.configuredLimits);
	}

	private async readLedger(): Promise<ReadLedgerResult | undefined> {
		let raw: string;
		try {
			const stat = await this.fs.lstat(this.ledgerPath);
			if (stat.isSymbolicLink() || !stat.isFile()) {
				throw new SessionGovernorStateError(`Session governor ledger '${this.ledgerPath}' is not a safe file.`);
			}
			const currentUid = isRuntimeFunction(process.getuid) ? process.getuid() : undefined;
			if (currentUid !== undefined && stat.uid !== currentUid) {
				throw new SessionGovernorStateError(
					`Session governor ledger '${this.ledgerPath}' is not owned by the current user.`,
				);
			}
			raw = await this.fs.readFile(this.ledgerPath, "utf8");
		} catch (error) {
			if (errorCode(error) === "ENOENT") return undefined;
			throw error;
		}
		await this.fs.chmod(this.ledgerPath, PRIVATE_FILE_MODE);
		return parseLedger(raw, this.sessionId);
	}

	private async writeLedger(ledger: GovernorLedger): Promise<void> {
		const tempPath = path.join(this.sessionDir, `.ledger.${this.pid}.${this.token()}.tmp`);
		try {
			await this.fs.writeFile(tempPath, `${JSON.stringify(ledger, null, 2)}\n`, {
				encoding: "utf8",
				flag: "wx",
				mode: PRIVATE_FILE_MODE,
			});
			await this.fs.chmod(tempPath, PRIVATE_FILE_MODE);
			await this.fs.rename(tempPath, this.ledgerPath);
		} finally {
			try {
				await this.fs.rm(tempPath, { force: true });
			} catch (error) {
				reportAgentDiagnostic(`Failed to remove session governor temporary ledger '${tempPath}':`, error);
			}
		}
		try {
			await this.fs.chmod(this.ledgerPath, PRIVATE_FILE_MODE);
		} catch (error) {
			// The temp file already had 0600 before the atomic rename. This is a
			// post-commit hardening retry, not a reason to report the transaction failed.
			reportAgentDiagnostic(
				`Failed to reassert private mode on committed governor ledger '${this.ledgerPath}':`,
				error,
			);
		}
	}

	private async acquireLock(): Promise<AsyncDurableClaim> {
		const startedAt = Date.now();
		while (Date.now() - startedAt < this.lockTimeoutMs) {
			try {
				const claim = await tryAcquireKernelClaimAsync(this.sessionDir, "ledger");
				if (claim) return claim;
			} catch (error) {
				throw new SessionGovernorStateError(
					`Failed to acquire the session governor ledger lock '${path.join(this.sessionDir, "ledger.lock")}': ${String(error)}`,
				);
			}
			await sleep(this.lockRetryMs);
		}
		throw new SessionGovernorStateError(
			`Timed out acquiring the session governor ledger lock for session '${this.sessionId}'.`,
		);
	}
}

export function createLease(input: AgentGovernorLease): AgentGovernorLease {
	return Object.freeze({
		...input,
		ownerAgentPath: Object.freeze([...input.ownerAgentPath]),
		agentPath: Object.freeze([...input.agentPath]),
	});
}

export function toLeaseRecord(lease: AgentGovernorLease): LeaseRecord {
	let record: LeaseRecord = {
		logicalAgentId: lease.logicalAgentId,
		runtimeRunId: lease.runtimeRunId,
		childIndex: lease.childIndex,
		leaseId: lease.leaseId,
		ownerAgentPath: [...lease.ownerAgentPath],
		agentPath: [...lease.agentPath],
		pid: lease.pid,
		mode: lease.mode,
		acquiredAtMs: lease.acquiredAtMs,
	};
	if (lease.processStartIdentity) record = { ...record, processStartIdentity: lease.processStartIdentity };
	if (lease.systemBootIdentity) record = { ...record, systemBootIdentity: lease.systemBootIdentity };
	if (lease.asyncDir) record = { ...record, asyncDir: lease.asyncDir };
	return record;
}

export function toPublicLease(sessionId: string, lease: LeaseRecord): AgentGovernorLease {
	return createLease({ sessionId, ...lease });
}

export function snapshotLedger(
	ledger: GovernorLedger,
	effectiveLimits: SessionGovernorLimits,
	ownerAgentPath: readonly string[],
): SessionGovernorSnapshot {
	return {
		sessionId: ledger.sessionId,
		limits: { ...ledger.limits },
		effectiveLimits: { ...effectiveLimits },
		ownerAgentPath: [...ownerAgentPath],
		total: ledger.total,
		running: ledger.leases.length,
		agents: ledger.agents.map((agent) => ({
			...agent,
			ownerAgentPath: [...agent.ownerAgentPath],
			agentPath: [...agent.agentPath],
			limits: { ...agent.limits },
			workUsage: { ...agent.workUsage },
		})),
		leases: ledger.leases.map((lease) => toPublicLease(ledger.sessionId, lease)),
	};
}

function parseLedger(raw: string, expectedSessionId: string): ReadLedgerResult {
	let parsed: ReturnType<typeof parseJsonValue>;
	try {
		parsed = parseJsonValue(raw);
	} catch {
		throw new SessionGovernorStateError("Session governor ledger is not valid JSON; refusing to overwrite it.");
	}
	const value = Value.Clean(GOVERNOR_LEDGER_SCHEMA, parsed);
	if (!Value.Check(GOVERNOR_LEDGER_SCHEMA, value)) {
		throw new SessionGovernorStateError("Session governor ledger records are invalid.");
	}
	if (value.version !== LEDGER_VERSION || value.sessionId !== expectedSessionId) {
		throw new SessionGovernorStateError("Session governor ledger identity or version is invalid.");
	}
	const agents: AgentRecord[] = value.agents.map((agent) => ({
		...agent,
		workUsage: agent.workUsage ? { ...agent.workUsage } : emptyAgentWorkUsage(),
	}));
	for (const agent of agents) {
		if (!samePath(agent.agentPath, [...agent.ownerAgentPath, agent.logicalAgentId])) {
			throw new SessionGovernorStateError(`Logical Agent '${agent.logicalAgentId}' has an invalid owner path.`);
		}
	}
	const migrated =
		value.agents.some((agent) => agent.workUsage === undefined) ||
		value.leases.some((lease) => lease.runtimeRunId === undefined || lease.childIndex === undefined);
	const leases: LeaseRecord[] = value.leases.map((lease) => ({
		...lease,
		runtimeRunId: lease.runtimeRunId ?? lease.logicalAgentId,
		childIndex: lease.childIndex ?? 0,
	}));
	if (value.total !== agents.length) {
		throw new SessionGovernorStateError("Session governor ledger total does not match its durable Agent records.");
	}
	if (new Set(agents.map((agent) => agent.logicalAgentId)).size !== agents.length) {
		throw new SessionGovernorStateError("Session governor ledger contains duplicate logical Agent IDs.");
	}
	if (new Set(leases.map((lease) => lease.logicalAgentId)).size !== leases.length) {
		throw new SessionGovernorStateError("Session governor ledger contains duplicate running leases.");
	}
	if (new Set(leases.map(runtimeAddressKey)).size !== leases.length) {
		throw new SessionGovernorStateError("Session governor ledger contains duplicate runtime Agent addresses.");
	}
	for (const lease of leases) {
		const agent = agents.find((candidate) => candidate.logicalAgentId === lease.logicalAgentId);
		if (
			!agent ||
			!samePath(agent.ownerAgentPath, lease.ownerAgentPath) ||
			!samePath(agent.agentPath, lease.agentPath)
		) {
			throw new SessionGovernorStateError(
				"Session governor ledger contains a lease without a matching Agent record.",
			);
		}
	}

	return { ledger: { ...value, version: LEDGER_VERSION, agents, leases }, migrated };
}

function errorCode<Cause>(cause: Cause): string | undefined {
	return isRuntimeObject(cause) && cause !== null && "code" in cause && isRuntimeString(cause.code)
		? cause.code
		: undefined;
}

async function ensurePrivateDirectory(fs: SessionGovernorFileSystem, directory: string): Promise<void> {
	await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
	const stat = await fs.lstat(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new SessionGovernorStateError(`Session governor directory '${directory}' is not a safe real directory.`);
	}
	const currentUid = isRuntimeFunction(process.getuid) ? process.getuid() : undefined;
	if (currentUid !== undefined && stat.uid !== currentUid) {
		throw new SessionGovernorStateError(
			`Session governor directory '${directory}' is not owned by the current user.`,
		);
	}
	await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}

async function inspectExistingPrivateDirectory(fs: SessionGovernorFileSystem, directory: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(directory);
		const currentUid = isRuntimeFunction(process.getuid) ? process.getuid() : undefined;
		if (stat.isSymbolicLink() || !stat.isDirectory()) {
			throw new SessionGovernorStateError(`Session governor directory '${directory}' is not a safe real directory.`);
		}
		if (currentUid !== undefined && stat.uid !== currentUid) {
			throw new SessionGovernorStateError(
				`Session governor directory '${directory}' is not owned by the current user.`,
			);
		}
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

async function sleep(delayMs: number): Promise<void> {
	if (delayMs === 0) return;
	await new Promise((resolve) => setTimeout(resolve, delayMs));
}
