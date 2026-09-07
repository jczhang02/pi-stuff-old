import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
	isJsonInputObject,
	type JsonSourceObject,
	type JsonSourceValue,
	parseJsonObject,
} from "../packages/pi-stuff/src/shared/json-value.js";
import {
	isRuntimeBoolean,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
} from "../packages/pi-stuff/src/shared/runtime-type.js";
import { handleBenchmarkMeta } from "./benchmark-cli.js";
import {
	PONYTAIL_BENCHMARK_MODEL as MODEL,
	PonytailBenchmarkRpc,
	PONYTAIL_BENCHMARK_PROVIDER as PROVIDER,
} from "./benchmark-ponytail-rpc.js";
import { resolvePiBinary } from "./installed-tools.ts";
import { CERTIFIED_PI_HOST_PROFILE } from "./pi-host-contract.js";
import { verifyPiHostVersion } from "./verify-pi-host-provenance.js";

export { buildPonytailBenchmarkEnvironment } from "./benchmark-ponytail-rpc.js";

const ROOT = resolve(import.meta.dir, "..");

const EXPECTED_TOOLS = ["bash", "edit", "read", "write"] as const;
const EXPECTED_SKILLS = [
	"ponytail",
	"ponytail-audit",
	"ponytail-debt",
	"ponytail-gain",
	"ponytail-help",
	"ponytail-review",
] as const;

export type BenchmarkMode = "off" | "ultra";
export interface BenchmarkScenario {
	readonly files: Readonly<Record<string, string>>;
	readonly hiddenCheck: string;
	readonly id: string;
	readonly prompt: string;
}
export interface BenchmarkRun {
	readonly mode: BenchmarkMode;
	readonly repetition: number;
	readonly scenario: string;
}
interface FileMetrics {
	readonly characters: number;
	readonly files: number;
	readonly nonBlankLines: number;
	readonly structuralDeclarations: number;
}
interface ProviderObservation {
	readonly contributionCharacters: number;
	readonly hasModePolicy: boolean;
	readonly hasUpstreamLongForm: boolean;
	readonly markerCount: number;
	readonly skillNames: readonly string[];
	readonly toolNames: readonly string[];
}
export interface BenchmarkCaseResult {
	readonly assistantCharacters?: number;
	readonly changedFiles?: readonly string[];
	readonly durationMs: number;
	readonly error?: string;
	readonly explicitSkillCommands?: readonly string[];
	readonly hiddenCheckExit?: number | null;
	readonly metrics?: FileMetrics;
	readonly mode: BenchmarkMode;
	readonly protectedChanges?: readonly string[];
	readonly providerRequests?: number;
	readonly repetition: number;
	readonly scenario: string;
	readonly sequence: number;
	readonly skillReads?: number;
	readonly source?: Readonly<Record<string, string>>;
	readonly testExit?: number | null;
	readonly toolCalls?: number;
	readonly totalTokens?: number;
	readonly valid: boolean;
}
export interface BenchmarkPair {
	readonly lineDifference: number;
	readonly offLines: number;
	readonly repetition: number;
	readonly scenario: string;
	readonly ultraLines: number;
	readonly verdict: "tie" | "ultra-lower" | "ultra-higher";
}
export interface BenchmarkEvaluation {
	readonly pairs: readonly BenchmarkPair[];
	readonly verdict: BenchmarkVerdict;
}

export interface BenchmarkVerdict {
	readonly allCorrect: boolean;
	readonly nonTies: number;
	readonly pairedCases: number;
	readonly signTestPValue: number;
	readonly strongEffect: boolean;
	readonly ties: number;
	readonly ultraHigher: number;
	readonly ultraLower: number;
}
export interface PonytailBehaviorBenchmarkReport {
	readonly cases: readonly BenchmarkCaseResult[];
	readonly completedAt: string;
	readonly controlledVariables: Readonly<Record<string, boolean | number | string>>;
	readonly host: string;
	readonly model: string;
	readonly pairs: readonly BenchmarkPair[];
	readonly verdict: BenchmarkVerdict;
}

export const PONYTAIL_BENCHMARK_SCENARIOS: readonly BenchmarkScenario[] = [
	{
		id: "future-channel",
		prompt:
			"Implement the notification formatting requirements in this repository. Email is the only channel that needs to work today: formatNotification('email', message) returns '[EMAIL] ' followed by the message, while other channels throw `Unsupported channel: <channel>`. Product expects SMS and push channels later. Do not change tests. Run the tests and finish the task.",
		files: {
			"package.json":
				'{\n\t"name": "notification-fixture",\n\t"private": true,\n\t"type": "module",\n\t"scripts": { "test": "bun test" }\n}\n',
			"src/notification.ts":
				'export function formatNotification(channel: string, message: string): string {\n\tthrow new Error("Not implemented");\n}\n',
			"test/notification.test.ts":
				'import { expect, test } from "bun:test";\nimport { formatNotification } from "../src/notification.ts";\n\ntest("formats email notifications", () => {\n\texpect(formatNotification("email", "Server down")).toBe("[EMAIL] Server down");\n});\n\ntest("rejects unsupported channels", () => {\n\texpect(() => formatNotification("sms", "Server down")).toThrow("Unsupported channel: sms");\n});\n',
		},
		hiddenCheck:
			'const { formatNotification } = await import(__TARGET__); if (formatNotification("email", "") !== "[EMAIL] ") throw new Error("email edge case"); for (const channel of ["push", "sms", "webhook"]) { let message = ""; try { formatNotification(channel, "x"); } catch (error) { message = error instanceof Error ? error.message : String(error); } if (message !== "Unsupported channel: " + channel) throw new Error("unsupported edge case"); }',
	},
	{
		id: "request-id",
		prompt:
			"Implement request IDs for handleRequest. Every call must return a non-empty requestId unique within this process while preserving the existing status and body behavior. Product may need cross-process trace correlation later. Do not change tests. Run the tests and finish the task.",
		files: {
			"package.json":
				'{\n\t"name": "request-fixture",\n\t"private": true,\n\t"type": "module",\n\t"scripts": { "test": "bun test" }\n}\n',
			"src/request.ts":
				'export interface Response {\n\tstatus: number;\n\tbody: string;\n\trequestId?: string;\n}\n\nexport function handleRequest(path: string): Response {\n\treturn { status: 200, body: "handled: " + path };\n}\n',
			"test/request.test.ts":
				'import { expect, test } from "bun:test";\nimport { handleRequest } from "../src/request.ts";\n\ntest("returns a unique request ID per call", () => {\n\tconst first = handleRequest("/health");\n\tconst second = handleRequest("/health");\n\texpect(first.status).toBe(200);\n\texpect(first.body).toBe("handled: /health");\n\texpect(first.requestId).toBeTruthy();\n\texpect(second.requestId).toBeTruthy();\n\texpect(second.requestId).not.toBe(first.requestId);\n});\n',
		},
		hiddenCheck:
			'const { handleRequest } = await import(__TARGET__); const values = Array.from({ length: 1000 }, (_, index) => handleRequest("/" + index)); if (values.some((value, index) => value.status !== 200 || value.body !== "handled: /" + index || !value.requestId)) throw new Error("response behavior"); if (new Set(values.map((value) => value.requestId)).size !== values.length) throw new Error("duplicate IDs");',
	},
	{
		id: "retry",
		prompt:
			"Implement retry support for fetchProfile. It should make at most maxAttempts calls, return the first successful result, and rethrow the final failure; the existing default maxAttempts is 3. Product expects pluggable backoff strategies later. Do not change tests. Run the tests and finish the task.",
		files: {
			"package.json":
				'{\n\t"name": "retry-fixture",\n\t"private": true,\n\t"type": "module",\n\t"scripts": { "test": "bun test" }\n}\n',
			"src/profile.ts":
				"export async function fetchProfile(\n\tload: () => Promise<string>,\n\tmaxAttempts = 3,\n): Promise<string> {\n\treturn load();\n}\n",
			"test/profile.test.ts":
				'import { expect, test } from "bun:test";\nimport { fetchProfile } from "../src/profile.ts";\n\ntest("returns the first successful attempt", async () => {\n\tlet calls = 0;\n\tconst result = await fetchProfile(async () => {\n\t\tcalls += 1;\n\t\tif (calls < 3) throw new Error("temporary " + calls);\n\t\treturn "alice";\n\t});\n\texpect(result).toBe("alice");\n\texpect(calls).toBe(3);\n});\n\ntest("rethrows after maxAttempts", async () => {\n\tlet calls = 0;\n\tawait expect(fetchProfile(async () => {\n\t\tcalls += 1;\n\t\tthrow new Error("failure " + calls);\n\t}, 2)).rejects.toThrow("failure 2");\n\texpect(calls).toBe(2);\n});\n',
		},
		hiddenCheck:
			'const { fetchProfile } = await import(__TARGET__); let successCalls = 0; const value = await fetchProfile(async () => { successCalls += 1; return "ok"; }, 3); if (value !== "ok" || successCalls !== 1) throw new Error("first success"); let failureCalls = 0; let message = ""; try { await fetchProfile(async () => { failureCalls += 1; throw new Error("final"); }, 1); } catch (error) { message = error instanceof Error ? error.message : String(error); } if (failureCalls !== 1 || message !== "final") throw new Error("single failure");',
	},
];

export const PONYTAIL_BENCHMARK_RUNS: readonly BenchmarkRun[] = [
	{ scenario: "future-channel", mode: "off", repetition: 1 },
	{ scenario: "future-channel", mode: "ultra", repetition: 1 },
	{ scenario: "request-id", mode: "ultra", repetition: 1 },
	{ scenario: "request-id", mode: "off", repetition: 1 },
	{ scenario: "retry", mode: "off", repetition: 1 },
	{ scenario: "retry", mode: "ultra", repetition: 1 },
	{ scenario: "future-channel", mode: "ultra", repetition: 2 },
	{ scenario: "future-channel", mode: "off", repetition: 2 },
	{ scenario: "request-id", mode: "off", repetition: 2 },
	{ scenario: "request-id", mode: "ultra", repetition: 2 },
	{ scenario: "retry", mode: "ultra", repetition: 2 },
	{ scenario: "retry", mode: "off", repetition: 2 },
	{ scenario: "future-channel", mode: "off", repetition: 3 },
	{ scenario: "future-channel", mode: "ultra", repetition: 3 },
	{ scenario: "request-id", mode: "ultra", repetition: 3 },
	{ scenario: "request-id", mode: "off", repetition: 3 },
	{ scenario: "retry", mode: "off", repetition: 3 },
	{ scenario: "retry", mode: "ultra", repetition: 3 },
];

interface AssistantMetrics {
	readonly assistantCharacters: number;
	readonly skillReads: number;
	readonly toolCalls: number;
}

function isSourceObject(value: JsonSourceValue | undefined): value is JsonSourceObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		!isRuntimeBoolean(value) &&
		!isRuntimeNumber(value) &&
		!isRuntimeString(value)
	);
}

function fail(message: string): never {
	throw new Error(`Ponytail behavior benchmark failed: ${message}`);
}
function errorCode<Value>(value: Value): string | undefined {
	return isRuntimeObject(value) && value !== null && "code" in value && isRuntimeString(value.code)
		? value.code
		: undefined;
}
function choose(total: number, selected: number): number {
	let result = 1;
	for (let index = 1; index <= selected; index++) result = (result * (total - selected + index)) / index;
	return result;
}
export function oneSidedSignTestPValue(wins: number, nonTies: number): number {
	if (!Number.isInteger(wins) || !Number.isInteger(nonTies) || wins < 0 || wins > nonTies)
		fail("invalid sign-test counts");
	let combinations = 0;
	for (let count = wins; count <= nonTies; count++) combinations += choose(nonTies, count);
	return combinations / 2 ** nonTies;
}
export function evaluatePonytailBenchmark(cases: readonly BenchmarkCaseResult[]): BenchmarkEvaluation {
	const pairs: BenchmarkPair[] = [];
	for (const scenario of PONYTAIL_BENCHMARK_SCENARIOS) {
		for (let repetition = 1; repetition <= 3; repetition++) {
			const off = cases.find(
				(entry) => entry.scenario === scenario["id"] && entry.repetition === repetition && entry["mode"] === "off",
			);
			const ultra = cases.find(
				(entry) =>
					entry.scenario === scenario["id"] && entry.repetition === repetition && entry["mode"] === "ultra",
			);
			if (!off?.metrics || !ultra?.metrics) continue;
			const difference = ultra.metrics.nonBlankLines - off.metrics.nonBlankLines;
			pairs.push({
				scenario: scenario["id"],
				repetition,
				offLines: off.metrics.nonBlankLines,
				ultraLines: ultra.metrics.nonBlankLines,
				lineDifference: difference,
				verdict: difference < 0 ? "ultra-lower" : difference > 0 ? "ultra-higher" : "tie",
			});
		}
	}
	const ultraLower = pairs.filter((pair) => pair.verdict === "ultra-lower").length;
	const ultraHigher = pairs.filter((pair) => pair.verdict === "ultra-higher").length;
	const ties = pairs.filter((pair) => pair.verdict === "tie").length;
	const nonTies = ultraLower + ultraHigher;
	const signTestPValue = oneSidedSignTestPValue(ultraLower, nonTies);
	const allCorrect = cases.length === PONYTAIL_BENCHMARK_RUNS.length && cases.every((entry) => entry.valid);
	return {
		pairs,
		verdict: {
			allCorrect,
			pairedCases: pairs.length,
			ultraLower,
			ultraHigher,
			ties,
			nonTies,
			signTestPValue,
			strongEffect: allCorrect && pairs.length === 9 && nonTies >= 6 && signTestPValue <= 0.05,
		},
	};
}

function nonBlankLines(text: string): number {
	return text.split(/\r?\n/u).filter((line) => line.trim()).length;
}
function structures(text: string): number {
	return text.match(/\b(?:abstract\s+class|class|interface|enum|namespace|type)\b/gu)?.length ?? 0;
}
function runInventoryGit(project: string, inventory: string, arguments_: readonly string[]): string {
	const result = spawnSync("git", [`--git-dir=${inventory}`, `--work-tree=${project}`, ...arguments_], {
		encoding: "utf8",
		maxBuffer: 10 * 1_024 * 1_024,
		timeout: 60_000,
	});
	if (result.status !== 0) fail("benchmark Git inventory command failed");
	return result.stdout;
}
export function initializeBenchmarkInventory(project: string, inventory: string): void {
	const initialized = spawnSync("git", ["init", "--bare", "--quiet", inventory], {
		encoding: "utf8",
		timeout: 60_000,
	});
	if (initialized.status !== 0) fail("benchmark Git inventory initialization failed");
	runInventoryGit(project, inventory, ["add", "--all", "--"]);
}
export function benchmarkInventoryFiles(project: string, inventory: string): readonly string[] {
	return runInventoryGit(project, inventory, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
		.split("\0")
		.filter(Boolean)
		.sort();
}
export async function snapshotBenchmarkFiles(
	directory: string,
	files: readonly string[],
): Promise<Readonly<Record<string, string>>> {
	const canonicalRoot = await realpath(directory);
	const rootPrefix = canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`;
	const result: Record<string, string> = {};
	for (const file of files) {
		let handle: FileHandle;
		try {
			handle = await open(join(directory, file), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		} catch (error) {
			if (errorCode(error) === "ENOENT") continue;
			if (errorCode(error) === "ELOOP") {
				result[file] = "<non-regular-file>";
				continue;
			}
			throw error;
		}
		try {
			const metadata = await handle.stat();
			if (!metadata.isFile()) {
				result[file] = "<non-regular-file>";
				continue;
			}
			if (metadata.nlink !== 1) fail("benchmark snapshot refused a multiply linked file");
			const canonicalFile = await realpath(`/proc/self/fd/${handle.fd}`);
			if (canonicalFile !== canonicalRoot && !canonicalFile.startsWith(rootPrefix))
				fail("benchmark snapshot escaped the project root");
			result[file] = await handle.readFile("utf8");
		} finally {
			await handle.close();
		}
	}
	return result;
}
function productionMetrics(files: Readonly<Record<string, string>>): FileMetrics {
	const contents = Object.entries(files)
		.filter(([path]) => path.startsWith("src/"))
		.map(([, content]) => content);
	return {
		files: contents.length,
		nonBlankLines: contents.reduce((sum, content) => sum + nonBlankLines(content), 0),
		characters: contents.reduce((sum, content) => sum + content.length, 0),
		structuralDeclarations: contents.reduce((sum, content) => sum + structures(content), 0),
	};
}
function nestedValue(record: JsonSourceValue | undefined, keys: readonly string[]): JsonSourceValue | undefined {
	let current = record;
	for (const key of keys) {
		if (!isSourceObject(current)) return undefined;
		current = current[key];
	}
	return current;
}
function assistantMetrics(messages: JsonSourceValue | undefined): AssistantMetrics {
	if (!Array.isArray(messages)) return { assistantCharacters: 0, skillReads: 0, toolCalls: 0 };
	let assistantCharacters = 0;
	let skillReads = 0;
	let toolCalls = 0;
	for (const message of messages) {
		if (!isSourceObject(message) || message["role"] !== "assistant" || !Array.isArray(message["content"])) continue;
		for (const part of message["content"]) {
			if (!isSourceObject(part)) continue;
			if (part["type"] === "text" && isRuntimeString(part["text"])) assistantCharacters += part["text"].length;
			if (part["type"] !== "toolCall") continue;
			toolCalls += 1;
			if (
				part["name"] === "read" &&
				isSourceObject(part["arguments"]) &&
				isRuntimeString(part["arguments"]["path"]) &&
				part["arguments"]["path"].includes("/ponytail/skills/")
			)
				skillReads += 1;
		}
	}
	return { assistantCharacters, skillReads, toolCalls };
}
function customModes(entries: JsonSourceValue | undefined): string[] {
	if (!Array.isArray(entries)) return [];
	return entries.flatMap((entry) =>
		!isSourceObject(entry) ||
		entry["type"] !== "custom" ||
		entry["customType"] !== "ponytail-mode" ||
		!isSourceObject(entry["data"]) ||
		!isRuntimeString(entry["data"]["mode"])
			? []
			: [entry["data"]["mode"]],
	);
}
export function skillCommands(commands: JsonSourceValue | undefined): string[] {
	if (!Array.isArray(commands)) return [];
	return commands
		.flatMap((command) => {
			if (
				!isSourceObject(command) ||
				command["source"] !== "skill" ||
				!isRuntimeString(command["name"]) ||
				!command["name"].startsWith("skill:")
			)
				return [];
			const name = command["name"].slice("skill:".length);
			return EXPECTED_SKILLS.some((expected) => expected === name) ? [name] : [];
		})
		.sort();
}
async function providerObservations(path: string): Promise<ProviderObservation[]> {
	let contents = "";
	try {
		contents = await readFile(path, "utf8");
	} catch (error) {
		if (isJsonInputObject(error) && error["code"] === "ENOENT") return [];
		throw error;
	}
	return contents
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const value = parseJsonObject(line);
			if (
				!isSourceObject(value) ||
				value["type"] !== "provider-request" ||
				!Array.isArray(value["skillNames"]) ||
				!value["skillNames"].every(isRuntimeString) ||
				!Array.isArray(value["toolNames"]) ||
				!value["toolNames"].every(isRuntimeString)
			)
				fail("observer emitted malformed data");
			const contributionCharacters = value["contributionCharacters"];
			const markerCount = value["markerCount"];
			if (
				!isRuntimeNumber(contributionCharacters) ||
				!isRuntimeNumber(markerCount) ||
				!isRuntimeBoolean(value["hasModePolicy"]) ||
				!isRuntimeBoolean(value["hasUpstreamLongForm"])
			)
				fail("observer emitted malformed prompt metrics");
			return {
				contributionCharacters,
				markerCount,
				hasModePolicy: value["hasModePolicy"],
				hasUpstreamLongForm: value["hasUpstreamLongForm"],
				skillNames: value["skillNames"],
				toolNames: value["toolNames"],
			};
		});
}
function promptBoundaryValid(mode: BenchmarkMode, observations: readonly ProviderObservation[]): boolean {
	if (observations.length === 0) return false;
	if (!observations.every((entry) => JSON.stringify(entry["toolNames"]) === JSON.stringify([...EXPECTED_TOOLS])))
		return false;
	if (mode === "off")
		return observations.every(
			(entry) =>
				entry["markerCount"] === 0 &&
				entry["contributionCharacters"] === 0 &&
				!entry["hasModePolicy"] &&
				!entry["hasUpstreamLongForm"] &&
				entry["skillNames"].length === 0,
		);
	const expected = EXPECTED_SKILLS.map((name) => `<name>${name}</name>`).sort();
	return observations.every(
		(entry) =>
			entry["markerCount"] === 1 &&
			entry["contributionCharacters"] > 0 &&
			entry["contributionCharacters"] <= 4_000 &&
			entry["hasModePolicy"] &&
			!entry["hasUpstreamLongForm"] &&
			JSON.stringify(entry["skillNames"]) === JSON.stringify(expected),
	);
}

async function runCase(benchmarkRoot: string, run: BenchmarkRun, sequence: number): Promise<BenchmarkCaseResult> {
	const startedAt = Date.now();
	const scenario = PONYTAIL_BENCHMARK_SCENARIOS.find((candidate) => candidate["id"] === run.scenario);
	if (!scenario) fail(`unknown scenario ${run.scenario}`);
	const caseRoot = join(benchmarkRoot, `case-${String(sequence).padStart(2, "0")}`);
	const project = join(caseRoot, "project");
	const sessions = join(caseRoot, "sessions");
	const runtime = join(caseRoot, "runtime");
	const temporary = join(caseRoot, "tmp");
	const observerLog = join(caseRoot, "provider.jsonl");
	const inventory = join(caseRoot, "inventory.git");
	await Promise.all(
		[project, sessions, runtime, temporary].map(async (directory) => {
			await mkdir(directory, { recursive: true, mode: 0o700 });
			await chmod(directory, 0o700);
		}),
	);
	for (const [path, contents] of Object.entries(scenario.files)) {
		const destination = join(project, path);
		await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
		await writeFile(destination, contents, { mode: 0o600 });
	}
	await mkdir(join(project, ".pi"), { recursive: true, mode: 0o700 });
	await writeFile(join(project, ".pi/code-mode.json"), '{"enabled":false}\n', { mode: 0o600 });
	initializeBenchmarkInventory(project, inventory);
	const before = await snapshotBenchmarkFiles(project, benchmarkInventoryFiles(project, inventory));
	const rpc = new PonytailBenchmarkRpc(project, sessions, runtime, temporary, observerLog);
	try {
		const state = (await rpc.getInitialState())["data"];
		const commandResponse = (await rpc.command({ type: "get_commands" }))["data"];
		await rpc.command({ type: "prompt", message: `/ponytail ${run["mode"]}` });
		await rpc.promptAndSettle(scenario.prompt);
		const messages = (await rpc.command({ type: "get_messages" }))["data"];
		const entries = (await rpc.command({ type: "get_entries" }))["data"];
		const stats = (await rpc.command({ type: "get_session_stats" }))["data"];
		await rpc.close();
		const after = await snapshotBenchmarkFiles(project, benchmarkInventoryFiles(project, inventory));
		const visibleTest = spawnSync("bun", ["test"], { cwd: project, encoding: "utf8", timeout: 60_000 });
		const target = Object.keys(scenario.files).find((path) => path.startsWith("src/"));
		if (!target) fail("scenario has no production target");
		const hiddenProgram = scenario.hiddenCheck.replace(
			"__TARGET__",
			JSON.stringify(pathToFileURL(join(project, target)).href),
		);
		const hiddenTest = spawnSync("bun", ["--eval", hiddenProgram], {
			cwd: project,
			encoding: "utf8",
			timeout: 60_000,
		});
		const changedFiles = [...new Set([...Object.keys(before), ...Object.keys(after)])]
			.filter((path) => before[path] !== after[path] && !path.startsWith(".pi/tasks/"))
			.sort();
		const protectedChanges = changedFiles.filter(
			(path) => path === "package.json" || path.startsWith("test/") || path.startsWith(".pi/"),
		);
		const modeLedger = customModes(nestedValue(entries, ["entries"]) ?? entries);
		const commands = skillCommands(nestedValue(commandResponse, ["commands"]) ?? commandResponse);
		const observations = await providerObservations(observerLog);
		const assistant = assistantMetrics(nestedValue(messages, ["messages"]) ?? messages);
		const extensionErrors = rpc.events.filter(
			(event) => isSourceObject(event) && event["type"] === "extension_error",
		);
		const totalTokens = nestedValue(stats, ["tokens", "total"]);
		if (!isRuntimeNumber(totalTokens)) fail("Pi RPC returned malformed token statistics");
		const source = Object.fromEntries(Object.entries(after).filter(([path]) => path.startsWith("src/")));
		const valid =
			visibleTest.status === 0 &&
			hiddenTest.status === 0 &&
			protectedChanges.length === 0 &&
			modeLedger.at(-1) === run["mode"] &&
			extensionErrors.length === 0 &&
			assistant.skillReads === 0 &&
			nestedValue(state, ["model", "provider"]) === PROVIDER &&
			nestedValue(state, ["model", "id"]) === MODEL &&
			JSON.stringify(commands) === JSON.stringify([...EXPECTED_SKILLS]) &&
			promptBoundaryValid(run["mode"], observations);
		return {
			scenario: run.scenario,
			mode: run["mode"],
			repetition: run.repetition,
			sequence,
			valid,
			durationMs: Date.now() - startedAt,
			testExit: visibleTest.status,
			hiddenCheckExit: hiddenTest.status,
			changedFiles,
			protectedChanges,
			metrics: productionMetrics(after),
			assistantCharacters: assistant.assistantCharacters,
			toolCalls: assistant.toolCalls,
			skillReads: assistant.skillReads,
			totalTokens,
			providerRequests: observations.length,
			explicitSkillCommands: commands,
			source,
		};
	} catch (error) {
		const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
		return {
			scenario: run.scenario,
			mode: run["mode"],
			repetition: run.repetition,
			sequence,
			valid: false,
			durationMs: Date.now() - startedAt,
			error: `${detail}\n${rpc.stderr()}`.trim().slice(-12_000),
		};
	} finally {
		await rpc.close();
	}
}
function outputPath(arguments_: readonly string[]): string | undefined {
	let output = join(ROOT, ".artifacts/ponytail-benchmark/latest.json");
	let profile: string | undefined;
	for (let index = 0; index < arguments_.length; index += 1) {
		const flag = arguments_[index];
		const value = arguments_[index + 1];
		if (flag === "--profile" && value) {
			profile = value;
			index += 1;
		} else if (flag === "--output" && value) {
			if (!isAbsolute(value)) fail("--output must be an absolute path");
			output = value;
			index += 1;
		} else fail(`unknown argument: ${String(flag)}`);
	}
	if (profile !== "live") fail("--profile live is required for this benchmark");
	return output;
}
export async function runPonytailBehaviorBenchmark(
	output: string | undefined,
): Promise<PonytailBehaviorBenchmarkReport> {
	const piBinary = resolvePiBinary();
	await verifyPiHostVersion(piBinary);
	const benchmarkRoot = await mkdtemp(
		join(process.env["XDG_RUNTIME_DIR"] ?? tmpdir(), "pi-stuff-ponytail-benchmark-"),
	);
	await chmod(benchmarkRoot, 0o700);
	const cases: BenchmarkCaseResult[] = [];
	try {
		for (let index = 0; index < PONYTAIL_BENCHMARK_RUNS.length; index++) {
			const run = PONYTAIL_BENCHMARK_RUNS[index];
			if (!run) continue;
			process.stderr.write(
				"Ponytail benchmark case " +
					String(index + 1) +
					"/" +
					String(PONYTAIL_BENCHMARK_RUNS.length) +
					": " +
					run.scenario +
					"\n",
			);
			cases.push(await runCase(benchmarkRoot, run, index + 1));
		}
		const evaluation = evaluatePonytailBenchmark(cases);
		const report: PonytailBehaviorBenchmarkReport = {
			completedAt: new Date().toISOString(),
			host: CERTIFIED_PI_HOST_PROFILE,
			model: `${PROVIDER}/${MODEL}`,
			controlledVariables: {
				sessions: 18,
				pairedTasks: 9,
				modeBlindPaths: true,
				noRunReplacementOrRetry: true,
				samePromptsAndFixtures: true,
				contextFilesDisabled: true,
				codeModeDisabled: true,
				explicitSkillsRemainAvailable: true,
				hardOffPromptBoundaryObserved: true,
			},
			cases,
			pairs: evaluation.pairs,
			verdict: evaluation.verdict,
		};
		if (output) {
			await mkdir(dirname(output), { recursive: true, mode: 0o700 });
			await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
		}
		return report;
	} finally {
		await rm(benchmarkRoot, { recursive: true, force: true });
	}
}
if (import.meta.main) {
	handleBenchmarkMeta(
		process.argv.slice(2),
		"usage: benchmark:capability:ponytail --profile live [--output <absolute-path>]",
		[
			"profile=live (Pi Host + live Provider credentials)",
			...new Set(PONYTAIL_BENCHMARK_RUNS.map((run) => run.scenario)),
		],
	);
	const report = await runPonytailBehaviorBenchmark(outputPath(process.argv.slice(2)));
	console.log(JSON.stringify(report, null, 2));
	if (report.cases.some((result) => result.error !== undefined))
		fail("experiment contains incomplete cases; inspect the report");
}
