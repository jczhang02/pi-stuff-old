import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { runPiRpcSmoke } from "../../../scripts/smoke-pi.js";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../..");
const PI_STUFF_PACKAGE = join(REPOSITORY_ROOT, "packages", "pi-stuff");
const INSPECTOR = join(REPOSITORY_ROOT, "tests", "fixtures", "assert-work-tools.ts");
const PI_BINARY = resolvePiBinary();

test("the single Pi Stuff Package loads Background Work without reviving a disabled Bash", async () => {
	const result = await runPiRpcSmoke({
		extensions: [INSPECTOR],
		packages: [PI_STUFF_PACKAGE],
		piBinary: PI_BINARY,
	});
	expect(result.stderr).toBe("");
	expect(result.commandNames).toContain("tasks");
	expect(result.commandNames).toContain("work-tools-certified");
	expect(result.createdFiles.some((path) => path.includes("tasks"))).toBe(false);
}, 30_000);
