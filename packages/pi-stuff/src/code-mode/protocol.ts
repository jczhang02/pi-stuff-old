import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import type { CodemodeValue } from "./cloudflare/codec.ts";

export const MAX_CONCURRENT_CODE_MODE_TOOL_CALLS = 768;
export const MAX_RETAINED_CODE_MODE_TRACES = 768;

export interface SandboxToolExecutionContext {
	readonly captureResult?: (result: AgentToolResult<unknown>) => void;
	readonly cwd: string;
	readonly extensionContext?: ExtensionContext;
	readonly onUpdate?: (result: AgentToolResult<unknown>) => void;
	readonly toolCallId?: string;
}

export interface SuiteSandboxTool {
	readonly description: string;
	/** Platform plumbing may manage its own durable step instead of creating a second ledger entry. */
	readonly ledger?: "bypass";
	readonly inputSchema: TSchema;
	readonly name: string;
	/** Platform plumbing is not a user Tool row. */
	readonly presentation?: "hidden";
	readonly replay?: "never" | "record" | "reexecute";
	readonly requiresApproval?: boolean;
	readonly usage: string;
	invoke(input: CodemodeValue, context: SandboxToolExecutionContext, signal: AbortSignal): Promise<CodemodeValue>;
}

export interface RuntimeContentItem {
	readonly detail?: "auto" | "high" | "low" | "original" | null;
	readonly image_url?: string;
	readonly text?: string;
	readonly type: "input_image" | "input_text";
}

type RuntimeToolTraceStatus = "cancelled" | "done" | "error" | "pending" | "running";

export interface RuntimeToolTrace {
	readonly attempt?: number;
	error?: string;
	readonly executionId?: string;
	readonly id: string;
	readonly input: CodemodeValue;
	readonly name: string;
	readonly replayed?: boolean;
	result?: AgentToolResult<unknown>;
	readonly sequence?: number;
	status: RuntimeToolTraceStatus;
}

export type RuntimeToolReplay =
	| {
			readonly kind: "error";
			readonly message: string;
			readonly result?: AgentToolResult<unknown>;
	  }
	| {
			readonly kind: "result";
			readonly result?: AgentToolResult<unknown>;
			readonly value: CodemodeValue;
	  };

export interface RuntimeToolCallPlan {
	readonly attempt: number;
	readonly executionId: string;
	readonly id: string;
	readonly pause?: { readonly message: string };
	readonly replay?: RuntimeToolReplay;
	readonly sequence: number;
}

export interface RuntimeToolCallSettlement {
	readonly message?: string;
	readonly result?: AgentToolResult<unknown>;
	readonly status: "error" | "incomplete" | "success";
	readonly value?: CodemodeValue;
}

export type RuntimeResponse = (
	| { readonly kind: "result"; readonly errorText?: string }
	| { readonly kind: "terminated" }
	| { readonly kind: "yielded" }
) & {
	readonly cellId: string;
	readonly contentItems: readonly RuntimeContentItem[];
	readonly droppedTraceCount?: number;
	readonly traces?: readonly RuntimeToolTrace[];
};

export interface RuntimeTraceUpdate {
	readonly cellId: string;
	readonly droppedTraceCount?: number;
	readonly trace: RuntimeToolTrace;
}

export interface ExecutorContext extends SandboxToolExecutionContext {
	readonly beginToolCall?: (name: string, input: CodemodeValue) => RuntimeToolCallPlan;
	readonly completeToolCall?: (plan: RuntimeToolCallPlan, settlement: RuntimeToolCallSettlement) => void;
	readonly onTraceUpdate?: (update: RuntimeTraceUpdate) => void;
}

export interface CodeModeExecuteOptions {
	readonly context: ExecutorContext;
	readonly signal?: AbortSignal;
	readonly source: string;
	readonly tools: readonly SuiteSandboxTool[];
}

export interface CodeModeWaitOptions {
	readonly context: ExecutorContext;
	readonly signal?: AbortSignal;
}
