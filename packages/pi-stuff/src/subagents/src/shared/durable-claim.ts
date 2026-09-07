import { dlopen, FFIType, ptr } from "bun:ffi";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import { assertPrivateDirectory } from "./private-directory.ts";
import { readProcessStartIdentity } from "./process-identity.ts";

const LOCK_EXCLUSIVE_NONBLOCKING = 2 | 4;
const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
const LOCKFILE_FAIL_IMMEDIATELY = 0x1;

export interface DurableClaim {
	/** Stable lock-file path; retained for diagnostics and never unlinked. */
	readonly directory: string;
	readonly token: string;
	release(): void;
}

export interface AsyncDurableClaim {
	readonly directory: string;
	readonly token: string;
	release(): Promise<void>;
}

function safeClaimName(name: string): string {
	if (!/^[A-Za-z0-9._-]{1,240}$/u.test(name) || name === "." || name === "..") {
		throw new Error("Durable claim name must be one safe path component.");
	}
	return name;
}

function errorCode<Value>(value: Value): string | undefined {
	return isRuntimeObject(value) && value !== null && "code" in value && isRuntimeString(value.code)
		? value.code
		: undefined;
}

/** Map an unbounded stream of logical owners onto a fixed set of lock inodes. */
export function shardedDurableClaimName(namespace: string, key: string, shardCount = 256): string {
	const safeNamespace = safeClaimName(namespace);
	if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > 4_096) {
		throw new Error("Durable claim shard count must be an integer between 1 and 4096.");
	}
	const digest = createHash("sha256").update(key).digest();
	const shard = digest.readUInt32BE(0) % shardCount;
	return safeClaimName(`${safeNamespace}-${shard.toString(16).padStart(3, "0")}`);
}

function flockLibraryName(platform: NodeJS.Platform): string {
	if (platform === "linux") return "libc.so.6";
	if (platform === "darwin") return "/usr/lib/libSystem.B.dylib";
	if (platform === "freebsd") return "libc.so.7";
	throw new Error(`Durable flock claims are unsupported on ${platform}.`);
}

function loadFlockLibrary() {
	return dlopen(flockLibraryName(process.platform), {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	});
}

let flockLibrary: ReturnType<typeof loadFlockLibrary> | undefined;

function tryFlock(fileDescriptor: number): boolean {
	flockLibrary ??= loadFlockLibrary();
	return flockLibrary.symbols.flock(fileDescriptor, LOCK_EXCLUSIVE_NONBLOCKING) === 0;
}

function loadWindowsCrtLibrary() {
	return dlopen("ucrtbase.dll", {
		_get_osfhandle: { args: [FFIType.i32], returns: FFIType.i64 },
	});
}

function loadWindowsKernelLibrary() {
	return dlopen("kernel32.dll", {
		LockFileEx: {
			args: [FFIType.i64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
			returns: FFIType.i32,
		},
	});
}

let windowsCrtLibrary: ReturnType<typeof loadWindowsCrtLibrary> | undefined;
let windowsKernelLibrary: ReturnType<typeof loadWindowsKernelLibrary> | undefined;

function tryWindowsFileLock(fileDescriptor: number): boolean {
	windowsCrtLibrary ??= loadWindowsCrtLibrary();
	windowsKernelLibrary ??= loadWindowsKernelLibrary();
	const handle = windowsCrtLibrary.symbols._get_osfhandle(fileDescriptor);
	if (handle === -1n) throw new Error("Unable to resolve the Windows handle for a durable claim.");
	// OVERLAPPED is 32 bytes on the 64-bit Windows targets supported by Bun.
	// A zero offset locks byte zero; closing the descriptor releases ownership,
	// including after process death, matching flock's crash semantics.
	const overlapped = Buffer.alloc(32);
	return (
		windowsKernelLibrary.symbols.LockFileEx(
			handle,
			LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
			0,
			1,
			0,
			ptr(overlapped),
		) !== 0
	);
}

export function durableClaimBackendForPlatform(platform: NodeJS.Platform): "flock" | "windows-lock-file-ex" {
	if (platform === "win32") return "windows-lock-file-ex";
	flockLibraryName(platform);
	return "flock";
}

function tryLock(fileDescriptor: number): boolean {
	return durableClaimBackendForPlatform(process.platform) === "windows-lock-file-ex"
		? tryWindowsFileLock(fileDescriptor)
		: tryFlock(fileDescriptor);
}

/**
 * Atomically acquire one process-owned claim below a private directory.
 *
 * A stable lock inode plus the kernel's open-file lease avoids stale-owner
 * recovery entirely: closing the descriptor (including process death) releases
 * ownership, so no check-then-rename can ever pre-empt a newer owner.
 */
function tryAcquireClaim(parentDirectory: string, name: string, persistOwner: boolean): DurableClaim | undefined {
	assertPrivateDirectory(parentDirectory);
	const lockPath = path.join(parentDirectory, `${safeClaimName(name)}.lock`);
	if (path.dirname(lockPath) !== path.resolve(parentDirectory)) {
		throw new Error("Durable claim path escaped its private parent directory.");
	}
	const flags = fs.constants.O_CREAT | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0);
	let descriptor: number;
	try {
		descriptor = fs.openSync(lockPath, flags, 0o600);
	} catch (error) {
		const code = errorCode(error);
		if (code === "EISDIR" || code === "ELOOP") {
			throw new Error(`Durable claim '${lockPath}' must be a regular file.`, {
				cause: error instanceof Error ? error : undefined,
			});
		}
		throw error;
	}
	let keepOpen = false;
	try {
		const stat = fs.fstatSync(descriptor);
		const currentUid = process.getuid?.();
		if (!stat.isFile() || (currentUid !== undefined && stat.uid !== currentUid)) {
			throw new Error(`Durable claim '${lockPath}' must be a regular file owned by the current user.`);
		}
		if ((stat.mode & 0o777) !== 0o600) fs.fchmodSync(descriptor, 0o600);
		if (!tryLock(descriptor)) return undefined;
		const token = randomUUID();
		if (persistOwner) {
			const owner = {
				version: 2,
				token,
				pid: process.pid,
				processStartIdentity: readProcessStartIdentity(process.pid) ?? `pid-only:${process.pid}`,
				createdAt: Date.now(),
			};
			fs.ftruncateSync(descriptor, 0);
			fs.writeSync(descriptor, `${JSON.stringify(owner)}\n`, 0, "utf-8");
			fs.fsyncSync(descriptor);
		}
		let released = false;
		keepOpen = true;
		return {
			directory: lockPath,
			token,
			release: () => {
				if (released) return;
				released = true;
				fs.closeSync(descriptor);
			},
		};
	} finally {
		if (!keepOpen) fs.closeSync(descriptor);
	}
}

export function tryAcquireDurableClaim(parentDirectory: string, name: string): DurableClaim | undefined {
	return tryAcquireClaim(parentDirectory, name, true);
}

/**
 * Acquire the same process-death-safe stable-inode claim without persisting an
 * owner record. Hot synchronization paths can therefore open/flock/close for
 * each short critical section without forcing an fsync on every event.
 */
export function tryAcquireKernelClaim(parentDirectory: string, name: string): DurableClaim | undefined {
	return tryAcquireClaim(parentDirectory, name, false);
}

/** Async Host-side kernel claim; only the in-memory flock operation is synchronous. */
export async function tryAcquireKernelClaimAsync(
	parentDirectory: string,
	name: string,
): Promise<AsyncDurableClaim | undefined> {
	const parentStat = await fs.promises.lstat(parentDirectory);
	assertPrivateDirectory(parentDirectory, parentStat);
	const lockPath = path.join(parentDirectory, `${safeClaimName(name)}.lock`);
	if (path.dirname(lockPath) !== path.resolve(parentDirectory)) {
		throw new Error("Durable claim path escaped its private parent directory.");
	}
	const flags = fs.constants.O_CREAT | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW ?? 0);
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(lockPath, flags, 0o600);
	} catch (error) {
		const code = errorCode(error);
		if (code === "EISDIR" || code === "ELOOP") {
			throw new Error(`Durable claim '${lockPath}' must be a regular file.`, {
				cause: error instanceof Error ? error : undefined,
			});
		}
		throw error;
	}
	let keepOpen = false;
	try {
		const stat = await handle.stat();
		const currentUid = process.getuid?.();
		if (!stat.isFile() || (currentUid !== undefined && stat.uid !== currentUid)) {
			throw new Error(`Durable claim '${lockPath}' must be a regular file owned by the current user.`);
		}
		if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600);
		if (!tryLock(handle.fd)) return undefined;
		const token = randomUUID();
		let released = false;
		keepOpen = true;
		return {
			directory: lockPath,
			token,
			release: async () => {
				if (released) return;
				released = true;
				await handle.close();
			},
		};
	} finally {
		if (!keepOpen) await handle.close();
	}
}
