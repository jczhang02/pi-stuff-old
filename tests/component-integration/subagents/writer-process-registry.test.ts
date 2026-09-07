import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	initializeWriterProcessRegistry,
	inspectWriterProcessLiveness,
	readAuthenticatedGroupMember,
	terminateOrphanWriterProcesses,
	updateWriterProcessRegistry,
	writerProcessRegistryPath,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/writer-process-registry.js";

const roots = new Set<string>();

afterEach(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	roots.clear();
});

function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-writer-registry-"));
	roots.add(root);
	return root;
}

test("authenticates a leader-gone group member from one process snapshot", () => {
	const asyncDir = fixture();
	fs.writeFileSync(
		path.join(asyncDir, "member-proof.json"),
		JSON.stringify({
			version: 1,
			groupLeaderPid: 777,
			groupLeaderProcessStartIdentity: "linux:leader",
			memberPid: 888,
			memberProcessStartIdentity: "linux:member",
		}),
		{ mode: 0o600 },
	);
	const writer = {
		state: "running" as const,
		pid: 777,
		processStartIdentity: "linux:leader",
		groupMemberProofFile: "member-proof.json",
	};
	let reads = 0;
	const member = readAuthenticatedGroupMember(asyncDir, writer, (pid) => {
		reads += 1;
		expect(pid).toBe(888);
		return { processStartIdentity: "linux:member", processGroupId: 777 };
	});

	expect(member).toEqual({ pid: 888, identity: "linux:member" });
	expect(reads).toBe(1);
	expect(
		readAuthenticatedGroupMember(asyncDir, writer, () => ({
			processStartIdentity: "linux:reused-pid",
			processGroupId: 777,
		})),
	).toBeUndefined();
	expect(
		readAuthenticatedGroupMember(asyncDir, writer, () => ({
			processStartIdentity: "linux:member",
			processGroupId: 999,
		})),
	).toBeUndefined();
});

test("treats missing and corrupt registries as unknown instead of proving termination", () => {
	const asyncDir = fixture();
	expect(inspectWriterProcessLiveness(asyncDir)).toBeUndefined();
	expect(terminateOrphanWriterProcesses(asyncDir)).toEqual({ remaining: 1, terminated: 0 });

	fs.writeFileSync(writerProcessRegistryPath(asyncDir), "{not-json", "utf-8");
	expect(inspectWriterProcessLiveness(asyncDir)).toBeUndefined();
	expect(terminateOrphanWriterProcesses(asyncDir)).toEqual({ remaining: 1, terminated: 0 });
});

test("accepts an initialized registry with every writer explicitly absent", () => {
	const asyncDir = fixture();
	initializeWriterProcessRegistry(asyncDir, "run", process.pid, 2);

	expect(inspectWriterProcessLiveness(asyncDir)).toBeFalse();
	expect(terminateOrphanWriterProcesses(asyncDir)).toEqual({ remaining: 0, terminated: 0 });
});

test("never signals a live PID without matching process-start identity", () => {
	const asyncDir = fixture();
	fs.writeFileSync(
		writerProcessRegistryPath(asyncDir),
		JSON.stringify({
			version: 1,
			runId: "run",
			runnerPid: process.pid,
			updatedAt: Date.now(),
			writers: { "0": { state: "running", pid: 999_999, processStartIdentity: "unavailable-now" } },
		}),
		"utf-8",
	);
	const signals: Array<NodeJS.Signals | 0 | undefined> = [];
	const fakeKill = (_pid: number, signal?: NodeJS.Signals | 0): boolean => {
		signals.push(signal);
		return true;
	};

	expect(inspectWriterProcessLiveness(asyncDir, fakeKill)).toBeUndefined();
	expect(terminateOrphanWriterProcesses(asyncDir, fakeKill)).toEqual({ remaining: 1, terminated: 0 });
	expect(signals.every((signal) => signal === 0)).toBeTrue();
});

test("never signals group records with missing, mismatched, or leader-gone identity evidence", () => {
	for (const [name, writer] of [
		["missing", { state: "running", pid: 999_991 }],
		["mismatch", { state: "running", pid: process.pid, processStartIdentity: "linux:not-this-process" }],
		["leader-gone", { state: "running", pid: 999_992, processStartIdentity: "linux:old-writer" }],
	] as const) {
		const asyncDir = fixture();
		fs.writeFileSync(
			writerProcessRegistryPath(asyncDir),
			JSON.stringify({
				version: 1,
				runId: name,
				runnerPid: process.pid,
				writerStartupGate: "parent-pipe-v1",
				writerProcessGroup: "writer-pid-v1",
				updatedAt: Date.now(),
				writers: { "0": writer },
			}),
			"utf-8",
		);
		const signals: Array<NodeJS.Signals | 0 | undefined> = [];
		const fakeKill = (_pid: number, signal?: NodeJS.Signals | 0): boolean => {
			signals.push(signal);
			return true;
		};
		terminateOrphanWriterProcesses(asyncDir, fakeKill);
		expect(signals.every((signal) => signal === 0)).toBeTrue();
	}
});

test("retains a signalled supervisor until the next probe proves it exited", () => {
	const asyncDir = fixture();
	initializeWriterProcessRegistry(asyncDir, "run", process.pid, 1);
	updateWriterProcessRegistry(asyncDir, 0, { state: "running", pid: process.pid });

	let exited = false;
	const signals: Array<NodeJS.Signals | 0 | undefined> = [];
	const fakeKill = (_pid: number, signal?: NodeJS.Signals | 0): boolean => {
		signals.push(signal);
		if (signal === 0 && exited) throw Object.assign(new Error("gone"), { code: "ESRCH" });
		if (signal === "SIGTERM") exited = true;
		return true;
	};

	expect(terminateOrphanWriterProcesses(asyncDir, fakeKill)).toEqual({ remaining: 1, terminated: 1 });
	expect(JSON.parse(fs.readFileSync(writerProcessRegistryPath(asyncDir), "utf-8")).writers["0"].state).toBe("running");
	expect(terminateOrphanWriterProcesses(asyncDir, fakeKill)).toEqual({ remaining: 0, terminated: 0 });
	expect(JSON.parse(fs.readFileSync(writerProcessRegistryPath(asyncDir), "utf-8")).writers["0"].state).toBe("none");
	expect(signals.filter((signal) => signal === "SIGTERM")).toHaveLength(1);
	expect(signals).not.toContain("SIGKILL");
	expect(signals.every((signal) => signal === 0 || signal === "SIGTERM")).toBeTrue();
});
