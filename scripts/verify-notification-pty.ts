import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";
import { armUiPtyOwnerWatchdog, disarmUiPtyOwnerWatchdog, type UiPtyOwnerWatchdog } from "./ui-pty-owner-watchdog.js";

const root = resolve(import.meta.dir, "..");
const provider = join(root, "tests/fixtures/notification-pty-provider.ts");
const runner = join(root, "tests/fixtures/notification-pty-runner.sh");
const OSC_777_NOTIFY = "\x1b]777;notify;";
const STRING_TERMINATOR = "\x1b\\";
const GRACE_MS = 700;
const TIMEOUT_MS = 20_000;

export interface NotificationPtyVerificationOptions {
	readonly columns?: number;
	readonly packagePath: string;
	readonly piBinary: string;
	readonly rows?: number;
}

function fail(message: string): never {
	throw new Error(`Notification PTY verification failed: ${message}`);
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function editorContains(frame: string, text: string): boolean {
	const lines = frame.split("\n");
	for (let index = 0; index + 2 < lines.length; index += 1) {
		if (
			/^─+$/u.test(lines[index] ?? "") &&
			(lines[index + 1] ?? "").includes(text) &&
			/^─+$/u.test(lines[index + 2] ?? "")
		) {
			return true;
		}
	}
	return false;
}

interface NotificationFrame {
	readonly body: string;
	readonly title: string;
}

function notificationFrames(raw: string): NotificationFrame[] {
	const frames: NotificationFrame[] = [];
	let cursor = 0;
	while (true) {
		const start = raw.indexOf(OSC_777_NOTIFY, cursor);
		if (start < 0) return frames;
		const payloadStart = start + OSC_777_NOTIFY.length;
		const end = raw.indexOf(STRING_TERMINATOR, payloadStart);
		if (end < 0) return frames;
		const payload = raw.slice(payloadStart, end);
		const separator = payload.indexOf(";");
		if (separator >= 0) {
			frames.push({ body: payload.slice(separator + 1), title: payload.slice(0, separator) });
		}
		cursor = end + STRING_TERMINATOR.length;
	}
}

class NotificationPtySession {
	private client: ReturnType<typeof Bun.spawn> | undefined;
	private readonly environment: Record<string, string | undefined>;
	private readonly label = `pinotify-${String(process.pid)}`;
	private readonly rawLog: string;
	private readonly socket: string;
	private readonly target = "pi";
	private readonly workingDirectory: string;
	private watchdog: UiPtyOwnerWatchdog | undefined;

	constructor(workingDirectory: string, environment: Record<string, string | undefined>, rawLog: string) {
		this.environment = environment;
		this.rawLog = rawLog;
		this.socket = join(workingDirectory, `${this.label}.sock`);
		this.workingDirectory = workingDirectory;
	}

	async start(columns: number, rows: number): Promise<void> {
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
				String(columns),
				"-y",
				String(rows),
				"-c",
				this.workingDirectory,
				runner,
				";",
				"set-option",
				"-g",
				"remain-on-exit",
				"on",
			],
			{ env: this.environment, stderr: "pipe", stdout: "pipe" },
		);
		if (result.exitCode !== 0) fail(result.stderr.toString().trim() || "tmux could not start Pi");
		this.tmux(["set-option", "-g", "allow-passthrough", "on"]);
		const attachCommand = ["tmux", "-S", this.socket, "attach-session", "-t", this.target]
			.map((argument) => `'${argument.replaceAll("'", `'\\''`)}'`)
			.join(" ");
		this.client = Bun.spawn(["script", "-qefc", attachCommand, this.rawLog], {
			env: this.environment,
			stderr: "ignore",
			stdout: "ignore",
		});
		await this.waitForClient();
		this.resize(columns, rows);
	}

	capture(): string {
		return this.tmux(["capture-pane", "-p", "-N", "-S", "-", "-t", this.target]);
	}

	resize(columns: number, rows: number): void {
		this.tmux(["resize-window", "-t", this.target, "-x", String(columns), "-y", String(rows)]);
	}

	sendKey(...keys: readonly string[]): void {
		this.tmux(["send-keys", "-t", this.target, ...keys]);
	}

	async sendPrompt(prompt: string): Promise<void> {
		this.tmux(["send-keys", "-t", this.target, "-l", prompt]);
		const deadline = Date.now() + TIMEOUT_MS;
		do {
			this.sendKey("Enter");
			await delay(150);
			if (!editorContains(this.capture(), prompt)) return;
		} while (Date.now() < deadline);
		fail(`timed out submitting ${JSON.stringify(prompt)}\n${this.capture()}`);
	}

	async waitForText(text: string): Promise<string> {
		return this.waitFor((screen) => screen.includes(text), `text ${JSON.stringify(text)}`);
	}

	async waitForFrameCount(count: number): Promise<NotificationFrame[]> {
		let frames: NotificationFrame[] = [];
		await this.waitFor(
			() => {
				frames = notificationFrames(readFileSync(this.rawLog, "utf8"));
				return frames.length === count;
			},
			`${String(count)} OSC 777 notification frames`,
		);
		return frames;
	}

	async waitForExit(): Promise<void> {
		await this.waitFor(
			() => this.tmux(["display-message", "-p", "-t", this.target, "#{pane_dead}"]).trim() === "1",
			"Pi exit",
		);
	}

	stop(): void {
		Bun.spawnSync(["tmux", "-S", this.socket, "kill-server"], { stderr: "pipe", stdout: "pipe" });
		try {
			this.client?.kill();
		} catch {}
		this.client = undefined;
		disarmUiPtyOwnerWatchdog(this.watchdog);
		this.watchdog = undefined;
	}

	private tmux(args: readonly string[]): string {
		const result = Bun.spawnSync(["tmux", "-S", this.socket, ...args], { stderr: "pipe", stdout: "pipe" });
		if (result.exitCode !== 0) fail(`tmux ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
		return result.stdout.toString();
	}

	private async waitForClient(): Promise<void> {
		const deadline = Date.now() + TIMEOUT_MS;
		while (Date.now() < deadline) {
			if (this.tmux(["display-message", "-p", "-t", this.target, "#{session_attached}"]).trim() !== "0") return;
			await delay(25);
		}
		fail("timed out waiting for the outer tmux client");
	}

	private async waitFor(predicate: (screen: string) => boolean, description: string): Promise<string> {
		const deadline = Date.now() + TIMEOUT_MS;
		let screen = "";
		while (Date.now() < deadline) {
			screen = this.capture();
			if (predicate(screen)) return screen;
			await delay(50);
		}
		fail(`timed out waiting for ${description}\n${screen}`);
	}
}

async function createNotificationSession(
	options: NotificationPtyVerificationOptions,
	temporaryDirectory: string,
	rawLog: string,
	columns: number,
	rows: number,
	minimumDurationMs = 0,
): Promise<NotificationPtySession> {
	const agentDirectory = join(temporaryDirectory, "agent");
	const projectDirectory = join(temporaryDirectory, "project");
	const sessionDirectory = join(temporaryDirectory, "sessions");
	await mkdir(temporaryDirectory, { recursive: true });
	await Promise.all([
		mkdir(agentDirectory, { recursive: true }),
		mkdir(projectDirectory, { recursive: true }),
		mkdir(sessionDirectory, { recursive: true }),
		chmod(runner, 0o755),
		writeFile(rawLog, ""),
	]);
	await disableSessionNamingForTest(agentDirectory);
	await Promise.all([
		writeFile(
			join(agentDirectory, "settings.json"),
			`${JSON.stringify({ defaultProjectTrust: "always", retry: { enabled: false } }, null, "\t")}\n`,
			{ mode: 0o600 },
		),
		writeFile(
			join(agentDirectory, "pi-stuff-notification.json"),
			`${JSON.stringify(
				{
					completionAlerts: true,
					delivery: "auto",
					enabled: true,
					failureAlerts: true,
					gracePeriodMs: GRACE_MS,
					minimumDurationMs,
					responsePreview: true,
					schemaVersion: 2,
					terminalBell: false,
				},
				null,
				"\t",
			)}\n`,
			{ mode: 0o600 },
		),
	]);
	return new NotificationPtySession(
		projectDirectory,
		{
			...process.env,
			GHOSTTY_RESOURCES_DIR: "/fixture/ghostty",
			PI_CODING_AGENT_DIR: agentDirectory,
			PI_OFFLINE: "1",
			PI_STUFF_NOTIFICATION_PTY_BIN: options.piBinary,
			PI_STUFF_NOTIFICATION_PTY_COLUMNS: String(columns),
			PI_STUFF_NOTIFICATION_PTY_PACKAGE: resolve(options.packagePath),
			PI_STUFF_NOTIFICATION_PTY_PROVIDER_EXTENSION: provider,
			PI_STUFF_NOTIFICATION_PTY_ROWS: String(rows),
			PI_STUFF_NOTIFICATION_PTY_SESSIONS: sessionDirectory,
			PI_TELEMETRY: "0",
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
			TERM_PROGRAM: "ghostty",
		},
		rawLog,
	);
}

async function verifyPromptWaitIsExcluded(
	options: NotificationPtyVerificationOptions,
	temporaryDirectory: string,
	columns: number,
	rows: number,
): Promise<void> {
	const rawLog = join(temporaryDirectory, "terminal.raw");
	const session = await createNotificationSession(options, temporaryDirectory, rawLog, columns, rows, 2_000);
	try {
		await session.start(columns, rows);
		await session.waitForText("notification-pty-model");
		await session.sendPrompt("NOTIFY_PROMPT_WAIT");
		await session.waitForText("Fixture prompt");
		await delay(2_500);
		session.sendKey("Enter");
		await session.waitForText("NOTIFICATION_PROMPT_DONE");
		await delay(GRACE_MS + 500);
		if (notificationFrames(await readFile(rawLog, "utf8")).length !== 0) {
			fail("UI prompt wait counted toward the minimum Agent Work Duration");
		}
		session.sendKey("C-d");
		await session.waitForExit();
	} finally {
		session.stop();
	}
}

async function verifyNotificationFlow(
	session: NotificationPtySession,
	rawLog: string,
	columns: number,
	rows: number,
): Promise<void> {
	await session.start(columns, rows);
	await session.waitForText("notification-pty-model");
	await session.sendPrompt("/notifications");
	const settingsScreen = await session.waitForText("Response preview");
	for (const label of [
		"Completion alerts",
		"Failure alerts",
		"Delivery",
		"Tmux notification",
		"Also ring terminal bell",
	]) {
		if (!settingsScreen.includes(label)) fail(`Notification settings omitted ${JSON.stringify(label)}`);
	}
	if (settingsScreen.includes("Notification sound")) fail("Notification settings still use the misleading sound name");
	session.sendKey("t");
	let frames = await session.waitForFrameCount(1);
	if (frames[0]?.title !== "Pi · Notification test" || frames[0]?.body !== "Notifications are working.") {
		fail(`unexpected test frame: ${JSON.stringify(frames[0])}`);
	}
	session.sendKey("Escape");
	await delay(100);

	await session.sendPrompt("NOTIFY_SUCCESS");
	await session.waitForText("NOTIFICATION_SUCCESS_DONE");
	frames = await session.waitForFrameCount(2);
	if (frames[1]?.title !== "Pi · project — Ready" || frames[1]?.body !== "NOTIFICATION_SUCCESS_DONE") {
		fail(`unexpected completion frame: ${JSON.stringify(frames[1])}`);
	}

	await session.sendPrompt("NOTIFY_FAILURE");
	await session.waitForText("NOTIFICATION_FAILURE_DONE");
	frames = await session.waitForFrameCount(3);
	if (frames[2]?.title !== "Pi · project — Needs attention" || frames[2]?.body !== "The run ended with an error.") {
		fail(`unexpected failure frame: ${JSON.stringify(frames[2])}`);
	}

	await session.sendPrompt("NOTIFY_CHAOS_CANCEL");
	await session.waitForText("NOTIFICATION_CHAOS_DONE");
	await delay(100);
	session.sendKey("x", "Escape");
	await delay(GRACE_MS + 300);
	if (notificationFrames(await readFile(rawLog, "utf8")).length !== 3)
		fail("random terminal input did not cancel grace");
	session.sendKey("C-c");

	await session.sendPrompt("NOTIFY_RELOAD_CANCEL");
	await session.waitForText("NOTIFICATION_RELOAD_DONE");
	await delay(100);
	await session.sendPrompt("/reload");
	await session.waitForText("Reloaded keybindings, extensions");
	await delay(GRACE_MS + 300);
	if (notificationFrames(await readFile(rawLog, "utf8")).length !== 3) fail("reload did not cancel grace");

	session.resize(48, 24);
	await session.sendPrompt("NOTIFY_SUCCESS_NARROW");
	await session.waitForText("NOTIFICATION_NARROW_DONE");
	frames = await session.waitForFrameCount(4);
	const narrowScreen = session.capture();
	if (narrowScreen.includes("Pi · project — Ready") || narrowScreen.includes("Pi · project — Needs attention")) {
		fail("notification was duplicated into the transcript or permanent UI");
	}
	if (narrowScreen.split("\n").some((line) => visibleWidth(line) > 48)) fail("notification broke narrow layout");

	await session.sendPrompt("NOTIFY_ABORT");
	await delay(250);
	session.sendKey("C-c");
	await delay(GRACE_MS + 500);
	if (notificationFrames(await readFile(rawLog, "utf8")).length !== 4) fail("aborted work emitted a notification");

	await session.sendPrompt("NOTIFY_SHUTDOWN_CANCEL");
	await session.waitForText("NOTIFICATION_SHUTDOWN_DONE");
	await delay(100);
	session.sendKey("C-d");
	await session.waitForExit();
	await delay(GRACE_MS + 100);
	if (notificationFrames(await readFile(rawLog, "utf8")).length !== 4) {
		fail("shutdown emitted a stale notification");
	}
}

export async function verifyNotificationPty(options: NotificationPtyVerificationOptions): Promise<void> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-notification-pty-"));
	const standardDirectory = join(temporaryDirectory, "standard");
	const rawLog = join(standardDirectory, "terminal.raw");
	const columns = options.columns ?? 64;
	const rows = options.rows ?? 28;
	const session = await createNotificationSession(options, standardDirectory, rawLog, columns, rows);
	try {
		await verifyNotificationFlow(session, rawLog, columns, rows);
		session.stop();
		await verifyPromptWaitIsExcluded(options, join(temporaryDirectory, "prompt-wait"), columns, rows);
	} finally {
		session.stop();
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
}
