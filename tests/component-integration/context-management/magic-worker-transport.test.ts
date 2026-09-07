import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
	MAGIC_WORKER_PROTOCOL_VERSION,
	type MagicWorkerInvocationRequest,
	type MagicWorkerMessage,
	type MagicWorkerReadyMessage,
	type MagicWorkerRequest,
} from "../../../packages/pi-stuff/src/context-management/magic-worker-protocol.js";
import {
	type MagicWorkerPort,
	type MagicWorkerStarter,
	MagicWorkerTransport,
	startMagicWorkerFromBundle,
} from "../../../packages/pi-stuff/src/context-management/magic-worker-transport.js";
import { EffectFoundation } from "../../../packages/pi-stuff/src/shared/effect-foundation.js";

test("native Worker release waits for close and remains safe after exit", async () => {
	const handle = startMagicWorkerFromBundle(new Blob(["setInterval(() => {}, 1000);"]));
	let closed = false;
	handle.port.addEventListener("close", () => {
		closed = true;
	});
	await handle.release();
	expect(closed).toBeTrue();
	await handle.release();
});

class FakeMagicWorkerPort implements MagicWorkerPort {
	onerror: ((event: ErrorEvent) => void) | null = null;
	onmessage: ((event: MessageEvent<MagicWorkerMessage>) => void) | null = null;
	onmessageerror: ((event: MessageEvent) => void) | null = null;
	readonly messages: MagicWorkerRequest[] = [];
	refs = 0;
	referenced = false;
	unrefs = 0;
	private readonly closeListeners = new Set<(event: CloseEvent) => void>();
	private readonly onPost: (message: MagicWorkerRequest) => void;

	constructor(onPost: (message: MagicWorkerRequest) => void) {
		this.onPost = onPost;
	}

	addEventListener(type: "close", listener: (event: CloseEvent) => void): void {
		if (type === "close") this.closeListeners.add(listener);
	}

	postMessage(message: MagicWorkerRequest): void {
		this.messages.push(message);
		this.onPost(message);
	}

	ref(): void {
		this.refs += 1;
		this.referenced = true;
	}

	unref(): void {
		this.unrefs += 1;
		this.referenced = false;
	}

	reply(message: MagicWorkerMessage): void {
		queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: message })));
	}

	fail(message: string): void {
		queueMicrotask(() => this.onerror?.(new ErrorEvent("error", { message })));
	}

	exit(reason: string): void {
		queueMicrotask(() => {
			const event = new CloseEvent("close", { code: 1, reason });
			for (const listener of this.closeListeners) listener(event);
		});
	}
}

function ready(id: number): MagicWorkerReadyMessage {
	return {
		commands: [],
		events: [],
		id,
		protocolVersion: MAGIC_WORKER_PROTOCOL_VERSION,
		tools: [],
		type: "ready",
	};
}

function invalidReady(id: number): MagicWorkerMessage {
	// SAFETY: this fixture deliberately violates the external protocol version.
	return { ...ready(id), protocolVersion: MAGIC_WORKER_PROTOCOL_VERSION + 1 } as MagicWorkerMessage;
}

function command(id: number): MagicWorkerInvocationRequest {
	return {
		args: "",
		context: {
			contextUsage: undefined,
			cwd: "/project",
			hasUI: false,
			mode: "rpc",
			model: undefined,
			session: { id: "session", leafId: undefined },
			systemPrompt: "",
		},
		id,
		name: "ctx-status",
		type: "command",
	};
}

function transportHarness(port: FakeMagicWorkerPort, onFatal: (error: Error) => void = () => undefined) {
	let releases = 0;
	const start: MagicWorkerStarter = async () => ({
		port,
		release: async () => {
			releases += 1;
		},
	});
	return {
		get releases() {
			return releases;
		},
		transport: new MagicWorkerTransport({ onEffect: () => undefined, onFatal, onSyncEffect: () => undefined }, start),
	};
}

test("protocol mismatch fails startup and releases the native Worker", async () => {
	let port!: FakeMagicWorkerPort;
	port = new FakeMagicWorkerPort((message) => {
		if (message.type === "initialize") port.reply(invalidReady(message.id));
	});
	const harness = transportHarness(port);

	await expect(Effect.runPromise(Effect.scoped(harness.transport.initialize(1, [])))).rejects.toThrow(
		"does not match",
	);
	expect(harness.releases).toBe(1);
});

test("interruption after acquisition releases an unattached native Worker", async () => {
	const controller = new AbortController();
	let releases = 0;
	const port = new FakeMagicWorkerPort(() => undefined);
	const transport = new MagicWorkerTransport(
		{ onEffect: () => undefined, onFatal: () => undefined, onSyncEffect: () => undefined },
		async () => {
			controller.abort();
			return {
				port,
				release: async () => {
					releases += 1;
				},
			};
		},
	);

	const exit = await Effect.runPromiseExit(Effect.scoped(transport.initialize(1, [])), {
		signal: controller.signal,
	});
	expect(Exit.hasInterrupts(exit)).toBeTrue();
	expect(port.messages).toEqual([]);
	expect(releases).toBe(1);
});

test("success and Worker errors settle requests and clear Worker references", async () => {
	let port!: FakeMagicWorkerPort;
	port = new FakeMagicWorkerPort((message) => {
		if (message.type === "initialize") port.reply(ready(message.id));
		else if (message.type === "command" && message.id === 2) {
			port.reply({ id: message.id, type: "command-result" });
		} else if (message.type === "command") {
			port.reply({ error: "request failed", id: message.id, stack: undefined, type: "error" });
		}
	});
	const harness = transportHarness(port);
	const result = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* harness.transport.initialize(1, []);
				const success = yield* harness.transport.request(command(2));
				const failure = yield* Effect.exit(harness.transport.request(command(3)));
				return { failure, success };
			}),
		),
	);

	expect(result.success).toEqual({ id: 2, type: "command-result" });
	expect(Exit.hasFails(result.failure)).toBeTrue();
	expect(port.refs).toBe(3);
	expect(port.unrefs).toBe(3);
	expect(harness.releases).toBe(1);
});

test("request interruption emits protocol cancellation and removes the pending request", async () => {
	const requestPosted = Promise.withResolvers<void>();
	let port!: FakeMagicWorkerPort;
	port = new FakeMagicWorkerPort((message) => {
		if (message.type === "initialize") port.reply(ready(message.id));
		else if (message.type === "command") requestPosted.resolve();
	});
	const harness = transportHarness(port);
	const controller = new AbortController();
	const running = Effect.runPromiseExit(
		Effect.scoped(
			Effect.gen(function* () {
				yield* harness.transport.initialize(1, []);
				return yield* harness.transport.request(command(2));
			}),
		),
		{ signal: controller.signal },
	);
	await requestPosted.promise;
	controller.abort(new Error("cancelled"));
	const exit = await running;

	expect(Exit.hasInterrupts(exit)).toBeTrue();
	expect(port.messages).toContainEqual({ id: 2, type: "cancel" });
	expect(port.refs).toBe(2);
	expect(port.unrefs).toBe(2);
	expect(harness.releases).toBe(1);
});

test("a late reply after cancellation is ignored while the Worker stays active", async () => {
	const requestPosted = Promise.withResolvers<void>();
	const fatals: Error[] = [];
	let port!: FakeMagicWorkerPort;
	port = new FakeMagicWorkerPort((message) => {
		if (message.type === "initialize") port.reply(ready(message.id));
		else if (message.type === "command") requestPosted.resolve();
	});
	const harness = transportHarness(port, (error) => fatals.push(error));

	await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* harness.transport.initialize(1, []);
				const controller = new AbortController();
				const running = Effect.runPromiseExit(harness.transport.request(command(2)), {
					signal: controller.signal,
				});
				yield* Effect.promise(() => requestPosted.promise);
				controller.abort(new Error("cancelled"));
				expect(Exit.hasInterrupts(yield* Effect.promise(() => running))).toBeTrue();
				port.reply({ id: 2, type: "command-result" });
				yield* Effect.promise(() => Bun.sleep(0));
				expect(harness.transport.isActive()).toBeTrue();
			}),
		),
	);

	expect(fatals).toEqual([]);
	expect(port.messages).toContainEqual({ id: 2, type: "cancel" });
	expect(port.unrefs).toBe(2);
	expect(port.referenced).toBeFalse();
	expect(harness.releases).toBe(1);
});

test("one Worker exit rejects every concurrent request and reports one fatal", async () => {
	const fatals: Error[] = [];
	let commandsPosted = 0;
	let port!: FakeMagicWorkerPort;
	port = new FakeMagicWorkerPort((message) => {
		if (message.type === "initialize") port.reply(ready(message.id));
		else if (message.type === "command" && ++commandsPosted === 2) port.exit("worker exited");
	});
	const harness = transportHarness(port, (error) => fatals.push(error));

	const exits = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				yield* harness.transport.initialize(1, []);
				return yield* Effect.all(
					[Effect.exit(harness.transport.request(command(2))), Effect.exit(harness.transport.request(command(3)))],
					{ concurrency: "unbounded" },
				);
			}),
		),
	);

	expect(exits.every(Exit.hasFails)).toBeTrue();
	expect(fatals).toHaveLength(1);
	expect(fatals[0]?.message).toContain("worker exited");
	expect(port.refs).toBe(3);
	expect(port.unrefs).toBe(2);
	expect(port.referenced).toBeFalse();
	expect(harness.releases).toBe(1);
});

for (const failure of ["error", "exit"] as const) {
	test(`unexpected Worker ${failure} rejects pending work and reports fatal`, async () => {
		const fatals: Error[] = [];
		let port!: FakeMagicWorkerPort;
		port = new FakeMagicWorkerPort((message) => {
			if (message.type === "initialize") port.reply(ready(message.id));
			else if (message.type === "command") {
				if (failure === "error") port.fail("worker crashed");
				else port.exit("worker exited");
			}
		});
		const harness = transportHarness(port, (error) => fatals.push(error));

		await expect(
			Effect.runPromise(
				Effect.scoped(
					Effect.gen(function* () {
						yield* harness.transport.initialize(1, []);
						return yield* harness.transport.request(command(2));
					}),
				),
			),
		).rejects.toThrow(failure === "error" ? "worker crashed" : "worker exited");
		expect(fatals).toHaveLength(1);
		expect(port.unrefs).toBe(2);
		expect(harness.releases).toBe(1);
	});
}

test("a hung request and native Worker release stay bounded by their Capability Scope", async () => {
	const neverReleased = Promise.withResolvers<void>();
	const requestPosted = Promise.withResolvers<void>();
	let releases = 0;
	let port!: FakeMagicWorkerPort;
	port = new FakeMagicWorkerPort((message) => {
		if (message.type === "initialize") port.reply(ready(message.id));
		else if (message.type === "command") requestPosted.resolve();
	});
	const transport = new MagicWorkerTransport(
		{ onEffect: () => undefined, onFatal: () => undefined, onSyncEffect: () => undefined },
		async () => ({
			port,
			release: () => {
				releases += 1;
				return neverReleased.promise;
			},
		}),
	);
	const foundation = new EffectFoundation(10);
	await foundation.startSession();
	const capability = foundation.forkCapability();
	expect(Exit.isSuccess(await foundation.run(capability, transport.initialize(1, [])))).toBeTrue();
	const pending = foundation.run(foundation.forkOperation(capability), transport.request(command(2)));
	await requestPosted.promise;

	const startedAt = performance.now();
	expect(await foundation.close(capability, Exit.void, 10)).toBeFalse();
	expect(performance.now() - startedAt).toBeLessThan(250);
	expect(Exit.hasInterrupts(await pending)).toBeTrue();
	expect(port.messages).toContainEqual({ id: 2, type: "cancel" });
	expect(releases).toBe(1);
	await foundation.shutdown();
});
