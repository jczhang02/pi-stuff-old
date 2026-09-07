import { expect, test } from "bun:test";
import { classifyLegacyActiveStatus } from "../../../packages/pi-stuff/src/subagents/src/runs/background/async-job-recovery.js";
import type { AsyncStatus } from "../../../packages/pi-stuff/src/subagents/src/shared/types.js";
import {
	acknowledgedOptions,
	CurrentAgents,
	createAsyncJobTracker,
	createFullState,
	eventHost,
	fs,
	os,
	path,
	row,
} from "../../agents/current-agents-fixtures.js";

function legacyStatus(overrides: Partial<AsyncStatus> = {}): AsyncStatus {
	return {
		mode: "single",
		runId: "legacy-run",
		sessionId: "root-session",
		startedAt: 1_000,
		state: "running",
		steps: [{ agent: "reviewer", status: "running" }],
		...overrides,
	};
}

test("classifies legacy active process evidence without touching current lifecycle artifacts", () => {
	const liveRunner = legacyStatus({ pid: 41, processStartIdentity: "proc:41" });
	expect(
		classifyLegacyActiveStatus("/legacy/live-runner", liveRunner, {
			inspectWriters: () => {
				throw new Error("writer inspection should short-circuit");
			},
			probeRunner: () => true,
			readRunnerIdentity: () => "proc:41",
		}),
	).toBe(liveRunner);

	const liveWriter = legacyStatus({ pid: 42, processStartIdentity: "proc:42" });
	expect(
		classifyLegacyActiveStatus("/legacy/live-writer", liveWriter, {
			inspectWriters: () => true,
			probeRunner: () => false,
		}),
	).toBe(liveWriter);

	const terminal = legacyStatus({ state: "failed" });
	expect(classifyLegacyActiveStatus("/legacy/terminal", terminal)).toBe(terminal);
	const current = legacyStatus({ lifecycleArtifactVersion: 3 });
	expect(
		classifyLegacyActiveStatus("/current/run", current, {
			inspectWriters: () => {
				throw new Error("current status must not be inspected as legacy");
			},
			probeRunner: () => {
				throw new Error("current status must not be inspected as legacy");
			},
		}),
	).toBe(current);
});

test("projects dead, reused, terminal, and unverifiable legacy owners as incomplete", () => {
	const options = { now: () => 9_000 };
	const dead = classifyLegacyActiveStatus("/legacy/dead", legacyStatus({ pid: 43 }), {
		...options,
		inspectWriters: () => false,
		probeRunner: () => false,
	});
	expect(dead).toMatchObject({ state: "failed", endedAt: 9_000 });
	expect(dead.error).toContain("no longer live");
	expect(dead.error).toContain("No process was signalled or reclaimed");
	expect(dead.steps?.[0]?.terminalOutcome).toMatchObject({
		class: "process",
		state: "failed",
		continuation: { resumeSupported: false, target: { id: "legacy-run", index: 0 } },
	});

	const reused = classifyLegacyActiveStatus(
		"/legacy/reused",
		legacyStatus({ pid: 44, processStartIdentity: "proc:old", sessionFile: "child.jsonl" }),
		{
			...options,
			inspectWriters: () => false,
			probeRunner: () => true,
			readRunnerIdentity: () => "proc:new",
		},
	);
	expect(reused.error).toContain("PID was reused");
	expect(reused.steps?.[0]?.terminalOutcome).toMatchObject({
		class: "process",
		state: "incomplete",
		continuation: { resumeSupported: true },
	});

	const unknown = classifyLegacyActiveStatus("/legacy/unknown", legacyStatus({ pid: 45 }), {
		...options,
		inspectWriters: () => undefined,
		probeRunner: () => false,
	});
	expect(unknown.error).toContain("cannot be verified");

	const observed = classifyLegacyActiveStatus(
		"/legacy/observed",
		legacyStatus({
			processTerminal: {
				version: 1,
				state: "observed",
				runId: "legacy-run",
				runnerProcessInstanceId: "legacy-runner",
				observedAt: 8_000,
				instances: [],
			},
		}),
		{
			...options,
			inspectWriters: () => {
				throw new Error("terminal proof must short-circuit liveness inspection");
			},
			probeRunner: () => {
				throw new Error("terminal proof must short-circuit liveness inspection");
			},
		},
	);
	expect(observed.error).toContain("terminal evidence");
	expect(observed.processTerminal?.state).toBe("observed");
});

test("cold restore quarantines an unverifiable legacy row without rewriting its artifact", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-legacy-quarantine-"));
	const asyncDir = path.join(root, "legacy-run");
	fs.mkdirSync(asyncDir);
	const statusPath = path.join(asyncDir, "status.json");
	const original = `${JSON.stringify(legacyStatus())}\n`;
	fs.writeFileSync(statusPath, original);
	const state = createFullState("root-session");
	const tracker = createAsyncJobTracker(eventHost(), state, root);
	try {
		await tracker.restoreActiveJobs();
		expect(state.asyncJobs.has("legacy-run")).toBeFalse();
		expect(state.recentAgentJobs?.get("legacy-run")?.status).toBe("failed");
		const restored = row(new CurrentAgents(state, acknowledgedOptions()).snapshot(), "legacy-run:0");
		expect(restored.status).toBe("failed");
		expect(restored.terminalOutcome).toMatchObject({ class: "process", state: "failed" });
		expect(restored.error).toContain("quarantined as incomplete");
		expect(fs.readFileSync(statusPath, "utf8")).toBe(original);
	} finally {
		tracker.resetJobs();
		fs.rmSync(root, { force: true, recursive: true });
	}
});
