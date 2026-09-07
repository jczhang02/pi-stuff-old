import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXPECTED_TOOLS = ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"] as const;

export default function assertTodoTools(pi: ExtensionAPI): void {
	pi.on("session_start", async () => {
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const active = new Set(pi.getActiveTools());
		for (const name of EXPECTED_TOOLS) {
			if (!registered.has(name) || !active.has(name)) throw new Error(`Todo tool is unavailable: ${name}`);
		}
		pi.registerCommand("todo-tools-certified", {
			description: "Test-only proof that every Todo tool is registered and active",
			handler: async () => {},
		});
	});
}
