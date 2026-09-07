import { expect, test } from "bun:test";
import {
	type AsyncJobState,
	acknowledgedOptions,
	asyncJob,
	CurrentAgents,
	createAsyncJobTracker,
	createFullState,
	createState,
	eventHost,
	foregroundRun,
	fs,
	os,
	type ProcessTerminalV1,
	path,
	row,
	signalledProcessTerminal,
	waitUntil,
} from "../../agents/current-agents-fixtures.js";

test("keeps a restored terminal run until an explicit physical process event is observed", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-terminal-physical-recovery-"));
	const asyncDir = path.join(root, "cold-terminal");
	fs.mkdirSync(asyncDir);
	const state = createFullState("root-session");
	const pending: ProcessTerminalV1 = {
		version: 1,
		state: "pending",
		runId: "cold-terminal",
		runnerProcessInstanceId: "cold-terminal-runner",
	};
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId: "cold-terminal",
			sessionId: "root-session",
			state: "failed",
			mode: "single",
			startedAt: 1_000,
			lastUpdate: 2_000,
			processTerminal: pending,
			steps: [{ agent: "reviewer", status: "failed" }],
		}),
	);
	const tracker = createAsyncJobTracker(eventHost(), state, root, { completionRetentionMs: 20 });

	try {
		await tracker.restoreActiveJobs();
		expect(state.asyncJobs.has("cold-terminal")).toBeTrue();
		await Bun.sleep(40);
		expect(state.asyncJobs.has("cold-terminal")).toBeTrue();
		tracker.handleProcessTerminal({
			version: 1,
			state: "observed",
			runId: "cold-terminal",
			runnerProcessInstanceId: "cold-terminal-runner",
			observedAt: 4_000,
			instances: [],
		});
		await waitUntil(() => !state.asyncJobs.has("cold-terminal"));
	} finally {
		tracker.resetJobs();
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("does not poll foreground recovery state from the Agent status observer", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-recovery-poll-"));
	const state = createFullState("root-session");
	const run = foregroundRun({
		runId: "cold-foreground",
		asyncDir: path.join(root, "cold-foreground"),
		children: [
			{
				agent: "reviewer",
				index: 0,
				task: "Recover the orphan",
				status: "detached",
				updatedAt: 1_000,
			},
		],
	});
	state.foregroundRuns?.set(run.runId, run);
	const tracker = createAsyncJobTracker(eventHost(), state, root);

	try {
		tracker.ensureObserver();
		await Bun.sleep(40);
		expect(run.children[0]?.status).toBe("detached");
	} finally {
		tracker.resetJobs();
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("restores sibling runs when optional control-event files are absent", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-restore-cursor-"));
	const firstDir = path.join(root, "first");
	const secondDir = path.join(root, "second");
	fs.mkdirSync(firstDir);
	fs.mkdirSync(secondDir);
	for (const id of ["first", "second"]) {
		fs.writeFileSync(
			path.join(root, id, "status.json"),
			JSON.stringify({
				lifecycleArtifactVersion: 3,
				runId: id,
				sessionId: "root-session",
				state: "running",
				mode: "single",
				startedAt: 1_000,
				steps: [{ agent: "reviewer", status: "running" }],
			}),
		);
	}
	const state = createFullState("root-session");
	const tracker = createAsyncJobTracker(eventHost(), state, root);
	try {
		await tracker.restoreActiveJobs();
		expect([...state.asyncJobs.keys()].sort()).toEqual(["first", "second"]);
		await waitUntil(() => state.asyncJobs.get("first")?.controlEventCursorPending !== true);
		expect(state.asyncJobs.get("first")?.controlEventCursor).toBe(0);
		expect(state.asyncJobs.get("second")?.controlEventCursor).toBe(0);
	} finally {
		tracker.resetJobs();
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("bounds legacy source scanning before trimming restored task text", () => {
	const state = createState();
	const leadingWhitespaceTask = `${" ".repeat(4 * 1024 * 1024)}LATE_TASK_TEXT_MUST_NOT_BE_SCANNED`;
	let lateOutputReads = 0;
	const recentOutput = ["x".repeat(4 * 1024 * 1024)];
	Object.defineProperty(recentOutput, 1, {
		configurable: true,
		enumerable: true,
		get: () => {
			lateOutputReads += 1;
			return "LATE_OUTPUT_MUST_NOT_BE_READ";
		},
	});
	state.recentAgentJobs?.set(
		"bounded-legacy",
		asyncJob("bounded-legacy", "complete", {
			steps: [{ agent: "reviewer", label: leadingWhitespaceTask, status: "completed" }],
		}),
	);
	state.asyncJobs.set(
		"bounded-output",
		asyncJob("bounded-output", "running", {
			steps: [{ agent: "reviewer", recentOutput, status: "running" }],
		}),
	);

	const snapshot = new CurrentAgents(state, acknowledgedOptions()).snapshot();
	const restored = row(snapshot, "bounded-legacy:0");
	expect(restored.description).toBe("Agent task");
	expect(restored.task).toBe("");
	const output = row(snapshot, "bounded-output:0").partialResult;
	expect(output).toHaveLength(4_000);
	expect(output).toEndWith("…");
	expect(lateOutputReads).toBe(0);
});

test("projects bounded terminal failures and drops task-only partial results across cold restore", async () => {
	const task = "Inspect the Agent detail without changing files.";
	const error = "Provider rejected the child payload\u001b]0;hidden\u0007 after validation.\u202e";
	const state = createState();
	state.recentAgentJobs?.set(
		"failed-detail",
		asyncJob("failed-detail", "failed", {
			tasks: [task],
			steps: [
				{
					agent: "reviewer",
					error,
					recentOutput: [`Task: ${task}`],
					status: "failed",
					task,
				},
			],
		}),
	);

	const projected = row(new CurrentAgents(state, acknowledgedOptions()).snapshot(), "failed-detail:0");
	expect(projected.error).toBe("Provider rejected the child payload after validation.");
	expect(projected.partialResult).toBeNull();
	expect(projected.task).toBe(task);

	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-failed-agent-restore-"));
	const runDir = path.join(root, "failed-detail");
	fs.mkdirSync(runDir);
	fs.writeFileSync(
		path.join(runDir, "status.json"),
		JSON.stringify({
			error,
			lastUpdate: 2_000,
			mode: "single",
			runId: "failed-detail",
			sessionId: "root-session",
			startedAt: 1_000,
			state: "failed",
			steps: [{ agent: "reviewer", recentOutput: [`Task: ${task}`], status: "failed", task }],
		}),
	);
	const restoredState = createFullState("root-session");
	const tracker = createAsyncJobTracker(eventHost(), restoredState, root);
	try {
		await tracker.restoreActiveJobs();
		const restored = row(new CurrentAgents(restoredState, acknowledgedOptions()).snapshot(), "failed-detail:0");
		expect(restored.error).toBe("Provider rejected the child payload after validation.");
		expect(restored.partialResult).toBeNull();
	} finally {
		tracker.resetJobs();
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("represents every explicit lifecycle state without inventing nested rows", () => {
	const state = createState();
	const active = [
		asyncJob("queued", "queued"),
		asyncJob("running", "running"),
		asyncJob("supervisor", "running", { currentTool: "contact_supervisor", activityState: "needs_attention" }),
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		asyncJob("stopping", "running", { stopping: true } as Partial<AsyncJobState>),
	];
	for (const job of active) state.asyncJobs.set(job.asyncId, job);

	const terminal = [
		asyncJob("completed", "complete"),
		asyncJob("failed", "failed"),
		asyncJob("agent-stopped", "paused"),
		asyncJob("user-cancelled", "stopped"),
		asyncJob("crashed", "failed", {
			steps: [
				{
					agent: "crashed",
					status: "failed",
					processTerminal: signalledProcessTerminal("crashed", "SIGSEGV", "external"),
				},
			],
		}),
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		asyncJob("resuming", "complete", { resuming: true } as Partial<AsyncJobState>),
	];
	for (const job of terminal) state.recentAgentJobs?.set(job.asyncId, job);

	const statuses = new Set(
		new CurrentAgents(state, acknowledgedOptions()).snapshot().rows.map(({ status }) => status),
	);
	expect(statuses).toEqual(
		new Set([
			"queued",
			"running",
			"waiting_supervisor",
			"stopping",
			"completed",
			"failed",
			"agent_stopped",
			"user_cancelled",
			"crashed",
			"resuming",
		]),
	);
});

test("keeps expected and ambiguous signalled failures distinct from crashes", () => {
	const state = createState();
	state.recentAgentJobs?.set(
		"turn-budget",
		asyncJob("turn-budget", "failed", {
			steps: [
				{
					agent: "reviewer",
					status: "failed",
					error: "Agent exceeded its turn budget (10 + 2).",
					turnBudgetExceeded: true,
					processTerminal: signalledProcessTerminal("turn-budget", "SIGKILL"),
				},
			],
		}),
	);
	state.recentAgentJobs?.set(
		"reported-error",
		asyncJob("reported-error", "failed", {
			steps: [
				{
					agent: "reviewer",
					status: "failed",
					error: "Provider mentioned SIGTERM while rejecting the request.",
				},
			],
		}),
	);
	state.recentAgentJobs?.set(
		"timed-out",
		asyncJob("timed-out", "failed", {
			steps: [
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				{
					agent: "reviewer",
					status: "failed",
					error: "Agent timed out after SIGTERM.",
					timedOut: true,
					crashed: true,
					processTerminal: signalledProcessTerminal("timed-out", "SIGTERM"),
				} as never,
			],
		}),
	);
	state.recentAgentJobs?.set(
		"unexpected-signal",
		asyncJob("unexpected-signal", "failed", {
			steps: [
				{
					agent: "reviewer",
					status: "failed",
					processTerminal: signalledProcessTerminal("unexpected-signal", "SIGSEGV", "external"),
				},
			],
		}),
	);
	state.recentAgentJobs?.set(
		"manager-signalled-error",
		asyncJob("manager-signalled-error", "failed", {
			steps: [
				{
					agent: "reviewer",
					status: "failed",
					error: "Provider rate limited the request.",
					processTerminal: signalledProcessTerminal("manager-signalled-error", "SIGTERM", "manager-final-drain"),
				},
			],
		}),
	);
	state.recentAgentJobs?.set(
		"historical-ambiguous-signal",
		asyncJob("historical-ambiguous-signal", "failed", {
			steps: [
				{
					agent: "reviewer",
					status: "failed",
					recentOutput: ["Completed the requested review with a valid final report."],
					processTerminal: signalledProcessTerminal("historical-ambiguous-signal", "SIGTERM"),
				},
			],
		}),
	);
	const snapshot = new CurrentAgents(state, acknowledgedOptions()).snapshot();
	expect(row(snapshot, "turn-budget:0").status).toBe("failed");
	expect(row(snapshot, "reported-error:0").status).toBe("failed");
	expect(row(snapshot, "timed-out:0").status).toBe("failed");
	expect(row(snapshot, "unexpected-signal:0").status).toBe("crashed");
	expect(row(snapshot, "manager-signalled-error:0").status).toBe("failed");
	expect(row(snapshot, "historical-ambiguous-signal:0").status).toBe("failed");
});

test("projects external signals as crashes without rewriting ordinary or completed exits", () => {
	const state = createState();
	state.recentAgentJobs?.set(
		"external-signal-with-error",
		asyncJob("external-signal-with-error", "failed", {
			steps: [
				{
					agent: "reviewer",
					status: "failed",
					error: "Native child terminated after a segmentation fault.",
					processTerminal: signalledProcessTerminal("external-signal-with-error", "SIGSEGV", "external"),
				},
			],
		}),
	);
	state.recentAgentJobs?.set(
		"external-wrapper-exit",
		asyncJob("external-wrapper-exit", "failed", {
			steps: [
				{
					agent: "reviewer",
					status: "failed",
					processTerminal: signalledProcessTerminal("external-wrapper-exit", null, "external", 143),
				},
			],
		}),
	);
	state.recentAgentJobs?.set(
		"ordinary-exit",
		asyncJob("ordinary-exit", "failed", {
			steps: [{ agent: "reviewer", status: "failed", error: "Build command exited with code 1." }],
		}),
	);
	state.recentAgentJobs?.set(
		"completed-signal",
		asyncJob("completed-signal", "complete", {
			steps: [
				{
					agent: "reviewer",
					status: "complete",
					processTerminal: signalledProcessTerminal("completed-signal", "SIGTERM"),
				},
			],
		}),
	);
	const snapshot = new CurrentAgents(state, acknowledgedOptions()).snapshot();
	expect(row(snapshot, "external-signal-with-error:0").status).toBe("crashed");
	expect(row(snapshot, "external-wrapper-exit:0").status).toBe("crashed");
	expect(row(snapshot, "ordinary-exit:0").status).toBe("failed");
	expect(row(snapshot, "completed-signal:0").status).toBe("completed");
});

test("repairs only strongly evidenced legacy final-drain failures to completed", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-legacy-final-drain-"));
	const transcript = (name: string, records: unknown[]): string => {
		const filePath = path.join(root, `${name}.jsonl`);
		fs.writeFileSync(filePath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
		return filePath;
	};
	const finalReport = {
		recordType: "message",
		sourceEventType: "message_end",
		role: "assistant",
		stopReason: "stop",
		text: "Complete, non-empty final report.",
		message: { role: "assistant", stopReason: "stop" },
	};
	const state = createState();
	const addLegacy = (
		id: string,
		transcriptPath: string,
		overrides: Partial<NonNullable<AsyncJobState["steps"]>[number]> = {},
		exitCode: number | null = null,
	) => {
		state.recentAgentJobs?.set(
			id,
			asyncJob(id, "failed", {
				steps: [
					{
						agent: "reviewer",
						status: "failed",
						transcriptPath,
						processTerminal: signalledProcessTerminal(
							id,
							exitCode === 143 ? null : "SIGTERM",
							undefined,
							exitCode,
						),
						...overrides,
					},
				],
			}),
		);
	};
	try {
		addLegacy("legacy-complete", transcript("complete", [finalReport]), { legacyFinalReportComplete: true });
		addLegacy(
			"legacy-wrapper-complete",
			transcript("wrapper", [finalReport]),
			{ legacyFinalReportComplete: true },
			143,
		);
		addLegacy("legacy-tool-use", transcript("tool-use", [{ ...finalReport, stopReason: "toolUse" }]));
		addLegacy("legacy-explicit-error", transcript("explicit-error", [finalReport]), {
			error: "Provider failed after output.",
		});
		addLegacy(
			"legacy-later-event",
			transcript("later-event", [finalReport, { recordType: "tool_end", sourceEventType: "tool_execution_end" }]),
		);
		state.recentAgentJobs?.set(
			"legacy-external",
			asyncJob("legacy-external", "failed", {
				steps: [
					{
						agent: "reviewer",
						status: "failed",
						transcriptPath: transcript("external", [finalReport]),
						processTerminal: signalledProcessTerminal("legacy-external", "SIGTERM", "external"),
					},
				],
			}),
		);

		const snapshot = new CurrentAgents(state, acknowledgedOptions()).snapshot();
		expect(row(snapshot, "legacy-complete:0").status).toBe("completed");
		expect(row(snapshot, "legacy-wrapper-complete:0").status).toBe("completed");
		expect(row(snapshot, "legacy-tool-use:0").status).toBe("failed");
		expect(row(snapshot, "legacy-explicit-error:0").status).toBe("failed");
		expect(row(snapshot, "legacy-later-event:0").status).toBe("failed");
		expect(row(snapshot, "legacy-external:0").status).toBe("crashed");
	} finally {
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("recovers legacy final-drain proof asynchronously before UI projection", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-legacy-final-drain-recovery-"));
	const runId = "legacy-recovered";
	const asyncDir = path.join(root, runId);
	const transcriptPath = path.join(asyncDir, "transcript.jsonl");
	fs.mkdirSync(asyncDir);
	fs.writeFileSync(transcriptPath, Buffer.alloc(1024 * 1024, 0x20));
	fs.appendFileSync(
		transcriptPath,
		`\n${JSON.stringify({
			recordType: "message",
			sourceEventType: "message_end",
			role: "assistant",
			stopReason: "stop",
			text: "Recovered final report.",
		})}\n`,
	);
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId,
			sessionId: "root-session",
			mode: "single",
			state: "failed",
			startedAt: 1_000,
			lastUpdate: 2_000,
			steps: [
				{
					agent: "reviewer",
					status: "failed",
					transcriptPath,
					processTerminal: signalledProcessTerminal(runId, "SIGTERM"),
				},
			],
		}),
	);
	const state = createFullState("root-session");
	const tracker = createAsyncJobTracker(eventHost(), state, root);
	let hostTicked = false;
	const hostTick = new Promise<void>((resolve) =>
		setTimeout(() => {
			hostTicked = true;
			resolve();
		}, 0),
	);
	try {
		await Promise.all([tracker.restoreActiveJobs(), hostTick]);
		expect(hostTicked).toBeTrue();
		expect(row(new CurrentAgents(state, acknowledgedOptions()).snapshot(), `${runId}:0`).status).toBe("completed");
	} finally {
		tracker.resetJobs();
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("returns deeply frozen copies rather than mutable Map values", () => {
	const state = createState();
	const job = asyncJob("copy", "running", { description: "original" });
	state.asyncJobs.set(job.asyncId, job);
	const current = new CurrentAgents(state, acknowledgedOptions());
	const before = current.snapshot();

	expect(Object.isFrozen(before)).toBe(true);
	expect(Object.isFrozen(before.rows)).toBe(true);
	expect(Object.isFrozen(before.rows[0])).toBe(true);

	job.description = "mutated upstream";
	job.agents = ["changed"];
	expect(before.rows[0]).toMatchObject({ name: "copy", task: "original" });
	expect(current.snapshot()).toBe(before);
	current.refresh();
	expect(current.snapshot().rows[0]).toMatchObject({ name: "changed", task: "mutated upstream" });
});
