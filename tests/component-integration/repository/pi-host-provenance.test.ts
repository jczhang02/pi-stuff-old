import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CERTIFIED_PI_HOST_PROFILE, CERTIFIED_PI_VERSION } from "../../../scripts/pi-host-contract.ts";
import { stageSupportedPiHost, verifyPiHostVersion } from "../../../scripts/verify-pi-host-provenance.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

test("the Host profile identifies the supported version", () => {
	expect(CERTIFIED_PI_HOST_PROFILE).toBe(CERTIFIED_PI_VERSION);
});

async function fixtureBinary(directory: string, version: string, body = "# fixture"): Promise<string> {
	const binary = join(directory, "pi");
	await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\n${body}\n`);
	await chmod(binary, 0o500);
	return binary;
}

test("Host verification accepts different executable bytes with the supported version", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-host-provenance-test-"));
	temporaryDirectories.push(directory);
	const binary = await fixtureBinary(directory, CERTIFIED_PI_VERSION, "# different bytes");

	await expect(verifyPiHostVersion(binary)).resolves.toBeUndefined();
});

test("Host verification rejects mismatch, nonzero, and missing executables", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-host-provenance-test-"));
	temporaryDirectories.push(directory);
	const mismatch = await fixtureBinary(directory, "0.84.0");
	await expect(verifyPiHostVersion(mismatch)).rejects.toThrow("supported Pi is");
	const failing = join(directory, "failing");
	await writeFile(failing, "#!/bin/sh\nexit 1\n");
	await chmod(failing, 0o500);
	await expect(verifyPiHostVersion(failing)).rejects.toThrow("Cannot verify PI_BIN version");
	await expect(verifyPiHostVersion(join(directory, "missing"))).rejects.toThrow("Cannot verify PI_BIN version");
});

test("staging preserves adjacent resources and ordinary symlinks", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-host-provenance-test-"));
	temporaryDirectories.push(directory);
	const binary = await fixtureBinary(directory, CERTIFIED_PI_VERSION);
	await writeFile(join(directory, "resource.txt"), "adjacent");
	const staging = await mkdtemp(join(tmpdir(), "pi-host-staging-test-"));
	temporaryDirectories.push(staging);
	const link = join(directory, "pi-link");
	await symlink(binary, link);
	const result = await stageSupportedPiHost(link, staging);
	expect(await readFile(join(result.binaryPath, "../resource.txt"), "utf8")).toBe("adjacent");
	await expect(verifyPiHostVersion(result.binaryPath)).resolves.toBeUndefined();
});
