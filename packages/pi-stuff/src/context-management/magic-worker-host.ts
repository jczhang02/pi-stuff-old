import type { ExtensionAPI, ExtensionContext, ExtensionEvent, SessionManager } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { readHostProxyProperty } from "../shared/host-proxy.ts";
import { type JsonObject, parseJsonObject } from "../shared/json-value.ts";
import { isRuntimeFunction } from "../shared/runtime-type.ts";
import {
	MAGIC_WORKER_SYNC_BUFFER_BYTES,
	type MagicWorkerContextSnapshot,
	type MagicWorkerEffectMessage,
	type MagicWorkerErrorMessage,
	type MagicWorkerEventInput,
	type MagicWorkerHostTool,
	type MagicWorkerSyncEffectMessage,
} from "./magic-worker-protocol.ts";

export function magicWorkerErrorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function requiredHostCall<Result>(label: string, call: () => Result): Result {
	try {
		return call();
	} catch (error) {
		throw new Error(`Magic Context could not snapshot Pi ${label}: ${magicWorkerErrorMessage(error)}`, {
			cause: error,
		});
	}
}

function workerModel(ctx: ExtensionContext): MagicWorkerContextSnapshot["model"] {
	const model = ctx.model;
	if (!model) return;
	return {
		api: model.api,
		contextWindow: model.contextWindow,
		id: model.id,
		maxTokens: model.maxTokens,
		provider: model.provider,
	};
}

export function snapshotMagicWorkerContext(ctx: ExtensionContext, readContextUsage = true): MagicWorkerContextSnapshot {
	const manager = ctx.sessionManager;
	return {
		contextUsage: readContextUsage ? requiredHostCall("context usage", () => ctx.getContextUsage()) : undefined,
		cwd: ctx.cwd,
		hasUI: ctx.hasUI,
		mode: ctx.mode,
		model: workerModel(ctx),
		session: {
			id: requiredHostCall("Session id", () => manager.getSessionId()),
			leafId: requiredHostCall("Session leaf id", () => manager.getLeafId()) ?? undefined,
		},
		systemPrompt: requiredHostCall("system prompt", () => ctx.getSystemPrompt()),
	};
}

function snapshotToolArguments(toolName: string, args: JsonObject): JsonObject {
	if (toolName !== "todowrite") return {};
	const todos = args["todos"];
	return todos === undefined ? {} : parseJsonObject(JSON.stringify({ todos }));
}

export function snapshotMagicWorkerEvent(event: ExtensionEvent): MagicWorkerEventInput {
	switch (event.type) {
		case "agent_end":
			return { event, name: "agent_end", type: "event" };
		case "before_agent_start":
			return { event, name: "before_agent_start", type: "event" };
		case "context":
			return { event, name: "context", type: "event" };
		case "message_end":
			return { event, name: "message_end", type: "event" };
		case "session_before_compact": {
			const compactEvent = event.customInstructions
				? {
						branchEntries: event.branchEntries,
						customInstructions: event.customInstructions,
						preparation: event.preparation,
						reason: event.reason,
						type: event.type,
						willRetry: event.willRetry,
					}
				: {
						branchEntries: event.branchEntries,
						preparation: event.preparation,
						reason: event.reason,
						type: event.type,
						willRetry: event.willRetry,
					};
			return { event: compactEvent, name: "session_before_compact", type: "event" };
		}
		case "session_before_switch":
			return { event, name: "session_before_switch", type: "event" };
		case "session_compact":
			return { event, name: "session_compact", type: "event" };
		case "session_shutdown":
			return { event, name: "session_shutdown", type: "event" };
		case "session_start":
			return { event, name: "session_start", type: "event" };
		case "tool_execution_end":
			return {
				event: {
					isError: event.isError,
					result: undefined,
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					type: event.type,
				},
				name: "tool_execution_end",
				type: "event",
			};
		case "tool_execution_start":
			return {
				event: {
					args: snapshotToolArguments(event.toolName, event.args),
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					type: event.type,
				},
				name: "tool_execution_start",
				type: "event",
			};
		case "tool_result": {
			const toolResult = {
				content: event.content,
				details: undefined,
				input: {},
				isError: event.isError,
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				type: event.type,
			};
			return {
				event: event.usage ? { ...toolResult, usage: event.usage } : toolResult,
				name: "tool_result",
				type: "event",
			};
		}
		default:
			throw new Error(`Magic Context registered unsupported Pi event '${event.type}'.`);
	}
}

export function magicWorkerHostTools(pi: ExtensionAPI): MagicWorkerHostTool[] {
	return pi.getAllTools().map((tool) => ({
		description: tool.description,
		name: tool.name,
		parameters: parseJsonObject(JSON.stringify(tool.parameters)),
		promptGuidelines: tool.promptGuidelines ? [...tool.promptGuidelines] : undefined,
		sourceInfo: { ...tool.sourceInfo },
	}));
}

export function magicWorkerError(message: MagicWorkerErrorMessage): Error {
	const error = new Error(message.error);
	if (message.stack) error.stack = message.stack;
	return error;
}

export function canAppendMagicWorkerCompaction(
	manager: ExtensionContext["sessionManager"],
): manager is ExtensionContext["sessionManager"] & Pick<SessionManager, "appendCompaction"> {
	return isRuntimeFunction(readHostProxyProperty(manager, "appendCompaction"));
}

function hostFailure(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(magicWorkerErrorMessage(cause));
}

export function applyMagicWorkerHostEffect(
	pi: ExtensionAPI,
	ctx: ExtensionContext | undefined,
	message: MagicWorkerEffectMessage,
	synchronize: (ctx: ExtensionContext) => void,
): Effect.Effect<void, Error> {
	return Effect.try({
		try: () => {
			if (message.sessionId && !ctx) {
				throw new Error(`Magic Context emitted '${message.name}' for an inactive Session.`);
			}
			switch (message.name) {
				case "appendEntry":
					pi.appendEntry(...message.args);
					if (ctx) synchronize(ctx);
					break;
				case "notify":
					if (!ctx) throw new Error("Magic Context emitted a notification without a Host context.");
					ctx.ui.notify(...message.args);
					break;
				case "sendMessage":
					pi.sendMessage(...message.args);
					break;
				case "sendUserMessage":
					pi.sendUserMessage(...message.args);
					break;
				case "setStatus":
					if (!ctx) throw new Error("Magic Context emitted a status update without a Host context.");
					ctx.ui.setStatus(...message.args);
					break;
			}
		},
		catch: hostFailure,
	});
}

export function applyMagicWorkerHostCompaction(
	ctx: ExtensionContext | undefined,
	message: MagicWorkerSyncEffectMessage,
	synchronize: (ctx: ExtensionContext) => void,
): Effect.Effect<string, Error> {
	return Effect.try({
		try: () => {
			if (!ctx) throw new Error("Pi Host context is no longer available for this Session.");
			const manager = ctx.sessionManager;
			if (!canAppendMagicWorkerCompaction(manager)) {
				throw new Error("Pi SessionManager does not expose appendCompaction.");
			}
			const entryId = manager.appendCompaction(...message.args);
			synchronize(ctx);
			return entryId;
		},
		catch: hostFailure,
	});
}

const SYNC_RESPONSE_TOO_LARGE = "Magic Context Host effect response exceeded its buffer.";

export function writeMagicWorkerSyncResponse(buffer: SharedArrayBuffer, status: 1 | 2, text: string): void {
	const control = new Int32Array(buffer, 0, 2);
	const bytes = new Uint8Array(buffer, Int32Array.BYTES_PER_ELEMENT * 2);
	try {
		let encoded = new TextEncoder().encode(text);
		let finalStatus = status;
		if (encoded.length > bytes.length) {
			encoded = new TextEncoder().encode(SYNC_RESPONSE_TOO_LARGE);
			finalStatus = 2;
		}
		const length = Math.min(encoded.length, bytes.length);
		bytes.set(encoded.subarray(0, length));
		Atomics.store(control, 1, length);
		Atomics.store(control, 0, finalStatus);
	} finally {
		Atomics.notify(control, 0);
	}
}

export { MAGIC_WORKER_SYNC_BUFFER_BYTES };
