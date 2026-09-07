import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type {
	ContextEvent,
	SessionEntry,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { writeMagicWorkerSyncResponse } from "../packages/pi-stuff/src/context-management/magic-worker-host.js";
import type {
	MagicWorkerContextSnapshot,
	MagicWorkerEventRequest,
	MagicWorkerInvocationRequest,
} from "../packages/pi-stuff/src/context-management/magic-worker-protocol.js";
import {
	buildMagicWorkerBundle,
	MagicWorkerTransport,
	startMagicWorkerFromBundle,
} from "../packages/pi-stuff/src/context-management/magic-worker-transport.js";
import { handleBenchmarkMeta } from "./benchmark-cli.js";
import { percentile, summarize } from "./lifecycle-benchmark-sampling.js";
import {
	type MagicContextBenchmarkCase as BenchmarkCase,
	MAGIC_CONTEXT_SAMPLE_SCHEMA,
	type MagicContextSample,
	numericMagicContextMetrics,
} from "./magic-context-benchmark-core.js";

const scriptPath = fileURLToPath(import.meta.url);
const root = resolve(dirname(scriptPath), "..");
const DEFAULT_OUTPUT = join(root, ".artifacts/magic-context-benchmark/latest.json");
const PACKAGE_MANIFEST_SCHEMA = Type.Object({
	dependencies: Type.Object({ "@cortexkit/pi-magic-context": Type.String({ minLength: 1 }) }),
});

interface EffectClock {
	firstEffectMs: number | null;
	startedAt: number | null;
}

const ZERO_USAGE = {
	cacheRead: 0,
	cacheWrite: 0,
	cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
	input: 0,
	output: 0,
	totalTokens: 0,
};

function round(value: number): number {
	return Number(value.toFixed(3));
}

function userMessage(text: string): UserMessage {
	return { content: [{ text, type: "text" }], role: "user", timestamp: Date.now() };
}

function assistantMessage(text: string): AssistantMessage {
	return {
		api: "openai-completions",
		content: [{ text, type: "text" }],
		model: "fixture-model",
		provider: "fixture",
		role: "assistant",
		stopReason: "stop",
		timestamp: Date.now(),
		usage: ZERO_USAGE,
	};
}

function messageEntry(id: string, parentId: string | null, message: AssistantMessage | UserMessage): SessionEntry {
	return { id, message, parentId, timestamp: new Date().toISOString(), type: "message" };
}

function branchFor(name: BenchmarkCase): SessionEntry[] {
	const count = name === "fresh" ? 1 : name === "short" ? 32 : name === "long" ? 500 : 32;
	const branch: SessionEntry[] = [];
	for (let index = 0; index < count; index += 1) {
		const id = `${name}-${String(index)}`;
		const parentId = branch.at(-1)?.id ?? null;
		const text = `${name} message ${String(index)} ${"context ".repeat(16)}`;
		branch.push(messageEntry(id, parentId, index % 2 === 0 ? userMessage(text) : assistantMessage(text)));
	}
	if (name === "malformed-image") {
		const id = `${name}-image`;
		branch.push(
			messageEntry(id, branch.at(-1)?.id ?? null, {
				content: [{ data: "%".repeat(4 * 1024 * 1024), mimeType: "image/png", type: "image" }],
				role: "user",
				timestamp: Date.now(),
			}),
		);
	}
	return branch;
}

function workerContext(sessionId: string, leafId: string | undefined): MagicWorkerContextSnapshot {
	return {
		contextUsage: { contextWindow: 128_000, percent: 0, tokens: 0 },
		cwd: root,
		hasUI: false,
		mode: "rpc",
		model: {
			api: "openai-completions",
			contextWindow: 128_000,
			id: "fixture-model",
			maxTokens: 4_096,
			provider: "fixture",
		},
		session: { id: sessionId, leafId },
		systemPrompt: "",
	};
}

function eventRequest(
	id: number,
	context: MagicWorkerContextSnapshot,
	event: ContextEvent | SessionShutdownEvent | SessionStartEvent,
): MagicWorkerEventRequest {
	switch (event.type) {
		case "context":
			return { context, event, id, name: "context", type: "event" };
		case "session_shutdown":
			return { context, event, id, name: "session_shutdown", type: "event" };
		case "session_start":
			return { context, event, id, name: "session_start", type: "event" };
	}
}

function measureCase(
	transport: MagicWorkerTransport,
	name: BenchmarkCase,
	clock: EffectClock,
	nextId: () => number,
): Effect.Effect<MagicContextSample["cases"][BenchmarkCase], Error> {
	return Effect.gen(function* () {
		const branch = branchFor(name);
		const sessionId = `benchmark-${name}`;
		const leafId = branch.at(-1)?.id;
		const context = workerContext(sessionId, leafId);
		clock.firstEffectMs = null;
		clock.startedAt = performance.now();
		transport.post({ branch, leafId, sessionId, type: "session-snapshot" });
		yield* transport.request(eventRequest(nextId(), context, { reason: "resume", type: "session_start" }));
		const fullSnapshotMs = round(performance.now() - clock.startedAt);
		const hostEffectMs = clock.firstEffectMs;
		const initialMessages = branch.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const firstProjectionStartedAt = performance.now();
		yield* transport.request(eventRequest(nextId(), context, { messages: initialMessages, type: "context" }));
		const firstProjectionMs = round(performance.now() - firstProjectionStartedAt);

		const incremental = messageEntry(
			`${name}-incremental`,
			leafId ?? null,
			assistantMessage(`${name} incremental leaf`),
		);
		const incrementalContext = workerContext(sessionId, incremental.id);
		const messages = [...branch, incremental].flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
		const incrementalStartedAt = performance.now();
		transport.post({ entry: incremental, leafId: incremental.id, sessionId, type: "session-entry" });
		yield* transport.request(eventRequest(nextId(), incrementalContext, { messages, type: "context" }));
		const incrementalLeafMs = round(performance.now() - incrementalStartedAt);
		yield* transport.request(
			eventRequest(nextId(), incrementalContext, { reason: "quit", type: "session_shutdown" }),
		);
		clock.startedAt = null;
		return { firstProjectionMs, fullSnapshotMs, hostEffectMs, incrementalLeafMs };
	});
}

function command(id: number, context: MagicWorkerContextSnapshot): MagicWorkerInvocationRequest {
	return { args: "", context, id, name: "ctx-status", type: "command" };
}

function measureQueue(
	transport: MagicWorkerTransport,
	nextId: () => number,
): Effect.Effect<MagicContextSample["queue"], Error> {
	return Effect.gen(function* () {
		const sessionId = "benchmark-queue";
		const branch = branchFor("fresh");
		const leafId = branch.at(-1)?.id;
		const context = workerContext(sessionId, leafId);
		transport.post({ branch, leafId, sessionId, type: "session-snapshot" });
		yield* transport.request(eventRequest(nextId(), context, { reason: "resume", type: "session_start" }));

		for (let index = 0; index < 3; index += 1) yield* transport.request(command(nextId(), context));
		const singles: number[] = [];
		const pairs: number[] = [];
		for (let index = 0; index < 5; index += 1) {
			const singleStartedAt = performance.now();
			yield* transport.request(command(nextId(), context));
			singles.push(performance.now() - singleStartedAt);
			const pairStartedAt = performance.now();
			yield* Effect.all(
				[transport.request(command(nextId(), context)), transport.request(command(nextId(), context))],
				{ concurrency: "unbounded" },
			);
			pairs.push(performance.now() - pairStartedAt);
		}
		const singleCommandMs = round(percentile(singles, 0.5));
		const parallelPairMs = round(percentile(pairs, 0.5));
		yield* transport.request(eventRequest(nextId(), context, { reason: "quit", type: "session_shutdown" }));
		return {
			estimatedQueueWaitMs: round(Math.max(0, parallelPairMs - singleCommandMs)),
			parallelPairMs,
			singleCommandMs,
		};
	});
}

async function packageVersion(): Promise<string> {
	const manifest: unknown = JSON.parse(await readFile(join(root, "packages", "pi-stuff", "package.json"), "utf8"));
	if (!Check(PACKAGE_MANIFEST_SCHEMA, manifest)) {
		throw new Error("Magic Context benchmark could not read the installed package version.");
	}
	return manifest.dependencies["@cortexkit/pi-magic-context"];
}

async function collectSample(): Promise<MagicContextSample> {
	const buildStartedAt = performance.now();
	const bundle = await buildMagicWorkerBundle();
	const workerBuildMs = round(performance.now() - buildStartedAt);
	let workerStartDurationMs: number | undefined;
	const clock: EffectClock = { firstEffectMs: null, startedAt: null };
	const transport = new MagicWorkerTransport(
		{
			onEffect: () => {
				if (clock.startedAt !== null && clock.firstEffectMs === null) {
					clock.firstEffectMs = round(performance.now() - clock.startedAt);
				}
			},
			onFatal: (error) => {
				throw error;
			},
			onSyncEffect: (message) => {
				writeMagicWorkerSyncResponse(message.buffer, 2, "Synchronous Host effects are outside this benchmark.");
			},
		},
		async () => {
			const workerStartedAt = performance.now();
			const handle = startMagicWorkerFromBundle(bundle);
			workerStartDurationMs = performance.now() - workerStartedAt;
			return handle;
		},
	);
	let id = 0;
	const nextId = (): number => {
		id += 1;
		return id;
	};
	const measured = await Effect.runPromise(
		Effect.scoped(
			Effect.gen(function* () {
				const initializeStartedAt = performance.now();
				const ready = yield* transport.initialize(nextId(), []);
				const initializeTotalMs = performance.now() - initializeStartedAt;
				if (workerStartDurationMs === undefined) {
					return yield* Effect.fail(new Error("Magic Context Worker start was not measured."));
				}
				const workerStartMs = round(workerStartDurationMs);
				const initializeAndTokenizerPreloadMs = round(initializeTotalMs - workerStartDurationMs);
				if (!ready.commands.some((registered) => registered.name === "ctx-status")) {
					return yield* Effect.fail(
						new Error(`Magic Context did not register ctx-status: ${JSON.stringify(ready)}`),
					);
				}
				const cases = {
					fresh: yield* measureCase(transport, "fresh", clock, nextId),
					short: yield* measureCase(transport, "short", clock, nextId),
					long: yield* measureCase(transport, "long", clock, nextId),
					"malformed-image": yield* measureCase(transport, "malformed-image", clock, nextId),
				};
				const queue = yield* measureQueue(transport, nextId);
				return { cases, initializeAndTokenizerPreloadMs, queue, workerStartMs };
			}),
		),
	);
	return {
		bundleBytes: bundle.size,
		packageVersion: await packageVersion(),
		workerBuildMs,
		...measured,
	};
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
	return value;
}

function nonNegativeInteger(raw: string | undefined, fallback: number, name: string): number {
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer.`);
	return value;
}

async function configureSample(rootDirectory: string): Promise<NodeJS.ProcessEnv> {
	const configDirectory = join(rootDirectory, "config", "cortexkit");
	await Promise.all([
		mkdir(configDirectory, { recursive: true }),
		mkdir(join(rootDirectory, "data"), { recursive: true }),
		mkdir(join(rootDirectory, "home"), { recursive: true }),
	]);
	await writeFile(
		join(configDirectory, "magic-context.jsonc"),
		`${JSON.stringify({
			dreamer: { disable: true },
			embedding: { provider: "off" },
			fail_closed_blocking: false,
			sidekick: { disable: true },
			toast_duration_ms: 0,
			todowrite: { enabled: false, overlay: false },
		})}\n`,
	);
	const environment: NodeJS.ProcessEnv = {
		...process.env,
		HF_HUB_OFFLINE: "1",
		HOME: join(rootDirectory, "home"),
		MAGIC_CONTEXT_LOG_PATH: join(rootDirectory, "magic-context.log"),
		MAGIC_CONTEXT_TEST_DATA_DIR: join(rootDirectory, "data"),
		PI_OFFLINE: "1",
		XDG_CACHE_HOME: join(rootDirectory, "cache"),
		XDG_CONFIG_HOME: join(rootDirectory, "config"),
		XDG_STATE_HOME: join(rootDirectory, "state"),
	};
	delete environment["XDG_DATA_HOME"];
	return environment;
}

async function runChildSample(directory: string, index: number): Promise<MagicContextSample> {
	const sampleDirectory = join(directory, `sample-${String(index)}`);
	const output = join(sampleDirectory, "sample.json");
	const env = await configureSample(sampleDirectory);
	const child = Bun.spawnSync([process.execPath, scriptPath, "--sample-output", output], {
		cwd: root,
		env,
		stderr: "pipe",
		stdout: "pipe",
	});
	if (child.exitCode !== 0) {
		const magicLog = await readFile(join(sampleDirectory, "magic-context.log"), "utf8").catch(
			() => "<Magic Context log unavailable>",
		);
		throw new Error(
			`Magic Context benchmark sample ${String(index)} failed:\n${child.stdout.toString()}\n${child.stderr.toString()}\n${magicLog}`,
		);
	}
	const sample: unknown = JSON.parse(await readFile(output, "utf8"));
	if (!Check(MAGIC_CONTEXT_SAMPLE_SCHEMA, sample)) {
		throw new Error(`Magic Context benchmark sample ${String(index)} returned an invalid report.`);
	}
	return sample;
}

async function runBenchmark(samples: number, warmups: number, output: string | undefined): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-magic-context-benchmark-"));
	try {
		const collected: MagicContextSample[] = [];
		for (let index = 0; index < warmups + samples; index += 1) {
			const sample = await runChildSample(directory, index);
			if (index >= warmups) collected.push(sample);
		}
		const first = collected[0];
		if (!first) throw new Error("Magic Context benchmark produced no measured samples.");
		const metricNames = [...numericMagicContextMetrics(first).keys()];
		const summaries = Object.fromEntries(
			metricNames.map((name) => [
				name,
				summarize(
					collected.map((sample) => {
						const value = numericMagicContextMetrics(sample).get(name);
						if (value === undefined) throw new Error(`Benchmark sample omitted ${name}.`);
						return value;
					}),
				),
			]),
		);
		const report = `${JSON.stringify(
			{
				packageVersion: first.packageVersion,
				raw: collected,
				samples,
				summaries,
				warmups,
			},
			null,
			2,
		)}\n`;
		if (output) {
			await mkdir(dirname(resolve(output)), { recursive: true });
			await writeFile(resolve(output), report);
		}
		process.stdout.write(report);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

handleBenchmarkMeta(process.argv.slice(2), "usage: benchmark:capability:magic-context [options]", [
	"worker-startup",
	"projection",
	"queue-settlement",
]);
const { values } = parseArgs({
	options: {
		output: { type: "string" },
		"sample-output": { type: "string" },
		samples: { type: "string" },
		warmups: { type: "string" },
	},
	strict: true,
});

const sampleOutput = values["sample-output"];
if (sampleOutput) {
	await mkdir(dirname(resolve(sampleOutput)), { recursive: true });
	await writeFile(resolve(sampleOutput), `${JSON.stringify(await collectSample())}\n`);
} else {
	await runBenchmark(
		positiveInteger(values.samples, 10, "--samples"),
		nonNegativeInteger(values.warmups, 3, "--warmups"),
		values.output ?? DEFAULT_OUTPUT,
	);
}
