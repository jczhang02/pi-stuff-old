import { fileURLToPath, pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import type { AsyncStatus } from "../../shared/types.ts";
import { INTERRUPT_SIGNAL, requestAsyncInterrupt } from "../background/control-channel.ts";
import type { BackgroundRunnerStatus } from "../background/initial-status.ts";
import type { BackgroundRunnerConfig } from "../shared/parallel-utils.ts";
import type { ForegroundWorkerMessage, ForegroundWorkerRequest } from "./worker-entry.ts";

function workerError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

async function startForegroundWorker() {
	// The compiled Host cannot resolve the source dependency graph inside a Worker.
	// Preserve each source URL for child Extensions, the writer supervisor and SDK assets.
	const build = await Bun.build({
		entrypoints: [fileURLToPath(new URL("./worker-entry.ts", import.meta.url))],
		target: "bun",
		format: "esm",
		plugins: [
			{
				name: "foreground-source-locations",
				setup(builder) {
					// Pi's Jiti loader resolves the Package graph; the compiled Bun resolver cannot always do so.
					builder.onResolve({ filter: /^effect\// }, ({ path }) => ({
						path: fileURLToPath(import.meta.resolve(path)),
					}));
					builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async ({ path }) => {
						const source = await Bun.file(path).text();
						if (!source.includes("import.meta")) return undefined;
						const transpiler = new Bun.Transpiler({
							loader: path.endsWith(".ts") ? "ts" : "js",
							define: { "import.meta.url": JSON.stringify(pathToFileURL(path).href) },
						});
						return { contents: await transpiler.transform(source), loader: "js" };
					});
				},
			},
		],
	}).catch((cause: unknown) => {
		const detail = cause instanceof AggregateError ? cause.errors.map(String).join("; ") : workerError(cause).message;
		throw new Error(`Foreground Worker build failed: ${detail}`, { cause });
	});
	const output = build.outputs[0];
	if (!build.success || build.outputs.length !== 1 || !output) {
		throw new Error(
			`Foreground Worker build failed: ${build.logs.map((log) => log.message).join("; ") || "no output"}`,
		);
	}
	const url = URL.createObjectURL(output);
	try {
		const worker = new Worker(url, { name: "pi-stuff-foreground-agent", type: "module" });
		const closed = new Promise<void>((resolve) => {
			worker.addEventListener("close", () => resolve(), { once: true });
		});
		return { worker, url, closed };
	} catch (error) {
		URL.revokeObjectURL(url);
		throw error;
	}
}

/** The run's existing stop channel, writer identities and completion files remain authoritative. */
export function runForegroundWorker(
	config: BackgroundRunnerConfig,
	onStatus: (status: AsyncStatus) => void,
	committedStatus?: BackgroundRunnerStatus,
): Effect.Effect<void, Error> {
	return Effect.scoped(
		Effect.acquireRelease(
			Effect.tryPromise({ try: startForegroundWorker, catch: workerError }),
			({ worker, url, closed }) =>
				Effect.promise(async () => {
					try {
						worker.terminate();
						await closed;
					} finally {
						URL.revokeObjectURL(url);
					}
				}),
		).pipe(
			Effect.flatMap(({ worker }) =>
				Effect.callback<void, Error>((resume) => {
					// Process signals reach Pi's main thread, not its Worker. Keep the inbox authoritative.
					const interrupt = () => {
						try {
							requestAsyncInterrupt(config.asyncDir, { source: "foreground-owner-signal" });
						} catch (error) {
							finish(Effect.fail(workerError(error)));
						}
					};
					const closed = () => finish(Effect.fail(new Error("Foreground Worker closed before completion.")));
					const release = Effect.sync(() => {
						process.off(INTERRUPT_SIGNAL, interrupt);
						worker.onmessage = null;
						worker.onerror = null;
						worker.onmessageerror = null;
						worker.removeEventListener("close", closed);
					});
					const finish = (result: Effect.Effect<void, Error>) => resume(result.pipe(Effect.ensuring(release)));
					process.on(INTERRUPT_SIGNAL, interrupt);
					worker.onmessage = ({ data }: MessageEvent<ForegroundWorkerMessage>) => {
						if (data.type === "status") onStatus(data.status);
						else finish(data.type === "complete" ? Effect.void : Effect.fail(new Error(data.message)));
					};
					worker.onerror = (event) => {
						event.preventDefault();
						finish(Effect.fail(new Error(event.message || "Foreground Worker crashed.")));
					};
					worker.onmessageerror = () =>
						finish(Effect.fail(new Error("Foreground Worker returned an unreadable message.")));
					worker.addEventListener("close", closed);
					try {
						const workerConfig = { piExecutable: process.execPath, ...config };
						if (!workerConfig.piArgv1 && process.argv[1]) workerConfig.piArgv1 = process.argv[1];
						worker.postMessage({
							ownerPid: process.pid,
							config: workerConfig,
							committedStatus,
						} satisfies ForegroundWorkerRequest);
					} catch (error) {
						finish(Effect.fail(workerError(error)));
					}
					return release;
				}),
			),
		),
	);
}
