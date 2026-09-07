import { afterEach, expect, test } from "bun:test";
import { requestAsyncInterrupt } from "../../../packages/pi-stuff/src/subagents/src/runs/background/control-channel.js";
import { SessionAgentGovernor } from "../../../packages/pi-stuff/src/subagents/src/runtime/session-governor.js";
import { SESSION_GOVERNOR_ROOT } from "../../../packages/pi-stuff/src/subagents/src/shared/types.js";
import {
	cleanupBackgroundEngineFixtures,
	createHash,
	fixtureRoot,
	fs,
	path,
	readBackgroundCompletion,
	readBackgroundStatus,
	runConfiguredBackground,
	singleRunnerConfig,
	task,
	waitForFile,
} from "../../agents/background-engine-fixtures.js";

const governorSessionDirectories: string[] = [];

afterEach(() => {
	cleanupBackgroundEngineFixtures();
	for (const directory of governorSessionDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("lets a real child process cross the retired turn and Tool boundaries and finish", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "sustained-child.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
let tool = 0;
for (let turn = 0; turn < 70; turn += 1) {
  const toolsThisTurn = turn < 60 ? 2 : 1;
  for (let offset = 0; offset < toolsThisTurn; offset += 1) {
    const id = "tool-" + String(tool++);
    emit({ type: "tool_execution_start", toolCallId: id, toolName: "read", args: { path: "piece-" + id } });
    emit({ type: "tool_execution_end", toolCallId: id, toolName: "read" });
  }
  emit({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "turn-" + String(turn), name: "read", arguments: { path: "next-" + String(turn) } }],
      stopReason: "toolUse",
      timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    },
  });
}
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "SUSTAINED_WORK_COMPLETE" }],
    stopReason: "stop",
    timestamp: Date.now(),
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  },
}) + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-sustained");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(singleRunnerConfig(root, "sustained", { asyncDir, resultPath }));

	expect(readBackgroundCompletion(resultPath)).toMatchObject({
		state: "complete",
		results: [
			{
				output: "SUSTAINED_WORK_COMPLETE",
				success: true,
				modelAttempts: [{ usage: { turns: 71 } }],
				terminalOutcome: { state: "completed", class: "completed" },
			},
		],
	});
	expect(readBackgroundStatus(asyncDir)).toMatchObject({
		state: "complete",
		steps: [{ status: "complete", turnCount: 71, toolCount: 130 }],
	});
});

function toolBudgetWriter(root: string, name: string, terminal: "success" | "provider-failure"): string {
	const writer = path.join(root, `${name}.ts`);
	const terminalMessage =
		terminal === "success"
			? `{ role: "assistant", content: [{ type: "text", text: "FINAL_SYNTHESIS_AFTER_BUDGET" }], stopReason: "stop", timestamp: Date.now(), usage: { input: 120, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } }`
			: `{ role: "assistant", content: [{ type: "text", text: "BOUNDED_PARTIAL_EVIDENCE" }], errorMessage: "503 Service Unavailable", stopReason: "error", timestamp: Date.now(), usage: { input: 120, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } } }`;
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
emit({ type: "entry_appended", entry: { type: "custom", customType: "pi-stuff-agent-tool-budget", data: { version: 1, outcome: "soft-reached", toolCount: 1, toolName: "read" } } });
emit({ type: "entry_appended", entry: { type: "custom", customType: "pi-stuff-agent-tool-budget", data: { version: 1, outcome: "hard-blocked", toolCount: 2, toolName: "read" } } });
process.stdout.write(JSON.stringify({ type: "message_end", message: ${terminalMessage} }) + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	return writer;
}

test("keeps final synthesis available after a configured Tool hard limit", async () => {
	const root = fixtureRoot();
	process.env["PI_SUBAGENT_PI_BINARY"] = toolBudgetWriter(root, "budget-success", "success");
	const asyncDir = path.join(root, "async-budget-success");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(
		singleRunnerConfig(root, "budget-success", {
			asyncDir,
			resultPath,
			work: {
				mode: "single",
				task: { ...task(0), cwd: root, toolBudget: { soft: 1, hard: 1, block: ["read"] } },
			},
		}),
	);

	expect(readBackgroundCompletion(resultPath)).toMatchObject({
		state: "complete",
		results: [
			{
				output: "FINAL_SYNTHESIS_AFTER_BUDGET",
				success: true,
				toolBudgetBlocked: true,
				toolBudget: { outcome: "hard-blocked", blockedTool: "read", toolCount: 2 },
				terminalOutcome: { state: "completed", class: "completed" },
			},
		],
	});
});

test("returns bounded partial evidence and the real terminal cause when synthesis later fails", async () => {
	const root = fixtureRoot();
	process.env["PI_SUBAGENT_PI_BINARY"] = toolBudgetWriter(root, "budget-failure", "provider-failure");
	const runId = "budget-failure";
	const logicalAgentId = `${runId}:0`;
	const governorSessionId = `${runId}-${path.basename(root)}`;
	const governor = new SessionAgentGovernor({
		rootDir: SESSION_GOVERNOR_ROOT,
		sessionId: governorSessionId,
		pid: process.pid,
	});
	const sessionDirectory = path.join(
		SESSION_GOVERNOR_ROOT,
		createHash("sha256").update(governorSessionId).digest("hex"),
	);
	governorSessionDirectories.push(sessionDirectory);
	const acquired = await governor.acquireSpawn({ logicalAgentId, runtimeRunId: runId, pid: process.pid });
	if (!acquired.ok) throw new Error(acquired.error.message);
	const sessionFile = path.join(root, "retained.jsonl");
	fs.writeFileSync(sessionFile, "RETAINED_SESSION\n", { mode: 0o600 });
	const asyncDir = path.join(root, "async-budget-failure");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(
		singleRunnerConfig(root, runId, {
			asyncDir,
			resultPath,
			work: {
				mode: "single",
				task: {
					...task(0),
					cwd: root,
					governorSessionId,
					logicalAgentPathComponent: logicalAgentId,
					sessionFile,
					toolBudget: { soft: 1, hard: 1, block: ["read"] },
				},
			},
		}),
	);

	const completion = readBackgroundCompletion(resultPath);
	expect(completion).toMatchObject({
		state: "failed",
		results: [
			{
				output: "BOUNDED_PARTIAL_EVIDENCE",
				success: false,
				toolBudgetBlocked: true,
				toolBudget: { outcome: "hard-blocked", blockedTool: "read", toolCount: 2 },
				cumulativeUsage: {
					turns: 1,
					inputTokens: 120,
					outputTokens: 5,
					reportedCostUsd: 0.25,
					modelAttempts: 1,
					resumes: 0,
				},
				terminalOutcome: {
					state: "incomplete",
					class: "provider",
					continuation: { target: { id: runId, index: 0 }, resumeSupported: true },
				},
			},
		],
	});
	expect((completion.results?.[0]?.output ?? "").length).toBeLessThan(1_000);
});

test("accounts a no-cost interrupted attempt and returns its bounded continuation evidence", async () => {
	const root = fixtureRoot();
	const ready = path.join(root, "interrupted-ready");
	const writer = path.join(root, "interrupted-child.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [
      { type: "text", text: "INTERRUPTED_PARTIAL_EVIDENCE" },
      { type: "toolCall", id: "continue-1", name: "read", arguments: { path: "next" } },
    ],
    stopReason: "toolUse",
    timestamp: Date.now(),
    usage: { input: 12, output: 3, cacheRead: 0, cacheWrite: 0 },
  },
}) + "\\n");
fs.writeFileSync(${JSON.stringify(ready)}, "ready");
setInterval(() => {}, 1_000);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const runId = "interrupted-usage";
	const logicalAgentId = `${runId}:0`;
	const governorSessionId = `${runId}-${path.basename(root)}`;
	const governor = new SessionAgentGovernor({
		rootDir: SESSION_GOVERNOR_ROOT,
		sessionId: governorSessionId,
		pid: process.pid,
	});
	governorSessionDirectories.push(
		path.join(SESSION_GOVERNOR_ROOT, createHash("sha256").update(governorSessionId).digest("hex")),
	);
	const acquired = await governor.acquireSpawn({ logicalAgentId, runtimeRunId: runId, pid: process.pid });
	if (!acquired.ok) throw new Error(acquired.error.message);
	const sessionFile = path.join(root, "retained-interrupted.jsonl");
	fs.writeFileSync(sessionFile, "RETAINED_SESSION\n", { mode: 0o600 });
	const asyncDir = path.join(root, "async-interrupted");
	const resultPath = path.join(asyncDir, "result.json");
	const running = runConfiguredBackground(
		singleRunnerConfig(root, runId, {
			asyncDir,
			resultPath,
			work: {
				mode: "single",
				task: {
					...task(0),
					cwd: root,
					governorSessionId,
					logicalAgentPathComponent: logicalAgentId,
					sessionFile,
				},
			},
		}),
	);
	await waitForFile(ready);
	requestAsyncInterrupt(asyncDir, { reason: "test pause" });
	await running;

	const completion = readBackgroundCompletion(resultPath);
	expect(completion).toMatchObject({
		state: "paused",
		results: [
			{
				interrupted: true,
				output: "INTERRUPTED_PARTIAL_EVIDENCE",
				cumulativeUsage: {
					turns: 1,
					toolCalls: 0,
					inputTokens: 12,
					outputTokens: 3,
					modelAttempts: 1,
					resumes: 0,
				},
				terminalOutcome: {
					state: "incomplete",
					class: "interrupted",
					continuation: { target: { id: runId, index: 0 }, resumeSupported: true },
				},
			},
		],
	});
	expect(completion.results?.[0]?.cumulativeUsage).not.toHaveProperty("reportedCostUsd");
});
