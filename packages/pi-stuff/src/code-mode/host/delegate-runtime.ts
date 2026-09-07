import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import { type JsonInputValue, type JsonValue, parseJsonValue } from "../../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import { type CodemodeValue, parseForStorage, stringifyForStorage } from "../cloudflare/codec.ts";
import { SuiteToolInvocationError } from "../connector.ts";
import {
	type ExecutorContext,
	MAX_CONCURRENT_CODE_MODE_TOOL_CALLS,
	type RuntimeResponse,
	type RuntimeToolCallPlan,
	type RuntimeToolTrace,
	type SuiteSandboxTool,
} from "../protocol.ts";
import type { CodeModeEffectOwner, CodeModeEffectTask } from "./effect-owner.ts";
import type { DelegateRequestMessage, DelegateResponseMessage, HostResult } from "./host-protocol.ts";
import { CodeModeTraceStore } from "./trace-store.ts";

const MAX_NOTIFICATION_CHARS = 16_384;
const MAX_NOTIFICATIONS_PER_CELL = 100;

type SendMessage = (message: DelegateResponseMessage) => void;

interface PreparedDelegateToolCall {
	readonly cellId: string;
	readonly context: ExecutorContext;
	readonly hidden: boolean;
	readonly input: CodemodeValue;
	readonly messageId: number;
	readonly nestedContext: ExecutorContext;
	readonly plan: RuntimeToolCallPlan | undefined;
	readonly tool: SuiteSandboxTool;
	readonly trace: RuntimeToolTrace;
}

interface PreparedDelegateRequest {
	cancel(): void;
	readonly program: Effect.Effect<void, never, Scope.Scope>;
}

function resultFromValue(value: CodemodeValue): AgentToolResult<unknown> {
	if (isRuntimeObject(value) && value !== null && "content" in value && Array.isArray(value["content"])) {
		// SAFETY: the Tool-result boundary requires an object with an array content payload; optional fields stay opaque.
		return value as CodemodeValue & AgentToolResult<unknown>;
	}
	let text: string;
	try {
		text = isRuntimeString(value) ? value : (JSON.stringify(value) ?? String(value));
	} catch {
		try {
			text = String(value);
		} catch {
			text = "[unserializable value]";
		}
	}
	return {
		content: [{ type: "text", text }],
		details: {},
	};
}

function decodeTransportValue(value: JsonInputValue): CodemodeValue {
	const serialized = JSON.stringify(value);
	return serialized === undefined ? undefined : parseForStorage(serialized);
}

function encodeTransportValue(value: CodemodeValue): JsonValue | undefined {
	try {
		const serialized = stringifyForStorage(value);
		return serialized === undefined ? undefined : parseJsonValue(serialized);
	} catch (error) {
		throw new Error(
			`Failed to serialize nested Tool result: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

export class CodeModeDelegateRuntime {
	private readonly cellContexts = new Map<string, ExecutorContext>();
	private readonly cellScopes = new Map<string, CodeModeEffectTask>();
	private readonly cellTools = new Map<string, Map<string, SuiteSandboxTool>>();
	private readonly cleanupTasks = new Map<string, CodeModeEffectTask>();
	private readonly effects: CodeModeEffectOwner;
	private readonly notifications = new Map<string, string[]>();
	private readonly requests = new Map<number, CodeModeEffectTask>();
	private readonly send: SendMessage;
	private readonly traces = new CodeModeTraceStore();

	constructor(send: SendMessage, effects: CodeModeEffectOwner) {
		this.effects = effects;
		this.send = send;
	}

	bindCell(cellId: string, context: ExecutorContext, tools?: Map<string, SuiteSandboxTool>): void {
		this.ensureCellScope(cellId);
		this.cellContexts.set(cellId, context);
		if (tools) this.cellTools.set(cellId, tools);
	}

	updateCellContext(cellId: string, context: ExecutorContext): void {
		this.ensureCellScope(cellId);
		this.cellContexts.set(cellId, context);
	}

	closeCell(cellId: string): void {
		this.cellContexts.delete(cellId);
		this.cellTools.delete(cellId);
		this.cellScopes.get(cellId)?.interrupt();
		this.cellScopes.delete(cellId);
		this.cleanupTasks.get(cellId)?.interrupt();
		const cleanup = this.effects.open();
		this.cleanupTasks.set(cellId, cleanup);
		cleanup.run(
			Effect.sleep(1_000).pipe(
				Effect.andThen(
					Effect.sync(() => {
						this.notifications.delete(cellId);
						this.traces.delete(cellId);
					}),
				),
				Effect.ensuring(
					Effect.sync(() => {
						if (this.cleanupTasks.get(cellId) === cleanup) this.cleanupTasks.delete(cellId);
					}),
				),
			),
		);
	}

	cancel(id: number): void {
		const request = this.requests.get(id);
		this.requests.delete(id);
		request?.interrupt();
	}

	handleRequest(message: DelegateRequestMessage): void {
		if (this.requests.has(message.id)) throw new Error(`Duplicate Code Mode delegate request: ${String(message.id)}`);
		if (message.request.type === "tool/invoke" && this.requests.size >= MAX_CONCURRENT_CODE_MODE_TOOL_CALLS) {
			this.respond(message.id, {
				message: `Code Mode has ${String(MAX_CONCURRENT_CODE_MODE_TOOL_CALLS)} concurrent Tool calls; settle one before starting another.`,
				status: "error",
			});
			return;
		}
		const request = this.effects.open();
		this.requests.set(message.id, request);
		try {
			const prepared = this.prepareRequest(message);
			if (!prepared) {
				this.requests.delete(message.id);
				request.interrupt();
				return;
			}
			request.run(
				prepared.program.pipe(
					Effect.ensuring(
						Effect.sync(() => {
							if (this.requests.get(message.id) === request) this.requests.delete(message.id);
						}),
					),
				),
				prepared.cancel,
			);
		} catch (error) {
			this.requests.delete(message.id);
			request.interrupt();
			throw error;
		}
	}

	attach(response: RuntimeResponse): RuntimeResponse {
		this.cleanupTasks.get(response.cellId)?.interrupt();
		this.cleanupTasks.delete(response.cellId);
		const notifications = this.notifications.get(response.cellId) ?? [];
		this.notifications.delete(response.cellId);
		const traced = this.traces.attach(response);
		return notifications.length === 0
			? traced
			: {
					...traced,
					contentItems: [
						...notifications.map((text) => ({ type: "input_text" as const, text })),
						...traced.contentItems,
					],
				};
	}

	clear(): void {
		const requests = [...this.requests.values()];
		this.requests.clear();
		for (const request of requests) request.interrupt();
		for (const cell of this.cellScopes.values()) cell.interrupt();
		this.cellScopes.clear();
		this.cellContexts.clear();
		this.cellTools.clear();
		this.notifications.clear();
		this.traces.clear();
		for (const cleanup of this.cleanupTasks.values()) cleanup.interrupt();
		this.cleanupTasks.clear();
	}

	private prepareRequest(message: DelegateRequestMessage): PreparedDelegateRequest | undefined {
		const request = message.request;
		if (request.type === "notification/send") {
			this.handleNotification(message.id, request);
			return;
		}
		const invocation = request.invocation;
		const cellId = invocation.cell_id;
		const name = invocation.tool_name.name;
		const context = this.cellContexts.get(cellId);
		const tool = this.cellTools.get(cellId)?.get(name);
		if (!context || !tool) {
			this.respond(message.id, {
				message: !tool ? `Unknown Suite Tool: ${name}` : "Code Mode cell context is unavailable",
				status: "error",
			});
			return;
		}
		let input: CodemodeValue;
		let plan: RuntimeToolCallPlan | undefined;
		let trace: RuntimeToolTrace;
		const hidden = tool.presentation === "hidden";
		try {
			input = decodeTransportValue(invocation.input);
			plan = tool.ledger === "bypass" ? undefined : context.beginToolCall?.(name, input);
			trace = hidden
				? { id: plan?.id ?? invocation.runtime_tool_call_id, input, name, status: "running" }
				: this.traces.start(cellId, plan?.id ?? invocation.runtime_tool_call_id, name, input, plan);
		} catch (error) {
			let failure = normalizeError(error);
			if (plan && !plan.pause && !plan.replay) {
				const result = resultFromValue(failure.message);
				try {
					context.completeToolCall?.(plan, { message: failure.message, result, status: "error" });
				} catch (ledgerError) {
					failure = new Error(`${failure.message}; ledger update failed: ${normalizeError(ledgerError).message}`);
				}
			}
			this.respond(message.id, {
				message: failure.message,
				status: "error",
			});
			return;
		}
		const nestedContext: ExecutorContext = {
			...context,
			captureResult: (result) => {
				trace.result = result;
				if (!hidden) this.traces.emit(cellId, trace, context);
			},
			onUpdate: (result) => {
				trace.result = result;
				if (!hidden) this.traces.emit(cellId, trace, context);
			},
			toolCallId: trace.id,
		};
		if (!hidden) this.traces.emit(cellId, trace, context);
		if (plan?.pause) {
			trace.result = resultFromValue(plan.pause.message);
			trace.status = "pending";
			if (!hidden) this.traces.emit(cellId, trace, context);
			this.respond(message.id, { message: plan.pause.message, status: "error" });
			return;
		}
		if (plan?.replay) {
			trace.result =
				plan.replay.result ??
				resultFromValue(plan.replay.kind === "result" ? plan.replay.value : plan.replay.message);
			trace.status = plan.replay.kind === "result" ? "done" : "error";
			if (plan.replay.kind === "error") trace.error = plan.replay.message;
			if (!hidden) this.traces.emit(cellId, trace, context);
			this.respond(
				message.id,
				plan.replay.kind === "result"
					? { status: "ok", value: { result: encodeTransportValue(plan.replay.value), type: "tool/result" } }
					: { message: plan.replay.message, status: "error" },
			);
			return;
		}
		return this.invokeTool({
			cellId,
			context,
			hidden,
			input,
			messageId: message.id,
			nestedContext,
			plan,
			tool,
			trace,
		});
	}

	private invokeTool(call: PreparedDelegateToolCall): PreparedDelegateRequest {
		let finished = false;
		let settlementAttempted = false;
		let toolReturned = false;
		let operationSignal: AbortSignal | undefined;
		const settleFailure = (cause: unknown, cancelled: boolean): void => {
			if (finished) return;
			finished = true;
			const error = normalizeError(cause);
			if (error instanceof SuiteToolInvocationError) call.trace.result = error.result;
			call.trace.result ??= resultFromValue(error.message);
			call.trace.status = cancelled ? "cancelled" : "error";
			call.trace.error = error.message;
			if (call.plan && !settlementAttempted) {
				settlementAttempted = true;
				try {
					call.context.completeToolCall?.(call.plan, {
						message: call.trace.error,
						result: call.trace.result,
						status: toolReturned ? "incomplete" : "error",
					});
				} catch (ledgerError) {
					call.trace.error = `${call.trace.error}; ledger update failed: ${
						ledgerError instanceof Error ? ledgerError.message : String(ledgerError)
					}`;
				}
			}
			if (!call.hidden) this.traces.emit(call.cellId, call.trace, call.context);
			this.respond(call.messageId, { message: call.trace.error, status: "error" });
		};
		const cancel = (): void => {
			settleFailure(operationSignal?.reason ?? new DOMException("This operation was aborted", "AbortError"), true);
		};
		const program = Effect.tryPromise({
			try: (signal) => {
				operationSignal = signal;
				return call.tool.invoke(call.input, call.nestedContext, signal);
			},
			catch: normalizeError,
		}).pipe(
			Effect.flatMap((value) =>
				Effect.try({
					try: () => {
						toolReturned = true;
						const transportValue = encodeTransportValue(value);
						call.trace.result ??= resultFromValue(value);
						call.trace.status = "done";
						if (call.plan) {
							settlementAttempted = true;
							call.context.completeToolCall?.(call.plan, {
								result: call.trace.result,
								status: "success",
								value,
							});
						}
						const serializationError = this.respond(call.messageId, {
							status: "ok",
							value: { result: transportValue, type: "tool/result" },
						});
						if (serializationError) {
							call.trace.status = "error";
							call.trace.error = serializationError.message;
						}
						if (!call.hidden) this.traces.emit(call.cellId, call.trace, call.context);
						finished = true;
					},
					catch: normalizeError,
				}),
			),
			Effect.catch((error) => Effect.sync(() => settleFailure(error, false))),
			Effect.onInterrupt(() => Effect.sync(cancel)),
		);
		return { cancel, program };
	}

	private ensureCellScope(cellId: string): void {
		if (!this.cellScopes.has(cellId)) this.cellScopes.set(cellId, this.effects.open());
	}

	private handleNotification(
		id: number,
		request: Extract<DelegateRequestMessage["request"], { type: "notification/send" }>,
	): void {
		if (!this.cellContexts.has(request.cellId)) {
			this.respond(id, { message: "Code Mode notification cell is unavailable", status: "error" });
			return;
		}
		const notifications = this.notifications.get(request.cellId) ?? [];
		notifications.push(request.text.slice(0, MAX_NOTIFICATION_CHARS));
		if (notifications.length > MAX_NOTIFICATIONS_PER_CELL) {
			notifications.splice(0, notifications.length - MAX_NOTIFICATIONS_PER_CELL);
		}
		this.notifications.set(request.cellId, notifications);
		this.respond(id, { status: "ok", value: { type: "notification/delivered" } });
	}

	private respond(id: number, result: HostResult): Error | undefined {
		try {
			this.send({ id, result, type: "delegate/response" });
			return undefined;
		} catch (error) {
			const failure = new Error(
				`Failed to serialize nested Tool result: ${error instanceof Error ? error.message : String(error)}`,
			);
			try {
				this.send({
					id,
					result: { message: failure.message, status: "error" },
					type: "delegate/response",
				});
			} catch {
				// Host teardown rejects the owning operation.
			}
			return failure;
		}
	}
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
