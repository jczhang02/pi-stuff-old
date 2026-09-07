import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXPECTED = ["apply_patch", "imagegen", "view_image"] as const;

export default function assertCodexTools(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		for (const name of EXPECTED) {
			if (!registered.has(name)) throw new Error(`Codex tool was not registered for transcript replay: ${name}`);
		}
		pi.registerCommand("codex-tools-registered-certified", {
			description: "Test-only proof of Codex transcript tool registration",
			handler: async () => {},
		});
	});
}
