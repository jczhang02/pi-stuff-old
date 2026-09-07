import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditRepositoryFiles } from "../../../scripts/check-repository-safety.ts";

test("document checks retain links, mirrors and credential checks without auditing code or dependencies", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-doc-check-"));
	const put = async (path: string, value: string) => {
		await mkdir(dirname(join(root, path)), { recursive: true });
		await writeFile(join(root, path), value);
	};
	try {
		expect(Bun.spawnSync(["git", "init", "-q", root]).exitCode).toBe(0);
		const source = "# Wiki\n";
		const hash = createHash("sha256").update(source).digest("hex");
		await put("docs/README.md", source);
		await put(
			"docs/i18n/zh-CN/docs/README.md",
			`<!-- translation-source: docs/README.md; translation-source-sha256: ${hash} -->\n\n# 文档\n`,
		);
		await put("package.json", "invalid JSON must not be read by document checks");
		await put("scripts/example.ts", "not valid TypeScript");
		expect(await auditRepositoryFiles(root, true)).toEqual([
			{ path: "docs/README.md", rule: "readme-screenshot-missing" },
			{ path: "docs/README.md", rule: "readme-screenshot-count:0/1" },
		]);
		await put("docs/README.md", "# Wiki\n[missing](missing.md)\n");
		const findings = await auditRepositoryFiles(root, true);
		expect(findings).toContainEqual({ path: "docs/README.md", rule: "markdown-link-target-missing:docs/missing.md" });
		expect(findings).toContainEqual({ path: "docs/i18n/zh-CN/docs/README.md", rule: "translation-stale" });
		await put("docs/README.md", `token: ghp_${"A".repeat(36)}`);
		expect(await auditRepositoryFiles(root, true)).toContainEqual({
			path: "docs/README.md",
			rule: "credential-pattern",
		});
		await put("docs/reports/evidence.json", JSON.stringify({ token: `ghp_${"A".repeat(36)}` }));
		expect(await auditRepositoryFiles(root, true)).toContainEqual({
			path: "docs/reports/evidence.json",
			rule: "credential-pattern",
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
