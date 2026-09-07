import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	agent,
	cleanupForegroundEngineFixtures,
	context,
	deriveLaunchRunId,
	type executeAsyncSingle,
	executor,
	fs,
	os,
	path,
	setupForegroundEngineFixtures,
	state,
	TEMP_ROOT_DIR,
	temporaryDirectories,
	userEntry,
} from "../../agents/foreground-engine-fixtures.js";

beforeEach(setupForegroundEngineFixtures);
afterEach(cleanupForegroundEngineFixtures);

test("parallel foreground execution completes as one bounded group", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-parallel-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const runState = state();
	const result = await executor(cwd, runState).execute(
		"parallel-call",
		{
			async: false,
			context: "fresh",
			tasks: [
				{ agent: "general-purpose", task: "Implement" },
				{ agent: "general-purpose", task: "Review" },
			],
		},
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	expect(result.isError).not.toBe(true);
	expect(result.details.mode).toBe("parallel");
	expect(result.details.results.map((child) => child.finalOutput)).toEqual(["result-1", "result-2"]);
});

test("fits the private Context projection to the tightest child fallback model", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-context-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let captured: Parameters<typeof executeAsyncSingle>[1] | undefined;
	const requestedBudgets: number[] = [];
	const smallAgent = { ...agent(), model: "test/large", fallbackModels: ["test/small"] };
	await executor(
		cwd,
		state(),
		(launch) => {
			captured = launch;
		},
		{
			agent: smallAgent,
			projectContext: async (_audience, _ctx, projectionOptions) => {
				requestedBudgets.push(projectionOptions?.maxTokens ?? -1);
				return {
					source: "magic-context",
					text: '<pi-stuff-context trust="reference-only">memory</pi-stuff-context>',
					truncated: false,
				};
			},
		},
	).execute(
		"context-call",
		{
			agent: "general-purpose",
			context: "fresh",
			task: "Inspect the parser",
		},
		new AbortController().signal,
		undefined,
		context(cwd, [
			{ provider: "test", id: "large", contextWindow: 128_000, maxTokens: 8_000 },
			{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 },
		]),
	);

	expect(requestedBudgets).toHaveLength(1);
	expect(requestedBudgets[0]).toBeGreaterThan(0);
	expect(requestedBudgets[0]).toBeLessThanOrEqual(4_000);
	expect(captured?.task).toBe(
		'<pi-stuff-context trust="reference-only">memory</pi-stuff-context>\n\nInspect the parser',
	);
});

test("uses a native raw fork when the parent history fits without adding duplicate projection", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-context-fork-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const requestedBudgets: number[] = [];
	let captured: Parameters<typeof executeAsyncSingle>[1] | undefined;
	let openSessionCalls = 0;
	const ctx = context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }], 3_500);
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
	await executor(cwd, state(), (launch) => (captured = launch), {
		agent: { ...agent(), model: "test/small" },
		projectContext: async (_audience, _ctx, projectionOptions) => {
			requestedBudgets.push(projectionOptions?.maxTokens ?? -1);
			return { source: "magic-context", text: "memory", truncated: false };
		},
	}).execute(
		"fork-budget-call",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		ctx,
	);

	expect(requestedBudgets).toHaveLength(0);
	expect(openSessionCalls).toBe(1);
	expect(captured?.sessionFile).toBe(path.join(cwd, "child.jsonl"));
	expect(captured?.task).not.toContain("memory");
});

test("converts an oversized raw fork into a bounded projected fork without cloning history", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-fork-too-large-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let captured: Parameters<typeof executeAsyncSingle>[1] | undefined;
	let openSessionCalls = 0;
	const ctx = context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }], 7_000);
	ctx.sessionManager.openSession = () => {
		openSessionCalls += 1;
		return { createBranchedSession: () => path.join(cwd, "child.jsonl") };
	};
	let frozenProjectionMessages: readonly unknown[] | undefined;
	const result = await executor(
		cwd,
		state(),
		(launch) => {
			captured = launch;
		},
		{
			agent: { ...agent(), model: "test/small" },
			projectContext: async (_audience, _context, options) => {
				frozenProjectionMessages = options?.sourceMessages;
				return {
					source: "magic-context",
					text: `<bounded max="${String(options?.maxTokens)}">parent memory</bounded>`,
					truncated: true,
				};
			},
		},
	).execute(
		"oversized-fork-call",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		ctx,
	);

	expect(result.isError).not.toBe(true);
	expect(openSessionCalls).toBe(0);
	expect(fs.existsSync(path.join(cwd, "child.jsonl"))).toBeFalse();
	expect(captured?.sessionFile).toBeUndefined();
	expect(captured?.task).toContain("parent memory");
	expect(captured?.task).toContain("delegated subagent running from a fork");
	expect(frozenProjectionMessages).toEqual([]);
});

test("projects multilingual parent history instead of admitting an overflowing raw fork", async () => {
	for (const { label, history } of [
		{ label: "cjk", history: "上下文".repeat(1_500) },
		{ label: "emoji", history: "🧭".repeat(2_100) },
	]) {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-stuff-parent-${label}-`));
		temporaryDirectories.push(cwd);
		fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
		const ctx = context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }], 100);
		ctx.sessionManager.buildContextEntries = () => [userEntry(history)];
		let openSessionCalls = 0;
		ctx.sessionManager.openSession = () => {
			openSessionCalls += 1;
			return { createBranchedSession: () => path.join(cwd, "child.jsonl") };
		};
		let projectedSource = "";

		const result = await executor(cwd, state(), undefined, {
			agent: { ...agent(), model: "test/small" },
			projectContext: async (_audience, _context, options) => {
				projectedSource = JSON.stringify(options?.sourceMessages ?? []);
				return { source: "native", text: "bounded multilingual history", truncated: true };
			},
		}).execute(
			`parent-${label}`,
			{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
			new AbortController().signal,
			undefined,
			ctx,
		);

		expect(result.isError, label).not.toBeTrue();
		expect(openSessionCalls, label).toBe(0);
		expect(projectedSource, label).toContain(history.slice(0, 4));
	}
});

test("conservatively preflights multilingual and high-entropy fork inputs", async () => {
	const cases = [
		{ label: "Chinese", task: "界".repeat(4_100) },
		{ label: "rare-CJK", task: "𠮷".repeat(2_000) },
		{ label: "emoji", task: "🧭".repeat(2_050) },
		{ label: "mixed", task: `${"界".repeat(2_000)}${"a".repeat(8_000)}` },
		{ label: "Base64", task: "AP6Zz9+/0f3cD7aQ".repeat(400) },
	];
	for (const { label, task } of cases) {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-stuff-foreground-${label.toLowerCase()}-`));
		temporaryDirectories.push(cwd);
		fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
		let engineCalls = 0;
		const result = await executor(
			cwd,
			state(),
			() => {
				engineCalls += 1;
			},
			{ agent: { ...agent(), model: "test/small" } },
		).execute(
			`multilingual-${label}`,
			{ agent: "general-purpose", context: "fork", task },
			new AbortController().signal,
			undefined,
			context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }], 0),
		);

		expect(result.isError, label).toBe(true);
		expect(engineCalls, label).toBe(0);
	}
});

test("does not bind or leave runtime state when foreground preflight fails", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-preflight-clean-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const callId = `unknown-${Date.now()}-${Math.random()}`;
	const runId = deriveLaunchRunId(callId, { sessionId: cwd, ownerAgentPath: [] });
	let binds = 0;
	const result = await executor(cwd, state(), undefined, { agents: [] }).execute(
		callId,
		{ agent: "missing", task: "Never launch", async: false },
		new AbortController().signal,
		undefined,
		context(cwd),
		{
			beforeForegroundStart: () => {
				binds += 1;
			},
		},
	);

	expect(result.isError).toBe(true);
	expect(result.content[0]).toEqual({ type: "text", text: "Unknown Agent: missing" });
	expect(binds).toBe(0);
	expect(fs.existsSync(path.join(TEMP_ROOT_DIR, "foreground-runs", runId))).toBeFalse();
	expect(fs.existsSync(path.join(cwd, "sessions", runId))).toBeFalse();
});

test("does not bind or commit runtime state when foreground launch is already cancelled", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-pre-abort-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const callId = `pre-abort-${Date.now()}-${Math.random()}`;
	const runId = deriveLaunchRunId(callId, { sessionId: cwd, ownerAgentPath: [] });
	const controller = new AbortController();
	controller.abort();
	let binds = 0;

	const result = await executor(cwd, state()).execute(
		callId,
		{ agent: "general-purpose", task: "Never launch", async: false },
		controller.signal,
		undefined,
		context(cwd),
		{
			beforeForegroundStart: () => {
				binds += 1;
			},
		},
	);

	expect(result).toMatchObject({ isError: true, details: { stopped: true, results: [] } });
	expect(binds).toBe(0);
	expect(fs.existsSync(path.join(TEMP_ROOT_DIR, "foreground-runs", runId))).toBeFalse();
});

test("removes a newly prepared foreground directory when governor binding fails", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-bind-clean-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const callId = `bind-failure-${Date.now()}-${Math.random()}`;
	const runId = deriveLaunchRunId(callId, { sessionId: cwd, ownerAgentPath: [] });
	const result = await executor(cwd, state()).execute(
		callId,
		{ agent: "general-purpose", task: "Never launch", async: false },
		new AbortController().signal,
		undefined,
		context(cwd),
		{ beforeForegroundStart: () => Promise.reject(new Error("injected governor EIO")) },
	);

	expect(result.isError).toBe(true);
	expect(fs.existsSync(path.join(TEMP_ROOT_DIR, "foreground-runs", runId))).toBeFalse();
	expect(fs.existsSync(path.join(cwd, "sessions", runId))).toBeFalse();
});

test("retires an unused nested route when the foreground engine throws before durable work starts", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-started-route-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let routeDirectory: string | undefined;
	const result = await executor(cwd, state(), undefined, {
		foregroundError: new Error("injected engine failure after start"),
		onForegroundConfig: (config) => {
			routeDirectory = config.nestedRoute ? path.dirname(config.nestedRoute.eventSink) : undefined;
			if (routeDirectory) temporaryDirectories.push(routeDirectory);
		},
	}).execute(
		`started-route-${Date.now()}-${Math.random()}`,
		{ agent: "general-purpose", task: "Start then fail", async: false },
		new AbortController().signal,
		undefined,
		context(cwd),
		{ beforeForegroundStart: () => {} },
	);

	expect(result.isError).toBe(true);
	expect(routeDirectory).toBeDefined();
	expect(fs.existsSync(routeDirectory ?? "")).toBeFalse();
});

test("preserves a colliding foreground runtime instead of overwriting or deleting its evidence", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-collision-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const callId = `collision-${Date.now()}-${Math.random()}`;
	const runId = deriveLaunchRunId(callId, { sessionId: cwd, ownerAgentPath: [] });
	const runtimeDir = path.join(TEMP_ROOT_DIR, "foreground-runs", runId);
	fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
	temporaryDirectories.push(runtimeDir);
	const sentinel = path.join(runtimeDir, "live-recovery-evidence.json");
	fs.writeFileSync(sentinel, JSON.stringify({ state: "running", pid: process.pid }), { mode: 0o600 });
	let binds = 0;

	const result = await executor(cwd, state()).execute(
		callId,
		{ agent: "general-purpose", task: "Must not launch", async: false },
		new AbortController().signal,
		undefined,
		context(cwd),
		{
			beforeForegroundStart: () => {
				binds += 1;
			},
		},
	);

	expect(result.isError).toBe(true);
	expect(result.content[0]).toMatchObject({ text: expect.stringContaining("refusing to overwrite") });
	expect(binds).toBe(0);
	expect(JSON.parse(fs.readFileSync(sentinel, "utf8"))).toEqual({ state: "running", pid: process.pid });
});

test("allows fresh context at the same parent usage because it does not clone the branch", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-fresh-large-parent-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let engineCalls = 0;
	const result = await executor(
		cwd,
		state(),
		() => {
			engineCalls += 1;
		},
		{ agent: { ...agent(), model: "test/small" } },
	).execute(
		"large-parent-fresh-call",
		{ agent: "general-purpose", context: "fresh", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }], 7_000),
	);

	expect(result.isError).not.toBe(true);
	expect(engineCalls).toBe(1);
});

test("uses one projected fork so heterogeneous fallback candidates keep their order", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-fork-filter-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let captured: Parameters<typeof executeAsyncSingle>[1] | undefined;
	const result = await executor(
		cwd,
		state(),
		(launch) => {
			captured = launch;
		},
		{
			agent: { ...agent(), model: "test/large", fallbackModels: ["test/small"] },
			projectContext: async () => ({ source: "native", text: "bounded parent", truncated: true }),
		},
	).execute(
		"fork-filter-call",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		context(
			cwd,
			[
				{ provider: "test", id: "large", contextWindow: 128_000, maxTokens: 8_000 },
				{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 },
			],
			7_000,
		),
	);

	expect(result.isError).not.toBe(true);
	expect(captured?.modelCandidates).toEqual(["test/large", "test/small"]);
	expect(captured?.sessionFile).toBeUndefined();
	expect(captured?.task).toContain("bounded parent");
});

test("uses the persisted branch estimator to avoid cloning an oversized raw branch", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-fork-estimate-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let engineCalls = 0;
	const ctx = context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }]);
	ctx.sessionManager.buildContextEntries = () => [userEntry("x".repeat(80_000))];
	const result = await executor(
		cwd,
		state(),
		() => {
			engineCalls += 1;
		},
		{ agent: { ...agent(), model: "test/small" } },
	).execute(
		"estimated-fork-call",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		ctx,
	);

	expect(result.isError).not.toBe(true);
	expect(engineCalls).toBe(1);
});

test("does not mistake Magic Context's effective usage for the larger persisted raw branch", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-fork-effective-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let captured: Parameters<typeof executeAsyncSingle>[1] | undefined;
	let openSessionCalls = 0;
	const ctx = context(cwd, [{ provider: "test", id: "large", contextWindow: 128_000, maxTokens: 8_000 }], 70_000);
	ctx.sessionManager.buildContextEntries = () => [userEntry("x".repeat(2_000_000))];
	ctx.sessionManager.openSession = () => {
		openSessionCalls += 1;
		return { createBranchedSession: () => path.join(cwd, "child.jsonl") };
	};
	const result = await executor(
		cwd,
		state(),
		(launch) => {
			captured = launch;
		},
		{
			agent: { ...agent(), model: "test/large" },
			projectContext: async () => ({
				source: "magic-context",
				text: "bounded managed history",
				truncated: true,
			}),
		},
	).execute(
		"effective-fork-call",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		ctx,
	);

	expect(result.isError).not.toBe(true);
	expect(openSessionCalls).toBe(0);
	expect(captured?.sessionFile).toBeUndefined();
	expect(captured?.task).toContain("bounded managed history");
});

test("uses a bounded projection when the persisted raw branch cannot be measured", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-fork-unmeasured-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let captured: Parameters<typeof executeAsyncSingle>[1] | undefined;
	let openSessionCalls = 0;
	const ctx = context(cwd, [{ provider: "test", id: "small", contextWindow: 8_000, maxTokens: 2_000 }], 500);
	ctx.sessionManager.buildContextEntries = () => {
		throw new Error("injected branch read failure");
	};
	ctx.sessionManager.openSession = () => {
		openSessionCalls += 1;
		return { createBranchedSession: () => path.join(cwd, "child.jsonl") };
	};

	const result = await executor(
		cwd,
		state(),
		(launch) => {
			captured = launch;
		},
		{
			agent: { ...agent(), model: "test/small" },
			projectContext: async () => ({
				source: "magic-context",
				text: "bounded fallback history",
				truncated: true,
			}),
		},
	).execute(
		"unmeasured-fork-call",
		{ agent: "general-purpose", context: "fork", task: "Inspect the parser" },
		new AbortController().signal,
		undefined,
		ctx,
	);

	expect(result.isError).not.toBe(true);
	expect(openSessionCalls).toBe(0);
	expect(captured?.sessionFile).toBeUndefined();
	expect(captured?.task).toContain("bounded fallback history");
});
