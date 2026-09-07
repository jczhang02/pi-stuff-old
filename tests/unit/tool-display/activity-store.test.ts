import { expect, test } from "bun:test";
import { ToolActivityStore } from "../../../packages/pi-stuff/src/tool-display/activity-store.js";

test("ToolActivityStore exposes immutable snapshots", () => {
	const store = new ToolActivityStore();
	const running = store.begin({
		id: "call-1",
		label: "Read",
		name: "read",
		target: "README.md",
	});
	const settled = store.settle("call-1", {
		detailLines: ["line one"],
		durationMs: 12,
		state: "success",
		summary: "Read 1 file",
	});

	expect(Object.isFrozen(running)).toBe(true);
	expect(settled).toBeDefined();
	if (!settled) throw new Error("Expected the activity to settle");
	expect(Object.isFrozen(settled)).toBe(true);
	expect(Object.isFrozen(settled.detailLines)).toBe(true);
	expect(() => {
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		(settled as { summary: string }).summary = "tampered";
	}).toThrow();
	expect(() => {
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		(settled.detailLines as string[]).push("tampered");
	}).toThrow();
	expect(store.get("call-1")?.summary).toBe("Read 1 file");
});

test("ToolActivityStore ignores an identical terminal transition", () => {
	const store = new ToolActivityStore();
	store.begin({ id: "call-1", label: "Read", name: "read", target: "README.md" });
	const terminal = { detailLines: ["line one"], durationMs: 12, state: "success" as const, summary: "done" };
	const settled = store.settle("call-1", terminal);
	let notifications = 0;
	store.subscribe(() => {
		notifications += 1;
	});

	expect(store.settle("call-1", terminal)).toBe(settled);
	expect(notifications).toBe(0);
});
