import { afterEach, expect, test } from "bun:test";
import {
	ASYNC_DIR,
	acquireRunnerProcessStartIdentity,
	type BackgroundRunnerConfig,
	buildNestedTerminalFallbackStatus,
	claimBackgroundRunDirectory,
	cleanupBackgroundEngineFixtures,
	cleanupBackgroundRunAfterAbort,
	finalizeSpawnedRunnerClose,
	fixtureRoot,
	fs,
	initializePreIdentityWriterAbsenceProof,
	initializeWriterProcessRegistry,
	inspectWriterProcessLiveness,
	nestedFallbackConfig,
	path,
	randomUUID,
	reconcileAsyncRun,
	removeRunnerStartupMarkerBestEffort,
	resolveBackgroundOwnershipFailure,
	spawn,
	temporaryDirectories,
	terminateRunnerBeforeProceed,
	waitForStartupControl,
} from "../../agents/background-engine-fixtures.js";

afterEach(cleanupBackgroundEngineFixtures);

test("does not block Pi's event loop while aborting an exact gated runner", async () => {
	if (process.platform === "win32") return;
	const child = spawn(
		process.execPath,
		["-e", 'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1000);'],
		{ detached: true, stdio: ["ignore", "pipe", "pipe"] },
	);
	try {
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Gated runner probe did not start.")), 3_000);
			child.once("error", reject);
			child.stdout?.once("data", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
		if (!child.pid) throw new Error("Gated runner probe has no PID.");
		const identity = await acquireRunnerProcessStartIdentity(child.pid);
		if (!identity) throw new Error("Gated runner probe has no process identity.");
		const startedAt = performance.now();
		terminateRunnerBeforeProceed(child.pid, identity);
		expect(performance.now() - startedAt).toBeLessThan(250);
		await new Promise<void>((resolve) => child.once("close", () => resolve()));
	} finally {
		if (child.pid && child.exitCode === null && child.signalCode === null) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
		}
	}
}, 5_000);

test("refuses to overwrite an existing background lifecycle directory", () => {
	const id = randomUUID().replaceAll("-", "").slice(0, 12);
	const asyncDir = path.join(ASYNC_DIR, id);
	temporaryDirectories.push(asyncDir);
	fs.mkdirSync(asyncDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(asyncDir, "sentinel"), "retained evidence");

	const claimed = claimBackgroundRunDirectory(id);

	expect(claimed).toMatchObject({ error: expect.stringContaining("refusing to overwrite") });
	expect(fs.readFileSync(path.join(asyncDir, "sentinel"), "utf8")).toBe("retained evidence");
});

test("failed background preparation never deletes a replacement directory", () => {
	const id = randomUUID().replaceAll("-", "").slice(0, 12);
	const claimed = claimBackgroundRunDirectory(id);
	if ("error" in claimed) throw new Error(claimed.error);
	const originalDir = `${claimed.asyncDir}.original`;
	temporaryDirectories.push(claimed.asyncDir, originalDir);
	fs.renameSync(claimed.asyncDir, originalDir);
	fs.mkdirSync(claimed.asyncDir, { mode: 0o700 });
	fs.writeFileSync(path.join(claimed.asyncDir, "sentinel"), "replacement");

	claimed.cleanup();

	expect(fs.readFileSync(path.join(claimed.asyncDir, "sentinel"), "utf8")).toBe("replacement");
	expect(fs.existsSync(originalDir)).toBe(true);
});

test("committing background preparation removes only its ownership marker", () => {
	const id = randomUUID().replaceAll("-", "").slice(0, 12);
	const claimed = claimBackgroundRunDirectory(id);
	if ("error" in claimed) throw new Error(claimed.error);
	temporaryDirectories.push(claimed.asyncDir);
	const marker = path.join(claimed.asyncDir, ".background-preparation-owner.json");
	expect(fs.existsSync(marker)).toBe(true);

	expect(claimed.commit()).toBe(true);

	expect(fs.existsSync(claimed.asyncDir)).toBe(true);
	expect(fs.existsSync(marker)).toBe(false);
});

test("retains lifecycle evidence unless abort proves the runner and writers exited", () => {
	const unsafeId = randomUUID().replaceAll("-", "").slice(0, 12);
	const unsafeClaim = claimBackgroundRunDirectory(unsafeId);
	if ("error" in unsafeClaim) throw new Error(unsafeClaim.error);
	temporaryDirectories.push(unsafeClaim.asyncDir);

	expect(cleanupBackgroundRunAfterAbort(unsafeClaim, () => false)).toBe(false);
	expect(fs.existsSync(unsafeClaim.asyncDir)).toBe(true);
	expect(fs.existsSync(path.join(unsafeClaim.asyncDir, ".background-preparation-owner.json"))).toBe(true);

	const safeId = randomUUID().replaceAll("-", "").slice(0, 12);
	const safeClaim = claimBackgroundRunDirectory(safeId);
	if ("error" in safeClaim) throw new Error(safeClaim.error);
	temporaryDirectories.push(safeClaim.asyncDir);
	expect(cleanupBackgroundRunAfterAbort(safeClaim, () => true)).toBe(true);
	expect(fs.existsSync(safeClaim.asyncDir)).toBe(false);
});

for (const abortFailure of ["false", "throw"] as const) {
	test(`retains a complete lifecycle binding when post-spawn ownership abort returns ${abortFailure}`, () => {
		const id = randomUUID().replaceAll("-", "").slice(0, 12);
		const claimed = claimBackgroundRunDirectory(id);
		if ("error" in claimed) throw new Error(claimed.error);
		temporaryDirectories.push(claimed.asyncDir);
		const acknowledgeStart = () => {};
		const abortStart = () => {
			if (abortFailure === "throw") throw Object.assign(new Error("injected abort EIO"), { code: "EIO" });
			return false;
		};

		const resolution = resolveBackgroundOwnershipFailure(claimed, {
			pid: 41_001,
			processStartIdentity: "boot:41001",
			acknowledgeStart,
			abortStart,
		});

		expect(resolution).toEqual({
			safeToRelease: false,
			lifecycleBinding: {
				pid: 41_001,
				processStartIdentity: "boot:41001",
				asyncDir: claimed.asyncDir,
				acknowledgeStart,
				abortStart,
			},
		});
		expect(fs.existsSync(claimed.asyncDir)).toBe(true);
		expect(fs.existsSync(path.join(claimed.asyncDir, ".background-preparation-owner.json"))).toBe(false);
	});
}

test("retains the actual runner pid and runtime directory when startup identity is unavailable", () => {
	const id = randomUUID().replaceAll("-", "").slice(0, 12);
	const claimed = claimBackgroundRunDirectory(id);
	if ("error" in claimed) throw new Error(claimed.error);
	temporaryDirectories.push(claimed.asyncDir);

	const resolution = resolveBackgroundOwnershipFailure(claimed, { pid: 41_002 });

	expect(resolution).toEqual({
		safeToRelease: false,
		lifecycleBinding: {
			pid: 41_002,
			asyncDir: claimed.asyncDir,
		},
	});
	expect(fs.existsSync(claimed.asyncDir)).toBeTrue();
	expect(fs.existsSync(path.join(claimed.asyncDir, ".background-preparation-owner.json"))).toBeFalse();
});

test("pre-initializes revival writer absence before identity capture and an unsafe delayed close", () => {
	const root = fixtureRoot();
	const id = randomUUID().replaceAll("-", "").slice(0, 12);
	const claimed = claimBackgroundRunDirectory(id);
	if ("error" in claimed) throw new Error(claimed.error);
	temporaryDirectories.push(claimed.asyncDir);
	const runnerPid = 41_003;
	const config: BackgroundRunnerConfig = {
		version: 2,
		id,
		cwd: root,
		asyncDir: claimed.asyncDir,
		resultPath: path.join(claimed.asyncDir, "result.json"),
		revivalLease: {
			sessionFile: path.join(root, "child-session.jsonl"),
			runId: id,
			sourceRunId: "source-run",
			asyncDir: claimed.asyncDir,
		},
		work: nestedFallbackConfig(root, path.join(claimed.asyncDir, "result.json")).work,
	};

	expect(initializePreIdentityWriterAbsenceProof(config, runnerPid)).toBeTrue();
	const resolution = resolveBackgroundOwnershipFailure(claimed, { pid: runnerPid });

	expect(resolution).toMatchObject({
		safeToRelease: false,
		lifecycleBinding: { pid: runnerPid, asyncDir: claimed.asyncDir },
	});
	expect(inspectWriterProcessLiveness(claimed.asyncDir)).toBeFalse();
});

test("does not turn post-authorization startup marker cleanup into a false launch failure", () => {
	expect(() =>
		removeRunnerStartupMarkerBestEffort("/tmp/runner-startup.json", () => {
			throw Object.assign(new Error("injected cleanup EIO"), { code: "EIO" });
		}),
	).not.toThrow();
});

test("retries a startup control removed before open without accepting invalid controls", async () => {
	const root = fixtureRoot();
	const controlPath = path.join(root, "runner-startup-control.json");
	fs.writeFileSync(controlPath, JSON.stringify({ action: "proceed", token: "expected-token" }));
	let cleanupInjected = false;
	const waiting = waitForStartupControl(controlPath, "expected-token", "proceed", 200, (path) => {
		if (!cleanupInjected) {
			expect(fs.existsSync(path)).toBeTrue();
			cleanupInjected = true;
			fs.rmSync(path);
		}
		return fs.readFileSync(path, "utf8");
	});
	setTimeout(() => {
		fs.writeFileSync(controlPath, JSON.stringify({ action: "proceed", token: "expected-token" }));
	}, 25);
	await waiting;
	expect(cleanupInjected).toBeTrue();

	fs.writeFileSync(controlPath, "not-json");
	await expect(waitForStartupControl(controlPath, "expected-token", "proceed", 50)).rejects.toThrow();
	fs.writeFileSync(controlPath, JSON.stringify({ action: "proceed", token: "wrong-token" }));
	await expect(waitForStartupControl(controlPath, "expected-token", "proceed", 50)).rejects.toThrow(
		"Runner startup token does not match the session lease.",
	);
	fs.writeFileSync(controlPath, JSON.stringify({ action: "launch", token: "expected-token" }));
	await expect(waitForStartupControl(controlPath, "expected-token", "proceed", 50)).rejects.toThrow(
		"Runner startup control action is invalid.",
	);
});

test("contains close-time terminal proof failure when the runtime directory disappears", () => {
	const root = fixtureRoot();
	const missingDir = path.join(root, "removed-before-close");
	const config: BackgroundRunnerConfig = {
		...nestedFallbackConfig(root, path.join(missingDir, "result.json")),
		id: "removed-before-close",
		asyncDir: missingDir,
	};

	expect(() =>
		finalizeSpawnedRunnerClose({
			launchConfig: config,
			runnerProcessInstanceId: "runner-close-proof",
			exitCode: 1,
			signal: null,
		}),
	).not.toThrow();
});

const RECOVERY_FIXTURES = [
	{
		runId: "repair-paused",
		state: "paused",
		startedAt: 1_000,
		endedAt: 1_500,
		now: 100_000,
		child: { success: false, exitCode: 1, interrupted: true, error: "Agent paused." },
		expected: { status: "paused", error: "Agent paused." },
		missingStatus: true,
	},
	{
		runId: "repair-stopped",
		state: "stopped",
		now: 2_000,
		child: { success: false, exitCode: 1, stopped: true, error: "Agent stopped by user." },
		expected: { status: "stopped", stopped: true, error: "Agent stopped by user." },
		missingStatus: false,
	},
	{
		runId: "repair-timeout",
		state: "failed",
		now: 2_000,
		timedOut: true,
		child: {
			success: false,
			exitCode: 1,
			timedOut: true,
			error: "Agent timed out.",
			attemptedModels: ["test/first"],
			modelAttempts: [
				{
					model: "test/first",
					success: false,
					exitCode: 1,
					error: "provider timeout",
					usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5, turns: 1 },
				},
			],
			totalCost: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 },
			turnBudget: { maxTurns: 1, graceTurns: 0, turnCount: 2, outcome: "exceeded" },
			turnBudgetExceeded: true,
			wrapUpRequested: true,
			toolBudget: { hard: 3, block: "*", outcome: "hard-blocked", toolCount: 3 },
			toolBudgetBlocked: true,
		},
		expected: {
			status: "failed",
			timedOut: true,
			attemptedModels: ["test/first"],
			modelAttempts: [{ model: "test/first", error: "provider timeout" }],
			totalCost: { inputTokens: 1, outputTokens: 2, costUsd: 0.5 },
			turnBudget: { maxTurns: 1, graceTurns: 0, turnCount: 2, outcome: "exceeded" },
			turnBudgetExceeded: true,
			wrapUpRequested: true,
			toolBudget: { hard: 3, block: "*", outcome: "hard-blocked", toolCount: 3 },
			toolBudgetBlocked: true,
			error: "Agent timed out.",
		},
		missingStatus: false,
	},
] as const;

test("repairs paused, stopped, and timed-out child state from durable results", () => {
	const root = fixtureRoot();
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(resultsDir, { recursive: true });

	for (const fixture of RECOVERY_FIXTURES) {
		const asyncDir = path.join(root, fixture.runId);
		fs.mkdirSync(asyncDir, { recursive: true });
		if (!fixture.missingStatus) {
			fs.writeFileSync(
				path.join(asyncDir, "status.json"),
				JSON.stringify({
					runId: fixture.runId,
					mode: "single",
					state: "running",
					startedAt: 1_000,
					currentTool: "read",
					currentToolStartedAt: 1_100,
					currentPath: "/repo/stale.ts",
					steps: [
						{
							agent: "writer",
							status: "running",
							startedAt: 1_000,
							currentTool: "read",
							currentToolArgs: "stale.ts",
							currentToolStartedAt: 1_100,
							currentPath: "/repo/stale.ts",
						},
					],
				}),
			);
		}
		const storedResult = {
			runId: fixture.runId,
			state: fixture.state,
			success: false,
			results: [{ agent: "writer", output: fixture.child.error, ...fixture.child }],
		};
		if ("startedAt" in fixture) {
			Object.assign(storedResult, { startedAt: fixture.startedAt, endedAt: fixture.endedAt });
		}
		if ("timedOut" in fixture && fixture.timedOut) Object.assign(storedResult, { timedOut: true });
		fs.writeFileSync(path.join(resultsDir, `${fixture.runId}.json`), JSON.stringify(storedResult));

		const reconcileOptions: Parameters<typeof reconcileAsyncRun>[1] = {
			resultsDir,
			now: () => fixture.now,
		};
		if (fixture.missingStatus) {
			reconcileOptions.startedRun = {
				runId: fixture.runId,
				mode: "single",
				agents: ["writer"],
				startedAt: 1_000,
			};
		}
		const repaired = reconcileAsyncRun(asyncDir, reconcileOptions);

		expect(repaired.repaired).toBe(true);
		expect(repaired.status?.state).toBe(fixture.state);
		expect(repaired.status?.steps?.[0]).toMatchObject(fixture.expected);
		expect(repaired.status?.currentTool).toBeUndefined();
		expect(repaired.status?.currentPath).toBeUndefined();
		expect(repaired.status?.steps?.[0]?.currentTool).toBeUndefined();
		expect(repaired.status?.steps?.[0]?.currentToolArgs).toBeUndefined();
		expect(repaired.status?.steps?.[0]?.currentPath).toBeUndefined();
		if ("timedOut" in fixture && fixture.timedOut) expect(repaired.status?.timedOut).toBe(true);
		if ("endedAt" in fixture) {
			expect(repaired.status?.endedAt).toBe(fixture.endedAt);
			expect(repaired.status?.lastUpdate).toBe(fixture.endedAt);
			expect(repaired.status?.steps?.[0]?.endedAt).toBe(fixture.endedAt);
			expect(repaired.status?.steps?.[0]?.durationMs).toBe(500);
		}
	}
});

test("prefers a result committed while stale-run liveness is being checked", () => {
	const root = fixtureRoot();
	const runId = "result-during-liveness";
	const asyncDir = path.join(root, runId);
	const resultsDir = path.join(root, "results-during-liveness");
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.mkdirSync(resultsDir, { recursive: true });
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId,
			mode: "single",
			state: "running",
			pid: 2_147_483_647,
			processStartIdentity: "dead-runner",
			startedAt: 1_000,
			steps: [{ agent: "writer", status: "running", startedAt: 1_000 }],
		}),
	);
	initializeWriterProcessRegistry(asyncDir, runId, process.pid, 1);
	const resultPath = path.join(resultsDir, `${runId}.json`);
	let committed = false;

	const repaired = reconcileAsyncRun(asyncDir, {
		resultsDir,
		now: () => 2_000,
		kill: (_pid, signal) => {
			if (signal === 0 && !committed) {
				committed = true;
				fs.writeFileSync(
					resultPath,
					JSON.stringify({
						runId,
						state: "complete",
						success: true,
						results: [{ agent: "writer", output: "REAL_SUCCESS", success: true, exitCode: 0 }],
					}),
				);
			}
			throw Object.assign(new Error("dead"), { code: "ESRCH" });
		},
	});

	expect(repaired.status).toMatchObject({
		state: "complete",
		steps: [{ status: "complete", exitCode: 0 }],
	});
	expect(JSON.parse(fs.readFileSync(resultPath, "utf8"))).toMatchObject({
		state: "complete",
		success: true,
		results: [{ output: "REAL_SUCCESS" }],
	});
});

test("atomically projects recovered process proof into failed status and repairs an old split projection", () => {
	const root = fixtureRoot();
	const runId = "recovered-terminal-projection";
	const asyncDir = path.join(root, runId);
	const resultsDir = path.join(root, "recovered-results");
	const sessionFile = path.join(root, "recoverable-child.jsonl");
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.mkdirSync(resultsDir);
	fs.writeFileSync(sessionFile, "");
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			lifecycleArtifactVersion: 3,
			runId,
			parentRunOrigin: "user",
			mode: "single",
			state: "running",
			pid: 2_147_483_647,
			processStartIdentity: "dead-runner",
			processTerminal: {
				version: 1,
				state: "pending",
				runId,
				runnerProcessInstanceId: "runner-instance-1",
			},
			startedAt: 1_000,
			lastUpdate: 1_500,
			sessionFile,
			steps: [{ agent: "writer", status: "running", startedAt: 1_000, sessionFile }],
		}),
	);
	initializeWriterProcessRegistry(asyncDir, runId, process.pid, 1);

	const repaired = reconcileAsyncRun(asyncDir, {
		resultsDir,
		now: () => 2_000,
		kill: () => {
			throw Object.assign(new Error("gone"), { code: "ESRCH" });
		},
	});
	expect(repaired).toMatchObject({
		repaired: true,
		status: {
			state: "failed",
			processTerminal: { state: "observed", resumeDisposition: "resumable" },
		},
	});
	if (!repaired.resultPath) throw new Error("Expected repaired result path");
	expect(JSON.parse(fs.readFileSync(repaired.resultPath, "utf8"))).toMatchObject({ parentRunOrigin: "user" });
	const proofPath = path.join(asyncDir, "process-terminal.json");
	expect(JSON.parse(fs.readFileSync(proofPath, "utf8"))).toMatchObject({
		state: "observed",
		resumeDisposition: "resumable",
	});

	const terminalStatus = JSON.parse(fs.readFileSync(path.join(asyncDir, "status.json"), "utf8"));
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			...terminalStatus,
			processTerminal: {
				version: 1,
				state: "unknown",
				runId,
				runnerProcessInstanceId: "runner-instance-1",
				reason: "runner-candidate-missing",
			},
		}),
	);
	fs.writeFileSync(
		proofPath,
		JSON.stringify({
			...JSON.parse(fs.readFileSync(proofPath, "utf8")),
			resumeDisposition: "unavailable",
		}),
	);

	const splitProjection = reconcileAsyncRun(asyncDir, { resultsDir });
	expect(splitProjection).toMatchObject({
		repaired: true,
		status: {
			state: "failed",
			processTerminal: { state: "observed", resumeDisposition: "resumable" },
		},
	});
	expect(JSON.parse(fs.readFileSync(proofPath, "utf8"))).toMatchObject({
		state: "observed",
		resumeDisposition: "resumable",
	});
});

test("repairs the run error from the child that drives mixed parallel failure", () => {
	const root = fixtureRoot();
	const resultsDir = path.join(root, "results");
	fs.mkdirSync(resultsDir, { recursive: true });
	for (const [runId, results] of [
		[
			"mixed-error-first",
			[
				{ success: false, stopped: true, error: "user stopped sibling" },
				{ success: false, error: "real execution failure" },
			],
		],
		[
			"mixed-error-last",
			[
				{ success: false, error: "real execution failure" },
				{ success: false, stopped: true, error: "user stopped sibling" },
			],
		],
	] as const) {
		const asyncDir = path.join(root, runId);
		fs.mkdirSync(asyncDir);
		fs.writeFileSync(
			path.join(asyncDir, "status.json"),
			JSON.stringify({
				runId,
				mode: "parallel",
				state: "running",
				startedAt: 1_000,
				steps: results.map((_, index) => ({ agent: `worker-${index}`, status: "running" })),
			}),
		);
		fs.writeFileSync(
			path.join(resultsDir, `${runId}.json`),
			JSON.stringify({ runId, state: "failed", success: false, results }),
		);
		const repaired = reconcileAsyncRun(asyncDir, { resultsDir, now: () => 2_000 });
		expect(repaired.status).toMatchObject({ state: "failed", error: "real execution failure" });
	}
});

test("never treats process-close proof alone as nested Agent success", () => {
	const root = fixtureRoot();
	const resultPath = path.join(root, "missing-result.json");
	const status = buildNestedTerminalFallbackStatus(
		nestedFallbackConfig(root, resultPath),
		{
			version: 1,
			state: "observed",
			runId: "nested-fallback",
			runnerProcessInstanceId: "runner-1",
			observedAt: 2_000,
			instances: [],
		},
		3_000,
	);

	expect(status.state).toBe("failed");
	expect(status.error).toContain("without a readable semantic result");
});
