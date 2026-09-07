import type * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Scope from "effect/Scope";
import type { EffectFoundation, EffectScopeOwner } from "../../shared/effect-foundation.ts";

export interface CodeModeEffectTask {
	interrupt(): void;
	run(program: Effect.Effect<void, never, Scope.Scope>, onInterrupt?: () => void): void;
}

/** Creates request and cell Scopes beneath one Code Mode Capability. */
export class CodeModeEffectOwner {
	private readonly capability: EffectScopeOwner;
	private readonly foundation: EffectFoundation;
	private readonly settlements = new Set<Promise<void>>();

	constructor(foundation: EffectFoundation, capability: EffectScopeOwner) {
		this.capability = capability;
		this.foundation = foundation;
	}

	open(): CodeModeEffectTask {
		if (!this.foundation.isCurrent(this.capability)) {
			throw new Error("Code Mode delegate Effects require the current Capability Scope.");
		}
		const operation = this.foundation.forkOperation(this.capability);
		let interruptHandler: (() => void) | undefined;
		let interrupted = false;
		let started = false;
		const close = (exit: Exit.Exit<unknown, unknown>): Promise<boolean> => this.foundation.close(operation, exit);
		return {
			interrupt: () => {
				if (interrupted) return;
				interrupted = true;
				interruptHandler?.();
				this.track(close(Exit.interrupt()).then(() => undefined));
			},
			run: (program, onInterrupt) => {
				if (started) throw new Error("Code Mode Effect Scope already has a running program.");
				started = true;
				if (interrupted) {
					onInterrupt?.();
					return;
				}
				interruptHandler = onInterrupt;
				this.track(
					this.foundation.run(operation, program).then(async (exit) => {
						await close(exit);
					}),
				);
			},
		};
	}

	private track(settlement: Promise<void>): void {
		this.settlements.add(settlement);
		void settlement.then(
			() => this.settlements.delete(settlement),
			() => this.settlements.delete(settlement),
		);
	}
}
