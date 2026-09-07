import { execFile } from "node:child_process";
import { chmod, cp, mkdtemp, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CERTIFIED_PI_VERSION } from "./pi-host-contract.ts";

const execFileAsync = promisify(execFile);

function unsupportedHostError(version: string): Error {
	return new Error(
		`PI_BIN reports ${version || "no version"}; supported Pi is ${CERTIFIED_PI_VERSION}. Point PI_BIN at an installed supported Pi executable.`,
	);
}

/** Checks the supported version only; real-Host acceptance establishes behavior. */
export async function verifyPiHostVersion(piBinary: string): Promise<void> {
	try {
		const metadata = await stat(piBinary);
		if (!metadata.isFile()) throw new Error("PI_BIN must be a regular file");
		const { stdout } = await execFileAsync(piBinary, ["--version"], { timeout: 30_000 });
		const version = stdout.trim();
		if (version !== CERTIFIED_PI_VERSION) throw unsupportedHostError(version);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("PI_BIN ")) throw error;
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Cannot verify PI_BIN version ${CERTIFIED_PI_VERSION}: ${detail}`);
	}
}

/** Copies the Host tree into a private acceptance-run directory after version verification. */
export async function stageSupportedPiHost(
	piBinary: string,
	stagingRoot: string,
): Promise<{ readonly binaryPath: string }> {
	await verifyPiHostVersion(piBinary);
	const sourceBinary = await realpath(piBinary);
	const directory = await mkdtemp(join(stagingRoot, "pi-host-"));
	await cp(dirname(sourceBinary), directory, {
		filter: (source) => resolve(source) !== sourceBinary,
		recursive: true,
	});
	await chmod(directory, 0o700);
	const binaryPath = join(directory, basename(sourceBinary));
	await cp(sourceBinary, binaryPath, { errorOnExist: true, force: false });
	await chmod(binaryPath, 0o500);
	return { binaryPath };
}
