import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type BashToolOptions,
	createBashToolDefinition,
	createReadToolDefinition,
	type ReadToolOptions,
} from "@earendil-works/pi-coding-agent";
import {
	registerBuiltins,
	resolveBuiltinHostSettings,
} from "../../../packages/pi-stuff/src/tool-display/builtin-tools.js";
import {
	getToolUiRuntime,
	type SuiteToolEnvelopeOperation,
} from "../../../packages/pi-stuff/src/tool-display/contract.js";
import { toolRegistrationHarness } from "../../fixtures/tool-registration-host.js";

test("built-in overrides receive Pi's merged image and shell settings exactly", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-builtin-settings-"));
	const agentDirectory = join(directory, "agent");
	const projectDirectory = join(directory, "project");
	mkdirSync(join(projectDirectory, ".pi"), { recursive: true });
	mkdirSync(agentDirectory, { recursive: true });
	writeFileSync(
		join(agentDirectory, "settings.json"),
		JSON.stringify({ images: { autoResize: false }, shellPath: "/bin/sh" }),
	);
	writeFileSync(
		join(projectDirectory, ".pi", "settings.json"),
		JSON.stringify({ shellCommandPrefix: "printf project-prefix;" }),
	);

	try {
		const untrusted = resolveBuiltinHostSettings(projectDirectory, false, agentDirectory);
		expect(untrusted).toEqual({
			autoResizeImages: false,
			shellCommandPrefix: undefined,
			shellPath: "/bin/sh",
		});
		const trusted = resolveBuiltinHostSettings(projectDirectory, true, agentDirectory);
		expect(trusted).toEqual({
			autoResizeImages: false,
			shellCommandPrefix: "printf project-prefix;",
			shellPath: "/bin/sh",
		});

		let readOptions: ReadToolOptions | undefined;
		let bashOptions: BashToolOptions | undefined;
		const { host: pi, tools } = toolRegistrationHarness();
		registerBuiltins(pi, projectDirectory, trusted, {
			bash: (cwd, options) => {
				bashOptions = options;
				return createBashToolDefinition(cwd, options);
			},
			read: (cwd, options) => {
				readOptions = options;
				return createReadToolDefinition(cwd, options);
			},
		});

		expect(readOptions).toMatchObject({ autoResizeImages: false });
		expect(bashOptions).toMatchObject({ commandPrefix: "printf project-prefix;", shellPath: "/bin/sh" });
		expect([...tools.keys()].sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
	} finally {
		rmSync(directory, { force: true, recursive: true });
	}
});

test("shell prefixes do not leak into standalone Bash operation titles", () => {
	const { host: pi, tools } = toolRegistrationHarness();
	registerBuiltins(pi, "/project", {
		autoResizeImages: true,
		shellCommandPrefix: "printf prefix",
		shellPath: undefined,
	});
	const runtime = getToolUiRuntime(pi);
	runtime.indexMessages([
		{
			role: "assistant",
			content: [
				{ type: "toolCall", id: "bash-prefix-1", name: "bash", arguments: { command: "pwd" } },
				{ type: "toolCall", id: "bash-prefix-2", name: "bash", arguments: { command: "pwd" } },
			],
		},
		{ role: "toolResult", toolCallId: "bash-prefix-1", content: [{ type: "text", text: "/project" }] },
		{ role: "toolResult", toolCallId: "bash-prefix-2", content: [{ type: "text", text: "/project" }] },
	]);
	const bash = tools.get("bash");
	if (!bash?.renderCall || !bash.renderResult) throw new Error("Expected decorated Bash renderers");
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const theme = { bold: (value: string) => value, fg: (_color: string, value: string) => value } as never;
	const settle = (toolCallId: string) => {
		const state = {};
		const args = { command: "pwd" };
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		const context = {
			args,
			executionStarted: false,
			invalidate: () => {},
			isError: false,
			lastComponent: undefined,
			state,
			toolCallId,
		} as never;
		const row = bash.renderCall?.(args, theme, context);
		bash.renderResult?.(
			{ content: [{ type: "text", text: "/project\n" }], details: undefined },
			{ expanded: false, isPartial: false },
			theme,
			context,
		);
		return row?.render(80).join("\n") ?? "";
	};
	const first = settle("bash-prefix-1");
	expect(first).toContain("Bash(pwd)");
	expect(first).not.toContain("printf prefix");
	const second = settle("bash-prefix-2");
	expect(second).toContain("Bash(pwd)");
	expect(second).not.toContain("printf prefix");
	runtime.clear();
});

test("built-in retrieval metadata deduplicates Read paths but counts Search and List calls", () => {
	const { host: pi } = toolRegistrationHarness();
	registerBuiltins(pi, "/project", {
		autoResizeImages: true,
		shellCommandPrefix: undefined,
		shellPath: undefined,
	});
	const runtime = getToolUiRuntime(pi);
	const calls = [
		{ type: "toolCall", id: "r1", name: "read", arguments: { path: "./a.ts" } },
		{ type: "toolCall", id: "r2", name: "read", arguments: { path: "/project/a.ts" } },
		{ type: "toolCall", id: "g1", name: "grep", arguments: { pattern: "needle", path: "." } },
		{ type: "toolCall", id: "g2", name: "grep", arguments: { pattern: "needle", path: "." } },
		{ type: "toolCall", id: "l1", name: "ls", arguments: { path: "." } },
		{ type: "toolCall", id: "l2", name: "ls", arguments: { path: "." } },
	];
	runtime.indexMessages(
		[
			{ role: "assistant", content: calls },
			...calls.map((call) => ({
				role: "toolResult",
				toolCallId: call.id,
				content: [{ type: "text", text: "ok" }],
				details: {},
			})),
		],
		true,
	);
	expect(runtime.resolveGroup("r1")).toMatchObject({
		memberIds: ["r1", "r2", "g1", "g2", "l1", "l2"],
		summary: "Searched 2 patterns, read 1 file, listed 2 directories",
	});
	runtime.clear();
});

test("exact SKILL.md reads present one standalone Skill activity with Read evidence", () => {
	const { host: pi } = toolRegistrationHarness();
	registerBuiltins(pi, "/project", {
		autoResizeImages: true,
		shellCommandPrefix: undefined,
		shellPath: undefined,
	});
	const runtime = getToolUiRuntime(pi);
	const calls = [
		{ type: "toolCall", id: "before", name: "read", arguments: { path: "before.ts" } },
		{ type: "toolCall", id: "skill", name: "read", arguments: { path: "skills/demo/SKILL.md" } },
		{ type: "toolCall", id: "after", name: "read", arguments: { path: "after.ts" } },
	];
	const results = [
		{ role: "toolResult", toolCallId: "before", content: [{ type: "text", text: "before" }], details: {} },
		{
			role: "toolResult",
			toolCallId: "skill",
			content: [{ type: "text", text: "# Demo\nInstructions" }],
			details: {},
		},
		{ role: "toolResult", toolCallId: "after", content: [{ type: "text", text: "after" }], details: {} },
	];

	runtime.startTurn([{ role: "assistant", content: calls }]);
	expect(runtime.resolveGroup("skill")).toMatchObject({
		label: "Skill demo",
		memberIds: ["skill"],
		outcome: "reading",
		state: "running",
		summary: "Skill demo · reading",
	});
	expect(runtime.resolveGroup("before")).toMatchObject({ memberIds: ["before"] });
	expect(runtime.resolveGroup("after")).toMatchObject({ memberIds: ["after"] });
	for (const result of results) runtime.indexMessage(result);
	runtime.endTurn();
	expect(runtime.resolveGroup("skill")).toMatchObject({ outcome: "loaded", state: "success" });
	runtime.clear();

	runtime.indexMessages([{ role: "assistant", content: calls }, ...results], true);

	expect(runtime.resolveGroup("skill")).toMatchObject({
		label: "Skill demo",
		memberIds: ["skill"],
		outcome: "loaded",
		state: "success",
		summary: "Skill demo · loaded",
	});
	expect(runtime.resolveGroup("before")).toMatchObject({ memberIds: ["before"] });
	expect(runtime.resolveGroup("after")).toMatchObject({ memberIds: ["after"] });
	const formatted = runtime.toolActivityDetail("skill", "formatted");
	expect(formatted?.activity).toMatchObject({ label: "Skill demo", name: "read", summary: "loaded" });
	expect(formatted?.sections).toEqual([{ lines: ["# Demo", "Instructions"], title: "Content" }]);
	const raw = runtime.toolActivityDetail("skill", "raw")?.lines.join("\n") ?? "";
	expect(raw).toContain("Tool name: read");
	expect(raw).toContain('{"path": "skills/demo/SKILL.md"}');
	expect(raw).toContain("# Demo");
	runtime.clear();

	let operations: readonly SuiteToolEnvelopeOperation[] = [
		{ args: { path: "skills/nested/SKILL.md" }, id: "nested-skill", name: "read", state: "running" },
	];
	runtime.registerEnvelope("codemode", () => operations);
	runtime.observeEnvelopeResult("codemode", "outer-skill", { operations });
	expect(runtime.resolveGroup("nested-skill")).toMatchObject({
		label: "Skill nested",
		outcome: "reading",
		state: "running",
	});
	operations = [
		{
			args: { path: "skills/nested/SKILL.md" },
			id: "nested-skill",
			name: "read",
			result: { content: [{ type: "text", text: "# Nested" }], details: {} },
			state: "success",
		},
	];
	runtime.observeEnvelopeResult("codemode", "outer-skill", { operations });
	expect(runtime.resolveGroup("nested-skill")).toMatchObject({
		label: "Skill nested",
		outcome: "loaded",
		state: "success",
	});
	expect(runtime.toolActivityDetail("nested-skill", "formatted")?.sections).toEqual([
		{ lines: ["# Nested"], title: "Content" },
	]);
	const nestedRaw = runtime.toolActivityDetail("nested-skill", "raw")?.lines.join("\n") ?? "";
	expect(nestedRaw).toContain("Tool name: read");
	expect(nestedRaw).toContain('{"path": "skills/nested/SKILL.md"}');
	runtime.clear();
});

test("exact SKILL.md read failures use the accepted Skill copy", () => {
	const { host: pi } = toolRegistrationHarness();
	registerBuiltins(pi, "/project", {
		autoResizeImages: true,
		shellCommandPrefix: undefined,
		shellPath: undefined,
	});
	const runtime = getToolUiRuntime(pi);
	runtime.indexMessages(
		[
			{
				role: "assistant",
				content: [
					{ type: "toolCall", id: "skill-error", name: "read", arguments: { path: "skills/demo/SKILL.md" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "skill-error",
				content: [{ type: "text", text: "ENOENT" }],
				details: {},
				isError: true,
			},
		],
		true,
	);
	expect(runtime.resolveGroup("skill-error")).toMatchObject({
		label: "Skill demo",
		outcome: "Failed to read SKILL.md",
		state: "error",
		summary: "Skill demo · Failed to read SKILL.md",
	});
});
