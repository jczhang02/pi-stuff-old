import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { visibleWidth } from "@earendil-works/pi-tui";
import { isJsonInputObject, type JsonInputValue, parseJsonValue } from "../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeFunction } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { FIXTURE_THINKING, THOUGHT_PHASES, THOUGHT_SPACING_PTY } from "../tests/fixtures/ui-pty-provider.js";
import * as pty from "./ui-pty-session.js";

export const EXPANDED_THINKING_PREFIX = "• thoughts: ";
export const HIDDEN_THINKING_LABEL = "• thoughts";

function containsValue(value: JsonInputValue, target: string): boolean {
	if (value === target) return true;
	if (Array.isArray(value)) return value.some((item) => containsValue(item, target));
	if (!isJsonInputObject(value)) return false;
	return Object.values(value).some((item) => containsValue(item, target));
}

export async function waitForPersistedSessionValue(
	sessionDirectory: string,
	target: string,
	description: string,
): Promise<void> {
	const deadline = Date.now() + pty.WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const sessionFiles = (await readdir(sessionDirectory)).filter((entry) => entry.endsWith(".jsonl"));
		for (const sessionFile of sessionFiles) {
			const records = (await readFile(join(sessionDirectory, sessionFile), "utf8"))
				.trim()
				.split("\n")
				.filter(Boolean)
				.map(parseJsonValue);
			if (records.some((record) => containsValue(record, target))) return;
		}
		await pty.delay(pty.POLL_INTERVAL_MS);
	}
	pty.fail(`settled session JSONL did not retain ${description}`);
}

function hiddenThinkingRows(screen: string): string[] {
	return screen.split("\n").filter((line) => line.trim() === HIDDEN_THINKING_LABEL);
}

function thoughtPhaseTail(phase: string): string {
	return phase.split(" ").at(-1) ?? phase;
}

function visibleThinkingRows(screen: string): string[] {
	return screen.split("\n").filter((line) => line.includes(EXPANDED_THINKING_PREFIX));
}

function verifySingleBlankBoundaries(screen: string, markers: readonly string[]): void {
	const lines = screen.split("\n");
	const indexes = markers.map((marker) => lines.findIndex((line) => line.includes(marker)));
	if (indexes.some((index) => index < 0)) pty.fail(`interleaved Thinking markers were not all visible\n${screen}`);
	for (let index = 1; index < indexes.length; index += 1) {
		const previous = indexes[index - 1];
		const current = indexes[index];
		if (previous === undefined || current === undefined || current - previous !== 2 || lines[previous + 1]?.trim()) {
			pty.fail(`interleaved Thinking boundary did not contain exactly one blank row\n${screen}`);
		}
	}
}

export async function verifyInterleavedThoughtSpacing(session: pty.TmuxPiSession): Promise<void> {
	session.sendLiteral(THOUGHT_SPACING_PTY.prompt);
	session.sendKey("Enter");
	let screen = await session.waitForText(THOUGHT_SPACING_PTY.finalText);
	verifySingleBlankBoundaries(screen, [
		THOUGHT_SPACING_PTY.firstThought,
		THOUGHT_SPACING_PTY.firstText,
		THOUGHT_SPACING_PTY.secondThought,
		THOUGHT_SPACING_PTY.finalText,
	]);

	session.sendKey("C-t");
	screen = await session.waitForAbsence(THOUGHT_SPACING_PTY.secondThought);
	const lines = screen.split("\n");
	const firstText = lines.findIndex((line) => line.includes(THOUGHT_SPACING_PTY.firstText));
	const finalText = lines.findIndex((line) => line.includes(THOUGHT_SPACING_PTY.finalText));
	const hiddenBoundary = lines.slice(firstText + 1, finalText).map((line) => line.trim());
	if (firstText < 0 || finalText < 0 || hiddenBoundary.join("\n") !== `\n${HIDDEN_THINKING_LABEL}\n`) {
		pty.fail(`hidden interleaved Thinking boundary did not contain exactly one blank row on each side\n${screen}`);
	}
	session.sendKey("C-t");
	await waitForThoughtText(session, THOUGHT_SPACING_PTY.secondThought);
}

export async function waitForHiddenThinking(session: pty.TmuxPiSession, minimumRows: number): Promise<string> {
	const deadline = Date.now() + pty.WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const screen = session.capture();
		const normalized = normalizeRenderedText(screen);
		if (
			hiddenThinkingRows(screen).length >= minimumRows &&
			THOUGHT_PHASES.every((phase) => !normalized.includes(phase) && !normalized.includes(thoughtPhaseTail(phase)))
		) {
			return screen;
		}
		await pty.delay(pty.POLL_INTERVAL_MS);
	}
	pty.fail(`timed out waiting for ${String(minimumRows)} hidden Thinking label(s)`);
}

function verifyItalicThinkingLabel(session: pty.TmuxPiSession, label: string): void {
	const line = session
		.captureAnsi()
		.split("\n")
		.find((candidate) => candidate.includes(label));
	if (!line?.includes("\u001b[3m")) pty.fail("Thinking label did not retain the Host italic style");
}

function verifyThinkingWidth(screen: string, columns: number): void {
	for (const [index, line] of screen.split("\n").entries()) {
		const width = visibleWidth(line);
		if (width > columns) {
			pty.fail(
				`settled ${String(columns)}-column Thinking row ${String(index + 1)} occupies ${String(width)} columns`,
			);
		}
	}
}

async function verifyThinkingMouseToggle(session: pty.TmuxPiSession, finalPhase: string): Promise<void> {
	const click = (label: string): void => {
		const lines = session.capture().split("\n");
		const row = lines.findIndex((line) => line.includes(label));
		if (row < 0) pty.fail(`Thinking click target was absent: ${label}`);
		const column = lines[row]?.indexOf(label) ?? -1;
		const position = `${String(column + 1)};${String(row + 1)}`;
		session.sendLiteral(`\u001b[<0;${position}M\u001b[<0;${position}m`);
	};
	click(EXPANDED_THINKING_PREFIX);
	await waitForHiddenThinking(session, 1);
	click(HIDDEN_THINKING_LABEL);
	await waitForThoughtText(session, EXPANDED_THINKING_PREFIX + finalPhase);
}

export async function verifyThoughtLifecycle(
	session: pty.TmuxPiSession,
	paths: pty.CasePaths,
	columns: number,
	rows: number,
): Promise<void> {
	const settledMarker = `THOUGHT_DONE_${String(columns)}`;
	const prompt = `THOUGHT_PROBE_${String(columns)}`;
	const finalPhase = THOUGHT_PHASES.at(-1) ?? pty.fail("Thinking fixture has no phases");
	session.sendLiteral(prompt);
	session.sendKey("Enter");

	let screen = "";
	for (const [index, phase] of THOUGHT_PHASES.entries()) {
		const expected = columns >= 64 ? EXPANDED_THINKING_PREFIX + phase : thoughtPhaseTail(phase);
		screen = await waitForThoughtText(session, expected);
		if (screen.includes(settledMarker)) {
			pty.fail(`Thinking phase ${String(index + 1)} was captured only after the response settled`);
		}
		if (visibleThinkingRows(screen).length !== 1) {
			pty.fail(`one Host Thinking run did not render as one latest-line row\n${screen}`);
		}
		const normalized = normalizeRenderedText(screen);
		if (columns >= 64) {
			for (const priorPhase of THOUGHT_PHASES.slice(0, index)) {
				if (normalized.includes(priorPhase)) {
					pty.fail(`Thinking phase ${String(index + 1)} retained an earlier phase\n${screen}`);
				}
			}
		}
	}

	await session.waitForText(settledMarker);
	session.resize(columns - 1, rows);
	await pty.delay(100);
	session.resize(columns, rows);
	const finalVisibleText = columns >= 64 ? EXPANDED_THINKING_PREFIX + finalPhase : thoughtPhaseTail(finalPhase);
	screen = await waitForThoughtText(session, finalVisibleText);
	screen = await session.waitForLatestPrompt(prompt);
	if (!screen.includes(settledMarker)) pty.fail("settled Thinking was not present beside its completed response");
	const promptRows = pty.rowsBelowEditorDivider(screen).filter((line) => line.includes(prompt));
	if (promptRows.length !== 1) {
		pty.fail(
			String(columns) +
				"-column latest prompt occupied " +
				String(promptRows.length) +
				" rows instead of exactly one\n" +
				screen,
		);
	}
	verifyThinkingWidth(screen, columns);

	if (columns === 100) {
		await verifyThinkingMouseToggle(session, finalPhase);
		verifyItalicThinkingLabel(session, EXPANDED_THINKING_PREFIX);
		session.sendKey("C-t");
		screen = await waitForHiddenThinking(session, 1);
		if (hiddenThinkingRows(screen).length !== 1) pty.fail("one Host Thinking run did not collapse to one label");
		verifyItalicThinkingLabel(session, HIDDEN_THINKING_LABEL);
		session.sendKey("C-t");
		await waitForThoughtText(session, EXPANDED_THINKING_PREFIX + finalPhase);

		const secondMarker = "THOUGHT_DONE_SECOND_RUN";
		session.sendLiteral("THOUGHT_PROBE_SECOND_RUN");
		session.sendKey("Enter");
		await session.waitForText(secondMarker);
		session.sendKey("C-t");
		screen = await waitForHiddenThinking(session, 2);
		if (hiddenThinkingRows(screen).length < 2) {
			pty.fail("separate Host Thinking runs did not retain separate hidden labels");
		}
		session.sendKey("C-t");
		await waitForThoughtText(session, EXPANDED_THINKING_PREFIX + finalPhase);
	}

	await waitForPersistedSessionValue(paths.sessions, FIXTURE_THINKING, "the original Thinking content");
	if (columns === 100) await verifyThinkingHtmlExport(paths.sessions);
}

export async function verifyThinkingHtmlExport(sessionDirectory: string): Promise<void> {
	const sessionFiles = (await readdir(sessionDirectory)).filter((entry) => entry.endsWith(".jsonl"));
	let sessionFile: string | undefined;
	for (const entry of sessionFiles) {
		const candidate = join(sessionDirectory, entry);
		const records = (await readFile(candidate, "utf8")).trim().split("\n").filter(Boolean).map(parseJsonValue);
		if (records.some((record) => containsValue(record, FIXTURE_THINKING))) {
			sessionFile = candidate;
			break;
		}
	}
	if (!sessionFile) pty.fail("Thinking Session was unavailable for HTML export");

	const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
	const exportModule = await import(pathToFileURL(join(dirname(piEntry), "core/export-html/index.js")).href);
	if (!isRuntimeFunction(exportModule.exportFromFile)) pty.fail("certified Pi HTML exporter is unavailable");
	const outputPath = join(sessionDirectory, "thinking-session.html");
	await exportModule.exportFromFile(sessionFile, { outputPath });
	const html = await readFile(outputPath, "utf8");
	const encoded = /<script id="session-data" type="application\/json">([^<]+)<\/script>/u.exec(html)?.[1];
	if (!encoded) pty.fail("Pi HTML export omitted canonical Session data");
	const exportedSession = parseJsonValue(Buffer.from(encoded, "base64").toString("utf8"));
	if (!containsValue(exportedSession, FIXTURE_THINKING)) {
		pty.fail("Pi HTML export did not retain the original Thinking content");
	}
	if (JSON.stringify(exportedSession).includes(EXPANDED_THINKING_PREFIX)) {
		pty.fail("display-only Thinking label leaked into Pi HTML export data");
	}
}

export function normalizeRenderedText(screen: string): string {
	return screen.replaceAll(/\s+/gu, " ").trim();
}

export async function waitForThoughtText(session: pty.TmuxPiSession, text: string, history = false): Promise<string> {
	const deadline = Date.now() + pty.WAIT_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const screen = session.capture(history);
		if (normalizeRenderedText(screen).includes(text)) return screen;
		await pty.delay(pty.POLL_INTERVAL_MS);
	}
	pty.fail(`timed out waiting for rendered Thinking text ${JSON.stringify(text)}`);
}
