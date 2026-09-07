import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyPonytailPty } from "../../../scripts/verify-ponytail-pty.ts";

const PI_BIN = resolvePiBinary();
const packagePath = resolve(import.meta.dir, "../../../packages/pi-stuff");

test("real Pi certifies the Ponytail Dialog, Statusline, settings, and hard-off Provider boundary", async () => {
	const evidence = await verifyPonytailPty({ piBinary: PI_BIN, packagePath });

	expect(evidence.sizes).toEqual(["64x28", "48x16"]);
	expect(evidence.activePromptChars).toBeGreaterThan(0);
	expect(evidence.activePromptChars).toBeLessThanOrEqual(4_000);
	expect(evidence.verified).toEqual([
		"dialog navigation, low viewport, Statusline ownership, and draft restoration",
		"mode ledger, merged settings, and environment override read-only behavior",
		"active compact Provider prompt and hard-off Provider boundary",
		"six explicit Ponytail Skill commands while model invocation is mode-gated",
	]);
}, 120_000);
