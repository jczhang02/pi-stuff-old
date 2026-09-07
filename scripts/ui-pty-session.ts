import { rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { CERTIFIED_PI_VERSION } from "./pi-host-contract.js";
import { armUiPtyOwnerWatchdog, disarmUiPtyOwnerWatchdog, type UiPtyOwnerWatchdog } from "./ui-pty-owner-watchdog.js";
import type { UiPtyVerificationOptions } from "./verify-ui-pty.js";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/ui-pty-provider.ts");
const runner = join(root, "tests/fixtures/ui-pty-runner.sh");
export const NERD_MODEL_MARKER = "\u{F167A}";
export const POLL_INTERVAL_MS = 50;
export const WAIT_TIMEOUT_MS = 20_000;

export interface CasePaths {
	readonly config: string;
	readonly log: string;
	readonly project: string;
	readonly runtime: string;
	readonly sessions: string;
}

let sessionCounter = 0;
export function fail(message: string): never {
	throw new Error(`UI PTY verification failed: ${message}`);
}

export function commandOutput(
	command: string,
	args: readonly string[],
	options: { readonly cwd?: string } = {},
): string {
	const result = options.cwd
		? Bun.spawnSync([command, ...args], { cwd: options.cwd, stderr: "pipe", stdout: "pipe" })
		: Bun.spawnSync([command, ...args], { stderr: "pipe", stdout: "pipe" });
	if (result.exitCode !== 0) {
		fail(
			`${command} ${args.join(" ")} exited ${String(result.exitCode)}: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`,
		);
	}
	return result.stdout.toString();
}

export function verifyHostVersion(piBinary: string): void {
	const version = commandOutput(piBinary, ["--version"]).trim();
	if (version !== CERTIFIED_PI_VERSION) {
		fail(`expected Pi ${CERTIFIED_PI_VERSION}, received ${version || "no version"}`);
	}
}

export function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function pageToTranscriptText(session: TmuxPiSession, text: string): Promise<string> {
	for (let page = 0; page < 40; page += 1) {
		const screen = session.capture();
		if (screen.includes(text)) return screen;
		session.sendKey("PageUp");
		await delay(POLL_INTERVAL_MS);
	}
	fail(`could not page to resumed transcript text ${JSON.stringify(text)}`);
}

export class TmuxPiSession {
	private columns: number;
	private readonly environment: Record<string, string | undefined>;
	private readonly label: string;
	private readonly project: string;
	private rows: number;
	private readonly socket: string;
	private stopped = false;
	private readonly target = "pi";
	private watchdog: UiPtyOwnerWatchdog | undefined;

	constructor(paths: CasePaths, options: UiPtyVerificationOptions, columns: number, rows: number) {
		sessionCounter += 1;
		this.columns = columns;
		this.rows = rows;
		this.project = paths.project;
		this.label = `piui-${String(process.pid)}-${String(sessionCounter)}`;
		this.socket = join(paths.config, `${this.label}.sock`);
		const environment = { ...process.env };
		for (const key of Object.keys(environment)) {
			if (key.startsWith("PI_SUBAGENT_")) delete environment[key];
		}
		this.environment = {
			...environment,
			COLORTERM: options.colorMode === "256" ? "ansi" : "truecolor",
			MAGIC_CONTEXT_PI_SUBAGENT: "1",
			PI_CODING_AGENT_DIR: paths.config,
			PI_OFFLINE: "1",
			PI_STUFF_CODE_MODE_DEFAULT: "off",
			PI_STUFF_CODE_MODE_FROZEN: undefined,
			PI_STUFF_PONYTAIL_MODE: undefined,
			PONYTAIL_DEFAULT_MODE: "full",
			PONYTAIL_HIDE_STATUS: "0",
			PONYTAIL_QUIET_STARTUP: "1",
			PI_STUFF_UI_PTY_BIN: options.piBinary,
			PI_STUFF_UI_PTY_COLUMNS: String(columns),
			PI_STUFF_UI_PTY_COLORTERM: options.colorMode === "256" ? "ansi" : "truecolor",
			PI_STUFF_UI_PTY_LOG: paths.log,
			PI_STUFF_UI_PTY_PACKAGE: resolve(options.packagePath),
			PI_STUFF_UI_PTY_PROVIDER_EXTENSION: providerExtension,
			PI_STUFF_UI_PTY_ROWS: String(rows),
			PI_STUFF_UI_PTY_MODE: options.tuiMode ?? "fullscreen",
			PI_STUFF_UI_PTY_SESSIONS: paths.sessions,
			PI_STUFF_UI_PTY_SESSION_ID:
				options.sessionId ?? `ui-pty-${String(columns)}x${String(rows)}-${String(sessionCounter)}`,
			PI_STUFF_UI_PTY_SKILL: join(paths.config, "skills", "humanizer-zh", "SKILL.md"),
			PI_TELEMETRY: "0",
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
			XDG_RUNTIME_DIR: paths.runtime,
		};
	}

	async start(): Promise<void> {
		this.watchdog = await armUiPtyOwnerWatchdog(this.socket);
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
				String(this.columns),
				"-y",
				String(this.rows),
				"-c",
				this.project,
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
			disarmUiPtyOwnerWatchdog(this.watchdog);
			this.watchdog = undefined;
			fail(`tmux could not start Pi: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`);
		}
		const serverOptions = this.tmux(["show-options", "-s"]);
		if (/^extended-keys-format\b/m.test(serverOptions)) {
			this.tmux(["set-option", "-s", "extended-keys-format", "csi-u"]);
		}
		const geometry = this.tmux(["display-message", "-p", "-t", this.target, "#{pane_width}x#{pane_height}"]).trim();
		if (geometry !== `${String(this.columns)}x${String(this.rows)}`) {
			fail(`expected ${String(this.columns)}x${String(this.rows)} PTY, received ${geometry}`);
		}
	}

	capture(history = false): string {
		return this.tmux(["capture-pane", "-p", "-N", ...(history ? ["-S", "-"] : []), "-t", this.target]);
	}

	captureAnsi(history = false): string {
		return this.tmux(["capture-pane", "-p", "-e", "-N", ...(history ? ["-S", "-"] : []), "-t", this.target]);
	}

	sendKey(...keys: readonly string[]): void {
		this.tmux(["send-keys", "-t", this.target, ...keys]);
	}

	sendLiteral(value: string): void {
		this.tmux(["send-keys", "-t", this.target, "-l", value]);
	}

	resize(columns: number, rows: number): void {
		this.tmux(["resize-window", "-t", this.target, "-x", String(columns), "-y", String(rows)]);
		const geometry = this.tmux(["display-message", "-p", "-t", this.target, "#{pane_width}x#{pane_height}"]).trim();
		if (geometry !== `${String(columns)}x${String(rows)}`) {
			fail(`live resize expected ${String(columns)}x${String(rows)}, received ${geometry}`);
		}
		const paneTty = this.tmux(["display-message", "-p", "-t", this.target, "#{pane_tty}"]).trim();
		commandOutput("stty", ["-F", paneTty, "rows", String(rows), "columns", String(columns)]);
		this.columns = columns;
		this.rows = rows;
	}

	paneTitle(): string {
		return this.tmux(["display-message", "-p", "-t", this.target, "#{pane_title}"]).trim();
	}

	async waitForText(text: string, history = false): Promise<string> {
		return this.waitFor((screen) => screen.includes(text), `text ${JSON.stringify(text)}`, history);
	}

	async waitForLatestPrompt(text: string): Promise<string> {
		return this.waitFor(
			(screen) => rowsBelowEditorDivider(screen).filter((line) => line.includes(text)).length === 1,
			`one latest-prompt row containing ${JSON.stringify(text)}`,
		);
	}

	async waitForAbsence(text: string): Promise<string> {
		return this.waitFor((screen) => !screen.includes(text), `absence of ${JSON.stringify(text)}`);
	}

	async waitForStatusline(stage = "normal screen"): Promise<string> {
		return this.waitFor(hasStatusline, `the shared Statusline Footer after ${stage}`);
	}

	async waitForStatuslineAbsence(): Promise<string> {
		return this.waitFor((screen) => !hasStatusline(screen), "absence of the shared Statusline Footer");
	}

	async waitForDialogFrame(text: string, columns: number, excludedText?: string): Promise<string> {
		return this.waitFor(
			(screen) =>
				screen.includes(text) &&
				(excludedText === undefined || !screen.includes(excludedText)) &&
				hasFullWidthDivider(screen, columns) &&
				!hasStatusline(screen),
			`${String(columns)}-column Command Dialog frame containing ${JSON.stringify(text)}`,
		);
	}

	async waitForDivider(columns: number): Promise<string> {
		const modelMarker = columns < 32 ? "ui-pt" : "ui-pty-model";
		return this.waitFor(
			(screen) =>
				screen.includes("Welcome back!") &&
				screen.includes(modelMarker) &&
				screen
					.split("\n")
					.some(
						(line) =>
							line.length > 0 &&
							[...line].every((character) => character === "─") &&
							visibleWidth(line) === columns,
					),
			`${String(columns)}-column Welcome divider`,
		);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		Bun.spawnSync(["tmux", "-S", this.socket, "kill-server"], {
			stderr: "pipe",
			stdout: "pipe",
		});
		const probe = Bun.spawnSync(["tmux", "-S", this.socket, "has-session"], {
			stderr: "pipe",
			stdout: "pipe",
		});
		if (probe.exitCode === 0) fail(`isolated tmux server ${this.label} survived cleanup`);
		disarmUiPtyOwnerWatchdog(this.watchdog);
		this.watchdog = undefined;
		rmSync(this.socket, { force: true });
	}

	private tmux(args: readonly string[]): string {
		const result = Bun.spawnSync(["tmux", "-S", this.socket, ...args], {
			stderr: "pipe",
			stdout: "pipe",
		});
		if (result.exitCode !== 0) {
			fail(`tmux ${args.join(" ")} failed: ${result.stderr.toString().trim() || result.stdout.toString().trim()}`);
		}
		return result.stdout.toString();
	}

	async waitFor(predicate: (screen: string) => boolean, description: string, history = false): Promise<string> {
		const deadline = Date.now() + WAIT_TIMEOUT_MS;
		let screen = "";
		while (Date.now() < deadline) {
			screen = this.capture(history);
			if (predicate(screen)) return screen;
			await delay(POLL_INTERVAL_MS);
		}
		fail(`timed out waiting for ${description} in ${String(this.columns)}x${String(this.rows)}\n${screen}`);
	}
}

export async function createCase(
	rootDirectory: string,
	label: string,
	theme: string,
	packagePath: string,
): Promise<CasePaths> {
	const caseDirectory = join(rootDirectory, label);
	const config = join(caseDirectory, "agent");
	const sessions = join(caseDirectory, "sessions");
	const project = join(caseDirectory, "项目", "长路径", "验证");
	const runtime = join(caseDirectory, "runtime");
	const skill = join(config, "skills", "humanizer-zh");
	const log = join(caseDirectory, "ui-pty.jsonl");
	await Promise.all([
		mkdir(config, { recursive: true }),
		mkdir(sessions, { recursive: true }),
		mkdir(project, { recursive: true }),
		mkdir(runtime, { mode: 0o700, recursive: true }),
		mkdir(skill, { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			join(config, "settings.json"),
			`${JSON.stringify(
				{
					defaultProjectTrust: "always",
					enableInstallTelemetry: false,
					hideThinkingBlock: false,
					images: { autoResize: false },
					outputPad: 1,
					packages: [resolve(packagePath)],
					quietStartup: true,
					theme,
					tuiMode: "fullscreen",
				},
				null,
				"\t",
			)}\n`,
			{ mode: 0o600 },
		),
		writeFile(log, "", { mode: 0o600 }),
		writeFile(
			join(skill, "SKILL.md"),
			"---\nname: humanizer-zh\ndescription: Humanize Chinese fixture text\n---\n\nFixture instructions.\n",
			{ mode: 0o600 },
		),
		writeFile(join(project, "tracked-工具.txt"), "committed\n", {
			mode: 0o600,
		}),
	]);
	commandOutput("git", ["init", "-b", "main"], { cwd: project });
	commandOutput("git", ["config", "user.name", "Pi Stuff UI Fixture"], {
		cwd: project,
	});
	commandOutput("git", ["config", "user.email", "ui-fixture@example.invalid"], { cwd: project });
	commandOutput("git", ["config", "commit.gpgsign", "false"], {
		cwd: project,
	});
	commandOutput("git", ["add", "tracked-工具.txt"], { cwd: project });
	commandOutput("git", ["commit", "-m", "fixture"], { cwd: project });
	await Promise.all([
		writeFile(join(project, "tracked-工具.txt"), "modified 中文\n", {
			mode: 0o600,
		}),
		writeFile(join(project, "untracked-🧪.txt"), "new\n", { mode: 0o600 }),
	]);
	return { config, log, project, runtime, sessions };
}

export function rowsBelowEditorDivider(screen: string): readonly string[] {
	const lines = screen.split("\n");
	let dividerIndex = -1;
	for (const [index, line] of lines.entries()) {
		if (line.length > 0 && [...line].every((character) => character === "─")) dividerIndex = index;
	}
	return dividerIndex < 0 ? [] : lines.slice(dividerIndex + 1);
}

export function statuslineRow(screen: string): string | undefined {
	return rowsBelowEditorDivider(screen).find((line) => line.startsWith(`${NERD_MODEL_MARKER} `));
}

export function hasStatusline(screen: string): boolean {
	return statuslineRow(screen) !== undefined;
}

export function hasFullWidthDivider(screen: string, columns: number, character?: string): boolean {
	return screen
		.split("\n")
		.some(
			(line) =>
				line.length > 0 &&
				[...line].every((value) =>
					character === undefined ? value === "─" || value === "━" : value === character,
				) &&
				visibleWidth(line) === columns,
		);
}
