import { afterEach, expect, test } from "bun:test";
import {
	apiFor,
	cleanupContextCoreFixtures,
	context,
	type ExtensionAPI,
	emit,
	getContextCapability,
	type Handler,
	type Handlers,
	isRuntimeObject,
	magicModule,
	piStuffContext,
} from "../../context/core-fixtures.js";

afterEach(cleanupContextCoreFixtures);

test("awaits startup activation before compaction can run", async () => {
	const handlers: Handlers = new Map();
	const sequence: string[] = [];
	const { promise: loadGate, resolve: releaseLoad } = Promise.withResolvers<void>();
	const { promise: loadEntered, resolve: markLoadEntered } = Promise.withResolvers<void>();
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => {
			sequence.push("loading");
			markLoadEntered?.();
			await loadGate;
			return {
				default: async (pi: ExtensionAPI) => {
					// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
					const register = pi.on.bind(pi) as (event: string, handler: Handler) => void;
					register("context", (event) => (isRuntimeObject(event) && event !== null ? event : undefined));
					register("session_before_compact", () => {
						sequence.push("magic-compaction");
						return { cancel: true };
					});
				},
			};
		},
	});
	const ctx = context();
	const startup = emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await loadEntered;
	expect(getContextCapability(ctx).status().state).toBe("loading");
	expect(sequence).toEqual(["loading"]);
	const compaction = emit(handlers, "session_before_compact", { type: "session_before_compact" }, ctx);
	await Promise.resolve();
	releaseLoad?.();
	await Promise.all([startup, compaction]);
	expect(sequence).toEqual(["loading", "magic-compaction"]);
});

test("late startup activation after shutdown stays native and runs staged cleanup", async () => {
	const handlers: Handlers = new Map();
	const { promise: factoryGate, resolve: releaseFactory } = Promise.withResolvers<void>();
	const { promise: factoryEntered, resolve: markFactoryEntered } = Promise.withResolvers<void>();
	let cleanupRuns = 0;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				markFactoryEntered?.();
				await factoryGate;
				magicApi.on("context", (event) => event);
				magicApi.on("session_start", () => {
					startupRuns++;
				});
				magicApi.on("session_shutdown", () => {
					cleanupRuns++;
				});
			},
		}),
	});
	const ctx = context();
	let startupRuns = 0;
	const activating = emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await factoryEntered;
	let shutdownSettled = false;
	const shutdown = emit(handlers, "session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx).then(() => {
		shutdownSettled = true;
	});
	await Promise.resolve();
	expect(shutdownSettled).toBe(false);
	releaseFactory?.();
	await Promise.all([activating, shutdown]);

	expect(shutdownSettled).toBe(true);
	expect(getContextCapability(ctx).status()).toEqual({ state: "native", engine: "native" });
	expect(handlers.get("context")).toHaveLength(1);
	expect(startupRuns).toBe(0);
	expect(cleanupRuns).toBe(1);
});

test("late deferred preparation cannot revive a disposed runtime", async () => {
	const handlers: Handlers = new Map();
	const { promise: preparationGate, resolve: releasePreparation } = Promise.withResolvers<void>();
	const { promise: preparationEntered, resolve: markPreparationEntered } = Promise.withResolvers<void>();
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => magicModule(),
		prepareMagicContext: async () => {
			markPreparationEntered?.();
			await preparationGate;
			return "deferred";
		},
	});
	const ctx = context();
	const activating = emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await preparationEntered;
	const capability = getContextCapability(ctx);
	const shutdown = emit(handlers, "session_shutdown", { type: "session_shutdown", reason: "reload" }, ctx);
	releasePreparation?.();
	await Promise.all([activating, shutdown]);

	expect(capability.status()).toEqual({ state: "native", engine: "native", trigger: "startup" });
});

test("does not let a non-cooperative Magic cleanup own Host shutdown", async () => {
	const handlers: Handlers = new Map();
	let cleanupStarted = false;
	let siblingCleanupStarted = false;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				magicApi.on("context", (event) => event);
				magicApi.on("session_shutdown", async () => {
					cleanupStarted = true;
					await new Promise(() => undefined);
				});
				magicApi.on("session_shutdown", () => {
					siblingCleanupStarted = true;
				});
			},
		}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const startedAt = performance.now();
	await emit(handlers, "session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

	expect(cleanupStarted).toBeTrue();
	expect(siblingCleanupStarted).toBeTrue();
	expect(performance.now() - startedAt).toBeLessThan(1_000);
	expect(getContextCapability(ctx).status()).toEqual({ state: "native", engine: "native" });
});

test("does not mix concurrent session starts across activation contexts", async () => {
	const handlers: Handlers = new Map();
	const { promise: loadGate, resolve: releaseLoad } = Promise.withResolvers<void>();
	const observed: Array<{ reason: unknown; sessionId: string | undefined }> = [];
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => {
			await loadGate;
			return {
				default: async (magicApi: ExtensionAPI) => {
					magicApi.on("context", (event) => event);
					magicApi.on("session_start", (event, ctx) => {
						observed.push({
							// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
							reason: (event as { readonly reason?: unknown }).reason,
							sessionId: ctx.sessionManager.getSessionId(),
						});
					});
				},
			};
		},
	});
	const firstCtx = context([], "/workspace/first", "session-first");
	const secondCtx = context([], "/workspace/second", "session-second");
	const first = emit(handlers, "session_start", { type: "session_start", reason: "startup" }, firstCtx);
	await Promise.resolve();
	const second = emit(handlers, "session_start", { type: "session_start", reason: "switch" }, secondCtx);
	releaseLoad?.();
	await Promise.all([first, second]);

	expect(observed).toEqual([
		{ reason: "startup", sessionId: "session-first" },
		{ reason: "switch", sessionId: "session-second" },
	]);
	expect(getContextCapability(firstCtx).status()).toEqual({ state: "native", engine: "native" });
	expect(getContextCapability(secondCtx).status().state).toBe("active");
});

test("serializes concurrent session starts after Magic is active", async () => {
	const handlers: Handlers = new Map();
	const { promise: firstGate, resolve: releaseFirst } = Promise.withResolvers<void>();
	const { promise: firstEntered, resolve: markFirstEntered } = Promise.withResolvers<void>();
	const order: string[] = [];
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				magicApi.on("context", (event) => event);
				magicApi.on("session_start", async (event) => {
					// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
					const reason = String((event as { readonly reason?: unknown }).reason);
					order.push(`${reason}:start`);
					if (reason === "first") {
						markFirstEntered?.();
						await firstGate;
					}
					order.push(`${reason}:end`);
				});
			},
		}),
	});
	const initialCtx = context([], "/workspace/initial", "session-initial");
	await emit(handlers, "session_start", { type: "session_start", reason: "initial" }, initialCtx);
	order.length = 0;

	const firstCtx = context([], "/workspace/first", "session-first");
	const secondCtx = context([], "/workspace/second", "session-second");
	const first = emit(handlers, "session_start", { type: "session_start", reason: "first" }, firstCtx);
	await firstEntered;
	const second = emit(handlers, "session_start", { type: "session_start", reason: "second" }, secondCtx);
	await Promise.resolve();
	expect(order).toEqual(["first:start"]);
	releaseFirst?.();
	await Promise.all([first, second]);

	expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
});

test("waits for failed-session cleanup before starting a replacement", async () => {
	const handlers: Handlers = new Map();
	let factories = 0;
	const { promise: cleanupGate, resolve: releaseCleanup } = Promise.withResolvers<void>();
	const { promise: cleanupEntered, resolve: markCleanupEntered } = Promise.withResolvers<void>();
	const order: string[] = [];
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (magicApi: ExtensionAPI) => {
				factories++;
				const factory = factories;
				magicApi.on("context", (event) => event);
				magicApi.on("session_start", (event) => {
					// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
					if (factory === 1 && (event as { readonly reason?: unknown }).reason === "fail") {
						throw new Error("startup failed");
					}
					order.push(`factory-${String(factory)}:start`);
				});
				magicApi.on("session_shutdown", async () => {
					if (factory !== 1) return;
					order.push("cleanup:start");
					markCleanupEntered?.();
					await cleanupGate;
					order.push("cleanup:end");
				});
			},
		}),
	});
	const initialCtx = context([], "/workspace/initial", "session-initial");
	await emit(handlers, "session_start", { type: "session_start", reason: "initial" }, initialCtx);
	order.length = 0;

	const failedCtx = context([], "/workspace/failed", "session-failed");
	const replacementCtx = context([], "/workspace/replacement", "session-replacement");
	const failed = emit(handlers, "session_start", { type: "session_start", reason: "fail" }, failedCtx);
	await cleanupEntered;
	expect(order).toEqual(["cleanup:start"]);
	const replacement = emit(
		handlers,
		"session_start",
		{ type: "session_start", reason: "replacement" },
		replacementCtx,
	);
	await Promise.resolve();
	expect(factories).toBe(1);
	releaseCleanup?.();
	await Promise.all([failed, replacement]);

	expect(order).toEqual(["cleanup:start", "cleanup:end", "factory-2:start"]);
	expect(getContextCapability(replacementCtx).status().state).toBe("active");
});

test("reuses one runtime when the same Host loads Context twice", async () => {
	const handlers: Handlers = new Map();
	const api = apiFor(handlers);
	let firstLoads = 0;
	let secondLoads = 0;
	piStuffContext(api, {
		loadMagicContext: async () => {
			firstLoads++;
			return magicModule();
		},
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);
	await emit(handlers, "input", { type: "input", text: "direct", source: "rpc" }, ctx);
	await emit(handlers, "before_agent_start", { type: "before_agent_start" }, ctx);
	piStuffContext(api, {
		loadMagicContext: async () => {
			secondLoads++;
			return magicModule();
		},
	});

	expect(firstLoads).toBe(1);
	expect(secondLoads).toBe(0);
	expect(handlers.get("context")).toHaveLength(1);
	expect(getContextCapability(ctx).status().state).toBe("active");
});
