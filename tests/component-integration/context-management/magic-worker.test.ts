import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, UserMessage } from "@earendil-works/pi-ai";
import type {
	AgentEndEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionEvent,
	MessageEndEvent,
	SessionBeforeCompactEvent,
	SessionBeforeSwitchEvent,
	SessionEntry,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolDefinition,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { buildSessionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { TSchema } from "typebox";
import type {
	MagicContextEventMap,
	MagicContextEventName,
} from "../../../packages/pi-stuff/src/context-management/magic-context-types.js";
import type { MagicModule } from "../../../packages/pi-stuff/src/context-management/magic-runtime.js";
import { magicContextWorkerFactory } from "../../../packages/pi-stuff/src/context-management/magic-worker-client.js";
import { MagicWorkerContextStore } from "../../../packages/pi-stuff/src/context-management/magic-worker-context.js";
import {
	applyMagicWorkerHostCompaction,
	applyMagicWorkerHostEffect,
	snapshotMagicWorkerEvent,
	writeMagicWorkerSyncResponse,
} from "../../../packages/pi-stuff/src/context-management/magic-worker-host.js";
import {
	MAGIC_WORKER_SYNC_BUFFER_BYTES,
	type MagicWorkerEffectMessage,
	type MagicWorkerInvocationRequest,
	type MagicWorkerSyncEffectMessage,
} from "../../../packages/pi-stuff/src/context-management/magic-worker-protocol.js";
import { installEffectFoundation } from "../../../packages/pi-stuff/src/shared/effect-foundation.js";
import { captureExtensionHandlers, createExtensionApi } from "../../fixtures/extension-api.js";
import { createExtensionCommandContext, createExtensionContext } from "../../fixtures/extension-context.js";

const MODEL: Model<Api> = {
	api: "openai-completions",
	baseUrl: "http://127.0.0.1.invalid",
	contextWindow: 128_000,
	cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
	id: "fixture-model",
	input: ["text"],
	maxTokens: 4_096,
	name: "Fixture",
	provider: "fixture",
	reasoning: false,
};

const ZERO_USAGE = {
	cacheRead: 0,
	cacheWrite: 0,
	cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
	input: 0,
	output: 0,
	totalTokens: 0,
};

type WorkerHandler = (
	event: ExtensionEvent,
	ctx: ExtensionContext,
) =>
	| MagicContextEventMap[MagicContextEventName]["result"]
	| Promise<MagicContextEventMap[MagicContextEventName]["result"]>;

interface WorkerHarnessState {
	branchReads: number;
	contextUsageReads: number;
	entryReads: number;
	currentBranch: SessionEntry[];
	currentLeafId: string | null;
}

function requireHandler(handlers: Map<string, WorkerHandler[]>, name: string): WorkerHandler {
	const handler = handlers.get(name)?.at(-1);
	if (!handler) throw new Error(`Magic Context did not register '${name}'.`);
	return handler;
}

function assistantMessage(text: string): AssistantMessage {
	return {
		api: MODEL.api,
		content: [{ text, type: "text" }],
		model: MODEL.id,
		provider: MODEL.provider,
		role: "assistant",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: ZERO_USAGE,
	};
}

function userMessage(text: string): UserMessage {
	return { content: [{ text, type: "text" }], role: "user", timestamp: Date.now() };
}

function messageEntry(id: string, message: AssistantMessage | UserMessage, parentId: string | null): SessionEntry {
	return { id, message, parentId, timestamp: new Date().toISOString(), type: "message" };
}

function beforeCompactEvent(
	firstKeptEntryId = "worker-entry",
	signal = new AbortController().signal,
): SessionBeforeCompactEvent {
	return {
		branchEntries: [],
		preparation: {
			fileOps: { edited: new Set(), read: new Set(), written: new Set() },
			firstKeptEntryId,
			isSplitTurn: false,
			messagesToSummarize: [],
			settings: { enabled: true, keepRecentTokens: 8_192, reserveTokens: 16_384 },
			tokensBefore: 0,
			turnPrefixMessages: [],
		},
		reason: "manual",
		signal,
		type: "session_before_compact",
		willRetry: false,
	};
}

async function createMagicWorkerHarness() {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-magic-worker-"));
	const configDirectory = join(temporaryDirectory, "config", "cortexkit");
	const dataDirectory = join(temporaryDirectory, "data");
	const magicLog = join(temporaryDirectory, "magic-context.log");
	await mkdir(configDirectory, { recursive: true });
	await mkdir(dataDirectory, { recursive: true });
	await writeFile(
		join(configDirectory, "magic-context.jsonc"),
		`${JSON.stringify({
			dreamer: { disable: true },
			embedding: { provider: "off" },
			fail_closed_blocking: false,
			sidekick: { disable: true },
			todowrite: { enabled: false, overlay: false },
		})}\n`,
	);
	const originalEnvironment = {
		HF_HUB_OFFLINE: process.env["HF_HUB_OFFLINE"],
		HOME: process.env["HOME"],
		MAGIC_CONTEXT_TEST_DATA_DIR: process.env["MAGIC_CONTEXT_TEST_DATA_DIR"],
		MAGIC_CONTEXT_LOG_PATH: process.env["MAGIC_CONTEXT_LOG_PATH"],
		PI_OFFLINE: process.env["PI_OFFLINE"],
		XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
		XDG_DATA_HOME: process.env["XDG_DATA_HOME"],
	};
	Object.assign(process.env, {
		HF_HUB_OFFLINE: "1",
		HOME: temporaryDirectory,
		MAGIC_CONTEXT_TEST_DATA_DIR: dataDirectory,
		MAGIC_CONTEXT_LOG_PATH: magicLog,
		PI_OFFLINE: "1",
		XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
	});
	delete process.env["XDG_DATA_HOME"];
	const handlers = new Map<string, WorkerHandler[]>();
	const registeredTools = new Map<string, ToolDefinition<TSchema, unknown>>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]>();
	const state: WorkerHarnessState = {
		branchReads: 0,
		contextUsageReads: 0,
		entryReads: 0,
		currentBranch: [],
		currentLeafId: null,
	};
	const pi = createExtensionApi({
		on: captureExtensionHandlers(handlers),
		registerCommand: (name, definition) => {
			commands.set(name, definition.handler);
		},
		registerTool: (tool) => {
			// SAFETY: the test registry erases only generic renderer state and retains the original Tool object.
			registeredTools.set(tool.name, tool as ToolDefinition<TSchema, unknown>);
		},
	});
	const contextForSession = (id: string) =>
		createExtensionCommandContext({
			cwd: temporaryDirectory,
			getContextUsage: () => {
				state.contextUsageReads += 1;
				return { contextWindow: 128_000, percent: 0, tokens: 0 };
			},
			hasUI: false,
			model: MODEL,
			sessionManager: {
				getBranch: () => {
					state.branchReads += 1;
					return state.currentBranch;
				},
				getEntry: (entryId: string) => {
					state.entryReads += 1;
					return state.currentBranch.find((entry) => entry.id === entryId);
				},
				getLeafId: () => state.currentLeafId,
				getSessionFile: () => undefined,
				getSessionId: () => id,
			},
			thinkingLevel: "off",
		});
	return {
		commands,
		contextForSession,
		handlers,
		magicLog,
		pi,
		registeredTools,
		state,
		cleanup: async () => {
			for (const [name, value] of Object.entries(originalEnvironment)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await rm(temporaryDirectory, { force: true, recursive: true });
		},
	};
}

async function cancellationOutcome(operation: PromiseLike<unknown>): Promise<"cancelled" | "completed" | "timed-out"> {
	return Promise.race([
		Promise.resolve(operation).then(
			() => "completed" as const,
			() => "cancelled" as const,
		),
		Bun.sleep(250).then(() => "timed-out" as const),
	]);
}

async function verifyOwnedCancellation(
	harness: Awaited<ReturnType<typeof createMagicWorkerHarness>>,
	activeContext: ExtensionCommandContext,
): Promise<void> {
	const { commands, registeredTools } = harness;
	const augmentationCommand = commands.get("ctx-aug");
	if (!augmentationCommand) throw new Error("ctx-aug was not registered");
	expect(await cancellationOutcome(augmentationCommand("", activeContext))).toBe("cancelled");

	const cancelledTool = new AbortController();
	cancelledTool.abort(new Error("Tool consumer cancelled"));
	const searchTool = registeredTools.get("ctx_search");
	if (!searchTool) throw new Error("ctx_search was not registered");
	expect(
		await cancellationOutcome(
			searchTool.execute(
				"cancelled-context-search",
				{ query: "中文检索标记" },
				cancelledTool.signal,
				undefined,
				activeContext,
			),
		),
	).toBe("cancelled");
	await commands.get("ctx-status")?.("", activeContext);
}

async function verifyToolLifecycleSkipsContextUsage(
	harness: Awaited<ReturnType<typeof createMagicWorkerHarness>>,
	context: ExtensionCommandContext,
): Promise<void> {
	const { handlers, state } = harness;
	const readsBeforeToolStart = state.contextUsageReads;
	await requireHandler(handlers, "message_end")(
		{
			message: { ...assistantMessage("TOOL_USE_USAGE_EVIDENCE"), stopReason: "toolUse" },
			type: "message_end",
		},
		context,
	);
	await requireHandler(handlers, "tool_execution_start")(
		{
			args: {},
			toolCallId: "context-usage-free-tool-start",
			toolName: "custom_tool",
			type: "tool_execution_start",
		},
		context,
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	expect(state.contextUsageReads).toBe(readsBeforeToolStart);
	await requireHandler(handlers, "tool_execution_end")(
		{
			isError: false,
			result: { content: [{ text: "done", type: "text" }], details: undefined },
			toolCallId: "context-usage-free-tool-start",
			toolName: "custom_tool",
			type: "tool_execution_end",
		},
		context,
	);
	expect(state.contextUsageReads).toBe(readsBeforeToolStart);
	await requireHandler(handlers, "tool_result")(
		{
			content: [{ text: "done", type: "text" }],
			details: undefined,
			input: {},
			isError: false,
			toolCallId: "context-usage-free-tool-start",
			toolName: "custom_tool",
			type: "tool_result",
		},
		context,
	);
	expect(state.contextUsageReads).toBe(readsBeforeToolStart);
}

test("Magic worker Tool events do not traverse irrelevant payloads", () => {
	const unreadPayload = {};
	Object.defineProperty(unreadPayload, "payload", {
		enumerable: true,
		get: () => {
			throw new Error("irrelevant Tool payload was traversed");
		},
	});
	const toolStart = snapshotMagicWorkerEvent({
		args: unreadPayload,
		toolCallId: "large-call",
		toolName: "fixture_large",
		type: "tool_execution_start",
	});
	expect(toolStart.name).toBe("tool_execution_start");
	if (toolStart.name !== "tool_execution_start") throw new Error("unexpected Magic worker event snapshot");
	expect(toolStart.event.args).toEqual({});
	const todos = [{ content: "keep the required field", status: "pending" }];
	const todoStart = snapshotMagicWorkerEvent({
		args: { ignored: unreadPayload, todos },
		toolCallId: "todo-call",
		toolName: "todowrite",
		type: "tool_execution_start",
	});
	expect(todoStart.name).toBe("tool_execution_start");
	if (todoStart.name !== "tool_execution_start") throw new Error("unexpected Magic worker event snapshot");
	expect(todoStart.event.args).toEqual({ todos });

	const toolResult = snapshotMagicWorkerEvent({
		content: [{ text: "done", type: "text" }],
		details: undefined,
		input: unreadPayload,
		isError: false,
		toolCallId: "large-call",
		toolName: "fixture_large",
		type: "tool_result",
	});
	expect(toolResult.name).toBe("tool_result");
	if (toolResult.name !== "tool_result") throw new Error("unexpected Magic worker event snapshot");
	expect(toolResult.event.input).toEqual({});
});

test("the pinned engine cancels explicit compaction while ordinary lifecycle work survives Agent cancellation", async () => {
	const harness = await createMagicWorkerHarness();
	const { commands, contextForSession, handlers, pi } = harness;
	try {
		const packageRoot = join(import.meta.dir, "../../../packages/pi-stuff");
		const directModule: MagicModule = await import(Bun.resolveSync("@cortexkit/pi-magic-context", packageRoot));
		await directModule.default(pi);
		const context = contextForSession("direct-cancellation-session");
		await requireHandler(handlers, "session_start")({ type: "session_start", reason: "startup" }, context);

		const eventSignal = new AbortController();
		eventSignal.abort(new Error("compaction consumer cancelled"));
		await expect(
			requireHandler(handlers, "session_before_compact")(
				beforeCompactEvent("direct-entry", eventSignal.signal),
				context,
			),
		).rejects.toThrow("compaction consumer cancelled");

		context.abort();
		const statusCommand = commands.get("ctx-status");
		expect(statusCommand).toBeDefined();
		await statusCommand?.("", context);
		const assistant = assistantMessage("DIRECT_INTERRUPTED_TURN");
		await requireHandler(handlers, "message_end")({ type: "message_end", message: assistant }, context);
		await requireHandler(handlers, "agent_end")({ type: "agent_end", messages: [assistant] }, context);
		await requireHandler(handlers, "session_shutdown")({ type: "session_shutdown", reason: "quit" }, context);
	} finally {
		await harness.cleanup();
	}
});

test("the isolated engine matches pinned cancellation and keeps ordinary turns incremental", async () => {
	const harness = await createMagicWorkerHarness();
	const { commands, contextForSession, handlers, magicLog, pi, registeredTools, state } = harness;
	const context = contextForSession("worker-test-session");
	const foundation = installEffectFoundation(pi);
	await foundation.startSession(context.sessionManager);
	try {
		await magicContextWorkerFactory(pi);
		if (!handlers.has("context")) {
			await Bun.sleep(600);
			throw new Error(await readFile(magicLog, "utf8"));
		}
		expect(handlers.has("context")).toBeTrue();
		expect([...registeredTools.keys()].sort()).toEqual([
			"ctx_expand",
			"ctx_memory",
			"ctx_note",
			"ctx_reduce",
			"ctx_search",
		]);
		expect(commands.has("ctx-status")).toBeTrue();

		const sessionStart: SessionStartEvent = { reason: "resume", type: "session_start" };
		await requireHandler(handlers, "session_start")(sessionStart, context);
		expect(state.branchReads).toBe(1);

		const beforeCompact = { ...beforeCompactEvent(), reason: "threshold" as const };
		expect(await requireHandler(handlers, "session_before_compact")(beforeCompact, context)).toEqual({
			cancel: true,
		});
		expect(state.branchReads).toBe(1);
		const cancelled = new AbortController();
		cancelled.abort(new Error("already cancelled"));
		await expect(
			requireHandler(handlers, "session_before_compact")({ ...beforeCompact, signal: cancelled.signal }, context),
		).rejects.toThrow("already cancelled");

		const inFlightTagged = assistantMessage("§1§ WORKER_IN_FLIGHT_INTERRUPT_EVIDENCE");
		const inFlightProjected = assistantMessage("WORKER_IN_FLIGHT_INTERRUPT_EVIDENCE");
		inFlightProjected.timestamp = inFlightTagged.timestamp;
		const inFlightEvent = requireHandler(handlers, "message_end")(
			{ message: inFlightTagged, type: "message_end" },
			context,
		);
		context.abort();
		expect(await inFlightEvent).toEqual({ message: inFlightProjected });
		const taggedMessage = assistantMessage("§1§ WORKER_INCREMENTAL_INDEX_EVIDENCE");
		const projectedMessage = assistantMessage("WORKER_INCREMENTAL_INDEX_EVIDENCE");
		projectedMessage.timestamp = taggedMessage.timestamp;
		const messageEnd: MessageEndEvent = { message: taggedMessage, type: "message_end" };
		const readsBeforeSettledMessage = state.contextUsageReads;
		const messageResult = await requireHandler(handlers, "message_end")(messageEnd, context);
		expect(messageResult).toEqual({ message: projectedMessage });
		expect(state.contextUsageReads).toBeGreaterThan(readsBeforeSettledMessage);
		state.currentLeafId = "worker-entry";
		state.currentBranch = [messageEntry(state.currentLeafId, projectedMessage, null)];
		await Bun.sleep(20);
		expect(state.branchReads).toBe(1);
		expect(state.entryReads).toBe(1);

		const user = userMessage("WORKER_INCREMENTAL_USER_EVIDENCE");
		state.currentLeafId = "worker-user-entry";
		state.currentBranch = [...state.currentBranch, messageEntry(state.currentLeafId, user, "worker-entry")];
		const contextEvent: ContextEvent = { messages: [projectedMessage, user], type: "context" };
		for (let turn = 0; turn < 2; turn += 1) {
			await requireHandler(handlers, "context")(contextEvent, context);
		}
		expect(state.branchReads).toBe(1);
		expect(state.entryReads).toBe(2);

		const branchMessage = userMessage("WORKER_BRANCH_SWITCH_EVIDENCE");
		state.currentLeafId = "worker-branch-entry";
		state.currentBranch = [messageEntry(state.currentLeafId, branchMessage, null)];
		const branchContextEvent: ContextEvent = { messages: [branchMessage], type: "context" };
		for (let turn = 0; turn < 2; turn += 1) {
			await requireHandler(handlers, "context")(branchContextEvent, context);
		}
		expect(state.branchReads).toBe(2);
		expect(state.entryReads).toBe(3);

		interface CyclicDetails {
			self?: CyclicDetails;
		}
		const cyclicDetails: CyclicDetails = {};
		cyclicDetails.self = cyclicDetails;
		for (const details of [() => undefined, cyclicDetails]) {
			const toolResult: ToolResultEvent = {
				content: [{ text: "clone-safe result", type: "text" }],
				details,
				input: {},
				isError: false,
				toolCallId: "clone-safe-tool",
				toolName: "custom_tool",
				type: "tool_result",
			};
			await requireHandler(handlers, "tool_result")(toolResult, context);
		}

		await verifyToolLifecycleSkipsContextUsage(harness, context);

		const agentEnd: AgentEndEvent = { messages: [projectedMessage], type: "agent_end" };
		await requireHandler(handlers, "agent_end")(agentEnd, context);
		await verifyOwnedCancellation(harness, context);

		const beforeSwitch: SessionBeforeSwitchEvent = { reason: "resume", type: "session_before_switch" };
		await requireHandler(handlers, "session_before_switch")(beforeSwitch, context);

		const shutdown: SessionShutdownEvent = { reason: "quit", type: "session_shutdown" };
		const shutdownHandler = requireHandler(handlers, "session_shutdown");
		await shutdownHandler(shutdown, context);
		expect(await shutdownHandler(shutdown, context)).toBeUndefined();
	} finally {
		await foundation.shutdown();
		await harness.cleanup();
	}
});

test("an oversized synchronous Host response still wakes the Worker with a bounded error", () => {
	const buffer = new SharedArrayBuffer(MAGIC_WORKER_SYNC_BUFFER_BYTES);
	const control = new Int32Array(buffer, 0, 2);
	writeMagicWorkerSyncResponse(buffer, 2, "x".repeat(MAGIC_WORKER_SYNC_BUFFER_BYTES * 2));

	expect(Atomics.wait(control, 0, 0, 1)).toBe("not-equal");
	expect(Atomics.load(control, 0)).toBe(2);
	const length = Atomics.load(control, 1);
	const response = new TextDecoder().decode(new Uint8Array(buffer, Int32Array.BYTES_PER_ELEMENT * 2, length));
	expect(response).toBe("Magic Context Host effect response exceeded its buffer.");
});

test("the Host interpreter preserves append, send, notification, status, and compaction effects", () => {
	const observed: string[] = [];
	const pi = createExtensionApi({
		appendEntry: (customType) => observed.push(`append:${customType}`),
		sendMessage: (message) => observed.push(`send:${message.customType}`),
		sendUserMessage: (content) => observed.push(`user:${content}`),
	});
	const ctx = createExtensionContext({
		ui: {
			notify: (message) => observed.push(`notify:${message}`),
			setStatus: (key, value) => observed.push(`status:${key}:${value ?? ""}`),
		},
	});
	Reflect.set(ctx.sessionManager, "appendCompaction", (summary: string) => {
		observed.push(`compact:${summary}`);
		return "compaction-entry";
	});
	const effects = [
		{ args: ["worker-entry", { value: 1 }], name: "appendEntry", sessionId: "session", type: "effect" },
		{
			args: [{ content: "continue", customType: "worker-message", display: false }],
			name: "sendMessage",
			sessionId: "session",
			type: "effect",
		},
		{ args: ["next"], name: "sendUserMessage", sessionId: "session", type: "effect" },
		{ args: ["notice", "info"], name: "notify", sessionId: "session", type: "effect" },
		{ args: ["magic", "working"], name: "setStatus", sessionId: "session", type: "effect" },
	] satisfies MagicWorkerEffectMessage[];
	let synchronizations = 0;
	for (const effect of effects) {
		Effect.runSync(
			applyMagicWorkerHostEffect(pi, ctx, effect, () => {
				synchronizations++;
			}),
		);
	}
	const compaction = {
		args: ["managed summary", "first-kept", 42_000],
		buffer: new SharedArrayBuffer(MAGIC_WORKER_SYNC_BUFFER_BYTES),
		name: "appendCompaction",
		sessionId: "session",
		type: "sync-effect",
	} satisfies MagicWorkerSyncEffectMessage;
	expect(
		Effect.runSync(
			applyMagicWorkerHostCompaction(ctx, compaction, () => {
				synchronizations++;
			}),
		),
	).toBe("compaction-entry");
	expect(observed).toEqual([
		"append:worker-entry",
		"send:worker-message",
		"user:next",
		"notify:notice",
		"status:magic:working",
		"compact:managed summary",
	]);
	expect(synchronizations).toBe(2);
});

test("the Host interpreter fails closed for inactive Sessions, Host exceptions, and unsupported compaction", () => {
	const inactive = {
		args: ["notice", "info"],
		name: "notify",
		sessionId: "inactive",
		type: "effect",
	} satisfies MagicWorkerEffectMessage;
	expect(() =>
		Effect.runSync(applyMagicWorkerHostEffect(createExtensionApi(), undefined, inactive, () => undefined)),
	).toThrow("Magic Context emitted 'notify' for an inactive Session.");

	const appendFailure = {
		args: ["worker-entry"],
		name: "appendEntry",
		sessionId: undefined,
		type: "effect",
	} satisfies MagicWorkerEffectMessage;
	expect(() =>
		Effect.runSync(
			applyMagicWorkerHostEffect(
				createExtensionApi({
					appendEntry: () => {
						throw new Error("append failed");
					},
				}),
				undefined,
				appendFailure,
				() => undefined,
			),
		),
	).toThrow("append failed");

	const ctx = createExtensionContext();
	Reflect.set(ctx.sessionManager, "appendCompaction", undefined);
	const unsupported = {
		args: ["managed summary", "first-kept", 42_000],
		buffer: new SharedArrayBuffer(MAGIC_WORKER_SYNC_BUFFER_BYTES),
		name: "appendCompaction",
		sessionId: "session",
		type: "sync-effect",
	} satisfies MagicWorkerSyncEffectMessage;
	expect(() => Effect.runSync(applyMagicWorkerHostCompaction(ctx, unsupported, () => undefined))).toThrow(
		"Pi SessionManager does not expose appendCompaction.",
	);
});

test("an invocation cancelled while queued never reaches Magic Context", () => {
	const contexts = new MagicWorkerContextStore(() => undefined);
	const controller = new AbortController();
	const request = {
		args: "",
		context: {
			contextUsage: undefined,
			cwd: "/project",
			hasUI: false,
			mode: "rpc",
			model: undefined,
			session: { id: "cancelled-session", leafId: undefined },
			systemPrompt: "",
		},
		id: 1,
		name: "ctx-status",
		type: "command",
	} satisfies MagicWorkerInvocationRequest;
	let invoked = false;
	controller.abort(new Error("queued invocation cancelled"));

	expect(() =>
		contexts.run(request, controller, async () => {
			invoked = true;
		}),
	).toThrow("queued invocation cancelled");
	expect(invoked).toBeFalse();
});

test("Magic retry preserves tags when a retained summary and persisted failure cancel message counts", async () => {
	const harness = await createMagicWorkerHarness();
	const { handlers, pi, state, contextForSession } = harness;
	const ctx = contextForSession("retained-summary-retry");
	const foundation = installEffectFoundation(pi);
	await foundation.startSession(ctx.sessionManager);
	try {
		await magicContextWorkerFactory(pi);
		await requireHandler(handlers, "session_start")({ type: "session_start", reason: "startup" }, ctx);
		const first = messageEntry("first", userMessage("FIRST_RETAINED_DIRECTIVE"), null);
		const oldSummary: SessionEntry = {
			type: "compaction",
			id: "old-summary",
			parentId: "first",
			timestamp: new Date().toISOString(),
			firstKeptEntryId: "first",
			summary: "Earlier task decisions",
			tokensBefore: 1000,
		};
		const second = messageEntry("second", assistantMessage("SECOND_RETAINED_RESULT"), "old-summary");
		const latestSummary: SessionEntry = {
			...oldSummary,
			id: "latest-summary",
			parentId: "second",
			summary: "Latest task decisions",
		};
		const current = messageEntry("current", userMessage("CURRENT_ACCEPTED_INPUT"), "latest-summary");
		state.currentBranch = [first, oldSummary, second, latestSummary, current];
		state.currentLeafId = "current";
		const messages = buildSessionContext(state.currentBranch).messages;
		const project = requireHandler(handlers, "context");
		const initial = await project({ type: "context", messages: structuredClone(messages) }, ctx);
		const failed = messageEntry(
			"failed",
			{ ...assistantMessage(""), stopReason: "error", errorMessage: "Connection closed" },
			"current",
		);
		state.currentBranch = [...state.currentBranch, failed];
		state.currentLeafId = "failed";
		const retried = await project({ type: "context", messages: structuredClone(messages) }, ctx);
		expect(retried).toEqual(initial);
		expect(await readFile(harness.magicLog, "utf8")).not.toContain("Pi branch projection failed:");
	} finally {
		await requireHandler(handlers, "session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
		await foundation.shutdown();
		await harness.cleanup();
	}
});
