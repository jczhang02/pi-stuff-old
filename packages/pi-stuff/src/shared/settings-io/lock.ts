/**
 * Whole-file exclusive settings lock shared by every Pi Stuff Capability.
 *
 * The lock mechanism is the existing flock-based lease also used by the legacy
 * per-Capability settings files. It is moved here so the single merged file
 * `pi-stuff.json` has one lock owner for all namespaces. flock owns the
 * mutual-exclusion contract; the file content is diagnostic only.
 */

import { dlopen, FFIType } from "bun:ffi";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { resolveSettingsLockPath } from "./paths.ts";

export { MERGED_SETTINGS_FILE, mergedSettingsPath, resolveSettingsLockPath } from "./paths.ts";

const SETTINGS_LOCK_POLL_MS = 10;
const SETTINGS_LOCK_TIMEOUT_MS = 10_000;
const FLOCK_EXCLUSIVE_NONBLOCKING = 2 | 4;

/**
 * Keep one stable lock inode and let the kernel own its lease. Closing the file
 * descriptor, including on process exit, releases the lease without a stale
 * check-then-unlink race against a later owner.
 */
function loadFlockLibrary() {
	if (process.platform !== "linux") {
		throw new Error(`Settings locking is not supported on ${process.platform}`);
	}
	return dlopen("libc.so.6", {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	});
}

let flockLibrary: ReturnType<typeof loadFlockLibrary> | undefined;

function tryAcquireFileLock(fileDescriptor: number): boolean {
	flockLibrary ??= loadFlockLibrary();
	return flockLibrary.symbols.flock(fileDescriptor, FLOCK_EXCLUSIVE_NONBLOCKING) === 0;
}

export async function acquireSettingsLockNative(
	lockPath = resolveSettingsLockPath(),
	owner = "pi-stuff",
	signal?: AbortSignal,
): Promise<() => Promise<void>> {
	signal?.throwIfAborted();
	await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
	signal?.throwIfAborted();
	const startedAt = Date.now();
	const handle = await open(
		lockPath,
		constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		signal?.throwIfAborted();
		while (!tryAcquireFileLock(handle.fd)) {
			if (Date.now() - startedAt >= SETTINGS_LOCK_TIMEOUT_MS) {
				throw new Error(`timed out waiting for the ${owner} settings lock at ${lockPath}`);
			}
			await delay(SETTINGS_LOCK_POLL_MS, undefined, signal ? { signal } : undefined);
		}
		await handle.chmod(0o600);
		signal?.throwIfAborted();
		await handle.truncate(0);
		signal?.throwIfAborted();
		// This record is diagnostic only; flock owns the mutual-exclusion contract.
		await handle.writeFile(`${JSON.stringify({ pid: process.pid, token: randomUUID() })}\n`);
		signal?.throwIfAborted();
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			await handle.close();
		};
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

export function acquireSettingsLockEffect(
	lockPath = resolveSettingsLockPath(),
	owner = "pi-stuff",
): Effect.Effect<void, Error, Scope.Scope> {
	return Effect.acquireRelease(
		Effect.tryPromise({
			try: (signal) => acquireSettingsLockNative(lockPath, owner, signal),
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		}),
		(release) => Effect.promise(release),
		{ interruptible: true },
	).pipe(Effect.asVoid);
}
