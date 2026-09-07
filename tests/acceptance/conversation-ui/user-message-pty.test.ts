import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { selectAcceptanceMatrix } from "../../../scripts/acceptance-matrix.ts";
import { resolvePiBinary } from "../../../scripts/installed-tools.ts";
import { readFixtureRecords, waitForFixtureRecords, writePtyEvidence } from "../../../scripts/ui-pty-interactions.js";
import { createCase, TmuxPiSession } from "../../../scripts/ui-pty-session.js";
import { stageSupportedPiHost } from "../../../scripts/verify-pi-host-provenance.js";

const PROMPT = "USER_MESSAGE_PTY_PROMPT 中文🧪 /skill:humanizer-zh";
const LABEL = "  /skill:humanizer-zh";

function userRows(screen: string): string[] {
	return screen
		.split("\n")
		.filter((row) => row.startsWith("  "))
		.map((row) => row.trimEnd());
}

async function reloadSession(session: TmuxPiSession, log: string): Promise<void> {
	const starts = (await readFixtureRecords(log)).filter((record) => record.type === "inventory").length;
	session.sendLiteral("/reload");
	session.sendKey("Enter");
	await waitForFixtureRecords(log, "inventory", starts + 1);
	await session.waitForAbsence("Reloading keybindings");
	await session.waitForText("Reloaded");
}

async function verifySessionLifecycle(session: TmuxPiSession, sessionFile: string, log: string): Promise<void> {
	const expected = [`${LABEL} ${PROMPT}`, LABEL, "  USER_MESSAGE_PTY_ORDINARY"];
	for (let attempt = 0; attempt < 2; attempt += 1) {
		await reloadSession(session, log);
		const screen = await session.waitForText("  USER_MESSAGE_PTY_ORDINARY");
		expect(userRows(screen)).toEqual(expected);
		expect(screen).not.toContain("styling is unavailable");
	}
	const beforeTheme = session.captureAnsi();
	session.sendKey("F9");
	await session.waitFor(() => session.captureAnsi() !== beforeTheme, "live theme repaint");
	expect(userRows(session.capture())).toEqual(expected);
	session.sendLiteral("/ui-pty-new");
	session.sendKey("Enter");
	await session.waitForAbsence("  USER_MESSAGE_PTY_ORDINARY");
	session.sendLiteral("/ui-pty-user-queue");
	session.sendKey("Enter");
	const queued = await session.waitFor(
		(screen) => screen.includes("  USER_MESSAGE_PTY_QUEUED") && screen.split("USER_MESSAGE_PTY_ACK").length === 3,
		"automatic and queued User Messages",
	);
	expect(userRows(queued)).toEqual(["  USER_MESSAGE_PTY_AUTO", "  USER_MESSAGE_PTY_QUEUED"]);
	session.resize(100, 45);
	session.sendKey("C-o");
	session.sendLiteral(`/ui-pty-resume ${sessionFile}`);
	session.sendKey("Enter");
	const restored = await session.waitForText("  USER_MESSAGE_PTY_ORDINARY");
	expect(userRows(restored)).toEqual(expected);
	expect(restored).not.toContain("styling is unavailable");
	await session.waitFor(
		(value) => value.split("Skill instructions").length === 3,
		"restored Skills honoring expanded Host state",
	);
	session.sendKey("C-o");
	await session.waitForAbsence("Skill instructions");
	session.resize(100, 32);
}

const RESIZE_SIZES = selectAcceptanceMatrix(
	[
		[64, 28],
		[48, 22],
		[32, 18],
		[24, 16],
		[100, 32],
	] as const,
	[
		[64, 28],
		[24, 16],
		[100, 32],
	] as const,
);

for (const tuiMode of ["regular", "fullscreen"] as const) {
	for (const theme of ["dark", "light"]) {
		test(`real Pi preserves unified User Messages through expansion, resize, reload, and replay: ${tuiMode}/${theme}`, async () => {
			const directory = await mkdtemp(join(tmpdir(), "pi-user-message-"));
			let session: TmuxPiSession | undefined;
			try {
				const PI_BIN = resolvePiBinary();
				const { PI_STUFF_UI_PTY_ARTIFACT_DIR } = process.env;
				const host = await stageSupportedPiHost(PI_BIN, directory);
				const packagePath = resolve(import.meta.dir, "../../../packages/pi-stuff");
				const paths = await createCase(directory, "user-message", theme, packagePath);
				await writeFile(
					join(paths.config, "pi-stuff.json"),
					JSON.stringify({
						ui: {
							schemaVersion: 3,
							inlineSlashAutocomplete: true,
							inputHighlighting: true,
							statusline: true,
							statuslineDensity: "auto",
							statuslineLatestPrompt: true,
							welcomeHeader: false,
						},
					}),
				);
				await writeFile(
					join(paths.config, "skills/humanizer-zh/SKILL.md"),
					"---\nname: humanizer-zh\ndescription: User Message fixture\n---\n\nUSER_MESSAGE_PTY_INSTRUCTIONS\n",
				);
				const options = { piBinary: host.binaryPath, packagePath, sessionId: "user-message-acceptance", tuiMode };
				session = new TmuxPiSession(paths, options, 100, 32);
				await session.start();
				await session.waitForStatusline();
				session.sendLiteral(`/skill:humanizer-zh ${PROMPT}`);
				session.sendKey("Escape");
				session.sendKey("Enter");
				let screen = await session.waitForText("USER_MESSAGE_PTY_ACK");
				expect(userRows(screen)).toEqual([`${LABEL} ${PROMPT}`]);
				expect(screen).not.toContain("to expand)");
				const coloredRow = session
					.captureAnsi()
					.split("\n")
					.find((row) => stripTerminalSequences(row).includes(LABEL));
				expect(coloredRow).toBeDefined();
				expect(new Set(coloredRow?.match(/\[38;[^m]+m/gu)).size).toBeGreaterThanOrEqual(6);
				expect(coloredRow?.split("\u001b[38;5;93m/")).toHaveLength(3);
				await writePtyEvidence(PI_STUFF_UI_PTY_ARTIFACT_DIR, `user-message-${tuiMode}-${theme}-collapsed`, session);
				session.sendKey("C-o");
				screen = await session.waitForText("Skill instructions");
				expect(screen.indexOf(PROMPT)).toBeLessThan(screen.indexOf("USER_MESSAGE_PTY_INSTRUCTIONS"));
				expect(userRows(screen)).toEqual([`${LABEL} ${PROMPT}`]);
				await writePtyEvidence(PI_STUFF_UI_PTY_ARTIFACT_DIR, `user-message-${tuiMode}-${theme}-expanded`, session);
				session.sendKey("C-o");
				await session.waitForAbsence("Skill instructions");
				for (const [columns, rows] of RESIZE_SIZES) {
					session.resize(columns, rows);
					screen = await session.waitFor(
						(value) =>
							value.includes("  /skill:") &&
							value.includes("USER_MESSAGE_PTY_ACK") &&
							value.replace(/\s/gu, "").includes(PROMPT.replace(/\s/gu, "")),
						`user card after ${columns}-column resize`,
					);
					expect(userRows(screen)).toHaveLength(1);
					expect(screen.replace(/\s/gu, "")).toContain(PROMPT.replace(/\s/gu, ""));
					for (const row of screen.split("\n")) expect(visibleWidth(row)).toBeLessThanOrEqual(columns);
					await writePtyEvidence(
						PI_STUFF_UI_PTY_ARTIFACT_DIR,
						`user-message-${tuiMode}-${theme}-${columns}`,
						session,
					);
				}
				session.sendKey("C-o");
				await session.waitForText("Skill instructions");
				session.sendLiteral("/skill:humanizer-zh");
				session.sendKey("Enter");
				screen = await session.waitFor((value) => userRows(value).includes(LABEL), "Skill-only User Message");
				expect(userRows(screen)).toEqual([`${LABEL} ${PROMPT}`, LABEL]);
				await session.waitFor(
					(value) => value.split("Skill instructions").length === 3,
					"new Skill honoring expanded Host state",
				);
				session.sendKey("C-o");
				await session.waitForAbsence("Skill instructions");
				session.sendLiteral("USER_MESSAGE_PTY_ORDINARY");
				session.sendKey("Enter");
				await session.waitFor((value) => value.split("USER_MESSAGE_PTY_ACK").length === 4, "third response");
				await reloadSession(session, paths.log);
				screen = await session.waitForText("  USER_MESSAGE_PTY_ORDINARY");
				expect(userRows(screen)).toEqual([`${LABEL} ${PROMPT}`, LABEL, "  USER_MESSAGE_PTY_ORDINARY"]);
				expect(screen).not.toContain("styling is unavailable");
				const files = await readdir(paths.sessions);
				const file = files.find((name) => name.endsWith(".jsonl"));
				if (!file) throw new Error("Host did not persist a Session");
				const entries = SessionManager.open(join(paths.sessions, file)).getEntries();
				const messages = entries.filter((entry) => entry.type === "message" && entry.message.role === "user");
				expect(messages).toHaveLength(3);
				const persisted = await readFile(join(paths.sessions, file), "utf8");
				const requests = await readFile(paths.log, "utf8");
				expect(persisted).toContain('<skill name=\\"humanizer-zh\\"');
				expect(requests).toContain('"lastUser":"<skill name=\\"humanizer-zh\\"');
				expect(persisted).not.toContain("");
				expect(requests).not.toContain("");
				await verifySessionLifecycle(session, join(paths.sessions, file), paths.log);
				session.stop();
				session = new TmuxPiSession(paths, options, 100, 32);
				await session.start();
				screen = await session.waitForText("  USER_MESSAGE_PTY_ORDINARY");
				expect(userRows(screen)).toEqual([`${LABEL} ${PROMPT}`, LABEL, "  USER_MESSAGE_PTY_ORDINARY"]);
				expect(screen).not.toContain("styling is unavailable");
			} finally {
				session?.stop();
				await rm(directory, { recursive: true, force: true });
			}
		}, 90_000);
	}
}
