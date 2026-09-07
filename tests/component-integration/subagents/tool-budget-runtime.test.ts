import { expect, test } from "bun:test";
import {
	CHILD_TOOL_BUDGET_ENTRY_TYPE,
	parseChildProtocolEvent,
} from "../../../packages/pi-stuff/src/subagents/src/runs/shared/child-protocol.js";
import { registerToolBudget } from "../../../packages/pi-stuff/src/subagents/src/runs/shared/subagent-prompt-runtime.js";
import { toolBudgetState } from "../../../packages/pi-stuff/src/subagents/src/runs/shared/tool-budget.js";

type ToolCallResult = { readonly block: true; readonly reason: string } | undefined;
type ToolCallHandler = (event: { readonly toolName?: string }) => ToolCallResult;
interface ToolBudgetEntryData {
	readonly version: 1;
	readonly outcome: "hard-blocked" | "soft-reached";
	readonly toolCount: number;
	readonly toolName: string;
}

test("keeps the soft Tool limit advisory and blocks only configured Tools after hard", () => {
	let toolCall: ToolCallHandler | undefined;
	const entries: Array<{ customType: string; data: ToolBudgetEntryData }> = [];
	let nudges = 0;
	const host = {
		on(event: string, handler: ToolCallHandler) {
			if (event === "tool_call") toolCall = handler;
		},
		appendEntry(customType: string, data: ToolBudgetEntryData) {
			entries.push({ customType, data });
		},
		sendUserMessage() {
			nudges += 1;
			throw new Error("advisory transport unavailable");
		},
	};
	// SAFETY: the test double implements every ExtensionAPI member exercised by registerToolBudget.
	registerToolBudget(host as never, { soft: 2, hard: 2, block: ["read"] });
	if (!toolCall) throw new Error("Expected the Tool budget handler to be registered.");

	expect(toolCall({ toolName: "bash" })).toBeUndefined();
	expect(toolCall({ toolName: "read" })).toBeUndefined();
	expect(toolCall({ toolName: "bash" })).toBeUndefined();
	const blocked = toolCall({ toolName: "read" });
	expect(blocked).toMatchObject({ block: true, reason: expect.stringContaining("'read' tool is blocked") });
	expect(nudges).toBe(1);
	expect(entries).toEqual([
		{
			customType: CHILD_TOOL_BUDGET_ENTRY_TYPE,
			data: { version: 1, outcome: "soft-reached", toolCount: 2, toolName: "read" },
		},
		{
			customType: CHILD_TOOL_BUDGET_ENTRY_TYPE,
			data: { version: 1, outcome: "hard-blocked", toolCount: 4, toolName: "read" },
		},
	]);
	expect(toolBudgetState({ soft: 2, hard: 2, block: ["read"] }, 4).outcome).toBe("soft-reached");
	expect(toolBudgetState({ soft: 2, hard: 2, block: ["read"] }, 4, "read")).toMatchObject({
		outcome: "hard-blocked",
		blockedTool: "read",
	});
});

test("validates Tool-budget lifecycle evidence at the child protocol boundary", () => {
	const valid = parseChildProtocolEvent({
		type: "entry_appended",
		entry: {
			type: "custom",
			customType: CHILD_TOOL_BUDGET_ENTRY_TYPE,
			data: { version: 1, outcome: "hard-blocked", toolCount: 4, toolName: "read" },
		},
	});
	expect(valid).toMatchObject({
		event: { toolBudgetEvent: { outcome: "hard-blocked", toolCount: 4, toolName: "read" } },
	});
	expect(
		parseChildProtocolEvent({
			type: "entry_appended",
			entry: {
				type: "custom",
				customType: CHILD_TOOL_BUDGET_ENTRY_TYPE,
				data: { version: 1, outcome: "hard-blocked", toolCount: 0, toolName: "read" },
			},
		}),
	).toEqual({ error: "entry_appended Tool budget data.toolCount must be a positive safe integer" });
});
