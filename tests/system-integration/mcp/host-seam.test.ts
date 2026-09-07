import { expect, test } from "bun:test";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { runMcpEffect } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-effect-runner.js";
import { createMcpStatusSnapshot } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-status.js";
import { createMcpRuntimeOwner } from "../../../packages/pi-stuff/src/mcp/runtime/runtime-owner.js";
import { McpServerManager } from "../../../packages/pi-stuff/src/mcp/runtime/server-manager.js";
import {
	formatMcpProxyToolCallLines,
	formatMcpToolResultIdentity,
	formatMcpToolResultLines,
} from "../../../packages/pi-stuff/src/mcp/runtime/tool-result-renderer.js";
import type { JsonInputObject } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { isJsonSourceValue } from "../../../packages/pi-stuff/src/shared/json-value.js";

async function createManager() {
	const owner = createMcpRuntimeOwner();
	const manager = await runMcpEffect(McpServerManager.make(owner));
	return { manager, owner };
}

test("MCP call and result previews are terminal-cell-safe", () => {
	const call = formatMcpProxyToolCallLines(
		{ args: JSON.stringify({ query: "😀".repeat(31) }), tool: "server/tool" },
		60,
	);
	const result = formatMcpToolResultLines(
		{ content: [{ type: "text", text: `\u001b[31m${"界".repeat(100)}\u001b[0m` }] },
		false,
		3,
		60,
	);
	for (const line of [...call.slice(1), ...result.lines]) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		expect(line).not.toContain("\u001b");
	}
	expect(result.truncated).toBeTrue();
	expect(
		formatMcpToolResultLines({ content: [{ type: "text", text: "x".repeat(60) }] }, false, 3, 60).truncated,
	).toBeFalse();
	const identity = formatMcpToolResultIdentity({
		mode: "call",
		server: "s".repeat(2_000_000),
		tool: "t".repeat(2_000_000),
	});
	expect(identity?.length).toBeLessThanOrEqual(3_010);
});

test("MCP call preview does not enumerate arbitrary argument objects", () => {
	let keyScans = 0;
	const args = new Proxy<JsonInputObject>(
		{},
		{
			ownKeys: () => {
				keyScans += 1;
				return Array.from({ length: 100_000 }, (_, index) => `field-${String(index)}`);
			},
		},
	);

	expect(formatMcpProxyToolCallLines({ args, tool: "server/tool" })).toEqual([
		"mcp call server/tool",
		"[argument object preview omitted]",
	]);
	expect(keyScans).toBe(0);
});

test("MCP status events omit absent optional server fields", async () => {
	const { manager } = await createManager();
	const snapshot = createMcpStatusSnapshot({
		config: { mcpServers: { context7: { url: "https://mcp.context7.com/mcp" } } },
		failureMessages: new Map(),
		failureTracker: new Map(),
		manager,
		resourceCounts: new Map(),
		toolMetadata: new Map(),
	});
	expect(isJsonSourceValue(snapshot)).toBeTrue();
	expect(snapshot.servers[0]).not.toHaveProperty("resourceCount");
});

test("MCP connection rejects advertised resources that cannot be listed", async () => {
	const { manager } = await createManager();
	try {
		await expect(
			runMcpEffect(
				manager.connectEffect("broken-resources", {
					command: process.execPath,
					args: [join(import.meta.dir, "../../fixtures/mcp/stdio-server.mjs")],
					env: { PI_STUFF_MCP_RESOURCES_ERROR: "1" },
				}),
			),
		).rejects.toThrow("resource listing failed");
	} finally {
		await runMcpEffect(manager.closeAllEffect());
	}
});

test("MCP connection bounds server-controlled metadata pagination and entries", async () => {
	for (const kind of ["tools", "resources"] as const) {
		const { manager } = await createManager();
		try {
			await expect(
				runMcpEffect(
					manager.connectEffect(`looping-${kind}`, {
						command: process.execPath,
						args: [join(import.meta.dir, "../../fixtures/mcp/stdio-server.mjs")],
						env: { PI_STUFF_MCP_METADATA_LOOP: kind },
					}),
				),
			).rejects.toThrow("metadata exceeded 100 pages");
		} finally {
			await runMcpEffect(manager.closeAllEffect());
		}
	}

	const { manager } = await createManager();
	try {
		await expect(
			runMcpEffect(
				manager.connectEffect("oversized-tools", {
					command: process.execPath,
					args: [join(import.meta.dir, "../../fixtures/mcp/stdio-server.mjs")],
					env: { PI_STUFF_MCP_OVERSIZED_METADATA: "1" },
				}),
			),
		).rejects.toThrow("metadata exceeded 10000 entries");
	} finally {
		await runMcpEffect(manager.closeAllEffect());
	}
});

test("MCP manager isolates failed servers and single-flights reconnect", async () => {
	const { manager } = await createManager();
	const definition = {
		command: process.execPath,
		args: [join(import.meta.dir, "../../fixtures/mcp/stdio-server.mjs")],
	};
	try {
		const stale = await runMcpEffect(manager.connectEffect("healthy", definition));
		await expect(
			runMcpEffect(
				manager.connectEffect("broken", {
					...definition,
					env: { PI_STUFF_MCP_RESOURCES_ERROR: "1" },
				}),
			),
		).rejects.toThrow("resource listing failed");
		expect(manager.getConnection("healthy")).toBe(stale);

		const [first, second] = await Promise.all([
			runMcpEffect(manager.reconnectEffect("healthy", definition, stale)),
			runMcpEffect(manager.reconnectEffect("healthy", definition, stale)),
		]);
		expect(first).toBe(second);
		expect(first).not.toBe(stale);
	} finally {
		await runMcpEffect(manager.closeAllEffect());
	}
});
