import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { HOST_SHUTDOWN_GRACE_MS } from "../lifecycle-deadline.ts";
import type { EffectFoundation, EffectScopeOwner } from "../shared/effect-foundation.ts";
import type { StatuslineClock } from "./statusline.ts";

/** Owns Conversation UI Effect work beneath the current Host Session. */
export class UiEffectOwner {
	private capability: EffectScopeOwner | undefined;
	private readonly foundation: EffectFoundation;

	constructor(foundation: EffectFoundation) {
		this.foundation = foundation;
	}

	bindSession(ctx: ExtensionContext): StatuslineClock | undefined {
		const session = this.foundation.sessionFor(ctx.sessionManager);
		if (!session) throw new Error("UI Session Scope was not initialized.");
		if (!this.foundation.isCurrent(session)) return undefined;
		const capability = this.foundation.forkCapability(session);
		this.capability = capability;
		return (callback, intervalMs) => {
			const operation = this.foundation.forkOperation(capability);
			void this.foundation
				.run(
					operation,
					Effect.forever(Effect.sleep(Math.max(0, intervalMs)).pipe(Effect.andThen(Effect.sync(callback)))),
				)
				.then((exit) => this.foundation.close(operation, exit));
			return () => {
				void this.foundation.close(operation, Exit.interrupt());
			};
		};
	}

	async run(program: Effect.Effect<void, Error>): Promise<void> {
		const capability = this.capability;
		if (!capability || !this.foundation.isCurrent(capability)) return;
		const operation = this.foundation.forkOperation(capability);
		const exit = await this.foundation.run(operation, program);
		await this.foundation.close(operation, exit);
		if (Exit.isFailure(exit) && !Cause.hasInterrupts(exit.cause)) throw Cause.squash(exit.cause);
	}

	async shutdown(idle: Effect.Effect<void>): Promise<void> {
		const capability = this.capability;
		this.capability = undefined;
		if (capability) await this.foundation.close(capability, Exit.interrupt(), HOST_SHUTDOWN_GRACE_MS);
		await Effect.runPromise(idle.pipe(Effect.timeoutOption(HOST_SHUTDOWN_GRACE_MS), Effect.asVoid));
	}
}
