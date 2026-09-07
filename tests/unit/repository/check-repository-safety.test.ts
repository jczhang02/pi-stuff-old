import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonInputObject } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { auditRepositoryFiles } from "../../../scripts/check-repository-safety.ts";
import {
	auditEffectBoundaryInventory,
	auditEffectBoundarySource,
	EFFECT_BOUNDARY_INVENTORY,
	type EffectBoundaryInventory,
} from "../../../scripts/repository-safety/effect-boundaries.js";

const TEMPORARY_ROOTS: string[] = [];
const SUITE_CAPABILITIES = [
	"conversation-ui",
	"session-naming",
	"tool-display",
	"context-management",
	"ponytail",
	"rtk",
	"codex",
	"goal",
	"web",
	"mcp",
	"background-work",
	"subagents",
	"todo",
	"btw",
	"notification",
	"code-mode",
];
const LOCAL_PACKAGE = {
	name: "@jczhang02/pi-stuff",
	private: true,
	files: ["index.ts", "src", "README.md", "LICENSE"],
	pi: {
		extensions: ["./index.ts"],
		skills: ["./src/ponytail/skills"],
		themes: ["./themes/*.json"],
	},
} satisfies JsonInputObject;

async function createRepository(packageManager = "bun@1.4.0"): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-safety-"));
	TEMPORARY_ROOTS.push(root);
	await Bun.$`git init --quiet ${root}`;
	await mkdir(join(root, "packages", "pi-stuff"), { recursive: true });
	await writeFile(
		join(root, "packages", "pi-stuff", "suite.json"),
		`${JSON.stringify({ schemaVersion: 2, capabilities: SUITE_CAPABILITIES, tools: [] }, null, "\t")}\n`,
	);
	await mkdir(join(root, "schemas"), { recursive: true });
	await writeFile(
		join(root, "schemas", "suite.schema.json"),
		`${JSON.stringify({ properties: { capabilities: { items: { enum: SUITE_CAPABILITIES } } } }, null, "\t")}\n`,
	);
	await writeFile(join(root, "README.md"), "Repository documentation.\n");
	await writeFile(
		join(root, "package.json"),
		`${JSON.stringify(
			{
				name: "fixture-root",
				private: true,
				packageManager,
				devDependencies: { typescript: "5.9.3" },
				trustedDependencies: [],
				workspaces: ["packages/pi-stuff"],
			},
			null,
			"\t",
		)}\n`,
	);
	await writeLocalPackage(root, LOCAL_PACKAGE);
	const effectBoundaryPaths = new Set([
		...EFFECT_BOUNDARY_INVENTORY.governedSources,
		...EFFECT_BOUNDARY_INVENTORY.nativeAdapters,
		...EFFECT_BOUNDARY_INVENTORY.runnerAdapters,
	]);
	for (const path of effectBoundaryPaths) await writeFixture(root, path, "export {};\n");
	return root;
}

async function writeLocalPackage(root: string, manifest: JsonInputObject): Promise<void> {
	await writeFile(join(root, "packages", "pi-stuff", "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
}

async function writeFixture(root: string, path: string, content: string | Uint8Array): Promise<void> {
	const absolutePath = join(root, path);
	await mkdir(dirname(absolutePath), { recursive: true });
	await writeFile(absolutePath, content);
}

function readmeScreenshotAssetPath(sourcePath: string, index = 0): string {
	const suffix = index === 0 ? "" : `-${String(index + 1)}`;
	return `docs/assets/readme/fixtures/${sourcePath.replaceAll("/", "-")}${suffix}.png`;
}

function readmeScreenshotBlock(sourcePath: string, index = 0): string {
	const link = `/${readmeScreenshotAssetPath(sourcePath, index)}`;
	return `<p align="center">\n  <a href="${link}">\n    <img src="${link}" alt="Fixture screenshot" width="100%">\n  </a>\n  <br>\n  <em>Fixture caption.</em>\n</p>`;
}

function pngHeader(width = 1600, height = 900, marker = ""): Buffer {
	const png = Buffer.alloc(24 + Buffer.byteLength(marker));
	Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
	png.writeUInt32BE(13, 8);
	png.write("IHDR", 12, "ascii");
	png.writeUInt32BE(width, 16);
	png.writeUInt32BE(height, 20);
	Buffer.from(marker).copy(png, 24);
	return png;
}

async function writeReadmeFixture(root: string, sourcePath: string, content: string, count = 1): Promise<void> {
	const blocks = Array.from({ length: count }, (_, index) => readmeScreenshotBlock(sourcePath, index));
	await Promise.all(
		blocks.map((_, index) =>
			writeFixture(
				root,
				readmeScreenshotAssetPath(sourcePath, index),
				pngHeader(1600, 900, `${sourcePath}:${index}`),
			),
		),
	);
	await writeFixture(root, sourcePath, `${content.trimEnd()}\n\n${blocks.join("\n\n")}\n`);
}

async function writeTranslationFixture(root: string, sourcePath: string, body = "# 中文镜像\n"): Promise<void> {
	const source = await readFile(join(root, sourcePath));
	const sha256 = createHash("sha256").update(source).digest("hex");
	await writeFixture(
		root,
		`docs/i18n/zh-CN/${sourcePath}`,
		`<!-- translation-source: ${sourcePath}; translation-source-sha256: ${sha256} -->\n\n${body}`,
	);
}

async function writeDocumentationFixture(root: string): Promise<readonly string[]> {
	const documents = {
		"AGENTS.md": "# Repository rules\n",
		"docs/README.md": "# Wiki\n\n[ADR](adr/0001-host.md)\n",
		"docs/adr/0001-host.md":
			"---\nstatus: accepted\n---\n\n# Keep the Host\n\n## Context\n\nContext.\n\n## Decision\n\nDecision.\n\n## Consequences\n\nConsequences.\n",
		"docs/research/README.md": "# Research\n\n[Study](study.md)\n",
		"docs/research/study.md": "# Study\n",
		"docs/reports/README.md": "# Reports\n\n[Report](report.md)\n",
		"docs/reports/report.md": "# Report\n",
	} as const;
	await writeReadmeFixture(root, "README.md", "Repository documentation.\n", 3);
	await writeReadmeFixture(root, "packages/pi-stuff/README.md", "# Package\n", 2);
	for (const [path, content] of Object.entries(documents)) {
		if (path.endsWith("/README.md")) await writeReadmeFixture(root, path, content);
		else await writeFixture(root, path, content);
	}
	const sources = ["README.md", "packages/pi-stuff/README.md", ...Object.keys(documents)];
	for (const source of sources) {
		const screenshotCount = source === "README.md" ? 3 : source === "packages/pi-stuff/README.md" ? 2 : 1;
		await writeTranslationFixture(
			root,
			source,
			source === "README.md" || source.endsWith("/README.md")
				? `${Array.from({ length: screenshotCount }, (_, index) => readmeScreenshotBlock(source, index)).join("\n\n")}\n\n# 中文镜像\n`
				: "# 中文镜像\n",
		);
	}
	return sources;
}

function repeatedLine(line: string, count: number): string {
	return `${line}\n`.repeat(count);
}

function multilineFunction(header: string, lines: number, footer = "}"): string {
	return [header, ...Array.from({ length: lines - 2 }, () => "\tvoid 0;"), footer].join("\n");
}

function indent(source: string): string {
	return source
		.split("\n")
		.map((line) => `\t${line}`)
		.join("\n");
}

function functionFinding(path: string, source: string, marker: string, lines: number) {
	const markerIndex = source.indexOf(marker);
	if (markerIndex < 0) throw new Error(`Missing fixture marker: ${marker}`);
	const start = source.slice(0, markerIndex).split("\n").length;
	return { path, rule: `source-function-over-120-lines:${String(start)}:${String(lines)}` };
}

afterEach(async () => {
	await Promise.all(TEMPORARY_ROOTS.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("accepts one private local Pi Package with exact dependencies", async () => {
	const root = await createRepository();
	await writeLocalPackage(root, {
		...LOCAL_PACKAGE,
		dependencies: { "@cortexkit/pi-magic-context": "0.40.0", typebox: "1.3.10" },
	});

	expect(await auditRepositoryFiles(root)).toEqual([]);
});

test("accepts indexed ADRs and fresh Simplified Chinese mirrors", async () => {
	const root = await createRepository();
	await writeDocumentationFixture(root);
	await writeFixture(root, "packages/pi-stuff/src/ponytail/skills/example/SKILL.md", "# Runtime Skill\n");
	await writeFixture(root, "packages/pi-stuff/src/example/THIRD_PARTY_NOTICES.md", "# Notices\n");
	await writeFixture(root, "docs/reports/historical.zh-CN.md", "# 历史记录\n");

	expect(await auditRepositoryFiles(root)).toEqual([]);
});

test("enforces README screenshot ownership, dimensions, mirrors, and orphan cleanup", async () => {
	const root = await createRepository();
	await writeDocumentationFixture(root);
	const rootAsset = readmeScreenshotAssetPath("README.md");
	const rootBlocks = [readmeScreenshotBlock("README.md"), readmeScreenshotBlock("README.md", 1)].join("\n\n");
	await writeFixture(root, "README.md", `Repository documentation.\n\n${rootBlocks}\n`);
	await writeTranslationFixture(root, "README.md", `${rootBlocks}\n\n# 中文镜像\n`);
	await writeFixture(root, rootAsset, pngHeader(800, 600, "README.md:0"));
	await writeFixture(
		root,
		"docs/README.md",
		`# Wiki\n\n[ADR](adr/0001-host.md)\n\n${readmeScreenshotBlock("README.md")}\n`,
	);
	await writeTranslationFixture(root, "docs/README.md", `${readmeScreenshotBlock("README.md")}\n\n# 中文镜像\n`);
	await writeFixture(root, "docs/research/README.md", "# Research\n\n[Study](study.md)\n");
	await writeTranslationFixture(root, "docs/research/README.md");
	await writeTranslationFixture(
		root,
		"docs/reports/README.md",
		`${readmeScreenshotBlock("README.md")}\n\n# 中文镜像\n`,
	);
	await writeReadmeFixture(root, "packages/pi-stuff/README.md", "# Package\n");
	await writeTranslationFixture(
		root,
		"packages/pi-stuff/README.md",
		`${readmeScreenshotBlock("packages/pi-stuff/README.md")}\n\n# 中文镜像\n`,
	);
	const duplicateContent = pngHeader(1600, 900, "duplicate-content");
	await writeFixture(root, readmeScreenshotAssetPath("docs/reports/README.md"), duplicateContent);
	await writeFixture(root, readmeScreenshotAssetPath("packages/pi-stuff/README.md"), duplicateContent);
	await writeFixture(root, "docs/assets/readme/fixtures/orphan.png", pngHeader(1600, 900, "orphan"));

	const findings = await auditRepositoryFiles(root);
	expect(findings).toContainEqual({ path: "README.md", rule: "readme-screenshot-size:800x600" });
	expect(findings).toContainEqual({ path: "README.md", rule: "readme-screenshot-count:2/3" });
	expect(findings).toContainEqual({ path: "docs/README.md", rule: "readme-screenshot-reused:README.md" });
	expect(findings).toContainEqual({ path: "docs/research/README.md", rule: "readme-screenshot-missing" });
	expect(findings).toContainEqual({ path: "docs/research/README.md", rule: "readme-screenshot-count:0/1" });
	expect(findings).toContainEqual({
		path: "packages/pi-stuff/README.md",
		rule: "readme-screenshot-count:1/2",
	});
	expect(findings).toContainEqual({
		path: "packages/pi-stuff/README.md",
		rule: `readme-screenshot-duplicate-content:${readmeScreenshotAssetPath("docs/reports/README.md")}`,
	});
	expect(findings).toContainEqual({
		path: "docs/i18n/zh-CN/docs/reports/README.md",
		rule: "readme-screenshot-translation-mismatch",
	});
	expect(findings).toContainEqual({
		path: "docs/assets/readme/fixtures/orphan.png",
		rule: "readme-screenshot-orphan",
	});
});

test("rejects broken wiki structure, ADR relations, and translation drift", async () => {
	const root = await createRepository();
	await writeDocumentationFixture(root);
	await writeFixture(
		root,
		"docs/README.md",
		"# Wiki\n\n[Missing](missing.md)\n[Escaped traversal](..%5c..%5coutside.md)\n",
	);
	await writeTranslationFixture(root, "docs/README.md");
	await writeFixture(
		root,
		"docs/adr/0001-host.md",
		"---\nstatus: superseded by ADR-9998\nsupersedes: 9999-missing\n---\n\n# Host\n\n## Decision\n\nDecision.\n\n## Context\n\nContext.\n\n## Consequences\n\nConsequences.\n",
	);
	await writeTranslationFixture(root, "docs/adr/0001-host.md");
	await writeFixture(root, "docs/research/study.md", "# Updated study\n");
	await rm(join(root, "docs/i18n/zh-CN/docs/reports/report.md"));

	const findings = await auditRepositoryFiles(root);
	expect(findings).toContainEqual({
		path: "docs/README.md",
		rule: "markdown-link-target-missing:docs/missing.md",
	});
	expect(findings).toContainEqual({
		path: "docs/README.md",
		rule: "markdown-link-outside-repository:..%5c..%5coutside.md",
	});
	expect(findings).toContainEqual({
		path: "docs/README.md",
		rule: "documentation-index-missing:docs/adr/0001-host.md",
	});
	expect(findings).toContainEqual({
		path: "docs/adr/0001-host.md",
		rule: "adr-relation-target-missing:9999",
	});
	expect(findings).toContainEqual({
		path: "docs/adr/0001-host.md",
		rule: "adr-relation-target-missing:9998",
	});
	expect(findings).toContainEqual({ path: "docs/adr/0001-host.md", rule: "adr-section-order" });
	expect(findings).toContainEqual({
		path: "docs/i18n/zh-CN/docs/research/study.md",
		rule: "translation-stale",
	});
	expect(findings).toContainEqual({
		path: "docs/reports/report.md",
		rule: "translation-missing:docs/i18n/zh-CN/docs/reports/report.md",
	});
});

test("requires repository Bun 1.4.0", async () => {
	const root = await createRepository("bun@1.3.14");

	expect(await auditRepositoryFiles(root)).toContainEqual({
		path: "package.json",
		rule: "package-manager-must-be-bun-1.4.0",
	});
});

test("rejects an unpinned source dependency", async () => {
	const root = await createRepository();
	await writeLocalPackage(root, {
		...LOCAL_PACKAGE,
		dependencies: {
			"@cortexkit/pi-magic-context": "https://github.com/cortexkit/magic-context/archive/refs/heads/main.tgz",
		},
	});

	expect(await auditRepositoryFiles(root)).toContainEqual({
		path: "packages/pi-stuff/package.json",
		rule: "direct-dependency-must-be-exact",
	});
});

test("rejects host state, private paths, and Package lifecycle side effects", async () => {
	const root = await createRepository();
	await writeFile(join(root, "auth.json"), "{}\n");
	await writeFile(join(root, "README.md"), `Local checkout: ${["", "home", "example", "private-suite"].join("/")}\n`);
	await writeLocalPackage(root, {
		...LOCAL_PACKAGE,
		files: ["index.ts", "src", "README.md", "LICENSE", "AGENTS.md"],
		scripts: { postinstall: "modify-host" },
	});

	expect(await auditRepositoryFiles(root)).toEqual([
		{ path: "README.md", rule: "private-absolute-path" },
		{ path: "auth.json", rule: "forbidden-host-state" },
		{ path: "packages/pi-stuff/package.json", rule: "package-files-allowlist" },
		{ path: "packages/pi-stuff/package.json", rule: "package-lifecycle-script" },
	]);
});

test("enforces the single private Package boundary", async () => {
	const root = await createRepository();
	await writeLocalPackage(root, {
		name: "@jczhang02/pi-stuff",
		files: ["index.ts", "../private.txt"],
		pi: { extensions: ["./extension.ts"] },
	});
	await mkdir(join(root, "packages", "pi-stuff", "src", "nested"), { recursive: true });
	await writeFile(join(root, "packages", "pi-stuff", "src", "nested", "package.json"), "{}\n");

	expect(await auditRepositoryFiles(root)).toEqual([
		{ path: "packages/pi-stuff/package.json", rule: "local-package-must-be-private" },
		{ path: "packages/pi-stuff/package.json", rule: "package-files-allowlist" },
		{ path: "packages/pi-stuff/package.json", rule: "package-pi-manifest" },
		{ path: "packages/pi-stuff/src/nested/package.json", rule: "unexpected-package-manifest" },
	]);
});

test("rejects ranged development dependencies and extra workspaces", async () => {
	const root = await createRepository();
	await writeFile(
		join(root, "package.json"),
		`${JSON.stringify(
			{
				name: "fixture-root",
				private: true,
				packageManager: "bun@1.4.0",
				devDependencies: { typescript: "^5.9.3" },
				trustedDependencies: ["typescript"],
				workspaces: ["packages/*"],
			},
			null,
			"\t",
		)}\n`,
	);

	expect(await auditRepositoryFiles(root)).toEqual([
		{ path: "package.json", rule: "direct-dependency-must-be-exact" },
		{ path: "package.json", rule: "trusted-dependencies-must-be-empty" },
		{ path: "package.json", rule: "single-package-workspace" },
	]);
});

test("enforces the documented internal Module dependency direction", async () => {
	const root = await createRepository();
	await mkdir(join(root, "packages", "pi-stuff", "src", "conversation-ui"), { recursive: true });
	await mkdir(join(root, "packages", "pi-stuff", "src", "goal"), { recursive: true });
	await mkdir(join(root, "packages", "pi-stuff", "src", "subagents"), { recursive: true });
	await mkdir(join(root, "packages", "pi-stuff", "src", "code-mode"), { recursive: true });
	await writeFile(
		join(root, "packages", "pi-stuff", "src", "conversation-ui", "index.ts"),
		'import goal from "../goal/index.js";\nexport default goal;\n',
	);
	await writeFile(
		join(root, "packages", "pi-stuff", "src", "subagents", "index.ts"),
		'import context from "../context-management/index.js";\nexport default context;\n',
	);
	await writeFile(
		join(root, "packages", "pi-stuff", "src", "code-mode", "index.ts"),
		'import context from "../context-management/index.js";\nimport type { Contract } from "../tool-display/contract.js";\nexport type Mode = Contract;\nexport default context;\n',
	);

	expect(await auditRepositoryFiles(root)).toEqual([
		{
			path: "packages/pi-stuff/src/conversation-ui/index.ts",
			rule: "forbidden-internal-module-dependency:conversation-ui->goal",
		},
	]);
});

test("rejects runtime source that bypasses every owned internal Module", async () => {
	const root = await createRepository();
	await mkdir(join(root, "packages", "pi-stuff", "src"), { recursive: true });
	for (const name of ["lifecycle-deadline.ts", "lifecycle-performance.ts", "suite-loader.ts", "suite-runtime.ts"]) {
		await writeFile(join(root, "packages", "pi-stuff", "src", name), "export {};\n");
	}
	await writeFile(
		join(root, "packages", "pi-stuff", "src", "global-coordinator.ts"),
		"export const coordinator = new Map();\n",
	);

	expect(await auditRepositoryFiles(root)).toContainEqual({
		path: "packages/pi-stuff/src/global-coordinator.ts",
		rule: "unowned-internal-source-module",
	});
});

test("keeps Suite composition and internal import policy in lockstep", async () => {
	const root = await createRepository();
	await writeFile(
		join(root, "packages", "pi-stuff", "suite.json"),
		`${JSON.stringify(
			{
				schemaVersion: 2,
				capabilities: [...SUITE_CAPABILITIES.filter((name) => name !== "code-mode"), "new-mode"],
				tools: [],
			},
			null,
			"\t",
		)}\n`,
	);

	expect(await auditRepositoryFiles(root)).toEqual([
		{
			path: "packages/pi-stuff/suite.json",
			rule: "suite-capability-without-import-policy:new-mode",
		},
		{
			path: "packages/pi-stuff/suite.json",
			rule: "import-policy-module-missing-from-suite:code-mode",
		},
	]);
});

test("rejects incomplete and undeclared Suite manifest fields", async () => {
	const root = await createRepository();
	await writeFile(
		join(root, "packages", "pi-stuff", "suite.json"),
		`${JSON.stringify({ capabilities: SUITE_CAPABILITIES, tools: [] }, null, "\t")}\n`,
	);
	expect(await auditRepositoryFiles(root)).toContainEqual({
		path: "packages/pi-stuff/suite.json",
		rule: "suite-manifest-invalid",
	});

	await writeFile(
		join(root, "packages", "pi-stuff", "suite.json"),
		`${JSON.stringify(
			{ schemaVersion: 2, capabilities: SUITE_CAPABILITIES, tools: [], optionalToolz: [] },
			null,
			"\t",
		)}\n`,
	);

	expect(await auditRepositoryFiles(root)).toEqual([
		{
			path: "packages/pi-stuff/suite.json",
			rule: "suite-manifest-invalid",
		},
	]);
});

test("keeps the Suite schema and internal import policy in lockstep", async () => {
	const root = await createRepository();
	await writeFile(
		join(root, "schemas", "suite.schema.json"),
		`${JSON.stringify(
			{
				properties: {
					capabilities: {
						items: { enum: [...SUITE_CAPABILITIES.filter((name) => name !== "code-mode"), "new-mode"] },
					},
				},
			},
			null,
			"\t",
		)}\n`,
	);

	expect(await auditRepositoryFiles(root)).toEqual([
		{
			path: "schemas/suite.schema.json",
			rule: "suite-schema-capability-without-import-policy:new-mode",
		},
		{
			path: "schemas/suite.schema.json",
			rule: "import-policy-module-missing-from-suite-schema:code-mode",
		},
	]);
});

test("rejects raw console output from Host source", async () => {
	const root = await createRepository();
	await mkdir(join(root, "packages", "pi-stuff", "src", "goal"), { recursive: true });
	await mkdir(join(root, "packages", "pi-stuff", "src", "notification"), { recursive: true });
	await writeFile(
		join(root, "packages", "pi-stuff", "src", "goal", "index.ts"),
		'console.warn("this would corrupt the Host TUI");\n',
	);
	await writeFile(
		join(root, "packages", "pi-stuff", "src", "goal", "stream.ts"),
		'process.stderr.write("this would also corrupt the Host TUI\\n");\n',
	);
	await writeFile(
		join(root, "packages", "pi-stuff", "src", "notification", "transport.ts"),
		"export const notify = (bytes: string) => process.stdout.write(bytes);\n",
	);

	expect(await auditRepositoryFiles(root)).toEqual([
		{
			path: "packages/pi-stuff/src/goal/index.ts",
			rule: "raw-host-console-output",
		},
		{
			path: "packages/pi-stuff/src/goal/stream.ts",
			rule: "raw-host-stream-output",
		},
	]);
});

test("rejects literal Host colors outside the explicit palette owners", async () => {
	const root = await createRepository();
	await mkdir(join(root, "packages", "pi-stuff", "src", "goal"), { recursive: true });
	await writeFile(
		join(root, "packages", "pi-stuff", "src", "goal", "index.ts"),
		'export const color = "38;2;203;166;247";\n',
	);
	await writeFile(
		join(root, "packages", "pi-stuff", "src", "goal", "ansi.ts"),
		`const code = "36";\nexport const fg = (text: string) => \`\\x1b[\${code}m\${text}\\x1b[0m\`;\n`,
	);
	await writeFile(
		join(root, "packages", "pi-stuff", "src", "goal", "style.ts"),
		`export const style = (code: "1" | "3" | "7", text: string) => \`\\x1b[\${code}m\${text}\\x1b[0m\`;\n`,
	);
	await writeFixture(
		root,
		"packages/pi-stuff/src/conversation-ui/skill-command-style.ts",
		'export const color = "38;2;178;129;214";\n',
	);
	expect(await auditRepositoryFiles(root)).toEqual([
		{ path: "packages/pi-stuff/src/goal/ansi.ts", rule: "hard-coded-host-color" },
		{ path: "packages/pi-stuff/src/goal/index.ts", rule: "hard-coded-host-color" },
	]);
});

test("confines Effect runners to governed Pi-facing adapters across aliases", async () => {
	const root = await createRepository();
	await writeFixture(
		root,
		"packages/pi-stuff/src/shared/effect-foundation.ts",
		[
			'import * as Effect from "effect/Effect";',
			"const { runPromise: execute } = Effect;",
			"void Effect.runPromise(Effect.void);",
			"void execute(Effect.void);",
		].join("\n"),
	);
	const rejectedPath = "packages/pi-stuff/src/shared/escaped-runner.ts";
	await writeFixture(
		root,
		rejectedPath,
		[
			'import * as Runtime from "effect/Runtime";',
			'import { runPromiseExit as executeExit } from "effect/Effect";',
			"const execute = Runtime.runPromise;",
			"const { runSync: executeSync } = Runtime;",
			"void execute(runtime)(program);",
			"void executeExit(program);",
			"void executeSync(program);",
			"unrelated.runPromise(program);",
		].join("\n"),
	);

	expect(await auditRepositoryFiles(root)).toEqual([
		{ path: rejectedPath, rule: "effect-source-not-governed:1" },
		{ path: rejectedPath, rule: "effect-runner-outside-adapter:runPromise:5" },
		{ path: rejectedPath, rule: "effect-runner-outside-adapter:runPromiseExit:6" },
		{ path: rejectedPath, rule: "effect-runner-outside-adapter:runSync:7" },
	]);
});

test("requires public Effect subpath imports in production source", () => {
	const path = "packages/pi-stuff/src/codex/usage.ts";
	const inventory = {
		governedSources: [path],
		nativeAdapters: [],
		runnerAdapters: [],
	} satisfies EffectBoundaryInventory;

	expect(auditEffectBoundarySource(path, 'import { Effect } from "effect";\n', inventory)).toEqual([
		{ path, rule: "effect-root-import:1" },
	]);
	expect(auditEffectBoundarySource(path, 'import * as Effect from "effect/Effect";\n', inventory)).toEqual([]);
});

test("confines native effects to explicit adapters and resolves import and destructuring aliases", () => {
	const allowedPath = "packages/pi-stuff/src/codex/usage.ts";
	const rejectedPath = "packages/pi-stuff/src/codex/core.ts";
	const inventory = {
		governedSources: [rejectedPath],
		nativeAdapters: [allowedPath],
		runnerAdapters: [],
	} satisfies EffectBoundaryInventory;
	const source = [
		'import { spawn as launch } from "node:child_process";',
		'import { readFile as load } from "node:fs/promises";',
		'import { setTimeout as delay } from "node:timers/promises";',
		'import { Worker as Thread } from "node:worker_threads";',
		"const { spawn: bunLaunch } = Bun;",
		"export function runNativeEffects() {",
		"\tnew Promise(() => undefined);",
		"\tnew AbortController();",
		"\tvoid fetch(url);",
		"\tsetTimeout(callback, 1);",
		"\tsetInterval(callback, 1);",
		"\tnew Thread(workerPath);",
		"\tlaunch(command);",
		"\tload(path);",
		"\tdelay(1);",
		"\tBun.spawn(command);",
		"\tbunLaunch(command);",
		"\tunrelated.runPromise(program);",
		"\tpi.exec(command);",
		"}",
	].join("\n");

	expect(auditEffectBoundarySource(allowedPath, source, inventory)).toEqual([]);
	expect(auditEffectBoundarySource(rejectedPath, source, inventory)).toEqual([
		{ path: rejectedPath, rule: "native-effect-outside-adapter:Promise:7" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:AbortController:8" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:network.fetch:9" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:timer.setTimeout:10" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:timer.setInterval:11" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:Worker:12" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:process.spawn:13" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:filesystem.readFile:14" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:timer.setTimeout:15" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:process.Bun.spawn:16" },
		{ path: rejectedPath, rule: "native-effect-outside-adapter:process.Bun.spawn:17" },
	]);
	expect(
		auditEffectBoundarySource(
			"packages/pi-stuff/src/codex/unclassified.ts",
			"export const schedule = () => setTimeout(callback, 1);",
			inventory,
		),
	).toEqual([
		{
			path: "packages/pi-stuff/src/codex/unclassified.ts",
			rule: "native-effect-outside-adapter:timer.setTimeout:1",
		},
	]);
});

test("rejects duplicate and missing Effect boundary inventory paths", async () => {
	const root = await createRepository();
	const existingPath = "packages/pi-stuff/src/shared/effect-foundation.ts";
	const missingPath = "packages/pi-stuff/src/shared/missing.ts";
	const inventory = {
		governedSources: [existingPath, existingPath, missingPath],
		nativeAdapters: [],
		runnerAdapters: [existingPath],
	} satisfies EffectBoundaryInventory;

	expect(await auditEffectBoundaryInventory(root, [existingPath], inventory)).toEqual([
		{ path: existingPath, rule: "effect-boundary-inventory-duplicate:governed-sources" },
		{ path: missingPath, rule: "effect-boundary-inventory-path-missing:governed-sources" },
	]);
});

test("enforces the 800-line boundary across repository code", async () => {
	const root = await createRepository();
	await writeFixture(root, "scripts/exact.ts", repeatedLine("// fixture", 800));
	await writeFixture(root, "scripts/tracked.ts", repeatedLine("// fixture", 801));
	Bun.spawnSync(["git", "add", "scripts/tracked.ts"], { cwd: root });

	const executableDocumentExtensions = ["css", "html", "json", "jsonc", "tape", "yaml", "yml"];
	for (const extension of executableDocumentExtensions) {
		await writeFixture(root, `docs/examples/oversized.${extension}`, repeatedLine("fixture", 801));
	}
	await writeFixture(root, "scripts/untracked.sh", repeatedLine("# fixture", 801));
	await writeFixture(root, "docs/reports/oversized.html", repeatedLine("report artifact", 801));
	await writeFixture(root, "docs/reports/oversized.sh", repeatedLine("# fixture", 801));

	const expectedPaths = [
		...executableDocumentExtensions.map((extension) => `docs/examples/oversized.${extension}`),
		"docs/reports/oversized.sh",
		"scripts/tracked.ts",
		"scripts/untracked.sh",
	].sort();
	expect(await auditRepositoryFiles(root)).toEqual(
		expectedPaths.map((path) => ({ path, rule: "source-file-over-800-lines:801" })),
	);
});

test("parses every JavaScript and TypeScript source extension", async () => {
	const root = await createRepository();
	const extensions = ["cjs", "cts", "js", "jsx", "mjs", "mts", "ts", "tsx"];
	const source = multilineFunction("const fixture = () => {", 121, "};");
	for (const extension of extensions) {
		await writeFixture(root, `scripts/extension.${extension}`, source);
	}
	await writeFixture(root, "scripts/malformed.ts", "export function broken( {\n");

	expect(await auditRepositoryFiles(root)).toEqual([
		...extensions.map((extension) => ({
			path: `scripts/extension.${extension}`,
			rule: "source-function-over-120-lines:1:121",
		})),
		{ path: "scripts/malformed.ts", rule: "source-parse-error:2" },
	]);
});

test("recursively enforces the 120-line boundary for executable function forms", async () => {
	const root = await createRepository();
	const functionPath = "scripts/functions.ts";
	const functionSource = [
		multilineFunction("function accepted() {", 120),
		multilineFunction("const expression = function () {", 121, "};"),
		multilineFunction("const arrow = () => {", 122, "};"),
		`function outer() {\n${indent(multilineFunction("function nested() {", 121))}\n}`,
	].join("\n\n");
	const classPath = "scripts/class.ts";
	const classSource = `class Fixture {\n${indent(
		[
			multilineFunction("constructor() {", 121),
			multilineFunction("method() {", 121),
			multilineFunction("get value() {", 121),
			multilineFunction("set value(_value: number) {", 121),
		].join("\n\n"),
	)}\n}`;
	await writeFixture(root, functionPath, functionSource);
	await writeFixture(root, classPath, classSource);

	expect(await auditRepositoryFiles(root)).toEqual([
		functionFinding(classPath, classSource, "constructor()", 121),
		functionFinding(classPath, classSource, "method()", 121),
		functionFinding(classPath, classSource, "get value()", 121),
		functionFinding(classPath, classSource, "set value", 121),
		functionFinding(functionPath, functionSource, "const expression", 121),
		functionFinding(functionPath, functionSource, "const arrow", 122),
		functionFinding(functionPath, functionSource, "function outer", 123),
		functionFinding(functionPath, functionSource, "function nested", 121),
	]);
});

test("ignores tracked files deleted from the working tree", async () => {
	const root = await createRepository();
	const deletedPath = join(root, "scripts", "deleted.ts");
	await writeFixture(root, "scripts/deleted.ts", repeatedLine("// fixture", 801));
	Bun.spawnSync(["git", "add", "scripts/deleted.ts"], { cwd: root });
	await rm(deletedPath);

	expect(await auditRepositoryFiles(root)).toEqual([]);
});
