import { Database } from "bun:sqlite";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
	isJsonInputObject,
	type JsonInputObject,
	type JsonInputValue,
	parseJsonValue,
} from "../packages/pi-stuff/src/shared/json-value.js";
import {
	expectProgram,
	nativeCompactionProgram,
	runExpect,
	runResumePaintVerification,
	simpleProgram,
	startupOnlyProgram,
} from "./context-pty-drivers.js";
import { resolvePiBinary } from "./installed-tools.ts";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/context-pty-provider.ts");
const runner = join(root, "tests/fixtures/context-pty-runner.sh");
const MEMORY_EVIDENCE = "真实 Context 检索证据";
const CONTEXT_ACTIVITY_DATA_SCHEMA = Type.Object({ summary: Type.String() }, { additionalProperties: true });
const RECORD_LINE_SCHEMA = Type.Object(
	{
		commands: Type.Optional(Type.Array(Type.String())),
		contextPromptChars: Type.Optional(Type.Number()),
		cwd: Type.Optional(Type.String()),
		hasCompactMagicContextPrompt: Type.Optional(Type.Boolean()),
		hasContextActivityText: Type.Optional(Type.Boolean()),
		hasHistory: Type.Optional(Type.Boolean()),
		hasNativeSummary: Type.Optional(Type.Boolean()),
		hasPonytailPrompt: Type.Optional(Type.Boolean()),
		hasSince: Type.Optional(Type.Boolean()),
		hasVerboseMagicContextPrompt: Type.Optional(Type.Boolean()),
		lastUser: Type.Optional(Type.String()),
		searchResult: Type.Optional(Type.String()),
		sessionId: Type.Optional(Type.String()),
		ponytailMarkerCount: Type.Optional(Type.Number()),
		ponytailPromptChars: Type.Optional(Type.Number()),
		subagent: Type.Optional(Type.Boolean()),
		systemPromptChars: Type.Optional(Type.Number()),
		tools: Type.Optional(Type.Array(Type.String())),
		type: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const SESSION_LINE_FIELDS_SCHEMA = Type.Object(
	{
		customType: Type.Optional(Type.String()),
		type: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const MAGIC_COMPACTION_DETAILS_SCHEMA = Type.Object(
	{ source: Type.Literal("magic-context") },
	{ additionalProperties: true },
);
const COUNT_ROW_SCHEMA = Type.Object({ count: Type.Number() }, { additionalProperties: true });
const PROJECT_PATH_ROW_SCHEMA = Type.Object({ project_path: Type.String() }, { additionalProperties: true });
const PROJECT_PATH_ROWS_SCHEMA = Type.Array(PROJECT_PATH_ROW_SCHEMA);

export interface ContextPtyVerificationOptions {
	readonly piBinary: string;
	readonly packagePath: string;
	readonly columns?: number;
	readonly rows?: number;
}

type RecordLine = Static<typeof RECORD_LINE_SCHEMA>;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface SessionLine extends JsonInputObject {
	readonly customType?: string;
	readonly data?: JsonInputValue;
	readonly type?: string;
	readonly message?: JsonInputValue;
	readonly details?: JsonInputValue;
}

function fail(message: string): never {
	throw new Error(`Context PTY verification failed: ${message}`);
}

function rejectRawMagicContextOutput(output: string, label: string): void {
	const warning = output.match(/\[magic-context\][^\r\n]*/iu)?.[0];
	if (warning) fail(`${label} emitted raw Magic Context output: ${warning}`);
}

async function exists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

function seedNativeCompactedSession(sessionDirectory: string, cwd: string): string {
	const manager = SessionManager.create(cwd, sessionDirectory, { id: "context-native-compacted" });
	manager.appendModelChange("pi-stuff-context-pty", "fixture-model");
	const oldUser: UserMessage = {
		role: "user",
		content: "NATIVE_OLD_HISTORY",
		timestamp: Date.now(),
	};
	const oldAssistant: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "NATIVE_OLD_DONE" }],
		api: "openai-completions",
		provider: "pi-stuff-context-pty",
		model: "fixture-model",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
	manager.appendMessage(oldUser);
	manager.appendMessage(oldAssistant);
	const firstKeptEntryId = manager.appendMessage({
		role: "user",
		content: "NATIVE_TAIL_HISTORY",
		timestamp: Date.now(),
	} satisfies UserMessage);
	manager.appendMessage({
		...oldAssistant,
		content: [{ type: "text", text: "NATIVE_TAIL_DONE" }],
		timestamp: Date.now(),
	});
	manager.appendCompaction("NATIVE_COMPACTION_SUMMARY_MARKER", firstKeptEntryId, 50_000, {
		modifiedFiles: [],
		readFiles: [],
	});
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) fail("native-compacted target session was not persisted");
	return sessionFile;
}

async function readRecords(path: string): Promise<RecordLine[]> {
	const value = await readFile(path, "utf8");
	return value
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const record = JSON.parse(line);
			if (!Check(RECORD_LINE_SCHEMA, record)) fail(`provider log ${path} contains a malformed record`);
			return record;
		});
}

function parseSessionLines(contents: string, path: string): SessionLine[] {
	return contents
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const value = parseJsonValue(line);
			if (!isJsonInputObject(value) || !Check(SESSION_LINE_FIELDS_SCHEMA, value)) {
				fail(`session ${path} contains a malformed record`);
			}
			return value;
		});
}

function sessionText(lines: readonly SessionLine[]): string {
	return lines
		.filter((line) => line.type === "message")
		.map((line) => JSON.stringify(line.message))
		.join("\n");
}

function contextPaths(temporaryDirectory: string) {
	const activationHome = join(temporaryDirectory, "activation-home");
	const activationConfigDirectory = join(temporaryDirectory, "activation-config");
	const activationDataDirectory = join(temporaryDirectory, "activation-data");
	const dataDirectory = join(temporaryDirectory, "data");
	const startupDataDirectory = join(temporaryDirectory, "startup-only-data");
	const xdgConfigDirectory = join(temporaryDirectory, "config");
	const activationLegacyDirectory = join(activationHome, ".pi", "agent");
	return {
		activationAgentDirectory: join(temporaryDirectory, "activation-agent"),
		activationCacheDirectory: join(temporaryDirectory, "activation-cache"),
		activationCanonicalConfig: join(activationConfigDirectory, "cortexkit", "magic-context.jsonc"),
		activationConfigDirectory,
		activationDataDirectory,
		activationDatabase: join(activationDataDirectory, "cortexkit", "magic-context", "context.db"),
		activationHome,
		activationLegacyConfig: join(activationLegacyDirectory, "magic-context.jsonc"),
		activationLegacyDirectory,
		activationLog: join(temporaryDirectory, "activation-requests.jsonl"),
		activationMagicLog: join(temporaryDirectory, "activation-magic-context.log"),
		activationProjectDirectory: join(temporaryDirectory, "activation-project"),
		activationSessionDirectory: join(temporaryDirectory, "activation-sessions"),
		cacheDirectory: join(temporaryDirectory, "cache"),
		configDirectory: join(temporaryDirectory, "agent"),
		cortexConfigDirectory: join(xdgConfigDirectory, "cortexkit"),
		dataDirectory,
		databasePath: join(dataDirectory, "cortexkit", "magic-context", "context.db"),
		directActivationLog: join(temporaryDirectory, "direct-activation-requests.jsonl"),
		directActivationSessionDirectory: join(temporaryDirectory, "direct-activation-sessions"),
		historianMarker: join(temporaryDirectory, "historian-ready"),
		isolatedProjectDirectory: join(temporaryDirectory, "项目隔离", "other-context"),
		magicLog: join(temporaryDirectory, "magic-context.log"),
		nativeCompactedProjectDirectory: join(temporaryDirectory, "项目隔离", "native-compacted"),
		projectDirectory: join(temporaryDirectory, "项目隔离", "context"),
		requestLog: join(temporaryDirectory, "requests.jsonl"),
		sessionDirectory: join(temporaryDirectory, "sessions"),
		startupDataDirectory,
		startupDatabasePath: join(startupDataDirectory, "cortexkit", "magic-context", "context.db"),
		startupLog: join(temporaryDirectory, "startup-only-requests.jsonl"),
		startupSessionDirectory: join(temporaryDirectory, "startup-only-sessions"),
		temporaryDirectory,
		xdgConfigDirectory,
	};
}

type ContextPaths = ReturnType<typeof contextPaths>;

function magicContextConfig(historianTimeoutMs?: number): string {
	return `${JSON.stringify({
		dreamer: { disable: true },
		embedding: { provider: "off" },
		fail_closed_blocking: false,
		historian: {
			opencode: { model: "pi-stuff-context-pty/fixture-model" },
			pi: { model: "pi-stuff-context-pty/fixture-model", thinking_level: "off" },
		},
		historian_timeout_ms: historianTimeoutMs,
		pi: { subagent_extensions: [providerExtension] },
		sidekick: { disable: true },
		toast_duration_ms: 0,
		todowrite: { enabled: false, overlay: false },
	})}\n`;
}

function baseEnvironment(paths: ContextPaths, options: ContextPtyVerificationOptions, columns: number, rows: number) {
	return {
		...process.env,
		HF_HOME: paths.cacheDirectory,
		HF_HUB_OFFLINE: "1",
		HOME: paths.temporaryDirectory,
		MAGIC_CONTEXT_LOG_PATH: paths.magicLog,
		MAGIC_CONTEXT_TEST_DATA_DIR: paths.dataDirectory,
		PI_CODING_AGENT_DIR: paths.configDirectory,
		PI_OFFLINE: "1",
		PI_STUFF_CONTEXT_PTY_BIN: options.piBinary,
		PI_STUFF_CONTEXT_PTY_COLUMNS: String(columns),
		PI_STUFF_CONTEXT_PTY_HISTORIAN_MARKER: paths.historianMarker,
		PI_STUFF_CONTEXT_PTY_LOG: paths.requestLog,
		PI_STUFF_CONTEXT_PTY_PACKAGE: resolve(options.packagePath),
		PI_STUFF_CONTEXT_PTY_PROVIDER_EXTENSION: providerExtension,
		PI_STUFF_CONTEXT_PTY_ROWS: String(rows),
		PI_STUFF_CONTEXT_PTY_RUNNER: runner,
		PI_STUFF_CONTEXT_PTY_SESSIONS: paths.sessionDirectory,
		PI_STUFF_CONTEXT_PTY_SESSION_ID: `context-pty-${String(columns)}x${String(rows)}`,
		PI_TELEMETRY: "0",
		SHELL: "/bin/sh",
		TERM: "xterm-256color",
		TRANSFORMERS_OFFLINE: "1",
		XDG_CACHE_HOME: paths.cacheDirectory,
		XDG_CONFIG_HOME: paths.xdgConfigDirectory,
		XDG_DATA_HOME: undefined,
	};
}

function activationEnvironment(paths: ContextPaths, base: ReturnType<typeof baseEnvironment>) {
	return {
		...base,
		HOME: paths.activationHome,
		MAGIC_CONTEXT_LOG_PATH: paths.activationMagicLog,
		MAGIC_CONTEXT_TEST_DATA_DIR: paths.activationDataDirectory,
		PI_CODING_AGENT_DIR: paths.activationAgentDirectory,
		PI_STUFF_CONTEXT_PTY_AUTOMATIC_ONLY: "1",
		PI_STUFF_CONTEXT_PTY_INITIAL_PROMPT: undefined,
		PI_STUFF_CONTEXT_PTY_LOG: paths.activationLog,
		PI_STUFF_CONTEXT_PTY_SESSIONS: paths.activationSessionDirectory,
		PI_STUFF_CONTEXT_PTY_SESSION_ID: "context-automatic-activation",
		PI_STUFF_CONTEXT_PTY_STARTUP_ONLY: "1",
		XDG_CACHE_HOME: paths.activationCacheDirectory,
		XDG_CONFIG_HOME: paths.activationConfigDirectory,
		XDG_DATA_HOME: undefined,
	};
}

async function prepareContextFixture(options: ContextPtyVerificationOptions) {
	const paths = contextPaths(await mkdtemp(join(tmpdir(), "pi-stuff-context-pty-")));
	await Promise.all(
		[
			[paths.configDirectory, paths.cortexConfigDirectory, paths.dataDirectory],
			[paths.startupDataDirectory, paths.cacheDirectory, paths.projectDirectory],
			[paths.isolatedProjectDirectory, paths.nativeCompactedProjectDirectory],
			[paths.sessionDirectory, paths.startupSessionDirectory, paths.activationHome],
			[paths.activationAgentDirectory, paths.activationConfigDirectory, paths.activationDataDirectory],
			[paths.activationCacheDirectory, paths.activationProjectDirectory, paths.activationSessionDirectory],
			[paths.directActivationSessionDirectory, paths.activationLegacyDirectory],
		]
			.flat()
			.map((path) => mkdir(path, { recursive: true })),
	);
	await Promise.all([
		disableSessionNamingForTest(paths.configDirectory),
		disableSessionNamingForTest(paths.activationAgentDirectory),
		writeFile(paths.requestLog, ""),
		writeFile(paths.startupLog, ""),
		writeFile(paths.activationLog, ""),
		writeFile(paths.directActivationLog, ""),
		writeFile(paths.activationLegacyConfig, magicContextConfig()),
		writeFile(
			join(paths.activationAgentDirectory, "settings.json"),
			`${JSON.stringify({ defaultProjectTrust: "always", quietStartup: true, tuiMode: "fullscreen" })}\n`,
		),
		writeFile(
			join(paths.configDirectory, "settings.json"),
			`${JSON.stringify({ defaultProjectTrust: "always", quietStartup: true, tuiMode: "fullscreen" })}\n`,
		),
		writeFile(join(paths.cortexConfigDirectory, "magic-context.jsonc"), magicContextConfig(30_000)),
	]);
	const columns = options.columns ?? 64;
	const rows = options.rows ?? 28;
	const base = baseEnvironment(paths, options, columns, rows);
	return { ...paths, activationEnvironment: activationEnvironment(paths, base), baseEnvironment: base, columns, rows };
}

type ContextFixture = Awaited<ReturnType<typeof prepareContextFixture>>;

async function verifyActivation(fixture: ContextFixture): Promise<void> {
	const {
		activationCanonicalConfig,
		activationDatabase,
		activationEnvironment,
		activationLegacyConfig,
		activationLegacyDirectory,
		activationLog,
		activationProjectDirectory,
		directActivationLog,
		directActivationSessionDirectory,
	} = fixture;
	const legacyEntriesBefore = await readdir(activationLegacyDirectory);
	const legacyContentBefore = await readFile(activationLegacyConfig, "utf8");
	const automaticOutput = runExpect(
		simpleProgram("automatic"),
		activationEnvironment,
		"automatic activation purity",
		activationProjectDirectory,
	);
	if (!automaticOutput.includes("CONTEXT_FIRST_DONE")) fail("automatic fixture turn did not reach the model");
	if (await exists(activationCanonicalConfig)) {
		fail("automatic Extension turn migrated the legacy Magic Context config");
	}
	if (await exists(activationDatabase)) {
		fail("deferred automatic Extension turn created Magic Context derived state");
	}
	if (JSON.stringify(await readdir(activationLegacyDirectory)) !== JSON.stringify(legacyEntriesBefore)) {
		fail("automatic Extension turn changed the legacy Magic Context config directory");
	}
	if ((await readFile(activationLegacyConfig, "utf8")) !== legacyContentBefore) {
		fail("automatic Extension turn changed the legacy Magic Context config contents");
	}
	const automaticRequests = (await readRecords(activationLog)).filter((record) => record.type === "request");
	if (automaticRequests.length !== 1 || automaticRequests[0]?.hasCompactMagicContextPrompt !== false) {
		fail("deferred automatic Extension turn did not use the native Context path");
	}

	const directOutput = runExpect(
		simpleProgram("direct"),
		{
			...activationEnvironment,
			PI_STUFF_CONTEXT_PTY_AUTOMATIC_ONLY: undefined,
			PI_STUFF_CONTEXT_PTY_INITIAL_PROMPT: "CONTEXT_DIRECT",
			PI_STUFF_CONTEXT_PTY_LOG: directActivationLog,
			PI_STUFF_CONTEXT_PTY_SESSIONS: directActivationSessionDirectory,
			PI_STUFF_CONTEXT_PTY_SESSION_ID: "context-direct-activation",
			PI_STUFF_CONTEXT_PTY_STARTUP_ONLY: undefined,
		},
		"direct activation migration",
		activationProjectDirectory,
	);
	rejectRawMagicContextOutput(directOutput, "direct activation");
	if ((await readFile(activationCanonicalConfig, "utf8")) !== legacyContentBefore) {
		fail("direct activation did not migrate the exact legacy Magic Context config");
	}
	if (await exists(activationLegacyConfig)) {
		fail("direct activation left the migrated legacy Magic Context config active");
	}
	if (!(await exists(`${activationLegacyConfig}.MOVED_READPLEASE`))) {
		fail("direct activation did not preserve the migrated legacy config marker");
	}
	const directRequests = (await readRecords(directActivationLog)).filter((record) => record.type === "request");
	if (directRequests.length !== 1 || directRequests[0]?.hasCompactMagicContextPrompt !== true) {
		fail("direct input did not activate the official Magic Context package");
	}
}

async function startFreshSession(
	fixture: ContextFixture,
): Promise<{ readonly rawLines: SessionLine[]; readonly sessionFile: string }> {
	const {
		baseEnvironment,
		cortexConfigDirectory,
		magicLog,
		projectDirectory,
		sessionDirectory,
		startupDataDirectory,
		startupDatabasePath,
		startupLog,
		startupSessionDirectory,
	} = fixture;
	const startupConfigPath = join(cortexConfigDirectory, "magic-context.jsonc");
	const startupConfigBefore = await readFile(startupConfigPath, "utf8");
	runExpect(
		startupOnlyProgram(),
		{
			...baseEnvironment,
			MAGIC_CONTEXT_TEST_DATA_DIR: startupDataDirectory,
			PI_STUFF_CONTEXT_PTY_LOG: startupLog,
			PI_STUFF_CONTEXT_PTY_SESSIONS: startupSessionDirectory,
			PI_STUFF_CONTEXT_PTY_SESSION_ID: "context-startup-only",
			PI_STUFF_CONTEXT_PTY_STARTUP_ONLY: "1",
			XDG_DATA_HOME: undefined,
		},
		"startup readiness",
		projectDirectory,
	);
	if (!(await exists(startupDatabasePath))) {
		fail("session_start did not finish Magic Context derived-state initialization");
	}
	if ((await readFile(startupConfigPath, "utf8")) !== startupConfigBefore) {
		fail("startup activation mutated the recognized canonical Magic Context config");
	}
	if ((await readRecords(startupLog)).some((record) => record.type === "request")) {
		fail("startup activation unexpectedly reached the model");
	}
	const freshOutput = runExpect(expectProgram(), baseEnvironment, "fresh session", projectDirectory);
	rejectRawMagicContextOutput(freshOutput, "fresh session");
	for (const forbidden of ["Magic Context", "Magic Status", "ctx-aug", "ctx-doctor", "mc:"]) {
		if (freshOutput.includes(forbidden)) {
			const evidence = (await readFile(magicLog, "utf8").catch(() => ""))
				.split("\n")
				.filter((line) => /compact|error|fail/i.test(line))
				.slice(-80)
				.join("\n");
			fail(`fresh TUI exposed forbidden UI text ${forbidden}\nMagic Context log:\n${evidence}`);
		}
	}
	const sessionFiles = (await readdir(sessionDirectory))
		.filter((entry) => entry.endsWith(".jsonl"))
		.map((entry) => join(sessionDirectory, entry));
	if (sessionFiles.length !== 1) fail(`expected one durable session, received ${String(sessionFiles.length)}`);
	const [sessionFile] = sessionFiles;
	if (!sessionFile) fail("durable session file was not found");
	return { rawLines: parseSessionLines(await readFile(sessionFile, "utf8"), sessionFile), sessionFile };
}

async function verifyFreshPersistence(fixture: ContextFixture, rawLines: readonly SessionLine[]): Promise<void> {
	const persisted = sessionText(rawLines);
	const contextActivities = rawLines.filter(
		(line) => line.type === "custom" && line.customType === "pi-stuff-context-activity",
	);
	if (contextActivities.length < 2) {
		fail(`Context command activity was not durably recorded: ${JSON.stringify(contextActivities)}`);
	}
	const activitySummaries = contextActivities.map((line) =>
		Check(CONTEXT_ACTIVITY_DATA_SCHEMA, line.data) ? line.data.summary : undefined,
	);
	if (!activitySummaries.includes("applying queued drops") || !activitySummaries.includes("nothing queued")) {
		fail(`Context command activity lost its anchor or result: ${JSON.stringify(activitySummaries)}`);
	}
	for (const required of [
		"CONTEXT_FIRST",
		"CONTEXT_SECOND",
		"CONTEXT_MEMORY",
		"CONTEXT_SEARCH",
		"CONTEXT_BULK",
		"CONTEXT_AFTER_COMPACT",
		"CONTEXT_SETTLE",
		"CONTEXT_SEARCH_AGAIN",
	]) {
		if (!persisted.includes(required)) {
			const recentRequests = (await readRecords(fixture.requestLog))
				.filter((record) => record.type === "request")
				.slice(-12)
				.map((record) => record.lastUser);
			fail(
				`raw Pi transcript lost ${required}; recent lastUser=${JSON.stringify(recentRequests)}; session tail=${JSON.stringify(rawLines.slice(-20))}`,
			);
		}
	}
	for (const forbidden of ["<session-history>", "<session-history-since>"]) {
		if (persisted.includes(forbidden)) fail(`derived Magic projection leaked into Pi JSONL: ${forbidden}`);
	}
	const database = new Database(fixture.databasePath, { readonly: true });
	try {
		const historianSuccess = database
			.query("SELECT COUNT(*) AS count FROM historian_runs WHERE session_id = ? AND status = 'success'")
			.get(`context-pty-${String(fixture.columns)}x${String(fixture.rows)}`);
		if (!Check(COUNT_ROW_SCHEMA, historianSuccess) || historianSuccess.count < 1) {
			fail("high-pressure turn did not complete a successful Magic Context historian run");
		}
	} finally {
		database.close();
	}
	if (rawLines.some((line) => line.type === "compaction" && !Check(MAGIC_COMPACTION_DETAILS_SCHEMA, line.details))) {
		fail("fresh session appended a Pi-native compaction even though Magic Context owns the transformed view");
	}
}

async function runResumedSession(fixture: ContextFixture, sessionFile: string): Promise<RecordLine[]> {
	let output: string;
	try {
		output = await runResumePaintVerification(
			{ ...fixture.baseEnvironment, PI_STUFF_CONTEXT_PTY_RESUME_SESSION: sessionFile },
			fixture.projectDirectory,
			fixture.magicLog,
		);
	} catch (error) {
		const diagnosticRecords = (await readFile(fixture.requestLog, "utf8").catch(() => "<request log unavailable>"))
			.split("\n")
			.filter(Boolean)
			.slice(-30)
			.join("\n");
		const diagnosticMagicLog = (
			await readFile(fixture.magicLog, "utf8").catch(() => "<Magic Context log unavailable>")
		)
			.split("\n")
			.filter((line) => /historian|subagent|compartment|error|failed/i.test(line))
			.slice(-120)
			.map((line) => (line.length > 1_000 ? `${line.slice(0, 1_000)}…` : line))
			.join("\n");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nContext request records:\n${diagnosticRecords}\nMagic Context log:\n${diagnosticMagicLog}`,
		);
	}
	if (!output.includes("Context search 中文检索标记 · done")) {
		fail(`resumed ctx_search history did not retain the standalone Tool row\n${output}`);
	}
	if (output.includes("category=PROJECT_RULES")) {
		fail("resumed ctx_search history exposed the raw Magic Context result block");
	}
	const resumedLines = parseSessionLines(await readFile(sessionFile, "utf8"), sessionFile);
	const records = await readRecords(fixture.requestLog);
	if (!records.some((record) => record.type === "historian")) {
		const log = await readFile(fixture.magicLog, "utf8").catch(() => "<Magic Context log unavailable>");
		fail(`high-usage session never completed a real Magic Context historian model call\n${log}`);
	}
	const compactions = resumedLines.filter((line) => line.type === "compaction");
	const magicCompactions = compactions.filter((line) => Check(MAGIC_COMPACTION_DETAILS_SCHEMA, line.details));
	if (compactions.length !== magicCompactions.length) {
		fail("resumed high-usage session appended a Pi-native compaction instead of the Magic Context marker");
	}
	if (magicCompactions.length === 0) {
		const database = new Database(fixture.databasePath, { readonly: true });
		try {
			const runs = database.query("SELECT * FROM historian_runs ORDER BY id DESC LIMIT 3").all();
			const compartments = database.query("SELECT * FROM compartments ORDER BY id DESC LIMIT 3").all();
			const relevantLog = (await readFile(fixture.magicLog, "utf8").catch(() => ""))
				.split("\n")
				.filter((line) => /historian|subagent|compartment/i.test(line))
				.slice(-120)
				.join("\n");
			fail(
				`real historian pass did not append a Magic Context compaction marker during resume; runs=${JSON.stringify(runs)} compartments=${JSON.stringify(compartments)}\n${relevantLog}`,
			);
		} finally {
			database.close();
		}
	}
	return records;
}

async function verifyResumeRequests(fixture: ContextFixture, records: readonly RecordLine[]): Promise<string> {
	const inventories = records.filter((record) => record.type === "inventory" && record.subagent !== true);
	if (inventories.length === 0) fail("provider never observed the post-activation command/tool inventory");
	for (const inventory of inventories) {
		const commands = Array.isArray(inventory.commands) ? inventory.commands : [];
		const tools = Array.isArray(inventory.tools) ? inventory.tools : [];
		const contextCommands = commands.filter((command) => command === "ctx" || command.startsWith("ctx-")).sort();
		if (JSON.stringify(contextCommands) !== JSON.stringify(["ctx"])) {
			fail(`focused Magic diagnostics differ: ${JSON.stringify(contextCommands)}`);
		}
		for (const required of ["ctx_search", "ctx_memory", "ctx_note", "ctx_expand", "ctx_reduce"]) {
			if (!tools.includes(required)) fail(`Magic tool ${required} was not active`);
		}
		if (tools.includes("todowrite")) fail("Magic's own Todo surface leaked into Pi Stuff");
	}
	const requests = records.filter((record) => record.type === "request");
	if (requests.length < 8)
		fail(`expected the full fresh/resume request sequence, received ${String(requests.length)}`);
	for (const request of requests) {
		if (request.hasContextActivityText !== false) {
			fail(`model request received Context activity text for ${String(request.lastUser)}`);
		}
		if (request.hasSince !== true) fail(`Magic projection was absent for request ${String(request.lastUser)}`);
		if (request.hasCompactMagicContextPrompt !== true) {
			fail(`compact Magic Context instructions were absent for request ${String(request.lastUser)}`);
		}
		if (request.hasVerboseMagicContextPrompt !== false) {
			fail(`verbose upstream Magic Context instructions leaked into request ${String(request.lastUser)}`);
		}
		if (request.contextPromptChars === undefined || request.contextPromptChars > 8_000) {
			fail(
				`Context system prompt exceeded the separate 8,000-character budget: ${String(request.contextPromptChars)}`,
			);
		}
		if (
			request.hasPonytailPrompt !== true ||
			request.ponytailMarkerCount !== 1 ||
			request.ponytailPromptChars === undefined ||
			request.ponytailPromptChars > 10_000
		) {
			fail(`Ponytail prompt was absent, duplicated, or over budget for ${String(request.lastUser)}`);
		}
	}
	if (!requests.find((record) => record.searchResult !== undefined)?.searchResult?.includes(MEMORY_EVIDENCE)) {
		fail("ctx_search did not retrieve the Chinese memory written through ctx_memory");
	}
	if ((await readFile(fixture.magicLog, "utf8")).includes("embedding model failed to load")) {
		fail("the certified lexical-only profile still attempted to load the incompatible local embedding runtime");
	}
	if (!requests.some((record) => record.lastUser?.includes("CONTEXT_RESUME") === true)) {
		fail(`resumed session did not reach the model: ${JSON.stringify(requests.map((record) => record.lastUser))}`);
	}
	const sessionId = records.find((record) => record.type === "session")?.sessionId;
	if (!sessionId) fail("session identity was not recorded");
	return sessionId;
}

async function verifyIsolationAndNative(fixture: ContextFixture, sessionId: string): Promise<void> {
	const isolationSessionDirectory = join(fixture.temporaryDirectory, "isolation-sessions");
	const isolationLog = join(fixture.temporaryDirectory, "isolation.jsonl");
	await mkdir(isolationSessionDirectory);
	await writeFile(isolationLog, "");
	runExpect(
		simpleProgram("isolation"),
		{
			...fixture.baseEnvironment,
			PI_STUFF_CONTEXT_PTY_INITIAL_PROMPT: "CONTEXT_ISOLATION",
			PI_STUFF_CONTEXT_PTY_LOG: isolationLog,
			PI_STUFF_CONTEXT_PTY_SESSIONS: isolationSessionDirectory,
			PI_STUFF_CONTEXT_PTY_SESSION_ID: "context-isolation",
		},
		"project isolation",
		fixture.isolatedProjectDirectory,
	);
	const isolationRequests = (await readRecords(isolationLog)).filter((record) => record.type === "request");
	const isolationSearch = isolationRequests.find((record) => record.searchResult !== undefined);
	if (!isolationSearch?.searchResult) fail("isolated project did not execute ctx_search");
	if (isolationSearch.searchResult.includes(MEMORY_EVIDENCE)) {
		fail("memory from the first project leaked into the isolated project search");
	}

	const nativeSessionDirectory = join(fixture.temporaryDirectory, "native-compacted-sessions");
	const nativeLog = join(fixture.temporaryDirectory, "native-compacted.jsonl");
	await mkdir(nativeSessionDirectory);
	await writeFile(nativeLog, "");
	const nativeSession = seedNativeCompactedSession(nativeSessionDirectory, fixture.nativeCompactedProjectDirectory);
	runExpect(
		nativeCompactionProgram(),
		{
			...fixture.baseEnvironment,
			PI_STUFF_CONTEXT_PTY_LOG: nativeLog,
			PI_STUFF_CONTEXT_PTY_RESUME_SESSION: nativeSession,
			PI_STUFF_CONTEXT_PTY_SESSIONS: nativeSessionDirectory,
		},
		"native-compacted resume",
		fixture.nativeCompactedProjectDirectory,
	);
	const nativeRequests = (await readRecords(nativeLog)).filter((record) => record.type === "request");
	const nativeResume = nativeRequests.find((record) => record.lastUser?.includes("CONTEXT_NATIVE_RESUME") === true);
	if (nativeResume?.hasSince !== true || nativeResume.hasNativeSummary !== true) {
		fail("Magic Context did not adopt the existing Pi-native compaction summary on resume");
	}
	const nativeRaw = await readFile(nativeSession, "utf8");
	if (!nativeRaw.includes('"type":"compaction"') || !nativeRaw.includes("NATIVE_COMPACTION_SUMMARY_MARKER")) {
		fail("native compaction entry was rewritten or lost during Magic Context adoption");
	}

	const database = new Database(fixture.databasePath, { readonly: true });
	try {
		const ownership = database
			.query("SELECT project_path FROM session_projects WHERE session_id = ? AND harness = 'pi'")
			.get(sessionId);
		if (!Check(PROJECT_PATH_ROW_SCHEMA, ownership)) fail("Magic Context did not persist a Pi-scoped project binding");
		if (!ownership.project_path.startsWith("git:") && !ownership.project_path.startsWith("dir:")) {
			fail(`unexpected project identity ${ownership.project_path}`);
		}
		const isolatedOwnership = database
			.query("SELECT project_path FROM session_projects WHERE session_id = ? AND harness = 'pi'")
			.get("context-isolation");
		if (!Check(PROJECT_PATH_ROW_SCHEMA, isolatedOwnership)) {
			fail("isolated Pi session did not persist its project binding");
		}
		if (isolatedOwnership.project_path === ownership.project_path) {
			fail("distinct project directories resolved to the same Magic Context identity");
		}
		const memoryOwnership = database
			.query("SELECT DISTINCT project_path FROM memories WHERE content LIKE ?")
			.all(`%${MEMORY_EVIDENCE}%`);
		if (!Check(PROJECT_PATH_ROWS_SCHEMA, memoryOwnership)) fail("memory ownership query returned malformed rows");
		if (memoryOwnership.length !== 1 || memoryOwnership[0]?.project_path !== ownership.project_path) {
			fail("written memory was not confined to the originating project identity");
		}
	} finally {
		database.close();
	}
}

async function verifyUnavailable(fixture: ContextFixture): Promise<void> {
	const sessionDirectory = join(fixture.temporaryDirectory, "unavailable-sessions");
	const log = join(fixture.temporaryDirectory, "unavailable.jsonl");
	await mkdir(sessionDirectory);
	await writeFile(log, "");
	const output = runExpect(
		simpleProgram("unavailable"),
		{
			...fixture.baseEnvironment,
			PI_STUFF_CONTEXT_PTY_INITIAL_PROMPT: "CONTEXT_UNAVAILABLE",
			PI_STUFF_CONTEXT_PTY_LOG: log,
			PI_STUFF_CONTEXT_PTY_SESSIONS: sessionDirectory,
			PI_STUFF_CONTEXT_PTY_SESSION_ID: "context-unavailable",
			XDG_DATA_HOME: "/dev/null",
		},
		"unavailable",
		fixture.projectDirectory,
	);
	if (!output.includes("Context could not recover")) fail("Context failure explanation was not rendered");
	const records = (await readRecords(log)).filter((record) => record.type === "request");
	if (records.length !== 0) fail("storage failure allowed a raw-history Provider request");
	const sessions = (await readdir(sessionDirectory)).filter((file) => file.endsWith(".jsonl"));
	const transcripts = await Promise.all(sessions.map((file) => readFile(join(sessionDirectory, file), "utf8")));
	if (!transcripts.some((text) => text.includes("CONTEXT_UNAVAILABLE"))) fail("storage failure lost accepted input");
}

export async function verifyContextPty(options: ContextPtyVerificationOptions): Promise<void> {
	const fixture = await prepareContextFixture(options);
	try {
		await verifyActivation(fixture);
		const { rawLines, sessionFile } = await startFreshSession(fixture);
		await verifyFreshPersistence(fixture, rawLines);

		const records = await runResumedSession(fixture, sessionFile);
		const sessionId = await verifyResumeRequests(fixture, records);
		await verifyIsolationAndNative(fixture, sessionId);
		await verifyUnavailable(fixture);
	} finally {
		await rm(fixture.temporaryDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const PI_BIN = resolvePiBinary();
	await verifyContextPty({ piBinary: PI_BIN, packagePath: join(root, "packages/pi-stuff") });
	console.log(
		"Certified Magic Context in a real 64x28 Pi TUI, including project isolation, native-compaction adoption, lexical recall, resume, and unavailable",
	);
}
