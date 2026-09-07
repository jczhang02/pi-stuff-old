import * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import type { EffectFoundation, EffectScopeOwner } from "../../shared/effect-foundation.ts";

export interface BackgroundWorkEffectTask<A, E> {
	readonly exit: Promise<Exit.Exit<A, E>>;
	interrupt(): Promise<boolean>;
}

/** Owns Background Work operations beneath one Pi Session Capability Scope. */
export class BackgroundWorkEffectOwner {
	private readonly capability: EffectScopeOwner;
	private readonly foundation: EffectFoundation;

	constructor(foundation: EffectFoundation, session: EffectScopeOwner) {
		this.foundation = foundation;
		this.capability = foundation.forkCapability(session);
	}

	open<A, E>(program: Effect.Effect<A, E, Scope.Scope>, signal?: AbortSignal): BackgroundWorkEffectTask<A, E> {
		const operation = this.foundation.forkOperation(this.capability);
		const exit = this.foundation.run(operation, program, signal ? { signal } : undefined).then(async (result) => {
			await this.foundation.close(operation, result);
			return result;
		});
		return {
			exit,
			interrupt: () => this.foundation.close(operation, Exit.interrupt()),
		};
	}

	async run<A, E>(program: Effect.Effect<A, E, Scope.Scope>, signal?: AbortSignal): Promise<A> {
		const exit = await this.open(program, signal).exit;
		if (Exit.isSuccess(exit)) return exit.value;
		if (signal?.aborted) throw signal.reason;
		throw Cause.squash(exit.cause);
	}

	shutdown(): Promise<boolean> {
		return this.foundation.close(this.capability, Exit.interrupt());
	}
}
