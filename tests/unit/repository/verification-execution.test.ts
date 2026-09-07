import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readVerificationPlan } from "../../../scripts/verification-plan-contract.ts";

async function fixture(): Promise<{ root: string; head: string; file: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-verification-contract-"));
	await mkdir(join(root, "tests/unit/example"), { recursive: true });
	await writeFile(
		join(root, "tests/unit/example/example.test.ts"),
		'import { test } from "bun:test"; test("ok", () => {});\n',
	);
	const run = (args: string[]) =>
		Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd: root, stdout: "ignore", stderr: "ignore" });
	run(["init", "-q"]);
	run(["config", "user.email", "test@example.invalid"]);
	run(["config", "user.name", "test"]);
	run(["add", "."]);
	run(["commit", "-qm", "initial"]);
	const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: root }).stdout.toString().trim();
	return { root, head, file: "tests/unit/example/example.test.ts" };
}

test("verification plan rejects stale, malformed, and contradictory execution scope", async () => {
	const { root, head, file } = await fixture();
	try {
		const valid = {
			version: 1,
			profile: "offline",
			base: head,
			head,
			mode: "all",
			reason: "changed",
			changedFiles: ["src.ts"],
			files: [file],
		};
		await writeFile(join(root, "plan.json"), JSON.stringify(valid));
		expect(readVerificationPlan("plan.json", root).files).toEqual([file]);
		for (const bad of [
			{ ...valid, head: null },
			{ ...valid, head: "a".repeat(40) },
			{ ...valid, files: [] },
			{ ...valid, files: ["tests/unit/example/unknown.test.ts"] },
			{ ...valid, files: ["tests/unit/example/example-live.test.ts"] },
			{ ...valid, files: ["../escape"] },
			{ ...valid, files: [file, file] },
			{ ...valid, mode: "none", base: null, files: [] },
			{ ...valid, mode: "selected" },
			{ ...valid, extra: true },
		]) {
			await writeFile(join(root, "plan.json"), JSON.stringify(bad));
			expect(() => readVerificationPlan("plan.json", root)).toThrow();
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("runner consumes exact plans and records an explicit no-tests result", async () => {
	const { root, head, file } = await fixture();
	try {
		await writeFile(
			join(root, file),
			'import { test, expect } from "bun:test"; import { writeFileSync } from "node:fs"; test("selected", () => { writeFileSync("selected.marker", process.env["PI_STUFF_ACCEPTANCE_MATRIX"] ?? "missing"); expect(1).toBe(1); });',
		);
		await writeFile(join(root, "tests/unit/example/other.test.ts"), 'throw new Error("unselected file executed");');
		const plan = {
			version: 1,
			profile: "offline",
			base: head,
			head,
			mode: "selected",
			reason: "fixture",
			changedFiles: ["README.md"],
			files: [file],
		};
		await writeFile(join(root, "plan.json"), JSON.stringify(plan));
		const run = (...args: string[]) =>
			Bun.spawnSync([process.execPath, resolve("scripts/run-isolated-tests.ts"), "--plan", "plan.json", ...args], {
				cwd: root,
			});
		expect(run("--list").exitCode).toBe(0);
		expect(await Bun.file(join(root, "selected.marker")).exists()).toBe(false);
		expect(run("--level", "unit").exitCode).toBe(1);
		expect(run("--output", "executed.json").exitCode).toBe(0);
		expect(await Bun.file(join(root, "selected.marker")).text()).toBe("full");
		const report = await Bun.file(join(root, "executed.json")).json();
		expect(report.results.map((result: { file: string }) => result.file)).toEqual([file]);
		expect(report.totals.nativeExecuted).toBe(1);
		await writeFile(join(root, "plan.json"), JSON.stringify({ ...plan, acceptanceMatrix: "representative" }));
		expect(run("--output", "representative.json").exitCode).toBe(0);
		expect(await Bun.file(join(root, "selected.marker")).text()).toBe("representative");
		expect(run("--matrix", "full").exitCode).toBe(1);
		await writeFile(join(root, "plan.json"), JSON.stringify({ ...plan, mode: "none", files: [] }));
		expect(run("--output", "none.json").exitCode).toBe(0);
		expect((await Bun.file(join(root, "none.json")).json()).status).toBe("not-run");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("verify previews without work and reports failed checks or explicit no-tests", async () => {
	const { root, head } = await fixture();
	try {
		const runner = resolve("scripts/verify.ts");
		await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { check: 'bun -e "process.exit(1)"' } }));
		const run = (...args: string[]) =>
			Bun.spawnSync([process.execPath, runner, "--base", head, ...args], { cwd: root });
		expect(run("--unknown").exitCode).toBe(1);
		expect(run("--help").exitCode).toBe(0);
		const preview = run("--list");
		expect(preview.exitCode).toBe(0);
		expect(preview.stdout.toString()).toContain("Base:");
		expect(await Bun.file(join(root, ".artifacts/verification-plan.json")).exists()).toBe(false);
		expect(run("--output", ".artifacts/failed/summary.json").exitCode).toBe(1);
		const failed = await Bun.file(join(root, ".artifacts/failed/summary.json")).json();
		expect([failed.status, failed.checks, failed.tests]).toEqual(["failed", "failed", "not-run"]);
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({
				scripts: { check: 'bun -e "process.exit(1)"', test: `bun "${resolve("scripts/run-isolated-tests.ts")}"` },
			}),
		);
		expect(run("--keep-going", "--output", ".artifacts/diagnostic/summary.json").exitCode).toBe(1);
		const diagnostic = await Bun.file(join(root, ".artifacts/diagnostic/summary.json")).json();
		expect([diagnostic.status, diagnostic.checks, diagnostic.tests]).toEqual(["failed", "failed", "passed"]);
		await rm(join(root, ".artifacts"), { recursive: true });
		await writeFile(join(root, "package.json"), JSON.stringify({ scripts: { check: 'bun -e "process.exit(0)"' } }));
		Bun.spawnSync(["git", "add", "."], { cwd: root });
		Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "commands"], { cwd: root });
		await writeFile(join(root, "README.md"), "metadata change");
		const none = Bun.spawnSync(
			[process.execPath, runner, "--base", "HEAD", "--output", ".artifacts/none/summary.json"],
			{ cwd: root },
		);
		expect(none.exitCode).toBe(0);
		const report = await Bun.file(join(root, ".artifacts/none/summary.json")).json();
		expect([report.status, report.checks, report.tests]).toEqual(["passed", "passed", "not-run"]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
