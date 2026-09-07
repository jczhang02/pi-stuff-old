import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { BtwExchange } from "../../../packages/pi-stuff/src/btw/btw-history.js";
import { BtwDialogController } from "../../../packages/pi-stuff/src/btw/btw-ui.js";

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	italic: (text: string) => text,
	underline: (text: string) => text,
	strikethrough: (text: string) => text,
} as Theme;

function exchange(index: number): BtwExchange {
	return {
		id: `exchange-${index}`,
		question: `earlier question ${index}`,
		answer: `earlier answer ${index}`,
		timestamp: index,
		contextTrimmed: false,
	};
}

function setup(
	options: {
		question?: string;
		history?: BtwExchange[];
		error?: string;
		copyText?: (text: string) => Promise<void>;
		onFork?: (exchange: BtwExchange, signal: AbortSignal) => Promise<void>;
		theme?: Theme;
	} = {},
) {
	let closeCount = 0;
	const clearCalls: Array<string | undefined> = [];
	let renderCount = 0;
	const tui = {
		terminal: { rows: 28 },
		requestRender: () => {
			renderCount++;
		},
	};
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const controller = new BtwDialogController(
		options.theme ?? theme,
		tui as never,
		keybindings,
		Object.assign(
			{
				history: options.history ?? [],
				onClose: () => {
					closeCount++;
				},
				onClearEarlier: (id: string | undefined) => clearCalls.push(id),
				onFork: options.onFork ?? (async () => {}),
			},
			options.question === undefined ? undefined : { question: options.question },
			options.error === undefined ? undefined : { error: options.error },
			options.copyText === undefined ? undefined : { copyText: options.copyText },
		),
	);
	return {
		controller,
		clearCalls,
		terminal: tui.terminal,
		get closeCount() {
			return closeCount;
		},
		get renderCount() {
			return renderCount;
		},
	};
}

test("matches Claude Code's direct question surface without extra sections or state labels", () => {
	const { controller } = setup({ question: "Why keep this isolated?" });
	const output = controller.render(100).join("\n");

	expect(output).toContain("/btw Why keep this isolated?");
	expect(output).toContain("Answering…");
	expect(output).toContain("Esc close");
	for (const redundant of [
		"BTW history",
		"● answering",
		"◆ Answer",
		"side question · main task continues",
		"single exchange",
		"\n  Question",
		"\n  Answer",
	]) {
		expect(output).not.toContain(redundant);
	}
	expect(output).not.toContain("╭");
	controller.dispose();
});

test("shows an empty /btw history as neutral guidance", () => {
	const colors: Array<{ color: string; text: string }> = [];
	// SAFETY: this deterministic fixture implements every Theme member exercised by the BTW renderer.
	const result = setup({
		theme: {
			...theme,
			fg: (color: string, text: string) => {
				colors.push({ color, text });
				return text;
			},
		} as Theme,
	});
	const output = result.controller.render(80).join("\n");
	expect(output).toContain("Ask a question with /btw <question>.");
	expect(output).not.toContain("No previous /btw exchange");
	expect(colors).toContainEqual({ color: "muted", text: "Ask a question with /btw <question>." });
	expect(colors).not.toContainEqual({ color: "error", text: "Ask a question with /btw <question>." });
	result.controller.dispose();
});

test("streams in place, then renders the final Markdown answer and copy action", async () => {
	const copied: string[] = [];
	const { controller } = setup({
		question: "question",
		copyText: async (text) => {
			copied.push(text);
		},
	});
	controller.appendText("**partial**");
	controller.setSuccess({
		id: "current",
		question: "question",
		answer: "**final answer**",
		timestamp: 1,
		contextTrimmed: false,
	});
	controller.handleInput("c");
	await Promise.resolve();

	const output = controller.render(80).join("\n");
	expect(output).toContain("final answer");
	expect(output).toContain("Copied answer");
	expect(output).toContain("Esc close");
	expect(copied).toEqual(["**final answer**"]);
	controller.dispose();
});

test("keeps recent questions in one reading flow and lets arrows switch answers", () => {
	const history = Array.from({ length: 10 }, (_, index) => exchange(index));
	const result = setup({ question: "current question", history });
	const newest = result.controller.render(100).join("\n");
	expect(newest).toContain("earlier question 6");
	expect(newest).toContain("earlier question 9");
	expect(newest).toContain("current question");
	expect(newest).not.toContain("earlier question 5");

	for (let index = 0; index < 10; index++) result.controller.handleInput("\u001b[D");
	const oldest = result.controller.render(100).join("\n");
	expect(oldest).toContain("/btw earlier question 0");
	expect(oldest).toContain("earlier answer 0");
	result.controller.dispose();
});

test("stays a single Claude-style surface at every width", () => {
	for (const width of [64, 100]) {
		const result = setup({ history: [exchange(1), exchange(2)] });
		const lines = result.controller.render(width);
		const output = lines.join("\n");
		expect(lines[0]).toBe("━".repeat(width));
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(output).toContain("/btw earlier question 2");
		expect(output).toContain("earlier answer 2");
		expect(output).toContain("←/→ to switch");
		expect(output).toContain("x to clear history");
		expect(output).not.toContain("┃");
		expect(output).not.toContain("BTW history");
		result.controller.dispose();
	}
});

test("keeps history navigation and clearing available beside an in-flight question", () => {
	const result = setup({ question: "current question", history: [exchange(1), exchange(2)] });
	result.controller.handleInput("\u001b[D");
	expect(result.controller.render(80).join("\n")).toContain("earlier answer 2");
	result.controller.handleInput("\u001b[C");
	result.controller.handleInput("x");
	expect(result.clearCalls).toEqual([]);
	expect(result.controller.render(80).join("\n")).toContain("Clear BTW history?");
	result.controller.handleInput("y");
	const output = result.controller.render(80).join("\n");
	expect(result.clearCalls).toEqual([undefined]);
	expect(output).toContain("current question");
	expect(output).not.toContain("earlier question");
	result.controller.dispose();
});

test("retains the selected successful exchange when clearing history", () => {
	const result = setup({ history: [exchange(1), exchange(2)] });
	result.controller.handleInput("\u001b[D");
	result.controller.handleInput("x");
	expect(result.clearCalls).toEqual([]);
	result.controller.handleInput("\u001b");
	expect(result.clearCalls).toEqual([]);
	expect(result.controller.render(80).join("\n")).not.toContain("Clear BTW history?");
	result.controller.handleInput("x");
	result.controller.handleInput("y");
	expect(result.clearCalls).toEqual(["exchange-1"]);
	const output = result.controller.render(80).join("\n");
	expect(output).toContain("earlier question 1");
	expect(output).toContain("earlier answer 1");
	expect(output).toContain("Cleared BTW history");
	result.controller.dispose();
});

test("promotes only a completed selected exchange and aborts a pending promotion on close", async () => {
	const promoted: BtwExchange[] = [];
	let promotionSignal: AbortSignal | undefined;
	const result = setup({
		history: [exchange(1)],
		onFork: async (selected, signal) => {
			promoted.push(selected);
			promotionSignal = signal;
			await new Promise<void>(() => {});
		},
	});
	result.controller.handleInput("f");
	await Promise.resolve();
	expect(promoted.map((item) => item.id)).toEqual(["exchange-1"]);
	const waiting = result.controller.render(80).join("\n");
	expect(waiting).toContain("Waiting for the main Agent to finish");
	expect(waiting).toContain("Esc close");
	result.controller.handleInput("\u001b");
	result.controller.dispose();
	expect(result.closeCount).toBe(1);
	expect(promotionSignal?.aborted).toBe(true);
});

test("accepts Kitty keyboard encoding for copy, fork, and clear", async () => {
	const copied: string[] = [];
	const promoted: string[] = [];
	const result = setup({
		history: [exchange(1), exchange(2)],
		copyText: async (text) => {
			copied.push(text);
		},
		onFork: async (selected) => {
			promoted.push(selected.id);
		},
	});
	result.controller.handleInput("\u001b[99u");
	result.controller.handleInput("\u001b[102u");
	await Promise.resolve();
	expect(copied).toEqual(["earlier answer 2"]);
	expect(promoted).toEqual(["exchange-2"]);

	result.controller.handleInput("\u001b[120u");
	expect(result.clearCalls).toEqual([]);
	result.controller.handleInput("\u001b[121u");
	expect(result.clearCalls).toEqual(["exchange-2"]);
	result.controller.dispose();
});

test("keeps partial text visibly incomplete on provider failure", () => {
	const { controller } = setup({ question: "question" });
	controller.setError("provider unavailable", "partial answer");
	const output = controller.render(80).join("\n");
	expect(output).toContain("partial answer");
	expect(output).toContain("provider unavailable");
	expect(output).not.toContain("Partial answer");
	expect(output).not.toContain("Answer");
	controller.dispose();
});

test("keeps the selected question, error, and Escape reachable at very low height", () => {
	const result = setup({ question: "question", history: [exchange(1)] });
	result.controller.setError("provider unavailable", "partial answer");
	result.terminal.rows = 6;
	const lines = result.controller.render(64);
	expect(lines).toHaveLength(3);
	expect(lines.join("\n")).toContain("question");
	expect(lines.join("\n")).toContain("provider unavailable");
	expect(lines.at(-1)).toContain("Esc close");
	result.controller.dispose();
});

test("only Escape closes the reading surface", () => {
	const result = setup({
		question: "a very long question ".repeat(10),
		history: [exchange(1), exchange(2)],
	});
	const lines = result.controller.render(64);
	expect(lines.every((line) => visibleWidth(line) <= 64)).toBe(true);
	result.controller.handleInput(" ");
	result.controller.handleInput("\r");
	expect(result.closeCount).toBe(0);
	result.controller.handleInput("?");
	expect(result.controller.render(64).join("\n")).toContain("BTW / Keys");
	result.controller.handleInput("\u001b");
	expect(result.closeCount).toBe(0);
	result.controller.handleInput("\u001b");
	expect(result.closeCount).toBe(1);
	result.controller.dispose();
});

test("accepts both PageUp and b for page scrolling", () => {
	for (const key of ["\u001b[5~", "b"] as const) {
		const result = setup({ question: "question" });
		result.controller.setSuccess({
			id: "current",
			question: "question",
			answer: Array.from({ length: 30 }, (_, index) => `line ${String(index + 1)}`).join("\n\n"),
			timestamp: 1,
			contextTrimmed: false,
		});
		result.terminal.rows = 12;
		const tail = result.controller.render(64).join("\n");
		expect(tail).toContain("b/Space page");
		expect(tail).not.toContain("PgUp/PgDn page");
		result.controller.handleInput(key);
		const earlier = result.controller.render(64).join("\n");
		expect(earlier).not.toBe(tail);
		result.controller.dispose();
	}
});

test("strips ESC and C1 terminal protocols plus bidi controls from every rendered field", () => {
	const { controller } = setup({
		question: "safe\u001b[31m question\u001b]0;hidden-title\u0007 after\u009b32m 中文\u202e end",
	});
	controller.setError(
		"bad\u001bXhidden-sos\u001b\\ error\u0090hidden-c1-dcs\u009c tail",
		"partial\u001bPhidden-dcs\u0007hidden-dcs-after-bell\u001b\\ answer\u009d0;hidden-c1-osc\u0007 kept\u2066 text",
	);
	const output = controller.render(80).join("\n");
	for (const control of ["\u001b", "\u0090", "\u009b", "\u009c", "\u009d", "\u202e", "\u2066"]) {
		expect(output).not.toContain(control);
	}
	for (const hidden of [
		"hidden-title",
		"hidden-sos",
		"hidden-c1-dcs",
		"hidden-dcs",
		"hidden-dcs-after-bell",
		"hidden-c1-osc",
	]) {
		expect(output).not.toContain(hidden);
	}
	expect(output).toContain("safe question after 中文 end");
	expect(output).toContain("partial answer kept  text");
	expect(output).toContain("bad error tail");
	controller.dispose();
});
