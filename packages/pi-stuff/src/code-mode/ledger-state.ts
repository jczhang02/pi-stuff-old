import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { type Static, type TProperties, Type } from "typebox";
import { Value } from "typebox/value";
import { type JsonSourceValue, type JsonValue, parseJsonValue } from "../shared/json-value.ts";
import { isRuntimeObject } from "../shared/runtime-type.ts";
import { type CodemodeValue, parseForStorage, stringifyForStorage } from "./cloudflare/codec.ts";
import type { Snippet } from "./cloudflare/snippet.ts";
import { unwrapSuiteToolResult } from "./connector.ts";
import { isCodeModeToolContent } from "./presentation.ts";

const SCHEMA_VERSION = 1;
export const MAX_DURABLE_INPUT_BYTES = 1_000_000;
export const MAX_RETAINED_EXECUTIONS = 50;

const EXECUTION_STATUSES = [
	"abandoned",
	"cancelled",
	"compensated",
	"error",
	"expired",
	"incomplete",
	"paused",
	"rejected",
	"rolled_back",
	"running",
	"success",
] as const;

export type CodeModeExecutionStatus = (typeof EXECUTION_STATUSES)[number];

export type ReplayPolicy = "never" | "record" | "reexecute";

const NONEMPTY_STRING_SCHEMA = Type.String({ minLength: 1 });
const JSON_VALUE_SCHEMA = Type.Unsafe<JsonValue>({});
const STORED_VALUE_SCHEMA = Type.Union([
	Type.Object({ kind: Type.Literal("undefined") }, { additionalProperties: false }),
	Type.Object({ json: JSON_VALUE_SCHEMA, kind: Type.Literal("json") }, { additionalProperties: false }),
]);
const REPLAY_POLICY_SCHEMA = Type.Union([Type.Literal("never"), Type.Literal("record"), Type.Literal("reexecute")]);
const EVENT_BASE_SCHEMA = { at: Type.Number(), schemaVersion: Type.Literal(SCHEMA_VERSION) };

function eventSchema<const Kind extends string, const Properties extends TProperties>(
	kind: Kind,
	properties: Properties,
) {
	return Type.Object(
		{ ...EVENT_BASE_SCHEMA, ...properties, kind: Type.Literal(kind) },
		{ additionalProperties: false },
	);
}

function executionEventSchema<const Kind extends string, const Properties extends TProperties>(
	kind: Kind,
	properties: Properties,
) {
	return eventSchema(kind, { executionId: NONEMPTY_STRING_SCHEMA, ...properties });
}

function callEventSchema<const Kind extends string, const Properties extends TProperties>(
	kind: Kind,
	properties: Properties,
) {
	return executionEventSchema(kind, { callId: NONEMPTY_STRING_SCHEMA, ...properties });
}

const CALL_OPENED_SCHEMA = {
	args: STORED_VALUE_SCHEMA,
	argsKey: Type.String(),
	attempt: Type.Integer(),
	name: NONEMPTY_STRING_SCHEMA,
	replay: REPLAY_POLICY_SCHEMA,
	requiresApproval: Type.Optional(Type.Boolean()),
	sequence: Type.Integer(),
};
const LEDGER_EVENT_SCHEMA = Type.Union([
	callEventSchema("call-compensated", {}),
	callEventSchema("call-pending", CALL_OPENED_SCHEMA),
	callEventSchema("call-settled", {
		error: Type.Optional(Type.String()),
		result: Type.Optional(STORED_VALUE_SCHEMA),
		status: Type.Union([Type.Literal("error"), Type.Literal("success")]),
		value: Type.Optional(STORED_VALUE_SCHEMA),
	}),
	callEventSchema("call-started", CALL_OPENED_SCHEMA),
	// Legacy replay only. Current retention trims the projection and relies on
	// the aggregate physical budget instead of appending more tombstones.
	executionEventSchema("execution-pruned", {}),
	executionEventSchema("execution-resumed", { attempt: Type.Integer() }),
	executionEventSchema("execution-settled", {
		attempt: Type.Integer(),
		error: Type.Optional(Type.String()),
		status: Type.Unsafe<CodeModeExecutionStatus>({ enum: EXECUTION_STATUSES, type: "string" }),
	}),
	executionEventSchema("execution-started", {
		code: Type.String(),
		cwd: Type.Optional(Type.String()),
		outerToolCallId: Type.String(),
	}),
	eventSchema("snippet-deleted", { name: Type.String() }),
	eventSchema("snippet-saved", {
		snippet: Type.Object(
			{
				code: Type.String(),
				connectors: Type.Optional(Type.Array(Type.String())),
				description: Type.String(),
				inputSchema: Type.Optional(Type.Unknown()),
				name: Type.String(),
				savedAt: Type.Number(),
			},
			{ additionalProperties: false },
		),
	}),
]);

type StoredValue = Readonly<Static<typeof STORED_VALUE_SCHEMA>>;
type SchemaLedgerEvent = Static<typeof LEDGER_EVENT_SCHEMA>;
type SchemaEvent<Kind extends SchemaLedgerEvent["kind"]> = Readonly<Extract<SchemaLedgerEvent, { kind: Kind }>>;

export type CallPendingEvent = SchemaEvent<"call-pending">;
export type CallSettledEvent = SchemaEvent<"call-settled">;
export type CallStartedEvent = SchemaEvent<"call-started">;
export type ExecutionSettledEvent = SchemaEvent<"execution-settled">;
export type LedgerEvent = Readonly<SchemaLedgerEvent>;

export interface CallState {
	args: CodemodeValue;
	argsKey: string;
	attempt: number;
	callId: string;
	compensated?: boolean;
	error?: string;
	name: string;
	replay: ReplayPolicy;
	requiresApproval: boolean;
	result?: AgentToolResult<unknown>;
	sequence: number;
	status: "error" | "pending" | "running" | "success";
	value?: CodemodeValue;
	valuePresent?: boolean;
}

export interface CodeModeExecutionHistoryItem {
	readonly code: string;
	readonly createdAt: number;
	readonly error?: string;
	readonly executionId: string;
	readonly outerToolCallId: string;
	readonly status: CodeModeExecutionStatus;
	readonly toolCalls: number;
	readonly tools: readonly string[];
	readonly updatedAt: number;
}

export interface CodeModeCompensationTarget {
	readonly callId: string;
	readonly input: CodemodeValue;
	readonly name: string;
	readonly sequence: number;
	readonly value: CodemodeValue;
}

export interface CodeModePendingAction {
	readonly args: CodemodeValue;
	readonly connector: "tools";
	readonly executionId: string;
	readonly method: string;
	readonly seq: number;
}

type Mutable<Value> = { -readonly [Key in keyof Value]: Value[Key] };

export interface ExecutionState extends Omit<Mutable<CodeModeExecutionHistoryItem>, "tools"> {
	attempt: number;
	calls: Map<number, CallState>;
	cwd?: string;
}

export interface LedgerSnapshot {
	executions: Map<string, ExecutionState>;
	snippets: Map<string, Snippet>;
	totalExecutions: number;
}

function serializeDurableValue<Value>(what: string, value: Value): string | undefined {
	try {
		return stringifyForStorage(value);
	} catch (error) {
		throw new Error(
			`${what} could not be recorded durably (not serializable: ${error instanceof Error ? error.message : String(error)}). Only JSON-compatible values, binary, and bigint can cross a replay boundary.`,
		);
	}
}

function storedDurableValue(serialized: string | undefined): StoredValue {
	return serialized === undefined ? { kind: "undefined" } : { json: parseJsonValue(serialized), kind: "json" };
}

export function durableValue<Value>(what: string, value: Value): StoredValue {
	return storedDurableValue(serializeDurableValue(what, value));
}

export function durableInputValue<Value>(what: string, value: Value): StoredValue {
	const serialized = serializeDurableValue(what, value);
	const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized);
	if (bytes > MAX_DURABLE_INPUT_BYTES) {
		throw new Error(
			`${what} is too large to record durably before execution (${String(bytes)} bytes > ${String(MAX_DURABLE_INPUT_BYTES)} byte limit). Write large data to a file or workspace and pass a small reference such as a path.`,
		);
	}
	return storedDurableValue(serialized);
}
export function optionalPresentationValue(name: string, value: AgentToolResult<unknown>): StoredValue | undefined {
	try {
		if (!isCodeModeToolContent(value.content)) return undefined;
		unwrapSuiteToolResult(name, value);
		return durableValue("The Tool presentation result", value);
	} catch {
		return undefined;
	}
}

function restoreValue(value: StoredValue | undefined): CodemodeValue {
	if (!value || value.kind === "undefined") return undefined;
	return value.json === null || !isRuntimeObject(value.json)
		? value.json
		: parseForStorage(JSON.stringify(value.json));
}

export function eventFrom(source: JsonSourceValue): LedgerEvent | undefined {
	const value = parseJsonValue(JSON.stringify(source));
	if (!isRuntimeObject(value) || value === null || !("kind" in value)) return undefined;
	const schema = LEDGER_EVENT_SCHEMA.anyOf.find((candidate) => candidate.properties.kind.const === value["kind"]);
	if (!schema) return undefined;
	// Preserve TypeBox's unsafe-key filtering without trying and cloning unrelated event kinds.
	const cleaned = Value.Clean(schema, Value.Clone(value));
	if (!Value.Check(schema, cleaned)) return undefined;
	// SAFETY: TypeBox validates every discriminated event member before the durable fold consumes it.
	return cleaned as LedgerEvent;
}

export function createLedgerSnapshot(): LedgerSnapshot {
	return { executions: new Map(), snippets: new Map(), totalExecutions: 0 };
}

function applyOpened(execution: ExecutionState, event: CallPendingEvent | CallStartedEvent): void {
	execution.attempt = Math.max(execution.attempt, event.attempt);
	execution.calls.set(event.sequence, {
		args: restoreValue(event.args),
		argsKey: event.argsKey,
		attempt: event.attempt,
		callId: event.callId,
		name: event.name,
		replay: event.replay,
		requiresApproval: event.kind === "call-pending" || event.requiresApproval === true,
		sequence: event.sequence,
		status: event.kind === "call-pending" ? "pending" : "running",
	});
	if (event.kind === "call-pending") execution.status = "paused";
	execution.toolCalls = Math.max(execution.toolCalls, event.sequence + 1);
}

function restoredToolResult(value: StoredValue | undefined): AgentToolResult<unknown> | undefined {
	const result = restoreValue(value);
	// SAFETY: the runtime object and complete Tool-content checks establish the AgentToolResult members consumed here.
	return isRuntimeObject(result) && result !== null && "content" in result && isCodeModeToolContent(result["content"])
		? (result as CodemodeValue & AgentToolResult<unknown>)
		: undefined;
}

function applySettled(call: CallState, event: CallSettledEvent): void {
	call.status = event.status;
	if (event.error) call.error = event.error;
	const result = restoredToolResult(event.result);
	if (result) call.result = result;
	if (event.value) {
		call.value = restoreValue(event.value);
		call.valuePresent = true;
	} else if (event.status === "success" && result) {
		try {
			call.value = unwrapSuiteToolResult(call.name, result);
			call.valuePresent = true;
		} catch {
			// A malformed historical presentation result remains diagnostic only.
		}
	}
	if (call.status === "success" && result && "isError" in result && result.isError === true) {
		call.status = "error";
		const text = result.content.find((item) => item.type === "text" && item.text.trim());
		call.error ??= text?.type === "text" ? text.text.trim() : `${call.name} failed`;
	}
}

export function applyEvent(state: LedgerSnapshot, event: LedgerEvent): void {
	if (event.kind === "execution-started") {
		if (!state.executions.has(event.executionId)) state.totalExecutions += 1;
		const execution: ExecutionState = {
			attempt: 0,
			calls: new Map(),
			code: event.code,
			createdAt: event.at,
			executionId: event.executionId,
			outerToolCallId: event.outerToolCallId,
			status: "running",
			toolCalls: 0,
			updatedAt: event.at,
		};
		if (event.cwd !== undefined) Object.assign(execution, { cwd: event.cwd });
		state.executions.set(event.executionId, execution);
		return;
	}
	if (event.kind === "execution-pruned") {
		state.executions.delete(event.executionId);
		return;
	}
	if (event.kind === "snippet-saved") {
		state.snippets.set(event.snippet.name, event.snippet);
		return;
	}
	if (event.kind === "snippet-deleted") {
		state.snippets.delete(event.name);
		return;
	}
	const execution = state.executions.get(event.executionId);
	if (!execution) return;
	execution.updatedAt = event.at;
	if (event.kind === "execution-resumed") {
		execution.attempt = event.attempt;
		execution.status = "running";
		delete execution.error;
		return;
	}
	if (event.kind === "execution-settled") {
		execution.attempt = event.attempt;
		execution.status = event.status;
		if (event.error) execution.error = event.error;
		else delete execution.error;
		return;
	}
	if (event.kind === "call-pending" || event.kind === "call-started") {
		applyOpened(execution, event);
		return;
	}
	const call = [...execution.calls.values()].find((candidate) => candidate.callId === event.callId);
	if (!call) return;
	if (event.kind === "call-compensated") {
		call.compensated = true;
		execution.status = "compensated";
		return;
	}
	applySettled(call, event);
}

export function trimTerminalExecutions(state: LedgerSnapshot): void {
	const terminal = [...state.executions.values()]
		.filter((execution) => !["running", "incomplete", "paused"].includes(execution.status))
		.sort((left, right) => right.updatedAt - left.updatedAt);
	for (const execution of terminal.slice(MAX_RETAINED_EXECUTIONS)) state.executions.delete(execution.executionId);
}

export function executionHistory(state: LedgerSnapshot): CodeModeExecutionHistoryItem[] {
	return [...state.executions.values()]
		.sort((left, right) => right.createdAt - left.createdAt)
		.map(({ calls, attempt: _attempt, cwd: _cwd, ...execution }) => ({
			...execution,
			tools: [...new Set([...calls.values()].map((call) => call.name))],
		}));
}
