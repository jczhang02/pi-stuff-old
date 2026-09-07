import { expect, test } from "bun:test";
import { access, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { mergeNamespaceRecordEffect } from "../../../packages/pi-stuff/src/shared/settings-io/index.js";
import { ToolUiSettingsStore } from "../../../packages/pi-stuff/src/tool-display/settings.js";

function deferred() {
	return Promise.withResolvers<void>();
}

function run<Value, ErrorType>(effect: Effect.Effect<Value, ErrorType>): Promise<Value> {
	return Effect.runPromise(effect);
}

async function withTemporarySettings(runTest: (path: string, directory: string) => Promise<void>): Promise<void> {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-tools-settings-"));
	try {
		await runTest(join(directory, "settings.json"), directory);
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
}

test("rapid toggles serialize to the final in-memory and on-disk value", async () => {
	await withTemporarySettings(async (path, directory) => {
		const store = await run(ToolUiSettingsStore.load(path));

		await Promise.all(Array.from({ length: 101 }, (_, index) => run(store.setLiveElapsed(index % 2 !== 0))));

		expect(store.get()).toEqual({ liveElapsed: false, schemaVersion: 1 });
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ tools: { liveElapsed: false, schemaVersion: 1 } });
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		expect((await readdir(directory)).sort()).toEqual(["settings.json", "settings.json.lock"]);
	});
});

test("Tool settings startup reads the legacy file without migrating it", async () => {
	await withTemporarySettings(async (path, directory) => {
		const legacyPath = join(directory, "pi-stuff-tools.json");
		const legacy = { liveElapsed: false, schemaVersion: 1 } as const;
		await writeFile(legacyPath, JSON.stringify(legacy));

		expect((await run(ToolUiSettingsStore.load(path))).get()).toEqual(legacy);
		await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
		expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual(legacy);
	});
});

test("Tool settings preserve sibling namespaces", async () => {
	await withTemporarySettings(async (path) => {
		await run(mergeNamespaceRecordEffect(path, "ui", { statusline: true }));
		const store = await run(ToolUiSettingsStore.load(path));

		await run(store.setLiveElapsed(false));

		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			tools: { liveElapsed: false, schemaVersion: 1 },
			ui: { statusline: true },
		});
	});
});

test("unchanged settings skip persistence", async () => {
	await withTemporarySettings(async (path) => {
		let writes = 0;
		const store = await run(
			ToolUiSettingsStore.load(path, (_settingsPath, _namespace, _record) =>
				Effect.sync(() => {
					writes += 1;
				}),
			),
		);

		await run(store.setLiveElapsed(true));

		expect(writes).toBe(0);
		expect(store.get()).toEqual({ liveElapsed: true, schemaVersion: 1 });
	});
});

test("whenIdle waits for an active settings write", async () => {
	await withTemporarySettings(async (path) => {
		const started = deferred();
		const release = deferred();
		const store = await run(
			ToolUiSettingsStore.load(path, (settingsPath, namespace, record) =>
				Effect.gen(function* () {
					yield* Effect.sync(() => started.resolve());
					yield* Effect.promise(() => release.promise);
					yield* mergeNamespaceRecordEffect(settingsPath, namespace, record);
				}),
			),
		);
		const mutation = run(store.setLiveElapsed(false));
		await started.promise;
		let idleSettled = false;
		const idle = run(store.whenIdle()).then(() => {
			idleSettled = true;
		});

		await Promise.resolve();
		expect(idleSettled).toBe(false);
		release.resolve();
		await Promise.all([mutation, idle]);

		expect(idleSettled).toBe(true);
		expect(store.get()).toEqual({ liveElapsed: false, schemaVersion: 1 });
	});
});

test("a failed settings write keeps the last committed value", async () => {
	await withTemporarySettings(async (path) => {
		const store = await run(ToolUiSettingsStore.load(path, () => Effect.fail(new Error("write failed"))));

		await expect(run(store.setLiveElapsed(false))).rejects.toThrow("write failed");

		expect(store.get()).toEqual({ liveElapsed: true, schemaVersion: 1 });
	});
});
