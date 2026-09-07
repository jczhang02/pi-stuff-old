import type {
	AgentEndEvent,
	AgentToolResult,
	AgentToolUpdateCallback,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	CompactionResult,
	ContextEvent,
	ContextUsage,
	ExtensionAPI,
	ExtensionContext,
	ExtensionUIContext,
	MessageEndEvent,
	SessionBeforeCompactEvent,
	SessionBeforeSwitchEvent,
	SessionCompactEvent,
	SessionManager,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolDefinition,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolInfo,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import type { JsonInputValue, JsonObject } from "../shared/json-value.ts";

export type MagicContextCommandName =
	| "ctx-aug"
	| "ctx-dream"
	| "ctx-embed"
	| "ctx-flush"
	| "ctx-recomp"
	| "ctx-session-upgrade"
	| "ctx-status"
	| "ctx-wrapup"
	| "todos";

export type MagicContextToolName = "ctx_expand" | "ctx_memory" | "ctx_note" | "ctx_reduce" | "ctx_search" | "todowrite";

export interface MagicContextModel {
	readonly api?: string;
	readonly contextWindow: number;
	readonly id: string;
	readonly maxTokens: number;
	readonly provider: string;
}

export type MagicContextSessionManager = Pick<
	SessionManager,
	"appendCompaction" | "getBranch" | "getEntry" | "getLeafId" | "getSessionId"
>;

export interface MagicContextExtensionContext {
	readonly cwd: string;
	readonly hasUI: boolean;
	readonly mode: ExtensionContext["mode"];
	readonly model: MagicContextModel | undefined;
	readonly sessionManager: MagicContextSessionManager;
	readonly signal: AbortSignal | undefined;
	readonly ui: Pick<ExtensionUIContext, "custom" | "notify" | "setStatus">;
	getContextUsage(): ContextUsage | undefined;
	getSystemPrompt(): string;
}

export interface MagicCompactionResult {
	readonly cancel?: boolean;
	readonly compaction?: CompactionResult;
}

export interface MagicContextEventMap {
	readonly agent_end: { readonly event: AgentEndEvent; readonly result: undefined };
	readonly before_agent_start: {
		readonly event: BeforeAgentStartEvent;
		readonly result: BeforeAgentStartEventResult | undefined;
	};
	readonly context: {
		readonly event: ContextEvent;
		readonly result: { readonly messages?: ContextEvent["messages"] } | undefined;
	};
	readonly message_end: {
		readonly event: MessageEndEvent;
		readonly result: { readonly message?: MessageEndEvent["message"] } | undefined;
	};
	readonly session_before_compact: {
		readonly event: SessionBeforeCompactEvent;
		readonly result: MagicCompactionResult | undefined;
	};
	readonly session_before_switch: {
		readonly event: SessionBeforeSwitchEvent;
		readonly result: { readonly cancel?: boolean } | undefined;
	};
	readonly session_compact: { readonly event: SessionCompactEvent; readonly result: undefined };
	readonly session_shutdown: { readonly event: SessionShutdownEvent; readonly result: undefined };
	readonly session_start: { readonly event: SessionStartEvent; readonly result: undefined };
	readonly tool_execution_end: { readonly event: ToolExecutionEndEvent; readonly result: undefined };
	readonly tool_execution_start: { readonly event: ToolExecutionStartEvent; readonly result: undefined };
	readonly tool_result: {
		readonly event: ToolResultEvent;
		readonly result: { readonly content?: ToolResultEvent["content"] } | undefined;
	};
}

export type MagicContextEventName = keyof MagicContextEventMap;
export type MagicContextEventHandler<Name extends MagicContextEventName> = (
	event: MagicContextEventMap[Name]["event"],
	ctx: MagicContextExtensionContext,
) => MagicContextEventMap[Name]["result"] | Promise<MagicContextEventMap[Name]["result"]>;
export type MagicContextEventRegistration = {
	readonly [Name in MagicContextEventName]: readonly [Name, MagicContextEventHandler<Name>];
}[MagicContextEventName];

export interface MagicContextToolDefinition
	extends Pick<
		ToolDefinition,
		| "constrainedSampling"
		| "description"
		| "executionMode"
		| "label"
		| "promptGuidelines"
		| "promptSnippet"
		| "renderShell"
	> {
	readonly name: MagicContextToolName;
	readonly parameters: JsonObject;
	execute(
		toolCallId: string,
		params: JsonObject,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<JsonInputValue | undefined> | undefined,
		ctx: MagicContextExtensionContext,
	): Promise<AgentToolResult<JsonInputValue | undefined>>;
}

export interface MagicContextToolInfo extends Omit<ToolInfo, "name" | "parameters"> {
	readonly name: string;
	readonly parameters: JsonObject;
}

export interface MagicContextCommandDefinition {
	readonly description?: string;
	readonly handler: (args: string, ctx: MagicContextExtensionContext) => Promise<void> | void;
}

export interface MagicContextExtensionAPI
	extends Pick<ExtensionAPI, "events" | "registerEntryRenderer" | "sendMessage" | "sendUserMessage"> {
	appendEntry(customType: string, data?: JsonInputValue): void;
	getAllTools(): MagicContextToolInfo[];
	on(...registration: MagicContextEventRegistration): void;
	registerCommand(name: MagicContextCommandName, definition: MagicContextCommandDefinition): void;
	registerTool(tool: MagicContextToolDefinition): void;
}
