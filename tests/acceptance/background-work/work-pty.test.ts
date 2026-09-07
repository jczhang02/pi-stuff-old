import { test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyWorkPty } from "../../../scripts/verify-work-pty.js";

const PI_BIN = resolvePiBinary();

test("real Pi TUI detaches, monitors, manages, reloads, and cleans Background Work", async () => {
	await verifyWorkPty({
		columns: 96,
		packagePath: resolve(import.meta.dir, "../../../packages/pi-stuff"),
		piBinary: PI_BIN,
		rows: 30,
	});
}, 60_000);
