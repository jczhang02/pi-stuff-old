import { afterEach, expect, test } from "bun:test";
import {
	requestAsyncStop,
	requestAsyncTimeout,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/control-channel.js";
import {
	DEFAULT_AGENT_WORK_COST_POLICY,
	SessionAgentGovernor,
} from "../../../packages/pi-stuff/src/subagents/src/runtime/session-governor.js";
import { SESSION_GOVERNOR_ROOT } from "../../../packages/pi-stuff/src/subagents/src/shared/types.js";
import {
	cleanupBackgroundEngineFixtures,
	createHash,
	fallbackSessionKeyForTest,
	fallbackShardForTest,
	fixtureRoot,
	fs,
	PROCESS_TERMINAL_CANDIDATE_SCHEMA,
	path,
	pathToFileURL,
	readBackgroundCompletion,
	readBackgroundStatus,
	readFixtureJson,
	runConfiguredBackground,
	shardedDurableClaimName,
	singleRunnerConfig,
	spawn,
	task,
	tryAcquireKernelClaim,
	waitForFile,
} from "../../agents/background-engine-fixtures.js";

const governorSessionDirectories: string[] = [];

afterEach(() => {
	cleanupBackgroundEngineFixtures();
	for (const directory of governorSessionDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("reconciles reported usage before refusing an automatic model fallback", async () => {
	const root = fixtureRoot();
	const secondAttempt = path.join(root, "second-attempt");
	const writer = path.join(root, "cost-guard.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const model = Bun.argv[Bun.argv.indexOf("--model") + 1] ?? "";
if (model.endsWith("model-b")) await Bun.write(${JSON.stringify(secondAttempt)}, "started");
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: model.endsWith("model-a") ? [] : [{ type: "text", text: "UNEXPECTED_FALLBACK" }],
    errorMessage: model.endsWith("model-a") ? "503 Service Unavailable" : undefined,
    stopReason: model.endsWith("model-a") ? "error" : "stop",
    timestamp: Date.now(),
    usage: {
      input: ${String(DEFAULT_AGENT_WORK_COST_POLICY.reportedTokenLimit)},
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 1 },
    },
  },
}) + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const governorSessionId = `fallback-cost-${path.basename(root)}`;
	const logicalAgentId = "cost-guard-run:0";
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
	const acquired = await governor.acquireSpawn({ logicalAgentId, runtimeRunId: "cost-guard-run", pid: process.pid });
	if (!acquired.ok) throw new Error(acquired.error.message);
	const asyncDir = path.join(root, "async-cost-guard");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(
		singleRunnerConfig(root, "cost-guard-run", {
			asyncDir,
			resultPath,
			work: {
				mode: "single",
				task: {
					...task(0),
					cwd: root,
					governorSessionId,
					logicalAgentPathComponent: logicalAgentId,
					modelCandidates: ["test/model-a", "test/model-b"],
				},
			},
		}),
	);

	expect(readBackgroundCompletion(resultPath)).toMatchObject({
		state: "failed",
		results: [
			{
				success: false,
				error: expect.stringContaining("Automatic Agent expansion needs attention"),
				modelAttempts: [{ model: "test/model-a", success: false, costReported: true }],
			},
		],
	});
	expect(fs.existsSync(secondAttempt)).toBeFalse();
	expect((await governor.workUnit(logicalAgentId)).usage).toMatchObject({
		inputTokens: DEFAULT_AGENT_WORK_COST_POLICY.reportedTokenLimit,
		reportedCostUsd: 1,
		modelAttempts: 1,
	});
}, 5_000);

test("restores a frozen fork before retrying a larger model", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "clean-fallback-session.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
const args = Bun.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const session = valueAfter("--session");
const model = valueAfter("--model") ?? "";
if (!session) throw new Error("missing session");
const before = fs.readFileSync(session, "utf8");
if (model.endsWith("model-a")) {
  fs.appendFileSync(session, "PRIMARY_ATTEMPT_POLLUTION\\n");
  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      errorMessage: "final child payload is above the safe input bound",
      stopReason: "error",
      timestamp: Date.now(),
    },
  }) + "\\n", () => process.exit(0));
} else if (before.includes("PRIMARY_ATTEMPT_POLLUTION")) {
  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      errorMessage: "fallback inherited a polluted fork session",
      stopReason: "error",
      timestamp: Date.now(),
    },
  }) + "\\n", () => process.exit(0));
} else {
  fs.appendFileSync(session, "FALLBACK_SUCCESS\\n");
  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "CLEAN_FALLBACK" }],
      stopReason: "stop",
      timestamp: Date.now(),
    },
  }) + "\\n", () => process.exit(0));
}
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const sessionFile = path.join(root, "fork.jsonl");
	fs.writeFileSync(sessionFile, "BASE_SESSION\n", { mode: 0o600 });
	const asyncDir = path.join(root, "async-clean-fallback");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(
		singleRunnerConfig(root, "clean-fallback", {
			asyncDir,
			resultPath,
			work: {
				mode: "single",
				task: {
					...task(0),
					cwd: root,
					sessionFile,
					modelCandidates: ["test/model-a", "test/model-b"],
				},
			},
		}),
	);

	const completion = readBackgroundCompletion(resultPath);
	expect(completion).toMatchObject({
		state: "complete",
		results: [
			{
				output: "CLEAN_FALLBACK",
				modelAttempts: [
					{ model: "test/model-a", success: false },
					{ model: "test/model-b", success: true },
				],
			},
		],
	});
	const finalSession = fs.readFileSync(sessionFile, "utf8");
	expect(finalSession).toContain("BASE_SESSION");
	expect(finalSession).toContain("FALLBACK_SUCCESS");
	expect(finalSession).not.toContain("PRIMARY_ATTEMPT_POLLUTION");
}, 5_000);

function parallelFallbackWriter(readyDirectory: string): string {
	return `#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
const args = Bun.argv.slice(2);
const valueAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const session = valueAfter("--session");
const model = valueAfter("--model") ?? "";
if (!session) throw new Error("missing session");
const sessionName = path.basename(session);
const emit = (message) => process.stdout.write(JSON.stringify({
  type: "message_end",
  message: { role: "assistant", timestamp: Date.now(), ...message },
}) + "\\n", () => process.exit(0));
if (model.endsWith("model-a")) {
  fs.appendFileSync(session, "PRIMARY_ATTEMPT_POLLUTION\\n");
  fs.writeFileSync(path.join(${JSON.stringify(readyDirectory)}, sessionName + ".ready"), "ready");
  const deadline = Date.now() + 2_000;
  while (fs.readdirSync(${JSON.stringify(readyDirectory)}).filter((name) => name.endsWith(".ready")).length < 2) {
    if (Date.now() >= deadline) {
      emit({ content: [], errorMessage: "parallel fallback rendezvous timed out", stopReason: "error" });
      await new Promise(() => {});
    }
    await Bun.sleep(10);
  }
  emit({ content: [], errorMessage: "503 Service Unavailable", stopReason: "error" });
} else {
  const before = fs.readFileSync(session, "utf8");
  if (before.includes("PRIMARY_ATTEMPT_POLLUTION")) {
    emit({ content: [], errorMessage: "fallback inherited a polluted fork session", stopReason: "error" });
  } else {
    fs.appendFileSync(session, "FALLBACK_SUCCESS\\n");
    emit({ content: [{ type: "text", text: "CLEAN_" + sessionName }], stopReason: "stop" });
  }
}
`;
}

test("restores different fallback sessions concurrently without a shared lock", async () => {
	const root = fixtureRoot();
	const readyDirectory = path.join(root, "parallel-fallback-ready");
	fs.mkdirSync(readyDirectory, { mode: 0o700 });
	const writer = path.join(root, "parallel-fallback-session.ts");
	fs.writeFileSync(writer, parallelFallbackWriter(readyDirectory), { mode: 0o700 });
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const sessionByOldLifecycleShard = new Map<number, string>();
	const sessionFiles: string[] = [];
	for (let index = 0; index < 10_000 && sessionFiles.length === 0; index += 1) {
		const candidate = path.join(root, `fork-${index}.jsonl`);
		const shard = fallbackShardForTest(candidate);
		const collision = sessionByOldLifecycleShard.get(shard);
		if (collision) sessionFiles.push(collision, candidate);
		else sessionByOldLifecycleShard.set(shard, candidate);
	}
	expect(sessionFiles).toHaveLength(2);
	expect(fallbackShardForTest(sessionFiles[0] ?? "")).toBe(fallbackShardForTest(sessionFiles[1] ?? ""));
	for (const sessionFile of sessionFiles) fs.writeFileSync(sessionFile, "BASE_SESSION\n", { mode: 0o600 });
	const restoreDirectory = path.join(root, ".pi-stuff-fallback-restores");
	fs.mkdirSync(restoreDirectory, { mode: 0o700 });
	for (let index = 0; index < 300; index += 1) {
		fs.writeFileSync(path.join(restoreDirectory, `unrelated-${String(index).padStart(3, "0")}`), "retained");
	}
	const priorRestorePaths = sessionFiles.map((sessionFile) => {
		const key = fallbackSessionKeyForTest(sessionFile);
		const prior = path.join(restoreDirectory, `restore-${key}.tmp`);
		fs.writeFileSync(prior, "CRASH_LEFT_PARTIAL_RESTORE", { mode: 0o600 });
		return prior;
	});
	const asyncDir = path.join(root, "async-parallel-fallback");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(
		singleRunnerConfig(root, "parallel-fallback", {
			asyncDir,
			resultPath,
			work: {
				mode: "parallel",
				group: {
					tasks: sessionFiles.map((sessionFile, index) => ({
						...task(index),
						cwd: root,
						sessionFile,
						modelCandidates: ["test/model-a", "test/model-b"],
					})),
					concurrency: 2,
					worktree: false,
				},
			},
		}),
	);

	const completion = readBackgroundCompletion(resultPath);
	expect(completion.state).toBe("complete");
	expect(completion.results).toHaveLength(2);
	for (const result of completion.results) {
		expect(result).toMatchObject({
			success: true,
			modelAttempts: [
				{ model: "test/model-a", success: false },
				{ model: "test/model-b", success: true },
			],
		});
	}
	expect(fs.readdirSync(readyDirectory).filter((name) => name.endsWith(".ready"))).toHaveLength(2);
	for (const sessionFile of sessionFiles) {
		const session = fs.readFileSync(sessionFile, "utf8");
		expect(session).toContain("BASE_SESSION");
		expect(session).toContain("FALLBACK_SUCCESS");
		expect(session).not.toContain("PRIMARY_ATTEMPT_POLLUTION");
	}
	expect(fs.existsSync(path.join(restoreDirectory, "restore.lock"))).toBeFalse();
	expect(priorRestorePaths.every((prior) => !fs.existsSync(prior))).toBeTrue();
	expect(fs.readdirSync(restoreDirectory).filter((name) => name.startsWith("unrelated-"))).toHaveLength(300);
}, 8_000);

test("rejects a concurrent fallback owner through a parent-directory alias", async () => {
	if (process.platform === "win32") return;
	const root = fixtureRoot();
	const alias = path.join(root, "root-alias");
	fs.symlinkSync(root, alias, "dir");
	const sessionFile = path.join(root, "shared-fork.jsonl");
	fs.writeFileSync(sessionFile, "BASE_SESSION\n", { mode: 0o600 });
	const writer = path.join(root, "holding-success.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
setTimeout(() => process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "HELD_SESSION_SUCCESS" }],
    stopReason: "stop",
    timestamp: Date.now(),
  },
}) + "\\n", () => process.exit(0)), 1_200);
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-same-session");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(
		singleRunnerConfig(root, "same-session", {
			asyncDir,
			resultPath,
			work: {
				mode: "parallel",
				group: {
					tasks: [sessionFile, path.join(alias, path.basename(sessionFile))].map((aliasedSession, index) => ({
						...task(index),
						cwd: root,
						sessionFile: aliasedSession,
						modelCandidates: ["test/model-a", "test/model-b"],
					})),
					concurrency: 2,
					worktree: false,
				},
			},
		}),
	);

	const completion = readBackgroundCompletion(resultPath);
	expect(completion.state).toBe("failed");
	expect(completion.results.filter((result) => result.success)).toHaveLength(1);
	expect(completion.results.filter((result) => result.output === "HELD_SESSION_SUCCESS")).toHaveLength(1);
	expect(completion.results.filter((result) => result.error?.includes("already owned"))).toHaveLength(1);
}, 6_000);

test("advances fallback orphan cleanup across pages without deleting an active copy", async () => {
	const root = fixtureRoot();
	const restoreDirectory = path.join(root, ".pi-stuff-fallback-restores");
	fs.mkdirSync(restoreDirectory, { mode: 0o700 });
	const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1_000);
	const oldPaths: string[] = [];
	for (let index = 0; index < 130; index += 1) {
		const key = createHash("sha256").update(`orphan-${index}`).digest("hex");
		const candidate = path.join(restoreDirectory, `restore-${key}.tmp`);
		fs.writeFileSync(candidate, `PRIVATE_ORPHAN_${index}`, { mode: 0o600 });
		fs.utimesSync(candidate, oldDate, oldDate);
		oldPaths.push(candidate);
	}
	const activeKey = createHash("sha256").update("active-orphan").digest("hex");
	const activePath = path.join(restoreDirectory, `restore-${activeKey}.tmp`);
	fs.writeFileSync(activePath, "PRIVATE_ACTIVE_COPY", { mode: 0o600 });
	fs.utimesSync(activePath, oldDate, oldDate);
	const recentKey = createHash("sha256").update("recent-orphan").digest("hex");
	const recentPath = path.join(restoreDirectory, `restore-${recentKey}.tmp`);
	fs.writeFileSync(recentPath, "PRIVATE_RECENT_COPY", { mode: 0o600 });
	const activeClaim = tryAcquireKernelClaim(
		restoreDirectory,
		shardedDurableClaimName("fallback-restore", activeKey, 4_096),
	);
	if (!activeClaim) throw new Error("Failed to establish active fallback-copy fixture claim.");

	const writer = path.join(root, "immediate-success.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
process.stdout.write(JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "SWEEP_TRIGGERED" }],
    stopReason: "stop",
    timestamp: Date.now(),
  },
}) + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const runSweep = async (index: number): Promise<void> => {
		const sessionFile = path.join(root, `sweep-${index}.jsonl`);
		fs.writeFileSync(sessionFile, "BASE_SESSION\n", { mode: 0o600 });
		const asyncDir = path.join(root, `async-sweep-${index}`);
		await runConfiguredBackground(
			singleRunnerConfig(root, `sweep-${index}`, {
				asyncDir,
				work: {
					mode: "single",
					task: {
						...task(index),
						cwd: root,
						sessionFile,
						modelCandidates: ["test/model-a", "test/model-b"],
					},
				},
			}),
		);
	};

	try {
		await runSweep(0);
		await runSweep(1);
		await runSweep(2);
		expect(fs.existsSync(activePath)).toBeTrue();
		expect(fs.existsSync(recentPath)).toBeTrue();
		expect(oldPaths.some((candidate) => fs.existsSync(candidate))).toBeFalse();
	} finally {
		activeClaim.release();
	}
	await runSweep(3);
	expect(fs.existsSync(activePath)).toBeFalse();
	expect(fs.existsSync(recentPath)).toBeTrue();
}, 8_000);

test("keeps a real runner fallback session anonymous across SIGKILL", async () => {
	if (process.platform !== "linux") return;
	const root = fixtureRoot();
	const isolatedTemp = path.join(root, "isolated-tmp");
	fs.mkdirSync(isolatedTemp, { mode: 0o700 });
	const sessionFile = path.join(root, "fork-for-crash.jsonl");
	fs.writeFileSync(sessionFile, "PRIVATE_SESSION_COPY\n", { mode: 0o600 });
	const writerReady = path.join(root, "writer-ready.txt");
	const writer = path.join(root, "holding-writer.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
fs.writeFileSync(${JSON.stringify(writerReady)}, String(process.pid));
setTimeout(() => process.exit(0), 2_000);
`,
		{ mode: 0o700 },
	);
	const moduleUrl = pathToFileURL(
		path.resolve("packages/pi-stuff/src/subagents/src/runs/background/subagent-runner.ts"),
	).href;
	const asyncDir = path.join(root, "async-fallback-crash");
	const config = singleRunnerConfig(root, "fallback-crash", {
		asyncDir,
		work: {
			mode: "single",
			task: {
				...task(0),
				cwd: root,
				sessionFile,
				modelCandidates: ["test/model-a", "test/model-b"],
			},
		},
	});
	const script = `
const { runConfiguredBackground } = await import(${JSON.stringify(moduleUrl)});
await runConfiguredBackground(${JSON.stringify(config)});
`;
	const child = spawn(process.execPath, ["-e", script], {
		env: {
			...process.env,
			PI_SUBAGENT_PI_BINARY: writer,
			TMPDIR: isolatedTemp,
			TMP: isolatedTemp,
			TEMP: isolatedTemp,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const childClosed = new Promise<void>((resolveClose) => child.once("close", () => resolveClose()));
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_192);
	});
	try {
		await waitForFile(writerReady);
		const fallbackEntries = (): string[] => {
			const found: string[] = [];
			const pending = [isolatedTemp];
			while (pending.length > 0) {
				const directory = pending.pop();
				if (!directory) break;
				for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
					const candidate = path.join(directory, entry.name);
					if (entry.isDirectory()) pending.push(candidate);
					if (entry.name.startsWith("pi-subagent-fallback-") || entry.name.startsWith("snapshot-")) {
						found.push(path.relative(isolatedTemp, candidate));
					}
				}
			}
			return found;
		};
		expect(fallbackEntries()).toEqual([]);
		child.kill("SIGKILL");
		await childClosed;
		expect(fallbackEntries()).toEqual([]);
	} finally {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
		await childClosed;
		if (fs.existsSync(writerReady)) {
			const writerPid = Number(fs.readFileSync(writerReady, "utf8"));
			if (Number.isSafeInteger(writerPid) && writerPid > 0) {
				try {
					process.kill(writerPid, "SIGKILL");
				} catch {}
			}
		}
	}
}, 5_000);

test("does not retry the whole task after a child has begun Tool execution", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "no-fallback-after-tool.ts");
	const attemptsPath = path.join(root, "model-attempts.txt");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import * as fs from "node:fs";
const args = Bun.argv.slice(2);
const modelIndex = args.indexOf("--model");
const model = modelIndex >= 0 ? args[modelIndex + 1] ?? "default" : "default";
fs.appendFileSync(${JSON.stringify(attemptsPath)}, model + "\\n");
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
if (model.endsWith("model-a")) {
  emit({ type: "tool_execution_start", toolName: "write", args: { path: "changed.txt" } });
  emit({ type: "tool_execution_end", toolName: "write" });
  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      errorMessage: "network error after a mutating Tool",
      stopReason: "error",
      timestamp: Date.now(),
    },
  }) + "\\n", () => process.exit(0));
} else {
  process.stdout.write(JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "UNSAFE_SECOND_ATTEMPT" }],
      stopReason: "stop",
      timestamp: Date.now(),
    },
  }) + "\\n", () => process.exit(0));
}
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-no-fallback-after-tool");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(
		singleRunnerConfig(root, "no-fallback-after-tool", {
			asyncDir,
			resultPath,
			work: {
				mode: "single",
				task: {
					...task(0),
					cwd: root,
					modelCandidates: ["test/model-a", "test/model-b"],
				},
			},
		}),
	);

	const completion = readBackgroundCompletion(resultPath);
	expect(completion).toMatchObject({
		state: "failed",
		results: [
			{
				modelAttempts: [{ model: "test/model-a", success: false }],
			},
		],
	});
	expect(readBackgroundStatus(asyncDir)).toMatchObject({
		steps: [{ toolCount: 1 }],
	});
	expect(fs.readFileSync(attemptsPath, "utf8").trim().split("\n")).toEqual(["test/model-a"]);
}, 5_000);

test("preserves prior writer proof when fallback persistence and the next launch fail", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "retryable-provider-error.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
const event = {
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text: "FIRST_ATTEMPT_REACHED_PROVIDER" }],
    errorMessage: "503 Service Unavailable",
    stopReason: "error",
    timestamp: Date.now(),
  },
};
process.stdout.write(JSON.stringify(event) + "\\n", () => process.exit(0));
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-retry-proof");
	const resultPath = path.join(asyncDir, "result.json");
	const statusPath = path.join(asyncDir, "status.json");
	const statusBackup = path.join(asyncDir, "status.backup.json");
	let spawning = 0;

	await runConfiguredBackground(
		singleRunnerConfig(root, "retry-proof", {
			asyncDir,
			resultPath,
			runnerProcessInstanceId: "runner-proof",
			work: {
				mode: "single",
				task: {
					...task(0),
					cwd: root,
					modelCandidates: ["test/model-a", "test/model-b"],
				},
			},
		}),
		{
			afterWriterProcessUpdate: (_index, writerState) => {
				if (writerState.state === "spawning") {
					spawning += 1;
					if (spawning === 2) {
						fs.rmSync(statusPath, { recursive: true, force: true });
						fs.renameSync(statusBackup, statusPath);
						throw new Error("injected second launch failure");
					}
				} else if (writerState.state === "none" && spawning === 1 && fs.existsSync(statusPath)) {
					fs.renameSync(statusPath, statusBackup);
					fs.mkdirSync(statusPath);
				}
			},
		},
	);
	const completion = readBackgroundCompletion(resultPath);
	const candidate = readFixtureJson(
		path.join(asyncDir, "process-terminal-candidate.json"),
		PROCESS_TERMINAL_CANDIDATE_SCHEMA,
	);

	expect(completion).toMatchObject({
		state: "failed",
		results: [
			{
				writerAttemptCount: 1,
				modelAttempts: [
					{ model: "test/model-a", error: "503 Service Unavailable" },
					{ model: "test/model-b", error: "injected second launch failure" },
				],
			},
		],
	});
	expect(completion.results[0]?.writerProcesses).toHaveLength(1);
	expect(candidate.expectedWriters?.["0"]).toBe(1);
	expect(candidate.writers?.["0"]).toHaveLength(1);
}, 5_000);

for (const cause of ["pause", "stop", "timeout"] as const) {
	test(`prevents useful fallback work after a run-wide ${cause} between attempts`, async () => {
		const root = fixtureRoot();
		const fallbackMarker = path.join(root, "fallback-ran");
		const writer = path.join(root, "between-fallback-attempts.ts");
		fs.writeFileSync(
			writer,
			`#!/usr/bin/env bun
import * as fs from "node:fs";
const model = Bun.argv[Bun.argv.indexOf("--model") + 1] ?? "";
const fallback = model.endsWith("model-b");
if (fallback) {
  await Bun.sleep(1000);
  fs.writeFileSync(${JSON.stringify(fallbackMarker)}, "ran");
}
process.stdout.write(JSON.stringify({ type: "message_end", message: {
  role: "assistant", content: [{ type: "text", text: fallback ? "UNEXPECTED_FALLBACK" : "FIRST_ATTEMPT" }],
  errorMessage: fallback ? undefined : "503 Service Unavailable", stopReason: fallback ? "stop" : "error"
} }) + "\\n");
`,
			{ mode: 0o700 },
		);
		process.env["PI_SUBAGENT_PI_BINARY"] = writer;
		const asyncDir = path.join(root, "async-between-fallback");
		const resultPath = path.join(asyncDir, "result.json");
		let firstAttemptClosed = false;
		await runConfiguredBackground(
			singleRunnerConfig(root, "between-fallback", {
				asyncDir,
				resultPath,
				work: {
					mode: "single",
					task: { ...task(0), cwd: root, modelCandidates: ["test/model-a", "test/model-b"] },
				},
			}),
			{
				afterWriterProcessUpdate: (_index, state) => {
					if (state.state !== "none" || firstAttemptClosed) return;
					firstAttemptClosed = true;
					if (cause === "pause") process.emit("SIGUSR2");
					else if (cause === "stop") requestAsyncStop(asyncDir, { source: "fallback-test" });
					else requestAsyncTimeout(asyncDir, { source: "fallback-test" });
				},
			},
		);
		const completion = readBackgroundCompletion(resultPath);
		expect(firstAttemptClosed).toBe(true);
		expect(completion).toMatchObject({
			state: cause === "pause" ? "paused" : cause === "stop" ? "stopped" : "failed",
			results: [
				{ success: false, [cause === "pause" ? "interrupted" : cause === "stop" ? "stopped" : "timedOut"]: true },
			],
		});
		if (cause === "pause") expect(completion.results[0]?.writerAttemptCount).toBe(1);
		expect(fs.existsSync(fallbackMarker)).toBe(false);
	}, 5000);
}
