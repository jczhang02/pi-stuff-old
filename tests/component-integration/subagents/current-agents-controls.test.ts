import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import type { AsyncJobState } from "../../../packages/pi-stuff/src/subagents/src/runs/background/async-contract.js";
import { readNewAsyncControlEvents } from "../../../packages/pi-stuff/src/subagents/src/runs/background/async-control-events.js";
import { appendDiagnosticEvent } from "../../../packages/pi-stuff/src/subagents/src/runs/background/runner-output.js";
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
	SUBAGENT_STEERING_NOTICE_EVENT,
	waitUntil,
} from "../../agents/current-agents-fixtures.js";

test("rescans retained control events after the event log inode changes", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-control-generation-"));
	const asyncDir = path.join(root, "run.async");
	const eventsPath = path.join(asyncDir, "events.jsonl");
	try {
		fs.mkdirSync(asyncDir, { recursive: true });
		fs.writeFileSync(eventsPath, `${JSON.stringify({ type: "old", payload: "x".repeat(200) })}\n`);
		// SAFETY: the reader exercises only the cursor fields and asyncDir supplied by this focused fixture.
		const job = { asyncDir, controlEventCursor: 0 } as AsyncJobState;
		const observed: string[] = [];
		await Effect.runPromise(
			readNewAsyncControlEvents(job, (line) => {
				observed.push(line);
				return true;
			}),
		);
		const replacement = path.join(asyncDir, "events.replacement");
		fs.writeFileSync(
			replacement,
			`${JSON.stringify({ type: "replacement-control" })}\n${JSON.stringify({ type: "padding", payload: "y".repeat(300) })}\n`,
		);
		fs.renameSync(replacement, eventsPath);
		await Effect.runPromise(
			readNewAsyncControlEvents(job, (line) => {
				observed.push(line);
				return true;
			}),
		);

		expect(observed.some((line) => line.includes("replacement-control"))).toBeTrue();
	} finally {
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("does not replay retained control records across one or several missed rollovers", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-control-rollover-"));
	const eventsPath = path.join(root, "events.jsonl");
	const priorLimit = process.env["PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES"];
	process.env["PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES"] = "32768";
	try {
		const records = Array.from(
			{ length: 500 },
			(_, id) => `${JSON.stringify({ type: "subagent.control", id })}\n`,
		).join("");
		const prefix = `${JSON.stringify({ payload: "x".repeat(32768 - Buffer.byteLength(records) - 16) })}\n`;
		fs.writeFileSync(eventsPath, prefix + records, { mode: 0o600 });
		// SAFETY: this focused reader fixture supplies all cursor state and its owned event directory.
		const job = { asyncDir: root, controlEventCursor: 0 } as AsyncJobState;
		const observed: number[] = [];
		const read = () =>
			Effect.runPromise(
				readNewAsyncControlEvents(job, (line) => {
					const event = JSON.parse(line);
					if (event.type === "subagent.control") observed.push(event.id);
					return true;
				}),
			);
		await read();
		expect(observed).toHaveLength(500);
		const initialIdentity = job.controlEventIdentity;
		appendDiagnosticEvent(eventsPath, { type: "subagent.control", id: 500 });
		// Retain more than 200 old controls: a fixed-size deduplication cache is not sufficient.
		expect(fs.readFileSync(eventsPath, "utf8").split("subagent.control").length).toBeGreaterThan(201);
		await read();
		expect(job.controlEventIdentity).not.toBe(initialIdentity);
		expect(observed).toEqual(Array.from({ length: 501 }, (_, id) => id));
		for (let roll = 0; roll < 3; roll++) {
			appendDiagnosticEvent(eventsPath, { payload: "x".repeat(20000) });
		}
		appendDiagnosticEvent(eventsPath, { type: "subagent.control", id: 501 });
		await read();
		await read();
		expect(observed).toEqual(Array.from({ length: 502 }, (_, id) => id));
	} finally {
		if (priorLimit === undefined) delete process.env["PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES"];
		else process.env["PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES"] = priorLimit;
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("publishes stopping/resuming only after an honest acknowledgement", async () => {
	const state = createState();
	state.asyncJobs.set("live", asyncJob("live", "running"));
	state.recentAgentJobs?.set("done", asyncJob("done", "complete"));
	state.recentAgentJobs?.set("cancelled", asyncJob("cancelled", "stopped"));
	const calls: string[] = [];
	const current = new CurrentAgents(
		state,
		acknowledgedOptions({
			inspect: (agent) => {
				calls.push(`inspect:${agent.key}`);
				return true;
			},
			steer: (agent, message) => {
				calls.push(`steer:${agent.key}:${message}`);
				return { acknowledged: message === "continue" };
			},
			stop: (agent) => {
				calls.push(`stop:${agent.key}`);
				return { acknowledged: true, message: "stop accepted" };
			},
			resume: (agent, message) => {
				calls.push(`resume:${agent.key}:${message ?? ""}`);
				return true;
			},
		}),
	);

	const stop = await current.control({ type: "stop", key: "live:0" });
	expect(stop).toMatchObject({ acknowledged: true, message: "stop accepted", status: "stopping" });
	expect((await current.control({ type: "stop", key: "live:0" })).acknowledged).toBe(false);

	expect((await current.control({ type: "steer", key: "live:0", message: "  " })).acknowledged).toBe(false);
	expect((await current.control({ type: "inspect", key: "done:0" })).acknowledged).toBe(true);

	const resume = await current.control({ type: "resume", key: "cancelled:0", message: "retry" });
	expect(resume).toMatchObject({ acknowledged: false, status: "user_cancelled" });

	state.recentAgentJobs?.set("resumable", asyncJob("resumable", "paused"));
	current.refresh();
	const resumed = await current.control({ type: "resume", key: "resumable:0", message: " retry " });
	expect(resumed).toMatchObject({ acknowledged: true, status: "resuming" });
	expect(calls).toContain("resume:resumable:0:retry");
	expect(calls.filter((call) => call === "stop:live:0")).toHaveLength(1);
});

test("does not mask an authoritative terminal transition with a local stopping state", async () => {
	const state = createState();
	const live = asyncJob("live", "running");
	state.asyncJobs.set(live.asyncId, live);
	const current = new CurrentAgents(
		state,
		acknowledgedOptions({
			stop: () => {
				live.status = "stopped";
				state.recentAgentJobs?.set(live.asyncId, live);
				return true;
			},
		}),
	);

	const result = await current.control({ type: "stop", key: "live:0" });
	expect(result).toMatchObject({ acknowledged: true, status: "user_cancelled" });
});

test("keeps branch-proven v1 status and steering projections normalized to the primary session", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-v1-tracker-normalization-"));
	const runId = "legacy-normalized-run";
	const asyncDir = path.join(root, runId);
	fs.mkdirSync(asyncDir, { recursive: true });
	fs.writeFileSync(
		path.join(asyncDir, "events.jsonl"),
		`${JSON.stringify({
			type: "subagent.steering.notice",
			ts: 2_000,
			runId,
			requestId: "legacy-steer",
			state: "recovered",
			message: "legacy steering recovered",
			currentSessionId: "/sessions/legacy.jsonl",
		})}\n`,
	);
	fs.writeFileSync(
		path.join(asyncDir, "status.json"),
		JSON.stringify({
			runId,
			sessionId: "/sessions/legacy.jsonl",
			mode: "single",
			state: "running",
			pid: process.pid,
			startedAt: 1_000,
			lastUpdate: 2_000,
			steps: [{ agent: "reviewer", status: "running" }],
		}),
	);
	const state = createFullState("ps2-current");
	state.currentSessionScope = {
		sessionId: "ps2-current",
		governorSessionId: "ps2-current",
		legacyArtifactSessionId: "/sessions/legacy.jsonl",
		legacyRunIds: new Set([runId]),
	};
	const notices: unknown[] = [];
	const tracker = createAsyncJobTracker(
		eventHost((event, payload) => {
			if (event === SUBAGENT_STEERING_NOTICE_EVENT) notices.push(payload);
		}),
		state,
		root,
		{ pollIntervalMs: 10 },
	);

	try {
		tracker.handleStarted({
			id: runId,
			asyncDir,
			sessionId: "ps2-current",
			mode: "single",
			agents: ["reviewer"],
		});
		await waitUntil(() => notices.length === 1);
		expect(state.asyncJobs.get(runId)?.sessionId).toBe("ps2-current");
		expect(notices[0]).toMatchObject({ currentSessionId: "ps2-current", runId });
	} finally {
		tracker.resetJobs();
		await Bun.sleep(20);
		fs.rmSync(root, { force: true, recursive: true });
	}
});

test("isolates async control observers from the underlying Agent lifecycle", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-async-observer-"));
	const asyncDir = path.join(root, "observer-run");
	fs.mkdirSync(asyncDir, { recursive: true });
	const statusPath = path.join(asyncDir, "status.json");
	fs.writeFileSync(
		statusPath,
		JSON.stringify({
			runId: "observer-run",
			sessionId: "root-session",
			mode: "single",
			state: "running",
			pid: process.pid,
			startedAt: 1_000,
			lastUpdate: 2_000,
			steps: [{ agent: "reviewer", status: "running", startedAt: 1_000 }],
		}),
	);
	fs.writeFileSync(
		path.join(asyncDir, "events.jsonl"),
		`${JSON.stringify({
			type: "subagent.control",
			event: { type: "active_long_running", ts: 2_000, runId: "observer-run", index: 0 },
			channels: ["event"],
		})}\n`,
	);
	const state = createFullState("root-session");
	let observerCalls = 0;
	const tracker = createAsyncJobTracker(
		eventHost(() => {
			observerCalls += 1;
			throw new Error("injected lifecycle observer failure");
		}),
		state,
		root,
		{ pollIntervalMs: 10 },
	);

	try {
		tracker.handleStarted({
			id: "observer-run",
			asyncDir,
			sessionId: "root-session",
			mode: "single",
			agents: ["reviewer"],
		});
		await waitUntil(() => observerCalls === 1 && (state.asyncJobs.get("observer-run")?.controlEventCursor ?? 0) > 0);
		expect(state.asyncJobs.get("observer-run")?.status).toBe("running");

		fs.writeFileSync(
			statusPath,
			JSON.stringify({
				runId: "observer-run",
				sessionId: "root-session",
				mode: "single",
				state: "complete",
				pid: process.pid,
				startedAt: 1_000,
				endedAt: 3_000,
				lastUpdate: 3_000,
				steps: [{ agent: "reviewer", status: "complete", startedAt: 1_000, endedAt: 3_000 }],
			}),
		);
		await waitUntil(() => state.recentAgentJobs?.get("observer-run")?.status === "complete");
		expect(state.recentAgentJobs?.get("observer-run")?.status).toBe("complete");
	} finally {
		tracker.resetJobs();
		await Bun.sleep(20);
		fs.rmSync(root, { force: true, recursive: true });
	}
});
