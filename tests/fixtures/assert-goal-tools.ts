import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXPECTED_TOOLS = ["goal_complete", "goal_blocked"] as const;

export default function assertGoalTools(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const active = new Set(pi.getActiveTools());
		for (const name of EXPECTED_TOOLS) {
			if (!registered.has(name) || !active.has(name)) throw new Error(`Goal tool is unavailable: ${name}`);
		}
		pi.registerCommand("goal-tools-certified", {
			description: "Test-only proof that both Goal terminal tools are registered and active",
			handler: async () => {},
		});
	});
}
