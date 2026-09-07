import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readlinkSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { parseJsonValue } from "../packages/pi-stuff/src/shared/json-value.js";
import {
	identityBoundProcessLiveness,
	probeProcessLiveness,
} from "../packages/pi-stuff/src/subagents/src/shared/process-identity.js";
import { respondToContextRequest } from "../tests/fixtures/responsiveness-provider.js";
import { HostResourceScope } from "./host-resource-scope.js";
import { CERTIFIED_PI_HOST_PROFILE } from "./pi-host-contract.js";
import { type PtyObservation, summarizePtyObservations } from "./pty-observation.js";
import { parseResponsivenessGates } from "./responsiveness-gates.ts";
import { readBackgroundOutcomes, readGoalCompletion } from "./responsiveness-session-evidence.ts";
import { armUiPtyOwnerWatchdog, disarmUiPtyOwnerWatchdog, type UiPtyOwnerWatchdog } from "./ui-pty-owner-watchdog.js";
import { stageSupportedPiHost } from "./verify-pi-host-provenance.js";

const root = resolve(import.meta.dir, "..");
const provider = join(root, "tests/fixtures/responsiveness-provider.ts");
const { values } = parseArgs({
	options: {
		pi: { type: "string", default: process.env["PI_BIN"] ?? "/opt/bin/pi" },
		suite: { type: "boolean", default: false },
		package: { type: "string", default: join(root, "packages/pi-stuff") },
		agent: { type: "string" },
		context: { type: "boolean", default: false },
		goal: { type: "boolean", default: false },
		"code-mode": { type: "boolean", default: false },
		ledger: { type: "boolean", default: false },
		snippet: { type: "boolean", default: false },
		"repeat-tool": { type: "boolean", default: false },
		columns: { type: "string", default: "120" },
		rows: { type: "string", default: "40" },
		"block-ms": { type: "string", default: "0" },
		"block-phase": { type: "string", default: "pre-tool" },
		"cpu-profile": { type: "boolean", default: false },
		diagnostic: { type: "boolean", default: false },
		"resource-scope": { type: "boolean", default: false },
		gates: { type: "string" },
	},
	strict: true,
	allowPositionals: false,
});
const columns = Number(values.columns);
const rows = Number(values.rows);
const blockMs = Number(values["block-ms"]);
const blockPhase = values["block-phase"];
const usage = values.suite;
const packageDirectory = resolve(values.package);
const codeMode = values["code-mode"];
const profileCpu = values["cpu-profile"];
const agentMode = values.agent;
const contextWork = values.context;
const goalWork = values.goal;
const timeoutMs = values.diagnostic ? 75_000 : agentMode || goalWork ? 60_000 : 30_000;
const purpose = profileCpu ? "cpu-diagnosis" : values.diagnostic ? "extended-diagnosis" : "observer-validation";
const requestedToolCount = values["repeat-tool"] || contextWork ? 2 : 1;
const expectedChildren = agentMode ? requestedToolCount : 0;
assert(Number.isSafeInteger(columns) && columns >= 40 && columns <= 240, "Invalid terminal width");
assert(Number.isSafeInteger(rows) && rows >= 20 && rows <= 80, "Invalid terminal height");
assert(Number.isFinite(blockMs) && blockMs >= 0 && blockMs <= 1_000, "Invalid negative-control duration");
assert(["startup", "pre-tool", "settlement"].includes(blockPhase), "Invalid negative-control phase");
assert(!codeMode || usage, "Code Mode requires the Suite");
assert(
	!contextWork || (usage && !agentMode && !values["repeat-tool"]),
	"Context requires --suite without Agent or repeat mode",
);
assert(
	agentMode === undefined || (usage && ["foreground", "background"].includes(agentMode)),
	"Agent mode requires --suite --agent foreground|background",
);
assert(!values.snippet || values.ledger, "Saved snippet requires a synthetic Ledger");
assert(
	!goalWork || (usage && !contextWork && !agentMode && !codeMode && !values.ledger && !values["repeat-tool"]),
	"Goal requires --suite without Context, Agent, Code Mode, Ledger or repeat mode",
);
assert(!(profileCpu || values.diagnostic) || !values.gates, "Diagnostic collection cannot use gates");

const PROVIDER_LOG_SCHEMA = Type.Array(
	Type.Object({
		type: Type.String(),
		role: Type.Union([Type.Literal("parent"), Type.Literal("child")]),
		pid: Type.Integer({ minimum: 1 }),
		atMs: Type.Number(),
		processStartIdentity: Type.Optional(Type.String({ minLength: 1 })),
		completedTools: Type.Optional(Type.Integer()),
		name: Type.Optional(Type.String()),
	}),
);
const directory = await mkdtemp(join(tmpdir(), "pi-stuff-responsiveness-"));
const resourceScope = values["resource-scope"]
	? new HostResourceScope(`ps-yon-${basename(directory)}.scope`)
	: undefined;

const { binaryPath: piBinary } = await stageSupportedPiHost(values.pi, directory);
const limits = values.gates
	? parseResponsivenessGates(
			await readFile(values.gates, "utf8"),
			createHash("sha256")
				.update(await readFile(piBinary))
				.digest("hex"),
		)
	: undefined;
await Promise.all(["home", "agent", "project", "sessions", "tmp"].map((name) => mkdir(join(directory, name))));
await writeFile(
	join(directory, "agent/settings.json"),
	JSON.stringify({
		quietStartup: true,
		tuiMode: "fullscreen",
		defaultProjectTrust: "always",
	}),
);
if (agentMode) {
	await mkdir(join(directory, "agent/agents"));
	await writeFile(
		join(directory, "agent/agents/cadence-agent.md"),
		`---
name: cadence-agent
description: Deterministic responsiveness child Agent.
model: openai-codex/cadence-model
extensions: ${provider}
systemPromptMode: append
inheritProjectContext: false
inheritSkills: false
---
Run the deterministic child Tool and return its result.
`,
	);
}
let codeModeHostSha256: string | undefined;
if (codeMode) {
	const helper = process.env["PI_STUFF_CODE_MODE_HOST"];
	assert(helper, "Set PI_STUFF_CODE_MODE_HOST to the prepared certified helper");
	assert((await stat(helper)).isFile(), "Code Mode helper must be a regular file");
	await copyFile(helper, join(directory, "codex-code-mode-host"));
	codeModeHostSha256 = createHash("sha256")
		.update(await readFile(join(directory, "codex-code-mode-host")))
		.digest("hex");
	await writeFile(join(directory, "agent/pi-stuff.json"), JSON.stringify({ codeMode: { enabled: true } }));
}
const providerLogPath = join(directory, "provider.jsonl");
const env: NodeJS.ProcessEnv = {
	PATH: process.env["PATH"],
	HOME: join(directory, "home"),
	PI_CODING_AGENT_DIR: join(directory, "agent"),
	XDG_CONFIG_HOME: join(directory, "config"),
	XDG_CACHE_HOME: join(directory, "cache"),
	XDG_DATA_HOME: join(directory, "data"),
	XDG_STATE_HOME: join(directory, "state"),
	LANG: "C.UTF-8",
	LC_ALL: "C.UTF-8",
	TERM: "xterm-256color",
	SHELL: "/bin/sh",
	TMPDIR: join(directory, "tmp"),
	PI_OFFLINE: usage ? "0" : "1",
	PSYON_GOAL: goalWork ? "1" : "0",
	PI_TELEMETRY: "0",
	PSYON_NEGATIVE_BLOCK_MS: String(blockMs),
	PSYON_NEGATIVE_BLOCK_PHASE: blockPhase,
	PSYON_TOOL_MODE: codeMode ? "codemode" : "bash",
	PSYON_REPEAT_TOOL: values["repeat-tool"] ? "1" : "0",
	PSYON_AGENT_MODE: agentMode,
	PSYON_CONTEXT: contextWork ? "1" : "0",
	PSYON_PROVIDER_LOG: providerLogPath,
	PSYON_USAGE_URL: "",
};
if (codeMode) env["PI_STUFF_CODE_MODE_HOST"] = join(directory, "codex-code-mode-host");
if (profileCpu) env["BUN_OPTIONS"] = `--cpu-prof --cpu-prof-dir=${directory}`;
const baseCommand = [
	piBinary,
	"--approve",
	"--no-extensions",
	"--no-context-files",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
];
let seedSession: string | undefined;
if (values.ledger) {
	const seed = Bun.spawn(
		[
			...baseCommand,
			"--offline",
			"--extension",
			provider,
			"--provider",
			"psyon-cadence",
			"--model",
			"cadence-model",
			"--session-dir",
			join(directory, "sessions"),
			"--print",
			"seed synthetic Ledger",
		],
		{
			cwd: join(directory, "project"),
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30_000,
			killSignal: "SIGKILL",
			env: {
				...env,
				PI_OFFLINE: "1",
				PSYON_USAGE_URL: "",
				PSYON_SEED_LEDGER: "1",
				PSYON_LEDGER_SNIPPET: values.snippet ? "1" : "0",
				PSYON_NEGATIVE_BLOCK_MS: "0",
				BUN_OPTIONS: "",
			},
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		seed.exited,
		new Response(seed.stdout).text(),
		new Response(seed.stderr).text(),
	]);
	assert.equal(exitCode, 0, stderr);
	assert(stdout.includes("PSYON_SEEDED"), "Synthetic native Ledger was not persisted");
	const files = (await readdir(join(directory, "sessions"))).filter((name) => name.endsWith(".jsonl"));
	assert.equal(files.length, 1, "Expected one synthetic native Session");
	const file = files[0];
	assert(file);
	seedSession = join(directory, "sessions", file);
}
await writeFile(providerLogPath, "");
const usageRequests: { path: string; at: number }[] = [];
const contextRequests: { body: string; naming: boolean }[] = [];
let server: ReturnType<typeof Bun.serve> | undefined;
const git = (...args: string[]): string => {
	const result = Bun.spawnSync(["git", ...args], { cwd: root });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout.toString();
};
const source = {
	commit: git("rev-parse", "HEAD").trim(),
	diff: git("diff", "HEAD"),
	package: usage
		? {
				directory: packageDirectory,
				commit: git("-C", packageDirectory, "rev-parse", "HEAD").trim(),
				diff: git("-C", packageDirectory, "diff", "HEAD"),
			}
		: undefined,
	snapshots: await Promise.all(
		[
			"scripts/benchmark-responsiveness.ts",
			"scripts/host-resource-scope.ts",
			"scripts/pty-observation.ts",
			"scripts/responsiveness-gates.ts",
			"scripts/responsiveness-session-evidence.ts",
			"tests/fixtures/responsiveness-provider.ts",
			"tests/fixtures/faux-provider.ts",
		].map(async (file) => {
			const content = await readFile(join(root, file), "utf8");
			return { file, sha256: createHash("sha256").update(content).digest("hex"), content };
		}),
	),
};
const socket = join(directory, "tmux.sock");
const tmux = (...args: string[]): string => {
	const child = Bun.spawnSync(["tmux", "-S", socket, ...args], {
		env,
		cwd: join(directory, "project"),
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.equal(child.exitCode, 0, child.stderr.toString());
	return child.stdout.toString();
};
const command = [
	...baseCommand,
	...(usage ? [] : ["--offline"]),
	"--tui-mode",
	"fullscreen",
	...(usage ? ["--extension", packageDirectory] : []),
	// Register observation markers after every Suite lifecycle handler.
	"--extension",
	provider,
	"--provider",
	usage ? "openai-codex" : "psyon-cadence",
	"--model",
	"cadence-model",
	"--session-dir",
	join(directory, "sessions"),
	...(seedSession ? ["--session", seedSession] : []),
];
const shellCommand = (resourceScope ? resourceScope.command(command) : command)
	.map((part) => `'${part.replaceAll("'", "'\\''")}'`)
	.join(" ");
let watchdog: UiPtyOwnerWatchdog | undefined;
const observations: (PtyObservation & { frame: string })[] = [];
const actions: { kind: string; phase: string; startedMs: number; visibleMs: number }[] = [];
const selected = (frame: string) => /^\s*→\s+(psyon-[\w-]+)/mu.exec(frame)?.[1];
const send = (...keys: string[]) => tmux("send-keys", "-t", "cadence:0.0", ...keys);
let pending: { kind: string; phase: string; startedMs: number; visible: (frame: string) => boolean } | undefined;
let firstActive = -1;
let lastActive = -1;
let readySeenMs: number | undefined;
let firstEditorMs: number | undefined;
let promptSentMs: number | undefined;
let agentEndIndex = -1;
let settledSeenMs: number | undefined;
let completedAt: number | undefined;
let responseSeen = false;
let backgroundCompletionRows = 0;
let nextActionMs = Infinity;
let nextAction = 0;
let lastFrame = "";
let summary: object | undefined;
const phase = () => {
	if (completedAt !== undefined) return "idle";
	if (agentMode === "background" && settledSeenMs !== undefined) return "background";
	if (agentEndIndex >= 0) return "settlement";
	return firstActive >= 0 ? "active" : "startup";
};
try {
	if (usage) {
		const parentNamespace = process.env["PSYON_PARENT_NETNS"];
		assert(parentNamespace?.startsWith("net:["), "Parent network namespace identity is required");
		assert.notEqual(
			readlinkSync("/proc/self/ns/net"),
			parentNamespace,
			"Suite probe requires an isolated network namespace",
		);
		assert.equal(Bun.spawnSync(["ip", "link", "set", "lo", "up"]).exitCode, 0);
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				const path = new URL(request.url).pathname;
				if (contextWork && path === "/backend-api/responses")
					return respondToContextRequest(request, codeMode, contextRequests);
				assert.equal(path, "/backend-api/wham/usage");
				assert.equal(request.headers.get("authorization"), "Bearer synthetic-fixture-token");
				assert.equal(request.headers.get("chatgpt-account-id"), "synthetic-fixture-account");
				usageRequests.push({ path, at: performance.now() });
				return Response.json({
					plan_type: "fixture",
					rate_limit: { secondary: { used_percent: 10, window_minutes: 10_080 } },
				});
			},
		});
		env["PSYON_USAGE_URL"] = `http://127.0.0.1:${String(server.port)}/backend-api`;
	}
	watchdog = await armUiPtyOwnerWatchdog(socket);
	const start = performance.now();
	const observerCpu = process.cpuUsage();
	tmux(
		"-f",
		"/dev/null",
		"new-session",
		"-d",
		"-s",
		"cadence",
		"-x",
		String(columns),
		"-y",
		String(rows),
		shellCommand,
	);
	while (performance.now() - start < timeoutMs) {
		const captureStartedMs = performance.now();
		const frame = tmux("capture-pane", "-p", "-N", "-t", "cadence:0.0");
		const capturedMs = performance.now();
		lastFrame = frame;
		const spinner = /([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+Working/u.exec(frame)?.[1];
		const observation: PtyObservation & { frame: string } = { captureStartedMs, capturedMs, frame };
		observations.push(spinner ? { ...observation, spinner } : observation);
		if (readySeenMs === undefined && frame.includes("PSYON_READY")) {
			readySeenMs = capturedMs;
		}
		// Pi accepts text before session_start handlers finish. Do not wait for PSYON_READY to probe it.
		if (firstEditorMs === undefined && frame.includes("cadence-model") && /─{20,}/u.test(frame)) {
			firstEditorMs = capturedMs;
			nextActionMs = capturedMs;
		}
		if (spinner) {
			lastActive = observations.length - 1;
			if (firstActive < 0) firstActive = lastActive;
		}
		responseSeen ||= frame.includes("PSYON_CADENCE_DONE");
		if (agentEndIndex < 0 && frame.includes("PSYON_AGENT_END")) agentEndIndex = observations.length - 1;
		if (settledSeenMs === undefined && frame.includes("PSYON_SETTLED")) settledSeenMs = capturedMs;
		if (agentMode === "background")
			backgroundCompletionRows = Math.max(
				backgroundCompletionRows,
				[...frame.matchAll(/• Agent finished\b/gu)].length,
			);
		if (pending?.visible(frame)) {
			actions.push({
				kind: pending.kind,
				phase: pending.phase,
				startedMs: pending.startedMs,
				visibleMs: capturedMs - pending.startedMs,
			});
			if (pending.kind === "selection-setup") {
				const before = selected(frame);
				const startedMs = performance.now();
				send("Down");
				pending = {
					kind: "selection",
					phase: phase(),
					startedMs,
					visible: (next) => selected(next) !== undefined && selected(next) !== before,
				};
			} else {
				send("C-u");
				pending = undefined;
				nextActionMs = capturedMs + 250;
			}
		}
		if (
			settledSeenMs !== undefined &&
			completedAt === undefined &&
			(agentMode !== "background" || backgroundCompletionRows >= expectedChildren)
		) {
			if (
				!usage ||
				(usageRequests.length > 0 && (await readFile(providerLogPath, "utf8")).includes('"name-persisted"'))
			)
				completedAt = capturedMs;
		}
		const completedMs = completedAt;
		if (
			completedMs !== undefined &&
			!pending &&
			["input", "selection"].every((kind) =>
				actions.some((action) => action.kind === kind && action.startedMs >= completedMs),
			)
		)
			break;
		if (
			promptSentMs === undefined &&
			readySeenMs !== undefined &&
			!pending &&
			selected(frame) === undefined &&
			["input", "selection"].every((kind) => actions.some((action) => action.kind === kind))
		) {
			promptSentMs = performance.now();
			send("-l", "--", goalWork ? "/goal PSYON_MEASURE" : "PSYON_MEASURE");
			send("Enter");
		}
		if (!pending && capturedMs >= nextActionMs) {
			const startedMs = performance.now();
			if (nextAction % 2 === 0 || readySeenMs === undefined) {
				const marker = `PSYON_INPUT_${nextAction}`;
				send("-l", "--", marker);
				pending = { kind: "input", phase: phase(), startedMs, visible: (next) => next.includes(marker) };
			} else {
				send("-l", "--", "/psyon-");
				pending = {
					kind: "selection-setup",
					phase: phase(),
					startedMs,
					visible: (next) => selected(next) !== undefined,
				};
			}
			nextAction++;
		}
		await Bun.sleep(10);
	}
	const completedMs = completedAt;
	assert(
		responseSeen &&
			completedMs !== undefined &&
			firstActive >= 0 &&
			lastActive > firstActive &&
			agentEndIndex > firstActive,
		`Observation incomplete: ${lastFrame}`,
	);
	assert(
		actions.some((action) => action.kind === "input") && actions.some((action) => action.kind === "selection"),
		"Input/selection evidence missing",
	);
	assert(
		!pending &&
			["input", "selection"].every((kind) =>
				actions.some((action) => action.kind === kind && action.startedMs >= completedMs),
			),
		"Post-settlement interaction did not complete",
	);
	const providerLog = (await readFile(providerLogPath, "utf8")).trim().split("\n").map(parseJsonValue);
	assert(Check(PROVIDER_LOG_SCHEMA, providerLog), "Invalid fixture Provider evidence");
	assert.deepEqual(
		providerLog
			.filter((entry) => entry.type === "agent-request" && entry.role === "parent")
			.map((entry) => entry.completedTools),
		goalWork ? [0, 0, 1] : requestedToolCount === 2 ? [0, 1, 2] : [0, 1],
	);
	const goalContinuationRequests = providerLog.filter((entry) => entry.type === "goal-continuation").length;
	assert.equal(goalContinuationRequests, goalWork ? 1 : 0);
	assert.equal(providerLog.filter((entry) => entry.type === "goal-final-request").length, goalWork ? 1 : 0);
	const contextProjections = contextRequests.filter((entry) => !entry.naming);
	assert.equal(contextProjections.length, contextWork ? 3 : 0, "Native Context requests are missing");
	const contextRetrievals = providerLog.filter((entry) => entry.type === "context-retrieval").length;
	assert.equal(contextRetrievals, contextWork ? 1 : 0, "Context retrieval was not verified");
	const childRequests = providerLog.filter((entry) => entry.type === "agent-request" && entry.role === "child");
	const childProcesses = providerLog.filter((entry) => entry.type === "fixture-ready" && entry.role === "child");
	const childCompletions = providerLog.filter((entry) => entry.type === "response-complete" && entry.role === "child");
	assert.equal(childProcesses.length, expectedChildren, "Expected child process evidence is missing");
	assert.equal(childRequests.length, expectedChildren * 2, "Unexpected child Provider requests");
	for (const entry of childProcesses) {
		assert(entry.processStartIdentity, "Child birth identity is missing");
		assert.equal(
			childCompletions.filter((completion) => completion.pid === entry.pid).length,
			1,
			"Missing or repeated child completion",
		);
		assert.deepEqual(
			childRequests.filter((request) => request.pid === entry.pid).map((request) => request.completedTools),
			[0, 1],
		);
		assert.equal(
			identityBoundProcessLiveness(entry.pid, entry.processStartIdentity, probeProcessLiveness(entry.pid)),
			false,
			"Child process was not reaped",
		);
	}
	const parentCompletions = providerLog.filter(
		(entry) => entry.type === "response-complete" && entry.role === "parent",
	);
	assert.equal(parentCompletions.length, 1, "Unexpected parent completion");
	assert.equal(childCompletions.length, expectedChildren, "Missing child completion");
	const parentResponse = parentCompletions[0];
	assert(parentResponse, "Parent completion is missing");
	const lastChildResponse = childCompletions.at(-1);
	const parentCompletedWhileChildRunning =
		agentMode === "background" && lastChildResponse !== undefined && parentResponse.atMs < lastChildResponse.atMs;
	if (agentMode === "background") {
		assert(
			parentCompletedWhileChildRunning && lastChildResponse,
			"Parent did not finish independently of the background child",
		);
		for (const kind of ["input", "selection"])
			assert(
				actions.some(
					(action) =>
						action.kind === kind &&
						action.phase === "background" &&
						performance.timeOrigin + action.startedMs >= parentResponse.atMs &&
						performance.timeOrigin + action.startedMs + action.visibleMs < lastChildResponse.atMs,
				),
				`Missing ${kind} while the parent was idle and its child was running`,
			);
	}
	const background =
		agentMode === "background"
			? await readBackgroundOutcomes(directory, expectedChildren)
			: { outcomes: 0, deliveries: 0 };
	const backgroundIntegrationRequests = providerLog.filter(
		(entry) => entry.type === "background-integration-request" && entry.role === "parent",
	).length;
	assert.equal(backgroundIntegrationRequests, background.deliveries, "Missing or repeated result integration");
	assert.equal(
		providerLog.filter((entry) => entry.type === "background-integration-complete" && entry.role === "parent").length,
		background.deliveries,
		"Background result integration did not finish",
	);
	const firstAgentRow = observations.find((entry) => /• Agent\b.*cadence-agent/u.test(entry.frame));
	const agentRowObserved = firstAgentRow !== undefined;
	assert(!agentMode || agentRowObserved, "Agent Tool UI was not observed");
	const firstGoalToolRow = observations.find((entry) => entry.frame.includes("Goal complete · done"));
	assert(!goalWork || firstGoalToolRow, "Successful Goal Tool UI was not observed");
	if (usage) {
		assert.equal(usageRequests.length, 1 + background.deliveries, "Each settled user-work run refreshes usage once");
		assert.equal(
			contextWork
				? contextRequests.filter((entry) => entry.naming).length
				: providerLog.filter((entry) => entry.type === "naming-request").length,
			1,
		);
		assert(providerLog.some((entry) => entry.type === "name-persisted" && entry.name === "Cadence Resource Fixture"));
	}
	const active = summarizePtyObservations(observations.slice(firstActive, agentEndIndex));
	const firstSpinner = observations[firstActive];
	const finalObservation = observations.at(-1);
	const firstInput = actions.find((action) => action.kind === "input");
	assert(
		firstSpinner &&
			finalObservation &&
			firstInput &&
			readySeenMs !== undefined &&
			firstEditorMs !== undefined &&
			promptSentMs !== undefined &&
			settledSeenMs !== undefined,
		"Required timing evidence missing",
	);
	summary = {
		purpose,
		observationTimeoutMs: timeoutMs,
		certification: false,
		profile: CERTIFIED_PI_HOST_PROFILE,
		seededSession: Boolean(seedSession),
		codeMode,
		agentMode,
		agentRowObserved,
		backgroundOutcomes: background.outcomes,
		backgroundIntegrationRequests,
		parentCompletedWhileChildRunning,
		firstAgentRowMs: firstAgentRow ? firstAgentRow.capturedMs - start : undefined,
		completedChildTools: childRequests.filter((entry) => entry.completedTools === 1).length,
		reapedChildProcesses: childProcesses.length,
		codeModeHostSha256,
		requestedToolCount,
		contextProjectionRequests: contextProjections.length,
		contextRetrievals,
		goalContinuationRequests,
		firstGoalToolRowMs: firstGoalToolRow ? firstGoalToolRow.capturedMs - start : undefined,
		goalCompleted: goalWork && (await readGoalCompletion(directory)),
		negativeBlockMs: blockMs,
		negativeBlockPhase: blockPhase,
		automaticUsageRefreshes: usageRequests.length,
		suite: usage,
		columns,
		rows,
		...summarizePtyObservations(observations),
		// Spinner absence is valid before an Agent run and after agent_end; capture gaps and held frames are measured over the entire trace.
		maximumSpinnerAbsenceMs: active.maximumSpinnerAbsenceMs,
		activeDurationMs: active.durationMs,
		activeCaptureCount: active.captureCount,
		firstSpinnerMs: firstSpinner.capturedMs - start,
		firstReadyMs: readySeenMs - start,
		firstEditorMs: firstEditorMs - start,
		promptToSpinnerMs: firstSpinner.capturedMs - promptSentMs,
		startupInputMs: firstInput.startedMs + firstInput.visibleMs - start,
		settledMs: settledSeenMs - start,
		postSettlementObservationMs: finalObservation.capturedMs - settledSeenMs,
		observerCpu: process.cpuUsage(observerCpu),
		maximumInputMs: Math.max(
			...actions.filter((action) => action.kind !== "selection").map((action) => action.visibleMs),
		),
		maximumStartupInputMs: Math.max(
			...actions
				.filter((action) => action.kind !== "selection" && action.phase === "startup")
				.map((action) => action.visibleMs),
		),
		maximumSteadyInputMs: Math.max(
			...actions
				.filter((action) => action.kind !== "selection" && action.phase !== "startup")
				.map((action) => action.visibleMs),
		),
		maximumSelectionMs: Math.max(
			...actions.filter((action) => action.kind === "selection").map((action) => action.visibleMs),
		),
		maximumSelectionSetupMs: Math.max(
			...actions.filter((action) => action.kind === "selection-setup").map((action) => action.visibleMs),
		),
		actionCount: actions.length,
		resourceScope: await resourceScope?.read(parentResponse.pid),
		directory,
	};
	console.log(JSON.stringify(summary));
} finally {
	try {
		const evidencePath = join(directory, "evidence.json");
		await writeFile(
			evidencePath,
			JSON.stringify(
				{
					summary,
					providerLog: await readFile(providerLogPath, "utf8"),
					sessions: await Promise.all(
						(await readdir(join(directory, "sessions")))
							.filter((name) => name.endsWith(".jsonl"))
							.map((name) => readFile(join(directory, "sessions", name), "utf8")),
					),
					observerTimeOriginMs: performance.timeOrigin,
					observations,
					actions,
					contextRequests,
					limits,
					source,
				},
				null,
				2,
			),
		);
		const artifactDirectory = process.env["PI_STUFF_UI_PTY_ARTIFACT_DIR"];
		if (artifactDirectory) {
			await mkdir(artifactDirectory, { recursive: true });
			await copyFile(evidencePath, join(artifactDirectory, `${basename(directory)}.json`));
		}
		if (profileCpu) {
			send("C-u");
			send("C-d");
			await Bun.sleep(2_000);
		}
	} finally {
		try {
			Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { stdout: "ignore", stderr: "ignore" });
		} finally {
			server?.stop(true);
			disarmUiPtyOwnerWatchdog(watchdog);
			resourceScope?.stop();
		}
	}
}

assert(summary, "Observation did not produce a complete summary");
const SUMMARY_SCHEMA = Type.Object({
	maximumObservationGapMs: Type.Number(),
	maximumSpinnerAbsenceMs: Type.Number(),
	maximumSpinnerFrameMs: Type.Number(),
	maximumStartupInputMs: Type.Number(),
	maximumSteadyInputMs: Type.Number(),
	maximumSelectionMs: Type.Number(),
	activeDurationMs: Type.Number(),
	activeCaptureCount: Type.Integer(),
});
assert(Check(SUMMARY_SCHEMA, summary), "Invalid observation summary");
assert(
	summary.activeDurationMs >= 9_000 && summary.activeCaptureCount >= 600,
	"Insufficient continuous active coverage",
);
assert(
	summary.maximumObservationGapMs <= 40 && summary.maximumSpinnerAbsenceMs === 0,
	"Missing or delayed observations; sample is inconclusive",
);
if (limits) {
	const checks = [
		["maximumObservationGapMs", "maximumObservationGapMs"],
		["maximumSpinnerAbsenceMs", "maximumActiveSpinnerAbsenceMs"],
		["maximumSpinnerFrameMs", "spinnerMs"],
		["maximumStartupInputMs", "startupInputMs"],
		["maximumSteadyInputMs", "steadyInputMs"],
		["maximumSelectionMs", "selectionMs"],
	] as const;
	const breaches = checks.filter(([metric, gate]) => summary[metric] > limits[gate]);
	assert.equal(
		breaches.length,
		0,
		breaches.map(([metric, gate]) => `${metric}: ${String(summary[metric])} > ${String(limits[gate])} ms`).join("\n"),
	);
}
