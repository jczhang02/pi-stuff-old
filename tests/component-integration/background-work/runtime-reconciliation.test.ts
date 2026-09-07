import { afterEach, expect, test } from "bun:test";
import {
	captureProcessIdentity,
	children,
	cleanupRuntimeFixtures,
	createAuthenticatedRuntimeRecord,
	existsSync,
	join,
	leaderGoneProcessGroup,
	mkdirSync,
	processExists,
	readFileSync,
	reconcileStaleRuns,
	resolve,
	spawn,
	TEST_WORK_AUTHORITY_KEY,
	temporaryRoot,
	waitUntil,
	writeFileSync,
} from "../../work/runtime-fixtures.js";

afterEach(cleanupRuntimeFixtures);

test("treats a reused PID identity as gone without signaling the new process", async () => {
	const root = temporaryRoot();
	const directory = join(root, ".pi", "tasks", "pi-stuff-stale-reused");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "runtime.json"),
		JSON.stringify(
			createAuthenticatedRuntimeRecord(
				{ pid: process.pid, started: "linux:stale-owner" },
				[{ id: "b-reused", supervisor: { pid: process.pid, started: "linux:reused" } }],
				TEST_WORK_AUTHORITY_KEY,
			),
		),
	);
	const result = await reconcileStaleRuns(root, { authorityKey: TEST_WORK_AUTHORITY_KEY });
	expect(result).toEqual({ cleanedDirectories: 1, killedProcesses: 0, unresolvedDirectories: 0 });
	expect(processExists(process.pid)).toBe(true);
	expect(existsSync(directory)).toBe(false);
});

test("kills a verified process group left by a dead owner", async () => {
	if (process.platform !== "linux") return;
	const root = temporaryRoot();
	const directory = join(root, ".pi", "tasks", "pi-stuff-stale-live");
	mkdirSync(directory, { recursive: true });
	const child = spawn("/bin/sh", ["-c", "trap '' TERM HUP INT; while :; do sleep 1; done"], {
		detached: true,
		stdio: "ignore",
	});
	children.push(child);
	if (!child.pid) throw new Error("stale process fixture did not start");
	const childPid = child.pid;
	await waitUntil(() => captureProcessIdentity(childPid) !== undefined);
	const identity = captureProcessIdentity(childPid);
	if (!identity) throw new Error("stale process fixture has no identity");
	writeFileSync(
		join(directory, "runtime.json"),
		JSON.stringify(
			createAuthenticatedRuntimeRecord(
				{ pid: process.pid, started: "linux:dead-owner" },
				[{ id: "b-stale", command: identity, supervisor: identity }],
				TEST_WORK_AUTHORITY_KEY,
			),
		),
	);
	const result = await reconcileStaleRuns(root, { authorityKey: TEST_WORK_AUTHORITY_KEY });
	expect(result.cleanedDirectories).toBe(1);
	expect(result.killedProcesses).toBe(1);
	await waitUntil(() => !processExists(identity.pid));
});

test("retains an authenticated leader-gone group when continuity is unverifiable", async () => {
	if (process.platform !== "linux") return;
	const root = temporaryRoot();
	const directory = join(root, ".pi", "tasks", "pi-stuff-stale-leader-gone");
	mkdirSync(directory, { recursive: true });
	const { childPid, leaderIdentity } = await leaderGoneProcessGroup(root, "reconcile-leader-gone");
	writeFileSync(
		join(directory, "runtime.json"),
		JSON.stringify(
			createAuthenticatedRuntimeRecord(
				{ pid: process.pid, started: "linux:dead-owner" },
				[{ id: "b-leader-gone", command: leaderIdentity, supervisor: leaderIdentity }],
				TEST_WORK_AUTHORITY_KEY,
			),
		),
	);
	const result = await reconcileStaleRuns(root, { authorityKey: TEST_WORK_AUTHORITY_KEY });
	expect(result).toEqual({ cleanedDirectories: 0, killedProcesses: 0, unresolvedDirectories: 1 });
	expect(processExists(childPid)).toBe(true);
	expect(existsSync(directory)).toBe(true);
});

test("never trusts an unsigned repository-preseeded runtime record", async () => {
	const root = temporaryRoot();
	const directory = join(root, ".pi", "tasks", "pi-stuff-preseeded");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "runtime.json"),
		JSON.stringify({
			owner: { pid: process.pid, started: "linux:fake-owner" },
			schemaVersion: 2,
			tasks: [
				{
					id: "forged",
					supervisor: captureProcessIdentity(process.pid),
				},
			],
		}),
	);
	const result = await reconcileStaleRuns(root, { authorityKey: TEST_WORK_AUTHORITY_KEY });
	expect(result).toEqual({ cleanedDirectories: 0, killedProcesses: 0, unresolvedDirectories: 1 });
	expect(processExists(process.pid)).toBe(true);
	expect(existsSync(directory)).toBe(true);
});

test("reaps a TERM-ignoring command tree after its Pi-like parent is killed", async () => {
	if (process.platform !== "linux") return;
	const root = temporaryRoot();
	const readyPath = join(root, "ready.json");
	const treePath = join(root, "tree.txt");
	const fixture = resolve(import.meta.dir, "../../fixtures/work-supervisor-parent.mjs");
	const supervisor = resolve(
		import.meta.dir,
		"../../../packages/pi-stuff/src/background-work/src/process-supervisor.mjs",
	);
	const parent = spawn(process.execPath, [fixture, supervisor, readyPath, treePath], {
		cwd: root,
		stdio: "ignore",
	});
	children.push(parent);
	await waitUntil(() => existsSync(readyPath) && existsSync(treePath));
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const ready = JSON.parse(readFileSync(readyPath, "utf-8")) as {
		commandPid: number;
		parentPid: number;
		supervisorPid: number;
	};
	const treePids = readFileSync(treePath, "utf-8").trim().split(/\s+/u).map(Number);
	expect(treePids).toContain(ready.commandPid);
	for (const pid of [ready.supervisorPid, ...treePids]) expect(processExists(pid)).toBe(true);
	process.kill(ready.parentPid, "SIGKILL");
	await waitUntil(() => [ready.supervisorPid, ...treePids].every((pid) => !processExists(pid)), 10_000);
}, 15_000);
