import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentExecutionGovernor,
	agentExecutionLogicalId,
	formatAgentExecutionGovernorError,
} from "../../../packages/pi-stuff/src/subagents/src/runtime/agent-execution-governor.js";
import {
	DEFAULT_SESSION_GOVERNOR_LIMITS,
	SessionAgentGovernor,
} from "../../../packages/pi-stuff/src/subagents/src/runtime/session-governor.js";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createGovernor(
	label: string,
	options: { maxDepth?: number; maxRunning?: number } = {},
): Promise<{ execution: AgentExecutionGovernor; session: SessionAgentGovernor }> {
	const rootDir = await mkdtemp(join(tmpdir(), `pi-stuff-execution-governor-${label}-`));
	roots.push(rootDir);
	const session = new SessionAgentGovernor({
		rootDir: join(rootDir, "state"),
		sessionId: `session-${label}`,
		limits: options,
		pid: 4_001,
	});
	return { execution: new AgentExecutionGovernor(session), session };
}

function requireReservation<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
	if (!result.ok) throw new Error("Expected an Agent execution reservation");
	// SAFETY: this test controls the value and supplies every Extract member exercised by this case.
	return result as Extract<T, { ok: true }>;
}

test("atomically reserves a stable launch batch under the session concurrency and depth defaults", async () => {
	const { execution, session } = await createGovernor("spawn-defaults");
	const result = requireReservation(await execution.reserveSpawn({ launchRunId: "launch-stable", childCount: 3 }));

	expect(result.reservation).toMatchObject({
		kind: "spawn",
		launchRunId: "launch-stable",
		logicalRunId: "launch-stable",
		leases: [
			{ logicalAgentId: "launch-stable:0", runtimeRunId: "launch-stable", childIndex: 0 },
			{ logicalAgentId: "launch-stable:1", runtimeRunId: "launch-stable", childIndex: 1 },
			{ logicalAgentId: "launch-stable:2", runtimeRunId: "launch-stable", childIndex: 2 },
		],
	});
	expect(await session.snapshot()).toMatchObject({
		limits: DEFAULT_SESSION_GOVERNOR_LIMITS,
		total: 3,
		running: 3,
	});
	expect(agentExecutionLogicalId("launch-stable", 2)).toBe("launch-stable:2");
});

test("returns a concrete capacity explanation and leaves a rejected batch entirely unreserved", async () => {
	const { execution, session } = await createGovernor("capacity", { maxRunning: 1 });
	const rejected = await execution.reserveSpawn({ launchRunId: "too-wide", childCount: 2 });

	expect(rejected).toMatchObject({
		ok: false,
		error: { kind: "limit", code: "running_limit", limit: 1, used: 0, requested: 2 },
	});
	if (rejected.ok) throw new Error("Expected the launch to be rejected");
	expect(rejected.message).toContain("2 Agents");
	expect(rejected.message).toContain("1 may run at once");
	expect(rejected.message).toContain("Wait for a running Agent to finish");
	expect(await session.snapshot()).toMatchObject({ total: 0, running: 0, agents: [], leases: [] });
});

test("reports a runtime Target conflict without inventing an owner mismatch", () => {
	expect(
		formatAgentExecutionGovernorError(
			{
				kind: "conflict",
				code: "runtime_address_in_use",
				logicalAgentId: "launch:1",
				message: "Runtime Agent address 'launch:1' is already reserved in this session.",
			},
			"start",
			2,
		),
	).toBe("Cannot start 2 Agents: Runtime Agent address 'launch:1' is already reserved in this session.");
});

test("resumes the durable target child identity under the new launch runtime", async () => {
	const { execution, session } = await createGovernor("resume");
	const initial = requireReservation(
		await execution.reserveSpawn({ launchRunId: "target-run", childCount: 2 }),
	).reservation;
	await execution.settle(initial, { kind: "foreground", terminalChildIndexes: [0, 1] });

	const resumed = requireReservation(
		await execution.reserveResume({
			launchRunId: "resume-launch",
			targetRunId: "target-run",
			childIndex: 1,
		}),
	).reservation;

	expect(resumed).toMatchObject({
		kind: "resume",
		launchRunId: "resume-launch",
		logicalRunId: "target-run",
		leases: [
			{
				logicalAgentId: "target-run:1",
				runtimeRunId: "resume-launch",
				childIndex: 1,
				mode: "resume",
			},
		],
	});
	expect(await session.snapshot()).toMatchObject({ total: 2, running: 1 });
});

test("rebinds a reserved child to the actual runtime identity after execution starts", async () => {
	const { execution, session } = await createGovernor("rebind");
	const reservation = requireReservation(
		await execution.reserveSpawn({ launchRunId: "provisional-launch", childCount: 2 }),
	).reservation;

	const rebound = await execution.rebindChild(reservation, 1, {
		runtimeRunId: "runtime-from-runner",
		childIndex: 7,
		pid: 7_777,
	});

	expect(rebound).toMatchObject({
		rebound: true,
		lease: {
			logicalAgentId: "provisional-launch:1",
			runtimeRunId: "runtime-from-runner",
			childIndex: 7,
			pid: 7_777,
		},
	});
	expect(await session.findRuntimeLease("provisional-launch", 1)).toBeUndefined();
	expect(await session.findRuntimeLease("runtime-from-runner", 7)).toMatchObject({
		logicalAgentId: "provisional-launch:1",
	});
});

test("releases only terminal foreground children while retaining detached and background starts", async () => {
	const { execution, session } = await createGovernor("settlement");
	const foreground = requireReservation(
		await execution.reserveSpawn({ launchRunId: "foreground", childCount: 3 }),
	).reservation;

	expect(await execution.settle(foreground, { kind: "foreground", terminalChildIndexes: [0, 2] })).toEqual({
		releasedCount: 2,
		alreadyReleasedCount: 0,
		retainedCount: 1,
	});
	expect((await session.snapshot()).leases.map(({ logicalAgentId }) => logicalAgentId)).toEqual(["foreground:1"]);

	const detached = requireReservation(
		await execution.reserveSpawn({ launchRunId: "detached", childCount: 1 }),
	).reservation;
	expect(await execution.settle(detached, { kind: "detached" })).toEqual({
		releasedCount: 0,
		alreadyReleasedCount: 0,
		retainedCount: 1,
	});

	const background = requireReservation(
		await execution.reserveSpawn({ launchRunId: "background", childCount: 1 }),
	).reservation;
	expect(await execution.settle(background, { kind: "background-started" })).toEqual({
		releasedCount: 0,
		alreadyReleasedCount: 0,
		retainedCount: 1,
	});
	expect(await session.snapshot()).toMatchObject({ total: 5, running: 3 });
});

test("rolls back every provisional spawn record when execution fails to start", async () => {
	const { execution, session } = await createGovernor("start-error");
	const reservation = requireReservation(
		await execution.reserveSpawn({ launchRunId: "broken-launch", childCount: 3 }),
	).reservation;

	expect(await execution.settle(reservation, { kind: "start-error" })).toEqual({
		releasedCount: 3,
		alreadyReleasedCount: 0,
		retainedCount: 0,
	});
	expect(await session.snapshot()).toMatchObject({ total: 0, running: 0, agents: [], leases: [] });
	expect(await execution.reserveSpawn({ launchRunId: "broken-launch", childCount: 3 })).toMatchObject({
		ok: true,
	});
});

test("retains the logical Agent record when a resume attempt fails before start", async () => {
	const { execution, session } = await createGovernor("resume-start-error");
	const initial = requireReservation(
		await execution.reserveSpawn({ launchRunId: "saved-run", childCount: 1 }),
	).reservation;
	await execution.settle(initial, { kind: "foreground", terminalChildIndexes: [0] });
	const resume = requireReservation(
		await execution.reserveResume({ launchRunId: "resume-attempt", targetRunId: "saved-run", childIndex: 0 }),
	).reservation;

	expect(await execution.settle(resume, { kind: "start-error" })).toEqual({
		releasedCount: 1,
		alreadyReleasedCount: 0,
		retainedCount: 0,
	});
	expect(await session.snapshot()).toMatchObject({
		total: 1,
		running: 0,
		agents: [{ logicalAgentId: "saved-run:0" }],
	});
	expect(
		await execution.reserveResume({
			launchRunId: "resume-retry",
			targetRunId: "saved-run",
			childIndex: 0,
		}),
	).toMatchObject({ ok: true });
});

test("uses runtime completion events as an idempotent release boundary", async () => {
	const { execution, session } = await createGovernor("completion");
	const reservation = requireReservation(
		await execution.reserveSpawn({ launchRunId: "completion-launch", childCount: 1 }),
	).reservation;
	await execution.rebindChild(reservation, 0, { runtimeRunId: "runtime-complete", childIndex: 4 });

	expect(await execution.completeRuntime({ runtimeRunId: "runtime-complete", childIndex: 4 })).toMatchObject({
		released: true,
		logicalAgentId: "completion-launch:0",
	});
	expect(await execution.completeRuntime({ runtimeRunId: "runtime-complete", childIndex: 4 })).toEqual({
		released: false,
		reason: "not_found",
	});
	expect(await execution.settle(reservation, { kind: "foreground", terminalChildIndexes: [0] })).toEqual({
		releasedCount: 0,
		alreadyReleasedCount: 1,
		retainedCount: 0,
	});
	expect(await session.snapshot()).toMatchObject({ total: 1, running: 0 });
});
