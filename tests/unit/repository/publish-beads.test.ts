import { expect, test } from "bun:test";
import { type GithubMutation, publishBeads } from "../../../scripts/publish-beads.ts";

const SHA = "a".repeat(40);
const URL = "https://github.com/example/suite";
type WorkflowRunFixture = {
	id: number;
	html_url: string;
	path: string;
	head_sha: string;
	event: string;
	status: string;
	conclusion: string | null;
	run_number: number;
	run_attempt: number;
};

function records() {
	const bead = {
		id: "ps-root",
		title: "Deliver the change",
		status: "closed",
		close_reason: "Accepted after verification.",
		external_ref: `${URL}/issues/10`,
		metadata: {
			github_delivery: {
				kind: "code",
				summary: "Implemented the change.",
				validation: "Focused tests passed.",
				commits: [SHA],
				pull_request: 12,
			},
		},
		dependencies: [{ id: "ps-related", dependency_type: "discovered-from" }],
	};
	const related = { id: "ps-related", title: "Earlier work", status: "open", external_ref: `${URL}/issues/9` };
	const pull = {
		html_url: `${URL}/pull/12`,
		state: "open",
		draft: false,
		merged: false,
		body: `Refs ${URL}/issues/10`,
		head: { sha: SHA },
		base: { repo: { full_name: "example/suite" } },
	};
	const human = {
		id: 1,
		body: "Human context stays intact.",
		html_url: `${URL}/issues/10#issuecomment-1`,
		user: { login: "human" },
	};
	const workflowRun: WorkflowRunFixture = {
		id: 20,
		html_url: `${URL}/actions/runs/20`,
		path: ".github/workflows/ci.yml",
		head_sha: SHA,
		event: "pull_request",
		status: "completed",
		conclusion: "success",
		run_number: 1,
		run_attempt: 1,
	};
	const jobs = [
		{ name: "Plan", status: "completed", conclusion: "success" },
		{ name: "Checks", status: "completed", conclusion: "success" },
		{ name: "Tests", status: "completed", conclusion: "success" },
		{ name: "Verify", status: "completed", conclusion: "success" },
	];
	return { bead, related, pull, human, workflowRun, jobs };
}

function fixture() {
	const { bead, related, pull, human, workflowRun, jobs } = records();
	const comments = [human];
	const calls: string[][] = [];
	let corruptReadback = false;
	let remoteState: string | undefined;
	let failAfterCreate = false;
	const run = (command: readonly string[], input?: GithubMutation): string => {
		calls.push([...command]);
		if (command[0] === "bd") {
			if (command[1] === "show") return JSON.stringify([command[2] === "ps-root" ? bead : related]);
			if (command[1] === "list") return "[]";
			if (command[1] === "dep") return JSON.stringify(command[5] === "down" ? bead.dependencies : []);
			if (command[1] === "github" || command[1] === "export") return "";
		}
		if (command[1] === "repo") return "example/suite";
		if (command[2] === "user") return "publisher";
		const path = command[2] ?? "";
		if (path.includes("actions/workflows/ci.yml/runs")) return JSON.stringify([{ workflow_runs: [workflowRun] }]);
		if (path.includes("actions/runs/20/attempts/1/jobs"))
			return JSON.stringify([
				{
					jobs,
				},
			]);
		if (path.includes("/commits/")) return JSON.stringify({ sha: SHA });
		if (path.includes("/pulls/")) return JSON.stringify(pull);
		if (path.endsWith("comments?per_page=100")) return JSON.stringify([[human], comments.slice(1)]);
		if (path.endsWith("/comments") || path.includes("/issues/comments/")) {
			if (!input || !("body" in input)) throw new Error("Missing comment body");
			const comment = {
				id: 2,
				body: input.body,
				html_url: `${URL}/issues/10#issuecomment-2`,
				user: { login: "publisher" },
			};
			comments.splice(1, comments.length, comment);
			if (failAfterCreate) {
				failAfterCreate = false;
				throw new Error("Connection lost after POST");
			}
			return JSON.stringify(comment);
		}
		if (path.endsWith("/issues/10")) {
			if (input && "state" in input) remoteState = input.state;
			return JSON.stringify({
				title: bead.title,
				state: corruptReadback ? "open" : (remoteState ?? (bead.status === "closed" ? "closed" : "open")),
			});
		}
		throw new Error(`Unexpected command: ${command.join(" ")}`);
	};
	return {
		bead,
		related,
		pull,
		comments,
		calls,
		run,
		setRemoteState: (state: string) => {
			remoteState = state;
		},
		corruptReadback: () => {
			corruptReadback = true;
		},
		failAfterCreate: () => {
			failAfterCreate = true;
		},
		workflowRun,
		jobs,
	};
}

test("publication carries closure, verified PR/commit and related Issue links; retries and reopening preserve human comments", () => {
	const f = fixture();
	expect(publishBeads("ps-root", f.run)).toEqual([`${URL}/issues/10#issuecomment-2`]);
	const body = f.comments[1]?.body ?? "";
	for (const text of [
		"Accepted after verification.",
		"Focused tests passed.",
		`${URL}/commit/${SHA}`,
		`${URL}/pull/12`,
		"open, not merged",
		`${URL}/issues/9`,
		"discovered-from",
	])
		expect(body).toContain(text);
	publishBeads("ps-root", f.run);
	expect(f.calls.filter((call) => call.includes("POST"))).toHaveLength(1);
	expect(f.calls.filter((call) => call.includes("PATCH"))).toHaveLength(0);
	f.bead.status = "in_progress";
	publishBeads("ps-root", f.run);
	expect(f.comments).toHaveLength(2);
	expect(f.comments[0]?.body).toBe("Human context stays intact.");
	expect(f.comments[1]?.body).toContain("**in_progress**");
	expect(f.comments[1]?.body).not.toContain("## Closure");
});

test("missing closure evidence fails before sync; bad remote references fail instead of claiming delivery", () => {
	const f = fixture();
	f.bead.close_reason = "";
	expect(() => publishBeads("ps-root", f.run)).toThrow("close_reason");
	expect(f.calls.some((call) => call[1] === "github")).toBeFalse();
	f.bead.close_reason = "Accepted";
	f.pull.body = "No link";
	expect(() => publishBeads("ps-root", f.run)).toThrow("PR body must reference");
	f.pull.body = `Refs ${URL}/issues/10`;
	f.related.external_ref = "";
	expect(() => publishBeads("ps-root", f.run)).toThrow("publish it first");
});

test("ambiguous POST outcome is recovered by readback on retry, without creating another comment", () => {
	const f = fixture();
	f.failAfterCreate();
	expect(() => publishBeads("ps-root", f.run)).toThrow("Connection lost");
	publishBeads("ps-root", f.run);
	expect(f.calls.filter((call) => call.includes("POST"))).toHaveLength(1);
	f.corruptReadback();
	expect(() => publishBeads("ps-root", f.run)).toThrow("state/title readback");
});

test("foreign managed comments and stale PR heads cannot silently pass publication", () => {
	const f = fixture();
	publishBeads("ps-root", f.run);
	const comment = f.comments[1];
	if (!comment) throw new Error("missing fixture comment");
	comment.user.login = "someone-else";
	expect(() => publishBeads("ps-root", f.run)).toThrow("foreign authorship");
	comment.user.login = "publisher";
	f.pull.head.sha = "b".repeat(40);
	expect(() => publishBeads("ps-root", f.run)).toThrow("current PR head");
});

test("an incomplete descendant prevents the entire subtree from being synchronized", () => {
	const f = fixture();
	const run = (command: readonly string[], input?: GithubMutation): string => {
		if (command[1] === "list" && command[3] === "ps-root") return '[{"id":"ps-child"}]';
		if (command[1] === "show" && command[2] === "ps-child")
			return JSON.stringify([{ id: "ps-child", title: "Incomplete child", status: "closed" }]);
		return f.run(command, input);
	};
	expect(() => publishBeads("ps-root", run)).toThrow("ps-child: closed publication requires");
	expect(f.calls.some((call) => call[1] === "github")).toBeFalse();
});

test("no-code closure requires its own evidence and explicitly states why there is no PR", () => {
	const f = fixture();
	const run = (command: readonly string[], input?: GithubMutation): string => {
		if (command[1] === "show" && command[2] === "ps-root") {
			return JSON.stringify([
				{
					...f.bead,
					metadata: {
						github_delivery: {
							kind: "no-code",
							summary: "Investigation completed.",
							validation: "Compared recorded evidence.",
							commits: [],
							no_pr_reason: "Research only; no source change required.",
						},
					},
				},
			]);
		}
		return f.run(command, input);
	};
	publishBeads("ps-root", run);
	expect(f.comments[1]?.body).toContain("Research only; no source change required.");
	expect(f.calls.some((call) => call[2]?.includes("/pulls/"))).toBeFalse();
});

test("a successful write response without the expected remote comment fails verification", () => {
	const f = fixture();
	const run = (command: readonly string[], input?: GithubMutation): string => {
		if (command.includes("POST")) return "{}";
		return f.run(command, input);
	};
	expect(() => publishBeads("ps-root", run)).toThrow("comment readback failed");
});

test("a newly mirrored Issue left open by upstream sync is reconciled to canonical closure and verified", () => {
	const f = fixture();
	f.setRemoteState("open");
	publishBeads("ps-root", f.run);
	publishBeads("ps-root", f.run);
	expect(f.calls.filter((call) => call[2]?.endsWith("/issues/10") && call.includes("PATCH"))).toHaveLength(1);
});

test("unknown PR states fail instead of being reported as open", () => {
	const f = fixture();
	f.pull.state = "unexpected";
	expect(() => publishBeads("ps-root", f.run)).toThrow("invalid delivery PR");
});

test("a no-tests Plan remains publishable with an explicit not-run result", () => {
	const f = fixture();
	f.jobs[2] = { name: "Tests", status: "completed", conclusion: "skipped" };
	publishBeads("ps-root", f.run);
	expect(f.comments[1]?.body).toContain("Plan, Checks, and Verify passed; Tests not run (verified no-tests plan)");
});

test("a failed Verify job never certifies delivery", () => {
	const f = fixture();
	f.jobs[3] = { name: "Verify", status: "completed", conclusion: "failure" };
	expect(() => publishBeads("ps-root", f.run)).toThrow("Verify");
	expect(f.calls.some((call) => call[1] === "github")).toBeFalse();
});
