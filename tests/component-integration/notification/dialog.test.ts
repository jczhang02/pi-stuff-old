import { expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { CommandDialogViewContext } from "../../../packages/pi-stuff/src/conversation-ui/index.js";
import { createNotificationSettingsView } from "../../../packages/pi-stuff/src/notification/notification-settings-dialog.ts";
import { NotificationSettingsStore } from "../../../packages/pi-stuff/src/notification/settings.ts";

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

test("Notification settings use one owned native Command Dialog", async () => {
	initTheme("dark", false);
	let closed = 0;
	let tests = 0;
	const settings = NotificationSettingsStore.memory();
	const terminal = { rows: 30 };
	// SAFETY: this test controls the value and supplies every CommandDialogViewContext member exercised by this case.
	const context = {
		close: () => {
			closed += 1;
		},
		keybindings: {},
		requestRender: () => {},
		signal: new AbortController().signal,
		theme,
		tui: { terminal },
	} as CommandDialogViewContext<void>;
	const component = createNotificationSettingsView(
		settings,
		{ update: (patch) => Effect.runPromise(settings.update(patch)) },
		{ onTest: () => (tests += 1) },
	).create(context);

	const initial = component.render(72).join("\n");
	expect(initial).toContain("Notifications");
	expect(initial).toContain("Response preview");
	expect(initial).toContain("Tmux notification");
	expect(initial).toContain("Also ring terminal bell");
	expect(initial).not.toContain("Notification sound");
	expect(initial).not.toMatch(/[╭╮╰╯]/u);
	component.handleInput?.("t");
	expect(tests).toBe(1);

	component.handleInput?.("\r");
	await Promise.resolve();
	expect(settings.get().enabled).toBe(false);
	for (let index = 0; index < 6; index += 1) component.handleInput?.("\u001b[B");
	component.handleInput?.("\r");
	await Promise.resolve();
	expect(settings.get().tmuxNotification).toBe(false);

	terminal.rows = 6;
	const low = component.render(48);
	expect(low).toHaveLength(3);
	expect(low.join("\n")).toContain("Notifications");
	expect(low.at(-1)).toMatch(/Esc(?: to)? close/);

	component.handleInput?.("\u001b");
	expect(closed).toBe(1);
	component.dispose?.();
});
