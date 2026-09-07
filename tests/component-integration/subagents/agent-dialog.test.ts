import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type {
	CommandDialogComponent,
	CommandDialogViewContext,
} from "../../../packages/pi-stuff/src/conversation-ui/index.js";
import type {
	AgentControlAction,
	AgentControlResult,
	AgentRow,
	AgentSessionSnapshot,
	AgentStatus,
	CurrentAgentsView,
} from "../../../packages/pi-stuff/src/subagents/src/session/current-agents.js";
import {
	type AgentDialogOptions,
	type AgentTranscriptRequest,
	createAgentDialogView,
} from "../../../packages/pi-stuff/src/subagents/src/ui/agent-dialog.js";
import { testTheme } from "../../fixtures/extension-context.js";
import { TestTui } from "../../fixtures/test-tui.js";

const theme = testTheme;

function deferred<Value>() {
	return Promise.withResolvers<Value>();
}

class CurrentAgentsHarness {
	readonly actions: AgentControlAction[] = [];
	controlHandler: (action: AgentControlAction) => Promise<AgentControlResult> = async (action) =>
		result(action, true, "accepted");
	private readonly listeners = new Set<(snapshot: AgentSessionSnapshot) => void>();
	private value: AgentSessionSnapshot;

	constructor(rows: readonly AgentRow[]) {
		this.value = snapshot(rows);
	}

	asCurrentAgents(): CurrentAgentsView {
		return this;
	}

	control(action: AgentControlAction): Promise<AgentControlResult> {
		this.actions.push(action);
		return this.controlHandler(action);
	}

	snapshot(): AgentSessionSnapshot {
		return this.value;
	}

	subscribe(listener: (snapshot: AgentSessionSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.value);
		return () => this.listeners.delete(listener);
	}

	listenerCount(): number {
		return this.listeners.size;
	}

	update(rows: readonly AgentRow[]): void {
		this.value = snapshot(rows, this.value.revision + 1);
		for (const listener of this.listeners) listener(this.value);
	}
}

class DialogContextHarness {
	closed = 0;
	renderRequests = 0;
	readonly controller = new AbortController();
	readonly tui = new TestTui(28, 64);
	private readonly activeTheme: Theme;
	private readonly keybindings: KeybindingsManager;

	constructor(activeTheme = theme, keybindings = new KeybindingsManager(TUI_KEYBINDINGS)) {
		this.activeTheme = activeTheme;
		this.keybindings = keybindings;
	}

	context(): CommandDialogViewContext<void> {
		return {
			close: () => {
				this.closed += 1;
			},
			keybindings: this.keybindings,
			requestRender: () => {
				this.renderRequests += 1;
			},
			signal: this.controller.signal,
			theme: this.activeTheme,
			tui: this.tui,
		};
	}
}

function snapshot(rows: readonly AgentRow[], revision = 1): AgentSessionSnapshot {
	return { revision, rows, sessionId: "session" };
}

function row(key: string, status: AgentStatus, overrides: Partial<Omit<AgentRow, "key" | "status">> = {}): AgentRow {
	return {
		childIndex: 0,
		description: `work assigned to ${key}`,
		endedAt: ["agent_stopped", "completed", "crashed", "failed", "user_cancelled"].includes(status) ? 12_001 : null,
		error: null,
		elapsedMs: 12_000,
		contextUsage: null,
		cumulativeUsage: null,
		terminalOutcome: null,
		key,
		name: key,
		nestedAgents: [],
		nestedCount: 0,
		partialResult: null,
		runId: `run-${key}`,
		savedOutputPath: null,
		sessionFile: null,
		sessionId: "session",
		startedAt: 1,
		status,
		task: `work assigned to ${key}`,
		transcriptPath: `/tmp/${key}.jsonl`,
		...overrides,
	};
}

function result(action: AgentControlAction, acknowledged: boolean, message: string): AgentControlResult {
	return { acknowledged, key: action.key, message, status: null, type: action.type };
}

function setup(rows: readonly AgentRow[], options: Partial<AgentDialogOptions> = {}, activeTheme = theme) {
	const current = new CurrentAgentsHarness(rows);
	const context = new DialogContextHarness(activeTheme);
	const requests: AgentTranscriptRequest[] = [];
	const view = createAgentDialogView(current.asCurrentAgents(), {
		readTranscript: (request) => {
			requests.push(request);
			return null;
		},
		...options,
	});
	const component = view.create(context.context());
	return { component, context, current, requests, view };
}

function input(component: CommandDialogComponent, data: string): void {
	component.handleInput?.(data);
}

function text(component: CommandDialogComponent, width = 64): string {
	return component.render(width).join("\n");
}

async function flush(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

test("hides selection hints when there are no Agents", () => {
	const { component } = setup([]);
	const output = text(component);
	expect(output).toContain("No Agents in the current session.");
	expect(output).not.toContain("select");
	expect(output).not.toContain("details");
	expect(output).toContain("? keys");
	expect(output).toContain("Esc close");
	input(component, "?");
	const keyHelp = text(component);
	expect(keyHelp).not.toContain("Previous/next");
	expect(keyHelp).not.toContain("Open details");
	expect(keyHelp).toContain("Return one level");
	component.dispose?.();
});

test("hides nested selection hints when the nested roster becomes empty", async () => {
	const parent = row("parent", "running", {
		nestedAgents: [
			{
				childIndex: 0,
				depth: 1,
				description: "Inspect one child",
				error: null,
				key: "nested-child",
				name: "nested-child",
				nestedCount: 0,
				parentRunId: "run-parent",
				partialResult: null,
				runId: "nested-run",
				savedOutputPath: null,
				sessionFile: null,
				status: "running",
				task: "Inspect one child",
				transcriptPath: null,
			},
		],
		nestedCount: 1,
	});
	const { component, current } = setup([parent]);
	input(component, "\r");
	await flush();
	input(component, "n");
	expect(text(component)).toContain("nested-child");

	current.update([row("parent", "running")]);
	const output = text(component);
	expect(output).toContain("0 nested Agents");
	expect(output).not.toContain("select");
	expect(output).not.toContain("details");
	expect(output).toContain("? keys");
	expect(output).toContain("Esc back");
});

test("keeps running identity and state above the tertiary dim token", () => {
	const colors: Array<{ color: string; text: string }> = [];
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const recordingTheme = {
		...theme,
		fg: (color: string, text: string) => {
			colors.push({ color, text });
			return text;
		},
	} as Theme;
	const { component } = setup([row("reviewer", "running")], {}, recordingTheme);
	component.render(64);
	expect(colors).toContainEqual({ color: "accent", text: "● 12s" });
	expect(colors).not.toContainEqual({ color: "dim", text: "● 12s" });
	component.dispose?.();
});

test("is a normal full-width view with a bounded 64-column list", () => {
	const rows = Array.from({ length: 9 }, (_, index) =>
		row(`agent-${index + 1}`, index === 0 ? "waiting_supervisor" : "running", {
			task: `task ${index + 1} with a deliberately long explanation that should not escape the terminal width`,
		}),
	);
	const { component, view } = setup(rows);
	const rendered = component.render(64);

	expect(view.priority).toBe("normal");
	expect(rendered[0]).toBe("━".repeat(64));
	expect(rendered.join("\n")).toContain("Agents");
	expect(rendered.join("\n")).toContain("○");
	expect(rendered.join("\n")).toContain("later");
	expect(rendered.join("\n")).toContain("b/Space page");
	expect(rendered.join("\n")).not.toContain("PgUp/PgDn page");
	expect(rendered.join("\n")).not.toMatch(/[╭╮╰╯]/u);
	expect(rendered.length).toBeLessThanOrEqual(28);
	expect(rendered.every((line) => visibleWidth(line) <= 64 && !line.includes("\n"))).toBe(true);
	input(component, " ");
	expect(text(component)).toContain("› agent-7");
});

test("uses the short description in the list and preserves the full Task in detail", async () => {
	const fullTask = "Inspect /tmp/pi-run/deep/sample.txt without changing the file";
	const { component } = setup([
		row("reviewer", "completed", {
			description: "Review sample output",
			endedAt: 12_001,
			task: fullTask,
		}),
	]);
	const list = text(component, 64);
	expect(list).toContain("Review sample output");
	expect(list).not.toContain("/tmp/pi-run/deep");
	expect(list).not.toMatch(/\b(?:done|completed)\b/i);

	input(component, "\r");
	await flush();
	expect(text(component, 100)).toContain(fullTask);
});

test("keeps timestamp-free legacy completion semantically visible", async () => {
	const { component } = setup([row("legacy", "completed", { elapsedMs: null, endedAt: null, startedAt: null })]);
	expect(text(component, 64)).toContain("✓");
	expect(text(component, 64)).not.toMatch(/\b(?:done|completed)\b/i);
	input(component, "\r");
	await flush();
	expect(text(component, 64)).toContain("completed");
});

test("keeps title, selected state, errors, and Escape reachable at very low height", async () => {
	const failure = new Error("transcript disk unavailable");
	const { component, context } = setup([row("reviewer", "running")], {
		readTranscript: async () => {
			throw failure;
		},
	});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	(context.tui.terminal as { rows: number }).rows = 6;
	const list = component.render(64);
	expect(list).toHaveLength(3);
	expect(list.join("\n")).toContain("Agents");
	expect(list.join("\n")).toContain("reviewer");
	expect(list.at(-1)).toContain("Esc close");

	input(component, "\r");
	await flush();
	const detail = component.render(64);
	expect(detail).toHaveLength(3);
	expect(detail.join("\n")).toContain("Agents / reviewer");
	expect(detail.join("\n")).toContain("transcript disk unavailable");
	expect(detail.at(-1)).toContain("Esc back");
	component.dispose?.();
});

test("shows a terminal error once and removes repeated task wrappers", async () => {
	const task = "Inspect the Agent detail without changing files.";
	const { component, context } = setup(
		[
			row("failed", "failed", {
				error: "Provider rejected the child payload\u001b]0;hidden\u0007 after validation.\u202e",
				partialResult: `Task: ${task}`,
				task,
			}),
		],
		{ initialKey: "failed", readTranscript: () => `User\nTask: ${task}` },
	);
	await flush();
	const detail = text(component, 100);
	expect(detail).toContain("× failed · 12s");
	expect(detail).toContain("Error\n  Provider rejected the child payload after validation.");
	expect(detail).not.toContain("◆");
	expect(detail.split("Provider rejected the child payload")).toHaveLength(2);
	expect(detail.split(task)).toHaveLength(2);
	expect(detail).not.toContain("Partial result");
	expect(detail).not.toContain("User");
	expect(detail).not.toContain("hidden");
	expect(detail).not.toContain("\u202e");

	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	(context.tui.terminal as { rows: number }).rows = 6;
	const low = text(component, 64);
	expect(low).toContain("Provider rejected the child payload");
	expect(low).toContain("Esc back");
});

test("shows cumulative usage and recovery in the authoritative Agent detail", async () => {
	const { component } = setup(
		[
			row("limited", "failed", {
				cumulativeUsage: {
					turns: 66,
					toolCalls: 94,
					inputTokens: 1_000_000,
					outputTokens: 12_180,
					reportedCostUsd: 4.16343,
					modelAttempts: 1,
					resumes: 0,
				},
				terminalOutcome: {
					state: "incomplete",
					class: "cost_guard",
					reason: "Automatic Agent expansion needs attention.",
					continuation: {
						target: { id: "run-limited", index: 0 },
						resumeSupported: true,
						acknowledgementRequired: true,
					},
				},
			}),
		],
		{ initialKey: "limited" },
	);
	await flush();
	const detail = text(component, 120);
	expect(detail).toContain("Run\n  66 turns · 94 Tools · 1000000 input + 12180 output tokens");
	expect(detail).toContain("Reported cost $4.163430 · 1 attempts · 0 resumes");
	expect(detail).toContain("cost_guard · incomplete · Automatic Agent expansion needs attention.");
	expect(detail).toContain("Target run-limited index 0 · resumable · acknowledgement required");
});

test("navigates without wrapping and uses Escape as back then close", async () => {
	const { component, context, requests } = setup([
		row("first", "running"),
		row("second", "completed", { nestedCount: 3 }),
	]);
	input(component, "\u001b[A");
	expect(text(component)).toContain("  › first");
	expect(text(component)).toContain("x stop");
	input(component, "\u001b[B");
	input(component, "\u001b[B");
	expect(text(component)).toContain("  › second");
	expect(text(component)).not.toContain("x dismiss");
	input(component, "?");
	expect(text(component)).toContain("Agents / Keys");
	input(component, "\u001b");
	expect(text(component)).toContain("  › second");

	input(component, "\r");
	await flush();
	expect(requests.at(-1)?.row.key).toBe("second");
	expect(text(component)).toContain("Agents / second");
	expect(text(component)).toContain("3 nested");

	input(component, "\u001b");
	expect(text(component)).toContain("  › second");
	expect(context.closed).toBe(0);
	input(component, "\u001b");
	expect(context.closed).toBe(1);
});

test("keeps CJK rows safe and wraps every action hint instead of clipping Escape", async () => {
	const dangerousName = "编译\u001b]0;renamed\u0007助手";
	const { component } = setup(
		[
			row("cjk", "failed", {
				name: dangerousName,
				task: "检查中文路径与很长的终端输出是否安全换行",
			}),
		],
		{ initialKey: "cjk", readTranscript: () => "第一行\n第二行\n第三行" },
	);
	await flush();

	for (const width of [100, 64, 32]) {
		const rendered = component.render(width);
		const renderedText = rendered.join("\n");
		expect(rendered.every((line) => visibleWidth(line) <= width && !line.includes("\n"))).toBe(true);
		expect(renderedText).not.toContain("\u001b]");
		expect(renderedText).not.toContain("renamed");
		expect(renderedText).toContain("Esc back");
	}

	input(component, "\u001b");
	const list = component.render(32);
	expect(list.join("\n")).toContain("  › 编译助手");
	expect(list.join("\n")).toContain("Esc close");
	expect(list.every((line) => visibleWidth(line) <= 32)).toBe(true);
});

test("loads a bounded transcript, strips terminal controls, and accepts the compact page key", async () => {
	const requests: AgentTranscriptRequest[] = [];
	const transcript = [
		"line-1",
		"\u001b[31mline-2-red\u001b[0m",
		"\u001b]8;;https://example.invalid\u0007hidden-link-target\u001b]8;;\u0007",
		"line-4\u202e",
		"line-5",
		"line-6",
		"line-7",
		"line-8",
	].join("\n");
	const { component } = setup(
		[
			row("reader", "running", {
				partialResult: "partial\u001b[2J result",
				task: "inspect\u001b[31m safely\u001b[0m",
			}),
		],
		{
			initialKey: "reader",
			maxTranscriptChars: 400,
			readTranscript: (request) => {
				requests.push(request);
				return transcript;
			},
		},
	);
	await flush();
	const before = text(component);

	expect(requests).toHaveLength(1);
	expect(requests[0]?.maxChars).toBe(400);
	expect(requests[0]?.signal).toBeInstanceOf(AbortSignal);
	expect(before).toContain("line-8");
	expect(before).toContain("● running · 12s");
	expect(before).not.toContain("0 nested");
	expect(before).not.toContain("\u001b");
	expect(before).not.toContain("https://example.invalid");
	expect(before).not.toContain("\u202e");
	expect(before).toContain("earlier lines");

	input(component, "b");
	const after = text(component);
	expect(after).toContain("line-2-red");
	expect(after).toContain("hidden-link-target");
	expect(after).toContain("later lines");
	expect(after).toContain("partial result");
	expect(after).not.toBe(before);
	expect(component.render(64).length).toBeLessThanOrEqual(28);
	expect(component.render(64).every((line) => visibleWidth(line) <= 64)).toBe(true);

	const fallback = setup([row("fallback", "completed", { partialResult: "ONLY_PARTIAL_9X" })], {
		initialKey: "fallback",
		readTranscript: () => "ONLY_PARTIAL_9X",
	});
	await flush();
	const fallbackText = text(fallback.component);
	expect(fallbackText).toContain("No Activity yet.");
	expect(fallbackText).toContain("Result");
	expect(fallbackText.match(/ONLY_PARTIAL_9X/g)).toHaveLength(1);
});

test("renders Agent prose and Result as Markdown while failed Tool output stays literal", async () => {
	const { component } = setup(
		[
			row("researcher", "completed", {
				partialResult: "## Result\n**Complete**\n\n```sh\nbun test\n```",
			}),
		],
		{
			initialKey: "researcher",
			readTranscript: () => ({
				items: [
					{ kind: "message", speaker: "researcher", text: "# Finding\n**Readable** explanation" },
					{
						kind: "tool",
						name: "bash",
						outcome: "failed",
						result: "# literal Tool output\n**not Markdown**",
						target: "bun test",
					},
				],
			}),
		},
	);
	await flush();
	const rendered = text(component, 120);

	expect(rendered).toContain("Result");
	expect(rendered).toContain("Complete");
	expect(rendered).toContain("bun test");
	expect(rendered).not.toContain("## Result");
	expect(rendered).not.toContain("**Complete**");

	input(component, "\u001b[F");
	const activity = text(component, 120);
	expect(activity).toContain("Finding");
	expect(activity).toContain("Readable explanation");
	expect(activity).not.toContain("# Finding");
	expect(activity).not.toContain("**Readable**");
	expect(activity).toContain("# literal Tool output");
	expect(activity).toContain("**not Markdown**");
});

test("keeps successful Tool results collapsed until t and bounds the expanded preview", async () => {
	const resultLines = Array.from({ length: 11 }, (_, index) => `tool-line-${String(index + 1)}`);
	const { component } = setup([row("reader", "running")], {
		initialKey: "reader",
		readTranscript: () => ({
			items: [
				{
					kind: "tool",
					name: "read",
					outcome: "completed",
					result: resultLines.join("\n"),
					target: "src/agent-dialog.ts",
				},
			],
		}),
	});
	await flush();
	const collapsed = text(component, 120);
	expect(collapsed).toContain("✓ Read · src/agent-dialog.ts · completed");
	expect(collapsed).toContain("t tool details");
	expect(collapsed).not.toContain("tool-line-1");

	input(component, "t");
	input(component, "\u001b[H");
	const expanded = text(component, 120);
	expect(expanded).toContain("⎿ tool-line-1");
	expect(expanded).toContain("tool-line-8");
	expect(expanded).toContain("⎿ … 3 lines omitted");
	expect(expanded).not.toContain("tool-line-11");

	input(component, "t");
	expect(text(component, 120)).not.toContain("tool-line-1");
});

test("keeps long detail content in one fixed scrollable window", async () => {
	const task = Array.from({ length: 16 }, (_, index) => `task line ${index + 1}`).join("\n");
	const result = Array.from({ length: 80 }, (_, index) => `result line ${index + 1}`).join("\n");
	const activity = Array.from({ length: 5 }, (_, index) => `activity line ${index + 1}`).join("\n");
	const { component, context } = setup([row("reviewer", "completed", { partialResult: result, task })], {
		initialKey: "reviewer",
		readTranscript: () => activity,
	});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	(context.tui.terminal as { columns: number; rows: number }).columns = 120;
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	(context.tui.terminal as { columns: number; rows: number }).rows = 76;
	await flush();

	const before = component.render(120);
	expect(before).toHaveLength(20);
	expect(before.filter((line) => line.includes("Agents / reviewer"))).toHaveLength(1);

	input(component, "\u001b[B");
	const afterDown = component.render(120);
	expect(afterDown).not.toEqual(before);

	input(component, "\u001b[F");
	const atEnd = text(component, 120);
	expect(atEnd).toContain("Activity");
	expect(atEnd).toContain("activity line 5");
	expect(atEnd).toContain("Esc back");
});

test("keeps a section visible while scrolling at low height", async () => {
	const { component, context } = setup([row("reviewer", "completed", { task: "Review the dialog" })], {
		initialKey: "reviewer",
		readTranscript: () => "activity line 1\nactivity line 2\nactivity line 3",
	});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	(context.tui.terminal as { columns: number; rows: number }).columns = 100;
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	(context.tui.terminal as { columns: number; rows: number }).rows = 12;
	await flush();
	component.render(100);

	input(component, "\u001b[H");
	input(component, "\u001b[B");
	expect(text(component, 100)).toContain("Activity");
});

test("shows pending and rejected stop results without inventing success", async () => {
	const pending = deferred<AgentControlResult>();
	const { component, current } = setup([row("worker", "running")]);
	current.controlHandler = (action) =>
		pending.promise.then((value) => ({ ...value, key: action.key, type: action.type }));

	input(component, "x");
	expect(text(component)).toContain("Stopping… waiting for acknowledgement.");
	expect(text(component)).not.toContain("Acknowledged:");
	input(component, "\r");
	expect(text(component)).toContain("Stopping… waiting for acknowledgement.");
	await flush();
	expect(current.actions).toEqual([{ key: "worker", type: "stop" }]);

	pending.resolve({
		acknowledged: false,
		key: "worker",
		message: "process refused",
		status: "running",
		type: "stop",
	});
	await flush();
	expect(text(component)).toContain("Not acknowledged: process refused");
	expect(text(component)).not.toContain("Acknowledged: process refused");

	current.controlHandler = async () => {
		throw new Error("control bridge offline");
	};
	input(component, "x");
	await flush();
	expect(text(component)).toContain("Request failed: control bridge offline");
});

test("steers with required text and reports positive acknowledgement", async () => {
	const pending = deferred<AgentControlResult>();
	const { component, current } = setup([row("worker", "running")], { initialKey: "worker" });
	current.controlHandler = () => pending.promise;

	input(component, "s");
	input(component, "\r");
	expect(text(component)).toContain("Enter a steering message.");
	expect(current.actions).toEqual([]);
	input(component, "g");
	input(component, "o");
	input(component, "!");
	input(component, "\u007f");
	input(component, "\r");
	expect(text(component)).toContain("Sending guidance… waiting for acknowledgement.");
	await flush();
	expect(current.actions).toEqual([{ key: "worker", message: "go", type: "steer" }]);

	pending.resolve({
		acknowledged: true,
		key: "worker",
		message: "guidance received",
		status: "running",
		type: "steer",
	});
	await flush();
	expect(text(component)).toContain("Acknowledged: guidance received");
});

test("resumes only resumable terminal states and keeps their details durable", async () => {
	const failed = setup([row("failed", "failed")], { initialKey: "failed" });
	input(failed.component, "r");
	input(failed.component, "\r");
	await flush();
	expect(failed.current.actions[0]).toEqual({ key: "failed", type: "resume" });
	input(failed.component, "x");
	await flush();
	expect(failed.current.actions).toEqual([{ key: "failed", type: "resume" }]);
	expect(text(failed.component)).toContain("Agents / failed");

	const cancelled = setup([row("cancelled", "user_cancelled")], { initialKey: "cancelled" });
	input(cancelled.component, "r");
	expect(cancelled.current.actions).toEqual([]);
	expect(text(cancelled.component)).not.toContain("Resume message");
});

test("tracks snapshots and unsubscribes on disposal", () => {
	const { component, current } = setup([row("first", "running")]);
	expect(current.listenerCount()).toBe(1);
	current.update([row("second", "completed")]);
	expect(text(component)).toContain("second");
	expect(text(component)).not.toContain("first");

	component.dispose?.();
	expect(current.listenerCount()).toBe(0);
	current.update([row("third", "running")]);
	expect(text(component)).not.toContain("third");
});
