import { afterEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import {
	initializeWriterProcessRegistry,
	inspectWriterProcessLivenessEffect,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/writer-process-registry.js";
import { maintainAgentRuntime as maintainAgentRuntimeNative } from "../../../packages/pi-stuff/src/subagents/src/runtime/runtime-maintenance.js";
import {
	shardedDurableClaimName,
	tryAcquireKernelClaim,
} from "../../../packages/pi-stuff/src/subagents/src/shared/durable-claim.js";
import { readProcessStartIdentity } from "../../../packages/pi-stuff/src/subagents/src/shared/process-identity.js";

const roots = new Set<string>();

function maintainAgentRuntime(root?: string, options: { readonly now?: number } = {}) {
	return maintainAgentRuntimeNative(root, {
		...options,
		inspectWriterLiveness: (directory) => Effect.runPromise(inspectWriterProcessLivenessEffect(directory)),
	});
}

afterEach(() => {
	for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
	roots.clear();
});

function fixture(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-runtime-maintenance-"));
	roots.add(root);
	return root;
}

function terminalRun(
	root: string,
	kind: "foreground" | "async" | "nested",
	runId: string,
	options: {
		endedAt?: number;
		processObserved?: boolean;
		eventBytes?: number;
		rootRunId?: string;
		sessionId?: string;
		completeSessionHistory?: boolean;
	} = {},
): string {
	const parent =
		kind === "foreground"
			? path.join(root, "foreground-runs")
			: kind === "async"
				? path.join(root, "async-subagent-runs")
				: path.join(root, "nested-subagent-runs", options.rootRunId ?? "root-run");
	const directory = path.join(parent, runId);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	const endedAt = options.endedAt ?? Date.now();
	const sessionFile = options.completeSessionHistory ? path.join(directory, "child-session.jsonl") : undefined;
	if (sessionFile) fs.writeFileSync(sessionFile, '{"type":"message"}\n', { mode: 0o600 });
	const status = {
		lifecycleArtifactVersion: 3,
		runId,
		sessionId: options.sessionId,
		mode: "single",
		state: "complete",
		startedAt: endedAt - 1_000,
		endedAt,
		lastUpdate: endedAt,
		steps: sessionFile ? [{ agent: "scout", status: "complete", sessionFile }] : [],
	};
	if (options.processObserved) {
		Object.assign(status, {
			processTerminal: {
				version: 1,
				state: "observed",
				runId,
				runnerProcessInstanceId: `${runId}-runner`,
				observedAt: endedAt,
				instances: [],
			},
		});
	}
	fs.writeFileSync(path.join(directory, "status.json"), JSON.stringify(status), { mode: 0o600 });
	initializeWriterProcessRegistry(directory, runId, process.pid, 1);
	if (options.eventBytes) fs.writeFileSync(path.join(directory, "events.jsonl"), "x".repeat(options.eventBytes));
	const timestamp = new Date(endedAt);
	fs.utimesSync(directory, timestamp, timestamp);
	return directory;
}

function staleResult(root: string, runId: string, asyncDir: string, sessionId: string, endedAt: number): string {
	const resultsDir = path.join(root, "async-subagent-results");
	fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
	const resultPath = path.join(resultsDir, `${runId}.json`);
	fs.writeFileSync(
		resultPath,
		JSON.stringify({
			id: runId,
			runId,
			sessionId,
			asyncDir,
			state: "complete",
			success: true,
			endedAt,
			results: [{ agent: "scout", success: true, output: "done" }],
		}),
		{ mode: 0o600 },
	);
	const timestamp = new Date(endedAt);
	fs.utimesSync(resultPath, timestamp, timestamp);
	return resultPath;
}

test("reclaims only identity-proven abandoned preparation directories", async () => {
	const root = fixture();
	const foregroundRoot = path.join(root, "foreground-runs");
	fs.mkdirSync(foregroundRoot, { recursive: true, mode: 0o700 });
	const abandoned = path.join(foregroundRoot, "abandoned-prepare");
	const live = path.join(foregroundRoot, "live-prepare");
	for (const [directory, identity] of [
		[abandoned, "linux:proven-replaced"],
		[live, readProcessStartIdentity(process.pid)],
	] as const) {
		if (!identity) throw new Error("Test platform requires process-start identity support.");
		fs.mkdirSync(directory, { mode: 0o700 });
		const stat = fs.lstatSync(directory);
		fs.writeFileSync(
			path.join(directory, ".foreground-preparation-owner.json"),
			JSON.stringify({
				version: 2,
				token: "12345678-1234-1234-1234-123456789abc",
				pid: process.pid,
				processStartIdentity: identity,
				createdAt: Date.now(),
				device: stat.dev,
				inode: stat.ino,
			}),
			{ mode: 0o600 },
		);
	}

	const report = await maintainAgentRuntime(root);

	expect(report.abandonedPreparationsReclaimed).toBe(1);
	expect(fs.existsSync(abandoned)).toBeFalse();
	expect(fs.existsSync(live)).toBeTrue();
});

test("does not let more than one pass of foreground entries starve async and nested diagnostics", async () => {
	const root = fixture();
	const foreground = path.join(root, "foreground-runs");
	fs.mkdirSync(foreground, { recursive: true, mode: 0o700 });
	for (let index = 0; index < 5_001; index += 1) {
		fs.mkdirSync(path.join(foreground, `f-${String(index).padStart(4, "0")}`), { mode: 0o700 });
	}
	const asyncRun = terminalRun(root, "async", "async-fair", {
		endedAt: Date.now() - 2 * 60 * 60 * 1_000,
		processObserved: true,
		eventBytes: 300 * 1_024,
	});
	const nestedRun = terminalRun(root, "nested", "nested-fair", {
		endedAt: Date.now() - 2 * 60 * 60 * 1_000,
		processObserved: true,
		eventBytes: 300 * 1_024,
	});

	const report = await maintainAgentRuntime(root);

	expect(report.trimmed).toBe(2);
	expect(fs.statSync(path.join(asyncRun, "events.jsonl")).size).toBeLessThanOrEqual(256 * 1_024);
	expect(fs.statSync(path.join(nestedRun, "events.jsonl")).size).toBeLessThanOrEqual(256 * 1_024);
}, 20_000);

test("requires observed v3 process proof before trimming terminal diagnostics", async () => {
	const root = fixture();
	const run = terminalRun(root, "async", "missing-proof", { eventBytes: 300 * 1_024 });

	const report = await maintainAgentRuntime(root);

	expect(report.trimmed).toBe(0);
	expect(fs.statSync(path.join(run, "events.jsonl")).size).toBe(300 * 1_024);
});

test("trims terminal foreground v3 diagnostics without detached-runner proof", async () => {
	const root = fixture();
	const run = terminalRun(root, "foreground", "foreground-host-run", {
		endedAt: Date.now() - 2 * 60 * 60 * 1_000,
		eventBytes: 300 * 1_024,
	});

	const report = await maintainAgentRuntime(root);

	expect(report.trimmed).toBe(1);
	expect(fs.statSync(path.join(run, "events.jsonl")).size).toBeLessThanOrEqual(256 * 1_024);
});

test("never garbage-collects lifecycle evidence without a durable consumed marker protocol", async () => {
	const root = fixture();
	const run = terminalRun(root, "async", "retained-proof", {
		endedAt: Date.now() - 40 * 24 * 60 * 60 * 1_000,
		processObserved: true,
	});

	await maintainAgentRuntime(root);

	expect(fs.existsSync(run)).toBeTrue();
});

test("retires a stale result inbox entry only after complete run history is durable", async () => {
	const root = fixture();
	const now = Date.now();
	const endedAt = now - 31 * 24 * 60 * 60 * 1_000;
	const run = terminalRun(root, "async", "retired-result", {
		endedAt,
		processObserved: true,
		sessionId: "parent-session",
		completeSessionHistory: true,
	});
	const resultPath = staleResult(root, "retired-result", run, "parent-session", endedAt);

	const report = await maintainAgentRuntime(root, { now });

	expect(report.staleResultsRetired).toBe(1);
	expect(fs.existsSync(resultPath)).toBeFalse();
	expect(fs.existsSync(path.join(run, "child-session.jsonl"))).toBeTrue();
});

test("retires only old unclaimed delivery state left after its result disappeared", async () => {
	const root = fixture();
	const now = Date.now();
	const staleAt = now - 31 * 24 * 60 * 60 * 1_000;
	const resultsDir = path.join(root, "async-subagent-results");
	fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
	for (const runId of ["orphan", "recent", "paired"]) {
		terminalRun(root, "async", runId, { endedAt: staleAt, processObserved: true });
	}
	const oldState = path.join(resultsDir, ".orphan.json.delivery-state");
	const recentState = path.join(resultsDir, ".recent.json.delivery-state");
	const pairedState = path.join(resultsDir, ".paired.json.delivery-state");
	for (const state of [oldState, recentState, pairedState]) fs.writeFileSync(state, "{}", { mode: 0o600 });
	fs.writeFileSync(path.join(resultsDir, "paired.json"), "{}", { mode: 0o600 });
	const staleTimestamp = new Date(staleAt);
	for (const state of [oldState, pairedState]) fs.utimesSync(state, staleTimestamp, staleTimestamp);
	const claim = tryAcquireKernelClaim(resultsDir, shardedDurableClaimName("result-delivery", "orphan.json"));
	if (!claim) throw new Error("Test could not acquire the result delivery claim.");

	try {
		await maintainAgentRuntime(root, { now });
		expect(fs.existsSync(oldState)).toBeTrue();
	} finally {
		claim.release();
	}

	await maintainAgentRuntime(root, { now });

	expect(fs.existsSync(oldState)).toBeFalse();
	expect(fs.existsSync(recentState)).toBeTrue();
	expect(fs.existsSync(pairedState)).toBeTrue();
});

test("retains recent, unproven, incomplete, foreign, and claimed result entries", async () => {
	const root = fixture();
	const now = Date.now();
	const staleAt = now - 31 * 24 * 60 * 60 * 1_000;
	const recentAt = now - 29 * 24 * 60 * 60 * 1_000;
	const cases = [
		{ runId: "recent-result", endedAt: recentAt, processObserved: true, history: true, resultSession: "s" },
		{ runId: "missing-proof", endedAt: staleAt, processObserved: false, history: true, resultSession: "s" },
		{ runId: "missing-history", endedAt: staleAt, processObserved: true, history: false, resultSession: "s" },
		{ runId: "foreign-result", endedAt: staleAt, processObserved: true, history: true, resultSession: "other" },
	] as const;
	const retained: string[] = [];
	for (const candidate of cases) {
		const run = terminalRun(root, "async", candidate.runId, {
			endedAt: candidate.endedAt,
			processObserved: candidate.processObserved,
			sessionId: "s",
			completeSessionHistory: candidate.history,
		});
		retained.push(staleResult(root, candidate.runId, run, candidate.resultSession, candidate.endedAt));
	}
	const claimedRun = terminalRun(root, "async", "claimed-result", {
		endedAt: staleAt,
		processObserved: true,
		sessionId: "s",
		completeSessionHistory: true,
	});
	const claimedResult = staleResult(root, "claimed-result", claimedRun, "s", staleAt);
	retained.push(claimedResult);
	const claim = tryAcquireKernelClaim(
		path.dirname(claimedResult),
		shardedDurableClaimName("result-delivery", path.basename(claimedResult)),
	);
	if (!claim) throw new Error("Test could not acquire the result delivery claim.");

	try {
		const report = await maintainAgentRuntime(root, { now });

		expect(report.staleResultsRetired).toBe(0);
		for (const resultPath of retained) expect(fs.existsSync(resultPath)).toBeTrue();
	} finally {
		claim.release();
	}
});

test("advances past 5,000 older runs and unretirable results on the next bounded pass", async () => {
	const root = fixture();
	const now = Date.now();
	const staleAt = now - 31 * 24 * 60 * 60 * 1_000;
	const asyncRoot = path.join(root, "async-subagent-runs");
	fs.mkdirSync(asyncRoot, { recursive: true, mode: 0o700 });
	const unrelatedTimestamp = new Date(staleAt - 24 * 60 * 60 * 1_000);
	for (let index = 0; index < 5_000; index += 1) {
		const directory = path.join(asyncRoot, `blocked-${String(index).padStart(4, "0")}`);
		fs.mkdirSync(directory, { mode: 0o700 });
		fs.utimesSync(directory, unrelatedTimestamp, unrelatedTimestamp);
		if (index < 256) staleResult(root, path.basename(directory), directory, "unbound-session", staleAt);
	}
	const run = terminalRun(root, "async", "reachable-result", {
		endedAt: staleAt,
		processObserved: true,
		sessionId: "parent-session",
		completeSessionHistory: true,
	});
	const resultPath = staleResult(root, "reachable-result", run, "parent-session", staleAt);

	const firstReport = await maintainAgentRuntime(root, { now });
	expect(firstReport.staleResultsRetired).toBe(0);
	expect(fs.existsSync(resultPath)).toBeTrue();

	const secondReport = await maintainAgentRuntime(root, { now });

	expect(secondReport.staleResultsRetired).toBe(1);
	expect(fs.existsSync(resultPath)).toBeFalse();
}, 20_000);

test("does not rewrite a recently terminal event stream while tracker cursors may still reference it", async () => {
	const root = fixture();
	const run = terminalRun(root, "async", "cursor-grace", {
		processObserved: true,
		eventBytes: 300 * 1_024,
	});
	const before = fs.statSync(path.join(run, "events.jsonl"));

	const report = await maintainAgentRuntime(root);
	const after = fs.statSync(path.join(run, "events.jsonl"));

	expect(report.trimmed).toBe(0);
	expect(after.ino).toBe(before.ino);
	expect(after.size).toBe(before.size);
});
