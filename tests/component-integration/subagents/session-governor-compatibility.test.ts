import { afterEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import {
	initializeWriterProcessRegistry,
	inspectWriterProcessLivenessEffect,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/writer-process-registry.ts";
import { SessionAgentGovernor } from "../../../packages/pi-stuff/src/subagents/src/runtime/session-governor.ts";
import {
	type PrepareSessionGovernorCompatibilityInput,
	prepareSessionGovernorCompatibility as prepareSessionGovernorCompatibilityNative,
} from "../../../packages/pi-stuff/src/subagents/src/runtime/session-governor-compatibility.ts";
import { readProcessStartIdentity } from "../../../packages/pi-stuff/src/subagents/src/shared/process-identity.ts";
import type { SessionGovernorCompatibilityScope } from "../../../packages/pi-stuff/src/subagents/src/shared/session-identity.ts";
import { TEMP_ROOT_DIR } from "../../../packages/pi-stuff/src/subagents/src/shared/types.ts";

const limits = { maxDepth: 3, maxRunning: 20, maxTotal: 200 };
const roots = new Set<string>();

type CompatibilityInput = Omit<PrepareSessionGovernorCompatibilityInput, "inspectWriterLiveness"> &
	Partial<Pick<PrepareSessionGovernorCompatibilityInput, "inspectWriterLiveness">>;

function prepareSessionGovernorCompatibility(input: CompatibilityInput) {
	return prepareSessionGovernorCompatibilityNative({
		...input,
		inspectWriterLiveness:
			input.inspectWriterLiveness ??
			((directory) => Effect.runPromise(inspectWriterProcessLivenessEffect(directory))),
	});
}

interface LegacyLockOwnerFixture {
	readonly pid: number;
	readonly processStartIdentity?: string;
	readonly token: string;
}

afterEach(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	roots.clear();
});

function temporaryRoot(prefix: string): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	roots.add(root);
	return root;
}

function scope(
	input: { declared?: readonly string[]; started?: readonly string[]; legacyArtifactSessionId?: string } = {},
): SessionGovernorCompatibilityScope {
	const result: SessionGovernorCompatibilityScope = {
		sessionId: "ps2-current",
		governorSessionId: "ps2-current",
		legacyGovernorSessionId: "logical-session",
		declaredLogicalAgentIds: new Set(input.declared ?? []),
		startedLogicalAgentIds: new Set(input.started ?? []),
	};
	if (input.legacyArtifactSessionId) {
		Object.assign(result, { legacyArtifactSessionId: input.legacyArtifactSessionId, startedAtMs: 1 });
	}
	return result;
}

function governor(rootDir: string, sessionId: string, ownerAgentPath: readonly string[] = []): SessionAgentGovernor {
	return new SessionAgentGovernor({ rootDir, sessionId, ownerAgentPath, limits });
}

function makeFixtureUseLegacyLockProtocol(rootDir: string): void {
	const sessionDir = path.join(rootDir, createHash("sha256").update("logical-session").digest("hex"));
	fs.rmSync(path.join(sessionDir, "ledger.lock"), { recursive: true, force: true });
}

function legacyLockPath(rootDir: string): string {
	return path.join(rootDir, createHash("sha256").update("logical-session").digest("hex"), "ledger.lock");
}

function writeStaleLegacyLock(rootDir: string, owner: LegacyLockOwnerFixture): string {
	const lockDir = legacyLockPath(rootDir);
	fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ ...owner, acquiredAtMs: 1 }), { mode: 0o600 });
	const old = new Date(Date.now() - 60_000);
	fs.utimesSync(lockDir, old, old);
	return lockDir;
}

function runtimeDirectory(runId: string, sessionId: string, childIndex = 0): string {
	const directory = path.join(TEMP_ROOT_DIR, "async-subagent-runs", runId);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	fs.chmodSync(directory, 0o700);
	initializeWriterProcessRegistry(directory, runId, process.pid, 0);
	fs.writeFileSync(
		path.join(directory, "status.json"),
		`${JSON.stringify({
			runId,
			sessionId,
			mode: "single",
			state: "complete",
			startedAt: 1,
			endedAt: 2,
			steps: Array.from({ length: childIndex + 1 }, (_, index) => ({
				agent: "worker",
				status: index === childIndex ? "completed" : "complete",
				startedAt: 1,
				endedAt: 2,
			})),
		})}\n`,
		{ mode: 0o600 },
	);
	roots.add(directory);
	return directory;
}

test("does not retain a pre-upgrade directory lock for the current process lifetime", async () => {
	const currentRoot = temporaryRoot("pi-governor-current-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const result = await prepareSessionGovernorCompatibility({
		scope: scope(),
		limits,
		currentRootDir: currentRoot,
		legacyRootDir: legacyRoot,
	});

	expect(result.ok).toBeTrue();
	expect(fs.existsSync(legacyLockPath(legacyRoot))).toBeFalse();
});

test("reclaims a stale barrier written by the previous current release", async () => {
	const currentRoot = temporaryRoot("pi-governor-current-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const lockDir = writeStaleLegacyLock(legacyRoot, {
		token: "f8878118-8a4d-431e-bb8c-09ad89886309",
		pid: process.pid,
		processStartIdentity: "definitely-not-the-current-process-generation",
	});

	const result = await prepareSessionGovernorCompatibility({
		scope: scope(),
		limits,
		currentRootDir: currentRoot,
		legacyRootDir: legacyRoot,
		legacyLockOptions: { timeoutMs: 20, retryMs: 1 },
	});

	expect(result.ok).toBeTrue();
	expect(fs.existsSync(lockDir)).toBeFalse();
});

test("keeps a live previous-release barrier fail-closed", async () => {
	const currentRoot = temporaryRoot("pi-governor-current-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const processStartIdentity = readProcessStartIdentity(process.pid);
	if (!processStartIdentity) throw new Error("Expected a process identity on the certified platform.");
	const lockDir = writeStaleLegacyLock(legacyRoot, {
		token: "7b73d977-1d87-4f2a-97ec-ae7541fe7831",
		pid: process.pid,
		processStartIdentity,
	});

	const result = await prepareSessionGovernorCompatibility({
		scope: scope(),
		limits,
		currentRootDir: currentRoot,
		legacyRootDir: legacyRoot,
		legacyLockOptions: { timeoutMs: 20, retryMs: 1 },
	});

	expect(result.ok).toBeFalse();
	expect(fs.existsSync(lockDir)).toBeTrue();
});

test("serializes concurrent recovery of one stale previous-release barrier", async () => {
	const currentRootA = temporaryRoot("pi-governor-current-a-");
	const currentRootB = temporaryRoot("pi-governor-current-b-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const lockDir = writeStaleLegacyLock(legacyRoot, {
		token: "04057a65-e2e2-4b9e-8cd5-52b027bc05d1",
		pid: 999_999_991,
		processStartIdentity: "linux:dead",
	});
	const options = { timeoutMs: 100, retryMs: 1 };
	const results = await Promise.all([
		prepareSessionGovernorCompatibility({
			scope: scope(),
			limits,
			currentRootDir: currentRootA,
			legacyRootDir: legacyRoot,
			legacyLockOptions: options,
		}),
		prepareSessionGovernorCompatibility({
			scope: scope(),
			limits,
			currentRootDir: currentRootB,
			legacyRootDir: legacyRoot,
			legacyLockOptions: options,
		}),
	]);

	expect(results.every((result) => result.ok)).toBeTrue();
	expect(fs.existsSync(lockDir)).toBeFalse();
});

test("keeps concurrent upgraded contenders fail-closed behind one uncooperative v1 lock", async () => {
	const currentRootA = temporaryRoot("pi-governor-current-a-");
	const currentRootB = temporaryRoot("pi-governor-current-b-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const lockDir = writeStaleLegacyLock(legacyRoot, { token: "stale", pid: 999_999_991 });
	const first = prepareSessionGovernorCompatibility({
		scope: scope(),
		limits,
		currentRootDir: currentRootA,
		legacyRootDir: legacyRoot,
		legacyLockOptions: {
			timeoutMs: 30,
			retryMs: 1,
		},
	});
	const second = prepareSessionGovernorCompatibility({
		scope: scope(),
		limits,
		currentRootDir: currentRootB,
		legacyRootDir: legacyRoot,
		legacyLockOptions: { timeoutMs: 30, retryMs: 1 },
	});
	const results = await Promise.all([first, second]);
	expect(results.every((result) => !result.ok)).toBeTrue();
	expect(fs.existsSync(lockDir)).toBeTrue();
	expect(JSON.parse(fs.readFileSync(path.join(lockDir, "owner.json"), "utf8"))).toMatchObject({ token: "stale" });
});

test("keeps a legacy owner without process-generation identity conservative", async () => {
	const currentRoot = temporaryRoot("pi-governor-current-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const lockDir = writeStaleLegacyLock(legacyRoot, { token: "legacy-live", pid: process.pid });
	const result = await prepareSessionGovernorCompatibility({
		scope: scope(),
		limits,
		currentRootDir: currentRoot,
		legacyRootDir: legacyRoot,
		legacyLockOptions: { timeoutMs: 20, retryMs: 1 },
	});
	expect(result.ok).toBeFalse();
	expect(fs.existsSync(lockDir)).toBeTrue();
});

test("imports only paired branch starts when no v1 ledger remains and is idempotent", async () => {
	const currentRoot = temporaryRoot("pi-governor-current-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const first = await prepareSessionGovernorCompatibility({
		scope: scope({ declared: ["started:0", "preflight-only:0"], started: ["started:0"] }),
		limits,
		currentRootDir: currentRoot,
		legacyRootDir: legacyRoot,
		now: () => 10,
	});
	if (!first.ok) throw new Error("Expected a successful v1 history import.");
	const second = await prepareSessionGovernorCompatibility({
		scope: scope({ declared: ["started:0", "preflight-only:0"], started: ["started:0"] }),
		limits,
		currentRootDir: currentRoot,
		legacyRootDir: legacyRoot,
		now: () => 10,
	});
	if (!second.ok) throw new Error("Expected an idempotent v1 history import.");
	const snapshot = await governor(currentRoot, "ps2-current").inspectExistingSnapshot();

	expect(first).toMatchObject({ ok: true, importedLogicalAgentIds: ["started:0"] });
	expect(second).toMatchObject({ ok: true, importedLogicalAgentIds: [] });
	expect(snapshot?.agents.map(({ logicalAgentId }) => logicalAgentId)).toEqual(["started:0"]);
	expect(snapshot?.agents[0]?.limits).toEqual({ maxDepth: 1, maxRunning: 1, maxTotal: Number.MAX_SAFE_INTEGER });
});

test("never imports an undeclared parallel index from an idle v1 ledger", async () => {
	const currentRoot = temporaryRoot("pi-governor-current-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const old = governor(legacyRoot, "logical-session");
	for (const logicalAgentId of ["parallel:0", "parallel:1", "parallel:99"]) {
		const acquired = await old.acquireSpawn({ logicalAgentId });
		if (!acquired.ok) throw new Error(acquired.error.message);
		await old.release(acquired.lease);
	}
	makeFixtureUseLegacyLockProtocol(legacyRoot);

	const result = await prepareSessionGovernorCompatibility({
		scope: scope({ declared: ["parallel:0", "parallel:1"] }),
		limits,
		currentRootDir: currentRoot,
		legacyRootDir: legacyRoot,
	});
	const snapshot = await governor(currentRoot, "ps2-current").inspectExistingSnapshot();

	expect(result.ok).toBeTrue();
	expect(snapshot?.agents.map(({ logicalAgentId }) => logicalAgentId).sort()).toEqual(["parallel:0", "parallel:1"]);
	expect(fs.existsSync(legacyLockPath(legacyRoot))).toBeFalse();
});

test("quarantines a v1 lease whose runtime ownership is still live or unknown", async () => {
	const currentRoot = temporaryRoot("pi-governor-current-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const old = governor(legacyRoot, "logical-session");
	const acquired = await old.acquireSpawn({ logicalAgentId: "live:0" });
	if (!acquired.ok) throw new Error(acquired.error.message);
	makeFixtureUseLegacyLockProtocol(legacyRoot);

	const result = await prepareSessionGovernorCompatibility({
		scope: scope({ declared: ["live:0"] }),
		limits,
		currentRootDir: currentRoot,
		legacyRootDir: legacyRoot,
	});

	expect(result).toMatchObject({ ok: false });
	expect(result.ok ? "" : result.message).toContain("temporarily paused");
	expect(await governor(currentRoot, "ps2-current").inspectExistingSnapshot()).toBeUndefined();
});

test("keeps missing, corrupt, nonterminal, live, and writer-unknown v1 evidence quarantined", async () => {
	for (const kind of ["missing", "corrupt", "nonterminal", "live", "writer-unknown"] as const) {
		const currentRoot = temporaryRoot(`pi-governor-current-${kind}-`);
		const legacyRoot = temporaryRoot(`pi-governor-legacy-${kind}-`);
		const old = governor(legacyRoot, "logical-session");
		const acquired = await old.acquireSpawn({ logicalAgentId: `${kind}:0`, pid: 999_999_991 });
		if (!acquired.ok) throw new Error(acquired.error.message);
		const asyncDir = runtimeDirectory(`${kind}-${randomUUID()}`, "/sessions/current.jsonl");
		await old.rebindRuntime(acquired.lease, {
			runtimeRunId: path.basename(asyncDir),
			asyncDir,
			pid: 999_999_991,
		});
		makeFixtureUseLegacyLockProtocol(legacyRoot);

		let readStatus: PrepareSessionGovernorCompatibilityInput["readStatus"];
		let isPidAlive: PrepareSessionGovernorCompatibilityInput["isPidAlive"];
		let inspectWriterLiveness: PrepareSessionGovernorCompatibilityInput["inspectWriterLiveness"] | undefined;
		if (kind === "missing") readStatus = () => null;
		if (kind === "corrupt")
			readStatus = () => {
				throw new Error("corrupt legacy status");
			};
		if (kind === "nonterminal") {
			readStatus = () => ({
				runId: path.basename(asyncDir),
				sessionId: "/sessions/current.jsonl",
				mode: "single",
				state: "running",
				startedAt: 1,
				steps: [{ agent: "worker", status: "running" }],
			});
		}
		if (kind === "live") isPidAlive = () => true;
		if (kind === "writer-unknown") {
			isPidAlive = () => false;
			inspectWriterLiveness = () => undefined;
		}

		let compatibilityInput: CompatibilityInput = {
			scope: scope({ declared: [`${kind}:0`], legacyArtifactSessionId: "/sessions/current.jsonl" }),
			limits,
			currentRootDir: currentRoot,
			legacyRootDir: legacyRoot,
		};
		if (readStatus) compatibilityInput = { ...compatibilityInput, readStatus };
		if (isPidAlive) compatibilityInput = { ...compatibilityInput, isPidAlive };
		if (inspectWriterLiveness) compatibilityInput = { ...compatibilityInput, inspectWriterLiveness };
		const result = await prepareSessionGovernorCompatibility(compatibilityInput);

		expect(result.ok, kind).toBeFalse();
		expect(await governor(currentRoot, "ps2-current").inspectExistingSnapshot(), kind).toBeUndefined();
		expect((await old.inspectExistingSnapshot())?.leases, kind).toHaveLength(1);
	}
});

test("ignores another physical copy's live v1 lease", async () => {
	const currentRoot = temporaryRoot("pi-governor-current-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const old = governor(legacyRoot, "logical-session");
	const acquired = await old.acquireSpawn({ logicalAgentId: "copied:0", pid: 999_999_991 });
	if (!acquired.ok) throw new Error(acquired.error.message);
	const asyncDir = runtimeDirectory(`copy-${randomUUID()}`, "/sessions/original.jsonl");
	await old.rebindRuntime(acquired.lease, { runtimeRunId: path.basename(asyncDir), asyncDir, pid: 999_999_991 });
	makeFixtureUseLegacyLockProtocol(legacyRoot);

	const result = await prepareSessionGovernorCompatibility({
		scope: scope({
			declared: ["copied:0"],
			started: ["copied:0"],
			legacyArtifactSessionId: "/sessions/copied.jsonl",
		}),
		limits,
		currentRootDir: currentRoot,
		legacyRootDir: legacyRoot,
	});

	expect(result).toMatchObject({ ok: true, importedLogicalAgentIds: ["copied:0"] });
});

test("imports a physically-proven dead nested ownership tree", async () => {
	const currentRoot = temporaryRoot("pi-governor-current-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const oldRoot = governor(legacyRoot, "logical-session");
	const parent = await oldRoot.acquireSpawn({ logicalAgentId: "root-run:0" });
	if (!parent.ok) throw new Error(parent.error.message);
	await oldRoot.release(parent.lease);
	const oldChild = governor(legacyRoot, "logical-session", ["root-run:0"]);
	const nested = await oldChild.acquireSpawn({ logicalAgentId: "nested-run:0", pid: 999_999_992 });
	if (!nested.ok) throw new Error(nested.error.message);
	const asyncDir = runtimeDirectory(`nested-${randomUUID()}`, "/sessions/current.jsonl");
	await oldChild.rebindRuntime(nested.lease, {
		runtimeRunId: path.basename(asyncDir),
		asyncDir,
		pid: 999_999_992,
	});
	makeFixtureUseLegacyLockProtocol(legacyRoot);

	const result = await prepareSessionGovernorCompatibility({
		scope: scope({ declared: ["root-run:0"], legacyArtifactSessionId: "/sessions/current.jsonl" }),
		limits,
		currentRootDir: currentRoot,
		legacyRootDir: legacyRoot,
		isPidAlive: () => false,
	});
	const snapshot = await governor(currentRoot, "ps2-current").inspectExistingSnapshot();

	expect(result.ok).toBeTrue();
	expect(snapshot?.agents.map(({ logicalAgentId }) => logicalAgentId).sort()).toEqual(["nested-run:0", "root-run:0"]);
	expect(snapshot?.leases).toHaveLength(0);
});

test("rejects a physically-current lease whose owner chain is orphaned", async () => {
	const currentRoot = temporaryRoot("pi-governor-current-");
	const legacyRoot = temporaryRoot("pi-governor-legacy-");
	const asyncDir = runtimeDirectory(`orphan-${randomUUID()}`, "/sessions/current.jsonl");
	const sessionDir = path.join(legacyRoot, createHash("sha256").update("logical-session").digest("hex"));
	fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(sessionDir, "ledger.json"),
		`${JSON.stringify({
			version: 1,
			sessionId: "logical-session",
			limits,
			total: 1,
			agents: [
				{
					logicalAgentId: "orphan:0",
					ownerAgentPath: ["missing:0"],
					agentPath: ["missing:0", "orphan:0"],
					limits,
					createdAtMs: 2,
				},
			],
			leases: [
				{
					logicalAgentId: "orphan:0",
					runtimeRunId: path.basename(asyncDir),
					childIndex: 0,
					leaseId: "lease",
					ownerAgentPath: ["missing:0"],
					agentPath: ["missing:0", "orphan:0"],
					pid: 999_999_993,
					asyncDir,
					mode: "spawn",
					acquiredAtMs: 2,
				},
			],
			updatedAtMs: 2,
		})}\n`,
		{ mode: 0o600 },
	);

	const result = await prepareSessionGovernorCompatibility({
		scope: scope({ declared: ["root-run:0"], legacyArtifactSessionId: "/sessions/current.jsonl" }),
		limits,
		currentRootDir: currentRoot,
		legacyRootDir: legacyRoot,
		isPidAlive: () => false,
	});

	expect(result).toMatchObject({ ok: false });
	expect(result.ok ? "" : result.message).toContain("unproven ownership path");
});
