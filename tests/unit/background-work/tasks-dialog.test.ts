import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type {
	BackgroundWorkOutcome,
	BackgroundWorkSnapshot,
} from "../../../packages/pi-stuff/src/background-work/src/runtime.js";
import { createTasksDialogView } from "../../../packages/pi-stuff/src/background-work/src/tasks-dialog.js";
import { TestTui } from "../../fixtures/test-tui.js";

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

class RuntimeHarness {
	readonly listeners = new Set<() => void>();
	readonly stopped: string[] = [];
	rows: BackgroundWorkSnapshot[] = [
		{
			command: "bun test --watch with a very long target that must remain a distinct field",
			id: "b-shell",
			kind: "shell",
			recentOutput: "first line\nsecond line",
			startedAt: Date.now() - 5_000,
			status: "running",
			title: "Run the complete verification command without blocking the main Agent",
		},
	];

	scheduleRefresh(): () => void {
		return () => {};
	}

	snapshot(): readonly BackgroundWorkSnapshot[] {
		return this.rows;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async stop(id: string): Promise<BackgroundWorkOutcome> {
		this.stopped.push(id);
		const row = this.rows.find((item) => item.id === id);
		this.rows = this.rows.filter((item) => item.id !== id);
		for (const listener of this.listeners) listener();
		return {
			endedAt: Date.now(),
			id,
			kind: row?.kind ?? "shell",
			startedAt: row?.startedAt ?? Date.now(),
			status: "stopped",
			summary: `Stopped ${id}`,
			title: row?.title ?? id,
		};
	}
}

function harness(rows = 24, activeTheme = theme, keybindings = new KeybindingsManager(TUI_KEYBINDINGS)) {
	let closed = 0;
	let renders = 0;
	return {
		closed: () => closed,
		context: {
			close: () => {
				closed += 1;
			},
			keybindings,
			requestRender: () => {
				renders += 1;
			},
			signal: new AbortController().signal,
			theme: activeTheme,
			tui: new TestTui(rows),
		},
		renders: () => renders,
	};
}

test("hides selection hints when there is no background work", () => {
	const runtime = new RuntimeHarness();
	runtime.rows = [];
	const component = createTasksDialogView(runtime).create(harness().context);
	const output = component.render(64).join("\n");
	expect(output).toContain("No background work in this session.");
	expect(output).not.toContain("select");
	expect(output).not.toContain("details");
	expect(output).toContain("? keys");
	expect(output).toContain("Esc close");
	component.handleInput?.("?");
	const keyHelp = component.render(64).join("\n");
	expect(keyHelp).not.toContain("Previous/next");
	expect(keyHelp).not.toContain("Open details");
	expect(keyHelp).toContain("Return one level");
	component.dispose?.();
});

test("keeps running task identity and state above the tertiary dim token", () => {
	const colors: Array<{ color: string; text: string }> = [];
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const recordingTheme = {
		...theme,
		fg: (color: string, text: string) => {
			colors.push({ color, text });
			return text;
		},
	} as Theme;
	const runtime = new RuntimeHarness();
	const ui = harness(24, recordingTheme);
	const component = createTasksDialogView(runtime).create(ui.context);
	component.render(92);
	expect(colors.some(({ color, text }) => color === "muted" && text.includes("Run the complete"))).toBe(false);
	expect(colors.some(({ color, text }) => color === "accent" && text.includes("●"))).toBe(true);
	expect(colors.some(({ color, text }) => color === "dim" && text.includes("Run the complete"))).toBe(false);
	component.dispose?.();
});

test("renders active Background Work as one full-width bounded list", () => {
	const runtime = new RuntimeHarness();
	const ui = harness();
	const component = createTasksDialogView(runtime).create(ui.context);
	const normal = component.render(92);
	expect(normal[0]).toBe("━".repeat(92));
	expect(normal.join("\n")).toContain("Tasks · 1 current");
	expect(normal.join("\n")).toContain("Shell");
	expect(normal.join("\n")).toContain("x stop");
	expect(normal.join("\n")).not.toMatch(/[╭╮╰╯]/u);

	const narrow = component.render(28);
	expect(narrow.every((line) => visibleWidth(line) <= 28)).toBe(true);
	expect(narrow.join("\n")).not.toContain("running · 5s");
	expect(narrow.join("\n")).toContain("Esc close");
	component.dispose?.();
});

test("keeps task selection and Shell detail together in one stable wide Dialog", () => {
	const runtime = new RuntimeHarness();
	const ui = harness(32);
	const component = createTasksDialogView(runtime).create(ui.context);
	const lines = component.render(100);
	const output = lines.join("\n");
	expect(lines).toHaveLength(18);
	expect(lines[0]).toBe("━".repeat(100));
	expect(lines.slice(1).every((line) => visibleWidth(line.slice(0, line.indexOf("┃"))) === 36)).toBe(true);
	expect(output).toContain("Tasks · 1 current");
	expect(output).toContain("Tasks / Shell");
	expect(output).toContain("Command");
	expect(output).toContain("Output");
	expect(output).not.toContain("◆");
	expect(output).toContain("first line");

	component.handleInput?.("\t");
	component.handleInput?.("\u001b");
	expect(ui.closed()).toBe(0);
	component.handleInput?.("\u001b[Z");
	component.handleInput?.("\u001b");
	expect(ui.closed()).toBe(0);
	component.handleInput?.("?");
	expect(component.render(100).join("\n")).toContain("Tasks / Keys");
	component.handleInput?.("\u001b");
	component.handleInput?.("\u001b");
	expect(ui.closed()).toBe(1);
	component.dispose?.();
});

test("shows a Monitor source, conditions, and latest evidence", () => {
	const runtime = new RuntimeHarness();
	runtime.rows = [
		{
			id: "monitor-health",
			kind: "monitor",
			monitorFailureText: "FATAL",
			monitorSource: "http",
			monitorSuccessText: "READY",
			monitorTarget: "https://example.test/health",
			monitorTimeoutSeconds: 30,
			recentOutput: "503 booting",
			startedAt: Date.now() - 3_000,
			status: "running",
			title: "Wait for service health",
		},
	];
	const ui = harness(32);
	const component = createTasksDialogView(runtime).create(ui.context);
	const output = component.render(100).join("\n");
	expect(output).toContain("Tasks / Monitor");
	expect(output).toContain("Source");
	expect(output).toContain("HTTP · https://example.test/health");
	expect(output).toContain('success contains "READY"');
	expect(output).toContain('failure contains "FATAL"');
	expect(output).toContain("timeout");
	expect(output).toContain("30s");
	expect(output).toContain("Latest evidence");
	expect(output).not.toContain("◆");
	expect(output).toContain("503 booting");
	component.dispose?.();
});

test("pages a long task list with Space", () => {
	const runtime = new RuntimeHarness();
	const template = runtime.rows[0];
	if (!template) throw new Error("missing task fixture");
	runtime.rows = Array.from({ length: 12 }, (_, index) => ({
		...template,
		id: `shell-${String(index + 1)}`,
		startedAt: Date.now() + index,
		title: `Task ${String(index + 1)}`,
	}));
	const ui = harness();
	const component = createTasksDialogView(runtime).create(ui.context);
	const overflow = component.render(64).join("\n");
	expect(overflow).toContain("b/Space page");
	expect(overflow).not.toContain("PgUp/PgDn page");
	component.handleInput?.(" ");
	component.handleInput?.("\r");
	expect(component.render(64).join("\n")).toContain("Task 7");
	component.dispose?.();
});

test("honors a user-rebound Pi selection key", () => {
	const runtime = new RuntimeHarness();
	const first = runtime.rows[0];
	if (!first) throw new Error("missing task fixture");
	runtime.rows = [first, { ...first, id: "second", title: "Second task" }];
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+y" });
	const component = createTasksDialogView(runtime).create(harness(24, theme, keybindings).context);
	component.render(64);
	component.handleInput?.("\u0019");
	component.handleInput?.("\r");
	expect(component.render(64).join("\n")).toContain("Second task");
	component.dispose?.();
});

test("stops a selected Shell or Monitor activity", async () => {
	const runtime = new RuntimeHarness();
	const ui = harness();
	const component = createTasksDialogView(runtime).create(ui.context);
	component.handleInput?.("x");
	await Bun.sleep(0);
	expect(runtime.stopped).toEqual(["b-shell"]);
	expect(component.render(72).join("\n")).not.toContain("Run the complete verification");
	expect(ui.renders()).toBeGreaterThan(0);
	component.dispose?.();
});

test("preserves controls in a short terminal", () => {
	const runtime = new RuntimeHarness();
	const ui = harness(6);
	const component = createTasksDialogView(runtime).create(ui.context);
	const lines = component.render(38);
	expect(lines).toHaveLength(3);
	expect(lines.join("\n")).toContain("Tasks");
	expect(lines.join("\n")).toContain("Shell");
	expect(lines.at(-1)).toContain("Esc close");
	component.dispose?.();
});
