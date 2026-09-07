import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { HOST_SHUTDOWN_GRACE_MS } from "../lifecycle-deadline.ts";
import type { EffectFoundation, EffectScopeOwner } from "../shared/effect-foundation.ts";
import { ensureCodeModeHostBinary } from "./host/binary.ts";
import { CodeModeEffectOwner } from "./host/effect-owner.ts";
import { CodeModeHostClient, codeModeAbortError } from "./host/host-client.ts";
import type { CodeModeExecuteOptions, CodeModeWaitOptions, RuntimeResponse } from "./protocol.ts";
import type { CodeModeExecutor } from "./runtime.ts";

export class V8CodeModeExecutor implements CodeModeExecutor {
	private capability: EffectScopeOwner | undefined;
	private client: CodeModeHostClient | undefined;
	private readonly clientGate = Semaphore.makeUnsafe(1);
	private readonly foundation: EffectFoundation;

	constructor(foundation: EffectFoundation) {
		this.foundation = foundation;
	}

	async execute(options: CodeModeExecuteOptions): Promise<RuntimeResponse> {
		return this.invoke(options.signal, (client) => client.execute(options));
	}

	async wait(
		cellId: string,
		options: CodeModeWaitOptions & { readonly yieldTimeMs: number },
	): Promise<RuntimeResponse> {
		return this.invoke(options.signal, (client) => client.wait(cellId, options.yieldTimeMs, options));
	}

	async shutdown(): Promise<void> {
		const capability = this.capability;
		this.capability = undefined;
		this.client = undefined;
		if (capability) await this.foundation.close(capability, Exit.interrupt(), HOST_SHUTDOWN_GRACE_MS);
	}

	private acquireClient(capability: EffectScopeOwner): Effect.Effect<CodeModeHostClient, Error, Scope.Scope> {
		return this.clientGate.withPermit(
			Effect.suspend(() => {
				if (this.client && this.capability === capability) return Effect.succeed(this.client);
				return Effect.acquireRelease(
					Effect.tryPromise({
						try: (signal) => ensureCodeModeHostBinary(signal),
						catch: normalizeError,
					}).pipe(
						Effect.map(
							(binary) => new CodeModeHostClient(binary, new CodeModeEffectOwner(this.foundation, capability)),
						),
					),
					(client) =>
						client.shutdown().pipe(
							Effect.ensuring(
								Effect.sync(() => {
									if (this.client === client) this.client = undefined;
									if (this.capability === capability) this.capability = undefined;
								}),
							),
						),
				).pipe(
					Effect.tap((client) =>
						Effect.sync(() => {
							this.client = client;
						}),
					),
				);
			}),
		);
	}

	private currentCapability(): EffectScopeOwner {
		const current = this.capability;
		if (current && this.foundation.isCurrent(current)) return current;
		const session = this.foundation.currentSession();
		if (!session || !this.foundation.isCurrent(session)) {
			throw new Error("Code Mode is unavailable before Session start.");
		}
		this.client = undefined;
		const capability = this.foundation.forkCapability(session);
		this.capability = capability;
		return capability;
	}

	private async invoke<A>(
		signal: AbortSignal | undefined,
		use: (client: CodeModeHostClient) => Effect.Effect<A, Error>,
	): Promise<A> {
		if (signal?.aborted) throw codeModeAbortError();
		const capability = this.currentCapability();
		const acquired = await this.foundation.run(capability, this.acquireClient(capability), { signal });
		if (Exit.isFailure(acquired)) {
			await this.closeFailedCapability(capability, acquired);
			throw exitError(acquired, signal);
		}
		if (signal?.aborted || !this.foundation.isCurrent(capability) || this.capability !== capability) {
			throw codeModeAbortError();
		}
		const operation = this.foundation.forkOperation(capability);
		const exit = await this.foundation.run(operation, use(acquired.value), { signal });
		await this.foundation.close(operation, exit);
		if (Exit.isFailure(exit)) throw exitError(exit, signal);
		if (signal?.aborted || !this.foundation.isCurrent(capability)) throw codeModeAbortError();
		return exit.value;
	}

	private async closeFailedCapability(capability: EffectScopeOwner, exit: Exit.Exit<unknown, unknown>): Promise<void> {
		await this.foundation.close(capability, exit, HOST_SHUTDOWN_GRACE_MS);
		if (this.capability === capability) {
			this.capability = undefined;
			this.client = undefined;
		}
	}
}

function exitError<A, E>(exit: Exit.Exit<A, E>, signal?: AbortSignal): Error {
	if (signal?.aborted || (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))) return codeModeAbortError();
	return Exit.isFailure(exit) ? normalizeError(Cause.squash(exit.cause)) : new Error("Code Mode operation failed");
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
