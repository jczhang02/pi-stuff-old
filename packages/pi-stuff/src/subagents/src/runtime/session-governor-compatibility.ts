import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { type JsonValue, parseJsonValue } from "../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import { tryAcquireKernelClaimAsync } from "../shared/durable-claim.ts";
import { assertPrivateDirectory, readBoundedOwnedFileSnapshotAsync } from "../shared/private-directory.ts";
import { readProcessStartIdentityAsync } from "../shared/process-identity.ts";
import type { SessionGovernorCompatibilityScope } from "../shared/session-identity.ts";
import { LEGACY_SESSION_GOVERNOR_ROOT, SESSION_GOVERNOR_ROOT, TEMP_ROOT_DIR } from "../shared/types.ts";
import { type readStatus, readStatusAsync } from "../shared/utils.ts";
import {
	SessionAgentGovernor,
	type SessionGovernorAgentSnapshot,
	type SessionGovernorHistoricalAgent,
	type SessionGovernorLimitInput,
	type SessionGovernorSnapshot,
} from "./session-governor.ts";

const TERMINAL_STEP_STATES = new Set(["complete", "completed", "failed", "paused", "stopped"]);
const CONSERVATIVE_IMPORTED_LIMITS = Object.freeze({ maxDepth: 1, maxRunning: 1, maxTotal: 1 });

export type SessionGovernorCompatibilityResult =
	| {
			readonly ok: true;
			readonly importedLogicalAgentIds: readonly string[];
			readonly legacyLedgerObserved: boolean;
	  }
	| {
			readonly ok: false;
			readonly message: string;
	  };

export interface PrepareSessionGovernorCompatibilityInput {
	readonly scope: SessionGovernorCompatibilityScope;
	readonly limits: SessionGovernorLimitInput;
	readonly currentRootDir?: string;
	readonly legacyRootDir?: string;
	readonly now?: () => number;
	readonly isPidAlive?: (pid: number) => Promise<boolean | undefined> | boolean | undefined;
	readonly inspectWriterLiveness: (asyncDir: string) => Promise<boolean | undefined> | boolean | undefined;
	readonly readStatus?: (asyncDir: string) => Promise<ReturnType<typeof readStatus>> | ReturnType<typeof readStatus>;
	/** Deterministic seams for pre-v2 lock detection tests. */
	readonly legacyLockOptions?: {
		readonly timeoutMs?: number;
		readonly retryMs?: number;
	};
}

/**
 * Migrate only historical records into the v2 ledger. The v1 ledger is never
 * written or locked by this release. A pre-v2 process already holding its
 * directory lock blocks migration; simultaneous old/new writers are not a
 * supported cross-version protocol.
 */
export async function prepareSessionGovernorCompatibility(
	input: PrepareSessionGovernorCompatibilityInput,
): Promise<SessionGovernorCompatibilityResult> {
	const legacyRootDir = input.legacyRootDir ?? LEGACY_SESSION_GOVERNOR_ROOT;
	const current = new SessionAgentGovernor({
		rootDir: input.currentRootDir ?? SESSION_GOVERNOR_ROOT,
		sessionId: input.scope.governorSessionId,
		limits: input.limits,
	});
	const legacySessionId = input.scope.legacyGovernorSessionId;
	const legacy = legacySessionId
		? new SessionAgentGovernor({
				rootDir: legacyRootDir,
				sessionId: legacySessionId,
				limits: input.limits,
			})
		: undefined;

	let legacySnapshot: SessionGovernorSnapshot | undefined;
	try {
		if (legacy && legacySessionId) {
			if (await legacyGovernorLocked(legacyRootDir, legacySessionId, input.legacyLockOptions)) {
				return {
					ok: false,
					message:
						"Agent launches are paused by a pre-upgrade governor lock that may still be live or may be stale after a crash. " +
						`Close every older Pi process using this session; if the lock remains, remove only '${legacyGovernorLockPath(legacyRootDir, legacySessionId)}', then retry.`,
				};
			}
			legacySnapshot = await legacy.inspectExistingSnapshot();
			if (await legacyGovernorLocked(legacyRootDir, legacySessionId, input.legacyLockOptions)) {
				return {
					ok: false,
					message: "Agent launches are paused because a pre-upgrade governor changed during migration.",
				};
			}
		}
	} catch (error) {
		return {
			ok: false,
			message: `Agent launches are paused because the pre-upgrade governor ledger cannot be safely inspected: ${messageOf(error)}`,
		};
	}

	const historical = branchHistoricalAgents(input.scope, input.now?.() ?? Date.now());
	if (legacySnapshot) {
		const classification = await classifyLegacyLeases(legacySnapshot, input);
		if (classification.kind === "quarantine") {
			return {
				ok: false,
				message:
					"Agent launches are temporarily paused while pre-upgrade Agents are still running or cannot be safely proven stopped. " +
					"Status, steer, and stop remain available; retry after those Agents finish.",
			};
		}
		if (classification.kind === "current-dead") {
			const connected = connectedLegacyAgents(legacySnapshot.agents, input.scope.declaredLogicalAgentIds);
			if (!legacySnapshot.leases.every((lease) => connected.has(lease.logicalAgentId))) {
				return {
					ok: false,
					message:
						"Agent launches are paused because the pre-upgrade governor ledger contains an unproven ownership path.",
				};
			}
			for (const agent of legacySnapshot.agents) {
				if (connected.has(agent.logicalAgentId)) historical.set(agent.logicalAgentId, historicalAgent(agent));
			}
		} else if (classification.kind === "no-leases") {
			// With no physical runtime path, only top-level records explicitly
			// declared by this Pi session are safe to carry across copied files.
			for (const agent of legacySnapshot.agents) {
				if (agent.ownerAgentPath.length === 0 && input.scope.declaredLogicalAgentIds.has(agent.logicalAgentId)) {
					historical.set(
						agent.logicalAgentId,
						conservativeHistoricalAgent(agent.logicalAgentId, agent.createdAtMs),
					);
				}
			}
		}
		// `foreign` means a copied same-header session saw another physical
		// session's live v1 ledger. Import only paired branch history in that case.
	}

	try {
		const before = await current.inspectExistingSnapshot();
		const imported = [...historical.values()];
		const after = imported.length > 0 ? await current.importHistoricalAgents(imported) : before;
		const previous = new Set(before?.agents.map(({ logicalAgentId }) => logicalAgentId) ?? []);
		const result: Extract<SessionGovernorCompatibilityResult, { ok: true }> = {
			ok: true,
			importedLogicalAgentIds: Object.freeze(
				(after?.agents ?? []).map(({ logicalAgentId }) => logicalAgentId).filter((id) => !previous.has(id)),
			),
			legacyLedgerObserved: legacySnapshot !== undefined,
		};
		return result;
	} catch (error) {
		return {
			ok: false,
			message: `Agent launches are paused because governor history could not be migrated safely: ${messageOf(error)}`,
		};
	}
}

function legacyGovernorLockPath(rootDir: string, sessionId: string): string {
	return path.join(rootDir, createHash("sha256").update(sessionId).digest("hex"), "ledger.lock");
}

async function legacyGovernorLocked(
	rootDir: string,
	sessionId: string,
	options: NonNullable<PrepareSessionGovernorCompatibilityInput["legacyLockOptions"]> = {},
): Promise<boolean> {
	const lockDir = legacyGovernorLockPath(rootDir, sessionId);
	const deadline = Date.now() + (options.timeoutMs ?? 1_000);
	let recoveryAttempted = false;
	while (Date.now() <= deadline) {
		try {
			await fs.promises.lstat(lockDir);
			if (!recoveryAttempted) {
				recoveryAttempted = true;
				if (await reclaimStaleCurrentBarrier(lockDir)) continue;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, options.retryMs ?? 10));
		} catch (error) {
			if (messageCode(error) === "ENOENT") return false;
			throw error;
		}
	}
	return true;
}

interface CurrentBarrierOwner {
	readonly token: string;
	readonly pid: number;
	readonly processStartIdentity: string;
	readonly acquiredAtMs: number;
}

async function reclaimStaleCurrentBarrier(lockDir: string): Promise<boolean> {
	try {
		assertPrivateDirectory(lockDir, await fs.promises.lstat(lockDir));
	} catch (error) {
		if (messageCode(error) === "ENOENT") return true;
		throw error;
	}
	const claim = await tryAcquireKernelClaimAsync(path.dirname(lockDir), "ledger-v1-recovery");
	if (!claim) return false;
	try {
		const owner = await readCurrentBarrierOwner(path.join(lockDir, "owner.json"));
		if (!owner) return false;
		const currentIdentity = await readProcessStartIdentityAsync(owner.pid);
		if (
			currentIdentity === owner.processStartIdentity ||
			(currentIdentity === undefined && explicitPidState(owner.pid) !== false)
		) {
			return false;
		}
		const staleDir = `${lockDir}.stale-${claim.token}`;
		try {
			await fs.promises.rename(lockDir, staleDir);
		} catch (error) {
			if (messageCode(error) === "ENOENT") return true;
			throw error;
		}
		const movedOwner = await readCurrentBarrierOwner(path.join(staleDir, "owner.json"));
		if (!movedOwner || movedOwner.token !== owner.token) {
			await fs.promises.rename(staleDir, lockDir).catch(() => undefined);
			throw new Error("Pre-upgrade governor ownership changed during stale-lock recovery.");
		}
		await fs.promises.rm(staleDir, { recursive: true, force: true });
		return true;
	} finally {
		await claim.release();
	}
}

async function readCurrentBarrierOwner(ownerPath: string): Promise<CurrentBarrierOwner | undefined> {
	let value: JsonValue;
	try {
		value = parseJsonValue((await readBoundedOwnedFileSnapshotAsync(ownerPath, 4_096)).text);
	} catch {
		return undefined;
	}
	if (
		!isRuntimeObject(value) ||
		value === null ||
		!("token" in value) ||
		!isRuntimeString(value["token"]) ||
		!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value["token"]) ||
		!("pid" in value) ||
		!isRuntimeNumber(value["pid"]) ||
		!Number.isSafeInteger(value["pid"]) ||
		value["pid"] <= 0 ||
		!("processStartIdentity" in value) ||
		!isRuntimeString(value["processStartIdentity"]) ||
		value["processStartIdentity"].length === 0 ||
		value["processStartIdentity"].length > 512 ||
		!("acquiredAtMs" in value) ||
		!isRuntimeNumber(value["acquiredAtMs"]) ||
		!Number.isSafeInteger(value["acquiredAtMs"]) ||
		value["acquiredAtMs"] <= 0
	) {
		return undefined;
	}
	return {
		token: value["token"],
		pid: value["pid"],
		processStartIdentity: value["processStartIdentity"],
		acquiredAtMs: value["acquiredAtMs"],
	};
}

type LegacyClassification =
	| { readonly kind: "no-leases" }
	| { readonly kind: "foreign" }
	| { readonly kind: "current-dead" }
	| { readonly kind: "quarantine" };

async function classifyLegacyLeases(
	snapshot: SessionGovernorSnapshot,
	input: PrepareSessionGovernorCompatibilityInput,
): Promise<LegacyClassification> {
	if (snapshot.leases.length === 0) return { kind: "no-leases" };
	const inspectStatus = input.readStatus ?? readStatusAsync;
	const inspectWriter = input.inspectWriterLiveness;
	const isPidAlive = input.isPidAlive ?? explicitPidState;
	let foreign = 0;
	let currentDead = 0;
	for (const lease of snapshot.leases) {
		if (!lease.asyncDir || !safeLegacyRuntimeDirectory(lease.asyncDir)) return { kind: "quarantine" };
		let status: ReturnType<typeof readStatus>;
		try {
			status = await inspectStatus(lease.asyncDir);
		} catch {
			return { kind: "quarantine" };
		}
		if (!status || status.runId !== lease.runtimeRunId) return { kind: "quarantine" };
		const physicalMatch =
			status.sessionId === input.scope.sessionId ||
			(Boolean(input.scope.legacyArtifactSessionId) && status.sessionId === input.scope.legacyArtifactSessionId);
		if (!physicalMatch) {
			foreign += 1;
			continue;
		}
		const step = status.steps?.[lease.childIndex];
		if (!step || !TERMINAL_STEP_STATES.has(step.status)) return { kind: "quarantine" };
		if ((await isPidAlive(lease.pid)) !== false || (await inspectWriter(lease.asyncDir)) !== false) {
			return { kind: "quarantine" };
		}
		currentDead += 1;
	}
	if (foreign === snapshot.leases.length) return { kind: "foreign" };
	if (foreign > 0 || currentDead !== snapshot.leases.length) return { kind: "quarantine" };
	return { kind: "current-dead" };
}

function connectedLegacyAgents(
	agents: readonly SessionGovernorAgentSnapshot[],
	declaredTopLevel: ReadonlySet<string>,
): ReadonlySet<string> {
	const byPath = new Map(agents.map((agent) => [pathKey(agent.agentPath), agent]));
	const connected = new Set<string>();
	for (const agent of [...agents].sort((left, right) => left.agentPath.length - right.agentPath.length)) {
		if (agent.ownerAgentPath.length === 0) {
			if (declaredTopLevel.has(agent.logicalAgentId)) connected.add(agent.logicalAgentId);
			continue;
		}
		const owner = byPath.get(pathKey(agent.ownerAgentPath));
		if (owner && connected.has(owner.logicalAgentId)) connected.add(agent.logicalAgentId);
	}
	return connected;
}

function branchHistoricalAgents(
	scope: SessionGovernorCompatibilityScope,
	now: number,
): Map<string, SessionGovernorHistoricalAgent> {
	return new Map(
		[...scope.startedLogicalAgentIds].map((logicalAgentId) => [
			logicalAgentId,
			conservativeHistoricalAgent(logicalAgentId, scope.startedAtMs ?? now),
		]),
	);
}

function conservativeHistoricalAgent(logicalAgentId: string, createdAtMs: number): SessionGovernorHistoricalAgent {
	return {
		logicalAgentId,
		ownerAgentPath: [],
		agentPath: [logicalAgentId],
		limits: CONSERVATIVE_IMPORTED_LIMITS,
		createdAtMs,
	};
}

function historicalAgent(agent: SessionGovernorAgentSnapshot): SessionGovernorHistoricalAgent {
	return {
		logicalAgentId: agent.logicalAgentId,
		ownerAgentPath: [...agent.ownerAgentPath],
		agentPath: [...agent.agentPath],
		limits: { ...agent.limits },
		createdAtMs: agent.createdAtMs,
	};
}

function safeLegacyRuntimeDirectory(directory: string): boolean {
	if (!path.isAbsolute(directory)) return false;
	const resolved = path.resolve(directory);
	for (const rootName of ["async-subagent-runs", "foreground-runs", "nested-subagent-runs"] as const) {
		const root = path.join(TEMP_ROOT_DIR, rootName);
		const relative = path.relative(root, resolved);
		if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
			return true;
		}
	}
	return false;
}

function pathKey(parts: readonly string[]): string {
	return JSON.stringify(parts);
}

function explicitPidState(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return messageCode(error) === "ESRCH" ? false : undefined;
	}
}

function messageCode(cause: unknown): string | undefined {
	return cause && isRuntimeObject(cause) && "code" in cause ? String(cause.code) : undefined;
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}
