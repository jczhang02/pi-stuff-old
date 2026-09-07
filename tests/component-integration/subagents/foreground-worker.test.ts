import { expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { INTERRUPT_SIGNAL } from "../../../packages/pi-stuff/src/subagents/src/runs/background/control-channel.ts";
import { createInitialStatus } from "../../../packages/pi-stuff/src/subagents/src/runs/background/initial-status.ts";
import { initializeWriterProcessRegistry } from "../../../packages/pi-stuff/src/subagents/src/runs/background/writer-process-registry.ts";
import { runForegroundConfig } from "../../../packages/pi-stuff/src/subagents/src/runs/foreground/execution.ts";
import { runForegroundWorker } from "../../../packages/pi-stuff/src/subagents/src/runs/foreground/worker.ts";
import type { BackgroundRunnerConfig } from "../../../packages/pi-stuff/src/subagents/src/runs/shared/parallel-utils.ts";

let callerEngineCalls = 0;
mock.module("../../../packages/pi-stuff/src/subagents/src/runs/background/subagent-runner.ts", () => {
	return {
		runConfiguredBackground() {
			callerEngineCalls += 1;
			throw new Error("The shared child engine must not execute in Pi's UI thread.");
		},
	};
});

test("foreground execution isolates the shared engine and preserves committed startup state", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-foreground-worker-"));
	const NativeWorker = globalThis.Worker;
	const signalListeners = process.listenerCount(INTERRUPT_SIGNAL);
	let workerClosed = false;
	globalThis.Worker = class extends NativeWorker {
		constructor(...args: ConstructorParameters<typeof NativeWorker>) {
			super(...args);
			this.addEventListener(
				"close",
				() => {
					workerClosed = true;
				},
				{ once: true },
			);
		}
	};
	try {
		const asyncDir = join(root, "isolated-foreground");
		await mkdir(asyncDir, { mode: 0o700 });
		const config: BackgroundRunnerConfig = {
			version: 2,
			id: "isolated-foreground",
			cwd: root,
			asyncDir,
			resultPath: join(asyncDir, "completion.json"),
			work: { mode: "parallel", group: { tasks: [], concurrency: 1, worktree: false } },
		};
		const initial = createInitialStatus(config, Date.now() - 1_000);
		initializeWriterProcessRegistry(asyncDir, config.id, process.pid, 0);
		const observed: number[] = [];
		const result = await Effect.runPromise(
			runForegroundConfig(config, undefined, { onStatus: (status) => observed.push(status.startedAt) }, initial),
		);
		// An empty group deliberately launches no child; the real runner still settles its files and status.
		expect(result.details.results).toEqual([]);
		expect(observed.length).toBeGreaterThan(0);
		expect(observed.every((startedAt) => startedAt === initial.startedAt)).toBeTrue();
		expect(callerEngineCalls).toBe(0);
		expect(workerClosed).toBeTrue();
		expect(process.listenerCount(INTERRUPT_SIGNAL)).toBe(signalListeners);
	} finally {
		globalThis.Worker = NativeWorker;
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);

for (const outcome of ["failure", "interruption"] as const) {
	test(`foreground Worker releases process listeners after ${outcome}`, async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-stuff-foreground-release-"));
		const NativeWorker = globalThis.Worker;
		const signalListeners = process.listenerCount(INTERRUPT_SIGNAL);
		const posted = Promise.withResolvers<void>();
		let workerClosed = false;
		globalThis.Worker = class extends NativeWorker {
			constructor(...args: ConstructorParameters<typeof NativeWorker>) {
				super(...args);
				this.addEventListener("close", () => {
					workerClosed = true;
				});
			}
			override postMessage(): void {
				posted.resolve();
				if (outcome === "failure") throw new Error("Injected Worker request failure");
			}
		};
		try {
			const config: BackgroundRunnerConfig = {
				version: 2,
				id: "foreground-release",
				cwd: root,
				asyncDir: root,
				resultPath: join(root, "completion.json"),
				work: { mode: "parallel", group: { tasks: [], concurrency: 1, worktree: false } },
			};
			const fiber = Effect.runFork(runForegroundWorker(config, () => {}));
			await posted.promise;
			if (outcome === "failure") {
				await expect(Effect.runPromise(Fiber.join(fiber))).rejects.toThrow("Injected Worker request failure");
			} else {
				expect(process.listenerCount(INTERRUPT_SIGNAL)).toBe(signalListeners + 1);
				await Effect.runPromise(Fiber.interrupt(fiber));
			}
			expect(workerClosed).toBeTrue();
			expect(process.listenerCount(INTERRUPT_SIGNAL)).toBe(signalListeners);
		} finally {
			globalThis.Worker = NativeWorker;
			await rm(root, { recursive: true, force: true });
		}
	}, 15_000);
}

test("foreground interruption reaps writers after execution release and records owner exit", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-foreground-interrupt-"));
	try {
		const asyncDir = join(root, "interrupted-foreground");
		await mkdir(asyncDir, { mode: 0o700 });
		const config: BackgroundRunnerConfig = {
			version: 2,
			id: "interrupted-foreground",
			cwd: root,
			asyncDir,
			resultPath: join(asyncDir, "completion.json"),
			work: { mode: "parallel", group: { tasks: [], concurrency: 1, worktree: false } },
		};
		await writeFile(join(asyncDir, "status.json"), JSON.stringify(createInitialStatus(config, Date.now())));
		const entered = Promise.withResolvers<void>();
		const events: string[] = [];
		const fiber = Effect.runFork(
			runForegroundConfig(config, undefined, {
				runConfigured: () =>
					Effect.sync(() => entered.resolve()).pipe(
						Effect.andThen(Effect.never),
						Effect.ensuring(
							Effect.sync(() => {
								events.push("released");
							}),
						),
					),
				reapWriters: () =>
					Effect.sync(() => {
						events.push("reaped");
						return { remaining: 0, terminated: 1 };
					}),
			}),
		);
		await entered.promise;
		await Effect.runPromise(Fiber.interrupt(fiber));
		expect(events).toEqual(["released", "reaped"]);
		expect(JSON.parse(await readFile(join(asyncDir, ".foreground-owner-ended.json"), "utf8"))).toMatchObject({
			runId: config.id,
		});
		expect(JSON.parse(await readFile(join(asyncDir, "status.json"), "utf8"))).toMatchObject({ state: "failed" });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
