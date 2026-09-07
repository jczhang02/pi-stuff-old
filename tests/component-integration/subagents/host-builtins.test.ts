import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeMcpServerHash,
	resolveMcpDirectToolSelections,
} from "../../../packages/pi-stuff/src/subagents/src/runs/shared/mcp-direct-tool-allowlist.ts";
import { writeChildToolDiagnostic } from "../../../packages/pi-stuff/src/subagents/src/runs/shared/tool-availability.ts";

const ISOLATED_ENVIRONMENT_KEYS = ["PI_CODING_AGENT_DIR", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"] as const;

test("PowerShell is available to child Agents as a Pi built-in", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-powershell-child-"));
	const diagnosticPath = join(directory, "diagnostic.json");
	try {
		expect(writeChildToolDiagnostic(diagnosticPath, ["powershell"], [])).toBeUndefined();
		expect(existsSync(diagnosticPath)).toBe(false);

		expect(writeChildToolDiagnostic(diagnosticPath, ["powershell", "missing_fixture"], [])).toMatchObject({
			missing: ["missing_fixture"],
		});
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});

test("MCP direct Tools cannot replace Pi's PowerShell built-in", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-powershell-mcp-"));
	// SAFETY: Object.fromEntries receives every key from the closed tuple and each corresponding optional environment value.
	const previousEnvironment = Object.fromEntries(
		ISOLATED_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]]),
	) as Record<(typeof ISOLATED_ENVIRONMENT_KEYS)[number], string | undefined>;
	const cwd = join(directory, "project");
	const cacheDirectory = join(directory, "cache");
	try {
		process.env["PI_CODING_AGENT_DIR"] = join(directory, "agent");
		process.env["XDG_CACHE_HOME"] = cacheDirectory;
		process.env["XDG_CONFIG_HOME"] = join(directory, "config");
		await mkdir(join(cacheDirectory, "pi-stuff", "mcp"), { recursive: true });
		await mkdir(cwd, { recursive: true });
		await writeFile(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: { fixture: { command: "fixture", directTools: true } },
				settings: { toolPrefix: "none" },
			}),
		);
		await writeFile(
			join(cacheDirectory, "pi-stuff", "mcp", "mcp-cache.json"),
			JSON.stringify({
				servers: {
					fixture: {
						cachedAt: Date.now(),
						configHash: computeMcpServerHash({ command: "fixture" }),
						tools: [{ name: "powershell" }, { name: "fixture_tool" }],
					},
				},
				version: 2,
			}),
		);

		expect(resolveMcpDirectToolSelections(["fixture"], cwd)).toEqual([
			{ name: "fixture_tool", selector: "fixture/fixture_tool" },
		]);
	} finally {
		for (const key of ISOLATED_ENVIRONMENT_KEYS) {
			const value = previousEnvironment[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(directory, { force: true, recursive: true });
	}
});
