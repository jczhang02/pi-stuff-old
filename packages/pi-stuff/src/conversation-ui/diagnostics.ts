import { stripVTControlCharacters } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getHostSharedResource } from "../shared/host-resource.ts";
import { isRuntimeString } from "../shared/runtime-type.ts";

export type DiagnosticSeverity = "error" | "info" | "warning";
export type DiagnosticVisibility = "notice" | "silent";

export interface DiagnosticReport {
	readonly action?: string;
	readonly capability: string;
	readonly details?: readonly string[] | string;
	readonly error?: unknown;
	readonly key?: string;
	readonly severity?: DiagnosticSeverity;
	readonly summary: string;
	readonly timestamp?: number;
	readonly visibility?: DiagnosticVisibility;
}

export interface DiagnosticRecord {
	readonly action?: string;
	readonly capability: string;
	readonly count: number;
	readonly details: readonly string[];
	readonly firstOccurredAt: number;
	readonly id: string;
	readonly lastOccurredAt: number;
	readonly severity: DiagnosticSeverity;
	readonly summary: string;
	readonly visibility: DiagnosticVisibility;
}

type DiagnosticListener = () => void;

const MAX_RECORDS = 100;
const MAX_PENDING_REPORTS = 32;
const MAX_SUMMARY_LENGTH = 512;
const MAX_DETAIL_LENGTH = 8_192;
const DIAGNOSTIC_REGISTRY = Symbol.for("@jczhang02/pi-stuff/diagnostics/v1");
const DIAGNOSTIC_DISCOVERY_EVENT = "@jczhang02/pi-stuff/diagnostics-discovery/v1";
const PROCESS_STATE = Symbol.for("@jczhang02/pi-stuff/diagnostic-process-state/v1");

interface MutableDiagnosticRecord {
	action?: string;
	capability: string;
	count: number;
	details: readonly string[];
	firstOccurredAt: number;
	id: string;
	lastOccurredAt: number;
	severity: DiagnosticSeverity;
	summary: string;
	visibility: DiagnosticVisibility;
}

interface DiagnosticProcessState {
	active?: DiagnosticChannel;
	nextId: number;
	pending: DiagnosticReport[];
}

function processState(): DiagnosticProcessState {
	// SAFETY: PROCESS_STATE is a versioned global symbol written only by this module as DiagnosticProcessState.
	const root = globalThis as {
		[key: symbol]: DiagnosticProcessState | undefined;
	};
	root[PROCESS_STATE] ??= { nextId: 0, pending: [] };
	return root[PROCESS_STATE];
}

function channelRegistry(): WeakMap<object, DiagnosticChannel> {
	// SAFETY: DIAGNOSTIC_REGISTRY is a versioned global symbol written only by this module as this WeakMap.
	const root = globalThis as {
		[key: symbol]: WeakMap<object, DiagnosticChannel> | undefined;
	};
	root[DIAGNOSTIC_REGISTRY] ??= new WeakMap();
	return root[DIAGNOSTIC_REGISTRY];
}

function redactSensitiveText(value: string): string {
	return value
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [redacted]")
		.replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/gu, "$1-[redacted]")
		.replace(
			/("(?:access[_-]?token|api[_-]?key|client[_-]?secret|refresh[_-]?token|token)"\s*:\s*")[^"]*/giu,
			"$1[redacted]",
		)
		.replace(/\b([A-Z0-9_]*(?:API_KEY|ACCESS_TOKEN|CLIENT_SECRET|REFRESH_TOKEN))=[^\s]+/gu, "$1=[redacted]")
		.replace(/([?&](?:access_token|api[_-]?key|client_secret|code|refresh_token|token)=)[^&\s]+/giu, "$1[redacted]");
}

function withoutAnsi(value: string): string {
	return stripVTControlCharacters(value);
}

function withoutControlCharacters(value: string): string {
	return Array.from(value, (character) => {
		const code = character.charCodeAt(0);
		return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127 ? "" : character;
	}).join("");
}

export function sanitizeDiagnosticLine(value: string): string {
	return withoutControlCharacters(redactSensitiveText(withoutAnsi(value)))
		.replace(/[\r\n\t]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function bounded(value: string, maximum: number): string {
	return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function errorDetails(cause: unknown): string[] {
	if (cause === undefined || cause === null) return [];
	if (cause instanceof Error) {
		const source = cause.stack || `${cause.name}: ${cause.message}`;
		return source.split(/\r?\n/gu);
	}
	if (isRuntimeString(cause)) return cause.split(/\r?\n/gu);
	try {
		return [JSON.stringify(cause) ?? String(cause)];
	} catch {
		return [String(cause)];
	}
}

function normalizedDetails(report: DiagnosticReport): string[] {
	const supplied = Array.isArray(report.details)
		? report.details
		: isRuntimeString(report.details)
			? report.details.split(/\r?\n/gu)
			: [];
	const lines: string[] = [];
	let remaining = MAX_DETAIL_LENGTH;
	for (const raw of [...supplied, ...errorDetails(report.error)]) {
		if (remaining <= 0) break;
		const line = bounded(sanitizeDiagnosticLine(raw), remaining);
		if (!line) continue;
		lines.push(line);
		remaining -= line.length;
	}
	return lines;
}

function severityRank(severity: DiagnosticSeverity): number {
	switch (severity) {
		case "info":
			return 0;
		case "warning":
			return 1;
		case "error":
			return 2;
	}
}

/** Bounded, current-process diagnostic history that never enters Session or model context. */
export class DiagnosticChannel {
	private readonly listeners = new Set<DiagnosticListener>();
	private readonly noticeIds = new Set<string>();
	private records: MutableDiagnosticRecord[] = [];

	report(input: DiagnosticReport): DiagnosticRecord {
		const capability = bounded(sanitizeDiagnosticLine(input.capability) || "Pi Stuff", 80);
		const summary = bounded(sanitizeDiagnosticLine(input.summary) || "Unknown diagnostic", MAX_SUMMARY_LENGTH);
		const severity = input.severity ?? "error";
		const visibility = input.visibility ?? "silent";
		const action = input.action ? bounded(sanitizeDiagnosticLine(input.action), 120) : undefined;
		const now = Number.isFinite(input.timestamp)
			? Math.max(0, Math.floor(input.timestamp ?? Date.now()))
			: Date.now();
		const key = `${capability}\u0000${bounded(sanitizeDiagnosticLine(input.key ?? summary), MAX_SUMMARY_LENGTH)}\u0000${severity}`;
		const existing = this.records.find((record) => record.id.startsWith(`${key}\u0000`));
		const details = normalizedDetails(input);
		let record: MutableDiagnosticRecord;
		if (existing) {
			existing.count += 1;
			existing.lastOccurredAt = now;
			existing.visibility = visibility === "notice" ? "notice" : existing.visibility;
			if (details.length > 0) existing.details = details;
			if (action) existing.action = action;
			record = existing;
			this.records = [existing, ...this.records.filter((candidate) => candidate !== existing)];
		} else {
			const sequence = ++processState().nextId;
			record = {
				capability,
				count: 1,
				details,
				firstOccurredAt: now,
				id: `${key}\u0000${String(sequence)}`,
				lastOccurredAt: now,
				severity,
				summary,
				visibility,
			};
			if (action) record.action = action;
			this.records.unshift(record);
		}
		if (visibility === "notice") this.noticeIds.add(record.id);
		if (this.records.length > MAX_RECORDS) {
			for (const removed of this.records.splice(MAX_RECORDS)) this.noticeIds.delete(removed.id);
		}
		this.emit();
		return record;
	}

	acknowledgeNotices(): void {
		if (this.noticeIds.size === 0) return;
		this.noticeIds.clear();
		this.emit();
	}

	clear(): void {
		if (this.records.length === 0 && this.noticeIds.size === 0) return;
		this.records = [];
		this.noticeIds.clear();
		this.emit();
	}

	list(): readonly DiagnosticRecord[] {
		return this.records;
	}

	listNotices(): readonly DiagnosticRecord[] {
		return this.records
			.filter((record) => this.noticeIds.has(record.id))
			.sort((left, right) => severityRank(right.severity) - severityRank(left.severity));
	}

	subscribe(listener: DiagnosticListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		for (const listener of Array.from(this.listeners)) {
			try {
				listener();
			} catch {
				// Presentation observers are isolated from the operation that reported a diagnostic.
			}
		}
	}
}

export function getDiagnosticChannel(pi: Pick<ExtensionAPI, "events" | "on">): DiagnosticChannel {
	return getHostSharedResource(
		pi.events,
		channelRegistry(),
		DIAGNOSTIC_DISCOVERY_EVENT,
		() => new DiagnosticChannel(),
		{ registerOwnerCleanup: (cleanup) => pi.on("session_shutdown", cleanup) },
	);
}

/** Bind the process-local reporting seam to the channel owned by this Pi Host. */
export function activateDiagnosticChannel(channel: DiagnosticChannel): void {
	const state = processState();
	state.active = channel;
	const pending = state.pending.splice(0);
	for (const report of pending) channel.report(report);
}

/** Report from a Capability without writing directly to the Host terminal. */
export function reportDiagnostic(report: DiagnosticReport): void {
	const state = processState();
	if (state.active) {
		state.active.report(report);
		return;
	}
	state.pending.push(report);
	if (state.pending.length > MAX_PENDING_REPORTS) state.pending.splice(0, state.pending.length - MAX_PENDING_REPORTS);
}

/** Test-only reset for the process-local bridge. */
export function resetDiagnosticProcessState(): void {
	const state = processState();
	delete state.active;
	state.pending = [];
	state.nextId = 0;
}
