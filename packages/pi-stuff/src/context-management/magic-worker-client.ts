import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { Type } from "typebox";
import { HOST_SHUTDOWN_GRACE_MS } from "../lifecycle-deadline.ts";
import { type EffectFoundation, type EffectScopeOwner, installEffectFoundation } from "../shared/effect-foundation.ts";
import { type JsonInputValue, type JsonObject, parseJsonObject } from "../shared/json-value.ts";
import {
	applyMagicWorkerHostCompaction,
	applyMagicWorkerHostEffect,
	magicWorkerErrorMessage,
	magicWorkerHostTools,
	requiredHostCall,
	snapshotMagicWorkerContext,
	snapshotMagicWorkerEvent,
	writeMagicWorkerSyncResponse,
} from "./magic-worker-host.ts";
import type {
	MagicWorkerCommandName,
	MagicWorkerContextSnapshot,
	MagicWorkerEffectMessage,
	MagicWorkerEventName,
	MagicWorkerEventRequest,
	MagicWorkerEventResult,
	MagicWorkerInvocationRequest,
	MagicWorkerReadyMessage,
	MagicWorkerResultMessage,
	MagicWorkerSyncEffectMessage,
	MagicWorkerToolDescriptor,
	MagicWorkerToolName,
} from "./magic-worker-protocol.ts";
import { MagicWorkerTransport } from "./magic-worker-transport.ts";

interface MagicModule {
	readonly default: (pi: ExtensionAPI, onFatal?: MagicWorkerFatalHandler) => Promise<void> | void;
}

type MagicWorkerFatalHandler = (cause: unknown) => void;

const BRANCH_COMMANDS: ReadonlySet<MagicWorkerCommandName> = new Set([
	"ctx-recomp",
	"ctx-session-upgrade",
	"ctx-wrapup",
]);

class MagicWorkerClient {
	private readonly capability: EffectScopeOwner;
	private readonly contexts = new Map<string, ExtensionContext>();
	private readonly foundation: EffectFoundation;
	private nextId = 1;
	private readonly onFatal: MagicWorkerFatalHandler | undefined;
	private readonly pi: ExtensionAPI;
	private readonly sessionLeaves = new Map<string, string | undefined>();
	private readonly transport: MagicWorkerTransport;

	constructor(pi: ExtensionAPI, foundation: EffectFoundation, onFatal?: MagicWorkerFatalHandler) {
		this.pi = pi;
		this.foundation = foundation;
		this.onFatal = onFatal;
		const session = foundation.currentSession();
		if (!session) throw new Error("Magic Context worker is unavailable before Session start.");
		this.capability = foundation.forkCapability(session);
		this.transport = new MagicWorkerTransport({
			onEffect: (message) => this.applyEffect(message),
			onFatal: (error) => this.reportFatal(error),
			onSyncEffect: (message) => this.applySyncEffect(message),
		});
	}

	async initialize(): Promise<MagicWorkerReadyMessage> {
		const exit = await this.foundation.run(
			this.capability,
			this.transport.initialize(this.nextRequestId(), magicWorkerHostTools(this.pi)),
		);
		if (Exit.isSuccess(exit)) return exit.value;
		await this.close(exit);
		if (Cause.hasInterruptsOnly(exit.cause)) {
			throw new Error("Magic Context worker initialization was cancelled.");
		}
		throw Cause.squash(exit.cause);
	}

	register(ready: MagicWorkerReadyMessage): void {
		for (const name of ready.events) this.registerEvent(name);
		for (const descriptor of ready.tools) this.registerTool(descriptor);
		for (const command of ready.commands) {
			const handler = async (args: string, ctx: ExtensionContext): Promise<void> => {
				await this.invokeCommand(command.name, args, ctx);
			};
			this.pi.registerCommand(
				command.name,
				command.description ? { description: command.description, handler } : { handler },
			);
		}
	}

	private registerEvent(name: MagicWorkerEventName): void {
		switch (name) {
			case "agent_end":
				this.pi.on("agent_end", (event, ctx) => this.invokeVoidEvent(event, ctx));
				break;
			case "before_agent_start":
				this.pi.on("before_agent_start", async (event, ctx) => {
					const reply = await this.invokeEvent(event, ctx);
					if (reply.event !== "before_agent_start") throw this.unexpectedEventReply(event.type, reply.event);
					return reply.result;
				});
				break;
			case "context":
				this.pi.on("context", async (event, ctx) => {
					const reply = await this.invokeEvent(event, ctx);
					if (reply.event !== "context") throw this.unexpectedEventReply(event.type, reply.event);
					return reply.result;
				});
				break;
			case "message_end":
				this.pi.on("message_end", async (event, ctx) => {
					const reply = await this.invokeEvent(event, ctx);
					if (reply.event !== "message_end") throw this.unexpectedEventReply(event.type, reply.event);
					return reply.result;
				});
				break;
			case "session_before_compact":
				this.pi.on("session_before_compact", async (event, ctx) => {
					const reply = await this.invokeEvent(event, ctx);
					if (reply.event !== "session_before_compact") throw this.unexpectedEventReply(event.type, reply.event);
					return reply.result;
				});
				break;
			case "session_before_switch":
				this.pi.on("session_before_switch", async (event, ctx) => {
					const reply = await this.invokeEvent(event, ctx);
					if (reply.event !== "session_before_switch") throw this.unexpectedEventReply(event.type, reply.event);
					return reply.result;
				});
				break;
			case "session_compact":
				this.pi.on("session_compact", (event, ctx) => this.invokeVoidEvent(event, ctx));
				break;
			case "session_shutdown":
				this.pi.on("session_shutdown", async (event, ctx) => {
					if (this.isClosed()) return;
					try {
						await this.invokeVoidEvent(event, ctx);
					} finally {
						await this.close();
					}
				});
				break;
			case "session_start":
				this.pi.on("session_start", (event, ctx) => this.invokeVoidEvent(event, ctx));
				break;
			case "tool_execution_end":
				this.pi.on("tool_execution_end", (event, ctx) => this.invokeVoidEvent(event, ctx));
				break;
			case "tool_execution_start":
				this.pi.on("tool_execution_start", (event, ctx) => this.invokeVoidEvent(event, ctx));
				break;
			case "tool_result":
				this.pi.on("tool_result", async (event, ctx) => {
					const reply = await this.invokeEvent(event, ctx);
					if (reply.event !== "tool_result") throw this.unexpectedEventReply(event.type, reply.event);
					return reply.result;
				});
		}
	}

	private registerTool(descriptor: MagicWorkerToolDescriptor): void {
		const parameters = Type.Object({}, { ...descriptor.parameters });
		const tool: ToolDefinition<typeof parameters, JsonInputValue | undefined> = {
			description: descriptor.description,
			label: descriptor.label,
			name: descriptor.name,
			parameters,
			execute: (toolCallId, args, signal, onUpdate, ctx) =>
				this.invokeTool(descriptor.name, toolCallId, parseJsonObject(JSON.stringify(args)), ctx, signal, onUpdate),
		};
		if (descriptor.constrainedSampling !== undefined) tool.constrainedSampling = descriptor.constrainedSampling;
		if (descriptor.executionMode !== undefined) tool.executionMode = descriptor.executionMode;
		if (descriptor.promptGuidelines !== undefined) tool.promptGuidelines = [...descriptor.promptGuidelines];
		if (descriptor.promptSnippet !== undefined) tool.promptSnippet = descriptor.promptSnippet;
		if (descriptor.renderShell !== undefined) tool.renderShell = descriptor.renderShell;
		this.pi.registerTool(tool);
	}

	private async invokeEvent(event: ExtensionEvent, ctx: ExtensionContext): Promise<MagicWorkerEventResult> {
		const input = snapshotMagicWorkerEvent(event);
		let sessionId: string | undefined;
		try {
			const reply = await this.invoke(
				() => {
					const readContextUsage = magicEventReadsContextUsage(event);
					const context = this.synchronizeSession(ctx, event.type === "session_start", readContextUsage);
					sessionId = context.session.id;
					return {
						...input,
						context,
						id: this.nextRequestId(),
					} satisfies MagicWorkerEventRequest;
				},
				ctx,
				event.type === "session_before_compact" ? event.signal : undefined,
			);
			if (reply.type !== "event-result") {
				throw new Error(`Magic Context worker returned '${reply.type}' for event '${event.type}'.`);
			}
			if (event.type === "message_end") this.refreshPersistedEntry(ctx, sessionId);
			return reply.result;
		} finally {
			if (event.type === "session_before_switch" && sessionId) {
				this.sessionLeaves.delete(sessionId);
				if (this.contexts.get(sessionId) === ctx) this.contexts.delete(sessionId);
			}
		}
	}

	private async invokeVoidEvent(event: ExtensionEvent, ctx: ExtensionContext): Promise<void> {
		const reply = await this.invokeEvent(event, ctx);
		if (reply.event !== event.type) throw this.unexpectedEventReply(event.type, reply.event);
	}

	private unexpectedEventReply(expected: ExtensionEvent["type"], actual: MagicWorkerEventName): Error {
		return new Error(`Magic Context worker returned event '${actual}' for '${expected}'.`);
	}

	private async invokeCommand(name: MagicWorkerCommandName, args: string, ctx: ExtensionContext): Promise<void> {
		// The pinned official package reads the command context signal only in ctx-aug.
		const signal = name === "ctx-aug" ? ctx.signal : undefined;
		const reply = await this.invoke(
			() => ({
				args,
				context: this.synchronizeSession(ctx, BRANCH_COMMANDS.has(name)),
				id: this.nextRequestId(),
				name,
				type: "command",
			}),
			ctx,
			signal,
		);
		if (reply.type !== "command-result") {
			throw new Error(`Magic Context worker returned '${reply.type}' for command '${name}'.`);
		}
	}

	private refreshPersistedEntry(ctx: ExtensionContext, expectedSessionId: string | undefined): void {
		if (!expectedSessionId) return;
		setImmediate(() => {
			if (this.isClosed()) return;
			try {
				if (this.activeContext(expectedSessionId) !== ctx) return;
				this.synchronizeSession(ctx, false, false);
			} catch {
				// Pi may switch or close the Session before this post-persistence refresh runs.
			}
		});
	}

	private synchronizeSession(
		ctx: ExtensionContext,
		forceSnapshot = false,
		readContextUsage = true,
	): MagicWorkerContextSnapshot {
		const snapshot = snapshotMagicWorkerContext(ctx, readContextUsage);
		const sessionId = snapshot.session.id;
		if (!sessionId) return snapshot;
		const leafId = snapshot.session.leafId;
		const previousLeafId = this.sessionLeaves.get(sessionId);
		if (!forceSnapshot && this.sessionLeaves.has(sessionId) && leafId === previousLeafId) return snapshot;
		if (!forceSnapshot && this.sessionLeaves.has(sessionId) && leafId) {
			const entry = requiredHostCall("Session leaf entry", () => ctx.sessionManager.getEntry(leafId));
			if (entry && (entry.parentId ?? undefined) === previousLeafId) {
				this.transport.post({ entry, leafId, sessionId, type: "session-entry" });
				this.sessionLeaves.set(sessionId, leafId);
				return snapshot;
			}
		}
		const branch = requiredHostCall("Session branch", () => ctx.sessionManager.getBranch());
		this.transport.post({ branch: [...branch], leafId, sessionId, type: "session-snapshot" });
		this.sessionLeaves.set(sessionId, leafId);
		return snapshot;
	}

	private async invokeTool(
		name: MagicWorkerToolName,
		toolCallId: string,
		args: JsonObject,
		ctx: ExtensionContext,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<JsonInputValue | undefined> | undefined,
	): Promise<AgentToolResult<JsonInputValue | undefined>> {
		const reply = await this.invoke(
			() => ({
				args,
				context: this.synchronizeSession(ctx),
				id: this.nextRequestId(),
				name,
				toolCallId,
				type: "tool",
			}),
			ctx,
			signal,
			onUpdate,
		);
		if (reply.type !== "tool-result") {
			throw new Error(`Magic Context worker returned '${reply.type}' for Tool '${name}'.`);
		}
		return reply.result;
	}

	private async invoke(
		createRequest: () => MagicWorkerInvocationRequest,
		ctx: ExtensionContext,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<JsonInputValue | undefined>,
	): Promise<MagicWorkerResultMessage> {
		if (this.isClosed()) throw new Error("Magic Context worker is closed.");
		signal?.throwIfAborted();
		const session = this.foundation.sessionFor(ctx.sessionManager);
		if (!session || !this.foundation.isCurrent(session) || session.generation !== this.capability.generation) {
			throw new Error("Magic Context worker request was cancelled.");
		}
		const operation = this.foundation.forkOperation(this.capability);
		const program = Effect.try({
			try: () => {
				const request = createRequest();
				const sessionId = request.context.session.id;
				if (sessionId) this.contexts.set(sessionId, ctx);
				return request;
			},
			catch: (cause) => (cause instanceof Error ? cause : new Error(magicWorkerErrorMessage(cause))),
		}).pipe(Effect.flatMap((request) => this.transport.request(request, onUpdate)));
		const exit = await this.foundation.run(operation, program, { signal });
		await this.foundation.close(operation, exit);
		if (signal?.aborted) throw signal.reason;
		if (Exit.isFailure(exit)) {
			if (Cause.hasInterruptsOnly(exit.cause)) throw new Error("Magic Context worker request was cancelled.");
			throw Cause.squash(exit.cause);
		}
		if (exit.value.type === "ready") {
			throw new Error("Magic Context worker returned an initialization reply for an invocation.");
		}
		return exit.value;
	}

	private nextRequestId(): number {
		return this.nextId++;
	}

	private activeContext(sessionId: string): ExtensionContext | undefined {
		if (!this.foundation.isCurrent(this.capability)) return;
		const ctx = this.contexts.get(sessionId);
		if (!ctx || ctx.sessionManager.getSessionId() !== sessionId) return;
		const session = this.foundation.sessionFor(ctx.sessionManager);
		return session?.generation === this.capability.generation && this.foundation.isCurrent(session) ? ctx : undefined;
	}

	private applyEffect(message: MagicWorkerEffectMessage): void {
		const ctx = message.sessionId ? this.activeContext(message.sessionId) : undefined;
		const exit = Effect.runSyncExit(
			applyMagicWorkerHostEffect(this.pi, ctx, message, (active) => this.synchronizeSession(active, false, false)),
		);
		if (Exit.isFailure(exit)) this.reportFatal(Cause.squash(exit.cause));
	}

	private applySyncEffect(message: MagicWorkerSyncEffectMessage): void {
		const ctx = message.sessionId ? this.activeContext(message.sessionId) : undefined;
		const exit = Effect.runSyncExit(
			applyMagicWorkerHostCompaction(ctx, message, (active) => this.synchronizeSession(active, false, false)),
		);
		const status = Exit.isSuccess(exit) ? 1 : 2;
		const text = Exit.isSuccess(exit) ? exit.value : magicWorkerErrorMessage(Cause.squash(exit.cause));
		writeMagicWorkerSyncResponse(message.buffer, status, text);
	}

	private reportFatal(cause: unknown): void {
		const error = cause instanceof Error ? cause : new Error(magicWorkerErrorMessage(cause));
		void this.close(Exit.fail(error));
		this.onFatal?.(error);
	}

	private isClosed(): boolean {
		return !this.transport.isActive() || !this.foundation.isCurrent(this.capability);
	}

	async close(exit: Exit.Exit<unknown, unknown> = Exit.void): Promise<void> {
		await this.foundation.close(this.capability, exit, HOST_SHUTDOWN_GRACE_MS);
		this.contexts.clear();
		this.sessionLeaves.clear();
	}
}

function magicEventReadsContextUsage(event: ExtensionEvent): boolean {
	// Pi Stuff suppresses upstream Tool-time Statusline output. The pinned
	// Tool lifecycle and result handlers otherwise use Session metadata, while a Tool-use
	// message already carries Assistant usage and is followed by Context refresh.
	return (
		event.type !== "tool_execution_start" &&
		event.type !== "tool_execution_end" &&
		event.type !== "tool_result" &&
		!(event.type === "message_end" && event.message.role === "assistant" && event.message.stopReason === "toolUse")
	);
}

export async function magicContextWorkerFactory(pi: ExtensionAPI, onFatal?: MagicWorkerFatalHandler): Promise<void> {
	const client = new MagicWorkerClient(pi, installEffectFoundation(pi), onFatal);
	try {
		const ready = await client.initialize();
		client.register(ready);
	} catch (error) {
		await client.close(Exit.fail(error));
		throw error;
	}
}

export async function loadMagicContextWorker(): Promise<MagicModule> {
	return { default: magicContextWorkerFactory };
}
