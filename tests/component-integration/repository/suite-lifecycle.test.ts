import { expect, test } from "bun:test";
import {
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionEvent,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
	installSuiteSessionReadiness,
	markSuiteSessionReady,
	rejectSuiteSessionReadiness,
	whenSuiteSessionReady,
} from "../../../packages/pi-stuff/src/conversation-ui/suite-lifecycle.js";

type Handler = (event: ExtensionEvent, ctx: ExtensionContext) => object | undefined | Promise<object | undefined>;

function fakePi() {
	const handlers = new Map<string, Handler[]>();
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const pi = {
		events: {},
		on(name: string, handler: Handler) {
			const current = handlers.get(name) ?? [];
			current.push(handler);
			handlers.set(name, current);
		},
	} as ExtensionAPI;
	return { handlers, pi };
}

function context(sessionManager: ExtensionContext["sessionManager"]): ExtensionContext {
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	return { sessionManager } as ExtensionContext;
}

test("Suite readiness releases startup work only after later Capability initialization", async () => {
	const { handlers, pi } = fakePi();
	installSuiteSessionReadiness(pi);
	const order: string[] = [];
	let ready: Promise<boolean> | undefined;

	pi.on("session_start", (_event, ctx) => {
		order.push("goal-observed");
		ready = Effect.runPromise(whenSuiteSessionReady(pi, ctx)).then((value) => {
			order.push(`goal-released:${value}`);
			return value;
		});
	});
	pi.on("session_start", async () => {
		order.push("context-started");
		await Promise.resolve();
		order.push("context-ready");
	});
	pi.on("session_start", (_event, ctx) => {
		order.push("suite-marked");
		markSuiteSessionReady(pi, ctx);
	});

	const ctx = context(SessionManager.inMemory());
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ reason: "reload", type: "session_start" }, ctx);
	}

	expect(await ready).toBe(true);
	expect(order).toEqual(["goal-observed", "context-started", "context-ready", "suite-marked", "goal-released:true"]);
});

test("Suite readiness rejects stale startup generations and resolves shutdown waiters", async () => {
	const { handlers, pi } = fakePi();
	installSuiteSessionReadiness(pi);
	const start = handlers.get("session_start")?.[0];
	const shutdown = handlers.get("session_shutdown")?.[0];
	if (!start || !shutdown) throw new Error("Expected readiness lifecycle handlers");

	const first = context(SessionManager.inMemory());
	const second = context(SessionManager.inMemory());
	await start({ reason: "startup", type: "session_start" }, first);
	const staleReady = Effect.runPromise(whenSuiteSessionReady(pi, first));
	await start({ reason: "new", type: "session_start" }, second);
	expect(await staleReady).toBe(false);
	markSuiteSessionReady(pi, first);

	const currentReady = Effect.runPromise(whenSuiteSessionReady(pi, second));
	await shutdown({ reason: "reload", type: "session_shutdown" }, second);
	expect(await currentReady).toBe(false);
	expect(await Effect.runPromise(whenSuiteSessionReady(pi, second))).toBe(false);

	const third = context(SessionManager.inMemory());
	await start({ reason: "resume", type: "session_start" }, third);
	const resumedReady = Effect.runPromise(whenSuiteSessionReady(pi, third));
	markSuiteSessionReady(pi, third);
	expect(await resumedReady).toBe(true);
});

test("Suite readiness rejects startup work when final validation fails", async () => {
	const { handlers, pi } = fakePi();
	installSuiteSessionReadiness(pi);
	let ready: Promise<boolean> | undefined;
	pi.on("session_start", (_event, ctx) => {
		ready = Effect.runPromise(whenSuiteSessionReady(pi, ctx));
	});
	pi.on("session_start", (_event, ctx) => {
		rejectSuiteSessionReadiness(pi, ctx);
	});

	const ctx = context(SessionManager.inMemory());
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ reason: "startup", type: "session_start" }, ctx);
	}

	expect(await ready).toBe(false);
});

test("Suite readiness rejects when Pi catches an earlier Capability startup failure and continues", async () => {
	const { handlers, pi } = fakePi();
	const suiteApi = installSuiteSessionReadiness(pi);
	let ready: Promise<boolean> | undefined;
	suiteApi.on("session_start", (_event, ctx) => {
		ready = Effect.runPromise(whenSuiteSessionReady(pi, ctx));
	});
	suiteApi.on("session_start", () => {
		throw new Error("Capability startup failed");
	});
	pi.on("session_start", (_event, ctx) => {
		markSuiteSessionReady(pi, ctx);
	});

	const ctx = context(SessionManager.inMemory());
	const errors: unknown[] = [];
	for (const handler of handlers.get("session_start") ?? []) {
		try {
			await handler({ reason: "startup", type: "session_start" }, ctx);
		} catch (error) {
			errors.push(error);
		}
	}

	expect(errors).toHaveLength(1);
	expect(await ready).toBe(false);
});

test("standalone Capabilities have no aggregate Suite startup barrier", async () => {
	const { pi } = fakePi();
	expect(await Effect.runPromise(whenSuiteSessionReady(pi, context(SessionManager.inMemory())))).toBe(true);
});
