/** Own the durable steering wire format, paths, validation, and record I/O. */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentWorkOrigin } from "../../../../conversation-ui/agent-run-origin.ts";
import { type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import {
	isRuntimeBoolean,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
} from "../../../../shared/runtime-type.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import {
	assertPrivateDirectory,
	ensurePrivateDirectory,
	ensurePrivateDirectoryWithin,
	readBoundedOwnedFile,
} from "../../shared/private-directory.ts";
import { MAX_BACKGROUND_TASKS } from "../shared/parallel-utils.ts";

export const MAX_CONTROL_RECORD_BYTES = 64 * 1024;
export const MAX_STEER_REQUEST_ID_LENGTH = 256;
const STEER_REQUESTS_DIR = "steer-requests";
const STEER_TARGETS_DIR = "steer-targets";
const STEER_CAPABILITIES_DIR = "steer-capabilities";
export const STEER_ACKS_DIR = "steer-acks";
const STEER_INBOX_CLOSED_FILE = "steer-inbox-closed.json";
const MAX_STEER_MESSAGE_BYTES = 128 * 1024;

export interface SteerRequest {
	type: "steer";
	id: string;
	ts: number;
	message: string;
	/** Monotonic user takeover attribution for the owning background run. */
	parentRunOrigin?: AgentWorkOrigin;
	targetIndex?: number;
	targetIndexes?: number[];
	source?: string;
}

export interface SteerCapability {
	type: "steer-capability";
	protocolVersion: 1;
	index: number;
	pid: number;
	readyAt: number;
	supported: boolean;
}

export interface SteerAck {
	type: "steer-ack";
	protocolVersion: 1;
	requestId: string;
	index: number;
	ts: number;
	state: "delivered" | "failed";
	message: string;
}

export function controlInboxDir(asyncDir: string): string {
	return path.join(asyncDir, "control");
}

/** Directory of parent-to-runner steering requests. */
export function steerRequestsDir(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), STEER_REQUESTS_DIR);
}

export function steerInboxClosedPath(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), STEER_INBOX_CLOSED_FILE);
}

export function closeSteerInbox(asyncDir: string, state: string): void {
	prepareControlDirectory(asyncDir, controlInboxDir(asyncDir));
	writePrivateAtomicJson(steerInboxClosedPath(asyncDir), { version: 1, closedAt: Date.now(), state });
}

/** Per-child inbox consumed by the child prompt runtime inside the Pi process. */
export function stepSteerInboxDir(asyncDir: string, index: number): string {
	assertChildIndex(index);
	return path.join(controlInboxDir(asyncDir), STEER_TARGETS_DIR, String(index));
}

export function steerCapabilitiesDir(asyncDir: string): string {
	return path.join(controlInboxDir(asyncDir), STEER_CAPABILITIES_DIR);
}

export function steerCapabilityPath(asyncDir: string, index: number): string {
	assertChildIndex(index);
	return path.join(steerCapabilitiesDir(asyncDir), `${index}.json`);
}

export function steerAcksDir(asyncDir: string, index: number): string {
	assertChildIndex(index);
	return path.join(controlInboxDir(asyncDir), STEER_ACKS_DIR, String(index));
}

function steerAckFileName(requestId: string): string {
	return `${Buffer.from(requestId).toString("base64url")}.json`;
}

export function steerAckPathFromDir(dir: string, requestId: string): string {
	if (!/^[^\s]+$/.test(requestId) || requestId.length > 256)
		throw new Error("steer acknowledgment requestId is invalid.");
	return path.join(dir, steerAckFileName(requestId));
}

function assertChildIndex(index: number): void {
	if (!isValidChildIndex(index)) throw new Error("steer child index must be a non-negative integer.");
}

export function isValidChildIndex(index: JsonValue | undefined): index is number {
	return isRuntimeNumber(index) && Number.isInteger(index) && index >= 0 && index <= 1_000_000;
}

function steerRequestFileName(request: SteerRequest): string {
	return `${String(request.ts).padStart(13, "0")}-${Buffer.from(request.id).toString("base64url")}.json`;
}

function validSteerRequest(request: Partial<SteerRequest>): request is SteerRequest {
	return (
		request.type === "steer" &&
		isRuntimeString(request.id) &&
		/^[^\s]+$/.test(request.id) &&
		request.id.length <= MAX_STEER_REQUEST_ID_LENGTH &&
		isRuntimeNumber(request.ts) &&
		Number.isFinite(request.ts) &&
		request.ts > 0 &&
		isRuntimeString(request.message) &&
		Boolean(request.message.trim()) &&
		Buffer.byteLength(request.message, "utf8") <= MAX_STEER_MESSAGE_BYTES &&
		(request.targetIndex === undefined || isValidChildIndex(request.targetIndex)) &&
		(request.targetIndexes === undefined ||
			(request.targetIndex === undefined &&
				Array.isArray(request.targetIndexes) &&
				request.targetIndexes.length > 0 &&
				request.targetIndexes.length <= MAX_BACKGROUND_TASKS &&
				request.targetIndexes.every(isValidChildIndex) &&
				new Set(request.targetIndexes).size === request.targetIndexes.length)) &&
		(request.parentRunOrigin === undefined ||
			request.parentRunOrigin === "automatic" ||
			request.parentRunOrigin === "user") &&
		(request.source === undefined ||
			(isRuntimeString(request.source) && Boolean(request.source.trim()) && request.source.length <= 256))
	);
}

export function writeSteerRequestToDir(dir: string, request: SteerRequest): string {
	if (!validSteerRequest(request)) throw new Error("steer request is malformed or exceeds transport limits.");
	ensurePrivateDirectory(dir);
	const requestPath = path.join(dir, steerRequestFileName(request));
	writePrivateAtomicJson(requestPath, request);
	return requestPath;
}

export function writeSteerCapabilityAt(
	filePath: string,
	capability: Omit<SteerCapability, "type" | "protocolVersion">,
): string {
	assertChildIndex(capability.index);
	if (!Number.isInteger(capability.pid) || capability.pid <= 0)
		throw new Error("steer capability pid must be a positive integer.");
	if (!Number.isFinite(capability.readyAt) || capability.readyAt <= 0)
		throw new Error("steer capability readyAt must be a finite timestamp.");
	const record: SteerCapability = { type: "steer-capability", protocolVersion: 1, ...capability };
	ensurePrivateDirectory(path.dirname(filePath));
	writePrivateAtomicJson(filePath, record);
	return filePath;
}

export function writeSteerAckAt(filePath: string, ack: Omit<SteerAck, "type" | "protocolVersion">): string {
	assertChildIndex(ack.index);
	if (!/^[^\s]+$/.test(ack.requestId) || ack.requestId.length > 256)
		throw new Error("steer acknowledgment requestId is invalid.");
	if (!Number.isFinite(ack.ts) || ack.ts <= 0) throw new Error("steer acknowledgment ts must be a finite timestamp.");
	if (!ack.message.trim() || ack.message.length > 1000) throw new Error("steer acknowledgment message is invalid.");
	const record: SteerAck = { type: "steer-ack", protocolVersion: 1, ...ack, message: ack.message.trim() };
	ensurePrivateDirectory(path.dirname(filePath));
	writePrivateAtomicJson(filePath, record);
	return filePath;
}

export function writeSteerAck(asyncDir: string, ack: Omit<SteerAck, "type" | "protocolVersion">): string {
	prepareControlDirectory(asyncDir, steerAcksDir(asyncDir, ack.index));
	return writeSteerAckAt(path.join(steerAcksDir(asyncDir, ack.index), steerAckFileName(ack.requestId)), ack);
}

export function prepareControlDirectory(asyncDir: string, directory: string): void {
	assertPrivateDirectory(asyncDir);
	ensurePrivateDirectoryWithin(asyncDir, directory);
}

export function requestAsyncSteer(
	asyncDir: string,
	payload: {
		message: string;
		parentRunOrigin?: AgentWorkOrigin;
		targetIndex?: number;
		targetIndexes?: number[];
		source?: string;
		id?: string;
		ts?: number;
	},
	deps: { now?: () => number; randomId?: () => string } = {},
): string {
	prepareControlDirectory(asyncDir, steerRequestsDir(asyncDir));
	const message = payload.message.trim();
	if (!message) throw new Error("steer message must not be empty.");
	if (Buffer.byteLength(message, "utf8") > MAX_STEER_MESSAGE_BYTES)
		throw new Error(`steer message exceeds ${MAX_STEER_MESSAGE_BYTES} UTF-8 bytes.`);
	if (payload.targetIndex !== undefined && !isValidChildIndex(payload.targetIndex)) {
		throw new Error("steer targetIndex must be an integer between 0 and 1000000.");
	}
	if (
		payload.targetIndexes !== undefined &&
		(!Array.isArray(payload.targetIndexes) ||
			payload.targetIndex !== undefined ||
			payload.targetIndexes.length === 0 ||
			payload.targetIndexes.length > MAX_BACKGROUND_TASKS ||
			!payload.targetIndexes.every(isValidChildIndex) ||
			new Set(payload.targetIndexes).size !== payload.targetIndexes.length)
	) {
		throw new Error(
			`steer targetIndexes must contain 1-${String(MAX_BACKGROUND_TASKS)} unique non-negative integers and cannot be combined with targetIndex.`,
		);
	}
	const closedPath = steerInboxClosedPath(asyncDir);
	if (fs.existsSync(closedPath)) throw new Error("Async run no longer accepts steering requests.");
	const request: SteerRequest = {
		type: "steer",
		id: payload.id ?? deps.randomId?.() ?? randomUUID(),
		ts: payload.ts ?? deps.now?.() ?? Date.now(),
		message,
	};
	if (payload.parentRunOrigin) request.parentRunOrigin = payload.parentRunOrigin;
	if (payload.targetIndex !== undefined) request.targetIndex = payload.targetIndex;
	if (payload.targetIndexes !== undefined) request.targetIndexes = [...payload.targetIndexes];
	if (payload.source) request.source = payload.source;
	const requestPath = writeSteerRequestToDir(steerRequestsDir(asyncDir), request);
	if (fs.existsSync(closedPath)) {
		fs.rmSync(requestPath, { force: true });
		throw new Error("Async run stopped accepting steering before the request was committed.");
	}
	return requestPath;
}

export function enqueueStepSteer(asyncDir: string, index: number, request: SteerRequest): string {
	assertChildIndex(index);
	prepareControlDirectory(asyncDir, stepSteerInboxDir(asyncDir, index));
	const { targetIndexes: _targetIndexes, ...singleTargetRequest } = request;
	return writeSteerRequestToDir(stepSteerInboxDir(asyncDir, index), {
		...singleTargetRequest,
		targetIndex: index,
		type: "steer",
	});
}

function parseSteerCapability(raw: JsonValue): SteerCapability | undefined {
	if (!raw || !isRuntimeObject(raw) || Array.isArray(raw)) return undefined;
	// SAFETY: the JSON object check establishes the field container; every protocol field is validated below.
	const input = raw as Partial<SteerCapability>;
	if (input.type !== "steer-capability" || input.protocolVersion !== 1) return undefined;
	const { index, pid, readyAt } = input;
	if (!isValidChildIndex(index)) return undefined;
	if (!isRuntimeNumber(pid) || !Number.isInteger(pid) || pid <= 0) return undefined;
	if (!isRuntimeNumber(readyAt) || !Number.isFinite(readyAt) || readyAt <= 0 || !isRuntimeBoolean(input.supported))
		return undefined;
	return { type: "steer-capability", protocolVersion: 1, index, pid, readyAt, supported: input.supported };
}

export function parseSteerAck(raw: JsonValue): SteerAck | undefined {
	if (!raw || !isRuntimeObject(raw) || Array.isArray(raw)) return undefined;
	// SAFETY: the JSON object check establishes the field container; every protocol field is validated below.
	const input = raw as Partial<SteerAck>;
	if (
		input.type !== "steer-ack" ||
		input.protocolVersion !== 1 ||
		!isRuntimeString(input.requestId) ||
		!/^[^\s]+$/.test(input.requestId) ||
		input.requestId.length > 256
	)
		return undefined;
	const { index, ts } = input;
	if (!isValidChildIndex(index)) return undefined;
	if (!isRuntimeNumber(ts) || !Number.isFinite(ts) || ts <= 0) return undefined;
	if (input.state !== "delivered" && input.state !== "failed") return undefined;
	if (!isRuntimeString(input.message) || !input.message.trim() || input.message.length > 1000) return undefined;
	return {
		type: "steer-ack",
		protocolVersion: 1,
		requestId: input.requestId,
		index,
		ts,
		state: input.state,
		message: input.message.trim(),
	};
}

export function readSteerAckAt(filePath: string): SteerAck | undefined {
	try {
		return parseSteerAck(parseJsonValue(readBoundedOwnedFile(filePath, MAX_CONTROL_RECORD_BYTES)));
	} catch {
		return undefined;
	}
}

export function consumeSteerCapabilities(
	asyncDir: string,
	fsImpl: Pick<typeof fs, "existsSync" | "readdirSync" | "readFileSync"> = fs,
): SteerCapability[] {
	const dir = steerCapabilitiesDir(asyncDir);
	if (!fsImpl.existsSync(dir)) return [];
	const capabilities: SteerCapability[] = [];
	for (const entry of fsImpl
		.readdirSync(dir)
		.filter((name) => /^\d+\.json$/.test(name))
		.sort()) {
		try {
			const target = path.join(dir, entry);
			const text =
				fsImpl === fs
					? readBoundedOwnedFile(target, MAX_CONTROL_RECORD_BYTES)
					: fsImpl.readFileSync(target, "utf-8");
			const capability = parseSteerCapability(parseJsonValue(text));
			if (capability) capabilities.push(capability);
		} catch {
			// A partially written or malformed capability is ignored until a valid one arrives.
		}
	}
	return capabilities;
}

export function parseSteerRequest(raw: JsonValue): SteerRequest | undefined {
	if (!raw || !isRuntimeObject(raw) || Array.isArray(raw)) return undefined;
	// SAFETY: the JSON object check establishes the field container; validSteerRequest validates the full protocol.
	const input = raw as Partial<SteerRequest>;
	if (!validSteerRequest(input)) return undefined;
	const request: SteerRequest = {
		type: "steer",
		id: input.id.trim(),
		ts: input.ts,
		message: input.message.trim(),
	};
	if (input.parentRunOrigin) request.parentRunOrigin = input.parentRunOrigin;
	if (input.targetIndex !== undefined) request.targetIndex = input.targetIndex;
	if (input.targetIndexes !== undefined) request.targetIndexes = [...input.targetIndexes];
	if (isRuntimeString(input.source) && input.source.trim()) request.source = input.source;
	return request;
}
