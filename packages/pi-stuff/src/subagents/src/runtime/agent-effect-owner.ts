import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import type { EffectFoundation, EffectScopeOwner } from "../../../shared/effect-foundation.ts";

export interface AgentEffectTask<A, E> {
	readonly result: Promise<Exit.Exit<A, E>>;
	interrupt(): Promise<boolean>;
}

/** Owns Agent Capability Effects beneath the current Pi Session. */
export class AgentEffectOwner {
	private readonly foundation: EffectFoundation;
	private capability: EffectScopeOwner | undefined;
	private generation = 0;

	constructor(foundation: EffectFoundation) {
		this.foundation = foundation;
	}

	async startSession(sessionManager: ExtensionContext["sessionManager"]): Promise<void> {
		const generation = ++this.generation;
		const previous = this.capability;
		this.capability = undefined;
		if (previous) await this.foundation.close(previous, Exit.interrupt());
		if (generation !== this.generation) return;
		const session = this.foundation.sessionFor(sessionManager);
		if (!session) throw new Error("Agent Effects require the current Pi Session Scope.");
		this.capability = this.foundation.forkCapability(session);
	}

	start<A, E>(program: Effect.Effect<A, E, Scope.Scope>): AgentEffectTask<A, E> {
		const capability = this.capability;
		if (!capability || !this.foundation.isCurrent(capability)) {
			throw new Error("Agent Effects are unavailable outside the current Pi Session.");
		}
		const operation = this.foundation.forkOperation(capability);
		const close = (exit: Exit.Exit<unknown, unknown>) => {
			return this.foundation.close(operation, exit);
		};
		const result = this.foundation.run(operation, program).then(async (exit) => {
			await close(exit);
			return exit;
		});
		return {
			result,
			interrupt: () => close(Exit.interrupt()),
		};
	}

	async run<A, E>(program: Effect.Effect<A, E, Scope.Scope>): Promise<A> {
		const exit = await this.start(program).result;
		if (Exit.isSuccess(exit)) return exit.value;
		throw Cause.squash(exit.cause);
	}

	async stop(): Promise<boolean> {
		this.generation += 1;
		const capability = this.capability;
		this.capability = undefined;
		return capability ? this.foundation.close(capability, Exit.interrupt()) : true;
	}
}
