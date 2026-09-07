import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { type JsonInputValue, parseJsonValue } from "../../shared/json-value.ts";
import type {
	CodeModeExecuteOptions,
	CodeModeWaitOptions,
	ExecutorContext,
	RuntimeResponse,
	SuiteSandboxTool,
} from "../protocol.ts";
import { CodeModeDelegateRuntime } from "./delegate-runtime.ts";
import type { CodeModeEffectOwner } from "./effect-owner.ts";
import {
	DEFAULT_EXEC_YIELD_MS,
	type DelegateResponseMessage,
	executionCellId,
	type HostMessage,
	MAX_OUTPUT_TOKENS,
	parseHostMessage,
	parseRuntimeResponse,
	runtimeOutcome,
	toWireToolDefinition,
} from "./host-protocol.ts";

const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_QUEUED_WRITE_BYTES = 128 * 1024 * 1024;
const SHUTDOWN_GRACE_MS = 250;
const STARTUP_TIMEOUT_MS = 10_000;

interface Pending {
	context?: ExecutorContext;
	resume(effect: Effect.Effect<JsonInputValue, Error>): void;
	tools?: Map<string, SuiteSandboxTool>;
}

interface HostOperationRequest {
	readonly cellId?: string;
	readonly method: "session/execute" | "session/open" | "session/shutdown" | "session/terminate" | "session/wait";
	readonly request?: object;
	readonly sessionId: string;
}

type HostOutboundMessage =
	| DelegateResponseMessage
	| { readonly id: number; readonly type: "operation/cancel" }
	| { readonly id: number; readonly request: HostOperationRequest; readonly type: "operation/request" }
	| {
			readonly optionalCapabilities: string[];
			readonly requiredCapabilities: string[];
			readonly supportedVersions: [1];
			readonly type: "connection/hello";
	  };

export class CodeModeHostLostError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "CodeModeHostLostError";
	}
}

export class CodeModeHostClient {
	private readonly binary: string;
	private buffer = Buffer.alloc(0);
	private readonly cancelled = new Set<number>();
	private child: ChildProcessWithoutNullStreams | undefined;
	private readonly delegateRuntime: CodeModeDelegateRuntime;
	private readonly initial = new Map<number, Pending>();
	private readonly pending = new Map<number, Pending>();
	private queuedWriteBytes = 0;
	private ready: Deferred.Deferred<void, Error> | undefined;
	private requestId = 0;
	private readonly sessionId = randomUUID();
	private stderr = "";
	private readonly startupTimeoutMs: number;

	constructor(binary: string, effects: CodeModeEffectOwner, startupTimeoutMs = STARTUP_TIMEOUT_MS) {
		this.binary = binary;
		this.delegateRuntime = new CodeModeDelegateRuntime((message) => this.send(message), effects);
		this.startupTimeoutMs = startupTimeoutMs;
	}

	start(): Effect.Effect<void, Error> {
		return Effect.suspend(() => {
			const current = this.ready;
			const ready = current ?? Deferred.makeUnsafe<void, Error>();
			const ownsStartup = current === undefined;
			if (ownsStartup) this.ready = ready;
			const startup = ownsStartup ? this.startProcess() : Deferred.await(ready);
			return startup.pipe(
				Effect.timeout(this.startupTimeoutMs),
				Effect.mapError((error) =>
					Cause.isTimeoutError(error)
						? new Error(`Code Mode host startup timed out after ${String(this.startupTimeoutMs)} ms`)
						: error,
				),
				Effect.onExit((exit) =>
					Effect.sync(() => {
						if (Exit.isSuccess(exit)) {
							if (ownsStartup) Deferred.doneUnsafe(ready, Effect.void);
							return;
						}
						const failure = Cause.hasInterruptsOnly(exit.cause)
							? codeModeAbortError()
							: normalizeError(Cause.squash(exit.cause));
						if (ownsStartup) Deferred.doneUnsafe(ready, Effect.fail(failure));
						this.failAll(failure);
					}),
				),
			);
		});
	}

	execute(options: CodeModeExecuteOptions): Effect.Effect<RuntimeResponse, Error> {
		let id: number | undefined;
		let cellId: string | undefined;
		let initialPending: Pending | undefined;
		return Effect.gen({ self: this }, function* () {
			yield* this.start();
			id = ++this.requestId;
			const initial = Deferred.makeUnsafe<JsonInputValue, Error>();
			initialPending = { resume: (effect) => Deferred.doneUnsafe(initial, effect) };
			this.initial.set(id, initialPending);
			const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
			cellId = executionCellId(
				yield* this.requestWithId(
					id,
					{
						method: "session/execute",
						request: {
							enabled_tools: options.tools.map(toWireToolDefinition),
							max_output_tokens: MAX_OUTPUT_TOKENS,
							source: options.source,
							tool_call_id: options.context.toolCallId ?? `codemode-${String(id)}`,
							yield_time_ms: DEFAULT_EXEC_YIELD_MS,
						},
						sessionId: this.sessionId,
					},
					options.context,
					tools,
				),
			);
			return this.delegateRuntime.attach(parseRuntimeResponse(yield* Deferred.await(initial)));
		}).pipe(
			Effect.tapError((error) =>
				Effect.sync(() => {
					if (id !== undefined) this.rejectOperation(id, error);
				}),
			),
			Effect.onInterrupt(() =>
				Effect.sync(() => {
					if (id !== undefined) this.cancelOperation(id, options.context, cellId);
				}),
			),
			Effect.ensuring(
				Effect.sync(() => {
					if (id !== undefined && this.initial.get(id) === initialPending) this.initial.delete(id);
				}),
			),
		);
	}

	wait(cellId: string, yieldTimeMs: number, options: CodeModeWaitOptions): Effect.Effect<RuntimeResponse, Error> {
		let id: number | undefined;
		return Effect.gen({ self: this }, function* () {
			yield* this.start();
			this.delegateRuntime.updateCellContext(cellId, options.context);
			id = ++this.requestId;
			const value = yield* this.requestWithId(
				id,
				{
					method: "session/wait",
					request: { cell_id: cellId, yield_time_ms: yieldTimeMs },
					sessionId: this.sessionId,
				},
				options.context,
			);
			const response = runtimeOutcome(value);
			if (!response) return yield* Effect.fail(new Error("Code Mode host returned an invalid wait outcome"));
			return this.delegateRuntime.attach(parseRuntimeResponse(response));
		}).pipe(
			Effect.onInterrupt(() =>
				Effect.sync(() => {
					if (id !== undefined) this.cancelOperation(id, options.context, cellId);
				}),
			),
		);
	}

	shutdown(): Effect.Effect<void> {
		return Effect.suspend(() => {
			const child = this.child;
			if (!child) return Effect.void;
			return this.request({ method: "session/shutdown", sessionId: this.sessionId }).pipe(
				Effect.timeoutOption(SHUTDOWN_GRACE_MS),
				Effect.catch(() => Effect.void),
				Effect.asVoid,
				Effect.ensuring(
					Effect.sync(() => {
						child.kill();
						this.failAll(new Error("Code Mode host shut down"));
					}),
				),
			);
		});
	}

	private cancelOperation(id: number, context: ExecutorContext, cellId?: string): void {
		const error = codeModeAbortError();
		try {
			this.send({ id, type: "operation/cancel" });
			if (!cellId) this.cancelled.add(id);
		} catch {
			// Host teardown is already authoritative.
		}
		this.rejectOperation(id, error);
		// The outer Pi Tool has no model-facing wait handle after cancellation.
		if (cellId) {
			try {
				this.terminate(cellId, context);
			} catch {
				// Host teardown is already authoritative.
			}
		}
	}

	private terminate(cellId: string, context?: ExecutorContext): void {
		if (context) this.delegateRuntime.updateCellContext(cellId, context);
		const id = ++this.requestId;
		const pending: Pending = { resume: () => undefined };
		this.pending.set(id, pending);
		try {
			this.send({
				id,
				request: { cellId, method: "session/terminate", sessionId: this.sessionId },
				type: "operation/request",
			});
		} catch (error) {
			if (this.pending.get(id) === pending) this.pending.delete(id);
			throw error;
		}
	}

	private startProcess(): Effect.Effect<void, Error> {
		return Effect.gen({ self: this }, function* () {
			const child = yield* Effect.try({
				try: () => spawn(this.binary, [], { shell: false, stdio: ["pipe", "pipe", "pipe"] }),
				catch: normalizeError,
			});
			this.child = child;
			this.buffer = Buffer.alloc(0);
			this.stderr = "";
			child.stdout.on("data", (chunk: Buffer) => {
				if (this.child === child) this.onData(chunk);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				if (this.child === child) this.stderr = (this.stderr + chunk.toString()).slice(-16_384);
			});
			child.on("error", (error) => {
				if (this.child === child)
					this.failAll(new CodeModeHostLostError(`Code Mode host failed: ${error.message}`, { cause: error }));
			});
			child.on("close", (code) => {
				if (this.child !== child) return;
				this.failAll(
					new CodeModeHostLostError(
						`Code Mode host exited with code ${code ?? "unknown"}${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`,
					),
				);
			});
			yield* Effect.callback<JsonInputValue, Error>((resume) => {
				const pending: Pending = { resume };
				this.pending.set(0, pending);
				try {
					this.send({
						optionalCapabilities: [],
						requiredCapabilities: [],
						supportedVersions: [1],
						type: "connection/hello",
					});
				} catch (error) {
					if (this.pending.get(0) === pending) this.pending.delete(0);
					resume(Effect.fail(normalizeError(error)));
				}
				return Effect.sync(() => {
					if (this.pending.get(0) === pending) this.pending.delete(0);
				});
			}).pipe(Effect.asVoid);
			yield* this.request({ method: "session/open", sessionId: this.sessionId });
		});
	}

	private request(request: HostOperationRequest, context?: ExecutorContext): Effect.Effect<JsonInputValue, Error> {
		return this.requestWithId(++this.requestId, request, context);
	}

	private requestWithId(
		id: number,
		request: HostOperationRequest,
		context?: ExecutorContext,
		tools?: Map<string, SuiteSandboxTool>,
	): Effect.Effect<JsonInputValue, Error> {
		return Effect.callback((resume) => {
			const pending: Pending = { resume };
			if (context) pending.context = context;
			if (tools) pending.tools = tools;
			this.pending.set(id, pending);
			try {
				this.send({ id, request, type: "operation/request" });
			} catch (error) {
				if (this.pending.get(id) === pending) this.pending.delete(id);
				resume(Effect.fail(normalizeError(error)));
			}
			return Effect.sync(() => {
				if (this.pending.get(id) === pending) this.pending.delete(id);
			});
		});
	}

	private rejectOperation(id: number, error: Error): void {
		const pending = this.pending.get(id);
		this.pending.delete(id);
		pending?.resume(Effect.fail(error));
		const initial = this.initial.get(id);
		this.initial.delete(id);
		initial?.resume(Effect.fail(error));
	}

	private send(message: HostOutboundMessage): void {
		const child = this.child;
		if (!child?.stdin.writable) throw new Error("Code Mode host is not running");
		const payload = Buffer.from(JSON.stringify(message));
		if (payload.length > MAX_FRAME_BYTES) throw new Error(`Code Mode frame exceeds ${String(MAX_FRAME_BYTES)} bytes`);
		const header = Buffer.allocUnsafe(4);
		header.writeUInt32LE(payload.length);
		const frame = Buffer.concat([header, payload]);
		if (this.queuedWriteBytes + frame.length > MAX_QUEUED_WRITE_BYTES) {
			throw new Error(`Code Mode write queue exceeds ${String(MAX_QUEUED_WRITE_BYTES)} bytes`);
		}
		this.queuedWriteBytes += frame.length;
		child.stdin.write(frame, (error) => {
			this.queuedWriteBytes = Math.max(0, this.queuedWriteBytes - frame.length);
			if (error && this.child === child) {
				this.failAll(new CodeModeHostLostError(`Code Mode host write failed: ${error.message}`, { cause: error }));
			}
		});
	}

	private onData(chunk: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, chunk]);
		while (this.buffer.length >= 4) {
			const length = this.buffer.readUInt32LE(0);
			if (length > MAX_FRAME_BYTES) {
				this.failAll(new Error(`Code Mode frame exceeds ${String(MAX_FRAME_BYTES)} bytes`));
				return;
			}
			if (this.buffer.length < length + 4) return;
			const payload = this.buffer.subarray(4, length + 4);
			this.buffer = this.buffer.subarray(length + 4);
			try {
				this.handleMessage(parseHostMessage(parseJsonValue(payload.toString("utf8"))));
			} catch (error) {
				this.failAll(error instanceof Error ? error : new Error(String(error)));
				return;
			}
		}
	}

	private handleMessage(message: HostMessage): void {
		if (message.type === "connection/ready") {
			const pending = this.pending.get(0);
			this.pending.delete(0);
			pending?.resume(Effect.succeed(undefined));
			return;
		}
		if (message.type === "connection/rejected") {
			const pending = this.pending.get(0);
			this.pending.delete(0);
			pending?.resume(Effect.fail(new Error(`Code Mode handshake rejected: ${JSON.stringify(message.reason)}`)));
			return;
		}
		if (message.type === "operation/response") {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			if (!pending) {
				if (this.cancelled.delete(message.id) && message.result.status === "ok") {
					const cellId = executionCellId(message.result.value);
					if (cellId) {
						try {
							this.terminate(cellId);
						} catch {
							// Host teardown is already authoritative.
						}
					}
				}
				return;
			}
			if (message.result.status === "error") {
				pending.resume(Effect.fail(new Error(message.result.message)));
				return;
			}
			const cellId = executionCellId(message.result.value);
			if (cellId && pending.context) this.delegateRuntime.bindCell(cellId, pending.context, pending.tools);
			pending.resume(Effect.succeed(message.result.value));
			return;
		}
		if (message.type === "execute/initialResponse") {
			const pending = this.initial.get(message.id);
			this.initial.delete(message.id);
			if (!pending) return;
			if (message.result.status === "error") pending.resume(Effect.fail(new Error(message.result.message)));
			else pending.resume(Effect.succeed(message.result.value));
			return;
		}
		if (message.type === "delegate/request") {
			this.delegateRuntime.handleRequest(message);
			return;
		}
		if (message.type === "delegate/cancel") {
			this.delegateRuntime.cancel(message.id);
			return;
		}
		this.delegateRuntime.closeCell(message.cellId);
	}

	private failAll(error: Error): void {
		for (const pending of [...this.pending.values(), ...this.initial.values()]) pending.resume(Effect.fail(error));
		this.cancelled.clear();
		this.pending.clear();
		this.initial.clear();
		this.delegateRuntime.clear();
		this.queuedWriteBytes = 0;
		const child = this.child;
		this.child = undefined;
		this.ready = undefined;
		if (child && !child.killed) child.kill();
	}
}

export function codeModeAbortError(): Error {
	const error = new Error("Code Mode operation aborted");
	error.name = "AbortError";
	return error;
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
