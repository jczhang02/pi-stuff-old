import { describe, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import type {
	CommandDialogComponent,
	CommandDialogViewContext,
} from "../../../packages/pi-stuff/src/conversation-ui/index.js";
import {
	DEFAULT_SESSION_NAMING_SETTINGS,
	SessionNamingSettingsStore,
} from "../../../packages/pi-stuff/src/session-naming/settings.js";
import { createSessionNamingSettingsView } from "../../../packages/pi-stuff/src/session-naming/settings-dialog.js";
import { TestTui } from "../../fixtures/test-tui.js";

initTheme("dark", false);

// SAFETY: this test fixture implements the exact theme surface exercised by the Dialog.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

const MODEL_CHOICES = [
	{ description: "Primary fixture", value: "fixture/primary" },
	{ description: "Backup fixture", value: "fixture/backup" },
] as const;

function createDialog(settings: SessionNamingSettingsStore): CommandDialogComponent {
	const view = createSessionNamingSettingsView(
		settings,
		{ update: (patch) => Effect.runPromise(settings.update(patch)) },
		{ modelChoices: MODEL_CHOICES },
	);
	const context = {
		close: () => {},
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => {},
		signal: new AbortController().signal,
		theme,
		tui: new TestTui(24),
	} satisfies CommandDialogViewContext<void>;
	return view.create(context);
}

describe("Session Naming settings Dialog", () => {
	test("shows the routine controls and fixed model with a bounded responsive surface", () => {
		const settings = SessionNamingSettingsStore.memory({
			...DEFAULT_SESSION_NAMING_SETTINGS,
			cooldownMinutes: 15,
			model: "fixture/primary",
			fallbackModels: ["fixture/backup"],
		});
		const dialog = createDialog(settings);
		const lines = dialog.render(64);
		const text = lines.join("\n");

		expect(text).toContain("Session Naming");
		expect(text).toContain("Automatic naming");
		expect(text).toContain("Rename cooldown");
		expect(text).toContain("15 min");
		expect(text).toContain("Keep manually assigned names");
		expect(text).toContain("Naming model");
		expect(text).toContain("fixture/primary");
		expect(text).not.toContain("fallbackModels");
		expect(lines.every((line) => visibleWidth(line) <= 64)).toBe(true);
		expect(lines.length).toBeLessThanOrEqual(24);

		const narrow = dialog.render(24);
		const narrowText = narrow.join("\n");
		expect(narrowText).toContain("Auto naming");
		expect(narrowText).toContain("on");
		expect(narrowText).toContain("Cooldown");
		expect(narrowText).toContain("15 min");
		expect(narrowText).toContain("Keep manual names");
		expect(narrowText).toContain("off");
		expect(narrowText).toContain("Model");
		expect(narrowText).toContain("Fixed");
		expect(narrowText.match(/Enter/gu)).toHaveLength(1);
		expect(narrow.every((line) => visibleWidth(line) <= 24)).toBe(true);
		dialog.dispose?.();
	});

	test("persists each selection through the live settings store", async () => {
		const settings = SessionNamingSettingsStore.memory(DEFAULT_SESSION_NAMING_SETTINGS);
		const dialog = createDialog(settings);

		dialog.handleInput?.("\r");
		await Effect.runPromise(settings.whenIdle());
		expect(settings.get().enabled).toBe(false);

		dialog.handleInput?.("\x1b[B");
		dialog.handleInput?.("\r");
		await Effect.runPromise(settings.whenIdle());
		expect(settings.get().cooldownMinutes).toBe(30);

		dialog.handleInput?.("\x1b[B");
		dialog.handleInput?.("\r");
		await Effect.runPromise(settings.whenIdle());
		expect(settings.get().respectManualName).toBe(true);

		dialog.handleInput?.("\x1b[B");
		dialog.handleInput?.("\r");
		let text = dialog.render(64).join("\n");
		expect(text).toContain("Search models");
		expect(text).toContain("Session model");
		expect(text).toContain("fixture/primary");
		expect(text).toContain("fixture/backup");
		for (const character of "backup") dialog.handleInput?.(character);
		text = dialog.render(64).join("\n");
		expect(text).toContain("fixture/backup");
		expect(text).not.toContain("fixture/primary");
		dialog.handleInput?.("\r");
		await Effect.runPromise(settings.whenIdle());
		expect(settings.get().model).toBe("fixture/backup");

		dialog.handleInput?.("\r");
		for (const character of "session") dialog.handleInput?.(character);
		dialog.handleInput?.("\r");
		await Effect.runPromise(settings.whenIdle());
		expect(settings.get().model).toBeUndefined();
		dialog.dispose?.();
	});
});
