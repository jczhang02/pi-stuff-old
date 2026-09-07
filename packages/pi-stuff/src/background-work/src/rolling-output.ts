import { randomUUID } from "node:crypto";
import {
	closeSync,
	fstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { formatSize } from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalWhitespace as sanitizeTerminalText } from "../../shared/terminal-text.ts";

const DEFAULT_ACTIVITY_OUTPUT_LIMIT = 20 * 1024 * 1024;
export const DEFAULT_MODEL_OUTPUT_LIMIT = 50 * 1024;
const MEMORY_TAIL_LIMIT = 64 * 1024;
const MIN_ROLLING_OUTPUT_LIMIT = 64;
const OMISSION_METADATA_SUFFIX = ".omitted-bytes";
const STABLE_READ_ATTEMPTS = 3;

type OmissionMetadata = {
	readonly entries: ReadonlyMap<string, number>;
	readonly kind: "valid";
	readonly raw: string;
};

type MetadataRead = OmissionMetadata | { readonly kind: "invalid" | "missing" };

export interface RollingOutputSnapshot {
	readonly buffer: Buffer;
	readonly omittedBytes: number;
	readonly totalBytes: number;
}

function completeUtf8End(buffer: Buffer): number {
	let end = buffer.length;
	while (end > 0) {
		let start = end - 1;
		while (start > 0 && ((buffer[start] ?? 0) & 0xc0) === 0x80) start -= 1;
		const lead = buffer[start] ?? 0;
		const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf8 ? 4 : 1;
		if (end - start >= width) return end;
		end = start;
	}
	return 0;
}

export function utf8SafeTail(buffer: Buffer, maxBytes: number): Buffer {
	let start = Math.max(0, buffer.length - Math.max(1, maxBytes));
	while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return buffer.subarray(start, completeUtf8End(buffer));
}

export function utf8SafePrefix(buffer: Buffer): Buffer {
	return buffer.subarray(0, completeUtf8End(buffer));
}

function durableByteTail(buffer: Buffer, maxBytes: number): Buffer {
	let start = Math.max(0, buffer.length - Math.max(1, maxBytes));
	while (start < buffer.length && ((buffer[start] ?? 0) & 0xc0) === 0x80) start += 1;
	return buffer.subarray(start);
}

export function visibleOmissionMarker(omittedBytes: number): string {
	return omittedBytes > 0 ? `…[${formatSize(omittedBytes)} earlier output bytes omitted]\n` : "";
}

function formatTextTail(selected: Buffer, omittedBytes: number): string {
	return sanitizeTerminalText(visibleOmissionMarker(omittedBytes) + selected.toString("utf-8")).trimEnd();
}

export function boundedTextTail(value: string, maxBytes = DEFAULT_MODEL_OUTPUT_LIMIT): string {
	const buffer = Buffer.from(value, "utf-8");
	const selected = utf8SafeTail(buffer, maxBytes);
	return formatTextTail(selected, buffer.length - selected.length);
}

function omissionMetadataPath(path: string): string {
	return path + OMISSION_METADATA_SUFFIX;
}

function readMetadata(path: string): MetadataRead {
	let raw: string;
	try {
		raw = readFileSync(omissionMetadataPath(path), "utf8");
	} catch (error) {
		return { kind: error instanceof Error && "code" in error && error.code === "ENOENT" ? "missing" : "invalid" };
	}
	const entries = new Map<string, number>();
	for (const line of raw.split("\n")) {
		const match = line.match(/^(\d+):(\d+):(\d+)$/u);
		if (!match) return { kind: "invalid" };
		const omittedBytes = Number(match[3]);
		const key = `${match[1] ?? ""}:${match[2] ?? ""}`;
		if (!Number.isSafeInteger(omittedBytes) || entries.has(key)) return { kind: "invalid" };
		entries.set(key, omittedBytes);
	}
	return entries.size > 0 && entries.size <= 2 ? { entries, kind: "valid", raw } : { kind: "invalid" };
}

function metadataForFiles(files: readonly { fd: number; omittedBytes: number }[]): Buffer {
	return Buffer.from(
		files
			.map(({ fd, omittedBytes }) => {
				const info = fstatSync(fd, { bigint: true });
				return `${String(info.dev)}:${String(info.ino)}:${String(omittedBytes)}`;
			})
			.join("\n"),
		"utf8",
	);
}

function closeQuietly(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		closeSync(fd);
	} catch {
		// Storage has already degraded; cleanup cannot restore durability.
	}
}

function removeQuietly(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// Temporary artifacts are private and a later root cleanup retries removal.
	}
}

function writeAll(fd: number, value: Buffer, writer: typeof writeSync, position = 0): void {
	let offset = 0;
	while (offset < value.length) {
		const written = writer(fd, value, offset, value.length - offset, position + offset);
		if (written <= 0) throw new Error("Background output write made no progress");
		offset += written;
	}
}

function matchingOmissionCount(before: MetadataRead, after: MetadataRead, device: string, inode: string) {
	if (before.kind === "missing" && after.kind === "missing") return 0;
	if (before.kind !== "valid" || after.kind !== "valid" || before.raw !== after.raw) return undefined;
	return before.entries.get(`${device}:${inode}`);
}

export function readRollingOutput(path: string, maxBytes?: number): RollingOutputSnapshot | undefined {
	for (let attempt = 0; attempt < STABLE_READ_ATTEMPTS; attempt += 1) {
		const before = readMetadata(path);
		let fd: number | undefined;
		try {
			fd = openSync(path, "r");
			const info = fstatSync(fd, { bigint: true });
			if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
			const totalBytes = Number(info.size);
			const requested = maxBytes === undefined ? totalBytes : Math.max(1, maxBytes);
			const bytes = Math.min(totalBytes, requested);
			const buffer = Buffer.alloc(bytes);
			const position = totalBytes - bytes;
			let offset = 0;
			while (offset < bytes) {
				const read = readSync(fd, buffer, offset, bytes - offset, position + offset);
				if (read <= 0) break;
				offset += read;
			}
			const after = readMetadata(path);
			const omittedBytes = matchingOmissionCount(before, after, String(info.dev), String(info.ino));
			if (omittedBytes !== undefined && offset === bytes) {
				return { buffer, omittedBytes, totalBytes };
			}
		} catch {
			return undefined;
		} finally {
			if (fd !== undefined) {
				try {
					closeSync(fd);
				} catch {
					// A read-only close failure cannot change Background Work lifecycle state.
				}
			}
		}
	}
	return undefined;
}

export class BoundedOutputFile {
	readonly path: string;
	private bytes = 0;
	private closed = false;
	private fd: number | undefined;
	private readonly closeFile: typeof closeSync;
	private readonly maxBytes: number;
	private omittedFileBytes = 0;
	private omittedTailBytes = 0;
	private overflow = false;
	private readonly renameFile: typeof renameSync;
	private storageError: string | undefined;
	private tail = Buffer.alloc(0);
	private readonly writeFile: typeof writeSync;

	constructor(
		path: string,
		maxBytes = DEFAULT_ACTIVITY_OUTPUT_LIMIT,
		deps: {
			readonly closeSync?: typeof closeSync;
			readonly renameSync?: typeof renameSync;
			readonly writeSync?: typeof writeSync;
		} = {},
	) {
		if (!Number.isSafeInteger(maxBytes) || maxBytes < MIN_ROLLING_OUTPUT_LIMIT) {
			throw new Error(
				"Background output retention must be a safe integer of at least " +
					String(MIN_ROLLING_OUTPUT_LIMIT) +
					" bytes",
			);
		}
		this.path = path;
		this.maxBytes = maxBytes;
		this.closeFile = deps.closeSync ?? closeSync;
		this.renameFile = deps.renameSync ?? renameSync;
		this.writeFile = deps.writeSync ?? writeSync;
		mkdirSync(dirname(path), { mode: 0o700, recursive: true });
		this.fd = openSync(path, "wx+", 0o600);
		try {
			const metadataFd = openSync(omissionMetadataPath(path), "wx", 0o600);
			try {
				writeAll(metadataFd, metadataForFiles([{ fd: this.fd, omittedBytes: 0 }]), writeSync);
			} finally {
				closeSync(metadataFd);
			}
		} catch (error) {
			closeSync(this.fd);
			rmSync(path, { force: true });
			rmSync(omissionMetadataPath(path), { force: true });
			throw error;
		}
	}

	get bytesWritten(): number {
		return this.bytes;
	}

	get overflowed(): boolean {
		return this.overflow;
	}

	get durable(): boolean {
		return this.storageError === undefined;
	}

	append(chunk: Buffer): boolean {
		if (this.closed) return false;
		this.remember(chunk);
		if (this.fd === undefined) return true;
		if (this.bytes + chunk.length <= this.maxBytes) {
			this.write(chunk);
			return true;
		}
		this.overflow = true;
		this.replaceWithTail(chunk);
		return true;
	}

	recentText(maxBytes = DEFAULT_MODEL_OUTPUT_LIMIT): string {
		const selected = utf8SafeTail(this.tail, maxBytes);
		return formatTextTail(selected, this.omittedTailBytes + this.tail.length - selected.length);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.closeStorage();
	}

	remove(): void {
		this.close();
		rmSync(this.path, { force: true });
		rmSync(omissionMetadataPath(this.path), { force: true });
	}

	private write(chunk: Buffer): void {
		if (this.fd === undefined) return;
		try {
			writeAll(this.fd, chunk, this.writeFile, this.bytes);
			this.bytes += chunk.length;
		} catch (error) {
			this.degradeStorage(error);
		}
	}

	private remember(chunk: Buffer): void {
		const joined = Buffer.concat([this.tail, chunk]);
		const start = Math.max(0, joined.length - MEMORY_TAIL_LIMIT);
		this.omittedTailBytes += start;
		this.tail = Buffer.from(joined.subarray(start));
	}

	private replaceWithTail(chunk: Buffer): void {
		if (this.fd === undefined) return;
		const token = `${String(process.pid)}.${randomUUID()}`;
		const replacementPath = `${this.path}.${token}.rolling`;
		const metadataPath = `${omissionMetadataPath(this.path)}.${token}.tmp`;
		let replacementFd: number | undefined;
		let metadataFd: number | undefined;
		try {
			const selected = this.replacementPayload(chunk);
			const omittedBytes = this.omittedFileBytes + this.bytes + chunk.length - selected.length;
			replacementFd = openSync(replacementPath, "wx+", 0o600);
			writeAll(replacementFd, selected, this.writeFile);
			metadataFd = openSync(metadataPath, "wx", 0o600);
			writeAll(
				metadataFd,
				metadataForFiles([
					{ fd: this.fd, omittedBytes: this.omittedFileBytes },
					{ fd: replacementFd, omittedBytes },
				]),
				writeSync,
			);
			closeSync(metadataFd);
			metadataFd = undefined;
			this.renameFile(metadataPath, omissionMetadataPath(this.path));
			this.renameFile(replacementPath, this.path);
			const previousFd = this.fd;
			this.fd = replacementFd;
			replacementFd = undefined;
			this.bytes = selected.length;
			this.omittedFileBytes = omittedBytes;
			this.closeFile(previousFd);
			this.compactMetadata(token);
		} catch (error) {
			this.degradeStorage(error);
		} finally {
			closeQuietly(replacementFd);
			closeQuietly(metadataFd);
			removeQuietly(replacementPath);
			removeQuietly(metadataPath);
		}
	}

	private replacementPayload(chunk: Buffer): Buffer {
		// Leave append headroom so small chunks do not rewrite the entire retained file.
		const retainedBytes = Math.floor(this.maxBytes / 2);
		if (this.fd === undefined || chunk.length >= retainedBytes) return durableByteTail(chunk, retainedBytes);
		const priorBytes = Math.min(this.bytes, retainedBytes - chunk.length);
		const prior = Buffer.allocUnsafe(priorBytes);
		let offset = 0;
		while (offset < prior.length) {
			const read = readSync(this.fd, prior, offset, prior.length - offset, this.bytes - prior.length + offset);
			if (read <= 0) throw new Error("Background output rollover read made no progress");
			offset += read;
		}
		return durableByteTail(Buffer.concat([prior, chunk]), retainedBytes);
	}

	private compactMetadata(token: string): void {
		if (this.fd === undefined) return;
		const path = `${omissionMetadataPath(this.path)}.${token}.compact`;
		let fd: number | undefined;
		try {
			fd = openSync(path, "wx", 0o600);
			writeAll(fd, metadataForFiles([{ fd: this.fd, omittedBytes: this.omittedFileBytes }]), writeSync);
			closeSync(fd);
			fd = undefined;
			this.renameFile(path, omissionMetadataPath(this.path));
		} catch {
			// The published two-generation metadata remains valid after a cleanup failure.
		} finally {
			closeQuietly(fd);
			removeQuietly(path);
		}
	}

	private degradeStorage(cause: unknown): void {
		if (this.storageError !== undefined) return;
		this.storageError = cause instanceof Error ? cause.message : String(cause);
		this.remember(Buffer.from(`\n[Background output storage failed: ${this.storageError}]\n`, "utf-8"));
		this.closeStorage();
	}

	private closeStorage(): void {
		const fd = this.fd;
		this.fd = undefined;
		if (fd === undefined) return;
		try {
			this.closeFile(fd);
		} catch (error) {
			this.degradeStorage(error);
		}
	}
}

export function tryReadBoundedTail(path: string, maxBytes = DEFAULT_MODEL_OUTPUT_LIMIT): string | undefined {
	const snapshot = readRollingOutput(path, maxBytes);
	if (!snapshot) return undefined;
	const selected = utf8SafeTail(snapshot.buffer, maxBytes);
	return formatTextTail(selected, snapshot.omittedBytes + snapshot.totalBytes - selected.length);
}
