import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readProcessStartIdentity } from "../../../packages/pi-stuff/src/subagents/src/shared/process-identity.js";
import { uiPtyOwnerMatches, uiPtyOwnerState } from "../../../scripts/ui-pty-owner-watchdog.js";

interface WatchdogRecord {
	readonly ownerPid: number;
	readonly panePid: number;
	readonly serverPid: number;
	readonly watchdogPid: number;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error instanceof Error && "code" in error && error.code === "EPERM";
	}
}

async function waitForRecord(path: string): Promise<WatchdogRecord> {
	const deadline = Date.now() + 3_000;
	while (Date.now() < deadline) {
		const value = await readFile(path, "utf8").catch(() => "");
		if (value) {
			// SAFETY: the spawned watchdog fixture owns this JSON file and writes every WatchdogRecord field before signaling readiness.
			return JSON.parse(value) as WatchdogRecord;
		}
		await Bun.sleep(20);
	}
	throw new Error("UI PTY watchdog fixture did not become ready");
}

async function waitForCleanup(socket: string, pids: readonly number[]): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const probe = Bun.spawnSync(["tmux", "-S", socket, "has-session"], {
			stderr: "ignore",
			stdout: "ignore",
		});
		if (probe.exitCode !== 0 && pids.every((pid) => !processExists(pid))) return;
		await Bun.sleep(20);
	}
	throw new Error(`owner-death cleanup left processes alive: ${pids.filter(processExists).join(", ")}`);
}

test("distinguishes a live owner from a reused process id", () => {
	const identity = readProcessStartIdentity(process.pid);
	if (!identity) return;
	expect(uiPtyOwnerMatches(process.pid, identity)).toBe(true);
	expect(uiPtyOwnerMatches(process.pid, `${identity}-different-generation`)).toBe(false);
});

test("keeps an unreadable but demonstrably live owner in an unknown state", () => {
	expect(
		uiPtyOwnerState(
			process.pid,
			"expected-generation",
			() => undefined,
			() => true,
		),
	).toBe("unknown");
	expect(
		uiPtyOwnerState(
			process.pid,
			"expected-generation",
			() => undefined,
			() => false,
		),
	).toBe("gone");
});

test("kills only the isolated tmux server after its verification owner is SIGKILLed", async () => {
	if (process.platform !== "linux") return;
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-ui-pty-watchdog-"));
	const recordPath = join(directory, "record.json");
	const socket = join(directory, "isolated.sock");
	const stubbornTmux = join(directory, "stubborn-tmux");
	await writeFile(
		stubbornTmux,
		'#!/bin/sh\nfor argument in "$@"; do\n  if [ "$argument" = "kill-server" ]; then exit 0; fi\ndone\nexec /usr/bin/tmux "$@"\n',
	);
	await chmod(stubbornTmux, 0o700);
	const fixture = resolve(import.meta.dir, "../../fixtures/ui-pty-watchdog-owner.ts");
	const owner = Bun.spawn([process.execPath, fixture, recordPath, socket, stubbornTmux], {
		stderr: "pipe",
		stdin: "ignore",
		stdout: "pipe",
	});
	let record: WatchdogRecord | undefined;
	try {
		record = await waitForRecord(recordPath);
		const unrelatedIdentity = readProcessStartIdentity(process.pid);
		process.kill(record.ownerPid, "SIGKILL");
		await owner.exited;
		await waitForCleanup(socket, [record.panePid, record.serverPid, record.watchdogPid]);
		expect(readProcessStartIdentity(process.pid)).toBe(unrelatedIdentity);
	} finally {
		Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { stderr: "ignore", stdout: "ignore" });
		for (const pid of record
			? [record.ownerPid, record.panePid, record.serverPid, record.watchdogPid]
			: [owner.pid]) {
			if (!processExists(pid)) continue;
			try {
				process.kill(pid, "SIGKILL");
			} catch {
				// The fixture or its isolated descendants have already exited.
			}
		}
		await rm(directory, { force: true, recursive: true });
	}
}, 10_000);
