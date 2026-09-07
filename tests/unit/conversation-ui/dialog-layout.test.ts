import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import {
	commandDialogKeys,
	commandDialogListIndex,
	commandDialogListKeyHelp,
	commandDialogNavigation,
	commandDialogReadOnlyPageHint,
	commandDialogRows,
	commandDialogScrollOffset,
	fitCommandDialogRows,
	fitFixedCommandDialogRows,
	renderCommandDialogKeyHelp,
	renderCommandDialogSplit,
} from "../../../packages/pi-stuff/src/conversation-ui/dialog-layout.js";
import type { CommandDialogViewContext } from "../../../packages/pi-stuff/src/conversation-ui/index.js";

function context(rows: number): Pick<CommandDialogViewContext<unknown>, "tui"> {
	// SAFETY: this test controls the value and supplies every Pick member exercised by this case.
	return { tui: { terminal: { rows } } } as Pick<CommandDialogViewContext<unknown>, "tui">;
}

const sections = {
	header: ["divider", "title"],
	body: ["", "selected", "body one", "body two", ""],
	priority: ["selected"],
	footer: ["more actions", "Esc close"],
};

test("Command Dialog row budgets reserve normal Pi chrome", () => {
	expect(commandDialogRows(context(24))).toBe(21);
	expect(commandDialogRows(context(3))).toBe(1);
	expect(commandDialogRows(context(0))).toBe(0);
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	expect(commandDialogRows({ tui: { terminal: {} } } as never)).toBe(21);
});

test("read-only navigation honors Pi bindings and compact-keyboard aliases", () => {
	const defaults = new KeybindingsManager(TUI_KEYBINDINGS);
	expect(commandDialogNavigation("\u001b[A", defaults)).toBe("up");
	expect(commandDialogNavigation("\u0010", defaults)).toBe("up");
	expect(commandDialogNavigation("\u000e", defaults)).toBe("down");
	expect(commandDialogNavigation("b", defaults)).toBe("pageUp");
	expect(commandDialogNavigation(" ", defaults)).toBe("pageDown");
	expect(commandDialogNavigation("\u001b[H", defaults)).toBe("home");
	expect(commandDialogNavigation("\u001b[F", defaults)).toBe("end");
	expect(commandDialogNavigation("\u001b[1;2B", defaults)).toBeUndefined();

	const rebound = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+y" });
	expect(commandDialogNavigation("\u0019", rebound)).toBe("down");
	expect(commandDialogNavigation("\u001b[B", rebound)).toBeUndefined();
	expect(commandDialogKeys(rebound, "tui.select.down", "↓")).toBe("Ctrl+Y");
});

test("shared navigation clamps lists and scrollable documents", () => {
	expect(commandDialogListIndex(3, 10, 4, "pageDown")).toBe(7);
	expect(commandDialogListIndex(7, 10, 4, "pageDown")).toBe(9);
	expect(commandDialogListIndex(7, 10, 4, "home")).toBe(0);
	expect(commandDialogScrollOffset(6, 20, 8, "pageUp")).toBe(0);
	expect(commandDialogScrollOffset(6, 20, 8, "end")).toBe(20);
});

test("read-only footers prefer compact page aliases only when content overflows", () => {
	expect(commandDialogReadOnlyPageHint(false)).toBeUndefined();
	expect(commandDialogReadOnlyPageHint(true)).toBe("b/Space page");
	expect(commandDialogReadOnlyPageHint(true, " · 9–16/30")).toBe("b/Space page · 9–16/30");

	const help = commandDialogListKeyHelp(new KeybindingsManager(TUI_KEYBINDINGS), "item");
	expect(help).toContainEqual({ keys: "PgUp/PgDn, b/Space", description: "Previous/next page" });
});

test("key help keeps configured compact-keyboard aliases visible when space allows", () => {
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+y" });
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const theme = {
		bold: (value: string) => value,
		fg: (_color: string, value: string) => value,
	} as Theme;
	const lines = renderCommandDialogKeyHelp(
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		{ keybindings, theme, tui: { terminal: { rows: 24 } } } as never,
		64,
		"Tasks",
		commandDialogListKeyHelp(keybindings, "task"),
	);
	expect(lines.some((line) => line.includes("↑/Ctrl+Y, Ctrl+P/Ctrl+N"))).toBe(true);
});

test("low-height fitting preserves escape, current state, and title before optional rows", () => {
	expect(fitCommandDialogRows(sections, 0)).toEqual([]);
	expect(fitCommandDialogRows(sections, 1)).toEqual(["Esc close"]);
	expect(fitCommandDialogRows(sections, 2)).toEqual(["selected", "Esc close"]);
	expect(fitCommandDialogRows(sections, 3)).toEqual(["title", "selected", "Esc close"]);
	expect(fitCommandDialogRows(sections, 4)).toEqual(["title", "selected", "more actions", "Esc close"]);
	expect(fitCommandDialogRows(sections, 5)).toEqual(["divider", "title", "selected", "more actions", "Esc close"]);
});

test("ordinary-height fitting preserves the original layout exactly", () => {
	expect(fitCommandDialogRows(sections, 9)).toEqual([
		"divider",
		"title",
		"",
		"selected",
		"body one",
		"body two",
		"",
		"more actions",
		"Esc close",
	]);
});

test("an overflow-only semantic title can replace decorative chrome without changing the full layout", () => {
	const sections = {
		header: ["divider"],
		overflowTitle: "/btw selected question",
		body: ["/btw selected question", "provider unavailable"],
		footer: ["Esc close"],
		priority: ["/btw selected question", "provider unavailable"],
	};
	expect(fitCommandDialogRows(sections, 8)).toEqual([
		"divider",
		"/btw selected question",
		"provider unavailable",
		"Esc close",
	]);
	expect(fitCommandDialogRows(sections, 3)).toEqual(["/btw selected question", "provider unavailable", "Esc close"]);
});

test("an explicit overflow title already in the header is not repeated", () => {
	const sections = {
		header: ["divider", "Agents / reviewer", "completed"],
		overflowTitle: "Agents / reviewer",
		body: ["Task", "result"],
		footer: ["Esc back"],
		priority: ["result"],
	};
	const fitted = fitCommandDialogRows(sections, 5);
	expect(fitted.filter((line) => line === "Agents / reviewer")).toHaveLength(1);
});

test("fixed fitting keeps the footer on the last row", () => {
	expect(fitFixedCommandDialogRows({ header: ["divider"], body: ["content"], footer: ["Esc close"] }, 5)).toEqual([
		"divider",
		"content",
		"",
		"",
		"Esc close",
	]);
});

test("split rendering stays one full-width surface with one internal divider", () => {
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const theme = { fg: (_color: string, value: string) => value } as Theme;
	const lines = renderCommandDialogSplit(
		theme,
		100,
		() => ["ignored pane rule", "Tools", "activity", "Esc close"],
		() => ["ignored pane rule", "Tools / Read", "detail", "Esc back"],
	);
	expect(lines[0]).toBe("━".repeat(100));
	expect(lines.slice(1).every((line) => visibleWidth(line) <= 100)).toBe(true);
	expect(lines.slice(1).every((line) => line[36] === "┃")).toBe(true);
	expect(lines[1]).toContain("Tools");
	expect(lines[1]).toContain("Tools / Read");
});
