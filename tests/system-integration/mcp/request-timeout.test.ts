import { expect, test } from "bun:test";
import { join } from "node:path";
import { runMcpEffect } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-effect-runner.js";
import { createMcpRuntimeOwner } from "../../../packages/pi-stuff/src/mcp/runtime/runtime-owner.js";
import { McpServerManager } from "../../../packages/pi-stuff/src/mcp/runtime/server-manager.js";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("ordinary MCP Tool and resource requests disable the SDK default deadline", async () => {
	const owner = createMcpRuntimeOwner();
	const manager = await runMcpEffect(McpServerManager.make(owner));
	try {
		expect(manager.getRequestOptions("missing")).toEqual({ timeout: 0 });

		manager.setDefaultRequestTimeoutMs(25);
		expect(manager.getRequestOptions("missing")).toEqual({ timeout: 25 });
		manager.setDefaultRequestTimeoutMs(undefined);

		const connection = await runMcpEffect(
			manager.connectEffect("slow", {
				args: [join(import.meta.dir, "../../fixtures/mcp/stdio-server.mjs")],
				command: process.execPath,
				env: { PI_STUFF_MCP_HANG_CALL: "1" },
			}),
		);
		manager.setDefaultRequestTimeoutMs(25);
		await expect(
			connection.client.callTool(
				{ arguments: { text: "deadline" }, name: "echo" },
				undefined,
				manager.getRequestOptions("slow"),
			),
		).rejects.toThrow(/timed out/iu);
		manager.setDefaultRequestTimeoutMs(undefined);

		const controller = new AbortController();
		const pending = connection.client.callTool(
			{ arguments: { text: "wait" }, name: "echo" },
			undefined,
			manager.getRequestOptions("slow", controller.signal),
		);
		const state = await Promise.race([
			pending.then(
				() => "settled",
				() => "settled",
			),
			delay(20).then(() => "pending"),
		]);
		expect(state).toBe("pending");

		controller.abort(new Error("fixture abort"));
		await expect(pending).rejects.toThrow("fixture abort");
	} finally {
		await runMcpEffect(manager.closeAllEffect());
		await runMcpEffect(owner.stop());
	}
});
