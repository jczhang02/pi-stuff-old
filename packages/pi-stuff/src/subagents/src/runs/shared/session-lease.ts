import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type JsonObject, type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { createAtomicJsonWriter } from "../../shared/atomic-json.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";

export const SESSION_LEASES_DIR = path.join(TEMP_ROOT_DIR, "session-leases");

export interface SessionLeaseRequest {
	sessionFile: string;
	/** Runtime directory containing the authenticated writer-process registry. */
	asyncDir: string;
	runId: string;
	sourceRunId: string;
	parentSessionId?: string;
}

export type SessionLeaseIntent = Omit<SessionLeaseRequest, "asyncDir">;

export interface SessionLeaseOwner {
	version: 1;
	token: string;
	canonicalSessionFile: string;
	runId: string;
	sourceRunId: string;
	parentSessionId?: string;
	pid: number;
	hostname: string;
	processStartIdentity?: string;
	writerState: "none" | "spawning" | "running";
	writerStartupGate?: "parent-pipe-v1";
	writerPid?: number;
	writerProcessStartIdentity?: string;
	/** Added compatibly to v1 owners; missing legacy values are never stale-reclaimed. */
	asyncDir?: string;
	acquiredAt: string;
	acquiredAtMs: number;
	updatedAtMs: number;
}

export interface SessionLeaseHandle {
	leaseDir: string;
	owner: SessionLeaseOwner;
	updateWriter(writer: { state: "none" | "spawning" } | { state: "running"; pid: number }): void;
	release(): boolean;
}

export type SessionLeaseState =
	| { state: "free"; canonicalSessionFile: string; canonicalSessionId: string }
	| { state: "owned"; canonicalSessionFile: string; canonicalSessionId: string; owner: SessionLeaseOwner }
	| { state: "unreadable"; canonicalSessionFile: string; canonicalSessionId: string };

interface SessionLeaseOptions {
	rootDir?: string;
	now?: () => number;
	token?: () => string;
	pid?: number;
	hostname?: string;
	processStartIdentity?: string;
	isProcessAlive?: (pid: number) => boolean | undefined;
	getProcessStartIdentity?: (pid: number) => string | undefined;
	inspectWriterLiveness?: (asyncDir: string) => boolean | undefined;
}

export class SessionLeaseConflictError extends Error {
	readonly owner?: SessionLeaseOwner | undefined;

	constructor(message: string, owner?: SessionLeaseOwner) {
		super(message);
		this.name = "SessionLeaseConflictError";
		this.owner = owner;
	}
}

function getProcessStartIdentity(pid: number): string | undefined {
	if (process.platform === "linux") {
		try {
			const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
			const commandEnd = stat.lastIndexOf(")");
			if (commandEnd === -1) return undefined;
			const fields = stat
				.slice(commandEnd + 1)
				.trim()
				.split(/\s+/);
			const startTicks = fields[19];
			return startTicks ? `linux:${startTicks}` : undefined;
		} catch {
			return undefined;
		}
	}
	if (process.platform === "darwin" || process.platform === "freebsd") {
		const result = spawnSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" });
		const started = result.status === 0 ? result.stdout.trim() : "";
		return started ? `${process.platform}:${started}` : undefined;
	}
	return undefined;
}

function processIsAlive(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = error !== null && isRuntimeObject(error) && "code" in error ? error.code : undefined;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return undefined;
	}
}

export function canonicalSessionFilePath(sessionFile: string): string {
	return fs.realpathSync.native(path.resolve(sessionFile));
}

export function canonicalSessionId(sessionFile: string): string {
	const canonical = canonicalSessionFilePath(sessionFile);
	const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
	return createHash("sha256").update(key).digest("hex");
}

export function sessionLeaseDir(sessionFile: string, rootDir = SESSION_LEASES_DIR): string {
	return path.join(rootDir, canonicalSessionId(sessionFile));
}

export function inspectSessionLease(sessionFile: string, rootDir = SESSION_LEASES_DIR): SessionLeaseState {
	const canonicalSessionFile = canonicalSessionFilePath(sessionFile);
	const canonicalSessionIdValue = canonicalSessionId(canonicalSessionFile);
	const leaseDir = path.join(rootDir, canonicalSessionIdValue);
	if (!fs.existsSync(leaseDir))
		return { state: "free", canonicalSessionFile, canonicalSessionId: canonicalSessionIdValue };
	const owner = readLeaseOwner(leaseDir);
	return owner
		? { state: "owned", canonicalSessionFile, canonicalSessionId: canonicalSessionIdValue, owner }
		: { state: "unreadable", canonicalSessionFile, canonicalSessionId: canonicalSessionIdValue };
}

function isJsonObject(value: JsonValue): value is JsonObject {
	return value !== null && isRuntimeObject(value) && !Array.isArray(value);
}

function parseOwner(value: JsonValue): SessionLeaseOwner | undefined {
	if (!isJsonObject(value)) return undefined;
	const version = value["version"];
	const token = value["token"];
	const canonicalSessionFile = value["canonicalSessionFile"];
	const runId = value["runId"];
	const sourceRunId = value["sourceRunId"];
	const parentSessionId = value["parentSessionId"];
	const pid = value["pid"];
	const hostname = value["hostname"];
	const processStartIdentity = value["processStartIdentity"];
	const writerState = value["writerState"];
	const writerStartupGate = value["writerStartupGate"];
	const writerPid = value["writerPid"];
	const writerProcessStartIdentity = value["writerProcessStartIdentity"];
	const asyncDir = value["asyncDir"];
	const acquiredAt = value["acquiredAt"];
	const acquiredAtMs = value["acquiredAtMs"];
	const updatedAtMs = value["updatedAtMs"];
	if (
		version !== 1 ||
		!isRuntimeString(token) ||
		!isRuntimeString(canonicalSessionFile) ||
		!isRuntimeString(runId) ||
		!isRuntimeString(sourceRunId) ||
		!isRuntimeNumber(pid) ||
		!Number.isInteger(pid) ||
		pid <= 0 ||
		!isRuntimeString(hostname) ||
		(writerState !== "none" && writerState !== "spawning" && writerState !== "running") ||
		!isRuntimeString(acquiredAt) ||
		!isRuntimeNumber(acquiredAtMs) ||
		!isRuntimeNumber(updatedAtMs)
	)
		return undefined;
	if (parentSessionId !== undefined && !isRuntimeString(parentSessionId)) return undefined;
	if (processStartIdentity !== undefined && !isRuntimeString(processStartIdentity)) return undefined;
	if (writerPid !== undefined && (!isRuntimeNumber(writerPid) || !Number.isInteger(writerPid) || writerPid <= 0))
		return undefined;
	if (writerProcessStartIdentity !== undefined && !isRuntimeString(writerProcessStartIdentity)) return undefined;
	if (asyncDir !== undefined && (!isRuntimeString(asyncDir) || !path.isAbsolute(asyncDir))) return undefined;
	if (writerStartupGate !== undefined && writerStartupGate !== "parent-pipe-v1") return undefined;
	if (writerState === "running" && writerPid === undefined) return undefined;
	if (writerState !== "running" && (writerPid !== undefined || writerProcessStartIdentity !== undefined))
		return undefined;
	const owner: SessionLeaseOwner = {
		version: 1,
		token,
		canonicalSessionFile,
		runId,
		sourceRunId,
		pid,
		hostname,
		writerState,
		acquiredAt,
		acquiredAtMs,
		updatedAtMs,
	};
	if (parentSessionId !== undefined) owner.parentSessionId = parentSessionId;
	if (processStartIdentity !== undefined) owner.processStartIdentity = processStartIdentity;
	if (writerStartupGate !== undefined) owner.writerStartupGate = writerStartupGate;
	if (writerPid !== undefined) owner.writerPid = writerPid;
	if (writerProcessStartIdentity !== undefined) owner.writerProcessStartIdentity = writerProcessStartIdentity;
	if (asyncDir !== undefined) owner.asyncDir = asyncDir;
	return owner;
}

function readLeaseOwner(leaseDir: string): SessionLeaseOwner | undefined {
	try {
		return parseOwner(parseJsonValue(fs.readFileSync(path.join(leaseDir, "owner.json"), "utf-8")));
	} catch {
		return undefined;
	}
}

function conflictMessage(canonicalSessionFile: string, owner: SessionLeaseOwner | undefined): string {
	if (!owner) {
		return `Direct revival of session '${canonicalSessionFile}' is blocked by an existing lease with unreadable owner metadata. Refusing to reclaim it without proof that the owner is stale.`;
	}
	const parent = owner.parentSessionId ? `, parent session '${owner.parentSessionId}'` : "";
	return `Direct revival of session '${canonicalSessionFile}' is already owned by run '${owner.runId}' (source run '${owner.sourceRunId}'${parent}, pid ${owner.pid} on ${owner.hostname}). Wait for that revival to finish or start a separate continuation without reusing this session file.`;
}

function processDemonstrablyGone(
	pid: number,
	startIdentity: string | undefined,
	options: Required<Pick<SessionLeaseOptions, "isProcessAlive" | "getProcessStartIdentity">>,
): boolean {
	const alive = options.isProcessAlive(pid);
	if (alive === false) return true;
	if (alive !== true || !startIdentity) return false;
	const currentIdentity = options.getProcessStartIdentity(pid);
	return currentIdentity !== undefined && currentIdentity !== startIdentity;
}

function demonstrablyStale(
	owner: SessionLeaseOwner,
	options: Required<
		Pick<SessionLeaseOptions, "hostname" | "isProcessAlive" | "getProcessStartIdentity" | "inspectWriterLiveness">
	>,
): boolean {
	if (owner.hostname !== options.hostname) return false;
	if (!processDemonstrablyGone(owner.pid, owner.processStartIdentity, options)) return false;
	// The writer supervisor is a process-group leader. Its own PID can disappear
	// while the Pi child remains alive in that group and continues appending to the
	// canonical session. Only the authenticated writer registry can prove the
	// entire writer group absent. Legacy owners without that binding are retained.
	if (!owner.asyncDir || options.inspectWriterLiveness(owner.asyncDir) !== false) return false;
	if (owner.writerState !== "running") return true;
	return Boolean(
		owner.writerPid !== undefined &&
			processDemonstrablyGone(owner.writerPid, owner.writerProcessStartIdentity, options),
	);
}

function createLeaseDirectory(leaseDir: string, owner: SessionLeaseOwner): boolean {
	const tempDir = `${leaseDir}.candidate-${owner.token}`;
	fs.mkdirSync(path.dirname(leaseDir), { recursive: true, mode: 0o700 });
	fs.rmSync(tempDir, { recursive: true, force: true });
	fs.mkdirSync(tempDir, { mode: 0o700 });
	try {
		fs.writeFileSync(path.join(tempDir, "owner.json"), JSON.stringify(owner, null, 2), {
			encoding: "utf-8",
			mode: 0o600,
		});
		try {
			fs.renameSync(tempDir, leaseDir);
			return true;
		} catch (error) {
			if (fs.existsSync(leaseDir)) return false;
			throw error;
		}
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
}

export function acquireSessionLease(
	request: SessionLeaseRequest,
	options: SessionLeaseOptions = {},
): SessionLeaseHandle {
	const canonicalSessionFile = canonicalSessionFilePath(request.sessionFile);
	const canonicalAsyncDir = fs.realpathSync.native(path.resolve(request.asyncDir));
	const rootDir = options.rootDir ?? SESSION_LEASES_DIR;
	const leaseDir = sessionLeaseDir(canonicalSessionFile, rootDir);
	const now = options.now ?? Date.now;
	const pid = options.pid ?? process.pid;
	const hostname = options.hostname ?? os.hostname();
	const getIdentity = options.getProcessStartIdentity ?? getProcessStartIdentity;
	const processStartIdentity = options.processStartIdentity ?? getIdentity(pid);
	const acquiredAtMs = now();
	const owner: SessionLeaseOwner = {
		version: 1,
		token: options.token?.() ?? randomUUID(),
		canonicalSessionFile,
		runId: request.runId,
		sourceRunId: request.sourceRunId,
		asyncDir: canonicalAsyncDir,
		pid,
		hostname,
		writerState: "none",
		acquiredAt: new Date(acquiredAtMs).toISOString(),
		acquiredAtMs,
		updatedAtMs: acquiredAtMs,
	};
	if (request.parentSessionId) owner.parentSessionId = request.parentSessionId;
	if (processStartIdentity) owner.processStartIdentity = processStartIdentity;
	const staleOptions = {
		hostname,
		isProcessAlive: options.isProcessAlive ?? processIsAlive,
		getProcessStartIdentity: getIdentity,
		inspectWriterLiveness: options.inspectWriterLiveness ?? (() => undefined),
	};

	for (let attempt = 0; attempt < 4; attempt++) {
		if (createLeaseDirectory(leaseDir, owner)) {
			const writeOwner = createAtomicJsonWriter();
			return {
				leaseDir,
				owner,
				updateWriter(writer) {
					const currentOwner = readLeaseOwner(leaseDir);
					if (!currentOwner || currentOwner.token !== owner.token) {
						throw new Error(`Session revival lease ownership changed for run '${owner.runId}'.`);
					}
					const writerProcessStartIdentity = writer.state === "running" ? getIdentity(writer.pid) : undefined;
					const nextOwner: SessionLeaseOwner = {
						...owner,
						writerState: writer.state,
						updatedAtMs: now(),
					};
					delete nextOwner.writerPid;
					delete nextOwner.writerProcessStartIdentity;
					if (writer.state === "spawning" && process.platform !== "win32") {
						nextOwner.writerStartupGate = "parent-pipe-v1";
					}
					if (writer.state === "running") {
						nextOwner.writerPid = writer.pid;
						if (writerProcessStartIdentity) nextOwner.writerProcessStartIdentity = writerProcessStartIdentity;
					}
					writeOwner(path.join(leaseDir, "owner.json"), nextOwner);
					delete owner.writerPid;
					delete owner.writerProcessStartIdentity;
					Object.assign(owner, nextOwner);
				},
				release() {
					const currentOwner = readLeaseOwner(leaseDir);
					if (!currentOwner || currentOwner.token !== owner.token) return false;
					fs.rmSync(leaseDir, { recursive: true, force: true });
					return !fs.existsSync(leaseDir);
				},
			};
		}

		const existingOwner = readLeaseOwner(leaseDir);
		if (!existingOwner || !demonstrablyStale(existingOwner, staleOptions)) {
			throw new SessionLeaseConflictError(conflictMessage(canonicalSessionFile, existingOwner), existingOwner);
		}
		// The per-owner tombstone is retained. Every contender that observed this
		// stale token targets the same occupied destination, so only the first can
		// rename it and later contenders cannot move a successor lease by mistake.
		const tombstone = `${leaseDir}.stale-${existingOwner.token.replace(/[^A-Za-z0-9._-]/g, "-")}`;
		try {
			fs.renameSync(leaseDir, tombstone);
		} catch (error) {
			const code = error !== null && isRuntimeObject(error) && "code" in error ? error.code : undefined;
			if (code === "ENOENT" || fs.existsSync(tombstone)) continue;
			throw error;
		}
	}

	const existingOwner = readLeaseOwner(leaseDir);
	throw new SessionLeaseConflictError(conflictMessage(canonicalSessionFile, existingOwner), existingOwner);
}
