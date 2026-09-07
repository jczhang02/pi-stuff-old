import { expect, test } from "bun:test";
import {
	acknowledgedOptions,
	asyncJob,
	CurrentAgents,
	createAsyncJobTracker,
	createFullState,
	createState,
	eventHost,
	fs,
	os,
	path,
	row,
	SUBAGENT_CONTROL_EVENT,
	signalChannel,
	waitUntil,
} from "../../agents/current-agents-fixtures.js";

test("keeps the next valid control event after an oversized line crosses a scan window", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-control-window-"));
	const runId = "control-window";
	const asyncDir = path.join(root, runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId,
			sessionId: "root-session",
			mode: "single",
			state: "running",
			pid: process.pid,
			startedAt: 1_000,
			lastUpdate: 2_000,
			steps: [{ agent: "reviewer", status: "running", startedAt: 1_000 }],
		}),
	);
	const validEvent = JSON.stringify({
		type: "subagent.control",
		event: { type: "needs_attention", ts: 2_000, runId, index: 0, reason: "fixture" },
		channels: ["event"],
	});
	fs.writeFileSync(path.join(asyncDir, "events.jsonl"), `${"x".repeat(2 * 1024 * 1024 + 257)}\n${validEvent}\n`);
	const state = createFullState("root-session");
	const delivered: unknown[] = [];
	const tracker = createAsyncJobTracker(
		eventHost((event, payload) => {
			if (event === SUBAGENT_CONTROL_EVENT) delivered.push(payload);
		}),
		state,
		root,
		{ pollIntervalMs: 10 },
	);
	try {
		tracker.handleStarted({
			id: runId,
			asyncDir,
			sessionId: "root-session",
			mode: "single",
			agents: ["reviewer"],
		});
		await waitUntil(() => delivered.length === 1, 3_000);
		expect(delivered).toHaveLength(1);
		expect(state.asyncJobs.get(runId)?.controlEventCursor).toBe(
			fs.statSync(path.join(asyncDir, "events.jsonl")).size,
		);
	} finally {
		tracker.resetJobs();
		await Bun.sleep(20);
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("refreshes state-driven consumers and notifies only on semantic changes", () => {
	const state = createState();
	const live = asyncJob("live", "running", { description: "first" });
	state.asyncJobs.set(live.asyncId, live);
	const current = new CurrentAgents(state, acknowledgedOptions());
	const tasks: string[] = [];
	current.subscribe((snapshot) => tasks.push(row(snapshot, "live:0").task));

	live.description = "changed";
	current.refresh();
	current.refresh();

	expect(tasks).toEqual(["first", "changed"]);
});

test("refreshes consumers from status events without a foreground poll loop", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-agent-refresh-"));
	const asyncDir = path.join(root, "live");
	fs.mkdirSync(asyncDir);
	const state = createFullState("root-session");
	let refreshes = 0;
	const tracker = createAsyncJobTracker(eventHost(), state, root, {
		onRefresh: () => {
			refreshes += 1;
		},
		readRunStatus: async () => null,
	});

	try {
		tracker.handleStarted({ id: "live", asyncDir, sessionId: "root-session" });
		await waitUntil(() => refreshes === 1);
		tracker.handleStatus({
			id: "live",
			asyncDir,
			sessionId: "root-session",
			status: {
				runId: "live",
				sessionId: "root-session",
				mode: "single",
				state: "running",
				startedAt: 1_000,
				lastUpdate: 2_000,
				currentTool: "read",
				steps: [{ agent: "reviewer", status: "running", currentTool: "read" }],
			},
		});
		await waitUntil(() => refreshes >= 2);
		const settledRefreshes = refreshes;
		await Bun.sleep(40);
		expect(state.asyncJobs.get("live")?.currentTool).toBe("read");
		expect(refreshes).toBe(settledRefreshes);
	} finally {
		tracker.resetJobs();
		await Bun.sleep(20);
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("keeps terminal rows in the detail authority across elapsed time", () => {
	const state = createState();
	const stateSignal = signalChannel();
	let now = 5_000;
	state.asyncJobs.set("live", asyncJob("live", "running"));
	state.recentAgentJobs?.set("old-terminal", asyncJob("old-terminal", "complete"));
	const snapshots: string[][] = [];
	const current = new CurrentAgents(
		state,
		acknowledgedOptions({
			now: () => now,
			subscribeState: stateSignal.subscribe,
		}),
	);
	current.subscribe((snapshot) => snapshots.push(snapshot.rows.map(({ key }) => key)));

	now = 500_000;
	stateSignal.emit();
	expect(snapshots).toHaveLength(1);
	expect(current.snapshot().rows.some(({ key }) => key === "old-terminal:0")).toBe(true);

	expect(current.snapshot().rows.map(({ key }) => key)).toEqual(["live:0", "old-terminal:0"]);
	state.recentAgentJobs?.set("new-terminal", asyncJob("new-terminal", "failed"));
	stateSignal.emit();
	expect(current.snapshot().rows.some(({ key }) => key === "new-terminal:0")).toBe(true);
	expect(current.snapshot().rows.some(({ key }) => key === "old-terminal:0")).toBe(true);

	state.currentSessionId = "second-session";
	state.asyncJobs.clear();
	state.recentAgentJobs?.set("old-terminal", asyncJob("old-terminal", "complete", { sessionId: "second-session" }));
	stateSignal.emit();
	expect(current.snapshot().rows.map(({ key }) => key)).toEqual(["old-terminal:0"]);
});

test("deduplicates notifications and becomes quiet after unsubscribe or dispose", async () => {
	const state = createState();
	const stateSignal = signalChannel();
	const live = asyncJob("live", "running", { description: "first" });
	state.asyncJobs.set(live.asyncId, live);
	let stopCalls = 0;
	const current = new CurrentAgents(
		state,
		acknowledgedOptions({
			subscribeState: stateSignal.subscribe,
			stop: () => {
				stopCalls += 1;
				return true;
			},
		}),
	);
	const revisions: number[] = [];
	const unsubscribe = current.subscribe(({ revision }) => revisions.push(revision));

	stateSignal.emit();
	stateSignal.emit();
	expect(revisions).toHaveLength(1);
	live.description = "changed";
	stateSignal.emit();
	expect(revisions).toHaveLength(2);

	unsubscribe();
	live.description = "changed again";
	stateSignal.emit();
	expect(revisions).toHaveLength(2);
	expect(stateSignal.size).toBe(1);

	current.dispose();
	expect(stateSignal.size).toBe(0);
	stateSignal.emit();
	const result = await current.control({ type: "stop", key: "live:0" });
	expect(result).toMatchObject({ acknowledged: false, status: null });
	expect(stopCalls).toBe(0);
});
