import { afterEach, expect, test } from "bun:test";
import {
	cleanupExtensionRootFixtures,
	context,
	createHarness,
	currentSessionId,
	fs,
	listenForAgentWorkOriginQueries,
	os,
	path,
	SUBAGENT_ASYNC_STARTED_EVENT,
	temporaryDirectories,
} from "../../agents/extension-root-fixtures.js";

afterEach(cleanupExtensionRootFixtures);

test("normalizes legacy control selectors before governor reservation", async () => {
	const root = createHarness();
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	const state = root.state.value;
	if (!state?.foregroundRuns || !state.currentSessionId) throw new Error("Expected an active Agent session");
	state.foregroundRuns.set("parallel", {
		children: [
			{ agent: "scout", index: 0, sessionFile: "/tmp/scout.jsonl", status: "completed", task: "Scout" },
			{ agent: "reviewer", index: 1, sessionFile: "/tmp/reviewer.jsonl", status: "completed", task: "Review" },
		],
		cwd: "/project",
		mode: "parallel",
		runId: "parallel",
		sessionId: state.currentSessionId,
		updatedAt: 1,
	});
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");

	await tool.execute(
		"legacy-resume",
		{ action: "resume", id: "parallel:1", message: "Continue review" },
		new AbortController().signal,
		undefined,
		context(),
	);

	expect(root.governor.prepares.at(-1)?.params).toMatchObject({
		action: "resume",
		id: "parallel",
		index: 1,
		message: "Continue review",
	});
	expect(root.engineParams.at(-1)).toMatchObject({ action: "resume", id: "parallel", index: 1 });

	await tool.execute(
		"legacy-steer",
		{ action: "steer", id: "parallel:1", message: "Apply review feedback" },
		new AbortController().signal,
		undefined,
		context(),
	);

	expect(root.governor.prepares.at(-1)?.params).toMatchObject({
		action: "steer",
		id: "parallel",
		index: 1,
		message: "Apply review feedback",
	});
	expect(root.engineParams.at(-1)).toMatchObject({ action: "steer", id: "parallel", index: 1 });
});

test("captures user attribution before launching a background Agent", async () => {
	const root = createHarness();
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	const stop = listenForAgentWorkOriginQueries(root.api.api, () => "user");
	try {
		await root.api.tools
			.get("subagent")
			?.execute(
				"user-launch",
				{ agent: "researcher", task: "Inspect user work" },
				new AbortController().signal,
				undefined,
				context(),
			);
	} finally {
		stop();
	}
	expect(root.engineOrigins).toEqual(["user"]);
});

test("accepts cost acknowledgement only from a direct user resume", async () => {
	const root = createHarness();
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	const state = root.state.value;
	if (!state?.foregroundRuns || !state.currentSessionId) throw new Error("Expected an active Agent session");
	state.foregroundRuns.set("cost-limited", {
		children: [
			{
				agent: "reviewer",
				index: 0,
				sessionFile: "/tmp/reviewer.jsonl",
				status: "failed",
				task: "Continue the retained review",
			},
		],
		cwd: "/project",
		mode: "single",
		runId: "cost-limited",
		sessionId: state.currentSessionId,
		updatedAt: 1,
	});
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");

	const automatic = await tool.execute(
		"automatic-resume",
		{ action: "resume", acknowledgeCost: true, id: "cost-limited" },
		new AbortController().signal,
		undefined,
		context(),
	);
	expect(automatic.content[0]).toMatchObject({
		type: "text",
		text: expect.stringContaining("requires a direct user-started Agent request"),
	});
	expect(root.governor.prepares).toHaveLength(0);

	const stop = listenForAgentWorkOriginQueries(root.api.api, () => "user");
	try {
		await tool.execute(
			"user-resume",
			{ action: "resume", acknowledgeCost: true, id: "cost-limited" },
			new AbortController().signal,
			undefined,
			context(),
		);
	} finally {
		stop();
	}
	expect(root.governor.prepares).toHaveLength(1);
	expect(root.governor.prepares[0]).toMatchObject({
		acknowledgeCost: true,
		params: { action: "resume", id: "cost-limited" },
	});
});

test("releases the governor invocation when post-prepare runtime startup fails", async () => {
	const root = createHarness({ runtimeStartFailure: true });
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");

	await expect(
		tool.execute(
			"runtime-start-failure",
			{ agent: "researcher", task: "Inspect lifecycle ownership" },
			new AbortController().signal,
			undefined,
			context(),
		),
	).rejects.toThrow("injected runtime directory EIO");
	expect(root.governor.failures).toBe(1);
	expect(root.governor.settlements).toBe(0);
	expect(root.engineParams).toEqual([]);
});

test("retains a launched background Agent lease when post-launch settlement persistence fails", async () => {
	const root = createHarness({ settleFailure: true });
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	const result = await root.api.tools
		.get("subagent")
		?.execute(
			"settle-failure",
			{ agent: "researcher", task: "Continue in background" },
			new AbortController().signal,
			undefined,
			context(),
		);
	expect(result?.content[0]?.text).toContain("started in the background");
	expect(root.governor.settlements).toBe(1);
	expect(root.governor.failures).toBe(0);
	expect(root.engineParams).toHaveLength(1);
});

test("does not resurrect result recovery or the supervisor after shutdown during reconciliation", async () => {
	const gate = Promise.withResolvers<void>();
	const root = createHarness({ reconcileGate: gate.promise });
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	const starting = root.api.commands.get("agents")?.handler("", context());
	while (root.governor.reconcileChecks === 0) await Bun.sleep(1);
	await root.api.fire("session_shutdown", { reason: "quit", type: "session_shutdown" });
	gate.resolve();
	await starting;

	expect(root.watcher.starts).toBe(0);
	expect(root.watcher.primes).toBe(0);
	expect(root.supervisor.started).toBe(0);
});

test("releases a prepared launch instead of dispatching it after shutdown", async () => {
	const gate = Promise.withResolvers<void>();
	const root = createHarness({ prepareGate: gate.promise });
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");
	const executing = tool.execute(
		"shutdown-during-prepare",
		{ agent: "researcher", task: "Must never launch" },
		new AbortController().signal,
		undefined,
		context(),
	);
	while (root.governor.prepares.length === 0) await Bun.sleep(1);
	await root.api.fire("session_shutdown", { reason: "quit", type: "session_shutdown" });
	gate.resolve();
	const result = await executing;

	expect(root.governor.failures).toBe(1);
	expect(root.engineParams).toEqual([]);
	expect(result.content[0]?.text).toContain("parent session ended or changed");
});

test("retains ledger authority when a background runner cannot be aborted across a session switch", async () => {
	const gate = Promise.withResolvers<void>();
	const root = createHarness({ backgroundGate: gate.promise, backgroundLifecycleAbort: false });
	const headerA = context([], { sessionFile: "/sessions/background-a.jsonl", sessionId: "background-a" });
	const headerB = context([], { sessionFile: "/sessions/background-b.jsonl", sessionId: "background-b" });
	await root.api.fire("session_start", { reason: "startup", type: "session_start" }, headerA);
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");
	const executing = tool.execute(
		"background-session-switch",
		{ agent: "researcher", task: "Runner survives the switch" },
		new AbortController().signal,
		undefined,
		headerA,
	);
	while (root.engineParams.length === 0) await Bun.sleep(1);
	await root.api.fire("session_start", { reason: "switch", type: "session_start" }, headerB);
	gate.resolve();
	const result = await executing;

	expect(root.governor.settlements).toBe(1);
	expect(root.governor.failures).toBe(0);
	expect(result.content[0]?.text).toContain("session ended or changed");
});

test("retains ledger authority when aborting a session-switched runner throws", async () => {
	const gate = Promise.withResolvers<void>();
	const root = createHarness({ backgroundGate: gate.promise, backgroundLifecycleAbort: "throw" });
	const headerA = context([], {
		sessionFile: "/sessions/background-throw-a.jsonl",
		sessionId: "background-throw-a",
	});
	const headerB = context([], {
		sessionFile: "/sessions/background-throw-b.jsonl",
		sessionId: "background-throw-b",
	});
	await root.api.fire("session_start", { reason: "startup", type: "session_start" }, headerA);
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");
	const executing = tool.execute(
		"background-session-switch-abort-throws",
		{ agent: "researcher", task: "Runner remains governed after failed abort transport" },
		new AbortController().signal,
		undefined,
		headerA,
	);
	while (root.engineParams.length === 0) await Bun.sleep(1);
	await root.api.fire("session_start", { reason: "switch", type: "session_start" }, headerB);
	gate.resolve();
	const result = await executing;

	expect(root.governor.settlements).toBe(1);
	expect(root.governor.failures).toBe(0);
	expect(result.content[0]?.text).toContain("session ended or changed");
});

test("settles a completed foreground result against its original session after shutdown", async () => {
	const gate = Promise.withResolvers<void>();
	const asyncDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-root-foreground-race-"));
	temporaryDirectories.add(asyncDir);
	const root = createHarness({
		foregroundAsyncDir: asyncDir,
		foregroundGate: gate.promise,
		foregroundDetails: {
			mode: "parallel",
			runId: "foreground-mixed",
			results: [
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				{ agent: "reviewer", success: true, exitCode: 0 } as never,
				// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
				{ agent: "writer", success: true, exitCode: 0, detached: true } as never,
			],
		},
	});
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");
	const executing = tool.execute(
		"foreground-shutdown-race",
		{ agent: "reviewer", task: "Finish before returning", foreground: true },
		new AbortController().signal,
		undefined,
		context(),
	);
	while (root.governor.starts.length === 0) await Bun.sleep(1);
	await root.api.fire("session_shutdown", { reason: "quit", type: "session_shutdown" });
	gate.resolve();
	const result = await executing;

	expect(root.governor.settlements).toBe(1);
	expect(root.governor.failures).toBe(0);
	expect(result.content[0]?.text).toContain("parent session ended or changed");
});

test("delegates private Context projection fitting to the Agent executor", async () => {
	const root = createHarness({
		contextProjection: '<pi-stuff-context trust="reference-only">memory</pi-stuff-context>',
	});
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");

	await tool.execute(
		"fresh-call",
		{ agent: "researcher", task: "Fresh task" },
		new AbortController().signal,
		undefined,
		context(),
	);
	await tool.execute(
		"fork-call",
		{ agent: "researcher", context: "fork", task: "Fork task" },
		new AbortController().signal,
		undefined,
		context(),
	);

	expect(root.projectionOwnership.delegated).toBe(true);
	expect(root.projections).toEqual([]);
	expect(root.engineParams.map((params) => params.contextProjection)).toEqual([undefined, undefined]);
});

test("defers existing-ledger reconciliation until an explicit Agent interaction", async () => {
	const root = createHarness({ governorLedgerExists: true });
	let entryReads = 0;
	const ctx = context();
	const getEntries = ctx.sessionManager.getEntries.bind(ctx.sessionManager);
	ctx.sessionManager.getEntries = () => {
		entryReads += 1;
		return getEntries();
	};
	await root.api.fire("session_start", { reason: "startup", type: "session_start" }, ctx);
	const readsAfterStart = entryReads;

	expect(root.governor.reconcileChecks).toBe(0);
	expect(root.governor.reconciles).toBe(0);
	expect(root.directories).toEqual([]);
	expect(root.watcher.starts).toBe(0);
	expect(root.watcher.primes).toBe(0);

	await root.api.commands.get("agents")?.handler("", ctx);

	expect(root.governor.reconcileChecks).toBe(1);
	expect(root.governor.reconciles).toBe(1);
	expect(root.tracker.restored).toBe(1);
	expect(root.watcher.starts).toBe(1);
	expect(root.watcher.primes).toBe(1);
	expect(entryReads).toBe(readsAfterStart);
});

test("restores an existing active run before starting its watcher", async () => {
	const root = createHarness({ restoreActive: true });
	await root.api.fire("session_start", { reason: "resume", type: "session_start" });

	expect(root.directories).toEqual([]);
	expect(root.watcher.starts).toBe(0);
	expect(root.watcher.primes).toBe(0);
	expect(root.tracker.pollers).toBe(0);
	expect(root.governor.reconciles).toBe(0);
	expect(root.state.value?.asyncJobs.has("restored")).toBe(true);

	await root.api.commands.get("agents")?.handler("", context());

	expect(root.watcher.starts).toBe(1);
	expect(root.watcher.primes).toBe(1);
	expect(root.tracker.pollers).toBe(1);
	expect(root.governor.reconciles).toBe(1);
});

test("propagates targeted active-run recovery failure instead of loading a partial roster", async () => {
	const root = createHarness({ restoreFailure: true });
	await expect(root.api.fire("session_start", { reason: "resume", type: "session_start" })).rejects.toThrow(
		"injected restore EIO",
	);
	expect(root.tracker.restored).toBe(1);
	expect(root.watcher.starts).toBe(0);
	expect(root.watcher.primes).toBe(0);
	expect(root.supervisor.started).toBe(0);
});

test("finishes bounded active-run recovery before exposing the roster", async () => {
	const restoreGate = Promise.withResolvers<void>();
	const root = createHarness({ restoreGate: restoreGate.promise });

	const startup = root.api
		.fire("session_start", { reason: "resume", type: "session_start" })
		.then(() => "ready" as const);
	expect(await Promise.race([startup, Bun.sleep(50).then(() => "blocked" as const)])).toBe("blocked");
	expect(root.tracker.restored).toBe(1);

	restoreGate.resolve();
	expect(await startup).toBe("ready");
});

test("does not let stale session recovery refresh the replacement session", async () => {
	const restoreGate = Promise.withResolvers<void>();
	const root = createHarness({ restoreActive: true, restoreGate: restoreGate.promise });
	const headerA = context([], { sessionFile: "/sessions/recovery-a.jsonl", sessionId: "recovery-a" });
	const headerB = context([], { sessionFile: "/sessions/recovery-b.jsonl", sessionId: "recovery-b" });
	const startingA = root.api.fire("session_start", { reason: "startup", type: "session_start" }, headerA);
	while (root.tracker.restored < 1) await Bun.sleep(1);
	const startingB = root.api.fire("session_start", { reason: "switch", type: "session_start" }, headerB);
	while (root.tracker.restored < 2) await Bun.sleep(1);
	const replacementSessionId = currentSessionId(root);
	const refreshesBeforeRecovery = root.current.refreshes;

	restoreGate.resolve();
	await Promise.all([startingA, startingB]);

	expect(currentSessionId(root)).toBe(replacementSessionId);
	expect(root.tracker.restoredSessions).toEqual([replacementSessionId]);
	expect([...(root.state.value?.asyncJobs.values() ?? [])].map((job) => job.sessionId)).toEqual([
		replacementSessionId,
	]);
	expect(root.current.refreshes - refreshesBeforeRecovery).toBe(1);
});

test("isolates reused session paths by header identity while preserving ordinary reload continuity", async () => {
	const root = createHarness();
	const headerA = context([], { sessionFile: "/sessions/reused.jsonl", sessionId: "header-a" });
	const headerB = context([], { sessionFile: "/sessions/reused.jsonl", sessionId: "header-b" });
	await root.api.fire("session_start", { reason: "startup", type: "session_start" }, headerA);
	const identityA = currentSessionId(root);
	await root.api.fire("session_start", { reason: "resume", type: "session_start" }, headerA);
	expect(currentSessionId(root)).toBe(identityA);
	await root.api.commands.get("agents")?.handler("", headerA);
	expect(root.governor.binds.at(-1)?.sessionId).toBe(identityA);

	await root.api.fire("session_start", { reason: "switch", type: "session_start" }, headerB);
	const identityB = currentSessionId(root);
	expect(identityB).not.toBe(identityA);
	await root.api.commands.get("agents")?.handler("", headerB);
	expect(root.governor.binds.at(-1)?.sessionId).toBe(identityB);

	const before = root.tracker.started;
	root.api.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "old-header-run", sessionId: identityA });
	expect(root.tracker.started).toBe(before);
	root.api.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "new-header-run", sessionId: identityB });
	expect(root.tracker.started).toBe(before + 1);
});

test("does not let an old session compatibility check authorize a new-session launch", async () => {
	const firstCheck = Promise.withResolvers<{
		ok: true;
		importedLogicalAgentIds: string[];
		legacyLedgerObserved: false;
	}>();
	let checks = 0;
	const root = createHarness({
		compatibility: async () => {
			checks += 1;
			if (checks === 1) return firstCheck.promise;
			return { ok: true, importedLogicalAgentIds: [], legacyLedgerObserved: false };
		},
	});
	const headerA = context([], { sessionFile: "/sessions/compat-a.jsonl", sessionId: "compat-a" });
	const headerB = context([], { sessionFile: "/sessions/compat-b.jsonl", sessionId: "compat-b" });
	await root.api.fire("session_start", { reason: "startup", type: "session_start" }, headerA);
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");
	const staleLaunch = tool.execute(
		"stale-compatibility",
		{ agent: "researcher", task: "Must remain in session A" },
		new AbortController().signal,
		undefined,
		headerA,
	);
	while (checks < 1) await Bun.sleep(1);

	await root.api.fire("session_start", { reason: "switch", type: "session_start" }, headerB);
	const currentLaunch = await tool.execute(
		"current-compatibility",
		{ agent: "researcher", task: "Launch in session B" },
		new AbortController().signal,
		undefined,
		headerB,
	);

	expect(checks).toBe(2);
	expect(currentLaunch.content[0]?.text).toContain("started in the background");
	expect(root.engineParams).toHaveLength(1);
	firstCheck.resolve({ ok: true, importedLogicalAgentIds: [], legacyLedgerObserved: false });
	const staleResult = await staleLaunch;
	expect(staleResult.content[0]?.text).toContain("session ended or changed");
	expect(root.engineParams).toHaveLength(1);
});
