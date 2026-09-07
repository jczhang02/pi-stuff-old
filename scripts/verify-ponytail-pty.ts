import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { resolvePiBinary } from "./installed-tools.ts";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/ponytail-pty-provider.ts");
const runner = join(root, "tests/fixtures/ponytail-pty-runner.sh");
const WAIT_TIMEOUT_MS = 30_000;
const FULL_COLUMNS = 64;
const FULL_ROWS = 28;
const NARROW_COLUMNS = 48;
const NARROW_ROWS = 16;
const DRAFT = "保留 Ponytail 草稿 · DRAFT_RESTORED";
const PONYTAIL_ICON = "\u{F15BF}";
const PONYTAIL_SKILL_COMMANDS = [
	"skill:ponytail",
	"skill:ponytail-audit",
	"skill:ponytail-debt",
	"skill:ponytail-gain",
	"skill:ponytail-help",
	"skill:ponytail-review",
] as const;

const RECORD_SCHEMA = Type.Object(
	{
		type: Type.String(),
		commands: Type.Optional(Type.Array(Type.String())),
		lastUser: Type.Optional(Type.String()),
		ponytailChars: Type.Optional(Type.Number()),
		ponytailMarkerCount: Type.Optional(Type.Number()),
		hasCatalog: Type.Optional(Type.Boolean()),
		hasCompactPolicy: Type.Optional(Type.Boolean()),
		hasUpstreamLongForm: Type.Optional(Type.Boolean()),
		skillNames: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: true },
);
const SETTINGS_SCHEMA = Type.Object(
	{
		ponytail: Type.Object({
			defaultMode: Type.String(),
			hideStatus: Type.Boolean(),
			quietStartup: Type.Boolean(),
		}),
	},
	{ additionalProperties: true },
);
const SESSION_ENTRY_SCHEMA = Type.Object(
	{
		type: Type.Optional(Type.String()),
		customType: Type.Optional(Type.String()),
		data: Type.Optional(Type.Object({ mode: Type.Optional(Type.String()) }, { additionalProperties: true })),
	},
	{ additionalProperties: true },
);

type RecordLine = Static<typeof RECORD_SCHEMA>;

export interface PonytailPtyVerificationOptions {
	readonly piBinary: string;
	readonly packagePath: string;
}

export interface PonytailPtyEvidence {
	readonly sizes: readonly string[];
	readonly activePromptChars: number;
	readonly verified: readonly string[];
}

interface PonytailSettingsSeed {
	readonly ponytail: {
		readonly defaultMode: string;
		readonly hideStatus: boolean;
		readonly quietStartup: boolean;
	};
}

interface FixturePaths {
	readonly agent: string;
	readonly cache: string;
	readonly config: string;
	readonly data: string;
	readonly log: string;
	readonly project: string;
	readonly runtime: string;
	readonly sessions: string;
}

function fail(message: string): never {
	throw new Error(`Ponytail PTY verification failed: ${message}`);
}

function cleanEnvironment(overrides: Readonly<Record<string, string>>) {
	const environment = { ...process.env };
	for (const key of [
		"PI_STUFF_PONYTAIL_MODE",
		"PONYTAIL_DEFAULT_MODE",
		"PONYTAIL_HIDE_STATUS",
		"PONYTAIL_QUIET_STARTUP",
		"PI_SUBAGENT_PARENT_SESSION_ID",
		"PI_SUBAGENT_PARENT_TOOL_CALL_ID",
		"PI_SUBAGENT_PARENT_AGENT_ID",
	]) {
		delete environment[key];
	}
	return { ...environment, ...overrides };
}

async function createFixture(base: string, settings?: PonytailSettingsSeed): Promise<FixturePaths> {
	const paths: FixturePaths = {
		agent: join(base, "agent"),
		cache: join(base, "cache"),
		config: join(base, "config"),
		data: join(base, "data"),
		log: join(base, "provider.jsonl"),
		project: join(base, "project"),
		runtime: join(base, "runtime"),
		sessions: join(base, "sessions"),
	};
	await Promise.all([
		mkdir(paths.agent, { recursive: true }),
		mkdir(paths.cache, { recursive: true }),
		mkdir(join(paths.config, "cortexkit"), { recursive: true }),
		mkdir(paths.data, { recursive: true }),
		mkdir(paths.project, { recursive: true }),
		mkdir(paths.runtime, { recursive: true, mode: 0o700 }),
		mkdir(paths.sessions, { recursive: true }),
	]);
	await Promise.all([
		writeFile(paths.log, ""),
		writeFile(
			join(paths.agent, "settings.json"),
			JSON.stringify({ defaultProjectTrust: "always", quietStartup: true, theme: "dark", tuiMode: "fullscreen" }) +
				"\n",
			{ mode: 0o600 },
		),
		writeFile(
			join(paths.config, "cortexkit", "magic-context.jsonc"),
			`${JSON.stringify({
				dreamer: { disable: true },
				embedding: { provider: "off" },
				fail_closed_blocking: false,
				sidekick: { disable: true },
				toast_duration_ms: 0,
				todowrite: { enabled: false, overlay: false },
			})}\n`,
			{ mode: 0o600 },
		),
	]);
	if (settings !== undefined) {
		await writeFile(join(paths.agent, "pi-stuff.json"), `${JSON.stringify(settings, null, "\t")}\n`, {
			mode: 0o600,
		});
	}
	return paths;
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

function verifyWidth(screen: string, columns: number, label: string): void {
	for (const [index, line] of screen.split("\n").entries()) {
		const width = visibleWidth(line);
		if (width > columns) {
			fail(`${label} row ${String(index + 1)} occupies ${String(width)}/${String(columns)} columns`);
		}
	}
}

class PonytailPtySession {
	private readonly directory: string;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly socket: string;
	private readonly target: string;
	private stopped = false;

	constructor(directory: string, environment: NodeJS.ProcessEnv, id: string) {
		this.directory = directory;
		this.environment = environment;
		this.socket = join(directory, "ponytail-pty.sock");
		this.target = id;
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
				String(FULL_COLUMNS),
				"-y",
				String(FULL_ROWS),
				"-c",
				this.directory,
				runner,
				";",
				"set-option",
				"-g",
				"remain-on-exit",
				"on",
			],
			{ env: this.environment, stderr: "pipe", stdout: "pipe" },
		);
		if (result.exitCode !== 0) fail(`tmux could not start Pi: ${result.stderr.toString().trim()}`);
		this.tmux(["set-option", "-g", "extended-keys", "on"]);
		if (this.tmux(["show-option", "-gv", "extended-keys"]).trim() !== "on") {
			fail("isolated tmux server did not enable extended keys");
		}
		const serverOptions = this.tmux(["show-options", "-s"]);
		if (/^extended-keys-format\b/m.test(serverOptions)) {
			this.tmux(["set-option", "-s", "extended-keys-format", "csi-u"]);
		}
	}

	capture(): string {
		return this.tmux(["capture-pane", "-p", "-N", "-t", this.target]);
	}

	resize(columns: number, rows: number): void {
		this.tmux(["resize-window", "-x", String(columns), "-y", String(rows), "-t", this.target]);
		const geometry = this.tmux(["display-message", "-p", "-t", this.target, "#{pane_width}x#{pane_height}"]).trim();
		if (geometry !== `${String(columns)}x${String(rows)}`) fail(`unexpected PTY geometry ${geometry}`);
	}

	sendKey(...keys: readonly string[]): void {
		this.tmux(["send-keys", "-t", this.target, ...keys]);
	}

	sendLiteral(value: string): void {
		this.tmux(["send-keys", "-t", this.target, "-l", "--", value]);
	}

	async waitFor(predicate: (screen: string) => boolean, label: string): Promise<string> {
		const deadline = Date.now() + WAIT_TIMEOUT_MS;
		let screen = "";
		while (Date.now() < deadline) {
			screen = this.capture();
			if (predicate(screen)) return screen;
			await Bun.sleep(25);
		}
		fail(`timed out waiting for ${label}\n${screen}`);
	}

	waitForText(text: string): Promise<string> {
		return this.waitFor((screen) => screen.includes(text), JSON.stringify(text));
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		Bun.spawnSync(["tmux", "-S", this.socket, "kill-server"], { stderr: "ignore", stdout: "ignore" });
	}

	private tmux(arguments_: readonly string[]): string {
		const result = Bun.spawnSync(["tmux", "-S", this.socket, ...arguments_], {
			stderr: "pipe",
			stdout: "pipe",
		});
		if (result.exitCode !== 0) {
			fail(`tmux ${arguments_.join(" ")} failed: ${result.stderr.toString().trim()}`);
		}
		return result.stdout.toString();
	}
}

async function readRecords(path: string): Promise<RecordLine[]> {
	return (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const record = JSON.parse(line);
			if (!Check(RECORD_SCHEMA, record)) fail("provider log contains a malformed record");
			return record;
		});
}

async function waitForRecord(
	path: string,
	predicate: (record: RecordLine) => boolean,
	label: string,
): Promise<RecordLine> {
	const deadline = Date.now() + WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const record = (await readRecords(path)).find(predicate);
		if (record) return record;
		await Bun.sleep(25);
	}
	fail(`timed out waiting for provider record ${label}`);
}

async function readPonytailSettings(agentDirectory: string): Promise<Static<typeof SETTINGS_SCHEMA>["ponytail"]> {
	const value = JSON.parse(await readFile(join(agentDirectory, "pi-stuff.json"), "utf8"));
	if (!Check(SETTINGS_SCHEMA, value)) fail("merged settings lost the Ponytail namespace");
	return value.ponytail;
}

async function sessionModes(sessionDirectory: string): Promise<string[]> {
	const files = (await readdir(sessionDirectory, { recursive: true })).filter((file) => file.endsWith(".jsonl"));
	if (files.length !== 1) fail(`expected one Ponytail Session, found ${String(files.length)}`);
	const file = files[0];
	if (!file) fail("Ponytail Session path is missing");
	return (await readFile(join(sessionDirectory, file), "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.flatMap((line) => {
			const entry = JSON.parse(line);
			if (!Check(SESSION_ENTRY_SCHEMA, entry)) fail("Ponytail Session contains a malformed entry");
			return entry.type === "custom" && entry.customType === "ponytail-mode" && entry.data?.mode
				? [entry.data.mode]
				: [];
		});
}

function fixtureEnvironment(
	paths: FixturePaths,
	options: PonytailPtyVerificationOptions,
	sessionId: string,
	overrides: Readonly<Record<string, string>> = {},
) {
	return cleanEnvironment({
		HOME: paths.project,
		HF_HOME: paths.cache,
		HF_HUB_OFFLINE: "1",
		MAGIC_CONTEXT_PI_SUBAGENT: "1",
		PI_CODING_AGENT_DIR: paths.agent,
		PI_OFFLINE: "1",
		PI_STUFF_PONYTAIL_PTY_BIN: options.piBinary,
		PI_STUFF_PONYTAIL_PTY_COLUMNS: String(FULL_COLUMNS),
		PI_STUFF_PONYTAIL_PTY_LOG: paths.log,
		PI_STUFF_PONYTAIL_PTY_PACKAGE: resolve(options.packagePath),
		PI_STUFF_PONYTAIL_PTY_PROVIDER_EXTENSION: providerExtension,
		PI_STUFF_PONYTAIL_PTY_ROWS: String(FULL_ROWS),
		PI_STUFF_PONYTAIL_PTY_SESSIONS: paths.sessions,
		PI_STUFF_PONYTAIL_PTY_SESSION_ID: sessionId,
		PI_TELEMETRY: "0",
		SHELL: "/bin/sh",
		TERM: "xterm-256color",
		TRANSFORMERS_OFFLINE: "1",
		XDG_CACHE_HOME: paths.cache,
		XDG_CONFIG_HOME: paths.config,
		XDG_DATA_HOME: paths.data,
		XDG_RUNTIME_DIR: paths.runtime,
		...overrides,
	});
}

async function waitForDialogMessage(session: PonytailPtySession, message: string): Promise<string> {
	return session.waitFor(
		(screen) => screen.includes(message) && !screen.includes("Saving…"),
		`settled dialog message ${JSON.stringify(message)}`,
	);
}

function requireText(screen: string, required: readonly string[], label: string): void {
	for (const text of required) {
		if (!screen.includes(text)) fail(`${label} is missing ${JSON.stringify(text)}\n${screen}`);
	}
}

async function verifyPrimarySession(
	base: string,
	options: PonytailPtyVerificationOptions,
): Promise<{ activePromptChars: number }> {
	const paths = await createFixture(base);
	await chmod(runner, 0o755);
	const session = new PonytailPtySession(
		paths.project,
		fixtureEnvironment(paths, options, "ponytail-pty-primary"),
		"ponytail-primary",
	);
	try {
		session.start();
		await session.waitForText(`${PONYTAIL_ICON} full`);
		session.sendLiteral(DRAFT);
		await session.waitFor((screen) => editorContains(screen, DRAFT), "typed draft");
		session.sendKey("F12");
		const dialog = await session.waitForText(`${PONYTAIL_ICON} Ponytail · full`);
		requireText(
			dialog,
			[`${PONYTAIL_ICON} Control`, "Session mode", "Review complexity", "Show help", "Enter choose"],
			"Ponytail dialog",
		);
		if (dialog.includes(`${PONYTAIL_ICON} full`)) fail("Ponytail Statusline remained visible under the dialog");
		verifyWidth(dialog, FULL_COLUMNS, "full Ponytail dialog");

		session.resize(NARROW_COLUMNS, NARROW_ROWS);
		const narrow = await session.waitFor(
			(screen) => screen.includes(`${PONYTAIL_ICON} Ponytail · full`) && screen.includes("Enter choose"),
			"narrow Ponytail dialog",
		);
		requireText(narrow, ["Session mode", "Enter choose"], "narrow Ponytail dialog");
		verifyWidth(narrow, NARROW_COLUMNS, "narrow Ponytail dialog");
		session.resize(FULL_COLUMNS, FULL_ROWS);

		session.sendKey("Escape");
		await session.waitFor(
			(screen) => !screen.includes(`${PONYTAIL_ICON} Ponytail · full`) && editorContains(screen, DRAFT),
			"draft restoration",
		);
		session.sendKey("C-u");
		session.sendKey("F12");
		await session.waitForText(`${PONYTAIL_ICON} Ponytail · full`);
		session.sendKey("Enter");
		await session.waitForText("Choose the current Session mode.");
		session.sendKey("Down", "Down", "Down", "Enter");
		await waitForDialogMessage(session, "Session mode set to ultra.");

		session.sendKey("Down", "Enter");
		await session.waitForText("Choose the default for Sessions without a saved mode.");
		session.sendKey("Down", "Enter");
		await waitForDialogMessage(session, "Default mode set to lite.");
		session.sendKey("Down", "Enter");
		await waitForDialogMessage(session, "Statusline hidden.");
		session.sendKey("Enter");
		await waitForDialogMessage(session, "Statusline shown.");
		session.sendKey("Down", "Enter");
		await waitForDialogMessage(session, "Startup notification quiet.");
		session.sendKey("Escape");
		await session.waitFor(
			(screen) => !screen.includes(`${PONYTAIL_ICON} Ponytail · ultra`) && screen.includes(`${PONYTAIL_ICON} ultra`),
			"restored ultra Statusline",
		);

		session.sendLiteral("PONYTAIL_ACTIVE");
		session.sendKey("Enter");
		await session.waitForText("PONYTAIL_ACTIVE_DONE");
		session.sendLiteral("/ponytail off");
		session.sendKey("Escape", "Enter");
		await session.waitForText("Ponytail mode: off");
		await session.waitFor((screen) => !screen.includes(`${PONYTAIL_ICON} ultra`), "hidden off Statusline");
		session.sendLiteral("PONYTAIL_OFF");
		session.sendKey("Enter");
		await session.waitForText("PONYTAIL_OFF_DONE");

		const settings = await readPonytailSettings(paths.agent);
		if (settings.defaultMode !== "lite" || settings.hideStatus !== false || settings.quietStartup !== true) {
			fail(`dialog persisted unexpected settings: ${JSON.stringify(settings)}`);
		}
		const modes = await sessionModes(paths.sessions);
		if (JSON.stringify(modes) !== JSON.stringify(["ultra", "off"])) {
			fail(`Session ledger differs: ${JSON.stringify(modes)}`);
		}
		const records = await readRecords(paths.log);
		const inventory = records.find((record) => record.type === "inventory");
		const commands = inventory?.commands ?? [];
		for (const command of ["ponytail", ...PONYTAIL_SKILL_COMMANDS]) {
			if (!commands.includes(command)) fail(`explicit command inventory is missing ${command}`);
		}
		const active = records.find((record) => record.lastUser?.endsWith("PONYTAIL_ACTIVE"));
		if (
			active?.ponytailMarkerCount !== 1 ||
			active.hasCatalog !== true ||
			active.hasCompactPolicy !== true ||
			active.hasUpstreamLongForm !== false ||
			JSON.stringify([...(active.skillNames ?? [])].sort()) !==
				JSON.stringify(PONYTAIL_SKILL_COMMANDS.map((name) => name.slice(6)).sort()) ||
			!active.ponytailChars ||
			active.ponytailChars > 4_000
		) {
			fail(`active Provider prompt is invalid: ${JSON.stringify(active)}`);
		}
		const off = records.find((record) => record.lastUser?.endsWith("PONYTAIL_OFF"));
		if (
			off?.ponytailChars !== 0 ||
			off.ponytailMarkerCount !== 0 ||
			off.hasCatalog !== false ||
			off.hasCompactPolicy !== false ||
			(off.skillNames?.length ?? 0) !== 0
		) {
			fail(`off Provider prompt is not a hard boundary: ${JSON.stringify(off)}`);
		}
		return { activePromptChars: active.ponytailChars };
	} finally {
		session.stop();
	}
}

async function verifyEnvironmentOverrides(base: string, options: PonytailPtyVerificationOptions): Promise<void> {
	const paths = await createFixture(base, {
		ponytail: { defaultMode: "lite", hideStatus: false, quietStartup: false },
	});
	const session = new PonytailPtySession(
		paths.project,
		fixtureEnvironment(paths, options, "ponytail-pty-overrides", {
			PONYTAIL_DEFAULT_MODE: "ultra",
			PONYTAIL_HIDE_STATUS: "true",
			PONYTAIL_QUIET_STARTUP: "true",
		}),
		"ponytail-overrides",
	);
	try {
		session.start();
		await session.waitForText("ponytail-pty-model");
		await waitForRecord(paths.log, (record) => record.type === "inventory", "Ponytail startup inventory");
		session.sendKey("F12");
		const overview = await session.waitForText(`${PONYTAIL_ICON} Ponytail · ultra`);
		requireText(
			overview,
			["Configuration merged · environment override", "ultra effective · lite saved", "hidden · environment"],
			"override dialog",
		);
		session.sendKey("Down", "Enter");
		await session.waitForText("Choose the default for Sessions without a saved mode.");
		session.sendKey("Down", "Down", "Enter");
		await waitForDialogMessage(session, "Saved full; environment keeps ultra effective.");
		session.sendKey("Down", "Enter");
		await waitForDialogMessage(session, "Saved shown; environment override remains effective.");
		session.sendKey("Escape");
		const closed = await session.waitFor(
			(screen) => !screen.includes(`${PONYTAIL_ICON} Ponytail · ultra`),
			"override dialog close",
		);
		if (closed.includes(`${PONYTAIL_ICON} ultra`)) {
			fail("environment-hidden Statusline became visible after dialog close");
		}
		const settings = await readPonytailSettings(paths.agent);
		if (settings.defaultMode !== "full" || settings.hideStatus !== false || settings.quietStartup !== false) {
			fail(`override dialog changed effective values instead of saved values: ${JSON.stringify(settings)}`);
		}
	} finally {
		session.stop();
	}
}

export async function verifyPonytailPty(options: PonytailPtyVerificationOptions): Promise<PonytailPtyEvidence> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-ponytail-pty-"));
	try {
		const primary = await verifyPrimarySession(join(temporaryDirectory, "primary"), options);
		await verifyEnvironmentOverrides(join(temporaryDirectory, "overrides"), options);
		return {
			sizes: [`${String(FULL_COLUMNS)}x${String(FULL_ROWS)}`, `${String(NARROW_COLUMNS)}x${String(NARROW_ROWS)}`],
			activePromptChars: primary.activePromptChars,
			verified: [
				"dialog navigation, low viewport, Statusline ownership, and draft restoration",
				"mode ledger, merged settings, and environment override read-only behavior",
				"active compact Provider prompt and hard-off Provider boundary",
				"six explicit Ponytail Skill commands while model invocation is mode-gated",
			],
		};
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const PI_BIN = resolvePiBinary();
	const evidence = await verifyPonytailPty({
		piBinary: PI_BIN,
		packagePath: join(root, "packages/pi-stuff"),
	});
	console.log(JSON.stringify(evidence, null, 2));
}
