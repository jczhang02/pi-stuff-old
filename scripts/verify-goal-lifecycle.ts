import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { codeModeHostBinaryPath } from "../packages/pi-stuff/src/code-mode/host/binary.js";
import { DEFAULT_SESSION_NAMING_SETTINGS } from "../packages/pi-stuff/src/session-naming/settings.js";
import type { JsonInputObject } from "../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { createAssistantMessage } from "../tests/fixtures/faux-provider.js";
import {
	activeGoal,
	BLOCKED_GOAL_FINAL_RESPONSE,
	BUDGETED_GOAL_FINAL_RESPONSE,
	CODE_MODE_GOAL_FINAL_RESPONSE,
	GOAL_FINAL_RESPONSE,
} from "../tests/fixtures/goal-lifecycle-provider.js";
import { terminateDetachedProcessGroup } from "./detached-process.js";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";

const PROVIDER = "pi-stuff-goal-lifecycle";
const MODEL = "fixture-model";
const TIMEOUT_MS = 30_000;

type Scenario = "blocker" | "code-mode" | "compaction" | "manual-compaction" | "normal" | "reload" | "retry";

interface ScenarioContract {
	readonly expectedGoalCalls: readonly number[];
	readonly finalResponse: string;
	readonly finalTool: "codemode" | "goal_blocked" | "goal_complete";
	readonly startMessage: string;
	readonly terminalStatus: "blocked" | "complete";
}

const SCENARIO_CONTRACTS = {
	"manual-compaction": {
		expectedGoalCalls: [1, 2],
		finalResponse: GOAL_FINAL_RESPONSE,
		finalTool: "goal_complete",
		startMessage: "",
		terminalStatus: "complete",
	},
	retry: {
		expectedGoalCalls: [1, 2, 3, 4, 5, 6],
		finalResponse: GOAL_FINAL_RESPONSE,
		finalTool: "goal_complete",
		startMessage: "/goal-lifecycle-seed",
		terminalStatus: "complete",
	},
	blocker: {
		expectedGoalCalls: [1, 2, 3, 4, 5, 6],
		finalResponse: BLOCKED_GOAL_FINAL_RESPONSE,
		finalTool: "goal_blocked",
		startMessage: "/goal Certify packed three-turn blocker audit",
		terminalStatus: "blocked",
	},
	"code-mode": {
		expectedGoalCalls: [1, 2],
		finalResponse: CODE_MODE_GOAL_FINAL_RESPONSE,
		finalTool: "codemode",
		startMessage: "/goal Certify packed Code Mode completion",
		terminalStatus: "complete",
	},
	compaction: {
		expectedGoalCalls: [1, 2, 3, 4],
		finalResponse: GOAL_FINAL_RESPONSE,
		finalTool: "goal_complete",
		startMessage: "/goal Certify packed active Goal compaction",
		terminalStatus: "complete",
	},
	normal: {
		expectedGoalCalls: [1, 2, 3],
		finalResponse: BUDGETED_GOAL_FINAL_RESPONSE,
		finalTool: "goal_complete",
		startMessage: "/goal --tokens 20k Certify packed multi-turn completion",
		terminalStatus: "complete",
	},
	reload: {
		expectedGoalCalls: [1, 2],
		finalResponse: GOAL_FINAL_RESPONSE,
		finalTool: "goal_complete",
		startMessage: "/goal-lifecycle-seed",
		terminalStatus: "complete",
	},
} satisfies Record<Scenario, ScenarioContract>;

const GOAL_RECORD_SCHEMA = Type.Object(
	{
		blockerAudit: Type.Optional(
			Type.Object({ attempts: Type.Optional(Type.Array(Type.Unknown())) }, { additionalProperties: true }),
		),
		id: Type.Optional(Type.String()),
		status: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const GOAL_STATE_SCHEMA = Type.Object(
	{ goal: Type.Optional(Type.Union([GOAL_RECORD_SCHEMA, Type.Null()])) },
	{ additionalProperties: true },
);
const SESSION_MESSAGE_SCHEMA = Type.Object(
	{
		content: Type.Optional(
			Type.Array(
				Type.Object(
					{ text: Type.Optional(Type.String()), type: Type.Optional(Type.String()) },
					{ additionalProperties: true },
				),
			),
		),
		role: Type.Optional(Type.String()),
		toolName: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const SESSION_ENTRY_SCHEMA = Type.Object(
	{
		customType: Type.Optional(Type.String()),
		data: Type.Optional(Type.Unknown()),
		message: Type.Optional(SESSION_MESSAGE_SCHEMA),
		type: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const RPC_RECORD_SCHEMA = Type.Object(
	{
		aborted: Type.Optional(Type.Boolean()),
		command: Type.Optional(Type.Unknown()),
		data: Type.Optional(Type.Unknown()),
		entry: Type.Optional(SESSION_ENTRY_SCHEMA),
		error: Type.Optional(Type.Unknown()),
		event: Type.Optional(Type.Unknown()),
		extensionPath: Type.Optional(Type.Unknown()),
		duringGoal: Type.Optional(Type.Boolean()),
		goalCalls: Type.Optional(Type.Number()),
		historical: Type.Optional(Type.Boolean()),
		message: Type.Optional(Type.Unknown()),
		phase: Type.Optional(Type.String()),
		toolName: Type.Optional(Type.String()),
		tools: Type.Optional(Type.Array(Type.String())),
		id: Type.Optional(Type.String()),
		idle: Type.Optional(Type.Boolean()),
		reason: Type.Optional(Type.Unknown()),
		result: Type.Optional(Type.Unknown()),
		success: Type.Optional(Type.Boolean()),
		type: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const ENTRIES_DATA_SCHEMA = Type.Object({ entries: Type.Array(SESSION_ENTRY_SCHEMA) }, { additionalProperties: true });

type GoalRecord = Static<typeof GOAL_RECORD_SCHEMA>;
type GoalState = Static<typeof GOAL_STATE_SCHEMA>;
type RpcRecord = Static<typeof RPC_RECORD_SCHEMA>;
type SessionEntryRecord = Static<typeof SESSION_ENTRY_SCHEMA>;
type SessionMessageRecord = Static<typeof SESSION_MESSAGE_SCHEMA>;

interface RpcTransport {
	records: RpcRecord[];
	send(command: JsonInputObject): Promise<RpcRecord>;
	stop(): Promise<void>;
}

export interface VerifyGoalLifecycleOptions {
	packagePath: string;
	piBinary: string;
}

interface GoalLifecycleEnvironment {
	readonly [name: string]: string;
}

function environment(temporaryDirectory: string, scenario: Scenario, logPath: string): GoalLifecycleEnvironment {
	const { PATH: path } = process.env;
	if (!path) throw new Error("PATH is required to start the Pi host");
	const result: GoalLifecycleEnvironment = {
		HOME: join(temporaryDirectory, "home"),
		LANG: "C.UTF-8",
		LC_ALL: "C.UTF-8",
		MAGIC_CONTEXT_PI_SUBAGENT: "1",
		NO_COLOR: "1",
		PATH: path,
		PI_CODING_AGENT_DIR: join(temporaryDirectory, "agent"),
		PI_OFFLINE: "1",
		PI_STUFF_GOAL_LIFECYCLE_LOG: logPath,
		PI_STUFF_CODE_MODE_DEFAULT: scenario === "code-mode" ? "on" : "off",
		PI_STUFF_GOAL_LIFECYCLE_SCENARIO: scenario,
		PI_TELEMETRY: "0",
		TERM: "dumb",
		XDG_CACHE_HOME: join(temporaryDirectory, "cache"),
		XDG_CONFIG_HOME: join(temporaryDirectory, "config"),
		XDG_DATA_HOME: join(temporaryDirectory, "data"),
		XDG_STATE_HOME: join(temporaryDirectory, "state"),
	};
	if (scenario === "code-mode") Object.assign(result, { PI_STUFF_CODE_MODE_HOST: codeModeHostBinaryPath() });
	return result;
}

function parseRecords(stdout: string): RpcRecord[] {
	return stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const value = JSON.parse(line);
			if (!Check(RPC_RECORD_SCHEMA, value)) throw new Error(`Invalid Pi RPC record: ${line}`);
			return value;
		});
}

async function createRpcTransport(command: string[], cwd: string, env: Record<string, string>): Promise<RpcTransport> {
	const child = Bun.spawn(command, { cwd, detached: true, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
	const records: RpcRecord[] = [];
	const pending = new Map<
		string,
		{ reject: (error: Error) => void; resolve: (record: RpcRecord) => void; timeout: ReturnType<typeof setTimeout> }
	>();
	const reader = child.stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let sequence = 0;
	let readError: Error | undefined;
	const consume = (line: string) => {
		if (!line) return;
		const parsed = JSON.parse(line);
		if (!Check(RPC_RECORD_SCHEMA, parsed)) throw new Error(`Invalid Pi RPC record: ${line}`);
		const record = parsed;
		records.push(record);
		if (!isRuntimeString(record.id) || record.type !== "response") return;
		const request = pending.get(record.id);
		if (!request) return;
		pending.delete(record.id);
		clearTimeout(request.timeout);
		request.resolve(record);
	};
	const reading = (async () => {
		while (true) {
			const { done, value } = await reader.read();
			buffer += decoder.decode(value, { stream: !done });
			while (buffer.includes("\n")) {
				const newline = buffer.indexOf("\n");
				const line = buffer.slice(0, newline).replace(/\r$/u, "");
				buffer = buffer.slice(newline + 1);
				consume(line);
			}
			if (done) {
				consume(buffer.replace(/\r$/u, ""));
				break;
			}
		}
	})().catch((cause: unknown) => {
		readError = cause instanceof Error ? cause : new Error(String(cause));
		for (const request of pending.values()) {
			clearTimeout(request.timeout);
			request.reject(readError);
		}
		pending.clear();
	});
	await new Promise((resolve) => setTimeout(resolve, 100));
	if (child.exitCode !== null) {
		const stderr = await new Response(child.stderr).text();
		throw new Error(`Pi exited during RPC startup: ${stderr.trim() || String(child.exitCode)}`);
	}
	return {
		records,
		async send(command_) {
			if (readError) throw readError;
			const id = `goal-lifecycle-rpc-${String(++sequence)}`;
			const result = new Promise<RpcRecord>((resolve, reject) => {
				const timeout = setTimeout(() => {
					pending.delete(id);
					reject(new Error(`Pi RPC request timed out: ${JSON.stringify(command_)}`));
				}, TIMEOUT_MS);
				pending.set(id, { reject, resolve, timeout });
			});
			child.stdin.write(`${JSON.stringify({ ...command_, id })}\n`);
			await child.stdin.flush();
			const record = await result;
			if (record.success !== true) throw new Error(`Pi RPC request failed: ${JSON.stringify(record)}`);
			return record;
		},
		async stop() {
			await terminateDetachedProcessGroup(child);
			await reading;
		},
	};
}

function entries(record: RpcRecord): SessionEntryRecord[] {
	if (!Check(ENTRIES_DATA_SCHEMA, record.data)) throw new Error("Pi get_entries response has no entries");
	return record.data.entries;
}

function goalStates(records: readonly SessionEntryRecord[]): GoalState[] {
	return records
		.filter((entry) => entry.type === "custom" && entry.customType === "goal-state")
		.map((entry) => entry.data)
		.filter((data) => Check(GOAL_STATE_SCHEMA, data));
}

function goal(state: GoalState): GoalRecord | null {
	return state.goal ?? null;
}

function messageText(message: SessionMessageRecord | undefined): string {
	if (message?.role !== "assistant") return "";
	return (message.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n");
}

function assistantText(entry: SessionEntryRecord): string {
	return entry.type === "message" ? messageText(entry.message) : "";
}

function rpcAssistantText(record: RpcRecord): string {
	if (!Check(SESSION_MESSAGE_SCHEMA, record.message)) return "";
	// SAFETY: the TypeBox check above validates the complete message shape before narrowing it.
	return messageText(record.message as SessionMessageRecord);
}

function assertFinalResponse(
	scenario: Scenario,
	sessionEntries: readonly SessionEntryRecord[],
	rpcRecords: readonly RpcRecord[],
	logRecords: readonly RpcRecord[],
): void {
	const contract = SCENARIO_CONTRACTS[scenario];
	const expected = contract.finalResponse;
	const finalResponseIndexes = sessionEntries.flatMap((entry, index) =>
		assistantText(entry).includes(expected) ? [index] : [],
	);
	if (finalResponseIndexes.length !== 1) {
		throw new Error(
			`${scenario}: expected one persisted final Assistant response, received ${String(finalResponseIndexes.length)}`,
		);
	}
	const terminalStateIndex = sessionEntries.findIndex((entry) => {
		if (entry.type !== "custom" || entry.customType !== "goal-state" || !Check(GOAL_STATE_SCHEMA, entry.data)) {
			return false;
		}
		return goal(entry.data)?.status === contract.terminalStatus;
	});
	if (terminalStateIndex < 0 || terminalStateIndex >= (finalResponseIndexes[0] ?? -1)) {
		throw new Error(`${scenario}: Goal terminal state was not persisted before its final Assistant response`);
	}
	if (scenario === "normal") {
		const terminalResult = sessionEntries
			.filter((entry) => entry.message?.role === "toolResult" && entry.message.toolName === "goal_complete")
			.at(-1);
		const elapsed = terminalResult?.message?.content
			?.map((part) => part.text ?? "")
			.join("\n")
			.match(/Elapsed time: ([^\n]+)\./u)?.[1];
		if (!elapsed || !sessionEntries.some((entry) => assistantText(entry).includes(`Elapsed time: ${elapsed}.`))) {
			throw new Error("normal: persisted final response did not report the supplied elapsed duration");
		}
	}
	const finalResponseEventIndex = rpcRecords.findIndex(
		(record) => record.type === "message_end" && rpcAssistantText(record).includes(expected),
	);
	const finalSettledIndex = rpcRecords.findIndex(
		(record, index) => index > finalResponseEventIndex && record.type === "agent_settled",
	);
	if (finalResponseEventIndex < 0 || finalSettledIndex < 0) {
		throw new Error(`${scenario}: final Assistant response did not reach an agent_settled boundary`);
	}
	if (rpcRecords.some((record, index) => index > finalSettledIndex && record.type === "agent_start")) {
		throw new Error(`${scenario}: another Agent run started after the final response settled`);
	}
	const finalProviderCalls = logRecords.filter(
		(record) => record.type === "provider_call" && record.phase === contract.terminalStatus,
	);
	if (finalProviderCalls.length !== 1) {
		throw new Error(
			`${scenario}: expected one final-response Provider call, received ${String(finalProviderCalls.length)}`,
		);
	}
	const finalTools = finalProviderCalls[0]?.tools ?? [];
	if (!finalTools.includes(contract.finalTool)) {
		throw new Error(`${scenario}: final-response Provider call did not retain the ${contract.finalTool} Tool`);
	}
	if (!finalTools.includes("goal_large_result")) {
		throw new Error(`${scenario}: final-response Provider call did not retain ordinary Tools`);
	}
}

function assertRetryQueue(records: readonly RpcRecord[]): void {
	const states = records.flatMap((record, index) => {
		const entry = record.entry;
		if (
			record.type !== "entry_appended" ||
			entry?.customType !== "goal-state" ||
			!Check(GOAL_STATE_SCHEMA, entry.data)
		)
			return [];
		return [{ index, goal: goal(entry.data) }];
	});
	const completed = states.find((state) => state.goal?.status === "complete");
	const retries = records.filter((record) => record.type === "auto_retry_start");
	const exhausted = records.findIndex((record) => record.type === "auto_retry_end" && record.success === false);
	const nextActive = states.find(
		(state) => state.index > (completed?.index ?? Infinity) && state.goal?.status === "active",
	);
	if (
		!completed?.goal?.id ||
		retries.length !== 2 ||
		exhausted <= completed.index ||
		!nextActive ||
		nextActive.index <= exhausted
	) {
		throw new Error("retry: queued Goal did not wait for final-response Host retry exhaustion");
	}
	if (
		states.some(
			(state) =>
				state.index > completed.index && state.goal?.id === completed.goal?.id && state.goal?.status !== "complete",
		)
	) {
		throw new Error("retry: final-response failure reverted the completed Goal");
	}
}

function assertScenario(
	scenario: Scenario,
	records: readonly RpcRecord[],
	sessionEntries: readonly SessionEntryRecord[],
	logRecords: readonly RpcRecord[],
	observedActiveGoal: boolean,
): void {
	if (scenario === "retry") assertRetryQueue(records);
	const states = goalStates(sessionEntries);
	if (states.length === 0) throw new Error(`${scenario}: no persisted Goal states were observed`);
	assertFinalResponse(scenario, sessionEntries, records, logRecords);
	const expectedProviderCalls = SCENARIO_CONTRACTS[scenario].expectedGoalCalls;
	const goalProviderCalls = logRecords
		.filter((record) => record.type === "provider_call" && record.goalCalls !== undefined)
		.map((record) => record.goalCalls);
	if (JSON.stringify(goalProviderCalls) !== JSON.stringify(expectedProviderCalls)) {
		throw new Error(
			`${scenario}: expected Goal provider calls ${JSON.stringify(expectedProviderCalls)}, received ${JSON.stringify(goalProviderCalls)}`,
		);
	}
	const goals = states.map(goal);
	const finalGoal = goals.at(-1);
	if (scenario === "blocker") {
		if (finalGoal?.status !== "blocked") {
			throw new Error("blocker: Goal did not reach blocked status");
		}
		const attempts = finalGoal.blockerAudit?.attempts;
		if (!Array.isArray(attempts) || attempts.length !== 3) {
			throw new Error("blocker: three distinct persisted attempts were not certified");
		}
		return;
	}
	if (finalGoal !== null) throw new Error(`${scenario}: Goal was not cleared after completion`);
	if (!observedActiveGoal) {
		throw new Error(`${scenario}: active Goal state was not persisted`);
	}
	if (scenario === "code-mode") {
		if (!logRecords.some((record) => record.type === "tool_call" && record.toolName === "codemode")) {
			throw new Error("code-mode: certified host did not execute the outer Code Mode Tool");
		}
	}
	if (scenario === "reload") {
		if (!logRecords.some((record) => record.type === "session_start" && record.reason === "reload")) {
			throw new Error("reload: certified host did not emit session_start reason=reload");
		}
	}
	if (scenario === "manual-compaction") {
		const end = records.find((record) => record.type === "compaction_end" && record.reason === "manual");
		if (!end?.result || end.aborted) throw new Error("manual compaction did not succeed");
		const boundary = logRecords.find((record) => record.type === "session_compact");
		const handlerEnd = logRecords.findIndex((record) => record.type === "manual_compaction_handler_complete");
		const goalRequests = logRecords.filter((record) => record.type === "provider_call" && record.goalCalls);
		if (boundary?.idle !== false || handlerEnd < 0 || goalRequests.length !== 2) {
			throw new Error("manual compaction did not preserve its busy boundary and exactly one Goal continuation");
		}
		const request = goalRequests[0];
		if (!request || logRecords.indexOf(request) <= handlerEnd) {
			throw new Error("Goal continued before manual compaction handlers finished");
		}
	}
	if (scenario === "compaction") {
		const compactionEnd = records.find((record) => record.type === "compaction_end");
		if (compactionEnd?.reason !== "threshold") {
			throw new Error(`compaction: expected a threshold compaction, received ${JSON.stringify(compactionEnd)}`);
		}
		const completionBoundaries = logRecords.filter(
			(record) => record.type === "session_compact" || record.type === "session_compact_failed",
		);
		if (completionBoundaries.length !== 1) {
			throw new Error(
				`compaction: expected one native compaction completion boundary, received ${JSON.stringify(completionBoundaries)}`,
			);
		}
		const completionBoundary = completionBoundaries[0];
		if (!completionBoundary) throw new Error("compaction: native compaction completion boundary disappeared");
		const completionBoundaryIndex = logRecords.indexOf(completionBoundary);
		const postToolProviderIndex = logRecords.findIndex(
			(record) => record.type === "provider_call" && record.goalCalls === 2,
		);
		if (completionBoundaryIndex < 0 || postToolProviderIndex <= completionBoundaryIndex) {
			throw new Error("compaction: threshold compaction did not finish before the post-Tool Provider request");
		}
		if (completionBoundary.type === "session_compact") {
			if (!compactionEnd || compactionEnd.aborted === true || !compactionEnd.result) {
				throw new Error(
					`compaction: certified host did not complete native compaction successfully: ${JSON.stringify(compactionEnd)}`,
				);
			}
		} else if (compactionEnd?.aborted !== true || completionBoundary.aborted !== true) {
			throw new Error(
				`compaction: certified host did not report the aborted compaction through session_compact_failed: ${JSON.stringify({ compactionEnd, completionBoundary })}`,
			);
		}
		if (logRecords.filter((record) => record.type === "agent_start" && record.duringGoal === true).length !== 1) {
			throw new Error("compaction: Goal did not own exactly one automatic continuation");
		}
		if (!JSON.stringify(sessionEntries).includes("GOAL_POST_TOOL_CANARY")) {
			throw new Error("compaction: raw large Tool result disappeared from the persisted Session");
		}
	}
}

async function seedCompactionHistory(transport: RpcTransport): Promise<void> {
	for (const index of [1, 2]) {
		const settledBefore = transport.records.filter((record) => record.type === "agent_settled").length;
		await transport.send({ type: "prompt", message: `Create historical compaction context ${String(index)}.` });
		const deadline = Date.now() + TIMEOUT_MS;
		while (transport.records.filter((record) => record.type === "agent_settled").length === settledBefore) {
			if (Date.now() >= deadline) throw new Error("compaction: historical prompt did not settle");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}
}

async function writeGoalLifecycleSettings(
	agentDirectory: string,
	packagePath: string,
	scenario: Scenario,
): Promise<void> {
	await writeFile(
		join(agentDirectory, "settings.json"),
		`${JSON.stringify(
			{
				packages: [packagePath],
				compaction: { enabled: false, keepRecentTokens: 14_000, reserveTokens: 6_000 },
				retry: { enabled: scenario === "retry", maxRetries: 2, baseDelayMs: 20 },
			},
			null,
			"\t",
		)}\n`,
	);
}

function reachedTerminalState(
	scenario: Scenario,
	latest: GoalRecord | null | undefined,
	observedActiveGoal: boolean,
	records: readonly RpcRecord[],
): boolean {
	if (SCENARIO_CONTRACTS[scenario].terminalStatus === "blocked") return latest?.status === "blocked";
	return (
		latest === null &&
		observedActiveGoal &&
		(scenario !== "compaction" || records.some((record) => record.type === "compaction_end"))
	);
}

async function waitForTerminalResponse(
	transport: RpcTransport,
	scenario: Scenario,
	logPath: string,
): Promise<{ records: RpcRecord[]; sessionEntries: SessionEntryRecord[]; observedActiveGoal: boolean }> {
	const deadline = Date.now() + TIMEOUT_MS;
	let latestGoalState: GoalRecord | null | undefined;
	let observedActiveGoal = false;
	while (true) {
		if (Date.now() >= deadline) {
			const lifecycleLog = parseRecords(await readFile(logPath, "utf8").catch(() => ""));
			const diagnostics = transport.records
				.filter((record) => record.command !== "get_entries")
				.slice(-30)
				.map((record) => ({
					command: record.command,
					error: record.error,
					event: record.event,
					extensionPath: record.extensionPath,
					id: record.id,
					reason: record.reason,
					success: record.success,
					type: record.type,
				}));
			const appendedGoalEntries = transport.records
				.filter((record) => record.type === "entry_appended")
				.flatMap((record) => (record.entry?.customType === "goal-state" ? [record.entry] : []));
			throw new Error(
				`${scenario}: Goal lifecycle did not reach a terminal state: ${JSON.stringify({ diagnostics, latestGoalState, observedActiveGoal, appendedGoalEntries, lifecycle: lifecycleLog.slice(-50) })}`,
			);
		}
		const entryResponse = await transport.send({ type: "get_entries" }).catch(async (cause: unknown) => {
			const lifecycleLog = parseRecords(await readFile(logPath, "utf8").catch(() => ""));
			throw new Error(
				`${scenario}: get_entries failed during Goal work: ${JSON.stringify({ lifecycle: lifecycleLog.slice(-30), rpc: transport.records.slice(-30) })}`,
				{ cause },
			);
		});
		const sessionEntries = entries(entryResponse);
		const goals = goalStates(sessionEntries).map(goal);
		const appendedGoals = goalStates(
			transport.records
				.filter((record) => record.type === "entry_appended")
				.flatMap((record) => (record.entry ? [record.entry] : [])),
		).map(goal);
		const latest = goals.at(-1);
		latestGoalState = latest;
		observedActiveGoal ||= [...goals, ...appendedGoals].some(
			(candidate) => candidate !== null && candidate.status === "active",
		);
		const contract = SCENARIO_CONTRACTS[scenario];
		if (latest && latest.status !== "active" && latest.status !== contract.terminalStatus) {
			throw new Error(`${scenario}: Goal stopped unexpectedly with status ${latest.status ?? "unknown"}`);
		}
		const terminal = reachedTerminalState(scenario, latest, observedActiveGoal, transport.records);
		const hasFinalResponse = sessionEntries.some((entry) => assistantText(entry).includes(contract.finalResponse));
		const finalResponseEventIndex = transport.records.findIndex(
			(record) => record.type === "message_end" && rpcAssistantText(record).includes(contract.finalResponse),
		);
		const settledAfterFinalResponse = transport.records.some(
			(record, index) => index > finalResponseEventIndex && record.type === "agent_settled",
		);
		if (terminal && hasFinalResponse && finalResponseEventIndex >= 0 && settledAfterFinalResponse) {
			await transport.send({ type: "prompt", message: "/goal-lifecycle-wait" });
			const settledEntries = entries(await transport.send({ type: "get_entries" }));
			return { records: [...transport.records], sessionEntries: settledEntries, observedActiveGoal };
		}
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

function seedManualCompactionSession(directory: string): string {
	const manager = SessionManager.create(directory, join(directory, "sessions"));
	const assistant = createAssistantMessage(PROVIDER, MODEL);
	manager.appendModelChange(PROVIDER, MODEL);
	for (const index of [1, 2]) {
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `Historical request ${String(index)} ${"x".repeat(50_000)}` }],
			timestamp: Date.now(),
		});
		manager.appendMessage(assistant([{ type: "text", text: `Historical result ${"y".repeat(50_000)}` }], "stop"));
	}
	manager.appendCustomEntry("goal-state", { goal: activeGoal("Continue after real manual compaction") });
	const path = manager.getSessionFile();
	if (!path) throw new Error("Manual compaction fixture has no Session file");
	return path;
}

async function runScenario(options: VerifyGoalLifecycleOptions, scenario: Scenario): Promise<void> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), `pi-stuff-goal-${scenario}-`));
	const agentDirectory = join(temporaryDirectory, "agent");
	const logPath = join(temporaryDirectory, "lifecycle.jsonl");
	const fixture = resolve(import.meta.dir, "..", "tests", "fixtures", "goal-lifecycle-provider.ts");
	try {
		await Promise.all([
			mkdir(join(temporaryDirectory, "home"), { recursive: true }),
			mkdir(agentDirectory, { recursive: true }),
		]);
		await Promise.all([
			writeGoalLifecycleSettings(agentDirectory, options.packagePath, scenario),
			disableSessionNamingForTest(agentDirectory),
		]);
		if (scenario === "retry") {
			await writeFile(
				join(agentDirectory, "pi-stuff.json"),
				JSON.stringify({
					sessionNaming: { ...DEFAULT_SESSION_NAMING_SETTINGS, enabled: false },
					goal: { experimental: { goals: true } },
				}),
			);
		}
		const startMessage = SCENARIO_CONTRACTS[scenario].startMessage;
		const sessionPath =
			scenario === "manual-compaction" ? seedManualCompactionSession(temporaryDirectory) : undefined;
		const transport = await createRpcTransport(
			[
				options.piBinary,
				"--mode",
				"rpc",
				"--offline",
				"--no-context-files",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-builtin-tools",
				"--no-approve",
				"--provider",
				PROVIDER,
				"--model",
				MODEL,
				"--session-dir",
				join(temporaryDirectory, "sessions"),
				...(sessionPath ? ["--session", sessionPath] : []),
				"--extension",
				fixture,
			],
			temporaryDirectory,
			environment(temporaryDirectory, scenario, logPath),
		);
		try {
			if (scenario === "compaction") {
				await seedCompactionHistory(transport);
				await transport.send({ enabled: true, type: "set_auto_compaction" });
			}
			await transport.send(
				scenario === "manual-compaction" ? { type: "compact" } : { type: "prompt", message: startMessage },
			);
			const final = await waitForTerminalResponse(transport, scenario, logPath);
			const extensionError = final.records.find((record) => record.type === "extension_error");
			if (extensionError) throw new Error(`${scenario}: Pi extension error: ${JSON.stringify(extensionError)}`);
			const logContents = await readFile(logPath, "utf8").catch(() => "");
			assertScenario(
				scenario,
				final.records,
				final.sessionEntries,
				parseRecords(logContents),
				final.observedActiveGoal,
			);
		} finally {
			await transport.stop();
		}
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

export async function verifyGoalLifecycle(options: VerifyGoalLifecycleOptions): Promise<void> {
	for (const scenario of [
		"normal",
		"code-mode",
		"reload",
		"compaction",
		"manual-compaction",
		"blocker",
		"retry",
	] as const) {
		try {
			await runScenario(options, scenario);
		} catch (cause) {
			throw new Error(`Goal lifecycle scenario ${scenario} failed`, { cause });
		}
	}
}
