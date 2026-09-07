import { expect, test } from "bun:test";
import {
	acknowledgedOptions,
	asyncJob,
	CurrentAgents,
	createAsyncJobTracker,
	createFullState,
	createState,
	eventHost,
	foregroundControl,
	foregroundRun,
	fs,
	os,
	type ProcessTerminalV1,
	path,
	row,
	waitUntil,
} from "../../agents/current-agents-fixtures.js";

const completedCumulativeUsage = {
	turns: 72,
	toolCalls: 140,
	inputTokens: 900_000,
	outputTokens: 20_000,
	reportedCostUsd: 4.25,
	modelAttempts: 2,
	resumes: 1,
};
const completedTerminalOutcome = {
	state: "completed",
	class: "completed",
	reason: "Agent returned a final answer.",
	continuation: { target: { id: "done", index: 0 }, resumeSupported: false },
} as const;

function currentSessionSnapshot() {
	const state = createState();
	state.foregroundControls.set(
		"foreground",
		foregroundControl({
			description: "Implement the state module",
			activeChildren: new Map([
				[
					0,
					{
						index: 0,
						agent: "worker",
						description: "Implement",
						contextUsage: { tokens: 37_500, contextWindow: 100_000 },
						startedAt: 1_000,
						updatedAt: 4_000,
					},
				],
				[
					1,
					{
						index: 1,
						agent: "reviewer",
						description: "Review",
						startedAt: 1_500,
						updatedAt: 4_000,
						currentActivityState: "needs_attention",
						currentTool: "contact_supervisor",
					},
				],
			]),
			nestedChildren: [
				{
					id: "nested-one",
					parentRunId: "foreground",
					parentStepIndex: 0,
					depth: 1,
					path: [],
					state: "running",
					children: [
						{
							id: "nested-two",
							parentRunId: "nested-one",
							depth: 2,
							path: [],
							state: "queued",
						},
					],
				},
			],
		}),
	);
	state.foregroundRuns?.set(
		"foreground",
		foregroundRun({
			mode: "parallel",
			children: [
				{
					agent: "worker",
					index: 0,
					status: "detached",
					finalOutput: "partial implementation",
					sessionFile: "/sessions/worker.jsonl",
					transcriptPath: "/transcripts/worker.md",
					updatedAt: 4_000,
				},
			],
		}),
	);
	state.foregroundRuns?.set(
		"finished-foreground",
		foregroundRun({
			runId: "finished-foreground",
			children: [
				{
					agent: "planner",
					index: 0,
					status: "completed",
					contextUsage: { tokens: 50_000, contextWindow: 100_000 },
					finalOutput: "plan complete",
					sessionFile: "/sessions/planner.jsonl",
					transcriptPath: "/transcripts/planner.md",
					updatedAt: 3_000,
				},
			],
		}),
	);
	state.asyncJobs.set("queued", asyncJob("queued", "queued", { description: "Explore APIs" }));
	state.asyncJobs.set("other-session", asyncJob("other-session", "running", { sessionId: "stale-session" }));
	state.recentAgentJobs?.set(
		"done",
		asyncJob("done", "complete", {
			steps: [
				{
					agent: "scout",
					status: "completed",
					cumulativeUsage: completedCumulativeUsage,
					terminalOutcome: completedTerminalOutcome,
					contextUsage: { tokens: 75_000, contextWindow: 100_000 },
					startedAt: 1_000,
					endedAt: 3_000,
					transcriptPath: "/transcripts/scout.md",
				},
			],
		}),
	);
	state.recentAgentJobs?.set("fleet-active", asyncJob("fleet-active", "running"));
	const current = new CurrentAgents(state, acknowledgedOptions());
	return current.snapshot();
}

test("projects only direct children from the current root session", () => {
	const snapshot = currentSessionSnapshot();
	expect(snapshot.sessionId).toBe("root-session");
	expect(new Set(snapshot.rows.map(({ key }) => key))).toEqual(
		new Set(["foreground:0", "foreground:1", "finished-foreground:0", "queued:0", "done:0"]),
	);
	expect(snapshot.rows.some(({ runId }) => runId === "nested-one")).toBe(false);
	expect(snapshot.rows.some(({ runId }) => runId === "other-session")).toBe(false);
	expect(snapshot.rows.some(({ runId }) => runId === "fleet-active")).toBe(false);
	expect(row(snapshot, "foreground:0")).toMatchObject({
		name: "worker",
		task: "Implement",
		status: "running",
		startedAt: 1_000,
		elapsedMs: 4_000,
		partialResult: "partial implementation",
		contextUsage: { tokens: 37_500, contextWindow: 100_000 },
		nestedCount: 2,
		sessionFile: "/sessions/worker.jsonl",
		transcriptPath: "/transcripts/worker.md",
	});
	expect(row(snapshot, "foreground:1").status).toBe("waiting_supervisor");
});

test("projects terminal direct children with bounded completion detail", () => {
	const snapshot = currentSessionSnapshot();
	expect(row(snapshot, "done:0")).toMatchObject({
		status: "completed",
		elapsedMs: 2_000,
		contextUsage: { tokens: 75_000, contextWindow: 100_000 },
		cumulativeUsage: {
			turns: 72,
			toolCalls: 140,
			inputTokens: 900_000,
			outputTokens: 20_000,
			reportedCostUsd: 4.25,
			modelAttempts: 2,
			resumes: 1,
		},
		terminalOutcome: {
			state: "completed",
			class: "completed",
			continuation: { target: { id: "done", index: 0 }, resumeSupported: false },
		},
	});
	expect(row(snapshot, "finished-foreground:0")).toMatchObject({
		status: "completed",
		partialResult: "plan complete",
		contextUsage: { tokens: 50_000, contextWindow: 100_000 },
		startedAt: null,
		elapsedMs: null,
	});
});

test("restores task-only legacy rows through the bounded description fallback", () => {
	const state = createState();
	const legacyTask = "独立只读复核 /tmp/pi-max-tools-019fc372-d606-77ef-b3d5-59ba054c8d1a/sample.txt 并检查状态";
	state.recentAgentJobs?.set(
		"legacy-background",
		asyncJob("legacy-background", "complete", {
			description: legacyTask,
			steps: [
				{
					agent: "background-reviewer",
					endedAt: 3_000,
					label: legacyTask,
					contextUsage: { tokens: 42_000, contextWindow: 100_000 },
					startedAt: 1_000,
					status: "completed",
				},
			],
		}),
	);
	state.foregroundRuns?.set(
		"legacy-foreground",
		foregroundRun({
			children: [
				{
					agent: "foreground-reviewer",
					description: legacyTask,
					contextUsage: { tokens: 42_000, contextWindow: 100_000 },
					index: 0,
					status: "completed",
					updatedAt: 3_000,
				},
			],
			runId: "legacy-foreground",
		}),
	);

	const snapshot = new CurrentAgents(state, acknowledgedOptions()).snapshot();
	for (const key of ["legacy-background:0", "legacy-foreground:0"]) {
		const restored = row(snapshot, key);
		expect(restored.description).toBe("独立只读复核 sample.txt 并检查状态");
		expect(restored.task).toBe(legacyTask);
		expect(restored.contextUsage).toEqual({ tokens: 42_000, contextWindow: 100_000 });
	}
});

test("uses the delegated task instead of the execution prompt", () => {
	const state = createState();
	const delegatedTask = `Review the Agent dialog.\n${"Keep this detail readable. ".repeat(30)}\nLAST_TASK_LINE`;
	state.recentAgentJobs?.set(
		"derived-prompt",
		asyncJob("derived-prompt", "complete", {
			steps: [
				{
					agent: "reviewer",
					delegatedTask,
					label: "Review Agent dialog",
					status: "completed",
					task: `<pi-stuff-context trust="reference-only">${"memory".repeat(1_000)}</pi-stuff-context>\n\nReview the Agent dialog.`,
				},
			],
		}),
	);
	state.recentAgentJobs?.set(
		"legacy-derived-prompt",
		asyncJob("legacy-derived-prompt", "complete", {
			steps: [
				{
					agent: "reviewer",
					label: "Review Agent dialog",
					status: "completed",
					task: `<pi-stuff-context trust="reference-only">${"memory".repeat(1_000)}</pi-stuff-context>\n\nReview the Agent dialog.`,
				},
			],
		}),
	);

	const projected = row(new CurrentAgents(state, acknowledgedOptions()).snapshot(), "derived-prompt:0");
	expect(projected.task).toBe(delegatedTask);
	expect(projected.task).toEndWith("LAST_TASK_LINE");
	expect(projected.task).not.toContain("pi-stuff-context");
	const legacy = row(new CurrentAgents(state, acknowledgedOptions()).snapshot(), "legacy-derived-prompt:0");
	expect(legacy.task).toBe("Review Agent dialog");
	expect(legacy.task).not.toContain("pi-stuff-context");
});

test("does not present terminal activity as the Agent result", () => {
	const state = createState();
	state.recentAgentJobs?.set(
		"completed-agent",
		asyncJob("completed-agent", "complete", {
			steps: [
				{
					agent: "reviewer",
					recentOutput: ["Read package.json", "Final answer"],
					status: "completed",
				},
			],
		}),
	);
	state.recentAgentJobs?.set(
		"completed-with-result",
		asyncJob("completed-with-result", "complete", {
			steps: [
				{
					agent: "reviewer",
					finalOutput: "First line\nSecond line",
					recentOutput: ["Read package.json", "First line", "Second line"],
					status: "completed",
				},
			],
		}),
	);

	const snapshot = new CurrentAgents(state, acknowledgedOptions()).snapshot();
	const completed = row(snapshot, "completed-agent:0");
	expect(completed.partialResult).toBeNull();
	expect(row(snapshot, "completed-with-result:0").partialResult).toBe("First line\nSecond line");
});

test("reconstructs a task-only legacy background label from persisted status", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-legacy-agent-restore-"));
	const runDir = path.join(root, "legacy-run");
	const sessionId = "legacy-session";
	const legacyTask = "独立只读复核 /tmp/pi-max-tools-019fc372-d606-77ef-b3d5-59ba054c8d1a/sample.txt 并检查状态";
	fs.mkdirSync(runDir);
	fs.writeFileSync(
		path.join(runDir, "status.json"),
		JSON.stringify({
			cwd: "/repo",
			endedAt: 3_000,
			lastUpdate: 3_000,
			mode: "single",
			runId: "legacy-run",
			sessionId,
			startedAt: 1_000,
			state: "complete",
			steps: [
				{
					agent: "reviewer",
					endedAt: 3_000,
					label: legacyTask,
					contextUsage: { tokens: 42_000, contextWindow: 100_000 },
					startedAt: 1_000,
					status: "completed",
				},
			],
		}),
	);
	const state = createFullState(sessionId);
	const tracker = createAsyncJobTracker(eventHost(), state, root);

	try {
		await tracker.restoreActiveJobs();
		const restored = row(new CurrentAgents(state, acknowledgedOptions()).snapshot(), "legacy-run:0");
		expect(restored.description).toBe("独立只读复核 sample.txt 并检查状态");
		expect(restored.task).toBe(legacyTask);
		expect(restored.contextUsage).toEqual({ tokens: 42_000, contextWindow: 100_000 });
	} finally {
		tracker.resetJobs();
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("cold startup restores only governor-indexed active runtime directories", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-targeted-agent-restore-"));
	const target = path.join(root, "target-run");
	const unrelated = path.join(root, "unrelated-run");
	fs.mkdirSync(target);
	fs.mkdirSync(unrelated);
	const reads: string[] = [];
	const state = createFullState("root-session");
	const tracker = createAsyncJobTracker(eventHost(), state, root, {
		readRunStatus: async (asyncDir) => {
			reads.push(asyncDir);
			return {
				lifecycleArtifactVersion: 3,
				runId: path.basename(asyncDir),
				sessionId: "root-session",
				state: "running",
				mode: "single",
				startedAt: 1_000,
				lastUpdate: 2_000,
				steps: [{ agent: "reviewer", status: "running" }],
			};
		},
	});

	try {
		await tracker.restoreActiveJobs([target]);
		expect(reads).toEqual([target]);
		expect([...state.asyncJobs.keys()]).toEqual(["target-run"]);
	} finally {
		tracker.resetJobs();
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("treats a missing runtime root as one completed restore generation", async () => {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-missing-agent-root-"));
	const root = path.join(base, "async-runs");
	const runDir = path.join(root, "late-run");
	const state = createFullState("root-session");
	const tracker = createAsyncJobTracker(eventHost(), state, root);

	try {
		await tracker.restoreActiveJobs();
		fs.mkdirSync(runDir, { recursive: true });
		fs.writeFileSync(
			path.join(runDir, "status.json"),
			JSON.stringify({
				lifecycleArtifactVersion: 3,
				runId: "late-run",
				sessionId: "root-session",
				state: "running",
				mode: "single",
				startedAt: 1_000,
				lastUpdate: 2_000,
				steps: [{ agent: "reviewer", status: "running" }],
			}),
		);
		await tracker.restoreActiveJobs();
		expect(state.asyncJobs.has("late-run")).toBeFalse();

		tracker.resetJobs();
		state.currentSessionId = "root-session";
		await tracker.restoreActiveJobs();
		expect(state.asyncJobs.has("late-run")).toBeTrue();
	} finally {
		tracker.resetJobs();
		fs.rmSync(base, { force: true, recursive: true });
	}
});

test("retains the last live state across a transient status observer failure", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-observer-retry-"));
	const asyncDir = path.join(root, "observer-retry");
	fs.mkdirSync(asyncDir);
	const state = createFullState("root-session");
	let attempts = 0;
	const tracker = createAsyncJobTracker(eventHost(), state, root, {
		pollIntervalMs: 10,
		readRunStatus: async () => {
			attempts += 1;
			if (attempts === 1) throw Object.assign(new Error("transient observer EIO"), { code: "EIO" });
			return {
				runId: "observer-retry",
				sessionId: "root-session",
				mode: "single",
				state: "running",
				pid: process.pid,
				startedAt: 1_000,
				lastUpdate: 2_000,
				steps: [{ agent: "reviewer", status: "running" }],
			};
		},
	});

	try {
		tracker.handleStarted({
			id: "observer-retry",
			asyncDir,
			sessionId: "root-session",
			mode: "single",
			agents: ["reviewer"],
		});
		while (attempts < 1) await Bun.sleep(5);
		expect(state.asyncJobs.get("observer-retry")?.status).not.toBe("failed");
		while (attempts < 2 || state.asyncJobs.get("observer-retry")?.status !== "running") await Bun.sleep(5);
		expect(state.asyncJobs.get("observer-retry")?.status).toBe("running");
	} finally {
		tracker.resetJobs();
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("never revives semantic completion from an older running status snapshot", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-terminal-monotonic-"));
	const asyncDir = path.join(root, "terminal-monotonic");
	fs.mkdirSync(asyncDir);
	const state = createFullState("root-session");
	const pending: ProcessTerminalV1 = {
		version: 1,
		state: "pending",
		runId: "terminal-monotonic",
		runnerProcessInstanceId: "terminal-monotonic-runner",
	};
	const tracker = createAsyncJobTracker(eventHost(), state, root, {
		completionRetentionMs: 25,
		readRunStatus: async () => null,
	});

	try {
		tracker.handleStarted({
			id: "terminal-monotonic",
			asyncDir,
			sessionId: "root-session",
			mode: "single",
			agents: ["reviewer"],
		});
		tracker.handleStatus({
			id: "terminal-monotonic",
			asyncDir,
			sessionId: "root-session",
			status: {
				runId: "terminal-monotonic",
				sessionId: "root-session",
				mode: "single",
				state: "running",
				startedAt: 1_000,
				lastUpdate: 2_000,
				processTerminal: pending,
				steps: [{ agent: "reviewer", status: "running" }],
			},
		});
		await waitUntil(() => state.asyncJobs.get("terminal-monotonic")?.processTerminal?.state === "pending");
		tracker.handleComplete({ id: "terminal-monotonic", sessionId: "root-session", state: "complete" });
		tracker.handleStatus({
			id: "terminal-monotonic",
			asyncDir,
			sessionId: "root-session",
			status: {
				runId: "terminal-monotonic",
				sessionId: "root-session",
				mode: "single",
				state: "running",
				startedAt: 1_000,
				lastUpdate: 2_000,
				processTerminal: pending,
				steps: [{ agent: "reviewer", status: "running" }],
			},
		});
		expect(state.asyncJobs.get("terminal-monotonic")?.status).toBe("complete");
		tracker.handleProcessTerminal({
			version: 1,
			state: "observed",
			runId: "terminal-monotonic",
			runnerProcessInstanceId: "foreign-runner",
			observedAt: 2_500,
			instances: [],
		});
		expect(state.asyncJobs.get("terminal-monotonic")?.processTerminal).toEqual(pending);

		tracker.handleProcessTerminal({
			version: 1,
			state: "observed",
			runId: "terminal-monotonic",
			runnerProcessInstanceId: "terminal-monotonic-runner",
			observedAt: 3_000,
			instances: [],
		});
		await waitUntil(() => !state.asyncJobs.has("terminal-monotonic"));
	} finally {
		tracker.resetJobs();
		fs.rmSync(root, { force: true, recursive: true });
	}
});
