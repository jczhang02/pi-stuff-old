import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prepareMagicContext } from "../../../packages/pi-stuff/src/context-management/config.js";

const roots: string[] = [];
// SAFETY: this test controls the value and supplies every NodeJS member exercised by this case.
const environment = process.env as NodeJS.ProcessEnv & {
	HOME?: string;
	PI_CODING_AGENT_DIR?: string;
	XDG_CONFIG_HOME?: string;
};
const ORIGINAL_ENV = {
	HOME: environment.HOME,
	PI_CODING_AGENT_DIR: environment.PI_CODING_AGENT_DIR,
	XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME,
};
const ORIGINAL_CWD = process.cwd();

interface BootstrapConfig {
	embedding?: { provider?: unknown };
	historian?: {
		opencode?: { model?: unknown };
		pi?: { model?: unknown; thinking_level?: unknown };
	};
	todowrite?: unknown;
	toast_duration_ms?: unknown;
}

function restoreEnvironment(): void {
	for (const [name, value] of Object.entries(ORIGINAL_ENV)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

async function isolatedEnvironment(): Promise<{
	canonical: string;
	customAgent: string;
	legacyAgent: string;
	root: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-context-config-"));
	roots.push(root);
	const customAgent = join(root, "custom-agent");
	const xdg = join(root, "config");
	environment.HOME = root;
	environment.PI_CODING_AGENT_DIR = customAgent;
	environment.XDG_CONFIG_HOME = xdg;
	return {
		canonical: join(xdg, "cortexkit", "magic-context.jsonc"),
		customAgent,
		legacyAgent: join(root, ".pi", "agent"),
		root,
	};
}

function extensionContext(cwd?: string): ExtensionContext {
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	return {
		cwd,
		model: { id: "fixture-model", provider: "fixture-provider" },
	} as ExtensionContext;
}

afterEach(async () => {
	process.chdir(ORIGINAL_CWD);
	restoreEnvironment();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function registerUserConfigurationTests(): void {
	test("keeps automatic Extension turns write-free until direct use", async () => {
		const paths = await isolatedEnvironment();

		expect(await prepareMagicContext(extensionContext(paths.root), { allowConfigurationMutation: false })).toBe(
			"deferred",
		);
		expect(await Bun.file(paths.canonical).exists()).toBeFalse();

		expect(await prepareMagicContext(extensionContext(paths.root), { allowConfigurationMutation: true })).toBe(
			"ready",
		);
		expect(await Bun.file(paths.canonical).exists()).toBeTrue();
	});

	test("creates one private canonical config on direct activation", async () => {
		const paths = await isolatedEnvironment();

		await prepareMagicContext(extensionContext(paths.root));

		// SAFETY: this test controls the serialized JSON fixture and exercises only the asserted fields.
		const config = JSON.parse(await readFile(paths.canonical, "utf8")) as BootstrapConfig;
		expect(config.historian?.opencode?.model).toBe("fixture-provider/fixture-model");
		expect(config.historian?.pi).toEqual({
			model: "fixture-provider/fixture-model",
			thinking_level: "medium",
		});
		expect(config.embedding?.provider).toBe("off");
		expect(config.todowrite).toEqual({ enabled: false, overlay: false });
		expect(config.toast_duration_ms).toBe(0);
		expect((await stat(paths.canonical)).mode & 0o777).toBe(0o600);

		await writeFile(paths.canonical, '{"enabled":false}\n', "utf8");
		await chmod(paths.canonical, 0o640);
		expect(await prepareMagicContext(extensionContext(paths.root), { allowConfigurationMutation: false })).toBe(
			"ready",
		);
		expect(await readFile(paths.canonical, "utf8")).toBe('{"enabled":false}\n');
		expect((await stat(paths.canonical)).mode & 0o777).toBe(0o640);
	});

	test("defers startup while a canonical user config needs per-harness migration", async () => {
		const paths = await isolatedEnvironment();
		await mkdir(join(paths.root, "config", "cortexkit"), { recursive: true });
		const legacyConfig = `{
			// Magic Context 0.33 flat execution settings.
			"historian": { "model": "legacy/historian" },
			"dreamer": {
				"fallback_models": ["legacy/dreamer"],
				"tasks": { "maintain-docs": { "timeout_minutes": 5 } },
			},
		}\n`;
		await writeFile(paths.canonical, legacyConfig, "utf8");

		expect(await prepareMagicContext(extensionContext(paths.root), { allowConfigurationMutation: false })).toBe(
			"deferred",
		);
		expect(await readFile(paths.canonical, "utf8")).toBe(legacyConfig);
		expect(await prepareMagicContext(extensionContext(paths.root), { allowConfigurationMutation: true })).toBe(
			"ready",
		);
		expect(await readFile(paths.canonical, "utf8")).toBe(legacyConfig);
	});

	test("preserves a legacy Pi config instead of creating a competing canonical file", async () => {
		const paths = await isolatedEnvironment();
		await mkdir(paths.legacyAgent, { recursive: true });
		const legacy = join(paths.legacyAgent, "magic-context.jsonc");
		await writeFile(legacy, '{"historian":{"model":"legacy/model"}}\n', "utf8");

		expect(await prepareMagicContext(extensionContext(paths.root), { allowConfigurationMutation: false })).toBe(
			"deferred",
		);
		await prepareMagicContext(extensionContext(paths.root));

		expect(await readFile(legacy, "utf8")).toContain("legacy/model");
		expect(await Bun.file(paths.canonical).exists()).toBeFalse();
	});
}

function registerProjectConfigurationTests(): void {
	test("does not mistake a custom Pi agent directory for an upstream config location", async () => {
		const paths = await isolatedEnvironment();
		await mkdir(paths.customAgent, { recursive: true });
		await writeFile(join(paths.customAgent, "magic-context.jsonc"), '{"enabled":false}\n', "utf8");

		expect(await prepareMagicContext(extensionContext(paths.root))).toBe("ready");
		expect(await Bun.file(paths.canonical).exists()).toBeTrue();
	});

	test("allows mutation-free startup with an existing canonical project config", async () => {
		const paths = await isolatedEnvironment();
		const projectConfig = join(paths.root, ".cortexkit", "magic-context.json");
		await mkdir(join(paths.root, ".cortexkit"), { recursive: true });
		await writeFile(projectConfig, '{"historian":{"model":"project/model"}}\n', "utf8");

		expect(await prepareMagicContext(extensionContext(paths.root), { allowConfigurationMutation: false })).toBe(
			"ready",
		);
		expect(await Bun.file(paths.canonical).exists()).toBeFalse();
		expect(await readFile(projectConfig, "utf8")).toBe('{"historian":{"model":"project/model"}}\n');
	});

	test("leaves legacy project migration to upstream without creating a global user config", async () => {
		const paths = await isolatedEnvironment();
		const legacyProject = join(paths.root, ".pi", "magic-context.jsonc");
		await mkdir(join(paths.root, ".pi"), { recursive: true });
		await writeFile(legacyProject, '{"historian":{"model":"legacy-project/model"}}\n', "utf8");

		expect(await prepareMagicContext(extensionContext(paths.root))).toBe("ready");
		expect(await Bun.file(paths.canonical).exists()).toBeFalse();
		expect(await readFile(legacyProject, "utf8")).toBe('{"historian":{"model":"legacy-project/model"}}\n');
	});

	test("matches upstream path rules for JSON variants and relative XDG_CONFIG_HOME", async () => {
		const paths = await isolatedEnvironment();
		process.chdir(paths.root);
		environment.XDG_CONFIG_HOME = "relative-config";
		const fallbackJson = join(paths.root, ".config", "cortexkit", "magic-context.json");
		await mkdir(join(paths.root, ".config", "cortexkit"), { recursive: true });
		await writeFile(fallbackJson, '{"enabled":false}\n', "utf8");

		expect(await prepareMagicContext(extensionContext(paths.root))).toBe("ready");
		expect(await readFile(fallbackJson, "utf8")).toBe('{"enabled":false}\n');
		expect(
			await Bun.file(join(paths.root, "relative-config", "cortexkit", "magic-context.jsonc")).exists(),
		).toBeFalse();
		expect(await Bun.file(join(paths.root, ".config", "cortexkit", "magic-context.jsonc")).exists()).toBeFalse();
	});

	test("defers an automatic activation while upstream project migration is pending", async () => {
		const paths = await isolatedEnvironment();
		await mkdir(join(paths.root, "config", "cortexkit"), { recursive: true });
		await writeFile(paths.canonical, '{"enabled":true}\n', "utf8");
		const legacyProject = join(paths.root, ".pi", "magic-context.jsonc");
		await mkdir(join(paths.root, ".pi"), { recursive: true });
		await writeFile(legacyProject, '{"enabled":false}\n', "utf8");

		expect(await prepareMagicContext(extensionContext(paths.root), { allowConfigurationMutation: false })).toBe(
			"deferred",
		);
		expect(await readFile(legacyProject, "utf8")).toBe('{"enabled":false}\n');
		expect(await Bun.file(join(paths.root, ".cortexkit", "magic-context.jsonc")).exists()).toBeFalse();
	});
}

describe.serial("Magic Context first-use configuration", () => {
	registerUserConfigurationTests();
	registerProjectConfigurationTests();
});
