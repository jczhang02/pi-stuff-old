import { expect, test } from "bun:test";
import { MCP_PRESENTATION, type McpPresentationArguments } from "../../../packages/pi-stuff/src/mcp/presentation.js";

function category(args: McpPresentationArguments): string | undefined {
	return MCP_PRESENTATION.activity.classify({ args, state: "running" })[0]?.category;
}

test("MCP activity metadata distinguishes invocation, connection, and catalog retrieval", () => {
	expect(category({ search: "tool", tool: "server.execute" })).toBe("invoke-mcp");
	expect(category({ connect: "server", describe: "server.execute" })).toBe("connect-mcp");
	expect(category({ search: "browser" })).toBe("search-mcp");
	expect(category({ describe: "server.execute" })).toBe("search-mcp");
	expect(category({ action: "status" })).toBe("search-mcp");
});
