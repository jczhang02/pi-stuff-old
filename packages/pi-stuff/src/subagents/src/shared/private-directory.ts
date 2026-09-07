import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonValue } from "../../../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import { readProcessStartIdentity } from "./process-identity.ts";

export function errnoCode<Value>(cause: Value): string | undefined {
	if (!isRuntimeObject(cause) || cause === null || !("code" in cause)) return undefined;
	return isRuntimeString(cause.code) ? cause.code : undefined;
}

function noFollowFlag(): number {
	// SAFETY: Node exposes O_NOFOLLOW only on supporting platforms; this reads that optional numeric constant.
	return (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
}

function notFound(cause: unknown): boolean {
	return errnoCode(cause) === "ENOENT";
}

/** Create or validate an Agent runtime directory without accepting symlink ownership. */
export function ensurePrivateDirectory(directory: string): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(directory);
	} catch (error) {
		if (!notFound(error)) throw error;
		fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
		stat = fs.lstatSync(directory);
	}
	assertPrivateDirectory(directory, stat);
	fs.chmodSync(directory, 0o700);
}

/** Claim one new Agent run directory until its lifecycle owner commits it. */
export function claimPreparedRunDirectory(directory: string, kind: "background" | "foreground") {
	try {
		fs.mkdirSync(directory, { mode: 0o700 });
	} catch (error) {
		if (errnoCode(error) === "EEXIST") {
			throw new Error(
				`${kind === "foreground" ? "Foreground" : "Background"} Agent runtime '${directory}' already exists; refusing to overwrite retained lifecycle evidence.`,
			);
		}
		throw error;
	}
	const created = fs.lstatSync(directory);
	const token = randomUUID();
	const markerPath = path.join(directory, `.${kind}-preparation-owner.json`);
	let committed = false;
	let removed = false;
	const stillCreated = (): boolean => {
		if (removed) return false;
		try {
			const current = fs.lstatSync(directory);
			return current.isDirectory() && current.dev === created.dev && current.ino === created.ino;
		} catch {
			return false;
		}
	};
	const removeCreated = (): boolean => {
		if (removed) return true;
		if (!stillCreated()) return false;
		const failedPath = `${directory}.failed-${token}`;
		try {
			fs.renameSync(directory, failedPath);
			const moved = fs.lstatSync(failedPath);
			if (!moved.isDirectory() || moved.dev !== created.dev || moved.ino !== created.ino) return false;
			fs.rmSync(failedPath, { recursive: true });
			removed = true;
			return true;
		} catch {
			// Preserve unproven lifecycle evidence instead of deleting through an ownership race.
			return false;
		}
	};
	try {
		ensurePrivateDirectory(directory);
		fs.writeFileSync(
			markerPath,
			`${JSON.stringify({
				version: 2,
				token,
				pid: process.pid,
				processStartIdentity: readProcessStartIdentity(process.pid),
				createdAt: Date.now(),
				device: created.dev,
				inode: created.ino,
			})}\n`,
			{ encoding: "utf8", flag: "wx", mode: 0o600 },
		);
	} catch (error) {
		removeCreated();
		throw error;
	}
	const stillOwned = (): boolean => {
		if (committed || !stillCreated()) return false;
		try {
			const marker = parseJsonValue(readBoundedOwnedFile(markerPath, 4 * 1024));
			return isRuntimeObject(marker) && marker !== null && !Array.isArray(marker) && marker["token"] === token;
		} catch {
			return false;
		}
	};
	return {
		cleanup: () => {
			if (stillOwned()) removeCreated();
		},
		commit: () => {
			if (!stillOwned()) return false;
			try {
				fs.unlinkSync(markerPath);
				committed = true;
				return true;
			} catch {
				return false;
			}
		},
		isCommitted: () => committed,
		isRemoved: () => removed,
		removeCreated,
		stillCreated,
	};
}

/** Validate an existing Agent runtime directory without creating it. */
export function assertPrivateDirectory(directory: string, knownStat?: fs.Stats): void {
	const stat = knownStat ?? fs.lstatSync(directory);
	if (stat.isSymbolicLink() || !stat.isDirectory()) {
		throw new Error(`Agent runtime path '${directory}' must be a real directory, not a symlink.`);
	}
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && stat.uid !== currentUid) {
		throw new Error(`Agent runtime path '${directory}' is owned by another user.`);
	}
}

function relativeDirectorySegments(root: string, directory: string): string[] {
	const resolvedRoot = path.resolve(root);
	const resolvedDirectory = path.resolve(directory);
	const relative = path.relative(resolvedRoot, resolvedDirectory);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Agent runtime path '${directory}' is outside '${root}'.`);
	}
	return relative ? relative.split(path.sep) : [];
}

/** Validate every directory component below an already trusted private root. */
export function assertPrivateDirectoryWithin(root: string, directory: string): void {
	assertPrivateDirectory(root);
	let cursor = path.resolve(root);
	for (const segment of relativeDirectorySegments(root, directory)) {
		cursor = path.join(cursor, segment);
		assertPrivateDirectory(cursor);
	}
}

/**
 * Create a private descendant one component at a time. This deliberately avoids
 * recursive mkdir traversing an unvalidated intermediate symlink.
 */
export function ensurePrivateDirectoryWithin(root: string, directory: string): void {
	assertPrivateDirectory(root);
	let cursor = path.resolve(root);
	for (const segment of relativeDirectorySegments(root, directory)) {
		cursor = path.join(cursor, segment);
		try {
			fs.mkdirSync(cursor, { mode: 0o700 });
		} catch (error) {
			if (errnoCode(error) !== "EEXIST") throw error;
		}
		assertPrivateDirectory(cursor);
		fs.chmodSync(cursor, 0o700);
	}
}

function assertOwnedRegularFile(filePath: string, stat: fs.Stats, maxBytes?: number): void {
	if (!stat.isFile()) throw new Error(`Agent runtime file '${filePath}' must be a regular file.`);
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && stat.uid !== currentUid) {
		throw new Error(`Agent runtime file '${filePath}' is owned by another user.`);
	}
	if (maxBytes !== undefined && stat.size > maxBytes) {
		throw new Error(`Agent runtime file '${filePath}' exceeds the ${maxBytes}-byte limit.`);
	}
}

function openOwnedRegularFile(filePath: string, maxBytes?: number): number {
	const noFollow = noFollowFlag();
	let fd: number;
	try {
		fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
	} catch (error) {
		if (errnoCode(error) === "ELOOP") {
			throw new Error(`Agent runtime file '${filePath}' must not be a symbolic link.`, { cause: error });
		}
		throw error;
	}
	try {
		assertOwnedRegularFile(filePath, fs.fstatSync(fd), maxBytes);
		return fd;
	} catch (error) {
		fs.closeSync(fd);
		throw error;
	}
}

export interface OwnedFileSnapshot {
	readonly ctimeMs: number;
	readonly dev: number;
	readonly ino: number;
	readonly mtimeMs: number;
	readonly size: number;
	readonly text: string;
}

export type OwnedFileRemoval = "removed" | "missing" | "changed";

/** A concurrent writer replaced or mutated a file while one snapshot was open. */
export class OwnedFileChangedDuringReadError extends Error {
	constructor(filePath: string) {
		super(`Agent runtime file '${filePath}' changed while it was being read.`);
		this.name = "OwnedFileChangedDuringReadError";
	}
}

/** Recognize a transient snapshot race through any local error wrappers. */
export function isOwnedFileChangedDuringReadError(cause: unknown): boolean {
	let current = cause;
	for (let depth = 0; depth < 8; depth += 1) {
		if (current instanceof OwnedFileChangedDuringReadError) return true;
		if (!isRuntimeObject(current) || current === null || !("cause" in current)) return false;
		current = current.cause;
	}
	return false;
}

export type FileVersion = Pick<fs.Stats, "ctimeMs" | "dev" | "ino" | "mtimeMs" | "size">;

export function sameFileVersion(before: FileVersion, after: FileVersion): boolean {
	return (
		before.dev === after.dev &&
		before.ino === after.ino &&
		before.size === after.size &&
		before.ctimeMs === after.ctimeMs &&
		before.mtimeMs === after.mtimeMs
	);
}

function readExactFileVersion(fd: number, size: number, filePath: string, position = 0): Buffer {
	const buffer = Buffer.alloc(size);
	let offset = 0;
	while (offset < size) {
		const read = fs.readSync(fd, buffer, offset, size - offset, position + offset);
		if (read === 0) throw new OwnedFileChangedDuringReadError(filePath);
		offset += read;
	}
	return buffer;
}

/** Read one opened, owner-controlled bounded regular file and its fd metadata. */
export function readBoundedOwnedFileSnapshot(filePath: string, maxBytes: number): OwnedFileSnapshot {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Owned file byte limit must be non-negative.");
	const fd = openOwnedRegularFile(filePath, maxBytes);
	try {
		const stat = fs.fstatSync(fd);
		const text = readExactFileVersion(fd, stat.size, filePath).toString("utf-8");
		const after = fs.fstatSync(fd);
		if (!sameFileVersion(stat, after)) {
			throw new OwnedFileChangedDuringReadError(filePath);
		}
		return {
			ctimeMs: stat.ctimeMs,
			dev: stat.dev,
			ino: stat.ino,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			text,
		};
	} finally {
		fs.closeSync(fd);
	}
}

/** Async counterpart for Host-side observers that must never block the TUI thread. */
export async function readBoundedOwnedFileSnapshotAsync(
	filePath: string,
	maxBytes: number,
): Promise<OwnedFileSnapshot> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Owned file byte limit must be non-negative.");
	const noFollow = noFollowFlag();
	let handle: fs.promises.FileHandle;
	try {
		handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
	} catch (error) {
		if (errnoCode(error) === "ELOOP") {
			throw new Error(`Agent runtime file '${filePath}' must not be a symbolic link.`, { cause: error });
		}
		throw error;
	}
	try {
		const stat = await handle.stat();
		assertOwnedRegularFile(filePath, stat, maxBytes);
		const buffer = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
			if (bytesRead === 0) throw new OwnedFileChangedDuringReadError(filePath);
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (!sameFileVersion(stat, after)) throw new OwnedFileChangedDuringReadError(filePath);
		return {
			ctimeMs: stat.ctimeMs,
			dev: stat.dev,
			ino: stat.ino,
			mtimeMs: stat.mtimeMs,
			size: stat.size,
			text: buffer.toString("utf-8"),
		};
	} finally {
		await handle.close();
	}
}

/** Atomically remove only the exact regular-file snapshot previously read. */
export function removeOwnedFileSnapshot(filePath: string, snapshot: OwnedFileSnapshot): OwnedFileRemoval {
	const quarantinePath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.consumed-${randomUUID()}`);
	try {
		fs.renameSync(filePath, quarantinePath);
	} catch (error) {
		if (notFound(error)) return "missing";
		throw error;
	}
	const moved = fs.lstatSync(quarantinePath);
	const unchanged =
		moved.isFile() &&
		moved.dev === snapshot.dev &&
		moved.ino === snapshot.ino &&
		moved.size === snapshot.size &&
		moved.mtimeMs === snapshot.mtimeMs;
	if (!unchanged) {
		try {
			// Hard-link restoration has no-overwrite semantics. If a new canonical
			// file already exists, retain this unproven inode under quarantine.
			fs.linkSync(quarantinePath, filePath);
			fs.unlinkSync(quarantinePath);
		} catch {
			// Preserve the unproven replacement for diagnostics and later recovery.
		}
		return "changed";
	}
	fs.unlinkSync(quarantinePath);
	return "removed";
}

/** Async counterpart for Host-side result consumption. */
export async function removeOwnedFileSnapshotAsync(
	filePath: string,
	snapshot: OwnedFileSnapshot,
): Promise<OwnedFileRemoval> {
	const quarantinePath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.consumed-${randomUUID()}`);
	try {
		await fs.promises.rename(filePath, quarantinePath);
	} catch (error) {
		if (notFound(error)) return "missing";
		throw error;
	}
	const moved = await fs.promises.lstat(quarantinePath);
	const unchanged =
		moved.isFile() &&
		moved.dev === snapshot.dev &&
		moved.ino === snapshot.ino &&
		moved.size === snapshot.size &&
		moved.mtimeMs === snapshot.mtimeMs;
	if (!unchanged) {
		try {
			await fs.promises.link(quarantinePath, filePath);
			await fs.promises.unlink(quarantinePath);
		} catch {
			// Preserve the unproven replacement for diagnostics and later recovery.
		}
		return "changed";
	}
	await fs.promises.unlink(quarantinePath);
	return "removed";
}

/** Read one owner-controlled bounded regular file without following symlinks. */
export function readBoundedOwnedFile(filePath: string, maxBytes: number): string {
	return readBoundedOwnedFileSnapshot(filePath, maxBytes).text;
}

export interface OwnedFileTail {
	readonly dev: number;
	readonly ino: number;
	readonly mtimeMs: number;
	readonly size: number;
	readonly text: string;
}

/** Async counterpart for Host-side recovery and detail readers. */
export async function readOwnedFileTailAsync(filePath: string, maxBytes: number): Promise<OwnedFileTail> {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error("Owned file tail limit must be non-negative.");
	const noFollow = noFollowFlag();
	const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
	try {
		const stat = await handle.stat();
		assertOwnedRegularFile(filePath, stat);
		const start = Math.max(0, stat.size - Math.max(0, maxBytes));
		const buffer = Buffer.alloc(stat.size - start);
		let offset = 0;
		while (offset < buffer.length) {
			const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, start + offset);
			if (bytesRead === 0) throw new OwnedFileChangedDuringReadError(filePath);
			offset += bytesRead;
		}
		let text = buffer.toString("utf-8");
		if (start > 0) {
			const preceding = Buffer.alloc(1);
			await handle.read(preceding, 0, 1, start - 1);
			if (preceding[0] !== 0x0a) {
				const newline = text.indexOf("\n");
				text = newline === -1 ? "" : text.slice(newline + 1);
			}
		}
		const after = await handle.stat();
		if (!sameFileVersion(stat, after)) throw new OwnedFileChangedDuringReadError(filePath);
		return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size, text };
	} finally {
		await handle.close();
	}
}

/** Validate an owner-controlled regular file and return its absolute path. */
export function validateOwnedRegularFile(filePath: string, maxBytes?: number): string {
	const resolved = path.resolve(filePath);
	if (fs.lstatSync(filePath).isSymbolicLink())
		throw new Error(`Agent runtime file '${filePath}' must not be a symbolic link.`);
	const fd = openOwnedRegularFile(filePath, maxBytes);
	try {
		assertOwnedRegularFile(filePath, fs.fstatSync(fd), maxBytes);
	} finally {
		fs.closeSync(fd);
	}
	return resolved;
}
