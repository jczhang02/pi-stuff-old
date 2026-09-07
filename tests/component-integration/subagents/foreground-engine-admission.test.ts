import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	agent,
	cleanupForegroundEngineFixtures,
	context,
	createExtensionApi,
	type executeAsyncSingle,
	executor,
	fs,
	os,
	path,
	setupForegroundEngineFixtures,
	state,
	temporaryDirectories,
	toolInfo,
} from "../../agents/foreground-engine-fixtures.js";

beforeEach(setupForegroundEngineFixtures);
afterEach(cleanupForegroundEngineFixtures);

test("accounts for resolved skill metadata before creating a fork session", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-fork-skill-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const skillRoot = path.join(cwd, "skills");
	const skillName = `large-skill-${path.basename(cwd)}`;
	const skillDirectory = path.join(skillRoot, skillName);
	fs.mkdirSync(skillDirectory, { recursive: true });
	fs.writeFileSync(
		path.join(skillDirectory, "SKILL.md"),
		`---\ndescription: ${"x".repeat(20_000)}\n---\nInstructions\n`,
	);
	let openSessionCalls = 0;
	const ctx = context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }], 500);
	ctx.sessionManager.openSession = () => {
		openSessionCalls += 1;
		return { createBranchedSession: () => path.join(cwd, "child.jsonl") };
	};
	const result = await executor(cwd, state(), undefined, {
		agent: {
			...agent(),
			model: "test/small",
			skills: [skillName],
			skillPath: [skillRoot],
		},
	}).execute(
		"skill-overflow-fork-call",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		ctx,
	);

	expect(result.isError).toBe(true);
	expect(openSessionCalls).toBe(0);
});

test("accounts for the Host system prompt before admitting a child launch", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-host-prompt-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const ctx = context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }], 100);
	ctx.getSystemPrompt = () => "p".repeat(20_000);
	let engineCalls = 0;

	const result = await executor(
		cwd,
		state(),
		() => {
			engineCalls += 1;
		},
		{ agent: { ...agent(), model: "test/small" } },
	).execute(
		"host-prompt-overflow",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		ctx,
	);

	expect(result.isError).toBeTrue();
	expect(engineCalls).toBe(0);
});

test("accounts for the selected tool schema before admitting a child launch", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-tool-schema-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let engineCalls = 0;
	const pi = createExtensionApi({
		getActiveTools: () => ["read"],
		getAllTools: () => [
			toolInfo({
				name: "read",
				description: "Read a file.",
				parameters: { type: "object", properties: { path: { type: "string" } } },
				promptGuidelines: ["s".repeat(20_000)],
			}),
		],
	});

	const result = await executor(
		cwd,
		state(),
		() => {
			engineCalls += 1;
		},
		{ agent: { ...agent(), model: "test/small", tools: ["read"] }, pi },
	).execute(
		"tool-schema-overflow",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }], 100),
	);

	expect(result.isError).toBeTrue();
	expect(engineCalls).toBe(0);
});

test("accounts for the read Tool forced into a skill-enabled child", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-skill-read-tool-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const skillRoot = path.join(cwd, "skills");
	const skillName = "small-skill";
	fs.mkdirSync(path.join(skillRoot, skillName), { recursive: true });
	fs.writeFileSync(path.join(skillRoot, skillName, "SKILL.md"), "---\ndescription: Small skill\n---\nUse it.\n");
	let engineCalls = 0;
	const pi = createExtensionApi({
		getActiveTools: () => ["write"],
		getAllTools: () => [
			toolInfo({ name: "write", description: "Write.", parameters: {} }),
			toolInfo({
				name: "read",
				description: "Read.",
				parameters: {},
				promptGuidelines: ["r".repeat(20_000)],
			}),
		],
	});

	const result = await executor(
		cwd,
		state(),
		() => {
			engineCalls += 1;
		},
		{
			agent: {
				...agent(),
				model: "test/small",
				tools: ["write"],
				skills: [skillName],
				skillPath: [skillRoot],
			},
			pi,
		},
	).execute(
		"skill-read-tool-overflow",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }], 100),
	);

	expect(result.isError).toBeTrue();
	expect(engineCalls).toBe(0);
});

test("does not charge a replaced Host base prompt when inherited context and Skills are disabled", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-replace-prompt-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const ctx = context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }], 100);
	ctx.getSystemPrompt = () => "parent".repeat(4_000);
	let engineCalls = 0;

	const result = await executor(
		cwd,
		state(),
		() => {
			engineCalls += 1;
		},
		{
			agent: {
				...agent(),
				model: "test/small",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
			},
		},
	).execute(
		"replace-prompt-fits",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		ctx,
	);

	expect(result.isError).not.toBeTrue();
	expect(engineCalls).toBe(1);
});

test("projects a replace-mode fork when retained project context makes the raw child too large", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-replace-context-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const ctx = context(cwd, [{ provider: "test", id: "large", contextWindow: 32_000, maxTokens: 4_000 }], 17_000);
	ctx.getSystemPrompt = () => "default base".repeat(20_000);
	ctx.getSystemPromptOptions = () => ({
		cwd,
		customPrompt: "default base".repeat(20_000),
		contextFiles: [{ path: path.join(cwd, "AGENTS.md"), content: "p".repeat(4_000) }],
		skills: [],
	});
	let openSessionCalls = 0;
	ctx.sessionManager.openSession = () => {
		openSessionCalls += 1;
		return { createBranchedSession: () => path.join(cwd, "child.jsonl") };
	};
	let captured: Parameters<typeof executeAsyncSingle>[1] | undefined;
	let projectionCalls = 0;

	const result = await executor(
		cwd,
		state(),
		(launch) => {
			captured = launch;
		},
		{
			agent: { ...agent(), model: "test/large", systemPromptMode: "replace" },
			projectContext: async () => {
				projectionCalls += 1;
				return { source: "magic-context", text: "bounded parent", truncated: true };
			},
		},
	).execute(
		"replace-context-projects",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		ctx,
	);

	expect(result.isError).not.toBeTrue();
	expect(openSessionCalls).toBe(0);
	expect(projectionCalls).toBe(1);
	expect(captured?.sessionFile).toBeUndefined();
	expect(captured?.task).toContain("bounded parent");
});

test("accounts for replace-mode project context from the child's actual cwd", async () => {
	const parentCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-parent-cwd-"));
	const childCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-child-cwd-"));
	temporaryDirectories.push(parentCwd, childCwd);
	fs.writeFileSync(path.join(parentCwd, "parent.jsonl"), "");
	fs.writeFileSync(path.join(parentCwd, "AGENTS.md"), "small parent rule");
	fs.writeFileSync(path.join(childCwd, "AGENTS.md"), `large child rule\n${"x".repeat(9_000)}`);
	const ctx = context(parentCwd, [{ provider: "test", id: "large", contextWindow: 32_000, maxTokens: 4_000 }], 13_000);
	ctx.getSystemPromptOptions = () => ({
		cwd: parentCwd,
		contextFiles: [{ path: path.join(parentCwd, "AGENTS.md"), content: "small parent rule" }],
		skills: [],
	});
	let openSessionCalls = 0;
	ctx.sessionManager.openSession = () => {
		openSessionCalls += 1;
		return { createBranchedSession: () => path.join(parentCwd, "child.jsonl") };
	};
	let projectionCalls = 0;
	let captured: Parameters<typeof executeAsyncSingle>[1] | undefined;

	const result = await executor(
		parentCwd,
		state(),
		(launch) => {
			captured = launch;
		},
		{
			agent: {
				...agent(),
				model: "test/large",
				systemPromptMode: "replace",
				inheritSkills: false,
			},
			projectContext: async () => {
				projectionCalls += 1;
				return { source: "magic-context", text: "bounded parent", truncated: true };
			},
		},
	).execute(
		"replace-child-cwd-projects",
		{ agent: "general-purpose", context: "fork", cwd: childCwd, task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		ctx,
	);

	expect(result.isError).not.toBeTrue();
	expect(openSessionCalls).toBe(0);
	expect(projectionCalls).toBe(1);
	expect(captured?.sessionFile).toBeUndefined();
	expect(captured?.task).toContain("bounded parent");
});

test("supports one native and one projected child in the same parallel fork", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-fork-parallel-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let openSessionCalls = 0;
	const ctx = context(
		cwd,
		[
			{ provider: "test", id: "large", contextWindow: 128_000, maxTokens: 8_000 },
			{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 },
		],
		7_000,
	);
	ctx.sessionManager.openSession = () => {
		openSessionCalls += 1;
		return {
			createBranchedSession: () => {
				const child = path.join(cwd, "child.jsonl");
				fs.writeFileSync(child, "");
				return child;
			},
		};
	};
	const runState = state();
	const result = await executor(cwd, runState, undefined, {
		agent: { ...agent(), model: "test/small" },
		projectContext: async () => ({ source: "magic-context", text: "bounded parent", truncated: true }),
	}).execute(
		"parallel-oversized-fork-call",
		{
			async: false,
			context: "fork",
			tasks: [
				{ agent: "general-purpose", model: "test/large", task: "Fits" },
				{ agent: "general-purpose", model: "test/small", task: "Does not fit" },
			],
		},
		new AbortController().signal,
		undefined,
		ctx,
	);

	expect(result.isError).not.toBe(true);
	expect(openSessionCalls).toBe(1);
	expect(runState.foregroundRuns?.size).toBe(1);
});

test("launches without a projection when model limits are unknown", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-context-unknown-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let projections = 0;
	let captured: { task: string } | undefined;
	await executor(
		cwd,
		state(),
		(launch) => {
			captured = launch;
		},
		{
			projectContext: async () => {
				projections++;
				throw new Error("projection should not be requested");
			},
		},
	).execute(
		"unknown-budget-call",
		{ agent: "general-purpose", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	expect(projections).toBe(0);
	expect(captured?.task).toBe("Inspect the parser");
});

test("launches without a projection when Context fails open", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-context-failure-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let projections = 0;
	let captured: { task: string } | undefined;
	await executor(
		cwd,
		state(),
		(launch) => {
			captured = launch;
		},
		{
			agent: { ...agent(), model: "test/small" },
			projectContext: async () => {
				projections++;
				throw new Error("Magic unavailable");
			},
		},
	).execute(
		"failed-projection-call",
		{ agent: "general-purpose", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }]),
	);

	expect(projections).toBe(1);
	expect(captured?.task).toBe("Inspect the parser");
});
