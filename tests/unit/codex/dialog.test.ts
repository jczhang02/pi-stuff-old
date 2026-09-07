import { expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createCodexDialogView, formatCodexToolLines } from "../../../packages/pi-stuff/src/codex/dialog.js";
import type { CommandDialogViewContext } from "../../../packages/pi-stuff/src/conversation-ui/index.js";
import { TestTui } from "../../fixtures/test-tui.js";

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

initTheme("dark", false);

function dialogContext(rows: number, activeTheme = theme): CommandDialogViewContext<void> {
	return {
		close: () => {},
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => {},
		signal: new AbortController().signal,
		theme: activeTheme,
		tui: new TestTui(rows),
	};
}

test("packs complete Codex Tool labels at wide and narrow widths", () => {
	expect(formatCodexToolLines(80)).toEqual(["apply_patch · view_image · imagegen · gpt-image-2"]);
	expect(formatCodexToolLines(46)).toEqual(["apply_patch · view_image", "imagegen · gpt-image-2"]);
	expect(formatCodexToolLines(12)).toEqual(["apply_patch", "view_image", "imagegen"]);
	for (const width of [12, 22, 46, 80]) {
		for (const line of formatCodexToolLines(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
	}
});

test("keeps Codex error, selection, and Escape reachable at very low height", async () => {
	const context = dialogContext(6);
	const component = createCodexDialogView({
		getFast: () => false,
		getUsage: () => undefined,
		refreshUsage: async () => {
			throw new Error("usage service unavailable");
		},
		setFast: async () => {},
	}).create(context);
	await Bun.sleep(0);
	const lines = component.render(64);
	expect(lines).toHaveLength(3);
	expect(lines.join("\n")).toContain("Codex");
	expect(lines.join("\n")).toContain("usage service unavailable");
	expect(lines.at(-1)).toContain("Esc close");
	component.dispose?.();
});

test("keeps Codex usage state and Tool identities above the tertiary dim token", () => {
	const colors: Array<{ color: string; text: string }> = [];
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const recordingTheme = {
		...theme,
		fg: (color: string, text: string) => {
			colors.push({ color, text });
			return text;
		},
	} as Theme;
	const component = createCodexDialogView({
		getFast: () => false,
		getUsage: () => undefined,
		refreshUsage: async () => {
			throw new Error("usage unavailable");
		},
		setFast: async () => {},
	}).create(dialogContext(24, recordingTheme));
	component.render(64);
	expect(colors).toContainEqual({ color: "muted", text: "Loading usage…" });
	expect(colors.some(({ color, text }) => color === "muted" && text.includes("apply_patch"))).toBe(true);
	expect(colors.some(({ color, text }) => color === "dim" && text.includes("apply_patch"))).toBe(false);
	component.dispose?.();
});
