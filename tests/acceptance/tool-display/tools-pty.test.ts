import { test } from "bun:test";
import { resolve } from "node:path";
import { selectAcceptanceMatrix } from "../../../scripts/acceptance-matrix.ts";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyActiveToolParity, verifyToolsLivenessPty, verifyToolsPty } from "../../../scripts/verify-tools-pty.ts";

const PI_BIN = resolvePiBinary();
const AGGREGATE_PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");

test("real Pi keeps the complete Tool UI responsive and renders focused details safely", async () => {
	await verifyActiveToolParity({ piBinary: PI_BIN, packagePath: AGGREGATE_PACKAGE });
	for (const [columns, rows] of selectAcceptanceMatrix(
		[
			[100, 32],
			[64, 28],
		] as const,
		[[100, 32]] as const,
	)) {
		await verifyToolsPty({ piBinary: PI_BIN, packagePath: AGGREGATE_PACKAGE, columns, rows });
		await verifyToolsLivenessPty({ piBinary: PI_BIN, packagePath: AGGREGATE_PACKAGE, columns, rows });
	}
}, 180_000);
