import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import type {
	AgentRow,
	AgentSessionSnapshot,
	AgentStatus,
	CurrentAgentsView,
} from "../../../packages/pi-stuff/src/subagents/src/session/current-agents.js";
import {
	AgentRoster,
	type AgentRosterContext,
	type AgentRosterOptions,
} from "../../../packages/pi-stuff/src/subagents/src/ui/agent-roster.js";
import { createTestAgentEffectOwner } from "../../agents/agent-effect-owner-fixture.js";
import { testTheme } from "../../fixtures/extension-context.js";
import { TestTui } from "../../fixtures/test-tui.js";

type InputResult = { consume?: boolean; data?: string } | undefined;
type InputHandler = (data: string) => InputResult;

interface RosterComponent {
	invalidate(): void;
	render(width: number): string[];
}

type RosterFactory = (tui: TUI, theme: Theme) => RosterComponent;

const theme = testTheme;

const editor = {
	getText: () => "",
	handleInput: () => {},
	invalidate: () => {},
	render: () => [],
	setText: () => {},
};

class CurrentAgentsHarness {
	readonly actions: Array<{ key: string; type: string }> = [];
	private readonly listeners = new Set<(snapshot: AgentSessionSnapshot) => void>();
	private value: AgentSessionSnapshot;

	constructor(rows: readonly AgentRow[]) {
		this.value = { revision: 1, rows, sessionId: "session" };
	}

	asCurrentAgents(): CurrentAgentsView {
		return this;
	}

	control(action: Parameters<CurrentAgentsView["control"]>[0]): ReturnType<CurrentAgentsView["control"]> {
		this.actions.push(action);
		return Promise.resolve({
			acknowledged: true,
			key: action.key,
			message: "accepted",
			status: null,
			type: action.type,
		});
	}

	snapshot(): AgentSessionSnapshot {
		return this.value;
	}

	subscribe(listener: (snapshot: AgentSessionSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	update(rows: readonly AgentRow[]): void {
		this.value = { revision: this.value.revision + 1, rows, sessionId: "session" };
		for (const listener of this.listeners) listener(this.value);
	}
}

class UiHarness {
	editorText = "";
	focusedComponent: Component = editor;
	readonly notifications: Array<{ message: string; level: string }> = [];
	readonly placements: Array<string | undefined> = [];
	readonly renderRequests: number[] = [];
	readonly widgetWrites: Array<RosterFactory | undefined> = [];
	private component: RosterComponent | undefined;
	private inputHandler: InputHandler | undefined;

	readonly tui = new TestTui();

	constructor() {
		this.tui.getFocusedComponent = () => this.focusedComponent;
	}

	context(): AgentRosterContext {
		// SAFETY: this test controls the value and supplies every AgentRosterContext member exercised by this case.
		return { hasUI: true, ui: this as AgentRosterContext["ui"] };
	}

	emit(data: string): InputResult {
		return this.inputHandler?.(data);
	}

	getEditorText(): string {
		return this.editorText;
	}

	hasInputListener(): boolean {
		return this.inputHandler !== undefined;
	}

	notify(message: string, level: string): void {
		this.notifications.push({ level, message });
	}

	onTerminalInput(handler: InputHandler): () => void {
		this.inputHandler = handler;
		return () => {
			if (this.inputHandler === handler) this.inputHandler = undefined;
		};
	}

	render(width: number): string[] {
		return this.component?.render(width) ?? [];
	}

	setWidget(_key: string, factory: RosterFactory | undefined, options?: { placement?: string }): void {
		this.component = factory?.(this.tui, theme);
		this.widgetWrites.push(factory);
		this.placements.push(options?.placement);
	}
}

function row(
	key: string,
	status: AgentStatus,
	overrides: {
		contextUsage?: AgentRow["contextUsage"];
		description?: string;
		elapsedMs?: number;
		endedAt?: number;
		name?: string;
		startedAt?: number;
		task?: string;
	} = {},
): AgentRow {
	const task = overrides.task ?? `work assigned to ${key}`;
	return {
		childIndex: 0,
		contextUsage: overrides.contextUsage ?? null,
		cumulativeUsage: null,
		terminalOutcome: null,
		description: overrides.description ?? task,
		endedAt: overrides.endedAt ?? null,
		error: null,
		elapsedMs: overrides.elapsedMs ?? null,
		key,
		name: overrides.name ?? key,
		nestedAgents: [],
		nestedCount: 0,
		partialResult: null,
		runId: `run-${key}`,
		savedOutputPath: null,
		sessionFile: null,
		sessionId: "session",
		startedAt: overrides.startedAt ?? null,
		status,
		task,
		transcriptPath: null,
	};
}

function setup(rows: readonly AgentRow[], options: Partial<AgentRosterOptions> = {}) {
	const current = new CurrentAgentsHarness(rows);
	const ui = new UiHarness();
	const opened: string[] = [];
	const roster = new AgentRoster(current.asCurrentAgents(), {
		effects: createTestAgentEffectOwner(),
		onOpen: (key) => {
			opened.push(key);
		},
		...options,
	});
	roster.setContext(ui.context());
	return { current, opened, roster, ui };
}

function lineFor(lines: readonly string[], name: string): string {
	const line = lines.find((candidate) => candidate.includes(name));
	if (!line) throw new Error(`Expected a line containing ${name}`);
	return line;
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

class FakeClock {
	now = 1_000;
	private nextId = 0;
	private readonly sleepers = new Map<
		number,
		{ readonly dueAt: number; readonly resume: (effect: Effect.Effect<void>) => void }
	>();

	readonly sleep = (delayMs: number): Effect.Effect<void> =>
		Effect.callback((resume) => {
			const id = ++this.nextId;
			this.sleepers.set(id, { dueAt: this.now + delayMs, resume });
			return Effect.sync(() => this.sleepers.delete(id));
		});

	async advance(ms: number): Promise<void> {
		const target = this.now + ms;
		for (;;) {
			const due = [...this.sleepers.entries()]
				.filter(([, sleeper]) => sleeper.dueAt <= target)
				.sort((left, right) => left[1].dueAt - right[1].dueAt)[0];
			if (!due) {
				this.now = target;
				return;
			}
			this.now = due[1].dueAt;
			this.sleepers.delete(due[0]);
			due[1].resume(Effect.void);
			await Bun.sleep(0);
		}
	}
}

test("keeps a live Agent state above the tertiary dim token", () => {
	const colors: Array<{ color: string; text: string }> = [];
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const recordingTheme = {
		...theme,
		fg: (color: string, text: string) => {
			colors.push({ color, text });
			return text;
		},
	} as Theme;
	const result = setup([row("research", "running", { elapsedMs: 5_000 })]);
	result.roster.setFooterHosted(true);
	const tail = result.roster.createFooterTail(result.ui.tui, recordingTheme);
	tail.render(80);
	expect(colors).toContainEqual({ color: "muted", text: "5s" });
	expect(colors).not.toContainEqual({ color: "dim", text: "5s" });
	tail.dispose();
	result.roster.dispose();
});

test("mounts below the editor only while direct children exist", () => {
	const result = setup([]);
	expect(result.ui.render(80)).toEqual([]);
	expect(result.ui.hasInputListener()).toBe(false);

	result.current.update([row("research", "running")]);
	expect(result.ui.placements.at(-1)).toBe("belowEditor");
	expect(result.ui.hasInputListener()).toBe(true);
	expect(result.ui.render(80).join("\n")).toContain("research");

	result.current.update([]);
	expect(result.ui.widgetWrites.at(-1)).toBeUndefined();
	expect(result.ui.hasInputListener()).toBe(false);
	expect(result.ui.render(80)).toEqual([]);
	result.roster.dispose();
});

test("renders as the shared Footer tail without also mounting belowEditor", () => {
	const result = setup([row("research", "running")]);
	result.roster.setFooterHosted(true);
	const tail = result.roster.createFooterTail(result.ui.tui, theme);

	expect(result.ui.widgetWrites.at(-1)).toBeUndefined();
	expect(tail.render(80)[0]).toBe("● main");
	expect(tail.render(80).join("\n")).toContain("research");
	expect(tail.replacesBaseRow2).toBeFalse();
	expect(result.ui.hasInputListener()).toBe(true);

	result.ui.emit("\u001b[B");
	expect(tail.replacesBaseRow2).toBeTrue();
	expect(tail.render(80)[0]).toBe("↑/↓ select · Enter view · Esc return");
	tail.dispose();
	result.roster.dispose();
});

test("starts every Fleetview marker, management hint, and overflow indicator at cell one", () => {
	const result = setup(Array.from({ length: 6 }, (_, index) => row(`scout-${index + 1}`, "running")));
	const idle = result.ui.render(100);

	expect(idle[0]).toBe("● main");
	expect(lineFor(idle, "scout-1")).toMatch(/^○ scout-1(?:\s|$)/u);
	expect(idle.at(-1)).toBe("… +1 more");
	expect(idle.every((line) => !line.startsWith(" "))).toBeTrue();

	result.ui.emit("\u001b[B");
	expect(result.ui.render(100)[0]).toBe("↑/↓ select · Enter view · Esc return");
	expect(result.ui.render(64)[0]).toBe("↑/↓ · Enter · Esc");
	result.roster.dispose();
});

test("orders live work before terminal work and caps the passive viewport", () => {
	const rows = [
		row("done", "completed"),
		row("run", "running", { elapsedMs: 5_000 }),
		row("fail", "failed"),
		row("wait", "waiting_supervisor"),
		row("queue", "queued"),
		row("stop", "agent_stopped"),
		row("active", "running"),
	];
	const result = setup(rows);
	const normal = result.ui.render(100);
	const normalText = normal.join("\n");

	expect(normalText).toContain("… +2 more");
	expect(normalText.indexOf("run")).toBeLessThan(normalText.indexOf("done"));
	expect(normalText.indexOf("wait")).toBeLessThan(normalText.indexOf("done"));
	expect(normalText.indexOf("queue")).toBeLessThan(normalText.indexOf("done"));
	expect(normal.filter((line) => rows.some((item) => line.includes(item.name)))).toHaveLength(5);

	const narrow = result.ui.render(64);
	expect(narrow.join("\n")).toContain("… +3 more");
	expect(narrow.filter((line) => rows.some((item) => line.includes(item.name)))).toHaveLength(4);
	expect(narrow.every((line) => visibleWidth(line) <= 64 && !line.includes("\n"))).toBe(true);
	result.roster.dispose();
});

test("keeps the short state at the right and omits an unreadable description", () => {
	const result = setup([
		row("queued-child", "queued", {
			description: "复核 sample.txt 🧪",
			name: "researcher",
			task: "Inspect /tmp/pi-run/deep/sample.txt and verify every byte without changing the file",
		}),
	]);
	for (const width of [100, 64, 48, 32, 24]) {
		const rendered = result.ui.render(width);
		const agentLine = rendered.find((line) => line.trimEnd().endsWith("queued"));
		expect(agentLine).toBeDefined();
		if (!agentLine) continue;
		expect(agentLine).not.toContain("sample.tx…");
		expect(agentLine).not.toContain("…queued");
		expect(agentLine).toMatch(/\S\s{2,}queued$/);
		expect(visibleWidth(agentLine)).toBeLessThanOrEqual(width);
		expect(rendered.every((line) => visibleWidth(line) <= width && !line.includes("\n"))).toBe(true);
		expect(rendered.join("\n")).not.toMatch(/tokens?|tool|latest action|statusline/i);
		if (agentLine.includes("sample")) expect(agentLine).toContain("复核 sample.txt 🧪");
	}
	result.roster.dispose();
});

test("shows current Agent context pressure and drops it before identity on narrow rows", () => {
	const colors: Array<{ color: string; text: string }> = [];
	// SAFETY: this render probe exercises only Theme.fg; the test double preserves that exact callable contract.
	const recordingTheme = {
		...theme,
		fg: (color: string, text: string) => {
			colors.push({ color, text });
			return text;
		},
	} as Theme;
	const current = new CurrentAgentsHarness([
		row("low", "running", {
			contextUsage: { tokens: 1_052, contextWindow: 272_000 },
		}),
		row("zero", "running", {
			contextUsage: { tokens: 0, contextWindow: 272_000 },
		}),
		row("routine", "running", {
			contextUsage: { tokens: 37_500, contextWindow: 100_000 },
			elapsedMs: 5_000,
		}),
		row("pressure", "waiting_supervisor", {
			contextUsage: { tokens: 75_000, contextWindow: 100_000 },
		}),
		row("critical", "failed", {
			contextUsage: { tokens: 95_000, contextWindow: 100_000 },
		}),
	]);
	const ui = new UiHarness();
	const roster = new AgentRoster(current.asCurrentAgents(), {
		effects: createTestAgentEffectOwner(),
		onOpen: () => {},
	});
	roster.setContext(ui.context());
	roster.setFooterHosted(true);
	const tail = roster.createFooterTail(ui.tui, recordingTheme);

	const wide = tail.render(100);
	expect(lineFor(wide, "low")).toEndWith("<1% · running");
	expect(lineFor(wide, "zero")).toEndWith("0% · running");
	expect(lineFor(wide, "routine")).toEndWith("38% · 5s");
	expect(lineFor(wide, "pressure")).toEndWith("75% · waiting");
	expect(lineFor(wide, "critical")).toEndWith("95% · failed");
	expect(colors).toContainEqual({ color: "muted", text: "<1%" });
	expect(colors).toContainEqual({ color: "muted", text: "0%" });
	expect(colors).toContainEqual({ color: "muted", text: "38%" });
	expect(colors).toContainEqual({ color: "warning", text: "75%" });
	expect(colors).toContainEqual({ color: "error", text: "95%" });

	current.update([
		row("queued-child", "queued", {
			contextUsage: { tokens: 50_000, contextWindow: 100_000 },
			name: "researcher",
		}),
	]);
	expect(lineFor(tail.render(32), "researcher")).toEndWith("50% · queued");
	expect(lineFor(tail.render(24), "researcher")).toEndWith("queued");
	expect(lineFor(tail.render(24), "researcher")).not.toContain("50%");
	tail.dispose();
	roster.dispose();
});

test("removes terminal controls while preserving CJK names, tasks, and the right state", () => {
	const result = setup([
		row("unsafe", "failed", {
			description:
				"检查\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069\u001b[31m失败\u001b[0m\u009b32m输出\u009b0m",
			name: "审\u202e查\u001b]0;伪造标题\u0007员",
			task: "完整任务保留很长的中文说明与 /tmp/run/deep/sample.txt",
		}),
	]);
	const rendered = result.ui.render(64);
	const agentLine = lineFor(rendered, "审查员");

	expect(agentLine.trimEnd().endsWith("failed")).toBe(true);
	expect(agentLine).toContain("检查失败输出");
	expect(agentLine).not.toContain("伪造标题");
	expect(containsTerminalControl(agentLine)).toBe(false);
	expect(containsBidiFormatControl(agentLine)).toBe(false);
	expect(visibleWidth(agentLine)).toBeLessThanOrEqual(64);
	result.roster.dispose();
});

test("lingers terminal rows for 30 seconds while live rows never expire", async () => {
	const clock = new FakeClock();
	const terminal = row("finished", "completed", {
		description: "Review sample output",
		elapsedMs: 2_000,
		endedAt: clock.now,
	});
	const live = row("live", "running", { description: "Watch build", startedAt: clock.now });
	const result = setup([terminal, live], {
		now: () => clock.now,
		sleep: clock.sleep,
	});

	expect(result.ui.render(64).join("\n")).toContain("finished");
	await clock.advance(29_999);
	expect(result.ui.render(64).join("\n")).toContain("finished");
	await clock.advance(1);
	const afterExpiry = result.ui.render(64).join("\n");
	expect(afterExpiry).not.toContain("finished");
	expect(afterExpiry).toContain("live");
	expect(result.current.snapshot().rows.some(({ key }) => key === "finished")).toBe(true);
	await clock.advance(60_000);
	expect(result.ui.render(64).join("\n")).toContain("live");
	result.roster.dispose();
});

test("stops elapsed refresh work when the roster is disposed", async () => {
	const clock = new FakeClock();
	const result = setup([row("live", "running", { startedAt: clock.now })], {
		now: () => clock.now,
		sleep: clock.sleep,
	});
	await Bun.sleep(0);
	const initialRequests = result.ui.tui.renderRequests;

	await clock.advance(1_000);
	expect(result.ui.tui.renderRequests).toBeGreaterThan(initialRequests);
	result.roster.dispose();
	await Bun.sleep(0);
	const disposedRequests = result.ui.tui.renderRequests;

	await clock.advance(1_000);
	expect(result.ui.tui.renderRequests).toBe(disposedRequests);
});

test("omits an already-old terminal row on the first roster frame without deleting detail state", () => {
	const clock = new FakeClock();
	const oldTerminal = row("old-review", "completed", {
		description: "Review old output",
		elapsedMs: 2_000,
		endedAt: clock.now - 30_000,
	});
	const result = setup([oldTerminal], {
		now: () => clock.now,
		sleep: clock.sleep,
	});

	expect(result.ui.render(64)).toEqual([]);
	expect(result.ui.hasInputListener()).toBe(false);
	expect(result.current.snapshot().rows).toEqual([oldTerminal]);
	result.roster.dispose();
});

test("settles a running row to an unmistakable completed state and freezes elapsed time", async () => {
	const clock = new FakeClock();
	const running = row("reviewer", "running", {
		description: "Review sample output",
		startedAt: clock.now - 18_000,
	});
	const result = setup([running], {
		now: () => clock.now,
		sleep: clock.sleep,
	});
	expect(lineFor(result.ui.render(100), "reviewer")).toMatch(/\s{2,}18s$/u);
	if (running.startedAt == null) throw new Error("Expected running start time");

	result.current.update([
		row("reviewer", "completed", {
			description: "Review sample output",
			elapsedMs: 18_000,
			endedAt: clock.now,
			startedAt: running.startedAt,
		}),
	]);
	for (const width of [100, 64, 48, 32, 24]) {
		const agentLine = result.ui.render(width).find((line) => line.trimEnd().endsWith("done · 18s"));
		expect(agentLine).toBeDefined();
		if (!agentLine) continue;
		expect(agentLine).not.toContain("…done");
		expect(agentLine).toMatch(/\S\s{2,}done · 18s$/);
		expect(visibleWidth(agentLine)).toBeLessThanOrEqual(width);
	}
	await clock.advance(5_000);
	expect(lineFor(result.ui.render(100), "reviewer")).toEndWith("done · 18s");
	result.roster.dispose();

	const legacy = setup([row("legacy", "completed", { description: "Review legacy output" })]);
	const legacyLine = lineFor(legacy.ui.render(48), "legacy");
	expect(legacyLine).toMatch(/\s{2,}done$/u);
	expect(legacyLine).not.toMatch(/completed/i);
	legacy.roster.dispose();
});

test("uses marker color only for selection and confines state color to the right text", () => {
	const colors: Array<{ color: string; text: string }> = [];
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const recordingTheme = {
		...theme,
		fg: (color: string, text: string) => {
			colors.push({ color, text });
			return text;
		},
	} as Theme;
	const result = setup([row("scout", "waiting_supervisor")]);
	result.roster.setFooterHosted(true);
	const tail = result.roster.createFooterTail(result.ui.tui, recordingTheme);

	tail.render(100);
	expect(colors).toContainEqual({ color: "text", text: "●" });
	expect(colors).toContainEqual({ color: "muted", text: "○" });
	expect(colors).toContainEqual({ color: "warning", text: "waiting" });
	expect(colors).not.toContainEqual({ color: "warning", text: "○" });

	colors.length = 0;
	result.ui.emit("\u001b[B");
	tail.render(100);
	expect(colors.filter(({ color, text }) => color === "accent" && text === "●")).toHaveLength(1);
	expect(colors).toContainEqual({ color: "muted", text: "○" });

	colors.length = 0;
	result.ui.emit("\u001b[B");
	tail.render(100);
	expect(colors.filter(({ color, text }) => color === "accent" && text === "●")).toHaveLength(1);
	expect(colors).toContainEqual({ color: "muted", text: "○" });
	tail.dispose();
	result.roster.dispose();
});

test("styles every routine, waiting, and error state with the Revision 2 semantic token", () => {
	const cases: ReadonlyArray<{
		readonly color: string;
		readonly status: AgentStatus;
		readonly text: string;
	}> = [
		{ color: "muted", status: "queued", text: "queued" },
		{ color: "muted", status: "running", text: "running" },
		{ color: "muted", status: "resuming", text: "resuming" },
		{ color: "muted", status: "stopping", text: "stopping" },
		{ color: "muted", status: "completed", text: "done" },
		{ color: "muted", status: "agent_stopped", text: "stopped" },
		{ color: "muted", status: "user_cancelled", text: "cancelled" },
		{ color: "warning", status: "waiting_supervisor", text: "waiting" },
		{ color: "error", status: "failed", text: "failed" },
		{ color: "error", status: "crashed", text: "crashed" },
	];

	for (const expected of cases) {
		const colors: Array<{ color: string; text: string }> = [];
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		const recordingTheme = {
			...theme,
			fg: (color: string, text: string) => {
				colors.push({ color, text });
				return text;
			},
		} as Theme;
		const result = setup([row("worker", expected.status)]);
		result.roster.setFooterHosted(true);
		const tail = result.roster.createFooterTail(result.ui.tui, recordingTheme);
		tail.render(100);
		expect(colors).toContainEqual({ color: expected.color, text: expected.text });
		tail.dispose();
		result.roster.dispose();
	}
});

test("only enters keyboard navigation from an empty, truly focused editor", () => {
	const result = setup([row("child", "running")]);
	result.ui.editorText = "draft";
	expect(result.ui.emit("\u001b[B")).toBeUndefined();
	expect(result.ui.render(80).join("\n")).not.toContain("↑/↓");

	result.ui.editorText = "";
	result.ui.focusedComponent = { invalidate: () => {}, render: () => [] };
	expect(result.ui.emit("\u001b[B")).toBeUndefined();
	expect(result.ui.render(80).join("\n")).not.toContain("↑/↓");

	result.ui.focusedComponent = editor;
	expect(result.ui.emit("\u001b[B")).toEqual({ consume: true });
	expect(result.ui.render(80)[0]).toBe("↑/↓ select · Enter view · Esc return");
	result.roster.dispose();
});

test("navigates without wrapping, opens children, and returns from main", () => {
	const result = setup([row("first", "running"), row("second", "waiting_supervisor")]);
	expect(result.ui.emit("\u001b[B")).toEqual({ consume: true });
	expect(result.ui.emit("\u001b[A")).toEqual({ consume: true });
	expect(lineFor(result.ui.render(80), "main")).toContain("●");

	expect(result.ui.emit("\u001b[B")).toEqual({ consume: true });
	expect(result.ui.emit("\r")).toEqual({ consume: true });
	expect(result.opened).toEqual(["first"]);

	expect(result.ui.emit("\u001b[B")).toEqual({ consume: true });
	expect(result.ui.emit("\u001b[B")).toEqual({ consume: true });
	expect(result.ui.emit("\u001b[B")).toEqual({ consume: true });
	expect(lineFor(result.ui.render(80), "second")).toContain("●");
	expect(result.ui.emit("\u001b[B")).toEqual({ consume: true });
	expect(lineFor(result.ui.render(80), "second")).toContain("●");

	expect(result.ui.emit("\u001b")).toEqual({ consume: true });
	expect(result.ui.render(80)[0]).toBe("● main");
	expect(result.ui.emit("\u001b[B")).toEqual({ consume: true });
	expect(result.ui.emit("\r")).toEqual({ consume: true });
	expect(result.ui.render(80)[0]).toBe("● main");
	result.roster.dispose();
});

test("uses contextual main, live-child, and terminal-child management hints", () => {
	const live = setup([row("live", "running")]);
	live.ui.emit("\u001b[B");
	expect(live.ui.render(80)[0]).toBe("↑/↓ select · Enter view · Esc return");
	expect(live.ui.render(64)[0]).toBe("↑/↓ · Enter · Esc");
	live.ui.emit("\u001b[B");
	expect(live.ui.render(80)[0]).toBe("↑/↓ select · Enter view · x stop · Esc return");
	expect(live.ui.render(64)[0]).toBe("↑/↓ · Enter · x stop · Esc");
	live.roster.dispose();

	const terminal = setup([row("done", "completed")]);
	terminal.ui.emit("\u001b[B");
	terminal.ui.emit("\u001b[B");
	expect(terminal.ui.render(80)[0]).toBe("↑/↓ select · Enter view · x dismiss · Esc return");
	expect(terminal.ui.render(64)[0]).toBe("↑/↓ · Enter · x dismiss · Esc");
	terminal.roster.dispose();
});

test("stops live rows, dismisses terminal rows, and lets unrelated printable input through", () => {
	const live = setup([row("live", "running")]);
	live.ui.emit("\u001b[B");
	live.ui.emit("\u001b[B");
	expect(live.ui.emit("x")).toEqual({ consume: true });
	expect(live.current.actions).toEqual([{ key: "live", type: "stop" }]);
	expect(live.ui.emit("q")).toBeUndefined();
	expect(live.ui.render(80)[0]).toBe("● main");
	live.roster.dispose();

	const terminal = setup([row("finished", "completed")]);
	terminal.ui.emit("\u001b[B");
	terminal.ui.emit("\u001b[B");
	expect(terminal.ui.emit("x")).toEqual({ consume: true });
	expect(terminal.current.actions).toEqual([]);
	expect(terminal.ui.render(80)).toEqual([]);
	expect(terminal.current.snapshot().rows.map(({ key }) => key)).toEqual(["finished"]);
	terminal.roster.dispose();
});

test("keeps an offscreen selection visible and unregisters all chrome while suppressed", () => {
	const result = setup(Array.from({ length: 7 }, (_, index) => row(`child-${index + 1}`, "running")));
	result.ui.emit("\u001b[B");
	for (let index = 0; index < 7; index++) result.ui.emit("\u001b[B");

	const selectedView = result.ui.render(64);
	expect(lineFor(selectedView, "child-7")).toContain("●");
	expect(selectedView.join("\n")).toContain("… +3 more");

	result.roster.setSuppressed(true);
	expect(result.ui.widgetWrites.at(-1)).toBeUndefined();
	expect(result.ui.hasInputListener()).toBe(false);
	expect(result.ui.render(64)).toEqual([]);

	result.roster.setSuppressed(false);
	expect(result.ui.hasInputListener()).toBe(true);
	expect(result.ui.placements.at(-1)).toBe("belowEditor");
	result.roster.dispose();
});
