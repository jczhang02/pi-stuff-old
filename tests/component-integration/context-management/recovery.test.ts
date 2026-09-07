import { expect, test } from "bun:test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import { ContextRecovery } from "../../../packages/pi-stuff/src/context-management/recovery.js";
import { getContextStatusChannel } from "../../../packages/pi-stuff/src/conversation-ui/statusline-channels.js";
import { createExtensionApi } from "../../fixtures/extension-api.js";

test("recovery shares one monotonic deadline and one restart until a successful phase ends", async () => {
	const status = getContextStatusChannel(createExtensionApi());
	const recovery = new ContextRecovery(status);
	let elapsed = 0;
	const live = Effect.runSync(Clock.clockWith(Effect.succeed));
	const clock = { ...live, monotonicTimeNanos: Effect.sync(() => BigInt(elapsed) * 1_000_000n) };
	const run = <A>(effect: Effect.Effect<A, unknown>) =>
		Effect.runPromise(Effect.provideService(effect, Clock.Clock, clock));
	await expect(run(recovery.run(Effect.fail(new Error("transient")), "compacting"))).rejects.toThrow("transient");
	elapsed = 590_000;
	await run(recovery.restart(Effect.void));
	await expect(run(recovery.restart(Effect.void))).rejects.toThrow("already restarted");
	elapsed = 600_001;
	let attempts = 0;
	await expect(run(recovery.run(Effect.sync(() => attempts++)))).rejects.toThrow("exceeded ten minutes");
	expect(attempts).toBe(0);
	expect(status.source.getSnapshot()?.state).toBe("unknown");
	recovery.clear();
	expect(status.source.getSnapshot()).toBeUndefined();
	elapsed += 10_000_000;
	await run(recovery.restart(Effect.sync(() => attempts++)));
	expect(attempts).toBe(1);
});
