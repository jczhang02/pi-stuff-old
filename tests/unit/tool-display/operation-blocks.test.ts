import { expect, test } from "bun:test";
import { type AgentToolResult, initTheme, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerWorkTools } from "../../../packages/pi-stuff/src/background-work/src/tools.js";
import { registerCodexTools } from "../../../packages/pi-stuff/src/codex/tools.js";
import { sanitizeMultilineTerminalText } from "../../../packages/pi-stuff/src/shared/terminal-text.js";
import type { ToolArguments } from "../../../packages/pi-stuff/src/tool-display/activity.js";
import { registerBuiltins } from "../../../packages/pi-stuff/src/tool-display/builtin-tools.js";
import { getToolUiRuntime, type ToolUiRuntime } from "../../../packages/pi-stuff/src/tool-display/contract.js";
import { diffRowsFromResult } from "../../../packages/pi-stuff/src/tool-display/operation-block-diff.js";
import { styleOperationEvidence } from "../../../packages/pi-stuff/src/tool-display/operation-block-renderer.js";
import { toolRegistrationHarness } from "../../fixtures/tool-registration-host.js";

// SAFETY: this deterministic fixture implements the exact Theme members exercised by Tool rows.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

interface RenderOptions {
	readonly expanded?: boolean;
	readonly isError?: boolean;
}

function renderSettled(
	tool: ToolDefinition,
	runtime: ToolUiRuntime,
	id: string,
	args: ToolArguments,
	result: AgentToolResult<unknown>,
	options: RenderOptions = {},
): string[] {
	const resultMessage = { role: "toolResult", toolCallId: id, ...result };
	if (options.isError === true) Object.assign(resultMessage, { isError: true });
	runtime.resetProjection([
		{ role: "assistant", content: [{ type: "toolCall", id, name: tool.name, arguments: args }] },
		resultMessage,
	]);
	const state = {};
	const context = {
		args,
		argsComplete: true,
		cwd: "/project",
		executionStarted: false,
		expanded: options.expanded === true,
		invalidate: () => undefined,
		isError: options.isError === true,
		isPartial: false,
		lastComponent: undefined,
		showImages: true,
		state,
		toolCallId: id,
	};
	// SAFETY: the Tool owns this schema-validated fixture and the test supplies every renderer context member it reads.
	const component = tool.renderCall?.(args, theme, context as never);
	if (!component) throw new Error(`missing ${tool.name} call renderer`);
	// SAFETY: the result fixture follows the registered Tool's public result contract.
	const body = tool.renderResult?.(result as never, { expanded: options.expanded === true, isPartial: false }, theme, {
		...context,
		lastComponent: component,
	} as never);
	return [...component.render(120), ...(body?.render(120) ?? [])];
}

function renderRunning(tool: ToolDefinition, runtime: ToolUiRuntime, id: string, args: ToolArguments): string {
	runtime.resetProjection([
		{ role: "assistant", content: [{ type: "toolCall", id, name: tool.name, arguments: args }] },
	]);
	const context = {
		args,
		argsComplete: true,
		cwd: "/project",
		executionStarted: true,
		expanded: false,
		invalidate: () => undefined,
		isError: false,
		isPartial: true,
		lastComponent: undefined,
		showImages: true,
		state: {},
		toolCallId: id,
	};
	// SAFETY: the Tool owns this schema-validated fixture and the test supplies every renderer context member it reads.
	const component = tool.renderCall?.(args, theme, context as never);
	if (!component) throw new Error(`missing ${tool.name} call renderer`);
	return component.render(120).join("\n");
}

function builtins() {
	const registration = toolRegistrationHarness();
	registerBuiltins(
		registration.host,
		"/project",
		{ autoResizeImages: true, shellCommandPrefix: undefined, shellPath: undefined },
		{},
		new Set(["write", "edit"]),
	);
	return { ...registration, runtime: getToolUiRuntime(registration.host) };
}

test("Write shows result-authorized final content with compact and expanded bounds", () => {
	const { runtime, tools } = builtins();
	const write = tools.get("write");
	if (!write) throw new Error("missing Write Tool");
	const content = Array.from({ length: 12 }, (_, index) =>
		index === 1 ? "" : `const value${String(index + 1)} = ${String(index + 1)};`,
	).join("\n");
	const result = {
		content: [{ type: "text" as const, text: "Successfully wrote 222 bytes to src/demo.ts" }],
		details: undefined,
	};
	const compact = renderSettled(write, runtime, "write-1", { content, path: "src/demo.ts" }, result).join("\n");
	expect(compact).toContain("Write(src/demo.ts)");
	expect(compact).toContain("12 lines written");
	expect(compact).toContain("2 │ ");
	expect(compact).toContain("… +2 lines (ctrl+o to expand)");
	expect(compact).not.toContain("Successfully wrote");

	const expanded = sanitizeMultilineTerminalText(
		renderSettled(write, runtime, "write-2", { content, path: "src/demo.ts" }, result, {
			expanded: true,
		}).join("\n"),
	);
	expect(expanded).toContain("12 │ const value12 = 12;");
	expect(expanded).not.toContain("ctrl+o to expand");
});

test("Operation Blocks cap large source and diff before expanded rendering", () => {
	const { runtime, tools } = builtins();
	const write = tools.get("write");
	const edit = tools.get("edit");
	if (!write || !edit) throw new Error("missing file Tools");
	const source = `${"const value = 1;\n".repeat(300_000)}POISON_SOURCE_TAIL`;
	const writeLines = renderSettled(
		write,
		runtime,
		"write-large",
		{ content: source, path: "src/large.ts" },
		{ content: [{ type: "text", text: "written" }], details: { finalContent: source } },
		{ expanded: true },
	);
	expect(writeLines.join("\n")).toContain("preview truncated");
	expect(writeLines.join("\n")).not.toContain("POISON_SOURCE_TAIL");
	expect(writeLines.length).toBeLessThanOrEqual(250);

	const diff = `--- a/src/large.ts\n+++ b/src/large.ts\n@@ -1,1 +1,100001 @@\n${"+const next = 1;\n".repeat(100_000)}POISON_DIFF_TAIL`;
	const result = { content: [{ type: "text" as const, text: "edited" }], details: { diff } };
	const parsed = diffRowsFromResult(result, "src/large.ts", true);
	expect(parsed.rows.length).toBeLessThanOrEqual(480);
	expect(parsed.truncated).toBeTrue();
	const editLines = renderSettled(
		edit,
		runtime,
		"edit-large",
		{ newText: "next", oldText: "value", path: "src/large.ts" },
		result,
		{ expanded: true },
	);
	expect(editLines.join("\n")).toContain("more diff omitted");
	expect(editLines.join("\n")).not.toContain("POISON_DIFF_TAIL");
	expect(editLines.length).toBeLessThanOrEqual(250);
});

test("operation evidence sanitizes Tool controls before source and diff styling", () => {
	initTheme("dark", false);
	const taggedTheme = {
		bold: (value: string) => value,
		fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
	};
	// SAFETY: this fixture implements the exact Theme methods exercised by the evidence renderer.
	const evidenceTheme = taggedTheme as Theme;
	const styled = styleOperationEvidence(
		[
			{ kind: "source", languagePath: "src/demo.ts", newLine: 1, text: "const value = 1;" },
			{
				diffKind: "delete",
				kind: "diff",
				languagePath: "src/demo.ts",
				oldLine: 2,
				text: "\u001b]8;;https://evil.invalid\u0007const oldValue = 1;\u001b]8;;\u0007",
			},
			{
				diffKind: "add",
				kind: "diff",
				languagePath: "src/demo.ts",
				newLine: 2,
				text: "const newValue = 2;",
			},
		],
		evidenceTheme,
		"success",
	);
	const output = styled.join("\n");
	expect(output).toContain("<dim>1 │ </dim>");
	expect(output).toContain("<error>-</error>");
	expect(output).toContain("<success>+</success>");
	expect(output).toContain("\u001b[");
	expect(output).not.toContain("evil.invalid");
});

test("Write prefers verified result content and uses singular line grammar", () => {
	const { runtime, tools } = builtins();
	const write = tools.get("write");
	if (!write) throw new Error("missing Write Tool");
	const output = renderSettled(
		write,
		runtime,
		"write-verified",
		{ content: "unverified invocation content", path: "src/verified.ts" },
		{
			content: [{ type: "text", text: "Successfully wrote content" }],
			details: { finalContent: "verified final content" },
		},
		{ expanded: true },
	).join("\n");
	expect(output).toContain("1 line written");
	expect(output).toContain("verified final content");
	expect(output).not.toContain("unverified invocation content");
	expect(output).not.toContain("Successfully wrote content");
});

test("Edit shows verified exact statistics and old/new line gutters", () => {
	const { runtime, tools } = builtins();
	const edit = tools.get("edit");
	if (!edit) throw new Error("missing Edit Tool");
	const patch = [
		"--- a/src/demo.ts",
		"+++ b/src/demo.ts",
		"@@ -1,3 +1,4 @@",
		" const before = true;",
		"-const oldValue = 1;",
		"+const newValue = 2;",
		"+const extra = 3;",
		" export {};",
	].join("\n");
	const output = sanitizeMultilineTerminalText(
		renderSettled(
			edit,
			runtime,
			"edit-1",
			{ edits: [{ oldText: "old", newText: "new" }], path: "src/demo.ts" },
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/demo.ts." }],
				details: { diff: "", patch },
			},
		).join("\n"),
	);
	expect(output).toContain("Edit(src/demo.ts)");
	expect(output).toContain("+2/-1");
	expect(output).toMatch(/2\s+│ - const oldValue/u);
	expect(output).toMatch(/\s3 │ \+ const extra/u);
	expect(output).not.toContain("Successfully replaced");
});

test("Patch reports aggregate and per-file evidence, including pure rename wording", () => {
	const registration = toolRegistrationHarness();
	registerCodexTools(registration.host);
	const runtime = getToolUiRuntime(registration.host);
	const patchTool = registration.tools.get("apply_patch");
	if (!patchTool) throw new Error("missing Patch Tool");
	const diff = [
		"--- a/src/a.ts",
		"+++ b/src/a.ts",
		"@@ -1 +1 @@",
		"-const a = 1;",
		"+const a = 2;",
		"--- /dev/null",
		"+++ b/src/b.ts",
		"@@ -0,0 +1 @@",
		"+export {};",
	].join("\n");
	const output = renderSettled(
		patchTool,
		runtime,
		"patch-1",
		{ input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: src/b.ts\n*** End Patch" },
		{
			content: [{ type: "text", text: "Applied patch successfully. changed 2 files." }],
			details: {
				changedFiles: ["src/a.ts", "src/b.ts"],
				createdFiles: ["src/b.ts"],
				deletedFiles: [],
				diff,
				fuzz: 0,
				movedFiles: [],
			},
		},
	).join("\n");
	expect(output).toContain("Patch(2 files)");
	expect(output).toContain("+2/-1");
	expect(output).toContain("M src/a.ts · +1/-1");
	expect(output).toContain("A src/b.ts · +1/-0");

	const renameInput = "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n*** End Patch";
	const rename = renderSettled(
		patchTool,
		runtime,
		"patch-rename",
		{ input: renameInput },
		{
			content: [{ type: "text", text: "Applied patch successfully. changed 1 file." }],
			details: {
				changedFiles: ["new.ts"],
				createdFiles: [],
				deletedFiles: [],
				fuzz: 0,
				movedFiles: ["new.ts"],
			},
		},
	).join("\n");
	expect(rename).toContain("Patch(new.ts)");
	expect(rename).toContain("+0/-0");
	expect(rename).toContain("renamed without content changes");
});

test("Background output is the only Background Operation Block", () => {
	const registration = toolRegistrationHarness();
	registerWorkTools(registration.host, { current: () => undefined }, { includeBash: false });
	const runtime = getToolUiRuntime(registration.host);
	const background = registration.tools.get("background");
	if (!background) throw new Error("missing Background Tool");
	const output = renderSettled(
		background,
		runtime,
		"background-output",
		{ action: "output", task_id: "shell-7" },
		{
			content: [
				{
					type: "text",
					text: 'Background command "tests" completed\n\nfirst\nsecond\nthird\nfourth',
				},
			],
			details: { action: "output", status: "read", taskId: "shell-7" },
		},
		{ expanded: true },
	).join("\n");
	expect(output).toContain("Background(shell-7)");
	expect(output).toContain("4 lines read");
	expect(output.match(/first/gu)).toHaveLength(1);
	expect(output).not.toContain('Background command "tests" completed');

	const singular = renderSettled(
		background,
		runtime,
		"background-singular",
		{ action: "output", task_id: "shell-8" },
		{
			content: [{ type: "text", text: "only output line" }],
			details: { action: "output", status: "read", taskId: "shell-8" },
		},
	).join("\n");
	expect(singular).toContain("1 line read");

	const list = renderSettled(
		background,
		runtime,
		"background-list",
		{ action: "list" },
		{
			content: [{ type: "text", text: "No Background Shell or Monitor activity is running in this session." }],
			details: { action: "list", status: "listed" },
		},
	).join("\n");
	expect(list).not.toContain("Background(");
	expect(list).not.toContain("⎿");
});

test("mutation issues do not invent evidence from invocation arguments", () => {
	const { runtime, tools } = builtins();
	const write = tools.get("write");
	if (!write) throw new Error("missing Write Tool");
	const output = renderSettled(
		write,
		runtime,
		"write-error",
		{ content: "must not appear", path: "src/fail.ts" },
		{ content: [{ type: "text", text: "Operation aborted" }], details: undefined },
		{ isError: true },
	).join("\n");
	expect(output).toContain("Write(src/fail.ts)");
	expect(output).toContain("Cancelled: Operation aborted");
	expect(output).not.toContain("must not appear");
});

test("Operation Blocks keep a non-empty protocol identity when arguments omit one", () => {
	const builtinsRegistration = builtins();
	const write = builtinsRegistration.tools.get("write");
	if (!write) throw new Error("missing Write Tool");
	expect(
		renderSettled(
			write,
			builtinsRegistration.runtime,
			"write-call",
			{ content: "verified" },
			{ content: [{ type: "text", text: "written" }], details: undefined },
		).join("\n"),
	).toContain("Write(write-call)");

	const codexRegistration = toolRegistrationHarness();
	registerCodexTools(codexRegistration.host);
	const patch = codexRegistration.tools.get("apply_patch");
	if (!patch) throw new Error("missing Patch Tool");
	expect(
		renderSettled(
			patch,
			getToolUiRuntime(codexRegistration.host),
			"patch-call",
			{},
			{ content: [{ type: "text", text: "patched" }], details: {} },
		).join("\n"),
	).toContain("Patch(patch-call)");

	const workRegistration = toolRegistrationHarness();
	registerWorkTools(workRegistration.host, { current: () => undefined }, { includeBash: false });
	const background = workRegistration.tools.get("background");
	if (!background) throw new Error("missing Background Tool");
	expect(
		renderSettled(
			background,
			getToolUiRuntime(workRegistration.host),
			"background-call",
			{ action: "output" },
			{ content: [{ type: "text", text: "output" }], details: { action: "output", status: "read" } },
		).join("\n"),
	).toContain("Background(background-call)");
});

test("every new Operation Block member materializes while running and names terminal issue kinds", () => {
	const builtinRegistration = builtins();
	const codexRegistration = toolRegistrationHarness();
	registerCodexTools(codexRegistration.host);
	const workRegistration = toolRegistrationHarness();
	registerWorkTools(workRegistration.host, { current: () => undefined }, { includeBash: false });
	const cases = [
		{
			args: { content: "verified only after success", path: "src/write.ts" },
			header: "Write(src/write.ts)",
			running: "Writing…",
			runtime: builtinRegistration.runtime,
			tool: builtinRegistration.tools.get("write"),
		},
		{
			args: { edits: [{ newText: "new", oldText: "old" }], path: "src/edit.ts" },
			header: "Edit(src/edit.ts)",
			running: "Editing…",
			runtime: builtinRegistration.runtime,
			tool: builtinRegistration.tools.get("edit"),
		},
		{
			args: { input: "*** Begin Patch\n*** Update File: src/patch.ts\n@@\n-old\n+new\n*** End Patch" },
			header: "Patch(src/patch.ts)",
			running: "Applying…",
			runtime: getToolUiRuntime(codexRegistration.host),
			tool: codexRegistration.tools.get("apply_patch"),
		},
		{
			args: { action: "output", task_id: "shell-9" },
			header: "Background(shell-9)",
			running: "Reading output…",
			runtime: getToolUiRuntime(workRegistration.host),
			tool: workRegistration.tools.get("background"),
		},
	] as const;
	for (const [caseIndex, fixture] of cases.entries()) {
		if (!fixture.tool) throw new Error(`missing Operation Block Tool ${String(caseIndex)}`);
		const running = renderRunning(fixture.tool, fixture.runtime, `running-${String(caseIndex)}`, fixture.args);
		expect(running).toContain(fixture.header);
		expect(running).toContain(fixture.running);
		for (const [issueIndex, issue] of [
			{ prefix: "Error:", text: "Permission denied" },
			{ prefix: "Rejected:", text: "Tool execution was blocked by policy" },
			{ prefix: "Cancelled:", text: "Operation aborted" },
		].entries()) {
			const output = renderSettled(
				fixture.tool,
				fixture.runtime,
				`issue-${String(caseIndex)}-${String(issueIndex)}`,
				fixture.args,
				{ content: [{ type: "text", text: issue.text }], details: undefined },
				{ isError: true },
			).join("\n");
			expect(output).toContain(fixture.header);
			expect(output).toContain(`${issue.prefix} ${issue.text}`);
			expect(output).not.toContain("verified only after success");
		}
	}
});
