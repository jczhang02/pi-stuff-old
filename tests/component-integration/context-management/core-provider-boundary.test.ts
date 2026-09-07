import { afterEach, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { registerContextPromptContributor } from "../../../packages/pi-stuff/src/context-management/index.js";
import { getContextStatusChannel } from "../../../packages/pi-stuff/src/conversation-ui/statusline.js";
import {
	apiFor,
	cleanupContextCoreFixtures,
	createExtensionCommandContext,
	emit,
	emitResults,
	type Handlers,
	magicModule,
	piStuffContext,
	taggedMessage,
} from "../../context/core-fixtures.js";

afterEach(cleanupContextCoreFixtures);

test("unknown estimates and unserializable multimodal payloads do not interrupt a valid Magic request", async () => {
	const handlers: Handlers = new Map();
	const api = apiFor(handlers);
	piStuffContext(api, { loadMagicContext: async () => magicModule() });
	const ctx = createExtensionCommandContext();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await emitResults(handlers, "context", { type: "context", messages: [taggedMessage("current input")] }, ctx);
	for (const payload of [
		{ messages: [{ role: "user", content: [{ type: "image", data: "fixture", mimeType: "image/png" }] }] },
		{ messages: [], unmeasurable: 1n },
	]) {
		await emit(handlers, "before_provider_request", { type: "before_provider_request", payload }, ctx);
		expect(ctx.signal?.aborted).toBe(false);
		expect(getContextStatusChannel(api).source.getSnapshot()).toEqual({ state: "unknown" });
	}
});

test("allows a high local estimate without interrupting the Agent", async () => {
	const handlers: Handlers = new Map();
	const notifications: string[] = [];
	const api = apiFor(handlers);
	const contextStatus = getContextStatusChannel(api);
	piStuffContext(api, {
		loadMagicContext: async () => magicModule(),
	});
	const ctx = createExtensionCommandContext({
		model: {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1.invalid",
			contextWindow: 100,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
			id: "fixture-model",
			input: ["text"],
			maxTokens: 4,
			name: "Fixture",
			provider: "unknown-provider",
			reasoning: false,
		} satisfies Model<Api>,
		getContextUsage: () => ({ contextWindow: 100, percent: 0, tokens: 0 }),
		ui: { notify: (message) => notifications.push(message) },
	});
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await emitResults(handlers, "context", { type: "context", messages: [taggedMessage("current input")] }, ctx);

	await emit(
		handlers,
		"before_provider_request",
		{
			type: "before_provider_request",
			payload: { messages: [{ role: "user", content: [{ type: "text", text: "x".repeat(10_000) }] }] },
		},
		ctx,
	);

	expect(ctx.signal?.aborted).toBe(false);
	expect(notifications).toEqual([]);
	expect(contextStatus.source.getSnapshot()).toMatchObject({ state: "validated", contextWindow: 100 });
});

test("keeps healthy projection out of recovery display and clears estimates after a successful response", async () => {
	const handlers: Handlers = new Map();
	const api = apiFor(handlers);
	const contextStatus = getContextStatusChannel(api);
	let statusDuringProjection: unknown;
	piStuffContext(api, {
		loadMagicContext: async () =>
			magicModule({
				onContext: () => {
					statusDuringProjection = contextStatus.source.getSnapshot();
				},
			}),
	});
	const ctx = createExtensionCommandContext({
		model: {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1.invalid",
			contextWindow: 128_000,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
			id: "fixture-model",
			input: ["text"],
			maxTokens: 512,
			name: "Fixture",
			provider: "unknown-provider",
			reasoning: false,
		} satisfies Model<Api>,
	});
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	await emitResults(handlers, "context", { type: "context", messages: [taggedMessage("project")] }, ctx);
	expect(statusDuringProjection).toBeUndefined();

	await emit(
		handlers,
		"before_provider_request",
		{
			type: "before_provider_request",
			payload: { messages: [taggedMessage("project")] },
		},
		ctx,
	);
	expect(contextStatus.source.getSnapshot()).toMatchObject({
		state: "validated",
		contextWindow: 128_000,
	});
	expect(contextStatus.source.getSnapshot()?.tokens).toBeGreaterThanOrEqual(0);

	await emit(
		handlers,
		"message_end",
		{ type: "message_end", message: { role: "assistant", stopReason: "error" } },
		ctx,
	);
	expect(contextStatus.source.getSnapshot()).toEqual({ state: "unknown" });

	await emit(
		handlers,
		"message_end",
		{ type: "message_end", message: { role: "assistant", stopReason: "stop" } },
		ctx,
	);
	expect(contextStatus.source.getSnapshot()).toBeUndefined();
});

test("lets Magic project every retry even when the raw messages are unchanged", async () => {
	const handlers: Handlers = new Map();
	let magicContexts = 0;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () =>
			magicModule({
				onContext: () => {
					magicContexts++;
				},
			}),
	});
	const ctx = createExtensionCommandContext({
		model: {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1.invalid",
			contextWindow: 128_000,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
			id: "fixture-model",
			input: ["text"],
			maxTokens: 512,
			name: "Fixture",
			provider: "unknown-provider",
			reasoning: false,
		} satisfies Model<Api>,
	});
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const rawMessage = taggedMessage("retry me");
	const first = await emitResults(handlers, "context", { type: "context", messages: [rawMessage] }, ctx);
	await emit(
		handlers,
		"before_provider_request",
		{
			type: "before_provider_request",
			payload: { messages: [rawMessage] },
		},
		ctx,
	);
	const retry = await emitResults(handlers, "context", { type: "context", messages: [rawMessage] }, ctx);

	expect(magicContexts).toBe(2);
	expect(retry[0]).toEqual(first[0]);

	await emitResults(
		handlers,
		"context",
		{ type: "context", messages: [rawMessage, taggedMessage("new trailing message")] },
		ctx,
	);
	expect(magicContexts).toBe(3);
});

test("reprojects an earlier message changed in place without relying on object identity", async () => {
	const handlers: Handlers = new Map();
	let magicContexts = 0;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () =>
			magicModule({
				onContext: () => {
					magicContexts++;
				},
			}),
	});
	const ctx = createExtensionCommandContext({
		model: {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1.invalid",
			contextWindow: 128_000,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
			id: "fixture-model",
			input: ["text"],
			maxTokens: 512,
			name: "Fixture",
			provider: "unknown-provider",
			reasoning: false,
		} satisfies Model<Api>,
	});
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const firstMessage = taggedMessage("first");
	const trailingMessage = taggedMessage("trailing");
	await emitResults(handlers, "context", { type: "context", messages: [firstMessage, trailingMessage] }, ctx);
	await emit(
		handlers,
		"before_provider_request",
		{
			type: "before_provider_request",
			payload: { messages: [firstMessage, trailingMessage] },
		},
		ctx,
	);

	firstMessage.content[0] = { type: "text", text: "changed earlier" };
	const changedEarlierMessage = firstMessage;
	const recomputed = await emitResults(
		handlers,
		"context",
		{ type: "context", messages: [changedEarlierMessage, trailingMessage] },
		ctx,
	);

	expect(magicContexts).toBe(2);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	expect((recomputed[0] as { messages: unknown[] }).messages).toContain(changedEarlierMessage);
});

test("does not validate a replacement candidate after an earlier provider boundary resumes", async () => {
	const handlers: Handlers = new Map();
	let magicContexts = 0;
	const { promise: contributionGate, resolve: releaseContribution } = Promise.withResolvers<void>();
	let contributionEntered = false;
	const api = apiFor(handlers);
	registerContextPromptContributor(api, {
		id: "candidate-gate",
		renderAgent: () => undefined,
		renderProvider: async () => {
			contributionEntered = true;
			await contributionGate;
			return "candidate contribution";
		},
	});
	piStuffContext(api, {
		loadMagicContext: async () =>
			magicModule({
				onContext: () => {
					magicContexts++;
				},
			}),
	});
	const ctx = createExtensionCommandContext({
		model: {
			api: "openai-completions",
			baseUrl: "http://127.0.0.1.invalid",
			contextWindow: 128_000,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
			id: "fixture-model",
			input: ["text"],
			maxTokens: 512,
			name: "Fixture",
			provider: "unknown-provider",
			reasoning: false,
		} satisfies Model<Api>,
	});
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const messageA = taggedMessage("candidate A");
	const messageB = taggedMessage("candidate B");
	await emitResults(handlers, "context", { type: "context", messages: [messageA] }, ctx);
	const pendingBoundary = emit(
		handlers,
		"before_provider_request",
		{ type: "before_provider_request", payload: { system: "Host" } },
		ctx,
	);
	while (!contributionEntered) await Promise.resolve();

	await emitResults(handlers, "context", { type: "context", messages: [messageB] }, ctx);
	releaseContribution();
	await pendingBoundary;
	await emitResults(handlers, "context", { type: "context", messages: [messageB] }, ctx);

	expect(magicContexts).toBe(3);
});
