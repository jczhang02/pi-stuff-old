import { test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyToolsResumePty } from "../../../scripts/verify-tools-resume-pty.ts";

const PI_BIN = resolvePiBinary();
const AGGREGATE_PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");

test("real Pi keeps compact Tool rows and exact active membership across in-process resume", async () => {
	await verifyToolsResumePty({ piBinary: PI_BIN, packagePath: AGGREGATE_PACKAGE });
}, 120_000);
