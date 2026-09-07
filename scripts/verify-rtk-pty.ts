import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { CERTIFIED_RTK_VERSION } from "../packages/pi-stuff/src/rtk/runtime.js";
import { isRuntimeString } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { formatInstalledToolFailure, probeInstalledTool, resolvePiBinary } from "./installed-tools.ts";
import { CERTIFIED_PI_VERSION } from "./pi-host-contract.ts";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";
import { stripTerminalControls } from "./terminal-controls.js";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/rtk-pty-provider.ts");
const runner = join(root, "tests/fixtures/rtk-pty-runner.sh");
const LONG_RESULT_ID = "rtk-pty-long-output";
const RG_FILES_COMMAND = "rg --files -g '*.txt' .";
const RG_SEARCH_COMMAND = "rg -n RTK untracked.txt";
const SESSION_TOOL_RESULT_SCHEMA = Type.Object(
	{
		message: Type.Object(
			{
				content: Type.Array(
					Type.Object(
						{ text: Type.Optional(Type.String()), type: Type.Optional(Type.String()) },
						{ additionalProperties: true },
					),
				),
				role: Type.Literal("toolResult"),
				toolCallId: Type.String(),
			},
			{ additionalProperties: true },
		),
	},
	{ additionalProperties: true },
);
const CONTEXT_RECORD_SCHEMA = Type.Object(
	{
		bashCommands: Type.Optional(Type.Array(Type.String())),
		executedCommands: Type.Optional(Type.Array(Type.String())),
		phase: Type.Optional(Type.String()),
		toolResults: Type.Optional(
			Type.Array(
				Type.Object(
					{ id: Type.Optional(Type.String()), text: Type.Optional(Type.String()) },
					{ additionalProperties: true },
				),
			),
		),
	},
	{ additionalProperties: true },
);
type ContextRecord = Static<typeof CONTEXT_RECORD_SCHEMA>;

function fail(message: string): never {
	throw new Error(`RTK PTY verification failed: ${message}`);
}

function freshExpectProgram(): string {
	return `
set timeout 25

proc must_expect {pattern} {
    expect {
        -exact $pattern {}
        timeout {
            puts stderr "Timed out waiting for: $pattern"
            exit 2
        }
        eof {
            puts stderr "Reached EOF while waiting for: $pattern"
            exit 3
        }
    }
}

spawn -noecho script -qefc $env(PI_STUFF_RTK_PTY_RUNNER) /dev/null
must_expect "RTK_FRESH_DONE"
after 200
send -- "/rtk\\r"
must_expect "RTK"
must_expect "Runtime"
must_expect "ready"
must_expect "${CERTIFIED_RTK_VERSION}"
must_expect "Behavior"
must_expect "Command rewriting"
must_expect "Model projection"
must_expect "Session savings"
send -- "\\033"
after 100
send -- "/rtk settings\\r"
must_expect "/rtk takes no subcommands; run /rtk."
send -- "\\004"
expect {
    eof {}
    timeout {
        puts stderr "Timed out waiting for fresh Pi to exit"
        exit 4
    }
}
`;
}

function resumeExpectProgram(): string {
	return `
set timeout 20

proc must_expect {pattern} {
    expect {
        -exact $pattern {}
        timeout {
            puts stderr "Timed out waiting for: $pattern"
            exit 2
        }
        eof {
            puts stderr "Reached EOF while waiting for: $pattern"
            exit 3
        }
    }
}

spawn -noecho script -qefc $env(PI_STUFF_RTK_PTY_RUNNER) /dev/null
must_expect "RTK_RESUME_DONE"
after 150
send -- "\\004"
expect {
    eof {}
    timeout {
        puts stderr "Timed out waiting for resumed Pi to exit"
        exit 4
    }
}
`;
}

function run(command: readonly string[], cwd: string): string {
	const result = Bun.spawnSync([...command], { cwd, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode !== 0) {
		fail(`${command[0]} exited ${String(result.exitCode)}: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString().trim();
}

function verifyHostVersion(piBinary: string): void {
	const version = run([piBinary, "--version"], root);
	if (version !== CERTIFIED_PI_VERSION) fail(`expected Pi ${CERTIFIED_PI_VERSION}, received ${version || "nothing"}`);
}

async function resolveInstalledRtk(): Promise<string> {
	const probe = await probeInstalledTool("RTK", `rtk ${CERTIFIED_RTK_VERSION}`);
	if (probe.status !== "ready" || !probe.path) fail(formatInstalledToolFailure(probe, `rtk ${CERTIFIED_RTK_VERSION}`));
	return probe.path;
}

function runPty(
	phase: "fresh" | "resume",
	options: {
		readonly configDirectory: string;
		readonly logPath: string;
		readonly packagePath: string;
		readonly path: string;
		readonly piBinary: string;
		readonly projectDirectory: string;
		readonly rtkBinary: string;
		readonly sessionDirectory: string;
		readonly sessionFile?: string;
	},
): string {
	const result = Bun.spawnSync(["expect", "-c", phase === "fresh" ? freshExpectProgram() : resumeExpectProgram()], {
		cwd: options.projectDirectory,
		env: {
			...process.env,
			PATH: options.path,
			PI_CODING_AGENT_DIR: options.configDirectory,
			PI_STUFF_RTK_PTY_BIN: options.piBinary,
			PI_STUFF_RTK_PTY_EXECUTABLE: options.rtkBinary,
			PI_STUFF_RTK_PTY_LOG: options.logPath,
			PI_STUFF_RTK_PTY_PACKAGE: resolve(options.packagePath),
			PI_STUFF_RTK_PTY_PHASE: phase,
			PI_STUFF_RTK_PTY_PROVIDER_EXTENSION: providerExtension,
			PI_STUFF_RTK_PTY_RUNNER: runner,
			PI_STUFF_RTK_PTY_SESSIONS: options.sessionDirectory,
			PI_STUFF_RTK_PTY_SESSION: options.sessionFile ?? "",
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = result.stdout.toString();
	if (result.exitCode !== 0) {
		fail(
			`${phase} Pi failed: ${result.stderr.toString().trim() || `expect exited ${String(result.exitCode)}`}\nPTY tail:\n${output.slice(-12_000)}`,
		);
	}
	return output;
}

function parseContextRecords(contents: string): ContextRecord[] {
	return contents
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const record = JSON.parse(line);
			if (!Check(CONTEXT_RECORD_SCHEMA, record)) fail("provider log contains a malformed context record");
			return record;
		});
}

function recordForPhase(records: readonly ContextRecord[], phase: string): ContextRecord {
	for (let index = records.length - 1; index >= 0; index -= 1) {
		const record = records[index];
		if (record?.phase === phase) return record;
	}
	return fail(`provider did not record the ${phase} model context`);
}

function projectedResult(record: ContextRecord): string {
	if (!Array.isArray(record.toolResults)) fail("provider record has no projected Tool results");
	const result = record.toolResults.find((candidate) => candidate.id === LONG_RESULT_ID);
	if (!result || !isRuntimeString(result.text)) fail("provider record has no projected long Bash result");
	return result.text;
}

function verifyCommandHistory(record: ContextRecord): void {
	if (!Array.isArray(record.bashCommands)) fail("provider record has no Bash command history");
	for (const command of ["git status", RG_FILES_COMMAND, RG_SEARCH_COMMAND]) {
		if (!record.bashCommands.includes(command)) {
			fail(`model context did not retain ${command}: ${JSON.stringify(record.bashCommands)}`);
		}
	}
}

function verifyExecutedCommands(record: ContextRecord): void {
	if (!Array.isArray(record.executedCommands)) fail("provider record has no executed Bash command history");
	for (const command of [`rtk git status`, `rtk ${RG_FILES_COMMAND}`, `rtk ${RG_SEARCH_COMMAND}`]) {
		if (!record.executedCommands.includes(command)) {
			fail(`Host did not pass the RTK-rewritten command to Bash: ${JSON.stringify(record.executedCommands)}`);
		}
	}
}

function rawResult(sessionContents: string, toolCallId: string): string {
	for (const line of sessionContents.split("\n")) {
		if (!line) continue;
		const entry = JSON.parse(line);
		if (!Check(SESSION_TOOL_RESULT_SCHEMA, entry) || entry.message.toolCallId !== toolCallId) continue;
		return entry.message.content
			.filter((part) => part.type === "text")
			.flatMap((part) => (part.text === undefined ? [] : [part.text]))
			.join("\n");
	}
	fail(`raw session has no Bash Tool result for ${toolCallId}`);
}

function verifyProjection(raw: string, projected: string, label: string): void {
	if (raw.length <= 12_000) fail("raw Bash result was not large enough to exercise projection");
	if (!raw.includes("\u001b[31mRAW_RTK_RESULT_MARKER\u001b[0m") || !raw.includes("RAW_RTK_LONG_LINE_1599")) {
		fail("raw session did not retain the original ANSI and tail markers");
	}
	if (projected === raw || projected.length > 12_100) fail(`${label} context did not bound the long Bash result`);
	if (projected.includes("\u001b") || !projected.includes("RAW_RTK_RESULT_MARKER")) {
		fail(`${label} context did not sanitize ANSI while retaining useful output`);
	}
}

export async function verifyRtkPty(options: {
	readonly packagePath: string;
	readonly piBinary: string;
}): Promise<void> {
	verifyHostVersion(options.piBinary);
	const rtkBinary = await resolveInstalledRtk();
	const inheritedPath = process.env["PATH"];
	if (!inheritedPath) fail("PATH is required to run the RTK PTY verification");
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-rtk-pty-"));
	const configDirectory = join(temporaryDirectory, "config");
	const sessionDirectory = join(temporaryDirectory, "sessions");
	const projectDirectory = join(temporaryDirectory, "project");
	const logPath = join(temporaryDirectory, "provider.jsonl");
	await Promise.all([mkdir(configDirectory), mkdir(sessionDirectory), mkdir(projectDirectory)]);
	await disableSessionNamingForTest(configDirectory);
	await Promise.all([
		writeFile(join(temporaryDirectory, "rtk"), '#!/bin/sh\nexec "$PI_STUFF_RTK_PTY_EXECUTABLE" "$@"\n', {
			mode: 0o755,
		}),
		writeFile(
			join(configDirectory, "settings.json"),
			`${JSON.stringify({ defaultProjectTrust: "always" }, null, "\t")}\n`,
			{ mode: 0o600 },
		),
		writeFile(join(projectDirectory, "untracked.txt"), "RTK fixture\n", { mode: 0o600 }),
	]);
	run(["git", "-c", "init.defaultBranch=fixture", "init", "-q"], projectDirectory);

	try {
		const shared = {
			configDirectory,
			logPath,
			packagePath: options.packagePath,
			path: `${temporaryDirectory}:${inheritedPath}`,
			piBinary: options.piBinary,
			projectDirectory,
			rtkBinary,
			sessionDirectory,
		};
		const freshOutput = runPty("fresh", shared);
		const visibleFresh = stripTerminalControls(freshOutput);
		for (const required of [
			"RTK_FRESH_DONE",
			"RTK",
			"Runtime",
			"ready",
			CERTIFIED_RTK_VERSION,
			"Behavior",
			"Command rewriting",
			"Model projection",
			"Session savings",
			"/rtk takes no subcommands; run /rtk.",
		]) {
			if (!visibleFresh.includes(required)) fail(`fresh TUI is missing ${required}`);
		}
		const sessions = (await readdir(sessionDirectory)).filter((entry) => entry.endsWith(".jsonl"));
		if (sessions.length !== 1 || !sessions[0]) fail("fresh Pi did not create exactly one isolated session");
		const sessionFile = join(sessionDirectory, sessions[0]);
		const sessionBeforeResume = await readFile(sessionFile, "utf8");
		const rawGitStatus = rawResult(sessionBeforeResume, "rtk-pty-git-status");
		if (!rawGitStatus.includes("* No commits yet on fixture") || !rawGitStatus.includes("?? untracked.txt")) {
			fail(`real Host did not execute the RTK-rewritten git status command: ${rawGitStatus}`);
		}
		if (rawGitStatus.includes("On branch fixture")) fail("real Host executed raw git status instead of RTK");
		const rawRgFiles = rawResult(sessionBeforeResume, "rtk-pty-rg-files");
		if (!rawRgFiles.includes("untracked.txt")) {
			fail(`real Host did not execute the RTK-rewritten rg --files command: ${rawRgFiles}`);
		}
		const rawRgSearch = rawResult(sessionBeforeResume, "rtk-pty-rg-search");
		if (!rawRgSearch.includes("1:RTK fixture")) {
			fail(`real Host did not execute the RTK-rewritten rg search command: ${rawRgSearch}`);
		}
		const rawBeforeResume = rawResult(sessionBeforeResume, LONG_RESULT_ID);
		const freshRecord = recordForPhase(parseContextRecords(await readFile(logPath, "utf8")), "fresh");
		verifyCommandHistory(freshRecord);
		verifyExecutedCommands(freshRecord);
		const projectedFresh = projectedResult(freshRecord);
		verifyProjection(rawBeforeResume, projectedFresh, "fresh");

		const resumeOutput = runPty("resume", { ...shared, sessionFile });
		if (!stripTerminalControls(resumeOutput).includes("RTK_RESUME_DONE")) fail("resumed TUI did not complete");
		const rawAfterResume = rawResult(await readFile(sessionFile, "utf8"), LONG_RESULT_ID);
		if (rawAfterResume !== rawBeforeResume) fail("session reload changed the original raw Bash result");
		const resumeRecord = recordForPhase(parseContextRecords(await readFile(logPath, "utf8")), "resume");
		verifyCommandHistory(resumeRecord);
		const projectedResume = projectedResult(resumeRecord);
		verifyProjection(rawAfterResume, projectedResume, "resumed");
		if (projectedResume !== projectedFresh)
			fail("fresh and resumed model contexts projected the same result differently");
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const piBinary = resolvePiBinary();
	await verifyRtkPty({ packagePath: join(root, "packages/pi-stuff"), piBinary });
	console.log("Certified RTK rewrite and projection across fresh/resumed real Pi TUI sessions");
}
