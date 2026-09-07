import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
	EffectNamespacedSettingsStore,
	mergeNamespaceRecordEffect,
	readNamespaceEffect,
	readSettingsFileEffect,
	SettingsFormatError,
	type SettingsRecord,
} from "../../../packages/pi-stuff/src/shared/settings-io/index.js";
import {
	acquireSettingsLockEffect,
	acquireSettingsLockNative,
} from "../../../packages/pi-stuff/src/shared/settings-io/lock.js";

const roots: string[] = [];
const run = Effect.runPromise;

async function dir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-settings-io-"));
	roots.push(root);
	return root;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

async function writeSettingsFixture(path: string, record: SettingsRecord): Promise<void> {
	await Bun.write(path, JSON.stringify(record));
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test("readSettingsFileEffect returns {} for a missing file", async () => {
	const path = join(await dir(), "pi-stuff.json");
	expect(await run(readSettingsFileEffect(path))).toEqual({});
});

test("readSettingsFileEffect identifies invalid settings content", async () => {
	const path = join(await dir(), "pi-stuff.json");
	await Bun.write(path, "{");
	await expect(run(readSettingsFileEffect(path))).rejects.toBeInstanceOf(SettingsFormatError);
});

test("mergeNamespaceRecordEffect writes tab-indented JSON", async () => {
	const path = join(await dir(), "pi-stuff.json");
	await run(mergeNamespaceRecordEffect(path, "ui", { statusline: true }));
	const content = await readFile(path, "utf8");
	expect(content).toBe('{\n\t"ui": {\n\t\t"statusline": true\n\t}\n}\n');
});

test("settings locks refuse symlinks without changing their targets", async () => {
	const root = await dir();
	const target = join(root, "outside.txt");
	const lockPath = join(root, "pi-stuff.json.lock");
	await Bun.write(target, "preserve me\n");
	await symlink(target, lockPath);

	await expect(acquireSettingsLockNative(lockPath, "test settings")).rejects.toThrow();
	expect(await readFile(target, "utf8")).toBe("preserve me\n");
});

test("mergeNamespaceRecordEffect preserves sibling namespaces", async () => {
	const path = join(await dir(), "pi-stuff.json");
	await writeSettingsFixture(path, { ui: { statusline: true }, tools: { liveElapsed: false } });
	const merged = await run(mergeNamespaceRecordEffect(path, "ui", { statusline: false }));
	expect(merged).toEqual({ ui: { statusline: false }, tools: { liveElapsed: false } });
	expect(await run(readSettingsFileEffect(path))).toEqual({
		ui: { statusline: false },
		tools: { liveElapsed: false },
	});
});

test("readNamespaceEffect returns undefined for a missing namespace", async () => {
	const path = join(await dir(), "pi-stuff.json");
	await writeSettingsFixture(path, { ui: { statusline: true } });
	expect(await run(readNamespaceEffect(path, "ui"))).toEqual({ statusline: true });
	expect(await run(readNamespaceEffect(path, "tools"))).toBeUndefined();
});

test("readNamespaceEffect rejects a malformed namespace", async () => {
	const path = join(await dir(), "pi-stuff.json");
	await writeSettingsFixture(path, { codeMode: true });
	await expect(run(readNamespaceEffect(path, "codeMode"))).rejects.toThrow("is not a JSON object");
});

const TEST_SETTINGS_SCHEMA = Type.Object({ count: Type.Number(), enabled: Type.Boolean() });
type TestSettings = Static<typeof TEST_SETTINGS_SCHEMA>;

function normalize<Value>(value: Value): TestSettings {
	if (!Check(TEST_SETTINGS_SCHEMA, value)) throw new Error("expected enabled boolean and count number");
	return value;
}

test("EffectNamespacedSettingsStore loads defaults when the namespace is absent", async () => {
	const path = join(await dir(), "pi-stuff.json");
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, { path }),
	);
	expect(store.get()).toEqual({ enabled: false, count: 0 });
});

test("EffectNamespacedSettingsStore reports invalid initial values and leaves them untouched", async () => {
	const path = join(await dir(), "pi-stuff.json");
	await writeSettingsFixture(path, { codex: { enabled: "invalid", count: 3 } });
	const diagnostics: string[] = [];
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, {
			path,
			reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic.key),
		}),
	);

	expect(store.get()).toEqual({ enabled: false, count: 0 });
	expect(diagnostics).toEqual(["invalid-settings"]);
	await expect(run(store.update({ enabled: true }))).rejects.toThrow("expected enabled boolean and count number");
	expect(await run(readNamespaceEffect(path, "codex"))).toEqual({ enabled: "invalid", count: 3 });
});

test("EffectNamespacedSettingsStore update persists under the whole-file lock and preserves siblings", async () => {
	const path = join(await dir(), "pi-stuff.json");
	await writeSettingsFixture(path, { ui: { statusline: true } });
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, {
			path,
			acquireLock: acquireSettingsLockEffect,
		}),
	);
	await run(store.update({ enabled: true }));
	expect(store.get()).toEqual({ enabled: true, count: 0 });
	expect(await run(readNamespaceEffect(path, "codex"))).toEqual({ enabled: true, count: 0 });
	// Sibling namespace survives the locked write.
	expect(await run(readNamespaceEffect(path, "ui"))).toEqual({ statusline: true });
});

test("EffectNamespacedSettingsStore updateWith computes from the latest persisted namespace", async () => {
	const path = join(await dir(), "pi-stuff.json");
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, { path }),
	);
	await writeSettingsFixture(path, { codex: { enabled: false, count: 6 }, ui: { statusline: true } });

	await run(store.updateWith((current) => ({ enabled: true, count: current.count + 1 })));

	expect(store.get()).toEqual({ enabled: true, count: 7 });
	expect(await run(readSettingsFileEffect(path))).toEqual({
		codex: { enabled: true, count: 7 },
		ui: { statusline: true },
	});
});

test("EffectNamespacedSettingsStore replace writes the whole namespace wholesale", async () => {
	const path = join(await dir(), "pi-stuff.json");
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, { path }),
	);
	await run(store.replace({ enabled: true, count: 7 }));
	expect(await run(readNamespaceEffect(path, "codex"))).toEqual({ enabled: true, count: 7 });
});

test("EffectNamespacedSettingsStore replace repairs an invalid namespace and preserves siblings", async () => {
	const path = join(await dir(), "pi-stuff.json");
	await writeSettingsFixture(path, { codex: { enabled: false, count: 0 }, ui: { statusline: true } });
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, { path }),
	);
	await writeSettingsFixture(path, { codex: { enabled: "invalid" }, ui: { statusline: true } });
	await run(store.replace({ enabled: true, count: 7 }));
	expect(store.get()).toEqual({ enabled: true, count: 7 });
	expect(await run(readSettingsFileEffect(path))).toEqual({
		codex: { enabled: true, count: 7 },
		ui: { statusline: true },
	});
});

test("EffectNamespacedSettingsStore keeps a legacy fallback read-only until direct input", async () => {
	const root = await dir();
	const mergedPath = join(root, "pi-stuff.json");
	const legacyPath = join(root, "pi-stuff-codex.json");
	await Bun.write(legacyPath, JSON.stringify({ fast: true }));
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, {
			path: mergedPath,
			legacyPath,
			legacyReader: (source) =>
				Effect.tryPromise({
					try: async () => {
						const raw = JSON.parse(await readFile(source, "utf8"));
						return { enabled: raw["fast"] === true, count: 1 };
					},
					catch: (error) => (error instanceof Error ? error : new Error(String(error))),
				}),
		}),
	);
	expect(store.get()).toEqual({ enabled: true, count: 1 });
	expect(await run(readNamespaceEffect(mergedPath, "codex"))).toBeUndefined();
	expect(await fileExists(legacyPath)).toBe(true);

	await run(store.replace({ enabled: false, count: 2 }));
	expect(await run(readNamespaceEffect(mergedPath, "codex"))).toEqual({ enabled: false, count: 2 });
	expect(await fileExists(legacyPath)).toBe(true);
});

test("EffectNamespacedSettingsStore keeps the merged namespace authoritative over stale legacy settings", async () => {
	const root = await dir();
	const mergedPath = join(root, "pi-stuff.json");
	const legacyPath = join(root, "pi-stuff-codex.json");
	await writeSettingsFixture(mergedPath, { codex: { enabled: false, count: 7 } });
	await Bun.write(legacyPath, JSON.stringify({ fast: true }));
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, {
			path: mergedPath,
			legacyPath,
			legacyReader: () => Effect.succeed({ enabled: true, count: 1 }),
		}),
	);
	expect(store.get()).toEqual({ enabled: false, count: 7 });
	expect(await fileExists(legacyPath)).toBe(true);
});

test("EffectNamespacedSettingsStore memory store does not touch disk", async () => {
	const store = EffectNamespacedSettingsStore.memory<TestSettings>({ enabled: false, count: 0 });
	await run(store.update({ enabled: true }));
	expect(store.get()).toEqual({ enabled: true, count: 0 });
});

test("EffectNamespacedSettingsStore subscribers receive updated values", async () => {
	const path = join(await dir(), "pi-stuff.json");
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, { path }),
	);
	const seen: TestSettings[] = [];
	store.subscribe((value) => seen.push(value));
	await run(store.update({ enabled: true }));
	expect(seen).toEqual([{ enabled: true, count: 0 }]);
});

test("EffectNamespacedSettingsStore skips unchanged writes and notifications", async () => {
	const path = join(await dir(), "pi-stuff.json");
	let writes = 0;
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, {
			path,
			writer: () =>
				Effect.sync(() => {
					writes += 1;
				}),
		}),
	);
	const seen: TestSettings[] = [];
	store.subscribe((value) => seen.push(value));

	await run(store.update({ enabled: false }));

	expect(writes).toBe(0);
	expect(seen).toEqual([]);
});

test("EffectNamespacedSettingsStore serializes queued updates from the latest persisted namespace", async () => {
	const path = join(await dir(), "pi-stuff.json");
	await writeSettingsFixture(path, { ui: { statusline: true } });
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, {
			path,
			acquireLock: acquireSettingsLockEffect,
		}),
	);

	await Promise.all(
		Array.from({ length: 12 }, () => run(store.updateWith((current) => ({ ...current, count: current.count + 1 })))),
	);
	await run(store.whenIdle());

	expect(store.get()).toEqual({ enabled: false, count: 12 });
	expect(await run(readSettingsFileEffect(path))).toEqual({
		codex: { enabled: false, count: 12 },
		ui: { statusline: true },
	});
});

test("EffectNamespacedSettingsStore preserves legacy fallback diagnostics", async () => {
	const root = await dir();
	const diagnostics: string[] = [];
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, {
			path: join(root, "pi-stuff.json"),
			legacyPath: join(root, "legacy.json"),
			legacyReader: () => Effect.fail(new Error("invalid legacy settings")),
			reportDiagnostic: (diagnostic) => diagnostics.push(diagnostic.key),
		}),
	);

	expect(store.get()).toEqual({ enabled: false, count: 0 });
	expect(diagnostics).toEqual(["invalid-legacy-settings"]);
});

test("an interrupted Effect mutation finishes its atomic write and live-state commit", async () => {
	const path = join(await dir(), "pi-stuff.json");
	const persisted = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const store = await run(
		EffectNamespacedSettingsStore.load<TestSettings>("codex", { enabled: false, count: 0 }, normalize, {
			path,
			acquireLock: acquireSettingsLockEffect,
			writer: (settingsPath, namespace, record) =>
				Effect.gen(function* () {
					yield* mergeNamespaceRecordEffect(settingsPath, namespace, record);
					yield* Effect.sync(() => persisted.resolve());
					yield* Effect.promise(() => finish.promise);
				}),
		}),
	);
	const controller = new AbortController();
	const update = run(store.replace({ enabled: true, count: 1 }), { signal: controller.signal });
	await persisted.promise;
	controller.abort(new Error("cancel after persistence"));
	finish.resolve();

	await expect(update).rejects.toThrow();
	await run(store.whenIdle());
	expect(store.get()).toEqual({ enabled: true, count: 1 });
	expect(await run(readNamespaceEffect(path, "codex"))).toEqual({ enabled: true, count: 1 });
});

test("cancelling an Effect settings-lock waiter closes its native handle", async () => {
	const lockPath = join(await dir(), "pi-stuff.json.lock");
	const release = await acquireSettingsLockNative(lockPath, "holder");
	const controller = new AbortController();
	const waiting = run(Effect.scoped(acquireSettingsLockEffect(lockPath, "waiter")), {
		signal: controller.signal,
	});
	await Bun.sleep(20);
	controller.abort(new Error("cancel settings waiter"));
	await expect(waiting).rejects.toThrow();
	await release();

	const releaseAfterCancellation = await acquireSettingsLockNative(lockPath, "next holder");
	await releaseAfterCancellation();
});
