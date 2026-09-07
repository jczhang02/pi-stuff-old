import { expect, test } from "bun:test";
import { CodeModeTraceStore } from "../../../packages/pi-stuff/src/code-mode/host/trace-store.js";
import type { RuntimeTraceUpdate } from "../../../packages/pi-stuff/src/code-mode/protocol.js";

test("duplicate nested Tool IDs fail instead of corrupting the UI projection", () => {
	const traces = new CodeModeTraceStore();
	traces.start("cell", "nested-1", "read", { path: "a.ts" });
	expect(() => traces.start("cell", "nested-1", "write", { path: "b.ts" })).toThrow(
		"Duplicate Code Mode nested Tool call ID: nested-1",
	);
});

test("nested Tool trace retention never limits execution", () => {
	const traces = new CodeModeTraceStore();
	const updates: RuntimeTraceUpdate[] = [];
	const context = { cwd: "/project", onTraceUpdate: (update: RuntimeTraceUpdate) => updates.push(update) };
	let first: ReturnType<CodeModeTraceStore["start"]> | undefined;
	for (let index = 0; index < 800; index += 1) {
		const trace = traces.start("cell", `nested-${String(index)}`, "read", { path: `${String(index)}.ts` });
		first ??= trace;
		traces.emit("cell", trace, context);
	}

	expect(() => traces.start("cell", "nested-799", "read", {})).toThrow(
		"Duplicate Code Mode nested Tool call ID: nested-799",
	);
	expect(() => traces.start("cell", "nested-0", "read", {})).toThrow(
		"Duplicate Code Mode nested Tool call ID: nested-0",
	);
	if (!first) throw new Error("expected the first trace fixture");
	first.status = "done";
	first.result = {
		addedToolNames: ["ctx_search"],
		content: [{ text: "settled", type: "text" }],
		details: {},
		terminate: true,
	};
	traces.emit("cell", first, context);
	const response = traces.attach({ cellId: "cell", contentItems: [], kind: "result" });
	expect(updates).toHaveLength(801);
	expect(updates.at(-1)).toMatchObject({
		droppedTraceCount: 32,
		trace: { id: "nested-0", result: { addedToolNames: ["ctx_search"], terminate: true }, status: "done" },
	});
	expect(updates.slice(0, -1).every((update) => update.trace.status === "running")).toBe(true);
	expect(updates.every((update) => !("traces" in update))).toBe(true);
	expect(response.droppedTraceCount).toBe(32);
	expect(response.traces).toHaveLength(768);
	expect(response.traces?.[0]?.id).toBe("nested-32");
	expect(response.traces?.at(-1)?.id).toBe("nested-799");
});
