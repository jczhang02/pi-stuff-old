import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	__resetState,
	getRenderState,
	replaceState,
	setActiveRenderSession,
} from "../../../packages/pi-stuff/src/todo/state/store.js";
import { TodoOverlay } from "../../../packages/pi-stuff/src/todo/todo-overlay.js";
import type { Task, TaskStatus } from "../../../packages/pi-stuff/src/todo/tool/types.js";

const SESSION_ID = "test-session";
const identityTheme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	strikethrough: (text: string) => text,
};

function task(
	id: string,
	subject: string,
	status: TaskStatus = "pending",
	blockedBy?: readonly string[],
	activeForm?: string,
): Task {
	const result: Task = { id, subject, description: `${subject} description`, status };
	if (blockedBy && blockedBy.length > 0) result.blockedBy = [...blockedBy];
	if (activeForm !== undefined) result.activeForm = activeForm;
	return result;
}

function setup(tasks: readonly Task[], options: { lingerCompleted?: boolean } = {}) {
	__resetState();
	setActiveRenderSession(SESSION_ID);
	replaceState(SESSION_ID, { tasks: [...tasks], nextId: tasks.length + 1 });

	const setWidgetCalls: unknown[][] = [];
	const setWidget = (...args: unknown[]): void => {
		setWidgetCalls.push(args);
	};
	// SAFETY: this test controls the value and supplies every ExtensionUIContext member exercised by this case.
	const ui = { setWidget, theme: identityTheme } as ExtensionUIContext;
	const overlay = new TodoOverlay();
	overlay.setUICtx(ui);
	overlay.refresh(options);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const factory = setWidgetCalls[0]?.[1] as
		| ((
				tui: { requestRender: (...args: unknown[]) => void },
				theme: typeof identityTheme,
		  ) => { render: (width: number) => string[]; invalidate: () => void })
		| undefined;
	const requestRenderCalls: unknown[][] = [];
	const requestRender = (...args: unknown[]): void => {
		requestRenderCalls.push(args);
	};
	const widget = factory?.({ requestRender }, identityTheme);
	return { overlay, requestRenderCalls, setWidgetCalls, widget };
}

beforeEach(() => {
	__resetState();
});

afterEach(() => {
	__resetState();
});

test("renders zero rows and registers nothing when the list is empty", () => {
	const { setWidgetCalls, widget } = setup([]);
	expect(setWidgetCalls).toHaveLength(0);
	expect(widget).toBeUndefined();
});

test("aligns the summary icon with the content edge and summary text with task glyphs", () => {
	const { setWidgetCalls, widget } = setup([task("1", "write tests")]);
	expect(setWidgetCalls).toHaveLength(1);
	expect(setWidgetCalls[0]?.[0]).toBe("rpiv-todos");
	expect(setWidgetCalls[0]?.[2]).toEqual({ placement: "aboveEditor" });
	expect(widget?.render(200)).toEqual([" 1 tasks (0 done, 1 open)", "  □ write tests"]);
});

test("shows at most five ordered task rows plus one overflow row", () => {
	const finalTasks = [
		task("1", "runnable 1"),
		task("2", "active", "in_progress"),
		task("3", "recent 3", "completed"),
		task("4", "blocked 4", "pending", ["1"]),
		task("5", "runnable 5"),
		task("6", "runnable 6"),
		task("7", "recent 7", "completed"),
	];
	const initialTasks = finalTasks.map((item) =>
		item.status === "completed" ? { ...item, status: "pending" as const } : item,
	);
	const { overlay, widget } = setup(initialTasks);
	replaceState(SESSION_ID, { tasks: finalTasks, nextId: 8 });
	overlay.refresh({ forceExpanded: true });
	expect(widget?.render(200)).toEqual([
		" 7 tasks (2 done, 5 open)",
		"  ✓ recent 3",
		"  ✓ recent 7",
		"  ■ active",
		"  □ runnable 1",
		"  □ runnable 5",
		"  … +2 pending",
	]);
});

test("keeps dependency metadata out of the user-facing checklist", () => {
	const { widget } = setup([
		task("1", "finished dependency", "completed"),
		task("2", "now runnable", "pending", ["1"]),
		task("3", "still blocked", "pending", ["2"]),
	]);
	const output = widget?.render(200).join("\n") ?? "";
	expect(output).toContain("□ now runnable");
	expect(output).toContain("□ still blocked");
	expect(output).not.toContain("⊘");
	expect(output).not.toContain("blocked by");
});

test("collapses to exactly one Next line and prefers active work", () => {
	const { overlay, widget } = setup([
		task("1", "pending"),
		task("2", "doing now", "in_progress", undefined, "Actively doing now"),
	]);
	overlay.toggle();
	expect(widget?.render(200)).toEqual(["  Next: Actively doing now"]);
});

test("forceExpanded restores task rows after a collapse", () => {
	const { overlay, widget } = setup([task("1", "one"), task("2", "two")]);
	overlay.toggle();
	expect(widget?.render(200)).toHaveLength(1);
	overlay.refresh({ forceExpanded: true });
	expect(widget?.render(200)).toEqual([" 2 tasks (0 done, 2 open)", "  □ one", "  □ two"]);
});

test("retains forceExpanded while a Command Dialog suppresses the widget", () => {
	const { overlay, widget } = setup([task("1", "one"), task("2", "two")]);
	overlay.toggle();
	expect(widget?.render(200)).toEqual(["  Next: one"]);

	overlay.setSuppressed(true);
	overlay.refresh({ forceExpanded: true });
	overlay.setSuppressed(false);

	expect(widget?.render(200)).toEqual([" 2 tasks (0 done, 2 open)", "  □ one", "  □ two"]);
	expect(overlay.isRegistered()).toBe(true);
});

test("normalizes and truncates a long subject to one terminal row", () => {
	const { widget } = setup([task("1", "a long\nsubject that cannot fit")]);
	const lines = widget?.render(18) ?? [];
	expect(lines).toHaveLength(2);
	expect(lines[1]).not.toContain("\n");
	expect(lines.every((line) => visibleWidth(line) <= 18)).toBe(true);
});

test("keeps aligned CJK, emoji, overflow, and collapsed rows inside the width matrix", () => {
	const { overlay, widget } = setup([
		task("1", "检查🙂一个非常长的中文任务名称，确保终端不会横向溢出", "in_progress"),
		task("2", "继续验证后续步骤🧪"),
		task("3", "第三个任务"),
		task("4", "第四个任务"),
		task("5", "第五个任务"),
		task("6", "第六个任务"),
		task("7", "第七个任务"),
	]);

	for (const width of [100, 64, 48, 32, 24]) {
		const lines = widget?.render(width) ?? [];
		expect(lines).toHaveLength(7);
		expect(lines.every((line) => visibleWidth(line) <= width && !line.includes("\n"))).toBe(true);
		expect(Bun.stripANSI(lines[0] ?? "").startsWith(" 7 tasks ")).toBe(true);
		expect(Bun.stripANSI(lines[0] ?? "").startsWith("  7 tasks ")).toBe(false);
		expect(Bun.stripANSI(lines[0] ?? "")).not.toContain("◆");
		expect(lines.slice(1).every((line) => Bun.stripANSI(line).startsWith("  "))).toBe(true);
		expect(lines.slice(1).every((line) => !Bun.stripANSI(line).startsWith("   "))).toBe(true);
	}

	overlay.toggle();
	for (const width of [100, 64, 48, 32, 24]) {
		const lines = widget?.render(width) ?? [];
		expect(lines).toHaveLength(1);
		expect(visibleWidth(lines[0] ?? "")).toBeLessThanOrEqual(width);
		expect(Bun.stripANSI(lines[0] ?? "").startsWith("  ")).toBe(true);
		expect(Bun.stripANSI(lines[0] ?? "").startsWith("   ")).toBe(false);
	}
});

test("preserves the blocked task subject across the width matrix", () => {
	const { widget } = setup([task("1", "检查🙂非常长的工作区路径和结果文件", "pending", ["依赖-🧪-非常长的名称"])]);

	for (const width of [100, 64, 48, 32, 24]) {
		const line = widget?.render(width)[1] ?? "";
		const plain = Bun.stripANSI(line);
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(plain).toContain("检查🙂");
		expect(plain).not.toContain("依赖");
	}
});

test("refreshes a registered widget without creating a second one", () => {
	const { overlay, requestRenderCalls, setWidgetCalls } = setup([task("1", "one")]);
	overlay.refresh();
	expect(setWidgetCalls).toHaveLength(1);
	expect(requestRenderCalls).toHaveLength(1);
});

describe("TodoOverlay all-complete linger", () => {
	test("keeps an already-completed replay hidden when no linger is requested", () => {
		const { overlay, setWidgetCalls } = setup([task("1", "already finished", "completed")]);
		expect(overlay.isRegistered()).toBe(false);
		expect(setWidgetCalls).toHaveLength(0);
	});

	test("keeps completed rows for five seconds, then hides only the widget", () => {
		const originalSetTimeout = globalThis.setTimeout;
		let scheduledCallback: (() => void) | undefined;
		let scheduledDelay: number | undefined;
		const timerHandle = { unref: () => {} };
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		globalThis.setTimeout = ((callback: () => void, delay?: number) => {
			scheduledCallback = callback;
			scheduledDelay = delay;
			return timerHandle;
		}) as typeof setTimeout;
		try {
			const { overlay, setWidgetCalls, widget } = setup([task("1", "finished", "completed")], {
				lingerCompleted: true,
			});
			expect(scheduledDelay).toBe(5_000);
			expect(widget?.render(200)).toEqual([" 1 tasks (1 done, 0 open)", "  ✓ finished"]);
			expect(overlay.isRegistered()).toBe(true);

			scheduledCallback?.();
			expect(overlay.isRegistered()).toBe(false);
			expect(setWidgetCalls.at(-1)).toEqual(["rpiv-todos", undefined]);
			expect(getRenderState().tasks).toHaveLength(1);
			expect(getRenderState().tasks[0]?.status).toBe("completed");
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});

	test("does not schedule hiding while any unfinished task remains", () => {
		const { overlay, setWidgetCalls } = setup([task("1", "finished", "completed"), task("2", "remaining")]);
		expect(overlay.isRegistered()).toBe(true);
		expect(setWidgetCalls).toHaveLength(1);
	});

	test("retains all-complete linger while a Command Dialog suppresses the widget", () => {
		const originalSetTimeout = globalThis.setTimeout;
		let scheduledCallback: (() => void) | undefined;
		let scheduledDelay: number | undefined;
		const timerHandle = { unref: () => {} };
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		globalThis.setTimeout = ((callback: () => void, delay?: number) => {
			scheduledCallback = callback;
			scheduledDelay = delay;
			return timerHandle;
		}) as typeof setTimeout;
		try {
			const { overlay } = setup([task("1", "finishing")]);
			overlay.setSuppressed(true);
			replaceState(SESSION_ID, { tasks: [task("1", "finishing", "completed")], nextId: 2 });
			overlay.refresh({ forceExpanded: true, lingerCompleted: true });
			expect(scheduledDelay).toBe(5_000);

			overlay.setSuppressed(false);
			expect(overlay.isRegistered()).toBe(true);
			scheduledCallback?.();
			expect(overlay.isRegistered()).toBe(false);
		} finally {
			globalThis.setTimeout = originalSetTimeout;
		}
	});
});
