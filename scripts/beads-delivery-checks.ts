import { type Static, Type } from "typebox";
import { Check } from "typebox/value";

const RUN = Type.Object({
	id: Type.Integer({ minimum: 1 }),
	path: Type.String(),
	head_sha: Type.String(),
	event: Type.String(),
	status: Type.String(),
	conclusion: Type.Union([Type.String(), Type.Null()]),
	run_number: Type.Integer({ minimum: 1 }),
	run_attempt: Type.Integer({ minimum: 1 }),
});
const JOB = Type.Object({
	name: Type.String(),
	status: Type.String(),
	conclusion: Type.Union([Type.String(), Type.Null()]),
});

function verifiedTestJobs(records: Static<typeof JOB>[], sha: string): string {
	const error = `CI verification failed for ${sha}: Tests is missing, incomplete, or unsuccessful`;
	const legacy = records.filter((job) => job.name === "Tests");
	const shards = records
		.flatMap((job) => {
			const match = /^Tests \(shard ([1-9]\d*)\/([1-9]\d*)\)$/u.exec(job.name);
			if (!match && job.name.startsWith("Tests (shard")) throw new Error(error);
			return match ? [{ ...job, index: Number(match[1]), total: Number(match[2]) }] : [];
		})
		.sort((left, right) => left.index - right.index);
	const single = legacy[0];
	if (single) {
		if (
			legacy.length !== 1 ||
			shards.length ||
			single.status !== "completed" ||
			!["success", "skipped"].includes(single.conclusion ?? "")
		)
			throw new Error(error);
		return single.conclusion === "skipped" ? "Tests not run (verified no-tests plan)" : "Tests passed";
	}
	const total = shards[0]?.total;
	if (
		!total ||
		!Number.isSafeInteger(total) ||
		shards.length !== total ||
		shards.some(
			(job, index) =>
				job.index !== index + 1 ||
				job.total !== total ||
				job.status !== "completed" ||
				job.conclusion !== "success",
		)
	)
		throw new Error(error);
	return `${total} Tests shard(s) passed`;
}

// The Plan job owns scope selection;
// publication verifies the current Plan/Checks/Tests/Verify result rather than reclassifying paths.
export function verifyDeliveryChecks(
	repository: string,
	sha: string,
	event: "push" | "pull_request",
	run: (command: readonly string[]) => string,
): string[] {
	const response: unknown = JSON.parse(
		run([
			"gh",
			"api",
			`repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`,
			"--paginate",
			"--slurp",
		]),
	);
	if (!Check(Type.Array(Type.Object({ workflow_runs: Type.Array(RUN) })), response))
		throw new Error(`Invalid CI workflow runs for ${sha}`);
	const latest = response
		.flatMap((page) => page.workflow_runs)
		.filter(
			(item) =>
				item.path === ".github/workflows/ci.yml" &&
				item.head_sha === sha &&
				(item.event === event || item.event === "workflow_dispatch"),
		)
		.sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt || b.id - a.id)[0];
	if (!latest) throw new Error(`CI verification failed for ${sha}: no matching workflow run`);
	if (latest.status !== "completed" || latest.conclusion !== "success")
		throw new Error(`CI verification failed for ${sha}: latest workflow run is incomplete or unsuccessful`);
	const jobs: unknown = JSON.parse(
		run([
			"gh",
			"api",
			`repos/${repository}/actions/runs/${latest.id}/attempts/${latest.run_attempt}/jobs?per_page=100`,
			"--paginate",
			"--slurp",
		]),
	);
	if (!Check(Type.Array(Type.Object({ jobs: Type.Array(JOB) })), jobs))
		throw new Error(`Invalid CI jobs for run ${latest.id}`);
	const required = ["Plan", "Checks", "Verify"];
	const records = jobs.flatMap((page) => page.jobs);
	for (const name of required) {
		const matches = records.filter((job) => job.name === name);
		const job = matches[0];
		if (matches.length !== 1 || job?.status !== "completed" || job?.conclusion !== "success")
			throw new Error(`CI verification failed for ${sha}: ${name} is missing, incomplete, or unsuccessful`);
	}
	const testStatus = verifiedTestJobs(records, sha);
	return [
		`[Actions run](https://github.com/${repository}/actions/runs/${latest.id}/attempts/${latest.run_attempt}): Plan, Checks, and Verify passed; ${testStatus} for commit ${sha}.`,
	];
}
