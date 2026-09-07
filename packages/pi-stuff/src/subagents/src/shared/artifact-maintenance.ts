import * as fs from "node:fs";
import * as path from "node:path";
import { type JsonValue, parseJsonValue } from "../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import {
	ARTIFACT_CLEANUP_CONTROL_DIRECTORY,
	ARTIFACT_MAINTENANCE_INTERVAL_MS,
	artifactBaseName,
	artifactGroupNames,
	hasErrorCode,
} from "./artifact-files.ts";
import { type DirectoryScanCursor, ownedRegularFile, scanDirectoryNames } from "./artifact-snapshot.ts";
import { writePrivateAtomicTextAsync } from "./atomic-json.ts";
import { shardedDurableClaimName, tryAcquireDurableClaim } from "./durable-claim.ts";
import { TEMP_ARTIFACTS_DIR } from "./types.ts";
import { getAgentSessionsDir } from "./utils.ts";

const CLEANUP_MARKER_FILE = ".last-cleanup";
const CLEANUP_CURSOR_FILE = ".cleanup-cursor";
const DISCOVERY_CURSOR_FILE = ".artifact-cleanup-frontier";
const LEGACY_DISCOVERY_CONTROL_DIRECTORY = ".artifact-cleanup-snapshots";
const ARTIFACT_DIRECTORY_NAME = "subagent-artifacts";
const MAX_ARTIFACT_DIRECTORIES_PER_PASS = 5_000;
const MAX_ARTIFACT_ENTRIES_PER_PASS = 50_000;
const MAX_DISCOVERY_CURSOR_BYTES = 1024 * 1024;

export interface ArtifactMaintenanceReport {
	readonly directoriesInspected: number;
	readonly filesRemoved: number;
	readonly bytesReclaimed: number;
	readonly scanComplete: boolean;
}

export interface ArtifactMaintenanceOptions {
	readonly sessionsRoot?: string;
	readonly tempArtifactsDir?: string;
	readonly now?: number;
	readonly maxDirectories?: number;
	readonly maxEntries?: number;
}

interface ArtifactCleanupBudget {
	entries: number;
	readonly maxEntries: number;
}

function orderedArtifactGroupNames(base: string): string[] {
	return artifactGroupNames(base).sort((left, right) => {
		const terminalProofOrder = Number(left.endsWith("_meta.json")) - Number(right.endsWith("_meta.json"));
		return terminalProofOrder || left.localeCompare(right);
	});
}

function isTerminalArtifactMetadata<Value>(value: Value): boolean {
	if (!value || !isRuntimeObject(value) || value === null || Array.isArray(value)) return false;
	const state = "state" in value ? value.state : undefined;
	if (state === "running" || state === "queued") return false;
	if (["complete", "failed", "stopped"].includes(String(state))) return true;
	const exitCode = "exitCode" in value ? value.exitCode : undefined;
	return isRuntimeNumber(exitCode) && Number.isFinite(exitCode);
}

async function ownedDirectory(directory: string): Promise<boolean> {
	try {
		const stat = await fs.promises.lstat(directory);
		const currentUid = process.getuid?.();
		return stat.isDirectory() && !stat.isSymbolicLink() && (currentUid === undefined || stat.uid === currentUid);
	} catch {
		return false;
	}
}

async function cleanupMarkerIsFresh(directory: string, now: number): Promise<boolean> {
	try {
		const marker = await fs.promises.lstat(path.join(directory, CLEANUP_MARKER_FILE));
		const currentUid = process.getuid?.();
		return (
			marker.isFile() &&
			!marker.isSymbolicLink() &&
			(currentUid === undefined || marker.uid === currentUid) &&
			now - marker.mtimeMs < ARTIFACT_MAINTENANCE_INTERVAL_MS
		);
	} catch {
		return false;
	}
}

async function ensureControlDirectory(directory: string): Promise<string> {
	const control = path.join(directory, ARTIFACT_CLEANUP_CONTROL_DIRECTORY);
	try {
		await fs.promises.mkdir(control, { mode: 0o700 });
	} catch (error) {
		if (!hasErrorCode(error, "EEXIST")) throw error;
	}
	if (!(await ownedDirectory(control))) throw new Error("Invalid artifact cleanup control directory.");
	await fs.promises.chmod(control, 0o700);
	return control;
}

function cursorFromValue(value: JsonValue): DirectoryScanCursor | undefined {
	if (!value || !isRuntimeObject(value) || value === null || Array.isArray(value) || value["version"] !== 1) {
		return undefined;
	}
	const dev = value["dev"];
	const ino = value["ino"];
	const cookie = value["cookie"];
	if (
		!isRuntimeNumber(dev) ||
		!Number.isSafeInteger(dev) ||
		dev < 0 ||
		!isRuntimeNumber(ino) ||
		!Number.isSafeInteger(ino) ||
		ino < 0 ||
		!isRuntimeString(cookie) ||
		!/^\d+$/u.test(cookie)
	) {
		return undefined;
	}
	return { cookie, dev, ino };
}

async function readCursor(filePath: string): Promise<DirectoryScanCursor | undefined> {
	try {
		const stat = await fs.promises.lstat(filePath);
		if (!ownedRegularFile(stat) || stat.size > 4_096) return undefined;
		return cursorFromValue(parseJsonValue(await fs.promises.readFile(filePath, "utf8")));
	} catch {
		return undefined;
	}
}

async function writeCursor(filePath: string, cursor: DirectoryScanCursor): Promise<void> {
	await writePrivateAtomicTextAsync(filePath, `${JSON.stringify({ version: 1, ...cursor })}\n`);
}

function terminalArtifactGroup(directory: string, base: string, cutoff: number): boolean {
	try {
		const metadataPath = path.join(directory, `${base}_meta.json`);
		const metadataStat = fs.lstatSync(metadataPath);
		if (!ownedRegularFile(metadataStat) || metadataStat.mtimeMs >= cutoff || metadataStat.size > 64 * 1024) {
			return false;
		}
		if (!isTerminalArtifactMetadata(parseJsonValue(fs.readFileSync(metadataPath, "utf8")))) return false;
		for (const name of artifactGroupNames(base)) {
			try {
				const stat = fs.lstatSync(path.join(directory, name));
				if (!ownedRegularFile(stat) || stat.mtimeMs >= cutoff) return false;
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

async function removeTerminalArtifactGroup(
	directory: string,
	base: string,
	cutoff: number,
): Promise<{ filesRemoved: number; bytesReclaimed: number }> {
	let claim: ReturnType<typeof tryAcquireDurableClaim>;
	try {
		claim = tryAcquireDurableClaim(
			await ensureControlDirectory(directory),
			shardedDurableClaimName("artifact-group", base),
		);
	} catch {
		return { filesRemoved: 0, bytesReclaimed: 0 };
	}
	if (!claim) return { filesRemoved: 0, bytesReclaimed: 0 };
	let filesRemoved = 0;
	let bytesReclaimed = 0;
	try {
		if (!terminalArtifactGroup(directory, base, cutoff)) return { filesRemoved, bytesReclaimed };
		for (const name of orderedArtifactGroupNames(base)) {
			try {
				const candidate = path.join(directory, name);
				const stat = fs.lstatSync(candidate);
				if (!ownedRegularFile(stat) || stat.mtimeMs >= cutoff) return { filesRemoved, bytesReclaimed };
				fs.unlinkSync(candidate);
				filesRemoved += 1;
				bytesReclaimed += stat.size;
			} catch (error) {
				if (!hasErrorCode(error, "ENOENT")) return { filesRemoved, bytesReclaimed };
			}
		}
		return { filesRemoved, bytesReclaimed };
	} finally {
		claim.release();
	}
}

async function cleanArtifactDirectory(
	directory: string,
	cutoff: number,
	now: number,
	budget: ArtifactCleanupBudget,
): Promise<{ filesRemoved: number; bytesReclaimed: number; complete: boolean }> {
	if (!(await ownedDirectory(directory)) || (await cleanupMarkerIsFresh(directory, now))) {
		return { filesRemoved: 0, bytesReclaimed: 0, complete: true };
	}
	let control: string;
	let claim: ReturnType<typeof tryAcquireDurableClaim>;
	try {
		control = await ensureControlDirectory(directory);
		claim = tryAcquireDurableClaim(control, "maintenance");
	} catch {
		return { filesRemoved: 0, bytesReclaimed: 0, complete: false };
	}
	if (!claim) return { filesRemoved: 0, bytesReclaimed: 0, complete: false };
	const cursorPath = path.join(control, CLEANUP_CURSOR_FILE);
	let filesRemoved = 0;
	let bytesReclaimed = 0;
	try {
		const bases: string[] = [];
		const scan = await scanDirectoryNames(
			directory,
			await readCursor(cursorPath),
			Math.max(0, budget.maxEntries - budget.entries),
			(name, type) => {
				if (type === 10 || !name.endsWith("_meta.json")) return undefined;
				const base = artifactBaseName(name);
				if (base) bases.push(base);
				return undefined;
			},
		);
		budget.entries += scan.scanned;
		for (const base of bases) {
			const removed = await removeTerminalArtifactGroup(directory, base, cutoff);
			filesRemoved += removed.filesRemoved;
			bytesReclaimed += removed.bytesReclaimed;
		}
		if (scan.complete) {
			await fs.promises.unlink(cursorPath).catch(() => undefined);
			await writePrivateAtomicTextAsync(path.join(directory, CLEANUP_MARKER_FILE), `${String(now)}\n`);
		} else if (scan.cursor) {
			await writeCursor(cursorPath, scan.cursor);
		}
		return { filesRemoved, bytesReclaimed, complete: scan.complete };
	} catch {
		await fs.promises.unlink(cursorPath).catch(() => undefined);
		return { filesRemoved, bytesReclaimed, complete: false };
	} finally {
		claim.release();
	}
}

interface DiscoveryFrame {
	readonly artifact?: true;
	readonly cursor?: DirectoryScanCursor;
	readonly directory: string;
}

function safeDiscoveryDirectory<Value>(value: Value): value is Value & string {
	if (!isRuntimeString(value) || value.length === 0 || value.length > 4_096 || path.isAbsolute(value)) return false;
	return !value.split(/[\\/]+/u).some((part) => part === ".." || part.includes("\0"));
}

function discoveryFrame(value: JsonValue): DiscoveryFrame | undefined {
	if (!value || !isRuntimeObject(value) || value === null || Array.isArray(value)) return undefined;
	if (!safeDiscoveryDirectory(value["directory"])) return undefined;
	if (value["artifact"] !== undefined && value["artifact"] !== true) return undefined;
	const cursor = value["cursor"] === undefined ? undefined : cursorFromValue(value["cursor"]);
	if (value["cursor"] !== undefined && !cursor) return undefined;
	const directory = value["directory"];
	if (value["artifact"] === true)
		return cursor ? { artifact: true, cursor, directory } : { artifact: true, directory };
	return cursor ? { cursor, directory } : { directory };
}

async function readDiscoveryFrontier(control: string): Promise<DiscoveryFrame[] | undefined> {
	try {
		const filePath = path.join(control, DISCOVERY_CURSOR_FILE);
		const stat = await fs.promises.lstat(filePath);
		if (!ownedRegularFile(stat) || stat.size > MAX_DISCOVERY_CURSOR_BYTES) return undefined;
		const value = parseJsonValue(await fs.promises.readFile(filePath, "utf8"));
		if (
			!value ||
			!isRuntimeObject(value) ||
			Array.isArray(value) ||
			value["version"] !== 4 ||
			!Array.isArray(value["pending"]) ||
			value["pending"].length > MAX_ARTIFACT_ENTRIES_PER_PASS
		) {
			return undefined;
		}
		const frames = value["pending"].map(discoveryFrame);
		return frames.every((frame): frame is DiscoveryFrame => frame !== undefined) ? frames : undefined;
	} catch {
		return undefined;
	}
}

async function writeDiscoveryFrontier(control: string, pending: readonly DiscoveryFrame[]): Promise<void> {
	const frames = pending.map(({ cursor, ...frame }) =>
		cursor ? { ...frame, cursor: { version: 1, ...cursor } } : frame,
	);
	const content = `${JSON.stringify({ version: 4, pending: frames })}\n`;
	if (Buffer.byteLength(content, "utf8") > MAX_DISCOVERY_CURSOR_BYTES) {
		throw new Error("Artifact discovery frontier exceeded its persistence bound.");
	}
	await writePrivateAtomicTextAsync(path.join(control, DISCOVERY_CURSOR_FILE), content);
}

function resolveDiscoveryFrame(root: string, frame: DiscoveryFrame): string | undefined {
	const candidate = path.resolve(root, frame.directory);
	const relative = path.relative(root, candidate);
	return relative.startsWith("..") || path.isAbsolute(relative) ? undefined : candidate;
}

async function findSessionArtifactDirectories(
	root: string,
	maximum: number,
	now: number,
	budget: ArtifactCleanupBudget,
): Promise<{ directories: string[]; complete: boolean }> {
	if (!(await ownedDirectory(root))) return { directories: [], complete: true };
	let control: string;
	try {
		control = await ensureControlDirectory(root);
	} catch {
		return { directories: [], complete: false };
	}
	const claim = tryAcquireDurableClaim(control, "discovery-maintenance");
	if (!claim) return { directories: [], complete: false };
	const pending = (await readDiscoveryFrontier(control)) ?? [{ directory: "." }];
	const directories: string[] = [];
	const retry: DiscoveryFrame[] = [];
	try {
		while (pending.length > 0 && directories.length < maximum && budget.entries < budget.maxEntries) {
			const frame = pending.pop();
			if (!frame) break;
			const directory = resolveDiscoveryFrame(root, frame);
			if (!directory || !(await ownedDirectory(directory))) continue;
			if (frame.artifact) {
				if (!(await cleanupMarkerIsFresh(directory, now))) {
					directories.push(directory);
					retry.push(frame);
				}
				continue;
			}
			let child: DiscoveryFrame | undefined;
			try {
				const scan = await scanDirectoryNames(
					directory,
					frame.cursor,
					budget.maxEntries - budget.entries,
					async (name, type) => {
						if (
							type === 10 ||
							(type !== 0 && type !== 4) ||
							name === ARTIFACT_CLEANUP_CONTROL_DIRECTORY ||
							name === LEGACY_DISCOVERY_CONTROL_DIRECTORY
						) {
							return;
						}
						const candidate = path.join(directory, name);
						if (!(await ownedDirectory(candidate))) return;
						const relative = path.relative(root, candidate);
						if (!safeDiscoveryDirectory(relative)) return;
						child =
							name === ARTIFACT_DIRECTORY_NAME
								? { artifact: true, directory: relative }
								: { directory: relative };
						return false;
					},
				);
				budget.entries += scan.scanned;
				if (!scan.complete && scan.cursor) pending.push({ directory: frame.directory, cursor: scan.cursor });
				if (child) pending.push(child);
			} catch {
				if (await ownedDirectory(directory)) pending.push({ directory: frame.directory });
				break;
			}
		}
		const complete = pending.length === 0;
		pending.push(...retry);
		try {
			if (pending.length === 0) {
				await fs.promises.unlink(path.join(control, DISCOVERY_CURSOR_FILE)).catch(() => undefined);
			} else {
				await writeDiscoveryFrontier(control, pending);
			}
		} catch {
			return { directories, complete: false };
		}
		return { directories, complete };
	} finally {
		claim.release();
	}
}

/** Reclaim old Agent artifacts after an explicit Agent interaction. */
export async function maintainAgentArtifacts(
	maxAgeDays: number,
	options: ArtifactMaintenanceOptions = {},
): Promise<ArtifactMaintenanceReport> {
	const now = options.now ?? Date.now();
	const cutoff = now - Math.max(0, maxAgeDays) * 24 * 60 * 60 * 1_000;
	const maxEntries = Math.max(1, options.maxEntries ?? MAX_ARTIFACT_ENTRIES_PER_PASS);
	const maxDirectories = Math.min(
		Math.max(0, options.maxDirectories ?? MAX_ARTIFACT_DIRECTORIES_PER_PASS),
		maxEntries,
	);
	const sessionsRoot = options.sessionsRoot ?? getAgentSessionsDir();
	const discovered = await findSessionArtifactDirectories(sessionsRoot, maxDirectories, now, {
		entries: 0,
		maxEntries,
	});
	let directoriesInspected = 0;
	let filesRemoved = 0;
	let bytesReclaimed = 0;
	let scanComplete = discovered.complete;
	let remaining = maxEntries;
	for (let index = 0; index < discovered.directories.length; index += 1) {
		const directory = discovered.directories[index];
		if (!directory || !(await ownedDirectory(directory))) continue;
		directoriesInspected += 1;
		const quota = Math.max(1, Math.floor(remaining / (discovered.directories.length - index)));
		const budget = { entries: 0, maxEntries: quota };
		const cleaned = await cleanArtifactDirectory(directory, cutoff, now, budget);
		remaining = Math.max(0, remaining - budget.entries);
		filesRemoved += cleaned.filesRemoved;
		bytesReclaimed += cleaned.bytesReclaimed;
		if (!cleaned.complete) scanComplete = false;
	}
	const tempArtifactsDir = options.tempArtifactsDir ?? TEMP_ARTIFACTS_DIR;
	if (await ownedDirectory(tempArtifactsDir)) {
		directoriesInspected += 1;
		const cleaned = await cleanArtifactDirectory(tempArtifactsDir, cutoff, now, {
			entries: 0,
			maxEntries,
		});
		filesRemoved += cleaned.filesRemoved;
		bytesReclaimed += cleaned.bytesReclaimed;
		if (!cleaned.complete) scanComplete = false;
	}
	return { directoriesInspected, filesRemoved, bytesReclaimed, scanComplete };
}
