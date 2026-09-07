import { test } from "bun:test";
import { waitForDetachedProcess } from "../../../scripts/detached-process.ts";

test("Code Mode RPC acceptance uses the real Pi Host with an offline fixture Provider", async () => {
	const child = Bun.spawn([process.execPath, "scripts/verify-code-mode-real.ts"], {
		detached: true,
		stderr: "inherit",
		stdout: "inherit",
	});
	const result = await waitForDetachedProcess(child, 180000);
	if (result.exitCode !== 0 || result.timedOut) throw new Error("Code Mode RPC acceptance failed");
}, 185000);
