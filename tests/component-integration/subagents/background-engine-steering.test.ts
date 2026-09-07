import { afterEach, expect, test } from "bun:test";
import {
	cleanupBackgroundEngineFixtures,
	fixtureRoot,
	fs,
	path,
	readBackgroundCompletion,
	readBackgroundStatus,
	requestAsyncSteer,
	requestAsyncStop,
	runConfiguredBackground,
	singleRunnerConfig,
	steerAcksDir,
	steerInboxClosedPath,
	steerRequestsDir,
	stepSteerInboxDir,
	task,
	waitForCondition,
	waitForDirectoryEntry,
	waitForFile,
	writeSteerAck,
} from "../../agents/background-engine-fixtures.js";

afterEach(cleanupBackgroundEngineFixtures);

test("keeps a steered writer alive when new input follows a valid terminal report", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "steered-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const assistant = (text) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
  },
});
const user = (text) => ({
  type: "message_end",
  message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
});
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
process.on("SIGTERM", () => process.exit(143));
emit(assistant("VALID_COMPLETED_REVIEW"));
setTimeout(() => emit(user("Late correlated steering input")), 25);
setTimeout(() => emit(assistant("VALID_COMPLETED_REVIEW_AFTER_STEERING")), 1_200);
setTimeout(() => process.exit(0), 1_225);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(asyncDir, "result.json");
	const config = singleRunnerConfig(root, "steered-terminal-report", {
		work: { mode: "single", task: task(0) },
	});

	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(resultPath);

	expect(completion).toMatchObject({
		state: "complete",
		success: true,
		results: [
			{
				exitCode: 0,
				output: "VALID_COMPLETED_REVIEW_AFTER_STEERING",
				success: true,
			},
		],
	});
}, 5_000);

test("cancels an armed hard drain when steering arrives after the internal signal", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "late-steered-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const assistant = (text) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    timestamp: Date.now(),
  },
});
const user = (text) => ({
  type: "message_end",
  message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
});
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let resumed = false;
process.on("SIGTERM", () => {
  if (resumed) return;
  resumed = true;
  emit(user("Steering delivered after the internal final-drain signal"));
  setTimeout(() => {
    emit(assistant("VALID_COMPLETED_REVIEW_AFTER_LATE_STEERING"));
    process.exit(0);
  }, 3_500);
});
emit(assistant("EARLY_TERMINAL_REPORT"));
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(asyncDir, "result.json");
	const config = singleRunnerConfig(root, "late-steering-cancels-hard-drain", {
		work: { mode: "single", task: task(0) },
	});

	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(resultPath);

	expect(completion).toMatchObject({
		state: "complete",
		success: true,
		results: [
			{
				exitCode: 0,
				output: "VALID_COMPLETED_REVIEW_AFTER_LATE_STEERING",
				success: true,
			},
		],
	});
}, 6_000);

test("real steering routing revokes an armed final drain before the child emits another event", async () => {
	const root = fixtureRoot();
	const termMarker = path.join(root, "manager-term-observed");
	const writer = path.join(root, "routed-steering-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
process.on("SIGTERM", () => fs.writeFileSync(${JSON.stringify(termMarker)}, "term"));
const event = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "VALID_BEFORE_ROUTED_STEERING" }],
    stopReason: "stop",
    timestamp: Date.now(),
  },
};
process.stdout.write(JSON.stringify(event) + "\\n");
setTimeout(() => process.exit(0), 4_500);
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(asyncDir, "result.json");
	const config = singleRunnerConfig(root, "real-steering-revokes-final-drain", {
		parentRunOrigin: "automatic",
	});

	const running = runConfiguredBackground(config);
	await waitForFile(termMarker);
	requestAsyncSteer(asyncDir, {
		id: "late-real-steer",
		message: "Continue with the routed follow-up.",
		parentRunOrigin: "user",
		source: "test",
		targetIndex: 0,
	});
	await running;
	const completion = readBackgroundCompletion(resultPath);

	expect(completion).toMatchObject({
		parentRunOrigin: "user",
		state: "complete",
		success: true,
		results: [
			{
				exitCode: 0,
				success: true,
				writerProcesses: [{ exitCode: 0, signal: null }],
			},
		],
	});
	expect(readBackgroundStatus(asyncDir)).toMatchObject({
		parentRunOrigin: "user",
	});
}, 7_000);

test("retains an acknowledgement that becomes visible before its source steering request", async () => {
	const root = fixtureRoot();
	const readyMarker = path.join(root, "ack-before-source-ready");
	const releaseMarker = path.join(root, "ack-before-source-release");
	const writer = path.join(root, "ack-before-source-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(readyMarker)}, "ready");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releaseMarker)})) return;
  clearInterval(timer);
  const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ACK_ORDER_OK" }], stopReason: "stop", timestamp: Date.now() } };
  process.stdout.write(JSON.stringify(event) + "\\n", () => process.exit(0));
}, 20);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-ack-before-source");
	const resultPath = path.join(asyncDir, "result.json");
	const requestId = "ack-visible-first";
	const running = runConfiguredBackground(singleRunnerConfig(root, "ack-before-source", { asyncDir, resultPath }));
	await waitForFile(readyMarker);
	writeSteerAck(asyncDir, {
		index: 0,
		message: "accepted before source recovery",
		requestId,
		state: "delivered",
		ts: Date.now(),
	});
	await waitForCondition(
		() => fs.readdirSync(steerAcksDir(asyncDir, 0)).some((entry) => entry.includes(".pi-stuff-inflight.")),
		"the unmatched steering acknowledgement to retain its durable claim",
	);
	expect(fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8")).not.toContain("subagent.steer.delivered");

	requestAsyncSteer(asyncDir, {
		id: requestId,
		message: "Restore and correlate this steering request.",
		source: "test",
		targetIndex: 0,
	});
	await waitForCondition(() => {
		try {
			const persisted = readBackgroundStatus(asyncDir);
			return persisted.steering?.recent?.find(({ id }) => id === requestId)?.targets?.[0]?.state === "delivered";
		} catch {
			return false;
		}
	}, "the retained acknowledgement to correlate with its restored source");
	fs.writeFileSync(releaseMarker, "release");
	await running;

	expect(fs.readdirSync(steerAcksDir(asyncDir, 0))).toHaveLength(0);
	const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8");
	expect(events.match(/subagent\.steer\.delivered/g)).toHaveLength(1);
}, 7_000);

test("replays a steering source after one status-write failure without routing twice", async () => {
	const root = fixtureRoot();
	const readyMarker = path.join(root, "steer-retry-ready");
	const releaseMarker = path.join(root, "steer-retry-release");
	const writer = path.join(root, "steer-retry-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(readyMarker)}, "ready");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releaseMarker)})) return;
  clearInterval(timer);
  const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "STEER_RETRY_OK" }], stopReason: "stop", timestamp: Date.now() } };
  process.stdout.write(JSON.stringify(event) + "\\n", () => process.exit(0));
}, 20);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-steer-retry");
	const resultPath = path.join(asyncDir, "result.json");
	const statusPath = path.join(asyncDir, "status.json");
	const requestId = "source-status-retry";
	const running = runConfiguredBackground(singleRunnerConfig(root, "steer-source-retry", { asyncDir, resultPath }));
	await waitForFile(readyMarker);
	fs.rmSync(statusPath, { force: true });
	fs.mkdirSync(statusPath);
	requestAsyncSteer(asyncDir, {
		id: requestId,
		message: "Route exactly once across a transient status failure.",
		source: "test",
		targetIndex: 0,
	});
	await waitForDirectoryEntry(stepSteerInboxDir(asyncDir, 0));
	await waitForCondition(
		() => fs.readdirSync(steerRequestsDir(asyncDir)).some((entry) => entry.includes(".pi-stuff-inflight.")),
		"the steering source claim to remain in flight",
	);

	fs.rmSync(statusPath, { recursive: true, force: true });
	await waitForCondition(() => {
		try {
			const persisted = readBackgroundStatus(asyncDir);
			return persisted.steering?.recent?.some(({ id }) => id === requestId) === true;
		} catch {
			return false;
		}
	}, "the replayed steering status write");
	expect(fs.readdirSync(stepSteerInboxDir(asyncDir, 0)).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
	expect(fs.readdirSync(steerRequestsDir(asyncDir))).toHaveLength(0);

	writeSteerAck(asyncDir, {
		index: 0,
		message: "accepted after source retry",
		requestId,
		state: "delivered",
		ts: Date.now(),
	});
	await waitForCondition(() => fs.readdirSync(steerAcksDir(asyncDir, 0)).length === 0, "steering ack completion");
	fs.writeFileSync(releaseMarker, "release");
	await running;

	const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8");
	expect(events.match(/subagent\.steer\.routed/g)).toHaveLength(1);
	expect(events.match(/subagent\.steer\.delivered/g)).toHaveLength(1);
}, 8_000);

test("keeps multi-target steering and final result authoritative when control status persistence fails", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "steering-persistence-writer.ts");
	const releaseMarker = path.join(root, "release-steering-writers");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
const index = process.env.PI_SUBAGENT_CHILD_INDEX;
fs.writeFileSync(${JSON.stringify(path.join(root, "ready-"))} + index, "ready");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releaseMarker)})) return;
  clearInterval(timer);
  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "STEERING_STATUS_DEGRADED_" + index }],
      stopReason: "stop",
      timestamp: Date.now(),
    },
  };
  process.stdout.write(JSON.stringify(event) + "\\n", () => process.exit(0));
}, 20);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-steering-persistence");
	const resultPath = path.join(asyncDir, "result.json");
	const statusPath = path.join(asyncDir, "status.json");
	const requestId = "multi-target-persistence";
	const running = runConfiguredBackground(
		singleRunnerConfig(root, "steering-persistence", {
			asyncDir,
			resultPath,
			work: {
				mode: "parallel",
				group: {
					tasks: [
						{ ...task(0), cwd: root },
						{ ...task(1), cwd: root },
					],
					concurrency: 2,
					worktree: false,
				},
			},
		}),
		{
			beforeFinalPersistence: () => {
				writeSteerAck(asyncDir, {
					index: 0,
					message: "first delivered",
					requestId,
					state: "delivered",
					ts: Date.now(),
				});
				writeSteerAck(asyncDir, {
					index: 1,
					message: "second delivered",
					requestId,
					state: "delivered",
					ts: Date.now() + 1,
				});
				fs.mkdirSync(steerInboxClosedPath(asyncDir));
			},
		},
	);

	await Promise.all([waitForFile(path.join(root, "ready-0")), waitForFile(path.join(root, "ready-1"))]);
	fs.rmSync(statusPath, { force: true });
	fs.mkdirSync(statusPath);
	requestAsyncSteer(asyncDir, {
		id: requestId,
		message: "Apply this to both running Agents.",
		source: "test",
		targetIndexes: [0, 1],
	});
	await Promise.all([
		waitForDirectoryEntry(stepSteerInboxDir(asyncDir, 0)),
		waitForDirectoryEntry(stepSteerInboxDir(asyncDir, 1)),
	]);
	fs.writeFileSync(releaseMarker, "release");
	await running;

	expect(readBackgroundCompletion(resultPath)).toMatchObject({
		state: "complete",
		success: true,
		results: [{ success: true }, { success: true }],
	});
	const events = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8");
	expect(events.match(/subagent\.steer\.routed/g)).toHaveLength(2);
	expect(events.match(/subagent\.steer\.delivered/g)).toHaveLength(2);
	expect(fs.statSync(statusPath).isDirectory()).toBe(true);
}, 7_000);

test("preserves the first stop cause and rejects steering while a child is terminating", async () => {
	const root = fixtureRoot();
	const readyMarker = path.join(root, "stop-race-ready");
	const writer = path.join(root, "stop-race-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(readyMarker)}, "ready");
let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  process.stdout.write("x".repeat(17 * 1024 * 1024), () => process.exit(0));
});
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(asyncDir, "result.json");
	const config = singleRunnerConfig(root, "stop-cause-wins-race");

	const running = runConfiguredBackground(config);
	await waitForFile(readyMarker);
	requestAsyncStop(asyncDir, { source: "test", targetIndex: 0 });
	requestAsyncSteer(asyncDir, {
		id: "steer-after-stop",
		message: "This must not revive a terminating child.",
		source: "test",
		targetIndex: 0,
	});
	await running;
	const completion = readBackgroundCompletion(resultPath);
	const status = readBackgroundStatus(asyncDir);

	expect(completion).toMatchObject({
		state: "stopped",
		results: [{ error: "Agent stopped by user.", stopped: true }],
	});
	expect(status.steering?.recent?.[0]?.targets?.[0]).toMatchObject({
		state: "failed",
		reason: "Agent is stopped.",
	});
}, 7_000);
