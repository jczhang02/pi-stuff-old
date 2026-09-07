import { expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { ToolArguments } from "../../../packages/pi-stuff/src/tool-display/activity.js";
import { ToolUiRuntime } from "../../../packages/pi-stuff/src/tool-display/contract.js";

function details(name: string, args: ToolArguments, result: AgentToolResult<unknown>, id = name) {
	const runtime = new ToolUiRuntime();
	runtime.indexMessages(
		[
			{ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
			{ role: "toolResult", toolCallId: id, ...result },
		],
		true,
	);
	return {
		formatted: runtime.toolActivityDetail(id, "formatted"),
		raw: runtime.toolActivityDetail(id, "raw"),
	};
}

const textResult = (text = "evidence"): AgentToolResult<unknown> => ({
	content: [{ type: "text", text }],
	details: { source: "fixture" },
});

test("/tools Formatted uses the accepted semantic section map and Raw stays protocol-oriented", () => {
	const cases: Array<[string, ToolArguments, AgentToolResult<unknown>, string[]]> = [
		["read", { path: "a.ts" }, textResult("content"), ["Content"]],
		["grep", { pattern: "needle" }, textResult("a.ts:1:needle"), ["Matches"]],
		["find", { pattern: "*.ts" }, textResult("a.ts"), ["Files"]],
		["ls", { path: "." }, textResult("src"), ["Entries"]],
		["write", { content: "one\ntwo", path: "a.ts" }, textResult("written"), ["Change", "Content"]],
		[
			"edit",
			{ path: "a.ts" },
			{
				content: [{ type: "text", text: "changed" }],
				details: { patch: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new" },
			},
			["Change", "Diff"],
		],
		["bash", { command: "printf ok" }, textResult("ok"), ["Command", "Output"]],
		[
			"apply_patch",
			{ input: "*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch" },
			{
				content: [{ type: "text", text: "changed" }],
				details: { changedFiles: ["a.ts"], createdFiles: [], deletedFiles: [], movedFiles: [] },
			},
			["Files", "Diff"],
		],
		["view_image", { path: "a.png" }, textResult("image/png · a.png"), ["Image"]],
		["imagegen", { prompt: "a landscape" }, textResult("a.png"), ["Generation", "Images"]],
		["goal_complete", { summary: "done" }, textResult("tests passed"), ["Summary", "Evidence"]],
		["goal_blocked", { reason: "waiting" }, textResult("waiting"), ["Reason"]],
		["web_search", { query: "Pi" }, textResult("answer\nhttps://example.com"), ["Answer", "Sources"]],
		["fetch_content", { url: "https://example.com" }, textResult("document"), ["Document"]],
		["get_search_content", { responseId: "r" }, textResult("passage"), ["Matches"]],
		["mcp", { server: "local", tool: "echo" }, textResult("reply"), ["Invocation", "Result"]],
		["background", { action: "list" }, textResult("task"), ["Tasks"]],
		["monitor", { path: "log.txt" }, textResult("waiting"), ["Monitor"]],
		["subagent", { agent: "reviewer", task: "Review" }, textResult("launched"), ["Task"]],
		["TaskCreate", { task: "Review" }, textResult("created"), ["Task"]],
		["TaskGet", { id: "1" }, textResult("task"), ["Task"]],
		["TaskList", {}, textResult("tasks"), ["Tasks"]],
		["TaskUpdate", { id: "1" }, textResult("updated"), ["Change"]],
		["ctx_expand", { range: "1:4" }, textResult("expanded"), ["Range", "Result"]],
		["ctx_search", { query: "term" }, textResult("match"), ["Query", "Matches"]],
		["ctx_memory", {}, textResult("memory"), ["Memory"]],
		["ctx_note", {}, textResult("note"), ["Note"]],
		["ctx_reduce", {}, textResult("reduced"), ["Reduction"]],
		["subagent_supervisor", {}, textResult("status"), ["Status"]],
		["intercom", {}, textResult("message"), ["Message"]],
		["contact_supervisor", { request: "question" }, textResult("reply"), ["Request", "Reply"]],
		["structured_output", {}, textResult("output"), ["Output"]],
		["tool_search", { query: "tool" }, textResult("match"), ["Matches"]],
	];

	for (const [name, args, result, titles] of cases) {
		const detail = details(name, args, result, `semantic-${name}`);
		expect(
			detail.formatted?.sections?.map((section) => section.title),
			name,
		).toEqual(titles);
		expect(detail.formatted?.lines.join("\n"), name).not.toContain("Call ID");
		const raw = detail.raw?.lines.join("\n") ?? "";
		expect(raw, name).toContain("Call ID");
		expect(raw, name).toContain("Arguments");
		expect(raw, name).toContain("Result content");
		expect(raw, name).toContain("Details");
	}
});

test("/tools semantic variants preserve ownership and distinct terminal states", () => {
	const image = details(
		"view_image",
		{ path: "pixel.png" },
		{
			content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
			details: { path: "pixel.png" },
		},
	);
	expect(image.formatted?.images).toEqual([{ data: "aGVsbG8=", mimeType: "image/png" }]);
	expect(details("mcp", { search: "echo" }, textResult("match")).formatted?.sections?.[0]?.title).toBe("Matches");
	expect(
		details(
			"subagent",
			{ agent: "reviewer", foreground: true, task: "Review" },
			textResult("report"),
		).formatted?.sections?.map((section) => section.title),
	).toEqual(["Task", "Result"]);
	expect(
		details("background", { action: "output", task_id: "shell-1" }, textResult("one\ntwo")).formatted?.sections?.map(
			(section) => section.title,
		),
	).toEqual(["Background", "Output"]);
	for (const [text, title] of [
		["failure", "Error"],
		["Tool execution was blocked by policy", "Rejection"],
		["Operation aborted", "Cancellation"],
	] as const) {
		const result = { ...textResult(text), isError: true };
		expect(details("structured_output", {}, result, `issue-${title}`).formatted?.sections?.[0]?.title).toBe(title);
	}
});

test("file mutation Formatted sections retain source and per-file diff evidence", () => {
	const write = details(
		"write",
		{
			content: "\u001b]8;;https://evil.invalid\u0007const value = 1;\u001b]8;;\u0007",
			path: "src/write.ts",
		},
		textResult("written"),
	).formatted?.sections?.find((section) => section.title === "Content");
	expect(write?.languagePath).toBe("src/write.ts");
	expect(write?.operationEvidence?.map((line) => line?.kind)).toEqual(["source"]);
	expect(write?.lines.join("\n")).not.toContain("evil.invalid");

	const edit = details(
		"edit",
		{ path: "src/edit.ts" },
		{
			content: [{ type: "text", text: "changed" }],
			details: { patch: "--- a/src/edit.ts\n+++ b/src/edit.ts\n@@ -1 +1 @@\n-old\n+new" },
		},
	).formatted?.sections?.find((section) => section.title === "Diff");
	expect(edit?.languagePath).toBe("src/edit.ts");
	expect(edit?.operationEvidence?.map((line) => line?.diffKind)).toEqual(["delete", "add"]);

	const patch = details(
		"apply_patch",
		{ input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Update File: scripts/b.py\n*** End Patch" },
		{
			content: [{ type: "text", text: "changed" }],
			details: {
				changedFiles: ["src/a.ts", "scripts/b.py"],
				createdFiles: [],
				deletedFiles: [],
				diff: [
					"--- a/src/a.ts",
					"+++ b/src/a.ts",
					"@@ -1 +1 @@",
					"-const oldValue = 1;",
					"+const newValue = 2;",
					"--- a/scripts/b.py",
					"+++ b/scripts/b.py",
					"@@ -1 +1 @@",
					"-old_value = 1",
					"+new_value = 2",
				].join("\n"),
				movedFiles: [],
			},
		},
	).formatted?.sections?.find((section) => section.title === "Diff");
	expect(
		patch?.operationEvidence?.flatMap((line) =>
			line?.kind === "diff" && line.languagePath ? [line.languagePath] : [],
		),
	).toEqual(["src/a.ts", "src/a.ts", "scripts/b.py", "scripts/b.py"]);
});
