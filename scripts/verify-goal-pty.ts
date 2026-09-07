import { rmSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { isRuntimeFunction } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { GOAL_FINAL_RESPONSE, GOAL_FINAL_RESPONSE_MARKER } from "../tests/fixtures/ui-pty-provider.ts";
import { resolvePiBinary } from "./installed-tools.ts";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/ui-pty-provider.ts");
const runner = join(root, "tests/fixtures/goal-pty-runner.sh");
const WAIT_TIMEOUT_MS = 20_000;

export interface GoalPtyVerificationOptions {
	readonly piBinary: string;
	readonly packagePath: string;
	readonly columns: number;
	readonly rows: number;
}

const PROVIDER_REQUEST_SCHEMA = Type.Object(
	{
		ownedGoalPrompt: Type.Optional(Type.String()),
		tools: Type.Optional(Type.Array(Type.String())),
		type: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const GIT_PROBE_SCHEMA = Type.Object(
	{ providerRequests: Type.Optional(Type.Number()) },
	{ additionalProperties: true },
);
const GOAL_DATA_SCHEMA = Type.Object(
	{
		goal: Type.Optional(Type.Object({ status: Type.Optional(Type.String()) }, { additionalProperties: true })),
	},
	{ additionalProperties: true },
);
const SESSION_MESSAGE_SCHEMA = Type.Object(
	{
		content: Type.Optional(
			Type.Array(Type.Object({ text: Type.Optional(Type.String()) }, { additionalProperties: true })),
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
		display: Type.Optional(Type.Boolean()),
		message: Type.Optional(SESSION_MESSAGE_SCHEMA),
		type: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
function fail(message: string): never {
	throw new Error(`Goal PTY verification failed: ${message}`);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function verifyScreen(screen: string, columns: number, label: string, allowNormalChrome = false): void {
	const divider = (allowNormalChrome ? "─" : "━").repeat(columns);
	if (!screen.includes(divider)) {
		fail(`${label} did not render a ${String(columns)}-column divider\n${screen}`);
	}
	const surface = screen.slice(screen.lastIndexOf(divider));
	const forbiddenChrome = allowNormalChrome ? [] : ["╭", "╮", "╰", "╯", "Working"];
	for (const forbidden of forbiddenChrome) {
		if (surface.includes(forbidden)) fail(`${label} exposed forbidden floating or normal chrome: ${forbidden}`);
	}
	for (const [index, line] of screen.split("\n").entries()) {
		const width = visibleWidth(line);
		if (width > columns) {
			fail(`${label} row ${String(index + 1)} occupies ${String(width)} columns in a ${String(columns)}-column PTY`);
		}
	}
}

class GoalPtySession {
	private readonly configDirectory: string;
	private readonly directory: string;
	private readonly options: GoalPtyVerificationOptions;
	private readonly sessionDirectory: string;
	private readonly socket: string;
	private readonly target = "pi";
	private stopped = false;

	constructor(
		directory: string,
		options: GoalPtyVerificationOptions,
		configDirectory: string,
		sessionDirectory: string,
	) {
		this.configDirectory = configDirectory;
		this.directory = directory;
		this.options = options;
		this.sessionDirectory = sessionDirectory;
		this.socket = join(directory, "goal-pty.sock");
	}

	start(): void {
		const path = process.env["PATH"];
		if (!path) fail("PATH is required to start the Goal PTY fixture");
		const environment = {
			...process.env,
			PATH: `${join(this.directory, "bin")}:${path}`,
			PI_CODING_AGENT_DIR: this.configDirectory,
			PI_OFFLINE: "1",
			PI_STUFF_GOAL_PTY_BIN: this.options.piBinary,
			PI_STUFF_GOAL_PTY_COLUMNS: String(this.options.columns),
			PI_STUFF_GOAL_PTY_PACKAGE: resolve(this.options.packagePath),
			PI_STUFF_GOAL_PTY_PROVIDER_EXTENSION: providerExtension,
			PI_STUFF_GOAL_PTY_GIT_PROBE: join(this.directory, "git-probe.jsonl"),
			PI_STUFF_GOAL_PTY_ROWS: String(this.options.rows),
			PI_STUFF_GOAL_PTY_SESSIONS: this.sessionDirectory,
			PI_STUFF_GOAL_PTY_SESSION_ID: `goal-pty-${String(this.options.columns)}x${String(this.options.rows)}`,
			PI_STUFF_UI_PTY_LOG: join(this.directory, "provider.jsonl"),
			PI_TELEMETRY: "0",
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
		};
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
				this.directory,
				runner,
				";",
				"set-option",
				"-g",
				"remain-on-exit",
				"on",
				";",
				"set-option",
				"-g",
				"extended-keys",
				"on",
			],
			{ env: environment, stderr: "pipe", stdout: "pipe" },
		);
		if (result.exitCode !== 0) {
			fail(`tmux could not start Pi: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`);
		}
		const serverOptions = this.tmux(["show-options", "-s"]);
		if (/^extended-keys-format\b/m.test(serverOptions)) {
			this.tmux(["set-option", "-s", "extended-keys-format", "csi-u"]);
		}
		const geometry = this.tmux(["display-message", "-p", "-t", this.target, "#{pane_width}x#{pane_height}"]).trim();
		if (geometry !== `${String(this.options.columns)}x${String(this.options.rows)}`) {
			fail(`expected ${String(this.options.columns)}x${String(this.options.rows)} PTY, received ${geometry}`);
		}
	}

	capture(): string {
		return this.tmux(["capture-pane", "-p", "-N", "-t", this.target]);
	}

	sendKey(...keys: readonly string[]): void {
		this.tmux(["send-keys", "-t", this.target, ...keys]);
	}

	sendLiteral(value: string): void {
		this.tmux(["send-keys", "-t", this.target, "-l", value]);
	}

	async waitForText(text: string): Promise<string> {
		const deadline = Date.now() + WAIT_TIMEOUT_MS;
		let screen = "";
		while (Date.now() < deadline) {
			screen = this.capture();
			if (screen.includes(text)) return screen;
			await delay(50);
		}
		fail(`timed out waiting for ${JSON.stringify(text)}\n${screen}`);
	}

	async waitForMissing(texts: readonly string[]): Promise<string> {
		const deadline = Date.now() + WAIT_TIMEOUT_MS;
		let screen = "";
		while (Date.now() < deadline) {
			screen = this.capture();
			if (texts.every((text) => !screen.includes(text))) return screen;
			await delay(50);
		}
		fail(`timed out waiting for closed dialog ${JSON.stringify(texts)}\n${screen}`);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		Bun.spawnSync(["tmux", "-S", this.socket, "kill-server"], { stderr: "pipe", stdout: "pipe" });
		rmSync(this.socket, { force: true });
	}

	private tmux(arguments_: readonly string[]): string {
		const result = Bun.spawnSync(["tmux", "-S", this.socket, ...arguments_], {
			stderr: "pipe",
			stdout: "pipe",
		});
		if (result.exitCode !== 0) {
			fail(
				`tmux ${arguments_.join(" ")} failed: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
			);
		}
		return result.stdout.toString();
	}
}

async function verifyGoalDialogs(session: GoalPtySession, columns: number, gitProbePath: string): Promise<void> {
	await session.waitForText("Welcome back!");
	session.sendLiteral("/goal");
	session.sendKey("Enter");
	const main = await session.waitForText("No goal is currently set");
	for (const required of ["Goal", "Start a goal", "Start with token budget", "Settings", "Help"]) {
		if (!main.includes(required)) fail(`Goal manager is missing ${required}\n${main}`);
	}
	verifyScreen(main, columns, "Goal manager");

	session.sendKey("Down", "Down", "Enter");
	const settings = await session.waitForText("Pi Goal Settings");
	for (const required of ["Automatic work", "Unlimited", "No-progress guard", "Off", "Goal tools"]) {
		if (!settings.includes(required)) fail(`Goal SettingsList is missing ${required}\n${settings}`);
	}
	verifyScreen(settings, columns, "Goal SettingsList");

	session.sendKey("Escape");
	await session.waitForText("No goal is currently set");
	session.sendKey("Escape");
	const restored = await session.waitForMissing(["Pi Goal Settings", "No goal is currently set"]);
	verifyScreen(restored, columns, "restored conversation", true);
	if (await readFile(gitProbePath, "utf8").catch(() => "")) {
		fail("handled Goal dialogs triggered a Statusline Git refresh without an Agent turn");
	}
}

async function verifyPersistedGoal(temporaryDirectory: string, sessionDirectory: string): Promise<void> {
	await delay(500);
	const sessionFiles = (await readdir(sessionDirectory, { recursive: true }))
		.filter((file) => file.endsWith(".jsonl"))
		.map((file) => join(sessionDirectory, file));
	if (sessionFiles.length !== 1) {
		fail(`expected one persisted Goal session, found ${String(sessionFiles.length)}`);
	}
	const [sessionFile] = sessionFiles;
	if (!sessionFile) fail("persisted Goal session path is missing");
	const sessionJsonl = await readFile(sessionFile, "utf8");
	const entries = sessionJsonl
		.trim()
		.split("\n")
		.map((line) => {
			const entry = JSON.parse(line);
			if (!Check(SESSION_ENTRY_SCHEMA, entry)) fail("Goal session contains a malformed entry");
			return entry;
		});
	const hiddenEntry = entries.find(
		(entry) => entry.type === "custom_message" && entry.customType === "pi-stuff-goal-prompt",
	);
	if (hiddenEntry?.display !== false) fail("persisted Goal protocol is not marked display=false");
	const goalStates = entries.filter((entry) => entry.type === "custom" && entry.customType === "goal-state");
	const completedGoal = goalStates
		.map((entry) => (Check(GOAL_DATA_SCHEMA, entry.data) ? entry.data.goal : undefined))
		.find((goal) => goal?.status === "complete");
	const completionResults = entries.flatMap((entry) =>
		entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "goal_complete"
			? [entry.message]
			: [],
	);
	const successfulCompletion = completionResults.some((message) =>
		message.content?.some((part) => part.text?.startsWith("Goal complete:")),
	);
	const finalResponseIndexes = entries.flatMap((entry, index) =>
		entry.type === "message" &&
		entry.message?.role === "assistant" &&
		entry.message.content?.some((part) => part.text?.includes(GOAL_FINAL_RESPONSE))
			? [index]
			: [],
	);
	const completedStateIndex = entries.findIndex(
		(entry) =>
			entry.type === "custom" &&
			entry.customType === "goal-state" &&
			Check(GOAL_DATA_SCHEMA, entry.data) &&
			entry.data.goal?.status === "complete",
	);
	if (!completedGoal || !successfulCompletion || finalResponseIndexes.length !== 1) {
		fail(
			`hidden Goal prompt fixture did not complete and persist one final Assistant response: ${JSON.stringify({ completedGoal, completionResults, finalResponseIndexes })}`,
		);
	}
	if (completedStateIndex < 0 || completedStateIndex >= (finalResponseIndexes[0] ?? -1)) {
		fail("Goal completion state was not persisted before its final Assistant response");
	}

	const exportPath = join(temporaryDirectory, "goal-session.html");
	const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const exportModuleUrl = pathToFileURL(join(dirname(piEntry), "core/export-html/index.js")).href;
	const exportModule = await import(exportModuleUrl);
	if (!isRuntimeFunction(exportModule.exportFromFile)) fail("certified Pi HTML exporter is unavailable");
	try {
		await exportModule.exportFromFile(sessionFile, { outputPath: exportPath });
	} catch (error) {
		fail(`Pi HTML export failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const exportedHtml = await readFile(exportPath, "utf8");
	for (const forbidden of ["<goal_objective>", "Goal-mode rules:", "pi-goal-prompt:"]) {
		if (exportedHtml.includes(forbidden)) fail(`Goal protocol leaked as plaintext into HTML export: ${forbidden}`);
	}
}

export async function verifyGoalPty(options: GoalPtyVerificationOptions): Promise<void> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-goal-pty-"));
	const configDirectory = join(temporaryDirectory, "agent");
	const binDirectory = join(temporaryDirectory, "bin");
	const sessionDirectory = join(temporaryDirectory, "sessions");
	const gitProbePath = join(temporaryDirectory, "git-probe.jsonl");
	await Promise.all([mkdir(configDirectory), mkdir(binDirectory), mkdir(sessionDirectory)]);
	await disableSessionNamingForTest(configDirectory);
	await writeFile(
		join(binDirectory, "git"),
		`#!/bin/sh
if [ "$1" = "--no-optional-locks" ] && [ "$2" = "status" ]; then
  requests=$(grep -c '"type":"request"' "$PI_STUFF_UI_PTY_LOG" 2>/dev/null || true)
  requests=$(printf '%s' "$requests" | tr -d ' ')
  printf '{"providerRequests":%s}\n' "$requests" >> "$PI_STUFF_GOAL_PTY_GIT_PROBE"
  printf '## main\\0'
  exit 0
fi
exec /usr/bin/git "$@"
`,
		{ mode: 0o700 },
	);
	await writeFile(
		join(configDirectory, "settings.json"),
		`${JSON.stringify({ defaultProjectTrust: "always", quietStartup: true, theme: "dark", tuiMode: "fullscreen" }, null, "\t")}\n`,
		{ mode: 0o600 },
	);

	const session = new GoalPtySession(temporaryDirectory, options, configDirectory, sessionDirectory);
	try {
		session.start();
		await verifyGoalDialogs(session, options.columns, gitProbePath);

		const objective = "verify hidden Goal protocol";
		session.sendLiteral(`/goal ${objective}`);
		session.sendKey("Enter");
		const completionSummary = "Hidden Goal prompt delivery completed and verified.";
		const active = await session.waitForText("Goal complete · done");
		if (active.includes(completionSummary)) {
			fail(`compact Goal Tool leaked its text result\n${active}`);
		}
		for (const forbidden of ["<goal_objective>", "Goal-mode rules", "pi-goal-prompt:", "Continuation behavior:"]) {
			if (active.includes(forbidden)) fail(`hidden Goal protocol leaked into the TUI: ${forbidden}\n${active}`);
		}
		verifyScreen(active, options.columns, "active hidden Goal prompt", true);

		const finalResponse = await session.waitForText(GOAL_FINAL_RESPONSE_MARKER);
		verifyScreen(finalResponse, options.columns, "Goal final Assistant response", true);

		session.sendKey("C-o");
		const expanded = await session.waitForText(completionSummary);
		const visibleSummaryCount = expanded.split(completionSummary).length - 1;
		if (visibleSummaryCount !== 1) {
			fail(
				`expanded Goal completion summary rendered ${String(visibleSummaryCount)} times instead of once\n${expanded}`,
			);
		}
		session.sendKey("C-o");
		await session.waitForMissing([completionSummary]);

		const requestLog = await readFile(join(temporaryDirectory, "provider.jsonl"), "utf8");
		const requests = requestLog
			.trim()
			.split("\n")
			.map((line) => {
				const record = JSON.parse(line);
				if (!Check(PROVIDER_REQUEST_SCHEMA, record)) fail("provider log contains a malformed request");
				return record;
			})
			.filter((record) => record.type === "request");
		if (requests.length !== 3) {
			fail(`Goal fixture produced ${String(requests.length)} Provider requests instead of three`);
		}
		if (requests.some((request) => !request.tools?.includes("goal_complete"))) {
			fail("A Goal fixture Provider request did not retain goal_complete");
		}
		const gitProbeDeadline = Date.now() + WAIT_TIMEOUT_MS;
		let gitProbe = "";
		while (!gitProbe && Date.now() < gitProbeDeadline) {
			gitProbe = await readFile(gitProbePath, "utf8").catch(() => "");
			if (!gitProbe) await delay(20);
		}
		const gitRefreshes = gitProbe
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const record = JSON.parse(line);
				if (!Check(GIT_PROBE_SCHEMA, record)) fail("Git probe log contains a malformed record");
				return record;
			});
		if (gitRefreshes.length !== 1 || gitRefreshes[0]?.providerRequests !== requests.length) {
			fail(
				`Statusline Git refresh did not wait for the complete user-driven Goal run: ${JSON.stringify(gitRefreshes)}`,
			);
		}
		const deliveredPrompt = requests.find((request) => request.ownedGoalPrompt)?.ownedGoalPrompt ?? "";
		for (const required of [
			`<goal_objective>\n${objective}\n</goal_objective>`,
			"Goal-mode rules:",
			"<!-- pi-goal-prompt:",
		]) {
			if (!deliveredPrompt.includes(required)) fail(`model context is missing hidden Goal protocol: ${required}`);
		}

		await verifyPersistedGoal(temporaryDirectory, sessionDirectory);
	} finally {
		session.stop();
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const PI_BIN = resolvePiBinary();
	await verifyGoalPty({
		piBinary: PI_BIN,
		packagePath: join(root, "packages/pi-stuff"),
		columns: 56,
		rows: 24,
	});
	console.log("Certified Goal Command Dialog and native SettingsList in a 56x24 PTY");
}
