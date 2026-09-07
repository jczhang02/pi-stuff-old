import { test } from "bun:test";
import { waitForDetachedProcess } from "../../../scripts/detached-process.ts";

test("Magic Context live Provider acceptance is explicit", async () => {
	if (process.env["PI_STUFF_TEST_PROFILE"] !== "live") {
		throw new Error("Magic Context live acceptance requires PI_STUFF_TEST_PROFILE=live");
	}
	const child = Bun.spawn(
		[
			process.execPath,
			"scripts/verify-magic-context-real.ts",
			"--report",
			`.artifacts/tests/magic-context-${Date.now()}.json`,
		],
		{ detached: true, stderr: "inherit", stdout: "inherit", env: { ...process.env, PI_STUFF_REAL_ACCEPTANCE: "1" } },
	);
	const result = await waitForDetachedProcess(child, 900000);
	if (result.exitCode !== 0 || result.timedOut) throw new Error("Magic Context live acceptance failed");
}, 905_000);
