import { afterEach, expect, test } from "bun:test";
import { getContextStatusChannel } from "../../../packages/pi-stuff/src/conversation-ui/statusline-channels.js";
import {
	apiFor,
	COMPACTION_RESULT,
	type CompactOptions,
	cleanupContextCoreFixtures,
	context,
	createExtensionCommandContext,
	type ExtensionAPI,
	emit,
	emitResults,
	getContextCapability,
	type Handler,
	type Handlers,
	piStuffContext,
	taggedMessage,
} from "../../context/core-fixtures.js";

afterEach(cleanupContextCoreFixtures);

test("explicit compaction cancellation clears recovery without degrading a healthy Worker", async () => {
	const handlers: Handlers = new Map();
	const api = apiFor(handlers);
	const entered = Promise.withResolvers<void>();
	piStuffContext(api, {
		loadMagicContext: async () => ({
			default: (pi) => {
				pi.on("context", (event) => ({
					messages: [taggedMessage("<session-history>preserved</session-history>"), ...event.messages],
				}));
				pi.on(
					"session_before_compact",
					(event) =>
						new Promise((_resolve, reject) => {
							entered.resolve();
							event.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
						}),
				);
			},
		}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	const cancel = new AbortController();
	const pending = emitResults(
		handlers,
		"session_before_compact",
		{ type: "session_before_compact", reason: "overflow", signal: cancel.signal },
		ctx,
	);
	await entered.promise;
	expect(getContextStatusChannel(api).source.getSnapshot()?.state).toBe("recovering");
	cancel.abort();
	expect(await pending).toEqual([{ cancel: true }]);
	expect(getContextCapability(ctx).status().state).toBe("active");
	expect(getContextStatusChannel(api).source.getSnapshot()).toBeUndefined();
});

test("compaction cancellation stops waiting for Session initialization without starting compaction", async () => {
	const handlers: Handlers = new Map();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let compactions = 0;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => {
			entered.resolve();
			await release.promise;
			return {
				default: (pi) => {
					pi.on("context", (event) => ({
						messages: [taggedMessage("<session-history>preserved</session-history>"), ...event.messages],
					}));
					pi.on("session_before_compact", () => {
						compactions++;
						return { compaction: COMPACTION_RESULT };
					});
				},
			};
		},
	});
	const ctx = context();
	const startup = emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	const cancel = new AbortController();
	const pending = emitResults(
		handlers,
		"session_before_compact",
		{ type: "session_before_compact", reason: "overflow", signal: cancel.signal },
		ctx,
	);
	await entered.promise;
	cancel.abort();
	try {
		expect(await pending).toEqual([{ cancel: true }]);
	} finally {
		release.resolve();
	}
	await startup;
	expect(compactions).toBe(0);
	expect(getContextCapability(ctx).status().state).toBe("active");
});

test("overflow recovery restarts a failed Worker and replaces lifecycle handlers once", async () => {
	const handlers: Handlers = new Map();
	let starts = 0;
	const observed: number[] = [];
	await piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: (pi, onFatal) => {
				const worker = ++starts;
				pi.on("context", (event) => ({
					messages: [taggedMessage("<session-history>preserved</session-history>"), ...event.messages],
				}));
				pi.on("before_agent_start", () => {
					observed.push(worker);
				});
				pi.on("session_before_compact", () => {
					if (worker === 1) {
						const error = new Error("Worker exited during compaction");
						onFatal?.(error);
						throw error;
					}
					return { compaction: COMPACTION_RESULT };
				});
			},
		}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	const result = await emitResults(
		handlers,
		"session_before_compact",
		{
			type: "session_before_compact",
			reason: "overflow",
			signal: new AbortController().signal,
		},
		ctx,
	);
	expect(result).toEqual([{ compaction: COMPACTION_RESULT }]);
	expect(starts).toBe(2);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	expect(observed).toEqual([2]);
	expect(ctx.signal?.aborted).toBe(false);
});

test("a late failed projection cannot restart or abort a replacement Session", async () => {
	const handlers: Handlers = new Map();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let starts = 0;
	await piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: (pi) => {
				starts++;
				pi.on("context", async () => {
					entered.resolve();
					await release.promise;
					throw new Error("old Session projection failed");
				});
			},
		}),
	});
	const original = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, original);
	const projection = emitResults(handlers, "context", { type: "context", messages: [taggedMessage("old")] }, original);
	await entered.promise;
	const replacement = context([], "/workspace/project-b", "session-b");
	await emit(handlers, "session_start", { type: "session_start", reason: "switch" }, replacement);
	release.resolve();
	expect(await projection).toEqual([undefined]);
	expect(starts).toBe(1);
	expect(original.signal?.aborted).toBe(false);
	expect(replacement.signal?.aborted).toBe(false);
	expect(getContextCapability(replacement).status().state).toBe("active");
});

test("overflow counts a Worker already lost before its hook against the same single restart allowance", async () => {
	const handlers: Handlers = new Map();
	let starts = 0;
	let failWorker: (() => void) | undefined;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: (pi, onFatal) => {
				starts++;
				failWorker = () => onFatal?.(new Error("Worker exited"));
				pi.on("context", (event) => ({
					messages: [taggedMessage("<session-history>preserved</session-history>"), ...event.messages],
				}));
				pi.on("session_before_compact", () => {
					failWorker?.();
					throw new Error("replacement Worker exited");
				});
			},
		}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	failWorker?.();
	expect(
		await emitResults(
			handlers,
			"session_before_compact",
			{ type: "session_before_compact", reason: "overflow", signal: new AbortController().signal },
			ctx,
		),
	).toEqual([{ cancel: true }]);
	expect(starts).toBe(2);
});

test("preserves input and blocks native fallback when Magic recovery fails", async () => {
	const handlers: Handlers = new Map();
	const api = apiFor(handlers);
	let shouldFail = false;
	piStuffContext(api, {
		loadMagicContext: async () => ({
			default: async (pi: ExtensionAPI) => {
				// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
				const register = pi.on.bind(pi) as (event: string, handler: Handler) => void;
				register("context", (event) => {
					if (shouldFail) return;
					// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
					const contextEvent = event as { messages: unknown[] };
					return {
						messages: [taggedMessage("<session-history>healthy</session-history>"), ...contextEvent.messages],
					};
				});
				register("session_before_compact", () => ({ cancel: true }));
			},
		}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	expect(await emitResults(handlers, "session_before_compact", {}, ctx)).toEqual([{ cancel: true }]);

	shouldFail = true;
	const original = { type: "context", messages: [taggedMessage("native")] };
	expect(await emitResults(handlers, "context", original, ctx)).toEqual([undefined]);
	expect(getContextCapability(ctx).status().state).toBe("degraded");
	expect(await emitResults(handlers, "session_before_compact", {}, ctx)).toEqual([{ cancel: true }]);

	expect(ctx.signal?.aborted).toBe(true);
});

test("keeps Magic ownership under extreme estimated pressure without proactive compaction", async () => {
	const handlers: Handlers = new Map();
	let compactionResults: unknown[] = [];
	let compactions = 0;
	let projections = 0;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
				const register = magicApi.on.bind(magicApi) as (event: string, handler: Handler) => void;
				register("context", (event) => {
					projections++;
					// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
					const contextEvent = event as { messages: unknown[] };
					return {
						messages: [taggedMessage("<session-history>managed</session-history>"), ...contextEvent.messages],
					};
				});
				register("session_before_compact", () => ({ cancel: true }));
			},
		}),
		prepareMagicContext: async () => "ready",
		readNativeCompactionSettings: () => ({ enabled: true, reserveTokens: 20_000 }),
	});
	let tokens = 400_001;
	const ctx = Object.assign(context(), {
		compact: (options: CompactOptions) => {
			compactions++;
			void emitResults(handlers, "session_before_compact", {}, ctx).then((results) => {
				compactionResults = results;
				tokens = 1_000;
				options.onComplete?.(COMPACTION_RESULT);
			});
		},
		getContextUsage: () => ({ contextWindow: 200_000, percent: (tokens / 200_000) * 100, tokens }),
	});
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	expect(compactions).toBe(0);
	expect(compactionResults).toEqual([]);
	expect(getContextCapability(ctx).status().state).toBe("active");
	expect(projections).toBe(0);

	await emitResults(handlers, "context", { type: "context", messages: [taggedMessage("native")] }, ctx);
	expect(getContextCapability(ctx).status().state).toBe("active");
	expect(projections).toBe(1);
});

test("isolates optional turn-handler failures without tearing down Magic", async () => {
	const handlers: Handlers = new Map();
	let attempts = 0;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				attempts++;
				const attempt = attempts;
				magicApi.on("context", (event) => event);
				magicApi.on("before_agent_start", () => {
					if (attempt === 1) throw new Error("turn startup failed");
				});
			},
		}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	expect(getContextCapability(ctx).status()).toMatchObject({
		engine: "magic-context",
		state: "active",
	});

	await emit(handlers, "input", { type: "input", text: "retry", source: "rpc" }, ctx);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	expect(attempts).toBe(1);
	expect(getContextCapability(ctx).status().state).toBe("active");
});

test("ignores a stale Magic compaction result after shutdown", async () => {
	const handlers: Handlers = new Map();
	const { promise: compactionGate, resolve: releaseCompaction } = Promise.withResolvers<void>();
	const { promise: compactionEntered, resolve: markCompactionEntered } = Promise.withResolvers<void>();
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				magicApi.on("context", (event) => event);
				magicApi.on("session_before_compact", async () => {
					markCompactionEntered?.();
					await compactionGate;
					return { cancel: true };
				});
			},
		}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	const compaction = emitResults(handlers, "session_before_compact", {}, ctx);
	await compactionEntered;
	const shutdown = emit(handlers, "session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
	releaseCompaction?.();

	expect(await compaction).toEqual([{ cancel: true }]);
	await shutdown;
});

test("does not fabricate a manual compaction summary from a cancellation", async () => {
	const handlers: Handlers = new Map();
	const api = apiFor(handlers);
	piStuffContext(api, {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				magicApi.on("context", (event) => ({
					messages: [taggedMessage("<session-history>healthy</session-history>"), ...event.messages],
				}));
				magicApi.on("session_before_compact", () => ({ cancel: true }));
			},
		}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await emit(handlers, "input", { type: "input", text: "direct", source: "rpc" }, ctx);

	const result = await emitResults(
		handlers,
		"session_before_compact",
		{
			preparation: { firstKeptEntryId: "keep-this", tokensBefore: 42_000 },
			reason: "manual",
			signal: new AbortController().signal,
			type: "session_before_compact",
		},
		ctx,
	);

	expect(result).toEqual([{ cancel: true }]);
});

test("does not stack native compaction after the Magic compaction hook throws", async () => {
	const handlers: Handlers = new Map();
	const api = apiFor(handlers);
	piStuffContext(api, {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				magicApi.on("context", (event) => ({
					messages: [taggedMessage("<session-history>healthy</session-history>"), ...event.messages],
				}));
				magicApi.on("session_before_compact", () => {
					throw new Error("context store unavailable");
				});
			},
		}),
	});
	const notifications: string[] = [];
	const ctx = createExtensionCommandContext({
		...context(),
		ui: { notify: (message: string) => notifications.push(message) },
	});
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await emit(handlers, "input", { type: "input", text: "direct", source: "rpc" }, ctx);

	expect(
		await emitResults(
			handlers,
			"session_before_compact",
			{
				preparation: { firstKeptEntryId: "keep-this", tokensBefore: 42_000 },
				reason: "manual",
				signal: new AbortController().signal,
			},
			ctx,
		),
	).toEqual([{ cancel: true }]);
	expect(getContextCapability(ctx).status()).toMatchObject({
		engine: "magic-context",
		error: "context store unavailable",
		state: "degraded",
	});
	expect(notifications).toHaveLength(1);
	expect(notifications[0]).toContain("Session and current input are preserved");
});
