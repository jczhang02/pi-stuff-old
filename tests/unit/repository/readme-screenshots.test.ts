import { expect, test } from "bun:test";
import { auditReadmeScreenshots } from "../../../scripts/check-readme-screenshots.ts";

test("test directory guides do not require product screenshots", async () => {
	const markdown = new Map([
		["tests/README.md", "# Tests\n"],
		["docs/i18n/zh-CN/tests/README.md", "# 测试\n"],
	]);
	expect(await auditReadmeScreenshots(".", [...markdown.keys()], markdown, () => undefined)).toEqual([]);
});
