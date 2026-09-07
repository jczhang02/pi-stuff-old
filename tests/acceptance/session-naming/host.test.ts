import { test } from "bun:test";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { CERTIFIED_PI_VERSION } from "../../../scripts/pi-host-contract.js";
import { verifySessionNaming } from "../../../scripts/verify-session-naming.js";

const PI_BINARY = resolvePiBinary();
const PI_STUFF_PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");

await access(PI_BINARY).catch(() => {
	throw new Error(`Set PI_BIN to the certified Pi ${CERTIFIED_PI_VERSION} standalone binary: ${PI_BINARY}`);
});

test("the certified Pi Host persists automatic and forced Session names across resume", async () => {
	await verifySessionNaming({ packagePath: PI_STUFF_PACKAGE, piBinary: PI_BINARY });
}, 30_000);
