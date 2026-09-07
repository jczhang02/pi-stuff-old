import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { selectAcceptanceMatrix } from "../../../scripts/acceptance-matrix.ts";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import * as flow from "../../../scripts/ui-pty-interactions.ts";
import * as pty from "../../../scripts/ui-pty-session.ts";
import { verifyUiPty } from "../../../scripts/verify-ui-pty.ts";

const PI_BIN = resolvePiBinary();
const AGGREGATE_PACKAGE = resolve(import.meta.dir, "../../../packages/pi-stuff");

test("real Pi renders and restores the integrated production UI at the selected acceptance widths", async () => {
	const evidence = await verifyUiPty({ piBinary: PI_BIN, packagePath: AGGREGATE_PACKAGE });

	expect(evidence.sizes).toEqual(
		selectAcceptanceMatrix(["100x32", "64x28", "48x22", "32x18", "24x16"], ["100x32", "64x28"]),
	);
	expect(evidence.markdownTransformer).toBeTypeOf("boolean");
	expect(evidence.vibeLineMaximumFrameDurationMs).toBeGreaterThan(0);
	expect(evidence.vibeLineMaximumFrameDurationMs).toBeLessThanOrEqual(500);
	for (const required of [
		"live resize 100x32 -> 64x28 -> 48x22 -> 32x18 -> 24x16 -> 100x32",
		"priority Statusline fields and responsive prompt bounds at the selected acceptance widths",
		"latest-line, hidden, toggled, interleaved spacing, multi-run, settled, resumed, Session-, Provider-, and export-preserved Thinking",
		"100 continuous deltas across 2,500 cumulative CJK characters kept every Vibe Line Spinner frame within 500ms and recovered",
		"native and inline autocomplete suppression and restoration",
		"long CJK prompt, Welcome scroll-away, streaming and settled Thinking",
		"User/Assistant streaming, settled, narrow fallback, wide resize, Provider-canonical, Session-canonical, and resumed fenced visualizations",
		"metered and API-key subscription Statusline cost behavior",
		"responsive /codex controls, Fast persistence, and offline degradation",
		"native /ui settings, Notification exclusion, enum changes, and restart persistence",
		"native /autoname settings completion, responsive searchable model selection, immediate writes, reset, and restart persistence",
		"/ui search, immediate Statusline and Inline changes, Welcome next-launch persistence",
	]) {
		expect(evidence.verified).toContain(required);
	}
}, 120_000);

const WORKING_SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/u;
function ansiColorBefore(line: string, token: string): string | undefined {
	const tokenIndex = line.indexOf(token);
	if (tokenIndex < 0) return undefined;
	return line
		.slice(0, tokenIndex)
		.match(/\[38;[^m]+m/gu)
		?.at(-1);
}

async function setThinkingLevel(session: pty.TmuxPiSession, level: "low" | "medium"): Promise<void> {
	session.sendKey("C-u");
	session.sendLiteral(`/thinking ${level}`);
	session.sendKey("Escape");
	session.sendKey("Enter");
	await session.waitForText(`Thinking level: ${level}`);
}

async function expectEmbeddedStatus(session: pty.TmuxPiSession, columns: number): Promise<string> {
	// Synchronize and assert against one frame; a second capture can cross a redraw or completion.
	let ansiScreen = "";
	await session.waitFor(() => {
		ansiScreen = session.captureAnsi();
		return WORKING_SPINNER.test(ansiScreen);
	}, "running indicator");
	const screen = stripVTControlCharacters(ansiScreen);
	const indicators = screen.split("\n").filter((line) => WORKING_SPINNER.test(line));
	expect(indicators).toHaveLength(1);
	expect(indicators[0]).toMatch(/^── [⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] .+─+\s*$/u);
	flow.verifyTerminalWidth(screen, columns, "embedded working status");
	const ansiIndicator = ansiScreen.split("\n").find((line) => WORKING_SPINNER.test(line));
	const spinnerColor =
		ansiIndicator && ansiColorBefore(ansiIndicator, ansiIndicator.match(WORKING_SPINNER)?.[0] ?? "");
	const messageColor = ansiIndicator && ansiColorBefore(ansiIndicator, "Working");
	expect(spinnerColor, JSON.stringify({ screen, ansiScreen })).toBeDefined();
	expect(messageColor).toBe(spinnerColor);
	expect(ansiIndicator && ansiColorBefore(ansiIndicator, "──")).toBe(spinnerColor);
	return spinnerColor ?? "";
}

for (const tuiMode of ["regular", "fullscreen"] as const) {
	for (const theme of ["dark", "light"] as const) {
		test(`real Pi keeps embedded working status through resize, dialogs, cancellation and reload: ${tuiMode}/${theme}`, async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-embedded-status-"));
			const paths = await pty.createCase(directory, "status", theme, AGGREGATE_PACKAGE);
			const session = new pty.TmuxPiSession(
				paths,
				{ piBinary: PI_BIN, packagePath: AGGREGATE_PACKAGE, tuiMode },
				100,
				32,
			);
			try {
				await session.start();
				await session.waitForStatusline();
				expect(await flow.verifyVibeLineSpinnerLiveness(session)).toBeLessThanOrEqual(500);
				await session.waitFor((screen) => !WORKING_SPINNER.test(screen), "idle editor after completion");
				await setThinkingLevel(session, "low");
				session.sendLiteral("THOUGHT_PROBE_EMBEDDED");
				session.sendKey("Enter");
				const lowColor = await expectEmbeddedStatus(session, 100);
				session.sendLiteral("UNSENT_DRAFT");
				session.sendKey("F12");
				const dialog = await session.waitForText("DRAFT_SURFACE");
				expect(WORKING_SPINNER.test(dialog)).toBeFalse();
				session.sendKey("Escape");
				await session.waitForAbsence("DRAFT_SURFACE");
				await session.waitForText("UNSENT_DRAFT");
				await expectEmbeddedStatus(session, 100);
				session.resize(24, 16);
				await expectEmbeddedStatus(session, 24);
				session.resize(100, 32);
				await expectEmbeddedStatus(session, 100);
				session.sendKey("Escape");
				await session.waitFor((screen) => !WORKING_SPINNER.test(screen), "idle editor after cancellation");
				expect(session.capture()).toContain("UNSENT_DRAFT");
				await setThinkingLevel(session, "medium");
				session.sendLiteral("THOUGHT_PROBE_COLOR");
				session.sendKey("Enter");
				const mediumColor = await expectEmbeddedStatus(session, 100);
				expect(mediumColor).not.toBe(lowColor);
				session.sendKey("Escape");
				await session.waitFor((screen) => !WORKING_SPINNER.test(screen), "idle editor after color cancellation");
				session.sendKey("C-u");
				session.sendLiteral("/reload");
				session.sendKey("Enter");
				await flow.waitForFixtureRecords(paths.log, "inventory", 2);
				await session.waitForStatusline();
				session.sendLiteral("THOUGHT_PROBE_AFTER_RELOAD");
				session.sendKey("Enter");
				await expectEmbeddedStatus(session, 100);
				await session.waitForText("THOUGHT_DONE_AFTER_RELOAD");
				await session.waitFor((screen) => !WORKING_SPINNER.test(screen), "idle editor after reload and completion");
			} finally {
				session.stop();
				await rm(directory, { force: true, recursive: true });
			}
		}, 60_000);
	}
}
