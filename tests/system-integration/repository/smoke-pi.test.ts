import { describe, expect, test } from "bun:test";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { CERTIFIED_PI_VERSION } from "../../../scripts/pi-host-contract.ts";
import { runPiRpcSmoke } from "../../../scripts/smoke-pi.ts";

const PI_BINARY = resolvePiBinary();

await access(PI_BINARY).catch(() => {
	throw new Error(`Set PI_BIN to the certified Pi ${CERTIFIED_PI_VERSION} standalone binary: ${PI_BINARY}`);
});

describe("runPiRpcSmoke", () => {
	test("observes a fixture command through the standalone Pi host", async () => {
		const result = await runPiRpcSmoke({
			piBinary: PI_BINARY,
			extensions: [resolve(import.meta.dir, "../../fixtures/smoke-extension.ts")],
		});

		expect(result.commandNames).toContain("pi-stuff-smoke");
		expect(result.stderr).toBe("");
	});

	test("observes a fixture Package through settings-based discovery", async () => {
		const result = await runPiRpcSmoke({
			piBinary: PI_BINARY,
			packages: [resolve(import.meta.dir, "../../fixtures/smoke-package")],
		});

		expect(result.commandNames).toContain("pi-stuff-package-smoke");
		expect(result.stderr).toBe("");
	});
});
