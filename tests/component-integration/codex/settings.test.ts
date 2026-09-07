import { afterEach, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { CodexSettingsStore } from "../../../packages/pi-stuff/src/codex/settings.js";
import { mergedSettingsPath } from "../../../packages/pi-stuff/src/shared/settings-io/index.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function temporaryAgentDir(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-codex-settings-"));
	temporaryRoots.push(root);
	return join(root, "agent");
}

test("loading Codex settings has no startup write", async () => {
	const agentDir = await temporaryAgentDir();
	const settings = await Effect.runPromise(CodexSettingsStore.load(agentDir));
	expect(settings.get()).toEqual({ fast: false });
	expect(
		access(mergedSettingsPath(agentDir)).then(
			() => true,
			() => false,
		),
	).resolves.toBe(false);
});

test("loading legacy Codex settings remains read-only", async () => {
	const agentDir = await temporaryAgentDir();
	await mkdir(agentDir, { recursive: true });
	const legacyPath = join(agentDir, "pi-stuff-codex.json");
	await writeFile(legacyPath, JSON.stringify({ fast: true }));

	expect((await Effect.runPromise(CodexSettingsStore.load(agentDir))).get()).toEqual({ fast: true });
	expect(
		access(mergedSettingsPath(agentDir)).then(
			() => true,
			() => false,
		),
	).resolves.toBe(false);
	expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual({ fast: true });
});

test("Fast mode persists atomically with private permissions", async () => {
	const agentDir = await temporaryAgentDir();
	const settings = await Effect.runPromise(CodexSettingsStore.load(agentDir));
	await Effect.runPromise(settings.setFast(true));
	const path = mergedSettingsPath(agentDir);
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ codex: { fast: true } });
	expect((await stat(path)).mode & 0o777).toBe(0o600);
	expect((await Effect.runPromise(CodexSettingsStore.load(agentDir))).get()).toEqual({ fast: true });
});

test("invalid settings fail closed without overwriting user data", async () => {
	const agentDir = await temporaryAgentDir();
	const path = mergedSettingsPath(agentDir);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, "not-json\n", { encoding: "utf8", mode: 0o600 });
	const settings = await Effect.runPromise(CodexSettingsStore.load(agentDir));
	expect(settings.get()).toEqual({ fast: false });
	expect(await readFile(path, "utf8")).toBe("not-json\n");
});

test("failed Fast persistence projects the error, releases the lock, and leaves the queue usable", async () => {
	const agentDir = await temporaryAgentDir();
	const settings = await Effect.runPromise(CodexSettingsStore.load(agentDir));
	const path = mergedSettingsPath(agentDir);
	await mkdir(path, { recursive: true });

	await expect(Effect.runPromise(settings.setFast(true))).rejects.toThrow();
	expect(settings.get()).toEqual({ fast: false });

	await rm(path, { recursive: true });
	await Effect.runPromise(settings.setFast(true));
	await Effect.runPromise(settings.whenIdle());
	expect(settings.get()).toEqual({ fast: true });
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ codex: { fast: true } });
});
