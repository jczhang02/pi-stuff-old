/**
 * Pure path helpers for the single merged settings file.
 *
 * These are split from `lock.ts` so runtimes that only need the path (e.g. Node
 * running compiled Goal upstream tests) do not load `bun:ffi`. The FFI-based
 * `acquireSettingsLockNative` lives in `lock.ts`.
 */

import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { xdgRuntimeHome } from "../../xdg/index.ts";

/** The single merged settings file name every Capability converges into. */
export const MERGED_SETTINGS_FILE = "pi-stuff.json";

export function mergedSettingsPath(agentDirectory = getAgentDir()): string {
	return join(agentDirectory, MERGED_SETTINGS_FILE);
}

/**
 * The lock path for the merged settings file.
 *
 * When the file lives at the canonical agent directory and an XDG runtime home
 * exists, the lock lives under `$XDG_RUNTIME_DIR/pi-stuff/` so it survives
 * parallel writes cleanly and matches the legacy UI settings lock location.
 * Otherwise the lock sits beside the file with a `.lock` suffix.
 */
export function resolveSettingsLockPath(
	settingsPath: string = mergedSettingsPath(),
	environment: NodeJS.ProcessEnv = process.env,
	agentDir = getAgentDir(),
): string {
	const runtimeHome = xdgRuntimeHome(environment);
	return settingsPath === mergedSettingsPath(agentDir) && runtimeHome
		? join(runtimeHome, "pi-stuff", `${MERGED_SETTINGS_FILE}.lock`)
		: `${settingsPath}.lock`;
}
