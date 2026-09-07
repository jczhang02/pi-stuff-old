import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { getProxyForUrl } from "proxy-from-env";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { isRuntimeObject } from "../../shared/runtime-type.ts";
import { codeModeHostBinaryName, hostAssetUrl, resolveCodeModeHostAsset } from "./host-assets.ts";
import { readProcessStartIdentity } from "./process-start-identity.ts";

const execFileAsync = promisify(execFile);

const DOWNLOAD_TIMEOUT_MS = 120_000;
const INSTALL_LOCK_POLL_MS = 200;
const INSTALL_LOCK_TIMEOUT_MS = 125_000;
const INSTALL_LOCK_STALE_MS = 180_000;
const INSTALL_LOCK_OWNER_FILE = "owner.json";
const INSTALL_LOCK_OWNER_SCHEMA = Type.Object(
	{
		pid: Type.Integer({ maximum: Number.MAX_SAFE_INTEGER, minimum: 1 }),
		processIdentity: Type.Optional(Type.String({ minLength: 1 })),
		token: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: true },
);

interface InstallLockOwner {
	readonly pid: number;
	readonly processIdentity?: string;
	readonly token: string;
}

interface InstallLock {
	readonly path: string;
	readonly token: string;
}

interface InstallLockSnapshot {
	readonly identity: string;
	readonly mtimeMs: number;
	readonly owner?: InstallLockOwner;
}

export interface InstallCodeModeHostOptions {
	readonly arch: string;
	readonly destination: string;
	readonly platform: string;
	readonly signal?: AbortSignal;
	/** Override the staging root; defaults to the operating-system temporary directory. */
	readonly temporaryDirectory?: string;
}

function walk(directory: string): string[] {
	const output: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) output.push(...walk(path));
		else output.push(path);
	}
	return output;
}

async function acquireInstallLock(
	lockPath: string,
	destination: string,
	signal: AbortSignal | undefined,
): Promise<InstallLock | undefined> {
	cleanupAbandonedInstallCandidates(lockPath);
	const deadline = Date.now() + INSTALL_LOCK_TIMEOUT_MS;
	while (Date.now() < deadline) {
		signal?.throwIfAborted();
		if (existsSync(destination)) return undefined;
		const token = randomUUID();
		const candidate = `${lockPath}.candidate-${token}`;
		try {
			mkdirSync(candidate);
			try {
				const processIdentity = readProcessStartIdentity(process.pid);
				if (!processIdentity) throw new Error("Cannot identify the Code Mode host installer process generation");
				const owner: InstallLockOwner = {
					pid: process.pid,
					processIdentity,
					token,
				};
				writeFileSync(join(candidate, INSTALL_LOCK_OWNER_FILE), `${JSON.stringify(owner)}\n`, {
					encoding: "utf8",
					flag: "wx",
					mode: 0o600,
				});
			} catch (error) {
				rmSync(candidate, { force: true, recursive: true });
				throw error;
			}
			try {
				renameSync(candidate, lockPath);
				return { path: lockPath, token };
			} catch (error) {
				rmSync(candidate, { force: true, recursive: true });
				if (!isErrno(error, "EEXIST") && !isErrno(error, "ENOTEMPTY")) throw error;
			}
		} catch (error) {
			if (!isErrno(error, "EEXIST")) throw error;
		}
		try {
			const snapshot = readLockSnapshot(lockPath);
			if (lockSnapshotIsStale(snapshot) && reclaimStaleLock(lockPath, snapshot)) continue;
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		await delay(INSTALL_LOCK_POLL_MS, undefined, signal ? { signal } : undefined);
	}
	if (existsSync(destination)) return undefined;
	throw new Error(`Timed out waiting for Code Mode host install lock: ${lockPath}`);
}

function isErrno(cause: unknown, code: string): boolean {
	return cause instanceof Error && "code" in cause && cause.code === code;
}

function cleanupAbandonedInstallCandidates(lockPath: string): void {
	const parent = dirname(lockPath);
	const prefix = `${basename(lockPath)}.candidate-`;
	for (const entry of readdirSync(parent, { withFileTypes: true })) {
		if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
		const candidate = join(parent, entry.name);
		try {
			if (Date.now() - statSync(candidate).mtimeMs <= INSTALL_LOCK_STALE_MS) continue;
			const owner = readLockOwner(candidate);
			if (owner && lockOwnerIsAlive(owner)) continue;
			rmSync(candidate, { force: true, recursive: true });
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
	}
}

function readLockOwner(lockPath: string): InstallLockOwner | undefined {
	try {
		const value = JSON.parse(readFileSync(join(lockPath, INSTALL_LOCK_OWNER_FILE), "utf8"));
		if (!Check(INSTALL_LOCK_OWNER_SCHEMA, value)) return undefined;
		return value;
	} catch {
		return undefined;
	}
}

function lockOwnerIsAlive(owner: InstallLockOwner): boolean {
	try {
		process.kill(owner.pid, 0);
	} catch (error) {
		if (isErrno(error, "ESRCH")) return false;
		return true;
	}
	const currentIdentity = readProcessStartIdentity(owner.pid);
	return !owner.processIdentity || !currentIdentity || owner.processIdentity === currentIdentity;
}

function readLockSnapshot(lockPath: string): InstallLockSnapshot {
	const metadata = statSync(lockPath);
	const owner = readLockOwner(lockPath);
	if (!owner) {
		return {
			identity: `${String(metadata.dev)}:${String(metadata.ino)}`,
			mtimeMs: metadata.mtimeMs,
		};
	}
	return {
		identity: owner.token,
		mtimeMs: metadata.mtimeMs,
		owner,
	};
}

function lockSnapshotIsStale(snapshot: InstallLockSnapshot): boolean {
	return (
		Date.now() - snapshot.mtimeMs > INSTALL_LOCK_STALE_MS && (!snapshot.owner || !lockOwnerIsAlive(snapshot.owner))
	);
}

function reclaimStaleLock(lockPath: string, expected: InstallLockSnapshot): boolean {
	const reclaimKey = createHash("sha256").update(expected.identity).digest("hex").slice(0, 20);
	const reclaimPath = `${lockPath}.reclaim-${reclaimKey}`;
	try {
		mkdirSync(reclaimPath);
	} catch (error) {
		if (isErrno(error, "EEXIST")) return false;
		throw error;
	}
	try {
		const current = readLockSnapshot(lockPath);
		if (current.identity !== expected.identity || !lockSnapshotIsStale(current)) return false;
		rmSync(lockPath, { force: true, recursive: true });
		return true;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return false;
		throw error;
	} finally {
		rmSync(reclaimPath, { force: true, recursive: true });
	}
}

function releaseInstallLock(lock: InstallLock): void {
	if (readLockOwner(lock.path)?.token !== lock.token) return;
	// A live owner is never reclaimable, and every stale reclaimer revalidates
	// under the identity-keyed mutex. No conforming contender can replace this
	// path between the ownership read and removal while this process is alive.
	rmSync(lock.path, { force: true, recursive: true });
}

export async function installCodeModeHost(options: InstallCodeModeHostOptions): Promise<void> {
	const [assetName, expectedSha256] = resolveCodeModeHostAsset(options.platform, options.arch);
	const binaryName = codeModeHostBinaryName(options.platform);
	const destination = resolve(options.destination);
	if (basename(destination) !== binaryName) {
		throw new Error(`Code Mode host destination must end with ${binaryName}`);
	}
	if (existsSync(destination)) return;
	await mkdir(resolve(destination, ".."), { recursive: true });
	const lockPath = `${destination}.lock`;
	const lock = await acquireInstallLock(lockPath, destination, options.signal);
	if (!lock) return;

	let temporary: string | undefined;
	const staged = `${destination}.${String(process.pid)}.tmp`;
	try {
		temporary = await mkdtemp(join(options.temporaryDirectory ?? tmpdir(), "pi-stuff-code-mode-"));
		const assetUrl = hostAssetUrl(assetName);
		let bytes: Buffer;
		try {
			const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
			const proxy = getProxyForUrl(assetUrl);
			const request: RequestInit & { proxy?: string } = {
				redirect: "follow",
				signal: options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal,
			};
			if (proxy) request.proxy = proxy;
			const response = await fetch(assetUrl, request);
			if (!response.ok) throw new Error(`${String(response.status)} ${response.statusText}`);
			bytes = Buffer.from(await response.arrayBuffer());
		} catch (error) {
			throw new Error(
				`Code Mode host download failed for ${assetUrl}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
		const actualSha256 = createHash("sha256").update(bytes).digest("hex");
		if (actualSha256 !== expectedSha256) throw new Error(`Code Mode host checksum mismatch for ${assetName}`);

		if (options.platform === "win32") {
			await writeFile(staged, bytes);
		} else {
			const archive = join(temporary, basename(assetName));
			const extracted = join(temporary, "extracted");
			await writeFile(archive, bytes);
			await mkdir(extracted);
			try {
				await execFileAsync("tar", ["-xzf", archive, "-C", extracted], { signal: options.signal });
			} catch (error) {
				options.signal?.throwIfAborted();
				const stderr = error && isRuntimeObject(error) && "stderr" in error ? String(error.stderr).trim() : "";
				throw new Error(`Code Mode host archive extraction failed${stderr ? `: ${stderr}` : ""}`, { cause: error });
			}
			const candidates = walk(extracted).filter((path) => basename(path).startsWith("codex-code-mode-host"));
			if (candidates.length !== 1) {
				throw new Error(`Expected one Code Mode host binary, found ${String(candidates.length)}`);
			}
			await copyFile(candidates[0] ?? "", staged);
			await chmod(staged, 0o755);
		}
		await rename(staged, destination);
	} finally {
		await rm(staged, { force: true });
		if (temporary) await rm(temporary, { force: true, recursive: true });
		releaseInstallLock(lock);
	}
}
