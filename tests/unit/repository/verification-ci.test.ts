import { describe, expect, test } from "bun:test";
import { aggregateCiResult, type CiAggregateInput } from "../../../scripts/verify-ci-result.js";

const plan = {
	version: 1 as const,
	profile: "offline" as const,
	base: null,
	head: null,
	mode: "selected" as const,
	reason: "selected tests",
	changedFiles: [],
	files: ["tests/unit/example.test.ts"],
};

const report = {
	profile: "offline" as const,
	scope: { files: plan.files },
	results: [{ file: "tests/unit/example.test.ts", exitCode: 0, executed: 1, skipped: 0 }],
};

const base: CiAggregateInput = {
	planResult: "success",
	testsRequired: true,
	checksResult: "success",
	testsResult: "success",
	plan,
	testsReport: report,
};

describe("CI verification aggregate", () => {
	for (const [name, input, expected] of [
		["successful required run", base, true],
		[
			"successful explicit no-tests plan",
			{ ...base, testsRequired: false, testsResult: "skipped", plan: { ...plan, mode: "none", files: [] } },
			true,
		],
		["failed plan", { ...base, planResult: "failure" }, false],
		["cancelled plan", { ...base, planResult: "cancelled" }, false],
		["missing plan result", { ...base, planResult: "missing" }, false],
		["missing plan flag", { ...base, testsRequired: undefined }, false],
		["unexpected skipped required tests", { ...base, testsResult: "skipped" }, false],
		["failed required tests", { ...base, testsResult: "failure" }, false],
		["cancelled required tests", { ...base, testsResult: "cancelled" }, false],
		["unexpected test run for no-tests plan", { ...base, testsRequired: false }, false],
		["failed checks", { ...base, checksResult: "failure" }, false],
		["missing plan artifact", { ...base, plan: null }, false],
		["tests_required disagrees with plan", { ...base, plan, testsRequired: false }, false],
		["missing required tests report", { ...base, plan, testsReport: null }, false],
		["missing structured tests report", { ...base, plan, testsReport: null }, false],
		[
			"incomplete required tests report",
			{ ...base, plan, testsReport: { profile: "offline" as const, scope: { files: [] }, results: [] } },
			false,
		],
		["complete required tests report", { ...base, plan, testsReport: report }, true],
	] satisfies readonly [string, CiAggregateInput, boolean][]) {
		test(name, () => expect(aggregateCiResult(input).ok).toBe(expected));
	}
});
