import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { codeModeHostBinaryPath } from "../packages/pi-stuff/src/code-mode/host/binary.js";
import { isRuntimeNumber, isRuntimeString } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { waitForDetachedProcess } from "./detached-process.js";
import { resolvePiBinary } from "./installed-tools.ts";
import { CERTIFIED_PI_VERSION } from "./pi-host-contract.ts";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/agents-execution-matrix-provider.ts");
const PROCESS_TIMEOUT_MS = 90_000;
const BACKGROUND_SETTLE_TIMEOUT_MS = 60_000;

type ScenarioId =
	| "single-fresh-foreground"
	| "single-fresh-foreground-code-mode"
	| "single-fork-background"
	| "parallel-fresh-background"
	| "parallel-fork-foreground"
	| "aggregate-fanout-foreground"
	| "long-fresh-foreground"
	| "long-fork-foreground";

interface Scenario {
	readonly id: ScenarioId;
	readonly childCount: 1 | 2;
	readonly codeMode?: true;
	readonly context: "fresh" | "fork";
	readonly foreground: boolean;
}

const LOG_RECORD_SCHEMA = Type.Object(
	{
		activeTools: Type.Optional(Type.Array(Type.String())),
		at: Type.Optional(Type.Number()),
		baseExtensionMatches: Type.Optional(Type.Boolean()),
		childBaseExtension: Type.Optional(Type.String()),
		codeModeFrozen: Type.Optional(Type.String()),
		kind: Type.Optional(Type.String()),
		payloadBytes: Type.Optional(Type.Number()),
		ponytailMode: Type.Optional(Type.String()),
		result: Type.Optional(Type.String()),
		round: Type.Optional(Type.Number()),
		sawEvidence: Type.Optional(Type.Boolean()),
		sawRootMarker: Type.Optional(Type.Boolean()),
		sawSteering: Type.Optional(Type.Boolean()),
		sawSuiteSurface: Type.Optional(Type.Boolean()),
		scenario: Type.Optional(Type.String()),
		task: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
type LogRecord = Static<typeof LOG_RECORD_SCHEMA>;

interface ProcessResult {
	readonly exitCode: number;
	readonly stderr: string;
	readonly stdout: string;
	readonly timedOut: boolean;
}

export interface AgentsExecutionMatrixVerificationOptions {
	readonly packagePath: string;
	readonly piBinary: string;
}

const SCENARIOS: readonly Scenario[] = [
	{ id: "single-fresh-foreground", childCount: 1, context: "fresh", foreground: true },
	{
		id: "single-fresh-foreground-code-mode",
		childCount: 1,
		codeMode: true,
		context: "fresh",
		foreground: true,
	},
	{ id: "single-fork-background", childCount: 1, context: "fork", foreground: false },
	{ id: "parallel-fresh-background", childCount: 2, context: "fresh", foreground: false },
	{ id: "parallel-fork-foreground", childCount: 2, context: "fork", foreground: true },
	{ id: "aggregate-fanout-foreground", childCount: 2, context: "fresh", foreground: true },
	{ id: "long-fresh-foreground", childCount: 1, context: "fresh", foreground: true },
	{ id: "long-fork-foreground", childCount: 1, context: "fork", foreground: true },
];

function fail(message: string): never {
	throw new Error(`Agents execution matrix verification failed: ${message}`);
}

async function pathExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

function verifyHostVersion(piBinary: string): void {
	const result = Bun.spawnSync([piBinary, "--version"], { stdout: "pipe", stderr: "pipe" });
	const version = result.stdout.toString().trim();
	if (result.exitCode !== 0 || version !== CERTIFIED_PI_VERSION) {
		fail(`expected Pi ${CERTIFIED_PI_VERSION}, received ${version || `exit ${result.exitCode}`}`);
	}
}

async function runProcess(
	command: readonly string[],
	options: { readonly cwd: string; readonly env: Record<string, string | undefined> },
): Promise<ProcessResult> {
	const child = Bun.spawn([...command], {
		cwd: options.cwd,
		detached: true,
		env: options.env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = new Response(child.stdout).text();
	const stderr = new Response(child.stderr).text();
	const { exitCode, timedOut } = await waitForDetachedProcess(child, PROCESS_TIMEOUT_MS);
	return { exitCode, stdout: await stdout, stderr: await stderr, timedOut };
}

export function parseCompleteLogRecords(contents: string): LogRecord[] {
	const completeEnd = contents.lastIndexOf("\n");
	if (completeEnd < 0) return [];
	return contents
		.slice(0, completeEnd)
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			const record = JSON.parse(line);
			if (!Check(LOG_RECORD_SCHEMA, record)) fail("provider log contains a malformed record");
			return record;
		});
}

async function readRecords(logPath: string): Promise<LogRecord[]> {
	const contents = await readFile(logPath, "utf8").catch(() => "");
	return parseCompleteLogRecords(contents);
}

function scenarioRecords(records: readonly LogRecord[], scenario: ScenarioId): LogRecord[] {
	return records.filter((record) => record.scenario === scenario);
}

async function waitForScenario(logPath: string, scenario: Scenario): Promise<LogRecord[]> {
	const deadline = Date.now() + BACKGROUND_SETTLE_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const records = scenarioRecords(await readRecords(logPath), scenario.id);
		const finished = records.filter((record) => record.kind === "child-finish").length;
		if (records.some((record) => record.kind === "main-result") && finished >= scenario.childCount) return records;
		await Bun.sleep(50);
	}
	return scenarioRecords(await readRecords(logPath), scenario.id);
}

function recordIndex(records: readonly LogRecord[], kind: string): number {
	return records.findIndex((record) => record.kind === kind);
}

function peakChildConcurrency(records: readonly LogRecord[]): number {
	let active = 0;
	let peak = 0;
	for (const record of records) {
		if (record.kind === "child-start") {
			active += 1;
			peak = Math.max(peak, active);
		} else if (record.kind === "child-finish" || record.kind === "child-abort") {
			active = Math.max(0, active - 1);
		}
	}
	return peak;
}

function verifyLongScenario(scenario: Scenario, records: readonly LogRecord[], mainResult: string): void {
	if (!scenario.id.startsWith("long-")) return;
	const longTurns = records.filter((record) => record.kind === "child-long-turn");
	const longTools = records.filter((record) => record.kind === "child-long-tool");
	const steers = records.filter((record) => record.kind === "child-long-steer");
	if (longTools.length !== 8 || longTurns.length !== 9) {
		fail(`long child expected 8 Tool rounds and 9 provider turns, received ${longTools.length}/${longTurns.length}`);
	}
	if (steers.length !== 1 || steers[0]?.round !== 4) {
		fail(`long child expected one steering delivery after round 4, received ${JSON.stringify(steers)}`);
	}
	const retainedContinuation = longTurns.find(
		(record) => isRuntimeNumber(record.round) && record.round >= 5 && record.sawEvidence === true,
	);
	const steeredContinuation = longTurns.find(
		(record) =>
			isRuntimeNumber(record.round) &&
			record.round >= 5 &&
			record.sawEvidence === true &&
			record.sawSteering === true,
	);
	if (!retainedContinuation || !steeredContinuation) {
		fail("long child did not continue after both retained check evidence and mid-run steering");
	}
	const finalTurn = longTurns.find((record) => record.round === 8);
	if (finalTurn?.sawEvidence !== true || finalTurn.sawSteering !== true) {
		fail(`long child final turn lost check evidence or steering authority: ${JSON.stringify(finalTurn)}`);
	}
	if (!mainResult.includes("rounds=8:evidence=true:steering=true")) {
		fail(`long child did not return its stable completion evidence: ${mainResult}`);
	}
}

function verifyScenario(scenario: Scenario, records: readonly LogRecord[], processResult: ProcessResult): void {
	if (processResult.timedOut) fail(`${scenario.id} timed out\n${processResult.stderr}`);
	if (processResult.exitCode !== 0) {
		fail(
			`${scenario.id} exited ${processResult.exitCode}\nstdout:\n${processResult.stdout}\nstderr:\n${processResult.stderr}`,
		);
	}
	if (`${processResult.stdout}\n${processResult.stderr}`.includes("Suite declared unregistered Tools")) {
		fail(`${scenario.id} emitted an unregistered Suite Tool diagnostic`);
	}
	if (!processResult.stdout.includes(`MATRIX_MAIN_RESULT:${scenario.id}`)) {
		fail(`${scenario.id} did not complete the real main Pi turn\nstdout:\n${processResult.stdout}`);
	}

	const launches = records.filter((record) => record.kind === "main-launch");
	const mainResults = records.filter((record) => record.kind === "main-result");
	const starts = records.filter((record) => record.kind === "child-start");
	const finishes = records.filter((record) => record.kind === "child-finish");
	if (launches.length !== 1 || mainResults.length !== 1) {
		fail(`${scenario.id} expected one main launch and result, received ${launches.length} and ${mainResults.length}`);
	}
	if (starts.length !== scenario.childCount || finishes.length !== scenario.childCount) {
		fail(
			`${scenario.id} expected ${scenario.childCount} child starts/finishes, received ${starts.length}/${finishes.length}`,
		);
	}
	if (new Set(starts.map((record) => record.task)).size !== scenario.childCount) {
		fail(`${scenario.id} did not execute ${scenario.childCount} distinct direct-child tasks`);
	}

	for (const start of starts) {
		const expectedMarker = scenario.context === "fork";
		if (start.sawRootMarker !== expectedMarker) {
			fail(
				`${scenario.id} ${scenario.context} child observed root marker=${String(start.sawRootMarker)}; expected ${expectedMarker}`,
			);
		}
		if (start.sawSuiteSurface !== true) {
			fail(`${scenario.id} child did not inherit the Suite UI surface`);
		}
		if (start.ponytailMode !== "full") {
			fail(`${scenario.id} child inherited Ponytail mode ${String(start.ponytailMode)} instead of full`);
		}
		if (start.baseExtensionMatches !== true) {
			fail(
				`${scenario.id} child base extension was ${String(start.childBaseExtension)}; expected the Suite Package entry`,
			);
		}
		const activeTools = Array.isArray(start.activeTools) ? start.activeTools : [];
		if (scenario.codeMode) {
			if (start.codeModeFrozen !== "on") {
				fail(`${scenario.id} child inherited Code Mode as ${String(start.codeModeFrozen)} instead of on`);
			}
			for (const tool of ["codemode", "tool_search", "matrix_blob"]) {
				if (!activeTools.includes(tool)) {
					fail(`${scenario.id} child lost the provider-facing path for ${tool}: ${JSON.stringify(activeTools)}`);
				}
			}
			if (activeTools.includes("read") || activeTools.includes("bash")) {
				fail(`${scenario.id} exposed Suite Tool schemas outside Code Mode: ${JSON.stringify(activeTools)}`);
			}
		} else if (scenario.id === "single-fresh-foreground") {
			for (const tool of ["read", "bash", "matrix_blob"]) {
				if (!activeTools.includes(tool)) {
					fail(`${scenario.id} direct child lost Agent-defined Tool ${tool}: ${JSON.stringify(activeTools)}`);
				}
			}
		}
		const fanoutAuthorized =
			scenario.id === "aggregate-fanout-foreground" &&
			start.task !== "MATRIX_GRANDCHILD_TASK_AGGREGATE_FANOUT_FOREGROUND";
		if (fanoutAuthorized !== activeTools.includes("subagent")) {
			fail(
				`${scenario.id} child subagent authority was ${activeTools.includes("subagent")}; expected ${fanoutAuthorized}`,
			);
		}
	}

	const mainResult = mainResults[0]?.result;
	if (!isRuntimeString(mainResult)) fail(`${scenario.id} main Agent did not receive a textual subagent result`);
	if (scenario.foreground) {
		if (mainResult.includes("started in the background") || !mainResult.includes("completed")) {
			fail(`${scenario.id} did not return foreground child summaries to the main Agent: ${mainResult}`);
		}
	} else if (!mainResult.includes("started in the background")) {
		fail(`${scenario.id} did not return a background launch receipt to the main Agent: ${mainResult}`);
	}

	const mainResultIndex = recordIndex(records, "main-result");
	const childFinishIndexes = records
		.map((record, index) => ({ index, record }))
		.filter(({ record }) => record.kind === "child-finish")
		.map(({ index }) => index);
	if (mainResultIndex < 0 || childFinishIndexes.length !== scenario.childCount) {
		fail(`${scenario.id} has incomplete lifecycle ordering evidence`);
	}
	if (scenario.foreground && childFinishIndexes.some((index) => index > mainResultIndex)) {
		fail(`${scenario.id} main Agent continued before foreground children finished`);
	}
	if (!scenario.foreground && childFinishIndexes.some((index) => index < mainResultIndex)) {
		fail(`${scenario.id} background children finished before the main Agent received its launch receipt`);
	}
	if (scenario.childCount === 2 && peakChildConcurrency(records) < 2) {
		fail(
			`${scenario.id} parallel provider peak concurrency was ${peakChildConcurrency(records)}, expected at least 2`,
		);
	}
	verifyLongScenario(scenario, records, mainResult);
	if (scenario.codeMode && !mainResult.includes("MATRIX_CODE_CHILD_TOOLS_OK")) {
		fail(`${scenario.id} child could not use every resolved Agent Tool: ${mainResult}`);
	}
}

async function runScenario(input: {
	readonly configDirectory: string;
	readonly logPath: string;
	readonly packagePath: string;
	readonly piBinary: string;
	readonly projectDirectory: string;
	readonly scenario: Scenario;
	readonly sessionsDirectory: string;
	readonly temporaryDirectory: string;
}): Promise<void> {
	const marker = `ROOT_CONTEXT_MARKER_${input.scenario.id}_${randomUUID()}`;
	const result = await runProcess(
		[
			input.piBinary,
			"--offline",
			"--approve",
			"--no-extensions",
			"--no-skills",
			"--no-context-files",
			"--extension",
			resolve(input.packagePath),
			"--extension",
			providerExtension,
			"--provider",
			"pi-stuff-agents-execution-matrix",
			"--model",
			"fixture-model",
			"--session-dir",
			input.sessionsDirectory,
			"--session-id",
			`agents-execution-matrix-${input.scenario.id}`,
			"--print",
			`Execute the deterministic ${input.scenario.id} matrix scenario. Private root marker: ${marker}`,
		],
		{
			cwd: input.projectDirectory,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: input.configDirectory,
				PI_SUBAGENT_PI_BINARY: input.piBinary,
				PI_STUFF_AGENTS_EXECUTION_MATRIX_LOG: input.logPath,
				PI_STUFF_AGENTS_EXECUTION_MATRIX_EXPECTED_BASE_EXTENSION: join(resolve(input.packagePath), "index.ts"),
				PI_STUFF_AGENTS_EXECUTION_MATRIX_ROOT_MARKER: marker,
				PI_STUFF_AGENTS_EXECUTION_MATRIX_SCENARIO: input.scenario.id,
				PI_STUFF_CODE_MODE_DEFAULT: input.scenario.codeMode ? "on" : "off",
				PI_STUFF_CODE_MODE_HOST: codeModeHostBinaryPath(),
				PI_STUFF_PONYTAIL_MODE: undefined,
				PONYTAIL_DEFAULT_MODE: "full",
				PONYTAIL_QUIET_STARTUP: "1",
				TERM: "xterm-256color",
				TMPDIR: input.temporaryDirectory,
				XDG_RUNTIME_DIR: join(input.temporaryDirectory, "runtime"),
				XDG_STATE_HOME: join(input.temporaryDirectory, "state"),
			},
		},
	);
	const records = await waitForScenario(input.logPath, input.scenario);
	verifyScenario(input.scenario, records, result);
}

export async function verifyAgentsExecutionMatrix(options: AgentsExecutionMatrixVerificationOptions): Promise<void> {
	verifyHostVersion(options.piBinary);
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-agents-execution-matrix-"));
	const configDirectory = join(temporaryDirectory, "config");
	const agentsDirectory = join(configDirectory, "agents");
	const projectDirectory = join(temporaryDirectory, "project");
	const sessionsDirectory = join(temporaryDirectory, "sessions");
	const logPath = join(temporaryDirectory, "provider.jsonl");
	await Promise.all([
		mkdir(agentsDirectory, { recursive: true }),
		mkdir(projectDirectory),
		mkdir(join(temporaryDirectory, "runtime"), { mode: 0o700 }),
		mkdir(sessionsDirectory),
	]);
	await disableSessionNamingForTest(configDirectory);
	await Promise.all([
		writeFile(join(projectDirectory, "matrix.txt"), "MATRIX_CHILD_FILE_OK\n", { mode: 0o600 }),
		writeFile(
			join(agentsDirectory, "matrix-agent.md"),
			`---
name: matrix-agent
description: Deterministic restricted execution-matrix Agent.
model: pi-stuff-agents-execution-matrix/fixture-model
tools: read, bash, matrix_blob
subagentOnlyExtensions: ${providerExtension}
maxSubagentDepth: 2
systemPromptMode: append
inheritProjectContext: false
inheritSkills: false
---
Return the deterministic matrix result without calling tools.
`,
			{ mode: 0o600 },
		),
		writeFile(
			join(agentsDirectory, "matrix-fanout-agent.md"),
			`---
name: matrix-fanout-agent
description: Deterministic fanout execution-matrix Agent.
model: pi-stuff-agents-execution-matrix/fixture-model
tools: matrix_blob, subagent
subagentOnlyExtensions: ${providerExtension}
maxSubagentDepth: 2
systemPromptMode: append
inheritProjectContext: false
inheritSkills: false
---
Return the deterministic matrix result without calling tools.
`,
			{ mode: 0o600 },
		),
	]);

	try {
		const filter = process.env["PI_STUFF_AGENTS_EXECUTION_MATRIX_FILTER"]?.trim();
		const scenarios = filter ? SCENARIOS.filter((scenario) => scenario.id === filter) : SCENARIOS;
		if (scenarios.length === 0) fail(`unknown scenario filter ${filter}`);
		for (const scenario of scenarios) {
			await runScenario({
				configDirectory,
				logPath,
				packagePath: options.packagePath,
				piBinary: options.piBinary,
				projectDirectory,
				scenario,
				sessionsDirectory,
				temporaryDirectory,
			});
		}
	} catch (error) {
		const log = await readFile(logPath, "utf8").catch(() => "(provider log unavailable)");
		throw new Error(`${error instanceof Error ? error.message : String(error)}\nProvider log:\n${log}`, {
			cause: error,
		});
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
		if (await pathExists(temporaryDirectory)) fail("temporary verification directory was not removed");
	}
}

if (import.meta.main) {
	const PI_BIN = resolvePiBinary();
	await verifyAgentsExecutionMatrix({ piBinary: PI_BIN, packagePath: join(root, "packages/pi-stuff") });
	console.log("Certified Agents single/parallel, fresh/fork, foreground/background execution matrix");
}
