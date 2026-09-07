import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { readVerificationPlan } from "./verification-plan-contract.ts";
import { completeTestReport, readTestReport, type TestReport } from "./verify-ci-result.ts";

export function aggregateTestReports(planPath: string, reportPaths: readonly string[], output: string): boolean {
	const plan = readVerificationPlan(planPath);
	const reports: TestReport[] = [];
	const errors: string[] = [];
	for (const path of reportPaths) {
		try {
			reports.push(readTestReport(path));
		} catch (error) {
			errors.push(String(error));
		}
	}
	const results = reports.flatMap((report) => report.results);
	const seen = new Set(results.map((result) => result.file));
	const acceptanceMatrix = plan.acceptanceMatrix ?? "full";
	const cancelled = reports.flatMap((item) => item.cancelled ?? []);
	const inProgress = reports.flatMap((item) => item.inProgress ?? []);
	const unfinished = new Set([...cancelled, ...inProgress]);
	const report = {
		profile: "offline" as const,
		status: "passed",
		acceptanceMatrix,
		scope: { files: plan.files },
		results,
		notRun: plan.files.filter((file) => !seen.has(file) && !unfinished.has(file)),
		cancelled,
		inProgress,
		errors,
		setupDurationMs: reports.reduce((sum, item) => sum + (item.setupDurationMs ?? 0), 0),
		totals: {
			nativeExecuted: results.reduce((sum, result) => sum + result.executed, 0),
			skipped: results.reduce((sum, result) => sum + result.skipped, 0),
			durationMs: results.reduce((sum, result) => sum + (result.durationMs ?? 0), 0),
		},
	};
	const complete =
		errors.length === 0 &&
		reports.length > 0 &&
		reports.every((item) => completeTestReport(item, item.scope.files, acceptanceMatrix)) &&
		completeTestReport(report, plan.files, acceptanceMatrix);
	if (!complete) report.status = results.some((result) => result.exitCode !== 0) ? "failed" : "incomplete";
	mkdirSync(dirname(resolve(output)), { recursive: true });
	writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
	console.log(
		`${report.status}: ${results.length}/${plan.files.length} file results across ${reports.length} reports`,
	);
	return complete;
}

if (import.meta.main) {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		options: { plan: { type: "string" }, output: { type: "string" } },
	});
	if (!values.plan || !values.output) throw new Error("--plan and --output are required");
	if (!aggregateTestReports(values.plan, positionals, values.output)) process.exitCode = 1;
}
