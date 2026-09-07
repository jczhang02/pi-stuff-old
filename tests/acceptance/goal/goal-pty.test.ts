import { test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyGoalPty } from "../../../scripts/verify-goal-pty.ts";

const PI_BIN = resolvePiBinary();
const AGGREGATE_PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");

test("real Pi renders Goal as a full-width Command Dialog with native settings", async () => {
	await verifyGoalPty({
		piBinary: PI_BIN,
		packagePath: AGGREGATE_PACKAGE,
		columns: 56,
		rows: 24,
	});
}, 30_000);
