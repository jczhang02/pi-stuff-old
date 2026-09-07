import { describe, expect, it } from "bun:test";
import { deriveBlocks, detectCycle, hasCycle } from "../../../packages/pi-stuff/src/todo/state/task-graph.js";
import type { Task } from "../../../packages/pi-stuff/src/todo/tool/types.js";

function task(id: string, blockedBy?: string[]): Task {
	return Object.assign(
		{ id, subject: `Task ${id}`, description: `Description ${id}`, status: "pending" as const },
		blockedBy ? { blockedBy } : undefined,
	);
}

describe("task dependency graph", () => {
	it("detects direct and transitive cycles", () => {
		expect(hasCycle([task("1", ["2"]), task("2", ["1"])])).toBe(true);
		expect(hasCycle([task("1", ["2"]), task("2", ["3"]), task("3", ["1"])])).toBe(true);
		expect(hasCycle([task("1"), task("2", ["1"]), task("3", ["2"])])).toBe(false);
	});

	it("checks a prospective blockedBy merge without mutating its input", () => {
		const tasks = [task("1"), task("2", ["1"])];
		expect(detectCycle(tasks, "1", ["2"])).toBe(true);
		expect(tasks[0]?.blockedBy).toBeUndefined();
	});

	it("inverts blockedBy into a string-keyed blocks map", () => {
		const blocks = deriveBlocks([task("1"), task("2", ["1"]), task("3", ["1", "2"])]);
		expect(blocks.get("1")).toEqual(["2", "3"]);
		expect(blocks.get("2")).toEqual(["3"]);
		expect(blocks.has("3")).toBe(false);
	});
});
