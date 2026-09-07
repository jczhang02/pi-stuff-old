import { isRuntimeObject } from "../shared/runtime-type.ts";
import type { ToolArguments } from "./activity.ts";

interface ToolRuntimeRecord {
	readonly activity?: unknown;
	readonly arguments?: unknown;
	readonly block?: unknown;
	readonly categories?: unknown;
	readonly classify?: unknown;
	readonly codeMode?: unknown;
	readonly compensate?: unknown;
	readonly content?: unknown;
	readonly decode?: unknown;
	readonly details?: unknown;
	readonly display?: unknown;
	readonly disposeExecution?: unknown;
	readonly execute?: unknown;
	readonly id?: unknown;
	readonly input?: unknown;
	readonly isError?: unknown;
	readonly lifecycle?: unknown;
	readonly media?: unknown;
	readonly name?: unknown;
	readonly onPassEnd?: unknown;
	readonly owner?: unknown;
	readonly partialResult?: unknown;
	readonly parameters?: unknown;
	readonly presentation?: unknown;
	readonly reason?: unknown;
	readonly renderCall?: unknown;
	readonly renderResult?: unknown;
	readonly registry?: unknown;
	readonly replay?: unknown;
	readonly requiresApproval?: unknown;
	readonly result?: unknown;
	readonly resultIsError?: unknown;
	readonly role?: unknown;
	readonly showFallback?: unknown;
	readonly silentSuccess?: unknown;
	readonly stopReason?: unknown;
	readonly summarizeIssue?: unknown;
	readonly terminate?: unknown;
	readonly tool?: unknown;
	readonly toolCallId?: unknown;
	readonly toolName?: unknown;
	readonly type?: unknown;
	readonly usage?: unknown;
	readonly catalog?: unknown;
	readonly get?: unknown;
	readonly invoke?: unknown;
	readonly isActive?: unknown;
	readonly list?: unknown;
}

export function isRecordValue<Value>(value: Value): value is Value & ToolRuntimeRecord {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

export function isToolArguments<Value>(value: Value): value is Value & ToolArguments {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}
