import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { resetDiagnosticProcessState } from "../../../packages/pi-stuff/src/conversation-ui/diagnostics.js";
import {
	DEFAULT_SESSION_NAMING_SETTINGS,
	parseSessionNamingSettings,
	SessionNamingSettingsStore,
} from "../../../packages/pi-stuff/src/session-naming/settings.js";

const roots: string[] = [];

afterEach(async () => {
	resetDiagnosticProcessState();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("loads defaults without creating the merged settings file", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-session-naming-settings-"));
	roots.push(root);
	const path = join(root, "pi-stuff.json");

	const store = await Effect.runPromise(SessionNamingSettingsStore.load(path));
	expect(store.get()).toEqual(DEFAULT_SESSION_NAMING_SETTINGS);
	expect(await Bun.file(path).exists()).toBe(false);
});

test("parses explicit model order and manual-name policy", () => {
	expect(
		parseSessionNamingSettings({
			schemaVersion: 1,
			enabled: true,
			cooldownMinutes: 30,
			respectManualName: true,
			model: "fixture/primary",
			fallbackModels: ["fixture/backup"],
		}),
	).toEqual({
		schemaVersion: 1,
		enabled: true,
		cooldownMinutes: 30,
		respectManualName: true,
		model: "fixture/primary",
		fallbackModels: ["fixture/backup"],
	});
});

test("persists concurrent Dialog changes without clobbering advanced settings or siblings", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-session-naming-settings-"));
	roots.push(root);
	const path = join(root, "pi-stuff.json");
	await writeFile(
		path,
		JSON.stringify({
			ui: { statusline: true },
			sessionNaming: {
				...DEFAULT_SESSION_NAMING_SETTINGS,
				model: "fixture/primary",
				fallbackModels: ["fixture/backup"],
			},
		}),
	);
	const store = await Effect.runPromise(SessionNamingSettingsStore.load(path));
	const observed: boolean[] = [];
	const unsubscribe = store.subscribe((settings) => observed.push(settings.enabled));

	await Promise.all([
		Effect.runPromise(store.update({ enabled: false })),
		Effect.runPromise(store.update({ cooldownMinutes: 30 })),
		Effect.runPromise(store.update({ respectManualName: true })),
	]);
	unsubscribe();
	const persisted = JSON.parse(await Bun.file(path).text());

	expect(store.get()).toEqual({
		...DEFAULT_SESSION_NAMING_SETTINGS,
		enabled: false,
		cooldownMinutes: 30,
		respectManualName: true,
		model: "fixture/primary",
		fallbackModels: ["fixture/backup"],
	});
	expect(observed).toEqual([false, false, false]);
	expect(persisted.ui).toEqual({ statusline: true });
	expect(persisted.sessionNaming.model).toBe("fixture/primary");
	expect(persisted.sessionNaming.fallbackModels).toEqual(["fixture/backup"]);
});

test("sets and clears the fixed model without clobbering newer fallback settings", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-session-naming-settings-"));
	roots.push(root);
	const path = join(root, "pi-stuff.json");
	await writeFile(
		path,
		JSON.stringify({
			ui: { statusline: true },
			sessionNaming: {
				...DEFAULT_SESSION_NAMING_SETTINGS,
				model: "fixture/primary",
				fallbackModels: ["fixture/backup"],
			},
		}),
	);
	const store = await Effect.runPromise(SessionNamingSettingsStore.load(path));

	await writeFile(
		path,
		JSON.stringify({
			ui: { statusline: false },
			sessionNaming: {
				...DEFAULT_SESSION_NAMING_SETTINGS,
				model: "fixture/primary",
				fallbackModels: ["fixture/external"],
			},
		}),
	);
	await Effect.runPromise(store.update({ model: "fixture/secondary" }));
	await Effect.runPromise(store.update({ model: null }));

	const persisted = JSON.parse(await Bun.file(path).text());
	expect(store.get().model).toBeUndefined();
	expect(persisted.ui).toEqual({ statusline: false });
	expect(persisted.sessionNaming).not.toHaveProperty("model");
	expect(persisted.sessionNaming.fallbackModels).toEqual(["fixture/external"]);
});

test("falls back as one namespace when merged settings are malformed", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-session-naming-settings-"));
	roots.push(root);
	const path = join(root, "pi-stuff.json");
	const invalid = '{"sessionNaming":{"schemaVersion":1,"enabled":"yes"}}\n';
	await writeFile(path, invalid);
	const store = await Effect.runPromise(SessionNamingSettingsStore.load(path));

	expect(store.get()).toEqual(DEFAULT_SESSION_NAMING_SETTINGS);
	await expect(Effect.runPromise(store.update({ enabled: false }))).rejects.toThrow("valid Session Naming settings");
	expect(await Bun.file(path).text()).toBe(invalid);
});
