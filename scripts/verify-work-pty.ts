import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { processExists } from "../packages/pi-stuff/src/background-work/src/process.js";
import { resolvePiBinary } from "./installed-tools.ts";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";
import { stripTerminalControls } from "./terminal-controls.js";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/work-pty-provider.ts");
const runner = join(root, "tests/fixtures/work-pty-runner.sh");
const REQUEST_RECORD_SCHEMA = Type.Object(
	{
		monitorCompletedNotification: Type.Boolean(),
		monitorTimedOutNotification: Type.Boolean(),
		request: Type.Number(),
		shellCompletedNotification: Type.Boolean(),
		tools: Type.Array(Type.String()),
	},
	{ additionalProperties: true },
);
const SESSION_RECORD_SCHEMA = Type.Object(
	{
		message: Type.Optional(
			Type.Object(
				{
					content: Type.Optional(Type.Unknown()),
					role: Type.Optional(Type.String()),
				},
				{ additionalProperties: true },
			),
		),
	},
	{ additionalProperties: true },
);

function expectProgram(): string {
	return `
set timeout 25

proc must_expect {pattern} {
    expect {
        -exact $pattern {}
        timeout { puts stderr "Timed out waiting for: $pattern"; exit 2 }
        eof { puts stderr "Reached EOF while waiting for: $pattern"; exit 3 }
    }
}

spawn -noecho script -qefc $env(PI_STUFF_WORK_PTY_RUNNER) /dev/null
set work_pty $spawn_out(slave,name)
must_expect "foreground.pid; sleep 3"
after 1000
set detached 0
set continued 0
set timeout 1
for {set attempt 0} {$attempt < 4 && !$detached && !$continued} {incr attempt} {
    send -- "\\002"
    expect {
        -exact "Command manually moved to background task" { set detached 1 }
        -exact "CTRL_B_CONTINUED" { set continued 1 }
        timeout {}
        eof { puts stderr "Reached EOF while detaching foreground Bash"; exit 3 }
    }
}
set timeout 25
if {!$detached && !$continued} { puts stderr "Ctrl+B did not detach foreground Bash"; exit 2 }
if {!$continued} { must_expect "CTRL_B_CONTINUED" }
must_expect "FOREGROUND_HANDOFF_COMPLETION_REPORT"
send -- "/tasks\r"
must_expect "No background work in this session."
must_expect "Esc close"
send -- "\\033"
after 100
send -- "start stop fixture\r"
must_expect "STOP_FIXTURE_CONTINUES"
send -- "/tasks\r"
must_expect "Tasks"
must_expect "Shell"
must_expect "x stop"
send -- "x"
must_expect "No background work in this session."
send -- "\\033"
after 100
send -- "start monitor fixture\r"
must_expect "MAIN_CONTINUES"
send -- "/tasks\r"
must_expect "Tasks"
must_expect "Esc close"
send -- "\\033"
after 100
set narrow_columns 48
stty rows $env(PI_STUFF_WORK_PTY_ROWS) columns $narrow_columns < $work_pty
after 150
send -- "/tasks\r"
must_expect "Tasks"
must_expect "Esc close"
send -- "\r"
must_expect "Tasks / Shell"
must_expect "Esc back"
send -- "\\033"
must_expect "↑/↓ select"
after 100
send -- "\\033"
after 100
stty rows $env(PI_STUFF_WORK_PTY_ROWS) columns $env(PI_STUFF_WORK_PTY_COLUMNS) < $work_pty
exec touch release.flag
must_expect "MONITOR_RESUMED"
send -- "/work-wait-idle\r"
must_expect "WORK_PTY_IDLE"
send -- "/reload\r"
must_expect "Reloaded keybindings, extensions"
must_expect "context files"
after 150
send -- "/tasks\r"
must_expect "No background work in this session."
must_expect "Esc close"
send -- "\\033"
after 100
send -- "DRAFT_AFTER_TASKS"
must_expect "DRAFT_AFTER_TASKS"
send -- "\\003"
after 100
send -- "\\004"
expect {
    eof {}
    timeout { puts stderr "Timed out waiting for Pi to exit"; exit 4 }
}
`;
}

function fail(message: string): never {
	throw new Error(`Background Work PTY verification failed: ${message}`);
}

async function processFrom(path: string): Promise<number> {
	const value = Number((await readFile(path, "utf-8")).trim());
	if (!Number.isSafeInteger(value) || value <= 0) fail(`invalid process fixture at ${path}`);
	return value;
}

export async function verifyWorkPty(options: {
	readonly columns: number;
	readonly packagePath: string;
	readonly piBinary: string;
	readonly rows: number;
}): Promise<void> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-work-pty-"));
	const configDirectory = join(temporaryDirectory, "config");
	const sessionDirectory = join(temporaryDirectory, "sessions");
	const requestLog = join(temporaryDirectory, "requests.jsonl");
	await Promise.all([mkdir(configDirectory), mkdir(sessionDirectory), chmod(runner, 0o755)]);
	await disableSessionNamingForTest(configDirectory);
	await writeFile(
		join(configDirectory, "settings.json"),
		`${JSON.stringify({ defaultProjectTrust: "always" }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	try {
		const result = Bun.spawnSync(["expect", "-c", expectProgram()], {
			cwd: temporaryDirectory,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: configDirectory,
				PI_STUFF_WORK_PTY_BIN: options.piBinary,
				PI_STUFF_WORK_PTY_COLUMNS: String(options.columns),
				PI_STUFF_WORK_PTY_LOG: requestLog,
				PI_STUFF_WORK_PTY_PACKAGE: resolve(options.packagePath),
				PI_STUFF_WORK_PTY_PROVIDER_EXTENSION: providerExtension,
				PI_STUFF_WORK_PTY_ROWS: String(options.rows),
				PI_STUFF_WORK_PTY_RUNNER: runner,
				PI_STUFF_WORK_PTY_SESSIONS: sessionDirectory,
				PI_STUFF_WORK_PTY_SESSION_ID: "work-pty-session",
				SHELL: "/bin/sh",
				TERM: "xterm-256color",
			},
			stderr: "pipe",
			stdout: "pipe",
		});
		const output = result.stdout.toString();
		if (result.exitCode !== 0) {
			fail(`${result.stderr.toString().trim()}\nPTY tail:\n${output.slice(-12_000)}`);
		}
		const visible = stripTerminalControls(output);
		for (const expected of [
			"CTRL_B_CONTINUED",
			"FOREGROUND_HANDOFF_COMPLETION_REPORT",
			"MAIN_CONTINUES",
			"MONITOR_RESUMED",
			"Prepare monitored service",
			"STOP_FIXTURE_CONTINUES",
			"Monitor",
			"Tasks",
			"Tasks / Shell",
			"No background work in this session.",
			"DRAFT_AFTER_TASKS",
		]) {
			if (!visible.includes(expected)) fail(`terminal output is missing ${expected}`);
		}
		for (const forbidden of [
			"<background-work-notification>",
			"<task id=",
			"MISSING_FOREGROUND_HANDOFF_NOTIFICATION",
			"UNEXPECTED_REQUEST_",
		]) {
			if (visible.includes(forbidden)) fail(`terminal output exposed ${forbidden}`);
		}
		const records = (await readFile(requestLog, "utf-8"))
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const record = JSON.parse(line);
				if (!Check(REQUEST_RECORD_SCHEMA, record)) fail("provider log contains a malformed request record");
				return record;
			});
		if (records.length < 9) fail(`expected at least 9 model requests, received ${String(records.length)}`);
		for (const [index, record] of records.entries()) {
			if (record.request !== index) fail(`request sequence diverged at ${String(index)}`);
			for (const tool of ["background", "bash", "monitor"]) {
				if (!record.tools.includes(tool)) fail(`request ${String(index)} is missing ${tool}`);
			}
		}
		const resumed = [...records].reverse().find((record) => record.monitorCompletedNotification);
		if (!resumed || resumed.monitorTimedOutNotification) {
			fail(
				`Monitor resume did not carry a completed, non-timeout terminal notification: ${JSON.stringify(records)}`,
			);
		}
		if (!records[2]?.shellCompletedNotification) {
			fail("foreground handoff continuation did not carry the completed Shell notification");
		}
		const sessions = (await readdir(sessionDirectory)).filter((entry) => entry.endsWith(".jsonl"));
		if (sessions.length !== 1 || !sessions[0]) fail("expected exactly one isolated Session");
		const transcript = await readFile(join(sessionDirectory, sessions[0]), "utf-8");
		const reportPersisted = transcript
			.trim()
			.split("\n")
			.filter(Boolean)
			.some((line) => {
				const record = JSON.parse(line);
				if (!Check(SESSION_RECORD_SCHEMA, record)) fail("Session contains a malformed record");
				return (
					record.message?.role === "assistant" &&
					JSON.stringify(record.message.content)?.includes("FOREGROUND_HANDOFF_COMPLETION_REPORT") === true
				);
			});
		if (!reportPersisted) fail("Session did not persist the foreground handoff Completion Report");
		for (const path of [
			join(temporaryDirectory, "foreground.pid"),
			join(temporaryDirectory, "stop.pid"),
			join(temporaryDirectory, "background.pid"),
		]) {
			const pid = await processFrom(path);
			if (processExists(pid)) fail(`Pi exit left process ${String(pid)} alive`);
		}
	} finally {
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
}

if (import.meta.main) {
	await verifyWorkPty({
		columns: 96,
		packagePath: resolve(root, "packages/pi-stuff"),
		piBinary: resolvePiBinary(),
		rows: 30,
	});
}
