import { afterEach, expect, test } from "bun:test";
import {
	cleanupResultWatcherFixtures,
	createRecordingResultWatcher,
	fs,
	os,
	path,
	readBoundedOwnedFileSnapshot,
	temporaryDirectories,
	waitForResultWatcher,
} from "../../agents/result-watcher-fixtures.js";

afterEach(cleanupResultWatcherFixtures);

test("awaits result snapshots without blocking the host event loop", async () => {
	const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-async-read-"));
	temporaryDirectories.push(resultsDir);
	const resultPath = path.join(resultsDir, "async-read.json");
	fs.writeFileSync(
		resultPath,
		JSON.stringify({ id: "async-read", sessionId: "root-session", success: true, summary: "done" }),
	);
	const readStarted = Promise.withResolvers<void>();
	const releaseRead = Promise.withResolvers<void>();
	const { delivered, watcher } = createRecordingResultWatcher(resultsDir, {
		readResultSnapshot: async (target, maxBytes) => {
			readStarted.resolve();
			await releaseRead.promise;
			return readBoundedOwnedFileSnapshot(target, maxBytes);
		},
	});

	watcher.startResultWatcher();
	watcher.primeExistingResults();
	await readStarted.promise;
	let hostTimerFired = false;
	setTimeout(() => {
		hostTimerFired = true;
	}, 0);
	await Bun.sleep(10);
	expect(hostTimerFired).toBeTrue();
	releaseRead.resolve();
	await waitForResultWatcher(() => delivered.length > 0 && !fs.existsSync(resultPath));

	expect(delivered).toHaveLength(1);
	expect(fs.existsSync(resultPath)).toBeFalse();
	watcher.stopResultWatcher();
});

test("reads an unchanged foreign-session result once and revisits an atomic replacement", async () => {
	const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-foreign-cache-"));
	temporaryDirectories.push(resultsDir);
	const resultPath = path.join(resultsDir, "shared-name.json");
	fs.writeFileSync(
		resultPath,
		JSON.stringify({ id: "shared-name", sessionId: "other-session", success: true, summary: "foreign" }),
	);
	let reads = 0;
	const inertWatcher = {
		close: () => {},
		on: () => inertWatcher,
		unref: () => inertWatcher,
	};
	const { delivered, watcher } = createRecordingResultWatcher(resultsDir, {
		fs: {
			existsSync: fs.existsSync,
			realpathSync: fs.realpathSync,
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			watch: (() => inertWatcher) as never,
		},
		readResultSnapshot: (target, maxBytes) => {
			reads += 1;
			return readBoundedOwnedFileSnapshot(target, maxBytes);
		},
	});

	watcher.startResultWatcher();
	for (let scan = 0; scan < 3; scan += 1) {
		watcher.primeExistingResults();
		await Bun.sleep(100);
	}
	expect(reads).toBe(1);
	expect(fs.existsSync(resultPath)).toBe(true);

	const replacement = path.join(resultsDir, ".shared-name.replacement");
	fs.writeFileSync(
		replacement,
		JSON.stringify({
			id: "shared-name",
			parentRunOrigin: "user",
			sessionId: "root-session",
			success: true,
			summary: "now local",
		}),
	);
	fs.renameSync(replacement, resultPath);
	watcher.primeExistingResults();
	await waitForResultWatcher(() => delivered.length > 0 && !fs.existsSync(resultPath));

	expect(reads).toBe(2);
	expect(delivered).toHaveLength(1);
	expect(delivered[0]?.parentRunOrigin).toBe("user");
	expect(fs.existsSync(resultPath)).toBe(false);
	watcher.stopResultWatcher();
});

test("caches an unchanged invalid async binding and revisits an atomic replacement", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-invalid-cache-"));
	temporaryDirectories.push(root);
	const resultsDir = path.join(root, "results");
	const asyncDirRoot = path.join(root, "async");
	fs.mkdirSync(resultsDir, { mode: 0o700 });
	fs.mkdirSync(asyncDirRoot, { mode: 0o700 });
	const resultPath = path.join(resultsDir, "unsafe-binding.json");
	fs.writeFileSync(
		resultPath,
		JSON.stringify({
			id: "unsafe-binding",
			runId: "unsafe-binding",
			sessionId: "root-session",
			asyncDir: path.join(root, "outside-runtime"),
			success: true,
			summary: "unsafe",
		}),
	);
	let reads = 0;
	const inertWatcher = { close: () => {}, on: () => inertWatcher, unref: () => inertWatcher };
	const { delivered, watcher } = createRecordingResultWatcher(resultsDir, {
		asyncDirRoot,
		fs: {
			existsSync: fs.existsSync,
			realpathSync: fs.realpathSync,
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			watch: (() => inertWatcher) as never,
		},
		readResultSnapshot: (target, maxBytes) => {
			reads += 1;
			return readBoundedOwnedFileSnapshot(target, maxBytes);
		},
	});

	watcher.startResultWatcher();
	for (let scan = 0; scan < 3; scan += 1) {
		watcher.primeExistingResults();
		await Bun.sleep(100);
	}
	expect(reads).toBe(1);
	expect(fs.existsSync(resultPath)).toBeTrue();

	const replacement = path.join(resultsDir, ".unsafe-binding.replacement");
	fs.writeFileSync(
		replacement,
		JSON.stringify({ id: "unsafe-binding", sessionId: "root-session", success: true, summary: "safe now" }),
	);
	fs.renameSync(replacement, resultPath);
	watcher.primeExistingResults();
	await waitForResultWatcher(() => delivered.length > 0 && !fs.existsSync(resultPath));

	expect(reads).toBe(2);
	expect(delivered).toHaveLength(1);
	expect(fs.existsSync(resultPath)).toBeFalse();
	watcher.stopResultWatcher();
});

test("contains a durable result-claim release failure", async () => {
	const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-result-release-failure-"));
	temporaryDirectories.push(resultsDir);
	const resultPath = path.join(resultsDir, "release-failure.json");
	fs.writeFileSync(
		resultPath,
		JSON.stringify({ id: "release-failure", sessionId: "root-session", success: true, summary: "done" }),
	);
	const unhandled: unknown[] = [];
	const onUnhandled = (cause: unknown) => unhandled.push(cause);
	process.on("unhandledRejection", onUnhandled);
	let releases = 0;
	const { watcher } = createRecordingResultWatcher(resultsDir, {
		acquireClaim: () => ({
			directory: path.join(resultsDir, "fake.lock"),
			token: "fake",
			release: () => {
				releases += 1;
				throw Object.assign(new Error("injected claim close EIO"), { code: "EIO" });
			},
		}),
	});

	try {
		watcher.startResultWatcher();
		watcher.primeExistingResults();
		await waitForResultWatcher(() => !fs.existsSync(resultPath));
		await Bun.sleep(25);
		expect(fs.existsSync(resultPath)).toBeFalse();
		expect(releases).toBe(1);
		expect(unhandled).toEqual([]);
	} finally {
		watcher.stopResultWatcher();
		process.off("unhandledRejection", onUnhandled);
	}
});
