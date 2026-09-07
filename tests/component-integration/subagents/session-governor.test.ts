import { afterEach, expect, test } from "bun:test";
import * as nodeFs from "node:fs/promises";
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import {
	type AgentGovernorLease,
	DEFAULT_SESSION_GOVERNOR_LIMITS,
	SessionAgentGovernor,
	type SessionGovernorBatchAcquireResult,
	type SessionGovernorFileSystem,
	SessionGovernorStateError,
} from "../../../packages/pi-stuff/src/subagents/src/runtime/session-governor.js";
import type { GovernorLedger } from "../../../packages/pi-stuff/src/subagents/src/runtime/session-governor-contracts.js";
import {
	resolveSessionGovernorRoot,
	resolveTempRootDir,
} from "../../../packages/pi-stuff/src/subagents/src/shared/types.js";
import { getAgentSessionsDir } from "../../../packages/pi-stuff/src/subagents/src/shared/utils.js";

const roots: string[] = [];
const GOVERNOR_LEDGER_SCHEMA = Type.Object(
	{
		leases: Type.Array(
			Type.Object(
				{
					childIndex: Type.Optional(Type.Number()),
					pid: Type.Optional(Type.Number()),
					runtimeRunId: Type.Optional(Type.String()),
				},
				{ additionalProperties: true },
			),
		),
		total: Type.Optional(Type.Number()),
	},
	{ additionalProperties: true },
);

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storageRoot(label: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `pi-stuff-governor-${label}-`));
	roots.push(root);
	return join(root, "state");
}

async function ledgerPath(rootDir: string): Promise<string> {
	const entries = await readdir(rootDir);
	const sessionDirectory = entries[0];
	if (!sessionDirectory) throw new Error("Expected a session governor directory");
	return join(rootDir, sessionDirectory, "ledger.json");
}

async function readGovernorLedger(path: string) {
	const value = JSON.parse(await readFile(path, "utf8"));
	if (!Check(GOVERNOR_LEDGER_SCHEMA, value)) throw new Error("Expected a Session governor ledger");
	return value;
}

function requireLease(result: Awaited<ReturnType<SessionAgentGovernor["acquireSpawn"]>>): AgentGovernorLease {
	if (!result.ok) throw new Error(`Expected a lease, received ${result.error.code}`);
	return result.lease;
}

function requireBatchLeases(result: SessionGovernorBatchAcquireResult): readonly AgentGovernorLease[] {
	if (!result.ok) throw new Error(`Expected leases, received ${result.error.code}`);
	return result.leases;
}

function ioError(message: string): NodeJS.ErrnoException {
	return Object.assign(new Error(message), { code: "EIO" });
}

function governorFs(overrides: Partial<SessionGovernorFileSystem>): SessionGovernorFileSystem {
	return { ...nodeFs, ...overrides };
}

test("ignores a relative XDG_STATE_HOME instead of disabling the governor", () => {
	expect(resolveSessionGovernorRoot({ XDG_STATE_HOME: "relative/state" }, "/workspace/example-user")).toBe(
		"/workspace/example-user/.local/state/pi-stuff/agents/session-governor",
	);
	expect(resolveSessionGovernorRoot({ XDG_STATE_HOME: "/var/lib/test-state" }, "/workspace/example-user")).toBe(
		"/var/lib/test-state/pi-stuff/agents/session-governor",
	);
	expect(resolveTempRootDir({ env: { XDG_RUNTIME_DIR: "/run/user/1000" }, getuid: () => 1000 })).toBe(
		"/run/user/1000/pi-stuff/agents-uid-1000",
	);
	expect(
		resolveTempRootDir({
			env: { XDG_RUNTIME_DIR: "relative/runtime" },
			getuid: () => 1000,
			tmpdir: () => "/tmp",
		}),
	).toBe("/tmp/pi-stuff-agents-uid-1000");
	expect(getAgentSessionsDir({ HOME: "/users/example", PI_CODING_AGENT_SESSION_DIR: "~/pi-sessions" })).toBe(
		"/users/example/pi-sessions",
	);
});

test("keeps finite depth and concurrency defaults while cumulative launches remain unbounded", async () => {
	const rootDir = await storageRoot("defaults");
	const governor = new SessionAgentGovernor({ rootDir, sessionId: "session-defaults" });

	expect(await governor.snapshot()).toMatchObject({
		limits: DEFAULT_SESSION_GOVERNOR_LIMITS,
		effectiveLimits: DEFAULT_SESSION_GOVERNOR_LIMITS,
		total: 0,
		running: 0,
	});
	expect(
		() =>
			new SessionAgentGovernor({
				rootDir,
				sessionId: "invalid-zero",
				limits: { maxRunning: 0 },
			}),
	).toThrow("positive safe integer");
	expect(
		() =>
			new SessionAgentGovernor({
				rootDir,
				sessionId: "invalid-fraction",
				limits: { maxDepth: 1.5 },
			}),
	).toThrow("positive safe integer");
	expect(
		() =>
			new SessionAgentGovernor({
				rootDir,
				sessionId: "invalid-unlimited",
				limits: { maxRunning: Number.POSITIVE_INFINITY },
			}),
	).toThrow("unlimited and zero are not supported");
});

test("persists one owner-only ledger across governor reloads", async () => {
	const rootDir = await storageRoot("reload");
	const first = new SessionAgentGovernor({ rootDir, sessionId: "durable-session", pid: 101 });
	const lease = requireLease(await first.acquireSpawn({ logicalAgentId: "agent-stable", pid: 501 }));

	const reloaded = new SessionAgentGovernor({ rootDir, sessionId: "durable-session", pid: 102 });
	expect(await reloaded.snapshot()).toMatchObject({
		total: 1,
		running: 1,
		agents: [{ logicalAgentId: "agent-stable", agentPath: ["agent-stable"] }],
		leases: [
			{
				logicalAgentId: "agent-stable",
				runtimeRunId: "agent-stable",
				childIndex: 0,
				pid: 501,
				mode: "spawn",
			},
		],
	});

	expect((await stat(rootDir)).mode & 0o777).toBe(0o700);
	const sessionEntries = await readdir(rootDir);
	expect(sessionEntries).toHaveLength(1);
	const sessionDir = join(rootDir, sessionEntries[0] ?? "missing");
	expect((await stat(sessionDir)).mode & 0o777).toBe(0o700);
	expect((await stat(join(sessionDir, "ledger.json"))).mode & 0o777).toBe(0o600);
	expect((await readdir(sessionDir)).sort()).toEqual(["ledger.json", "ledger.lock"]);

	expect(await reloaded.release(lease)).toMatchObject({ released: true, snapshot: { total: 1, running: 0 } });
	expect(await reloaded.release(lease)).toMatchObject({
		released: false,
		reason: "already_released",
		snapshot: { total: 1, running: 0 },
	});
	// SAFETY: this test controls the serialized JSON fixture and exercises only the asserted fields.
	const persisted = JSON.parse(await readFile(join(sessionDir, "ledger.json"), "utf8")) as {
		total: number;
		leases: unknown[];
	};
	expect(persisted).toMatchObject({ total: 1, leases: [] });
});

test("loads a valid durable ledger after it grows beyond the retired 4 MiB threshold", async () => {
	const rootDir = await storageRoot("large-ledger");
	const sessionId = "large-ledger-session";
	await new SessionAgentGovernor({ rootDir, sessionId }).snapshot();
	const pathToLedger = await ledgerPath(rootDir);
	// SAFETY: SessionAgentGovernor created and schema-validated this private v1 ledger immediately above.
	const ledger = JSON.parse(await readFile(pathToLedger, "utf8")) as GovernorLedger;
	ledger.agents = Array.from({ length: 12_000 }, (_, index) => {
		const logicalAgentId = `historical-agent-${String(index)}`;
		return {
			logicalAgentId,
			ownerAgentPath: [],
			agentPath: [logicalAgentId],
			limits: ledger.limits,
			createdAtMs: index,
			workUsage: {
				turns: 0,
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				modelAttempts: 0,
				resumes: 0,
			},
		};
	});
	ledger.total = ledger.agents.length;
	const serialized = `${JSON.stringify(ledger, null, 2)}\n`;
	expect(Buffer.byteLength(serialized, "utf8")).toBeGreaterThan(4 * 1024 * 1024);
	await writeFile(pathToLedger, serialized, { mode: 0o600 });

	expect(await new SessionAgentGovernor({ rootDir, sessionId }).snapshot()).toMatchObject({
		total: 12_000,
		running: 0,
	});
});

test("persists explicit spawn runtime mappings and resolves the current lease", async () => {
	const rootDir = await storageRoot("spawn-runtime-mapping");
	const governor = new SessionAgentGovernor({ rootDir, sessionId: "spawn-runtime-session" });
	const result = await governor.acquireSpawnBatch([
		{ logicalAgentId: "logical-a", runtimeRunId: "runtime-group", childIndex: 0, pid: 601 },
		{ logicalAgentId: "logical-b", runtimeRunId: "runtime-group", childIndex: 1, pid: 602 },
	]);
	const leases = requireBatchLeases(result);

	expect(leases).toMatchObject([
		{ logicalAgentId: "logical-a", runtimeRunId: "runtime-group", childIndex: 0 },
		{ logicalAgentId: "logical-b", runtimeRunId: "runtime-group", childIndex: 1 },
	]);
	expect(result.snapshot.leases).toMatchObject(leases);
	expect(await governor.findRuntimeLease("runtime-group", 1)).toMatchObject({
		logicalAgentId: "logical-b",
		leaseId: leases[1]?.leaseId,
	});
	expect(await governor.findRuntimeLease("runtime-group", 9)).toBeUndefined();
});

test("keeps logical identity while resume receives a new runtime mapping", async () => {
	const rootDir = await storageRoot("resume-runtime-mapping");
	const governor = new SessionAgentGovernor({ rootDir, sessionId: "resume-runtime-session" });
	const spawned = requireLease(
		await governor.acquireSpawn({
			logicalAgentId: "durable-logical-agent",
			runtimeRunId: "initial-runtime",
			childIndex: 2,
			pid: 701,
		}),
	);
	await governor.release(spawned);

	const resumed = await governor.acquireResume({
		logicalAgentId: spawned.logicalAgentId,
		runtimeRunId: "resumed-runtime",
		childIndex: 4,
		pid: 702,
	});
	if (!resumed.ok) throw new Error(resumed.error.message);

	expect(resumed.lease).toMatchObject({
		logicalAgentId: "durable-logical-agent",
		runtimeRunId: "resumed-runtime",
		childIndex: 4,
		mode: "resume",
		agentPath: spawned.agentPath,
	});
	expect(resumed.snapshot).toMatchObject({ total: 1, running: 1 });
	expect(await governor.findRuntimeLease("initial-runtime", 2)).toBeUndefined();
	expect(await governor.findRuntimeLease("resumed-runtime", 4)).toMatchObject({
		logicalAgentId: spawned.logicalAgentId,
	});
});

test("rebinds atomically only when the current lease ownership matches", async () => {
	const rootDir = await storageRoot("runtime-rebind");
	const governor = new SessionAgentGovernor({ rootDir, sessionId: "runtime-rebind-session" });
	const lease = requireLease(
		await governor.acquireSpawn({
			logicalAgentId: "rebind-agent",
			runtimeRunId: "provisional-runtime",
			childIndex: 0,
			pid: 801,
		}),
	);
	const staleOwner: AgentGovernorLease = { ...lease, leaseId: "stale-lease-owner" };

	expect(
		await governor.rebindRuntime(staleOwner, {
			runtimeRunId: "must-not-bind",
			childIndex: 8,
			pid: 899,
		}),
	).toMatchObject({
		rebound: false,
		reason: "ownership_changed",
		snapshot: {
			leases: [{ runtimeRunId: "provisional-runtime", childIndex: 0, pid: 801 }],
		},
	});

	const rebound = await governor.rebindRuntime(lease, {
		runtimeRunId: "actual-runtime",
		childIndex: 3,
		pid: 802,
	});
	expect(rebound).toMatchObject({
		rebound: true,
		lease: { runtimeRunId: "actual-runtime", childIndex: 3, pid: 802 },
		snapshot: { leases: [{ runtimeRunId: "actual-runtime", childIndex: 3, pid: 802 }] },
	});
	expect(await governor.findRuntimeLease("provisional-runtime", 0)).toBeUndefined();
	expect(await governor.findRuntimeLease("actual-runtime", 3)).toMatchObject({ leaseId: lease.leaseId });
});

test("reloads rebound runtime mappings from the durable ledger", async () => {
	const rootDir = await storageRoot("runtime-reload");
	const first = new SessionAgentGovernor({ rootDir, sessionId: "runtime-reload-session" });
	const lease = requireLease(await first.acquireSpawn({ logicalAgentId: "reload-agent", pid: 901 }));
	const rebound = await first.rebindRuntime(lease, {
		runtimeRunId: "persisted-runtime",
		childIndex: 6,
		pid: 902,
	});
	if (!rebound.rebound) throw new Error(rebound.reason);

	const reloaded = new SessionAgentGovernor({ rootDir, sessionId: "runtime-reload-session" });
	expect(await reloaded.snapshot()).toMatchObject({
		leases: [
			{
				logicalAgentId: "reload-agent",
				runtimeRunId: "persisted-runtime",
				childIndex: 6,
				pid: 902,
			},
		],
	});
	expect(await reloaded.findRuntimeLease("persisted-runtime", 6)).toEqual(rebound.lease);
	const persisted = await readGovernorLedger(await ledgerPath(rootDir));
	expect(persisted.leases[0]).toMatchObject({ runtimeRunId: "persisted-runtime", childIndex: 6, pid: 902 });
});

test("migrates old lease records without runtime fields and rewrites the ledger", async () => {
	const rootDir = await storageRoot("runtime-migration");
	const sessionId = "runtime-migration-session";
	const first = new SessionAgentGovernor({ rootDir, sessionId });
	await first.acquireSpawn({ logicalAgentId: "legacy-agent", pid: 1_001 });
	const pathToLedger = await ledgerPath(rootDir);
	const legacy = await readGovernorLedger(pathToLedger);
	const legacyLease = legacy.leases[0];
	if (!legacyLease) throw new Error("Expected a legacy lease record");
	delete legacyLease.runtimeRunId;
	delete legacyLease.childIndex;
	await writeFile(pathToLedger, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

	const migrated = new SessionAgentGovernor({ rootDir, sessionId });
	expect(await migrated.snapshot()).toMatchObject({
		leases: [{ logicalAgentId: "legacy-agent", runtimeRunId: "legacy-agent", childIndex: 0, pid: 1_001 }],
	});
	expect(await migrated.findRuntimeLease("legacy-agent", 0)).toMatchObject({ logicalAgentId: "legacy-agent" });

	const rewritten = await readGovernorLedger(pathToLedger);
	expect(rewritten.leases[0]).toMatchObject({ runtimeRunId: "legacy-agent", childIndex: 0 });
});

test("enforces running capacity without turning cumulative launches into admission", async () => {
	const rootDir = await storageRoot("limits");
	const options = {
		rootDir,
		sessionId: "limited-session",
		limits: { maxDepth: 3, maxRunning: 1 },
	};
	const firstGovernor = new SessionAgentGovernor({ ...options, pid: 111 });
	const secondGovernor = new SessionAgentGovernor({ ...options, pid: 222 });

	const raced = await Promise.all([
		firstGovernor.acquireSpawn({ logicalAgentId: "agent-a", pid: 1_001 }),
		secondGovernor.acquireSpawn({ logicalAgentId: "agent-b", pid: 1_002 }),
	]);
	const success = raced.find((result) => result.ok);
	const limited = raced.find((result) => !result.ok);
	if (!success?.ok || !limited || limited.ok) throw new Error("Expected one winner and one limit result");
	expect(limited.error).toMatchObject({ kind: "limit", code: "running_limit", limit: 1, used: 1 });
	expect(limited.snapshot).toMatchObject({ total: 1, running: 1 });

	await firstGovernor.release(success.lease);
	const secondId = limited.error.logicalAgentId;
	const second = await secondGovernor.acquireSpawn({ logicalAgentId: secondId, pid: 1_003 });
	const secondLease = requireLease(second);
	expect(second.snapshot).toMatchObject({ total: 2, running: 1 });
	await secondGovernor.release(secondLease);

	const third = requireLease(await firstGovernor.acquireSpawn({ logicalAgentId: "agent-c", pid: 1_004 }));
	expect(third).toMatchObject({ logicalAgentId: "agent-c" });
	expect(await firstGovernor.release(third)).toMatchObject({ released: true, snapshot: { total: 3, running: 0 } });

	const resumed = await firstGovernor.acquireResume({ logicalAgentId: success.lease.logicalAgentId, pid: 1_005 });
	if (!resumed.ok) throw new Error(`Expected resume, received ${resumed.error.code}`);
	expect(resumed).toMatchObject({ ok: true, lease: { mode: "resume" }, snapshot: { total: 3, running: 1 } });
	const resumeLimited = await secondGovernor.acquireResume({ logicalAgentId: secondId, pid: 1_006 });
	expect(resumeLimited).toMatchObject({
		ok: false,
		error: { kind: "limit", code: "running_limit" },
		snapshot: { total: 3, running: 1 },
	});
	await firstGovernor.release(resumed.lease);

	const duplicateSpawn = await firstGovernor.acquireSpawn({
		logicalAgentId: success.lease.logicalAgentId,
		pid: 1_007,
	});
	expect(duplicateSpawn).toMatchObject({
		ok: false,
		error: { kind: "conflict", code: "logical_agent_exists" },
		snapshot: { total: 3, running: 0 },
	});
});

test("atomically reserves whole parallel batches across competing governor instances", async () => {
	const rootDir = await storageRoot("batch-race");
	const options = {
		rootDir,
		sessionId: "batch-race-session",
		limits: { maxDepth: 3, maxRunning: 3 },
	};
	const first = new SessionAgentGovernor({ ...options, pid: 811 });
	const second = new SessionAgentGovernor({ ...options, pid: 822 });
	const requests = (prefix: string, pid: number) => [
		{ logicalAgentId: `${prefix}-1`, pid },
		{ logicalAgentId: `${prefix}-2`, pid: pid + 1 },
	];

	const raced = await Promise.all([
		first.acquireSpawnBatch(requests("first", 8_101)),
		second.acquireSpawnBatch(requests("second", 8_201)),
	]);
	const winner = raced.find((result) => result.ok);
	const loser = raced.find((result) => !result.ok);
	if (!winner?.ok || !loser || loser.ok) throw new Error("Expected one whole batch winner and one loser");

	expect(winner.leases).toHaveLength(2);
	expect(winner.snapshot).toMatchObject({ total: 2, running: 2 });
	expect(winner.leases.every((lease) => lease.agentPath.length === 1)).toBe(true);
	expect(loser).toMatchObject({
		ok: false,
		error: { kind: "limit", code: "running_limit", limit: 3, used: 2, requested: 2 },
		snapshot: { total: 2, running: 2 },
	});
	expect(await first.snapshot()).toMatchObject({ total: 2, running: 2 });

	expect(await first.releaseBatch(winner.leases)).toMatchObject({
		released: true,
		releasedCount: 2,
		snapshot: { total: 2, running: 0 },
	});
	const retried = await second.acquireSpawnBatch(
		requests(loser.error.logicalAgentId.startsWith("first") ? "first" : "second", 8_301),
	);
	expect(retried).toMatchObject({ ok: true, snapshot: { total: 4, running: 2 } });
	if (retried.ok) await second.releaseBatch(retried.leases);
});

test("rolls back batch validation and mid-construction failures without durable partial Agents", async () => {
	const rootDir = await storageRoot("batch-rollback");
	const governor = new SessionAgentGovernor({
		rootDir,
		sessionId: "batch-rollback-session",
		limits: { maxRunning: 2 },
	});
	const seed = requireLease(await governor.acquireSpawn({ logicalAgentId: "seed", pid: 9_001 }));
	await governor.release(seed);

	const existingConflict = await governor.acquireSpawnBatch([
		{ logicalAgentId: "new-before", pid: 9_002 },
		{ logicalAgentId: "seed", pid: 9_003 },
		{ logicalAgentId: "new-after", pid: 9_004 },
	]);
	expect(existingConflict).toMatchObject({
		ok: false,
		error: { kind: "conflict", code: "logical_agent_exists", logicalAgentId: "seed" },
		snapshot: { total: 1, running: 0 },
	});
	expect(existingConflict.snapshot.agents.map(({ logicalAgentId }) => logicalAgentId)).toEqual(["seed"]);

	const capacityFailure = await governor.acquireSpawnBatch([
		{ logicalAgentId: "capacity-1", pid: 9_011 },
		{ logicalAgentId: "capacity-2", pid: 9_012 },
		{ logicalAgentId: "capacity-3", pid: 9_013 },
	]);
	expect(capacityFailure).toMatchObject({
		ok: false,
		error: { kind: "limit", code: "running_limit", used: 0, requested: 3 },
		snapshot: { total: 1, running: 0 },
	});

	const totalRoot = await storageRoot("batch-total-rollback");
	const totalGovernor = new SessionAgentGovernor({
		rootDir: totalRoot,
		sessionId: "batch-total-rollback-session",
		limits: { maxRunning: 5 },
	});
	const counted = requireLease(await totalGovernor.acquireSpawn({ logicalAgentId: "already-counted", pid: 9_015 }));
	await totalGovernor.release(counted);
	const beyondLegacyTotal = await totalGovernor.acquireSpawnBatch([
		{ logicalAgentId: "total-1", pid: 9_016 },
		{ logicalAgentId: "total-2", pid: 9_017 },
	]);
	expect(beyondLegacyTotal).toMatchObject({ ok: true, snapshot: { total: 3, running: 2 } });
	if (beyondLegacyTotal.ok) await totalGovernor.releaseBatch(beyondLegacyTotal.leases);

	const throwRoot = await storageRoot("batch-token-failure");
	let tokenCalls = 0;
	const throwing = new SessionAgentGovernor({
		rootDir: throwRoot,
		sessionId: "batch-token-failure-session",
		token: () => {
			tokenCalls += 1;
			if (tokenCalls === 3) throw new Error("second lease token failed");
			return `token-${tokenCalls}`;
		},
	});
	await expect(
		throwing.acquireSpawnBatch([
			{ logicalAgentId: "token-1", pid: 9_021 },
			{ logicalAgentId: "token-2", pid: 9_022 },
		]),
	).rejects.toThrow("second lease token failed");
	const reloaded = new SessionAgentGovernor({ rootDir: throwRoot, sessionId: "batch-token-failure-session" });
	expect(await reloaded.snapshot()).toMatchObject({ total: 0, running: 0, agents: [], leases: [] });
});

test("rejects duplicate logical run IDs and releases batches all-or-none", async () => {
	const rootDir = await storageRoot("batch-duplicates");
	const governor = new SessionAgentGovernor({ rootDir, sessionId: "batch-duplicate-session" });
	const duplicate = await governor.acquireSpawnBatch([
		{ logicalAgentId: "same-run", pid: 10_001 },
		{ logicalAgentId: "same-run", pid: 10_002 },
	]);
	expect(duplicate).toMatchObject({
		ok: false,
		error: { kind: "conflict", code: "logical_agent_exists", logicalAgentId: "same-run" },
		snapshot: { total: 0, running: 0 },
	});

	const leases = requireBatchLeases(
		await governor.acquireSpawnBatch([
			{ logicalAgentId: "release-1", pid: 10_011 },
			{ logicalAgentId: "release-2", pid: 10_012 },
		]),
	);
	const firstLease = leases[0];
	const secondLease = leases[1];
	if (!firstLease || !secondLease) throw new Error("Expected both release leases");
	const changedLease: AgentGovernorLease = { ...secondLease, leaseId: "changed-owner" };
	expect(await governor.releaseBatch([firstLease, changedLease])).toMatchObject({
		released: false,
		releasedCount: 0,
		logicalAgentId: "release-2",
		reason: "ownership_changed",
		snapshot: { total: 2, running: 2 },
	});
	expect(await governor.releaseBatch([firstLease, firstLease])).toMatchObject({
		released: false,
		releasedCount: 0,
		logicalAgentId: "release-1",
		reason: "duplicate_logical_agent_id",
		snapshot: { total: 2, running: 2 },
	});
	expect(await governor.releaseBatch(leases)).toMatchObject({
		released: true,
		releasedCount: 2,
		snapshot: { total: 2, running: 0 },
	});
	expect(await governor.releaseBatch(leases)).toMatchObject({
		released: false,
		releasedCount: 0,
		logicalAgentId: "release-1",
		reason: "already_released",
		snapshot: { total: 2, running: 0 },
	});
});

test("keeps child ceilings monotonic and rejects delegation below depth three", async () => {
	const rootDir = await storageRoot("depth");
	const root = new SessionAgentGovernor({ rootDir, sessionId: "depth-session", pid: 301 });
	const first = await root.acquireSpawn({
		logicalAgentId: "level-1",
		pid: 2_001,
		childLimits: { maxDepth: 99, maxRunning: 99 },
	});
	if (!first.ok) throw new Error(first.error.message);
	expect(first.snapshot.agents[0]?.limits).toEqual(DEFAULT_SESSION_GOVERNOR_LIMITS);

	const levelOne = new SessionAgentGovernor({
		rootDir,
		sessionId: "depth-session",
		ownerAgentPath: ["level-1"],
		limits: { maxRunning: 999 },
		pid: 302,
	});
	const second = await levelOne.acquireSpawnBatch([
		{ logicalAgentId: "level-2", pid: 2_002 },
		{ logicalAgentId: "level-2-peer", pid: 2_003 },
	]);
	if (!second.ok) throw new Error(second.error.message);
	expect(second.snapshot.agents.find(({ logicalAgentId }) => logicalAgentId === "level-2-peer")).toMatchObject({
		ownerAgentPath: ["level-1"],
		agentPath: ["level-1", "level-2-peer"],
	});
	const levelTwo = new SessionAgentGovernor({
		rootDir,
		sessionId: "depth-session",
		ownerAgentPath: ["level-1", "level-2"],
		pid: 303,
	});
	const third = await levelTwo.acquireSpawn({ logicalAgentId: "level-3", pid: 2_004 });
	if (!third.ok) throw new Error(third.error.message);
	const levelThree = new SessionAgentGovernor({
		rootDir,
		sessionId: "depth-session",
		ownerAgentPath: ["level-1", "level-2", "level-3"],
		pid: 304,
	});
	const rejected = await levelThree.acquireSpawnBatch([
		{ logicalAgentId: "level-4-a", pid: 2_005 },
		{ logicalAgentId: "level-4-b", pid: 2_006 },
	]);
	expect(rejected).toMatchObject({
		ok: false,
		error: { kind: "limit", code: "depth_limit", limit: 3, used: 3, requested: 4 },
		snapshot: { total: 4, running: 4 },
	});

	const ceilingRootDir = await storageRoot("child-ceiling");
	const ceilingRoot = new SessionAgentGovernor({ rootDir: ceilingRootDir, sessionId: "ceiling-session" });
	const ceilingChild = await ceilingRoot.acquireSpawn({
		logicalAgentId: "bounded-child",
		pid: 2_101,
		childLimits: { maxDepth: 1, maxRunning: 2 },
	});
	if (!ceilingChild.ok) throw new Error(ceilingChild.error.message);
	const bounded = new SessionAgentGovernor({
		rootDir: ceilingRootDir,
		sessionId: "ceiling-session",
		ownerAgentPath: ["bounded-child"],
		limits: { maxDepth: 3, maxRunning: 20 },
	});
	expect((await bounded.snapshot()).effectiveLimits).toEqual({
		maxDepth: 1,
		maxRunning: 2,
		maxTotal: DEFAULT_SESSION_GOVERNOR_LIMITS.maxTotal,
	});
	expect(await bounded.acquireSpawn({ logicalAgentId: "forbidden-grandchild", pid: 2_102 })).toMatchObject({
		ok: false,
		error: { kind: "limit", code: "depth_limit", limit: 1 },
		snapshot: { total: 1, running: 1 },
	});
});

test("explicit reconciliation reclaims only demonstrably dead running leases and never total", async () => {
	const rootDir = await storageRoot("reconcile");
	const governor = new SessionAgentGovernor({
		rootDir,
		sessionId: "reconcile-session",
		limits: { maxRunning: 3 },
	});
	const initial = requireBatchLeases(
		await governor.acquireSpawnBatch([
			{ logicalAgentId: "stale-agent", pid: 7_001 },
			{ logicalAgentId: "live-agent", pid: 7_002 },
		]),
	);
	const stale = initial[0];
	const live = initial[1];
	if (!stale || !live) throw new Error("Expected the reconciliation batch to return both leases");

	const reconciled = await governor.reconcile((pid) => (pid === stale.pid ? false : undefined));
	expect(reconciled).toMatchObject({
		reclaimedLogicalAgentIds: ["stale-agent"],
		snapshot: { total: 2, running: 1 },
	});
	expect(await governor.reconcile(() => true)).toMatchObject({
		reclaimedLogicalAgentIds: [],
		snapshot: { total: 2, running: 1 },
	});

	const resumed = await governor.acquireResume({ logicalAgentId: stale.logicalAgentId, pid: 7_003 });
	if (!resumed.ok) throw new Error(resumed.error.message);
	expect(resumed.snapshot).toMatchObject({ total: 2, running: 2 });
	await governor.releaseBatch([resumed.lease, live]);
	expect(await governor.snapshot()).toMatchObject({ total: 2, running: 0 });
});

test("does not let an unregistered child path initialize or impersonate a session owner", async () => {
	const rootDir = await storageRoot("owner-path");
	const child = new SessionAgentGovernor({
		rootDir,
		sessionId: "owner-session",
		ownerAgentPath: ["unknown-child"],
	});
	await expect(child.snapshot()).rejects.toBeInstanceOf(SessionGovernorStateError);

	const root = new SessionAgentGovernor({ rootDir, sessionId: "owner-session" });
	await root.snapshot();
	await expect(child.snapshot()).rejects.toThrow("is not registered");
});

test("returns a committed reservation when post-rename ledger hardening fails", async () => {
	const rootDir = await storageRoot("post-commit-chmod");
	let injected = false;
	const governor = new SessionAgentGovernor({
		rootDir,
		sessionId: "post-commit-chmod-session",
		fs: governorFs({
			chmod: async (target, mode) => {
				if (!injected && String(target).endsWith("/ledger.json")) {
					injected = true;
					throw ioError("injected post-commit chmod failure");
				}
				await nodeFs.chmod(target, mode);
			},
		}),
	});

	const acquired = await governor.acquireSpawn({ logicalAgentId: "committed-agent", pid: 12_001 });
	expect(acquired).toMatchObject({ ok: true, snapshot: { total: 1, running: 1 } });
	expect(injected).toBe(true);
	expect(await new SessionAgentGovernor({ rootDir, sessionId: "post-commit-chmod-session" }).snapshot()).toMatchObject(
		{ total: 1, running: 1, leases: [{ logicalAgentId: "committed-agent" }] },
	);
});

test("does not turn best-effort temporary-ledger cleanup into a false reservation failure", async () => {
	const rootDir = await storageRoot("temp-cleanup");
	let injected = false;
	const governor = new SessionAgentGovernor({
		rootDir,
		sessionId: "temp-cleanup-session",
		fs: governorFs({
			rm: async (target, options) => {
				if (!injected && String(target).includes("/.ledger.") && String(target).endsWith(".tmp")) {
					injected = true;
					throw ioError("injected temporary cleanup failure");
				}
				await nodeFs.rm(target, options);
			},
		}),
	});

	const acquired = await governor.acquireSpawn({ logicalAgentId: "cleanup-agent", pid: 12_011 });
	expect(acquired).toMatchObject({ ok: true, snapshot: { total: 1, running: 1 } });
	expect(injected).toBe(true);
	expect(await readFile(await ledgerPath(rootDir), "utf8")).toContain('"logicalAgentId": "cleanup-agent"');
});

test("keeps a stable kernel lock inode without making lock-file cleanup part of commit", async () => {
	const rootDir = await storageRoot("release-lock-cleanup");
	const governor = new SessionAgentGovernor({
		rootDir,
		sessionId: "release-lock-cleanup-session",
	});

	const acquired = await governor.acquireSpawn({ logicalAgentId: "unlock-agent", pid: 12_021 });
	expect(acquired).toMatchObject({ ok: true, snapshot: { total: 1, running: 1 } });
	expect(await readFile(await ledgerPath(rootDir), "utf8")).toContain('"logicalAgentId": "unlock-agent"');
	const [sessionDirectory] = await readdir(rootDir);
	if (!sessionDirectory) throw new Error("Expected a session governor directory");
	expect((await stat(join(rootDir, sessionDirectory, "ledger.lock"))).isFile()).toBe(true);
	expect(
		await new SessionAgentGovernor({ rootDir, sessionId: "release-lock-cleanup-session" }).snapshot(),
	).toMatchObject({ total: 1, running: 1 });
});

test("fails closed when the stable governor lock path is replaced by a directory", async () => {
	const rootDir = await storageRoot("incomplete-lock");
	const sessionId = "incomplete-lock-session";
	await new SessionAgentGovernor({ rootDir, sessionId }).snapshot();
	const [sessionDirectory] = await readdir(rootDir);
	if (!sessionDirectory) throw new Error("Expected a session governor directory");
	const lockPath = join(rootDir, sessionDirectory, "ledger.lock");
	await rm(lockPath);
	await nodeFs.mkdir(lockPath, { mode: 0o700 });
	await expect(new SessionAgentGovernor({ rootDir, sessionId }).snapshot()).rejects.toThrow("regular file");
});

test("ignores stale diagnostic bytes because kernel ownership is the only lock authority", async () => {
	const rootDir = await storageRoot("stale-diagnostic-lock");
	const sessionId = "stale-diagnostic-lock-session";
	await new SessionAgentGovernor({ rootDir, sessionId }).snapshot();
	const [sessionDirectory] = await readdir(rootDir);
	if (!sessionDirectory) throw new Error("Expected a session governor directory");
	const lockPath = join(rootDir, sessionDirectory, "ledger.lock");
	await writeFile(lockPath, JSON.stringify({ token: "abandoned", pid: 44_001, acquiredAtMs: 0 }), {
		mode: 0o600,
	});
	expect(await new SessionAgentGovernor({ rootDir, sessionId }).snapshot()).toMatchObject({ total: 0, running: 0 });
	expect((await readdir(join(rootDir, sessionDirectory))).sort()).toEqual(["ledger.json", "ledger.lock"]);
});
