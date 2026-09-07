import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { EffectFoundation } from "../../../packages/pi-stuff/src/shared/effect-foundation.js";
import { AgentEffectOwner } from "../../../packages/pi-stuff/src/subagents/src/runtime/agent-effect-owner.js";

test("closes the previous Agent Capability scope before replacing it", async () => {
	const foundation = new EffectFoundation(1_000);
	// SAFETY: EffectFoundation keys Session identity only; this test never reads Host SessionManager members.
	const sessionManager = {} as ExtensionContext["sessionManager"];
	await foundation.startSession(sessionManager);
	const owner = new AgentEffectOwner(foundation);
	await owner.startSession(sessionManager);
	let active = 0;
	owner.start(
		Effect.acquireRelease(
			Effect.sync(() => {
				active += 1;
			}),
			() =>
				Effect.sync(() => {
					active -= 1;
				}),
		).pipe(Effect.andThen(Effect.never)),
	);
	await Bun.sleep(0);
	expect(active).toBe(1);

	await owner.startSession(sessionManager);

	expect(active).toBe(0);
	await owner.stop();
	await foundation.shutdown();
});
