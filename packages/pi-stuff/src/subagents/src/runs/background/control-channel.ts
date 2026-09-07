/**
 * Cross-OS control channel for async subagent runs.
 *
 * Background runs are detached OS processes. The original control path delivered
 * an interrupt with `process.kill(pid, SIGUSR2|SIGBREAK)`, but Windows cannot
 * deliver those signals cross-process via `process.kill` and throws `ENOSYS`,
 * which left async runs uninterruptible (no stop, no live steer) on Windows.
 *
 * This module adds a portable, file-based control inbox inside the run directory.
 * The parent drops an interrupt request file; the runner watches the inbox and
 * routes the request into its existing graceful `interruptRunner()` (pause +
 * resumable), identically on every platform. The OS signal is kept only as an
 * opportunistic fast-path; its failure is non-fatal because the file inbox is
 * authoritative.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import { type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import {
	errnoCode,
	type OwnedFileSnapshot,
	readBoundedOwnedFileSnapshot,
	removeOwnedFileSnapshot,
} from "../../shared/private-directory.ts";
import { probeProcessLiveness, readProcessStartIdentity } from "../../shared/process-identity.ts";
import { POLL_INTERVAL_MS } from "../../shared/types.ts";
import { resolveWatchPath } from "../../shared/utils.ts";
import {
	consumeSteerCapabilities,
	controlInboxDir,
	isValidChildIndex,
	MAX_CONTROL_RECORD_BYTES,
	MAX_STEER_REQUEST_ID_LENGTH,
	parseSteerAck,
	parseSteerRequest,
	prepareControlDirectory,
	STEER_ACKS_DIR,
	type SteerAck,
	type SteerCapability,
	type SteerRequest,
	steerRequestsDir,
} from "./steering-channel.ts";

export * from "./steering-channel.ts";

/**
 * Opportunistic fast-path interrupt signal. On Unix `SIGUSR2` is trapped by the
 * runner; on Windows `process.kill(pid, "SIGBREAK")` is not deliverable
 * cross-process and throws `ENOSYS`, so the file inbox below is the real channel.
 */
export const INTERRUPT_SIGNAL: NodeJS.Signals = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
const CONTROL_INFLIGHT_SEPARATOR = ".pi-stuff-inflight.";
const activeControlConsumers = new Set<string>();

function compareCodePoints(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}

type KillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

type SingletonRequest<Type extends "interrupt" | "timeout"> = {
	type: Type;
	ts?: number;
	source?: string;
	reason?: string;
};

export type InterruptRequest = SingletonRequest<"interrupt">;
export type TimeoutRequest = SingletonRequest<"timeout">;

export interface StopRequest {
	type: "stop";
	id?: string;
	ts?: number;
	source?: string;
	reason?: string;
	targetIndex?: number;
}
const STOP_REQUESTS_DIR = "stop-requests";

/** Path of the portable interrupt request file. */
export function interruptRequestPath(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), "interrupt.json");
}

/** Path of the portable timeout request file. */
export function timeoutRequestPath(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), "timeout.json");
}

/** Path of the portable manual stop request file. */
export function stopRequestPath(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), "stop.json");
}

/** Directory of queued manual stop requests. `stop.json` remains read-only legacy compatibility. */
export function stopRequestsDir(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), STOP_REQUESTS_DIR);
}

export function requestAsyncInterrupt(
	asyncDir: string,
	payload: Omit<InterruptRequest, "type"> = {},
	deps: { now?: () => number } = {},
): string {
	prepareControlDirectory(asyncDir, controlInboxDir(asyncDir));
	const requestPath = interruptRequestPath(asyncDir);
	const request: InterruptRequest = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: "interrupt" };
	writePrivateAtomicJson(requestPath, request);
	return requestPath;
}

export function requestAsyncTimeout(
	asyncDir: string,
	payload: Omit<TimeoutRequest, "type"> = {},
	deps: { now?: () => number } = {},
): string {
	prepareControlDirectory(asyncDir, controlInboxDir(asyncDir));
	const requestPath = timeoutRequestPath(asyncDir);
	const request: TimeoutRequest = { ...payload, ts: payload.ts ?? deps.now?.() ?? Date.now(), type: "timeout" };
	writePrivateAtomicJson(requestPath, request);
	return requestPath;
}

export function requestAsyncStop(
	asyncDir: string,
	payload: Omit<StopRequest, "type" | "id"> = {},
	deps: { now?: () => number; randomId?: () => string } = {},
): string {
	if (payload.targetIndex !== undefined && !isValidChildIndex(payload.targetIndex)) {
		throw new Error("stop targetIndex must be an integer between 0 and 1000000.");
	}
	const ts = payload.ts ?? deps.now?.() ?? Date.now();
	const id = deps.randomId?.() || randomUUID();
	if (!/^\S+$/.test(id) || id.length > MAX_STEER_REQUEST_ID_LENGTH) {
		throw new Error("stop request id is invalid.");
	}
	if (!Number.isFinite(ts) || ts <= 0) throw new Error("stop request timestamp must be positive and finite.");
	const requestPath = path.join(
		stopRequestsDir(asyncDir),
		`${String(ts).padStart(13, "0")}-${Buffer.from(id).toString("base64url")}.json`,
	);
	prepareControlDirectory(asyncDir, stopRequestsDir(asyncDir));
	const request: StopRequest = { ...payload, id, ts, type: "stop" };
	writePrivateAtomicJson(requestPath, request);
	return requestPath;
}

interface ClaimedControlRecord {
	readonly claimedPath: string;
	readonly originalName: string;
}

function parseClaimedControlRecord(
	directory: string,
	entry: string,
):
	| (ClaimedControlRecord & {
			readonly ownerPid: number;
			readonly ownerIdentity: string;
			readonly consumerId: string;
	  })
	| undefined {
	const separator = entry.lastIndexOf(CONTROL_INFLIGHT_SEPARATOR);
	if (separator <= 0) return undefined;
	const originalName = entry.slice(0, separator);
	const metadata = entry.slice(separator + CONTROL_INFLIGHT_SEPARATOR.length).split(".");
	if (metadata.length !== 3 || !/^\d+$/u.test(metadata[0] ?? "") || !/^[A-Za-z0-9_-]+$/u.test(metadata[1] ?? "")) {
		return undefined;
	}
	let ownerIdentity: string;
	try {
		ownerIdentity = Buffer.from(metadata[1] ?? "", "base64url").toString("utf8");
	} catch {
		return undefined;
	}
	const ownerPid = Number(metadata[0]);
	const consumerId = metadata[2] ?? "";
	if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0 || !ownerIdentity || !/^[a-f0-9-]{36}$/u.test(consumerId)) {
		return undefined;
	}
	return { claimedPath: path.join(directory, entry), originalName, ownerPid, ownerIdentity, consumerId };
}

function controlClaimRecoverable(claim: ReturnType<typeof parseClaimedControlRecord>): boolean {
	if (!claim || activeControlConsumers.has(claim.consumerId)) return false;
	if (claim.ownerPid === process.pid && claim.ownerIdentity === "pid-only") return true;
	const currentIdentity = readProcessStartIdentity(claim.ownerPid);
	if (currentIdentity) return currentIdentity !== claim.ownerIdentity || claim.ownerPid === process.pid;
	return probeProcessLiveness(claim.ownerPid) === false;
}

function claimControlRecord(target: string, consumerId: string): ClaimedControlRecord | undefined {
	const ownerIdentity = readProcessStartIdentity(process.pid) ?? "pid-only";
	const originalName = path.basename(target);
	const claimedPath = `${target}${CONTROL_INFLIGHT_SEPARATOR}${process.pid}.${Buffer.from(ownerIdentity).toString(
		"base64url",
	)}.${consumerId}`;
	try {
		fs.renameSync(target, claimedPath);
		return { claimedPath, originalName };
	} catch {
		return undefined;
	}
}

function processDurableControlRecords<T>(input: {
	readonly directories: Array<{ readonly path: string; readonly accepts: (name: string) => boolean }>;
	readonly parse: (raw: JsonValue) => T | undefined;
	readonly callback: (value: T, complete: () => boolean) => undefined | "retain";
	readonly kind: "interrupt" | "timeout" | "stop" | "steer" | "steer-ack";
	readonly afterClaim?: ((kind: string, claimedPath: string) => void) | undefined;
}): void {
	const consumerId = randomUUID();
	activeControlConsumers.add(consumerId);
	try {
		const candidates: ClaimedControlRecord[] = [];
		for (const directory of input.directories) {
			let entries: string[];
			try {
				entries = fs.readdirSync(directory.path).sort();
			} catch {
				continue;
			}
			for (const entry of entries) {
				if (directory.accepts(entry)) {
					const claimed = claimControlRecord(path.join(directory.path, entry), consumerId);
					if (claimed) candidates.push(claimed);
					continue;
				}
				const claimed = parseClaimedControlRecord(directory.path, entry);
				if (claimed && directory.accepts(claimed.originalName) && controlClaimRecoverable(claimed)) {
					candidates.push(claimed);
				}
			}
		}
		candidates.sort(
			(left, right) =>
				compareCodePoints(left.originalName, right.originalName) ||
				compareCodePoints(left.claimedPath, right.claimedPath),
		);
		for (const candidate of candidates) {
			let snapshot: OwnedFileSnapshot;
			try {
				snapshot = readBoundedOwnedFileSnapshot(candidate.claimedPath, MAX_CONTROL_RECORD_BYTES);
			} catch {
				continue;
			}
			let parsed: T | undefined;
			try {
				parsed = input.parse(parseJsonValue(snapshot.text));
			} catch {
				parsed = undefined;
			}
			if (parsed === undefined) {
				removeOwnedFileSnapshot(candidate.claimedPath, snapshot);
				continue;
			}
			try {
				input.afterClaim?.(input.kind, candidate.claimedPath);
				const complete = (): boolean => removeOwnedFileSnapshot(candidate.claimedPath, snapshot) === "removed";
				const disposition = input.callback(parsed, complete);
				if (disposition !== "retain") complete();
			} catch {
				// The in-flight record remains durable. A later poll or replacement
				// runner replays the idempotent request instead of silently losing it.
			}
		}
	} finally {
		activeControlConsumers.delete(consumerId);
	}
}

function parseSingletonRequest<Type extends "interrupt" | "timeout">(
	raw: JsonValue,
	type: Type,
): SingletonRequest<Type> | undefined {
	if (!raw || !isRuntimeObject(raw) || Array.isArray(raw)) return undefined;
	// SAFETY: the JSON object check establishes the legacy request container; the discriminator is checked next.
	const request = raw as Partial<SingletonRequest<Type>>;
	return request.type === type ? { ...request, type } : undefined;
}

export function processSteerRequestsFromDir(
	dir: string,
	callback: (request: SteerRequest, complete: () => boolean) => undefined | "retain",
	afterClaim?: (kind: string, claimedPath: string) => void,
): void {
	processDurableControlRecords({
		directories: [{ path: dir, accepts: (name) => name.endsWith(".json") }],
		parse: parseSteerRequest,
		callback,
		kind: "steer",
		afterClaim,
	});
}

export function consumeSteerRequestsFromDir(dir: string): SteerRequest[] {
	const requests: SteerRequest[] = [];
	processSteerRequestsFromDir(dir, (request) => {
		requests.push(request);
		return undefined;
	});
	return requests;
}

export function processSteerAcks(
	asyncDir: string,
	callback: (ack: SteerAck) => undefined | "retain",
	afterClaim?: (kind: string, claimedPath: string) => void,
): void {
	const root = path.join(controlInboxDir(asyncDir), STEER_ACKS_DIR);
	let indexes: string[] = [];
	try {
		indexes = fs.readdirSync(root).filter((entry) => /^\d+$/u.test(entry));
	} catch {
		return;
	}
	processDurableControlRecords({
		directories: indexes.map((index) => ({
			path: path.join(root, index),
			accepts: (name: string) => name.endsWith(".json"),
		})),
		parse: parseSteerAck,
		callback,
		kind: "steer-ack",
		afterClaim,
	});
}

function parseStopRequest(raw: JsonValue): StopRequest | undefined {
	if (!raw || !isRuntimeObject(raw) || Array.isArray(raw)) return undefined;
	// SAFETY: the JSON object check establishes the field container; every optional protocol field is validated below.
	const parsed = raw as Partial<StopRequest>;
	if (
		parsed.type !== "stop" ||
		(parsed.id !== undefined && (!/^\S+$/.test(parsed.id) || parsed.id.length > MAX_STEER_REQUEST_ID_LENGTH)) ||
		(parsed.ts !== undefined && (!Number.isFinite(parsed.ts) || parsed.ts <= 0)) ||
		(parsed.source !== undefined && !isRuntimeString(parsed.source)) ||
		(parsed.reason !== undefined && !isRuntimeString(parsed.reason)) ||
		(parsed.targetIndex !== undefined && !isValidChildIndex(parsed.targetIndex))
	) {
		return undefined;
	}
	const request: StopRequest = { type: "stop" };
	if (parsed.id !== undefined) request.id = parsed.id;
	if (parsed.ts !== undefined) request.ts = parsed.ts;
	if (parsed.source !== undefined) request.source = parsed.source;
	if (parsed.reason !== undefined) request.reason = parsed.reason;
	if (parsed.targetIndex !== undefined) request.targetIndex = parsed.targetIndex;
	return request;
}

/** Drain queued stop requests plus a valid legacy `stop.json`, ignoring malformed input. */
export function consumeStopRequests(asyncDir: string): StopRequest[] {
	const requests: StopRequest[] = [];
	processStopRequests(asyncDir, (request) => requests.push(request));
	return requests;
}

function processStopRequests(
	asyncDir: string,
	callback: (request: StopRequest) => void,
	afterClaim?: (kind: string, claimedPath: string) => void,
): void {
	processDurableControlRecords({
		directories: [
			{ path: stopRequestsDir(asyncDir), accepts: (name) => name.endsWith(".json") },
			{ path: controlInboxDir(asyncDir), accepts: (name) => name === path.basename(stopRequestPath(asyncDir)) },
		],
		parse: parseStopRequest,
		callback: (request) => {
			callback(request);
			return undefined;
		},
		kind: "stop",
		afterClaim,
	});
}

function processSingletonRequest<Type extends "interrupt" | "timeout">(
	target: string,
	type: Type,
	callback: () => void,
	afterClaim?: (kind: string, claimedPath: string) => void,
): void {
	const name = path.basename(target);
	processDurableControlRecords({
		directories: [{ path: path.dirname(target), accepts: (entry) => entry === name }],
		parse: (raw) => parseSingletonRequest(raw, type),
		callback: () => {
			callback();
			return undefined;
		},
		kind: type,
		afterClaim,
	});
}

/**
 * Parent side: portable interrupt = authoritative file request + best-effort OS
 * signal. The signal is only a latency optimization on Unix; ENOSYS on Windows
 * is swallowed because the file inbox is authoritative there. Other signal
 * failures are surfaced, but never revoke the durable request.
 */
export function deliverInterruptRequest(input: {
	asyncDir: string;
	pid?: number;
	kill?: KillFn;
	signal?: NodeJS.Signals;
	now?: () => number;
	source?: string;
}): void {
	const timing = input.now === undefined ? {} : { now: input.now };
	requestAsyncInterrupt(input.asyncDir, input.source ? { source: input.source } : {}, timing);
	if (isRuntimeNumber(input.pid) && input.pid > 0) {
		try {
			(input.kill ?? process.kill)(input.pid, input.signal ?? INTERRUPT_SIGNAL);
		} catch (error) {
			if (errnoCode(error) === "ENOSYS") {
				// File inbox is authoritative when custom cross-process signals are unavailable.
				return;
			}
			throw error;
		}
	}
}

export function deliverTimeoutRequest(input: {
	asyncDir: string;
	pid?: number;
	kill?: KillFn;
	signal?: NodeJS.Signals;
	now?: () => number;
	source?: string;
}): void {
	requestAsyncTimeout(
		input.asyncDir,
		input.source ? { source: input.source } : {},
		input.now === undefined ? {} : { now: input.now },
	);
}

export function deliverStopRequest(input: {
	asyncDir: string;
	pid?: number;
	kill?: KillFn;
	signal?: NodeJS.Signals;
	now?: () => number;
	source?: string;
	targetIndex?: number;
}): void {
	const request: Omit<StopRequest, "type" | "id"> = {};
	if (input.source) request.source = input.source;
	if (input.targetIndex !== undefined) request.targetIndex = input.targetIndex;
	requestAsyncStop(input.asyncDir, request, input.now === undefined ? {} : { now: input.now });
}

/**
 * Runner side: watch the control inbox and route interrupt requests into
 * `onInterrupt`. Uses `fs.watch` when available plus an interval poll as a
 * portable safety net (covers filesystems/platforms where `fs.watch` is
 * unreliable). Fires once per distinct request and remains owned by the caller Scope.
 */
export function watchAsyncControlInbox(
	asyncDir: string,
	opts: {
		onInterrupt: () => void;
		onTimeout?: () => void;
		onStop?: (request: StopRequest) => void;
		onSteer?: (request: SteerRequest) => void;
		onSteerCapability?: (capability: SteerCapability) => void;
		onSteerAck?: (ack: SteerAck) => undefined | "retain";
		pollIntervalMs?: number;
		watch?: typeof fs.watch;
		/** Deterministic crash-window seam used by process-level recovery tests. */
		afterControlClaim?: (kind: string, claimedPath: string) => void;
	},
): Effect.Effect<void, never, Scope.Scope> {
	return Effect.gen(function* () {
		const changes = yield* Queue.unbounded<void>();
		const dir = controlInboxDir(asyncDir);
		yield* Effect.sync(() => {
			try {
				fs.mkdirSync(dir, { recursive: true });
			} catch {
				// Best effort — the poll/watch below tolerates a missing dir.
			}
		});

		let disposed = false;
		const invoke = <T>(callback: ((value: T) => void) | undefined, value: T): void => {
			try {
				callback?.(value);
			} catch {
				// One control observer must not prevent later durable requests from being consumed.
			}
		};
		const check = (): void => {
			if (disposed) return;
			try {
				processStopRequests(asyncDir, (stop) => opts.onStop?.(stop), opts.afterControlClaim);
				processSingletonRequest(
					timeoutRequestPath(asyncDir),
					"timeout",
					() => opts.onTimeout?.(),
					opts.afterControlClaim,
				);
				processSingletonRequest(
					interruptRequestPath(asyncDir),
					"interrupt",
					() => opts.onInterrupt(),
					opts.afterControlClaim,
				);
				processSteerRequestsFromDir(
					steerRequestsDir(asyncDir),
					(request) => {
						opts.onSteer?.(request);
						return undefined;
					},
					opts.afterControlClaim,
				);
				for (const capability of consumeSteerCapabilities(asyncDir)) {
					invoke(opts.onSteerCapability, capability);
				}
				processSteerAcks(asyncDir, (ack) => opts.onSteerAck?.(ack), opts.afterControlClaim);
			} catch {
				// Never let inbox errors crash the runner.
			}
		};

		yield* Effect.sync(check);
		yield* Effect.acquireRelease(
			Effect.sync(() => {
				try {
					const watcher = (opts.watch ?? fs.watch)(resolveWatchPath(dir, fs.realpathSync.native), () => {
						Queue.offerUnsafe(changes, undefined);
					});
					watcher.on?.("error", () => {
						// Polling remains authoritative after transient watcher errors.
					});
					watcher.unref?.();
					return watcher;
				} catch {
					return undefined;
				}
			}),
			(watcher) =>
				Effect.sync(() => {
					disposed = true;
					try {
						watcher?.close();
					} catch {
						// Native watcher teardown is best effort during process exit.
					}
				}),
		);
		yield* Effect.forkScoped(
			Effect.gen(function* () {
				while (true) {
					yield* Effect.raceFirst(Queue.take(changes), Effect.sleep(opts.pollIntervalMs ?? POLL_INTERVAL_MS));
					yield* Effect.sync(check);
				}
			}),
		);
	});
}
