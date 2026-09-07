import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { parseJsonValue } from "../../shared/json-value.ts";
import { isRuntimeFunction, isRuntimeObject } from "../../shared/runtime-type.ts";

const MAX_COMMAND_AUTHORIZATION_BYTES = 4 * 1024 * 1024;
const SUPERVISOR_POST_EXIT_DRAIN_MS = 500;
const SUPERVISOR_PATH = fileURLToPath(new URL("./process-supervisor.mjs", import.meta.url));

export interface ProcessIdentity {
	readonly pid: number;
	readonly started: string;
}

export interface SupervisorProcess {
	closeControl(): void;
	readonly completion: Promise<{
		readonly code: number | null;
		readonly error?: Error;
		readonly signal: NodeJS.Signals | null;
	}>;
	readonly control: Readable;
	readonly output: Readable;
	readonly pid: number;
	kill(signal: NodeJS.Signals): void;
	unref(): void;
}

export type SignalVerifiedSupervisor = (
	supervisor: SupervisorProcess,
	identity: ProcessIdentity,
	signal: NodeJS.Signals,
) => "gone" | "requested" | "unresolved";

export function resolveSupervisorExecutable(override: string | undefined): string {
	if (override) return override;
	// The supervisor is plain ESM. Prefer Node's mature concurrent child-process
	// pipe implementation; Bun remains a portable fallback for Bun-only hosts.
	const executable = Bun.which("node") ?? Bun.which("bun");
	if (!executable) throw new Error("Background Work requires Node.js or Bun on PATH to run its process supervisor");
	return executable;
}

export function spawnSupervisor(
	executable: string,
	envelope: string,
	options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
): SupervisorProcess {
	const subprocess = Bun.spawn({
		cmd: [executable, SUPERVISOR_PATH, envelope],
		cwd: options.cwd,
		detached: process.platform !== "win32",
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (!subprocess.pid) {
		subprocess.kill("SIGKILL");
		subprocess.unref();
		throw new Error("Background Work supervisor pipes were not created");
	}
	const control = Readable.fromWeb(subprocess.stdout);
	// The supervisor reserves stdout for control and merges command output onto stderr.
	const output = Readable.fromWeb(subprocess.stderr);
	const closeControl = () => {
		if (!control.destroyed) control.destroy();
	};
	const streamCompletion = Promise.all([
		finished(output, { cleanup: true }).catch(() => undefined),
		finished(control, { cleanup: true }).catch(() => undefined),
	]);
	const completion = subprocess.exited.then(async () => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const drained = await Promise.race([
			streamCompletion.then(() => true),
			new Promise<false>((resolve) => {
				timer = setTimeout(() => resolve(false), SUPERVISOR_POST_EXIT_DRAIN_MS);
			}),
		]);
		if (timer) clearTimeout(timer);
		if (!drained) {
			// A detached grandchild may inherit the supervisor's output descriptor
			// after both the command shell and supervisor have exited.
			// Process exit is authoritative; never let foreign pipe ownership keep a
			// completed Work task alive forever.
			output.destroy();
			closeControl();
		}
		return { code: subprocess.exitCode, signal: subprocess.signalCode };
	});
	return {
		closeControl,
		completion,
		control,
		output,
		pid: subprocess.pid,
		kill: (signal) => subprocess.kill(signal),
		unref: () => subprocess.unref(),
	};
}

export function signalVerifiedSupervisor(
	supervisor: SupervisorProcess,
	identity: ProcessIdentity,
	signal: NodeJS.Signals,
): "gone" | "requested" | "unresolved" {
	if (!identityMatches(identity)) return "gone";
	try {
		// Signal only the still-authenticated supervisor. It remains the process
		// group leader while it escalates and reaps descendants; a group-wide
		// SIGKILL here would destroy that sole durable authority first.
		supervisor.kill(signal);
		return "requested";
	} catch {
		return identityMatches(identity) ? "unresolved" : "gone";
	}
}

export async function abandonSupervisorAndWait(supervisor: SupervisorProcess): Promise<void> {
	try {
		supervisor.kill("SIGKILL");
	} catch {
		// The exact subprocess may already have exited.
	}
	supervisor.output.destroy();
	supervisor.closeControl();
	supervisor.unref();
	await supervisor.completion;
}

export function publishCommandAuthorization(filePath: string, token: string, command: string): void {
	const content = `${JSON.stringify({ version: 1, token, command })}\n`;
	if (Buffer.byteLength(content, "utf-8") > MAX_COMMAND_AUTHORIZATION_BYTES) {
		throw new Error(
			`Background Work command exceeds the ${formatSize(MAX_COMMAND_AUTHORIZATION_BYTES)} transport limit`,
		);
	}
	const temporary = `${filePath}.${randomBytes(6).toString("hex")}.tmp`;
	try {
		writeFileSync(temporary, content, { encoding: "utf-8", flag: "wx", mode: 0o600 });
		renameSync(temporary, filePath);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export function consumeCommandAcknowledgement(
	filePath: string,
	token: string,
	supervisorIdentity: ProcessIdentity,
): boolean {
	try {
		const stat = lstatSync(filePath);
		const currentUid = isRuntimeFunction(process.getuid) ? process.getuid() : undefined;
		if (
			stat.isSymbolicLink() ||
			!stat.isFile() ||
			stat.size <= 0 ||
			stat.size > 8 * 1024 ||
			(stat.mode & 0o077) !== 0 ||
			(currentUid !== undefined && stat.uid !== currentUid)
		) {
			throw new Error("Background Work command acknowledgement is not a private bounded regular file.");
		}
		const payload = parseJsonValue(readFileSync(filePath, "utf-8"));
		if (
			!isRuntimeObject(payload) ||
			payload === null ||
			Array.isArray(payload) ||
			payload["version"] !== 1 ||
			payload["token"] !== token ||
			payload["supervisorPid"] !== supervisorIdentity.pid ||
			payload["supervisorStarted"] !== supervisorIdentity.started
		) {
			throw new Error("Background Work command acknowledgement does not match its supervisor authority.");
		}
		rmSync(filePath, { force: true });
		return true;
	} catch (cause) {
		if (cause && isRuntimeObject(cause) && "code" in cause && cause.code === "ENOENT") return false;
		throw cause;
	}
}

function errorCode(cause: unknown): string | undefined {
	return cause && isRuntimeObject(cause) && "code" in cause ? String(cause.code) : undefined;
}

/** Stable enough to distinguish a live process from a reused PID. */
export function processStartIdentity(pid: number): string | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
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
	if (process.platform === "darwin" || process.platform === "freebsd") {
		const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
			encoding: "utf-8",
		});
		const started = result.status === 0 ? result.stdout.trim() : "";
		return started ? `${process.platform}:${started}` : undefined;
	}
	return undefined;
}

export function captureProcessIdentity(pid: number): ProcessIdentity | undefined {
	const started = processStartIdentity(pid);
	return started ? { pid, started } : undefined;
}

/**
 * Newly spawned processes can exist briefly before their platform start marker
 * is readable. Retry that observation before deciding launch authority is
 * unavailable; never substitute the numeric PID itself as authority.
 */
export async function captureProcessIdentityWithRetry(
	pid: number,
	timeoutMs = 250,
	deps: {
		readonly capture?: (pid: number) => ProcessIdentity | undefined;
		readonly exists?: (pid: number) => boolean;
		readonly now?: () => number;
		readonly wait?: (milliseconds: number) => Promise<void>;
	} = {},
): Promise<ProcessIdentity | undefined> {
	const capture = deps.capture ?? captureProcessIdentity;
	const exists = deps.exists ?? processExists;
	const now = deps.now ?? Date.now;
	const wait = deps.wait ?? ((milliseconds: number) => Bun.sleep(milliseconds));
	const deadline = now() + Math.max(0, timeoutMs);
	for (;;) {
		const identity = capture(pid);
		if (identity) return identity;
		const remaining = deadline - now();
		if (remaining <= 0 || !exists(pid)) return undefined;
		await wait(Math.min(20, remaining));
	}
}

export function identityMatches(identity: ProcessIdentity): boolean {
	return processStartIdentity(identity.pid) === identity.started;
}

export function processExists(pid: number): boolean {
	if (!Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function processGroupExists(pgid: number): boolean {
	if (!Number.isSafeInteger(pgid) || pgid <= 0 || process.platform === "win32") return false;
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

export function signalProcessGroup(pgid: number, signal: NodeJS.Signals): boolean {
	if (!Number.isSafeInteger(pgid) || pgid <= 0) return false;
	try {
		process.kill(process.platform === "win32" ? pgid : -pgid, signal);
		return true;
	} catch {
		// On Unix, a failed group signal must never fall back to +pid: the
		// leader may have exited and that numeric PID may now name an unrelated
		// process. Windows has no negative process-group target.
		return false;
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Stop a process tree whose leader identity has already been verified.
 * Re-verify the leader before every destructive signal. A numeric process-group
 * id is not durable authority after the original leader disappears.
 */
export async function terminateVerifiedProcessGroup(
	identity: ProcessIdentity,
	graceMs = 1_500,
): Promise<"identity-mismatch" | "killed" | "stopped" | "unresolved"> {
	if (!identityMatches(identity)) {
		const currentIdentity = processStartIdentity(identity.pid);
		if (currentIdentity !== undefined || processExists(identity.pid)) return "identity-mismatch";
		// A stale numeric PGID cannot prove that the original group existed
		// continuously; it may have disappeared and been reused before recovery.
		return processGroupExists(identity.pid) ? "unresolved" : "identity-mismatch";
	}
	signalProcessGroup(identity.pid, "SIGTERM");
	const deadline = Date.now() + Math.max(0, graceMs);
	while (Date.now() < deadline) {
		if (!processGroupExists(identity.pid)) return "stopped";
		await delay(Math.min(50, Math.max(1, deadline - Date.now())));
	}
	if (!processGroupExists(identity.pid)) return "stopped";
	if (!identityMatches(identity)) {
		return processGroupExists(identity.pid) ? "unresolved" : "stopped";
	}
	signalProcessGroup(identity.pid, "SIGKILL");
	const killDeadline = Date.now() + Math.max(500, Math.min(2_000, graceMs));
	while (Date.now() < killDeadline) {
		if (!processGroupExists(identity.pid)) return "killed";
		await delay(Math.min(50, Math.max(1, killDeadline - Date.now())));
	}
	return processGroupExists(identity.pid) ? "unresolved" : "killed";
}

/** Clean descendants without ever transferring authority to a reused numeric PID. */
export async function reapOwnedProcessGroup(identity: ProcessIdentity, graceMs = 150): Promise<void> {
	const outcome = await terminateVerifiedProcessGroup(identity, graceMs);
	if (outcome === "unresolved") {
		throw new Error(`Process group ${identity.pid} remained alive or unverifiable after SIGKILL.`);
	}
}
