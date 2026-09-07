import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Message, Model, UserMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type ExtensionContext, estimateTokens, type SessionEntry } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { executeBtw, type OpenBtwStream, readEffectiveContext } from "../../../packages/pi-stuff/src/btw/btw.js";
import { fitBranch } from "../../../packages/pi-stuff/src/btw/btw-budget.js";
import piStuffContext, { __test as contextTest } from "../../../packages/pi-stuff/src/context-management/index.js";
import { EffectFoundation } from "../../../packages/pi-stuff/src/shared/effect-foundation.js";
import { createExtensionContext } from "../../fixtures/extension-context.js";

const MODEL: Model<Api> = {
	id: "fixture-model",
	name: "Fixture model",
	api: "openai-completions",
	provider: "fixture",
	baseUrl: "http://127.0.0.1.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 4_096,
};

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
	errorMessage?: string,
): AssistantMessage {
	const result: AssistantMessage = {
		role: "assistant",
		content: text.length === 0 ? [] : [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: ZERO_USAGE,
		stopReason,
		timestamp: Date.now(),
	};
	return errorMessage === undefined ? result : { ...result, errorMessage };
}

function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function messageEntry(id: string, message: Message, parentId: string | null = null): SessionEntry {
	return { type: "message", id, parentId, timestamp: new Date().toISOString(), message };
}

function extensionContext(
	buildContextEntries: () => SessionEntry[],
	mainSignal: AbortSignal = new AbortController().signal,
): ExtensionContext {
	return createExtensionContext({
		model: MODEL,
		thinkingLevel: "high",
		signal: mainSignal,
		sessionManager: {
			buildContextEntries,
			getSessionId: () => "session-a",
			getBranch: () => {
				throw new Error("getBranch must not be used");
			},
		},
	});
}

function completedStream(deltas: readonly string[], final: AssistantMessage) {
	const stream = createAssistantMessageEventStream();
	const pending = assistant("", "pending");
	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	for (const delta of deltas) {
		stream.push({ type: "text_delta", contentIndex: 0, delta, partial: pending });
	}
	stream.push({ type: "text_end", contentIndex: 0, content: deltas.join(""), partial: pending });
	if (final.stopReason === "error" || final.stopReason === "aborted") {
		stream.push({ type: "error", reason: final.stopReason, error: final });
	} else {
		if (final.stopReason === "pending") throw new Error("pending is not a terminal stream result");
		stream.push({ type: "done", reason: final.stopReason, message: final });
	}
	return stream;
}

function runBtw(...args: Parameters<typeof executeBtw>) {
	return Effect.runPromise(executeBtw(...args));
}

describe("BTW effective context", () => {
	test("uses Pi's compaction-aware context, preserves completed images, and removes any pending assistant", () => {
		const entries: SessionEntry[] = [
			{
				type: "branch_summary",
				id: "summary",
				parentId: null,
				timestamp: new Date().toISOString(),
				fromId: "old",
				summary: "effective compacted summary",
			},
			{
				type: "custom_message",
				id: "custom",
				parentId: "summary",
				timestamp: new Date().toISOString(),
				customType: "fixture",
				content: "effective custom context",
				display: false,
			},
			messageEntry(
				"image",
				{
					role: "user",
					content: [
						{ type: "text", text: "look at this" },
						{ type: "image", data: "sensitive-base64", mimeType: "image/png" },
					],
					timestamp: Date.now(),
				},
				"custom",
			),
			messageEntry("pending", assistant("unfinished", "pending"), "image"),
		];
		const result = readEffectiveContext(extensionContext(() => entries));
		const serialized = JSON.stringify(result.messages);

		expect(serialized).toContain("effective compacted summary");
		expect(serialized).toContain("effective custom context");
		expect(serialized).toContain("sensitive-base64");
		expect(serialized).not.toContain("unfinished");
	});

	test("preserves completed tool calls and tool results while excluding a non-trailing partial", () => {
		const toolCall = {
			...assistant("", "toolUse"),
			content: [{ type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "src/a.ts" } }],
		};
		const toolResult: Message = {
			role: "toolResult",
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text", text: "completed tool result" }],
			isError: false,
			timestamp: Date.now(),
		};
		const entries: SessionEntry[] = [
			messageEntry("user", user("inspect the file")),
			messageEntry("tool-call", toolCall, "user"),
			messageEntry("tool-result", toolResult, "tool-call"),
			messageEntry("partial", assistant("unfinished partial", "pending"), "tool-result"),
			{
				type: "custom",
				id: "invisible-state",
				parentId: "partial",
				timestamp: new Date().toISOString(),
				customType: "fixture",
				data: { ignored: true },
			},
		];
		const serialized = JSON.stringify(readEffectiveContext(extensionContext(() => entries)).messages);
		expect(serialized).toContain("src/a.ts");
		expect(serialized).toContain("completed tool result");
		expect(serialized).not.toContain("unfinished partial");
	});
});

describe("BTW context budget", () => {
	test("bounds structured thinking and tool arguments when one recent turn is oversized", () => {
		const oversized = {
			...assistant(""),
			content: [
				{ type: "thinking" as const, thinking: "reasoning".repeat(2_000) },
				{
					type: "toolCall" as const,
					id: "tool-1",
					name: "write",
					arguments: { content: "payload".repeat(4_000), path: "/tmp/fixture" },
				},
			],
		};
		const mainRequest = user("main request");
		const messages: Message[] = [mainRequest, oversized];
		const result = fitBranch({
			entries: [messageEntry("user", mainRequest), messageEntry("assistant", oversized, "user")],
			messages,
			model: MODEL,
			systemPrompt: "side system",
			question: user("side question"),
			keepBudget: 100,
		});

		expect(result.messages.reduce((total, message) => total + estimateTokens(message), 0)).toBeLessThanOrEqual(100);
		expect(JSON.stringify(result.messages)).not.toContain("payloadpayloadpayload");
		expect(result.stubbed).toBe(true);
	});

	test("fits ten thousand unanchored Tool results without rescanning the branch per replacement", () => {
		const messages: Message[] = Array.from({ length: 10_000 }, (_, index) => ({
			role: "toolResult" as const,
			toolCallId: `tool-${String(index)}`,
			toolName: "read",
			content: [{ type: "text" as const, text: "x".repeat(100) }],
			isError: false,
			timestamp: index,
		}));
		const entries = messages.map((message, index) =>
			messageEntry(`entry-${String(index)}`, message, index === 0 ? null : `entry-${String(index - 1)}`),
		);
		const started = performance.now();
		const result = fitBranch({
			entries,
			messages,
			model: MODEL,
			systemPrompt: "side system",
			question: user("side question"),
			keepBudget: 0,
		});

		expect(performance.now() - started).toBeLessThan(1_000);
		expect(result.messages).toEqual([]);
		expect(result.stubbed).toBe(true);
	});
});

test("reuses captured Magic memory without re-running stateful projection for a frozen branch", async () => {
	type ContextHandlerResult = object | undefined | Promise<object | undefined>;
	interface ContextHarnessEvent {
		readonly messages?: readonly Message[];
		readonly prompt?: string;
		readonly reason?: string;
		readonly type?: string;
	}
	type ContextHandler = (event: ContextHarnessEvent, ctx: ExtensionContext) => ContextHandlerResult;
	const handlers = new Map<string, ContextHandler[]>();
	const activeTools: string[] = [];
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const api = {
		events: {},
		on: (event: string, handler: ContextHandler) => {
			const current = handlers.get(event) ?? [];
			current.push(handler);
			handlers.set(event, current);
		},
		registerTool: () => undefined,
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		registerCommand: () => undefined,
		registerEntryRenderer: () => undefined,
	} as never;
	let captured: Parameters<OpenBtwStream>[0] | undefined;
	let magicTransforms = 0;
	try {
		piStuffContext(api, {
			loadMagicContext: async () => ({
				default: async (magicPi) => {
					// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
					const register = magicPi.on.bind(magicPi) as (
						event: string,
						handler: (event: ContextHarnessEvent) => ContextHandlerResult,
					) => void;
					register("context", () => {
						magicTransforms += 1;
						return {
							messages: [
								user("<session-history><project-memory>side memory</project-memory></session-history>"),
							],
						};
					});
				},
			}),
		});
		const ctx = extensionContext(() => [messageEntry("main", user("main conversation"))]);
		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "startup" }, ctx);
		}
		for (const handler of handlers.get("before_agent_start") ?? []) {
			await handler({ type: "before_agent_start", prompt: "main conversation" }, ctx);
		}
		for (const handler of handlers.get("context") ?? []) {
			await handler({ type: "context", messages: [user("main conversation")] }, ctx);
		}
		await runBtw("isolated question", ctx, new AbortController().signal, {}, (request) => {
			captured = request;
			return Effect.succeed(completedStream(["answer"], assistant("answer")));
		});
	} finally {
		await contextTest.clear();
	}

	expect(magicTransforms).toBe(1);
	expect(captured?.context.systemPrompt).toContain("pi-stuff-context");
	expect(captured?.context.systemPrompt).toContain("side memory");
	expect(JSON.stringify(captured?.context.messages)).toContain("main conversation");
});

test("streams text through the composed transport with no tools and an independent signal", async () => {
	const mainController = new AbortController();
	const sideController = new AbortController();
	const ctx = extensionContext(() => [messageEntry("main", user("main conversation"))], mainController.signal);
	const deltas: string[] = [];
	let captured: Parameters<OpenBtwStream>[0] | undefined;
	const openStream: OpenBtwStream = (request) => {
		captured = request;
		return Effect.succeed(completedStream(["side ", "answer"], assistant("side answer")));
	};

	const result = await runBtw(
		"isolated question",
		ctx,
		sideController.signal,
		{ onTextDelta: (delta) => deltas.push(delta) },
		openStream,
	);

	expect(result.kind).toBe("success");
	expect(deltas).toEqual(["side ", "answer"]);
	expect(captured?.signal).not.toBe(mainController.signal);
	expect(captured?.signal).not.toBe(sideController.signal);
	expect(captured?.signal.aborted).toBe(true);
	expect(sideController.signal.aborted).toBe(false);
	expect(captured?.context.tools).toEqual([]);
	const requestText = JSON.stringify(captured?.context.messages);
	expect(requestText).toContain("main conversation");
	expect(requestText).toContain("isolated question");
});

test("retries overflow once, resets partial output, and never re-reads a changed main branch", async () => {
	let contextReads = 0;
	const ctx = extensionContext(() => {
		contextReads++;
		return [messageEntry("main", user(contextReads === 1 ? "frozen context" : "leaked later context"))];
	});
	let calls = 0;
	const events: string[] = [];
	const requests: Parameters<OpenBtwStream>[0][] = [];
	const openStream: OpenBtwStream = (request) => {
		requests.push(request);
		calls++;
		return Effect.succeed(
			calls === 1
				? completedStream(["discard me"], assistant("", "error", "prompt is too long"))
				: completedStream(["kept"], assistant("kept")),
		);
	};

	const result = await runBtw(
		"question",
		ctx,
		new AbortController().signal,
		{
			onTextDelta: (delta) => events.push(delta),
			onRetry: () => events.push("RESET"),
		},
		openStream,
	);

	expect(result.kind).toBe("success");
	expect(calls).toBe(2);
	expect(contextReads).toBe(1);
	expect(events).toEqual(["discard me", "RESET", "kept"]);
	expect(JSON.stringify(requests[1]?.context.messages)).toContain("frozen context");
	expect(JSON.stringify(requests[1]?.context.messages)).not.toContain("leaked later context");
});

test("keeps failed partial output ephemeral and rejects a model tool attempt", async () => {
	const stream = createAssistantMessageEventStream();
	const pending = assistant("", "pending");
	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: pending });
	stream.push({
		type: "toolcall_start",
		contentIndex: 1,
		partial: pending,
	});
	stream.push({
		type: "toolcall_end",
		contentIndex: 1,
		toolCall: { type: "toolCall", id: "tool-1", name: "read", arguments: {} },
		partial: pending,
	});
	stream.push({ type: "done", reason: "toolUse", message: assistant("partial", "toolUse") });
	const result = await runBtw(
		"question",
		extensionContext(() => []),
		new AbortController().signal,
		{},
		() => Effect.succeed(stream),
	);

	expect(result).toMatchObject({ kind: "error", partial: "partial" });
	if (result.kind === "error") expect(result.error).toContain("tools are disabled");
});

test("an aborted side signal does not touch the main signal", async () => {
	const mainController = new AbortController();
	const sideController = new AbortController();
	const stream = createAssistantMessageEventStream();
	const pending = assistant("", "pending");
	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	stream.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial: pending });
	const result = await runBtw(
		"question",
		extensionContext(() => [], mainController.signal),
		sideController.signal,
		{ onTextDelta: () => sideController.abort() },
		() => Effect.succeed(stream),
	);

	expect(result).toEqual({ kind: "aborted", partial: "partial", stopReason: "aborted" });
	expect(mainController.signal.aborted).toBe(false);
});

test("cancels a stream acquisition that has not settled", async () => {
	const sideController = new AbortController();
	const pending = runBtw(
		"question",
		extensionContext(() => []),
		sideController.signal,
		{},
		() => Effect.never,
	);
	sideController.abort();

	expect(await pending).toEqual({ kind: "aborted", partial: "", stopReason: "aborted" });
});

test("aborts the provider signal when its owning Session Scope is replaced", async () => {
	const foundation = new EffectFoundation();
	const session = await foundation.startSession();
	const operation = foundation.forkOperation(session);
	const stream = createAssistantMessageEventStream();
	let providerSignal: AbortSignal | undefined;
	let markOpened: (() => void) | undefined;
	const opened = new Promise<void>((resolve) => {
		markOpened = resolve;
	});
	const running = foundation.run(
		operation,
		executeBtw(
			"question",
			extensionContext(() => []),
			new AbortController().signal,
			{},
			(request) =>
				Effect.sync(() => {
					providerSignal = request.signal;
					markOpened?.();
					return stream;
				}),
		),
	);

	await opened;
	expect(providerSignal?.aborted).toBe(false);
	await foundation.startSession();
	const exit = await running;
	expect(Exit.isFailure(exit)).toBe(true);
	if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
	expect(providerSignal?.aborted).toBe(true);
	await foundation.shutdown();
});

test("projects provider failures with their partial text and stop reason", async () => {
	const result = await runBtw(
		"question",
		extensionContext(() => []),
		new AbortController().signal,
		{},
		() => Effect.succeed(completedStream(["partial"], assistant("partial", "error", "provider exploded"))),
	);

	expect(result).toMatchObject({ kind: "error", partial: "partial", stopReason: "error" });
	if (result.kind === "error") expect(result.error).toContain("provider exploded");
});

test("projects a provider-originated abort as an in-surface error", async () => {
	const result = await runBtw(
		"question",
		extensionContext(() => []),
		new AbortController().signal,
		{},
		() => Effect.succeed(completedStream(["partial"], assistant("partial", "aborted"))),
	);

	expect(result).toMatchObject({ kind: "error", partial: "partial", stopReason: "aborted" });
	if (result.kind === "error") expect(result.error).toContain("model provider");
});
