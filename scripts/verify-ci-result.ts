import { existsSync, readFileSync } from "node:fs";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { VerificationPlan } from "./verification-plan.ts";
import { readVerificationPlan } from "./verification-plan-contract.ts";

export type CiJobResult = "success" | "failure" | "cancelled" | "skipped" | "missing";

const TEST_REPORT = Type.Object({
	profile: Type.Literal("offline"),
	status: Type.Optional(Type.String()),
	acceptanceMatrix: Type.Optional(Type.Union([Type.Literal("full"), Type.Literal("representative")])),
	setupDurationMs: Type.Optional(Type.Number({ minimum: 0 })),
	scope: Type.Object({ files: Type.Array(Type.String()) }),
	notRun: Type.Optional(Type.Array(Type.String())),
	cancelled: Type.Optional(Type.Array(Type.String())),
	inProgress: Type.Optional(Type.Array(Type.String())),
	results: Type.Array(
		Type.Object({
			file: Type.String(),
			exitCode: Type.Integer(),
			durationMs: Type.Optional(Type.Number({ minimum: 0 })),
			executed: Type.Integer({ minimum: 0 }),
			skipped: Type.Integer({ minimum: 0 }),
		}),
	),
});
export type TestReport = Static<typeof TEST_REPORT>;

export function readTestReport(path: string): TestReport {
	const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!Value.Check(TEST_REPORT, raw)) throw new Error(`Invalid Tests report: ${path}`);
	return raw;
}

export function completeTestReport(report: TestReport, files: string[], matrix = "full"): boolean {
	return (
		(report.status === undefined || report.status === "passed") &&
		(report.acceptanceMatrix ?? "full") === matrix &&
		(report.notRun?.length ?? 0) === 0 &&
		(report.cancelled?.length ?? 0) === 0 &&
		(report.inProgress?.length ?? 0) === 0 &&
		sameFiles(
			report.results.map((result) => result.file),
			files,
		) &&
		sameFiles(report.scope.files, files) &&
		report.results.every((result) => result.exitCode === 0 && result.executed > 0)
	);
}

export interface CiAggregateInput {
	planResult: CiJobResult;
	testsRequired: boolean | undefined;
	checksResult: CiJobResult;
	testsResult: CiJobResult;
	plan: VerificationPlan | null;
	testsReport: Static<typeof TEST_REPORT> | null;
}

export function aggregateCiResult(input: CiAggregateInput) {
	if (input.planResult !== "success") return { ok: false, reason: `Plan result is ${input.planResult}` };
	if (!input.plan) return { ok: false, reason: "Plan artifact is missing" };
	if (input.testsRequired !== (input.plan.mode !== "none"))
		return { ok: false, reason: "tests_required disagrees with the plan" };
	if (input.checksResult !== "success") return { ok: false, reason: `Checks result is ${input.checksResult}` };
	if (!input.testsRequired)
		return {
			ok: input.testsResult === "skipped",
			reason: `Plan requires no Tests; Tests result is ${input.testsResult}`,
		};
	if (input.testsResult !== "success") return { ok: false, reason: `Required Tests result is ${input.testsResult}` };
	const report = input.testsReport;
	if (!report) return { ok: false, reason: "Tests report artifact is missing" };
	const complete = completeTestReport(report, input.plan.files, input.plan.acceptanceMatrix ?? "full");
	return {
		ok: complete,
		reason: complete ? "Required Tests succeeded" : "Tests report is incomplete or contains failures",
	};
}

function sameFiles(left: string[], right: string[]): boolean {
	const expected = [...right].sort();
	return (
		left.length === right.length &&
		new Set(left).size === left.length &&
		[...left].sort().every((file, index) => file === expected[index])
	);
}

function parseResult(value: string | undefined, name: string): CiJobResult {
	if (value === "success" || value === "failure" || value === "cancelled" || value === "skipped") return value;
	if (value === undefined || value === "") return "missing";
	throw new Error(`${name} has unsupported result: ${value}`);
}

function parseRequired(value: string | undefined): boolean | undefined {
	if (value === "true") return true;
	if (value === "false") return false;
	return undefined;
}

function main(): void {
	const planPath = process.env["CI_PLAN_PATH"];
	const artifactPresent = planPath ? existsSync(planPath) : false;
	const required = parseRequired(process.env["CI_TESTS_REQUIRED"]);
	let plan: VerificationPlan | null = null;
	if (artifactPresent && planPath) plan = readVerificationPlan(planPath, process.cwd());
	const reportPath = process.env["CI_TEST_REPORT_PATH"];
	const reportPresent = reportPath ? existsSync(reportPath) : false;
	const report = reportPresent && reportPath ? readTestReport(reportPath) : null;
	const outcome = aggregateCiResult({
		planResult: parseResult(process.env["CI_PLAN_RESULT"], "Plan"),
		testsRequired: required,
		checksResult: parseResult(process.env["CI_CHECKS_RESULT"], "Checks"),
		testsResult: parseResult(process.env["CI_TESTS_RESULT"], "Tests"),
		plan,
		testsReport: report,
	});
	console.log(outcome.reason);
	if (!outcome.ok) process.exitCode = 1;
}

if (import.meta.main) main();
