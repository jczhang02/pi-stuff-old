import { expect, test } from "bun:test";
import {
	auditEffectBoundarySource,
	type EffectBoundaryInventory,
} from "../../../scripts/repository-safety/effect-boundaries.js";

test("requires public Effect subpath imports in production source", () => {
	const path = "packages/pi-stuff/src/codex/usage.ts";
	const inventory = {
		governedSources: [path],
		nativeAdapters: [],
		runnerAdapters: [],
	} satisfies EffectBoundaryInventory;

	expect(auditEffectBoundarySource(path, 'import { Effect } from "effect";\n', inventory)).toEqual([
		{ path, rule: "effect-root-import:1" },
	]);
	expect(auditEffectBoundarySource(path, 'import * as Effect from "effect/Effect";\n', inventory)).toEqual([]);
});

test("confines native effects to explicit adapters and resolves import and destructuring aliases", () => {
	const allowedPath = "packages/pi-stuff/src/codex/usage.ts";
	const rejectedPath = "packages/pi-stuff/src/codex/core.ts";
	const inventory = {
		governedSources: [rejectedPath],
		nativeAdapters: [allowedPath],
		runnerAdapters: [],
	} satisfies EffectBoundaryInventory;
	const source = [
		'import { spawn as launch } from "node:child_process";',
		'import { readFile as load } from "node:fs/promises";',
		'import { setTimeout as delay } from "node:timers/promises";',
		'import { Worker as Thread } from "node:worker_threads";',
		"const { spawn: bunLaunch } = Bun;",
		"export function runNativeEffects() {",
		"\tnew Promise(() => undefined);",
		"\tnew AbortController();",
		"\tvoid fetch(url);",
		"\tsetTimeout(callback, 1);",
		"\tsetInterval(callback, 1);",
		"\tnew Thread(workerPath);",
		"\tlaunch(command);",
		"\tload(path);",
		"\tdelay(1);",
		"\tBun.spawn(command);",
		"\tbunLaunch(command);",
		"\tunrelated.runPromise(program);",
		"\tpi.exec(command);",
		"}",
	].join("\n");

	expect(auditEffectBoundarySource(allowedPath, source, inventory)).toEqual([]);
	expect(auditEffectBoundarySource(rejectedPath, source, inventory)).toEqual([
		{ path: rejectedPath, rule: "native-effect-outside-adapter:Promise:7" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:AbortController:8" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:network.fetch:9" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:timer.setTimeout:10" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:timer.setInterval:11" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:Worker:12" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:process.spawn:13" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:filesystem.readFile:14" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:timer.setTimeout:15" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:process.Bun.spawn:16" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:process.Bun.spawn:17" },
	]);
	expect(
		auditEffectBoundarySource(
			"packages/pi-stuff/src/codex/unclassified.ts",
			"export const schedule = () => setTimeout(callback, 1);",
			inventory,
		),
	).toEqual([
		{
			path: "packages/pi-stuff/src/codex/unclassified.ts",
			rule: "native-effect-outside-adapter:timer.setTimeout:1",
		},
	]);
});
