import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const runner = join(root, "tests/fixtures/context-pty-runner.sh");
const MUST_EXPECT = `
proc must_expect {pattern} {
    expect {
        -exact $pattern {}
        timeout { puts stderr "Timed out waiting for: $pattern"; exit 2 }
        eof { puts stderr "Reached EOF waiting for: $pattern"; exit 3 }
    }
}
`;

const SIMPLE_PROGRAMS = {
	automatic: { done: "CONTEXT_FIRST_DONE", label: "Automatic Context", wait: "automatic Context turn" },
	direct: { done: "CONTEXT_FIRST_DONE", label: "Direct Context", wait: "direct Context turn" },
	unavailable: { done: "Context could not recover", label: "Unavailable", wait: "Context failure explanation" },
	isolation: { done: "CONTEXT_ISOLATION_DONE", label: "Isolated Context", wait: "isolated Context search" },
} as const;

function fail(message: string): never {
	throw new Error(`Context PTY verification failed: ${message}`);
}

function exitProgram(error: string): string {
	return `send -- "\\003"
after 150
send -- "\\004"
expect { eof {} timeout { puts stderr "${error}"; exit 4 } }`;
}

export function expectProgram(): string {
	return `
set timeout 60
${MUST_EXPECT}
proc must_log {pattern} {
    global env
    for {set attempt 0} {$attempt < 200} {incr attempt} {
        if {[file exists $env(PI_STUFF_CONTEXT_PTY_LOG)]} {
            set handle [open $env(PI_STUFF_CONTEXT_PTY_LOG) r]
            set contents [read $handle]
            close $handle
            foreach line [split $contents "\n"] {
                if {[string first {"type":"request"} $line] >= 0 && [string first $pattern $line] >= 0} { return }
            }
        }
        after 25
    }
    puts stderr "Timed out waiting for provider request: $pattern"
    puts stderr "Provider log: $contents"
    exit 6
}

spawn -noecho script -qefc $env(PI_STUFF_CONTEXT_PTY_RUNNER) /dev/null
must_expect "CONTEXT_FIRST_DONE"
send -- "/ctx "
must_expect "Open Context status"
send -- [binary format c 27]
after 100
send -- [binary format c 21]
after 100
send -- "/ctx\r"
must_expect "Wrap up history"
send -- "\r"
must_expect "Keep 20 recent messages"
send -- [binary format c 27]
must_expect "Rebuild compartments"
send -- [binary format c 27]
after 100
send -- "CONTEXT_DIALOG_FOCUS"
must_expect "CONTEXT_DIALOG_FOCUS"
send -- [binary format c 21]
send -- "/ctx flush\r"
must_expect "Context flush"
must_expect "nothing queued"
send -- "CONTEXT_SECOND\r"
must_log "CONTEXT_SECOND"
must_expect "CONTEXT_SECOND_DONE"
send -- "CONTEXT_MEMORY\r"
must_expect "CONTEXT_MEMORY_DONE"
send -- "CONTEXT_SEARCH\r"
must_expect "CONTEXT_SEARCH_DONE"
send -- "CONTEXT_BULK\r"
must_expect "CONTEXT_BULK_DONE"
send -- "/compact\r"
after 600
send -- "CONTEXT_AFTER_COMPACT\r"
must_expect "CONTEXT_AFTER_COMPACT_DONE"
set historian_ready 0
for {set attempt 0} {$attempt < 120} {incr attempt} {
    if {[file exists $env(PI_STUFF_CONTEXT_PTY_HISTORIAN_MARKER)]} {
        set historian_ready 1
        break
    }
    after 250
}
if {!$historian_ready} { puts stderr "Historian provider was never reached"; exit 5 }
after 500
send -- "CONTEXT_SETTLE\r"
must_expect "CONTEXT_SETTLE_DONE"
send -- "CONTEXT_SEARCH_AGAIN\r"
must_expect "CONTEXT_SEARCH_AGAIN_DONE"
${exitProgram("Pi did not exit")}
`;
}

export function startupOnlyProgram(): string {
	return `
set timeout 30
spawn -noecho script -qefc $env(PI_STUFF_CONTEXT_PTY_RUNNER) /dev/null
set session_ready 0
for {set attempt 0} {$attempt < 120} {incr attempt} {
    if {[file exists $env(PI_STUFF_CONTEXT_PTY_LOG)]} {
        set handle [open $env(PI_STUFF_CONTEXT_PTY_LOG) r]
        set contents [read $handle]
        close $handle
        if {[string first {"type":"session"} $contents] >= 0} { set session_ready 1; break }
    }
    after 250
}
if {!$session_ready} { puts stderr "Timed out waiting for startup session event"; exit 2 }
send -- "/context-startup-ready\\r"
expect {
    -exact "CONTEXT_STARTUP_READY" {}
    timeout { puts stderr "Timed out waiting for post-session_start readiness"; exit 5 }
    eof { puts stderr "Startup-only Pi exited before the readiness command"; exit 6 }
}
${exitProgram("Startup-only Pi did not exit")}
`;
}

export function simpleProgram(name: keyof typeof SIMPLE_PROGRAMS): string {
	const { done, label, wait } = SIMPLE_PROGRAMS[name];
	return `
set timeout 30
spawn -noecho script -qefc $env(PI_STUFF_CONTEXT_PTY_RUNNER) /dev/null
expect {
    -exact "${done}" {}
    timeout { puts stderr "Timed out waiting for ${wait}"; exit 2 }
    eof { puts stderr "${label} Pi exited early"; exit 3 }
}
${exitProgram(`${label} Pi did not exit`)}
`;
}

export function nativeCompactionProgram(): string {
	return `
set timeout 30
${MUST_EXPECT}
spawn -noecho script -qefc $env(PI_STUFF_CONTEXT_PTY_RUNNER) /dev/null
must_expect "NATIVE_TAIL_DONE"
send -- "CONTEXT_NATIVE_RESUME\r"
must_expect "CONTEXT_NATIVE_RESUME_DONE"
${exitProgram("Native-compacted Context Pi did not exit")}
`;
}

function runCommand(args: readonly string[], environment?: Record<string, string | undefined>): string {
	const result = Bun.spawnSync([...args], { env: environment ?? process.env, stderr: "pipe", stdout: "pipe" });
	if (result.exitCode !== 0) {
		fail(`${args.join(" ")} exited ${String(result.exitCode)}: ${result.stderr.toString().trim()}`);
	}
	return result.stdout.toString();
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

export async function runResumePaintVerification(
	environment: Record<string, string | undefined>,
	cwd: string,
	magicLog: string,
): Promise<string> {
	const socket = join(environment["HOME"] ?? cwd, "context-resume-tmux.sock");
	const session = `context-resume-${String(process.pid)}`;
	const tmux = (args: readonly string[]): string => runCommand(["tmux", "-S", socket, ...args]);
	const sessionExists = (): boolean =>
		Bun.spawnSync(["tmux", "-S", socket, "has-session", "-t", session], {
			stderr: "ignore",
			stdout: "ignore",
		}).exitCode === 0;
	const capture = (history = false): string =>
		tmux(["capture-pane", "-p", "-N", ...(history ? ["-S", "-"] : []), "-t", session]);
	const waitFor = async (
		predicate: (frame: string) => boolean,
		label: string,
		timeoutMs = 20_000,
	): Promise<string> => {
		const deadline = Date.now() + timeoutMs;
		let frame = "";
		while (Date.now() < deadline) {
			frame = capture(true);
			if (predicate(frame)) return frame;
			await Bun.sleep(10);
		}
		fail(`timed out waiting for ${label}\nCurrent frame:\n${frame}`);
	};
	const send = (text: string): void => {
		tmux(["send-keys", "-t", session, "-l", "--", text]);
		tmux(["send-keys", "-t", session, "Enter"]);
	};
	let panePid: number | undefined;
	let transformStopped = false;

	runCommand(["tmux", "-V"]);
	try {
		runCommand(
			[
				"tmux",
				"-S",
				socket,
				"-f",
				"/dev/null",
				"new-session",
				"-d",
				"-s",
				session,
				"-x",
				environment["PI_STUFF_CONTEXT_PTY_COLUMNS"] ?? "64",
				"-y",
				environment["PI_STUFF_CONTEXT_PTY_ROWS"] ?? "28",
				"-c",
				cwd,
				environment["PI_STUFF_CONTEXT_PTY_RUNNER"] ?? runner,
			],
			environment,
		);
		panePid = Number(tmux(["display-message", "-p", "-t", session, "#{pane_pid}"]).trim());
		if (!Number.isSafeInteger(panePid) || panePid <= 0) fail(`invalid resumed Pi pane pid ${String(panePid)}`);
		const historyOutput = await waitFor(
			(frame) => frame.includes("CONTEXT_SEARCH_AGAIN_DONE") && frame.includes("Context search 中文检索标记 · done"),
			"resumed editor readiness with historical ctx_search row",
			40_000,
		);

		const prompt = "CONTEXT_RESUME";
		tmux(["send-keys", "-t", session, "-l", "--", prompt]);
		await waitFor((frame) => editorContains(frame, prompt), "the typed resumed prompt");
		const logOffset = (await readFile(magicLog, "utf8")).length;
		tmux(["send-keys", "-t", session, "Enter"]);

		const transformDeadline = Date.now() + 10_000;
		while (Date.now() < transformDeadline) {
			const addedLog = (await readFile(magicLog, "utf8")).slice(logOffset);
			if (addedLog.includes("findSessionId")) break;
			await Bun.sleep(5);
		}
		if (!(await readFile(magicLog, "utf8")).slice(logOffset).includes("findSessionId")) {
			fail("resumed prompt never reached the Magic Context transform");
		}
		process.kill(panePid, "SIGSTOP");
		transformStopped = true;
		const transformFrame = capture();
		if (editorContains(transformFrame, prompt)) {
			fail(`interactive prompt remained in the editor after Context transformation began\n${transformFrame}`);
		}
		process.kill(panePid, "SIGCONT");
		transformStopped = false;

		await waitFor((frame) => frame.includes("CONTEXT_RESUME_DONE"), "resumed Context response", 40_000);
		send("CONTEXT_DRAIN");
		await waitFor((frame) => frame.includes("CONTEXT_DRAIN_DONE"), "Context marker drain");
		tmux(["send-keys", "-t", session, "C-c"]);
		await Bun.sleep(150);
		tmux(["send-keys", "-t", session, "C-d"]);
		const exitDeadline = Date.now() + 5_000;
		while (sessionExists() && Date.now() < exitDeadline) await Bun.sleep(10);
		if (sessionExists()) fail("resumed Pi did not exit");
		return historyOutput;
	} finally {
		if (transformStopped && panePid !== undefined) {
			try {
				process.kill(panePid, "SIGCONT");
			} catch {
				// The pane may already have exited while the verifier was handling a failure.
			}
		}
		Bun.spawnSync(["tmux", "-S", socket, "kill-server"], { stderr: "ignore", stdout: "ignore" });
	}
}

export function runExpect(
	program: string,
	environment: Record<string, string | undefined>,
	label: string,
	cwd: string = root,
): string {
	const driver = `
set evaluation [catch {eval $env(PI_STUFF_CONTEXT_EXPECT_PROGRAM)} message options]
if {$evaluation != 0} {
    puts stderr $message
    if {[dict exists $options -errorinfo]} { puts stderr [dict get $options -errorinfo] }
    exit 1
}
set waited [catch {wait} child]
if {!$waited && [llength $child] >= 4} {
    set child_status [lindex $child 3]
    if {$child_status != 0} { exit $child_status }
}
`;
	const result = Bun.spawnSync(["expect", "-c", driver], {
		cwd,
		env: { ...environment, PI_STUFF_CONTEXT_EXPECT_PROGRAM: program },
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
	if (result.exitCode !== 0) {
		const diagnostic = output.length > 20_000 ? `[earlier PTY output omitted]\n${output.slice(-20_000)}` : output;
		fail(`${label}: ${diagnostic.trim() || `expect exited ${String(result.exitCode)}`}`);
	}
	return output;
}
