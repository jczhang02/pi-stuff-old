import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { type JsonObject, type JsonValue, parseJsonValue } from "../../shared/json-value.ts";
import { isRuntimeFunction, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import {
	captureProcessIdentity,
	identityMatches,
	type ProcessIdentity,
	processExists,
	processStartIdentity,
	terminateVerifiedProcessGroup,
} from "./process.ts";

const SCHEMA_VERSION = 2;
const OWNED_DIRECTORY_PREFIX = "pi-stuff-";
const METADATA_FILE = "runtime.json";
const AUTHORITY_KEY_BYTES = 32;
const AUTHORITY_KEY_FILE = "runtime-auth.key";
const AUTHORITY_ALGORITHM = "hmac-sha256";
const MAX_STORED_TASKS = 64;

export interface StoredProcessTask {
	readonly command?: ProcessIdentity;
	readonly id: string;
	readonly supervisor: ProcessIdentity;
}

interface StoredRuntime {
	readonly auth: { readonly algorithm: typeof AUTHORITY_ALGORITHM; readonly digest: string };
	readonly owner: ProcessIdentity;
	readonly schemaVersion: 2;
	readonly tasks: readonly StoredProcessTask[];
}

interface StoredRuntimePayload {
	readonly owner: ProcessIdentity;
	readonly schemaVersion: 2;
	readonly tasks: readonly StoredProcessTask[];
}

export interface WorkRuntimeAuthorityOptions {
	/** Test seam. Production callers use the user-private authority key. */
	readonly authorityKey?: Uint8Array;
}

function safeToken(value: string): string {
	const normalized = value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
	return normalized.slice(0, 64) || "session";
}

function isPositiveInteger(value: JsonValue | undefined): value is number {
	return isRuntimeNumber(value) && Number.isSafeInteger(value) && value > 0;
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function parseIdentity(value: JsonValue | undefined): ProcessIdentity | undefined {
	if (!isJsonObject(value)) return undefined;
	const record = value;
	return isPositiveInteger(record["pid"]) && isRuntimeString(record["started"]) && record["started"]
		? { pid: record["pid"], started: record["started"] }
		: undefined;
}

function parseStoredRuntime(value: JsonValue, authorityKey: Uint8Array): StoredRuntime | undefined {
	if (!isJsonObject(value)) return undefined;
	const record = value;
	const owner = parseIdentity(record["owner"]);
	if (
		record["schemaVersion"] !== SCHEMA_VERSION ||
		!owner ||
		!Array.isArray(record["tasks"]) ||
		record["tasks"].length > MAX_STORED_TASKS
	) {
		return undefined;
	}
	const tasks: StoredProcessTask[] = [];
	for (const value of record["tasks"]) {
		if (!isJsonObject(value)) return undefined;
		const task = value;
		const supervisor = parseIdentity(task["supervisor"]);
		const command = task["command"] === undefined ? undefined : parseIdentity(task["command"]);
		if (!isRuntimeString(task["id"]) || !task["id"] || !supervisor || (task["command"] && !command)) {
			return undefined;
		}
		tasks.push(command ? { id: task["id"], supervisor, command } : { id: task["id"], supervisor });
	}
	const auth = record["auth"];
	if (!isJsonObject(auth)) return undefined;
	const authRecord = auth;
	if (
		authRecord["algorithm"] !== AUTHORITY_ALGORITHM ||
		!isRuntimeString(authRecord["digest"]) ||
		!/^[a-f0-9]{64}$/u.test(authRecord["digest"])
	) {
		return undefined;
	}
	const payload: StoredRuntimePayload = { owner, schemaVersion: SCHEMA_VERSION, tasks };
	const expected = runtimeDigest(payload, authorityKey);
	const received = Buffer.from(authRecord["digest"], "hex");
	if (received.length !== expected.length || !timingSafeEqual(received, expected)) return undefined;
	return {
		...payload,
		auth: { algorithm: AUTHORITY_ALGORITHM, digest: authRecord["digest"] },
	};
}

function readStoredRuntime(directory: string, authorityKey: Uint8Array): StoredRuntime | undefined {
	try {
		const metadataPath = join(directory, METADATA_FILE);
		const stat = lstatSync(metadataPath);
		if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 1024 * 1024) return undefined;
		return parseStoredRuntime(parseJsonValue(readFileSync(metadataPath, "utf-8")), authorityKey);
	} catch {
		return undefined;
	}
}

function canonicalRuntimePayload(payload: StoredRuntimePayload): string {
	return JSON.stringify({
		owner: { pid: payload.owner.pid, started: payload.owner.started },
		schemaVersion: SCHEMA_VERSION,
		tasks: payload.tasks.map((task) =>
			task.command
				? {
						id: task.id,
						command: { pid: task.command.pid, started: task.command.started },
						supervisor: { pid: task.supervisor.pid, started: task.supervisor.started },
					}
				: { id: task.id, supervisor: { pid: task.supervisor.pid, started: task.supervisor.started } },
		),
	});
}

function runtimeDigest(payload: StoredRuntimePayload, authorityKey: Uint8Array): Buffer {
	return createHmac("sha256", authorityKey).update(canonicalRuntimePayload(payload)).digest();
}

/** Build a record accepted by stale-run reconciliation without exposing the production key. */
export function createAuthenticatedRuntimeRecord(
	owner: ProcessIdentity,
	tasks: readonly StoredProcessTask[],
	authorityKey: Uint8Array,
): StoredRuntime {
	const payload: StoredRuntimePayload = { owner, schemaVersion: SCHEMA_VERSION, tasks: [...tasks] };
	return {
		...payload,
		auth: { algorithm: AUTHORITY_ALGORITHM, digest: runtimeDigest(payload, authorityKey).toString("hex") },
	};
}

function authorityRoot(): string {
	const configured = process.env["XDG_STATE_HOME"]?.trim();
	const stateRoot = configured && isAbsolute(configured) ? configured : join(homedir(), ".local", "state");
	return join(stateRoot, "pi-stuff", "work");
}

function loadOrCreateAuthorityKey(injected?: Uint8Array, create = true): Buffer | undefined {
	if (injected) {
		if (injected.byteLength < AUTHORITY_KEY_BYTES) throw new Error("Background Work authority key is too short.");
		return Buffer.from(injected);
	}
	const root = authorityRoot();
	const target = join(root, AUTHORITY_KEY_FILE);
	if (!create) {
		try {
			ensureOwnedDirectory(root, "Background Work authority directory", false);
			const stat = lstatSync(target);
			const currentUid = isRuntimeFunction(process.getuid) ? process.getuid() : undefined;
			if (
				stat.isSymbolicLink() ||
				!stat.isFile() ||
				stat.size !== AUTHORITY_KEY_BYTES ||
				(currentUid !== undefined && stat.uid !== currentUid)
			) {
				return undefined;
			}
			return readFileSync(target);
		} catch {
			return undefined;
		}
	}
	ensureOwnedDirectory(dirname(root), "Pi Stuff state directory");
	ensureOwnedDirectory(root, "Background Work authority directory");
	try {
		const stat = lstatSync(target);
		const currentUid = isRuntimeFunction(process.getuid) ? process.getuid() : undefined;
		if (
			stat.isSymbolicLink() ||
			!stat.isFile() ||
			stat.size !== AUTHORITY_KEY_BYTES ||
			(currentUid !== undefined && stat.uid !== currentUid)
		) {
			throw new Error(`Background Work authority key '${target}' is not a private regular file.`);
		}
		if ((stat.mode & 0o777) !== 0o600) chmodSync(target, 0o600);
		return readFileSync(target);
	} catch (error) {
		if (!isMissingPath(error)) throw error;
	}
	const key = randomBytes(AUTHORITY_KEY_BYTES);
	try {
		writeFileSync(target, key, { flag: "wx", mode: 0o600 });
		return key;
	} catch (error) {
		if (!isRuntimeObject(error) || error === null || !("code" in error) || error.code !== "EEXIST") throw error;
		return loadOrCreateAuthorityKey(undefined, true);
	}
}

function isMissingPath(cause: unknown): boolean {
	return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function isDirectory(path: string): boolean {
	try {
		const stat = lstatSync(path);
		const currentUid = isRuntimeFunction(process.getuid) ? process.getuid() : undefined;
		return stat.isDirectory() && !stat.isSymbolicLink() && (currentUid === undefined || stat.uid === currentUid);
	} catch {
		return false;
	}
}

function ensureOwnedDirectory(directory: string, label: string, create = true): void {
	if (create) mkdirSync(directory, { mode: 0o700, recursive: true });
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(directory);
	} catch (error) {
		throw new Error(`${label} '${directory}' is unavailable.`, { cause: error });
	}
	const currentUid = isRuntimeFunction(process.getuid) ? process.getuid() : undefined;
	if (stat.isSymbolicLink() || !stat.isDirectory() || (currentUid !== undefined && stat.uid !== currentUid)) {
		throw new Error(`${label} '${directory}' must be a real directory owned by the current user.`);
	}
}

function removeOwnedDirectory(root: string, directory: string): void {
	const resolvedRoot = resolve(root);
	const resolvedDirectory = resolve(directory);
	if (dirname(resolvedDirectory) !== resolvedRoot || !basename(resolvedDirectory).startsWith(OWNED_DIRECTORY_PREFIX)) {
		throw new Error(`Refusing to remove non-owned Background Work directory: ${resolvedDirectory}`);
	}
	ensureOwnedDirectory(resolvedDirectory, "Background Work runtime directory", false);
	rmSync(resolvedDirectory, { force: true, recursive: true });
}

export interface ReconciliationResult {
	readonly cleanedDirectories: number;
	readonly killedProcesses: number;
	readonly unresolvedDirectories: number;
}

/** Reap authenticated process trees left by an abruptly terminated Pi Host. */
export async function reconcileStaleRuns(
	cwd: string,
	options: WorkRuntimeAuthorityOptions = {},
): Promise<ReconciliationResult> {
	const root = join(cwd, ".pi", "tasks");
	if (!existsSync(root)) return { cleanedDirectories: 0, killedProcesses: 0, unresolvedDirectories: 0 };
	try {
		ensureOwnedDirectory(dirname(root), "Project .pi directory", false);
		ensureOwnedDirectory(root, "Background Work task root", false);
	} catch {
		// Never enumerate or mutate a redirected/foreign task root.
		return { cleanedDirectories: 0, killedProcesses: 0, unresolvedDirectories: 1 };
	}
	const candidates = readdirSync(root, { withFileTypes: true }).filter(
		(entry) => entry.isDirectory() && entry.name.startsWith(OWNED_DIRECTORY_PREFIX),
	);
	if (candidates.length === 0) return { cleanedDirectories: 0, killedProcesses: 0, unresolvedDirectories: 0 };
	const authorityKey = loadOrCreateAuthorityKey(options.authorityKey, false);
	if (!authorityKey) {
		return { cleanedDirectories: 0, killedProcesses: 0, unresolvedDirectories: candidates.length };
	}
	let cleanedDirectories = 0;
	let killedProcesses = 0;
	let unresolvedDirectories = 0;
	for (const entry of candidates) {
		const directory = join(root, entry.name);
		const stored = readStoredRuntime(directory, authorityKey);
		if (!stored) {
			unresolvedDirectories += 1;
			continue;
		}
		if (identityMatches(stored.owner)) continue;
		let unresolved = false;
		const identities = new Map<string, ProcessIdentity>();
		for (const task of stored.tasks) {
			for (const identity of [task.command, task.supervisor]) {
				if (!identity) continue;
				identities.set(`${String(identity.pid)}:${identity.started}`, identity);
			}
		}
		for (const identity of identities.values()) {
			const currentIdentity = processStartIdentity(identity.pid);
			if (currentIdentity && currentIdentity !== identity.started) continue;
			if (!currentIdentity && processExists(identity.pid)) {
				unresolved = true;
				continue;
			}
			const outcome = await terminateVerifiedProcessGroup(identity, 2_000);
			if (outcome === "unresolved") {
				unresolved = true;
				continue;
			}
			if (outcome !== "identity-mismatch") killedProcesses += 1;
		}
		if (unresolved) {
			unresolvedDirectories += 1;
			continue;
		}
		removeOwnedDirectory(root, directory);
		cleanedDirectories += 1;
	}
	return { cleanedDirectories, killedProcesses, unresolvedDirectories };
}

export class WorkRunStorage {
	private directoryValue: string | undefined;
	private readonly owner: ProcessIdentity;
	private authorityKeyValue: Buffer | undefined;
	private readonly injectedAuthorityKey: Uint8Array | undefined;
	private readonly root: string;
	private readonly sessionId: string;
	private tasks: readonly StoredProcessTask[] = [];

	constructor(cwd: string, sessionId: string, options: WorkRuntimeAuthorityOptions = {}) {
		const owner = captureProcessIdentity(process.pid);
		if (!owner) throw new Error("Background Work requires a stable Pi process identity");
		this.owner = owner;
		this.injectedAuthorityKey = options.authorityKey;
		this.root = join(cwd, ".pi", "tasks");
		this.sessionId = safeToken(sessionId);
	}

	private authorityKey(): Buffer {
		if (!this.authorityKeyValue) {
			const loaded = loadOrCreateAuthorityKey(this.injectedAuthorityKey, true);
			if (!loaded) throw new Error("Background Work authority key could not be created.");
			this.authorityKeyValue = loaded;
		}
		return this.authorityKeyValue;
	}

	get directory(): string | undefined {
		return this.directoryValue;
	}

	ensureDirectory(): string {
		if (this.directoryValue && isDirectory(this.directoryValue)) return this.directoryValue;
		this.directoryValue = undefined;
		const projectMetadataDir = dirname(this.root);
		ensureOwnedDirectory(projectMetadataDir, "Project .pi directory");
		ensureOwnedDirectory(this.root, "Background Work task root");
		const token = randomBytes(6).toString("hex");
		const directory = join(this.root, `${OWNED_DIRECTORY_PREFIX}${this.sessionId}-${String(process.pid)}-${token}`);
		mkdirSync(directory, { mode: 0o700 });
		ensureOwnedDirectory(directory, "Background Work runtime directory", false);
		this.directoryValue = directory;
		return directory;
	}

	outputPath(id: string): string {
		this.persist(this.tasks);
		const directory = this.directoryValue;
		if (!directory) throw new Error("Background Work runtime directory was not established");
		return join(directory, `${safeToken(id)}.output`);
	}

	commandAuthorizationPath(id: string): string {
		const directory = this.directoryValue;
		if (!directory || !isDirectory(directory)) {
			throw new Error("Background Work runtime directory was not established");
		}
		return join(directory, `${safeToken(id)}.command`);
	}

	persist(tasks: readonly StoredProcessTask[]): void {
		this.tasks = [...tasks];
		const content = createAuthenticatedRuntimeRecord(this.owner, this.tasks, this.authorityKey());
		for (let attempt = 0; attempt < 2; attempt += 1) {
			const directory = this.ensureDirectory();
			const target = join(directory, METADATA_FILE);
			const temporary = join(directory, `.${METADATA_FILE}.${randomBytes(6).toString("hex")}.tmp`);
			try {
				writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`, {
					encoding: "utf-8",
					mode: 0o600,
					flag: "wx",
				});
				renameSync(temporary, target);
				return;
			} catch (error) {
				try {
					rmSync(temporary, { force: true });
				} catch {
					// Preserve the persistence failure that determines whether the
					// operation can be retried; temp cleanup is only best effort.
				}
				if (attempt === 0 && isMissingPath(error)) {
					if (this.directoryValue === directory) this.directoryValue = undefined;
					continue;
				}
				throw error;
			}
		}
	}

	cleanup(): void {
		const directory = this.directoryValue;
		if (!directory) return;
		this.tasks = [];
		removeOwnedDirectory(this.root, directory);
		this.directoryValue = undefined;
	}
}
