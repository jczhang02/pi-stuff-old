import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	parseUpstreamRecord,
	sanitizeUpstreamDiff,
	stripModelInvocationAdaptation,
	validateArchiveEntries,
	verifySubresourceIntegrity,
} from "../../../scripts/review-ponytail-upstream.js";

describe("Ponytail upstream review", () => {
	test("parses the pinned package and integrity record", () => {
		expect(
			parseUpstreamRecord(
				["- Upstream package: `@dietrichgebert/ponytail@4.9.0`", "- npm integrity: `sha512-example`"].join("\n"),
			),
		).toEqual({ integrity: "sha512-example", version: "4.9.0" });
	});

	test("permits exactly the reviewed local frontmatter adaptation", () => {
		expect(stripModelInvocationAdaptation("---\ndisable-model-invocation: true\nname: ponytail\n---\nbody\n")).toBe(
			"---\nname: ponytail\n---\nbody\n",
		);
		expect(() => stripModelInvocationAdaptation("---\nname: ponytail\n---\n")).toThrow("expected one");
	});

	test("verifies registry integrity before extraction", () => {
		const bytes = new TextEncoder().encode("reviewed ponytail package");
		const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
		expect(() => verifySubresourceIntegrity(bytes, integrity)).not.toThrow();
		expect(() => verifySubresourceIntegrity(bytes, "sha512-invalid")).toThrow("does not match");
	});

	test("rejects traversal and link entries", () => {
		expect(() =>
			validateArchiveEntries(
				["package/", "package/skills/ponytail/SKILL.md"],
				["drwxr-xr-x package/", "-rw-r--r-- package/SKILL.md"],
			),
		).not.toThrow();
		expect(() => validateArchiveEntries(["package/../escape"], ["-rw-r--r-- package/../escape"])).toThrow(
			"unsafe path",
		);
		expect(() => validateArchiveEntries(["package/link"], ["lrwxrwxrwx package/link -> /tmp"])).toThrow(
			"non-file entry",
		);
	});

	test("removes temporary absolute paths from review output", () => {
		const diff =
			"diff --git a/tmp/base/src/index.ts b/tmp/next/src/index.ts\n--- /tmp/base/src/index.ts\n+++ /tmp/next/src/index.ts\n";
		const sanitized = sanitizeUpstreamDiff(diff, "/tmp/base", "/tmp/next");
		expect(sanitized).toContain("a/baseline/src/index.ts");
		expect(sanitized).toContain("b/candidate/src/index.ts");
		expect(sanitized).not.toContain("/tmp/");
	});
});
