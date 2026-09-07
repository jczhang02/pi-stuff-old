import { test } from "bun:test";
import { resolve } from "node:path";
import { selectAcceptanceMatrix } from "../../../scripts/acceptance-matrix.ts";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyBtwPty } from "../../../scripts/verify-btw-pty.ts";

const PI_BIN = resolvePiBinary();
const AGGREGATE_PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");

test("real Pi TUI keeps BTW concurrent, fits oversized history, and remains focus-safe", async () => {
	for (const [columns, rows] of selectAcceptanceMatrix(
		[
			[100, 32],
			[64, 28],
		] as const,
		[[100, 32]] as const,
	)) {
		await verifyBtwPty({ piBinary: PI_BIN, packagePath: AGGREGATE_PACKAGE, columns, rows });
	}
}, 120_000);
