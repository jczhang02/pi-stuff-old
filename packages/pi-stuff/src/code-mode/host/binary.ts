import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { piStuffCachePath } from "../../xdg/index.ts";
import { codeModeHostBinaryName, HOST_RELEASE } from "./host-assets.ts";
import { installCodeModeHost } from "./install-host.ts";

function packageRoot(): string {
	return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function getCodeModeHostCachePath(platform: string, arch: string): string {
	return piStuffCachePath("code-mode", HOST_RELEASE, `${platform}-${arch}`, codeModeHostBinaryName(platform));
}

export function codeModeHostBinaryPath(platform = process.platform, arch = process.arch): string {
	const override = process.env["PI_STUFF_CODE_MODE_HOST"];
	if (override) {
		if (!isAbsolute(override) || !existsSync(override)) {
			throw new Error("PI_STUFF_CODE_MODE_HOST must point to an existing absolute path");
		}
		return override;
	}
	const name = codeModeHostBinaryName(platform);
	const bundled = join(packageRoot(), "bin", `${platform}-${arch}`, name);
	if (existsSync(bundled)) return bundled;
	const cached = getCodeModeHostCachePath(platform, arch);
	if (existsSync(cached)) return cached;
	throw new Error(`No Code Mode host binary for ${platform}-${arch}`);
}

export async function ensureCodeModeHostBinary(signal?: AbortSignal): Promise<string> {
	try {
		return codeModeHostBinaryPath();
	} catch (error) {
		if (process.env["PI_STUFF_CODE_MODE_HOST"]) throw error;
		const destination = getCodeModeHostCachePath(process.platform, process.arch);
		const options: Parameters<typeof installCodeModeHost>[0] = {
			arch: process.arch,
			destination,
			platform: process.platform,
		};
		if (signal) Object.assign(options, { signal });
		await installCodeModeHost(options);
		return codeModeHostBinaryPath();
	}
}
