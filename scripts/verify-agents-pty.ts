import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { isRuntimeNumber, isRuntimeString } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { selectAcceptanceMatrix } from "./acceptance-matrix.js";
import {
	AGENTS_EXPECT_PROGRAM,
	type FleetviewSelection,
	fail,
	fleetviewHelp,
	verifyTerminalOutput,
} from "./agents-pty-contract.js";
import { resolvePiBinary } from "./installed-tools.ts";
import { CERTIFIED_PI_VERSION } from "./pi-host-contract.ts";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/agents-pty-provider.ts");
const runner = join(root, "tests/fixtures/agents-pty-runner.sh");
const NERD_PROMPT_MARKER = "\uF460";

export interface AgentsPtyVerificationOptions {
	readonly artifactDirectory?: string;
	readonly piBinary: string;
	readonly packagePath: string;
	readonly columns: number;
	readonly rows: number;
}

const LOG_RECORD_SCHEMA = Type.Object(
	{
		at: Type.Optional(Type.Number()),
		completion: Type.Optional(Type.Boolean()),
		kind: Type.Optional(Type.String()),
		lastUser: Type.Optional(Type.String()),
		phase: Type.Optional(Type.String()),
		role: Type.Optional(Type.String()),
		tools: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: true },
);
const SESSION_ENTRY_SCHEMA = Type.Object(
	{
		customType: Type.Optional(Type.String()),
		data: Type.Optional(Type.Unknown()),
		type: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const OUTCOME_SCHEMA = Type.Object(
	{ count: Type.Number(), key: Type.String(), status: Type.String(), version: Type.Number() },
	{ additionalProperties: true },
);
type LogRecord = Static<typeof LOG_RECORD_SCHEMA>;

function number<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) ? value : undefined;
}

async function pathExists(path: string): Promise<boolean> {
	return access(path).then(
		() => true,
		() => false,
	);
}

async function readFailureDiagnostics(directory: string): Promise<string> {
	const entries = await readdir(directory, { recursive: true }).catch((): string[] => []);
	const candidates = entries
		.filter(
			(entry) =>
				/(?:status|result|events|output|stderr|transcript|work).*\.(?:json|jsonl|log|txt)$/i.test(entry) ||
				/(?:^|[\\/])sessions[\\/].*\.jsonl$/i.test(entry),
		)
		.sort()
		.slice(0, 24);
	const sections: string[] = [];
	let remaining = 24_000;
	for (const entry of candidates) {
		if (remaining <= 0) break;
		const content = await readFile(join(directory, entry), "utf8").catch(() => undefined);
		if (content === undefined) continue;
		const excerpt = content.slice(-Math.min(remaining, 6_000));
		sections.push(`--- ${entry} ---\n${excerpt}`);
		remaining -= excerpt.length;
	}
	return sections.join("\n");
}

function verifyHostVersion(piBinary: string): void {
	const result = Bun.spawnSync([piBinary, "--version"], { stdout: "pipe", stderr: "pipe" });
	const version = result.stdout.toString().trim();
	if (result.exitCode !== 0 || version !== CERTIFIED_PI_VERSION) {
		fail(`expected Pi ${CERTIFIED_PI_VERSION}, received ${version || `exit ${result.exitCode}`}`);
	}
}

function git(cwd: string, args: readonly string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		fail(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString().trim();
}

function verifyRequests(records: readonly LogRecord[]): void {
	const requests = records.filter((record) => record.kind === "request");
	const mainRequests = requests.filter((record) => record.role === "main");
	const launch = mainRequests.find((record) => record.phase === "launch");
	const continued = mainRequests.find((record) => record.phase === "continued");
	const childRequests = requests.filter((record) => record.role === "child" && record.phase === "child");
	const child = childRequests[0];
	const completion = requests.find((record) => record.role === "main" && record.phase === "completion");
	const childFinished = records.find((record) => record.kind === "child-finished");
	if (!launch || !continued || !child || !childFinished) {
		fail("provider did not observe launch, non-blocking continuation, child, and finish phases");
	}
	if (completion?.completion !== true) {
		fail("background completion did not reach the main model as a completion request");
	}
	if (mainRequests.length !== 3) {
		fail(
			`expected launch, independent continuation, and completion requests; received ${String(mainRequests.length)}`,
		);
	}
	if (childRequests.length < 2) fail("the child did not complete its Tool call and final report turns");
	if (launch.lastUser !== "launch one background general-purpose Agent") {
		fail("main launch prompt was not observed");
	}
	if (!Array.isArray(launch.tools) || !launch.tools.includes("subagent")) {
		fail("the model did not receive the public subagent tool");
	}
	if (!isRuntimeString(child.lastUser) || !child.lastUser.includes("AGENT_PTY_TASK")) {
		fail("the general-purpose child did not receive its task");
	}
	const continuedAt = number(continued.at);
	const childFinishedAt = number(childFinished.at);
	if (continuedAt === undefined || childFinishedAt === undefined || continuedAt >= childFinishedAt) {
		fail("the main session did not continue before the background Agent finished");
	}
}

class TmuxAgentsSession {
	private readonly environment: Record<string, string | undefined>;
	private readonly options: AgentsPtyVerificationOptions;
	private readonly socket: string;
	private stopped = false;
	private readonly target = "pi";
	private readonly workspace: string;

	constructor(
		options: AgentsPtyVerificationOptions,
		paths: {
			readonly config: string;
			readonly log: string;
			readonly runtime: string;
			readonly sessions: string;
			readonly workspace: string;
		},
	) {
		this.options = options;
		this.socket = join(paths.config, `fleetview-${String(process.pid)}-${String(options.columns)}.sock`);
		this.environment = {
			...process.env,
			MAGIC_CONTEXT_PI_SUBAGENT: "1",
			PI_CODING_AGENT_DIR: paths.config,
			PI_SUBAGENT_PI_BINARY: options.piBinary,
			PI_STUFF_AGENTS_PTY_BIN: options.piBinary,
			PI_STUFF_AGENTS_PTY_COLUMNS: String(options.columns),
			PI_STUFF_AGENTS_PTY_LOG: paths.log,
			PI_STUFF_AGENTS_PTY_PACKAGE: resolve(options.packagePath),
			PI_STUFF_AGENTS_PTY_PROVIDER_EXTENSION: providerExtension,
			PI_STUFF_AGENTS_PTY_ROWS: String(options.rows),
			PI_STUFF_AGENTS_PTY_SESSIONS: paths.sessions,
			PI_STUFF_AGENTS_PTY_SESSION_ID: `fleetview-${String(options.columns)}x${String(options.rows)}`,
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
			TMPDIR: paths.runtime,
			XDG_RUNTIME_DIR: paths.runtime,
			XDG_STATE_HOME: join(paths.runtime, "state"),
		};
		this.workspace = paths.workspace;
	}

	start(): void {
		const result = Bun.spawnSync(
			[
				"tmux",
				"-S",
				this.socket,
				"-f",
				"/dev/null",
				"new-session",
				"-d",
				"-s",
				this.target,
				"-x",
				String(this.options.columns),
				"-y",
				String(this.options.rows),
				"-c",
				this.workspace,
				runner,
				";",
				"set-option",
				"-s",
				"extended-keys",
				"on",
				";",
				"set-option",
				"-g",
				"remain-on-exit",
				"on",
			],
			{ env: this.environment, stderr: "pipe", stdout: "pipe" },
		);
		if (result.exitCode !== 0) {
			fail(`tmux could not start the Fleetview probe: ${result.stderr.toString().trim()}`);
		}
		const serverOptions = this.tmux(["show-options", "-s"]);
		if (/^extended-keys-format\b/m.test(serverOptions)) {
			this.tmux(["set-option", "-s", "extended-keys-format", "csi-u"]);
		}
	}

	capture(ansi = false): string {
		return this.tmux(["capture-pane", "-p", ...(ansi ? ["-e"] : []), "-N", "-t", this.target]);
	}

	sendKey(key: string): void {
		this.tmux(["send-keys", "-t", this.target, key]);
	}

	async sendAndWaitForChange(value: string, literal = false): Promise<string> {
		const before = await this.waitForStableScreen();
		if (literal) this.sendLiteral(value);
		else this.sendKey(value);
		const deadline = Date.now() + 20_000;
		let changed = false;
		let screen = before;
		let stableSince = Date.now();
		while (Date.now() < deadline) {
			const current = this.capture();
			if (current !== screen) {
				screen = current;
				changed ||= current !== before;
				stableSince = Date.now();
			} else if (changed && Date.now() - stableSince >= 100) return screen;
			await Bun.sleep(25);
		}
		fail(`timed out waiting for stable screen change after ${JSON.stringify(value)}\n${screen}`);
	}

	async waitForStableScreen(): Promise<string> {
		const deadline = Date.now() + 20_000;
		let screen = this.capture();
		let stableSince = Date.now();
		while (Date.now() < deadline) {
			await Bun.sleep(25);
			const current = this.capture();
			if (current !== screen) {
				screen = current;
				stableSince = Date.now();
			} else if (Date.now() - stableSince >= 100) return screen;
		}
		fail(`timed out waiting for a stable screen\n${screen}`);
	}

	sendLiteral(value: string): void {
		this.tmux(["send-keys", "-t", this.target, "-l", value]);
	}

	async waitForText(text: string): Promise<string> {
		return this.waitFor((screen) => screen.includes(text), `text ${JSON.stringify(text)}`);
	}

	async waitForAbsence(text: string): Promise<string> {
		return this.waitFor((screen) => !screen.includes(text), `absence of ${JSON.stringify(text)}`);
	}

	async waitForFleetviewFrame(selection: FleetviewSelection, columns = this.options.columns): Promise<string> {
		return this.waitFor(
			(screen) => hasOrderedFleetviewFrame(screen, columns, selection),
			`${String(columns)}-column ${selection} Fleetview frame`,
		);
	}

	resize(columns: number, rows: number): void {
		this.tmux(["resize-window", "-t", this.target, "-x", String(columns), "-y", String(rows)]);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		Bun.spawnSync(["tmux", "-S", this.socket, "kill-server"], { stderr: "pipe", stdout: "pipe" });
	}

	private tmux(args: readonly string[]): string {
		const result = Bun.spawnSync(["tmux", "-S", this.socket, ...args], { stderr: "pipe", stdout: "pipe" });
		if (result.exitCode !== 0) {
			fail(`tmux ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
		}
		return result.stdout.toString();
	}

	private async waitFor(predicate: (screen: string) => boolean, description: string): Promise<string> {
		const deadline = Date.now() + 120_000;
		let screen = "";
		while (Date.now() < deadline) {
			screen = this.capture();
			if (predicate(screen)) return screen;
			await Bun.sleep(50);
		}
		fail(`timed out waiting for ${description}\n${screen}`);
	}
}

function fleetviewLineIndices(screen: string, help: string | undefined) {
	const lines = screen.split("\n").map((line) => line.trimEnd());
	const status = lines.findIndex((line) => line.startsWith("\u{F167A} "));
	return {
		agent: lines.findIndex((line) => /^[●○] general-purpose(?:\s|$)/u.test(line)),
		help: help === undefined ? -1 : lines.indexOf(help),
		main: lines.findIndex((line) => /^[●○] main$/u.test(line)),
		prompt: lines.findIndex((line) => line.startsWith(`${NERD_PROMPT_MARKER} `)),
		status,
	};
}

function hasOrderedFleetviewFrame(screen: string, columns: number, selection: FleetviewSelection): boolean {
	const active = selection !== "idle";
	const help = active ? fleetviewHelp(columns, selection) : undefined;
	const indices = fleetviewLineIndices(screen, help);
	return (
		indices.status >= 0 &&
		(active
			? indices.prompt === -1 && indices.help === indices.status + 1 && indices.main === indices.help + 1
			: indices.prompt === indices.status + 1 && indices.help === -1 && indices.main === indices.status + 2) &&
		indices.agent === indices.main + 1
	);
}

function verifyFleetviewFrame(screen: string, columns: number, selection: FleetviewSelection): void {
	const help = selection === "idle" ? undefined : fleetviewHelp(columns, selection);
	const indices = fleetviewLineIndices(screen, help);
	const lines = screen.split("\n").map((line) => line.trimEnd());
	if (!hasOrderedFleetviewFrame(screen, columns, selection)) {
		fail(
			`${String(columns)}-column shared Footer order does not replace Prompt with contextual controls in place\n${screen}`,
		);
	}
	const selectedChild = selection === "live" || selection === "terminal";
	if (
		lines[indices.main] !== `${selectedChild ? "○" : "●"} main` ||
		!lines[indices.agent]?.startsWith(`${selectedChild ? "●" : "○"} general-purpose`)
	) {
		fail(`${String(columns)}-column Fleetview selection markers are not aligned at terminal cell 1\n${screen}`);
	}
	let lastVisible = -1;
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		if (lines[index]?.trim()) {
			lastVisible = index;
			break;
		}
	}
	if (lastVisible !== indices.agent) {
		fail(`${String(columns)}-column Fleetview is not the bottommost visible Footer region\n${screen}`);
	}
	for (const [index, line] of lines.entries()) {
		if (visibleWidth(line) > columns) {
			fail(`${String(columns)}-column Fleetview frame overflowed on row ${String(index + 1)}\n${screen}`);
		}
	}
}

function verifyFleetviewContextPercent(screen: string, columns: number, expected: number): void {
	const line = screen
		.split("\n")
		.map((entry) => entry.trimEnd())
		.find((entry) => /^[●○] general-purpose(?:\s|$)/u.test(entry));
	if (!line?.includes(`${String(expected)}% ·`)) {
		fail(`${String(columns)}-column Fleetview did not show Agent context at ${String(expected)}%\n${screen}`);
	}
}

function sanitizeFleetviewEvidence(value: string): string {
	return value.replace(/\/tmp\/pi-(?:stuff-agents-pty|subagent-session)-[^/\s]+/gu, "[fixture]").trimEnd();
}

async function writeFleetviewEvidence(
	directory: string | undefined,
	entries: readonly (readonly [name: string, value: string])[],
): Promise<void> {
	if (!directory) return;
	await mkdir(directory, { recursive: true });
	await Promise.all(
		entries.map(([name, value]) => writeFile(join(directory, name), sanitizeFleetviewEvidence(value), "utf8")),
	);
}

async function verifyFleetviewNavigation(
	session: TmuxAgentsSession,
	options: AgentsPtyVerificationOptions,
): Promise<void> {
	session.start();
	await session.waitForText("MAIN_NOT_BLOCKED");
	let screen = await session.waitForFleetviewFrame("idle");
	verifyFleetviewFrame(screen, options.columns, "idle");
	const idleIndices = fleetviewLineIndices(screen, undefined);
	const prompt = screen.split("\n").map((line) => line.trimEnd())[idleIndices.prompt];
	if (!prompt) fail(`${String(options.columns)}-column idle Fleetview has no latest Prompt row\n${screen}`);
	const idleName = `pi-${CERTIFIED_PI_VERSION}-footer-fleetview-idle-${String(options.columns)}x${String(options.rows)}`;
	await writeFleetviewEvidence(options.artifactDirectory, [
		[`${idleName}.txt`, screen],
		[`${idleName}.ansi`, session.capture(true)],
	]);

	session.sendKey("Down");
	screen = await session.waitForFleetviewFrame("main");
	verifyFleetviewFrame(screen, options.columns, "main");
	const activeName = `pi-${CERTIFIED_PI_VERSION}-footer-fleetview-active-${String(options.columns)}x${String(options.rows)}`;
	await writeFleetviewEvidence(options.artifactDirectory, [
		[`${activeName}.txt`, screen],
		[`${activeName}.ansi`, session.capture(true)],
	]);

	session.sendKey("Down");
	await session.waitForText("37%");
	screen = await session.waitForFleetviewFrame("live");
	verifyFleetviewFrame(screen, options.columns, "live");
	verifyFleetviewContextPercent(screen, options.columns, 37);
	if (options.columns > 64) {
		session.resize(64, 28);
		screen = await session.waitForFleetviewFrame("live", 64);
		verifyFleetviewFrame(screen, 64, "live");
		verifyFleetviewContextPercent(screen, 64, 37);
		session.resize(options.columns, options.rows);
		screen = await session.waitForFleetviewFrame("live");
		verifyFleetviewFrame(screen, options.columns, "live");
		verifyFleetviewContextPercent(screen, options.columns, 37);
	}

	session.sendKey("Escape");
	screen = await session.waitForFleetviewFrame("idle");
	verifyFleetviewFrame(screen, options.columns, "idle");
	await session.waitForText("FINAL_DELIVERABLE_FROM_BACKGROUND_RESULT");
	screen = await session.waitForFleetviewFrame("idle");
	verifyFleetviewFrame(screen, options.columns, "idle");
	if (
		!screen
			.split("\n")
			.map((line) => line.trimEnd())
			.includes(prompt)
	) {
		fail(`${String(options.columns)}-column Fleetview did not restore the exact latest Prompt row\n${screen}`);
	}
}

async function verifyAgentDetail(session: TmuxAgentsSession, options: AgentsPtyVerificationOptions): Promise<void> {
	session.sendLiteral("/agents");
	session.sendKey("Enter");
	await session.waitForText("↑/↓ select · Enter details");
	session.sendKey("Enter");
	await session.waitForText("Agents / general-purpose");
	await session.waitForText("Activity");
	session.sendKey("Escape");
	await session.waitForText("↑/↓ select");
	session.sendKey("Escape");
	await session.waitForAbsence("Agents ·");
	let screen = await session.waitForFleetviewFrame("idle");
	verifyFleetviewFrame(screen, options.columns, "idle");
	await session.waitForText("done ·");
	await session.waitForText("inspect with /agents");
	session.sendLiteral("/agents");
	session.sendKey("Enter");
	await session.waitForText("↑/↓ select · Enter details");
	session.sendKey("Enter");
	await session.waitForText("Agents / general-purpose");
	await session.waitForText("Activity");
	const detailInitial = await session.waitForStableScreen();
	if (detailInitial.includes("pi-stuff-context")) fail("Agent detail exposed Suite-owned execution context");
	if (detailInitial.split("Agents / general-purpose").length !== 2) fail("Agent detail repeated its title");
	const detailScreens = [detailInitial];
	for (let index = 0; index < 64 && detailScreens.at(-1)?.includes("later lines"); index += 1) {
		detailScreens.push(await session.sendAndWaitForChange("Down"));
	}
	const detailDown = detailScreens[1] ?? fail(`Down did not move the completed Agent detail\n${detailInitial}`);
	const detailEnd = detailScreens.at(-1) ?? fail("completed Agent detail had no rendered page");
	if (detailEnd.includes("later lines")) fail("completed Agent detail exceeded the bounded page traversal");
	const detailPages = detailScreens.join("\n");
	if (
		!detailPages.includes("Result") ||
		!detailPages.includes("CHILD_RUNNING") ||
		!detailPages.includes("CHILD_FINAL_SUMMARY") ||
		!detailPages.includes("CHILD_MARKDOWN_RENDERED")
	) {
		fail("Agent Result did not remain inspectable through detail pagination");
	}
	if (detailPages.includes("## CHILD_FINAL_SUMMARY") || detailPages.includes("**CHILD_MARKDOWN_RENDERED**")) {
		fail("Agent Result exposed unrendered Markdown markers");
	}
	if (detailEnd.includes("AGENT_TOOL_RESULT")) fail(`successful Tool result was expanded by default\n${detailEnd}`);
	await session.sendAndWaitForChange("t");
	await session.sendAndWaitForChange(" ", true);
	await session.waitForText("AGENT_TOOL_RESULT");
	const prefix = `pi-${CERTIFIED_PI_VERSION}-agents-detail-${String(options.columns)}x${String(options.rows)}`;
	await writeFleetviewEvidence(options.artifactDirectory, [
		[`${prefix}-initial.txt`, detailInitial],
		[`${prefix}-down.txt`, detailDown],
		[`${prefix}-end.txt`, detailEnd],
		[`${prefix}-tools.txt`, session.capture()],
	]);

	session.sendKey("Escape");
	await session.waitForText("↑/↓ select");
	session.sendKey("Escape");
	screen = await session.waitForFleetviewFrame("idle");
	verifyFleetviewFrame(screen, options.columns, "idle");
	session.sendKey("Down");
	screen = await session.waitForFleetviewFrame("main");
	verifyFleetviewFrame(screen, options.columns, "main");
	session.sendKey("Down");
	screen = await session.waitForFleetviewFrame("terminal");
	verifyFleetviewFrame(screen, options.columns, "terminal");
	verifyFleetviewContextPercent(screen, options.columns, 40);
	session.sendKey("Escape");
	screen = await session.waitForFleetviewFrame("idle");
	verifyFleetviewFrame(screen, options.columns, "idle");
	session.sendKey("C-d");
	await Bun.sleep(250);
}

async function verifyFleetviewFooterLayout(
	options: AgentsPtyVerificationOptions,
	temporaryDirectory: string,
	workspace: string,
	agentDefinition: string,
): Promise<void> {
	const rootDirectory = join(temporaryDirectory, `fleetview-${String(options.columns)}x${String(options.rows)}`);
	const config = join(rootDirectory, "config");
	const agents = join(config, "agents");
	const runtime = join(rootDirectory, "runtime");
	const sessions = join(rootDirectory, "sessions");
	const log = join(rootDirectory, "requests.jsonl");
	await Promise.all([
		mkdir(agents, { recursive: true }),
		mkdir(runtime, { recursive: true }),
		mkdir(sessions, { recursive: true }),
	]);
	await disableSessionNamingForTest(config);
	await Promise.all([
		writeFile(join(agents, "general-purpose.md"), agentDefinition, { mode: 0o600 }),
		writeFile(log, "", { mode: 0o600 }),
		writeFile(
			join(config, "settings.json"),
			`${JSON.stringify({ enableInstallTelemetry: false, outputPad: 1, quietStartup: true, tuiMode: "fullscreen" })}\n`,
			{ mode: 0o600 },
		),
	]);

	const session = new TmuxAgentsSession(options, { config, log, runtime, sessions, workspace });
	try {
		await verifyFleetviewNavigation(session, options);
		await verifyAgentDetail(session, options);
	} catch (error) {
		const providerLog = await readFile(log, "utf8").catch(() => "(provider log unavailable)");
		const diagnostics = await readFailureDiagnostics(rootDirectory);
		const reason = (error instanceof Error ? error.message : String(error)).replace(
			/^Agents PTY verification failed: /u,
			"",
		);
		fail(`${reason}\nProvider log:\n${providerLog.trim()}\nRuntime diagnostics:\n${diagnostics || "(none)"}`);
	} finally {
		session.stop();
	}
}

async function verifyPersistedAgentState(
	requestLog: string,
	sessionDirectory: string,
	workspaceDirectory: string,
): Promise<void> {
	const records = (await readFile(requestLog, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const record = JSON.parse(line);
			if (!Check(LOG_RECORD_SCHEMA, record)) fail("provider log contains a malformed request record");
			return record;
		});
	verifyRequests(records);
	const gitStatus = git(workspaceDirectory, ["status", "--porcelain"]);
	if (gitStatus) fail(`read-only Agent delegation dirtied the workspace:\n${gitStatus}`);
	const workspaceEntries = await readdir(workspaceDirectory, { recursive: true });
	if (workspaceEntries.some((entry) => entry.split(/[\\/]/).includes(".pi-subagents"))) {
		fail("read-only Agent delegation created a project-local .pi-subagents directory");
	}

	const topLevelSessions = (await readdir(sessionDirectory)).filter((entry) => entry.endsWith(".jsonl"));
	if (topLevelSessions.length !== 1 || !topLevelSessions[0]) fail("expected exactly one isolated main session");
	const transcript = await readFile(join(sessionDirectory, topLevelSessions[0]), "utf8");
	for (const required of [
		"subagent",
		"MAIN_NOT_BLOCKED",
		"FINAL_DELIVERABLE_FROM_BACKGROUND_RESULT",
		"pi-stuff-agent-outcome",
	]) {
		if (!transcript.includes(required)) fail(`main session transcript is missing ${required}`);
	}
	for (const forbidden of ["Fleet", "statusline", "AGENT_TOOL_RESULT", "UNSOLICITED_MAIN_TURN"]) {
		if (transcript.includes(forbidden)) fail(`ephemeral or removed UI leaked into the session: ${forbidden}`);
	}
	const sessionEntries = transcript
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const entry = JSON.parse(line);
			if (!Check(SESSION_ENTRY_SCHEMA, entry)) fail("session contains a malformed entry");
			return entry;
		});
	const outcomes = sessionEntries.filter(
		(entry) => entry.type === "custom" && entry.customType === "pi-stuff-agent-outcome",
	);
	if (outcomes.length !== 1) {
		fail(`expected one durable completion outcome across fresh and resumed Pi; received ${String(outcomes.length)}`);
	}
	const outcomeData = outcomes[0]?.data;
	if (!Check(OUTCOME_SCHEMA, outcomeData)) fail("durable completion outcome has invalid data");
	const outcome = outcomeData;
	if (outcome.version !== 1 || outcome.count !== 1 || outcome.status !== "completed") {
		fail("durable completion outcome has the wrong public state projection");
	}
	if (!isRuntimeString(outcome.key) || !/^pi-stuff-result-[a-f0-9]{32}$/.test(outcome.key)) {
		fail(`durable completion outcome does not use a safe digest key: ${JSON.stringify(outcome.key)}`);
	}
	for (const forbiddenKey of ["agent", "task", "report", "summary", "path", "error", "output"]) {
		if (forbiddenKey in outcome) fail(`durable completion outcome exposed ${forbiddenKey}`);
	}

	const artifactsDirectory = join(sessionDirectory, "subagent-artifacts");
	const artifactEntries = await readdir(artifactsDirectory, { recursive: true }).catch((): string[] => []);
	if (!artifactEntries.some((entry) => entry.endsWith("_transcript.jsonl"))) {
		fail("Settings-owned session artifacts did not retain the Agent transcript for /agents resume inspection");
	}
	if (!artifactEntries.some((entry) => entry.endsWith("_output.md"))) {
		fail("Settings-owned session artifacts did not retain the Agent report");
	}
}

export async function verifyAgentsPty(options: AgentsPtyVerificationOptions): Promise<void> {
	verifyHostVersion(options.piBinary);
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-agents-pty-"));
	const configDirectory = join(temporaryDirectory, "config");
	const agentsDirectory = join(configDirectory, "agents");
	const runtimeDirectory = join(temporaryDirectory, "runtime");
	const sessionDirectory = join(configDirectory, "sessions", "pty-project");
	const workspaceDirectory = join(temporaryDirectory, "workspace");
	const requestLog = join(temporaryDirectory, "requests.jsonl");
	await Promise.all([
		mkdir(agentsDirectory, { recursive: true }),
		mkdir(runtimeDirectory),
		mkdir(sessionDirectory, { recursive: true }),
		mkdir(workspaceDirectory),
	]);
	await disableSessionNamingForTest(configDirectory);
	await writeFile(join(workspaceDirectory, "agent-tool-target.txt"), "AGENT_TOOL_RESULT\n", { mode: 0o600 });
	const agentDefinition = `---
name: general-purpose
description: Deterministic native PTY lifecycle Agent.
model: pi-stuff-agents-pty/fixture-model
extensions: ${providerExtension}
systemPromptMode: append
inheritProjectContext: false
inheritSkills: false
---
Return the deterministic fixture result.
`;
	await writeFile(join(agentsDirectory, "general-purpose.md"), agentDefinition, { mode: 0o600 });
	git(workspaceDirectory, ["init", "--quiet"]);
	git(workspaceDirectory, ["config", "user.name", "Pi Stuff PTY"]);
	git(workspaceDirectory, ["config", "user.email", "pty@invalid.example"]);
	git(workspaceDirectory, ["config", "commit.gpgsign", "false"]);
	git(workspaceDirectory, ["add", "agent-tool-target.txt"]);
	git(workspaceDirectory, ["commit", "--quiet", "-m", "test: seed read-only Agent fixture"]);

	try {
		await verifyFleetviewFooterLayout(options, temporaryDirectory, workspaceDirectory, agentDefinition);
		const result = Bun.spawnSync(["expect", "-c", AGENTS_EXPECT_PROGRAM], {
			cwd: workspaceDirectory,
			env: {
				...process.env,
				MAGIC_CONTEXT_PI_SUBAGENT: "1",
				PI_CODING_AGENT_DIR: configDirectory,
				PI_SUBAGENT_PI_BINARY: options.piBinary,
				PI_STUFF_AGENTS_PTY_BIN: options.piBinary,
				PI_STUFF_AGENTS_PTY_COLUMNS: String(options.columns),
				PI_STUFF_AGENTS_PTY_LOG: requestLog,
				PI_STUFF_AGENTS_PTY_MAIN_HELP: fleetviewHelp(options.columns, "main"),
				PI_STUFF_AGENTS_PTY_PACKAGE: resolve(options.packagePath),
				PI_STUFF_AGENTS_PTY_PROVIDER_EXTENSION: providerExtension,
				PI_STUFF_AGENTS_PTY_ROWS: String(options.rows),
				PI_STUFF_AGENTS_PTY_RUNNER: runner,
				PI_STUFF_AGENTS_PTY_SESSIONS: sessionDirectory,
				PI_STUFF_AGENTS_PTY_SESSION_ID: `agents-pty-${options.columns}x${options.rows}`,
				SHELL: "/bin/sh",
				TERM: "xterm-256color",
				TMPDIR: runtimeDirectory,
				XDG_RUNTIME_DIR: runtimeDirectory,
				XDG_STATE_HOME: join(runtimeDirectory, "state"),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = result.stdout.toString();
		if (result.exitCode !== 0) {
			const providerLog = await readFile(requestLog, "utf8").catch(() => "(provider log unavailable)");
			const diagnostics = await readFailureDiagnostics(temporaryDirectory);
			const reason = result.stderr.toString().trim() || `expect exited ${result.exitCode}`;
			fail(
				`${reason}\nProvider log:\n${providerLog.trim()}\nRuntime diagnostics:\n${diagnostics || "(none)"}\nPTY tail:\n${output.slice(-12_000)}`,
			);
		}
		verifyTerminalOutput(output, options.columns);
		await verifyPersistedAgentState(requestLog, sessionDirectory, workspaceDirectory);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
		if (await pathExists(temporaryDirectory)) fail("temporary verification directory was not removed");
	}
}

if (import.meta.main) {
	const PI_BIN = resolvePiBinary();
	const { PI_STUFF_AGENTS_PTY_ARTIFACT_DIR } = process.env;
	for (const [columns, rows] of selectAcceptanceMatrix(
		[
			[100, 32],
			[64, 28],
		] as const,
		[[100, 32]] as const,
	)) {
		const verificationOptions: AgentsPtyVerificationOptions = {
			piBinary: PI_BIN,
			packagePath: join(root, "packages/pi-stuff"),
			columns,
			rows,
		};
		if (PI_STUFF_AGENTS_PTY_ARTIFACT_DIR) {
			Object.assign(verificationOptions, { artifactDirectory: PI_STUFF_AGENTS_PTY_ARTIFACT_DIR });
		}
		await verifyAgentsPty(verificationOptions);
	}
	console.log("Certified Agents in selected PTYs");
}
