import { afterEach, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
	ASYNC_DIR,
	buildWriterSpawnCommand,
	CHILD_MODEL_CONTEXT_ENTRY_TYPE,
	captureWriterProcessStartIdentity,
	cleanupBackgroundEngineFixtures,
	createBackgroundCompletion,
	createNestedRoute,
	fixtureRoot,
	fs,
	path,
	pathToFileURL,
	projectForegroundCompletion,
	randomUUID,
	readBackgroundCompletion,
	readBackgroundStatus,
	requestAsyncSteer,
	requestAsyncStop,
	resolveAsyncRunnerBunCommand,
	resolveBunRuntimeCommand,
	runBackgroundWork,
	runConfiguredBackground,
	singleRunnerConfig,
	spawn,
	task,
	temporaryDirectories,
	waitForCondition,
	waitForFile,
	waitForFileText,
	writeNestedEvent,
} from "../../agents/background-engine-fixtures.js";

afterEach(cleanupBackgroundEngineFixtures);

test("keeps the Host event loop responsive while concurrent writer identities become readable", async () => {
	let heartbeat = 0;
	const timer = setInterval(() => {
		heartbeat += 1;
	}, 1);
	try {
		const identities = await Effect.runPromise(
			Effect.all(
				Array.from({ length: 20 }, (_, index) => {
					let attempts = 0;
					return captureWriterProcessStartIdentity(process.pid, {
						intervalMs: 5,
						read: () => {
							attempts += 1;
							return attempts >= 3 ? `writer-${String(index)}` : undefined;
						},
						timeoutMs: 100,
					});
				}),
				{ concurrency: "unbounded" },
			),
		);
		expect(identities).toEqual(Array.from({ length: 20 }, (_, index) => `writer-${String(index)}`));
		expect(heartbeat).toBeGreaterThan(0);
	} finally {
		clearInterval(timer);
	}
});

test("retires its top-level nested route after terminal state is durable", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "route-retirement-writer.sh");
	fs.writeFileSync(
		writer,
		`#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"ROUTE_RETIRED"}],"stopReason":"stop"}}'
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const id = `route-retire-${randomUUID()}`;
	const nestedRoute = createNestedRoute(id);
	const routeRoot = path.dirname(nestedRoute.eventSink);
	const asyncDir = path.join(ASYNC_DIR, id);
	temporaryDirectories.push(asyncDir);
	const resultPath = path.join(asyncDir, "result.json");
	writeNestedEvent(nestedRoute, {
		type: "subagent.nested.completed",
		ts: 2,
		parentRunId: id,
		parentStepIndex: 0,
		child: {
			id: `${id}-child`,
			parentRunId: id,
			parentStepIndex: 0,
			parentRunOrigin: "user",
			depth: 1,
			path: [{ runId: id, stepIndex: 0 }],
			state: "complete",
			startedAt: 1,
			endedAt: 2,
			lastUpdate: 2,
		},
	});

	await runConfiguredBackground(
		singleRunnerConfig(root, id, {
			asyncDir,
			resultPath,
			nestedRoute,
		}),
	);

	expect(readBackgroundCompletion(resultPath)).toMatchObject({
		parentRunOrigin: "user",
		state: "complete",
		results: [{ output: "ROUTE_RETIRED" }],
		nestedChildren: [{ id: `${id}-child`, parentRunOrigin: "user" }],
	});
	expect(readBackgroundStatus(asyncDir)).toMatchObject({
		parentRunOrigin: "user",
		steps: [{ children: [{ id: `${id}-child`, parentRunOrigin: "user" }] }],
	});
	expect(fs.existsSync(routeRoot)).toBe(false);
});

test("tracks active Provider context against the actual child Host model window", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "context-usage-writer.ts");
	fs.writeFileSync(
		writer,
		[
			"#!/usr/bin/env bun",
			'const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + "\\n");',
			`emit({ type: "entry_appended", entry: { type: "custom", customType: ${JSON.stringify(CHILD_MODEL_CONTEXT_ENTRY_TYPE)}, data: { version: 1, provider: "provider", model: "context-model", contextWindow: 100000 } } });`,
			'emit({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "sample" } }], stopReason: "toolUse", usage: { input: 19000, output: 1000, cacheRead: 0, cacheWrite: 0, totalTokens: 20000 } } });',
			"await Bun.sleep(300);",
			'emit({ type: "tool_result_end", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false, content: [{ type: "text", text: "observed output" }] } });',
			"await Bun.sleep(300);",
			'emit({ type: "compaction_start" });',
			"await Bun.sleep(300);",
			'emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "CONTEXT_OK" }], stopReason: "stop", usage: { input: 24500, output: 500, cacheRead: 0, cacheWrite: 0, totalTokens: 25000 } } });',
		].join("\n"),
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-context-usage");
	const resultPath = path.join(asyncDir, "result.json");
	const statusPath = path.join(asyncDir, "status.json");
	const readContextUsage = (): { tokens: number; contextWindow: number } | undefined => {
		if (!fs.existsSync(statusPath)) return undefined;
		return readBackgroundStatus(asyncDir).steps?.[0]?.contextUsage;
	};

	const config = singleRunnerConfig(root, "context-usage", {
		asyncDir,
		resultPath,
		work: {
			mode: "single",
			task: {
				...task(0),
				cwd: root,
				model: "provider/context-model",
				modelContextWindows: [{ model: "provider/context-model", contextWindow: 50_000 }],
			},
		},
	});
	const running = runConfiguredBackground(config);

	await waitForCondition(() => readContextUsage()?.tokens === 20_000, "first Provider usage");
	await waitForCondition(() => {
		const tokens = readContextUsage()?.tokens;
		return tokens !== undefined && tokens > 20_000 && tokens < 25_000;
	}, "estimated trailing Tool result usage");
	await waitForCondition(() => readContextUsage() === undefined, "compaction context reset");
	await running;

	const status = readBackgroundStatus(asyncDir);
	const result = readBackgroundCompletion(resultPath);
	expect(status.steps?.[0]?.contextUsage).toEqual({ tokens: 25_000, contextWindow: 100_000 });
	expect(result.results[0]).toMatchObject({
		output: "CONTEXT_OK",
		contextUsage: { tokens: 25_000, contextWindow: 100_000 },
	});
	expect(projectForegroundCompletion(config, result).details.results[0]).toMatchObject({
		contextUsage: { tokens: 25_000, contextWindow: 100_000 },
	});
}, 10_000);

test("resolves the writer supervisor through Bun without requiring node on PATH", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "node-less-writer.sh");
	fs.writeFileSync(
		writer,
		`#!/bin/sh
printf '%s\\n' '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"NODELESS_OK"}],"stopReason":"stop"}}'
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const originalPath = process.env["PATH"];
	process.env["PATH"] = root;
	try {
		const runtime = resolveBunRuntimeCommand({
			execPath: process.execPath,
			env: { PATH: root },
		});
		expect(runtime).toBe(process.execPath);
		expect(buildWriterSpawnCommand("pi", [], process.platform, undefined, undefined, runtime).command).toBe(
			process.execPath,
		);
		if (process.platform !== "win32") {
			expect(() => buildWriterSpawnCommand("pi", [], process.platform, undefined, undefined, "")).toThrow(
				"Bun is required",
			);
		}
		const asyncDir = path.join(root, "async-node-less");
		const resultPath = path.join(asyncDir, "result.json");
		await runConfiguredBackground(singleRunnerConfig(root, "node-less-writer-supervisor", { asyncDir, resultPath }));
		expect(readBackgroundCompletion(resultPath)).toMatchObject({
			state: "complete",
			success: true,
			results: [{ output: "NODELESS_OK", success: true }],
		});
	} finally {
		if (originalPath === undefined) delete process.env["PATH"];
		else process.env["PATH"] = originalPath;
	}
}, 10_000);

test("drains a fast writer's backpressured asynchronous stdout before the supervisor exits", async () => {
	const root = fixtureRoot();
	const writer = path.join(root, "backpressured-writer.ts");
	const tail = "BACKPRESSURE_TAIL_PRESERVED";
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import { once } from "node:events";
const text = "x".repeat(192 * 1024) + ${JSON.stringify(tail)};
const line = JSON.stringify({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
}) + "\\n";
for (let offset = 0; offset < line.length; offset += 4096) {
  if (!process.stdout.write(line.slice(offset, offset + 4096))) await once(process.stdout, "drain");
  await Bun.sleep(0);
}
`,
		{ mode: 0o700 },
	);
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	const asyncDir = path.join(root, "async-backpressured-output");
	const resultPath = path.join(asyncDir, "result.json");

	await runConfiguredBackground(singleRunnerConfig(root, "backpressured-output", { asyncDir, resultPath }));

	const result = readBackgroundCompletion(resultPath);
	expect(result.state).toBe("complete");
	expect(result.results[0]?.success).toBeTrue();
	expect(result.results[0]?.output?.endsWith(tail)).toBeTrue();
}, 10_000);

test("forwards beyond the retired aggregate transport threshold without a regular-file spool", async () => {
	if (process.platform === "win32") return;
	const root = fixtureRoot();
	const writer = path.join(root, "unbounded-spool-probe.ts");
	fs.writeFileSync(
		writer,
		`#!/usr/bin/env bun
import { once } from "node:events";
const chunk = Buffer.concat([Buffer.alloc(1024 * 1024 - 1, 120), Buffer.from("\\n")]);
for (let index = 0; index < 2; index++) {
  if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
}
`,
		{ mode: 0o700 },
	);
	const dispositionPath = path.join(root, "supervisor-disposition.json");
	const groupMemberProofPath = path.join(root, "supervisor-group-member.json");
	const controlPath = path.join(root, "supervisor-control.jsonl");
	const controlToken = randomUUID();
	fs.writeFileSync(
		controlPath,
		`${JSON.stringify({ version: 1, token: controlToken, sequence: 1, command: "proceed" })}\n`,
		{ mode: 0o600 },
	);
	const command = buildWriterSpawnCommand(
		writer,
		[],
		process.platform,
		dispositionPath,
		groupMemberProofPath,
		undefined,
		{ path: controlPath, token: controlToken },
	);
	const supervisor = spawn(command.command, command.args, {
		cwd: root,
		detached: true,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, PI_SUBAGENT_CHILD_PROTOCOL_MAX_BYTES: "65536" },
	});
	let stdoutBytes = 0;
	let stderr = "";
	let maxSpoolBytes = 0;
	supervisor.stdout?.on("data", (chunk: Buffer) => {
		stdoutBytes += chunk.length;
	});
	supervisor.stderr?.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_192);
	});
	const sampleSpools = () => {
		for (const entry of fs.readdirSync(root)) {
			if (!entry.endsWith(".spool")) continue;
			maxSpoolBytes = Math.max(maxSpoolBytes, fs.statSync(path.join(root, entry)).size);
		}
	};
	const monitor = setInterval(sampleSpools, 2);
	try {
		supervisor.stdin?.end();
		const closed = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
			supervisor.once("error", reject);
			supervisor.once("close", (code, signal) => resolve({ code, signal }));
		});
		sampleSpools();
		expect(closed.signal).toBeNull();
		expect(closed.code).toBe(0);
		expect(stdoutBytes).toBe(2 * 1024 * 1024);
		expect(maxSpoolBytes).toBe(0);
		expect(fs.readdirSync(root).some((entry) => entry.endsWith(".spool"))).toBe(false);
	} catch (error) {
		throw new Error(`Writer transport probe failed (${stderr || "no supervisor stderr"}).`, { cause: error });
	} finally {
		clearInterval(monitor);
		if (supervisor.pid) {
			try {
				process.kill(-supervisor.pid, "SIGKILL");
			} catch {}
		}
	}
}, 8_000);

test("loads the detached runner import graph with the certified Bun command", () => {
	const bunCommand = resolveAsyncRunnerBunCommand();
	expect(bunCommand).toBeString();
	if (!bunCommand) throw new Error("Expected a certified Bun command");
	const runnerUrl = pathToFileURL(
		path.resolve(import.meta.dir, "../../../packages/pi-stuff/src/subagents/src/runs/background/subagent-runner.ts"),
	).href;
	const result = Bun.spawnSync([bunCommand, "--eval", `await import(${JSON.stringify(runnerUrl)})`], {
		cwd: path.resolve(import.meta.dir, "../../.."),
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(result.exitCode, result.stderr.toString()).toBe(0);
});

test("honors group concurrency and produces direct parallel children", async () => {
	let active = 0;
	let peak = 0;
	const work = {
		mode: "parallel" as const,
		group: { tasks: [task(0), task(1), task(2)], concurrency: 2, worktree: false },
	};
	const results = await runBackgroundWork(work, async (child, index) => {
		active++;
		peak = Math.max(peak, active);
		await Bun.sleep(5);
		active--;
		return { agent: child.agent, output: `done-${index}`, success: true, exitCode: 0 };
	});
	expect(peak).toBe(2);
	expect(results.map((result) => result.output)).toEqual(["done-0", "done-1", "done-2"]);

	const config = singleRunnerConfig("/tmp", "run-parallel", {
		parentRunOrigin: "user",
		work,
		resultPath: "/tmp/result.json",
		asyncDir: "/tmp/run-parallel",
		sessionId: "parent-session",
	});
	const completion = createBackgroundCompletion(config, results, 100, 200);
	expect(completion).toMatchObject({
		id: "run-parallel",
		runId: "run-parallel",
		parentRunOrigin: "user",
		mode: "parallel",
		state: "complete",
		success: true,
		results: [
			{ agent: "agent-0", output: "done-0", success: true },
			{ agent: "agent-1", output: "done-1", success: true },
			{ agent: "agent-2", output: "done-2", success: true },
		],
	});
	expect(completion).not.toHaveProperty("chain");
	expect(completion).not.toHaveProperty("workflowGraph");
});

test("rejects oversized parallel work before allocating child executions", async () => {
	let launches = 0;
	await expect(
		runBackgroundWork(
			{
				mode: "parallel",
				group: { tasks: Array.from({ length: 21 }, (_, index) => task(index)), concurrency: 4, worktree: false },
			},
			async (child) => {
				launches += 1;
				return { agent: child.agent, output: "unexpected", success: true, exitCode: 0 };
			},
		),
	).rejects.toThrow("at most 20 tasks");
	expect(launches).toBe(0);
});

test("waits for every parallel child when one child execution rejects", async () => {
	const completed: number[] = [];
	const work = {
		mode: "parallel" as const,
		group: { tasks: [task(0), task(1), task(2)], concurrency: 2, worktree: false },
	};
	const results = await runBackgroundWork(work, async (child, index) => {
		if (index === 0) throw new Error("child setup failed");
		await Bun.sleep(index === 1 ? 30 : 5);
		completed.push(index);
		return { agent: child.agent, output: `done-${index}`, success: true, exitCode: 0 };
	});

	expect(completed.sort()).toEqual([1, 2]);
	expect(results).toMatchObject([
		{
			agent: "agent-0",
			success: false,
			exitCode: 1,
			error: "child setup failed",
			terminalOutcome: {
				state: "failed",
				class: "unknown",
				continuation: { target: { id: "test-run", index: 0 }, resumeSupported: false },
			},
		},
		{ agent: "agent-1", success: true, exitCode: 0, output: "done-1" },
		{ agent: "agent-2", success: true, exitCode: 0, output: "done-2" },
	]);
});

test("does not start queued children after a stop and records a stopped completion", async () => {
	const controller = new AbortController();
	const started: number[] = [];
	const work = {
		mode: "parallel" as const,
		group: { tasks: [task(0), task(1), task(2)], concurrency: 1, worktree: false },
	};
	const results = await runBackgroundWork(
		work,
		async (child, index) => {
			started.push(index);
			controller.abort("stopped");
			return { agent: child.agent, output: "stopped", success: false, exitCode: 1, stopped: true };
		},
		{ signal: controller.signal },
	);
	expect(started).toEqual([0]);
	expect(results).toHaveLength(3);
	expect(results.every((result) => result.stopped)).toBe(true);
	expect(results.slice(1).every((result) => result.preStartTerminalCause === "stop")).toBe(true);

	const config = singleRunnerConfig("/tmp", "run-stopped", {
		work,
		resultPath: "/tmp/result.json",
		asyncDir: "/tmp/run-stopped",
	});
	expect(createBackgroundCompletion(config, results, 100, 200)).toMatchObject({
		state: "stopped",
		success: false,
		stopped: true,
	});
});

test("projects every queued terminal cause without rewriting a launched Agent error", async () => {
	for (const cause of ["pause", "timeout", "stop"] as const) {
		const controller = new AbortController();
		const collision = "Provider failed before it started returning output.";
		const results = await runBackgroundWork(
			{
				mode: "parallel",
				group: { tasks: [task(0), task(1)], concurrency: 1, worktree: false },
			},
			async (child) => {
				controller.abort(cause);
				return {
					agent: child.agent,
					output: collision,
					success: false,
					exitCode: 1,
					stopped: true,
					error: collision,
				};
			},
			{ signal: controller.signal },
		);

		expect(results[0]).toMatchObject({ error: collision, output: collision, stopped: true });
		expect(results[0]).not.toHaveProperty("preStartTerminalCause");
		expect(results[1]?.preStartTerminalCause).toBe(cause);
		expect(results[1]?.interrupted).toBe(cause === "pause" ? true : undefined);
		expect(results[1]?.timedOut).toBe(cause === "timeout" ? true : undefined);
		expect(results[1]?.stopped).toBe(cause === "stop" ? true : undefined);
		expect(results[1]?.terminalOutcome).toMatchObject({
			class: cause === "pause" ? "interrupted" : cause === "timeout" ? "timeout" : "stopped",
			continuation: { target: { id: "test-run", index: 1 }, resumeSupported: false },
		});
	}
});

test("terminalizes queued status steps when a bounded group is stopped", async () => {
	const root = fixtureRoot();
	const readyMarker = path.join(root, "group-stop-ready");
	const writer = path.join(root, "group-stop-writer.ts");
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
	const config = singleRunnerConfig(root, "queued-group-stop", {
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

	const running = runConfiguredBackground(config);
	await waitForFile(readyMarker);
	requestAsyncSteer(asyncDir, {
		id: "queued-stop-steer",
		message: "Inspect the queued child before finishing.",
		source: "test",
		targetIndex: 1,
	});
	await waitForFileText(path.join(asyncDir, "status.json"), "queued-stop-steer");
	const routed = readBackgroundStatus(asyncDir);
	expect(routed.steering?.recent?.[0]?.targets?.[0]?.state).toBe("routed");
	requestAsyncStop(asyncDir, { source: "test" });
	await running;
	const status = readBackgroundStatus(asyncDir);

	expect(status.state).toBe("stopped");
	expect(status.steps).toMatchObject([
		{ status: "stopped", stopped: true },
		{ status: "stopped", stopped: true },
	]);
	expect(status.steps?.[0]?.startedAt).toBeNumber();
	expect(status.steps?.[1]?.startedAt).toBeUndefined();
	expect(status.steps?.[1]?.endedAt).toBeNumber();
	expect(status.steering).toMatchObject({
		scheduled: 0,
		pending: 0,
		failed: 1,
		recent: [
			{
				targets: [
					{
						state: "failed",
						reason: "Agent run ended as stopped before steering was delivered.",
					},
				],
			},
		],
	});
}, 5_000);
