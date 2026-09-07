import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	CONTEXT_ACTIVITY_ENTRY_TYPE,
	ContextActivityRegistry,
	contextActivityUpdateFromMagic,
	failedContextActivity,
	isContextActivitySettled,
} from "../../../packages/pi-stuff/src/context-management/activity.js";

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

test("renders one Pi Stuff activity row while persisted updates stay hidden", () => {
	let renders = 0;
	const registry = new ContextActivityRegistry(() => {
		renders++;
	});
	const anchor = registry.create("wrapup", "keeping 20 recent messages");
	const component = registry.render(
		{
			customType: CONTEXT_ACTIVITY_ENTRY_TYPE,
			data: anchor,
			id: "entry-a",
			parentId: null,
			timestamp: "2026-08-13T00:00:00.000Z",
			type: "custom",
		},
		{ expanded: false },
		theme,
	);
	if (!component) throw new Error("Expected Context activity component");
	expect(anchor.id).toMatch(/^context-[\da-f-]{36}$/u);
	expect(component.render(80)).toEqual([" • Context wrapup · keeping 20 recent messages…"]);

	const update = registry.update(
		anchor.id,
		contextActivityUpdateFromMagic("wrapup", {
			level: "success",
			text: "## Magic Wrapup\n\nWrapped up 84 messages into 3 compartments.",
			title: "/ctx-wrapup",
		}),
	);
	expect(
		registry.render(
			{
				customType: CONTEXT_ACTIVITY_ENTRY_TYPE,
				data: update,
				id: "entry-b",
				parentId: null,
				timestamp: "2026-08-13T00:00:01.000Z",
				type: "custom",
			},
			{ expanded: false },
			theme,
		),
	).toBeUndefined();
	expect(component.render(80)).toEqual([" • Context wrapup · wrapped up 84 messages into 3 compartments"]);
	expect(renders).toBeGreaterThan(0);
});

test("keeps adapted command detail bounded, expandable, and terminal-width safe", () => {
	const registry = new ContextActivityRegistry(() => {});
	const anchor = registry.create("recomp", "starting");
	registry.update(
		anchor.id,
		contextActivityUpdateFromMagic("recomp", {
			level: "warning",
			text: [
				"## ⚠️ Recomp Confirmation Required",
				"",
				"Running /ctx-recomp will regenerate all compartments.",
				"To confirm, run `/ctx-recomp` again within 60 seconds.",
			].join("\n"),
			title: "/ctx-recomp",
		}),
	);
	const component = registry.render(
		{
			customType: CONTEXT_ACTIVITY_ENTRY_TYPE,
			data: anchor,
			id: "entry-a",
			parentId: null,
			timestamp: "2026-08-13T00:00:00.000Z",
			type: "custom",
		},
		{ expanded: true },
		theme,
	);
	if (!component) throw new Error("Expected Context activity component");
	const lines = component.render(46);
	expect(lines[0]).toBe(" • Context recomp · confirmation required");
	expect(lines.join("\n")).toContain("/ctx recomp");
	expect(lines.join("\n")).not.toContain("/ctx-recomp");
	expect(lines.every((line) => visibleWidth(line) <= 46)).toBeTrue();
});

test("keeps a partial recomp start running until its terminal result arrives", () => {
	const update = contextActivityUpdateFromMagic("recomp", {
		level: "info",
		text: "## Magic Recomp\n\nPartial recomp started for range 1-500.",
		title: "/ctx-recomp",
	});
	expect(update).toEqual({
		detail: "Magic Recomp\n\nPartial recomp started for range 1-500.",
		state: "running",
		summary: "rebuilding range 1-500",
	});
	expect(
		isContextActivitySettled({
			...update,
			id: "context-00000000-0000-0000-0000-000000000000",
			kind: "update",
			operation: "recomp",
			version: 1,
		}),
	).toBeFalse();
});

test("bounds unexpected failure detail before persisting it", () => {
	const failure = failedContextActivity(new Error(`bad\u001b[2J${"x".repeat(20_000)}`));
	expect(failure.state).toBe("error");
	expect(failure.summary).toBe("failed");
	expect(failure.detail).not.toContain("\u001b");
	expect(failure.detail.length).toBeLessThan(13_000);
});

test("rejects malformed restored activities and sanitizes accepted Session data", () => {
	const registry = new ContextActivityRegistry(() => {});
	const anchor = registry.create("flush", "starting");
	expect(
		registry.render(
			{
				customType: CONTEXT_ACTIVITY_ENTRY_TYPE,
				data: { ...anchor, operation: "constructor" },
				id: "entry-bad",
				parentId: null,
				timestamp: "2026-08-13T00:00:00.000Z",
				type: "custom",
			},
			{ expanded: false },
			theme,
		),
	).toBeUndefined();

	const component = registry.render(
		{
			customType: CONTEXT_ACTIVITY_ENTRY_TYPE,
			data: { ...anchor, detail: `detail\u001b[2J${"x".repeat(20_000)}`, summary: "done\u001b[31m" },
			id: "entry-safe",
			parentId: null,
			timestamp: "2026-08-13T00:00:01.000Z",
			type: "custom",
		},
		{ expanded: true },
		theme,
	);
	if (!component) throw new Error("Expected sanitized Context activity component");
	const rendered = component.render(80).join("\n");
	expect(rendered).not.toContain("\u001b");
	expect(rendered.length).toBeLessThan(14_000);
});
