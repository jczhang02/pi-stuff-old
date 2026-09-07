import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isRuntimeString } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { THOUGHT_PHASES, TODO_PTY_READY } from "../tests/fixtures/ui-pty-provider.js";
import { selectAcceptanceMatrix } from "./acceptance-matrix.js";
import { resolvePiBinary } from "./installed-tools.ts";
import { CERTIFIED_PI_HOST_PROFILE, CERTIFIED_PI_VERSION } from "./pi-host-contract.js";
import * as flow from "./ui-pty-interactions.js";
import * as pty from "./ui-pty-session.js";
import { stageSupportedPiHost } from "./verify-pi-host-provenance.js";

export { sanitizePtyEvidence } from "./ui-pty-interactions.js";

const root = resolve(import.meta.dir, "..");
const TARGET_SIZES = [
	{ columns: 100, rows: 32 },
	{ columns: 64, rows: 28 },
	{ columns: 48, rows: 22 },
	{ columns: 32, rows: 18 },
	{ columns: 24, rows: 16 },
] as const;
const ACCEPTANCE_SIZES = selectAcceptanceMatrix(TARGET_SIZES, TARGET_SIZES.slice(0, 2));
const NERD_PONYTAIL_MARKER = "\u{F15BF}";
const NERD_PROMPT_MARKER = "\uF460";
const LONG_PROMPT_PREFIX = "中文_LONG_CJK_PROMPT_开始";
const LONG_PROMPT_TOKEN = "长提示";
const LONG_PROMPT_SUFFIX = "LONG_CJK_PROMPT_结尾";
const LONG_PROMPT = `${LONG_PROMPT_PREFIX} ${Array.from(
	{ length: 48 },
	(_, index) => `${LONG_PROMPT_TOKEN}${String(index + 1).padStart(2, "0")}中文🧪`,
).join(" ")} ${LONG_PROMPT_SUFFIX}`;
const SUBSCRIPTION_MODEL = "ui-pty-subscription";

interface ThemeAccents {
	readonly [theme: string]: string;
}

const CATPPUCCIN_ACCENTS: ThemeAccents = {
	"catppuccin-frappe": "#ca9ee6",
	"catppuccin-latte": "#8839ef",
	"catppuccin-macchiato": "#c6a0f6",
	"catppuccin-mocha": "#cba6f7",
};

export interface UiPtyVerificationOptions {
	readonly artifactDirectory?: string;
	readonly colorMode?: "truecolor" | "256";
	readonly packagePath: string;
	readonly piBinary: string;
	readonly sessionId?: string;
	readonly theme?: string;
	readonly tuiMode?: "regular" | "fullscreen";
}

export interface UiPtyEvidence {
	readonly markdownTransformer: boolean;
	readonly sizes: readonly string[];
	readonly vibeLineMaximumFrameDurationMs: number;
	readonly verified: readonly string[];
}

export interface ThemeLifecycleEvidence {
	readonly colorMode: "truecolor" | "256";
	readonly sizes: readonly string[];
	readonly themes: readonly string[];
	readonly verified: readonly string[];
}
async function verifyPonytailDialog(
	session: pty.TmuxPiSession,
	paths: pty.CasePaths,
	options: UiPtyVerificationOptions,
): Promise<void> {
	let screen = await session.waitForStatusline("initial Ponytail mode");
	if (!screen.includes(`${NERD_PONYTAIL_MARKER} full`)) {
		pty.fail(`Ponytail full mode was absent from the shared Statusline\n${screen}`);
	}

	session.sendLiteral("/ponytail");
	session.sendKey("Enter");
	screen = await session.waitForDialogFrame(`${NERD_PONYTAIL_MARKER} Ponytail · full`, 100);
	flow.verifyDialogSurface(screen, 100, "/ponytail Command Dialog");
	await flow.writePtyEvidence(options.artifactDirectory, `pi-${CERTIFIED_PI_VERSION}-ponytail-open-100x32`, session);

	session.sendKey("Enter");
	await session.waitForText("Choose the current Session mode.");
	session.sendKey("Down");
	session.sendKey("Enter");
	await session.waitForText("Session mode set to lite.");
	session.sendKey("Escape");
	screen = await session.waitForStatusline("closing /ponytail after a mode change");
	if (!screen.includes(`${NERD_PONYTAIL_MARKER} lite`)) {
		pty.fail(`Ponytail mode change did not update the shared Statusline\n${screen}`);
	}

	session.sendLiteral("/ponytail");
	session.sendKey("Enter");
	await session.waitForDialogFrame(`${NERD_PONYTAIL_MARKER} Ponytail · lite`, 100);
	session.sendKey("Enter");
	await session.waitForText("Choose the current Session mode.");
	session.sendKey("Escape");
	await session.waitForText("Review complexity");
	session.sendKey("Escape");
	await session.waitForStatusline("closing /ponytail after nested Escape");

	session.sendKey("C-u");
	session.sendLiteral("/ponytail full");
	session.sendKey("Escape");
	await session.waitForStatusline("closing direct-command autocomplete");
	session.sendKey("Enter");
	screen = await session.waitForText(`${NERD_PONYTAIL_MARKER} full`);
	if (!screen.includes(`${NERD_PONYTAIL_MARKER} full`)) {
		pty.fail(`direct Ponytail command did not restore full mode\n${screen}`);
	}

	const sessionFiles = (await readdir(paths.sessions)).filter((entry) => entry.endsWith(".jsonl"));
	const ledgers = await Promise.all(sessionFiles.map((file) => readFile(join(paths.sessions, file), "utf8")));
	if (!ledgers.some((ledger) => ledger.includes('"customType":"ponytail-mode"'))) {
		pty.fail("Ponytail mode changes were absent from Pi Session history");
	}
}

async function verifyWideUi(
	session: pty.TmuxPiSession,
	paths: pty.CasePaths,
	options: UiPtyVerificationOptions,
): Promise<void> {
	const settingsPath = join(paths.config, "pi-stuff.json");
	let screen = await flow.openUi(session);
	screen = await session.waitForDialogFrame("Tool running timer", 100);
	await flow.writePtyEvidence(options.artifactDirectory, `pi-${CERTIFIED_PI_VERSION}-ui-parity-open-100x32`, session);
	session.resize(64, 28);
	screen = await session.waitForDialogFrame("Tool running timer", 64);
	flow.verifyDialogSurface(screen, 64, "narrow /ui Command Dialog", "─");
	await flow.writePtyEvidence(options.artifactDirectory, `pi-${CERTIFIED_PI_VERSION}-ui-parity-open-64x28`, session);
	session.resize(100, 32);
	await session.waitForDialogFrame("Tool running timer", 100);
	session.sendLiteral("welcome");
	screen = await session.waitForDialogFrame("→ Welcome header", 100);
	if (screen.includes("/tool-settings")) pty.fail("removed /tool-settings appeared in /ui");
	flow.verifyDialogSurface(screen, 100, "/ui Command Dialog", "─");
	flow.verifySettingValue(screen, "Welcome header", true);
	session.sendKey("Enter");
	await flow.waitForPersistedSetting(settingsPath, "ui", "welcomeHeader", false);
	screen = await session.waitForText("false");
	flow.verifySettingValue(screen, "Welcome header", false);
	session.sendKey("Escape");
	await session.waitForStatusline("closing the Welcome /ui dialog");

	session.sendLiteral("DRAFT_草稿");
	await session.waitForText("DRAFT_草稿");
	session.sendKey("F12");
	screen = await session.waitForText("DRAFT_SURFACE 中文");
	if (screen.includes("DRAFT_草稿")) pty.fail("Command Dialog did not temporarily remove the saved editor draft");
	if (pty.hasStatusline(screen)) pty.fail("Statusline remained visible in a fixture Command Dialog");
	session.sendKey("Escape");
	await session.waitForText("DRAFT_草稿");
	await session.waitForStatusline("closing the draft-restoration fixture dialog");

	session.sendKey("C-u");
	session.sendLiteral("/u");
	await session.waitForText("Configure Pi Stuff UI");
	await session.waitForStatuslineAbsence();
	session.sendKey("Escape");
	await session.waitForStatusline("closing native autocomplete");
	if (!session.capture().includes("/u")) pty.fail("native autocomplete Escape did not preserve the editor draft");

	session.sendKey("C-u");
	session.sendLiteral("prefix /hzh");
	await session.waitForText("Humanize Chinese fixture text");
	await session.waitForStatuslineAbsence();
	session.sendKey("Escape");
	await session.waitForText("prefix /hzh");
	await session.waitForStatusline("closing inline slash autocomplete");
	session.sendKey("C-u");
}

async function verifyWidePrompt(
	session: pty.TmuxPiSession,
	paths: pty.CasePaths,
	options: UiPtyVerificationOptions,
): Promise<void> {
	session.sendLiteral(LONG_PROMPT);
	session.sendKey("Enter");
	const finalThought = THOUGHT_PHASES.at(-1) ?? pty.fail("Thinking fixture has no phases");
	await flow.waitForThoughtText(session, finalThought);
	await session.waitForText("UI_PTY_DONE 中文结果🧪");
	await session.waitForText("22%");
	await session.waitForText("$0.42");
	await session.waitForText("\u{F03EB}1");
	await session.waitForText("\u{F0752}1");
	const screen = await session.waitForAbsence("Welcome back!");
	if (!screen.includes(`${NERD_PONYTAIL_MARKER} full`)) pty.fail("settled Statusline lost Ponytail's mode authority");
	for (const capabilityStatus of ["goal:UI", "mcp:2", "load:full"]) {
		if (screen.includes(capabilityStatus))
			pty.fail(`ordinary Statusline exposed capability-owned status: ${capabilityStatus}`);
	}
	const promptLines = pty.rowsBelowEditorDivider(screen).filter((line) => line.includes(LONG_PROMPT_TOKEN));
	if (promptLines.length !== 1) {
		pty.fail(`long prompt occupied ${String(promptLines.length)} Statusline rows instead of exactly one\n${screen}`);
	}
	if (!promptLines[0]?.startsWith(`${NERD_PROMPT_MARKER} 中文`)) {
		pty.fail(`wide-character Prompt text did not align with the model text through a stable icon gap\n${screen}`);
	}
	if (!promptLines[0].includes(LONG_PROMPT_PREFIX) || promptLines[0].includes(LONG_PROMPT_SUFFIX)) {
		pty.fail(`long prompt did not retain its beginning and truncate its bounded tail\n${screen}`);
	}
	const status = pty.statuslineRow(screen);
	if (!status) pty.fail(`settled long-prompt screen lost the shared Statusline\n${screen}`);
	const orderedMarkers = [
		pty.NERD_MODEL_MARKER,
		"\uF0EB",
		"\u{F024B}",
		"\uF418",
		"\u{F03EB}",
		"\u{F0328}",
		"\u{F01BC}",
		"\uF155",
	];
	let priorMarker = -1;
	for (const marker of orderedMarkers) {
		const markerIndex = status.indexOf(marker);
		if (markerIndex < 0) pty.fail(`wide Statusline is missing accepted segment icon ${marker}\n${screen}`);
		if (markerIndex <= priorMarker) pty.fail(`wide Statusline segment order is incorrect\n${screen}`);
		priorMarker = markerIndex;
	}
	const branchIndex = status.indexOf("\uF418");
	const fileStateIndex = status.indexOf("\u{F03EB}");
	if (status.slice(branchIndex, fileStateIndex).includes(" · ")) {
		pty.fail(`wide Statusline split the Git branch and file state into separate groups\n${screen}`);
	}
	if (status.includes("Fast")) pty.fail("disabled Fast mode left a Statusline segment or gap");
	await flow.waitForThoughtText(session, finalThought, true);
	flow.verifyTerminalWidth(screen, 100, "settled Thought and long-prompt screen");
	await flow.writePtyEvidence(
		options.artifactDirectory,
		`pi-${CERTIFIED_PI_VERSION}-statusline-parity-metered-100x32`,
		session,
	);
	const request = [...(await flow.readFixtureRecords(paths.log))]
		.reverse()
		.find((record) => record.type === "request");
	if (request?.lastUser !== LONG_PROMPT) pty.fail("fixture did not receive the complete long CJK prompt");

	await flow.verifyTodoOverlay(session, options, 100, 32);
	session.sendKey("F11");
	await session.waitForText("SUBSCRIPTION_MODEL_READY");
	await session.waitForText(SUBSCRIPTION_MODEL);
	await session.waitForText("22%");
	const subscriptionScreen = session.capture();
	if (subscriptionScreen.includes("$") || subscriptionScreen.includes("(sub)")) {
		pty.fail("API-key kimi-coding subscription exposed cost or a (sub) label");
	}
	const switchRecords = await flow.waitForFixtureRecords(paths.log, "subscription-switch", 1);
	const subscriptionSwitch = [...switchRecords].reverse().find((record) => record.type === "subscription-switch");
	if (
		subscriptionSwitch?.provider !== "kimi-coding" ||
		subscriptionSwitch.model !== SUBSCRIPTION_MODEL ||
		subscriptionSwitch.selected !== true ||
		subscriptionSwitch.usingOAuth !== false
	) {
		pty.fail(`subscription fixture did not select API-key kimi-coding: ${JSON.stringify(subscriptionSwitch)}`);
	}
}

async function verifyWideSettings(session: pty.TmuxPiSession, paths: pty.CasePaths): Promise<void> {
	const settingsPath = join(paths.config, "pi-stuff.json");
	const settings = [
		["density", "Statusline density", "ui", "statuslineDensity", "auto", "full"],
		["latest prompt", "Latest prompt", "ui", "statuslineLatestPrompt", true, false],
		["inline slash", "Inline slash autocomplete", "ui", "inlineSlashAutocomplete", true, false],
		["timer", "Tool running timer", "tools", "liveElapsed", true, false],
	] as const;
	let screen = "";
	for (const [query, label, namespace, key, before, after] of settings) {
		screen = await flow.openFilteredUi(session, query, label);
		flow.verifySettingValue(screen, label, before);
		session.sendKey("Enter");
		await flow.waitForPersistedSetting(settingsPath, namespace, key, after);
		screen = await session.waitForText(String(after));
		flow.verifySettingValue(screen, label, after);
		session.sendKey("Escape");
		if (key === "inlineSlashAutocomplete") await session.waitForAbsence("Type to search");
		await session.waitForStatusline();
		if (key === "inlineSlashAutocomplete") {
			session.sendKey("C-u");
			session.sendLiteral("prefix /hzh");
			await pty.delay(500);
			screen = session.capture();
			if (screen.includes("Humanize Chinese fixture text"))
				pty.fail("disabled inline autocomplete still opened suggestions");
			if (!screen.includes("prefix /hzh") || !pty.hasStatusline(screen)) {
				pty.fail("disabled inline autocomplete did not preserve the editor and Statusline");
			}
		}
	}

	screen = await flow.openUi(session);
	flow.verifySettingValue(screen, "Statusline", true);
	if (pty.hasStatusline(screen)) pty.fail("Statusline reappeared behind /ui after a completed model turn");
	session.sendKey("Enter");
	await flow.waitForPersistedSetting(settingsPath, "ui", "statusline", false);
	screen = await session.waitForText("false");
	flow.verifySettingValue(screen, "Statusline", false);
	session.sendKey("Escape");
	await session.waitForAbsence("Type to search");
	session.sendLiteral("STATUSLINE_OFF_草稿");
	await session.waitForText("STATUSLINE_OFF_草稿");
	if (pty.hasStatusline(session.capture())) pty.fail("disabled Statusline returned after /ui closed");
	session.stop();
}

async function verifyWideRestart(paths: pty.CasePaths, options: UiPtyVerificationOptions): Promise<number> {
	const settingsPath = join(paths.config, "pi-stuff.json");
	const restarted = new pty.TmuxPiSession(paths, options, 100, 32);
	let vibeLineMaximumFrameDurationMs = 0;
	try {
		await restarted.start();
		await flow.waitForFixtureRecords(paths.log, "inventory", 2);
		await restarted.waitForText(TODO_PTY_READY);
		const resumedHistory = await pty.pageToTranscriptText(restarted, "FENCED_TREE_ROOT");
		if (!resumedHistory.includes("├── conversation-ui-with-a-long-label") || !/[▁▂▃▄▅▆▇█]/u.test(resumedHistory)) {
			pty.fail("resumed Session did not re-project canonical chart/tree fence source");
		}
		if (resumedHistory.includes("type: sparkline")) {
			pty.fail("resumed wide Session exposed raw chart source instead of its projection");
		}
		let screen = restarted.capture();
		if (screen.includes("Welcome back!")) pty.fail("persisted Welcome=false was ignored on the next launch");
		if (pty.hasStatusline(screen)) pty.fail("persisted Statusline=false was ignored after restart");
		restarted.sendKey("C-u");
		restarted.sendLiteral("/autoname settings");
		restarted.sendKey("Enter");
		screen = await restarted.waitForText("Keep manually assigned names");
		flow.verifySettingValue(screen, "Automatic naming", "off");
		flow.verifySettingValue(screen, "Rename cooldown", "30 min");
		flow.verifySettingValue(screen, "Keep manually assigned names", "on");
		flow.verifySettingValue(screen, "Naming model", "kimi-coding/ui-pty-subscription");

		for (let index = 0; index < 3; index += 1) restarted.sendKey("Down");
		restarted.sendKey("Enter");
		await restarted.waitForText("Search models");
		restarted.sendLiteral("session");
		screen = await restarted.waitForAbsence("kimi-coding/ui-pty-subscription");
		if (!screen.includes("Session model")) pty.fail("/autoname model search lost the Session-model option");
		restarted.sendKey("Enter");
		await flow.waitForPersistedSetting(settingsPath, "sessionNaming", "model");
		screen = await restarted.waitForText("Session model");
		flow.verifySettingValue(screen, "Naming model", "Session model");
		restarted.sendKey("Escape");
		await restarted.waitForAbsence("Keep manually assigned names");

		screen = await flow.openUi(restarted);
		flow.verifySettingValue(screen, "Statusline", false);
		flow.verifySettingValue(screen, "Statusline density", "full");
		flow.verifySettingValue(screen, "Latest prompt", false);
		flow.verifySettingValue(screen, "Welcome header", false);
		flow.verifySettingValue(screen, "Input highlighting", true);
		flow.verifySettingValue(screen, "Inline slash autocomplete", false);
		flow.verifySettingValue(screen, "Tool running timer", false);
		restarted.sendLiteral("notification delivery");
		screen = await restarted.waitForText("No matching settings");
		if (screen.includes("→ Notification delivery")) pty.fail("Notification settings still appeared under /ui");
		restarted.sendKey("Escape");
		await restarted.waitForAbsence("Type to search");

		const resumedThought = THOUGHT_PHASES.at(-1) ?? pty.fail("Thinking fixture has no phases");
		restarted.sendLiteral("THOUGHT_PROBE_RESTART");
		restarted.sendKey("Enter");
		await restarted.waitForText("THOUGHT_DONE_RESTART");
		await flow.waitForThoughtText(restarted, resumedThought);
		restarted.sendKey("C-t");
		await flow.waitForHiddenThinking(restarted, 1);
		restarted.sendKey("C-t");
		await flow.waitForThoughtText(restarted, resumedThought);

		vibeLineMaximumFrameDurationMs = await flow.verifyVibeLineSpinnerLiveness(restarted);
	} finally {
		restarted.stop();
	}

	const persistedMode = (await stat(settingsPath)).mode & 0o777;
	if (persistedMode !== 0o600) pty.fail(`Pi Stuff settings mode is ${persistedMode.toString(8)}, expected 600`);
	return vibeLineMaximumFrameDurationMs;
}

async function verifyWideInteractions(
	session: pty.TmuxPiSession,
	paths: pty.CasePaths,
	options: UiPtyVerificationOptions,
): Promise<number> {
	await flow.verifyDiagnosticsUi(session, paths, options, 100, 32);
	await flow.verifyCodexDialog(session, paths);
	await flow.verifySessionNamingDialog(session, paths, options);
	await verifyPonytailDialog(session, paths, options);
	await verifyWideUi(session, paths, options);

	await verifyWidePrompt(session, paths, options);

	await verifyWideSettings(session, paths);

	return verifyWideRestart(paths, options);
}

function verifyCatppuccinRecord(
	record: flow.FixtureRecord,
	selectedTheme: string,
	colorMode: "truecolor" | "256" = "truecolor",
): void {
	const accent = CATPPUCCIN_ACCENTS[selectedTheme];
	if (!accent) pty.fail(`unknown Catppuccin theme ${selectedTheme}`);
	const [red, green, blue] = [accent.slice(1, 3), accent.slice(3, 5), accent.slice(5, 7)].map((value) =>
		Number.parseInt(value, 16),
	);
	const expectedAccent = `\x1b[38;2;${String(red)};${String(green)};${String(blue)}m`;
	const expectedHostMode = colorMode === "256" ? "256color" : "truecolor";
	const accentMatches =
		colorMode === "truecolor"
			? record.themeAccent === expectedAccent
			: isRuntimeString(record.themeAccent) &&
				record.themeAccent.startsWith("\u001b[38;5;") &&
				record.themeAccent.endsWith("m");
	if (record.theme !== selectedTheme || record.themeMode !== expectedHostMode || !accentMatches) {
		pty.fail(
			`Pi selected ${String(record.theme)} in ${String(record.themeMode)} with ${String(record.themeAccent)}, expected ${selectedTheme} in ${expectedHostMode}`,
		);
	}
	const availableThemes = record.themes;
	if (
		!Array.isArray(availableThemes) ||
		["dark", "light", ...Object.keys(CATPPUCCIN_ACCENTS)].some((theme) => !availableThemes.includes(theme))
	) {
		pty.fail("Pi did not retain its built-in themes beside all four Catppuccin Package themes");
	}
}

function verifyInventory(
	records: readonly flow.FixtureRecord[],
	selectedTheme?: string,
	colorMode: "truecolor" | "256" = "truecolor",
): boolean {
	const inventory = records.filter((record) => record.type === "inventory");
	if (inventory.length === 0) pty.fail("provider fixture did not observe a real session_start inventory");
	for (const record of inventory) {
		if (!Array.isArray(record.commands)) pty.fail("session inventory did not contain public command names");
		if (!record.commands.includes("ui")) pty.fail("Suite did not register /ui");
		if (!record.commands.includes("diagnostics")) pty.fail("Suite did not register /diagnostics");
		if (!record.commands.includes("notifications")) pty.fail("Suite did not register /notifications");
		if (!record.commands.includes("autoname")) pty.fail("Suite did not register /autoname");
		if (record.commands.includes("notify-test")) pty.fail("Suite still registered removed /notify-test");
		if (record.commands.includes("tool-settings")) pty.fail("Suite still registered removed /tool-settings");
	}
	if (!inventory.every((record) => record.markdownTransformer === true)) {
		pty.fail("Pi Host did not expose the required upstream Markdown-transform API");
	}
	if (CATPPUCCIN_ACCENTS[selectedTheme ?? ""] && selectedTheme) {
		for (const record of inventory) verifyCatppuccinRecord(record, selectedTheme, colorMode);
	}
	return true;
}

export async function verifyUiPty(options: UiPtyVerificationOptions): Promise<UiPtyEvidence> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-ui-pty-"));
	const verified: string[] = [];
	let thinkingDisplay = false;
	let vibeLineMaximumFrameDurationMs: number | undefined;
	try {
		options = {
			...options,
			piBinary: (await stageSupportedPiHost(options.piBinary, temporaryDirectory)).binaryPath,
		};
		pty.verifyHostVersion(options.piBinary);
		pty.commandOutput("tmux", ["-V"]);
		for (const { columns, rows } of ACCEPTANCE_SIZES) {
			const caseOptions: UiPtyVerificationOptions = {
				...options,
				sessionId: options.sessionId ?? `ui-pty-${String(columns)}x${String(rows)}`,
			};
			const paths = await pty.createCase(
				temporaryDirectory,
				`${String(columns)}x${String(rows)}`,
				options.theme ?? "dark",
				options.packagePath,
			);
			const session = new pty.TmuxPiSession(paths, caseOptions, columns, rows);
			try {
				await session.start();
				await session.waitForText("Welcome back!");
				const fresh = await session.waitForStatusline();
				flow.verifyFreshScreen(fresh, columns, rows);
				await flow.writePtyEvidence(
					options.artifactDirectory,
					`pi-${CERTIFIED_PI_VERSION}-statusline-parity-fresh-${String(columns)}x${String(rows)}`,
					session,
				);
				const initialRecords = await flow.waitForFixtureRecords(paths.log, "inventory", 1);
				verifyInventory(initialRecords, options.theme, options.colorMode ?? "truecolor");
				verified.push(`fresh Welcome and Statusline ${String(columns)}x${String(rows)}`);
				if (columns === 100) {
					await flow.verifyLiveResize(session);
					await flow.verifyThoughtLifecycle(session, paths, columns, rows);
					await flow.verifyInterleavedThoughtSpacing(session);
					await flow.verifyThoughtContextPreservation(session, paths);
					await flow.verifyFencedVisualization(session, paths, caseOptions);
					vibeLineMaximumFrameDurationMs = await verifyWideInteractions(session, paths, caseOptions);
					thinkingDisplay = true;
					verified.push(
						"live resize 100x32 -> 64x28 -> 48x22 -> 32x18 -> 24x16 -> 100x32",
						"priority Statusline fields and responsive prompt bounds at the selected acceptance widths",
						"latest-line, hidden, toggled, interleaved spacing, multi-run, settled, resumed, Session-, Provider-, and export-preserved Thinking",
						"100 continuous deltas across 2,500 cumulative CJK characters kept every Vibe Line Spinner frame within 500ms and recovered",
						"User/Assistant streaming, settled, narrow fallback, wide resize, Provider-canonical, Session-canonical, and resumed fenced visualizations",
						"native and inline autocomplete suppression and restoration",
						"long CJK prompt, Welcome scroll-away, streaming and settled Thinking",
						"metered and API-key subscription Statusline cost behavior",
						"expanded four-task Todo alignment in a real Suite turn",
						"responsive /codex controls, Fast persistence, and offline degradation",
						"native /ui settings, Notification exclusion, enum changes, and restart persistence",
						"native /autoname settings completion, responsive searchable model selection, immediate writes, reset, and restart persistence",
						"/ui search, immediate Statusline and Inline changes, Welcome next-launch persistence",
					);
				} else {
					if (columns === 64) {
						await flow.verifyDiagnosticsUi(session, paths, options, columns, rows);
						verified.push("diagnostic notice and full-width details at 64x28");
					}
					await flow.verifyThoughtLifecycle(session, paths, columns, rows);
					verified.push(`latest-line streaming and settled Thinking ${String(columns)}x${String(rows)}`);
					if (columns === 64) {
						await flow.verifyTodoOverlay(session, options, columns, rows);
						verified.push("expanded four-task Todo alignment at 64x28");
					}
				}
			} finally {
				session.stop();
			}
		}
		if (!thinkingDisplay) pty.fail("upstream Host Thinking display was not verified");
		if (vibeLineMaximumFrameDurationMs === undefined) pty.fail("Vibe Line liveness was not measured");
		return {
			markdownTransformer: true,
			sizes: ACCEPTANCE_SIZES.map(({ columns, rows }) => `${String(columns)}x${String(rows)}`),
			verified,
			vibeLineMaximumFrameDurationMs,
		};
	} finally {
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
}

function latestRecord(records: readonly flow.FixtureRecord[], type: string): flow.FixtureRecord {
	return [...records].reverse().find((record) => record.type === type) ?? {};
}

export async function verifyThemeLifecyclePty(
	options: Omit<UiPtyVerificationOptions, "sessionId" | "theme">,
): Promise<ThemeLifecycleEvidence> {
	const themes = selectAcceptanceMatrix(
		["catppuccin-latte", "catppuccin-frappe", "catppuccin-macchiato", "catppuccin-mocha"] as const,
		["catppuccin-latte", "catppuccin-frappe"] as const,
	);
	const sizes = selectAcceptanceMatrix(
		[
			{ columns: 64, rows: 28 },
			{ columns: 100, rows: 32 },
		] as const,
		[{ columns: 100, rows: 32 }] as const,
	);
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-theme-pty-"));
	try {
		options = {
			...options,
			piBinary: (await stageSupportedPiHost(options.piBinary, temporaryDirectory)).binaryPath,
		};
		pty.verifyHostVersion(options.piBinary);
		pty.commandOutput("tmux", ["-V"]);
	} catch (error) {
		await rm(temporaryDirectory, { force: true, recursive: true });
		throw error;
	}
	const initialTheme = themes[0] ?? pty.fail("acceptance theme matrix is empty");
	const paths = await pty.createCase(temporaryDirectory, "lifecycle", initialTheme, options.packagePath);
	const lifecycleOptions: UiPtyVerificationOptions = {
		...options,
		sessionId: "catppuccin-theme-lifecycle",
		theme: initialTheme,
	};
	const colorMode = options.colorMode ?? "truecolor";
	let session = new pty.TmuxPiSession(paths, lifecycleOptions, 100, 32);
	try {
		const verifyThemeSizes = async (theme: string, marker: string): Promise<void> => {
			for (const { columns, rows } of sizes) {
				session.resize(columns, rows);
				const screen = await session.waitForText(marker);
				if (screen.includes("38;2;"))
					pty.fail(`${theme} leaked a raw color escape at ${String(columns)}x${String(rows)}`);
				flow.verifyTerminalWidth(screen, columns, `${theme} at ${String(columns)}x${String(rows)}`);
			}
		};
		await session.start();
		await session.waitForText("Welcome back!");
		await session.waitForStatusline();
		let records = await flow.waitForFixtureRecords(paths.log, "inventory", 1);
		verifyCatppuccinRecord(latestRecord(records, "inventory"), initialTheme, colorMode);
		await verifyThemeSizes(initialTheme, "Welcome back!");

		const draft = "CATPPUCCIN_THEME_DRAFT_中文";
		session.sendLiteral(draft);
		await session.waitForText(draft);
		for (const [index, theme] of themes.slice(1).entries()) {
			session.sendKey("F9");
			records = await flow.waitForFixtureRecords(paths.log, "theme-switch", index + 1);
			const switched = latestRecord(records, "theme-switch");
			if (switched.success !== true) pty.fail(`Pi rejected live theme switch to ${theme}`);
			verifyCatppuccinRecord(switched, theme, colorMode);
			await verifyThemeSizes(theme, draft);
		}

		session.sendKey("C-u");
		session.sendLiteral("THEME_RESUME_MARKER");
		session.sendKey("Enter");
		await session.waitForText("UI_PTY_DONE");
		session.sendLiteral("/reload");
		session.sendKey("Enter");
		records = await flow.waitForFixtureRecords(paths.log, "inventory", 2);
		verifyCatppuccinRecord(latestRecord(records, "inventory"), themes.at(-1) ?? "", colorMode);
		session.stop();

		session = new pty.TmuxPiSession(paths, lifecycleOptions, 100, 32);
		await session.start();
		records = await flow.waitForFixtureRecords(paths.log, "inventory", 3);
		verifyCatppuccinRecord(latestRecord(records, "inventory"), themes.at(-1) ?? "", colorMode);
		await session.waitForText("THEME_RESUME_MARKER", true);
		await session.waitForStatusline();
		return {
			colorMode,
			sizes: sizes.map(({ columns, rows }) => `${String(columns)}x${String(rows)}`),
			themes,
			verified: [
				`all four Package themes discovered; ${themes.join(", ")} rendered at ${sizes.map(({ columns, rows }) => `${columns}x${rows}`).join(", ")} with ${colorMode === "truecolor" ? "exact truecolor accents" : "native 256-color fallback"}`,
				"live switching preserved the editor draft",
				"Extension reload retained the selected theme",
				"resumed Session retained the selected theme",
			],
		};
	} finally {
		session.stop();
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
}

if (import.meta.main) {
	const PI_BIN = resolvePiBinary();
	const { PI_STUFF_UI_PTY_ARTIFACT_DIR, PI_STUFF_UI_PTY_THEME } = process.env;
	const theme = PI_STUFF_UI_PTY_THEME?.trim() || "dark";
	const verificationOptions = {
		piBinary: PI_BIN,
		packagePath: join(root, "packages/pi-stuff"),
		theme,
	};
	if (PI_STUFF_UI_PTY_ARTIFACT_DIR) {
		Object.assign(verificationOptions, { artifactDirectory: PI_STUFF_UI_PTY_ARTIFACT_DIR });
	}
	const evidence = await verifyUiPty(verificationOptions);
	console.log(`Certified production UI in ${evidence.sizes.join(", ")}`);
	console.log(`Host profile: ${CERTIFIED_PI_HOST_PROFILE}`);
	console.log(`Thought transformer: ${evidence.markdownTransformer ? "upstream Host verified" : "missing"}`);
	for (const item of evidence.verified) console.log(`- ${item}`);
}
