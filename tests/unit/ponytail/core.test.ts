import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { PonytailSettingsStore } from "../../../packages/pi-stuff/src/ponytail/config.js";
import {
	filterPonytailSkillBodyForMode,
	getPonytailInstructions,
	preparePonytailInstructions,
} from "../../../packages/pi-stuff/src/ponytail/instructions.js";
import { isPonytailDeactivationCommand, normalizePonytailMode } from "../../../packages/pi-stuff/src/ponytail/types.js";

const roots: string[] = [];

function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-ponytail-test-"));
	roots.push(root);
	return {
		agentDir: path.join(root, "agent"),
		legacyPath: path.join(root, "legacy", "config.json"),
		root,
	};
}

function writeJson<Value>(filePath: string, value: Value): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Ponytail configuration", () => {
	test("resolves environment, merged, legacy, and defaults in order", async () => {
		const files = fixture();
		writeJson(files.legacyPath, { defaultMode: "lite", hideStatus: true, quietStartup: true });
		const legacy = await Effect.runPromise(
			PonytailSettingsStore.load(files.agentDir, { env: {}, legacyPath: files.legacyPath }),
		);
		expect(legacy.get()).toMatchObject({
			defaultMode: "lite",
			hideStatus: true,
			quietStartup: true,
			source: "legacy",
		});

		writeJson(path.join(files.agentDir, "pi-stuff.json"), {
			ponytail: { defaultMode: "ultra", hideStatus: false, quietStartup: false },
		});
		const merged = await Effect.runPromise(
			PonytailSettingsStore.load(files.agentDir, {
				env: { PONYTAIL_DEFAULT_MODE: "lite", PONYTAIL_HIDE_STATUS: "yes", PONYTAIL_QUIET_STARTUP: "0" },
				legacyPath: files.legacyPath,
			}),
		);
		expect(merged.get()).toMatchObject({
			defaultMode: "lite",
			defaultModeOverridden: true,
			hideStatus: true,
			hideStatusOverridden: true,
			quietStartup: false,
			quietStartupOverridden: true,
			source: "merged",
		});
	});

	test("fails closed without consulting legacy when merged settings are corrupt", async () => {
		const files = fixture();
		writeJson(files.legacyPath, { defaultMode: "ultra", hideStatus: true });
		fs.mkdirSync(files.agentDir, { recursive: true });
		const mergedPath = path.join(files.agentDir, "pi-stuff.json");
		fs.writeFileSync(mergedPath, "{broken");
		const store = await Effect.runPromise(
			PonytailSettingsStore.load(files.agentDir, { env: {}, legacyPath: files.legacyPath }),
		);
		expect(store.get()).toMatchObject({
			defaultMode: "full",
			hideStatus: false,
			source: "defaults",
			writable: false,
		});
		await expect(Effect.runPromise(store.update({ defaultMode: "lite" }))).rejects.toThrow();
		expect(fs.readFileSync(mergedPath, "utf8")).toBe("{broken");
	});

	test("rejects an invalid merged namespace and preserves it", async () => {
		const files = fixture();
		const mergedPath = path.join(files.agentDir, "pi-stuff.json");
		writeJson(mergedPath, { ponytail: { defaultMode: "review" }, untouched: true });
		const store = await Effect.runPromise(
			PonytailSettingsStore.load(files.agentDir, { env: {}, legacyPath: files.legacyPath }),
		);
		expect(store.get()).toMatchObject({ defaultMode: "full", source: "defaults", writable: false });
		await expect(Effect.runPromise(store.update({ hideStatus: true }))).rejects.toThrow(
			/invalid ponytail namespace/i,
		);
		expect(JSON.parse(fs.readFileSync(mergedPath, "utf8"))).toEqual({
			ponytail: { defaultMode: "review" },
			untouched: true,
		});
	});

	test("writes only merged settings while preserving valid legacy values and unknown fields", async () => {
		const files = fixture();
		writeJson(files.legacyPath, { defaultMode: "lite", hideStatus: true, quietStartup: true });
		writeJson(path.join(files.agentDir, "pi-stuff.json"), { ui: { transcript: true } });
		const store = await Effect.runPromise(
			PonytailSettingsStore.load(files.agentDir, { env: {}, legacyPath: files.legacyPath }),
		);
		const next = await Effect.runPromise(store.update({ defaultMode: "ultra" }));
		expect(next).toMatchObject({ defaultMode: "ultra", hideStatus: true, quietStartup: true, source: "merged" });
		expect(JSON.parse(fs.readFileSync(path.join(files.agentDir, "pi-stuff.json"), "utf8"))).toEqual({
			ui: { transcript: true },
			ponytail: { defaultMode: "ultra", hideStatus: true, quietStartup: true },
		});
		expect(JSON.parse(fs.readFileSync(files.legacyPath, "utf8"))).toEqual({
			defaultMode: "lite",
			hideStatus: true,
			quietStartup: true,
		});
	});
});

describe("Ponytail instructions", () => {
	test("filters only mode-specific table rows and examples", () => {
		const body = [
			"---",
			"name: ponytail",
			"---",
			"| **lite** | Lite row |",
			"| **full** | Full row |",
			'- lite: "Lite example"',
			'- full: "Full example"',
			"- Full: ordinary prose survives",
		].join("\n");
		const filtered = filterPonytailSkillBodyForMode(body, "full");
		expect(filtered).not.toContain("Lite row");
		expect(filtered).not.toContain("Lite example");
		expect(filtered).toContain("Full row");
		expect(filtered).toContain("Full example");
		expect(filtered).toContain("ordinary prose survives");
	});

	test("loads the canonical Skill and keeps review out of runtime modes", async () => {
		expect(await Effect.runPromise(preparePonytailInstructions())).toContain("name: ponytail");
		const instructions = getPonytailInstructions("ultra");
		expect(instructions).toContain("PONYTAIL MODE ACTIVE — level: ultra");
		expect(instructions).toContain("YAGNI extremist");
		expect(instructions).not.toContain("Build what's asked, but name the lazier alternative");
		expect(normalizePonytailMode("review")).toBeUndefined();
	});

	test("recognizes only standalone natural-language deactivation commands", () => {
		expect(isPonytailDeactivationCommand("Stop ponytail! ")).toBeTrue();
		expect(isPonytailDeactivationCommand("normal mode.")).toBeTrue();
		expect(isPonytailDeactivationCommand("add a normal mode toggle")).toBeFalse();
	});
});

test("retains the reviewed upstream resources with only the explicit-invocation adaptation", () => {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../packages/pi-stuff/src/ponytail");
	const expected = {
		"LICENSE.upstream": "fb1bc6909ac3ef82d5c22106e32ef682b0cff66788fa915fb9b53b15c9d2f3ab",
		"skills/ponytail-audit/SKILL.md": "5560b8e383dbe2ddfddc873a1e2bf2e586e23e0cd7d995537482b2315331f6d1",
		"skills/ponytail-debt/SKILL.md": "c84fba75f0ca12bfe83f9a78ea02fd125c5dd3f1fbb18124105a489937f284e6",
		"skills/ponytail-gain/SKILL.md": "24e01d1c9715cb136ba1c4f1e52a95940c0193558b876828e537736480d6408b",
		"skills/ponytail-help/SKILL.md": "2264d1615117b02b0fd5a69ec84cd2757006471a78e4d6c22eed6d581c1d37a4",
		"skills/ponytail-review/SKILL.md": "40df33b58fc6ef889b93585733feb9566b76e9586efa7f376785c1e995197ac0",
		"skills/ponytail/SKILL.md": "1316a2f3f95741d2300b116fe0c2d81ce4a9568656ed0a62643f54aaf09957f2",
	} satisfies Record<string, string>;
	for (const [relative, hash] of Object.entries(expected)) {
		const file = fs.readFileSync(path.join(root, relative), "utf8");
		const upstream = relative.endsWith("SKILL.md") ? file.replace("disable-model-invocation: true\n", "") : file;
		if (relative.endsWith("SKILL.md")) {
			expect(file.match(/^disable-model-invocation: true$/gmu)).toHaveLength(1);
		}
		expect(createHash("sha256").update(upstream).digest("hex")).toBe(hash);
	}
});
