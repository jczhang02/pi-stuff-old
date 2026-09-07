import { expect, test } from "bun:test";
import { runMcpEffect } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-effect-runner.js";
import { executeCall } from "../../../packages/pi-stuff/src/mcp/runtime/proxy-call.js";
import type { McpServerManager, ServerConnection } from "../../../packages/pi-stuff/src/mcp/runtime/server-manager.js";
import type { McpExtensionState } from "../../../packages/pi-stuff/src/mcp/runtime/state.js";
import type { ToolMetadata } from "../../../packages/pi-stuff/src/mcp/runtime/types.js";

type ToolCallRequest = Parameters<ServerConnection["client"]["callTool"]>[0];
type ToolCallResult = { content: Array<{ type: "text"; text: string }> };

function harness(
	callTool: (request: ToolCallRequest) => Promise<ToolCallResult>,
	status: ServerConnection["status"] = "connected",
) {
	const events: string[] = [];
	const activity = { events, inFlight: 0 };
	const tool: ToolMetadata = {
		name: "demo_echo",
		originalName: "echo",
		description: "echo",
	};
	// SAFETY: this deterministic connection supplies every ServerConnection member exercised by executeCall.
	const connection: ServerConnection = {
		client: { callTool },
		status,
		transport: {},
	} as never;
	// SAFETY: this test manager implements every McpServerManager operation exercised by the connected call path.
	const manager: McpServerManager = {
		decrementInFlight: () => {
			activity.inFlight -= 1;
			activity.events.push("decrement");
		},
		getConnection: () => connection,
		getRequestOptions: () => undefined,
		incrementInFlight: () => {
			activity.inFlight += 1;
			activity.events.push("increment");
		},
		touch: () => {
			activity.events.push("touch");
		},
	} as never;
	// SAFETY: this test state supplies every McpExtensionState member exercised by the connected call path.
	const state: McpExtensionState = {
		approvedToolCalls: new Map(),
		config: { mcpServers: { demo: {} } },
		failureMessages: new Map(),
		failureTracker: new Map(),
		manager,
		toolMetadata: new Map([["demo", [tool]]]),
	} as never;
	return { activity, state, tool };
}

test("MCP proxy call executes a resolved tool and balances activity ownership", async () => {
	let received: ToolCallRequest | undefined;
	const fixture = harness(async (request) => {
		received = request;
		return { content: [{ type: "text", text: "ok" }] };
	});

	const result = await runMcpEffect(executeCall(fixture.state, fixture.tool.name, { value: "hello" }));

	expect(received).toEqual({ name: "echo", arguments: { value: "hello" } });
	expect(result.content).toEqual([{ type: "text", text: "ok" }]);
	expect(result.details).toMatchObject({ mode: "call", server: "demo", tool: "echo" });
	expect(fixture.activity).toEqual({ events: ["touch", "increment", "decrement", "touch"], inFlight: 0 });
});

test("MCP proxy call releases activity ownership after a rejected tool call", async () => {
	const fixture = harness(async () => {
		throw new Error("boom");
	});

	const result = await runMcpEffect(executeCall(fixture.state, fixture.tool.name));

	expect(result.details).toMatchObject({ mode: "call", error: "call_failed", message: "boom" });
	expect(fixture.activity).toEqual({ events: ["touch", "increment", "decrement", "touch"], inFlight: 0 });
});

test("MCP proxy call reports authentication required before invoking a cached tool", async () => {
	const fixture = harness(async () => ({ content: [] }), "needs-auth");

	const result = await runMcpEffect(executeCall(fixture.state, fixture.tool.name));

	expect(result.details).toMatchObject({ mode: "call", error: "auth_required", server: "demo", tool: "echo" });
	expect(fixture.activity).toEqual({ events: [], inFlight: 0 });
});
