import { createEventBus, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { SuiteToolRegistrationHost } from "../../packages/pi-stuff/src/tool-display/contract.js";

export function toolRegistrationHarness(initialActiveTools: readonly string[] = []) {
	let activeTools = [...initialActiveTools];
	const tools = new Map<string, ToolDefinition>();
	const host: SuiteToolRegistrationHost = {
		events: createEventBus(),
		getActiveTools: () => [...activeTools],
		on: () => undefined,
		registerTool: (tool) => {
			// SAFETY: this test registry erases only generic renderer state; it returns the original Tool unchanged.
			tools.set(tool.name, tool as ToolDefinition);
		},
		setActiveTools: (names) => {
			activeTools = [...names];
		},
	};
	return { activeTools: () => activeTools, host, tools };
}
