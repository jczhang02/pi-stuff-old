import { expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { buildConfigWritePreview, buildUnifiedDiff } from "../../../packages/pi-stuff/src/mcp/config-persistence.js";
import {
	ensureCompatibilityImports,
	loadMcpConfig,
	writeProjectServerDisabledOverride,
	writeProjectServerLifecycleOverride,
	writeSharedServerEntry,
	writeStarterProjectConfig,
} from "../../../packages/pi-stuff/src/mcp/runtime/config.js";
import { parseMcpCommand } from "../../../packages/pi-stuff/src/mcp/runtime/implementation.js";
import { runMcpEffect } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-effect-runner.js";
import { acquireSettingsLockNative } from "../../../packages/pi-stuff/src/shared/settings-io/lock.js";

const MCP_CONFIG_DOCUMENT_SCHEMA = Type.Object(
	{
		mcpServers: Type.Record(Type.String(), Type.Object({ lifecycle: Type.String() }, { additionalProperties: true })),
	},
	{ additionalProperties: true },
);

test("keeps exact diffs for ordinary MCP configuration previews", () => {
	expect(buildUnifiedDiff("alpha\nold\nomega", "alpha\nnew\nomega")).toBe(
		"--- before\n+++ after\n  alpha\n+ new\n- old\n  omega",
	);
});

test("bounds oversized MCP configuration previews with a truthful linear diff", () => {
	const before = ["head", ...Array.from({ length: 501 }, (_, index) => `old-${String(index)}`), "tail"];
	const after = ["head", ...Array.from({ length: 501 }, (_, index) => `new-${String(index)}`), "tail"];
	const diff = buildUnifiedDiff(before.join("\n"), after.join("\n"));

	expect(diff.startsWith("--- before\n+++ after\n  head\n- old-0")).toBe(true);
	expect(diff.indexOf("- old-500")).toBeLessThan(diff.indexOf("+ new-0"));
	expect(diff.endsWith("+ new-500\n  tail")).toBe(true);
	expect(diff.split("\n")).toHaveLength(1_006);
});

test("rejects MCP configuration previews before source, generated, or line work becomes unbounded", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-preview-"));
	const path = join(cwd, ".mcp.json");
	try {
		await writeFile(path, "x".repeat(1_000_001));
		expect(() => buildConfigWritePreview(path, {})).toThrow("1000000-byte MCP config preview limit");
		expect(() => buildConfigWritePreview(join(cwd, "new.json"), { value: "x".repeat(1_000_001) })).toThrow(
			"1000000-byte MCP config preview limit",
		);
		expect(() => buildUnifiedDiff(Array.from({ length: 10_001 }, () => "x").join("\n"), "{}")).toThrow(
			"10000-line MCP config preview limit",
		);
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("parses the full server name after an MCP subcommand", () => {
	expect(parseMcpCommand("  reconnect docs local  ")).toEqual({
		serverName: "docs local",
		subcommand: "reconnect",
	});
	expect(parseMcpCommand("auth docs  local")).toEqual({
		serverName: "docs  local",
		subcommand: "auth",
	});
	expect(parseMcpCommand("   ")).toEqual({ subcommand: "" });
});

test("does not inherit URL-bound credentials when a higher-precedence source changes the endpoint", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const globalPath = join(cwd, "global.json");
	const serverName = "credential-bound-test";
	try {
		await writeFile(
			globalPath,
			JSON.stringify({
				mcpServers: {
					[serverName]: {
						url: "https://old.example/mcp",
						headers: { Authorization: "secret" },
						bearerToken: "secret",
						bearerTokenEnv: "SECRET_TOKEN",
						oauth: { clientId: "secret-client" },
					},
				},
			}),
		);
		await writeFile(
			join(cwd, ".mcp.json"),
			JSON.stringify({ mcpServers: { [serverName]: { url: "https://new.example/mcp" } } }),
		);

		expect((await runMcpEffect(loadMcpConfig(globalPath, cwd))).mcpServers[serverName]).toEqual({
			url: "https://new.example/mcp",
		});
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("keeps server state writes project-local when a custom global config is loaded", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const customPath = join(cwd, "custom-global.json");
	const projectPath = join(cwd, ".pi/mcp.json");
	const customDocument = { mcpServers: { docs: { command: "docs-mcp", disabled: true } } };
	try {
		await writeFile(customPath, `${JSON.stringify(customDocument)}\n`);
		const result = await runMcpEffect(writeProjectServerDisabledOverride(customPath, cwd, "docs", false));
		expect(result).toEqual({ changed: true, path: projectPath });
		expect(JSON.parse(await readFile(customPath, "utf8"))).toEqual(customDocument);
		expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({
			mcpServers: { docs: { disabled: false } },
		});
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("does not treat the project override or its alias as a lower config source", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const projectPath = join(cwd, ".pi/mcp.json");
	const aliasPath = join(cwd, "project-override-alias.json");
	try {
		await mkdir(join(cwd, ".pi"));
		await writeFile(projectPath, '{"mcpServers":{"docs":{"disabled":true}}}\n');
		await symlink(projectPath, aliasPath);
		for (const configPath of [projectPath, aliasPath]) {
			await writeFile(projectPath, '{"mcpServers":{"docs":{"disabled":true}}}\n');
			expect((await runMcpEffect(writeProjectServerDisabledOverride(configPath, cwd, "docs", false))).changed).toBe(
				true,
			);
			expect(JSON.parse(await readFile(projectPath, "utf8"))).toEqual({ mcpServers: {} });
		}
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("persists a server connection policy in the project MCP override", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const path = join(cwd, ".pi/mcp.json");
	try {
		await mkdir(join(cwd, ".pi"));
		await writeFile(path, '{"mcpServers":{"docs":{"disabled":false}},"settings":{"toolPrefix":"server"}}\n');
		expect((await runMcpEffect(writeProjectServerLifecycleOverride(cwd, "docs", "keep-alive"))).changed).toBe(true);
		expect((await runMcpEffect(writeProjectServerLifecycleOverride(cwd, "docs", "keep-alive"))).changed).toBe(false);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			mcpServers: { docs: { disabled: false, lifecycle: "keep-alive" } },
			settings: { toolPrefix: "server" },
		});
		expect((await runMcpEffect(writeProjectServerLifecycleOverride(cwd, "docs", "lazy"))).changed).toBe(true);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			mcpServers: { docs: { disabled: false, lifecycle: "lazy" } },
			settings: { toolPrefix: "server" },
		});
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("creates the first project override and preserves special server names", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const path = join(cwd, ".pi/mcp.json");
	try {
		expect((await runMcpEffect(writeProjectServerLifecycleOverride(cwd, "docs", "keep-alive"))).changed).toBe(true);
		expect((await runMcpEffect(writeProjectServerLifecycleOverride(cwd, "__proto__", "keep-alive"))).changed).toBe(
			true,
		);
		expect((await runMcpEffect(writeProjectServerLifecycleOverride(cwd, "toString", "lazy"))).changed).toBe(true);
		const document = JSON.parse(await readFile(path, "utf8"));
		expect(Check(MCP_CONFIG_DOCUMENT_SCHEMA, document)).toBe(true);
		if (!Check(MCP_CONFIG_DOCUMENT_SCHEMA, document)) throw new Error("Expected an MCP config document");
		expect(Object.hasOwn(document.mcpServers, "docs")).toBe(true);
		expect(Object.hasOwn(document.mcpServers, "__proto__")).toBe(true);
		expect(Object.hasOwn(document.mcpServers, "toString")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(document.mcpServers, "__proto__")?.value).toEqual({
			lifecycle: "keep-alive",
		});
		expect(document.mcpServers["toString"]).toEqual({ lifecycle: "lazy" });
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("loads special server names as own properties without changing map prototypes", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const path = join(cwd, "custom.json");
	try {
		await writeFile(
			path,
			'{"mcpServers":{"__proto__":{"command":"proto-mcp"},"toString":{"command":"string-mcp"}}}\n',
		);
		const servers = (await runMcpEffect(loadMcpConfig(path, cwd))).mcpServers;
		expect(Object.getPrototypeOf(servers)).toBe(Object.prototype);
		expect(Object.hasOwn(servers, "__proto__")).toBe(true);
		expect(Object.hasOwn(servers, "toString")).toBe(true);
		expect(Object.getOwnPropertyDescriptor(servers, "__proto__")?.value).toEqual({ command: "proto-mcp" });
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("refuses to write a project override through a symlink", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const path = join(cwd, ".pi/mcp.json");
	const target = join(cwd, "shared-mcp.json");
	try {
		await mkdir(join(cwd, ".pi"));
		await writeFile(target, '{"mcpServers":{}}\n');
		await symlink(target, path);
		await expect(runMcpEffect(writeProjectServerLifecycleOverride(cwd, "docs", "keep-alive"))).rejects.toThrow(
			"Refusing to write project MCP config through a symbolic link",
		);
		expect((await lstat(path)).isSymbolicLink()).toBe(true);
		expect(await readFile(target, "utf8")).toBe('{"mcpServers":{}}\n');
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("refuses a project override whose parent symlink escapes the project", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-outside-"));
	try {
		await symlink(outside, join(cwd, ".pi"));
		await expect(runMcpEffect(writeProjectServerLifecycleOverride(cwd, "docs", "keep-alive"))).rejects.toThrow(
			"Refusing to write project MCP config through a symbolic link",
		);
		expect(await Bun.file(join(outside, "mcp.json")).exists()).toBe(false);
	} finally {
		await rm(cwd, { force: true, recursive: true });
		await rm(outside, { force: true, recursive: true });
	}
});

test("pins the validated project config directory while waiting for its lock", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const outside = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-outside-"));
	const projectDirectory = join(cwd, ".pi");
	const pinnedDirectory = join(cwd, ".pi-pinned");
	let release: (() => Promise<void>) | undefined;
	try {
		await mkdir(projectDirectory);
		release = await acquireSettingsLockNative(join(projectDirectory, "mcp.json.lock"), "MCP race test");
		const pendingWrite = runMcpEffect(writeProjectServerLifecycleOverride(cwd, "docs", "keep-alive"));
		await new Promise((resolve) => setTimeout(resolve, 30));
		await rename(projectDirectory, pinnedDirectory);
		await symlink(outside, projectDirectory);
		await release();
		release = undefined;

		expect(await pendingWrite).toEqual({ changed: true, path: join(cwd, ".pi/mcp.json") });
		expect(JSON.parse(await readFile(join(pinnedDirectory, "mcp.json"), "utf8"))).toEqual({
			mcpServers: { docs: { lifecycle: "keep-alive" } },
		});
		expect(await Bun.file(join(outside, "mcp.json")).exists()).toBe(false);
	} finally {
		await release?.();
		await rm(cwd, { force: true, recursive: true });
		await rm(outside, { force: true, recursive: true });
	}
});

test("locks a shared config symlink and its resolved target as one file", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const path = join(cwd, ".mcp.json");
	const target = join(cwd, "shared-mcp.json");
	try {
		await writeFile(target, '{"mcpServers":{}}\n');
		await symlink(target, path);
		await Promise.all([
			runMcpEffect(writeSharedServerEntry(path, "docs", { command: "docs-mcp" })),
			runMcpEffect(writeSharedServerEntry(target, "browser", { command: "browser-mcp" })),
		]);
		expect((await lstat(path)).isSymbolicLink()).toBe(true);
		expect(JSON.parse(await readFile(target, "utf8"))).toEqual({
			mcpServers: {
				browser: { command: "browser-mcp" },
				docs: { command: "docs-mcp" },
			},
		});
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("merges concurrent server additions without losing either entry", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const path = join(cwd, ".mcp.json");
	try {
		await Promise.all([
			runMcpEffect(writeSharedServerEntry(path, "docs", { url: "https://docs.example/mcp" })),
			runMcpEffect(writeSharedServerEntry(path, "browser", { command: "browser-mcp" })),
		]);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			mcpServers: {
				browser: { command: "browser-mcp" },
				docs: { url: "https://docs.example/mcp" },
			},
		});
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("starter setup never replaces a config created after its preview", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const path = join(cwd, ".mcp.json");
	try {
		await writeFile(path, '{"mcpServers":{"docs":{"url":"https://docs.example/mcp"}}}\n');
		await expect(runMcpEffect(writeStarterProjectConfig(cwd))).rejects.toThrow(
			"Refusing to replace existing MCP config",
		);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
			mcpServers: { docs: { url: "https://docs.example/mcp" } },
		});
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("refuses to overwrite a malformed project MCP override", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const path = join(cwd, ".pi/mcp.json");
	try {
		await mkdir(join(cwd, ".pi"));
		await writeFile(path, "not json\n");
		await expect(runMcpEffect(writeProjectServerLifecycleOverride(cwd, "docs", "keep-alive"))).rejects.toThrow(
			"Failed to read project MCP override",
		);
		expect(await readFile(path, "utf8")).toBe("not json\n");
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});

test("refuses to overwrite malformed shared MCP configuration", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-config-"));
	const sharedPath = join(cwd, ".mcp.json");
	const piPath = join(cwd, "mcp.json");
	try {
		await writeFile(sharedPath, "not json\n");
		await expect(runMcpEffect(writeSharedServerEntry(sharedPath, "docs", { command: "docs-mcp" }))).rejects.toThrow(
			"Failed to read MCP config",
		);
		expect(await readFile(sharedPath, "utf8")).toBe("not json\n");
		await writeFile(sharedPath, '{"mcpServers":[]}\n');
		await expect(runMcpEffect(writeSharedServerEntry(sharedPath, "docs", { command: "docs-mcp" }))).rejects.toThrow(
			"mcpServers must be an object",
		);
		expect(await readFile(sharedPath, "utf8")).toBe('{"mcpServers":[]}\n');

		await writeFile(piPath, "[]\n");
		await expect(runMcpEffect(ensureCompatibilityImports(["cursor"], piPath))).rejects.toThrow(
			"Failed to read MCP config",
		);
		expect(await readFile(piPath, "utf8")).toBe("[]\n");
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});
