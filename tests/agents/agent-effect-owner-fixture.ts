import { afterEach } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EffectFoundation } from "../../packages/pi-stuff/src/shared/effect-foundation.js";
import { AgentEffectOwner } from "../../packages/pi-stuff/src/subagents/src/runtime/agent-effect-owner.js";

const owners = new Set<AgentEffectOwner>();

afterEach(async () => {
	await Promise.all([...owners].map((owner) => owner.stop()));
	owners.clear();
});

export function createTestAgentEffectOwner(): AgentEffectOwner {
	const foundation = new EffectFoundation(1_000);
	// SAFETY: EffectFoundation keys Session identity only; this fixture never reads Host SessionManager members.
	const sessionManager = {} as ExtensionContext["sessionManager"];
	void foundation.startSession(sessionManager);
	const owner = new AgentEffectOwner(foundation);
	void owner.startSession(sessionManager);
	owners.add(owner);
	return owner;
}
