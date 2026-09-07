import { describe, expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	formatCollapsedNextLine,
	formatOverlayOverflowLine,
	formatOverlayTaskLine,
	type OverlayTask,
	selectOpenBlockers,
	selectOverlayLayout,
} from "../../../packages/pi-stuff/src/todo/view/format.js";

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const recordingTheme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	strikethrough: (text: string) => `<strike>${text}</strike>`,
} as Theme;

function task(overrides: Partial<OverlayTask> = {}): OverlayTask {
	return {
		id: "task-1",
		subject: "quiet task",
		status: "pending",
		...overrides,
	};
}

function containsTerminalControl(value: string): boolean {
	return [...value].some((character) => {
		const code = character.codePointAt(0) ?? 0;
		return code < 0x20 || (code >= 0x7f && code <= 0x9f);
	});
}

function containsBidiFormatControl(value: string): boolean {
	return /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(value);
}

describe("formatOverlayTaskLine", () => {
	test("uses a quiet checkbox for runnable pending work", () => {
		expect(formatOverlayTaskLine({ task: task(), openBlockers: [] }, recordingTheme)).toBe(
			"<muted>□</muted> <text>quiet task</text>",
		);
	});

	test("uses an accent square and bold subject for in-progress work", () => {
		expect(formatOverlayTaskLine({ task: task({ status: "in_progress" }), openBlockers: [] }, recordingTheme)).toBe(
			"<accent>■</accent> <bold><accent>quiet task</accent></bold>",
		);
	});

	test("uses sanitized activeForm only for in-progress work and falls back to subject", () => {
		expect(
			formatOverlayTaskLine(
				{
					task: task({ activeForm: "  writing\n tests\u001b]0;hidden\u0007  ", status: "in_progress" }),
					openBlockers: [],
				},
				recordingTheme,
			),
		).toBe("<accent>■</accent> <bold><accent>writing tests</accent></bold>");
		expect(
			formatOverlayTaskLine(
				{ task: task({ activeForm: "\u001b]0;hidden\u0007", status: "in_progress" }), openBlockers: [] },
				recordingTheme,
			),
		).toContain("quiet task");
		for (const status of ["pending", "completed", "deleted"] as const) {
			expect(
				formatOverlayTaskLine(
					{ task: task({ activeForm: "must not leak", status }), openBlockers: [] },
					recordingTheme,
				),
			).not.toContain("must not leak");
		}
	});

	test("dims and strikes completed work", () => {
		expect(formatOverlayTaskLine({ task: task({ status: "completed" }), openBlockers: [] }, recordingTheme)).toBe(
			"<dim>✓</dim> <strike><dim>quiet task</dim></strike>",
		);
	});

	test("keeps the pending checkbox shape and warns through color without exposing dependency ids", () => {
		expect(formatOverlayTaskLine({ task: task(), openBlockers: ["dep-2", "missing"] }, recordingTheme)).toBe(
			"<warning>□</warning> <muted>quiet task</muted>",
		);
	});

	test("normalizes embedded whitespace to keep every task on one terminal row", () => {
		const line = formatOverlayTaskLine(
			{ task: task({ subject: "first\nsecond\tthird" }), openBlockers: [] },
			recordingTheme,
		);
		expect(line).toContain("first second third");
		expect(line).not.toContain("\n");
	});

	test("removes terminal controls without damaging CJK task text", () => {
		const line = formatOverlayTaskLine(
			{
				task: task({
					subject:
						"检查\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u001b[31m危险\u001b[0m\u001b]0;伪造标题\u0007 输出\u009b32m完成\u009b0m\u001b7 保留",
				}),
				openBlockers: ["依赖\u202e-2"],
			},
			recordingTheme,
		);

		expect(line).toContain("检查危险 输出完成 保留");
		expect(line).not.toContain("依赖-2");
		expect(line).not.toContain("伪造标题");
		expect(containsTerminalControl(line)).toBe(false);
		expect(containsBidiFormatControl(line)).toBe(false);
	});

	test("gives a blocked CJK and emoji subject the full width budget", () => {
		const row = {
			task: task({ subject: "检查🙂非常长的子任务路径与输出内容" }),
			openBlockers: ["依赖-🧪-非常长的名称"],
		};
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		const plainTheme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
			strikethrough: (text: string) => text,
		} as Theme;

		for (const width of [100, 64, 48, 32, 24]) {
			const line = formatOverlayTaskLine(row, plainTheme, width);
			const plain = Bun.stripANSI(line);
			expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			expect(plain).not.toContain("依赖");
			expect(plain).toContain("检查🙂");
		}
	});

	test("keeps a meaningful row when the subject contains only terminal commands", () => {
		const line = formatOverlayTaskLine(
			{ task: task({ subject: "\u001b[31m\u001b[0m\u001b]0;hidden\u0007" }), openBlockers: [] },
			recordingTheme,
		);

		expect(line).toContain("untitled task");
		expect(line).not.toContain("hidden");
	});
});

describe("selectOverlayLayout", () => {
	test("orders five rows by recency/status/blocking, then stable string id", () => {
		const tasks: OverlayTask[] = [
			task({ id: "10", subject: "recent 10", status: "completed" }),
			task({ id: "4", subject: "old", status: "completed" }),
			task({ id: "5", subject: "blocked", blockedBy: ["1"] }),
			task({ id: "3", subject: "active", status: "in_progress" }),
			task({ id: "1", subject: "runnable" }),
			task({ id: "2", subject: "recent 2", status: "completed" }),
		];
		const layout = selectOverlayLayout(tasks, new Set(["10", "2"]));

		expect(layout.visible.map((row) => row.task.id)).toEqual(["2", "10", "3", "1", "5"]);
		expect(layout.hidden.map((row) => row.task.id)).toEqual(["4"]);
		expect(layout.next?.task.id).toBe("3");
	});

	test("considers completed/deleted dependencies resolved and missing ones open", () => {
		const subject = task({ id: "subject", blockedBy: ["done", "deleted", "open", "missing"] });
		const all = [
			subject,
			task({ id: "done", status: "completed" }),
			task({ id: "deleted", status: "deleted" }),
			task({ id: "open", status: "pending" }),
		];
		const byId = new Map(all.map((item) => [String(item.id), item]));

		expect(selectOpenBlockers(subject, byId)).toEqual(["open", "missing"]);
	});

	test("never exposes more than five task rows", () => {
		const tasks = Array.from({ length: 8 }, (_, index) => task({ id: String(index + 1) }));
		const layout = selectOverlayLayout(tasks, new Set(), 99);
		expect(layout.visible).toHaveLength(5);
		expect(layout.hidden).toHaveLength(3);
		expect(formatOverlayOverflowLine(layout.hidden, recordingTheme)).toBe("<dim>… +3 pending</dim>");
	});
});

describe("formatCollapsedNextLine", () => {
	test("renders one compact Next line", () => {
		expect(formatCollapsedNextLine({ task: task({ subject: "ship it" }), openBlockers: [] }, recordingTheme)).toBe(
			"<muted>Next:</muted> <text>ship it</text>",
		);
	});

	test("has an all-complete fallback during the five-second linger", () => {
		expect(formatCollapsedNextLine(undefined, recordingTheme)).toBe(
			"<muted>Next:</muted> <dim>all tasks complete</dim>",
		);
	});

	test("uses the same fallback for a collapsed control-only subject", () => {
		expect(
			formatCollapsedNextLine(
				{ task: task({ subject: "\u001b]0;hidden\u0007" }), openBlockers: [] },
				recordingTheme,
			),
		).toBe("<muted>Next:</muted> <text>untitled task</text>");
	});

	test("keeps blocked state visible in collapsed mode without dependency ids", () => {
		expect(
			formatCollapsedNextLine(
				{ task: task({ subject: "waiting task" }), openBlockers: ["secret-dependency"] },
				recordingTheme,
			),
		).toBe("<muted>Next:</muted> <warning>□</warning> <muted>waiting task</muted>");
	});

	test("uses sanitized activeForm for the in-progress collapsed Next row", () => {
		expect(
			formatCollapsedNextLine(
				{
					task: task({ activeForm: "  shipping\n release\u001b]0;hidden\u0007", status: "in_progress" }),
					openBlockers: [],
				},
				recordingTheme,
			),
		).toBe("<muted>Next:</muted> <text>shipping release</text>");
	});
});
