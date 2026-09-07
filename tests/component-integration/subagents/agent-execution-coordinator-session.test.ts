import { expect, test } from "bun:test";
import {
	createDurableAgentExecutionCoordinator,
	harness,
	join,
	mkdtemp,
	parseAgentOwnerPath,
	rm,
	SessionAgentGovernor,
	tmpdir,
} from "../../agents/agent-execution-coordinator-fixtures.js";

test("root and fanout coordinators share one parent-session ledger with the propagated owner path", async () => {
	const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-stuff-coordinator-fanout-"));
	const rootDir = join(temporaryRoot, "governor-state");
	try {
		const root = createDurableAgentExecutionCoordinator({ rootDir });
		root.bindSession({ sessionId: "shared-parent", ownerAgentPath: [] });
		const parent = await root.prepare({ launchRunId: "parent-run", params: { agent: "worker" } });
		if (!parent.ok || !parent.invocation) throw new Error("Expected the parent reservation");

		const fanout = createDurableAgentExecutionCoordinator({ rootDir });
		fanout.bindSession({
			sessionId: "shared-parent",
			ownerAgentPath: parseAgentOwnerPath("parent-run:0"),
		});
		const nested = await fanout.prepare({ launchRunId: "nested-run", params: { agent: "reviewer" } });
		if (!nested.ok || !nested.invocation) throw new Error("Expected the nested reservation");

		const ledger = new SessionAgentGovernor({ rootDir, sessionId: "shared-parent" });
		expect(await ledger.snapshot()).toMatchObject({
			total: 2,
			running: 2,
			agents: [
				{ logicalAgentId: "parent-run:0", agentPath: ["parent-run:0"] },
				{
					logicalAgentId: "nested-run:0",
					ownerAgentPath: ["parent-run:0"],
					agentPath: ["parent-run:0", "nested-run:0"],
				},
			],
		});
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
	}
});

test("parses the propagated Agent owner path without inventing root components", () => {
	expect(parseAgentOwnerPath(undefined)).toEqual([]);
	expect(parseAgentOwnerPath("  ")).toEqual([]);
	expect(parseAgentOwnerPath("root:0 › nested:3 › leaf:1")).toEqual(["root:0", "nested:3", "leaf:1"]);
});

test("retains an ambiguous early completion until the matching concurrent resume settles", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	const first = await coordinator.prepare({
		launchRunId: "resume-call-a",
		params: { action: "resume", id: "logical-a", index: 0 },
	});
	const second = await coordinator.prepare({
		launchRunId: "resume-call-b",
		params: { action: "resume", id: "logical-b", index: 0 },
	});
	if (!first.ok || !first.invocation || !second.ok || !second.invocation) {
		throw new Error("Expected both resume reservations");
	}
	governor.completionResults = [
		{ released: false, reason: "not_found" },
		{ released: false, reason: "not_found" },
		{ released: true, logicalAgentId: "logical-b" },
	];
	await coordinator.observeAsyncStarted({
		id: "runtime-b",
		pid: 7_001,
		processStartIdentity: "proc-7001",
	});
	await coordinator.complete({ runId: "runtime-b" });
	await coordinator.settle(first.invocation, {
		details: { asyncId: "runtime-a", runId: "runtime-a", results: [] },
	});
	await Bun.sleep(40);
	await coordinator.settle(second.invocation, {
		details: { asyncId: "runtime-b", runId: "runtime-b", results: [] },
	});

	expect(governor.rebinds.at(-1)?.request).toMatchObject({ runtimeRunId: "runtime-b", pid: 7_001 });
	expect(governor.completions).toEqual([
		{ runtimeRunId: "runtime-b", childIndex: 0 },
		{ runtimeRunId: "runtime-b", childIndex: 0 },
		{ runtimeRunId: "runtime-b", childIndex: 0 },
	]);
});

test("drains an old-session completion after session switch and late settlement", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "session-a", ownerAgentPath: [] });
	const prepared = await coordinator.prepare({ launchRunId: "old-run", params: { agent: "worker" } });
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected old-session reservation");
	governor.completionResults = [
		{ released: false, reason: "not_found" },
		{ released: true, logicalAgentId: "old-run:0" },
	];
	await coordinator.complete({ runId: "old-run" });
	coordinator.bindSession({ sessionId: "session-b", ownerAgentPath: [] });
	await coordinator.settle(prepared.invocation, {
		details: { asyncId: "old-run", runId: "old-run", results: [] },
	});
	expect(governor.completions).toEqual([
		{ runtimeRunId: "old-run", childIndex: 0 },
		{ runtimeRunId: "old-run", childIndex: 0 },
	]);
});

test("keeps durable settlement and completion retries alive across dispose", async () => {
	const settlement = harness();
	settlement.coordinator.bindSession({ sessionId: "settlement-session", ownerAgentPath: [] });
	const prepared = await settlement.coordinator.prepare({
		launchRunId: "retry-settlement",
		params: { agent: "worker" },
	});
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected governed reservation");
	settlement.governor.settlementFailures = 1;
	await expect(settlement.coordinator.fail(prepared.invocation)).rejects.toThrow("injected settlement EIO");
	settlement.coordinator.dispose();

	const completion = harness();
	completion.coordinator.bindSession({ sessionId: "completion-session", ownerAgentPath: [] });
	completion.governor.completionFailures = 1;
	await expect(completion.coordinator.complete({ runId: "retry-completion" })).rejects.toThrow(
		"injected completion EIO",
	);
	completion.coordinator.dispose();

	await Bun.sleep(60);
	expect(settlement.governor.settlements).toHaveLength(2);
	expect(completion.governor.completions).toEqual([
		{ runtimeRunId: "retry-completion", childIndex: 0 },
		{ runtimeRunId: "retry-completion", childIndex: 0 },
	]);
});

test("keeps the startup gate closed across partial rebind failure and acknowledges after retry", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	const prepared = await coordinator.prepare({ launchRunId: "gated-run", params: { tasks: [{}, {}] } });
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected gated reservation");
	governor.rebindFailures = 1;
	let acknowledgements = 0;
	await expect(
		coordinator.observeAsyncStarted({
			id: "gated-run",
			pid: 7_101,
			processStartIdentity: "start-7101",
			acknowledgeStart: () => {
				acknowledgements += 1;
			},
		}),
	).rejects.toThrow("injected rebind EIO");
	expect(acknowledgements).toBe(0);
	await coordinator.settle(prepared.invocation, {
		details: { asyncId: "gated-run", runId: "gated-run", results: [] },
	});
	expect(acknowledgements).toBe(1);
	expect(governor.rebinds.length).toBeGreaterThanOrEqual(3);
});

test("binds and opens the startup gate from engine details when the start event is lost", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	const prepared = await coordinator.prepare({ launchRunId: "event-lost", params: { agent: "worker" } });
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected governed reservation");
	let acknowledgements = 0;
	await coordinator.settle(prepared.invocation, {
		details: {
			asyncId: "event-lost",
			results: [],
			lifecycleBinding: {
				pid: 7_201,
				processStartIdentity: "start-7201",
				asyncDir: "/tmp/event-lost",
				acknowledgeStart: () => {
					acknowledgements += 1;
				},
				abortStart: () => true,
			},
		},
	});
	expect(governor.rebinds.at(-1)?.request).toMatchObject({
		runtimeRunId: "event-lost",
		pid: 7_201,
		asyncDir: "/tmp/event-lost",
	});
	expect(acknowledgements).toBe(1);
});

test("binds an identity-unavailable failed runner to its actual pid and runtime directory", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	const prepared = await coordinator.prepare({ launchRunId: "identity-unavailable", params: { agent: "worker" } });
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected governed reservation");

	await coordinator.settle(prepared.invocation, {
		details: {
			asyncId: "identity-unavailable",
			results: [],
			lifecycleBinding: {
				pid: 7_202,
				asyncDir: "/tmp/identity-unavailable",
			},
		},
	});

	expect(governor.rebinds.at(-1)?.request).toEqual({
		runtimeRunId: "identity-unavailable",
		childIndex: 0,
		pid: 7_202,
		asyncDir: "/tmp/identity-unavailable",
	});
	expect(governor.settlements.at(-1)?.settlement).toEqual({ kind: "background-started" });
});

test("never opens the startup gate when durable lease ownership rejects a rebind", async () => {
	const { coordinator, governor } = harness();
	coordinator.bindSession({ sessionId: "parent-session", ownerAgentPath: [] });
	const prepared = await coordinator.prepare({ launchRunId: "rejected-gate", params: { agent: "worker" } });
	if (!prepared.ok || !prepared.invocation) throw new Error("Expected governed reservation");
	governor.rebindRejected = true;
	let acknowledgements = 0;
	let aborts = 0;
	await expect(
		coordinator.settle(prepared.invocation, {
			details: {
				asyncId: "rejected-gate",
				results: [],
				lifecycleBinding: {
					pid: 7_301,
					processStartIdentity: "start-7301",
					asyncDir: "/tmp/rejected-gate",
					acknowledgeStart: () => {
						acknowledgements += 1;
					},
					abortStart: () => {
						aborts += 1;
						return true;
					},
				},
			},
		}),
	).rejects.toThrow("ownership_changed");
	expect(acknowledgements).toBe(0);
	expect(aborts).toBe(1);
	expect(governor.settlements.at(-1)?.settlement).toEqual({ kind: "start-error" });
});
