import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { requirementsForTest } from "./test-environment.ts";
import { buildVerificationPlan } from "./verification-plan.ts";

function parseVerificationArguments(args: string[]) {
	const parsed = parseArgs({
		args,
		allowPositionals: false,
		options: {
			base: { type: "string" },
			output: { type: "string" },
			list: { type: "boolean" },
			"keep-going": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
	if (parsed.values.base === "" || parsed.values.output === "")
		throw new Error("--base and --output require non-empty values");
	return { ...parsed.values, keepGoing: parsed.values["keep-going"] === true };
}

function localEnvironment(base: string | undefined): NodeJS.ProcessEnv {
	const environment = { ...process.env };
	for (const key of ["CI_BASE_SHA", "CI_HEAD_SHA", "GITHUB_EVENT_NAME", "VERIFICATION_PLAN_CI"])
		delete environment[key];
	if (base) environment["VERIFY_BASE"] = base;
	return environment;
}

function reportPath(output: string | undefined): string {
	if (output) return resolve(output);
	const stamp = new Date().toISOString().replaceAll(":", "-");
	return resolve(`.artifacts/verify/${stamp}-${process.pid}/summary.json`);
}

function main(): void {
	const values = parseVerificationArguments(process.argv.slice(2));
	if (values.help) {
		console.log("Usage: bun run verify [--base <ref>] [--output <report.json>] [--list] [--keep-going]");
		return;
	}
	const root = process.cwd();
	const environment = localEnvironment(values.base);
	const plan = buildVerificationPlan(root, environment);
	console.log(`Base: ${plan.base ?? "unresolved"}`);
	console.log(`Head: ${plan.head ?? "unresolved"}`);
	console.log(`Reason: ${plan.reason}`);
	console.log(`Mode: ${plan.mode}; Acceptance matrix: ${plan.acceptanceMatrix ?? "full"}`);
	if (values.list) {
		for (const file of plan.files) console.log(`${file} [${requirementsForTest(file).join(", ")}]`);
		return;
	}
	const output = reportPath(values.output);
	console.log(`Selected ${plan.files.length} offline test files. Summary: ${output}`);
	const planFile = resolve(dirname(output), "verification-plan.json");
	mkdirSync(dirname(output), { recursive: true });
	writeFileSync(planFile, `${JSON.stringify(plan, null, 2)}\n`);
	const started = performance.now();
	const check = spawnSync(process.execPath, ["run", "check"], { stdio: "inherit", env: environment });
	const checks = check.status === 0 ? "passed" : "failed";
	if (checks === "failed" && !values.keepGoing) {
		writeFileSync(
			output,
			`${JSON.stringify({ status: "failed", checks: "failed", tests: "not-run", plan, durationMs: performance.now() - started, evidence: { plan: planFile, summary: output } }, null, 2)}\n`,
		);
		process.exitCode = check.status ?? 1;
		return;
	}
	if (plan.mode === "none") {
		writeFileSync(
			output,
			`${JSON.stringify({ status: checks, checks, tests: "not-run", durationMs: performance.now() - started, plan, evidence: { plan: planFile, summary: output } }, null, 2)}\n`,
		);
		if (checks === "failed") process.exitCode = check.status ?? 1;
		return;
	}
	const testReport = resolve(dirname(output), "tests.json");
	const tests = spawnSync(
		process.execPath,
		["run", "test", "--plan", planFile, "--output", testReport, ...(values.keepGoing ? ["--keep-going"] : [])],
		{
			stdio: "inherit",
			env: environment,
		},
	);
	writeFileSync(
		output,
		`${JSON.stringify({ status: checks === "passed" && tests.status === 0 ? "passed" : "failed", checks, tests: tests.status === 0 ? "passed" : "failed", plan, durationMs: performance.now() - started, evidence: { plan: planFile, tests: testReport, summary: output } }, null, 2)}\n`,
	);
	if (tests.status !== 0 || checks === "failed") process.exitCode = tests.status || check.status || 1;
}

if (import.meta.main) main();
