import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const runner = resolve(import.meta.dirname, "../../../scripts/run-isolated-tests.ts");

test("runner combines repeated dimensions with OR within a dimension and AND across dimensions", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-isolated-runner-"));
	try {
		const fixtures: Array<[string, string, string]> = [
			["unit", "alpha", "alpha case"],
			["unit", "beta", "beta case"],
			["acceptance", "alpha", "acceptance case"],
		];
		for (const [level, capability, name] of fixtures) {
			const directory = join(cwd, "tests", level, capability);
			await mkdir(directory, { recursive: true });
			await writeFile(
				join(directory, `${capability}.test.ts`),
				`import { test } from "bun:test"; test(${JSON.stringify(name)}, () => {});\n`,
			);
		}
		const result = Bun.spawnSync(
			[process.execPath, runner, "--list", "--level", "unit", "--level", "acceptance", "--capability", "alpha"],
			{ cwd },
		);
		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("tests/unit/alpha/alpha.test.ts");
		expect(result.stdout.toString()).toContain("tests/acceptance/alpha/alpha.test.ts");
		expect(result.stdout.toString()).not.toContain("tests/unit/beta/beta.test.ts");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("runner rejects an explicit selector that matches no test", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-isolated-runner-"));
	try {
		await mkdir(join(cwd, "tests/unit/example"), { recursive: true });
		await writeFile(
			join(cwd, "tests/unit/example/example.test.ts"),
			'import { test } from "bun:test"; test("present", () => {});\n',
		);
		const result = Bun.spawnSync([process.execPath, runner, "--name", "missing"], { cwd });
		expect(result.exitCode).not.toBe(0);
		expect(result.stderr.toString()).toContain("No tests matched");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("native name selection executes dynamic cases and reports skipped candidates", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-native-selection-"));
	try {
		await mkdir(join(cwd, "tests/unit/example"), { recursive: true });
		await writeFile(
			join(cwd, "tests/unit/example/example.test.ts"),
			'import {describe,test,expect} from "bun:test"; describe("computed",()=>{ for(const n of [1,2]) test("case " + n,()=>expect(n).toBe(1)); });',
		);
		const report = join(cwd, "report.json");
		const result = Bun.spawnSync([process.execPath, runner, "--name", "computed case 1", "--output", report], {
			cwd,
		});
		expect(result.exitCode).toBe(0);
		expect(JSON.parse(await readFile(report, "utf8")).totals).toMatchObject({ nativeExecuted: 1, skipped: 1 });
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("missing execution evidence stops remaining files unless complete diagnostics are requested", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-fail-fast-"));
	try {
		await mkdir(join(cwd, "tests/unit/example"), { recursive: true });
		await writeFile(join(cwd, "tests/unit/example/a.test.ts"), "process.exit(0);");
		await writeFile(
			join(cwd, "tests/unit/example/b.test.ts"),
			'import {test} from "bun:test"; test("later", () => Bun.write("later.marker", "ran"));',
		);
		const output = join(cwd, "report.json");
		const stopped = Bun.spawnSync([process.execPath, runner, "--output", output], { cwd });
		expect(stopped.exitCode).toBe(1);
		const report = JSON.parse(await readFile(output, "utf8"));
		expect(report.status).toBe("failed");
		expect(report.notRun).toEqual(["tests/unit/example/b.test.ts"]);
		expect(await Bun.file(join(cwd, "later.marker")).exists()).toBe(false);
		const diagnostic = Bun.spawnSync([process.execPath, runner, "--keep-going", "--output", output], { cwd });
		expect(diagnostic.exitCode).toBe(1);
		const complete = JSON.parse(await readFile(output, "utf8"));
		expect(complete.status).toBe("failed");
		expect(complete.notRun).toEqual([]);
		expect(complete.results).toHaveLength(2);
		expect(await Bun.file(join(cwd, "later.marker")).text()).toBe("ran");
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
