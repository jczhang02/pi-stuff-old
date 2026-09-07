import { Buffer } from "node:buffer";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import type { JsonObject, JsonValue } from "../../../../shared/json-value.ts";
import {
	isRuntimeBoolean,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
} from "../../../../shared/runtime-type.ts";
import type { ProtocolOutputLimit } from "../../shared/types.ts";

export type { ProtocolOutputLimit } from "../../shared/types.ts";

export const MAX_CHILD_PENDING_LINE_BYTES = 16 * 1024 * 1024;
export const MAX_CHILD_STDERR_BYTES = 128 * 1024;
const MAX_PROTOCOL_DIAGNOSTIC_BYTES = 4096;

type PiCustomMessage = Extract<AgentMessage, { role: "custom" }>;

export type ChildProtocolMessage = (Message | PiCustomMessage) & {
	model?: string;
	errorMessage?: string;
	stopReason?: string;
	usage?: {
		input?: number;
		inputTokens?: number;
		output?: number;
		outputTokens?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
};

export const CHILD_MODEL_CONTEXT_ENTRY_TYPE = "pi-stuff-agent-model-context";
export const CHILD_TOOL_BUDGET_ENTRY_TYPE = "pi-stuff-agent-tool-budget";

export interface ChildModelContext {
	readonly provider: string;
	readonly model: string;
	readonly contextWindow: number;
}

export interface ChildToolBudgetEvent {
	readonly outcome: "soft-reached" | "hard-blocked";
	readonly toolCount: number;
	readonly toolName: string;
}

const CHILD_PROTOCOL_EVENT_TYPES = new Set([
	"session",
	"agent_start",
	"agent_end",
	"agent_settled",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_result_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"queue_update",
	"compaction_start",
	"compaction_end",
	"entry_appended",
	"session_info_changed",
	"thinking_level_changed",
	"auto_retry_start",
	"auto_retry_end",
	"summarization_retry_scheduled",
	"summarization_retry_attempt_start",
	"summarization_retry_finished",
	"bash_execution_update",
]);

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && value !== undefined && isRuntimeObject(value) && !Array.isArray(value);
}

export interface ChildProtocolEvent {
	type: string;
	message?: ChildProtocolMessage;
	toolCallId?: string;
	toolName?: string;
	args?: JsonObject;
	isError?: boolean;
	willRetry?: JsonValue;
	modelContext?: ChildModelContext;
	toolBudgetEvent?: ChildToolBudgetEvent;
}

export function childMessageProtocolError(value: JsonValue | undefined): string | undefined {
	if (!isJsonObject(value)) return "message must be an object";
	const message = value;
	if (
		message["role"] !== "assistant" &&
		message["role"] !== "user" &&
		message["role"] !== "toolResult" &&
		message["role"] !== "custom"
	) {
		return "message.role is invalid";
	}
	for (const field of ["model", "errorMessage", "stopReason"] as const) {
		if (message[field] !== undefined && !isRuntimeString(message[field])) {
			return `message.${field} must be a string`;
		}
	}
	if (message["role"] === "custom") {
		if (!isRuntimeString(message["customType"]) || !message["customType"].trim()) {
			return "message.customType must be a non-empty string";
		}
		if (!isRuntimeBoolean(message["display"])) return "message.display must be a boolean";
		if (!isRuntimeNumber(message["timestamp"]) || !Number.isFinite(message["timestamp"])) {
			return "message.timestamp must be a finite number";
		}
		if (isRuntimeString(message["content"])) return undefined;
		if (!Array.isArray(message["content"])) return "message.content for role 'custom' must be a string or array";
	}
	if (message["role"] === "user" && isRuntimeString(message["content"])) return undefined;
	if (!Array.isArray(message["content"])) return `message.content for role '${message["role"]}' must be an array`;
	for (const part of message["content"]) {
		if (!isJsonObject(part)) return "message.content contains a non-object part";
		const content = part;
		if (!isRuntimeString(content["type"])) return "message.content part type must be a string";
		if (content["type"] === "text" && !isRuntimeString(content["text"])) {
			return "message.content text must be a string";
		}
		if (content["type"] === "thinking" && !isRuntimeString(content["thinking"])) {
			return "message.content thinking must be a string";
		}
		if (content["type"] === "image" && (!isRuntimeString(content["data"]) || !isRuntimeString(content["mimeType"]))) {
			return "message.content image fields must be strings";
		}
		if (
			content["type"] === "toolCall" &&
			(!isRuntimeString(content["id"]) || !isRuntimeString(content["name"]) || !isJsonObject(content["arguments"]))
		) {
			return "message.content toolCall fields are invalid";
		}
		const allowedTypes =
			message["role"] === "assistant"
				? ["text", "thinking", "toolCall"]
				: message["role"] === "user" || message["role"] === "toolResult" || message["role"] === "custom"
					? ["text", "image"]
					: [];
		if (!allowedTypes.includes(content["type"])) {
			return `message.content type '${content["type"]}' is invalid for role '${message["role"]}'`;
		}
	}
	return undefined;
}

export interface ParsedChildProtocolEvent {
	error?: string;
	event?: ChildProtocolEvent;
}

export interface BoundedLineReader {
	end(): void;
	exceeded(): boolean;
	push(chunk: Buffer | string): void;
}

export interface BoundedByteTail {
	byteLength(): number;
	droppedBytes(): number;
	push(chunk: Buffer | string): void;
	text(): string;
}

export function parseChildProtocolEvent(value: JsonValue): ParsedChildProtocolEvent {
	if (!isJsonObject(value)) {
		return { error: "event must be an object" };
	}
	const event = value;
	if (!isRuntimeString(event["type"]) || !event["type"].trim()) {
		return { error: "event.type must be a non-empty string" };
	}
	if (!CHILD_PROTOCOL_EVENT_TYPES.has(event["type"])) {
		return { error: `event.type '${event["type"]}' is unsupported` };
	}
	if (event["type"] === "message_end" || event["type"] === "tool_result_end") {
		const error = childMessageProtocolError(event["message"]);
		if (error) return { error: `${event["type"]} ${error}` };
	}
	let modelContext: ChildModelContext | undefined;
	let toolBudgetEvent: ChildToolBudgetEvent | undefined;
	if (event["type"] === "entry_appended" && isJsonObject(event["entry"])) {
		const entry = event["entry"];
		if (entry["customType"] === CHILD_MODEL_CONTEXT_ENTRY_TYPE) {
			if (entry["type"] !== "custom") return { error: "entry_appended model context entry.type must be 'custom'" };
			if (!isJsonObject(entry["data"])) return { error: "entry_appended model context data must be an object" };
			const data = entry["data"];
			if (data["version"] !== 1) return { error: "entry_appended model context data.version must be 1" };
			if (!isRuntimeString(data["provider"]) || !data["provider"].trim()) {
				return { error: "entry_appended model context data.provider must be a non-empty string" };
			}
			if (!isRuntimeString(data["model"]) || !data["model"].trim()) {
				return { error: "entry_appended model context data.model must be a non-empty string" };
			}
			if (
				!isRuntimeNumber(data["contextWindow"]) ||
				!Number.isSafeInteger(data["contextWindow"]) ||
				data["contextWindow"] <= 0
			) {
				return { error: "entry_appended model context data.contextWindow must be a positive safe integer" };
			}
			modelContext = {
				provider: data["provider"],
				model: data["model"],
				contextWindow: data["contextWindow"],
			};
		} else if (entry["customType"] === CHILD_TOOL_BUDGET_ENTRY_TYPE) {
			if (entry["type"] !== "custom") return { error: "entry_appended Tool budget entry.type must be 'custom'" };
			if (!isJsonObject(entry["data"])) return { error: "entry_appended Tool budget data must be an object" };
			const data = entry["data"];
			if (data["version"] !== 1) return { error: "entry_appended Tool budget data.version must be 1" };
			if (data["outcome"] !== "soft-reached" && data["outcome"] !== "hard-blocked") {
				return { error: "entry_appended Tool budget data.outcome is invalid" };
			}
			if (!isRuntimeNumber(data["toolCount"]) || !Number.isSafeInteger(data["toolCount"]) || data["toolCount"] < 1) {
				return { error: "entry_appended Tool budget data.toolCount must be a positive safe integer" };
			}
			if (!isRuntimeString(data["toolName"]) || !data["toolName"].trim()) {
				return { error: "entry_appended Tool budget data.toolName must be a non-empty string" };
			}
			toolBudgetEvent = {
				outcome: data["outcome"],
				toolCount: data["toolCount"],
				toolName: data["toolName"],
			};
		}
	}
	// SAFETY: supported event names are checked above, and final message events pass the complete message validator.
	return { event: { ...event, type: event["type"], modelContext, toolBudgetEvent } as ChildProtocolEvent };
}

export function formatProtocolOutputLimit(limit: ProtocolOutputLimit): string {
	if (limit.scope === "aggregate") {
		return `${limit.code}: child ${limit.stream} exceeded the ${limit.limitBytes}-byte aggregate protocol limit (observed at least ${limit.observedBytes} bytes).`;
	}
	return `${limit.code}: child ${limit.stream} line exceeded ${limit.limitBytes} bytes (observed at least ${limit.observedBytes} bytes without a newline).`;
}

export function createBoundedLineReader(options: {
	stream?: "stdout" | "stderr";
	maxPendingLineBytes?: number;
	onLine: (line: string) => void;
	onLimit: (limit: ProtocolOutputLimit) => void;
}): BoundedLineReader {
	const maxPendingLineBytes = options.maxPendingLineBytes ?? MAX_CHILD_PENDING_LINE_BYTES;
	if (!Number.isInteger(maxPendingLineBytes) || maxPendingLineBytes < 1) {
		throw new Error("maxPendingLineBytes must be a positive integer.");
	}
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let limitExceeded = false;

	const emitPending = (): void => {
		if (pendingBytes === 0) return;
		options.onLine(Buffer.concat(pending, pendingBytes).toString("utf8"));
		pending = [];
		pendingBytes = 0;
	};

	const append = (segment: Buffer): boolean => {
		if (segment.length === 0) return true;
		const observedBytes = pendingBytes + segment.length;
		if (observedBytes > maxPendingLineBytes) {
			const prior = pendingBytes > 0 ? Buffer.concat(pending, pendingBytes) : Buffer.alloc(0);
			const prefixFromPrior = prior.subarray(0, MAX_PROTOCOL_DIAGNOSTIC_BYTES);
			const prefix =
				prefixFromPrior.length === MAX_PROTOCOL_DIAGNOSTIC_BYTES
					? prefixFromPrior
					: Buffer.concat([
							prefixFromPrior,
							segment.subarray(0, MAX_PROTOCOL_DIAGNOSTIC_BYTES - prefixFromPrior.length),
						]);
			const tailFromSegment = segment.subarray(Math.max(0, segment.length - MAX_PROTOCOL_DIAGNOSTIC_BYTES));
			const tail =
				tailFromSegment.length === MAX_PROTOCOL_DIAGNOSTIC_BYTES
					? tailFromSegment
					: Buffer.concat([
							prior.subarray(
								Math.max(0, prior.length - (MAX_PROTOCOL_DIAGNOSTIC_BYTES - tailFromSegment.length)),
							),
							tailFromSegment,
						]);
			limitExceeded = true;
			pending = [];
			pendingBytes = 0;
			options.onLimit({
				code: "protocol_output_limit",
				stream: options.stream ?? "stdout",
				scope: "line",
				limitBytes: maxPendingLineBytes,
				observedBytes,
				diagnosticPrefix: prefix.toString("utf8"),
				diagnosticTail: tail.toString("utf8"),
			});
			return false;
		}
		pending.push(segment);
		pendingBytes = observedBytes;
		return true;
	};

	return {
		push(chunk) {
			if (limitExceeded) return;
			const bytes = isRuntimeString(chunk) ? Buffer.from(chunk) : chunk;
			let start = 0;
			for (let index = 0; index < bytes.length; index++) {
				if (bytes[index] !== 0x0a) continue;
				if (!append(bytes.subarray(start, index))) return;
				emitPending();
				start = index + 1;
			}
			append(bytes.subarray(start));
		},
		end() {
			if (!limitExceeded) emitPending();
		},
		exceeded: () => limitExceeded,
	};
}

export function createRollingLineReader(options: {
	stream: "stderr";
	maxPendingLineBytes?: number;
	onLine: (line: string) => void;
}): Pick<BoundedLineReader, "end" | "push"> {
	const maxPendingLineBytes = options.maxPendingLineBytes ?? MAX_CHILD_STDERR_BYTES;
	if (!Number.isInteger(maxPendingLineBytes) || maxPendingLineBytes < 1) {
		throw new Error("maxPendingLineBytes must be a positive integer.");
	}
	let pending: Buffer = Buffer.alloc(0);
	let droppedBytes = 0;

	const emitPending = (): void => {
		if (pending.length === 0 && droppedBytes === 0) return;
		const marker = droppedBytes > 0 ? `[… ${String(droppedBytes)} earlier ${options.stream} bytes omitted …]\n` : "";
		options.onLine(`${marker}${pending.toString("utf8")}`);
		pending = Buffer.alloc(0);
		droppedBytes = 0;
	};

	const append = (segment: Buffer): void => {
		if (segment.length === 0) return;
		const combined = Buffer.concat([pending, segment]);
		const retained = trimToUtf8Boundary(combined, maxPendingLineBytes);
		droppedBytes += combined.length - retained.length;
		pending = retained;
	};

	return {
		push(chunk) {
			const bytes = isRuntimeString(chunk) ? Buffer.from(chunk) : chunk;
			let start = 0;
			for (let index = 0; index < bytes.length; index += 1) {
				if (bytes[index] !== 0x0a) continue;
				append(bytes.subarray(start, index));
				emitPending();
				start = index + 1;
			}
			append(bytes.subarray(start));
		},
		end: emitPending,
	};
}

function trimToUtf8Boundary(buffer: Buffer, maxBytes: number): Buffer {
	if (buffer.length <= maxBytes) return buffer;
	let start = buffer.length - maxBytes;
	while (start < buffer.length) {
		const byte = buffer[start];
		if (byte === undefined || (byte & 0xc0) !== 0x80) break;
		start++;
	}
	return buffer.subarray(start);
}

export function createBoundedByteTail(maxBytes = MAX_CHILD_STDERR_BYTES): BoundedByteTail {
	if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error("maxBytes must be a positive integer.");
	let tail: Buffer = Buffer.alloc(0);
	let droppedBytes = 0;
	return {
		push(chunk) {
			const bytes = isRuntimeString(chunk) ? Buffer.from(chunk) : chunk;
			const combined = Buffer.concat([tail, bytes]);
			const retained = trimToUtf8Boundary(combined, maxBytes);
			droppedBytes += combined.length - retained.length;
			tail = retained;
		},
		text: () => tail.toString("utf8"),
		byteLength: () => tail.length,
		droppedBytes: () => droppedBytes,
	};
}

export type ChildLifecycleAction = "start-drain" | "cancel-drain" | "none";

export function projectChildLifecycle(
	event: { type?: string; willRetry?: unknown },
	terminalAssistantStop = false,
): ChildLifecycleAction {
	if (event.type === "agent_end" && event.willRetry === true) return "cancel-drain";
	if (event.type === "agent_settled") return "start-drain";
	if (terminalAssistantStop) return "start-drain";
	if (event.type === "agent_start" || event.type === "message_start" || event.type === "message_end") {
		return "cancel-drain";
	}
	return "none";
}
