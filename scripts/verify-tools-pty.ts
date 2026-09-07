import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { codeModeHostBinaryPath } from "../packages/pi-stuff/src/code-mode/host/binary.js";
import { CODE_MODE_NO_OUTPUT_MESSAGE } from "../packages/pi-stuff/src/code-mode/runtime.js";
import { isRuntimeString } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { selectAcceptanceMatrix } from "./acceptance-matrix.js";
import { resolvePiBinary } from "./installed-tools.ts";
import { CERTIFIED_PI_VERSION } from "./pi-host-contract.ts";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";
import { stripTerminalControls } from "./terminal-controls.js";
import { runToolsPtyLiveness, type ToolsLivenessSample } from "./tools-pty-liveness.ts";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/tools-pty-provider.ts");
const runner = join(root, "tests/fixtures/tools-pty-runner.sh");
const activeParityRunner = join(root, "tests/fixtures/tools-active-parity-runner.sh");
const BUILTINS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
const BUILTIN_SET = new Set<string>(BUILTINS);
const LONG_READ_DIRECTORY = "pi-max-tools-019fc372-d606-77ef-b3d5-59ba054c8d1a/deep";
const COMPACT_TRANSCRIPT_END_MARKER = "TOOLS_PTY_COMPACT_TRANSCRIPT_END";

export interface ToolsPtyVerificationOptions {
	readonly piBinary: string;
	readonly packagePath: string;
	readonly columns: number;
	readonly rows: number;
}

const REQUEST_RECORD_SCHEMA = Type.Object(
	{
		completed: Type.Optional(Type.Number()),
		tools: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: true },
);
type RequestRecord = Static<typeof REQUEST_RECORD_SCHEMA>;

export type { ToolsLivenessSample } from "./tools-pty-liveness.ts";

function parseRequestRecords(contents: string): RequestRecord[] {
	return contents
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const record = JSON.parse(line);
			if (!Check(REQUEST_RECORD_SCHEMA, record)) fail("provider log contains a malformed request record");
			return record;
		});
}

const PTY_EXPECT_HELPERS = `
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

proc discard_pending_output {} {
    set discarded ""
    expect -timeout 0 {
        -re {.+} {
            append discarded $expect_out(0,string)
            exp_continue
        }
        timeout {}
        eof {
            puts stderr "Reached EOF while discarding pending output"
            exit 3
        }
    }
    return $discarded
}

proc wait_for_quiet {} {
    set deadline [expr {[clock milliseconds] + 5000}]
    set quiet_since [clock milliseconds]
    while {[clock milliseconds] < $deadline} {
        set pending [discard_pending_output]
        set now [clock milliseconds]
        if {$pending ne ""} {
            set quiet_since $now
        } elseif {$now - $quiet_since >= 100} {
            return
        }
        after 10
    }
    puts stderr "Timed out waiting for terminal output to settle"
    exit 2
}
`;

const EXPECT_PROGRAM = `
set timeout 25
${PTY_EXPECT_HELPERS}

proc send_and_expect {keys pattern} {
    discard_pending_output
    send -- $keys
    must_expect $pattern
    wait_for_quiet
}

proc open_tool_from_oldest {up_count} {
    discard_pending_output
    send -- "/tools\\r"
    must_expect "Tools"
    wait_for_quiet
    discard_pending_output
    send -- "\\033\\[F"
    after 40
    for {set index 0} {$index < $up_count} {incr index} {
        send -- "\\033\\[A"
        after 40
    }
    send -- "\\r"
}

spawn -noecho script -qefc $env(PI_STUFF_TOOLS_PTY_RUNNER) /dev/null
set tool_pty $spawn_out(slave,name)
set conversation_marker "run the Code Mode visibility fixture"
must_expect "TOOLS_DIRECT_DONE"
wait_for_quiet
send -- "/codemode on\r"
must_expect "Code Mode on"
wait_for_quiet
send -- "run the Code Mode visibility fixture\r"
must_expect "TOOLS_DONE"
wait_for_quiet
puts "${COMPACT_TRANSCRIPT_END_MARKER}"
send_and_expect "\\017" "Tool output: expanded"
send_and_expect "\\017" "Tool output: collapsed"
send -- "/tools\\r"
must_expect "Tools"
must_expect "11 activities"
must_expect "Tool search"
must_expect "Esc close"
wait_for_quiet
send -- "?"
must_expect "Tools / Keys"
must_expect "Ctrl+Y"
wait_for_quiet
send_and_expect "\\033" "activities"
send_and_expect "\\031" "State · cancelled"
if {$env(PI_STUFF_TOOLS_PTY_COLUMNS) >= 96} {
    send_and_expect "\\tr" "Raw"
    send_and_expect "r" "Cancellation"
    send -- "\\033\\[Z"
    wait_for_quiet
}
send_and_expect "\\031" "State · rejected"
send_and_expect "\\033\\[A" "State · cancelled"
send_and_expect " " "Bash · command"
send_and_expect "\\rr" "Raw"
send_and_expect "r" "Output"
send_and_expect "\\033" "activities"
send_and_expect "\\033" $conversation_marker
open_tool_from_oldest 1
must_expect "Tools /"
must_expect "Content"
must_expect "旧内容"
send_and_expect "\\033" "activities"
send_and_expect "\\033" $conversation_marker
open_tool_from_oldest 2
must_expect "Tools /"
must_expect "Diff"
must_expect "旧内容"
must_expect "新内容"
send -- "r"
must_expect "Raw"
must_expect "oldText"
send_and_expect "\\033" "r raw"
send_and_expect "\\033" "activities"
send_and_expect "\\033" $conversation_marker
open_tool_from_oldest 3
must_expect "Tools /"
must_expect "PREFIX_CJK_工具"
must_expect "BASH_CJK_工具"
send -- "r"
must_expect "Raw"
must_expect "Call ID: tools-pty-4"
must_expect "Arguments"
send_and_expect "\\033\\[6~" "Result content"
send_and_expect "\\033" "r raw"
send_and_expect "\\033" "activities"
send_and_expect "\\033" $conversation_marker
open_tool_from_oldest 5
must_expect "Tools /"
must_expect "BUILTIN_FAILURE_工具"
send_and_expect "\\033" "activities"
send_and_expect "\\033" $conversation_marker
send -- "/tools tools-pty-2\\r"
must_expect "/tools does not accept arguments."
wait_for_quiet
send -- "/ui\\r"
must_expect "UI"
must_expect "Tool running timer"
must_expect "true"
must_expect "Enter/Space to change"
send_and_expect "timer" "Tool running timer"
send_and_expect "\\033" $conversation_marker
send -- "/reload\\r"
must_expect "Reloaded keybindings, extensions"
must_expect "context files"
set resized_columns [expr {$env(PI_STUFF_TOOLS_PTY_COLUMNS) + 1}]
stty rows $env(PI_STUFF_TOOLS_PTY_ROWS) columns $resized_columns < $tool_pty
must_expect "Searched 2 patterns, listed 1 directory"
stty rows $env(PI_STUFF_TOOLS_PTY_ROWS) columns $env(PI_STUFF_TOOLS_PTY_COLUMNS) < $tool_pty
send -- "DRAFT_AFTER_TOOLS"
must_expect "DRAFT_AFTER_TOOLS"
send -- "\\003\\004"
expect {
    eof {}
    timeout {
        puts stderr "Timed out waiting for Pi to exit"
        exit 4
    }
}
`;

const ACTIVE_PARITY_EXPECT_PROGRAM = `
set timeout 25
${PTY_EXPECT_HELPERS}

spawn -noecho script -qefc $env(PI_STUFF_TOOLS_ACTIVE_RUNNER) /dev/null
must_expect "TOOLS_PROBE_DONE"
wait_for_quiet
send -- "/reload\\r"
must_expect "Reloaded keybindings, extensions"
must_expect "context files"
wait_for_quiet
send -- "probe after reload\\r"
must_expect "TOOLS_PROBE_DONE"
wait_for_quiet
send -- "\\004"
expect {
    eof {}
    timeout {
        puts stderr "Timed out waiting for Pi parity probe to exit"
        exit 4
    }
}
`;

function fail(message: string): never {
	throw new Error(`Tools PTY verification failed: ${message}`);
}

function verifyOutput(output: string, columns: number): void {
	if (output.includes("\u001b]0;OWNED_TITLE") || output.includes("\u009dC1_TITLE")) {
		fail("model-visible terminal controls reached the terminal");
	}
	const visible = stripTerminalControls(output);
	verifyLifecycleFrames(visible);
	const fixtureStart = visible.indexOf("run the Code Mode visibility fixture");
	const toolsDialogStart = visible.indexOf(COMPACT_TRANSCRIPT_END_MARKER, fixtureStart + 1);
	if (fixtureStart < 0 || toolsDialogStart < 0) fail("could not isolate the compact Tool transcript");
	if (visible.slice(fixtureStart, toolsDialogStart).toLowerCase().includes("tool search")) {
		fail("successful tool_search flashed in the compact transcript");
	}
	for (const hidden of [
		"CONTROL_ONLY_ACK",
		CODE_MODE_NO_OUTPUT_MESSAGE,
		"VISIBLE_CODE_MODE_SUMMARY",
		"VISIBLE_CODE_MODE_DETAIL",
	]) {
		if (visible.includes(hidden)) fail(`successful pure-JavaScript Code Mode output reached Tool UI: ${hidden}`);
	}
	if (/• Code Mode/u.test(visible)) fail("successful pure-JavaScript Code Mode rendered envelope chrome");
	for (const required of [
		"TOOLS_DONE",
		"• TOOLS_DONE",
		"• Read 1 file",
		"• Write(written.ts)",
		"• Edit(written.ts)",
		"• Searched 2 patterns, listed 1 directory",
		"• List",
		"• Bash",
		"+1/-1",
		"• State error · working",
		"• State error · error",
		"• Bash(printf '",
		"⎿  PREFIX_CJK_工具",
		"⎿  Error: Exit code 7",
		"BUILTIN_FAILURE_工具",
		"State error",
		"State rejected",
		"State cancelled",
		"Tools",
		"Tools /",
		"Tools / Keys",
		"Tool search",
		"Ctrl+Y",
		"Content",
		"Diff",
		"oldText",
		"Call ID: tools-pty-4",
		"Arguments",
		"Result content",
		"PREFIX_CJK_工具",
		"BASH_CJK_工具",
		"BUILTIN_FAILURE_工具",
		"FIXTURE_ERROR",
		"FIXTURE_REJECTED",
		"FIXTURE_CANCELLED",
		"UI",
		"Tool running timer",
		"→ Tool running timer",
		"Esc back",
		"Esc close",
		"DRAFT_AFTER_TOOLS",
	]) {
		if (!visible.includes(required)) fail(`terminal output is missing ${required}`);
	}
	if (!visible.includes("━".repeat(columns))) fail(`Tool dialog did not render a ${String(columns)}-column divider`);
	if (!/• Read pi-max-tools-[^\n]* · 1 lines/u.test(visible)) {
		fail("long Tool target did not retain a semantic boundary before its settled result");
	}
	if (/pi-max-tools-[^\n]*…[ \t]+1 lines/u.test(visible)) {
		fail("long Tool target joined its ellipsis directly to the settled result");
	}
	const sgr = "\\u001b\\[[0-9;]*m";
	if (!new RegExp(`${sgr}const${sgr}`, "u").test(output)) {
		fail("Write detail did not contain syntax-highlighted TypeScript");
	}
	if (!new RegExp(`${sgr}-${sgr}[^\\n]{0,240}旧内容`, "u").test(output)) {
		fail("Edit deletion did not contain a styled semantic marker");
	}
	if (!new RegExp(`${sgr}\\+${sgr}[^\\n]{0,240}新内容`, "u").test(output)) {
		fail("Edit addition did not contain a styled semantic marker");
	}
}

function verifyLifecycleFrames(visible: string): void {
	const running = "• State error · working";
	const settled = "• State error · error";
	const runningFrame = visible.indexOf(running);
	const settledFrame = visible.indexOf(settled, runningFrame + running.length);
	if (runningFrame < 0 || settledFrame < 0) {
		fail("independent Tool row did not expose its active and settled states");
	}
	const firstRetrieval = visible.indexOf("• Read 1 file");
	const modification = visible.indexOf("• Write(written.ts)", firstRetrieval + 1);
	const secondRetrieval = visible.indexOf("• Searched 2 patterns, listed 1 directory", modification + 1);
	if (firstRetrieval < 0 || modification < 0 || secondRetrieval < 0) {
		fail("retrieval groups and their independent modification boundary lost source order");
	}
	const activeThirdParty = visible.indexOf("• Search fixture · searching", secondRetrieval + 1);
	const settledThirdParty = visible.indexOf("• Search fixture · searched", activeThirdParty + 1);
	if (activeThirdParty < 0 || settledThirdParty < 0) {
		fail("third-party retrieval metadata escaped its independent active and settled Tool Activity");
	}
	const firstBash = visible.indexOf("⎿  PREFIX_CJK_工具");
	const failedBash = visible.indexOf("⎿  Error: Exit code 7", firstBash + 1);
	if (firstBash < 0 || failedBash < 0 || firstBash >= failedBash) {
		fail("standalone Bash operation blocks did not retain source order or child output");
	}
}

function verifyRequests(records: readonly RequestRecord[]): void {
	const expectedCompletions = [...Array.from({ length: 13 }, (_, index) => index), 12, 13, 14, 15, 16];
	const requestCount = expectedCompletions.length;
	if (records.length !== requestCount) {
		fail(`expected ${String(requestCount)} model requests, received ${String(records.length)}`);
	}
	for (const [index, record] of records.entries()) {
		if (record.completed !== expectedCompletions[index]) {
			fail(`request ${String(index)} observed the wrong completion count`);
		}
		if (!Array.isArray(record.tools)) fail(`request ${String(index)} did not expose tools`);
		if (index < 13) {
			for (const name of BUILTINS) {
				if (!record.tools.includes(name)) fail(`request ${String(index)} did not preserve the ${name} tool`);
			}
			continue;
		}
		for (const name of ["codemode", "tool_search"]) {
			if (!record.tools.includes(name)) fail(`request ${String(index)} did not expose ${name}`);
		}
		for (const name of BUILTINS) {
			if (record.tools.includes(name)) fail(`request ${String(index)} exposed the nested ${name} tool`);
		}
	}
}

function verifyHostVersion(piBinary: string): void {
	const result = Bun.spawnSync([piBinary, "--version"], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const version = result.stdout.toString().trim();
	if (result.exitCode !== 0 || version !== CERTIFIED_PI_VERSION) {
		fail(`expected Pi ${CERTIFIED_PI_VERSION}, received ${version || `exit ${String(result.exitCode)}`}`);
	}
}

export async function verifyActiveToolParity(options: {
	readonly packagePath: string;
	readonly piBinary: string;
}): Promise<void> {
	verifyHostVersion(options.piBinary);
	for (const fixture of [
		{
			args: [],
			expected: ["bash", "edit", "read", "write"],
			name: "Host defaults",
		},
		{
			args: ["--no-builtin-tools"],
			expected: [],
			name: "--no-builtin-tools",
		},
		{
			args: ["--tools", "grep,find,ls"],
			expected: ["find", "grep", "ls"],
			name: "explicit allowlist",
		},
	]) {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-tools-active-"));
		const configDirectory = join(temporaryDirectory, "config");
		const sessionDirectory = join(temporaryDirectory, "sessions");
		const requestLog = join(temporaryDirectory, "requests.jsonl");
		await Promise.all([mkdir(configDirectory), mkdir(sessionDirectory)]);
		await disableSessionNamingForTest(configDirectory);
		await writeFile(
			join(configDirectory, "settings.json"),
			`${JSON.stringify({ defaultProjectTrust: "always" }, null, "\t")}\n`,
			{ mode: 0o600 },
		);
		try {
			const result = Bun.spawnSync(["expect", "-c", ACTIVE_PARITY_EXPECT_PROGRAM], {
				cwd: temporaryDirectory,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: configDirectory,
					PI_STUFF_TOOLS_ACTIVE_MODE:
						fixture.args.length === 0
							? "default"
							: fixture.args[0] === "--no-builtin-tools"
								? "none"
								: "allowlist",
					PI_STUFF_TOOLS_ACTIVE_RUNNER: activeParityRunner,
					PI_STUFF_TOOLS_PTY_BIN: options.piBinary,
					PI_STUFF_TOOLS_PTY_LOG: requestLog,
					PI_STUFF_TOOLS_PTY_PACKAGE: resolve(options.packagePath),
					PI_STUFF_TOOLS_PTY_PROBE_ONLY: "1",
					PI_STUFF_TOOLS_PTY_PROVIDER_EXTENSION: providerExtension,
					PI_STUFF_TOOLS_PTY_SESSIONS: sessionDirectory,
					PI_STUFF_TOOLS_PTY_SESSION_ID: `tools-active-${fixture.name.replace(/\W+/gu, "-")}`,
					SHELL: "/bin/sh",
					TERM: "xterm-256color",
				},
				stderr: "pipe",
				stdout: "pipe",
			});
			if (result.exitCode !== 0) {
				fail(
					`${fixture.name} reload parity probe failed: ${result.stderr.toString().trim()}\nPTY tail:\n${result.stdout.toString().slice(-8_000)}`,
				);
			}
			const records = parseRequestRecords(await readFile(requestLog, "utf8"));
			if (records.length !== 2) {
				fail(`${fixture.name} reload parity probe expected two model requests; received ${String(records.length)}`);
			}
			for (const [index, record] of records.entries()) {
				if (!Array.isArray(record.tools)) fail(`${fixture.name} request ${String(index + 1)} did not expose tools`);
				const builtins = record.tools.filter(
					(name): name is string => isRuntimeString(name) && BUILTIN_SET.has(name),
				);
				expectEqualStrings(builtins, fixture.expected, `${fixture.name} request ${String(index + 1)}`);
			}
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	}
}

function expectEqualStrings(actual: readonly string[], expected: readonly string[], label: string): void {
	const normalizedActual = [...actual].sort();
	const normalizedExpected = [...expected].sort();
	if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
		fail(
			`${label} changed active built-ins: expected ${normalizedExpected.join(", ") || "none"}; received ${normalizedActual.join(", ") || "none"}`,
		);
	}
}

export async function verifyToolsLivenessPty(options: ToolsPtyVerificationOptions): Promise<ToolsLivenessSample[]> {
	verifyHostVersion(options.piBinary);
	const samples = await runToolsPtyLiveness({ ...options, providerExtension, runner });
	for (const sample of samples) {
		console.log(
			`Tool liveness ${String(sample.columns)}x${String(sample.rows)} ${sample.payloadKind}: UI ${String(sample.firstUiMs)}ms, ${sample.interaction} ${String(sample.interactionMs)}ms, spinner ${String(sample.maximumSpinnerFrameMs)}ms`,
		);
	}
	return samples;
}

export async function verifyToolsPty(options: ToolsPtyVerificationOptions): Promise<void> {
	verifyHostVersion(options.piBinary);
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-tools-pty-"));
	const configDirectory = join(temporaryDirectory, "config");
	const sessionDirectory = join(temporaryDirectory, "sessions");
	const requestLog = join(temporaryDirectory, "requests.jsonl");
	const shellEvidence = join(temporaryDirectory, "shell-path-used.log");
	const shellWrapper = join(temporaryDirectory, "fixture-shell.sh");
	const projectConfigDirectory = join(temporaryDirectory, ".pi");
	await Promise.all([
		mkdir(configDirectory),
		mkdir(sessionDirectory),
		mkdir(projectConfigDirectory),
		mkdir(join(temporaryDirectory, LONG_READ_DIRECTORY), { recursive: true }),
	]);
	await disableSessionNamingForTest(configDirectory);
	await writeFile(join(temporaryDirectory, LONG_READ_DIRECTORY, "sample-工具.txt"), "输入内容\n", { mode: 0o600 });
	await writeFile(shellWrapper, `#!/bin/sh\nprintf 'SHELL_PATH_USED\\n' >> '${shellEvidence}'\nexec /bin/sh "$@"\n`, {
		mode: 0o700,
	});
	await chmod(shellWrapper, 0o700);
	await writeFile(
		join(configDirectory, "settings.json"),
		`${JSON.stringify({ defaultProjectTrust: "always", images: { autoResize: false }, shellPath: shellWrapper }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		join(configDirectory, "keybindings.json"),
		`${JSON.stringify({ "tui.select.down": ["down", "ctrl+y"] }, null, "\t")}\n`,
		{ mode: 0o600 },
	);
	await writeFile(
		join(projectConfigDirectory, "settings.json"),
		`${JSON.stringify({ shellCommandPrefix: "printf 'PREFIX_CJK_工具\\n';" }, null, "\t")}\n`,
		{ mode: 0o600 },
	);

	try {
		const result = Bun.spawnSync(["expect", "-c", EXPECT_PROGRAM], {
			cwd: temporaryDirectory,
			env: {
				...process.env,
				PI_CODING_AGENT_DIR: configDirectory,
				PI_STUFF_CODE_MODE_DEFAULT: "off",
				PI_STUFF_CODE_MODE_FROZEN: "",
				PI_STUFF_CODE_MODE_HOST: codeModeHostBinaryPath(),
				PI_STUFF_TOOLS_PTY_BIN: options.piBinary,
				PI_STUFF_TOOLS_PTY_COLUMNS: String(options.columns),
				PI_STUFF_TOOLS_PTY_LOG: requestLog,
				PI_STUFF_TOOLS_PTY_PACKAGE: resolve(options.packagePath),
				PI_STUFF_TOOLS_PTY_PROVIDER_EXTENSION: providerExtension,
				PI_STUFF_TOOLS_PTY_ROWS: String(options.rows),
				PI_STUFF_TOOLS_PTY_RUNNER: runner,
				PI_STUFF_TOOLS_PTY_SESSIONS: sessionDirectory,
				PI_STUFF_TOOLS_PTY_SESSION_ID: `tools-pty-${String(options.columns)}x${String(options.rows)}`,
				SHELL: "/bin/sh",
				TERM: "xterm-256color",
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = result.stdout.toString();
		if (result.exitCode !== 0) {
			const log = await readFile(requestLog, "utf8").catch(() => "(request log unavailable)");
			fail(
				`${result.stderr.toString().trim() || `expect exited ${String(result.exitCode)}`}\nRequests:\n${log}\nPTY tail:\n${output.slice(-12_000)}`,
			);
		}
		try {
			verifyOutput(output, options.columns);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`${message}\nPTY tail:\n${output.slice(-12_000)}`, {
				cause: error,
			});
		}
		const records = parseRequestRecords(await readFile(requestLog, "utf8"));
		verifyRequests(records);
		if (
			(await readFile(join(temporaryDirectory, "written.ts"), "utf8")) !==
			'const label = "新内容";\nconst count = 2;\n'
		) {
			fail("the original Host edit execution contract changed");
		}
		if (!(await readFile(shellEvidence, "utf8")).includes("SHELL_PATH_USED")) {
			fail("the configured Host shellPath was not used by Bash execution");
		}
		const sessions = (await readdir(sessionDirectory)).filter((entry) => entry.endsWith(".jsonl"));
		if (sessions.length !== 1 || !sessions[0]) fail("expected exactly one isolated session");
		const transcript = await readFile(join(sessionDirectory, sessions[0]), "utf8");
		for (const required of [
			"OWNED_TITLE",
			"PREFIX_CJK_工具",
			"BASH_CJK_工具",
			"BUILTIN_FAILURE_工具",
			"FIXTURE_SEARCH",
			"FIXTURE_ERROR",
			"FIXTURE_REJECTED",
			"FIXTURE_CANCELLED",
			"tool_search",
			"CONTROL_ONLY_ACK",
			CODE_MODE_NO_OUTPUT_MESSAGE,
			"VISIBLE_CODE_MODE_SUMMARY",
			"VISIBLE_CODE_MODE_DETAIL",
			"pi-stuff-code-mode",
			...BUILTINS,
		]) {
			if (!transcript.includes(required)) fail(`model-visible transcript is missing ${required}`);
		}
		if (transcript.includes("DRAFT_AFTER_TOOLS")) fail("Command Dialog draft text leaked into the transcript");
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const PI_BIN = resolvePiBinary();
	await verifyActiveToolParity({
		piBinary: PI_BIN,
		packagePath: join(root, "packages/pi-stuff"),
	});
	for (const [columns, rows] of selectAcceptanceMatrix(
		[
			[100, 32],
			[64, 28],
		] as const,
		[[100, 32]] as const,
	)) {
		await verifyToolsPty({
			piBinary: PI_BIN,
			packagePath: join(root, "packages/pi-stuff"),
			columns,
			rows,
		});
	}
	console.log("Certified Tool UI in selected PTYs");
}
