import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonInputObject } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { generateSuite } from "../../../scripts/generate-suite.ts";

const TEMPORARY_ROOTS: string[] = [];

async function writeJson(path: string, value: JsonInputObject): Promise<void> {
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
}

async function createRepository(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-generator-"));
	TEMPORARY_ROOTS.push(root);
	await mkdir(join(root, "packages", "pi-stuff"), { recursive: true });
	await writeJson(join(root, "packages", "pi-stuff", "package.json"), {
		name: "@jczhang02/pi-stuff",
		private: true,
		dependencies: { typebox: "1.3.10" },
	});
	await writeJson(join(root, "packages", "pi-stuff", "suite.json"), {
		$schema: "../../schemas/suite.schema.json",
		schemaVersion: 2,
		capabilities: ["conversation-ui", "goal", "subagents", "btw"],
		tools: [],
	});
	return root;
}

afterEach(async () => {
	await Promise.all(TEMPORARY_ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("writes one ordered Extension from internal Capability Modules", async () => {
	const root = await createRepository();
	const manifestPath = join(root, "packages", "pi-stuff", "package.json");
	const originalManifest = await readFile(manifestPath, "utf8");

	const result = await generateSuite(root, "write");
	const generatedIndex = await readFile(join(root, "packages", "pi-stuff", "index.ts"), "utf8");
	const generatedRuntime = await readFile(join(root, "packages", "pi-stuff", "src", "suite-runtime.ts"), "utf8");

	expect(result.changedFiles).toEqual(["packages/pi-stuff/index.ts", "packages/pi-stuff/src/suite-runtime.ts"]);
	expect(generatedIndex).toContain(
		'import { importFreshSuiteRuntime, loadSuiteRuntime } from "./src/suite-loader.js";',
	);
	expect(generatedRuntime).toContain('import conversationUi from "./conversation-ui/index.js";');
	expect(generatedRuntime).toContain('import goal from "./goal/index.js";');
	expect(generatedRuntime).toContain('import subagents from "./subagents/index.js";');
	expect(generatedRuntime).toContain('import btw from "./btw/index.js";');
	expect(generatedRuntime).toContain(
		"return subagents(pi, { childBaseExtensionPath: options.childBaseExtensionPath });",
	);
	expect(generatedRuntime).toContain('{ id: "conversation-ui", install: conversationUi },');
	expect(generatedRuntime).toContain('{ id: "subagents", install: (pi) => registerSuiteSubagents(pi, options) },');
	expect(generatedRuntime).toContain('{ id: "btw", install: btw },');
	expect(generatedRuntime).toContain("const suiteApi = installSuiteSessionReadiness(pi);");
	expect(generatedRuntime).not.toContain("const effects =");
	expect(generatedRuntime).toContain("await capability.install(suiteApi);");
	expect(generatedRuntime).toContain("markSuiteSessionReady(pi, ctx);");
	expect(generatedRuntime).toContain('markLifecyclePhase("suite.factory.end");');
	expect(await readFile(manifestPath, "utf8")).toBe(originalManifest);
});

test("generates a fail-fast Activity coverage gate for declared Suite Tools", async () => {
	const root = await createRepository();
	await writeJson(join(root, "packages", "pi-stuff", "suite.json"), {
		schemaVersion: 2,
		capabilities: ["conversation-ui", "tool-display"],
		tools: ["read", "write"],
		deferredTools: ["ctx_search"],
		optionalTools: ["intercom"],
	});

	await generateSuite(root, "write");
	const generated = await readFile(join(root, "packages", "pi-stuff", "src", "suite-runtime.ts"), "utf8");
	expect(generated).toContain("import toolDisplay, {");
	expect(generated).toContain("\tassertSuiteToolActivityCoverage,");
	expect(generated).toContain("\tconfigureSuiteToolReplay,");
	expect(generated).toContain("\tcreateSuiteToolRegistrationTracker,");
	expect(generated).toContain('const SUITE_TOOL_NAMES = ["read", "write"] as const;');
	expect(generated).toContain('const DEFERRED_SUITE_TOOL_NAMES = ["ctx_search"] as const;');
	expect(generated).toContain('const OPTIONAL_SUITE_TOOL_NAMES = ["intercom"] as const;');
	expect(generated).toContain('const REPLAY_SUITE_TOOL_NAMES = ["read", "write", "ctx_search", "intercom"] as const;');
	expect(generated).toContain("createSuiteToolRegistrationTracker(suiteApi)");
	expect(generated).toContain("await capability.install(registrations.api);");
	expect(generated).toContain(
		"configureSuiteToolReplay(registrations.api, registrations.toolNames, REPLAY_SUITE_TOOL_NAMES);",
	);
	expect(generated).toContain("assertSuiteToolActivityCoverage(");
	expect(generated).toContain("rejectSuiteSessionReadiness(pi, ctx);");
	expect(generated).toContain("markSuiteSessionReady(pi, ctx);");
});

test("makes subagent conditionally absent only for a non-fanout child Suite", async () => {
	const root = await createRepository();
	await writeJson(join(root, "packages", "pi-stuff", "suite.json"), {
		schemaVersion: 2,
		capabilities: ["conversation-ui", "tool-display", "subagents"],
		tools: ["read", "subagent"],
	});

	await generateSuite(root, "write");
	const generated = await readFile(join(root, "packages", "pi-stuff", "src", "suite-runtime.ts"), "utf8");
	expect(generated).toContain(
		'import { SUBAGENT_CHILD_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./subagents/src/runs/shared/pi-args.js";',
	);
	expect(generated).toContain('process.env[SUBAGENT_CHILD_ENV] === "1"');
	expect(generated).toContain('process.env[SUBAGENT_FANOUT_CHILD_ENV] !== "1"');
	expect(generated).toContain('SUITE_TOOL_NAMES.filter((name) => name !== "subagent")');
	expect(generated).toContain("REQUIRED_SUITE_TOOL_NAMES,");
});

test("rejects unknown Modules and overlapping Tool inventories", async () => {
	const root = await createRepository();
	await writeJson(join(root, "packages", "pi-stuff", "suite.json"), {
		schemaVersion: 2,
		capabilities: ["separate-package"],
		tools: [],
	});
	await expect(generateSuite(root, "write")).rejects.toThrow("Unknown Capability Module: separate-package");

	await writeJson(join(root, "packages", "pi-stuff", "suite.json"), {
		schemaVersion: 2,
		capabilities: ["tool-display"],
		tools: ["read"],
		optionalTools: ["read"],
	});
	await expect(generateSuite(root, "write")).rejects.toThrow("Suite Tool inventories overlap at read");
});

test("rejects undeclared Suite registry fields", async () => {
	const root = await createRepository();
	await writeJson(join(root, "packages", "pi-stuff", "suite.json"), {
		capabilities: [],
		tools: [],
	});
	await expect(generateSuite(root, "write")).rejects.toThrow("must match the supported Suite registry schema");

	await writeJson(join(root, "packages", "pi-stuff", "suite.json"), {
		schemaVersion: 2,
		capabilities: [],
		tools: [],
		optionalToolz: [],
	});

	await expect(generateSuite(root, "write")).rejects.toThrow("must match the supported Suite registry schema");
});

test("wires Code Mode after ordinary capabilities with the shared Tool registry", async () => {
	const root = await createRepository();
	await writeJson(join(root, "packages", "pi-stuff", "suite.json"), {
		schemaVersion: 2,
		capabilities: ["tool-display", "code-mode"],
		tools: ["read"],
	});

	await generateSuite(root, "write");
	const generated = await readFile(join(root, "packages", "pi-stuff", "src", "suite-runtime.ts"), "utf8");
	expect(generated).toContain(
		'import codeMode, { CODE_MODE_PROVIDER_TOOL_NAMES, registerCodeModeContextProjection } from "./code-mode/index.js";',
	);
	expect(generated).toContain('{ id: "tool-display", install: toolDisplay },');
	expect(generated).toContain("\tregisterCodeModeContextProjection(suiteApi);");
	expect(generated).toContain(`\tcodeMode(registrations.api, {
\t\teffects,
\t\tregistry: registrations.registry,
\t\tsurface: registrations.surface,
\t});`);
	expect(generated.indexOf("await capability.install(registrations.api)")).toBeLessThan(
		generated.indexOf("codeMode(registrations.api"),
	);
	expect(generated.indexOf("registerCodeModeContextProjection(suiteApi)")).toBeLessThan(
		generated.indexOf("await capability.install(registrations.api)"),
	);
});

test("injects effective Code Mode state into Subagents at the Suite composition root", async () => {
	const root = await createRepository();
	await writeJson(join(root, "packages", "pi-stuff", "suite.json"), {
		schemaVersion: 2,
		capabilities: ["tool-display", "subagents", "code-mode"],
		tools: ["read", "subagent"],
	});

	await generateSuite(root, "write");
	const generated = await readFile(join(root, "packages", "pi-stuff", "src", "suite-runtime.ts"), "utf8");
	expect(generated).toContain(
		'const resolveCodeModeEnabled = () => registrations.surface.isEnvelopeEnabled("codemode");',
	);
	expect(generated).toContain(
		"registerSuiteSubagents(pi, options, resolveCodeModeEnabled, CODE_MODE_PROVIDER_TOOL_NAMES)",
	);
	expect(generated).toContain("childBaseExtensionPath: options.childBaseExtensionPath");
	expect(generated).toContain("codeModeProviderTools,");
	expect(generated).toContain("resolveCodeModeEnabled,");
});

test("reports generated drift without rewriting the working tree", async () => {
	const root = await createRepository();
	const indexPath = join(root, "packages", "pi-stuff", "index.ts");
	await generateSuite(root, "write");
	await writeFile(indexPath, "stale\n");

	await expect(generateSuite(root, "check")).rejects.toThrow(
		"Generated Suite files are stale: packages/pi-stuff/index.ts",
	);
	expect(await readFile(indexPath, "utf8")).toBe("stale\n");
});
