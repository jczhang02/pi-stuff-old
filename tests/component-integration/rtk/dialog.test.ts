import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import type { CommandDialogViewContext } from "../../../packages/pi-stuff/src/conversation-ui/index.js";
import { RtkProjectionAdapter } from "../../../packages/pi-stuff/src/rtk/projection.js";
import { compactRtkBinaryPath, createRtkDialogView } from "../../../packages/pi-stuff/src/rtk/rtk-dialog.js";
import { RtkRuntime } from "../../../packages/pi-stuff/src/rtk/runtime.js";
import { RtkSettingsStore } from "../../../packages/pi-stuff/src/rtk/settings.js";
import { compactPath } from "../../../packages/pi-stuff/src/rtk/upstream/techniques/path-utils.js";
import { TestTui } from "../../fixtures/test-tui.js";

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

describe("RTK dialog path presentation", () => {
	test("keeps a long managed binary path on one meaningful narrow line", () => {
		const path = `${homedir()}/.local/share/mise/installs/cargo-https-github-com-rtk-ai-rtk/ref-8a7dd7e5570d7744d4b6508479a3674fe8c49286/bin/rtk`;
		const rendered = compactRtkBinaryPath(path, 38);
		expect(rendered).toBe("~/.../bin/rtk");
		expect(visibleWidth(rendered)).toBeLessThanOrEqual(38);
	});

	test("preserves an already compact path verbatim", () => {
		expect(compactRtkBinaryPath("/usr/local/bin/rtk", 38)).toBe("/usr/local/bin/rtk");
	});

	test("keeps RTK search and linter paths inside a terminal-cell budget", () => {
		const rendered = compactPath("/workspace/packages/深层/file.ts", 14);
		expect(rendered).toBe(".../深层/file…");
		expect(visibleWidth(rendered)).toBeLessThanOrEqual(14);
		expect(rendered).not.toMatch(/(?:[⋯…][\\/]|[\\/][⋯…])/u);
	});
});

describe("merged RTK dialog", () => {
	test("keeps Runtime, native behavior controls, and Session savings in one surface", async () => {
		initTheme("dark", false);
		let closed = 0;
		let verified = 0;
		const settings = RtkSettingsStore.memory();
		const tui = new TestTui(28);
		const context = {
			close: () => {
				closed += 1;
			},
			keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
			requestRender: () => {},
			signal: new AbortController().signal,
			theme,
			tui,
		} satisfies CommandDialogViewContext<void>;
		const component = createRtkDialogView({
			projection: new RtkProjectionAdapter(),
			runtime: new RtkRuntime(),
			settings,
			setOutputProjection: (enabled) => Effect.runPromise(settings.setOutputProjection(enabled)),
			setRewriteCommands: (enabled) => Effect.runPromise(settings.setRewriteCommands(enabled)),
			verify: async () => {
				verified += 1;
			},
		}).create(context);

		const initial = component.render(64).join("\n");
		expect(initial).toContain("RTK");
		expect(initial).toContain("Runtime");
		expect(initial).toContain("Behavior");
		expect(initial).toContain("Session savings");
		expect(initial).toContain("Command rewriting");
		expect(initial).toContain("configured on · effective unchecked");
		expect(initial).toContain("Model projection");
		expect(initial).toContain("configured on · effective active");
		expect(initial).toContain("No eligible result projected yet.");
		expect(initial).not.toContain("/rtk settings");
		expect(initial).not.toMatch(/[╭╮╰╯]/u);

		component.handleInput?.("\r");
		await Promise.resolve();
		expect(settings.get().rewriteCommands).toBe(false);
		expect(component.render(64).join("\n")).toContain("configured off · effective off");
		component.handleInput?.("\u001b[B");
		component.handleInput?.(" ");
		await Promise.resolve();
		expect(settings.get().outputProjection).toBe(false);

		component.handleInput?.("v");
		await Promise.resolve();
		expect(verified).toBe(1);
		component.handleInput?.("c");
		expect(component.render(64).join("\n")).toContain("Session savings cleared.");

		tui.rows = 6;
		const low = component.render(64);
		expect(low).toHaveLength(3);
		expect(low.join("\n")).toContain("Command rewriting");
		expect(low.join("\n")).toContain("Model projection");
		expect(low.at(-1)).toContain("unchecked");
		expect(low.at(-1)).toContain("No eligible result projected yet.");
		expect(low.at(-1)).toContain("Esc close");

		tui.rows = 28;
		component.handleInput?.("?");
		expect(component.render(64).join("\n")).toContain("RTK / Keys");
		component.handleInput?.("\u001b");
		expect(closed).toBe(0);
		component.handleInput?.("\u001b");
		expect(closed).toBe(1);
		component.dispose?.();
	});
});

test("RTK low-height state uses semantic colors without hiding configured and effective values", () => {
	const colors: Array<{ color: string; text: string }> = [];
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const recordingTheme = {
		bold: (value: string) => value,
		fg: (color: string, text: string) => {
			colors.push({ color, text });
			return text;
		},
	} as Theme;
	let closed = 0;
	const settings = RtkSettingsStore.memory({ outputProjection: false, rewriteCommands: false, schemaVersion: 1 });
	const component = createRtkDialogView({
		projection: new RtkProjectionAdapter(),
		runtime: new RtkRuntime(),
		settings,
		setOutputProjection: (enabled) => Effect.runPromise(settings.setOutputProjection(enabled)),
		setRewriteCommands: (enabled) => Effect.runPromise(settings.setRewriteCommands(enabled)),
	}).create({
		close: () => {
			closed += 1;
		},
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => {},
		signal: new AbortController().signal,
		theme: recordingTheme,
		tui: new TestTui(6),
	} satisfies CommandDialogViewContext<void>);
	const lines = component.render(64);
	expect(lines).toHaveLength(3);
	expect(lines.join("\n")).toContain("unchecked");
	expect(lines.join("\n")).toContain("configured off · effective off");
	expect(lines.join("\n")).toContain("No eligible result projected yet.");
	expect(lines.at(-1)).toContain("Esc close");
	expect(colors).toContainEqual({ color: "muted", text: "○ unchecked" });
	component.handleInput?.("\r");
	component.handleInput?.("q");
	expect(closed).toBe(0);
	component.handleInput?.("?");
	expect(component.render(64).join("\n")).toContain("RTK / Keys");
	component.handleInput?.("\u001b");
	expect(closed).toBe(0);
	component.handleInput?.("\u001b");
	expect(closed).toBe(1);
	component.dispose?.();
});
