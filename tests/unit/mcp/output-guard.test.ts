import { expect, test } from "bun:test";
import { guardMcpOutput } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-output-guard.js";

test("MCP output summaries estimate nested array bytes", async () => {
	const result = await guardMcpOutput([], {
		detailsMaxBytes: 1,
		rawMcpResult: { structuredContent: ["four"] },
	});
	expect(result.mcpResult).toMatchObject({
		structuredContent: { estimatedBytes: 4, type: "array" },
	});
});

test("MCP output truncation honors budgets smaller than its notice", async () => {
	const result = await guardMcpOutput([{ text: "long output", type: "text" }], {
		maxBytes: 1,
		maxLines: 1,
	});
	const text = result.content[0];
	if (text?.type !== "text") throw new TypeError("expected bounded text output");
	expect(Buffer.byteLength(text.text, "utf8")).toBeLessThanOrEqual(1);
	expect(text.text.split("\n")).toHaveLength(1);
	expect(result.outputGuard?.returnedBytes).toBeLessThanOrEqual(1);
	expect(result.outputGuard?.returnedLines).toBeLessThanOrEqual(1);
});
