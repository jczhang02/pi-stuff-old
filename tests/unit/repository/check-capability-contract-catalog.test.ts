import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditCapabilityContractCatalog } from "../../../scripts/check-capability-contract-catalog.ts";

const roots: string[] = [];

async function write(root: string, path: string, content: string): Promise<void> {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), content);
}

async function fixture(row: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-contracts-"));
	roots.push(root);
	await write(root, "packages/pi-stuff/suite.json", '{"capabilities":["demo"]}\n');
	await write(root, "packages/pi-stuff/src/demo/README.md", "# Demo\n");
	await write(root, "tests/demo.test.ts", "export {};\n");
	await write(
		root,
		"docs/capability-contract-catalog.md",
		`# Catalog\n\n| ID | Capability | Behavior authority | Public seam | Scenarios | Evidence profile | Evidence | Status |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n${row}\n`,
	);
	return root;
}

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("accepts a structurally complete pending contract", async () => {
	const root = await fixture(
		"| `demo.surface` | `demo` | [README](../packages/pi-stuff/src/demo/README.md) | Host command | normal: opens; failure: reports errors; recovery: retries | `real-host` | [test](../tests/demo.test.ts) | `pending` |",
	);
	expect(await auditCapabilityContractCatalog(root)).toEqual([]);
});

test("requires a report link for a completed status", async () => {
	const root = await fixture(
		"| `demo.surface` | `demo` | [README](../packages/pi-stuff/src/demo/README.md) | Host command | normal: opens | `real-host` | [test](../tests/demo.test.ts) | `pass` |",
	);
	expect(await auditCapabilityContractCatalog(root)).toContainEqual({
		path: "docs/capability-contract-catalog.md",
		rule: "status:demo.surface",
	});
});

test("requires a date in a completed status report path", async () => {
	const root = await fixture(
		"| `demo.surface` | `demo` | [README](../packages/pi-stuff/src/demo/README.md) | Host command | normal: opens | `real-host` | [test](../tests/demo.test.ts) | [pass](reports/acceptance.md) |",
	);
	await write(
		root,
		"docs/reports/acceptance.md",
		"| Contract ID | Scenario results | Evidence |\n| --- | --- | --- |\n| `demo.surface` | `normal=pass` | evidence |\n",
	);
	expect(await auditCapabilityContractCatalog(root)).toContainEqual({
		path: "docs/capability-contract-catalog.md",
		rule: "status-report:demo.surface",
	});
});

test("matches a completed status to its report matrix", async () => {
	const root = await fixture(
		"| `demo.surface` | `demo` | [README](../packages/pi-stuff/src/demo/README.md) | Host command | normal: opens | `real-host` | [test](../tests/demo.test.ts) | [blocked](reports/acceptance-2026-09-02.md) |",
	);
	await write(
		root,
		"docs/reports/acceptance-2026-09-02.md",
		"| Contract ID | Scenario results | Evidence |\n| --- | --- | --- |\n| `demo.surface` | `normal=blocked` | evidence |\n",
	);
	expect(await auditCapabilityContractCatalog(root)).toEqual([]);
});

test("rejects ownership, scenario, and evidence drift", async () => {
	const root = await fixture(
		"| `other.surface` | `demo` | [README](../packages/pi-stuff/src/demo/README.md) | Host command | failure: breaks; failure: repeats | `real-host` | prose only | `pending` |",
	);
	const findings = await auditCapabilityContractCatalog(root);
	expect(findings.map((finding) => finding.rule)).toEqual(
		expect.arrayContaining([
			"id-owner:other.surface:demo",
			"scenario:other.surface:failure",
			"scenario-normal:other.surface",
			"evidence:other.surface",
		]),
	);
});

test("rejects a missing repository evidence link", async () => {
	const root = await fixture(
		"| `demo.surface` | `demo` | [README](../packages/pi-stuff/src/demo/README.md) | Host command | normal: opens | `real-host` | [missing](../docs/missing.md) | `pending` |",
	);
	expect(await auditCapabilityContractCatalog(root)).toContainEqual({
		path: "docs/capability-contract-catalog.md",
		rule: "evidence:demo.surface",
	});
});

test("rejects any non-repository evidence link beside valid evidence", async () => {
	const root = await fixture(
		"| `demo.surface` | `demo` | [README](../packages/pi-stuff/src/demo/README.md) | Host command | normal: opens | `real-host` | [test](../tests/demo.test.ts); [external](https://example.com) | `pending` |",
	);
	expect(await auditCapabilityContractCatalog(root)).toContainEqual({
		path: "docs/capability-contract-catalog.md",
		rule: "evidence:demo.surface",
	});
});
