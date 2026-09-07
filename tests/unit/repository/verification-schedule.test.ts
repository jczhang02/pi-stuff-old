import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildVerificationPlan } from "../../../scripts/verification-plan.ts";
import { previousFullVerification } from "../../../scripts/verification-schedule.ts";

test("nightly reuse requires a successful same-main revision and a valid full plan artifact", () => {
	const root = resolve(import.meta.dirname, "../../..");
	const plan = buildVerificationPlan(root, { VERIFICATION_PLAN_CI: "1", GITHUB_EVENT_NAME: "workflow_dispatch" });
	if (!plan.head) throw new Error("A committed fixture revision is required");
	const head = plan.head;
	let full = true;
	const invoke = (args: string[]): string => {
		if (args[0] === "api")
			return JSON.stringify(
				[22, 11].map((id) => ({ id, run_attempt: 1, head_sha: head, head_branch: "main", conclusion: "success" })),
			);
		const directory = args.at(-1);
		if (!directory) throw new Error("Missing artifact destination");
		const selected = { ...plan, mode: "selected", files: plan.files.slice(0, 1) };
		writeFileSync(
			join(directory, "verification-plan.json"),
			JSON.stringify(args[2] === "11" && full ? plan : selected),
		);
		return "";
	};
	expect(previousFullVerification("example/repo", head, invoke, root)).toBe(11);
	full = false;
	expect(previousFullVerification("example/repo", head, invoke, root)).toBeUndefined();
	expect(previousFullVerification("example/repo", head, () => "[]", root)).toBeUndefined();
});
