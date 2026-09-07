import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXPECTED_TOOLS = ["fetch_content", "get_search_content", "web_search"] as const;

export default function assertWebTools(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const active = new Set(pi.getActiveTools());
		for (const name of EXPECTED_TOOLS) {
			if (!registered.has(name) || !active.has(name)) throw new Error(`Web tool is unavailable: ${name}`);
		}
		pi.registerCommand("web-tools-certified", {
			description: "Test-only proof that every bounded Web tool is registered and active",
			handler: async () => {},
		});
	});
}
