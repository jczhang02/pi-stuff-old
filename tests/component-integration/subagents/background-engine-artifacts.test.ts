import { afterEach, expect, test } from "bun:test";
import {
	appendDiagnosticEvent,
	cleanupBackgroundEngineFixtures,
	fixtureRoot,
	fs,
	path,
	readBackgroundCompletion,
	readBackgroundStatus,
	runConfiguredBackground,
	singleRunnerConfig,
	task,
} from "../../agents/background-engine-fixtures.js";

afterEach(cleanupBackgroundEngineFixtures);

test("records diagnostic rollover when the newest event cannot fit beside the marker", () => {
	const eventsPath = path.join(fixtureRoot(), "events.jsonl");
	process.env["PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES"] = "256";
	const initial = `${JSON.stringify({ payload: "old".repeat(40), type: "old" })}\n`;
	const latest = { payload: "x".repeat(160), type: "latest" };
	const expectedDiscardedBytes = Buffer.byteLength(initial, "utf8") + Buffer.byteLength(`${JSON.stringify(latest)}\n`);
	fs.writeFileSync(eventsPath, initial, { mode: 0o600 });

	appendDiagnosticEvent(eventsPath, latest);

	const events = fs.readFileSync(eventsPath, "utf8");
	expect(Buffer.byteLength(events, "utf8")).toBeLessThanOrEqual(256);
	expect(JSON.parse(events)).toMatchObject({
		discardedBytesThisRoll: expectedDiscardedBytes,
		type: "subagent.events.truncated",
	});
});

test("removes an oversized diagnostic log when no rollover record can fit", () => {
	const eventsPath = path.join(fixtureRoot(), "events.jsonl");
	process.env["PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES"] = "8";
	fs.writeFileSync(eventsPath, "stale".repeat(100), { mode: 0o600 });

	appendDiagnosticEvent(eventsPath, { type: "latest" });

	expect(fs.existsSync(eventsPath)).toBeFalse();
});

test("retains a bounded diagnostic log when only the new event exceeds its limit", () => {
	const eventsPath = path.join(fixtureRoot(), "events.jsonl");
	process.env["PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES"] = "64";
	const existing = `${JSON.stringify({ type: "old" })}\n`;
	fs.writeFileSync(eventsPath, existing, { mode: 0o600 });

	appendDiagnosticEvent(eventsPath, { payload: "x".repeat(100), type: "latest" });

	expect(fs.readFileSync(eventsPath, "utf8")).toBe(existing);
});

test("counts omitted event bytes before malformed UTF-8 decoding", () => {
	const eventsPath = path.join(fixtureRoot(), "events.jsonl");
	process.env["PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES"] = "1024";
	const retainedLine = Buffer.concat([Buffer.alloc(100, 0xff), Buffer.from("\n")]);
	const initial = Buffer.concat([Buffer.from(`${"a".repeat(900)}\n`), retainedLine]);
	fs.writeFileSync(eventsPath, initial, { mode: 0o600 });

	appendDiagnosticEvent(eventsPath, { payload: "x".repeat(40), type: "latest" });

	const marker = JSON.parse(fs.readFileSync(eventsPath, "utf8").split("\n")[0] ?? "{}");
	expect(marker).toMatchObject({ discardedBytesThisRoll: initial.length - retainedLine.length });
});

test("keeps a valid Agent result when its optional artifact directory disappears", async () => {
	const root = fixtureRoot();
	const artifactsDir = path.join(root, "artifacts");
	const writer = path.join(root, "artifact-loss-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
fs.rmSync(${JSON.stringify(artifactsDir)}, { recursive: true, force: true });
const event = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "VALID_AFTER_ARTIFACT_LOSS" }],
    stopReason: "stop",
    timestamp: Date.now(),
  },
};
process.stdout.write(JSON.stringify(event) + "\\n");
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const config = singleRunnerConfig(root, "artifact-directory-loss", {
		artifactsDir,
		artifactConfig: { enabled: true },
	});

	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(config.resultPath);
	const child = completion.results[0];
	const status = readBackgroundStatus(config.asyncDir);

	expect(completion).toMatchObject({
		state: "complete",
		success: true,
		results: [{ output: "VALID_AFTER_ARTIFACT_LOSS", success: true }],
	});
	expect(child?.transcriptError).toContain("Failed to write child transcript");
	expect(status.steps?.[0]).toMatchObject({
		finalOutput: "VALID_AFTER_ARTIFACT_LOSS",
		savedOutputPath: child?.artifactPaths?.outputPath,
	});
	expect(child?.artifactPaths && fs.existsSync(child.artifactPaths.outputPath)).toBe(true);
	expect(child?.artifactPaths && fs.existsSync(child.artifactPaths.metadataPath)).toBe(true);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const metadata = JSON.parse(fs.readFileSync(child?.artifactPaths?.metadataPath ?? "", "utf8")) as {
		state?: string;
	};
	expect(metadata.state).toBe("complete");
}, 5_000);

test("continues after newline-delimited child protocol output crosses the retired aggregate threshold", async () => {
	const root = fixtureRoot();
	process.env["PI_SUBAGENT_CHILD_PROTOCOL_MAX_BYTES"] = "4096";
	const writer = path.join(root, "aggregate-protocol-limit.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const lines = [];
for (let index = 0; index < 100; index++) {
  lines.push(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "ROW-" + index + "-" + "x".repeat(240) }],
      stopReason: index === 99 ? "stop" : "toolUse",
      timestamp: Date.now(),
    },
  }));
}
process.stdout.write(lines.join("\\n") + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const config = singleRunnerConfig(root, "aggregate-protocol", {
		asyncDir: path.join(root, "async-aggregate-protocol"),
	});
	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(config.resultPath);
	const status = readBackgroundStatus(config.asyncDir);

	expect(completion).toMatchObject({
		state: "complete",
		success: true,
		results: [{ output: expect.stringContaining("ROW-99-"), success: true }],
	});
	expect(completion.results[0]?.protocolError).toBeUndefined();
	expect(Buffer.byteLength((status.steps?.[0]?.recentOutput ?? []).join("\n"), "utf8")).toBeLessThanOrEqual(64 * 1024);
}, 5_000);

test("compacts redundant Pi lifecycle payloads while forwarding the full protocol", async () => {
	const root = fixtureRoot();
	process.env["PI_SUBAGENT_CHILD_PROTOCOL_MAX_BYTES"] = "4096";
	const writer = path.join(root, "redundant-protocol-payloads.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const toolResult = {
  role: "toolResult",
  toolCallId: "call-1",
  toolName: "read",
  content: [{ type: "text", text: "x".repeat(1700) }],
  isError: false,
  timestamp: Date.now(),
};
const assistant = {
  role: "assistant",
  content: [{ type: "text", text: "PROTOCOL_COMPACTED" }],
  stopReason: "stop",
  timestamp: Date.now(),
};
const events = [
  { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "fixture" } },
  { type: "message_start", message: toolResult },
  { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: toolResult.content }, isError: false },
  { type: "message_end", message: toolResult },
  { type: "turn_end", message: assistant, toolResults: [toolResult] },
  { type: "message_end", message: assistant },
];
process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const config = singleRunnerConfig(root, "redundant-protocol", {
		asyncDir: path.join(root, "async-redundant-protocol"),
	});
	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(config.resultPath);

	expect(completion).toMatchObject({
		state: "complete",
		success: true,
		results: [{ output: "PROTOCOL_COMPACTED", success: true }],
	});
	expect(completion.results[0]?.protocolError).toBeUndefined();
}, 5_000);

test("accepts a final record without a newline after the retired aggregate threshold", async () => {
	const root = fixtureRoot();
	const cases = [
		{
			id: "aggregate-final-line",
			protocolLimit: "512",
			script: `
const event = (text) => JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "toolUse", timestamp: Date.now() } });
process.stdout.write(event("a".repeat(240)) + "\\n" + event("b".repeat(240)), () => process.exit(0));
`,
			task: { ...task(0), cwd: root },
		},
	] as const;

	for (const fixture of cases) {
		process.env["PI_SUBAGENT_CHILD_PROTOCOL_MAX_BYTES"] = fixture.protocolLimit;
		const writer = path.join(root, `${fixture.id}.ts`);
		fs.writeFileSync(writer, `#!/usr/bin/env bun\n${fixture.script}`, { mode: 0o700 });
		process.env["PI_SUBAGENT_PI_BINARY"] = writer;
		const config = singleRunnerConfig(root, fixture.id, {
			asyncDir: path.join(root, fixture.id),
			work: { mode: "single", task: fixture.task },
		});
		await runConfiguredBackground(config);
		const completion = readBackgroundCompletion(config.resultPath);
		expect(completion).toMatchObject({
			state: "complete",
			success: true,
			results: [{ output: "b".repeat(240), success: true }],
		});
	}
});

test("allows ordinary Agents to continue beyond the retired 64-turn budget", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "unbounded-turns.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const events = Array.from({ length: 70 }, (_, index) => ({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "TURN_" + index }],
    stopReason: index === 69 ? "stop" : "toolUse",
    timestamp: Date.now(),
  },
}));
process.stdout.write(events.map(JSON.stringify).join("\\n") + "\\n");
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const config = singleRunnerConfig(root, "unbounded-turns", {
		asyncDir: path.join(root, "unbounded-turns"),
	});

	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(config.resultPath);
	expect(completion).toMatchObject({
		state: "complete",
		success: true,
		results: [{ output: "TURN_69", success: true }],
	});
}, 5_000);

test("terminates a child whose Tool call exceeds its configured timeout", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "tool-timeout.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
  type: "tool_execution_start",
  toolCallId: "call-1",
  toolName: "bash",
  args: { command: "hang" },
}) + "\\n");
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const config = singleRunnerConfig(root, "tool-timeout", {
		asyncDir: path.join(root, "tool-timeout"),
		work: { mode: "single", task: { ...task(0), toolTimeoutMs: 30 } },
	});

	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(config.resultPath);
	expect(completion).toMatchObject({
		state: "failed",
		results: [{ error: "Tool 'bash' exceeded its timeout of 30ms.", timedOut: true }],
	});
}, 5_000);

test("bounds recent status output by UTF-8 bytes without changing the full result", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "large-recent-output.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const text = "BEGIN-" + "界".repeat(40_000) + "-END";
const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() } };
process.stdout.write(JSON.stringify(event) + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const config = singleRunnerConfig(root, "large-recent", {
		asyncDir: path.join(root, "async-large-recent"),
	});
	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(config.resultPath);
	const status = readBackgroundStatus(config.asyncDir);
	const recent = (status.steps?.[0]?.recentOutput ?? []).join("\n");
	expect(Buffer.byteLength(recent, "utf8")).toBeLessThanOrEqual(64 * 1024);
	expect(recent).not.toContain("�");
	expect(completion.results[0]?.output).toStartWith("BEGIN-");
	expect(completion.results[0]?.output).toEndWith("-END");
});

test("fairly bounds multi-Agent result projections while preserving full output artifacts", async () => {
	const root = fixtureRoot();
	process.env["PI_SUBAGENT_TASK_RESULT_MAX_BYTES"] = "1024";
	process.env["PI_SUBAGENT_RUN_RESULT_MAX_BYTES"] = "2048";
	const writer = path.join(root, "bounded-run-results.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const index = process.env.PI_SUBAGENT_CHILD_INDEX ?? "unknown";
const text = "BEGIN-" + index + "-" + "界".repeat(2_000) + "-END-" + index;
const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: Date.now() } };
process.stdout.write(JSON.stringify(event) + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const config = singleRunnerConfig(root, "bounded-run-results", {
		asyncDir: path.join(root, "async-bounded-run-results"),
		work: {
			mode: "parallel",
			group: {
				tasks: Array.from({ length: 4 }, (_, index) => ({ ...task(index), cwd: root })),
				concurrency: 4,
				worktree: false,
			},
		},
	});
	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(config.resultPath);
	const totalBytes = completion.results.reduce((sum, result) => sum + Buffer.byteLength(result.output, "utf8"), 0);
	expect(totalBytes).toBeLessThanOrEqual(2048);
	for (const [index, result] of completion.results.entries()) {
		expect(Buffer.byteLength(result.output, "utf8")).toBeGreaterThan(0);
		expect(result.output).toContain("output truncated");
		expect(result.output).not.toContain("�");
		const fullOutput = fs.readFileSync(path.join(config.asyncDir, `output-${String(index)}.log`), "utf8");
		expect(fullOutput).toStartWith(`BEGIN-${String(index)}-`);
		expect(fullOutput).toEndWith(`-END-${String(index)}`);
		expect(Buffer.byteLength(fullOutput, "utf8")).toBeGreaterThan(Buffer.byteLength(result.output, "utf8"));
	}
}, 5_000);

test("keeps a bounded stderr tail without terminating on an oversized line or aggregate", async () => {
	const root = fixtureRoot();
	process.env["PI_SUBAGENT_CHILD_PROTOCOL_MAX_BYTES"] = "4096";
	const writer = path.join(root, "rolling-stderr.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const event = { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "DONE_AFTER_STDERR" }], stopReason: "stop", timestamp: Date.now() } };
process.stderr.write("ERR-BEGIN-" + "x".repeat(200_000) + "-ERR-END", () => {
  process.stdout.write(JSON.stringify(event) + "\\n", () => process.exit(0));
});
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const config = singleRunnerConfig(root, "rolling-stderr", {
		asyncDir: path.join(root, "rolling-stderr"),
	});

	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(config.resultPath);
	expect(completion).toMatchObject({
		state: "complete",
		success: true,
		results: [{ output: "DONE_AFTER_STDERR", success: true }],
	});
	const transcriptPath = completion.results[0]?.transcriptPath;
	expect(transcriptPath).toBeDefined();
	const transcript = fs.readFileSync(transcriptPath ?? "", "utf8");
	expect(transcript).toContain("earlier stderr bytes omitted");
	expect(transcript).toContain("ERR-END");
});

test("hard-kills a writer that emits an oversized protocol frame", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "protocol-limit-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
process.on("SIGTERM", () => {});
process.stdout.write("x".repeat(17 * 1024 * 1024));
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const config = singleRunnerConfig(root, "protocol-limit-hard-kill", {
		work: { mode: "single", task: task(0) },
	});

	await runConfiguredBackground(config);
	const completion = readBackgroundCompletion(config.resultPath);

	expect(completion).toMatchObject({
		state: "failed",
		success: false,
		results: [
			{
				error: expect.stringContaining("protocol_output_limit"),
				success: false,
				writerProcesses: [{ exitCode: null, signal: "SIGKILL" }],
			},
		],
	});
}, 7_000);
