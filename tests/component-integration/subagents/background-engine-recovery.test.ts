import { afterEach, expect, test } from "bun:test";
import {
	agent,
	type BackgroundRunnerConfig,
	buildAsyncParallelRunnerWork,
	buildAsyncSingleRunnerWork,
	buildContext,
	buildNestedTerminalFallbackStatus,
	buildWriterProcessEnv,
	cleanupBackgroundEngineFixtures,
	createInitialStatus,
	finalizeProcessTerminal,
	fixtureRoot,
	fs,
	initializeWriterProcessRegistry,
	listAsyncRuns,
	nestedFallbackConfig,
	path,
	projectAgentDefinition,
	projectLaunchBinding,
	type RunnerAgentTask,
	readAsyncRecoveryDescriptor,
	resolveNestedTerminalStatus,
	writeProcessTerminalCandidate,
} from "../../agents/background-engine-fixtures.js";

afterEach(cleanupBackgroundEngineFixtures);

test("recovers nested semantic failure and success from the result artifact", () => {
	const root = fixtureRoot();
	const resultPath = path.join(root, "result.json");
	const config = nestedFallbackConfig(root, resultPath);
	const processTerminal = {
		version: 1 as const,
		state: "observed" as const,
		runId: "nested-fallback",
		runnerProcessInstanceId: "runner-1",
		observedAt: 2_000,
		instances: [],
	};
	fs.writeFileSync(
		resultPath,
		JSON.stringify({ state: "failed", success: false, error: "child failed", startedAt: 1_000, endedAt: 1_900 }),
	);
	expect(buildNestedTerminalFallbackStatus(config, processTerminal, 3_000)).toMatchObject({
		state: "failed",
		error: "child failed",
		startedAt: 1_000,
		endedAt: 1_900,
	});

	fs.writeFileSync(resultPath, JSON.stringify({ state: "complete", success: true, startedAt: 1_000, endedAt: 1_900 }));
	expect(buildNestedTerminalFallbackStatus(config, processTerminal, 3_000)).toMatchObject({
		state: "complete",
		startedAt: 1_000,
		endedAt: 1_900,
	});

	fs.mkdirSync(config.asyncDir, { recursive: true });
	fs.writeFileSync(path.join(config.asyncDir, "status.json"), JSON.stringify({ state: "running" }));
	expect(resolveNestedTerminalStatus(config, processTerminal)).toMatchObject({ state: "complete" });
});

test("fails conservatively instead of loading oversized nested lifecycle artifacts", () => {
	const root = fixtureRoot();
	const resultPath = path.join(root, "oversized-result.json");
	const config = nestedFallbackConfig(root, resultPath);
	const processTerminal = {
		version: 1 as const,
		state: "observed" as const,
		runId: "nested-fallback",
		runnerProcessInstanceId: "runner-1",
		observedAt: 2_000,
		instances: [],
	};
	fs.writeFileSync(resultPath, "x");
	fs.truncateSync(resultPath, 32 * 1024 * 1024 + 1);

	expect(buildNestedTerminalFallbackStatus(config, processTerminal, 3_000)).toMatchObject({
		state: "failed",
		error: expect.stringContaining("without a readable semantic result"),
	});

	fs.mkdirSync(config.asyncDir, { recursive: true });
	const statusPath = path.join(config.asyncDir, "status.json");
	fs.writeFileSync(statusPath, "x");
	fs.truncateSync(statusPath, 8 * 1024 * 1024 + 1);
	expect(resolveNestedTerminalStatus(config, processTerminal)).toMatchObject({
		state: "failed",
		error: expect.stringContaining("without a readable semantic result"),
	});
});

test("never invents a not-started child from missing, foreign, or contradictory process proof", () => {
	const root = fixtureRoot();
	for (const kind of ["missing", "foreign", "contradictory", "legacy-empty"] as const) {
		const runId = `proof-${kind}`;
		const asyncDir = path.join(root, runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify({
				runId,
				mode: "single",
				state: "failed",
				startedAt: 1_000,
				lastUpdate: 2_000,
				steps: [{ agent: "reviewer", status: "failed" }],
			}),
		);
		if (kind !== "missing") {
			const candidate: Parameters<typeof writeProcessTerminalCandidate>[1] = {
				version: 1,
				runId: kind === "foreign" ? "another-run" : runId,
				runnerProcessInstanceId: kind === "foreign" ? "another-runner" : "runner-1",
				writers: {
					"0":
						kind === "contradictory"
							? [
									{
										kind: "pi-writer",
										processInstanceId: "writer-1",
										attempt: 0,
										closeObservedAt: 1_900,
										exitCode: 1,
										signal: null,
									},
								]
							: [],
				},
			};
			if (kind !== "legacy-empty") candidate.expectedWriters = { "0": 0 };
			writeProcessTerminalCandidate(asyncDir, candidate);
		}

		finalizeProcessTerminal(asyncDir, runId, {
			processInstanceId: "runner-1",
			closeObservedAt: 2_100,
			exitCode: 1,
			signal: null,
		});
		// SAFETY: this test controls the serialized JSON fixture and exercises only the asserted fields.
		const status = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as {
			steps: Array<{ processTerminal?: { state?: string } }>;
		};
		expect(status.steps[0]?.processTerminal?.state).toBe("unknown");
	}
});

test("preserves observed per-child writer proof across async status reload", () => {
	const root = fixtureRoot();
	const runId = "proof-round-trip";
	const asyncDir = path.join(root, runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId,
			mode: "single",
			state: "failed",
			startedAt: 1_000,
			lastUpdate: 2_000,
			steps: [{ agent: "reviewer", status: "failed" }],
		}),
	);
	initializeWriterProcessRegistry(asyncDir, runId, process.pid, 1);
	writeProcessTerminalCandidate(asyncDir, {
		version: 1,
		runId,
		runnerProcessInstanceId: "runner-1",
		writers: {
			"0": [
				{
					kind: "pi-writer",
					processInstanceId: "writer-1",
					attempt: 0,
					closeObservedAt: 1_900,
					exitCode: null,
					signal: "SIGSEGV",
				},
			],
		},
		expectedWriters: { "0": 1 },
	});
	const proof = finalizeProcessTerminal(asyncDir, runId, {
		processInstanceId: "runner-1",
		closeObservedAt: 2_100,
		exitCode: 1,
		signal: null,
	});
	expect(proof.state).toBe("observed");

	const [restored] = listAsyncRuns(root, { states: ["failed"] });
	expect(restored?.steps[0]?.processTerminal).toMatchObject({
		state: "observed",
		childIndex: 0,
		instances: [{ kind: "pi-writer", signal: "SIGSEGV" }],
	});
});

test("restores a healthy async sibling when another status snapshot is corrupt", () => {
	const root = fixtureRoot();
	const corruptDir = path.join(root, "corrupt-sibling");
	const healthyDir = path.join(root, "healthy-sibling");
	fs.mkdirSync(corruptDir);
	fs.mkdirSync(healthyDir);
	fs.writeFileSync(path.join(corruptDir, "status.json"), "{not-json", "utf8");
	fs.writeFileSync(
		path.join(healthyDir, "status.json"),
		JSON.stringify({
			runId: "healthy-sibling",
			sessionId: "root-session",
			mode: "single",
			state: "running",
			pid: process.pid,
			startedAt: Date.now(),
			lastUpdate: Date.now(),
			steps: [{ agent: "reviewer", status: "running" }],
		}),
	);

	const runs = listAsyncRuns(root, { sessionId: "root-session", states: ["running"] });
	expect(runs.map((run) => run.id)).toEqual(["healthy-sibling"]);
});

test("launch evidence contains current limits but ignores retired Agent features", () => {
	const root = fixtureRoot();
	const configured = {
		...agent(root, "writer"),
		memory: { scope: "project", path: "/retired" },
		completionGuard: true,
		output: "/retired/output",
	};

	const definition = projectAgentDefinition(configured);
	const binding = projectLaunchBinding({
		definitionDigest: "definition",
		inheritProjectContext: true,
		inheritSkills: false,
		excludeTools: ["write"],
		toolBudget: { hard: 12, soft: 9, block: ["read"] },
		toolTimeoutMs: 1_500,
		maxSubagentDepth: 2,
		capabilityCeiling: { version: 1, allowedTools: ["read"] },
	});

	expect(definition.version).toBe(4);
	expect(definition).not.toHaveProperty("memory");
	expect(definition).not.toHaveProperty("completionGuard");
	expect(definition).not.toHaveProperty("output");
	expect(binding).toMatchObject({
		version: 4,
		excludeTools: ["write"],
		toolBudget: { hard: 12, soft: 9, block: ["read"] },
		toolTimeoutMs: 1_500,
		maxSubagentDepth: 2,
		capabilityCeiling: { version: 1, allowedTools: ["read"] },
	});
});

test("increments nested depth without leaking detached-runner identity", () => {
	const writerEnv = buildWriterProcessEnv(
		{
			PATH: "/bin",
			PI_SUBAGENT_DEPTH: "1",
			PI_SUBAGENT_MAX_DEPTH: "9",
			PI_STUFF_BACKGROUND_RUNNER: "1",
			PI_STUFF_BACKGROUND_RUNNER_CONFIG: "/tmp/runner.json",
		},
		{
			CHILD_SETTING: "enabled",
			PI_SUBAGENT_DEPTH: "99",
			PI_SUBAGENT_MAX_DEPTH: "99",
			PI_STUFF_BACKGROUND_RUNNER: "1",
			PI_STUFF_BACKGROUND_RUNNER_CONFIG: "/tmp/override.json",
		},
		3,
	);

	expect(writerEnv["PATH"]).toBe("/bin");
	expect(writerEnv["CHILD_SETTING"]).toBe("enabled");
	expect(writerEnv["PI_SUBAGENT_DEPTH"]).toBe("2");
	expect(writerEnv["PI_SUBAGENT_MAX_DEPTH"]).toBe("3");
	expect(writerEnv["PI_STUFF_BACKGROUND_RUNNER"]).toBeUndefined();
	expect(writerEnv["PI_STUFF_BACKGROUND_RUNNER_CONFIG"]).toBeUndefined();
});

test("creates a runnable lifecycle status before child launch", () => {
	const root = fixtureRoot();
	const startedAt = 123_456;
	const task: RunnerAgentTask = {
		agent: "writer",
		description: "Implement parser change",
		task: "Implement",
		cwd: root,
		context: "fresh",
		systemPrompt: "You are writer.",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: false,
		maxSubagentDepth: 1,
	};
	const config: BackgroundRunnerConfig = {
		version: 2,
		id: "runtime-status",
		parentRunOrigin: "user",
		cwd: root,
		asyncDir: path.join(root, "async"),
		resultPath: path.join(root, "result.json"),
		work: { mode: "single", task },
	};

	const status = createInitialStatus(config, startedAt);

	expect(status.lifecycleArtifactVersion).toBe(3);
	expect(status.runId).toBe("runtime-status");
	expect(status.parentRunOrigin).toBe("user");
	expect(status.state).toBe("running");
	expect(status.steps).toHaveLength(1);
	expect(status.steps[0]).toMatchObject({
		agent: "writer",
		label: "Implement parser change",
		status: "pending",
		task: "Implement",
	});
});

test("keeps the detached runner independent from Host UI description fallback", () => {
	const root = fixtureRoot();
	const task: RunnerAgentTask = {
		agent: "legacy-writer",
		task: "Inspect /tmp/deep/sample.txt without changing it",
		cwd: root,
		inheritProjectContext: true,
		inheritSkills: false,
	};
	const config: BackgroundRunnerConfig = {
		version: 2,
		id: "legacy-runtime-status",
		cwd: root,
		asyncDir: path.join(root, "async"),
		resultPath: path.join(root, "result.json"),
		work: { mode: "single", task },
	};

	const [step] = createInitialStatus(config, 123_456).steps;

	expect(step).toMatchObject({ agent: "legacy-writer", task: task.task, status: "pending" });
	expect(step).not.toHaveProperty("label");
});

test("builds one parallel group and resolves every task override before persistence", () => {
	const root = fixtureRoot();
	const agents = [
		agent(root, "writer", {
			model: "provider/writer-default",
			fallbackModels: ["provider/writer-default"],
			excludeTools: ["write"],
			toolBudget: { hard: 30, soft: 20 },
			toolTimeoutMs: 3_500,
		}),
		agent(root, "reviewer", {
			model: "provider/reviewer-default",
			excludeTools: ["edit"],
			toolBudget: { hard: 15 },
			toolTimeoutMs: 3_000,
		}),
	];

	const built = buildAsyncParallelRunnerWork("run-parallel", {
		tasks: [
			{
				agent: "writer",
				description: "Implement core change",
				task: "Implement",
				cwd: "packages/core",
				model: "provider/fast",
				skill: "review",
				toolBudget: { hard: 9, soft: 6, block: ["browser"] },
				toolTimeoutMs: 1_500,
			},
			{ agent: "reviewer", description: "Review core change", task: "Review", skill: ["review"] },
		],
		agents,
		availableModels: [
			{ provider: "provider", id: "fast", fullId: "provider/fast", contextWindow: 120_000 },
			{
				provider: "provider",
				id: "writer-default",
				fullId: "provider/writer-default",
				contextWindow: 100_000,
			},
			{
				provider: "provider",
				id: "reviewer-default",
				fullId: "provider/reviewer-default",
				contextWindow: 80_000,
			},
		],
		ctx: buildContext(root),
		cwd: root,
		contextForAgent: () => "fork",
		thinking: "high",
		toolBudget: { hard: 14, soft: 10, block: ["read"] },
		toolTimeoutMs: 2_500,
		concurrency: 2,
		worktree: false,
		maxSubagentDepth: 3,
	});

	expect("error" in built).toBe(false);
	if ("error" in built) throw new Error(built.error);
	expect(built.work.mode).toBe("parallel");
	if (built.work.mode !== "parallel") throw new Error("Expected parallel work");
	expect(built.work.group.concurrency).toBe(2);
	expect(built.work.group.tasks).toHaveLength(2);
	expect(built.work.group.tasks[0]).toMatchObject({
		agent: "writer",
		description: "Implement core change",
		task: "Implement",
		cwd: path.join(root, "packages", "core"),
		context: "fork",
		model: "provider/fast",
		modelCandidates: ["provider/fast", "provider/writer-default"],
		modelContextWindows: [
			{ model: "provider/fast", contextWindow: 120_000 },
			{ model: "provider/writer-default", contextWindow: 100_000 },
		],
		thinking: "high",
		skills: ["review"],
		excludeTools: ["write"],
		toolBudget: { hard: 9, soft: 6, block: ["browser"] },
		toolTimeoutMs: 1_500,
	});
	expect(built.work.group.tasks[1]).toMatchObject({
		agent: "reviewer",
		description: "Review core change",
		task: "Review",
		cwd: root,
		context: "fork",
		model: "provider/reviewer-default",
		modelContextWindows: [{ model: "provider/reviewer-default", contextWindow: 80_000 }],
		thinking: "high",
		skills: ["review"],
		excludeTools: ["edit"],
		toolBudget: { hard: 14, soft: 10, block: ["read"] },
		toolTimeoutMs: 2_500,
	});
	expect(built.recoveries.map((recovery) => recovery.modelOrigin)).toEqual(["explicit", "configured"]);
});

test("single recovery data retains the child session and limits without retired features", () => {
	const root = fixtureRoot();
	const built = buildAsyncSingleRunnerWork("run-single", {
		agent: "writer",
		task: "Continue the implementation",
		agentConfig: agent(root, "writer", { excludeTools: ["write"] }),
		ctx: buildContext(root),
		cwd: root,
		context: "fork",
		sessionFile: path.join(root, "child.jsonl"),
		toolBudget: { hard: 11, block: ["read"] },
		toolTimeoutMs: 1_800,
		maxSubagentDepth: 2,
		capabilityCeiling: {
			version: 1,
			allowedTools: ["read", "edit"],
			denyExtensions: false,
			sources: ["test"],
		},
	});

	expect("error" in built).toBe(false);
	if ("error" in built) throw new Error(built.error);
	expect(built.work.mode).toBe("single");
	const recovery = built.recoveries[0];
	if (!recovery) throw new Error("Single background work did not retain its recovery descriptor.");
	expect(recovery).toMatchObject({
		version: 2,
		sourceRunId: "run-single",
		agent: "writer",
		excludeTools: ["write"],
		sessionFile: path.join(root, "child.jsonl"),
		context: "fork",
		modelOrigin: "inherited",
		initialToolBudget: { hard: 11, block: ["read"] },
		toolTimeoutMs: 1_800,
		capabilityCeiling: {
			version: 1,
			allowedTools: ["read", "edit"],
			denyExtensions: false,
			sources: ["test"],
		},
	});
	for (const retired of [
		"acceptance",
		"agentContract",
		"completionGuard",
		"initialTurnBudget",
		"memory",
		"outputMode",
		"outputPath",
		"share",
		"structuredOutputSchema",
	]) {
		expect(retired in recovery).toBe(false);
	}
});

test("keeps read available when a child inherits ambient Skills without an explicit skill list", () => {
	const root = fixtureRoot();
	const built = buildAsyncSingleRunnerWork("run-inherited-skills", {
		agent: "writer",
		task: "Inspect the implementation",
		agentConfig: agent(root, "writer", {
			inheritSkills: true,
			tools: ["edit"],
		}),
		ctx: buildContext(root),
		cwd: root,
		context: "fresh",
		maxSubagentDepth: 2,
		capabilityCeiling: {
			version: 1,
			allowedTools: ["edit", "read"],
			denyExtensions: false,
			sources: ["test"],
		},
	});

	expect("error" in built).toBe(false);
	if ("error" in built) throw new Error(built.error);
	expect(built.work.mode).toBe("single");
	if (built.work.mode !== "single") throw new Error("Expected single work");
	expect(built.work.task.skills).toEqual([]);
	expect(built.work.task.inheritSkills).toBeTrue();
	expect(built.work.task.tools).toEqual(["edit"]);
});

test("reads the selected child from a version 2 parallel recovery collection", () => {
	const root = fixtureRoot();
	const built = buildAsyncParallelRunnerWork("recover-parallel", {
		tasks: [
			{ agent: "writer", task: "Write" },
			{ agent: "reviewer", task: "Review" },
		],
		agents: [agent(root, "writer"), agent(root, "reviewer")],
		ctx: buildContext(root),
		maxSubagentDepth: 2,
	});
	expect("error" in built).toBe(false);
	if ("error" in built) throw new Error(built.error);
	const asyncDir = path.join(root, "async", "recover-parallel");
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(
		path.join(asyncDir, "recovery-descriptors.json"),
		JSON.stringify({ version: 2, children: built.recoveries }),
	);

	const descriptor = readAsyncRecoveryDescriptor(asyncDir, 1);

	expect(descriptor).toMatchObject({
		version: 2,
		sourceRunId: "recover-parallel",
		childIndex: 1,
		agent: "reviewer",
		cwd: root,
		maxSubagentDepth: 2,
	});
	expect(readAsyncRecoveryDescriptor(asyncDir)).toBeUndefined();
});
