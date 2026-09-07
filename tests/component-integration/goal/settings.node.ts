import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as Effect from "effect/Effect";
import {
	DEFAULT_GOAL_SETTINGS,
	type GoalSettings,
	GoalSettingsStore,
	normalizeGoalSettings,
} from "../../../packages/pi-stuff/src/goal/src/settings.js";
import { type JsonValue, parseJsonValue } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeObject } from "../../../packages/pi-stuff/src/shared/runtime-type.js";

function goalDocument<Value>(value: Value): string {
	return `${JSON.stringify({ goal: value })}\n`;
}

function readGoalNamespace(path: string): JsonValue | undefined {
	const document = parseJsonValue(readFileSync(path, "utf8"));
	return isRuntimeObject(document) && document !== null && !Array.isArray(document) ? document["goal"] : undefined;
}

function loadSettings(path: string): Promise<GoalSettingsStore> {
	return Effect.runPromise(GoalSettingsStore.load(path));
}

function saveSettings(store: GoalSettingsStore, settings: GoalSettings): Promise<void> {
	return Effect.runPromise(store.replace(settings));
}

test("normalizeGoalSettings applies defaults and accepts bounded continuation limits", () => {
	assert.equal(DEFAULT_GOAL_SETTINGS.continuationLimits.automaticTurns, null);
	assert.equal(DEFAULT_GOAL_SETTINGS.continuationLimits.noProgressTurns, null);
	assert.deepEqual(DEFAULT_GOAL_SETTINGS.rpc, { enabled: false });
	assert.deepEqual(normalizeGoalSettings({}), DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(normalizeGoalSettings({ futureOption: true }), DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(normalizeGoalSettings({ toolVisibility: "always" }), {
		...DEFAULT_GOAL_SETTINGS,
		toolVisibility: "always",
	});
	assert.deepEqual(normalizeGoalSettings({ toolVisibility: "after-first-goal" }), {
		...DEFAULT_GOAL_SETTINGS,
		toolVisibility: "after-first-goal",
	});
	assert.deepEqual(normalizeGoalSettings({ experimental: { goals: true, futureOption: "kept-compatible" } }), {
		...DEFAULT_GOAL_SETTINGS,
		experimental: { goals: true },
	});
	assert.deepEqual(normalizeGoalSettings({ rpc: {} }), DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(normalizeGoalSettings({ rpc: { enabled: true } }), {
		...DEFAULT_GOAL_SETTINGS,
		rpc: { enabled: true },
	});
	assert.deepEqual(normalizeGoalSettings({ rpc: { enabled: false, future: true } }), {
		...DEFAULT_GOAL_SETTINGS,
		rpc: { enabled: false },
	});
	assert.deepEqual(normalizeGoalSettings({ continuationLimits: {} }), DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(normalizeGoalSettings({ continuationLimits: { automaticTurns: 7 } }), {
		...DEFAULT_GOAL_SETTINGS,
		continuationLimits: { automaticTurns: 7, noProgressTurns: null },
	});
	assert.deepEqual(normalizeGoalSettings({ continuationLimits: { noProgressTurns: 2 } }), {
		...DEFAULT_GOAL_SETTINGS,
		continuationLimits: { automaticTurns: null, noProgressTurns: 2 },
	});
	assert.deepEqual(
		normalizeGoalSettings({
			continuationLimits: { automaticTurns: null, noProgressTurns: null, future: true },
		}),
		{
			...DEFAULT_GOAL_SETTINGS,
			continuationLimits: { automaticTurns: null, noProgressTurns: null },
		},
	);

	for (const value of [
		null,
		[],
		"always",
		{ toolVisibility: "sometimes" },
		{ experimental: true },
		{ experimental: { goals: "yes" } },
		{ rpc: true },
		{ rpc: [] },
		{ rpc: { enabled: "yes" } },
		{ continuationLimits: true },
		{ continuationLimits: [] },
		{ continuationLimits: { automaticTurns: 0 } },
		{ continuationLimits: { automaticTurns: -1 } },
		{ continuationLimits: { automaticTurns: 1.5 } },
		{ continuationLimits: { automaticTurns: Number.MAX_SAFE_INTEGER + 1 } },
		{ continuationLimits: { noProgressTurns: "3" } },
	]) {
		assert.equal(normalizeGoalSettings(value), undefined);
	}
});

test("GoalSettingsStore creates a complete document only after a changed setting is saved", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-create-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const parent = join(directory, "nested");
	const settingsPath = join(parent, "pi-stuff.json");

	const store = await loadSettings(settingsPath);
	assert.equal(store.loadIssue, undefined);
	assert.deepEqual(store.get(), DEFAULT_GOAL_SETTINGS);
	assert.equal(existsSync(parent), false);

	const saved = { ...DEFAULT_GOAL_SETTINGS, toolVisibility: "after-first-goal" } satisfies GoalSettings;
	await saveSettings(store, saved);

	assert.deepEqual(readGoalNamespace(settingsPath), saved);
	assert.deepEqual(readdirSync(parent), ["pi-stuff.json"]);
});

test("startup reads legacy Goal settings without migrating them", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-legacy-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsPath = join(directory, "pi-stuff.json");
	const legacyPath = join(directory, "pi-goal.json");
	writeFileSync(legacyPath, JSON.stringify({ toolVisibility: "after-first-goal" }));

	const store = await loadSettings(settingsPath);
	assert.equal(store.loadIssue, undefined);
	assert.deepEqual(store.get(), { ...DEFAULT_GOAL_SETTINGS, toolVisibility: "after-first-goal" });
	assert.equal(existsSync(settingsPath), false);
	assert.equal(existsSync(legacyPath), true);
});

test("GoalSettingsStore atomically preserves unknown top-level and nested fields", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-save-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsPath = join(directory, "pi-stuff.json");
	writeFileSync(
		settingsPath,
		JSON.stringify({
			ui: { statusline: true },
			goal: {
				future: { enabled: true },
				toolVisibility: "after-first-goal",
				experimental: { goals: false, futureQueue: "keep" },
				rpc: { enabled: true, futureRpc: "keep" },
				continuationLimits: { automaticTurns: 25, noProgressTurns: 3, futureLimit: 9 },
			},
		}),
	);

	const store = await loadSettings(settingsPath);
	await saveSettings(store, {
		toolVisibility: "always",
		experimental: { goals: true },
		rpc: { enabled: false },
		continuationLimits: { automaticTurns: 40, noProgressTurns: null },
	});

	assert.deepEqual(readGoalNamespace(settingsPath), {
		future: { enabled: true },
		toolVisibility: "always",
		experimental: { goals: true, futureQueue: "keep" },
		rpc: { enabled: false, futureRpc: "keep" },
		continuationLimits: { automaticTurns: 40, noProgressTurns: null, futureLimit: 9 },
	});
	// SAFETY: this test controls the serialized JSON fixture and exercises only the asserted fields.
	assert.deepEqual((JSON.parse(readFileSync(settingsPath, "utf8")) as { ui?: unknown }).ui, {
		statusline: true,
	});
	assert.deepEqual(readdirSync(directory), ["pi-stuff.json"]);
});

test("GoalSettingsStore refuses to overwrite malformed settings", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-save-failure-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsPath = join(directory, "pi-stuff.json");
	writeFileSync(settingsPath, "{invalid");
	const store = await loadSettings(settingsPath);
	assert.equal(store.loadIssue?.kind, "invalid");
	await assert.rejects(
		saveSettings(store, { ...DEFAULT_GOAL_SETTINGS, toolVisibility: "after-first-goal" }),
		/invalid JSON/i,
	);
	assert.equal(readFileSync(settingsPath, "utf8"), "{invalid");
	assert.deepEqual(readdirSync(directory), ["pi-stuff.json"]);
});

test("GoalSettingsStore distinguishes loaded, malformed, and unreadable files", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "pi-goal-settings-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const settingsPath = join(directory, "pi-stuff.json");

	const missing = await loadSettings(settingsPath);
	assert.equal(missing.loadIssue, undefined);
	assert.deepEqual(missing.get(), DEFAULT_GOAL_SETTINGS);

	await writeFile(
		settingsPath,
		goalDocument({ toolVisibility: "after-first-goal", experimental: { goals: true } }),
		"utf8",
	);
	const loaded = await loadSettings(settingsPath);
	assert.equal(loaded.loadIssue, undefined);
	assert.deepEqual(loaded.get(), {
		toolVisibility: "after-first-goal",
		experimental: { goals: true },
		rpc: { enabled: false },
		continuationLimits: { automaticTurns: null, noProgressTurns: null },
	});

	await writeFile(settingsPath, "{invalid", "utf8");
	const malformed = await loadSettings(settingsPath);
	assert.equal(malformed.loadIssue?.kind, "invalid");
	assert.match(malformed.loadIssue?.reason ?? "", /pi-stuff\.json/);

	await mkdir(join(directory, "not-a-file"));
	await assert.rejects(loadSettings(join(directory, "not-a-file")), /EISDIR|directory/i);
});
