import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { runPiRpcSmoke } from "../../../scripts/smoke-pi.js";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../..");
const PI_STUFF_PACKAGE = join(REPOSITORY_ROOT, "packages", "pi-stuff");
const INSPECTOR = join(REPOSITORY_ROOT, "tests", "fixtures", "assert-codex-tools.ts");
const PI_BINARY = resolvePiBinary();

test("the single Pi Stuff Package loads only the deliberate Codex surface and leaves no startup settings", async () => {
	const result = await runPiRpcSmoke({
		extensions: [INSPECTOR],
		packages: [PI_STUFF_PACKAGE],
		piBinary: PI_BINARY,
	});
	expect(result.stderr).toBe("");
	expect(result.commandNames).toContain("codex");
	expect(result.commandNames).toContain("codex-tools-registered-certified");
	for (const excluded of ["compact", "image-generation", "status", "voice", "web"]) {
		expect(result.commandNames).not.toContain(excluded);
	}
	expect(result.createdFiles).not.toContain("agent/pi-stuff-codex.json");
}, 30_000);
