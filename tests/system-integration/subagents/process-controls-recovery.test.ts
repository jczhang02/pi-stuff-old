import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { isRuntimeFunction, isRuntimeNumber } from "../../../packages/pi-stuff/src/shared/runtime-type.js";
import type { AgentConfig } from "../../../packages/pi-stuff/src/subagents/src/agents/agents.ts";
import {
	executeAsyncParallel,
	executeAsyncSingle,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/async-execution.ts";
import { createAsyncJobTracker } from "../../../packages/pi-stuff/src/subagents/src/runs/background/async-job-tracker.ts";
import {
	deliverStopRequest,
	requestAsyncSteer,
} from "../../../packages/pi-stuff/src/subagents/src/runs/background/control-channel.ts";
import { reconcileAsyncRun } from "../../../packages/pi-stuff/src/subagents/src/runs/background/stale-run-reconciler.ts";
import { waitForSteeringAction } from "../../../packages/pi-stuff/src/subagents/src/runs/background/steering.ts";
import { writerProcessRegistryPath } from "../../../packages/pi-stuff/src/subagents/src/runs/background/writer-process-registry.ts";
import { createDurableAgentExecutionCoordinator } from "../../../packages/pi-stuff/src/subagents/src/runtime/durable-agent-execution-coordinator.ts";
import { SessionAgentGovernor } from "../../../packages/pi-stuff/src/subagents/src/runtime/session-governor.ts";
import { CurrentAgents } from "../../../packages/pi-stuff/src/subagents/src/session/current-agents.ts";
import {
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	getAsyncConfigPath,
	RESULTS_DIR,
	SESSION_GOVERNOR_ROOT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_ASYNC_STATUS_EVENT,
	type SubagentState,
} from "../../../packages/pi-stuff/src/subagents/src/shared/types.ts";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { CERTIFIED_PI_VERSION } from "../../../scripts/pi-host-contract.ts";
import { createTestAgentEffectOwner } from "../../agents/agent-effect-owner-fixture.ts";
import { CONTEXT_USAGE_PROVIDER_EXTENSION_PATH } from "../../agents/fixtures/context-usage-provider.ts";
import { PROCESS_CONTROLS_PROVIDER_EXTENSION_PATH } from "../../agents/fixtures/process-controls-provider.ts";
import { createExtensionApi } from "../../fixtures/extension-api.ts";

const providerExtension = PROCESS_CONTROLS_PROVIDER_EXTENSION_PATH;
const piBinary = resolvePiBinary();
const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const PROCESS_CONTROLS_LOG_ENV = "PI_STUFF_PROCESS_CONTROLS_LOG";
const SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";
const temporaryPaths: string[] = [];
const processGroups = new Set<number>();
const originalEnvironment = {
	agentDir: process.env[AGENT_DIR_ENV],
	log: process.env[PROCESS_CONTROLS_LOG_ENV],
	piBinary: process.env[SUBAGENT_PI_BINARY_ENV],
};
let piBinaryCertified = false;
const ASYNC_EVENT_SCHEMA = Type.Object(
	{
		acknowledgeStart: Type.Optional(Type.Function([], Type.Unknown())),
		asyncDir: Type.Optional(Type.String()),
		id: Type.String(),
		pid: Type.Optional(Type.Number()),
	},
	{ additionalProperties: true },
);
const PROCESS_JSON_SCHEMA = Type.Object(
	{
		memberPid: Type.Optional(Type.Number()),
		results: Type.Optional(
			Type.Array(
				Type.Object(
					{
						output: Type.Optional(Type.String()),
						stopped: Type.Optional(Type.Boolean()),
						success: Type.Optional(Type.Boolean()),
					},
					{ additionalProperties: true },
				),
			),
		),
		steps: Type.Optional(
			Type.Array(
				Type.Object(
					{
						contextUsage: Type.Optional(Type.Object({ contextWindow: Type.Number(), tokens: Type.Number() })),
						status: Type.Optional(Type.String()),
					},
					{ additionalProperties: true },
				),
			),
		),
		success: Type.Optional(Type.Boolean()),
		summary: Type.Optional(Type.String()),
		writers: Type.Optional(
			Type.Record(
				Type.String(),
				Type.Object(
					{
						groupMemberProofFile: Type.Optional(Type.String()),
						pid: Type.Optional(Type.Number()),
						state: Type.Optional(Type.String()),
					},
					{ additionalProperties: true },
				),
			),
		),
	},
	{ additionalProperties: true },
);
const PROVIDER_RECORD_SCHEMA = Type.Object(
	{
		childIndex: Type.Optional(Type.String()),
		kind: Type.Optional(Type.String()),
		userText: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const ERRNO_SCHEMA = Type.Object({ code: Type.Optional(Type.String()) }, { additionalProperties: true });
type AsyncEvent = Static<typeof ASYNC_EVENT_SCHEMA>;
type EventPayload = Parameters<ExtensionAPI["events"]["emit"]>[1];

afterEach(() => {
	for (const pid of processGroups) killProcessGroup(pid);
	processGroups.clear();
	for (const target of temporaryPaths.splice(0)) fs.rmSync(target, { recursive: true, force: true });
	setOrDelete("PI_CODING_AGENT_DIR", originalEnvironment.agentDir);
	setOrDelete("PI_STUFF_PROCESS_CONTROLS_LOG", originalEnvironment.log);
	setOrDelete("PI_SUBAGENT_PI_BINARY", originalEnvironment.piBinary);
});

function setOrDelete(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function fixtureRoot(prefix: string): string {
	if (!piBinaryCertified) {
		const version = Bun.spawnSync([piBinary, "--version"], { stdout: "pipe", stderr: "pipe" });
		const reportedVersion = version.stdout.toString().trim();
		if (version.exitCode !== 0 || reportedVersion !== CERTIFIED_PI_VERSION)
			throw new Error(
				`Pi at '${piBinary}' reported '${reportedVersion || version.stderr.toString().trim()}'; expected ${CERTIFIED_PI_VERSION}`,
			);
		piBinaryCertified = true;
	}
	const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	temporaryPaths.push(root);
	const agentDir = path.join(root, "agent-config");
	fs.mkdirSync(agentDir, { recursive: true });
	setOrDelete(AGENT_DIR_ENV, agentDir);
	setOrDelete(SUBAGENT_PI_BINARY_ENV, piBinary);
	setOrDelete(PROCESS_CONTROLS_LOG_ENV, path.join(root, "provider.jsonl"));
	return root;
}

function agent(root: string): AgentConfig {
	return {
		name: "general-purpose",
		description: "Process-level controls fixture",
		model: "pi-stuff-process-controls/fixture-model",
		extensions: [providerExtension],
		systemPrompt: "Follow the deterministic process-controls fixture.",
		systemPromptMode: "append",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "project",
		filePath: path.join(root, "general-purpose.md"),
	};
}

function contextUsageAgent(root: string): AgentConfig {
	return {
		...agent(root),
		model: "pi-stuff-context-usage/fixture-model",
		extensions: [CONTEXT_USAGE_PROVIDER_EXTENSION_PATH],
	};
}

class EventLog {
	readonly records: Array<{ name: string; data: EventPayload }> = [];

	emit(name: string, data: EventPayload): void {
		this.records.push({ name, data });
	}

	on(): () => void {
		return () => {};
	}

	started(runId: string): AsyncEvent {
		const match = this.event(SUBAGENT_ASYNC_STARTED_EVENT, runId);
		if (!match) throw new Error(`No start event recorded for ${runId}.`);
		return match;
	}

	status(runId: string): AsyncEvent | undefined {
		return this.event(SUBAGENT_ASYNC_STATUS_EVENT, runId);
	}

	private event(name: string, runId: string): AsyncEvent | undefined {
		for (const record of this.records) {
			if (record.name === name && Check(ASYNC_EVENT_SCHEMA, record.data) && record.data.id === runId) {
				return record.data;
			}
		}
		return undefined;
	}
}

function extensionApi(events: EventLog): ExtensionAPI {
	const bus = createEventBus();
	return createExtensionApi({
		events: {
			emit(event, payload) {
				events.emit(event, payload);
				bus.emit(event, payload);
			},
			on: bus.on,
		},
	});
}

function artifactConfig() {
	return { ...DEFAULT_ARTIFACT_CONFIG, enabled: false };
}

function readJson(filePath: string) {
	const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
	if (!Check(PROCESS_JSON_SCHEMA, value)) throw new Error(`Expected process fixture JSON at ${filePath}`);
	return value;
}

type ProviderRecord = Static<typeof PROVIDER_RECORD_SCHEMA>;

function readProviderRecords(root: string): ProviderRecord[] {
	const logPath = path.join(root, "provider.jsonl");
	if (!fs.existsSync(logPath)) return [];
	return fs
		.readFileSync(logPath, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const value = JSON.parse(line);
			if (!Check(PROVIDER_RECORD_SCHEMA, value)) throw new Error("Expected a process-controls provider record");
			return value;
		});
}

async function waitFor<T>(description: string, read: () => T | undefined, timeoutMs = 12_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() <= deadline) {
		const value = read();
		if (value !== undefined) return value;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out waiting for ${description}.`);
}

function runnerPid(events: EventLog, runId: string): number {
	const started = events.started(runId);
	if (isRuntimeFunction(started.acknowledgeStart)) started.acknowledgeStart();
	const pid = started.pid;
	if (!isRuntimeNumber(pid) || !Number.isInteger(pid) || pid <= 0) {
		throw new Error(`Run ${runId} did not publish a runner PID.`);
	}
	processGroups.add(pid);
	return pid;
}

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return Check(ERRNO_SCHEMA, error) && error.code === "EPERM";
	}
}

function killProcessGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
}

function cleanupRun(runId: string): void {
	for (const target of [
		path.join(ASYNC_DIR, runId),
		path.join(RESULTS_DIR, `${runId}.json`),
		getAsyncConfigPath(runId),
	]) {
		fs.rmSync(target, { recursive: true, force: true });
	}
}

function stateForSession(sessionId: string): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: sessionId,
		asyncJobs: new Map(),
		recentAgentJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
		completionSeen: new Map(),
	};
}

function trackGovernorSession(sessionId: string): void {
	temporaryPaths.push(path.join(SESSION_GOVERNOR_ROOT, createHash("sha256").update(sessionId).digest("hex")));
}

async function registerGovernorRun(sessionId: string, runId: string, childCount: number): Promise<void> {
	trackGovernorSession(sessionId);
	const governor = new SessionAgentGovernor({ rootDir: SESSION_GOVERNOR_ROOT, sessionId, pid: process.pid });
	for (let index = 0; index < childCount; index++) {
		const acquired = await governor.acquireSpawn({
			logicalAgentId: `${runId}:${index}`,
			runtimeRunId: runId,
			childIndex: index,
			pid: process.pid,
		});
		if (!acquired.ok) throw new Error(acquired.error.message);
	}
}

function seedSession(root: string): string {
	const sessionDir = path.join(root, "seed-session");
	fs.mkdirSync(sessionDir, { recursive: true });
	const result = Bun.spawnSync(
		[
			piBinary,
			"--offline",
			"--approve",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--extension",
			providerExtension,
			"--provider",
			"pi-stuff-process-controls",
			"--model",
			"fixture-model",
			"--session-dir",
			sessionDir,
			"--session-id",
			"process-controls-seed",
			"PROCESS_SEED",
		],
		{ cwd: root, env: { ...process.env }, stdout: "pipe", stderr: "pipe" },
	);
	if (result.exitCode !== 0) {
		throw new Error(`Failed to seed Pi session: ${result.stderr.toString()}`);
	}
	const session = fs.readdirSync(sessionDir).find((entry) => entry.endsWith(".jsonl"));
	if (!session) throw new Error("Seed Pi process did not create a session file.");
	return path.join(sessionDir, session);
}

// biome-ignore format: Keep real-Host acceptance and its independent timeout visibly grouped.
test(
		"reports context capacity from a real child-only Provider",
		async () => {
			const root = fixtureRoot("pi-stuff-child-model-context-");
			const runId = `child-model-context-${process.pid}-${Date.now()}`;
			const sessionId = `session-${runId}`;
			const events = new EventLog();
			const config = contextUsageAgent(root);
			cleanupRun(runId);
			try {
				await registerGovernorRun(sessionId, runId, 1);
				const launched = await executeAsyncSingle(runId, {
					agent: config.name,
					task: "PROCESS_CONTEXT_USAGE",
					agentConfig: config,
					ctx: {
						pi: extensionApi(events),
						cwd: root,
						currentSessionId: sessionId,
						parentSessionId: sessionId,
					},
					artifactConfig: artifactConfig(),
					maxSubagentDepth: 3,
				});
				expect(launched.isError).not.toBeTrue();
				const asyncDir = launched.details.asyncDir;
				if (!asyncDir) throw new Error("Context usage launch did not return asyncDir.");
				const pid = runnerPid(events, runId);
				const statusPath = path.join(asyncDir, "status.json");
				const status = await waitFor(
					"child-only Provider context usage",
					() => {
						if (!fs.existsSync(statusPath)) return undefined;
						const candidate = readJson(statusPath);
						const step = candidate.steps?.[0];
						return step?.status === "complete" && step.contextUsage?.tokens === 50_000 ? candidate : undefined;
					},
					30_000,
				);
				expect(status.steps?.[0]?.contextUsage).toEqual({ tokens: 50_000, contextWindow: 200_000 });
				await waitFor("child-only Provider runner exit", () => (!processAlive(pid) ? true : undefined));
				processGroups.delete(pid);
			} finally {
				cleanupRun(runId);
			}
		},
		45_000,
	);

// biome-ignore format: Keep real-process body and its independent timeout visibly grouped.
test(
		"targets steer and stop to one real parallel writer without disturbing its sibling",
		async () => {
			const root = fixtureRoot("pi-stuff-process-controls-");
			const runId = `controls-${process.pid}-${Date.now()}`;
			cleanupRun(runId);
			const events = new EventLog();
			const sessionId = `session-${runId}`;
			const config = agent(root);
			try {
				await registerGovernorRun(sessionId, runId, 2);
				const launched = await executeAsyncParallel(runId, {
					agents: [config],
					tasks: [
						{ agent: config.name, task: "PROCESS_CONTROL_HOLD_0" },
						{ agent: config.name, task: "PROCESS_CONTROL_HOLD_1" },
					],
					ctx: {
						pi: extensionApi(events),
						cwd: root,
						currentSessionId: sessionId,
						parentSessionId: sessionId,
					},
					artifactConfig: artifactConfig(),
					maxSubagentDepth: 3,
					concurrency: 2,
					globalConcurrencyLimit: 2,
				});
				expect(launched.isError).not.toBeTrue();
				const asyncDir = launched.details.asyncDir;
				if (!asyncDir) throw new Error("Parallel launch did not return asyncDir.");
				runnerPid(events, runId);

				await waitFor("both child writers to run", () => {
					const statusPath = path.join(asyncDir, "status.json");
					if (!fs.existsSync(statusPath)) return undefined;
					const status = readJson(statusPath);
					const steps = status.steps;
					return steps?.length === 2 && steps.every((step) => step.status === "running") ? status : undefined;
				});

				const requestId = `steer-${Date.now()}`;
				requestAsyncSteer(asyncDir, {
					id: requestId,
					message: "TARGET_ONLY_CHILD_ZERO",
					targetIndex: 0,
					source: "process-acceptance",
				});
				const steering = await Effect.runPromise(
					waitForSteeringAction({
						asyncDir,
						sourceRunId: runId,
						requestId,
						// The request is durable: a busy CI runner may acknowledge it after the
						// foreground command's short user-facing wait has returned "pending".
						timeoutMs: 12_000,
					}),
				);
				expect(steering).toMatchObject({
					state: "delivered",
					targets: [{ index: 0, state: "delivered" }],
				});
				await waitFor("child zero to consume the directed steer", () => {
					const request = readProviderRecords(root).find(
						(record) =>
							record.kind === "request" &&
							record.childIndex === "0" &&
							record.userText?.includes("TARGET_ONLY_CHILD_ZERO") === true,
					);
					return request ? true : undefined;
				});
				expect(
					readProviderRecords(root).some(
						(record) =>
							record.childIndex === "1" &&
							record.userText?.includes("TARGET_ONLY_CHILD_ZERO") === true,
					),
				).toBeFalse();

				deliverStopRequest({ asyncDir, source: "process-acceptance", targetIndex: 0 });
				await waitFor("child zero to stop without disturbing child one", () => {
					const statusPath = path.join(asyncDir, "status.json");
					if (!fs.existsSync(statusPath)) return undefined;
					const status = readJson(statusPath);
					const steps = status.steps;
					const siblingStatus = steps?.[1]?.status;
					return steps?.[0]?.status === "stopped" &&
						(siblingStatus === "running" || siblingStatus === "complete")
						? status
						: undefined;
				});

				const result = await waitFor("parallel completion", () => {
					const resultPath = path.join(RESULTS_DIR, `${runId}.json`);
					return fs.existsSync(resultPath) ? readJson(resultPath) : undefined;
				}, 12_000);
				const children = result.results;
				if (!children) throw new Error("Parallel completion did not contain child results");
				expect(children[0]).toMatchObject({ stopped: true, success: false });
				expect(children[1]).toMatchObject({ success: true, output: "PROCESS_CONTROL_RUNNING_1" });
				const eventsText = fs.readFileSync(path.join(asyncDir, "events.jsonl"), "utf8");
				expect(eventsText).toContain('"type":"subagent.child.stop_requested"');
				expect(eventsText).toContain('"index":0');
				expect(eventsText).not.toContain(`"requestId":"${requestId}","index":1`);
			} finally {
				cleanupRun(runId);
			}
		},
		35_000,
	);

function crashRecoveryFixture() {
	const root = fixtureRoot("pi-stuff-process-recovery-");
	const sourceRunId = `crash-${process.pid}-${Date.now()}`;
	const resumedRunId = `resume-${process.pid}-${Date.now()}`;
	cleanupRun(sourceRunId);
	cleanupRun(resumedRunId);
	const sessionId = `recovery-session-${process.pid}-${Date.now()}`;
	trackGovernorSession(sessionId);
	return {
		root,
		sessionFile: seedSession(root),
		sessionId,
		sourceRunId,
		resumedRunId,
		governorRoot: SESSION_GOVERNOR_ROOT,
		config: agent(root),
		events: new EventLog(),
	};
}

async function launchCrashRecoveryWriter(fixture: ReturnType<typeof crashRecoveryFixture>) {
	const { config, events, governorRoot, root, sessionFile, sessionId, sourceRunId } = fixture;
	const firstCoordinator = createDurableAgentExecutionCoordinator({
		effects: createTestAgentEffectOwner(),
		rootDir: governorRoot,
	});
	firstCoordinator.bindSession({ sessionId, ownerAgentPath: [] });
	const prepared = await firstCoordinator.prepare({
		launchRunId: sourceRunId,
		params: { agent: config.name, task: "PROCESS_CRASH_HOLD" },
	});
	if (!prepared.ok || !prepared.invocation) throw new Error("Initial Agent reservation failed.");
	const launched = await executeAsyncSingle(sourceRunId, {
		agent: config.name,
		task: "PROCESS_CRASH_HOLD",
		agentConfig: config,
		sessionFile,
		ctx: { pi: extensionApi(events), cwd: root, currentSessionId: sessionId, parentSessionId: sessionId },
		artifactConfig: artifactConfig(),
		maxSubagentDepth: 3,
	});
	expect(launched.isError).not.toBeTrue();
	const asyncDir = launched.details.asyncDir;
	if (!asyncDir) throw new Error("Crash launch did not return asyncDir.");
	const pid = runnerPid(events, sourceRunId);
	await firstCoordinator.observeAsyncStarted(events.started(sourceRunId));
	await firstCoordinator.settle(prepared.invocation, launched);
	await waitFor("crash writer to run", () => {
		const statusPath = path.join(asyncDir, "status.json");
		if (!fs.existsSync(statusPath)) return undefined;
		const status = readJson(statusPath);
		return status.steps?.[0]?.status === "running" ? status : undefined;
	});
	expect(await waitFor("runner IPC status projection", () => events.status(sourceRunId))).toMatchObject({
		id: sourceRunId,
		asyncDir,
	});
	expect(await new SessionAgentGovernor({ rootDir: governorRoot, sessionId }).snapshot()).toMatchObject({
		total: 1,
		running: 1,
	});
	const writerPid = await waitFor("writer process identity", () => {
		const registryPath = writerProcessRegistryPath(asyncDir);
		if (!fs.existsSync(registryPath)) return undefined;
		const writer = readJson(registryPath).writers?.["0"];
		return writer?.state === "running" && writer.pid !== undefined ? writer.pid : undefined;
	});
	expect(processAlive(writerPid)).toBeTrue();
	return { asyncDir, firstCoordinator, pid, writerPid };
}

// biome-ignore format: Keep crash-recovery body and its independent timeout visibly grouped.
test(
		"kills an orphan writer after a runner-only crash, then resumes the same logical Agent once",
		async () => {
			const fixture = crashRecoveryFixture();
			const { config, events, governorRoot, resumedRunId, root, sessionFile, sessionId, sourceRunId } = fixture;
			try {
				const { asyncDir, firstCoordinator, pid, writerPid } = await launchCrashRecoveryWriter(fixture);
				process.kill(pid, "SIGKILL");
				await waitFor("runner process death", () => (!processAlive(pid) ? true : undefined));

				const terminationStarted = reconcileAsyncRun(asyncDir, { resultsDir: RESULTS_DIR });
				const physicallyRepaired = (result: ReturnType<typeof reconcileAsyncRun>) => {
					return result.repaired && result.status?.processTerminal?.state === "observed" && !processAlive(writerPid)
						? result
						: undefined;
				};
				const repaired =
					physicallyRepaired(terminationStarted) ??
					(await waitFor("physical orphan repair proof", () =>
						physicallyRepaired(reconcileAsyncRun(asyncDir, { resultsDir: RESULTS_DIR })),
					));
				expect(repaired.repaired).toBeTrue();
				expect(repaired.status).toMatchObject({ state: "failed" });
				expect(repaired.message).toContain("exited or disappeared");
				processGroups.delete(pid);

				const restoredState = stateForSession(sessionId);
				const tracker = createAsyncJobTracker(extensionApi(new EventLog()), restoredState, ASYNC_DIR, {
					effects: createTestAgentEffectOwner(),
				});
				await tracker.restoreActiveJobs();
				const rows = new CurrentAgents(restoredState, {
					inspect: () => true,
					steer: () => true,
					stop: () => true,
					resume: () => true,
				}).snapshot().rows;
				expect(rows.find((row) => row.runId === sourceRunId)?.status).toBe("crashed");
				expect(restoredState.asyncJobs.has(sourceRunId)).toBeFalse();

				const reloadedCoordinator = createDurableAgentExecutionCoordinator({
					effects: createTestAgentEffectOwner(),
					rootDir: governorRoot,
				});
				reloadedCoordinator.bindSession({ sessionId, ownerAgentPath: [] });
				await reloadedCoordinator.reconcileExisting();
				const afterReconcile = await new SessionAgentGovernor({ rootDir: governorRoot, sessionId }).snapshot();
				expect(afterReconcile).toMatchObject({ total: 1, running: 0 });

				const resumeReservation = await reloadedCoordinator.prepare({
					launchRunId: resumedRunId,
					params: { action: "resume", id: sourceRunId, index: 0 },
					resumeTargetRunId: sourceRunId,
				});
				if (!resumeReservation.ok || !resumeReservation.invocation) throw new Error("Resume reservation failed.");
				const resumed = await executeAsyncSingle(resumedRunId, {
					agent: config.name,
					task: "PROCESS_RESUME_FINISH",
					agentConfig: config,
					sessionFile,
					revivalLease: {
						sessionFile,
						runId: resumedRunId,
						sourceRunId,
						parentSessionId: sessionId,
					},
					logicalSourceRunId: sourceRunId,
					logicalChildIndex: 0,
					ctx: {
						pi: extensionApi(events),
						cwd: root,
						currentSessionId: sessionId,
						parentSessionId: sessionId,
					},
					artifactConfig: artifactConfig(),
					maxSubagentDepth: 3,
				});
				expect(resumed.isError).not.toBeTrue();
				runnerPid(events, resumedRunId);
				await reloadedCoordinator.observeAsyncStarted(events.started(resumedRunId));
				await reloadedCoordinator.settle(resumeReservation.invocation, resumed);
				const resumedResult = await waitFor("resumed Agent completion", () => {
					const resultPath = path.join(RESULTS_DIR, `${resumedRunId}.json`);
					return fs.existsSync(resultPath) ? readJson(resultPath) : undefined;
				});
				expect(resumedResult).toMatchObject({ success: true, summary: "PROCESS_RESUME_COMPLETED" });
				await waitFor("resumed runner process exit", () => {
					const resumedPid = events.started(resumedRunId).pid;
					return isRuntimeNumber( resumedPid) && !processAlive(resumedPid) ? true : undefined;
				});

				const completion = { runId: resumedRunId, results: [{ taskIndex: 0 }] };
				await reloadedCoordinator.complete(completion);
				await reloadedCoordinator.complete(completion);
				const afterCompletion = await new SessionAgentGovernor({ rootDir: governorRoot, sessionId }).snapshot();
				expect(afterCompletion).toMatchObject({ total: 1, running: 0 });
				expect(afterCompletion.agents.map((entry) => entry.logicalAgentId)).toEqual([`${sourceRunId}:0`]);
				const completedEvents = fs
					.readFileSync(path.join(ASYNC_DIR, resumedRunId, "events.jsonl"), "utf8")
					.split("\n")
					.filter((line) => line.includes('"type":"subagent.run.completed"'));
				expect(completedEvents).toHaveLength(1);
				tracker.resetJobs();
				firstCoordinator.dispose();
				reloadedCoordinator.dispose();
			} finally {
				cleanupRun(sourceRunId);
				cleanupRun(resumedRunId);
			}
		},
		30_000,
	);

// biome-ignore format: Keep supervisor-crash acceptance and its process cleanup visibly grouped.
test(
		"authenticates and reaps a surviving Pi child after its writer supervisor is SIGKILLed",
		async () => {
			if (process.platform === "win32") return;
			const root = fixtureRoot("pi-stuff-supervisor-recovery-");
			const runId = `supervisor-crash-${process.pid}-${Date.now()}`;
			const sessionId = `session-${runId}`;
			const governorRoot = path.join(root, "governor");
			const events = new EventLog();
			const config = agent(root);
			cleanupRun(runId);
			const coordinator = createDurableAgentExecutionCoordinator({
				effects: createTestAgentEffectOwner(),
				rootDir: governorRoot,
			});
			try {
				coordinator.bindSession({ sessionId, ownerAgentPath: [] });
				const prepared = await coordinator.prepare({
					launchRunId: runId,
					params: { agent: config.name, task: "PROCESS_CRASH_HOLD" },
				});
				if (!prepared.ok || !prepared.invocation) throw new Error("Supervisor crash reservation failed.");
				const launched = await executeAsyncSingle(runId, {
					agent: config.name,
					task: "PROCESS_CRASH_HOLD",
					agentConfig: config,
					ctx: {
						pi: extensionApi(events),
						cwd: root,
						currentSessionId: sessionId,
						parentSessionId: sessionId,
					},
					artifactConfig: artifactConfig(),
					maxSubagentDepth: 3,
				});
				if (launched.isError || !launched.details.asyncDir) throw new Error("Supervisor crash launch failed.");
				const asyncDir = launched.details.asyncDir;
				runnerPid(events, runId);
				await coordinator.observeAsyncStarted(events.started(runId));
				await coordinator.settle(prepared.invocation, launched);

				const identities = await waitFor("writer survivor proof", () => {
					const registryPath = writerProcessRegistryPath(asyncDir);
					if (!fs.existsSync(registryPath)) return undefined;
					const registry = readJson(registryPath);
					const writer = registry.writers?.["0"];
					if (writer?.state !== "running" || !writer.pid || !writer.groupMemberProofFile) return undefined;
					const proofPath = path.join(asyncDir, writer.groupMemberProofFile);
					if (!fs.existsSync(proofPath)) return undefined;
					const proof = readJson(proofPath);
					return proof.memberPid !== undefined
						? { supervisorPid: writer.pid, memberPid: proof.memberPid }
						: undefined;
				});
				processGroups.add(identities.supervisorPid);
				expect(processAlive(identities.supervisorPid)).toBeTrue();
				expect(processAlive(identities.memberPid)).toBeTrue();

				process.kill(identities.supervisorPid, "SIGKILL");
				await waitFor("writer supervisor death", () =>
					!processAlive(identities.supervisorPid) ? true : undefined,
				);
				await waitFor("authenticated surviving Pi child reap", () =>
					!processAlive(identities.memberPid) ? true : undefined,
				);
				processGroups.delete(identities.supervisorPid);
				await waitFor("writer registry release", () => {
					const registry = readJson(writerProcessRegistryPath(asyncDir));
					const writer = registry.writers?.["0"];
					return writer?.state === "none" ? true : undefined;
				});
				await waitFor("supervisor-crash runner exit", () => {
					const pid = events.started(runId).pid;
					return isRuntimeNumber( pid) && !processAlive(pid) ? true : undefined;
				});
				await coordinator.reconcileExisting();
				const snapshot = await new SessionAgentGovernor({ rootDir: governorRoot, sessionId }).snapshot();
				expect(snapshot).toMatchObject({ total: 1, running: 0 });
			} finally {
				coordinator.dispose();
				cleanupRun(runId);
			}
		},
		25_000,
	);
