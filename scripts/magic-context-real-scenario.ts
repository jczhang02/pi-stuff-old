import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
	isJsonInputObject,
	type JsonInputObject,
	type JsonInputValue,
	parseJsonValue,
} from "../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { verifyRealHostLifecycle } from "./magic-context-real-lifecycle.js";
import { createRpcTransport, parseRpcRecord, type RpcRecord, type RpcTransport } from "./magic-context-real-rpc.js";

const root = resolve(import.meta.dir, "..");
export const MAGIC_CONTEXT_REAL_CONTRACT = {
	contextWindow: 128_000,
	maxOutputTokens: 128_000,
	model: "gpt-5.3-codex-spark",
	provider: "openai-codex",
} as const;
const EXPECTED_MAGIC_CONTEXT_LIMIT =
	MAGIC_CONTEXT_REAL_CONTRACT.contextWindow -
	Math.min(MAGIC_CONTEXT_REAL_CONTRACT.maxOutputTokens, MAGIC_CONTEXT_REAL_CONTRACT.contextWindow * 0.25);
const HISTORIAN_TIMEOUT_MS = 10 * 60_000;
const TARGET_PRESSURE_PERCENTAGE = 82;
const TARGET_PROVIDER_PRESSURE_PERCENTAGE =
	(EXPECTED_MAGIC_CONTEXT_LIMIT / MAGIC_CONTEXT_REAL_CONTRACT.contextWindow) * TARGET_PRESSURE_PERCENTAGE;
const PRESSURE_FILE_BYTES = 48 * 1024;
const TODO_SUBJECT = "Preserve Magic-only acceptance state";
const AUDIT_EXTENSION = join(root, "tests/fixtures/magic-context-real-audit.ts");

const AUDIT_RESULT_SCHEMA = Type.Object(
	{ content: Type.Array(Type.Object({ text: Type.Optional(Type.String()) }, { additionalProperties: true })) },
	{ additionalProperties: true },
);
const TOOL_RESULT_SCHEMA = Type.Object({ isError: Type.Optional(Type.Boolean()) }, { additionalProperties: true });
const MAGIC_COMPACTION_DETAILS_SCHEMA = Type.Object(
	{ source: Type.Literal("magic-context") },
	{ additionalProperties: true },
);
const MAGIC_BOUNDARY_DETAILS_SCHEMA = Type.Object(
	{ lastCompactedOrdinal: Type.Integer({ minimum: 0 }) },
	{ additionalProperties: true },
);
const PROVIDER_USAGE_SCHEMA = Type.Object(
	{
		cacheRead: Type.Optional(Type.Number()),
		cacheWrite: Type.Optional(Type.Number()),
		input: Type.Optional(Type.Number()),
		output: Type.Optional(Type.Number()),
		totalTokens: Type.Optional(Type.Number()),
	},
	{ additionalProperties: true },
);
const PROVIDER_MESSAGE_SCHEMA = Type.Object({ usage: PROVIDER_USAGE_SCHEMA }, { additionalProperties: true });
const GOAL_STATE_DATA_SCHEMA = Type.Object(
	{ goal: Type.Object({ status: Type.String() }, { additionalProperties: true }) },
	{ additionalProperties: true },
);
const SESSION_ENTRY_FIELDS_SCHEMA = Type.Object(
	{
		customType: Type.Optional(Type.String()),
		fromHook: Type.Optional(Type.Boolean()),
		type: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const SESSION_STATE_SCHEMA = Type.Object(
	{
		autoCompactionEnabled: Type.Optional(Type.Boolean()),
		model: Type.Optional(
			Type.Union([
				Type.Null(),
				Type.Object(
					{
						contextWindow: Type.Optional(Type.Number()),
						id: Type.Optional(Type.String()),
						maxTokens: Type.Optional(Type.Number()),
						provider: Type.Optional(Type.String()),
					},
					{ additionalProperties: true },
				),
			]),
		),
		sessionFile: Type.Optional(Type.String()),
		sessionId: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const SESSION_STATS_SCHEMA = Type.Object(
	{
		contextUsage: Type.Optional(
			Type.Object(
				{
					contextWindow: Type.Number(),
					percent: Type.Union([Type.Number(), Type.Null()]),
					tokens: Type.Union([Type.Number(), Type.Null()]),
				},
				{ additionalProperties: true },
			),
		),
	},
	{ additionalProperties: true },
);
const COUNT_ROW_SCHEMA = Type.Object({ count: Type.Number() }, { additionalProperties: true });
const MARKER_ROW_SCHEMA = Type.Object(
	{ marker: Type.Union([Type.Null(), Type.String()]) },
	{ additionalProperties: true },
);
const PROJECT_IDENTITY_ROW_SCHEMA = Type.Object({ projectIdentity: Type.String() }, { additionalProperties: true });
const COMPARTMENT_RANGES_SCHEMA = Type.Array(
	Type.Object({ end: Type.Number(), start: Type.Number() }, { additionalProperties: true }),
);

type ProviderUsage = Static<typeof PROVIDER_USAGE_SCHEMA>;
type SessionState = Static<typeof SESSION_STATE_SCHEMA>;
type SessionStats = Static<typeof SESSION_STATS_SCHEMA>;

interface SessionEntry extends JsonInputObject {
	readonly data?: JsonInputValue;
	readonly details?: JsonInputValue;
	readonly fromHook?: boolean;
	readonly message?: JsonInputValue;
	readonly type?: string;
}

type DatabaseEvidence = ReturnType<typeof readDatabaseEvidence>;
type PressureObservation = Readonly<{ label: string; percent: number; tokens: number }>;

export interface MagicContextScenarioOptions {
	readonly auditPath: string;
	readonly databasePath: string;
	readonly environment: NodeJS.ProcessEnv;
	readonly magicLogPath: string;
	readonly packagePath: string;
	readonly piBinary: string;
	readonly pressureFiles: readonly string[];
	readonly projectA: string;
	readonly projectB: string;
	readonly sessionDirectory: string;
}

interface ScenarioTransports {
	readonly active: Set<RpcTransport>;
	readonly allRecords: RpcRecord[];
	readonly options: MagicContextScenarioOptions;
}

type PrimaryEvidence = Readonly<{
	database: DatabaseEvidence;
	realHost: Awaited<ReturnType<typeof verifyRealHostLifecycle>>;
	sessionFile: string;
	sessionId: string;
}>;

function fail(message: string): never {
	throw new Error(`Magic Context real-provider acceptance failed: ${message}`);
}

function auditRecordContent(record: RpcRecord): string {
	const result = record["result"];
	if (!Check(AUDIT_RESULT_SCHEMA, result)) return "";
	return result.content.map((block) => block.text ?? "").join("\n");
}

function successfulResponse(record: RpcRecord, commandName: string): JsonInputObject {
	if (record.type !== "response" || record.command !== commandName || record.success !== true) {
		fail(`RPC ${commandName} failed: ${JSON.stringify(record)}`);
	}
	return isJsonInputObject(record.data) ? record.data : {};
}

function rpcCommand(
	options: MagicContextScenarioOptions,
	session: { sessionId?: string; sessionPath?: string },
): string[] {
	const commandLine = [
		options.piBinary,
		"--mode",
		"rpc",
		"--offline",
		"--approve",
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-context-files",
		"--no-themes",
		"--extension",
		join(options.packagePath, "index.ts"),
		"--extension",
		AUDIT_EXTENSION,
		"--provider",
		MAGIC_CONTEXT_REAL_CONTRACT.provider,
		"--model",
		MAGIC_CONTEXT_REAL_CONTRACT.model,
		"--thinking",
		"low",
		"--session-dir",
		options.sessionDirectory,
		"--tools",
		"read,TaskCreate,TaskGet,TaskList,TaskUpdate,ctx_memory,ctx_search,goal_complete,goal_blocked",
		"--system-prompt",
		[
			"You are executing a deterministic Pi Stuff acceptance run.",
			"When asked to call named tools, call every named tool exactly as requested; parallel calls are allowed.",
			"When asked to read files, use the read tool once for every listed path and do not summarize file contents.",
			"After requested tools finish, reply only with the requested completion marker unless the prompt explicitly requests continuity values.",
		].join(" "),
	];
	if (session.sessionPath) commandLine.push("--session", session.sessionPath);
	else if (session.sessionId) commandLine.push("--session-id", session.sessionId);
	else fail("RPC launch requires sessionId or sessionPath");
	return commandLine;
}

async function openSession(
	state: ScenarioTransports,
	projectDirectory: string,
	session: { readonly sessionId?: string; readonly sessionPath?: string },
): Promise<RpcTransport> {
	const rpc = await createRpcTransport(
		rpcCommand(state.options, session),
		projectDirectory,
		state.options.environment,
	);
	state.active.add(rpc);
	return rpc;
}

async function closeSession(state: ScenarioTransports, rpc: RpcTransport): Promise<void> {
	state.allRecords.push(...rpc.records);
	await rpc.stop();
	state.active.delete(rpc);
}

function toolEvents(records: readonly RpcRecord[], name: string): RpcRecord[] {
	return records.filter((record) => record.type === "tool_execution_end" && record["toolName"] === name);
}

function assertToolSuccess(records: readonly RpcRecord[], name: string, expectedMinimum = 1): void {
	const events = toolEvents(records, name);
	if (events.length < expectedMinimum) {
		fail(`expected at least ${String(expectedMinimum)} successful ${name} calls, received ${String(events.length)}`);
	}
	for (const event of events) {
		const result = event["result"];
		if (!Check(TOOL_RESULT_SCHEMA, result) || result.isError === true) {
			fail(`${name} returned an error: ${JSON.stringify(event)}`);
		}
	}
}

async function lastAssistantText(rpc: RpcTransport): Promise<string> {
	const data = successfulResponse(await rpc.send({ type: "get_last_assistant_text" }), "get_last_assistant_text");
	return isRuntimeString(data["text"]) ? data["text"] : "";
}

async function sessionState(rpc: RpcTransport): Promise<SessionState> {
	const data = successfulResponse(await rpc.send({ type: "get_state" }), "get_state");
	if (!Check(SESSION_STATE_SCHEMA, data)) fail("get_state returned malformed state");
	return data;
}

async function sessionStats(rpc: RpcTransport): Promise<SessionStats> {
	const data = successfulResponse(await rpc.send({ type: "get_session_stats" }), "get_session_stats");
	if (!Check(SESSION_STATS_SCHEMA, data)) fail("get_session_stats returned malformed statistics");
	return data;
}

async function sessionEntries(rpc: RpcTransport): Promise<SessionEntry[]> {
	const data = successfulResponse(await rpc.send({ type: "get_entries" }), "get_entries");
	const entries = data["entries"];
	if (!Array.isArray(entries)) fail("get_entries returned no entries array");
	return entries.map((entry) => {
		if (!isJsonInputObject(entry) || !Check(SESSION_ENTRY_FIELDS_SCHEMA, entry)) {
			fail("get_entries returned a malformed entry");
		}
		return entry;
	});
}

function observePressure(observations: PressureObservation[], label: string, stats: SessionStats): void {
	const usage = stats.contextUsage;
	if (!usage || usage.tokens === null || usage.percent === null) return;
	observations.push({ label, percent: usage.percent, tokens: usage.tokens });
}

async function runReadTurn(
	rpc: RpcTransport,
	paths: readonly string[],
	marker: string,
	observations: PressureObservation[],
): Promise<void> {
	const records = await rpc.promptAndWait(
		`Use read exactly once for each exact quoted filename, preserving every character including leading zeroes: ${paths.map((path) => JSON.stringify(basename(path))).join(", ")}. After all reads finish, reply exactly ${marker}.`,
	);
	assertToolSuccess(records, "read", paths.length);
	const answer = await lastAssistantText(rpc);
	if (answer.trim() !== marker) fail(`read turn ${marker} returned ${JSON.stringify(answer)}`);
	observePressure(observations, marker, await sessionStats(rpc));
}

function parseSession(path: string): Promise<SessionEntry[]> {
	return readFile(path, "utf8").then((contents) =>
		contents
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const entry = parseJsonValue(line);
				if (!isJsonInputObject(entry) || !Check(SESSION_ENTRY_FIELDS_SCHEMA, entry)) {
					fail(`session ${path} contains a malformed entry`);
				}
				return entry;
			}),
	);
}

function magicCompactions(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.filter(
		(entry) => entry.type === "compaction" && Check(MAGIC_COMPACTION_DETAILS_SCHEMA, entry.details),
	);
}

function nativeCompactions(entries: readonly SessionEntry[]): SessionEntry[] {
	return entries.filter(
		(entry) => entry.type === "compaction" && !Check(MAGIC_COMPACTION_DETAILS_SCHEMA, entry.details),
	);
}

async function waitForCondition<T>(
	read: () => Promise<T | undefined>,
	options: { readonly intervalMs?: number; readonly label: string; readonly timeoutMs: number },
): Promise<T> {
	const deadline = Date.now() + options.timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const result = await read();
			if (result !== undefined) return result;
		} catch (error) {
			lastError = error;
		}
		await Bun.sleep(options.intervalMs ?? 500);
	}
	fail(
		`timed out waiting for ${options.label}${lastError ? `: ${lastError instanceof Error ? lastError.message : String(lastError)}` : ""}`,
	);
}

function readDatabaseEvidence(databasePath: string, sessionId: string) {
	const database = new Database(databasePath, { readonly: true });
	try {
		const count = (sql: string): number => {
			const row = database.query(sql).get(sessionId);
			return Check(COUNT_ROW_SCHEMA, row) ? row.count : 0;
		};
		const marker = database
			.query("SELECT pending_pi_compaction_marker_state AS marker FROM session_meta WHERE session_id = ?")
			.get(sessionId);
		return {
			compartments: count("SELECT COUNT(*) AS count FROM compartments WHERE session_id = ? AND harness = 'pi'"),
			historianFailures: count(
				"SELECT COUNT(*) AS count FROM historian_runs WHERE session_id = ? AND status NOT IN ('success', 'noop')",
			),
			historianSuccesses: count(
				"SELECT COUNT(*) AS count FROM historian_runs WHERE session_id = ? AND status = 'success'",
			),
			pendingMarker: Check(MARKER_ROW_SCHEMA, marker) && marker.marker !== null && marker.marker.length > 0,
		};
	} finally {
		database.close();
	}
}

function readProjectIdentity(databasePath: string, sessionId: string): string {
	const database = new Database(databasePath, { readonly: true });
	try {
		const row = database
			.query("SELECT project_path AS projectIdentity FROM session_projects WHERE session_id = ? AND harness = 'pi'")
			.get(sessionId);
		if (!Check(PROJECT_IDENTITY_ROW_SCHEMA, row) || !row.projectIdentity) {
			fail(`Magic Context stored no project identity for ${sessionId}`);
		}
		return row.projectIdentity;
	} finally {
		database.close();
	}
}

function readCompartmentRanges(databasePath: string, sessionId: string): Static<typeof COMPARTMENT_RANGES_SCHEMA> {
	const database = new Database(databasePath, { readonly: true });
	try {
		const rows = database
			.query(
				"SELECT start_message AS start, end_message AS end FROM compartments WHERE session_id = ? AND harness = 'pi' ORDER BY sequence",
			)
			.all(sessionId);
		if (!Check(COMPARTMENT_RANGES_SCHEMA, rows)) fail("Magic Context returned malformed compartment ranges");
		return rows;
	} finally {
		database.close();
	}
}

function assertStrictlyAdvancing(values: readonly number[], label: string): void {
	for (let index = 1; index < values.length; index += 1) {
		if ((values[index] ?? 0) <= (values[index - 1] ?? 0)) {
			fail(`${label} did not advance strictly: ${JSON.stringify(values)}`);
		}
	}
}

function readMagicPressure(log: string): { contextLimit: number; effectivePercentage: number; rawTokens: number } {
	const matches = [...log.matchAll(/usage=(\d+(?:\.\d+)?)% \((\d+) tokens, limit=(\d+)\)/gu)].map((match) => ({
		contextLimit: Number(match[3]),
		effectivePercentage: Number(match[1]),
		rawTokens: Number(match[2]),
	}));
	const maximum = matches.reduce<(typeof matches)[number] | undefined>(
		(current, candidate) =>
			!current || candidate.effectivePercentage > current.effectivePercentage ? candidate : current,
		undefined,
	);
	if (!maximum) fail("official Magic Context log contained no context-pressure measurements");
	return maximum;
}

function maximumProviderPromptTokens(entries: readonly SessionEntry[]): number {
	return entries.reduce((maximum, entry) => {
		if (entry.type !== "message" || !Check(PROVIDER_MESSAGE_SCHEMA, entry.message)) return maximum;
		const usage = entry.message.usage;
		return Math.max(maximum, (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0));
	}, 0);
}

function latestGoalStatus(entries: readonly SessionEntry[]): string | undefined {
	const goalEntry = entries.filter((entry) => entry.type === "custom" && entry["customType"] === "goal-state").at(-1);
	return goalEntry && Check(GOAL_STATE_DATA_SCHEMA, goalEntry.data) ? goalEntry.data.goal.status : undefined;
}

async function assertInitialState(rpc: RpcTransport): Promise<{ sessionFile: string; sessionId: string }> {
	const state = await sessionState(rpc);
	if (state.autoCompactionEnabled !== false) fail("Pi native auto-compaction was not disabled");
	if (
		state.model?.provider !== MAGIC_CONTEXT_REAL_CONTRACT.provider ||
		state.model.id !== MAGIC_CONTEXT_REAL_CONTRACT.model ||
		state.model.contextWindow !== MAGIC_CONTEXT_REAL_CONTRACT.contextWindow ||
		state.model.maxTokens !== MAGIC_CONTEXT_REAL_CONTRACT.maxOutputTokens
	) {
		fail(`unexpected real model contract: ${JSON.stringify(state.model)}`);
	}
	if (!isRuntimeString(state.sessionFile) || !isRuntimeString(state.sessionId)) {
		fail(`Pi did not expose a durable real session: ${JSON.stringify(state)}`);
	}
	return { sessionFile: state.sessionFile, sessionId: state.sessionId };
}

async function seedContinuity(rpc: RpcTransport, canary: string, observations: PressureObservation[]): Promise<void> {
	const records = await rpc.promptAndWait(
		`The early acceptance canary is ${canary}. Call TaskCreate with subject ${JSON.stringify(TODO_SUBJECT)} and description ${JSON.stringify("A pending task that must survive Magic Context compaction and cold resume.")}. Also call ctx_memory with action write, category PROJECT_RULES, and content ${JSON.stringify(`Durable acceptance recall rule: the exact canary is ${canary}`)}. After both tools succeed, reply exactly MAGIC_SETUP_DONE.`,
	);
	assertToolSuccess(records, "TaskCreate");
	assertToolSuccess(records, "ctx_memory");
	if ((await lastAssistantText(rpc)).trim() !== "MAGIC_SETUP_DONE") fail("setup marker was not returned exactly");
	observePressure(observations, "setup", await sessionStats(rpc));
	const from = rpc.records.length;
	await rpc.send({
		message:
			"/goal Keep the Magic-only acceptance continuity marker active until the maintainer explicitly resumes it",
		type: "prompt",
	});
	await rpc.waitFor((record) => record.type === "agent_start", { from, timeoutMs: 60_000 });
	await rpc.send({ message: "/goal pause", type: "prompt" });
	await rpc.waitFor((record) => record.type === "agent_settled", { from, timeoutMs: 120_000 });
	if (latestGoalStatus(await sessionEntries(rpc)) !== "paused") fail("Goal did not persist a paused continuity state");
}

async function driveMagicPressure(
	rpc: RpcTransport,
	options: MagicContextScenarioOptions,
	identity: { readonly sessionFile: string; readonly sessionId: string },
	observations: PressureObservation[],
): Promise<DatabaseEvidence> {
	await runReadTurn(rpc, options.pressureFiles.slice(0, 2), "MAGIC_SINGLE_TURN_DONE", observations);
	await runReadTurn(rpc, options.pressureFiles.slice(2, 3), "MAGIC_MULTI_TURN_1_DONE", observations);
	const currentTokens = (await sessionStats(rpc)).contextUsage?.tokens ?? 0;
	const earlier = observations.find(({ label }) => label === "MAGIC_SINGLE_TURN_DONE")?.tokens ?? 0;
	const setupTokens = observations.find(({ label }) => label === "setup")?.tokens ?? 0;
	const perFileEstimate = Math.max(5_000, Math.round((earlier - setupTokens) / 2));
	const targetTokens = Math.round((EXPECTED_MAGIC_CONTEXT_LIMIT * TARGET_PRESSURE_PERCENTAGE) / 100);
	const requestedLongReads = Math.max(2, Math.min(7, Math.ceil((targetTokens - currentTokens) / perFileEstimate)));
	let nextFile = 3;
	await runReadTurn(
		rpc,
		options.pressureFiles.slice(nextFile, nextFile + requestedLongReads),
		"MAGIC_CRITICAL_SINGLE_TURN_DONE",
		observations,
	);
	nextFile += requestedLongReads;
	while (
		nextFile < options.pressureFiles.length &&
		Math.max(...observations.map(({ percent }) => percent)) < TARGET_PROVIDER_PRESSURE_PERCENTAGE &&
		magicCompactions(await parseSession(identity.sessionFile)).length === 0
	) {
		await runReadTurn(
			rpc,
			options.pressureFiles.slice(nextFile, nextFile + 1),
			`MAGIC_PRESSURE_${String(nextFile + 1)}_DONE`,
			observations,
		);
		nextFile += 1;
	}

	let historianObserved = false;
	for (let drive = 1; drive <= 3 && !historianObserved; drive += 1) {
		const records = await rpc.promptAndWait(
			`Continue the same acceptance task without reading another file. Reply exactly MAGIC_HISTORIAN_DRIVE_${String(drive)}_DONE.`,
		);
		if (toolEvents(records, "read").length > 0) fail("historian drive unexpectedly read another file");
		observePressure(observations, `historian-drive-${String(drive)}`, await sessionStats(rpc));
		try {
			await waitForCondition(
				async () => {
					const evidence = readDatabaseEvidence(options.databasePath, identity.sessionId);
					return evidence.historianSuccesses > 0 || evidence.compartments > 0 ? evidence : undefined;
				},
				{
					label: "a real historian publication",
					timeoutMs: drive === 3 ? HISTORIAN_TIMEOUT_MS : 15_000,
				},
			);
			historianObserved = true;
		} catch (error) {
			if (drive === 3) throw error;
		}
	}
	const database = await waitForCondition(
		async () => {
			const evidence = readDatabaseEvidence(options.databasePath, identity.sessionId);
			return evidence.historianSuccesses > 0 && evidence.compartments > 0 ? evidence : undefined;
		},
		{ label: "successful historian run and compartment", timeoutMs: HISTORIAN_TIMEOUT_MS },
	);
	let compactions = magicCompactions(await parseSession(identity.sessionFile));
	for (let drive = 1; drive <= 4 && compactions.length === 0; drive += 1) {
		await rpc.promptAndWait(
			`Consume the published Magic Context history without reading files. Reply exactly MAGIC_MARKER_DRIVE_${String(drive)}_DONE.`,
		);
		observePressure(observations, `marker-drive-${String(drive)}`, await sessionStats(rpc));
		compactions = magicCompactions(await parseSession(identity.sessionFile));
	}
	if (compactions.length === 0) fail("Magic Context published no boundary");
	if (compactions.some((entry) => entry.fromHook !== true))
		fail("a Magic boundary was not attributed to the extension hook");
	if (nativeCompactions(await parseSession(identity.sessionFile)).length !== 0) {
		fail("Pi-native compaction appeared in the authoritative JSONL");
	}
	return database;
}

async function verifyContinuity(rpc: RpcTransport, canary: string, coldResume: boolean): Promise<void> {
	const records = await rpc.promptAndWait(
		`${coldResume ? "This is a cold resume. " : ""}Call TaskList and ctx_search with query 'durable acceptance recall rule'. Return exactly two lines: CANARY=<the exact early canary> and TODO=<the pending task subject>.`,
	);
	assertToolSuccess(records, "TaskList");
	assertToolSuccess(records, "ctx_search");
	const text = await lastAssistantText(rpc);
	if (!text.includes(canary) || !text.includes(TODO_SUBJECT)) {
		fail(`${coldResume ? "cold-resume" : "post-boundary"} continuity failed: ${JSON.stringify(text)}`);
	}
	if (latestGoalStatus(await sessionEntries(rpc)) !== "paused") {
		fail(coldResume ? "cold resume lost the paused Goal state" : "Goal state changed across Magic boundary");
	}
}

async function runPrimarySession(
	state: ScenarioTransports,
	canary: string,
	sessionId: string,
	observations: PressureObservation[],
): Promise<PrimaryEvidence> {
	const rpc = await openSession(state, state.options.projectA, { sessionId });
	const identity = await assertInitialState(rpc);
	await seedContinuity(rpc, canary, observations);
	const realHost = await verifyRealHostLifecycle(rpc, identity, canary);
	const database = await driveMagicPressure(rpc, state.options, identity, observations);
	await verifyContinuity(rpc, canary, false);
	await closeSession(state, rpc);
	return { database, realHost, ...identity };
}

async function verifyColdResume(state: ScenarioTransports, primary: PrimaryEvidence, canary: string): Promise<void> {
	const rpc = await openSession(state, state.options.projectA, { sessionPath: primary.sessionFile });
	const resumedState = await sessionState(rpc);
	if (resumedState.autoCompactionEnabled !== false || resumedState.sessionId !== primary.sessionId) {
		fail(`cold resume changed compaction ownership or session identity: ${JSON.stringify(resumedState)}`);
	}
	await verifyContinuity(rpc, canary, true);
	await closeSession(state, rpc);
}

async function drainPendingMarker(state: ScenarioTransports, primary: PrimaryEvidence): Promise<void> {
	// ponytail: two cold-resume passes bound a final async Historian publication; raise only after a
	// reproduced chain needs more than one follow-up drain.
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		if (!readDatabaseEvidence(state.options.databasePath, primary.sessionId).pendingMarker) return;
		const rpc = await openSession(state, state.options.projectA, { sessionPath: primary.sessionFile });
		const marker = `MAGIC_FINAL_DRAIN_${String(attempt)}_DONE`;
		await rpc.promptAndWait(
			`Consume the pending Magic Context marker without reading files. Reply exactly ${marker}.`,
		);
		if ((await lastAssistantText(rpc)).trim() !== marker) {
			fail(`final marker drain ${String(attempt)} did not return its completion marker`);
		}
		await closeSession(state, rpc);
	}
}

async function verifyProjectIsolation(state: ScenarioTransports, sessionId: string, canary: string): Promise<void> {
	const rpc = await openSession(state, state.options.projectB, { sessionId });
	const records = await rpc.promptAndWait(
		"Call ctx_search with query 'durable acceptance recall rule'. If the project has no matching memory, reply exactly MAGIC_PROJECT_ISOLATED.",
	);
	assertToolSuccess(records, "ctx_search");
	if (toolEvents(records, "ctx_search").map(auditRecordContent).join("\n").includes(canary)) {
		fail("a second project retrieved the first project's canary");
	}
	if ((await lastAssistantText(rpc)).trim() !== "MAGIC_PROJECT_ISOLATED") {
		fail("the isolated project did not report an empty project-scoped search");
	}
	await closeSession(state, rpc);
}

async function verifySessionEvidence(state: ScenarioTransports, primary: PrimaryEvidence, canary: string) {
	const entries = await parseSession(primary.sessionFile);
	const magic = magicCompactions(entries);
	const native = nativeCompactions(entries);
	if (magic.length === 0) fail("no Magic boundary survived cold resume");
	if (magic.some((entry) => entry.fromHook !== true))
		fail("a final Magic boundary was not attributed to the extension hook");
	const boundaryOrdinals = magic.map((entry) => {
		if (!Check(MAGIC_BOUNDARY_DETAILS_SCHEMA, entry.details)) {
			fail(`Magic boundary has no valid lastCompactedOrdinal: ${JSON.stringify(entry)}`);
		}
		return entry.details.lastCompactedOrdinal;
	});
	assertStrictlyAdvancing(boundaryOrdinals, "Magic boundary ordinals");
	const raw = await readFile(primary.sessionFile);
	const text = raw.toString("utf8");
	for (const required of ["MAGIC_SETUP_DONE", "MAGIC_SINGLE_TURN_DONE", TODO_SUBJECT, canary]) {
		if (!text.includes(required)) fail(`authoritative JSONL lost ${required === canary ? "the canary" : required}`);
	}
	const auditContents = await readFile(state.options.auditPath, "utf8");
	const audit = auditContents.trim().split("\n").filter(Boolean).map(parseRpcRecord);
	const countRecords = (records: readonly RpcRecord[], type: string): number =>
		records.filter((record) => record.type === type).length;
	const maximumContextCharacters = audit
		.filter((record) => record.type === "context_projection")
		.reduce((maximum, record) => Math.max(maximum, Number(record["characters"] ?? 0)), 0);
	if (maximumContextCharacters < PRESSURE_FILE_BYTES * 4) {
		fail(`instrumented context never contained substantial Tool output: ${String(maximumContextCharacters)} chars`);
	}
	if (audit.some((record) => record.type === "tool_result" && record["isError"] === true)) {
		fail("a real acceptance Tool result failed");
	}
	if (countRecords(audit, "session_before_compact") !== 0 || countRecords(audit, "session_compact") !== 0) {
		fail("Pi native compaction lifecycle events fired despite compaction.enabled=false");
	}
	for (const forbidden of "compaction_start compaction_end auto_retry_start auto_retry_end summarization_retry_scheduled".split(
		" ",
	)) {
		if (countRecords(state.allRecords, forbidden) > 0) fail(`unexpected Pi event ${forbidden} occurred`);
	}
	const extensionErrors = state.allRecords.filter((record) => record.type === "extension_error");
	if (extensionErrors.length > 0) fail(`extension errors occurred: ${JSON.stringify(extensionErrors)}`);
	const visibleUi = state.allRecords.filter(
		(record) =>
			record.type === "extension_ui_request" &&
			/Context full|Magic Context|ctx-flush/iu.test(JSON.stringify(record)),
	);
	if (visibleUi.length > 0) {
		fail(`Magic Context leaked a user-visible emergency or duplicate UI request: ${JSON.stringify(visibleUi)}`);
	}
	return { boundaryOrdinals, entries, magic, maximumContextCharacters, native, raw };
}

function verifyDatabaseEvidence(
	options: MagicContextScenarioOptions,
	primary: PrimaryEvidence,
	isolatedSessionId: string,
	magicBoundaries: number,
) {
	if (primary.database.historianSuccesses < 1 || primary.database.compartments < 1) {
		fail(`historian evidence is incomplete: ${JSON.stringify(primary.database)}`);
	}
	const database = readDatabaseEvidence(options.databasePath, primary.sessionId);
	if (database.historianFailures > 0) fail(`the real historian recorded failures: ${JSON.stringify(database)}`);
	if (database.pendingMarker) fail("Magic deferred compaction marker remained undrained");
	if (database.historianSuccesses !== magicBoundaries) {
		fail(
			`successful Magic publications and boundaries differ: ${JSON.stringify({ boundaries: magicBoundaries, historianSuccesses: database.historianSuccesses })}`,
		);
	}
	const compartmentRanges = readCompartmentRanges(options.databasePath, primary.sessionId);
	if (compartmentRanges.length !== database.compartments) {
		fail(`compartment range evidence is incomplete: ${JSON.stringify(compartmentRanges)}`);
	}
	for (let index = 1; index < compartmentRanges.length; index += 1) {
		if ((compartmentRanges[index]?.start ?? 0) <= (compartmentRanges[index - 1]?.end ?? 0)) {
			fail(`Magic compartments overlap or repeat history: ${JSON.stringify(compartmentRanges)}`);
		}
	}
	const mainIdentity = readProjectIdentity(options.databasePath, primary.sessionId);
	const isolatedIdentity = readProjectIdentity(options.databasePath, isolatedSessionId);
	if (mainIdentity === isolatedIdentity) fail("the two real projects resolved to the same identity");
	return { compartmentRanges, database, isolatedIdentity, mainIdentity };
}

async function providerEvidence(
	entries: readonly SessionEntry[],
	observations: readonly PressureObservation[],
	logPath: string,
) {
	const maximumPressure = observations.reduce(
		(maximum, observation) => (observation.percent > maximum.percent ? observation : maximum),
		{ label: "none", percent: 0, tokens: 0 },
	);
	const magicPressure = readMagicPressure(await readFile(logPath, "utf8"));
	if (magicPressure.contextLimit !== EXPECTED_MAGIC_CONTEXT_LIMIT || magicPressure.effectivePercentage < 80) {
		fail(`official Magic Context never observed the real window's critical region: ${JSON.stringify(magicPressure)}`);
	}
	const providerPromptTokens = maximumProviderPromptTokens(entries);
	if (providerPromptTokens < MAGIC_CONTEXT_REAL_CONTRACT.contextWindow * 0.3) {
		fail(`real provider prompts never carried a substantial long-session context: ${String(providerPromptTokens)}`);
	}
	if (providerPromptTokens >= MAGIC_CONTEXT_REAL_CONTRACT.contextWindow) {
		fail(`a provider request reached or exceeded the real context window: ${String(providerPromptTokens)}`);
	}
	const usage = entries.flatMap((entry) =>
		entry.type === "message" && Check(PROVIDER_MESSAGE_SCHEMA, entry.message) ? [entry.message.usage] : [],
	);
	const sum = (field: keyof ProviderUsage): number => usage.reduce((total, value) => total + (value[field] ?? 0), 0);
	const cacheRead = sum("cacheRead");
	const uncachedInput = sum("input");
	if (cacheRead <= 0) fail("real provider never reported a Prompt Cache hit");
	return { cacheRead, magicPressure, maximumPressure, providerPromptTokens, uncachedInput };
}

export async function runMagicContextRealScenario(options: MagicContextScenarioOptions) {
	const state: ScenarioTransports = { active: new Set(), allRecords: [], options };
	const observations: PressureObservation[] = [];
	const canary = `MC_REAL_${randomUUID().replaceAll("-", "").toUpperCase()}`;
	const mainSessionId = `magic-real-${randomUUID()}`;
	const isolatedSessionId = `magic-isolated-${randomUUID()}`;
	try {
		const primary = await runPrimarySession(state, canary, mainSessionId, observations);
		await verifyColdResume(state, primary, canary);
		await drainPendingMarker(state, primary);
		await verifyProjectIsolation(state, isolatedSessionId, canary);
		const session = await verifySessionEvidence(state, primary, canary);
		const database = verifyDatabaseEvidence(options, primary, isolatedSessionId, session.magic.length);
		const provider = await providerEvidence(session.entries, observations, options.magicLogPath);
		return {
			canary,
			database,
			magicContextLimit: EXPECTED_MAGIC_CONTEXT_LIMIT,
			observations,
			provider,
			realHost: primary.realHost,
			session,
			sessionFile: primary.sessionFile,
			todoSubject: TODO_SUBJECT,
		};
	} catch (error) {
		const diagnostics = [...state.active]
			.map((transport) => transport.stderr().trim())
			.filter(Boolean)
			.join("\n");
		if (diagnostics) console.error(diagnostics.slice(-20_000));
		throw error;
	} finally {
		for (const transport of state.active) await transport.stop().catch(() => undefined);
	}
}
