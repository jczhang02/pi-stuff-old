import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as Effect from "effect/Effect";
import {
	codeModeProjectSettingsPath,
	readCodeModeGlobalEnabled,
	readCodeModeProjectEnabled,
	writeCodeModeGlobalEnabled,
	writeCodeModeProjectEnabled,
} from "../../../packages/pi-stuff/src/code-mode/settings.js";

const roots: string[] = [];

function run<Value>(program: Effect.Effect<Value, Error>): Promise<Value> {
	return Effect.runPromise(program);
}

async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-code-mode-settings-"));
	roots.push(root);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test("Code Mode project settings are read-only until an explicit update", async () => {
	const cwd = await project();
	const path = codeModeProjectSettingsPath(cwd);
	expect(await run(readCodeModeProjectEnabled(cwd))).toBeUndefined();
	expect(await Bun.file(path).exists()).toBe(false);

	await run(writeCodeModeProjectEnabled(cwd, true));
	expect(await run(readCodeModeProjectEnabled(cwd))).toBe(true);
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ enabled: true });
	expect((await stat(path)).mode & 0o777).toBe(0o600);
});

test("Code Mode project updates preserve owned-file extensions and reject malformed values", async () => {
	const cwd = await project();
	const path = codeModeProjectSettingsPath(cwd);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, '{"note":"keep","enabled":false}\n');
	await run(writeCodeModeProjectEnabled(cwd, true));
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ enabled: true, note: "keep" });

	await writeFile(path, '{"enabled":"yes"}\n');
	await expect(run(readCodeModeProjectEnabled(cwd))).rejects.toThrow('"enabled" must be a boolean');
	await expect(run(writeCodeModeProjectEnabled(cwd, false))).rejects.toThrow('"enabled" must be a boolean');
});

test("Code Mode project inheritance removes only the owned override", async () => {
	const cwd = await project();
	const path = codeModeProjectSettingsPath(cwd);
	await run(writeCodeModeProjectEnabled(cwd, true));
	await run(writeCodeModeProjectEnabled(cwd, undefined));
	expect(await Bun.file(path).exists()).toBe(false);

	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, '{"enabled":true,"note":"keep"}\n');
	await run(writeCodeModeProjectEnabled(cwd, undefined));
	expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ note: "keep" });
});

test("Code Mode global settings are read-only until an explicit update", async () => {
	const agentDir = await project();
	const mergedPath = join(agentDir, "pi-stuff.json");
	expect(await run(readCodeModeGlobalEnabled(agentDir))).toBeUndefined();
	expect(await Bun.file(mergedPath).exists()).toBe(false);

	await run(writeCodeModeGlobalEnabled(true, agentDir));
	expect(await run(readCodeModeGlobalEnabled(agentDir))).toBe(true);
	expect(JSON.parse(await readFile(mergedPath, "utf8"))).toEqual({ codeMode: { enabled: true } });
});

test("Code Mode global settings reject malformed values", async () => {
	const agentDir = await project();
	const mergedPath = join(agentDir, "pi-stuff.json");
	await mkdir(dirname(mergedPath), { recursive: true });
	await writeFile(mergedPath, JSON.stringify({ codeMode: { enabled: "yes" } }));
	await expect(run(readCodeModeGlobalEnabled(agentDir))).rejects.toThrow('"enabled" must be a boolean');
});

test("Code Mode global settings preserve sibling namespaces", async () => {
	const agentDir = await project();
	const mergedPath = join(agentDir, "pi-stuff.json");
	await mkdir(dirname(mergedPath), { recursive: true });
	await writeFile(mergedPath, JSON.stringify({ ui: { statusline: true }, codeMode: { enabled: false } }));
	await run(writeCodeModeGlobalEnabled(true, agentDir));
	expect(JSON.parse(await readFile(mergedPath, "utf8"))).toEqual({
		ui: { statusline: true },
		codeMode: { enabled: true },
	});
});
