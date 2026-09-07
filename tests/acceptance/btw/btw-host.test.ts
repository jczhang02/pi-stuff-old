import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { runPiRpcSmoke } from "../../../scripts/smoke-pi.ts";

const PI_BINARY = resolvePiBinary();
const PI_STUFF_PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");

test("the single Pi Stuff Package loads BTW without Extension errors", async () => {
	const result = await runPiRpcSmoke({ piBinary: PI_BINARY, packages: [PI_STUFF_PACKAGE] });
	expect(result.commandNames).toContain("btw");
	expect(result.stderr).toBe("");
}, 30_000);
