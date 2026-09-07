import { test } from "bun:test";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { verifyContextInputFramePty } from "../../../scripts/verify-context-input-frame-pty.ts";
import { verifyContextPty } from "../../../scripts/verify-context-pty.ts";

const PI_BIN = resolvePiBinary();

test("real Pi TUI activates Magic Context, resumes it, owns compaction, and preserves input when Context is unavailable", async () => {
	await verifyContextPty({
		piBinary: PI_BIN,
		packagePath: resolve(import.meta.dir, "../../../packages/pi-stuff"),
	});
}, 120_000);

test("long malformed-image history preserves the submitted input frame through native provider retry", async () => {
	await verifyContextInputFramePty({
		piBinary: PI_BIN,
		packagePath: resolve(import.meta.dir, "../../../packages/pi-stuff"),
	});
}, 120_000);
