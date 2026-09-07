import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { RtkSettingsStore } from "../../../packages/pi-stuff/src/rtk/settings.js";
import { mergeNamespaceRecordEffect } from "../../../packages/pi-stuff/src/shared/settings-io/index.js";

const roots: string[] = [];

function run<Value, ErrorType>(program: Effect.Effect<Value, ErrorType>): Promise<Value> {
	return Effect.runPromise(program);
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test("RTK settings discard unknown persisted keys", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-rtk-settings-"));
	roots.push(root);
	const path = join(root, "pi-stuff.json");
	await run(
		mergeNamespaceRecordEffect(path, "rtk", {
			outputProjection: false,
			rewriteCommands: true,
			schemaVersion: 1,
			future: "ignored",
		}),
	);

	expect((await run(RtkSettingsStore.load(path))).get()).toEqual({
		outputProjection: false,
		rewriteCommands: true,
		schemaVersion: 1,
	});
});

test("RTK startup reads legacy settings without migrating them", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-rtk-settings-"));
	roots.push(root);
	const path = join(root, "pi-stuff.json");
	const legacyPath = join(root, "pi-stuff-rtk.json");
	const legacy = { outputProjection: false, rewriteCommands: false, schemaVersion: 1 } as const;
	await writeFile(legacyPath, JSON.stringify(legacy));

	expect((await run(RtkSettingsStore.load(path))).get()).toEqual(legacy);
	await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
	expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual(legacy);
});

test("RTK settings serialize concurrent field updates without losing either value", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-rtk-settings-"));
	roots.push(root);
	const path = join(root, "pi-stuff.json");
	const store = await run(RtkSettingsStore.load(path));
	const observed: boolean[] = [];
	const unsubscribe = store.subscribe((settings) => observed.push(settings.outputProjection));

	await run(
		Effect.all([store.setOutputProjection(false), store.setRewriteCommands(false)], {
			concurrency: "unbounded",
			discard: true,
		}),
	);
	await run(store.whenIdle());
	unsubscribe();

	expect(store.get()).toEqual({ outputProjection: false, rewriteCommands: false, schemaVersion: 1 });
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
		rtk: { outputProjection: false, rewriteCommands: false, schemaVersion: 1 },
	});
	expect(observed.length).toBeGreaterThan(0);
});

test("a failed RTK settings write leaves the live value unchanged", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-rtk-settings-"));
	roots.push(root);
	const path = join(root, "pi-stuff.json");
	await run(
		mergeNamespaceRecordEffect(path, "rtk", {
			outputProjection: true,
			rewriteCommands: true,
			schemaVersion: 1,
		}),
	);
	const store = await run(RtkSettingsStore.load(path));
	let notifications = 0;
	store.subscribe(() => {
		notifications += 1;
	});
	await rm(path);
	await mkdir(path);

	await expect(run(store.setRewriteCommands(false))).rejects.toThrow();
	expect(store.get()).toEqual({ outputProjection: true, rewriteCommands: true, schemaVersion: 1 });
	expect(notifications).toBe(0);
});
