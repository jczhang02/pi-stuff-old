import { afterEach, beforeEach, expect, test } from "bun:test";
import { projectForegroundStatus } from "../../../packages/pi-stuff/src/subagents/src/runs/foreground/result-projection.js";
import {
	type BackgroundRunnerConfig,
	cleanupForegroundEngineFixtures,
	context,
	createInitialStatus,
	executor,
	fs,
	initializeWriterProcessRegistry,
	observeForegroundRuntimeRunsAsync,
	os,
	path,
	recoverForegroundRuntimeRunsAsync,
	refreshForegroundRuntimeRunAsync,
	replayForegroundRuns,
	setupForegroundEngineFixtures,
	state,
	temporaryDirectories,
} from "../../agents/foreground-engine-fixtures.js";

beforeEach(setupForegroundEngineFixtures);
afterEach(cleanupForegroundEngineFixtures);

test("foreground recovery keeps the canonical report ahead of later activity", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-report-"));
	temporaryDirectories.push(root);
	const config: BackgroundRunnerConfig = {
		version: 2,
		id: "canonical-report",
		work: {
			mode: "single",
			task: {
				agent: "general-purpose",
				task: "report",
				cwd: root,
				inheritProjectContext: false,
				inheritSkills: false,
			},
		},
		resultPath: path.join(root, "result.json"),
		cwd: root,
		asyncDir: path.join(root, "async"),
	};
	const status = createInitialStatus(config, 1);
	status.state = "complete";
	const step = status.steps[0];
	if (!step) throw new Error("Expected one foreground step");
	step.status = "complete";
	step.finalOutput = "CANONICAL_REPORT";
	step.recentOutput = ["later progress"];
	const projected = projectForegroundStatus(config, status);
	expect(projected.details.results[0]?.finalOutput).toBe("CANONICAL_REPORT");
	expect(projected.content[0]).toMatchObject({ text: expect.stringContaining("CANONICAL_REPORT") });
});

test("runtime-only foreground replay revives the exact child contract after its source agent is removed", async () => {
	const parentCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-runtime-contract-"));
	temporaryDirectories.push(parentCwd);
	const firstCwd = path.join(parentCwd, "first");
	const secondCwd = path.join(parentCwd, "second");
	const retainedCwd = path.join(secondCwd, "nested");
	fs.mkdirSync(firstCwd);
	fs.mkdirSync(secondCwd);
	fs.mkdirSync(retainedCwd);
	fs.writeFileSync(path.join(parentCwd, "parent.jsonl"), "");
	let foregroundConfig: BackgroundRunnerConfig | undefined;
	await executor(parentCwd, state(), undefined, {
		onForegroundConfig: (config) => {
			foregroundConfig = config;
		},
	}).execute(
		"runtime-contract-source",
		{
			async: false,
			tasks: [
				{ agent: "general-purpose", task: "Inspect first", cwd: firstCwd },
				{ agent: "general-purpose", task: "Inspect second", cwd: secondCwd },
			],
		},
		new AbortController().signal,
		undefined,
		context(parentCwd),
	);
	if (!foregroundConfig) throw new Error("Expected foreground runtime config");
	const config: BackgroundRunnerConfig = foregroundConfig;
	const childSessions = [path.join(firstCwd, "child.jsonl"), path.join(secondCwd, "child.jsonl")];
	for (const sessionFile of childSessions) fs.writeFileSync(sessionFile, "");
	const narrowCeiling = {
		version: 1 as const,
		allowedTools: ["read"],
		denyExtensions: true,
		sources: ["runtime-test"],
	};
	const status = createInitialStatus(config, 1, 2_147_000_000, "linux:dead-owner");
	status.state = "failed";
	status.endedAt = 2;
	status.lastUpdate = 2;
	for (const [index, step] of status.steps.entries()) {
		step.status = "failed";
		step.exitCode = 1;
		step.sessionFile = childSessions[index];
		step.launchContractDigest = `digest-${index}`;
		step.capabilityCeiling = narrowCeiling;
	}
	fs.writeFileSync(path.join(config.asyncDir, "status.json"), JSON.stringify(status));
	const descriptorPath = path.join(config.asyncDir, "recovery-descriptors.json");
	const descriptors = JSON.parse(fs.readFileSync(descriptorPath, "utf8"));
	descriptors.children[1] = {
		...descriptors.children[1],
		cwd: retainedCwd,
		launchContractDigest: "digest-1",
		systemPrompt: "Persisted source contract",
		tools: ["read"],
		capabilityCeiling: narrowCeiling,
	};
	fs.writeFileSync(descriptorPath, JSON.stringify(descriptors));

	const sessionId = status.sessionId;
	if (!sessionId) throw new Error("Expected persisted foreground session identity");
	const runtimeRoot = path.dirname(config.asyncDir);
	const recovered = await recoverForegroundRuntimeRunsAsync(runtimeRoot, {
		sessionId,
		governorSessionId: sessionId,
		legacyRunIds: new Set(),
	});
	expect(recovered.get(config.id)?.children[1]).toMatchObject({
		cwd: secondCwd,
		launchContractDigest: "digest-1",
		capabilityCeiling: narrowCeiling,
	});

	const coldState = state();
	coldState.currentSessionId = sessionId;
	coldState.foregroundRuns = recovered;
	let revived: Parameters<NonNullable<Parameters<typeof executor>[2]>>[0] | undefined;
	const result = await executor(
		parentCwd,
		coldState,
		(launch) => {
			revived = launch;
		},
		{ agents: [] },
	).execute(
		"runtime-contract-resume",
		{ action: "resume", id: config.id, index: 1, message: "Continue the second child" },
		new AbortController().signal,
		undefined,
		context(parentCwd),
	);

	expect(result.isError).not.toBeTrue();
	expect(revived).toMatchObject({
		cwd: retainedCwd,
		agentConfig: { systemPrompt: "Persisted source contract", tools: ["read"] },
		capabilityCeiling: narrowCeiling,
	});
});

test("foreground replay fails closed on malformed ceilings and bounds retained session strings", () => {
	const cwd = "/project";
	interface ReplayChildFixture {
		readonly agent: string;
		readonly capabilityCeiling?: object;
		readonly exitCode: number;
		readonly finalOutput?: string;
		readonly model?: string;
		readonly sessionFile?: string;
		readonly task: string;
	}
	const entry = (child: ReplayChildFixture) => ({
		type: "message",
		timestamp: "2026-08-06T10:00:00.000Z",
		message: {
			role: "toolResult",
			toolName: "subagent",
			details: { mode: "single", runId: "replayed", cwd, results: [child] },
		},
	});
	const base = { agent: "general-purpose", task: "Inspect", exitCode: 0 };
	expect(
		replayForegroundRuns(
			[entry({ ...base, capabilityCeiling: { version: 1, allowedTools: "*", sources: [] } })],
			"session",
		).size,
	).toBe(0);

	const replayed = replayForegroundRuns(
		[
			entry({
				...base,
				task: "t".repeat(100_000),
				finalOutput: "o".repeat(100_000),
				capabilityCeiling: { version: 1, allowedTools: ["read"], denyExtensions: true, sources: ["test"] },
			}),
		],
		"session",
	);
	const child = replayed.get("replayed")?.children[0];
	expect(child?.task?.length).toBe(16 * 1024);
	expect(child?.finalOutput?.length).toBe(32 * 1024);
	expect(child?.capabilityCeiling).toEqual({
		version: 1,
		allowedTools: ["read"],
		denyExtensions: true,
		sources: ["test"],
	});
	expect(replayForegroundRuns([entry({ ...base, model: "m".repeat(257) })], "session").size).toBe(0);
	expect(replayForegroundRuns([entry({ ...base, sessionFile: "/tmp/bad\npath" })], "session").size).toBe(0);
});

test("cold runtime replay skips a malformed newest run and still restores a healthy sibling", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-runtime-replay-"));
	temporaryDirectories.push(root);
	const sessionId = "/sessions/current.jsonl";
	const healthyId = "aaaaaaaaaaaa";
	const corruptId = "bbbbbbbbbbbb";
	for (const runId of [healthyId, corruptId]) fs.mkdirSync(path.join(root, runId), { recursive: true });
	fs.writeFileSync(
		path.join(root, healthyId, "status.json"),
		JSON.stringify({
			runId: healthyId,
			sessionId,
			mode: "single",
			state: "complete",
			cwd: "/project",
			startedAt: 1,
			endedAt: 2,
			lastUpdate: 2,
			steps: [{ agent: "general-purpose", task: "Inspect", status: "complete", exitCode: 0 }],
		}),
	);
	fs.writeFileSync(
		path.join(root, corruptId, "status.json"),
		JSON.stringify({
			runId: corruptId,
			sessionId,
			mode: "single",
			state: "complete",
			cwd: 123,
			startedAt: 3,
			steps: "not-an-array",
		}),
	);
	const now = new Date();
	fs.utimesSync(path.join(root, corruptId), now, new Date(now.getTime() + 1_000));

	const recovered = await recoverForegroundRuntimeRunsAsync(root, {
		sessionId,
		governorSessionId: sessionId,
		legacyRunIds: new Set(),
	});
	expect([...recovered.keys()]).toEqual([healthyId]);
	expect(recovered.get(healthyId)?.children[0]).toMatchObject({
		agent: "general-purpose",
		status: "completed",
		task: "Inspect",
	});
});

test("observation-only startup isolates disappearing and corrupt foreground siblings", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-runtime-observe-"));
	temporaryDirectories.push(root);
	const sessionId = "/sessions/current.jsonl";
	const healthyId = "111111111111";
	const disappearingId = "222222222222";
	const corruptId = "333333333333";
	for (const runId of [healthyId, disappearingId, corruptId]) fs.mkdirSync(path.join(root, runId));
	fs.writeFileSync(
		path.join(root, healthyId, "status.json"),
		JSON.stringify({
			runId: healthyId,
			sessionId,
			mode: "single",
			state: "complete",
			cwd: "/project",
			startedAt: 1,
			endedAt: 2,
			lastUpdate: 2,
			steps: [{ agent: "general-purpose", task: "Inspect", status: "complete", exitCode: 0 }],
		}),
	);
	fs.writeFileSync(path.join(root, corruptId, "status.json"), "{not-json");
	fs.rmSync(path.join(root, disappearingId), { recursive: true });

	const observed = await observeForegroundRuntimeRunsAsync(
		root,
		{ sessionId, governorSessionId: sessionId, legacyRunIds: new Set() },
		[healthyId, disappearingId, corruptId].map((runId) => path.join(root, runId)),
	);

	expect([...observed.keys()]).toEqual([healthyId]);
	expect(observed.get(healthyId)?.children[0]).toMatchObject({ status: "completed", task: "Inspect" });
});

test("cold runtime replay durably repairs a terminal completion left ahead of running status", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-completion-repair-"));
	temporaryDirectories.push(root);
	const runId = "cccccccccccc";
	const sessionId = "/sessions/current.jsonl";
	const asyncDir = path.join(root, runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId,
			sessionId,
			mode: "single",
			state: "running",
			cwd: "/project",
			startedAt: 1,
			lastUpdate: 1,
			steps: [{ agent: "general-purpose", task: "Inspect", status: "running" }],
		}),
	);
	fs.writeFileSync(
		path.join(asyncDir, "completion.json"),
		JSON.stringify({
			id: runId,
			runId,
			state: "complete",
			endedAt: 2,
			results: [{ agent: "general-purpose", success: true, exitCode: 0, output: "done" }],
		}),
	);

	const recovered = await recoverForegroundRuntimeRunsAsync(root, {
		sessionId,
		governorSessionId: sessionId,
		legacyRunIds: new Set(),
	});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const persisted = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as {
		state?: string;
		steps?: Array<{ status?: string }>;
	};

	expect(recovered.get(runId)?.children[0]?.status).toBe("completed");
	expect(persisted.state).toBe("complete");
	expect(persisted.steps?.[0]?.status).toBe("complete");
});

test("invalid completion cannot pin a foreground run whose owner is proven dead", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-invalid-completion-"));
	temporaryDirectories.push(root);
	const runId = "dddddddddddd";
	const sessionId = "/sessions/current.jsonl";
	const asyncDir = path.join(root, runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId,
			sessionId,
			mode: "single",
			state: "running",
			cwd: "/project",
			pid: 2_147_000_000,
			processStartIdentity: "linux:dead-owner",
			startedAt: 1,
			lastUpdate: 1,
			steps: [{ agent: "general-purpose", task: "Inspect", status: "running" }],
		}),
	);
	initializeWriterProcessRegistry(asyncDir, runId, process.pid, 1);
	fs.writeFileSync(path.join(asyncDir, "completion.json"), "{not-json", { mode: 0o600 });

	const recovered = await recoverForegroundRuntimeRunsAsync(root, {
		sessionId,
		governorSessionId: sessionId,
		legacyRunIds: new Set(),
	});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const persisted = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")) as {
		state?: string;
		steps?: Array<{ agentStatus?: string; status?: string }>;
	};

	expect(recovered.get(runId)?.children[0]).toMatchObject({ status: "failed", crashed: true });
	expect(persisted.state).toBe("failed");
	expect(persisted.steps?.[0]).toMatchObject({ status: "failed", agentStatus: "crashed" });
});

test("advances cold foreground orphan reaping until TERM-resistant writers are absent", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-reap-retry-"));
	temporaryDirectories.push(root);
	const runId = "abababababab";
	const asyncDir = path.join(root, runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId,
			sessionId: "/sessions/current.jsonl",
			mode: "single",
			state: "running",
			cwd: "/project",
			pid: 2_147_000_000,
			processStartIdentity: "linux:dead-owner",
			startedAt: 1,
			lastUpdate: 1,
			steps: [{ agent: "general-purpose", task: "Inspect", status: "running" }],
		}),
	);
	const run = {
		runId,
		mode: "single" as const,
		cwd: "/project",
		asyncDir,
		sessionId: "/sessions/current.jsonl",
		updatedAt: 1,
		children: [{ agent: "general-purpose", index: 0, task: "Inspect", status: "detached" as const, updatedAt: 1 }],
	};
	let passes = 0;
	const terminateWriters = () => {
		passes += 1;
		return passes === 1 ? { remaining: 1, terminated: 1 } : { remaining: 0, terminated: 1 };
	};

	await refreshForegroundRuntimeRunAsync(run, { terminateWriters });
	expect(run.children[0]?.status).toBe("detached");
	await refreshForegroundRuntimeRunAsync(run, { terminateWriters });

	expect(passes).toBe(2);
	expect(run.children[0]).toMatchObject({ status: "failed", crashed: true });
	expect(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"))).toMatchObject({
		state: "failed",
		steps: [{ status: "failed", agentStatus: "crashed" }],
	});
});

test("invalid completion does not fail a foreground run without dead-owner proof", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-unknown-owner-"));
	temporaryDirectories.push(root);
	const runId = "eeeeeeeeeeee";
	const sessionId = "/sessions/current.jsonl";
	const asyncDir = path.join(root, runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId,
			sessionId,
			mode: "single",
			state: "running",
			cwd: "/project",
			startedAt: 1,
			lastUpdate: 1,
			steps: [{ agent: "general-purpose", task: "Inspect", status: "running" }],
		}),
	);
	fs.writeFileSync(
		path.join(asyncDir, "completion.json"),
		JSON.stringify({ runId: "foreign-run", state: "complete", results: [] }),
		{ mode: 0o600 },
	);

	const recovered = await recoverForegroundRuntimeRunsAsync(root, {
		sessionId,
		governorSessionId: sessionId,
		legacyRunIds: new Set(),
	});

	expect(recovered.get(runId)?.children[0]?.status).toBe("detached");
	expect(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8")).state).toBe("running");
});

test("the private executor contract contains no removed orchestration fields or legacy branches", () => {
	const root = path.resolve(import.meta.dir, "../../..");
	const executorSource = fs.readFileSync(
		path.join(root, "packages/pi-stuff/src/subagents/src/runs/foreground/subagent-executor.ts"),
		"utf8",
	);
	const executionSource = fs.readFileSync(
		path.join(root, "packages/pi-stuff/src/subagents/src/runs/foreground/execution.ts"),
		"utf8",
	);
	const params = executorSource.match(/export interface SubagentParamsLike \{([\s\S]*?)\n\}/)?.[1] ?? "";
	for (const field of [
		"acceptance",
		"agentContract",
		"chain",
		"dynamic",
		"outputPath",
		"progress",
		"share",
		"structuredOutput",
		"workflow",
	]) {
		expect(params).not.toMatch(new RegExp(`\\b${field}\\??:`));
	}
	for (const removedModule of [
		"agent-memory",
		"acceptance",
		"agent-contract",
		"completion-guard",
		"dynamic-fanout",
		"intercom",
		"long-running-guard",
		"parallel-handoff",
		"single-output",
		"structured-output",
	]) {
		expect(`${executorSource}\n${executionSource}`).not.toContain(`/${removedModule}.ts`);
	}
});
