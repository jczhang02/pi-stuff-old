import { expect, test } from "bun:test";
import { verifyDeliveryChecks } from "../../../scripts/beads-delivery-checks.ts";

const SHA = "a".repeat(40);

function fixture() {
	const current = {
		id: 20,
		path: ".github/workflows/ci.yml",
		head_sha: SHA,
		event: "pull_request",
		status: "completed",
		conclusion: "success",
		run_number: 10,
		run_attempt: 2,
	};
	const runs = [current];
	const jobs = [
		{ name: "Plan", status: "completed", conclusion: "success" },
		{ name: "Checks", status: "completed", conclusion: "success" },
		{ name: "Tests", status: "completed", conclusion: "success" },
		{ name: "Verify", status: "completed", conclusion: "success" },
	];
	const calls: string[][] = [];
	const run = (command: readonly string[]): string => {
		calls.push([...command]);
		if (command[2]?.includes("actions/workflows/ci.yml/runs"))
			return JSON.stringify([{ workflow_runs: runs.slice(0, 1) }, { workflow_runs: runs.slice(1) }]);
		if (command[2]?.includes("actions/runs/20/attempts/2/jobs"))
			return JSON.stringify([{ jobs: jobs.slice(0, 1) }, { jobs: jobs.slice(1) }]);
		throw new Error(`Unexpected request: ${command.join(" ")}`);
	};
	return {
		current,
		runs,
		jobs,
		calls,
		check: (event: "push" | "pull_request" = "pull_request") =>
			verifyDeliveryChecks("example/suite", SHA, event, run),
	};
}

test("verification binds the workflow, commit, latest run and attempt across pages", () => {
	const f = fixture();
	f.runs.push({ ...f.current, id: 19, run_number: 9, conclusion: "failure" });
	expect(f.check().join(" ")).toContain("/actions/runs/20/attempts/2");
	expect(f.calls.every((call) => call.includes("--paginate") && call.includes("--slurp"))).toBeTrue();
	f.current.conclusion = "failure";
	f.runs[1] = { ...f.current, id: 19, run_number: 9, conclusion: "success" };
	expect(() => f.check()).toThrow("incomplete or unsuccessful");
});

test("missing or unrelated workflow evidence never certifies delivery", () => {
	for (const mode of ["absent", "path", "sha", "event", "queued", "unknown"] as const) {
		const f = fixture();
		if (mode === "absent") f.runs.length = 0;
		if (mode === "path") f.current.path = ".github/workflows/pretend-ci.yml";
		if (mode === "sha") f.current.head_sha = "b".repeat(40);
		if (mode === "event") f.current.event = "push";
		if (mode === "queued") f.current.status = "queued";
		if (mode === "unknown") f.current.conclusion = "unknown";
		expect(() => f.check()).toThrow("CI verification failed");
	}
});

test("each required job must have one completed successful result", () => {
	for (const name of ["Plan", "Checks", "Tests", "Verify"]) {
		for (const mode of ["missing", "duplicate", "failure", "skipped", "running"]) {
			const f = fixture();
			const index = f.jobs.findIndex((job) => job.name === name);
			if (mode === "missing") f.jobs.splice(index, 1);
			else if (mode === "duplicate") f.jobs.push({ name, status: "completed", conclusion: "success" });
			else f.jobs[index] = { name, status: mode === "running" ? "in_progress" : "completed", conclusion: mode };
			if (name === "Tests" && mode === "skipped") expect(() => f.check()).not.toThrow();
			else expect(() => f.check()).toThrow(`${name} is missing, incomplete, or unsuccessful`);
		}
	}
});

test("all delivery modes require the current Plan, Checks, Tests, and Verify jobs", () => {
	const f = fixture();
	expect(f.check().join(" ")).toContain("Plan, Checks, and Verify passed; Tests passed");
	const tests = f.jobs.find((job) => job.name === "Tests");
	if (!tests) throw new Error("missing Tests fixture");
	tests.conclusion = "skipped";
	expect(f.check().join(" ")).toContain("Tests not run (verified no-tests plan)");
	const verify = f.jobs.find((job) => job.name === "Verify");
	if (!verify) throw new Error("missing Verify fixture");
	verify.conclusion = "failure";
	expect(() => f.check()).toThrow("Verify");
});

test("delivery requires every unique shard advertised by the CI job names", () => {
	for (const mode of ["complete", "missing", "duplicate", "inconsistent", "cancelled", "legacy-mixed"] as const) {
		const f = fixture();
		f.jobs.splice(
			f.jobs.findIndex((job) => job.name === "Tests"),
			1,
		);
		f.jobs.push({ name: "Tests (shard 1/2)", status: "completed", conclusion: "success" });
		if (mode !== "missing")
			f.jobs.push({
				name:
					mode === "duplicate"
						? "Tests (shard 1/2)"
						: mode === "inconsistent"
							? "Tests (shard 2/3)"
							: "Tests (shard 2/2)",
				status: "completed",
				conclusion: mode === "cancelled" ? "cancelled" : "success",
			});
		if (mode === "legacy-mixed") f.jobs.push({ name: "Tests", status: "completed", conclusion: "success" });
		if (mode === "complete") expect(f.check().join(" ")).toContain("2 Tests shard(s) passed");
		else expect(() => f.check()).toThrow("Tests is missing, incomplete, or unsuccessful");
	}
});

test("malformed shard jobs cannot be ignored beside otherwise successful evidence", () => {
	for (const name of ["Tests (shard 1/2 extra)", "Tests (shard 0/2)", "Tests (shard 1/0)"]) {
		const f = fixture();
		f.jobs.push({ name, status: "completed", conclusion: "success" });
		expect(() => f.check()).toThrow("Tests is missing, incomplete, or unsuccessful");
	}
});
