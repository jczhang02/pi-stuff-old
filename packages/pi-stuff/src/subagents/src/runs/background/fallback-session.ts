/** Crash-safe fork-session snapshots shared by model fallback attempts. */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runtimeErrorCode as errorCode, isRuntimeNumber } from "../../../../shared/runtime-type.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { type DurableClaim, shardedDurableClaimName, tryAcquireKernelClaim } from "../../shared/durable-claim.ts";
import { ensurePrivateDirectory, readBoundedOwnedFile } from "../../shared/private-directory.ts";

const FALLBACK_SNAPSHOT_DIRECTORY = ".pi-stuff-fallback-snapshots";
const FALLBACK_RESTORE_DIRECTORY = ".pi-stuff-fallback-restores";
const FALLBACK_LIFECYCLE_DIRECTORY = ".pi-stuff-fallback-lifecycle";
const FALLBACK_SWEEP_CURSOR_FILE = ".fallback-orphan-cursor";
const FALLBACK_SWEEP_TEMPORARY_FILE = ".fallback-orphan-cursor.tmp";
const FALLBACK_CLAIM_ATTEMPTS = 200;
const FALLBACK_CLAIM_WAIT_MS = 5;
const FALLBACK_ORPHAN_GRACE_MS = 60 * 60 * 1_000;
const FALLBACK_ORPHANS_PER_SWEEP = 64;
const LINUX_O_TMPFILE = 0o20000000;
const O_NOFOLLOW =
	"O_NOFOLLOW" in fs.constants && isRuntimeNumber(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;

interface SessionFallbackSnapshot {
	restore(): void;
	dispose(): void;
}

interface FallbackSessionStorage {
	readonly descriptor: number;
	readonly namedPath?: string;
	readonly claim?: DurableClaim;
}

const fallbackClaimWaitArray = new Int32Array(new SharedArrayBuffer(4));

function syncDirectoryBestEffort(directory: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
		fs.fsyncSync(descriptor);
	} catch {
		// Some supported filesystems do not permit fsync on directory handles.
	} finally {
		if (descriptor !== undefined) {
			try {
				fs.closeSync(descriptor);
			} catch {
				// Directory synchronization is diagnostic durability only and must not
				// turn an already-committed session restore into a false failure.
			}
		}
	}
}

function assertOwnedFallbackSession(filePath: string, stat: fs.Stats): void {
	const currentUid = process.getuid?.();
	if (
		stat.isSymbolicLink() ||
		!stat.isFile() ||
		stat.nlink !== 1 ||
		(currentUid !== undefined && stat.uid !== currentUid)
	) {
		throw new Error(`Fallback session '${filePath}' must be a singly linked owned regular file.`);
	}
}

function openOwnedFallbackSession(filePath: string): number {
	const pathStat = fs.lstatSync(filePath);
	assertOwnedFallbackSession(filePath, pathStat);
	const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | O_NOFOLLOW);
	try {
		const descriptorStat = fs.fstatSync(descriptor);
		assertOwnedFallbackSession(filePath, descriptorStat);
		if (descriptorStat.dev !== pathStat.dev || descriptorStat.ino !== pathStat.ino) {
			throw new Error(`Fallback session '${filePath}' changed while it was opened.`);
		}
		return descriptor;
	} catch (error) {
		try {
			fs.closeSync(descriptor);
		} catch (cleanupError) {
			reportAgentDiagnostic("Failed to close a rejected Agent fallback session descriptor:", cleanupError);
		}
		throw error;
	}
}

function copyFallbackSessionDescriptor(source: number, destination: number): void {
	const before = fs.fstatSync(source);
	const buffer = Buffer.allocUnsafe(64 * 1024);
	let position = 0;
	fs.ftruncateSync(destination, 0);
	while (position < before.size) {
		const bytesRead = fs.readSync(source, buffer, 0, Math.min(buffer.length, before.size - position), position);
		if (bytesRead <= 0) throw new Error("Fallback session ended while it was being copied.");
		let written = 0;
		while (written < bytesRead) {
			const bytesWritten = fs.writeSync(destination, buffer, written, bytesRead - written, position + written);
			if (bytesWritten <= 0) throw new Error("Fallback session destination stopped accepting data.");
			written += bytesWritten;
		}
		position += bytesRead;
	}
	const after = fs.fstatSync(source);
	if (
		after.dev !== before.dev ||
		after.ino !== before.ino ||
		after.size !== before.size ||
		after.mtimeMs !== before.mtimeMs ||
		after.ctimeMs !== before.ctimeMs
	) {
		throw new Error("Fallback session changed while it was being copied.");
	}
	fs.fsyncSync(destination);
}

function ensureFallbackPrivateDirectory(parent: string, name: string): string {
	const directory = path.join(parent, name);
	try {
		fs.mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	ensurePrivateDirectory(directory);
	return directory;
}

function fallbackSessionKey(sessionFile: string): string {
	const resolved = path.resolve(sessionFile);
	const canonicalParent = fs.realpathSync.native(path.dirname(resolved));
	let canonicalSlot = path.join(canonicalParent, path.basename(resolved));
	if (process.platform === "win32") canonicalSlot = canonicalSlot.toLowerCase();
	return createHash("sha256").update(canonicalSlot).digest("hex");
}

function acquireFallbackClaim(directory: string, namespace: string, sessionKey: string): DurableClaim {
	const name = shardedDurableClaimName(namespace, sessionKey, 4_096);
	for (let attempt = 0; attempt < FALLBACK_CLAIM_ATTEMPTS; attempt += 1) {
		const claim = tryAcquireKernelClaim(directory, name);
		if (claim) return claim;
		Atomics.wait(fallbackClaimWaitArray, 0, 0, FALLBACK_CLAIM_WAIT_MS);
	}
	throw new Error("Timed out waiting for isolated Agent fallback storage.");
}

function acquireFallbackLifecycleClaim(directory: string, sessionKey: string): DurableClaim {
	const name = `fallback-session-${sessionKey}`;
	for (let attempt = 0; attempt < FALLBACK_CLAIM_ATTEMPTS; attempt += 1) {
		const claim = tryAcquireKernelClaim(directory, name);
		if (claim) return claim;
		Atomics.wait(fallbackClaimWaitArray, 0, 0, FALLBACK_CLAIM_WAIT_MS);
	}
	throw new Error("This Agent fallback session is already owned by another active attempt.");
}

function removeOwnedFallbackTemporary(filePath: string): void {
	try {
		const stat = fs.lstatSync(filePath);
		assertOwnedFallbackSession(filePath, stat);
		fs.unlinkSync(filePath);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function fallbackTemporaryIdentity(name: string, kind: "restore" | "snapshot"): string | undefined {
	const match = name.match(new RegExp(`^${kind}-([0-9a-f]{64})\\.tmp$`, "u"));
	return match?.[1];
}

function readFallbackSweepCursor(directory: string, kind: "restore" | "snapshot"): string {
	try {
		const value = readBoundedOwnedFile(path.join(directory, FALLBACK_SWEEP_CURSOR_FILE), 128).trim();
		return fallbackTemporaryIdentity(value, kind) ? value : "";
	} catch (error) {
		if (errorCode(error) !== "ENOENT") {
			reportAgentDiagnostic(`Failed to read ${kind} fallback orphan cursor:`, error);
		}
		return "";
	}
}

function writeFallbackSweepCursor(directory: string, value: string): void {
	const target = path.join(directory, FALLBACK_SWEEP_CURSOR_FILE);
	const temporary = path.join(directory, FALLBACK_SWEEP_TEMPORARY_FILE);
	removeOwnedFallbackTemporary(temporary);
	let descriptor: number | undefined;
	try {
		descriptor = fs.openSync(
			temporary,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | O_NOFOLLOW,
			0o600,
		);
		fs.writeFileSync(descriptor, `${value}\n`, "utf8");
		fs.fsyncSync(descriptor);
		fs.closeSync(descriptor);
		descriptor = undefined;
		removeOwnedFallbackTemporary(target);
		fs.renameSync(temporary, target);
		syncDirectoryBestEffort(directory);
	} finally {
		try {
			if (descriptor !== undefined) fs.closeSync(descriptor);
		} finally {
			try {
				fs.unlinkSync(temporary);
			} catch {
				// Atomic rename consumed the temporary, or the next sweep reclaims it.
			}
		}
	}
}

/**
 * Advance through crash debris without repeatedly restarting at a busy prefix.
 * Active writers retain the same kernel claim and therefore cannot be swept,
 * even if a very large copy outlives the conservative age threshold.
 */
function sweepFallbackOrphans(directory: string, kind: "restore" | "snapshot", now = Date.now()): void {
	const maintenance = tryAcquireKernelClaim(directory, "fallback-maintenance");
	if (!maintenance) return;
	try {
		// This private protocol directory contains a fixed set of sharded claim files
		// plus temporary debris. Enumeration is small in normal operation; the cursor
		// bounds destructive work and guarantees progress across repeated maintenance.
		const candidates = fs
			.readdirSync(directory, { withFileTypes: true })
			.filter((entry) => fallbackTemporaryIdentity(entry.name, kind) !== undefined)
			.map((entry) => entry.name)
			.sort();
		const cursor = readFallbackSweepCursor(directory, kind);
		const nextIndex = cursor ? candidates.findIndex((name) => name > cursor) : 0;
		const start = nextIndex < 0 ? 0 : nextIndex;
		const page = candidates.slice(start, start + FALLBACK_ORPHANS_PER_SWEEP);
		for (const name of page) {
			const sessionKey = fallbackTemporaryIdentity(name, kind);
			if (!sessionKey) continue;
			const candidate = path.join(directory, name);
			let stat: fs.Stats;
			try {
				stat = fs.lstatSync(candidate);
				assertOwnedFallbackSession(candidate, stat);
			} catch (error) {
				if (errorCode(error) === "ENOENT") continue;
				throw error;
			}
			if (now - stat.mtimeMs < FALLBACK_ORPHAN_GRACE_MS) continue;
			const owner = tryAcquireKernelClaim(directory, shardedDurableClaimName(`fallback-${kind}`, sessionKey, 4_096));
			if (!owner) continue;
			try {
				const current = fs.lstatSync(candidate);
				assertOwnedFallbackSession(candidate, current);
				if (now - current.mtimeMs >= FALLBACK_ORPHAN_GRACE_MS) fs.unlinkSync(candidate);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
			} finally {
				owner.release();
			}
		}

		if (page.length === 0 || start + page.length >= candidates.length) {
			removeOwnedFallbackTemporary(path.join(directory, FALLBACK_SWEEP_CURSOR_FILE));
		} else {
			writeFallbackSweepCursor(directory, page.at(-1) ?? "");
		}
	} catch (error) {
		reportAgentDiagnostic(`Failed to sweep ${kind} fallback crash debris:`, error);
	} finally {
		try {
			maintenance.release();
		} catch (error) {
			reportAgentDiagnostic(`Failed to release ${kind} fallback maintenance claim:`, error);
		}
	}
}

function openFallbackSessionStorage(sessionKey: string): FallbackSessionStorage {
	const root = ensureFallbackPrivateDirectory(os.tmpdir(), FALLBACK_SNAPSHOT_DIRECTORY);
	sweepFallbackOrphans(root, "snapshot");
	if (process.platform === "linux") {
		try {
			const descriptor = fs.openSync(
				os.tmpdir(),
				LINUX_O_TMPFILE | (fs.constants.O_DIRECTORY ?? 0) | fs.constants.O_RDWR,
				0o600,
			);
			try {
				fs.fchmodSync(descriptor, 0o600);
				return { descriptor };
			} catch (error) {
				try {
					fs.closeSync(descriptor);
				} catch (cleanupError) {
					reportAgentDiagnostic("Failed to close an incomplete anonymous Agent fallback snapshot:", cleanupError);
				}
				throw error;
			}
		} catch (error) {
			if (!new Set(["EISDIR", "EINVAL", "ENOTSUP", "EOPNOTSUPP", "EPERM"]).has(errorCode(error) ?? "")) {
				throw error;
			}
			// Some Linux filesystems do not implement O_TMPFILE. The private named
			// fallback below is swept after crashes and unlinked immediately when the
			// filesystem permits POSIX open-file deletion.
		}
	}

	const temporary = path.join(root, `snapshot-${sessionKey}.tmp`);
	const claim = acquireFallbackClaim(root, "fallback-snapshot", sessionKey);
	let descriptor: number | undefined;
	try {
		// The sharded kernel claim makes exact crash-debris cleanup race-free without
		// growing one permanent lock inode for every session ever observed.
		removeOwnedFallbackTemporary(temporary);
		descriptor = fs.openSync(
			temporary,
			fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | O_NOFOLLOW,
			0o600,
		);
		fs.fchmodSync(descriptor, 0o600);
		try {
			fs.unlinkSync(temporary);
			claim.release();
			return { descriptor };
		} catch {
			// Windows and a few non-POSIX filesystems retain the private name while
			// open. Keep the claim until disposal so no later owner can remove it.
			return { descriptor, namedPath: temporary, claim };
		}
	} catch (error) {
		try {
			if (descriptor !== undefined) fs.closeSync(descriptor);
		} catch {
			// Preserve the original snapshot-creation failure.
		}
		try {
			removeOwnedFallbackTemporary(temporary);
		} catch {
			// The next owner retries exact cleanup.
		}
		try {
			claim.release();
		} catch {
			// Preserve the original snapshot-creation failure.
		}
		throw error;
	}
}

function disposeFallbackSessionStorage(storage: FallbackSessionStorage): void {
	let firstError: unknown;
	try {
		fs.closeSync(storage.descriptor);
	} catch (error) {
		firstError = error;
	}
	if (storage.namedPath) {
		try {
			fs.unlinkSync(storage.namedPath);
		} catch (error) {
			if (errorCode(error) !== "ENOENT" && firstError === undefined) firstError = error;
		}
	}
	try {
		storage.claim?.release();
	} catch (error) {
		if (firstError === undefined) firstError = error;
	}
	if (firstError !== undefined) throw firstError;
}

function createAnonymousFallbackSession(sessionFile: string, sessionKey: string): FallbackSessionStorage {
	const source = openOwnedFallbackSession(sessionFile);
	let snapshot: FallbackSessionStorage | undefined;
	try {
		snapshot = openFallbackSessionStorage(sessionKey);
		copyFallbackSessionDescriptor(source, snapshot.descriptor);
	} catch (error) {
		try {
			if (snapshot !== undefined) disposeFallbackSessionStorage(snapshot);
		} catch (cleanupError) {
			reportAgentDiagnostic("Failed to discard an incomplete Agent fallback snapshot:", cleanupError);
		}
		try {
			fs.closeSync(source);
		} catch (cleanupError) {
			reportAgentDiagnostic("Failed to close the source of an incomplete Agent fallback snapshot:", cleanupError);
		}
		throw error;
	}
	try {
		fs.closeSync(source);
	} catch (error) {
		try {
			disposeFallbackSessionStorage(snapshot);
		} catch (cleanupError) {
			reportAgentDiagnostic(
				"Failed to discard an Agent fallback snapshot after source close failure:",
				cleanupError,
			);
		}
		throw error;
	}
	return snapshot;
}

/** Freeze a fork before model attempts so every retry starts from the same branch. */
export function createSessionFallbackSnapshot(
	sessionFile: string | undefined,
	candidateCount: number,
): SessionFallbackSnapshot | undefined {
	if (!sessionFile || candidateCount < 2) return undefined;
	const parent = path.dirname(sessionFile);
	const sessionKey = fallbackSessionKey(sessionFile);
	const restoreDirectory = ensureFallbackPrivateDirectory(parent, FALLBACK_RESTORE_DIRECTORY);
	sweepFallbackOrphans(restoreDirectory, "restore");
	// Lifecycle ownership must be exact: a bounded shard held across a model call
	// would randomly reject unrelated concurrent sessions. One stable inode per
	// persisted session mirrors the session store's own lifetime and guarantees
	// that retries for the same fork can never overwrite one another.
	const lifecycleDirectory = ensureFallbackPrivateDirectory(parent, FALLBACK_LIFECYCLE_DIRECTORY);
	const lifecycleClaim = acquireFallbackLifecycleClaim(lifecycleDirectory, sessionKey);
	let existed = false;
	let snapshot: FallbackSessionStorage | undefined;
	try {
		try {
			const stat = fs.lstatSync(sessionFile);
			assertOwnedFallbackSession(sessionFile, stat);
			existed = true;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		if (existed) snapshot = createAnonymousFallbackSession(sessionFile, sessionKey);
	} catch (error) {
		try {
			if (snapshot !== undefined) disposeFallbackSessionStorage(snapshot);
		} catch (cleanupError) {
			reportAgentDiagnostic("Failed to clean up an incomplete Agent fallback snapshot:", cleanupError);
		}
		try {
			lifecycleClaim.release();
		} catch (cleanupError) {
			reportAgentDiagnostic("Failed to release an incomplete Agent fallback lifecycle claim:", cleanupError);
		}
		throw error;
	}
	let disposed = false;

	return {
		restore() {
			if (disposed) throw new Error("Fallback session snapshot is already closed.");
			const restoreClaim = acquireFallbackClaim(restoreDirectory, "fallback-restore", sessionKey);
			const temporary = path.join(restoreDirectory, `restore-${sessionKey}.tmp`);
			let destination: number | undefined;
			let operationFailed = false;
			let operationError: unknown;
			try {
				if (!existed) {
					try {
						const stat = fs.lstatSync(sessionFile);
						assertOwnedFallbackSession(sessionFile, stat);
						fs.unlinkSync(sessionFile);
						syncDirectoryBestEffort(parent);
					} catch (error) {
						if (errorCode(error) !== "ENOENT") throw error;
					}
				} else {
					if (snapshot === undefined) throw new Error("Fallback session snapshot is unavailable.");
					removeOwnedFallbackTemporary(temporary);
					destination = fs.openSync(
						temporary,
						fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | O_NOFOLLOW,
						0o600,
					);
					fs.fchmodSync(destination, 0o600);
					copyFallbackSessionDescriptor(snapshot.descriptor, destination);
					fs.closeSync(destination);
					destination = undefined;
					fs.renameSync(temporary, sessionFile);
					syncDirectoryBestEffort(restoreDirectory);
					syncDirectoryBestEffort(parent);
				}
			} catch (error) {
				operationFailed = true;
				operationError = error;
			}
			const cleanupErrors: unknown[] = [];
			try {
				if (destination !== undefined) fs.closeSync(destination);
			} catch (error) {
				cleanupErrors.push(error);
			}
			try {
				fs.unlinkSync(temporary);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") cleanupErrors.push(error);
			}
			try {
				restoreClaim.release();
			} catch (error) {
				cleanupErrors.push(error);
			}
			if (operationFailed) {
				for (const cleanupError of cleanupErrors) {
					reportAgentDiagnostic("Failed to clean up an unsuccessful Agent fallback restore:", cleanupError);
				}
				throw operationError;
			}
			if (cleanupErrors.length > 0) throw cleanupErrors[0];
		},
		dispose() {
			if (disposed) return;
			disposed = true;
			try {
				if (snapshot !== undefined) disposeFallbackSessionStorage(snapshot);
			} catch (error) {
				reportAgentDiagnostic("Failed to close frozen Agent fallback session:", error);
			}
			try {
				lifecycleClaim.release();
			} catch (error) {
				reportAgentDiagnostic("Failed to release frozen Agent fallback lifecycle ownership:", error);
			}
		},
	};
}
