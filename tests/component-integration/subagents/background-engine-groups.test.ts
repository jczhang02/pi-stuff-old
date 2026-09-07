import { afterEach, expect, test } from "bun:test";
import {
	cleanupBackgroundEngineFixtures,
	fixtureRoot,
	fs,
	path,
	readBackgroundCompletion,
	readBackgroundStatus,
	readFixtureJson,
	requestAsyncStop,
	runConfiguredBackground,
	singleRunnerConfig,
	task,
	WRITER_REGISTRY_SCHEMA,
	waitForFile,
	waitForFileText,
} from "../../agents/background-engine-fixtures.js";

afterEach(cleanupBackgroundEngineFixtures);

test("terminalizes queued status steps when a bounded group times out", async () => {
	const root = fixtureRoot();
	const readyMarker = path.join(root, "group-timeout-ready");
	const writer = path.join(root, "group-timeout-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(readyMarker)}, "ready");
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async");
	const config = singleRunnerConfig(root, "queued-group-timeout", {
		deadlineAt: Date.now() + 250,
		work: {
			mode: "parallel",
			group: {
				tasks: [
					{ ...task(0), cwd: root },
					{ ...task(1), cwd: root },
				],
				concurrency: 1,
				worktree: false,
			},
		},
	});

	await runConfiguredBackground(config);
	expect(fs.existsSync(readyMarker)).toBe(true);
	const status = readBackgroundStatus(asyncDir);

	expect(status).toMatchObject({
		state: "failed",
		timedOut: true,
		steps: [
			{ status: "failed", timedOut: true },
			{ status: "failed", timedOut: true },
		],
	});
	expect(status.steps?.[0]?.startedAt).toBeNumber();
	expect(status.steps?.[1]?.startedAt).toBeUndefined();
	expect(status.steps?.[1]?.endedAt).toBeNumber();
}, 5_000);

test("stops one queued child without ever spawning its writer", async () => {
	const root = fixtureRoot();
	const readyMarker = path.join(root, "target-stop-ready");
	const releaseMarker = path.join(root, "target-stop-release");
	const queuedSpawnMarker = path.join(root, "queued-writer-spawned");
	const writer = path.join(root, "queued-target-stop-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
const index = process.env.PI_SUBAGENT_CHILD_INDEX;
const assistant = (text) => JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() },
}) + "\\n";
if (index === "1") {
  fs.writeFileSync(${JSON.stringify(queuedSpawnMarker)}, "spawned");
  process.stdout.write(assistant("QUEUED_CHILD_SHOULD_NOT_RUN"));
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(readyMarker)}, "ready");
const timer = setInterval(() => {
  if (!fs.existsSync(${JSON.stringify(releaseMarker)})) return;
  clearInterval(timer);
  process.stdout.write(assistant("FIRST_CHILD_COMPLETED"), () => process.exit(0));
}, 20);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(asyncDir, "result.json");
	const running = runConfiguredBackground(
		singleRunnerConfig(root, "queued-target-stop", {
			work: {
				mode: "parallel",
				group: {
					tasks: [
						{ ...task(0), cwd: root },
						{ ...task(1), cwd: root },
					],
					concurrency: 1,
					worktree: false,
				},
			},
		}),
	);

	await waitForFile(readyMarker);
	requestAsyncStop(asyncDir, { source: "test", targetIndex: 1 });
	await waitForFileText(path.join(asyncDir, "events.jsonl"), '"subagent.child.stop_requested"');
	fs.writeFileSync(releaseMarker, "release");
	await running;
	const completion = readBackgroundCompletion(resultPath);
	const status = readBackgroundStatus(asyncDir);

	expect(completion).toMatchObject({
		state: "stopped",
		results: [{ success: true }, { success: false, stopped: true }],
	});
	expect(completion.results[1]?.writerProcesses).toBeUndefined();
	expect(status.steps?.[1]).toMatchObject({ status: "stopped" });
	expect(status.steps?.[1]?.startedAt).toBeUndefined();
	expect(fs.existsSync(queuedSpawnMarker)).toBe(false);
}, 5_000);

test("terminalizes a child step when resolved child setup rejects", async () => {
	const root = fixtureRoot();
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(asyncDir, "result.json");
	const config = singleRunnerConfig(root, "child-setup-rejection", {
		work: {
			mode: "single",
			task: {
				...task(0),
				cwd: root,
				inheritSkills: true,
				tools: ["edit"],
				capabilityCeiling: {
					version: 1,
					allowedTools: ["edit"],
					denyExtensions: false,
					sources: ["test"],
				},
			},
		},
	});

	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(resultPath);
	const status = readBackgroundStatus(asyncDir);

	expect(completion).toMatchObject({ state: "failed", success: false });
	expect(status).toMatchObject({
		state: "failed",
		steps: [
			{
				status: "failed",
				exitCode: 1,
				error: expect.stringContaining("excludes required tool 'read'"),
			},
		],
	});
	expect(status.steps?.[0]?.endedAt).toBeNumber();
});

test("reports a provider-payload diagnostic ahead of the generic aborted assistant error", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "payload-diagnostic-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
const diagnosticPath = process.env.PI_SUBAGENT_TOOL_DIAGNOSTIC_PATH;
if (!diagnosticPath) throw new Error("missing child diagnostic path");
writeFileSync(diagnosticPath, JSON.stringify({ required: [], available: [], missing: [], launchError: "FINAL_PAYLOAD_BOUND" }));
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [],
    errorMessage: "Request aborted",
    stopReason: "error",
    timestamp: Date.now(),
  },
}) + "\\n");
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-payload-diagnostic");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(singleRunnerConfig(root, "payload-diagnostic", { asyncDir, resultPath }));
	const completion = readBackgroundCompletion(resultPath);

	expect(completion.state).toBe("failed");
	expect(completion.results[0]?.error).toBe("FINAL_PAYLOAD_BOUND");
});

test("records a diagnostic when the Agent process exits nonzero without reporting an error", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "silent-nonzero-writer.ts");
	fs.writeFileSync(writer, "#!/usr/bin/env bun\nprocess.exit(7);\n", { mode: 0o700 });
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(singleRunnerConfig(root, "silent-nonzero-exit"));
	const completion = readBackgroundCompletion(resultPath);
	const status = readBackgroundStatus(asyncDir);

	expect(completion.results[0]).toMatchObject({
		exitCode: 7,
		error: "Agent process exited with code 7 without a diagnostic.",
	});
	expect(status.steps?.[0]?.error).toBe("Agent process exited with code 7 without a diagnostic.");
});

test("records a diagnostic when the Agent process dies from a signal without reporting an error", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "silent-signal-writer.ts");
	fs.writeFileSync(writer, '#!/usr/bin/env bun\nprocess.kill(process.pid, "SIGTERM");\n', { mode: 0o700 });
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(singleRunnerConfig(root, "silent-signal-exit"));
	const completion = readBackgroundCompletion(resultPath);
	const status = readBackgroundStatus(asyncDir);

	expect(completion.results[0]).toMatchObject({
		exitCode: 1,
		error: "Agent process terminated by SIGTERM without a diagnostic.",
	});
	expect(status.steps?.[0]?.error).toBe("Agent process terminated by SIGTERM without a diagnostic.");
});

test("reaps a writer and clears its registry when post-spawn identity binding fails", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "writer-binding-failure.ts");
	const writerMarker = path.join(root, "writer-executed");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(writerMarker)}, "executed");
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(asyncDir, "result.json");
	const config = singleRunnerConfig(root, "writer-binding-failure");

	await runConfiguredBackground(config, {
		afterWriterProcessUpdate: (_index, writerState) => {
			if (writerState.state === "running") throw new Error("injected writer binding failure");
		},
	});
	const completion = readBackgroundCompletion(resultPath);
	const registry = readFixtureJson(path.join(asyncDir, "writer-processes-live.json"), WRITER_REGISTRY_SCHEMA);

	expect(completion).toMatchObject({
		state: "failed",
		results: [
			{
				error: expect.stringContaining("injected writer binding failure"),
				writerProcesses: [{ exitCode: 125, signal: null }],
			},
		],
	});
	expect(registry.writers?.["0"]?.state).toBe("none");
	expect(fs.existsSync(writerMarker)).toBe(false);
});

test("rolls a pre-spawn writer identity back to none without launching a child", async () => {
	const root = fixtureRoot();
	const spawnMarker = path.join(root, "writer-spawned");
	const writer = path.join(root, "pre-spawn-binding-failure.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(spawnMarker)}, "spawned");
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(asyncDir, "result.json");
	const observedStates: string[] = [];

	await runConfiguredBackground(singleRunnerConfig(root, "pre-spawn-writer-binding-failure"), {
		afterWriterProcessUpdate: (_index, writerState) => {
			observedStates.push(writerState.state);
			if (writerState.state === "spawning") throw new Error("injected pre-spawn binding failure");
		},
	});
	const completion = readBackgroundCompletion(resultPath);
	const registry = readFixtureJson(path.join(asyncDir, "writer-processes-live.json"), WRITER_REGISTRY_SCHEMA);

	expect(completion).toMatchObject({
		state: "failed",
		results: [{ error: expect.stringContaining("injected pre-spawn binding failure") }],
	});
	expect(completion.results[0]?.writerProcesses).toEqual([]);
	expect(observedStates).toEqual(["spawning", "none"]);
	expect(registry.writers?.["0"]?.state).toBe("none");
	expect(fs.existsSync(spawnMarker)).toBe(false);
});

test("bounds rejected child errors before persisting result, status, and diagnostics", async () => {
	const root = fixtureRoot();
	const asyncDir = path.join(root, "async-bounded-rejection");
	const resultPath = path.join(asyncDir, "result.json");
	const hugeError = `REJECTION-${"界".repeat(500_000)}`;
	await runConfiguredBackground(singleRunnerConfig(root, "bounded-rejection", { asyncDir, resultPath }), {
		afterWriterProcessUpdate: (_index, writerState) => {
			if (writerState.state === "spawning") throw new Error(hugeError);
		},
	});
	const completion = readBackgroundCompletion(resultPath);
	const status = readBackgroundStatus(asyncDir);
	for (const value of [completion.results[0]?.error, completion.results[0]?.output, status.steps?.[0]?.error]) {
		expect(Buffer.byteLength(value ?? "", "utf8")).toBeLessThanOrEqual(32 * 1024);
		expect(value).not.toContain("�");
	}
	expect(fs.statSync(path.join(asyncDir, "events.jsonl")).size).toBeLessThan(64 * 1024);
});

test("rolls writer identity back when child_process.spawn throws synchronously", async () => {
	const root = fixtureRoot();
	process.env["PI_SUBAGENT_PI_BINARY"] = "\0";
	const asyncDir = path.join(root, "async-sync-spawn-error");
	const resultPath = path.join(asyncDir, "result.json");
	const observedStates: string[] = [];

	await runConfiguredBackground(singleRunnerConfig(root, "sync-spawn-error", { asyncDir, resultPath }), {
		afterWriterProcessUpdate: (_index, writerState) => observedStates.push(writerState.state),
	});
	const completion = readBackgroundCompletion(resultPath);
	const registry = readFixtureJson(path.join(asyncDir, "writer-processes-live.json"), WRITER_REGISTRY_SCHEMA);

	expect(completion.state).toBe("failed");
	expect(completion.results[0]?.error).toContain("null bytes");
	expect(completion.results[0]?.writerProcesses).toEqual([]);
	expect(completion.results[0]?.writerAttemptCount).toBe(0);
	expect(observedStates).toEqual(["spawning", "none"]);
	expect(registry.writers?.["0"]?.state).toBe("none");
});
