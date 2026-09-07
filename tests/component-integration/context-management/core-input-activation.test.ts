import { afterEach, expect, test } from "bun:test";
import {
	__test,
	apiFor,
	cleanupContextCoreFixtures,
	context,
	type ExtensionAPI,
	emit,
	emitUntilHandled,
	getContextCapability,
	type Handler,
	type Handlers,
	hasDirectUserActivation,
	magicModule,
	piStuffContext,
	sendSuiteAgentMessage,
	taggedMessage,
	UI_RENDER_REQUEST_EVENT,
	withAgentWorkOrigin,
	withDirectUserActivation,
} from "../../context/core-fixtures.js";

afterEach(cleanupContextCoreFixtures);

const ACTIVE_CONTEXT_STATUS = {
	continuity: "degraded",
	continuityDetail:
		"Pi auto-compaction is disabled, so Pi will not invoke automatic Magic overflow recovery. Ordinary Magic compaction remains enabled.",
	engine: "magic-context",
	state: "active",
	trigger: "input",
} as const;

test("runs input activation only while Context is unsettled", () => {
	expect(__test.requiresInputActivation("dormant")).toBe(true);
	expect(__test.requiresInputActivation("loading")).toBe(true);
	expect(__test.requiresInputActivation("degraded")).toBe(true);
	expect(__test.requiresInputActivation("active")).toBe(false);
	expect(__test.requiresInputActivation("native")).toBe(false);
});

test("defers direct input activation until after Host input dispatch", async () => {
	const handlers: Handlers = new Map();
	const preparations: boolean[] = [];
	const { promise: deferredActivationStarted, resolve: markDeferredActivationStarted } = Promise.withResolvers<void>();
	await piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => magicModule(),
		prepareMagicContext: async (_ctx, options) => {
			preparations.push(options.allowConfigurationMutation);
			if (options.allowConfigurationMutation) markDeferredActivationStarted?.();
			return options.allowConfigurationMutation ? "ready" : "deferred";
		},
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	await emit(handlers, "input", { type: "input", text: "first", source: "interactive" }, ctx);
	expect(preparations).toEqual([false]);
	await deferredActivationStarted;
	expect(preparations).toEqual([false, true]);
});

test("accepted input activation survives Agent-turn interruption", async () => {
	const handlers: Handlers = new Map();
	let factoryLoads = 0;
	const { promise: preparationEntered, resolve: markPreparationEntered } = Promise.withResolvers<void>();
	const { promise: preparationGate, resolve: releasePreparation } = Promise.withResolvers<void>();
	await piStuffContext(apiFor(handlers), {
		readNativeCompactionSettings: () => ({ enabled: false, reserveTokens: 16_384 }),
		loadMagicContext: async () => {
			factoryLoads += 1;
			return magicModule();
		},
		prepareMagicContext: async (_ctx, options) => {
			if (!options.allowConfigurationMutation) return "deferred";
			markPreparationEntered?.();
			await preparationGate;
			return "ready";
		},
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	await emit(handlers, "input", { type: "input", text: "accepted", source: "interactive" }, ctx);
	await preparationEntered;
	ctx.abort();
	releasePreparation?.();
	await new Promise<void>((resolve) => setImmediate(resolve));
	await new Promise<void>((resolve) => setImmediate(resolve));

	expect(getContextCapability(ctx).status()).toEqual(ACTIVE_CONTEXT_STATUS);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	expect(factoryLoads).toBe(1);
});

test("does not bootstrap Magic Context from an Extension-authored automatic turn", async () => {
	const handlers: Handlers = new Map();
	let factories = 0;
	const preparations: boolean[] = [];
	piStuffContext(apiFor(handlers), {
		readNativeCompactionSettings: () => ({ enabled: false, reserveTokens: 16_384 }),
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				factories++;
				magicApi.on("context", (event) => event);
			},
		}),
		prepareMagicContext: async (_ctx, options) => {
			preparations.push(options.allowConfigurationMutation);
			return options.allowConfigurationMutation ? "ready" : "deferred";
		},
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	await emit(
		handlers,
		"input",
		{ type: "input", text: "automatic continuation", source: "extension", streamingBehavior: "followUp" },
		ctx,
	);
	expect(preparations).toEqual([false]);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	expect(preparations).toEqual([false, false]);
	expect(factories).toBe(0);
	expect(getContextCapability(ctx).status()).toEqual({ state: "dormant", engine: "native" });

	await emit(handlers, "input", { type: "input", text: "direct request", source: "rpc" }, ctx);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	expect(preparations).toEqual([false, false, true]);
	expect(factories).toBe(1);
	expect(getContextCapability(ctx).status()).toEqual(ACTIVE_CONTEXT_STATUS);
});

test("historical user attribution cannot authorize first-use Context mutation", async () => {
	const handlers: Handlers = new Map();
	const preparations: boolean[] = [];
	let factories = 0;
	let delivered: Parameters<ExtensionAPI["sendMessage"]>[0] | undefined;
	const api = apiFor(handlers);
	Reflect.set(api, "sendMessage", (message: Parameters<ExtensionAPI["sendMessage"]>[0]) => {
		delivered = message;
	});
	piStuffContext(api, {
		readNativeCompactionSettings: () => ({ enabled: false, reserveTokens: 16_384 }),
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				factories++;
				magicApi.on("context", (event) => event);
			},
		}),
		prepareMagicContext: async (_ctx, options) => {
			preparations.push(options.allowConfigurationMutation);
			return options.allowConfigurationMutation ? "ready" : "deferred";
		},
	});
	let idle = true;
	const ctx = context();
	Object.assign(ctx, { isIdle: () => idle });
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const backgroundCompletion = withAgentWorkOrigin(
		{ content: "background complete", customType: "background-result", display: true },
		"user",
	);
	expect(hasDirectUserActivation(backgroundCompletion)).toBe(false);
	await sendSuiteAgentMessage(api, backgroundCompletion, { triggerTurn: true });
	idle = false;
	await emit(handlers, "message_start", { message: { role: "custom", ...delivered } }, ctx);

	expect(preparations).toEqual([false, false, false]);
	expect(factories).toBe(0);
	expect(getContextCapability(ctx).status()).toEqual({ state: "dormant", engine: "native" });

	idle = true;
	await sendSuiteAgentMessage(
		api,
		withDirectUserActivation(
			withAgentWorkOrigin({ content: "explicit command", customType: "command-result", display: true }, "user"),
		),
		{ triggerTurn: true },
	);
	expect(preparations).toEqual([false, false, false, true]);
	expect(factories).toBe(1);
	expect(getContextCapability(ctx).status()).toEqual(ACTIVE_CONTEXT_STATUS);
});

test("does not bootstrap Magic Context when a later Extension handles automatic input", async () => {
	const handlers: Handlers = new Map();
	let factories = 0;
	let preparations = 0;
	const api = apiFor(handlers);
	piStuffContext(api, {
		loadMagicContext: async () => ({
			default: async () => {
				factories++;
			},
		}),
		prepareMagicContext: async (_ctx, options) => {
			preparations++;
			return options.allowConfigurationMutation ? "ready" : "deferred";
		},
	});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	(api.on as (event: string, handler: Handler) => void)("input", () => ({ action: "handled" }));
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	await emitUntilHandled(
		handlers,
		"input",
		{ type: "input", text: "display-only automatic message", source: "extension" },
		ctx,
	);

	expect(preparations).toBe(1);
	expect(factories).toBe(0);
	expect(getContextCapability(ctx).status()).toEqual({ state: "dormant", engine: "native" });
});

test("retries a deferred automatic activation when direct input arrives concurrently", async () => {
	const handlers: Handlers = new Map();
	const preparations: boolean[] = [];
	let factories = 0;
	const { promise: automaticGate, resolve: releaseAutomatic } = Promise.withResolvers<void>();
	const { promise: automaticEntered, resolve: markAutomaticEntered } = Promise.withResolvers<void>();
	let mutationFreeAttempts = 0;
	piStuffContext(apiFor(handlers), {
		readNativeCompactionSettings: () => ({ enabled: false, reserveTokens: 16_384 }),
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				factories++;
				magicApi.on("context", (event) => event);
			},
		}),
		prepareMagicContext: async (_ctx, options) => {
			preparations.push(options.allowConfigurationMutation);
			if (!options.allowConfigurationMutation) {
				mutationFreeAttempts++;
				if (mutationFreeAttempts > 1) {
					markAutomaticEntered?.();
					await automaticGate;
				}
				return "deferred";
			}
			return "ready";
		},
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const automatic = emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	await automaticEntered;
	const direct = emit(handlers, "input", { type: "input", text: "direct", source: "rpc" }, ctx);
	releaseAutomatic?.();
	await Promise.all([automatic, direct]);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);

	expect(preparations).toEqual([false, false, true]);
	expect(factories).toBe(1);
	expect(getContextCapability(ctx).status()).toEqual(ACTIVE_CONTEXT_STATUS);
});

test("gives only interactive input one Host paint turn before Context without requesting another render", async () => {
	const handlers: Handlers = new Map();
	const sequence: string[] = [];
	let renderRequests = 0;
	const api = apiFor(handlers);
	api.events.on(UI_RENDER_REQUEST_EVENT, (value) => {
		renderRequests++;
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		(value as { handled: boolean }).handled = true;
	});
	piStuffContext(api, {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				sequence.push("activate");
				magicApi.on("context", (event) => {
					sequence.push("transform");
					return { messages: [taggedMessage("<session-history>preserved</session-history>"), ...event.messages] };
				});
			},
		}),
		prepareMagicContext: async () => {
			sequence.push("prepare");
			return "ready";
		},
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	sequence.length = 0;

	await emit(handlers, "input", { type: "input", text: "first", source: "interactive" }, ctx);
	await emit(handlers, "input", { type: "input", text: "latest", source: "interactive" }, ctx);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	const hostTurn = new Promise<void>((resolveTurn) => {
		setImmediate(() => {
			sequence.push("host-turn");
			resolveTurn();
		});
	});
	const firstContext = emit(handlers, "context", { type: "context", messages: [taggedMessage("first")] }, ctx);
	expect(sequence).toEqual([]);
	expect(renderRequests).toBe(0);
	await Promise.all([hostTurn, firstContext]);
	await emit(handlers, "context", { type: "context", messages: [taggedMessage("tool result")] }, ctx);
	expect(sequence).toEqual(["host-turn", "transform", "transform"]);

	for (const source of ["rpc", "extension"] as const) {
		sequence.length = 0;
		await emit(handlers, "input", { type: "input", text: "handled", source: "interactive" }, ctx);
		await emit(handlers, "input", { type: "input", text: source, source }, ctx);
		let hostTurnReached = false;
		const hostTurn = new Promise<void>((resolveTurn) => {
			setImmediate(() => {
				hostTurnReached = true;
				resolveTurn();
			});
		});
		const contextTransform = emit(handlers, "context", { type: "context", messages: [taggedMessage(source)] }, ctx);
		expect(sequence).toEqual(["transform"]);
		expect(hostTurnReached).toBe(false);
		await Promise.all([hostTurn, contextTransform]);
	}
	expect(renderRequests).toBe(0);
});
