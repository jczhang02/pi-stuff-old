import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type { ContextStatusChannel, ContextStatusSnapshot } from "../conversation-ui/statusline-channels.ts";

/** A fault-recovery allowance, never a timer for healthy Agent work. */
export class ContextRecovery {
	private deadline: number | undefined;
	private restarted = false;
	private generation = 0;
	private readonly status: ContextStatusChannel;

	constructor(status: ContextStatusChannel) {
		this.status = status;
	}

	clear(): void {
		this.generation++;
		this.deadline = undefined;
		this.restarted = false;
		this.status.clear();
	}

	run<A>(
		operation: Effect.Effect<A, unknown>,
		phase: ContextStatusSnapshot["phase"] = "projecting",
	): Effect.Effect<A, unknown> {
		const generation = this.generation;
		return Effect.gen({ self: this }, function* () {
			this.status.publish({ state: "recovering", phase });
			const now = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;
			this.deadline ??= now + 600_000;
			const remaining = this.deadline - now;
			if (remaining <= 0) return yield* Effect.fail(new Error("Context recovery exceeded ten minutes."));
			return yield* operation.pipe(Effect.timeout(remaining));
		}).pipe(
			Effect.tapError(() =>
				Effect.sync(() => {
					if (generation === this.generation) this.status.publish({ state: "unknown" });
				}),
			),
		);
	}

	restart(operation: Effect.Effect<void, unknown>): Effect.Effect<void, unknown> {
		return Effect.suspend(() => {
			if (this.restarted) return Effect.fail(new Error("Context recovery already restarted its Worker once."));
			this.restarted = true;
			return this.run(operation, "restarting");
		});
	}
}
