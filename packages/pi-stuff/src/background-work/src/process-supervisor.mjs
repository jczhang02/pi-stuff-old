import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { Guard } from "typebox/guard";

const MAX_COMMAND_AUTHORIZATION_BYTES = 4 * 1024 * 1024;

function isRuntimeNumber(value) {
	return (
		Guard.IsNumber(value) ||
		Object.is(value, Number.NaN) ||
		Object.is(value, Number.POSITIVE_INFINITY) ||
		Object.is(value, Number.NEGATIVE_INFINITY)
	);
}

function processStartIdentity(pid) {
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd === -1) return undefined;
			const startTicks = stat
				.slice(commandEnd + 1)
				.trim()
				.split(/\s+/u)[19];
			return startTicks ? `linux:${startTicks}` : undefined;
		} catch {
			return undefined;
		}
	}
	if (process.platform !== "darwin" && process.platform !== "freebsd") return undefined;
	const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
	const started = result.status === 0 ? result.stdout.trim() : "";
	return started ? `${process.platform}:${started}` : undefined;
}

function processExists(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error && Guard.IsObject(error) && error.code === "EPERM";
	}
}

function linuxCommandGroupMembers() {
	if (process.platform !== "linux") return [];
	const members = [];
	for (const entry of readdirSync("/proc", { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue;
		const pid = Number(entry.name);
		if (pid === process.pid) continue;
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd === -1) continue;
			const fields = stat
				.slice(commandEnd + 1)
				.trim()
				.split(/\s+/u);
			if (Number(fields[2]) !== process.pid) continue;
			const started = fields[19];
			if (started) members.push({ pid, started: `linux:${started}` });
		} catch (error) {
			// ENOENT means this particular process exited between readdir and stat.
			// Any other failure makes the whole group scan inconclusive.
			if (!error || !Guard.IsObject(error) || (error.code !== "ENOENT" && error.code !== "ESRCH")) throw error;
		}
	}
	return members;
}

function bsdCommandGroupMembers() {
	if (process.platform !== "darwin" && process.platform !== "freebsd") return [];
	const result = spawnSync("/bin/ps", ["-axo", "pid=,pgid=,lstart="], {
		encoding: "utf-8",
		maxBuffer: 8 * 1024 * 1024,
	});
	if (result.error || result.status !== 0) {
		throw (
			result.error ??
			new Error(`Unable to inspect Background Work process group (ps exited ${String(result.status)}).`)
		);
	}
	const members = [];
	for (const line of result.stdout.split(/\r?\n/u)) {
		const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
		if (!match) continue;
		const pid = Number(match[1]);
		const pgid = Number(match[2]);
		const started = match[3];
		if (pid === process.pid || pgid !== process.pid || !started) continue;
		members.push({ pid, started: `${process.platform}:${started}` });
	}
	return members;
}

function commandGroupMembers() {
	if (process.platform === "linux") return linuxCommandGroupMembers();
	if (process.platform === "darwin" || process.platform === "freebsd") return bsdCommandGroupMembers();
	return child.pid && childStarted ? [{ pid: child.pid, started: childStarted }] : [];
}

function signalCommandGroupMembers(signal) {
	let members;
	try {
		members = commandGroupMembers();
	} catch {
		return false;
	}
	for (const member of members) {
		if (processStartIdentity(member.pid) !== member.started) continue;
		try {
			process.kill(member.pid, signal);
		} catch {
			// The member may have exited after the final identity check.
		}
	}
	return true;
}

function delay(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function stdinText() {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf-8");
}

const [, , encoded] = process.argv;
if (!encoded) throw new Error("Pi Stuff Work supervisor requires a launch envelope");
const envelope = JSON.parse(Buffer.from(encoded, "base64url").toString("utf-8"));
const control = process.stdout;
let controlAvailable = true;

control.on("error", () => {
	controlAvailable = false;
});

function report(value) {
	if (!controlAvailable || control.destroyed) return;
	try {
		control.write(`${JSON.stringify(value)}\n`);
	} catch {
		controlAvailable = false;
	}
}

function parentStillOwnsUs() {
	return processStartIdentity(envelope.parentPid) === envelope.parentStarted;
}

function writeCommandAcknowledgement() {
	if (!Guard.IsString(envelope.commandAcknowledgementPath) || !envelope.commandAcknowledgementPath) return;
	const supervisorStarted = processStartIdentity(process.pid);
	if (!supervisorStarted) throw new Error("Background Work supervisor lost its process-start identity.");
	const temporary = `${envelope.commandAcknowledgementPath}.${process.pid}.tmp`;
	writeFileSync(
		temporary,
		`${JSON.stringify({
			version: 1,
			token: envelope.commandAuthorizationToken,
			supervisorPid: process.pid,
			supervisorStarted,
		})}\n`,
		{ encoding: "utf-8", flag: "wx", mode: 0o600 },
	);
	renameSync(temporary, envelope.commandAcknowledgementPath);
}

async function commandAuthorizationText() {
	if (!Guard.IsString(envelope.commandAuthorizationPath) || !envelope.commandAuthorizationPath) {
		// Compatibility for a parent from before the regular-file transport.
		return stdinText();
	}
	if (!Guard.IsString(envelope.commandAuthorizationToken) || !envelope.commandAuthorizationToken) {
		throw new Error("Background Work command authorization token is missing.");
	}
	for (;;) {
		if (!parentStillOwnsUs()) throw new Error("Background Work parent exited before command authorization.");
		try {
			const stat = lstatSync(envelope.commandAuthorizationPath);
			const currentUid = Guard.IsFunction(process.getuid) ? process.getuid() : undefined;
			if (
				stat.isSymbolicLink() ||
				!stat.isFile() ||
				stat.size <= 0 ||
				stat.size > MAX_COMMAND_AUTHORIZATION_BYTES ||
				(stat.mode & 0o077) !== 0 ||
				(currentUid !== undefined && stat.uid !== currentUid)
			) {
				throw new Error("Background Work command authorization is not a private bounded regular file.");
			}
			const payload = JSON.parse(readFileSync(envelope.commandAuthorizationPath, "utf-8"));
			if (
				payload?.version !== 1 ||
				payload.token !== envelope.commandAuthorizationToken ||
				!Guard.IsString(payload.command) ||
				Buffer.byteLength(payload.command, "utf-8") > MAX_COMMAND_AUTHORIZATION_BYTES
			) {
				throw new Error("Background Work command authorization is invalid.");
			}
			unlinkSync(envelope.commandAuthorizationPath);
			writeCommandAcknowledgement();
			return payload.command;
		} catch (error) {
			if (error && Guard.IsObject(error) && error.code === "ENOENT") {
				await delay(20);
				continue;
			}
			throw error;
		}
	}
}

let command;
report({ type: "ready" });
try {
	command = await commandAuthorizationText();
} catch (error) {
	report({ type: "spawn-error", message: error instanceof Error ? error.message : String(error) });
	if (controlAvailable && !control.destroyed) control.end();
	await delay(25);
	process.exit(125);
}
// The parent may now safely expose the activity or lose/recreate its runtime
// directory: this supervisor has consumed the complete authenticated command.
report({ type: "authorized" });

const args = [...envelope.shellArgs];
if (envelope.commandTransport !== "stdin") args.push(command);
const child = spawn(envelope.shell, args, {
	cwd: envelope.cwd,
	// The supervisor is already a detached process-group leader. Keep the user
	// shell and every descendant in that anchored group so the numeric PGID can
	// never be reused while this supervisor is alive.
	detached: false,
	env: process.env,
	stdio: [envelope.commandTransport === "stdin" ? "pipe" : "ignore", 2, 2],
	windowsHide: true,
});

let stopping = false;
let settled = false;
let forceTimer;
let parentTimer;
let childStarted;
// The parent does not release command input until it has captured and durably
// persisted this supervisor's process-start identity. The still-live supervisor
// is therefore continuous authority for its own group before the short-lived
// command child's identity becomes observable.
const spawnedGroupAuthorized = true;

function stopChild(reason) {
	if (stopping) return;
	stopping = true;
	report({ type: "stopping", reason });
	if (spawnedGroupAuthorized) signalCommandGroupMembers("SIGTERM");
	forceTimer = setTimeout(() => {
		if (spawnedGroupAuthorized) signalCommandGroupMembers("SIGKILL");
	}, 1_500);
}

async function settle(code, signal) {
	if (settled) return;
	settled = true;
	if (parentTimer) clearInterval(parentTimer);
	if (forceTimer) clearTimeout(forceTimer);
	if (spawnedGroupAuthorized) {
		let termRequested = false;
		let nextKillAt = 0;
		for (;;) {
			let members;
			try {
				members = commandGroupMembers();
			} catch {
				// A transient /proc or ps failure cannot prove the group empty. Keep
				// this authenticated PGID leader alive and retry instead of abandoning
				// the only authority that can safely signal the descendants later.
				await delay(250);
				continue;
			}
			if (members.length === 0) break;
			if (!termRequested) {
				signalCommandGroupMembers("SIGTERM");
				termRequested = true;
				await delay(150);
				continue;
			}
			if (Date.now() >= nextKillAt) {
				signalCommandGroupMembers("SIGKILL");
				nextKillAt = Date.now() + 1_000;
			}
			await delay(100);
		}
	}
	report({ type: "exit", code, signal, groupReaped: true });
	const exitCode = isRuntimeNumber(code) ? code : signal ? 128 : 1;
	process.exitCode = exitCode;
	if (controlAvailable && !control.destroyed) control.end();
	setTimeout(() => process.exit(exitCode), 25);
}

child.once("spawn", () => {
	void (async () => {
		const deadline = Date.now() + 250;
		do {
			childStarted = child.pid ? processStartIdentity(child.pid) : undefined;
			if (childStarted) break;
			if (!child.pid || !processExists(child.pid) || Date.now() >= deadline) break;
			await delay(20);
		} while (!settled);
		if (settled) return;
		if (!child.pid || !childStarted) {
			try {
				child.kill("SIGKILL");
			} catch {}
			signalCommandGroupMembers("SIGKILL");
			report({ type: "spawn-error", message: "Cannot establish a stable command process identity." });
			await settle(null, "SIGKILL");
			return;
		}
		if (envelope.commandTransport === "stdin") {
			child.stdin?.on("error", () => {});
			child.stdin?.end(command);
		}
		report({
			type: "started",
			pid: child.pid,
			started: childStarted,
			groupPid: process.pid,
			groupStarted: processStartIdentity(process.pid),
		});
		if (stopping) signalCommandGroupMembers("SIGTERM");
		parentTimer = setInterval(() => {
			if (!parentStillOwnsUs()) stopChild("parent-exited");
		}, 250);
	})();
});

child.once("error", (error) => {
	report({ type: "spawn-error", message: error instanceof Error ? error.message : String(error) });
	void settle(null, null);
});

child.once("exit", (code, signal) => {
	void settle(code, signal);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
	process.on(signal, () => stopChild(`supervisor-${signal.toLowerCase()}`));
}

if (!parentStillOwnsUs()) stopChild("parent-exited-before-launch");
