import { expect, test } from "bun:test";
import {
	type ActivitySummaryMember,
	activityTarget,
	bashResultMovedToBackground,
	classifyBashActivity,
	classifyBashRetrievalActivity,
	classifyRetrievalGroupInvocation,
	planRetrievalGroups,
	singleActivity,
	summarizeRetrievalGroup,
	type ToolActivityCategory,
	type ToolActivityMetadata,
	type ToolArguments,
} from "../../../packages/pi-stuff/src/tool-display/activity.js";

const retrieval = (category: "list-directory" | "read-file" | "search-pattern") =>
	({
		categories: [category],
		classify: ({ args }) => singleActivity(category, { target: String(args["value"] ?? "") }),
	}) satisfies ToolActivityMetadata<ToolArguments, unknown>;
const policies = new Map<string, ToolActivityMetadata<ToolArguments, unknown>>([
	["read", retrieval("read-file")],
	["grep", retrieval("search-pattern")],
	["find", retrieval("search-pattern")],
	["ls", retrieval("list-directory")],
	[
		"edit",
		{
			categories: ["change-file"],
			classify: ({ args }) => singleActivity("change-file", { target: String(args["value"] ?? "") }),
		},
	],
	[
		"bash",
		{
			categories: ["run-command", "read-file", "search-pattern", "list-directory"],
			classify: classifyBashActivity,
		},
	],
]);
const classify = (name: string, args: ToolArguments) =>
	classifyRetrievalGroupInvocation(name, args, policies.get(name));

const call = (id: string, name: string, value: string) => ({
	type: "toolCall",
	id,
	name,
	arguments: { value },
});

const assistant = (...content: unknown[]) => ({ role: "assistant", content });

test("active path targets preserve only the nearest useful directory and basename", () => {
	expect(activityTarget("/workspace/pi-stuff/packages/pi-stuff/src/tool-display/contract.ts")).toBe(
		"/.../tool-display/contract.ts",
	);
	expect(activityTarget("packages/pi-stuff/src/tool-display/contract.ts")).toBe(".../tool-display/contract.ts");
	expect(activityTarget("packages/pi-stuff/package.json")).toBe(".../pi-stuff/package.json");
	expect(activityTarget("Running repository checks")).toBe("Running repository checks");
});

test("plans retrieval segments across Tool round-trips and keeps boundaries standalone", () => {
	const groups = planRetrievalGroups(
		[
			{ role: "user", content: [{ type: "text", text: "work" }] },
			assistant({ type: "thinking", thinking: "inspect" }, call("r1", "read", "a")),
			{ role: "toolResult", toolCallId: "r1", content: [{ type: "text", text: "A" }], details: {} },
			assistant({ type: "thinking", thinking: "change" }, call("e1", "edit", "a")),
			{ role: "toolResult", toolCallId: "e1", content: [{ type: "text", text: "ok" }], details: {} },
			assistant({ type: "thinking", thinking: "verify" }, call("b1", "bash", "test")),
		],
		classify,
		false,
	);

	expect(groups).toHaveLength(3);
	expect(groups[0]?.leaderId).toBe("r1");
	expect(groups[0]?.closed).toBe(true);
	expect(groups[0]?.members.map((member) => member.id)).toEqual(["r1"]);
	expect(groups[0]?.members[0]?.result?.content).toEqual([{ type: "text", text: "A" }]);
	expect(groups.slice(1).map((group) => group.members.map((member) => member.id))).toEqual([["e1"], ["b1"]]);
	expect(groups.slice(1).every((group) => group.closed && group.standalone)).toBe(true);
});

test("a new visible Thinking run closes the current Retrieval Group", () => {
	const groups = planRetrievalGroups(
		[
			assistant(
				{ type: "thinking", thinking: "inspect the first file" },
				call("r1", "read", "a"),
				{ type: "thinking", thinking: "inspect the second file" },
				call("r2", "read", "b"),
			),
		],
		classify,
		true,
	);

	expect(groups.map((group) => group.members.map((member) => member.id))).toEqual([["r1"], ["r2"]]);
});

test("ordinary Bash calls are standalone boundaries between retrieval segments", () => {
	const groups = planRetrievalGroups(
		[
			assistant(call("r1", "read", "a"), call("r2", "read", "b"), call("b1", "bash", "first")),
			{ role: "toolResult", toolCallId: "b1", content: [{ type: "text", text: "one" }], details: {} },
			assistant(call("b2", "bash", "second && third | cat"), call("e1", "edit", "a")),
		],
		classify,
		false,
	);

	expect(groups.map((group) => group.members.map((entry) => entry.id))).toEqual([
		["r1", "r2"],
		["b1"],
		["b2"],
		["e1"],
	]);
	expect(groups.map((group) => group.closed)).toEqual([true, true, true, true]);
	expect(groups.map((group) => group.standalone === true)).toEqual([false, true, true, true]);
});

test("branch and compaction metadata stay transparent to Retrieval Groups", () => {
	const groups = planRetrievalGroups(
		[
			assistant(call("r1", "read", "a")),
			{ role: "branchSummary", summary: "branch metadata" },
			{ role: "compactionSummary", summary: "compaction metadata" },
			assistant(call("r2", "read", "a")),
		],
		classify,
		true,
	);
	expect(groups.map((group) => group.members.map((entry) => entry.id))).toEqual([["r1", "r2"]]);
});

test("prose, visible context, user input, and unknown Tools are boundaries", () => {
	const groups = planRetrievalGroups(
		[
			assistant(call("r1", "read", "a"), { type: "text", text: "I found it." }, call("e1", "edit", "a")),
			assistant(call("x1", "third_party", "x"), call("b1", "bash", "test")),
			{ role: "custom", display: false, content: "hidden" },
			assistant(call("r2", "read", "b")),
			{ role: "custom", display: true, content: "visible notification" },
			assistant(call("r3", "read", "c")),
			{ role: "user", content: [{ type: "text", text: "next" }] },
		],
		classify,
		false,
	);

	expect(groups.map((group) => group.members.map((member) => member.id))).toEqual([
		["r1"],
		["e1"],
		["x1"],
		["b1"],
		["r2"],
		["r3"],
	]);
	expect(groups.every((group) => group.closed)).toBe(true);
});

test("a singleton forms a group and historical tails close deterministically", () => {
	const [group] = planRetrievalGroups([assistant(call("r1", "read", "a"))], classify, true);
	expect(group?.members).toHaveLength(1);
	expect(group?.closed).toBe(true);
});

test("assistant lifecycle failures settle calls that never received Tool results", () => {
	const groups = planRetrievalGroups(
		[
			{ ...assistant(call("cancelled", "read", "a")), stopReason: "aborted" },
			{ ...assistant(call("failed", "read", "b")), stopReason: "error" },
			{ ...assistant(call("completed", "read", "c")), stopReason: "aborted" },
			{ role: "toolResult", toolCallId: "completed", content: [{ type: "text", text: "done" }], details: {} },
		],
		classify,
		true,
	);

	expect(groups[0]?.members[0]?.terminalState).toBe("cancelled");
	expect(groups[0]?.members[1]?.terminalState).toBe("error");
	expect(groups[0]?.members[2]?.terminalState).toBeUndefined();
	expect(groups[0]?.members[2]?.result).toBeDefined();
});

test("classifies only explicit retrieval metadata and the two transparent infrastructure Tools", () => {
	expect(classify("read", { value: "a.ts" })).toBe("retrieval");
	expect(classify("grep", { value: "needle" })).toBe("retrieval");
	expect(classify("find", { value: "*.ts" })).toBe("retrieval");
	expect(classify("ls", { value: "." })).toBe("retrieval");
	expect(classify("edit", { value: "a.ts" })).toBe("boundary");
	expect(classify("third_party_read", { value: "a.ts" })).toBe("boundary");
	expect(classify("tool_search", { query: "read" })).toBe("transparent");
	expect(classify("ctx_reduce", {})).toBe("transparent");
	expect(classifyRetrievalGroupInvocation("mcp__files__read", { value: "a.ts" }, retrieval("read-file"))).toBe(
		"boundary",
	);
});

test("keeps exact SKILL.md reads standalone without changing ordinary Read grouping", () => {
	expect(classify("read", { path: "skills/demo/SKILL.md" })).toBe("boundary");
	expect(classify("read", { path: "skills/demo/../actual/SKILL.md" })).toBe("boundary");
	expect(classify("read", { path: "skills/demo/skill.md" })).toBe("retrieval");
	expect(classify("read", { path: "skills/demo/README.md" })).toBe("retrieval");

	const groups = planRetrievalGroups(
		[
			assistant(
				{ type: "toolCall", id: "r1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "skill", name: "read", arguments: { path: "skills/demo/SKILL.md" } },
				{ type: "toolCall", id: "r2", name: "read", arguments: { path: "b.ts" } },
			),
		],
		classify,
		true,
	);

	expect(groups.map((group) => group.members.map((entry) => entry.id))).toEqual([["r1"], ["skill"], ["r2"]]);
	expect(groups.map((group) => group.standalone === true)).toEqual([false, true, false]);
});

test("consequential Suite categories and unknown MCP calls are group boundaries", () => {
	const cases: ReadonlyArray<readonly [string, ToolActivityCategory]> = [
		["edit", "change-file"],
		["write", "change-file"],
		["apply_patch", "change-file"],
		["web_search", "search-web"],
		["history", "search-history"],
		["memory", "read-memory"],
		["task", "update-task"],
		["agent", "run-agent"],
		["background", "inspect-background"],
		["goal", "complete-goal"],
		["image", "view-image"],
	];
	for (const [name, category] of cases) {
		expect(
			classifyRetrievalGroupInvocation(
				name,
				{},
				{
					categories: [category],
					classify: () => [{ category, count: 1 }],
				},
			),
		).toBe("boundary");
	}
	expect(classifyRetrievalGroupInvocation("mcp__unknown__read", {}, undefined)).toBe("boundary");
});

test("transparent infrastructure stays recoverable without splitting retrieval", () => {
	const groups = planRetrievalGroups(
		[
			assistant(call("r1", "read", "a")),
			assistant(call("s1", "tool_search", "catalog")),
			assistant(call("r2", "read", "b")),
		],
		classify,
		true,
	);
	expect(groups.map((group) => group.members.map((entry) => entry.id))).toEqual([["r1", "s1", "r2"]]);
});

test("an infrastructure issue becomes an independent boundary on both sides", () => {
	const groups = planRetrievalGroups(
		[
			assistant(call("r1", "read", "a"), call("s1", "tool_search", "catalog"), call("r2", "read", "b")),
			{
				role: "toolResult",
				toolCallId: "s1",
				content: [{ type: "text", text: "catalog unavailable" }],
				details: {},
				isError: true,
			},
		],
		classify,
		true,
	);

	expect(groups.map((group) => group.members.map((entry) => entry.id))).toEqual([["r1"], ["s1"], ["r2"]]);
	expect(groups.every((group) => group.closed)).toBe(true);
});

test("classifies Bash retrieval without admitting it to Retrieval Groups", () => {
	for (const command of [
		"cat a.ts",
		"head -n 5 a.ts",
		"tail a.ts",
		"wc -l a.ts",
		"jq '.name' package.json",
		"grep -n needle a.ts",
		"rg needle src",
		"find src -name '*.ts'",
		"ls -la src",
		"tree src",
		"du -sh src",
		"printf 'scan\\n' && rg needle src | head",
		"cat a.ts;\n",
	]) {
		expect(classifyBashRetrievalActivity({ command }).length).toBeGreaterThan(0);
		expect(classify("bash", { command })).toBe("boundary");
	}

	for (const command of [
		"echo done",
		"cat a.ts && git status",
		"rg needle | xargs rm",
		"find src -delete",
		"find src -exec cat {} \\;",
		"cat a.ts > copy.ts",
		"cat $(generate-path)",
		"cat 'unterminated",
		"cat a.ts &",
		"cat a.ts &&",
		"cat a.ts |",
	]) {
		expect(classifyBashRetrievalActivity({ command })).toEqual([]);
	}
	expect(classifyBashRetrievalActivity({ command: "cat a.ts", run_in_background: true })).toEqual([]);
});

test("counts each Bash retrieval invocation once per semantic category", () => {
	expect(classifyBashRetrievalActivity({ command: "cat a && head b" })).toEqual([
		expect.objectContaining({ category: "read-file", count: 1 }),
	]);
	expect(
		classifyBashRetrievalActivity({ command: "cat a | rg needle && ls src" }).map((item) => item.category),
	).toEqual(["read-file", "search-pattern", "list-directory"]);
});

function member(state: ActivitySummaryMember["state"], items: ActivitySummaryMember["items"]): ActivitySummaryMember {
	return { items, state };
}

test("summarizes semantic categories in fixed order with object deduplication", () => {
	const summary = summarizeRetrievalGroup(
		[
			member("success", [{ category: "read-file", countKeys: ["/a.ts"], target: "a.ts" }]),
			member("success", [{ category: "run-command", count: 1, target: "Running tests" }]),
			member("success", [{ category: "change-file", countKeys: ["/a.ts", "/b.ts"] }]),
			member("success", [{ category: "read-file", countKeys: ["/a.ts", "/c.ts"] }]),
		],
		true,
	);

	expect(summary.summary).toBe("Changed 2 files, ran 1 command, read 2 files");
	expect(summary.target).toBe("");
	expect(summary.active).toBe(false);
});

test("Bash outcomes are success-gated and expose bounded Git identities", () => {
	const failed = classifyBashActivity({
		args: { command: "git push origin main" },
		result: { content: [{ type: "text", text: "rejected" }], details: {} },
		state: "error",
	});
	expect(failed.map((item) => item.category)).toEqual(["run-command"]);

	const pullRequest = classifyBashActivity({
		args: { command: "gh pr create" },
		result: { content: [{ type: "text", text: "https://github.com/acme/repo/pull/42" }], details: {} },
		state: "success",
	});
	expect(pullRequest).toEqual([expect.objectContaining({ category: "create-pr", detail: "#42" })]);

	const merge = classifyBashActivity({
		args: { command: "git merge feature" },
		result: { content: [{ type: "text", text: "Fast-forward" }], details: {} },
		state: "success",
	});
	expect(merge).toEqual([expect.objectContaining({ category: "merge", detail: "feature" })]);
	const rebase = classifyBashActivity({
		args: { command: "git rebase main" },
		result: { content: [{ type: "text", text: "Successfully rebased and updated refs/heads/topic." }], details: {} },
		state: "success",
	});
	expect(rebase).toEqual([expect.objectContaining({ category: "rebase", detail: "main" })]);

	for (const command of ["git merge feature || true", "git rebase main | cat", "git merge --abort"]) {
		const masked = classifyBashActivity({
			args: { command },
			result: { content: [{ type: "text", text: "Fast-forward\nSuccessfully rebased" }], details: {} },
			state: "success",
		});
		expect(masked.map((item) => item.category)).toEqual(["run-command"]);
	}

	for (const command of ["git commit --dry-run", "git push --dry-run origin main", "gh pr create --dry-run"]) {
		const dryRun = classifyBashActivity({
			args: { command },
			result: { content: [{ type: "text", text: "dry run" }], details: {} },
			state: "success",
		});
		expect(dryRun.map((item) => item.category)).toEqual(["run-command"]);
	}

	const commitWithoutEvidence = classifyBashActivity({
		args: { command: "git commit -m test" },
		result: { content: [{ type: "text", text: "nothing to commit" }], details: {} },
		state: "success",
	});
	expect(commitWithoutEvidence.map((item) => item.category)).toEqual(["run-command"]);
});

test("detects Background Work handoff markers only at bounded result edges", () => {
	const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: {} });
	expect(bashResultMovedToBackground(result(`moved to background task abc\n${"x".repeat(8_000)}`))).toBe(true);
	expect(bashResultMovedToBackground(result(`${"x".repeat(8_000)}\nmanually moved to background task abc`))).toBe(
		true,
	);
	expect(
		bashResultMovedToBackground(result(`${"x".repeat(2_000)}\nmoved to background task abc\n${"x".repeat(2_000)}`)),
	).toBe(false);
});

test("uses present tense, latest bounded target, structured outcomes, and honest issues", () => {
	const active = summarizeRetrievalGroup(
		[
			member("success", [{ category: "commit", count: 1, detail: "cf12251" }]),
			member("error", [{ category: "run-command", count: 1, target: "Typechecking" }]),
			member("rejected", [{ category: "read-file", countKeys: ["/secret"] }]),
			member("cancelled", []),
		],
		false,
	);

	expect(active.summary).toBe(
		"Committing 1 change, running 1 command, reading 1 file · 1 failed, 1 rejected, 1 cancelled",
	);
	expect(active.target).toBe("Typechecking");
	expect(active.issueState).toBe("error");

	const settled = summarizeRetrievalGroup(
		[member("success", [{ category: "commit", count: 1, detail: "cf12251" }])],
		true,
	);
	expect(settled.summary).toBe("Committed cf12251");
});

test("successful infrastructure-only groups are silent but issues remain visible", () => {
	expect(summarizeRetrievalGroup([member("success", [])], true).summary).toBe("");
	expect(summarizeRetrievalGroup([member("error", [])], true).summary).toBe("Internal operation failed");
});

test("keeps failures historical when later calls succeed", () => {
	const success = member("success", [{ category: "read-file", countKeys: ["a.ts"] }]);
	const failure = member("error", [{ category: "run-command", count: 1 }]);
	const retry = member("success", [{ category: "run-command", count: 1 }]);

	expect(summarizeRetrievalGroup([member("running", [])], false).outcome).toBe("running");
	expect(summarizeRetrievalGroup([success], true).outcome).toBe("success");
	expect(summarizeRetrievalGroup([failure, retry], true)).toMatchObject({
		issueText: "1 failed",
		outcome: "warning",
	});
	expect(summarizeRetrievalGroup([success, failure], true).outcome).toBe("warning");
	expect(summarizeRetrievalGroup([failure], true).outcome).toBe("error");
	expect(summarizeRetrievalGroup([member("rejected", [])], true).outcome).toBe("warning");
	expect(summarizeRetrievalGroup([member("cancelled", [])], true).outcome).toBe("warning");
});
