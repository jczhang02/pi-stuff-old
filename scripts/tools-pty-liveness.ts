import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";

const TOOL_UI_LIVENESS_LIMIT_MS = 150;
const TOOL_SPINNER_LIVENESS_LIMIT_MS = 200;
const SEVERE_STALL_LIMIT_MS = 500;
const WORKING_SPINNER = /([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])\s+Working/u;

type LivenessPayloadKind = "object" | "string";
type PtyEnvironment = Record<string, string | undefined>;

const LIVENESS_EVENT_SCHEMA = Type.Object(
	{
		at: Type.Optional(Type.Number()),
		payloadKind: Type.Union([Type.Literal("object"), Type.Literal("string")]),
		type: Type.Union([Type.Literal("liveness-emitted"), Type.Literal("liveness-ready")]),
	},
	{ additionalProperties: true },
);
type LivenessEvent = Static<typeof LIVENESS_EVENT_SCHEMA>;

export interface ToolsLivenessSample {
	readonly columns: number;
	readonly firstUiMs: number;
	readonly interaction: "input" | "selection";
	readonly interactionMs: number;
	readonly maximumSpinnerFrameMs: number;
	readonly rows: number;
	readonly payloadKind: LivenessPayloadKind;
}

export interface ToolsPtyLivenessOptions {
	readonly columns: number;
	readonly packagePath: string;
	readonly piBinary: string;
	readonly providerExtension: string;
	readonly rows: number;
	readonly runner: string;
}

interface LivenessFixture {
	readonly environment: PtyEnvironment;
	readonly requestLog: string;
	readonly sessionDirectory: string;
	readonly socket: string;
	readonly temporaryDirectory: string;
}

interface ObserveLivenessOptions {
	readonly actionVisible: (frame: string) => boolean;
	readonly capture: () => string;
	readonly columns: number;
	readonly emittedAt: number;
	readonly interaction: ToolsLivenessSample["interaction"];
	readonly rows: number;
	readonly sendAction: () => void;
	readonly settleMarker: string;
	readonly payloadKind: LivenessPayloadKind;
	readonly targetMarker: string;
}

function fail(message: string): never {
	throw new Error(`Tools PTY liveness verification failed: ${message}`);
}

function runCommand(args: readonly string[], environment?: PtyEnvironment): string {
	const result = environment
		? Bun.spawnSync([...args], { env: environment, stderr: "pipe", stdout: "pipe" })
		: Bun.spawnSync([...args], { stderr: "pipe", stdout: "pipe" });
	if (result.exitCode !== 0) {
		fail(`${args.join(" ")} exited ${String(result.exitCode)}: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString();
}

function parseLivenessEvents(contents: string): LivenessEvent[] {
	const events: LivenessEvent[] = [];
	for (const line of contents.trim().split("\n").filter(Boolean)) {
		const value = JSON.parse(line);
		if (Check(LIVENESS_EVENT_SCHEMA, value)) events.push(value);
	}
	return events;
}

function editorContains(frame: string, text: string): boolean {
	const lines = frame.split("\n");
	for (let index = 0; index + 2 < lines.length; index += 1) {
		if (
			/^(?:─+|── [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Working ─+)$/u.test(lines[index] ?? "") &&
			(lines[index + 1] ?? "").includes(text) &&
			/^─+$/u.test(lines[index + 2] ?? "")
		) {
			return true;
		}
	}
	return false;
}

function selectedAutocomplete(frame: string): string | undefined {
	for (const line of frame.split("\n")) {
		const selected = /^\s*→\s+([a-z][\w-]*)/u.exec(line)?.[1];
		if (selected) return selected;
	}
	return undefined;
}

async function waitForLivenessEvent(
	requestLog: string,
	type: LivenessEvent["type"],
	payloadKind: LivenessPayloadKind,
): Promise<LivenessEvent> {
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		const event = parseLivenessEvents(await readFile(requestLog, "utf8")).find(
			(candidate) => candidate.type === type && candidate.payloadKind === payloadKind,
		);
		if (event) return event;
		await Bun.sleep(10);
	}
	const observed = (await readFile(requestLog, "utf8")).trim() || "<empty>";
	fail(`timed out waiting for the ${payloadKind} ${type} event; request log: ${observed}`);
}

async function waitForFrame(
	capture: () => string,
	predicate: (frame: string) => boolean,
	label: string,
	timeoutMs = 10_000,
): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	let frame = "";
	while (Date.now() < deadline) {
		frame = capture();
		if (predicate(frame)) return frame;
		await Bun.sleep(10);
	}
	fail(`timed out waiting for ${label}\nFrame:\n${frame}`);
}

function assertLiveness(sample: ToolsLivenessSample, frame: string): void {
	const worst = Math.max(sample.firstUiMs, sample.interactionMs, sample.maximumSpinnerFrameMs);
	if (worst > SEVERE_STALL_LIMIT_MS) {
		fail(
			`${sample.payloadKind} hit the ${String(SEVERE_STALL_LIMIT_MS)}ms severe-stall backstop: UI ${String(sample.firstUiMs)}ms, ${sample.interaction} ${String(sample.interactionMs)}ms, spinner ${String(sample.maximumSpinnerFrameMs)}ms\nFrame:\n${frame}`,
		);
	}
	if (sample.firstUiMs > TOOL_UI_LIVENESS_LIMIT_MS || sample.interactionMs > TOOL_UI_LIVENESS_LIMIT_MS) {
		fail(
			`${sample.payloadKind} exceeded the ${String(TOOL_UI_LIVENESS_LIMIT_MS)}ms Tool UI limit: UI ${String(sample.firstUiMs)}ms, ${sample.interaction} ${String(sample.interactionMs)}ms\nFrame:\n${frame}`,
		);
	}
	if (sample.maximumSpinnerFrameMs > TOOL_SPINNER_LIVENESS_LIMIT_MS) {
		fail(
			`${sample.payloadKind} working indicator held one frame for ${String(sample.maximumSpinnerFrameMs)}ms (limit ${String(TOOL_SPINNER_LIVENESS_LIMIT_MS)}ms)\nFrame:\n${frame}`,
		);
	}
}

async function observeToolLiveness(options: ObserveLivenessOptions): Promise<ToolsLivenessSample> {
	const actionAt = Date.now();
	options.sendAction();
	let actionVisibleAt: number | undefined;
	let firstUiAt: number | undefined;
	let settled = false;
	let lastFrame = "";
	let maximumSpinnerFrameMs = 0;
	let maximumSpinnerFrame = "";
	let spinnerChangedAt = options.emittedAt;
	let spinnerFrame: string | undefined;
	const spinnerFrames = new Set<string>();
	const deadline = Date.now() + 8_000;
	while (Date.now() < deadline) {
		lastFrame = options.capture();
		const observedAt = Date.now();
		if (firstUiAt === undefined && lastFrame.includes(options.targetMarker)) firstUiAt = observedAt;
		if (actionVisibleAt === undefined && options.actionVisible(lastFrame)) actionVisibleAt = observedAt;
		if (lastFrame.includes(options.settleMarker)) settled = true;
		const nextSpinner = WORKING_SPINNER.exec(lastFrame)?.[1];
		if (nextSpinner) {
			spinnerFrames.add(nextSpinner);
			if (spinnerFrame !== nextSpinner) {
				spinnerFrame = nextSpinner;
				spinnerChangedAt = observedAt;
			} else {
				const unchangedMs = observedAt - spinnerChangedAt;
				if (unchangedMs > maximumSpinnerFrameMs) {
					maximumSpinnerFrameMs = unchangedMs;
					maximumSpinnerFrame = lastFrame;
				}
			}
		}
		if (settled && firstUiAt !== undefined && actionVisibleAt !== undefined && spinnerFrames.size >= 2) break;
		await Bun.sleep(10);
	}
	if (firstUiAt === undefined || actionVisibleAt === undefined || !settled || spinnerFrames.size < 2) {
		fail(
			`${options.payloadKind} observation incomplete: first UI=${String(firstUiAt)}, interaction=${String(actionVisibleAt)}, settled=${String(settled)}, spinner frames=${JSON.stringify([...spinnerFrames])}\nFrame:\n${lastFrame}`,
		);
	}
	const sample = {
		columns: options.columns,
		firstUiMs: firstUiAt - options.emittedAt,
		interaction: options.interaction,
		interactionMs: actionVisibleAt - actionAt,
		maximumSpinnerFrameMs,
		rows: options.rows,
		payloadKind: options.payloadKind,
	} satisfies ToolsLivenessSample;
	assertLiveness(sample, maximumSpinnerFrame || lastFrame);
	return sample;
}

async function prepareFixture(options: ToolsPtyLivenessOptions): Promise<LivenessFixture> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-tools-liveness-"));
	const configDirectory = join(temporaryDirectory, "config");
	const sessionDirectory = join(temporaryDirectory, "sessions");
	const requestLog = join(temporaryDirectory, "requests.jsonl");
	await Promise.all([mkdir(configDirectory), mkdir(sessionDirectory), writeFile(requestLog, "")]);
	await disableSessionNamingForTest(configDirectory);
	await writeFile(
		join(configDirectory, "settings.json"),
		`${JSON.stringify({ defaultProjectTrust: "always", quietStartup: true, tuiMode: "fullscreen" })}\n`,
		{ mode: 0o600 },
	);
	return {
		environment: {
			...process.env,
			HOME: temporaryDirectory,
			PI_CODING_AGENT_DIR: configDirectory,
			PI_STUFF_CODE_MODE_DEFAULT: "off",
			PI_STUFF_TOOLS_PTY_BIN: options.piBinary,
			PI_STUFF_TOOLS_PTY_COLUMNS: String(options.columns),
			PI_STUFF_TOOLS_PTY_LIVENESS: "1",
			PI_STUFF_TOOLS_PTY_LOG: requestLog,
			PI_STUFF_TOOLS_PTY_PACKAGE: resolve(options.packagePath),
			PI_STUFF_TOOLS_PTY_PROVIDER_EXTENSION: options.providerExtension,
			PI_STUFF_TOOLS_PTY_ROWS: String(options.rows),
			PI_STUFF_TOOLS_PTY_RUNNER: options.runner,
			PI_STUFF_TOOLS_PTY_SESSIONS: sessionDirectory,
			PI_STUFF_TOOLS_PTY_SESSION_ID: `tools-liveness-${String(options.columns)}x${String(options.rows)}`,
			PI_TELEMETRY: "0",
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
		},
		requestLog,
		sessionDirectory,
		socket: join(temporaryDirectory, "tmux.sock"),
		temporaryDirectory,
	};
}

function startSession(fixture: LivenessFixture, options: ToolsPtyLivenessOptions, session: string): void {
	runCommand(
		[
			"tmux",
			"-S",
			fixture.socket,
			"-f",
			"/dev/null",
			"start-server",
			";",
			"set-option",
			"-s",
			"extended-keys",
			"on",
			";",
			"new-session",
			"-d",
			"-s",
			session,
			"-x",
			String(options.columns),
			"-y",
			String(options.rows),
			"-c",
			fixture.temporaryDirectory,
			options.runner,
			";",
			"set-option",
			"-t",
			session,
			"remain-on-exit",
			"on",
		],
		fixture.environment,
	);
	const tmux = (args: readonly string[]): string =>
		runCommand(["tmux", "-S", fixture.socket, ...args], fixture.environment);
	const serverOptions = tmux(["show-options", "-s"]);
	if (/^extended-keys-format\b/m.test(serverOptions)) {
		tmux(["set-option", "-s", "extended-keys-format", "csi-u"]);
	}
}

export async function runToolsPtyLiveness(options: ToolsPtyLivenessOptions): Promise<ToolsLivenessSample[]> {
	const fixture = await prepareFixture(options);
	const session = `tools-liveness-${String(process.pid)}-${String(options.columns)}`;
	const tmux = (args: readonly string[]): string => runCommand(["tmux", "-S", fixture.socket, ...args]);
	const capture = (history = false): string =>
		tmux(["capture-pane", "-p", "-N", ...(history ? ["-S", "-"] : []), "-t", session]);
	const sendLiteral = (text: string): void => {
		tmux(["send-keys", "-t", session, "-l", "--", text]);
	};
	const sendKey = (key: string): void => {
		tmux(["send-keys", "-t", session, key]);
	};
	try {
		startSession(fixture, options, session);
		await waitForLivenessEvent(fixture.requestLog, "liveness-ready", "object");
		const objectEvent = await waitForLivenessEvent(fixture.requestLog, "liveness-emitted", "object");
		if (objectEvent.at === undefined) fail("object emission did not include an external timestamp");
		const inputMarker = "OBJECT_INPUT_LIVE";
		const samples = [
			await observeToolLiveness({
				actionVisible: (frame) => editorContains(frame, inputMarker),
				capture,
				columns: options.columns,
				emittedAt: objectEvent.at,
				interaction: "input",
				rows: options.rows,
				sendAction: () => sendLiteral(inputMarker),
				settleMarker: "OBJ_OK",
				payloadKind: "object",
				targetMarker: "LIVE_OBJ",
			}),
		];

		await waitForLivenessEvent(fixture.requestLog, "liveness-ready", "string");
		sendKey("C-u");
		sendLiteral("/t");
		const selectedBefore = selectedAutocomplete(
			await waitForFrame(capture, (frame) => selectedAutocomplete(frame) !== undefined, "Tool-time autocomplete"),
		);
		const stringEvent = await waitForLivenessEvent(fixture.requestLog, "liveness-emitted", "string");
		if (stringEvent.at === undefined || selectedBefore === undefined) fail("string liveness setup was incomplete");
		samples.push(
			await observeToolLiveness({
				actionVisible: (frame) => {
					const selected = selectedAutocomplete(frame);
					return selected !== undefined && selected !== selectedBefore;
				},
				capture,
				columns: options.columns,
				emittedAt: stringEvent.at,
				interaction: "selection",
				rows: options.rows,
				sendAction: () => sendKey("Down"),
				settleMarker: "STR_OK",
				payloadKind: "string",
				targetMarker: "LIVE_STR",
			}),
		);
		return samples;
	} catch (error) {
		let frame = "<closed>";
		try {
			frame = capture(true);
		} catch {
			// Preserve the original failure if the terminal process has already exited.
		}
		throw new Error(`${String(error)}\nFinal terminal frame:\n${frame}`, { cause: error });
	} finally {
		Bun.spawnSync(["tmux", "-S", fixture.socket, "kill-server"], { stderr: "ignore", stdout: "ignore" });
		await rm(fixture.temporaryDirectory, { force: true, recursive: true });
	}
}
