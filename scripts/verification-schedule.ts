import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { readVerificationPlan } from "./verification-plan-contract.ts";

const RUNS = Type.Array(
	Type.Object({
		id: Type.Integer({ minimum: 1 }),
		run_attempt: Type.Integer({ minimum: 1 }),
		head_sha: Type.String(),
		head_branch: Type.String(),
		conclusion: Type.String(),
	}),
);

function github(args: string[]): string {
	return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export function previousFullVerification(
	repository: string,
	head: string,
	invoke = github,
	root = process.cwd(),
): number | undefined {
	if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !/^[0-9a-f]{40}$/u.test(head))
		throw new Error("Invalid repository or revision");
	const runs = Value.Parse(
		RUNS,
		JSON.parse(
			invoke([
				"api",
				`repos/${repository}/actions/workflows/ci.yml/runs?branch=main&head_sha=${head}&status=success&per_page=100`,
				"--jq",
				".workflow_runs",
			]),
		),
	);
	for (const run of runs) {
		if (run.head_sha !== head || run.head_branch !== "main" || run.conclusion !== "success") continue;
		const directory = mkdtempSync(join(tmpdir(), "pi-stuff-full-evidence-"));
		try {
			invoke([
				"run",
				"download",
				String(run.id),
				"--repo",
				repository,
				"--name",
				`verification-plan-${run.id}-${run.run_attempt}`,
				"--dir",
				directory,
			]);
			const plan = readVerificationPlan(join(directory, "verification-plan.json"), root);
			if (plan.head === head && plan.mode === "all" && (plan.acceptanceMatrix ?? "full") === "full") return run.id;
		} catch {
			// Missing, expired, or invalid evidence cannot justify omitting a full run.
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}
	return undefined;
}

if (import.meta.main) {
	const head = process.env["GITHUB_SHA"] ?? "";
	let previous: number | undefined;
	try {
		previous = previousFullVerification(process.env["GITHUB_REPOSITORY"] ?? "", head);
	} catch (error) {
		console.error(`Full verification required: ${String(error)}`);
	}
	if (previous && process.env["GITHUB_ENV"]) {
		appendFileSync(process.env["GITHUB_ENV"], `CI_PREVIOUS_FULL_SHA=${head}\nCI_PREVIOUS_FULL_RUN=${previous}\n`);
	}
	console.log(
		previous
			? `Reuse full verification ${previous} for ${head}`
			: "No reusable full verification; run the complete offline inventory",
	);
}
