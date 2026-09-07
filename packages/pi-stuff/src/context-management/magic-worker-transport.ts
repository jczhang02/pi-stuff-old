import { fileURLToPath } from "node:url";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type { JsonInputValue } from "../shared/json-value.ts";
import { magicWorkerError, magicWorkerErrorMessage } from "./magic-worker-host.ts";
import {
	MAGIC_WORKER_PROTOCOL_VERSION,
	type MagicWorkerEffectMessage,
	type MagicWorkerHostTool,
	type MagicWorkerInitializeRequest,
	type MagicWorkerInvocationRequest,
	type MagicWorkerMessage,
	type MagicWorkerReadyMessage,
	type MagicWorkerRequest,
	type MagicWorkerResultMessage,
	type MagicWorkerSyncEffectMessage,
} from "./magic-worker-protocol.ts";

export interface MagicWorkerPort {
	addEventListener(type: "close", listener: (event: CloseEvent) => void): void;
	onerror: ((event: ErrorEvent) => void) | null;
	onmessage: ((event: MessageEvent<MagicWorkerMessage>) => void) | null;
	onmessageerror: ((event: MessageEvent) => void) | null;
	postMessage(message: MagicWorkerRequest): void;
	ref(): void;
	unref(): void;
}

export interface MagicWorkerNativeHandle {
	readonly port: MagicWorkerPort;
	release(): Promise<void>;
}

export type MagicWorkerStarter = () => Promise<MagicWorkerNativeHandle>;

interface MagicWorkerTransportCallbacks {
	readonly onEffect: (message: MagicWorkerEffectMessage) => void;
	readonly onFatal: (error: Error) => void;
	readonly onSyncEffect: (message: MagicWorkerSyncEffectMessage) => void;
}

interface PendingRequest {
	readonly onUpdate: AgentToolUpdateCallback<JsonInputValue | undefined> | undefined;
	readonly resume: (effect: Effect.Effect<MagicWorkerReadyMessage | MagicWorkerResultMessage, Error>) => void;
	readonly stopCancellation: () => void;
}

type MagicWorkerReplyRequest = MagicWorkerInitializeRequest | MagicWorkerInvocationRequest;

function workerError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(magicWorkerErrorMessage(cause));
}

export async function buildMagicWorkerBundle(): Promise<Blob> {
	const magicContextUrl = import.meta.resolve("@cortexkit/pi-magic-context");
	const build = await Bun.build({
		define: { "import.meta.url": JSON.stringify(magicContextUrl) },
		entrypoints: [fileURLToPath(new URL("./magic-worker-entry.ts", import.meta.url))],
		format: "esm",
		target: "bun",
	});
	const output = build.outputs[0];
	if (!build.success || build.outputs.length !== 1 || !output) {
		throw new Error(
			`Magic Context worker build failed: ${build.logs.map((log) => log.message).join("; ") || "no executable output"}`,
		);
	}
	return output;
}

export function startMagicWorkerFromBundle(output: Blob): MagicWorkerNativeHandle {
	const workerUrl = URL.createObjectURL(output);
	try {
		const worker = new Worker(workerUrl, { name: "pi-stuff-magic-context", type: "module" });
		const closed = new Promise<void>((resolve) => {
			worker.addEventListener("close", () => resolve(), { once: true });
		});
		return {
			port: worker,
			async release() {
				try {
					worker.terminate();
					await closed;
				} finally {
					URL.revokeObjectURL(workerUrl);
				}
			},
		};
	} catch (error) {
		URL.revokeObjectURL(workerUrl);
		throw error;
	}
}

async function startMagicWorkerNative(): Promise<MagicWorkerNativeHandle> {
	return startMagicWorkerFromBundle(await buildMagicWorkerBundle());
}

/** Effect-owned request correlation over the native Bun Worker protocol. */
export class MagicWorkerTransport {
	private accepting = false;
	private readonly callbacks: MagicWorkerTransportCallbacks;
	private handle: MagicWorkerNativeHandle | undefined;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly start: MagicWorkerStarter;

	constructor(callbacks: MagicWorkerTransportCallbacks, start: MagicWorkerStarter = startMagicWorkerNative) {
		this.callbacks = callbacks;
		this.start = start;
	}

	isActive(): boolean {
		return this.accepting;
	}

	initialize(
		id: number,
		hostTools: readonly MagicWorkerHostTool[],
	): Effect.Effect<MagicWorkerReadyMessage, Error, Scope.Scope> {
		return Effect.acquireRelease(Effect.tryPromise({ try: () => this.start(), catch: workerError }), (handle) =>
			Effect.promise(() => this.release(handle)),
		).pipe(
			Effect.tap((handle) => Effect.sync(() => this.attach(handle))),
			Effect.flatMap(() =>
				this.request({
					hostTools,
					id,
					protocolVersion: MAGIC_WORKER_PROTOCOL_VERSION,
					type: "initialize",
				}),
			),
			Effect.flatMap((message) => {
				if (message.type !== "ready") {
					return Effect.fail(new Error("Magic Context worker returned an invalid initialization response."));
				}
				if (message.protocolVersion !== MAGIC_WORKER_PROTOCOL_VERSION) {
					return Effect.fail(
						new Error(
							`Magic Context worker protocol ${String(message.protocolVersion)} does not match ${String(MAGIC_WORKER_PROTOCOL_VERSION)}.`,
						),
					);
				}
				return Effect.succeed(message);
			}),
		);
	}

	request(
		request: MagicWorkerReplyRequest,
		onUpdate?: AgentToolUpdateCallback<JsonInputValue | undefined>,
	): Effect.Effect<MagicWorkerReadyMessage | MagicWorkerResultMessage, Error> {
		return Effect.callback((resume, signal) => {
			const port = this.handle?.port;
			if (!this.accepting || !port) {
				resume(Effect.fail(new Error("Magic Context worker is closed.")));
				return;
			}
			let posted = false;
			let cancelled = false;
			const cancel = (): void => {
				cancelled = true;
				if (!posted || !this.accepting || !this.pending.has(request.id)) return;
				try {
					this.post({ id: request.id, type: "cancel" });
				} catch (error) {
					this.reportFatal(workerError(error));
				}
			};
			signal.addEventListener("abort", cancel, { once: true });
			this.pending.set(request.id, {
				onUpdate,
				resume,
				stopCancellation: () => signal.removeEventListener("abort", cancel),
			});
			port.ref();
			try {
				this.post(request);
				posted = true;
				if (cancelled || signal.aborted) cancel();
			} catch (error) {
				this.takePending(request.id);
				resume(Effect.fail(workerError(error)));
			}
			return Effect.sync(() => {
				this.takePending(request.id);
			});
		});
	}

	post(message: MagicWorkerRequest): void {
		if (!this.accepting || !this.handle) throw new Error("Magic Context worker is closed.");
		this.handle.port.postMessage(message);
	}

	private attach(handle: MagicWorkerNativeHandle): void {
		this.handle = handle;
		this.accepting = true;
		const port = handle.port;
		port.onmessage = (event) => this.receive(event.data);
		port.onerror = (event): void => {
			event.preventDefault();
			this.reportFatal(new Error(event.message || "Magic Context worker crashed."));
		};
		port.onmessageerror = () => {
			this.reportFatal(new Error("Magic Context worker returned an unreadable message."));
		};
		port.addEventListener("close", (event) => {
			const detail = event.reason || (event.code ? `exit ${String(event.code)}` : "an unexpected exit");
			this.reportFatal(new Error(`Magic Context worker closed after ${detail}.`));
		});
	}

	private receive(message: MagicWorkerMessage): void {
		if (!this.accepting) return;
		if (message.type === "effect") {
			this.callbacks.onEffect(message);
			return;
		}
		if (message.type === "sync-effect") {
			this.callbacks.onSyncEffect(message);
			return;
		}
		const pending = this.pending.get(message.id);
		if (!pending) return;
		if (message.type === "tool-update") {
			pending.onUpdate?.(message.update);
			return;
		}
		this.takePending(message.id);
		pending.resume(message.type === "error" ? Effect.fail(magicWorkerError(message)) : Effect.succeed(message));
	}

	private takePending(id: number): PendingRequest | undefined {
		const pending = this.pending.get(id);
		if (!pending) return;
		this.pending.delete(id);
		pending.stopCancellation();
		if (this.pending.size === 0) this.handle?.port.unref();
		return pending;
	}

	private failPending(error: Error): void {
		for (const id of this.pending.keys()) this.takePending(id)?.resume(Effect.fail(error));
	}

	private reportFatal(error: Error): void {
		if (!this.accepting) return;
		this.accepting = false;
		this.failPending(error);
		this.callbacks.onFatal(error);
	}

	private async release(handle: MagicWorkerNativeHandle): Promise<void> {
		if (this.handle === handle) {
			this.accepting = false;
			this.failPending(new Error("Magic Context worker closed."));
			this.handle = undefined;
		}
		await handle.release();
	}
}
