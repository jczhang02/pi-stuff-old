import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { waitForDetachedProcess } from "../../../scripts/detached-process.js";

const ERRNO_SCHEMA = Type.Object({ code: Type.Optional(Type.String()) }, { additionalProperties: true });
const PROCESS_RECORD_SCHEMA = Type.Object({ childPid: Type.Number(), parentPid: Type.Number() });

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return Check(ERRNO_SCHEMA, error) && error.code === "EPERM";
	}
}

async function readProcessRecord(path: string): Promise<{ readonly childPid: number; readonly parentPid: number }> {
	const deadline = Date.now() + 2_000;
	while (Date.now() < deadline) {
		const contents = await readFile(path, "utf8").catch(() => "");
		if (contents) {
			const record = JSON.parse(contents);
			if (Check(PROCESS_RECORD_SCHEMA, record)) return record;
			throw new Error("Detached process fixture published malformed process ids");
		}
		await Bun.sleep(20);
	}
	throw new Error("Detached process fixture did not publish its process ids");
}

async function waitForProcessExit(pid: number): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (processExists(pid) && Date.now() < deadline) await Bun.sleep(20);
	if (processExists(pid)) throw new Error(`Process ${String(pid)} survived group cleanup`);
}

test("timeout cleanup terminates the detached leader and a TERM-ignoring descendant", async () => {
	if (process.platform === "win32") return;
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-detached-process-"));
	const recordPath = join(directory, "processes.json");
	const fixture = resolve(import.meta.dir, "../../fixtures/detached-process-parent.mjs");
	const parent = Bun.spawn([process.execPath, fixture, recordPath], {
		detached: true,
		stderr: "ignore",
		stdin: "ignore",
		stdout: "ignore",
	});
	try {
		const record = await readProcessRecord(recordPath);
		const result = await waitForDetachedProcess(parent, 50, 50);
		expect(result.timedOut).toBe(true);
		await Promise.all([waitForProcessExit(record.parentPid), waitForProcessExit(record.childPid)]);
	} finally {
		try {
			process.kill(-parent.pid, "SIGKILL");
		} catch {
			// The expected cleanup path has already removed the group.
		}
		await rm(directory, { force: true, recursive: true });
	}
});

test("normal leader exit drains descendants that retain output pipes", async () => {
	if (process.platform === "win32") return;
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-detached-process-"));
	const recordPath = join(directory, "processes.json");
	const fixture = resolve(import.meta.dir, "../../fixtures/detached-process-parent.mjs");
	const parent = Bun.spawn([process.execPath, fixture, recordPath, "exit-after-spawn"], {
		detached: true,
		stderr: "pipe",
		stdin: "ignore",
		stdout: "pipe",
	});
	try {
		const record = await readProcessRecord(recordPath);
		const [{ exitCode, timedOut }] = await Promise.race([
			Promise.all([
				waitForDetachedProcess(parent, 2_000, 50),
				new Response(parent.stdout).text(),
				new Response(parent.stderr).text(),
			]),
			Bun.sleep(2_000).then(() => {
				throw new Error("Inherited output pipes did not reach EOF");
			}),
		]);
		expect(exitCode).toBe(0);
		expect(timedOut).toBe(false);
		await Promise.all([waitForProcessExit(record.parentPid), waitForProcessExit(record.childPid)]);
	} finally {
		try {
			process.kill(-parent.pid, "SIGKILL");
		} catch {
			// The expected cleanup path has already removed the group.
		}
		await rm(directory, { force: true, recursive: true });
	}
});
