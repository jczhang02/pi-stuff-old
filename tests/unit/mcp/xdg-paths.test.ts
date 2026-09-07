import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getGenericGlobalConfigPath,
	getPiGlobalConfigPath,
} from "../../../packages/pi-stuff/src/mcp/runtime/config.js";
import { getMetadataCachePath, loadMetadataCache } from "../../../packages/pi-stuff/src/mcp/runtime/metadata-cache.js";
import { getNpxCachePath } from "../../../packages/pi-stuff/src/mcp/runtime/npx-resolver.js";
import {
	getOnboardingStatePath,
	loadOnboardingState,
	saveOnboardingState,
} from "../../../packages/pi-stuff/src/mcp/runtime/onboarding-state.js";
import { getWebSearchConfigPath } from "../../../packages/pi-stuff/src/web/runtime/utils.js";

const ORIGINAL_ENVIRONMENT = {
	PI_CODING_AGENT_DIR: process.env["PI_CODING_AGENT_DIR"],
	XDG_CACHE_HOME: process.env["XDG_CACHE_HOME"],
	XDG_CONFIG_HOME: process.env["XDG_CONFIG_HOME"],
	XDG_STATE_HOME: process.env["XDG_STATE_HOME"],
};

function restoreEnvironment(): void {
	for (const [name, value] of Object.entries(ORIGINAL_ENVIRONMENT)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

afterEach(restoreEnvironment);

describe.serial("MCP XDG paths", () => {
	test("Pi-owned configuration follows the Host while shared MCP config follows XDG", () => {
		process.env["PI_CODING_AGENT_DIR"] = "/srv/config/pi";
		process.env["XDG_CONFIG_HOME"] = "/srv/config";

		expect(getPiGlobalConfigPath()).toBe("/srv/config/pi/mcp.json");
		expect(getWebSearchConfigPath()).toBe("/srv/config/pi/pi-stuff.json");
		expect(getGenericGlobalConfigPath()).toBe("/srv/config/mcp/mcp.json");
	});

	test("owned cache and state use the Pi Stuff XDG namespace", () => {
		process.env["XDG_CACHE_HOME"] = "/srv/cache";
		process.env["XDG_STATE_HOME"] = "/srv/state";

		expect(getMetadataCachePath()).toBe("/srv/cache/pi-stuff/mcp/mcp-cache.json");
		expect(getNpxCachePath()).toBe("/srv/cache/pi-stuff/mcp/mcp-npx-cache.json");
		expect(getOnboardingStatePath()).toBe("/srv/state/pi-stuff/mcp/mcp-onboarding.json");
	});

	test("invalidates pre-removal metadata that could contain app-only tools", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-cache-"));
		try {
			process.env["XDG_CACHE_HOME"] = root;
			const cachePath = getMetadataCachePath();
			await mkdir(join(root, "pi-stuff", "mcp"), { recursive: true });
			await Bun.write(
				cachePath,
				JSON.stringify({
					version: 1,
					servers: {
						legacy: {
							cachedAt: Date.now(),
							configHash: "legacy",
							resources: [],
							tools: [{ name: "app_only", uiVisibility: ["app"] }],
						},
					},
				}),
			);

			expect(loadMetadataCache()).toBeNull();
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	test("legacy onboarding state is read but new writes use XDG state", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-stuff-xdg-test-"));
		try {
			const agentDir = join(root, "config", "pi");
			const legacyPath = join(agentDir, "mcp-onboarding.json");
			process.env["PI_CODING_AGENT_DIR"] = agentDir;
			process.env["XDG_STATE_HOME"] = join(root, "state");
			await Bun.write(
				legacyPath,
				JSON.stringify({ version: 1, sharedConfigHintShown: true, setupCompleted: false }),
			);

			expect(loadOnboardingState()).toEqual({ version: 1, setupCompleted: false });
			saveOnboardingState({ version: 1, setupCompleted: true });

			expect(JSON.parse(await readFile(getOnboardingStatePath(), "utf8"))).toMatchObject({ setupCompleted: true });
			expect(JSON.parse(await readFile(legacyPath, "utf8"))).toMatchObject({ setupCompleted: false });
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});
