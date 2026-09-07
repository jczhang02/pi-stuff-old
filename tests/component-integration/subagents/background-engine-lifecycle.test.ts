import { afterEach, expect, test } from "bun:test";
import { persistRecoveries } from "../../../packages/pi-stuff/src/subagents/src/runs/background/async-execution.js";
import {
	Check,
	cleanupBackgroundEngineFixtures,
	fixtureRoot,
	fs,
	path,
	projectForegroundCompletion,
	readBackgroundCompletion,
	readBackgroundStatus,
	reconcileAsyncRun,
	requestAsyncStop,
	runConfiguredBackground,
	singleRunnerConfig,
	TRANSCRIPT_RECORD_SCHEMA,
	task,
	waitForFile,
} from "../../agents/background-engine-fixtures.js";

afterEach(cleanupBackgroundEngineFixtures);

test("keeps the async interrupt handler installed through terminal persistence", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "finalization-signal-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const event = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "FINALIZATION_SURVIVED" }],
    stopReason: "stop",
    timestamp: Date.now(),
  },
};
process.stdout.write(JSON.stringify(event) + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-finalization-signal");
	const resultPath = path.join(asyncDir, "result.json");
	const interruptSignal = process.platform === "win32" ? "SIGBREAK" : "SIGUSR2";
	const baselineListeners = process.listenerCount(interruptSignal);
	const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
	const { promise: atSeam, resolve: entered } = Promise.withResolvers<void>();

	const running = runConfiguredBackground(singleRunnerConfig(root, "finalization-signal", { asyncDir, resultPath }), {
		beforeFinalPersistence: async () => {
			entered();
			await blocked;
		},
	});
	await atSeam;
	expect(process.listenerCount(interruptSignal)).toBeGreaterThan(baselineListeners);
	process.emit(interruptSignal);
	release();
	await running;

	expect(process.listenerCount(interruptSignal)).toBe(baselineListeners);
	expect(readBackgroundCompletion(resultPath)).toMatchObject({
		state: "complete",
		results: [{ output: "FINALIZATION_SURVIVED", success: true }],
	});
	expect(readBackgroundStatus(asyncDir)).toMatchObject({
		state: "complete",
		steps: [{ status: "complete" }],
	});
});

test("continues and reaps the writer when live status persistence degrades", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "status-degradation-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
setTimeout(() => {
  emit({ type: "tool_execution_start", toolName: "read", args: { path: "sample.ts" } });
  emit({ type: "tool_execution_end", toolName: "read" });
  emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "STATUS_DEGRADED_BUT_COMPLETE" }], stopReason: "stop", timestamp: Date.now() } });
  process.exit(0);
}, 50);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-status-degradation");
	const resultPath = path.join(asyncDir, "result.json");
	const statusPath = path.join(asyncDir, "status.json");
	let writerPid: number | undefined;
	await expect(
		runConfiguredBackground(singleRunnerConfig(root, "status-degradation", { asyncDir, resultPath }), {
			afterWriterProcessUpdate: (_index, writerState) => {
				if (writerState.state !== "running") return;
				writerPid = writerState.pid;
				fs.rmSync(statusPath, { force: true });
				fs.mkdirSync(statusPath);
			},
		}),
	).resolves.toBeUndefined();
	expect(readBackgroundCompletion(resultPath)).toMatchObject({
		state: "complete",
		results: [{ output: "STATUS_DEGRADED_BUT_COMPLETE", success: true }],
	});
	expect(fs.statSync(statusPath).isDirectory()).toBe(true);
	expect(writerPid).toBeNumber();
	const settledWriterPid = writerPid;
	if (settledWriterPid !== undefined) expect(() => process.kill(settledWriterPid, 0)).toThrow();
	expect(JSON.parse(fs.readFileSync(path.join(asyncDir, "writer-processes-live.json"), "utf8"))).toMatchObject({
		writers: { "0": { state: "none" } },
	});
});

test("fails, persists proof, and reaps a writer that emits structurally invalid JSON protocol", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "malformed-protocol-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: "oops", stopReason: "stop" },
}) + "\\n");
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-malformed-protocol");
	const resultPath = path.join(asyncDir, "result.json");
	let writerPid: number | undefined;

	await runConfiguredBackground(singleRunnerConfig(root, "malformed-protocol", { asyncDir, resultPath }), {
		afterWriterProcessUpdate: (_index, writerState) => {
			if (writerState.state === "running") writerPid = writerState.pid;
		},
	});

	const completion = readBackgroundCompletion(resultPath);
	expect(completion.state).toBe("failed");
	expect(completion.results[0]?.success).toBe(false);
	expect(completion.results[0]?.error).toContain(
		"protocol_invalid_event: message_end message.content for role 'assistant' must be an array",
	);
	expect(completion.results[0]?.writerProcesses).toEqual([
		expect.objectContaining({ signal: "SIGTERM", terminationOrigin: "manager-request" }),
	]);
	expect(readBackgroundStatus(asyncDir)).toMatchObject({
		state: "failed",
		steps: [{ status: "failed" }],
	});
	expect(writerPid).toBeNumber();
	const settledWriterPid = writerPid;
	if (settledWriterPid !== undefined) expect(() => process.kill(settledWriterPid, 0)).toThrow();
});

test("accepts Pi CustomMessage lifecycle events without selecting them as the child report", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "custom-message-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "WORK_IN_PROGRESS" }],
    stopReason: "toolUse",
    timestamp: Date.now(),
  },
});
emit({
  type: "message_end",
  message: {
    role: "custom",
    customType: "magic-context:ceiling-nudge",
    content: "HOUSEKEEPING_NOT_A_REPORT",
    display: false,
    details: { source: "fixture" },
    timestamp: Date.now(),
  },
});
emit({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "CUSTOM_MESSAGE_SURVIVED" }],
    stopReason: "stop",
    timestamp: Date.now(),
  },
});
process.exit(0);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-custom-message");
	const resultPath = path.join(asyncDir, "result.json");
	const config = singleRunnerConfig(root, "custom-message", { asyncDir, resultPath });

	await runConfiguredBackground(config);

	const completion = readBackgroundCompletion(resultPath);
	expect(completion).toMatchObject({
		state: "complete",
		results: [{ output: "CUSTOM_MESSAGE_SURVIVED", success: true, contextNudgeObserved: true }],
	});
	const projected = projectForegroundCompletion(config, completion);
	expect(projected.content[0]).toMatchObject({ text: expect.stringContaining("Context housekeeping observed") });
	const transcriptPath = path.join(asyncDir, "transcripts", "0-agent-0.jsonl");
	const transcript = fs
		.readFileSync(transcriptPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => {
			const value = JSON.parse(line);
			if (!Check(TRANSCRIPT_RECORD_SCHEMA, value)) throw new Error("Expected a transcript fixture record");
			return value;
		});
	expect(transcript).toContainEqual(
		expect.objectContaining({
			recordType: "message",
			role: "custom",
			customType: "magic-context:ceiling-nudge",
			text: "HOUSEKEEPING_NOT_A_REPORT",
		}),
	);
});

test("retains writer proof when a malformed tool-result record is rejected", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "malformed-tool-result-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
  type: "tool_result_end",
  message: {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    isError: true,
    content: [{ type: "text", text: 42 }],
  },
}) + "\\n");
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-malformed-tool-result");
	const resultPath = path.join(asyncDir, "result.json");
	let writerPid: number | undefined;

	await runConfiguredBackground(singleRunnerConfig(root, "malformed-tool-result", { asyncDir, resultPath }), {
		afterWriterProcessUpdate: (_index, writerState) => {
			if (writerState.state === "running") writerPid = writerState.pid;
		},
	});

	const completion = readBackgroundCompletion(resultPath);
	expect(completion.results[0]).toMatchObject({
		success: false,
		writerAttemptCount: 1,
	});
	expect(completion.results[0]?.error).toContain("message.content text must be a string");
	expect(completion.results[0]?.writerProcesses).toEqual([
		expect.objectContaining({ signal: "SIGTERM", terminationOrigin: "manager-request" }),
	]);
	const settledWriterPid = writerPid;
	expect(settledWriterPid).toBeNumber();
	if (settledWriterPid !== undefined) expect(() => process.kill(settledWriterPid, 0)).toThrow();
});

test("leaves a nonterminal status that stale reconciliation can repair when result persistence fails", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "result-persistence-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "RESULT_WAS_READY" }], stopReason: "stop", timestamp: Date.now() } };
process.stdout.write(JSON.stringify(event) + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "result-persistence");
	const resultPath = path.join(asyncDir, "result.json");

	await expect(
		runConfiguredBackground(singleRunnerConfig(root, "result-persistence", { asyncDir, resultPath }), {
			beforeResultPersistence: () => {
				throw Object.assign(new Error("injected result EIO"), { code: "EIO" });
			},
		}),
	).rejects.toThrow("injected result EIO");
	expect(fs.existsSync(resultPath)).toBe(false);
	expect(readBackgroundStatus(asyncDir)).toMatchObject({
		state: "running",
		steps: [{ recentOutput: ["RESULT_WAS_READY"], status: "complete" }],
	});

	const resultsDir = path.join(root, "reconciled-results");
	fs.mkdirSync(resultsDir);
	const repaired = reconcileAsyncRun(asyncDir, {
		resultsDir,
		kill: () => {
			throw Object.assign(new Error("gone"), { code: "ESRCH" });
		},
	});
	expect(repaired).toMatchObject({ repaired: true, status: { state: "failed" } });
	expect(fs.existsSync(path.join(resultsDir, "result-persistence.json"))).toBe(true);
});

test("keeps successful child proof when optional worktree evidence capture fails", async () => {
	const root = fixtureRoot();
	for (const args of [
		["init", "-b", "main"],
		["config", "user.name", "Pi Stuff Test"],
		["config", "user.email", "pi-stuff@example.invalid"],
		["config", "commit.gpgsign", "false"],
		["add", "."],
		["commit", "-m", "fixture"],
	] as const) {
		const command = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe", stdout: "pipe" });
		if (command.exitCode !== 0) throw new Error(command.stderr.toString("utf-8"));
	}
	const writer = path.join(root, "worktree-evidence-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "WORKTREE_TASK_SUCCEEDED" }], stopReason: "stop", timestamp: Date.now() } };
process.stdout.write(JSON.stringify(event) + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	for (const args of [
		["add", path.basename(writer)],
		["commit", "-m", "add writer fixture"],
	] as const) {
		const command = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe", stdout: "pipe" });
		if (command.exitCode !== 0) throw new Error(command.stderr.toString("utf-8"));
	}
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const resultRoot = fixtureRoot();
	process.env["TMPDIR"] = resultRoot;
	const asyncDir = path.join(resultRoot, "async-worktree-evidence");
	const resultPath = path.join(asyncDir, "result.json");
	persistRecoveries(asyncDir, [
		{
			version: 2,
			sourceRunId: "worktree-evidence",
			childIndex: 0,
			agent: "agent-0",
			cwd: root,
			systemPromptMode: "append",
			inheritProjectContext: true,
			inheritSkills: false,
			maxSubagentDepth: 1,
		},
	]);
	await runConfiguredBackground(
		singleRunnerConfig(resultRoot, "worktree-evidence", {
			cwd: root,
			asyncDir,
			resultPath,
			work: {
				mode: "parallel",
				group: {
					tasks: [{ ...task(0), cwd: root }],
					concurrency: 1,
					worktree: true,
				},
			},
		}),
		{
			beforeWorktreeEvidence: () => {
				throw new Error("injected evidence failure");
			},
		},
	);
	const completion = readBackgroundCompletion(resultPath);
	expect(completion).toMatchObject({
		state: "complete",
		success: true,
		results: [{ output: "WORKTREE_TASK_SUCCEEDED", success: true }],
		worktree: { error: expect.stringContaining("injected evidence failure") },
	});
	expect(completion.results[0]?.writerProcesses).toHaveLength(1);
	const listed = Bun.spawnSync(["git", "worktree", "list", "--porcelain"], {
		cwd: root,
		stderr: "pipe",
		stdout: "pipe",
	});
	expect(listed.exitCode).toBe(0);
	expect(listed.stdout.toString("utf-8").match(/^worktree /gmu)).toHaveLength(1);
}, 10_000);

test("treats an internal final drain after a clean terminal report as completion", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "lingering-success-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const event = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "VALID_COMPLETED_REVIEW" }],
    stopReason: "stop",
    timestamp: Date.now(),
  },
};
process.stdout.write(JSON.stringify(event) + "\\n");
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async");
	const resultPath = path.join(asyncDir, "result.json");
	const config = singleRunnerConfig(root, "internal-final-drain", { asyncDir, resultPath });

	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(resultPath);

	expect(completion).toMatchObject({
		state: "complete",
		success: true,
		results: [
			{
				exitCode: 0,
				output: "VALID_COMPLETED_REVIEW",
				success: true,
				writerProcesses: [{ exitCode: null, signal: "SIGTERM", terminationOrigin: "manager-final-drain" }],
			},
		],
	});
}, 5_000);

test("fails without inventing a crash when final-drain disposition proof is unavailable", async () => {
	if (process.platform === "win32") return;
	const root = fixtureRoot();
	const writer = path.join(root, "missing-disposition-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const event = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "VALID_BUT_PROOF_REMOVED" }],
    stopReason: "stop",
    timestamp: Date.now(),
  },
};
process.stdout.write(JSON.stringify(event) + "\\n");
process.kill(process.ppid, "SIGKILL");
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-missing-disposition");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(singleRunnerConfig(root, "missing-final-drain-disposition", { asyncDir, resultPath }));
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const completion = JSON.parse(fs.readFileSync(resultPath, "utf8")) as {
		state: string;
		success: boolean;
		results: Array<{
			crashed?: boolean;
			error?: string;
			success: boolean;
			writerProcesses?: Array<{ terminationOrigin?: string }>;
		}>;
	};

	expect(completion.state).toBe("failed");
	expect(completion.success).toBeFalse();
	expect(completion.results[0]).toMatchObject({
		success: false,
		error: expect.stringContaining("termination provenance could not be verified"),
	});
	expect(completion.results[0]?.crashed).not.toBeTrue();
	expect(completion.results[0]?.writerProcesses?.[0]?.terminationOrigin).toBeUndefined();
}, 5_000);

test("classifies a bare SIGTERM to the writer supervisor as an external crash", async () => {
	if (process.platform === "win32") return;
	const root = fixtureRoot();
	const writer = path.join(root, "external-supervisor-signal-writer.ts");
	fs.writeFileSync(writer, "#!/usr/bin/env bun\nsetInterval(() => {}, 1_000);\n", { mode: 0o700 });
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-external-supervisor-signal");
	const resultPath = path.join(asyncDir, "result.json");
	const config = singleRunnerConfig(root, "external-supervisor-signal", { asyncDir, resultPath });

	await runConfiguredBackground(config, {
		afterWriterProcessUpdate: (_index, writerState) => {
			if (writerState.state !== "running") return;
			setTimeout(() => process.kill(writerState.pid, "SIGTERM"), 100);
		},
	});
	const completion = readBackgroundCompletion(resultPath);
	const projected = projectForegroundCompletion(config, completion);

	expect(completion).toMatchObject({
		state: "failed",
		results: [
			{
				success: false,
				writerProcesses: [{ signal: "SIGTERM", terminationOrigin: "external" }],
			},
		],
	});
	expect(projected.details.results[0]?.crashed).toBeTrue();
}, 5_000);

test("preserves external provenance when a manager stop follows the same signal", async () => {
	if (process.platform === "win32") return;
	const root = fixtureRoot();
	const readyMarker = path.join(root, "external-then-manager-ready");
	const signalMarker = path.join(root, "external-then-manager-signalled");
	const writer = path.join(root, "external-then-manager-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
process.on("SIGTERM", () => {
  fs.writeFileSync(${JSON.stringify(signalMarker)}, "signalled");
  setTimeout(() => process.exit(143), 250);
});
fs.writeFileSync(${JSON.stringify(readyMarker)}, "ready");
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-external-then-manager");
	const resultPath = path.join(asyncDir, "result.json");
	let supervisorPid: number | undefined;
	const running = runConfiguredBackground(
		singleRunnerConfig(root, "external-then-manager", { asyncDir, resultPath }),
		{
			afterWriterProcessUpdate: (_index, writerState) => {
				if (writerState.state === "running") supervisorPid = writerState.pid;
			},
		},
	);
	await waitForFile(readyMarker);
	if (!supervisorPid) throw new Error("Writer supervisor did not publish its pid.");
	process.kill(supervisorPid, "SIGTERM");
	await waitForFile(signalMarker);
	requestAsyncStop(asyncDir, { source: "test" });
	await running;

	const completion = readBackgroundCompletion(resultPath);
	expect(completion.results[0]?.writerProcesses?.[0]?.terminationOrigin).toBe("external");
}, 5_000);
