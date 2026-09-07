import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function assertWorkTools(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		const registered = new Set(pi.getAllTools().map((tool) => tool.name));
		const active = new Set(pi.getActiveTools());
		for (const name of ["background", "bash", "monitor"]) {
			if (!registered.has(name)) throw new Error(`Background Work tool is unavailable: ${name}`);
		}
		for (const name of ["background", "monitor"]) {
			if (!active.has(name)) throw new Error(`Background Work tool is inactive: ${name}`);
		}
		if (active.has("bash")) throw new Error("Background Work revived Bash under --no-builtin-tools");
		pi.registerCommand("work-tools-certified", {
			description: "Test-only proof that Background Work tools preserve Host activation",
			handler: async () => {},
		});
	});
}
