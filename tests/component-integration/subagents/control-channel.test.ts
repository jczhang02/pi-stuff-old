import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import {
	consumeStopRequests,
	deliverInterruptRequest,
	interruptRequestPath,
	requestAsyncInterrupt,
	requestAsyncStop,
	stopRequestPath,
	watchAsyncControlInbox,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/control-channel.js";

const roots = new Set<string>();

afterEach(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	roots.clear();
});

function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-control-channel-"));
	roots.add(root);
	return root;
}

describe("Agent stop control channel", () => {
	test("queues concurrent targeted stops without overwriting either request", () => {
		const asyncDir = fixture();
		const firstPath = requestAsyncStop(asyncDir, { targetIndex: 0 }, { now: () => 1_000, randomId: () => "a" });
		const secondPath = requestAsyncStop(asyncDir, { targetIndex: 1 }, { now: () => 1_000, randomId: () => "b" });

		expect(firstPath).not.toBe(secondPath);
		expect(consumeStopRequests(asyncDir).map((request) => request.targetIndex)).toEqual([0, 1]);
		expect(consumeStopRequests(asyncDir)).toEqual([]);
	});

	test("accepts a valid legacy whole-run stop", () => {
		const asyncDir = fixture();
		fs.mkdirSync(path.dirname(stopRequestPath(asyncDir)), { recursive: true });
		fs.writeFileSync(stopRequestPath(asyncDir), JSON.stringify({ type: "stop", source: "legacy" }), "utf-8");

		expect(consumeStopRequests(asyncDir)).toEqual([{ type: "stop", source: "legacy" }]);
	});

	test("ignores malformed stop input instead of broadening it to a whole-run stop", () => {
		const asyncDir = fixture();
		fs.mkdirSync(path.dirname(stopRequestPath(asyncDir)), { recursive: true });
		fs.writeFileSync(stopRequestPath(asyncDir), JSON.stringify({ type: "stop", targetIndex: -1 }), "utf-8");

		expect(consumeStopRequests(asyncDir)).toEqual([]);
		expect(fs.existsSync(stopRequestPath(asyncDir))).toBeFalse();
	});

	test("replays a stop after a consumer dies between durable claim and callback", async () => {
		const asyncDir = fixture();
		const requestPath = requestAsyncStop(asyncDir, { targetIndex: 3 }, { now: () => 1_000, randomId: () => "crash" });
		const received: number[] = [];
		const crashed = Effect.runFork(
			Effect.scoped(
				watchAsyncControlInbox(asyncDir, {
					onInterrupt: () => {},
					onStop: (request) => received.push(request.targetIndex ?? -1),
					afterControlClaim: (kind) => {
						if (kind === "stop") throw new Error("injected crash after claim");
					},
					pollIntervalMs: 60_000,
				}).pipe(Effect.andThen(Effect.never)),
			),
		);
		await Effect.runPromise(Fiber.interrupt(crashed));

		expect(received).toEqual([]);
		expect(fs.existsSync(requestPath)).toBeFalse();
		expect(
			fs.readdirSync(path.dirname(requestPath)).some((entry) => entry.includes(".pi-stuff-inflight.")),
		).toBeTrue();

		const recovered = Effect.runFork(
			Effect.scoped(
				watchAsyncControlInbox(asyncDir, {
					onInterrupt: () => {},
					onStop: (request) => received.push(request.targetIndex ?? -1),
					pollIntervalMs: 60_000,
				}).pipe(Effect.andThen(Effect.never)),
			),
		);
		await Effect.runPromise(Fiber.interrupt(recovered));

		expect(received).toEqual([3]);
		expect(
			fs.readdirSync(path.dirname(requestPath)).some((entry) => entry.includes(".pi-stuff-inflight.")),
		).toBeFalse();
	});

	test("polling delivers durable stop and interrupt requests exactly once when fs.watch stays silent", async () => {
		const asyncDir = fixture();
		const silentDirectory = fixture();
		const silentWatch = new Proxy(fs.watch, {
			apply: () => fs.watch(silentDirectory, () => {}),
		});
		const received: number[] = [];
		let interrupts = 0;
		const watcher = Effect.runFork(
			Effect.scoped(
				watchAsyncControlInbox(asyncDir, {
					onInterrupt: () => {
						interrupts += 1;
					},
					onStop: (request) => received.push(request.targetIndex ?? -1),
					watch: silentWatch,
					pollIntervalMs: 5,
				}).pipe(Effect.andThen(Effect.never)),
			),
		);
		const requestPath = requestAsyncStop(asyncDir, { targetIndex: 4 }, { now: () => 1_000, randomId: () => "poll" });
		requestAsyncInterrupt(asyncDir, {}, { now: () => 1_000 });

		expect(received).toEqual([]);
		expect(interrupts).toBe(0);
		await Bun.sleep(20);
		expect(received).toEqual([4]);
		expect(interrupts).toBe(1);
		expect(fs.existsSync(requestPath)).toBeFalse();
		expect(fs.existsSync(interruptRequestPath(asyncDir))).toBeFalse();
		await Bun.sleep(20);
		expect(received).toEqual([4]);
		expect(interrupts).toBe(1);
		await Effect.runPromise(Fiber.interrupt(watcher));
	});
});

test("Agent interrupt delivery keeps its request after a signal failure", () => {
	const asyncDir = fixture();
	const signalError = Object.assign(new Error("signal denied"), { code: "EPERM" });

	expect(() =>
		deliverInterruptRequest({
			asyncDir,
			kill: () => {
				throw signalError;
			},
			pid: 42,
		}),
	).toThrow(signalError);
	expect(fs.existsSync(interruptRequestPath(asyncDir))).toBeTrue();
});
