import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { isJsonInputObject, parseJsonValue } from "../packages/pi-stuff/src/shared/json-value.js";
import {
	DIAGNOSTIC_PTY_SUMMARY,
	TODO_PTY_PROMPT,
	TODO_PTY_READY,
	TODO_PTY_SUBJECTS,
	USER_VISUALIZATION_SOURCE,
	VIBE_LINE_LIVENESS_PTY_DONE,
	VIBE_LINE_LIVENESS_PTY_PROMPT,
	VISUALIZATION_PTY_PROMPT,
	VISUALIZATION_PTY_RESPONSE,
} from "../tests/fixtures/ui-pty-provider.js";
import { CERTIFIED_PI_VERSION } from "./pi-host-contract.js";
import * as pty from "./ui-pty-session.js";
import { waitForPersistedSessionValue } from "./ui-pty-thinking-evidence.js";
import type { UiPtyVerificationOptions } from "./verify-ui-pty.js";

export {
	verifyInterleavedThoughtSpacing,
	verifyThoughtLifecycle,
	waitForHiddenThinking,
	waitForThoughtText,
} from "./ui-pty-thinking-evidence.js";

const UI_LABELS = [
	"Statusline",
	"Statusline density",
	"Latest prompt",
	"Welcome header",
	"Input highlighting",
	"Inline slash autocomplete",
	"Tool running timer",
] as const;
const NERD_THINKING_MARKER = "\uF0EB med";
const VIBE_LINE_SPINNER = /^(?:── )?[ \t]*([⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏])[ \t]+\S.*$/u;
const VIBE_LINE_STALL_LIMIT_MS = 500;
const FIXTURE_RECORD_SCHEMA = Type.Object(
	{
		commands: Type.Optional(Type.Array(Type.String())),
		lastUser: Type.Optional(Type.String()),
		markdownTransformer: Type.Optional(Type.Boolean()),
		model: Type.Optional(Type.String()),
		provider: Type.Optional(Type.String()),
		priorThinkingPreserved: Type.Optional(Type.Boolean()),
		selected: Type.Optional(Type.Boolean()),
		success: Type.Optional(Type.Boolean()),
		theme: Type.Optional(Type.String()),
		themeAccent: Type.Optional(Type.String()),
		themeMode: Type.Optional(Type.String()),
		themes: Type.Optional(Type.Array(Type.String())),
		type: Type.Optional(Type.String()),
		usingOAuth: Type.Optional(Type.Boolean()),
		visualizationSourcePreserved: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: true },
);
export type FixtureRecord = Static<typeof FIXTURE_RECORD_SCHEMA>;

export function verifyTerminalWidth(screen: string, columns: number, label: string): void {
	for (const [index, line] of screen.split("\n").entries()) {
		const width = visibleWidth(line);
		if (width > columns) {
			pty.fail(
				`${label} row ${String(index + 1)} occupies ${String(width)} columns in a ${String(columns)}-column PTY`,
			);
		}
	}
}

export function verifyNoFloatingFrame(screen: string, label: string): void {
	const lines = screen.split("\n");
	let surfaceStart = 0;
	for (const [index, line] of lines.entries()) {
		if (line.length > 0 && [...line].every((character) => character === "─" || character === "━")) {
			surfaceStart = index;
		}
	}
	const surface = lines.slice(surfaceStart).join("\n");
	for (const forbidden of ["╭", "╮", "╰", "╯"]) {
		if (surface.includes(forbidden)) {
			pty.fail(`${label} exposed floating-frame glyph ${forbidden}\n${screen}`);
		}
	}
}

function verifyWelcomeCard(screen: string, columns: number, rows: number): void {
	for (const corner of ["╭", "╮", "╰", "╯"]) {
		if (!screen.includes(corner)) pty.fail(`${String(columns)}-column Welcome card is missing ${corner}`);
	}
	const title = screen.split("\n").find((line) => line.includes("Pi Stuff"));
	if (!title || visibleWidth(title) !== columns) {
		pty.fail(`${String(columns)}-column Welcome title row is not full-width\n${screen}`);
	}
	const lines = screen.split("\n");
	const compact = columns < 48 || rows <= 18;
	const finalLogoRow = lines.findIndex((line) => line.includes(compact ? "█▀ █" : "██    ██"));
	if (finalLogoRow < 0) {
		pty.fail(
			`${String(columns)}x${String(rows)} Welcome is missing the official ${compact ? "4×2" : "8×4"} Pi mark\n${screen}`,
		);
	}
	const blankAfterLogo = lines[finalLogoRow + 1];
	if (blankAfterLogo?.replace(/[│ ]/gu, "") !== "") {
		pty.fail(`${String(columns)}x${String(rows)} Welcome has no full blank row below the Pi mark\n${screen}`);
	}
	if (compact && screen.includes("██████")) {
		pty.fail(
			`${String(columns)}x${String(rows)} Welcome cropped the full Pi mark instead of selecting the compact mark`,
		);
	}
}

export async function writePtyEvidence(
	directory: string | undefined,
	name: string,
	session: pty.TmuxPiSession,
): Promise<void> {
	if (!directory) return;
	await mkdir(directory, { recursive: true });
	await Promise.all([
		writeFile(join(directory, `${name}.ansi`), sanitizePtyEvidence(session.captureAnsi()), "utf8"),
		writeFile(join(directory, `${name}.txt`), sanitizePtyEvidence(session.capture()), "utf8"),
	]);
}

export function sanitizePtyEvidence(value: string): string {
	return value
		.replace(/\/(?:var\/)?tmp\/(?:agent\/)?pi-stuff-ui-pty-[^/\s]+/gu, "[fixture]")
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trimEnd();
}

export function verifyFreshScreen(screen: string, columns: number, rows: number): void {
	const modelMarker = columns < 32 ? "ui-pt" : "ui-pty-model";
	const requiredFields = ["Welcome back!", modelMarker, ...(columns >= 48 ? ["med"] : [])];
	for (const required of requiredFields) {
		if (!screen.includes(required)) {
			pty.fail(`${String(columns)}-column fresh screen is missing ${required}\n${screen}`);
		}
	}
	const editorDivider = screen
		.split("\n")
		.find((line) => line.length > 0 && [...line].every((character) => character === "─"));
	if (!editorDivider || visibleWidth(editorDivider) !== columns) {
		pty.fail(`${String(columns)}-column editor did not render a full-width divider`);
	}
	verifyWelcomeCard(screen, columns, rows);

	if (columns >= 70) {
		for (const required of [
			"Loaded",
			"Tips for getting started",
			"Type / to browse commands",
			"extensions",
			"tools",
			"skills",
		]) {
			if (!screen.includes(required)) pty.fail(`wide Welcome/Statusline is missing ${required}`);
		}
	} else {
		for (const forbidden of ["Loaded", "Tips for getting started", "extensions", " tools", " skills"]) {
			if (screen.includes(forbidden)) pty.fail(`single-column Welcome retained wide-only ${forbidden}`);
		}
	}
	const statusline = pty.statuslineRow(screen);
	if (!statusline) pty.fail(`${String(columns)}-column screen has no icon-led Statusline below the editor\n${screen}`);
	if (!statusline.startsWith(`${pty.NERD_MODEL_MARKER} `)) {
		pty.fail(`${String(columns)}-column Statusline did not use the deterministic Nerd model icon\n${screen}`);
	}
	if (columns >= 48 && !statusline.includes(NERD_THINKING_MARKER)) {
		pty.fail(`${String(columns)}-column Statusline dropped or mis-rendered the Thinking segment\n${screen}`);
	}
	for (const required of ["ui-pt", "%", ...(columns >= 48 ? ["main"] : [])]) {
		if (!statusline.includes(required)) {
			pty.fail(`${String(columns)}-column Statusline dropped priority field ${required}\n${screen}`);
		}
	}
	verifyTerminalWidth(screen, columns, `fresh ${String(columns)}-column screen`);
}

export async function openUi(session: pty.TmuxPiSession): Promise<string> {
	session.sendKey("C-u");
	session.sendLiteral("/ui");
	session.sendKey("Enter");
	let screen = await session.waitForText("Tool running timer");
	for (const label of UI_LABELS) {
		if (!screen.includes(label)) screen = await session.waitForText(label);
	}
	if (screen.includes("RTK command") || screen.includes("RTK output")) {
		pty.fail("/ui retained RTK behavior settings");
	}
	return screen;
}

export async function openFilteredUi(session: pty.TmuxPiSession, query: string, label: string): Promise<string> {
	await openUi(session);
	session.sendLiteral(query);
	return session.waitForText(`→ ${label}`);
}

export function verifySettingValue(screen: string, label: string, expected: boolean | string): void {
	const row = screen.split("\n").find((line) => line.includes(label));
	if (!row?.includes(String(expected))) {
		pty.fail(`${label} did not show ${String(expected)} in /ui\n${screen}`);
	}
}

export function verifyDialogSurface(screen: string, columns: number, label: string, character = "━"): void {
	if (pty.hasStatusline(screen)) pty.fail(`Statusline remained visible while ${label} owned the input region`);
	verifyNoFloatingFrame(screen, label);
	verifyFullWidthDivider(screen, columns, label, character);
	verifyTerminalWidth(screen, columns, label);
}

export async function waitForPersistedSetting(
	path: string,
	namespace: string,
	key: string,
	expected?: boolean | number | string,
): Promise<void> {
	const deadline = Date.now() + pty.WAIT_TIMEOUT_MS;
	let last = "settings file not created";
	while (Date.now() < deadline) {
		try {
			const text = await readFile(path, "utf8");
			last = text;
			const file = parseJsonValue(text);
			if (!isJsonInputObject(file)) throw new Error("settings file is not a JSON object");
			const settings = file[namespace];
			if (
				isJsonInputObject(settings) &&
				(expected === undefined ? !Object.hasOwn(settings, key) : Object.is(settings[key], expected))
			) {
				return;
			}
		} catch (error) {
			last = String(error);
		}
		await pty.delay(pty.POLL_INTERVAL_MS);
	}
	const expectation = expected === undefined ? "was not removed" : `=${JSON.stringify(expected)} was not persisted`;
	pty.fail(`${namespace}.${key}${expectation}: ${last}`);
}

export async function waitForFixtureRecords(
	path: string,
	type: string,
	count: number,
): Promise<readonly FixtureRecord[]> {
	const deadline = Date.now() + pty.WAIT_TIMEOUT_MS;
	let records: readonly FixtureRecord[] = [];
	while (Date.now() < deadline) {
		records = await readFixtureRecords(path);
		if (records.filter((record) => record.type === type).length >= count) return records;
		await pty.delay(pty.POLL_INTERVAL_MS);
	}
	pty.fail(`fixture log did not reach ${String(count)} ${type} record(s)`);
}

export async function verifyVibeLineSpinnerLiveness(session: pty.TmuxPiSession): Promise<number> {
	session.sendLiteral(VIBE_LINE_LIVENESS_PTY_PROMPT);
	session.sendKey("Enter");
	const frames = new Set<string>();
	const deadline = Date.now() + pty.WAIT_TIMEOUT_MS;
	let currentFrame: string | undefined;
	let frameChangedAt: number | undefined;
	let maximumFrameDurationMs = 0;
	let embeddedIndicatorObserved = false;
	let screen = "";
	while (Date.now() < deadline) {
		screen = session.capture();
		const observedAt = performance.now();
		const spinnerLines = screen.split("\n").filter((line) => VIBE_LINE_SPINNER.test(line));
		const matches = spinnerLines
			.map((line) => VIBE_LINE_SPINNER.exec(line)?.[1])
			.filter((value): value is string => value !== undefined);
		const nextFrame = matches.length === 1 ? matches[0] : undefined;
		if (spinnerLines.length > 1) pty.fail("working indicator rendered more than once");
		if (spinnerLines.length === 1) {
			if (!spinnerLines[0]?.startsWith("── ")) pty.fail("working indicator rendered outside the editor border");
			embeddedIndicatorObserved = true;
		}
		if (nextFrame) {
			frames.add(nextFrame);
			if (nextFrame !== currentFrame) {
				currentFrame = nextFrame;
				frameChangedAt = observedAt;
			}
		}
		if (currentFrame && frameChangedAt !== undefined) {
			const frameDurationMs = observedAt - frameChangedAt;
			maximumFrameDurationMs = Math.max(maximumFrameDurationMs, frameDurationMs);
			if (frameDurationMs > VIBE_LINE_STALL_LIMIT_MS) {
				pty.fail(
					`Vibe Line Spinner frame ${currentFrame} remained unchanged for more than ${String(VIBE_LINE_STALL_LIMIT_MS)}ms`,
				);
			}
		}
		if (screen.includes(VIBE_LINE_LIVENESS_PTY_DONE)) break;
		await pty.delay(pty.POLL_INTERVAL_MS);
	}
	if (!screen.includes(VIBE_LINE_LIVENESS_PTY_DONE)) pty.fail("long CJK Thinking stress did not settle");
	if (frames.size < 2) pty.fail(`Vibe Line Spinner did not advance: ${JSON.stringify([...frames])}`);
	if (!embeddedIndicatorObserved) pty.fail("working indicator did not render inside the editor border");

	const recovery = "VIBE_LINE_RECOVERY";
	session.sendLiteral(`THOUGHT_PROBE_${recovery}`);
	session.sendKey("Enter");
	await session.waitForText(`THOUGHT_DONE_${recovery}`);
	return maximumFrameDurationMs;
}

export async function verifyThoughtContextPreservation(
	session: pty.TmuxPiSession,
	paths: pty.CasePaths,
): Promise<void> {
	session.sendLiteral("VERIFY_CONTEXT_REUSE");
	session.sendKey("Enter");
	await session.waitForText("CONTEXT_PRESERVED");
	const records = await waitForFixtureRecords(paths.log, "request", 2);
	const probe = [...records]
		.reverse()
		.find((record) => record.type === "request" && record.lastUser === "VERIFY_CONTEXT_REUSE");
	if (probe?.priorThinkingPreserved !== true) {
		pty.fail("the next real provider request did not retain the original Thinking in model context");
	}
}

export async function verifyFencedVisualization(
	session: pty.TmuxPiSession,
	paths: pty.CasePaths,
	options: UiPtyVerificationOptions,
): Promise<void> {
	session.sendLiteral(VISUALIZATION_PTY_PROMPT);
	session.sendKey("Enter");

	let screen = await session.waitForText("type: sparkline");
	if (screen.includes("VISUAL-DONE")) {
		pty.fail("streaming chart was not observed in its incomplete source-fence state");
	}
	if (/[▁▂▃▄▅▆▇█]/u.test(screen)) pty.fail("an incomplete chart fence rendered visualization glyphs");

	await session.waitForText("VISUAL-DONE");
	screen = await session.waitForText("├── conversation-ui-with-a-long-label");
	if (!screen.includes("• FENCED_VISUALIZATION_START")) {
		pty.fail("fenced visualization response lost its one outer Assistant marker");
	}
	if (!screen.includes("FENCED_CHART_TITLE") || !/[▁▂▃▄▅▆▇█]/u.test(screen)) {
		pty.fail("settled chart did not render its title and sparkline glyphs");
	}
	if (screen.includes("type: sparkline")) pty.fail("settled wide chart retained raw source rows");
	verifyTerminalWidth(screen, 100, "wide fenced visualization");
	await writePtyEvidence(
		options.artifactDirectory,
		`pi-${CERTIFIED_PI_VERSION}-fenced-visualization-wide-100x32`,
		session,
	);

	session.resize(24, 16);
	await session.waitForText("VISUAL-DONE");
	screen = await session.waitForText("conversation-ui");
	if (screen.includes("├── conversation-ui-with-a-long-label")) {
		pty.fail("too-narrow tree truncated or projected instead of retaining its source fence");
	}
	verifyTerminalWidth(screen, 24, "narrow fenced visualization fallback");
	await writePtyEvidence(
		options.artifactDirectory,
		`pi-${CERTIFIED_PI_VERSION}-fenced-visualization-narrow-24x16`,
		session,
	);

	session.resize(100, 32);
	screen = await session.waitForText("├── conversation-ui-with-a-long-label");
	if (!screen.includes("FENCED_CHART_TITLE") || !/[▁▂▃▄▅▆▇█]/u.test(screen)) {
		pty.fail("wide resize did not restore the chart projection");
	}

	session.sendLiteral("VERIFY_VISUALIZATION_CONTEXT");
	session.sendKey("Enter");
	await session.waitForText("VISUALIZATION_CONTEXT_PRESERVED");
	const records = await waitForFixtureRecords(paths.log, "request", 4);
	const probe = [...records]
		.reverse()
		.find((record) => record.type === "request" && record.lastUser === "VERIFY_VISUALIZATION_CONTEXT");
	if (probe?.visualizationSourcePreserved !== true) {
		pty.fail("the next real Provider request did not retain canonical chart/tree fence source");
	}

	session.sendKey("F8");
	screen = await session.waitForText("└── user-child");
	if (!screen.includes("USER_TREE_ROOT")) pty.fail("real Pi User Markdown lost its projected tree root");
	await session.waitForText("USER-VISUALIZATION-ACK");
	const userRecords = await waitForFixtureRecords(paths.log, "request", 5);
	const userRequest = [...userRecords]
		.reverse()
		.find((record) => record.type === "request" && record.lastUser === USER_VISUALIZATION_SOURCE);
	if (!userRequest) pty.fail("real Pi Provider did not receive canonical User tree fence source");
	await writePtyEvidence(
		options.artifactDirectory,
		`pi-${CERTIFIED_PI_VERSION}-fenced-visualization-user-100x32`,
		session,
	);
	await waitForPersistedSessionValue(
		paths.sessions,
		VISUALIZATION_PTY_RESPONSE,
		"the canonical fenced visualization source",
	);
}
export async function verifyLiveResize(session: pty.TmuxPiSession): Promise<void> {
	for (const { columns, rows } of [
		{ columns: 64, rows: 28 },
		{ columns: 48, rows: 22 },
		{ columns: 32, rows: 18 },
		{ columns: 24, rows: 16 },
		{ columns: 100, rows: 32 },
	]) {
		session.resize(columns, rows);
		await session.waitForDivider(columns);
		const screen = await session.waitForStatusline();
		verifyFreshScreen(screen, columns, rows);
	}
}

export function verifyFullWidthDivider(screen: string, columns: number, label: string, character = "━"): void {
	if (!pty.hasFullWidthDivider(screen, columns, character)) {
		pty.fail(`${label} did not expose a ${String(columns)}-column divider\n${screen}`);
	}
}

export async function verifyCodexDialog(session: pty.TmuxPiSession, paths: pty.CasePaths): Promise<void> {
	const settingsPath = join(paths.config, "pi-stuff.json");
	session.sendKey("C-u");
	session.sendLiteral("/codex");
	session.sendKey("Enter");
	let screen = await session.waitForText("gpt-image-2");
	await session.waitForText("Codex usage is unavailable in offline mode.");
	verifySettingValue(screen, "Fast mode", "off");
	verifyDialogSurface(screen, 100, "/codex Command Dialog");

	session.resize(64, 28);
	screen = await session.waitForDialogFrame("gpt-image-2", 64);
	verifyDialogSurface(screen, 64, "narrow /codex Command Dialog");
	session.resize(100, 32);
	await session.waitForDialogFrame("gpt-image-2", 100);
	session.sendKey("Escape");
	await session.waitForStatusline("closing the first /codex dialog");

	session.sendKey("C-u");
	session.sendLiteral("/codex fast");
	session.sendKey("Enter");
	// Pi may use the first Enter to accept the exact argument completion.
	await pty.delay(100);
	session.sendKey("Enter");
	await waitForPersistedSetting(settingsPath, "codex", "fast", true);
	session.sendLiteral("/codex");
	session.sendKey("Enter");
	screen = await session.waitForText("gpt-image-2");
	verifySettingValue(screen, "Fast mode", "on");
	session.sendKey("Enter");
	await waitForPersistedSetting(settingsPath, "codex", "fast", false);
	screen = await session.waitForText("off");
	verifySettingValue(screen, "Fast mode", "off");
	session.sendKey("Escape");
	await session.waitForStatusline("closing the Fast-mode /codex dialog");
}

export async function verifySessionNamingDialog(
	session: pty.TmuxPiSession,
	paths: pty.CasePaths,
	options: UiPtyVerificationOptions,
): Promise<void> {
	const settingsPath = join(paths.config, "pi-stuff.json");
	session.sendKey("C-u");
	session.sendLiteral("/autoname s");
	let screen = await session.waitForText("settings");
	if (!screen.includes("/autoname s")) pty.fail("/autoname argument completion did not preserve the editor prefix");
	if (pty.hasStatusline(screen)) pty.fail("Statusline remained visible while /autoname argument completion was open");
	session.sendKey("Enter");
	screen = await session.waitForStatusline("accepting /autoname argument completion");
	if (!screen.includes("/autoname settings")) pty.fail("/autoname argument completion did not accept settings");
	session.sendKey("Enter");
	screen = await session.waitForText("Keep manually assigned names");

	verifySettingValue(screen, "Automatic naming", "on");
	verifySettingValue(screen, "Rename cooldown", "10 min");
	verifySettingValue(screen, "Keep manually assigned names", "off");
	verifySettingValue(screen, "Naming model", "Session model");
	if (screen.includes("fallbackModels")) pty.fail("/autoname settings exposed fallback model controls");
	verifyDialogSurface(screen, 100, "/autoname settings Command Dialog", "─");
	await writePtyEvidence(
		options.artifactDirectory,
		`pi-${CERTIFIED_PI_VERSION}-session-naming-settings-100x32`,
		session,
	);

	session.resize(64, 28);
	screen = await session.waitForDialogFrame("Keep manually assigned names", 64);
	verifyDialogSurface(screen, 64, "narrow /autoname settings Command Dialog", "─");
	await writePtyEvidence(
		options.artifactDirectory,
		`pi-${CERTIFIED_PI_VERSION}-session-naming-settings-64x28`,
		session,
	);

	session.resize(24, 16);
	screen = await session.waitForDialogFrame("Keep manual names", 24);
	verifySettingValue(screen, "Auto naming", "on");
	verifySettingValue(screen, "Cooldown", "10 min");
	verifySettingValue(screen, "Keep manual names", "off");
	verifySettingValue(screen, "Model", "Session");
	verifyDialogSurface(screen, 24, "small /autoname settings Command Dialog", "─");
	await writePtyEvidence(
		options.artifactDirectory,
		`pi-${CERTIFIED_PI_VERSION}-session-naming-settings-24x16`,
		session,
	);

	session.resize(100, 32);
	await session.waitForDialogFrame("Keep manually assigned names", 100);

	session.sendKey("Enter");
	await waitForPersistedSetting(settingsPath, "sessionNaming", "enabled", false);
	screen = await session.waitForText("off");
	verifySettingValue(screen, "Automatic naming", "off");

	session.sendKey("Down");
	session.sendKey("Enter");
	await waitForPersistedSetting(settingsPath, "sessionNaming", "cooldownMinutes", 30);
	screen = await session.waitForText("30 min");
	verifySettingValue(screen, "Rename cooldown", "30 min");

	session.sendKey("Down");
	session.sendKey("Enter");
	await waitForPersistedSetting(settingsPath, "sessionNaming", "respectManualName", true);
	screen = await session.waitForText("on");
	verifySettingValue(screen, "Keep manually assigned names", "on");

	session.sendKey("Down");
	session.sendKey("Enter");
	screen = await session.waitForText("Search models");
	if (!screen.includes("Session model") || !screen.includes("kimi-coding/ui-pty-subscription")) {
		pty.fail(`/autoname model picker did not expose the Session and available fixture models\n${screen}`);
	}
	verifyFullWidthDivider(screen, 100, "/autoname model picker", "─");
	verifyTerminalWidth(screen, 100, "/autoname model picker");

	session.resize(64, 28);
	screen = await session.waitForDialogFrame("Session model", 64);
	if (!screen.includes("Session model")) pty.fail("narrow /autoname model picker lost the Session-model option");
	verifyTerminalWidth(screen, 64, "narrow /autoname model picker");
	await writePtyEvidence(options.artifactDirectory, `pi-${CERTIFIED_PI_VERSION}-session-naming-models-64x28`, session);

	session.resize(24, 16);
	screen = await session.waitForDialogFrame("Session model", 24);
	if (!screen.includes("Session model")) {
		pty.fail(`small /autoname model picker lost the Session-model option\n${screen}`);
	}
	verifyTerminalWidth(screen, 24, "small /autoname model picker");
	await writePtyEvidence(options.artifactDirectory, `pi-${CERTIFIED_PI_VERSION}-session-naming-models-24x16`, session);

	session.resize(100, 32);
	await session.waitForDialogFrame("Search models", 100);
	session.sendLiteral("kimi");
	screen = await session.waitForDialogFrame("kimi-coding/ui-pty-su", 100, "pi-stuff-ui-pty/ui-pty-model");
	session.sendKey("Enter");
	await waitForPersistedSetting(settingsPath, "sessionNaming", "model", "kimi-coding/ui-pty-subscription");
	screen = await session.waitForText("kimi-coding/ui-pty-subscription");
	verifySettingValue(screen, "Naming model", "kimi-coding/ui-pty-subscription");
	session.sendKey("Escape");
	screen = await session.waitForStatusline("closing /autoname settings");
	if (!screen.includes("ui-pty-model")) pty.fail("selecting a naming model changed the active Session model");
}

export async function verifyTodoOverlay(
	session: pty.TmuxPiSession,
	options: UiPtyVerificationOptions,
	columns: number,
	rows: number,
): Promise<void> {
	session.sendKey("C-u");
	session.sendLiteral(TODO_PTY_PROMPT);
	session.sendKey("Enter");
	await session.waitForText(TODO_PTY_READY);
	let screen = await session.waitForText("4 tasks (0 done, 4 open)");
	for (const subject of TODO_PTY_SUBJECTS) screen = await session.waitForText(`□ ${subject}`);

	const lines = screen.split("\n");
	const summaryIndex = lines.findIndex((line) => line.includes("4 tasks (0 done, 4 open)"));
	if (summaryIndex < 0 || !lines[summaryIndex]?.startsWith(" 4 tasks (0 done, 4 open)")) {
		pty.fail(`Todo summary icon and text are not aligned with the checklist columns\n${screen}`);
	}
	for (const [index, subject] of TODO_PTY_SUBJECTS.entries()) {
		const line = lines[summaryIndex + index + 1];
		if (!line?.startsWith(`  □ ${subject}`)) {
			pty.fail(`Todo row ${String(index + 1)} is not adjacent and aligned beneath its summary\n${screen}`);
		}
	}
	verifyTerminalWidth(screen, columns, "expanded Todo checklist");
	await writePtyEvidence(
		options.artifactDirectory,
		`pi-${CERTIFIED_PI_VERSION}-todo-parity-${String(columns)}x${String(rows)}`,
		session,
	);
}

export async function verifyDiagnosticsUi(
	session: pty.TmuxPiSession,
	paths: pty.CasePaths,
	options: UiPtyVerificationOptions,
	columns: number,
	rows: number,
): Promise<void> {
	const draft = "DIAGNOSTIC_DRAFT_草稿";
	session.sendKey("C-u");
	session.sendLiteral(draft);
	await session.waitForText(draft);
	session.sendKey("F10");
	let screen = await session.waitForText("/diagnostics");
	if (columns >= 80 && !screen.includes(DIAGNOSTIC_PTY_SUMMARY)) {
		pty.fail("wide diagnostic notice truncated its actionable summary");
	}
	if (!screen.includes(draft)) pty.fail("diagnostic notice disturbed the active editor draft");
	if (!pty.hasStatusline(screen))
		pty.fail("diagnostic notice replaced the Statusline instead of sitting above the editor");
	const noticeRows = screen.split("\n").filter((line) => line.includes("/diagnostics"));
	if (noticeRows.length !== 1) {
		pty.fail(`diagnostic burst rendered ${String(noticeRows.length)} notice rows instead of one\n${screen}`);
	}
	verifyTerminalWidth(screen, columns, `${String(columns)}-column diagnostic notice`);
	await writePtyEvidence(
		options.artifactDirectory,
		`pi-${CERTIFIED_PI_VERSION}-diagnostics-notice-${String(columns)}x${String(rows)}`,
		session,
	);

	session.sendKey("C-u");
	session.sendLiteral("/diagnostics");
	session.sendKey("Enter");
	screen = await session.waitForText("Diagnostics");
	if (columns >= 80 && !screen.includes(DIAGNOSTIC_PTY_SUMMARY)) {
		screen = await session.waitForText(DIAGNOSTIC_PTY_SUMMARY);
	}
	if (!screen.includes("2 occurrences")) screen = await session.waitForText("2 occurrences");
	verifyDialogSurface(screen, columns, "/diagnostics Command Dialog");

	session.sendKey("Enter");
	screen = await session.waitForText("Diagnostics / Background Work");
	screen = await session.waitForText("/tasks");
	if (screen.includes("fixture-secret-token-value")) pty.fail("/diagnostics exposed an unredacted credential");
	if (!screen.includes("Bearer [redacted]")) screen = await session.waitForText("Bearer [redacted]");
	verifyTerminalWidth(screen, columns, "/diagnostics detail");
	await writePtyEvidence(
		options.artifactDirectory,
		`pi-${CERTIFIED_PI_VERSION}-diagnostics-detail-${String(columns)}x${String(rows)}`,
		session,
	);
	session.sendKey("Escape");
	await session.waitForText("Enter details");
	session.sendLiteral("c");
	await session.waitForText("No Pi Stuff diagnostics yet.");
	session.sendKey("Escape");
	await session.waitForStatusline("closing /diagnostics");
	screen = await session.waitForAbsence(DIAGNOSTIC_PTY_SUMMARY);
	if (screen.includes("/diagnostics")) pty.fail("cleared diagnostic notice returned after the dialog closed");
	await pty.delay(50);
	for (const sessionFile of (await readdir(paths.sessions)).filter((entry) => entry.endsWith(".jsonl"))) {
		if ((await readFile(join(paths.sessions, sessionFile), "utf8")).includes(DIAGNOSTIC_PTY_SUMMARY)) {
			pty.fail("diagnostic presentation leaked into Pi Session history");
		}
	}
	await writePtyEvidence(
		options.artifactDirectory,
		`pi-${CERTIFIED_PI_VERSION}-diagnostics-${String(columns)}x${String(rows)}`,
		session,
	);
}

export async function readFixtureRecords(path: string): Promise<readonly FixtureRecord[]> {
	const text = await readFile(path, "utf8");
	return text
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const record = JSON.parse(line);
			if (!Check(FIXTURE_RECORD_SCHEMA, record)) pty.fail(`fixture log ${path} contains a malformed record`);
			return record;
		});
}
