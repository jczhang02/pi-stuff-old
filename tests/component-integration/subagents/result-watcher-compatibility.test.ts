import { afterEach, expect, test } from "bun:test";
import { createTestAgentEffectOwner } from "../../agents/agent-effect-owner-fixture.js";
import {
	Check,
	COMPLETION_EVENT_SCHEMA,
	type CompletionNotification,
	cleanupResultWatcherFixtures,
	createIntercomBus,
	createRecordingResultWatcher,
	createResultWatcher,
	createResultWatcherState,
	fs,
	type IntercomPayload,
	LEGACY_COMPLETION_SCHEMA,
	os,
	path,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	temporaryDirectories,
	waitForResultWatcher,
	writeTargetedResult,
} from "../../agents/result-watcher-fixtures.js";

afterEach(cleanupResultWatcherFixtures);

test("projects legacy result files onto the single/parallel completion contract", async () => {
	const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-contract-"));
	temporaryDirectories.push(resultsDir);
	const resultPath = path.join(resultsDir, "legacy-result.json");
	fs.writeFileSync(
		resultPath,
		JSON.stringify({
			id: "legacy-result",
			runId: "legacy-result",
			sessionId: "root-session",
			mode: "chain",
			success: true,
			summary: "complete",
			sessionFile: "/tmp/root-session.jsonl",
			chainStepCount: 2,
			workflowGraph: { nodes: [] },
			shareUrl: "https://example.invalid/shared",
			shareError: "legacy failure",
			memory: { scope: "project" },
			parallelHandoff: { path: "/tmp/retired-parallel-handoff.json" },
			results: [
				{
					agent: "writer",
					output: "implemented",
					success: true,
					sessionFile: "/tmp/writer.jsonl",
					transcriptPath: "/tmp/writer.md",
					shareUrl: "https://example.invalid/child",
				},
				{ agent: "reviewer", output: "reviewed", success: true },
			],
		}),
	);

	const { delivered, watcher } = createRecordingResultWatcher(resultsDir);

	watcher.startResultWatcher();
	watcher.primeExistingResults();
	await waitForResultWatcher(() => delivered.length > 0, 50);

	expect(delivered).toHaveLength(1);
	expect(delivered[0]).toMatchObject({
		id: "legacy-result",
		runId: "legacy-result",
		mode: "parallel",
		sessionFile: "/tmp/root-session.jsonl",
	});
	const projected = delivered[0];
	if (!projected || !Check(LEGACY_COMPLETION_SCHEMA, projected)) {
		throw new Error("Expected a projected legacy completion");
	}
	for (const retired of ["chainStepCount", "workflowGraph", "shareUrl", "shareError", "memory", "parallelHandoff"]) {
		expect(projected).not.toHaveProperty(retired);
	}
	const children = projected.results;
	expect(children[0]).toMatchObject({
		sessionFile: "/tmp/writer.jsonl",
		transcriptPath: "/tmp/writer.md",
	});
	expect(children[0]).not.toHaveProperty("shareUrl");
	watcher.stopResultWatcher();
});

test("preserves completed and paused child truth in one grouped result", async () => {
	const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-mixed-state-"));
	temporaryDirectories.push(resultsDir);
	const resultPath = path.join(resultsDir, "mixed-state.json");
	fs.writeFileSync(
		resultPath,
		JSON.stringify({
			id: "mixed-state",
			runId: "mixed-state",
			sessionId: "root-session",
			mode: "parallel",
			state: "paused",
			success: false,
			summary: "one completed, one paused",
			results: [
				{ agent: "writer", output: "finished", success: true },
				{ agent: "reviewer", output: "paused", success: false, interrupted: true },
			],
		}),
	);

	const { delivered, watcher } = createRecordingResultWatcher(resultsDir);

	watcher.startResultWatcher();
	watcher.primeExistingResults();
	await waitForResultWatcher(() => delivered.length > 0, 50);

	expect(delivered).toHaveLength(1);
	expect(delivered[0]?.results).toMatchObject([
		{ agent: "writer", status: "completed" },
		{ agent: "reviewer", status: "paused" },
	]);
	watcher.stopResultWatcher();
});

test("does not let an old epoch release a restarted delivery attempt", async () => {
	const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-epoch-race-"));
	temporaryDirectories.push(resultsDir);
	const resultPath = path.join(resultsDir, "epoch-race.json");
	fs.writeFileSync(
		resultPath,
		JSON.stringify({ id: "epoch-race", sessionId: "root-session", success: true, summary: "complete" }),
	);
	const deliveries: Array<{
		promise: Promise<boolean>;
		resolve: (value: boolean | PromiseLike<boolean>) => void;
		reject: (cause?: unknown) => void;
	}> = [];
	let calls = 0;
	const state = createResultWatcherState();
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const watcher = createResultWatcher({ events: { emit: () => {} } as never }, state, resultsDir, 60_000, {
		effects: createTestAgentEffectOwner(),
		notifier: {
			deliver: async () => {
				calls += 1;
				const pending = Promise.withResolvers<boolean>();
				deliveries.push(pending);
				return pending.promise;
			},
		},
	});

	watcher.startResultWatcher();
	watcher.primeExistingResults();
	await waitForResultWatcher(() => calls >= 1, 100, 5);
	watcher.stopResultWatcher();
	watcher.startResultWatcher();
	watcher.primeExistingResults();
	await waitForResultWatcher(() => calls >= 2, 100, 5);
	expect(calls).toBe(2);

	deliveries[0]?.resolve(true);
	await Bun.sleep(20);
	watcher.primeExistingResults();
	await Bun.sleep(100);
	expect(calls).toBe(2);

	deliveries[1]?.resolve(true);
	await waitForResultWatcher(() => !fs.existsSync(resultPath), 100, 5);
	expect(fs.existsSync(resultPath)).toBe(false);
	watcher.stopResultWatcher();
});

test("restores nested user takeover attribution before emitting a cold completion", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-nested-origin-"));
	temporaryDirectories.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDirRoot = path.join(root, "async");
	const runId = "nested-origin";
	const asyncDir = path.join(asyncDirRoot, runId);
	fs.mkdirSync(resultsDir, { recursive: true });
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId,
			sessionId: "root-session",
			parentRunOrigin: "automatic",
			mode: "single",
			state: "complete",
			startedAt: 1,
			endedAt: 2,
			lastUpdate: 2,
			steps: [{ agent: "worker", status: "complete" }],
			nestedRoute: {
				rootRunId: runId,
				eventSink: path.join(root, "nested", "events"),
				controlInbox: path.join(root, "nested", "control"),
				capabilityToken: "b".repeat(32),
			},
		}),
	);
	const resultPath = path.join(resultsDir, `${runId}.json`);
	fs.writeFileSync(
		resultPath,
		JSON.stringify({
			id: runId,
			runId,
			sessionId: "root-session",
			parentRunOrigin: "automatic",
			asyncDir,
			mode: "single",
			state: "complete",
			success: true,
			summary: "done",
			results: [{ agent: "worker", output: "done", success: true }],
		}),
	);

	const emitted: CompletionNotification[] = [];
	const notifications: CompletionNotification[] = [];
	const state = createResultWatcherState();
	const watcher = createResultWatcher(
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		{
			events: {
				emit: (channel: string, data: IntercomPayload) => {
					if (channel === SUBAGENT_ASYNC_COMPLETE_EVENT && Check(COMPLETION_EVENT_SCHEMA, data)) {
						emitted.push(data);
					}
				},
			},
		} as never,
		state,
		resultsDir,
		60_000,
		{
			asyncDirRoot,
			effects: createTestAgentEffectOwner(),
			notifier: {
				deliver: async (notification) => {
					notifications.push(notification);
					return true;
				},
			},
			projectNestedEvents: async () =>
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				({
					version: 3,
					rootRunId: runId,
					updatedAt: 3,
					children: [
						{
							id: "nested-child",
							parentRunId: runId,
							parentRunOrigin: "user",
							depth: 1,
							path: [{ runId }],
							state: "complete",
						},
					],
				}) as never,
		},
	);

	watcher.startResultWatcher();
	watcher.primeExistingResults({ triggerTurn: false });
	await waitForResultWatcher(() => emitted.length > 0);

	expect(notifications[0]?.parentRunOrigin).toBe("user");
	expect(emitted[0]?.parentRunOrigin).toBe("user");
	expect(notifications[0]).toMatchObject({ nestedChildren: [{ parentRunOrigin: "user" }] });
	watcher.stopResultWatcher();
});

test("does not deliver an old-session result after an awaited nested projection", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-projection-epoch-"));
	temporaryDirectories.push(root);
	const resultsDir = path.join(root, "results");
	const runId = "projection-epoch";
	const asyncDir = path.join(root, runId);
	fs.mkdirSync(resultsDir);
	fs.mkdirSync(asyncDir);
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId,
			sessionId: "root-session",
			mode: "single",
			state: "running",
			pid: process.pid,
			startedAt: 1,
			lastUpdate: 1,
			steps: [{ agent: "worker", status: "running" }],
			nestedRoute: {
				rootRunId: runId,
				eventSink: path.join(root, "nested", "events"),
				controlInbox: path.join(root, "nested", "control"),
				capabilityToken: "a".repeat(32),
			},
		}),
	);
	writeTargetedResult(resultsDir, runId);
	const resultPath = path.join(resultsDir, `${runId}.json`);
	const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
	fs.writeFileSync(resultPath, JSON.stringify({ ...result, asyncDir }));

	const projectionStarted = Promise.withResolvers<void>();
	const projectionRelease = Promise.withResolvers<void>();
	const { bus, received } = createIntercomBus([true]);
	const {
		delivered: notifications,
		state,
		watcher,
	} = createRecordingResultWatcher(resultsDir, {
		events: bus,
		projectNestedEvents: async () => {
			projectionStarted.resolve();
			await projectionRelease.promise;
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			return { version: 3, rootRunId: runId, updatedAt: Date.now(), children: [] } as never;
		},
	});

	watcher.startResultWatcher();
	watcher.primeExistingResults({ triggerTurn: false });
	await projectionStarted.promise;
	watcher.stopResultWatcher();
	state.currentSessionId = "replacement-session";
	projectionRelease.resolve();
	await Bun.sleep(50);

	expect(received).toEqual([]);
	expect(notifications).toEqual([]);
	expect(fs.existsSync(resultPath)).toBeTrue();
});
