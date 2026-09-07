import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentGovernorLease,
	SessionAgentGovernor,
} from "../../../packages/pi-stuff/src/subagents/src/runtime/session-governor.js";

const roots: string[] = [];

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

function requireLease(result: Awaited<ReturnType<SessionAgentGovernor["acquireSpawn"]>>): AgentGovernorLease {
	if (!result.ok) throw new Error(`Expected a lease, received ${result.error.code}`);
	return result.lease;
}

test("keeps active runtime addresses unique across spawn, resume, and rebind", async () => {
	const rootDir = await storageRoot("runtime-address-conflicts");
	const governor = new SessionAgentGovernor({ rootDir, sessionId: "runtime-address-conflict-session" });
	const first = requireLease(
		await governor.acquireSpawn({
			logicalAgentId: "logical-a",
			runtimeRunId: "shared-runtime",
			childIndex: 0,
			pid: 611,
		}),
	);

	expect(
		await governor.acquireSpawn({
			logicalAgentId: "logical-b",
			runtimeRunId: "shared-runtime",
			childIndex: 0,
			pid: 612,
		}),
	).toMatchObject({
		ok: false,
		error: { kind: "conflict", code: "runtime_address_in_use", logicalAgentId: "logical-b" },
		snapshot: { total: 1, running: 1 },
	});

	const second = requireLease(
		await governor.acquireSpawn({
			logicalAgentId: "logical-b",
			runtimeRunId: "other-runtime",
			childIndex: 1,
			pid: 613,
		}),
	);
	expect(await governor.rebindRuntime(second, { runtimeRunId: "shared-runtime", childIndex: 0 })).toMatchObject({
		rebound: false,
		reason: "runtime_address_in_use",
	});
	expect(await governor.findRuntimeLease("shared-runtime", 0)).toMatchObject({ leaseId: first.leaseId });

	await governor.release(second);
	expect(
		await governor.acquireResume({
			logicalAgentId: second.logicalAgentId,
			runtimeRunId: "shared-runtime",
			childIndex: 0,
			pid: 614,
		}),
	).toMatchObject({
		ok: false,
		error: { kind: "conflict", code: "runtime_address_in_use" },
		snapshot: { total: 2, running: 1 },
	});

	expect(
		await governor.acquireSpawnBatch([
			{ logicalAgentId: "logical-c", runtimeRunId: "batch-runtime", childIndex: 0, pid: 615 },
			{ logicalAgentId: "logical-d", runtimeRunId: "batch-runtime", childIndex: 0, pid: 616 },
		]),
	).toMatchObject({
		ok: false,
		error: { kind: "conflict", code: "runtime_address_in_use", logicalAgentId: "logical-d" },
		snapshot: { total: 2, running: 1 },
	});
});

test("rejects duplicate runtime addresses in a durable ledger", async () => {
	const rootDir = await storageRoot("duplicate-runtime-address");
	const sessionId = "duplicate-runtime-address-session";
	const governor = new SessionAgentGovernor({ rootDir, sessionId });
	await governor.acquireSpawnBatch([
		{ logicalAgentId: "logical-a", runtimeRunId: "runtime-group", childIndex: 0, pid: 1_011 },
		{ logicalAgentId: "logical-b", runtimeRunId: "runtime-group", childIndex: 1, pid: 1_012 },
	]);
	const path = await ledgerPath(rootDir);
	// SAFETY: this test controls the generated ledger and mutates only the asserted field.
	const persisted = JSON.parse(await readFile(path, "utf8")) as { leases: Array<{ childIndex: number }> };
	const duplicate = persisted.leases[1];
	if (!duplicate) throw new Error("Expected a second lease record");
	duplicate.childIndex = 0;
	await writeFile(path, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");

	await expect(new SessionAgentGovernor({ rootDir, sessionId }).snapshot()).rejects.toThrow(
		"duplicate runtime Agent addresses",
	);
});
