import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function assertMcpTools(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		const registered = pi.getAllTools().map((tool) => tool.name);
		const active = new Set(pi.getActiveTools());
		if (!registered.includes("mcp") || !active.has("mcp")) throw new Error("MCP gateway is unavailable");
		if (registered.includes("mcp_script") || registered.some((name) => name.startsWith("mcp__"))) {
			throw new Error("MCP exposed a forbidden direct or script Tool");
		}
		pi.registerCommand("mcp-tools-certified", {
			description: "Test-only proof that MCP exposes only its bounded gateway",
			handler: async () => {},
		});
	});
}
