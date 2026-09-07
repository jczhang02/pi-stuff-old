import { afterEach, expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	activateDiagnosticChannel,
	DiagnosticChannel,
	resetDiagnosticProcessState,
} from "../../../packages/pi-stuff/src/conversation-ui/diagnostics.js";
import type { CommandDialogViewContext } from "../../../packages/pi-stuff/src/conversation-ui/index.js";
import type {
	RegisteredUiSetting,
	UiSettingRegistry,
} from "../../../packages/pi-stuff/src/conversation-ui/settings.js";
import { createUiSettingsView } from "../../../packages/pi-stuff/src/conversation-ui/ui-settings-dialog.js";

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

afterEach(() => resetDiagnosticProcessState());

interface Deferred {
	readonly promise: Promise<void>;
	reject(cause: Error): void;
}

interface UiHarness {
	readonly closed: () => number;
	readonly context: CommandDialogViewContext<void>;
	readonly renders: () => number;
	readonly terminal: { rows: number };
}

interface FailingSettingHarness {
	readonly setting: RegisteredUiSetting;
	readonly value: () => string;
}

function deferred(): Deferred {
	let reject = (_reason: Error): void => {};
	const promise = new Promise<void>((_resolve, promiseReject) => {
		reject = promiseReject;
	});
	return { promise, reject };
}

function harness(rows = 28): UiHarness {
	let closed = 0;
	let renders = 0;
	const terminal = { rows };
	return {
		closed: () => closed,
		// SAFETY: this test controls the value and supplies every CommandDialogViewContext member exercised by this case.
		context: {
			close: () => {
				closed += 1;
			},
			keybindings: {},
			requestRender: () => {
				renders += 1;
			},
			signal: new AbortController().signal,
			theme,
			tui: { terminal },
		} as CommandDialogViewContext<void>,
		renders: () => renders,
		terminal,
	};
}

function setting(
	id: string,
	label: string,
	order: number,
	values: readonly string[] = ["true", "false"],
): RegisteredUiSetting & { value: string } {
	const listeners = new Set<() => void>();
	return {
		description: `${label} description`,
		get() {
			return this.value;
		},
		id,
		label,
		order,
		async set(value: string) {
			this.value = value;
			for (const listener of listeners) listener();
		},
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		value: values[0] ?? "",
		values,
	};
}

function failingSetting(persistence: Promise<void>): FailingSettingHarness {
	const listeners = new Set<() => void>();
	let value = "true";
	const notify = (): void => {
		for (const listener of listeners) listener();
	};
	return {
		setting: {
			description: "Statusline description",
			get: () => value,
			id: "statusline",
			label: "Statusline",
			order: 10,
			set: async (next) => {
				const previous = value;
				value = next;
				notify();
				try {
					await persistence;
				} catch (error) {
					value = previous;
					notify();
					throw error;
				}
			},
			subscribe: (listener) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			values: ["true", "false"],
		},
		value: () => value,
	};
}

test("/ui uses one native searchable list for all seven presentation settings", async () => {
	initTheme("dark", false);
	const settings = [
		setting("statusline", "Statusline", 10),
		setting("statuslineDensity", "Statusline density", 11, ["auto", "full", "compact"]),
		setting("statuslineLatestPrompt", "Latest prompt", 12),
		setting("welcomeHeader", "Welcome header", 20),
		setting("inputHighlighting", "Input highlighting", 30),
		setting("inlineSlashAutocomplete", "Inline slash autocomplete", 40),
		setting("toolRunningTimer", "Tool running timer", 50),
	];
	// SAFETY: this test controls the value and supplies every UiSettingRegistry member exercised by this case.
	const registry = { list: () => settings, register: () => () => {} } as UiSettingRegistry;
	const testHarness = harness();
	const component = createUiSettingsView(registry).create(testHarness.context);

	const open = component.render(64);
	expect(open[0]).toBe("─".repeat(64));
	expect(open[1]).toBe("  UI");
	expect(open.join("\n")).toContain("Statusline");
	expect(open.join("\n")).toContain("Tool running timer");
	expect(open.join("\n")).not.toContain("RTK");
	expect(open.every((line) => visibleWidth(line) <= 64)).toBe(true);

	component.handleInput?.("timer");
	expect(component.render(64).join("\n")).not.toContain("Welcome header");
	expect(component.render(64).join("\n")).toContain("Tool running timer");
	component.handleInput?.("\r");
	await Promise.resolve();
	expect(settings[6]?.value).toBe("false");
	expect(component.render(64).join("\n")).toContain("false");

	component.handleInput?.("\u001b");
	expect(testHarness.closed()).toBe(1);
	expect(testHarness.renders()).toBeGreaterThan(0);
	component.dispose?.();
});

test("/ui cycles each setting through its registered values", async () => {
	initTheme("dark", false);
	const density = setting("statuslineDensity", "Statusline density", 11, ["auto", "full", "compact"]);
	// SAFETY: this test controls the value and supplies every UiSettingRegistry member exercised by this case.
	const registry = {
		list: () => [density],
		register: () => () => {},
	} as UiSettingRegistry;
	const component = createUiSettingsView(registry).create(harness().context);

	expect(component.render(64).join("\n")).toContain("auto");
	component.handleInput?.("\r");
	await Promise.resolve();
	expect(density.value).toBe("full");
	expect(component.render(64).join("\n")).toContain("full");
	component.dispose?.();
});

test("/ui remains bounded at narrow width and very low height", () => {
	initTheme("dark", false);
	// SAFETY: this test controls the value and supplies every UiSettingRegistry member exercised by this case.
	const registry = {
		list: () => [setting("statusline", "Statusline", 10)],
		register: () => () => {},
	} as UiSettingRegistry;
	const testHarness = harness(28);
	const component = createUiSettingsView(registry).create(testHarness.context);
	const fortyEightColumns = component.render(48).join("\n");
	expect(fortyEightColumns).toContain("Esc close");
	expect(fortyEightColumns).not.toContain("Esc…");

	const narrow = component.render(12);
	expect(narrow.every((line) => visibleWidth(line) <= 12)).toBe(true);
	testHarness.terminal.rows = 6;
	const threeRows = component.render(64);
	expect(threeRows).toHaveLength(3);
	expect(threeRows.join("\n")).toContain("UI");
	expect(threeRows.join("\n")).toContain("Statusline");
	expect(threeRows.at(-1)).toMatch(/Esc(?: to)? close/);
	testHarness.terminal.rows = 5;
	expect(component.render(64).length).toBeLessThanOrEqual(2);
	testHarness.terminal.rows = 0;
	expect(component.render(64)).toEqual([]);
	component.dispose?.();
});

test("/ui rolls a failed setting back and shows the error while it remains open", async () => {
	initTheme("dark", false);
	const pending = deferred();
	const controlled = failingSetting(pending.promise);
	// SAFETY: this test controls the value and supplies every UiSettingRegistry member exercised by this case.
	const registry = {
		list: () => [controlled.setting],
		register: () => () => {},
	} as UiSettingRegistry;
	const notifications: string[] = [];
	const testHarness = harness();
	const component = createUiSettingsView(registry, {
		onPersistenceError: (message) => notifications.push(message),
	}).create(testHarness.context);

	component.handleInput?.("\r");
	expect(controlled.value()).toBe("false");
	pending.reject(new Error("settings disk denied"));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));

	expect(controlled.value()).toBe("true");
	expect(component.render(64).join("\n")).toContain("settings disk denied");
	expect(component.render(64).join("\n")).toContain("true");
	expect(notifications).toEqual([]);
	component.dispose?.();
});

test("/ui reports a failed write through its host adapter after immediate close", async () => {
	initTheme("dark", false);
	const pending = deferred();
	const controlled = failingSetting(pending.promise);
	// SAFETY: this test controls the value and supplies every UiSettingRegistry member exercised by this case.
	const registry = {
		list: () => [controlled.setting],
		register: () => () => {},
	} as UiSettingRegistry;
	const notifications: string[] = [];
	const testHarness = harness();
	const component = createUiSettingsView(registry, {
		onPersistenceError: (message) => notifications.push(message),
	}).create(testHarness.context);

	component.handleInput?.("\r");
	component.handleInput?.("\u001b");
	component.dispose?.();
	pending.reject(new Error("settings disk denied"));
	await new Promise<void>((resolve) => setTimeout(resolve, 0));

	expect(testHarness.closed()).toBe(1);
	expect(controlled.value()).toBe("true");
	expect(notifications).toEqual(["Error: settings disk denied"]);
});

test("/ui isolates Capability observer setup and cleanup failures", () => {
	initTheme("dark", false);
	const diagnostics = new DiagnosticChannel();
	activateDiagnosticChannel(diagnostics);
	let healthyReleased = false;
	const brokenSubscribe = setting("brokenSubscribe", "Broken subscribe", 10);
	brokenSubscribe.subscribe = () => {
		throw new Error("subscribe failed");
	};
	const brokenCleanup = setting("brokenCleanup", "Broken cleanup", 20);
	brokenCleanup.subscribe = () => () => {
		throw new Error("cleanup failed");
	};
	const healthy = setting("healthy", "Healthy", 30);
	healthy.subscribe = () => () => {
		healthyReleased = true;
	};
	// SAFETY: this test controls the value and supplies every UiSettingRegistry member exercised by this case.
	const registry = {
		list: () => [brokenSubscribe, brokenCleanup, healthy],
		register: () => () => {},
	} as UiSettingRegistry;

	const component = createUiSettingsView(registry).create(harness().context);
	expect(component.render(64).join("\n")).toContain("Healthy");
	component.dispose?.();
	expect(healthyReleased).toBe(true);
	expect(diagnostics.list()).toHaveLength(2);
	expect(diagnostics.list().map((record) => record.summary)).toEqual([
		"A UI setting observer could not be released",
		"The Broken subscribe setting could not refresh live",
	]);
	expect(diagnostics.listNotices()).toHaveLength(1);
});
