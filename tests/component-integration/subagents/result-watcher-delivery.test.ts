import { afterEach, expect, test } from "bun:test";
import {
	cleanupResultWatcherFixtures,
	createIntercomBus,
	createRecordingResultWatcher,
	fs,
	os,
	path,
	reconcileAsyncRun,
	temporaryDirectories,
	waitForResultWatcher,
	writeTargetedResult,
} from "../../agents/result-watcher-fixtures.js";

afterEach(cleanupResultWatcherFixtures);

test("delivers a cold targeted result without waking the main model, then deletes it after acknowledgement", async () => {
	const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-cold-target-"));
	temporaryDirectories.push(resultsDir);
	const resultPath = writeTargetedResult(resultsDir, "cold-target");
	const { bus, received } = createIntercomBus([true]);
	const { delivered: notifications, watcher } = createRecordingResultWatcher(resultsDir, { events: bus });

	watcher.startResultWatcher();
	watcher.primeExistingResults({ triggerTurn: false });
	await waitForResultWatcher(() => !fs.existsSync(resultPath));

	expect(received).toHaveLength(1);
	expect(received[0]).toMatchObject({ to: "parent-agent", runId: "cold-target" });
	expect(notifications).toHaveLength(1);
	expect(notifications[0]?.triggerTurn).toBe(false);
	expect(fs.existsSync(resultPath)).toBe(false);
	watcher.stopResultWatcher();
});

test("retains and retries a cold targeted result until target delivery is acknowledged", async () => {
	const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-cold-retry-"));
	temporaryDirectories.push(resultsDir);
	const resultPath = writeTargetedResult(resultsDir, "cold-retry");
	const { bus, received } = createIntercomBus([false, true]);
	const { delivered: notifications, watcher } = createRecordingResultWatcher(resultsDir, { events: bus });

	watcher.startResultWatcher();
	watcher.primeExistingResults({ triggerTurn: false });
	await waitForResultWatcher(() => received.length >= 1);
	expect(received).toHaveLength(1);
	expect(fs.existsSync(resultPath)).toBe(true);
	await waitForResultWatcher(() => received.length >= 2);
	await waitForResultWatcher(() => !fs.existsSync(resultPath));

	expect(received).toHaveLength(2);
	expect(received[0]?.requestId).toBe(received[1]?.requestId);
	expect(notifications).toHaveLength(1);
	expect(notifications[0]?.triggerTurn).toBe(false);
	expect(fs.existsSync(resultPath)).toBe(false);
	watcher.stopResultWatcher();
});

test("repairs terminal status before deleting an accepted result so reload cannot invent a crash", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-reload-"));
	temporaryDirectories.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(root, "reload-safe-result");
	fs.mkdirSync(resultsDir);
	fs.mkdirSync(asyncDir);
	const resultPath = path.join(resultsDir, "reload-safe-result.json");
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId: "reload-safe-result",
			sessionId: "root-session",
			mode: "single",
			state: "running",
			pid: 2_147_000_000,
			startedAt: 1_000,
			lastUpdate: 1_500,
			steps: [{ agent: "writer", status: "complete", startedAt: 1_000, endedAt: 2_000, exitCode: 0 }],
		}),
	);
	fs.writeFileSync(
		resultPath,
		JSON.stringify({
			id: "reload-safe-result",
			runId: "reload-safe-result",
			sessionId: "root-session",
			parentRunOrigin: "user",
			asyncDir,
			mode: "single",
			state: "complete",
			success: true,
			summary: "completed before final status write",
			startedAt: 1_000,
			endedAt: 2_000,
			results: [{ agent: "writer", output: "done", success: true, exitCode: 0 }],
		}),
	);

	const { delivered, watcher } = createRecordingResultWatcher(resultsDir);

	watcher.startResultWatcher();
	watcher.primeExistingResults();
	await waitForResultWatcher(() => !fs.existsSync(resultPath));
	expect(delivered).toHaveLength(1);
	expect(delivered[0]?.parentRunOrigin).toBe("user");
	expect(fs.existsSync(resultPath)).toBe(false);
	expect(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"))).toMatchObject({
		parentRunOrigin: "user",
		state: "complete",
		steps: [{ status: "complete" }],
	});

	const reloaded = reconcileAsyncRun(asyncDir, {
		resultsDir,
		kill: () => {
			throw Object.assign(new Error("gone"), { code: "ESRCH" });
		},
	});
	expect(reloaded).toMatchObject({ repaired: false, status: { state: "complete" } });
	expect(fs.existsSync(resultPath)).toBe(false);
	watcher.stopResultWatcher();
});

test("delivers a durable result once while missing status is repaired with bounded retry", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-missing-status-"));
	temporaryDirectories.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDir = path.join(root, "late-status");
	fs.mkdirSync(resultsDir);
	const resultPath = path.join(resultsDir, "late-status.json");
	fs.writeFileSync(
		resultPath,
		JSON.stringify({
			id: "late-status",
			runId: "late-status",
			sessionId: "root-session",
			asyncDir,
			mode: "single",
			state: "complete",
			success: true,
			summary: "durable completion",
			startedAt: 1_000,
			endedAt: 2_000,
			results: [{ agent: "writer", output: "done", success: true, exitCode: 0 }],
		}),
	);
	const { delivered, watcher } = createRecordingResultWatcher(resultsDir);

	watcher.startResultWatcher();
	watcher.primeExistingResults({ triggerTurn: false });
	await waitForResultWatcher(() => delivered.length > 0);
	expect(delivered).toHaveLength(1);
	expect(delivered[0]?.triggerTurn).toBe(false);
	expect(fs.existsSync(resultPath)).toBe(true);
	await Bun.sleep(650);
	expect(delivered).toHaveLength(1);

	fs.mkdirSync(asyncDir);
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId: "late-status",
			sessionId: "root-session",
			mode: "single",
			state: "running",
			pid: process.pid,
			startedAt: 1_000,
			lastUpdate: 1_500,
			steps: [{ agent: "writer", status: "complete", exitCode: 0 }],
		}),
	);
	await waitForResultWatcher(() => !fs.existsSync(resultPath), 300);
	expect(delivered).toHaveLength(1);
	expect(fs.existsSync(resultPath)).toBe(false);
	expect(JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"))).toMatchObject({
		state: "complete",
	});
	watcher.stopResultWatcher();
});

test("recovers the final result name when fs.watch reports only its atomic temp rename", async () => {
	const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-watcher-"));
	temporaryDirectories.push(resultsDir);
	const resultFile = "atomic-result.json";
	const resultPath = path.join(resultsDir, resultFile);
	fs.writeFileSync(
		resultPath,
		JSON.stringify({ id: "atomic-result", sessionId: "root-session", success: true, summary: "complete" }),
	);

	let watchListener:
		| ((event: "change" | "rename", filename: Buffer<ArrayBufferLike> | string | null) => void)
		| undefined;
	const fakeWatcher = {
		close: () => {},
		on: () => fakeWatcher,
		unref: () => fakeWatcher,
	};
	const { delivered, watcher } = createRecordingResultWatcher(resultsDir, {
		fs: {
			existsSync: fs.existsSync,
			realpathSync: fs.realpathSync,
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			watch: ((_directory: Parameters<typeof fs.watch>[0], listener: typeof watchListener) => {
				watchListener = listener;
				return fakeWatcher;
			}) as never,
		},
	});

	watcher.startResultWatcher();
	if (!watchListener) throw new Error("Expected fs.watch listener");
	watchListener("rename", `.${resultFile}.321.123456.abc123.tmp`);
	await waitForResultWatcher(() => delivered.length > 0 && !fs.existsSync(resultPath), 50);

	expect(delivered).toHaveLength(1);
	expect(delivered[0]).toMatchObject({ id: "atomic-result", sessionId: "root-session", triggerTurn: true });
	expect(fs.existsSync(resultPath)).toBe(false);
	watcher.stopResultWatcher();
});
