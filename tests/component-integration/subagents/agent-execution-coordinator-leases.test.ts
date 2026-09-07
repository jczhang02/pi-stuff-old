import { expect, test } from "bun:test";
import {
	AgentExecutionCoordinator,
	createDurableAgentExecutionCoordinator,
	existsSync,
	harness,
	initializeWriterProcessRegistry,
	join,
	lease,
	mkdir,
	mkdtemp,
	parseAgentOwnerPath,
	RecordingGovernor,
	recordForegroundOwnerExit,
	rm,
	runtimeCompletionAddresses,
	SessionAgentGovernor,
	tmpdir,
	writeFile,
	writerProcessRegistryPath,
} from "../../agents/agent-execution-coordinator-fixtures.js";

test("does not inspect system boot identity during construction or session binding", () => {
	let reads = 0;
	const coordinator = new AgentExecutionCoordinator({
		createSession: () => ({
			governor: new RecordingGovernor(),
			reconcile: async () => {},
		}),
		readSystemBootIdentity: () => {
			reads += 1;
			return "boot";
		},
	});
	coordinator.bindSession({ sessionId: "startup-pure", ownerAgentPath: [] });
	expect(reads).toBe(0);
});

test("lazily reserves a whole parallel launch and rebinds every child from async-started", async () => {
	const { coordinator, governor, identities } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: ["root-run:0"] });
	expect(identities).toEqual([]);

	const prepared = await coordinator.prepare({
		launchRunId: "launch-parallel",
		params: { tasks: [{}, {}, {}] },
	});
	expect(prepared.ok).toBe(true);
	expect(governor.spawnReservations).toEqual([{ launchRunId: "launch-parallel", childCount: 3 }]);
	expect(identities).toEqual([{ sessionId: "parent-session", ownerAgentPath: ["root-run:0"] }]);

	let startupAcknowledgements = 0;
	await coordinator.observeAsyncStarted({
		id: "launch-parallel",
		pid: 8_888,
		processStartIdentity: "proc-8888",
		acknowledgeStart: () => {
			startupAcknowledgements += 1;
		},
	});
	expect(startupAcknowledgements).toBe(1);
	expect(governor.rebinds.map(({ reservationIndex, request }) => ({ reservationIndex, request }))).toEqual([
		{
			reservationIndex: 0,
			request: {
				runtimeRunId: "launch-parallel",
				childIndex: 0,
				pid: 8_888,
				processStartIdentity: "proc-8888",
			},
		},
		{
			reservationIndex: 1,
			request: {
				runtimeRunId: "launch-parallel",
				childIndex: 1,
				pid: 8_888,
				processStartIdentity: "proc-8888",
			},
		},
		{
			reservationIndex: 2,
			request: {
				runtimeRunId: "launch-parallel",
				childIndex: 2,
				pid: 8_888,
				processStartIdentity: "proc-8888",
			},
		},
	]);

	if (!prepared.ok || !prepared.invocation) throw new Error("Expected a governed invocation");
	await coordinator.settle(prepared.invocation, {
		details: { asyncId: "launch-parallel", runId: "launch-parallel", results: [] },
	});
	expect(governor.settlements.at(-1)?.settlement).toEqual({ kind: "background-started" });
	expect(startupAcknowledgements).toBe(1);
});

test("releases only terminal foreground children and releases all reservations on engine failure", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	const prepared = await coordinator.prepare({ launchRunId: "foreground-run", params: { tasks: [{}, {}, {}] } });
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected a governed invocation");

	await coordinator.settle(prepared.invocation, {
		isError: true,
		details: {
			runId: "foreground-run",
			results: [{ exitCode: 0 }, { detached: true, exitCode: -2 }, { exitCode: 1 }],
		},
	});
	expect(governor.settlements.at(-1)?.settlement).toEqual({
		kind: "foreground",
		terminalChildIndexes: [0, 2],
	});

	const failed = await coordinator.prepare({ launchRunId: "failed-run", params: { agent: "worker" } });
	if (!failed.ok || !failed.invocation) throw new Error("Expected a governed invocation");
	await coordinator.fail(failed.invocation);
	expect(governor.settlements.at(-1)?.settlement).toEqual({ kind: "start-error" });
});

test("retains foreground leases missing from a short engine result", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	const prepared = await coordinator.prepare({ launchRunId: "short-result", params: { tasks: [{}, {}, {}] } });
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected a governed invocation");

	await coordinator.settle(prepared.invocation, {
		details: { runId: "short-result", results: [{ exitCode: 0 }] },
	});

	expect(governor.settlements.at(-1)?.settlement).toEqual({
		kind: "foreground",
		terminalChildIndexes: [0],
	});
});

test("retains an observed foreground start when the engine throws after its start hook", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	const prepared = await coordinator.prepare({ launchRunId: "foreground-started", params: { agent: "worker" } });
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected a governed invocation");

	await coordinator.observeAsyncStarted({
		id: "foreground-started",
		pid: 7_001,
		processStartIdentity: "proc-7001",
	});
	await coordinator.fail(prepared.invocation);

	expect(governor.settlements.at(-1)?.settlement).toEqual({ kind: "background-started" });
	expect(governor.settlements.some(({ settlement }) => settlement.kind === "start-error")).toBe(false);
});

test("releases an observed background start only after abortStart proves it was reaped", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });

	const retained = await coordinator.prepare({ launchRunId: "abort-refused", params: { agent: "worker" } });
	if (!retained.ok || !retained.invocation) throw new Error("Expected a governed invocation");
	await coordinator.observeAsyncStarted({
		id: "abort-refused",
		pid: 7_002,
		processStartIdentity: "proc-7002",
		abortStart: () => false,
	});
	await coordinator.fail(retained.invocation);
	expect(governor.settlements.at(-1)?.settlement).toEqual({ kind: "background-started" });

	const aborted = await coordinator.prepare({ launchRunId: "abort-proven", params: { agent: "worker" } });
	if (!aborted.ok || !aborted.invocation) throw new Error("Expected a governed invocation");
	let abortCalls = 0;
	await coordinator.observeAsyncStarted({
		id: "abort-proven",
		pid: 7_003,
		processStartIdentity: "proc-7003",
		abortStart: () => {
			abortCalls += 1;
			return true;
		},
	});
	await coordinator.fail(aborted.invocation);
	expect(abortCalls).toBe(1);
	expect(governor.settlements.at(-1)?.settlement).toEqual({ kind: "start-error" });
});

test("does not convert a zero-result wrapper into start-error after foreground start", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	const prepared = await coordinator.prepare({ launchRunId: "foreground-zero", params: { agent: "worker" } });
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected a governed invocation");
	await coordinator.observeAsyncStarted({
		id: "foreground-zero",
		pid: 7_004,
		processStartIdentity: "proc-7004",
	});

	await coordinator.settle(prepared.invocation, {
		isError: true,
		details: { runId: "foreground-zero", results: [] },
	});

	expect(governor.settlements.at(-1)?.settlement).toEqual({ kind: "background-started" });
	expect(governor.settlements.some(({ settlement }) => settlement.kind === "start-error")).toBe(false);
});

test("keeps resume logical identity while rebinding its new runtime as child zero", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	const prepared = await coordinator.prepare({
		launchRunId: "resume-tool-call",
		params: { action: "resume", id: "original-run", index: 4 },
	});
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected a governed resume");
	expect(governor.resumeReservations).toEqual([
		{
			acknowledgeCost: false,
			launchRunId: "resume-tool-call",
			targetRunId: "original-run",
			childIndex: 4,
		},
	]);

	await coordinator.observeAsyncStarted({
		id: "actual-resume-run",
		pid: 9_999,
		processStartIdentity: "proc-9999",
	});
	await coordinator.settle(prepared.invocation, {
		details: { asyncId: "actual-resume-run", runId: "actual-resume-run", results: [] },
	});
	expect(governor.rebinds.at(-1)).toMatchObject({
		reservationIndex: 0,
		request: {
			runtimeRunId: "actual-resume-run",
			childIndex: 0,
			pid: 9_999,
			processStartIdentity: "proc-9999",
		},
	});
	expect(governor.settlements.at(-1)?.settlement).toEqual({ kind: "background-started" });
});

test("projects group, task-index, and single-child completion events to idempotent runtime releases", async () => {
	expect(
		runtimeCompletionAddresses({
			runId: "group-run",
			results: [{ taskIndex: 4 }, { index: 7 }, {}],
		}),
	).toEqual([
		{ runtimeRunId: "group-run", childIndex: 4 },
		{ runtimeRunId: "group-run", childIndex: 7 },
		{ runtimeRunId: "group-run", childIndex: 2 },
	]);
	expect(runtimeCompletionAddresses({ runId: "foreground-run", taskIndex: 5 })).toEqual([
		{ runtimeRunId: "foreground-run", childIndex: 5 },
	]);
	expect(runtimeCompletionAddresses({ id: "single-run" })).toEqual([{ runtimeRunId: "single-run", childIndex: 0 }]);

	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	governor.completionResults = [
		{ released: false, reason: "not_found" },
		{ released: true, logicalAgentId: "late-run:0" },
	];
	const prepared = await coordinator.prepare({ launchRunId: "late-runtime", params: { agent: "worker" } });
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected a governed invocation");
	await coordinator.observeAsyncStarted({ id: "late-runtime", pid: 6_666 });
	await coordinator.complete({ runId: "late-runtime" });
	await coordinator.settle(prepared.invocation, {
		details: { asyncId: "late-runtime", runId: "late-runtime", results: [] },
	});
	expect(governor.completions).toEqual([
		{ runtimeRunId: "late-runtime", childIndex: 0 },
		{ runtimeRunId: "late-runtime", childIndex: 0 },
	]);
});

test("retains a semantic completion until the addressed runtime is process-terminal", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	governor.runtimeLease = { ...lease("live-completion", 0, "live-completion"), pid: 12 };

	await coordinator.complete({ runId: "live-completion" });
	expect(governor.completions).toEqual([]);

	governor.runtimeLease = undefined;
	await coordinator.complete({ runId: "live-completion" });
	expect(governor.completions).toEqual([{ runtimeRunId: "live-completion", childIndex: 0 }]);
});

test("reconciles only through the injected explicit pid verdict and never releases on dispose", async () => {
	const { coordinator, governor, identities, reconciled } = harness();
	coordinator.bindSession({ sessionId: "restored-session", ownerAgentPath: parseAgentOwnerPath("a:0 › b:2") });
	expect(identities).toEqual([]);
	await coordinator.reconcileDead();
	expect(identities).toEqual([{ sessionId: "restored-session", ownerAgentPath: ["a:0", "b:2"] }]);
	// A live PID is not sufficient proof after PID reuse: without a matching
	// process-start identity the coordinator must retain the lease.
	expect(reconciled).toEqual([[false, undefined, undefined]]);

	coordinator.dispose();
	expect(governor.settlements).toEqual([]);
});

test("reconcileExisting is zero-write without a ledger and reclaims a confirmed-dead restored lease", async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-stuff-coordinator-restore-"));
	const rootDir = join(temporaryRoot, "governor-state");
	try {
		const empty = createDurableAgentExecutionCoordinator({ rootDir, isPidAlive: () => false });
		empty.bindSession({ sessionId: "empty-session", ownerAgentPath: [] });
		expect(await empty.inspectExistingRuntimeLeases()).toEqual([]);
		await empty.reconcileExisting();
		expect(existsSync(rootDir)).toBe(false);

		const seed = new SessionAgentGovernor({ rootDir, sessionId: "restored-session" });
		const acquired = await seed.acquireSpawn({ logicalAgentId: "restored-run:0", pid: 54_321 });
		if (!acquired.ok) throw new Error(acquired.error.message);
		expect((await seed.snapshot()).running).toBe(1);

		const restored = createDurableAgentExecutionCoordinator({ rootDir, isPidAlive: () => false });
		restored.bindSession({ sessionId: "restored-session", ownerAgentPath: [] });
		expect(await restored.inspectExistingRuntimeLeases()).toEqual([
			expect.objectContaining({ logicalAgentId: "restored-run:0", pid: 54_321 }),
		]);
		await restored.reconcileExisting();
		expect(await seed.snapshot()).toMatchObject({ total: 1, running: 0, leases: [] });
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});

test("retains a dead-runner lease when writer registry evidence is missing or corrupt", async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-stuff-coordinator-writer-proof-"));
	const rootDir = join(temporaryRoot, "governor-state");
	const asyncDir = join(temporaryRoot, "async-run");
	try {
		await mkdir(asyncDir, { recursive: true });
		const seed = new SessionAgentGovernor({ rootDir, sessionId: "writer-proof-session" });
		const acquired = await seed.acquireSpawn({ logicalAgentId: "writer-proof:0", pid: 54_321 });
		if (!acquired.ok) throw new Error(acquired.error.message);
		await seed.rebindRuntime(acquired.lease, { asyncDir });

		const restored = createDurableAgentExecutionCoordinator({ rootDir, isPidAlive: () => false });
		restored.bindSession({ sessionId: "writer-proof-session", ownerAgentPath: [] });
		await restored.reconcileExisting();
		expect(await seed.snapshot()).toMatchObject({ running: 1 });

		await writeFile(writerProcessRegistryPath(asyncDir), "{not-json", "utf-8");
		await restored.reconcileExisting();
		expect(await seed.snapshot()).toMatchObject({ running: 1 });
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});

test("reclaims an identity-unavailable gated runner after its actual pid is proven dead", async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-stuff-coordinator-gated-runner-exit-"));
	const rootDir = join(temporaryRoot, "governor-state");
	const asyncDir = join(temporaryRoot, "gated-runner-exit");
	const runId = "gated-runner-exit";
	const runnerPid = 54_322;
	try {
		await mkdir(asyncDir, { recursive: true, mode: 0o700 });
		initializeWriterProcessRegistry(asyncDir, runId, runnerPid, 1);
		const seed = new SessionAgentGovernor({ rootDir, sessionId: "gated-runner-exit-session" });
		const acquired = await seed.acquireSpawn({ logicalAgentId: `${runId}:0`, pid: runnerPid });
		if (!acquired.ok) throw new Error(acquired.error.message);
		await seed.rebindRuntime(acquired.lease, { runtimeRunId: runId, pid: runnerPid, asyncDir });

		const restored = createDurableAgentExecutionCoordinator({ rootDir, isPidAlive: () => false });
		restored.bindSession({ sessionId: "gated-runner-exit-session", ownerAgentPath: [] });
		await restored.reconcileExisting();

		expect(await seed.snapshot()).toMatchObject({ total: 1, running: 0, leases: [] });
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});

test("durably binds an identity-unavailable foreground directory before Host failure", async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-stuff-coordinator-foreground-no-identity-"));
	const rootDir = join(temporaryRoot, "governor-state");
	const asyncDir = join(temporaryRoot, "foreground-no-identity");
	const runId = "foreground-no-identity";
	const hostPid = 54_323;
	try {
		await mkdir(asyncDir, { recursive: true, mode: 0o700 });
		initializeWriterProcessRegistry(asyncDir, runId, hostPid, 1);
		const active = createDurableAgentExecutionCoordinator({
			rootDir,
			isPidAlive: () => true,
			readProcessStartIdentity: () => undefined,
		});
		active.bindSession({ sessionId: "foreground-no-identity-session", ownerAgentPath: [] });
		const prepared = await active.prepare({ launchRunId: runId, params: { agent: "worker" } });
		if (!prepared.ok || !prepared.invocation) throw new Error("Expected a governed invocation");

		await active.observeAsyncStarted({ id: runId, pid: hostPid, asyncDir });

		const ledger = new SessionAgentGovernor({
			rootDir,
			sessionId: "foreground-no-identity-session",
			readProcessStartIdentity: () => undefined,
		});
		expect((await ledger.snapshot()).leases).toEqual([
			expect.objectContaining({
				runtimeRunId: runId,
				pid: hostPid,
				asyncDir,
			}),
		]);
		expect((await ledger.snapshot()).leases[0]?.processStartIdentity).toBeUndefined();
		active.dispose();

		const restored = createDurableAgentExecutionCoordinator({
			rootDir,
			isPidAlive: () => false,
			readProcessStartIdentity: () => undefined,
		});
		restored.bindSession({ sessionId: "foreground-no-identity-session", ownerAgentPath: [] });
		await restored.reconcileExisting();

		expect(await ledger.snapshot()).toMatchObject({ total: 1, running: 0, leases: [] });
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});

test("reconciles a terminal runner immediately after its late runtime binding", async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-stuff-coordinator-terminal-before-bind-"));
	const rootDir = join(temporaryRoot, "governor-state");
	const asyncDir = join(temporaryRoot, "terminal-before-bind");
	const runId = "terminal-before-bind";
	const runnerPid = 54_324;
	try {
		await mkdir(asyncDir, { recursive: true, mode: 0o700 });
		initializeWriterProcessRegistry(asyncDir, runId, runnerPid, 1);
		const coordinator = createDurableAgentExecutionCoordinator({
			rootDir,
			isPidAlive: (pid) => (pid === runnerPid ? false : undefined),
			readProcessStartIdentity: () => undefined,
		});
		coordinator.bindSession({ sessionId: "terminal-before-bind-session", ownerAgentPath: [] });
		const prepared = await coordinator.prepare({ launchRunId: runId, params: { agent: "worker" } });
		if (!prepared.ok || !prepared.invocation) throw new Error("Expected a governed invocation");
		const ledger = new SessionAgentGovernor({ rootDir, sessionId: "terminal-before-bind-session" });

		// This models the process-terminal event winning the race against runtime
		// binding: reconciliation can only see the still-live provisional Host.
		await coordinator.reconcileDead();
		expect(await ledger.snapshot()).toMatchObject({ running: 1 });

		await coordinator.settle(prepared.invocation, {
			isError: true,
			details: {
				asyncId: runId,
				runId,
				results: [],
				lifecycleBinding: { pid: runnerPid, asyncDir },
			},
		});

		expect(await ledger.snapshot()).toMatchObject({ total: 1, running: 0, leases: [] });
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});

test("reclaims a foreground lease from owner-exit and writer proof even while the Pi host stays alive", async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-stuff-coordinator-foreground-owner-exit-"));
	const rootDir = join(temporaryRoot, "governor-state");
	const asyncDir = join(temporaryRoot, "foreground-owner-exit");
	const runId = "foreground-owner-exit";
	try {
		await mkdir(asyncDir, { recursive: true, mode: 0o700 });
		const seed = new SessionAgentGovernor({ rootDir, sessionId: "foreground-owner-exit-session" });
		const acquired = await seed.acquireSpawn({ logicalAgentId: `${runId}:0`, pid: process.pid });
		if (!acquired.ok) throw new Error(acquired.error.message);
		await seed.rebindRuntime(acquired.lease, { runtimeRunId: runId, asyncDir });
		recordForegroundOwnerExit(asyncDir, runId, "injected foreground frame failure");
		await writeFile(join(asyncDir, "status.json"), "{not-json", { mode: 0o600 });
		await writeFile(
			writerProcessRegistryPath(asyncDir),
			`${JSON.stringify({
				version: 1,
				runId,
				runnerPid: process.pid,
				updatedAt: Date.now(),
				writers: { "0": { state: "spawning" } },
			})}\n`,
			{ mode: 0o600 },
		);

		const restored = createDurableAgentExecutionCoordinator({
			rootDir,
			isPidAlive: () => true,
			readProcessStartIdentity: () => acquired.lease.processStartIdentity,
		});
		restored.bindSession({ sessionId: "foreground-owner-exit-session", ownerAgentPath: [] });
		await restored.reconcileExisting();
		expect(await seed.snapshot()).toMatchObject({ running: 1 });

		await writeFile(
			writerProcessRegistryPath(asyncDir),
			`${JSON.stringify({
				version: 1,
				runId,
				runnerPid: process.pid,
				updatedAt: Date.now() + 1,
				writers: { "0": { state: "none" } },
			})}\n`,
			{ mode: 0o600 },
		);
		await restored.reconcileExisting();
		expect(await seed.snapshot()).toMatchObject({ total: 1, running: 0, leases: [] });
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});

test("reclaims a pre-reboot lease after transient writer evidence has been cleared", async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-stuff-coordinator-reboot-"));
	const rootDir = join(temporaryRoot, "governor-state");
	const clearedAsyncDir = join(temporaryRoot, "cleared-runtime");
	try {
		const seed = new SessionAgentGovernor({
			rootDir,
			sessionId: "reboot-session",
			readSystemBootIdentity: () => "boot-before",
		});
		const acquired = await seed.acquireSpawn({ logicalAgentId: "rebooted:0", pid: 54_321 });
		if (!acquired.ok) throw new Error(acquired.error.message);
		await seed.rebindRuntime(acquired.lease, { asyncDir: clearedAsyncDir });

		const restored = createDurableAgentExecutionCoordinator({
			rootDir,
			isPidAlive: () => true,
			readProcessStartIdentity: () => acquired.lease.processStartIdentity,
			readSystemBootIdentity: () => "boot-after",
		});
		restored.bindSession({ sessionId: "reboot-session", ownerAgentPath: [] });
		await restored.reconcileExisting();

		expect(await seed.snapshot()).toMatchObject({ total: 1, running: 0, leases: [] });
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});
