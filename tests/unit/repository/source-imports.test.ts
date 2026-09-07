import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditRepositoryFiles } from "../../../scripts/check-repository-safety.ts";

test("Package imports name existing source files without JavaScript-to-TypeScript fallback", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-source-imports-"));
	const sources = [
		["index.ts", 'export * from "./helper.js";'],
		[
			"src/shared/imports.ts",
			[
				'import { value } from "../../helper.js";',
				'import type { Value } from "../../helper.js";',
				'type Alias = import("../../helper.js").Value;',
			].join("\n"),
		],
		[
			"src/subagents/index.ts",
			[
				'export { value } from "../../helper.js";',
				'import("../../helper.js");',
				'import "../web/runtime/index.js";',
			].join("\n"),
		],
	] as const;
	try {
		await Bun.$`git init --quiet ${root}`;
		const packageRoot = join(root, "packages/pi-stuff");
		for (const [path, source] of [
			...sources,
			["helper.ts", "export const value = 1; export type Value = number;"],
			["src/web/runtime/index.js", "export {};"],
		]) {
			await mkdir(dirname(join(packageRoot, path)), { recursive: true });
			await writeFile(join(packageRoot, path), source);
		}
		const missingImports = async () =>
			(await auditRepositoryFiles(root)).filter((finding) =>
				finding.rule.startsWith("relative-import-missing-target:"),
			);
		expect(await missingImports()).toEqual(
			["index.ts", ...Array(3).fill("src/shared/imports.ts"), ...Array(2).fill("src/subagents/index.ts")].map(
				(path) => ({
					path: `packages/pi-stuff/${path}`,
					rule: "relative-import-missing-target:packages/pi-stuff/helper.js",
				}),
			),
		);
		for (const [path, source] of sources) {
			await writeFile(join(packageRoot, path), source.replaceAll("helper.js", "helper.ts"));
		}
		expect(await missingImports()).toEqual([]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
