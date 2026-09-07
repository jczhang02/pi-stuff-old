import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
	activateDiagnosticChannel,
	DiagnosticChannel,
	resetDiagnosticProcessState,
} from "../../../packages/pi-stuff/src/conversation-ui/diagnostics.js";
import {
	beginUiSettingsGeneration,
	getUiSettingRegistry,
	registerOwnedUiSettings,
	type UiSettings,
	UiSettingsStore,
} from "../../../packages/pi-stuff/src/conversation-ui/settings.js";

const DEFAULTS: UiSettings = {
	inlineSlashAutocomplete: true,
	inputHighlighting: true,
	schemaVersion: 3,
	statusline: true,
	statuslineDensity: "auto",
	statuslineLatestPrompt: true,
	welcomeHeader: true,
};

const run = Effect.runPromise;

afterEach(() => resetDiagnosticProcessState());

async function withTemporarySettings(run: (path: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-ui-settings-"));
	try {
		await run(join(directory, "settings.json"));
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
	const startedAt = Date.now();
	while (!(await predicate())) {
		if (Date.now() - startedAt >= timeoutMs) throw new Error("timed out waiting for settings race workers");
		await Bun.sleep(5);
	}
}

test("UI settings default on without writing during startup and persist explicit changes", async () => {
	await withTemporarySettings(async (path) => {
		const store = await run(UiSettingsStore.load(path));
		expect(store.get()).toEqual(DEFAULTS);
		expect(Bun.file(path).size).toBe(0);
		expect(Bun.file(`${path}.lock`).size).toBe(0);

		await Promise.all([
			run(store.set("statusline", false)),
			run(store.set("inputHighlighting", false)),
			run(store.set("statusline", true)),
		]);
		await run(store.whenIdle());

		// SAFETY: this test controls the serialized JSON fixture and exercises only the asserted fields.
		const persisted = JSON.parse(await readFile(path, "utf8")) as { ui: UiSettings };
		expect(persisted).toEqual({ ui: { ...DEFAULTS, inputHighlighting: false } });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await stat(`${path}.lock`)).mode & 0o777).toBe(0o600);
		expect((await run(UiSettingsStore.load(path))).get()).toEqual(persisted.ui);
	});
});

test("UI startup reads the legacy file without migrating it", async () => {
	await withTemporarySettings(async (path) => {
		const legacyPath = join(path, "..", "pi-stuff-ui.json");
		const legacy = { ...DEFAULTS, statusline: false };
		await writeFile(legacyPath, JSON.stringify(legacy));

		const store = await run(UiSettingsStore.load(path));
		expect(store.get()).toEqual(legacy);
		expect(Bun.file(path).size).toBe(0);
		expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual(legacy);

		await run(store.set("welcomeHeader", false));
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			ui: { ...legacy, welcomeHeader: false },
		});
		expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual(legacy);
	});
});

test("complete schema v1 settings migrate in memory and persist as v3 only after an explicit change", async () => {
	await withTemporarySettings(async (path) => {
		const versionOne = {
			inlineSlashAutocomplete: false,
			inputHighlighting: true,
			schemaVersion: 1,
			statusline: false,
			welcomeHeader: false,
		} as const;
		await writeFile(path, `${JSON.stringify({ ui: versionOne })}\n`);

		const store = await run(UiSettingsStore.load(path));
		expect(store.get()).toEqual({
			...DEFAULTS,
			inlineSlashAutocomplete: false,
			statusline: false,
			welcomeHeader: false,
		});
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ui: versionOne });

		await run(store.set("statuslineDensity", "compact"));
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			ui: {
				...DEFAULTS,
				inlineSlashAutocomplete: false,
				statusline: false,
				statuslineDensity: "compact",
				welcomeHeader: false,
			},
		});
	});
});

test("complete schema v2 settings discard the former icon preference when migrated to v3", async () => {
	await withTemporarySettings(async (path) => {
		const versionTwo = {
			...DEFAULTS,
			schemaVersion: 2,
			statuslineIcons: "ascii",
		} as const;
		await writeFile(path, `${JSON.stringify({ ui: versionTwo })}\n`);

		const store = await run(UiSettingsStore.load(path));
		expect(store.get()).toEqual(DEFAULTS);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ui: versionTwo });

		await run(store.set("welcomeHeader", false));
		const persisted: unknown = JSON.parse(await readFile(path, "utf8"));
		expect(persisted).toEqual({ ui: { ...DEFAULTS, welcomeHeader: false } });
	});
});

test("two stores merge distinct explicit changes without losing either value", async () => {
	await withTemporarySettings(async (path) => {
		const first = await run(UiSettingsStore.load(path));
		const second = await run(UiSettingsStore.load(path));

		await Promise.all([run(first.set("statusline", false)), run(second.set("inputHighlighting", false))]);

		expect((await run(UiSettingsStore.load(path))).get()).toEqual({
			...DEFAULTS,
			inputHighlighting: false,
			statusline: false,
		});
	});
});

test("concurrent stale-lock recovery admits only one settings writer", async () => {
	await withTemporarySettings(async (path) => {
		const workerCount = 8;
		const barrierPath = join(path, "..", "barrier");
		const activeWriterPath = join(path, "..", "active-writer");
		const overlapPath = join(path, "..", "writer-overlap");
		await mkdir(barrierPath);
		// Padding makes every worker inspect the same stale inode before the old
		// check-then-unlink implementation can replace it, keeping the race red-capable.
		const stalePadding = "x".repeat(16 * 1024 * 1024);
		await writeFile(`${path}.lock`, `${JSON.stringify({ padding: stalePadding, pid: 2_147_483_647 })}\n`);
		const staleTime = new Date(Date.now() - 10_000);
		await utimes(`${path}.lock`, staleTime, staleTime);

		const workerPath = join(import.meta.dir, "../../ui/settings-lock-race-worker.ts");
		const workers = Array.from({ length: workerCount }, (_, index) =>
			Bun.spawn([process.execPath, workerPath, path, barrierPath, activeWriterPath, overlapPath, String(index)], {
				stderr: "pipe",
				stdout: "pipe",
			}),
		);
		try {
			await waitUntil(async () => {
				const ready = await Promise.all(
					Array.from({ length: workerCount }, (_, index) =>
						Bun.file(join(barrierPath, `${String(index)}.ready`)).exists(),
					),
				);
				return ready.every(Boolean);
			});
			await writeFile(join(barrierPath, "go"), "go\n");
			const exitCodes = await Promise.all(workers.map((worker) => worker.exited));
			if (exitCodes.some((code) => code !== 0)) {
				const diagnostics = await Promise.all(
					workers.map(
						async (worker, index) => `worker ${String(index)}: ${await new Response(worker.stderr).text()}`,
					),
				);
				throw new Error(diagnostics.join("\n"));
			}
			expect(await Bun.file(overlapPath).exists()).toBe(false);
		} finally {
			for (const worker of workers) worker.kill();
		}
	});
}, 30_000);

test("invalid persisted UI settings fail quiet to the complete default", async () => {
	await withTemporarySettings(async (path) => {
		await writeFile(path, `${JSON.stringify({ ui: { schemaVersion: 1, statusline: false } })}\n`);
		await writeFile(join(path, "..", "pi-stuff-ui.json"), JSON.stringify({ ...DEFAULTS, statusline: false }));
		const diagnostics = new DiagnosticChannel();
		activateDiagnosticChannel(diagnostics);
		expect((await run(UiSettingsStore.load(path))).get()).toEqual(DEFAULTS);
		expect(diagnostics.list()).toHaveLength(1);
		expect(diagnostics.list()[0]?.summary).toBe("UI settings were invalid and built-in defaults are active");
		expect(diagnostics.listNotices()).toHaveLength(1);
	});
});

test("complete UI settings discard unknown persisted keys", async () => {
	await withTemporarySettings(async (path) => {
		await writeFile(path, `${JSON.stringify({ ui: { ...DEFAULTS, future: "ignored" } })}\n`);
		expect((await run(UiSettingsStore.load(path))).get()).toEqual(DEFAULTS);
	});
});

test("a failed latest UI settings write rolls the live value back", async () => {
	await withTemporarySettings(async (path) => {
		const store = await run(UiSettingsStore.load(path, () => Effect.fail(new Error("settings disk denied"))));

		const error = await run(store.set("statusline", false)).then(
			() => undefined,
			(cause: unknown) => cause,
		);

		expect(error).toBeInstanceOf(Error);
		expect(store.get()).toEqual(DEFAULTS);
		await run(store.whenIdle());
	});
});

test("the registry presents owned and Capability settings in one stable order", async () => {
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const api = { events: {} } as ExtensionAPI;
	const store = UiSettingsStore.memory();
	const registry = beginUiSettingsGeneration(api);
	const unregisterOwned = registerOwnedUiSettings(registry, store, run);
	const unregisterTool = registry.register({
		description: "Show elapsed time while long-running tools work",
		get: () => "true",
		id: "toolRunningTimer",
		label: "Tool running timer",
		order: 50,
		set: async () => {},
		subscribe: () => () => {},
		values: ["true", "false"],
	});

	expect(registry.list().map((setting) => setting.id)).toEqual([
		"statusline",
		"statuslineDensity",
		"statuslineLatestPrompt",
		"welcomeHeader",
		"inputHighlighting",
		"inlineSlashAutocomplete",
		"toolRunningTimer",
	]);
	expect(registry.list().map((setting) => [setting.id, setting.get(), setting.values])).toEqual([
		["statusline", "true", ["true", "false"]],
		["statuslineDensity", "auto", ["auto", "full", "compact"]],
		["statuslineLatestPrompt", "true", ["true", "false"]],
		["welcomeHeader", "true", ["true", "false"]],
		["inputHighlighting", "true", ["true", "false"]],
		["inlineSlashAutocomplete", "true", ["true", "false"]],
		["toolRunningTimer", "true", ["true", "false"]],
	]);
	expect(getUiSettingRegistry(api)).toBe(registry);
	const density = registry.list().find((setting) => setting.id === "statuslineDensity");
	if (!density) throw new Error("expected Statusline density setting");
	await density.set("compact");
	expect(store.getValue("statuslineDensity")).toBe("compact");
	await expect(density.set("dense")).rejects.toThrow("Invalid statuslineDensity value");

	unregisterTool();
	unregisterOwned();
	expect(registry.list()).toEqual([]);
});

test("a reload generation drops stale Capability setting adapters", () => {
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const api = { events: {} } as ExtensionAPI;
	const first = beginUiSettingsGeneration(api);
	first.register({
		description: "stale",
		get: () => "true",
		id: "stale",
		label: "Stale",
		order: 1,
		set: async () => {},
		subscribe: () => () => {},
		values: ["true", "false"],
	});
	const second = beginUiSettingsGeneration(api);
	expect(second).not.toBe(first);
	expect(second.list()).toEqual([]);
	first.register({
		description: "late stale",
		get: () => "true",
		id: "late-stale",
		label: "Late stale",
		order: 2,
		set: async () => {},
		subscribe: () => () => {},
		values: ["true", "false"],
	});
	expect(second.list()).toEqual([]);
	expect(getUiSettingRegistry(api)).toBe(second);
});
