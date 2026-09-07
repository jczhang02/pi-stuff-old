import type {
	AgentToolResult,
	ContextUsage,
	ExtensionAPI,
	ExtensionUIContext,
	SessionEntry,
	SessionManager,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { JsonInputValue, JsonObject } from "../shared/json-value.ts";
import type {
	MagicContextCommandName,
	MagicContextEventMap,
	MagicContextEventName,
	MagicContextModel,
	MagicContextToolName,
} from "./magic-context-types.ts";

export const MAGIC_WORKER_PROTOCOL_VERSION = 4;
export const MAGIC_WORKER_SYNC_BUFFER_BYTES = 64 * 1024;

export type MagicWorkerCommandName = MagicContextCommandName;
export type MagicWorkerToolName = MagicContextToolName;

export function magicWorkerCommandName(name: string): MagicWorkerCommandName | undefined {
	switch (name) {
		case "ctx-aug":
		case "ctx-dream":
		case "ctx-embed":
		case "ctx-flush":
		case "ctx-recomp":
		case "ctx-session-upgrade":
		case "ctx-status":
		case "ctx-wrapup":
		case "todos":
			return name;
		default:
			return;
	}
}

export function magicWorkerToolName(name: string): MagicWorkerToolName | undefined {
	switch (name) {
		case "ctx_expand":
		case "ctx_memory":
		case "ctx_note":
		case "ctx_reduce":
		case "ctx_search":
		case "todowrite":
			return name;
		default:
			return;
	}
}

export interface MagicWorkerSessionSnapshot {
	readonly id: string | undefined;
	readonly leafId: string | undefined;
}

export interface MagicWorkerEventMap {
	readonly agent_end: MagicContextEventMap["agent_end"]["event"];
	readonly before_agent_start: MagicContextEventMap["before_agent_start"]["event"];
	readonly context: MagicContextEventMap["context"]["event"];
	readonly message_end: MagicContextEventMap["message_end"]["event"];
	readonly session_before_compact: Omit<MagicContextEventMap["session_before_compact"]["event"], "signal">;
	readonly session_before_switch: MagicContextEventMap["session_before_switch"]["event"];
	readonly session_compact: MagicContextEventMap["session_compact"]["event"];
	readonly session_shutdown: MagicContextEventMap["session_shutdown"]["event"];
	readonly session_start: MagicContextEventMap["session_start"]["event"];
	readonly tool_execution_end: Omit<MagicContextEventMap["tool_execution_end"]["event"], "result"> & {
		readonly result: undefined;
	};
	readonly tool_execution_start: Omit<MagicContextEventMap["tool_execution_start"]["event"], "args"> & {
		readonly args: JsonObject;
	};
	readonly tool_result: Omit<MagicContextEventMap["tool_result"]["event"], "details" | "input"> & {
		readonly details: undefined;
		readonly input: JsonObject;
	};
}

export type MagicWorkerEventName = MagicContextEventName;

export type MagicWorkerEventInput = {
	readonly [Name in MagicWorkerEventName]: {
		readonly event: MagicWorkerEventMap[Name];
		readonly name: Name;
		readonly type: "event";
	};
}[MagicWorkerEventName];

export type MagicWorkerEventResult<Name extends MagicWorkerEventName = MagicWorkerEventName> = {
	readonly [Current in Name]: {
		readonly event: Current;
		readonly result: MagicContextEventMap[Current]["result"];
	};
}[Name];

export interface MagicWorkerContextSnapshot {
	readonly contextUsage: ContextUsage | undefined;
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly mode: "json" | "print" | "rpc" | "tui";
	readonly model: MagicContextModel | undefined;
	readonly session: MagicWorkerSessionSnapshot;
	readonly systemPrompt: string;
}

export interface MagicWorkerToolDescriptor {
	readonly constrainedSampling: ToolDefinition["constrainedSampling"] | undefined;
	readonly description: string;
	readonly executionMode: ToolDefinition["executionMode"] | undefined;
	readonly label: string;
	readonly name: MagicWorkerToolName;
	readonly parameters: JsonObject;
	readonly promptGuidelines: readonly string[] | undefined;
	readonly promptSnippet: string | undefined;
	readonly renderShell: ToolDefinition["renderShell"] | undefined;
}

export interface MagicWorkerCommandDescriptor {
	readonly description: string | undefined;
	readonly name: MagicWorkerCommandName;
}

export interface MagicWorkerHostTool {
	readonly description: string;
	readonly name: string;
	readonly parameters: JsonObject;
	readonly promptGuidelines: string[] | undefined;
	readonly sourceInfo: ToolInfo["sourceInfo"];
}

export interface MagicWorkerInitializeRequest {
	readonly hostTools: readonly MagicWorkerHostTool[];
	readonly id: number;
	readonly protocolVersion: typeof MAGIC_WORKER_PROTOCOL_VERSION;
	readonly type: "initialize";
}

interface MagicWorkerInvocationBase {
	readonly context: MagicWorkerContextSnapshot;
	readonly id: number;
}

export type MagicWorkerEventRequest = {
	readonly [Name in MagicWorkerEventName]: MagicWorkerInvocationBase & {
		readonly event: MagicWorkerEventMap[Name];
		readonly name: Name;
		readonly type: "event";
	};
}[MagicWorkerEventName];

export interface MagicWorkerCommandRequest extends MagicWorkerInvocationBase {
	readonly args: string;
	readonly name: MagicWorkerCommandName;
	readonly type: "command";
}

export interface MagicWorkerToolRequest extends MagicWorkerInvocationBase {
	readonly args: JsonObject;
	readonly name: MagicWorkerToolName;
	readonly toolCallId: string;
	readonly type: "tool";
}

export type MagicWorkerInvocationRequest = MagicWorkerCommandRequest | MagicWorkerEventRequest | MagicWorkerToolRequest;

export interface MagicWorkerCancelRequest {
	readonly id: number;
	readonly type: "cancel";
}

export interface MagicWorkerSessionEntryRequest {
	readonly entry: SessionEntry;
	readonly leafId: string;
	readonly sessionId: string;
	readonly type: "session-entry";
}

export interface MagicWorkerSessionSnapshotRequest {
	readonly branch: readonly SessionEntry[];
	readonly leafId: string | undefined;
	readonly sessionId: string;
	readonly type: "session-snapshot";
}

export type MagicWorkerRequest =
	| MagicWorkerCancelRequest
	| MagicWorkerInitializeRequest
	| MagicWorkerInvocationRequest
	| MagicWorkerSessionEntryRequest
	| MagicWorkerSessionSnapshotRequest;

export interface MagicWorkerReadyMessage {
	readonly commands: readonly MagicWorkerCommandDescriptor[];
	readonly events: readonly MagicWorkerEventName[];
	readonly id: number;
	readonly protocolVersion: typeof MAGIC_WORKER_PROTOCOL_VERSION;
	readonly tools: readonly MagicWorkerToolDescriptor[];
	readonly type: "ready";
}

export interface MagicWorkerCommandResultMessage {
	readonly id: number;
	readonly type: "command-result";
}

export interface MagicWorkerEventResultMessage {
	readonly id: number;
	readonly result: MagicWorkerEventResult;
	readonly type: "event-result";
}

export interface MagicWorkerToolResultMessage {
	readonly id: number;
	readonly result: AgentToolResult<JsonInputValue | undefined>;
	readonly type: "tool-result";
}

export type MagicWorkerResultMessage =
	| MagicWorkerCommandResultMessage
	| MagicWorkerEventResultMessage
	| MagicWorkerToolResultMessage;

export interface MagicWorkerErrorMessage {
	readonly error: string;
	readonly id: number;
	readonly stack: string | undefined;
	readonly type: "error";
}

export interface MagicWorkerToolUpdateMessage {
	readonly id: number;
	readonly type: "tool-update";
	readonly update: AgentToolResult<JsonInputValue | undefined>;
}

export type MagicWorkerEffect =
	| {
			readonly args: [customType: string, data?: JsonInputValue];
			readonly name: "appendEntry";
	  }
	| {
			readonly args: Parameters<ExtensionAPI["sendMessage"]>;
			readonly name: "sendMessage";
	  }
	| {
			readonly args: Parameters<ExtensionAPI["sendUserMessage"]>;
			readonly name: "sendUserMessage";
	  }
	| {
			readonly args: Parameters<ExtensionUIContext["notify"]>;
			readonly name: "notify";
	  }
	| {
			readonly args: Parameters<ExtensionUIContext["setStatus"]>;
			readonly name: "setStatus";
	  };

export type MagicWorkerEffectMessage = MagicWorkerEffect & {
	readonly sessionId: string | undefined;
	readonly type: "effect";
};

export interface MagicWorkerSyncEffectMessage {
	readonly args: Parameters<SessionManager["appendCompaction"]>;
	readonly buffer: SharedArrayBuffer;
	readonly name: "appendCompaction";
	readonly sessionId: string | undefined;
	readonly type: "sync-effect";
}

export type MagicWorkerMessage =
	| MagicWorkerEffectMessage
	| MagicWorkerErrorMessage
	| MagicWorkerReadyMessage
	| MagicWorkerResultMessage
	| MagicWorkerSyncEffectMessage
	| MagicWorkerToolUpdateMessage;
