import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	isJsonInputValue,
	type JsonInputObject,
	type JsonInputValue,
	type JsonObject,
	type JsonValue,
	parseJsonValue,
} from "../../../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";

interface SessionIdentityManager {
	getSessionFile(): string | null | undefined;
	getSessionId(): string | null | undefined;
}

const PROCESS_SESSION_NONCE = randomUUID();
const SESSION_HEADER_READ_BUFFER_BYTES = 4 * 1024;
const MAX_SESSION_HEADER_BYTES = 1024 * 1024;

export interface ResolvedSessionIdentity {
	/** Versioned identity written by this release to lifecycle artifacts. */
	readonly sessionId: string;
	/** Header id used by the durable spawn governor before and after this release. */
	readonly governorSessionId: string;
	/** Pre-v2 governor namespace; selected only after a clean live-ledger probe. */
	readonly legacyGovernorSessionId?: string;
	/** Pre-v2 lifecycle-artifact identity. Accepted only with same-header time proof. */
	readonly legacyArtifactSessionId?: string;
	readonly startedAtMs?: number;
}

export interface SessionCompatibilityScope extends ResolvedSessionIdentity {
	/** Legacy run ids proven by launch/result entries on the active Pi branch. */
	readonly legacyRunIds: ReadonlySet<string>;
}

export interface SessionGovernorCompatibilityScope extends ResolvedSessionIdentity {
	/** Exact v1 logical Agent records declared by launch calls anywhere in this Pi session. */
	readonly declaredLogicalAgentIds: ReadonlySet<string>;
	/** Exact v1 logical Agent records proven to have started by their paired result. */
	readonly startedLogicalAgentIds: ReadonlySet<string>;
}

function canonicalPath(value: string): string {
	const resolved = path.resolve(value);
	let candidate = resolved;
	const missingSuffix: string[] = [];
	while (true) {
		try {
			return path.join(fs.realpathSync.native(candidate), ...missingSuffix);
		} catch (error) {
			const code = error !== null && isRuntimeObject(error) && "code" in error ? error.code : undefined;
			if (code !== "ENOENT" && code !== "ENOTDIR") return resolved;
			const parent = path.dirname(candidate);
			if (parent === candidate) return resolved;
			missingSuffix.unshift(path.basename(candidate));
			candidate = parent;
		}
	}
}

/**
 * Stable physical identity for one Pi session.
 *
 * Pi session ids are project-local and may legally collide across projects.
 * Persisted sessions are scoped by both their canonical file and immutable
 * header id. Ephemeral and --no-session hosts are scoped by project cwd and
 * logical session id.
 * Only the digest is persisted or passed to descendants, so paths never become
 * filenames or protocol delimiters.
 */
export function resolveCurrentSessionId(
	sessionManager: SessionIdentityManager,
	cwd?: string,
	ephemeralHostNonce: string = PROCESS_SESSION_NONCE,
): string {
	return resolveCurrentSessionIdentity(sessionManager, cwd, ephemeralHostNonce).sessionId;
}

function readPersistedHeader(
	sessionFile: string,
	logicalSessionId: string,
): { readonly id: string; readonly startedAtMs: number } | undefined {
	let descriptor: number | undefined;
	try {
		// SAFETY: Node exposes O_NOFOLLOW on supported platforms; the optional extension models platforms that omit it.
		const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
		descriptor = fs.openSync(sessionFile, fs.constants.O_RDONLY | noFollow);
		const stat = fs.fstatSync(descriptor);
		const currentUid = process.getuid?.();
		if (!stat.isFile() || (currentUid !== undefined && stat.uid !== currentUid) || stat.size <= 0) return undefined;
		const decoder = new StringDecoder("utf-8");
		const buffer = Buffer.allocUnsafe(SESSION_HEADER_READ_BUFFER_BYTES);
		let pending = "";
		let scannedBytes = 0;
		while (scannedBytes < MAX_SESSION_HEADER_BYTES) {
			const readLength = Math.min(buffer.length, MAX_SESSION_HEADER_BYTES - scannedBytes);
			const bytesRead = fs.readSync(descriptor, buffer, 0, readLength, null);
			if (bytesRead === 0) {
				pending += decoder.end();
				break;
			}
			scannedBytes += bytesRead;
			pending += decoder.write(buffer.subarray(0, bytesRead));
			let newline = pending.indexOf("\n");
			while (newline >= 0) {
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				const parsed = parseHeaderCandidate(line);
				if (parsed === null) return undefined;
				if (parsed) return matchingHeader(parsed, logicalSessionId);
				newline = pending.indexOf("\n");
			}
		}
		if (scannedBytes >= MAX_SESSION_HEADER_BYTES) {
			const probe = Buffer.allocUnsafe(1);
			if (fs.readSync(descriptor, probe, 0, 1, null) > 0) return undefined;
			pending += decoder.end();
		}
		const parsed = parseHeaderCandidate(pending);
		return parsed ? matchingHeader(parsed, logicalSessionId) : undefined;
	} catch {
		return undefined;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

type HeaderCandidate = JsonObject;

function isJsonObject(value: JsonValue): value is JsonObject {
	return value !== null && isRuntimeObject(value) && !Array.isArray(value);
}

/** Match Pi's bounded header discovery: blank and malformed physical lines are skipped. */
function parseHeaderCandidate(line: string): HeaderCandidate | null | undefined {
	if (!line.trim()) return undefined;
	let parsed: JsonValue;
	try {
		parsed = parseJsonValue(line);
	} catch {
		return undefined;
	}
	if (!isJsonObject(parsed)) return null;
	const candidate = parsed;
	return candidate["type"] === "session" && isRuntimeString(candidate["id"]) ? candidate : null;
}

function matchingHeader(
	header: HeaderCandidate,
	logicalSessionId: string,
): { readonly id: string; readonly startedAtMs: number } | undefined {
	if (header["id"] !== logicalSessionId || !isRuntimeString(header["timestamp"])) return undefined;
	const startedAtMs = Date.parse(header["timestamp"]);
	return Number.isFinite(startedAtMs) ? { id: logicalSessionId, startedAtMs } : undefined;
}

export function resolveCurrentSessionIdentity(
	sessionManager: SessionIdentityManager,
	cwd?: string,
	_ephemeralHostNonce: string = PROCESS_SESSION_NONCE,
): ResolvedSessionIdentity {
	const sessionFile = sessionManager.getSessionFile()?.trim();
	const logicalSessionId = sessionManager.getSessionId()?.trim();
	let material: string;
	if (sessionFile) {
		if (!logicalSessionId) throw new Error("Persisted session header identity is unavailable.");
		const canonicalSessionFile = canonicalPath(sessionFile);
		material = `persisted\0path\0${canonicalSessionFile}\0header\0${logicalSessionId}`;
		const header = readPersistedHeader(canonicalSessionFile, logicalSessionId);
		const persistedSessionId = `ps2-${createHash("sha256").update(material).digest("hex")}`;
		const identity: ResolvedSessionIdentity = {
			sessionId: persistedSessionId,
			governorSessionId: persistedSessionId,
			legacyGovernorSessionId: logicalSessionId,
		};
		if (header) Object.assign(identity, { legacyArtifactSessionId: sessionFile, startedAtMs: header.startedAtMs });
		return identity;
	} else {
		if (!logicalSessionId) throw new Error("Current session identity is unavailable.");
		material = `ephemeral\0${canonicalPath(cwd ?? process.cwd())}\0session\0${logicalSessionId}`;
	}
	return {
		sessionId: `ps2-${createHash("sha256").update(material).digest("hex")}`,
		governorSessionId: `ps2-${createHash("sha256").update(material).digest("hex")}`,
		legacyGovernorSessionId: logicalSessionId,
		// Pre-v2 no-session artifacts used the logical id. The logical id is
		// already a per-session header identity, so no timestamp bridge is needed.
		legacyArtifactSessionId: logicalSessionId,
	};
}

type SessionHistoryValue = JsonInputValue | SessionEntry;

function isSessionHistoryObject(
	value: SessionHistoryValue | undefined,
): value is SessionHistoryValue & JsonInputObject {
	return !!value && isJsonInputValue(value) && isRuntimeObject(value) && !Array.isArray(value);
}

function record(value: SessionHistoryValue | undefined): JsonInputObject {
	return isSessionHistoryObject(value) ? value : {};
}

function legacyLaunchRunId(toolCallId: string): string {
	return createHash("sha256").update("\0").update(toolCallId).digest("hex").slice(0, 12);
}

function collectLegacyRunIds(entries: Iterable<SessionHistoryValue>): Set<string> {
	const runIds = new Set<string>();
	for (const value of entries) {
		const entry = record(value);
		if (entry["type"] !== "message") continue;
		const message = record(entry["message"]);
		if (message["role"] === "assistant" && Array.isArray(message["content"])) {
			for (const itemValue of message["content"]) {
				const item = record(itemValue);
				if (item["type"] !== "toolCall" || item["name"] !== "subagent" || !isRuntimeString(item["id"])) continue;
				const args = record(item["arguments"]);
				if (isRuntimeString(args["action"])) continue;
				if (
					(isRuntimeString(args["agent"]) && isRuntimeString(args["task"])) ||
					(Array.isArray(args["tasks"]) && args["tasks"].length > 0)
				) {
					runIds.add(legacyLaunchRunId(item["id"]));
				}
			}
		}
		if (message["role"] !== "toolResult" || message["toolName"] !== "subagent") continue;
		const details = record(message["details"]);
		for (const field of ["runId", "asyncId"] as const) {
			const runId = details[field];
			if (isRuntimeString(runId) && runId.trim()) runIds.add(runId);
		}
	}
	return runIds;
}

interface LegacyLaunchDeclaration {
	readonly runId: string;
	readonly logicalAgentIds: readonly string[];
}

function legacyLaunchDeclarations(entries: Iterable<SessionHistoryValue>) {
	const values = [...entries];
	const byToolCallId = new Map<string, LegacyLaunchDeclaration>();
	const byRunId = new Map<string, LegacyLaunchDeclaration>();
	const declared = new Set<string>();
	const started = new Set<string>();

	for (const value of values) {
		const entry = record(value);
		if (entry["type"] !== "message") continue;
		const message = record(entry["message"]);
		if (message["role"] !== "assistant" || !Array.isArray(message["content"])) continue;
		for (const itemValue of message["content"]) {
			const item = record(itemValue);
			if (item["type"] !== "toolCall" || item["name"] !== "subagent" || !isRuntimeString(item["id"])) continue;
			const args = record(item["arguments"]);
			if (isRuntimeString(args["action"])) continue;
			const childCount =
				isRuntimeString(args["agent"]) && isRuntimeString(args["task"])
					? 1
					: Array.isArray(args["tasks"]) && args["tasks"].length > 0
						? args["tasks"].length
						: 0;
			if (childCount === 0) continue;
			const runId = legacyLaunchRunId(item["id"]);
			const logicalAgentIds = Object.freeze(Array.from({ length: childCount }, (_, index) => `${runId}:${index}`));
			const declaration = Object.freeze({ runId, logicalAgentIds });
			byToolCallId.set(item["id"], declaration);
			byRunId.set(runId, declaration);
			for (const logicalAgentId of logicalAgentIds) declared.add(logicalAgentId);
		}
	}

	for (const value of values) {
		const entry = record(value);
		if (entry["type"] !== "message") continue;
		const message = record(entry["message"]);
		if (message["role"] !== "toolResult" || message["toolName"] !== "subagent") continue;
		const details = record(message["details"]);
		const resultRunId =
			isRuntimeString(details["asyncId"]) && details["asyncId"].trim()
				? details["asyncId"].trim()
				: isRuntimeString(details["runId"]) && details["runId"].trim()
					? details["runId"].trim()
					: undefined;
		const toolCallId =
			isRuntimeString(message["toolCallId"]) && message["toolCallId"].trim()
				? message["toolCallId"].trim()
				: undefined;
		const declaration =
			(toolCallId ? byToolCallId.get(toolCallId) : undefined) ??
			(resultRunId ? byRunId.get(resultRunId) : undefined);
		if (!declaration) continue;
		const provesStart =
			(isRuntimeString(details["asyncId"]) && details["asyncId"].trim().length > 0) ||
			(Array.isArray(details["results"]) && details["results"].length > 0);
		if (!provesStart) continue;
		for (const logicalAgentId of declaration.logicalAgentIds) started.add(logicalAgentId);
	}

	return { declared, started };
}

export function buildSessionCompatibilityScope(
	identity: ResolvedSessionIdentity,
	entries: Iterable<SessionHistoryValue>,
): SessionCompatibilityScope {
	return Object.freeze({ ...identity, legacyRunIds: collectLegacyRunIds(entries) });
}

/** Whole-session provenance used only for governor upgrade/accounting decisions. */
export function buildSessionGovernorCompatibilityScope(
	identity: ResolvedSessionIdentity,
	entries: Iterable<SessionHistoryValue>,
): SessionGovernorCompatibilityScope {
	const launches = legacyLaunchDeclarations(entries);
	return Object.freeze({
		...identity,
		declaredLogicalAgentIds: launches.declared,
		startedLogicalAgentIds: launches.started,
	});
}

/**
 * Accept a pre-v2 persisted artifact only when the active Pi branch proves its
 * run id belongs to the current header. This preserves an in-flight upgrade
 * without reviving header A when a user deliberately reuses its path for B.
 */
export function sessionArtifactMatches(
	identity: SessionCompatibilityScope | null | undefined,
	artifactSessionId: string | null | undefined,
	artifactRunId: string | null | undefined,
): boolean {
	if (!identity || !isRuntimeString(artifactSessionId)) return false;
	if (artifactSessionId === identity.sessionId) return true;
	if (!identity.legacyArtifactSessionId || artifactSessionId !== identity.legacyArtifactSessionId) return false;
	return isRuntimeString(artifactRunId) && identity.legacyRunIds.has(artifactRunId);
}
