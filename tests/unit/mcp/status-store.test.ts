import { describe, expect, test } from "bun:test";
import { McpStatusStore, parseMcpStatusSnapshot } from "../../../packages/pi-stuff/src/mcp/status-store.js";

const SNAPSHOT = {
	connectedCount: 1,
	disabledCount: 0,
	servers: [{ disabled: false, name: "filesystem", status: "connected", toolCount: 4 }],
	totalResources: 2,
	totalTools: 4,
	version: 1,
} as const;

describe("MCP status projection", () => {
	test("accepts only the versioned bounded event shape", () => {
		expect(parseMcpStatusSnapshot(SNAPSHOT)).toEqual(SNAPSHOT);
		expect(parseMcpStatusSnapshot({ ...SNAPSHOT, version: 2 })).toBeUndefined();
		expect(parseMcpStatusSnapshot({ ...SNAPSHOT, servers: [{ name: "bad", status: "invented" }] })?.servers).toEqual(
			[],
		);
	});

	test("notifies observers without retaining invalid events", () => {
		const store = new McpStatusStore();
		const values: unknown[] = [];
		store.subscribe((value) => values.push(value));
		store.set(SNAPSHOT);
		store.set({ version: 7 });
		expect(store.get()).toEqual(SNAPSHOT);
		expect(values).toEqual([SNAPSHOT]);
		store.clear();
		expect(values.at(-1)).toBeUndefined();
	});

	test("sanitizes untrusted server names before any terminal rendering", () => {
		const snapshot = parseMcpStatusSnapshot({
			...SNAPSHOT,
			servers: [{ disabled: false, name: "\u001b[31mred\nnext\u202e", status: "connected", toolCount: 1 }],
		});
		expect(snapshot?.servers[0]?.name).toBe("red next");
	});

	test("projects only bounded control metadata needed by the Dialog", () => {
		const snapshot = parseMcpStatusSnapshot({
			...SNAPSHOT,
			servers: [
				{
					autoConnect: true,
					disabled: false,
					failureDetail: `spawn failed\n${"x".repeat(600)}`,
					name: "local",
					oauth: true,
					status: "failed",
					toolCount: 0,
				},
			],
		});
		expect(snapshot?.servers[0]?.oauth).toBe(true);
		expect(snapshot?.servers[0]?.autoConnect).toBe(true);
		const detail = snapshot?.servers[0]?.failureDetail;
		expect(detail).toStartWith("spawn failed x");
		expect(detail?.length ?? 0).toBeLessThanOrEqual(400);
	});
});
