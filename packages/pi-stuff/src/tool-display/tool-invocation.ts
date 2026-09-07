import { validateToolArguments } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import { isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolArguments } from "./activity.ts";
import type { SuiteToolInvocation, SuiteToolInvocationResult } from "./contract.ts";
import { isRecordValue, isToolArguments } from "./tool-value.ts";

interface CapturedToolHandlerResult {
	readonly block?: boolean;
	readonly content?: AgentToolResult<unknown>["content"];
	readonly details?: unknown;
	readonly isError?: boolean;
	readonly reason?: string;
	readonly terminate?: boolean;
	readonly usage?: AgentToolResult<unknown>["usage"];
}

interface CapturedToolEvent {
	readonly args?: unknown;
	content?: AgentToolResult<unknown>["content"];
	details?: unknown;
	readonly input?: unknown;
	isError?: boolean;
	readonly partialResult?: AgentToolResult<unknown>;
	readonly result?: AgentToolResult<unknown>;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly type: string;
	usage?: AgentToolResult<unknown>["usage"];
}

export type CapturedToolHandler = (
	event: CapturedToolEvent,
	context: ExtensionContext,
) => CapturedToolHandlerResult | undefined | Promise<CapturedToolHandlerResult | undefined>;

const CAPTURED_TOOL_EVENTS = new Set([
	"tool_call",
	"tool_result",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);
const TOOL_CONTROL_OPEN = "<system-reminder>";
const TOOL_CONTROL_CLOSE = "</system-reminder>";

function errorToolResult(cause: unknown): AgentToolResult<unknown> {
	return {
		content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
		details: {},
	};
}

function stripToolControlText(text: string): string {
	if (!text.includes(TOOL_CONTROL_OPEN)) return text;
	let depth = 0;
	let index = 0;
	let stripped = "";
	let removed = false;
	while (index < text.length) {
		if (text.startsWith(TOOL_CONTROL_OPEN, index)) {
			depth += 1;
			removed = true;
			index += TOOL_CONTROL_OPEN.length;
			continue;
		}
		if (text.startsWith(TOOL_CONTROL_CLOSE, index) && depth > 0) {
			depth -= 1;
			index += TOOL_CONTROL_CLOSE.length;
			continue;
		}
		if (depth === 0) stripped += text[index] ?? "";
		index += 1;
	}
	if (!removed || depth !== 0) return text;
	return stripped.trimEnd();
}

export function stripToolControlMetadata<TDetails>(result: AgentToolResult<TDetails>): AgentToolResult<TDetails> {
	let changed = false;
	const content: AgentToolResult<TDetails>["content"] = [];
	for (const item of result.content) {
		if (item.type !== "text") {
			content.push(item);
			continue;
		}
		const text = stripToolControlText(item.text);
		if (text === item.text) {
			content.push(item);
			continue;
		}
		changed = true;
		if (text) content.push({ ...item, text });
	}
	return changed ? { ...result, content } : result;
}

interface ToolExecutionOutcome {
	readonly isError: boolean;
	readonly result: AgentToolResult<unknown>;
}

type ToolUpdateMessage =
	| { readonly result: AgentToolResult<unknown>; readonly type: "update" }
	| { readonly type: "finish" };

/** Own the complete nested Tool lifecycle used by Code Mode envelopes. */
export class SuiteToolInvocationRuntime {
	private readonly capturedHandlers = new Map<string, CapturedToolHandler[]>();
	private readonly getActiveTools: () => readonly string[];
	private readonly isActive: (name: string) => boolean;
	private readonly tools: ReadonlyMap<string, ToolDefinition>;

	constructor(
		tools: ReadonlyMap<string, ToolDefinition>,
		isActive: (name: string) => boolean,
		getActiveTools: () => readonly string[],
	) {
		this.tools = tools;
		this.isActive = isActive;
		this.getActiveTools = getActiveTools;
	}

	capture(event: string, handler: CapturedToolHandler): void {
		if (!CAPTURED_TOOL_EVENTS.has(event)) return;
		const handlers = this.capturedHandlers.get(event) ?? [];
		handlers.push(handler);
		this.capturedHandlers.set(event, handlers);
	}

	invoke(invocation: SuiteToolInvocation): Effect.Effect<SuiteToolInvocationResult, Error, Scope.Scope> {
		const tool = this.tools.get(invocation.name);
		if (!tool) return Effect.fail(new Error(`Unknown Suite Tool: ${invocation.name}`));
		if (!this.isActive(invocation.name)) {
			return Effect.fail(new Error(`Suite Tool is inactive: ${invocation.name}`));
		}
		return Effect.gen({ self: this }, function* () {
			yield* this.dispatchInformational(
				"tool_execution_start",
				{
					args: invocation.input,
					toolCallId: invocation.toolCallId,
					toolName: invocation.name,
					type: "tool_execution_start",
				},
				invocation.context,
			);

			const prepared = yield* Effect.try({
				try: () => this.prepare(tool, invocation),
				catch: normalizeError,
			}).pipe(
				Effect.map((value) => ({ ok: true as const, value })),
				Effect.catch((error) => Effect.succeed({ error, ok: false as const })),
			);
			if (!prepared.ok) return yield* this.fail(invocation, prepared.error);
			const blocked = yield* this.beforeExecution(invocation, prepared.value);
			if (blocked) return blocked;

			const executed = yield* this.execute(tool, invocation, prepared.value);
			const projected = yield* this.projectResult(invocation, prepared.value, executed);
			return yield* this.finish(invocation, projected.result, projected.isError);
		});
	}

	private prepare(tool: ToolDefinition, invocation: SuiteToolInvocation): ToolArguments {
		const rawArguments = tool.prepareArguments ? tool.prepareArguments(invocation.input) : invocation.input;
		// SAFETY: the registry erases each Tool's schema, while validation immediately below restores its runtime contract.
		const validated = validateToolArguments(
			tool as never,
			// SAFETY: the call record matches Pi's ToolCall shape and is consumed only by the selected Tool's schema validator.
			{
				arguments: rawArguments,
				id: invocation.toolCallId,
				name: invocation.name,
				type: "toolCall",
			} as never,
		);
		if (!isToolArguments(validated)) {
			throw new Error(`Suite Tool ${invocation.name} requires object arguments`);
		}
		return validated;
	}

	private beforeExecution(
		invocation: SuiteToolInvocation,
		prepared: ToolArguments,
	): Effect.Effect<SuiteToolInvocationResult | undefined> {
		return Effect.gen({ self: this }, function* () {
			const event: CapturedToolEvent = {
				input: prepared,
				toolCallId: invocation.toolCallId,
				toolName: invocation.name,
				type: "tool_call",
			};
			for (const handler of this.capturedHandlers.get("tool_call") ?? []) {
				const handled = yield* this.callHandler(handler, event, invocation.context).pipe(
					Effect.map((value) => ({ ok: true as const, value })),
					Effect.catch((error) => Effect.succeed({ error, ok: false as const })),
				);
				if (!handled.ok) return yield* this.fail(invocation, handled.error);
				const decision = handled.value;
				if (!isRecordValue(decision) || decision["block"] !== true) continue;
				return yield* this.fail(
					invocation,
					isRuntimeString(decision["reason"]) ? decision["reason"] : "Tool execution was blocked",
					decision["terminate"] === true,
				);
			}
			return invocation.signal?.aborted ? yield* this.fail(invocation, "Operation aborted") : undefined;
		});
	}

	private execute(
		tool: ToolDefinition,
		invocation: SuiteToolInvocation,
		prepared: ToolArguments,
	): Effect.Effect<ToolExecutionOutcome, never, Scope.Scope> {
		return Effect.gen({ self: this }, function* () {
			const updates = yield* Queue.unbounded<ToolUpdateMessage>();
			let activeUpdate = false;
			let finishing = false;
			let pendingUpdate: AgentToolResult<unknown> | undefined;
			let acceptingUpdates = true;
			const worker = yield* Effect.forkScoped(
				Effect.gen({ self: this }, function* () {
					while (true) {
						const message = yield* Queue.take(updates);
						if (message.type === "finish") return;
						yield* this.dispatchInformational(
							"tool_execution_update",
							{
								args: prepared,
								partialResult: message.result,
								toolCallId: invocation.toolCallId,
								toolName: invocation.name,
								type: "tool_execution_update",
							},
							invocation.context,
						);
						const next = pendingUpdate;
						pendingUpdate = undefined;
						if (next) Queue.offerUnsafe(updates, { result: next, type: "update" });
						else {
							activeUpdate = false;
							if (finishing) Queue.offerUnsafe(updates, { type: "finish" });
						}
					}
				}),
			);
			const activeBefore = this.getActiveTools();
			const executed = yield* Effect.tryPromise({
				// SAFETY: validation above produced the argument type owned by this registry-selected Tool definition.
				try: () =>
					tool.execute(
						invocation.toolCallId,
						prepared as never,
						invocation.signal,
						(partialResult) => {
							if (!acceptingUpdates) return;
							try {
								invocation.onUpdate?.(partialResult);
							} catch {
								// Rendering updates do not change nested Tool execution.
							}
							if (activeUpdate) {
								pendingUpdate = partialResult;
								return;
							}
							activeUpdate = true;
							Queue.offerUnsafe(updates, { result: partialResult, type: "update" });
						},
						invocation.context,
					),
				catch: normalizeError,
			}).pipe(
				Effect.map((result): ToolExecutionOutcome => ({ isError: false, result })),
				Effect.catch((error) => Effect.succeed({ isError: true, result: errorToolResult(error) })),
				Effect.onExit(() =>
					Effect.sync(() => {
						acceptingUpdates = false;
						finishing = true;
						if (!activeUpdate) Queue.offerUnsafe(updates, { type: "finish" });
					}),
				),
			);
			const activeAfter = executed.isError ? undefined : this.getActiveTools();
			yield* Fiber.join(worker);
			if (!activeAfter) return executed;
			if (!activeBefore.every((name) => activeAfter.includes(name))) return executed;
			const beforeNames = new Set(activeBefore);
			const addedToolNames = activeAfter.filter((name) => !beforeNames.has(name));
			if (addedToolNames.length === 0) return executed;
			return {
				...executed,
				result: {
					...executed.result,
					addedToolNames: [...new Set([...(executed.result.addedToolNames ?? []), ...addedToolNames])],
				},
			};
		});
	}

	private projectResult(
		invocation: SuiteToolInvocation,
		prepared: ToolArguments,
		executed: ToolExecutionOutcome,
	): Effect.Effect<ToolExecutionOutcome> {
		return Effect.gen({ self: this }, function* () {
			const event: CapturedToolEvent = {
				content: executed.result.content ?? [],
				details: executed.result.details,
				input: prepared,
				isError: executed.isError || ("isError" in executed.result && executed.result.isError === true),
				toolCallId: invocation.toolCallId,
				toolName: invocation.name,
				type: "tool_result",
			};
			if (executed.result.usage) event.usage = executed.result.usage;
			for (const handler of this.capturedHandlers.get("tool_result") ?? []) {
				const replacement = yield* Effect.catch(this.callHandler(handler, event, invocation.context), () =>
					Effect.succeed(undefined),
				);
				if (!isRecordValue(replacement)) continue;
				for (const key of ["content", "details", "isError", "usage"] as const) {
					if (replacement[key] !== undefined) {
						Object.defineProperty(event, key, {
							configurable: true,
							enumerable: true,
							value: replacement[key],
							writable: true,
						});
					}
				}
			}
			const result: AgentToolResult<unknown> = {
				...executed.result,
				content: event.content ?? [],
				details: event.details,
			};
			if (event.usage !== undefined) Object.assign(result, { usage: event.usage });
			if (event.isError === true) Object.assign(result, { isError: true });
			else Reflect.deleteProperty(result, "isError");
			return { isError: event.isError === true, result: stripToolControlMetadata(result) };
		});
	}

	private fail(
		invocation: SuiteToolInvocation,
		cause: unknown,
		terminate = false,
	): Effect.Effect<SuiteToolInvocationResult> {
		const result = errorToolResult(cause);
		if (terminate) Reflect.set(result, "terminate", true);
		return this.finish(invocation, result, true);
	}

	private finish(
		invocation: SuiteToolInvocation,
		result: AgentToolResult<unknown>,
		isError: boolean,
	): Effect.Effect<SuiteToolInvocationResult> {
		return this.dispatchInformational(
			"tool_execution_end",
			{
				isError,
				result,
				toolCallId: invocation.toolCallId,
				toolName: invocation.name,
				type: "tool_execution_end",
			},
			invocation.context,
		).pipe(Effect.andThen(Effect.succeed({ isError, result })));
	}

	private callHandler(
		handler: CapturedToolHandler,
		event: CapturedToolEvent,
		context: ExtensionContext,
	): Effect.Effect<CapturedToolHandlerResult | undefined, Error> {
		return Effect.tryPromise({
			try: () => Promise.resolve(handler.call(undefined, event, context)),
			catch: normalizeError,
		});
	}

	private dispatchInformational(
		event: "tool_execution_end" | "tool_execution_start" | "tool_execution_update",
		value: CapturedToolEvent,
		context: ExtensionContext,
	): Effect.Effect<void> {
		return Effect.gen({ self: this }, function* () {
			for (const handler of this.capturedHandlers.get(event) ?? []) {
				yield* Effect.catch(this.callHandler(handler, value, context), () => Effect.void);
			}
		});
	}
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
