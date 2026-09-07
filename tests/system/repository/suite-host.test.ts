import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { runPiRpcSmoke } from "../../../scripts/smoke-pi.ts";

const PI_BINARY = resolvePiBinary();
const PI_STUFF_PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");

test("Pi loads the ordered internal Modules through one Package", async () => {
	const result = await runPiRpcSmoke({ piBinary: PI_BINARY, packages: [PI_STUFF_PACKAGE] });

	for (const command of [
		"ui",
		"tools",
		"rtk",
		"codex",
		"goal",
		"ponytail",
		"ponytail-review",
		"ponytail-audit",
		"ponytail-debt",
		"ponytail-gain",
		"ponytail-help",
		"mcp",
		"tasks",
		"agents",
		"btw",
	]) {
		expect(result.commandNames).toContain(command);
	}
	expect(result.commandNames).not.toContain("tool-settings");
	expect(result.stderr).toBe("");
}, 30_000);
