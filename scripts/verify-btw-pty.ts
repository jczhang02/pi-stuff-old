import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
	isJsonInputObject,
	type JsonInputObject,
	type JsonInputValue,
	parseJsonValue,
} from "../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { selectAcceptanceMatrix } from "./acceptance-matrix.js";
import { resolvePiBinary } from "./installed-tools.ts";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/btw-pty-provider.ts");
const runner = join(root, "tests/fixtures/btw-pty-runner.sh");

export interface BtwPtyVerificationOptions {
	readonly piBinary: string;
	readonly packagePath: string;
	readonly columns: number;
	readonly rows: number;
}

const REQUEST_RECORD_SCHEMA = Type.Object(
	{
		lastUser: Type.Optional(Type.String()),
		messageChars: Type.Optional(Type.Number()),
		messageCount: Type.Optional(Type.Number()),
		tools: Type.Optional(Type.Array(Type.String())),
	},
	{ additionalProperties: true },
);
type RequestRecord = Static<typeof REQUEST_RECORD_SCHEMA>;

interface PersistedSession {
	readonly path: string;
	readonly lines: readonly JsonInputObject[];
	readonly messageText: readonly string[];
}

function contentText(content: JsonInputValue): string {
	if (isRuntimeString(content)) return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (!isJsonInputObject(part) || part["type"] !== "text" || !isRuntimeString(part["text"])) return [];
			return [part["text"]];
		})
		.join("\n");
}

function messageText(line: JsonInputObject): string | undefined {
	if (line["type"] !== "message" || !isJsonInputObject(line["message"])) return undefined;
	const message = line["message"];
	if (message["role"] !== "user" && message["role"] !== "assistant") return undefined;
	return contentText(message["content"]);
}

function parseRequestRecords(contents: string): RequestRecord[] {
	return contents
		.trim()
		.split("\n")
		.map((line) => {
			const record = JSON.parse(line);
			if (!Check(REQUEST_RECORD_SCHEMA, record)) fail("provider log contains a malformed request record");
			return record;
		});
}

async function readSession(path: string): Promise<PersistedSession> {
	const lines = (await readFile(path, "utf8"))
		.trim()
		.split("\n")
		.map((line) => {
			const value = parseJsonValue(line);
			if (!isJsonInputObject(value)) fail(`session ${path} contains a non-object record`);
			return value;
		});
	return {
		path,
		lines,
		messageText: lines.map(messageText).filter((text): text is string => text !== undefined),
	};
}

const EXPECT_PROGRAM = `
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

spawn -noecho script -qefc $env(PI_STUFF_PTY_RUNNER) /dev/null
must_expect "Working"
after 200
send -- "/btw side question\\r"
must_expect "BTW_STREAM"
must_expect "BTW_DONE"
for {set index 0} {$index < 8} {incr index} {
    send -- "\\033\\[A"
    after 50
}
must_expect "scroll line 10"
for {set index 0} {$index < 8} {incr index} {
    send -- "\\033\\[B"
    after 50
}
must_expect "BTW_DONE"
after 2100
send -- "\\033"
after 200
send -- "DRAFT_RESTORED"
after 100
send -- "\\033\\[24~"
must_expect "DRAFT_SURFACE"
send -- "\\033"
must_expect "DRAFT_RESTORED"
send -- "\\025"
after 200
send -- "/btw second question\\r"
must_expect "second question"
must_expect "BTW_STREAM"
must_expect "BTW_DONE"
send -- "\\033"
after 150
send -- "/btw\\r"
must_expect "side question"
must_expect "second question"
must_expect "BTW_DONE"
send -- "x"
must_expect "Clear BTW history?"
send -- "\\033"
after 150
send -- "x"
must_expect "Clear BTW history?"
send -- "y"
must_expect "Cleared BTW history"
send -- "f"
after 700
send -- "/btw\\r"
must_expect "Ask a question with /btw <question>."
send -- " "
after 150
send -- "\\r"
after 150
send -- "?"
must_expect "BTW / Keys"
send -- "\\033"
after 150
send -- "\\033"
after 150
send -- "\\003"
after 200
send -- "\\004"
expect {
    eof {}
    timeout {
        puts stderr "Timed out waiting for Pi to exit"
        exit 4
    }
}
`;

const RESUME_EXPECT_PROGRAM = `
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

spawn -noecho script -qefc $env(PI_STUFF_PTY_RUNNER) /dev/null
must_expect "MAIN_DONE"
after 200
send -- "/btw\\r"
must_expect "second question"
must_expect "BTW_DONE"
send -- "\\033"
after 150
send -- "\\003"
after 200
send -- "\\004"
expect {
    eof {}
    timeout {
        puts stderr "Timed out waiting for resumed Pi to exit"
        exit 4
    }
}
`;

const LARGE_FIT_EXPECT_PROGRAM = `
set timeout 30

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

spawn -noecho script -qefc $env(PI_STUFF_PTY_RUNNER) /dev/null
must_expect "MAIN_DONE"
after 200
send -- "/fixture-btw-large\r"
must_expect "BTW_LARGE_CONTEXT_READY"
set fit_started [clock milliseconds]
send -- "/btw large fit question\r"
must_expect "BTW_STREAM"
must_expect "BTW_DONE"
set fit_finished [clock milliseconds]
puts "BTW_LARGE_FIT_MS [expr {$fit_finished - $fit_started}]"
send -- "\\x1b"
after 150
send -- "\\x03"
after 200
send -- "\\x04"
expect {
    eof {}
    timeout {
        puts stderr "Timed out waiting for large-fit Pi to exit"
        exit 4
    }
}
`;

function fail(message: string): never {
	throw new Error(`BTW PTY verification failed: ${message}`);
}

function runExpect(program: string, environment: NodeJS.ProcessEnv, label: string): string {
	const result = Bun.spawnSync(["expect", "-c", program], {
		cwd: root,
		env: environment,
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = result.stdout.toString();
	if (result.exitCode !== 0) {
		const diagnostic = [result.stderr.toString().trim(), output.trim()].filter(Boolean).join("\n");
		fail(diagnostic || `${label} expect exited ${String(result.exitCode)}`);
	}
	return output;
}

async function verifyFreshBtwState(requestLog: string, sessionDirectory: string): Promise<string> {
	const requests = parseRequestRecords(await readFile(requestLog, "utf8"));
	if (requests.length !== 3) fail(`expected three model requests, received ${String(requests.length)}`);
	const [main, side, secondSide] = requests;
	if (main?.lastUser !== "main request") fail("main request was not observed");
	if (!Array.isArray(main.tools) || !main.tools.includes("TaskCreate")) fail("Suite Todo tools were not active");
	if (side?.lastUser !== "side question") fail("side request was not observed");
	if (side.messageCount !== 2) fail("side request included the pending main assistant or missed the main user");
	if (!Array.isArray(side.tools) || side.tools.length !== 0) fail("side request exposed tools");
	if (secondSide?.lastUser !== "second question") fail("second side request was not observed");
	if (secondSide.messageCount !== 3) fail("second side request did not include the completed main turn exactly once");
	if (!Array.isArray(secondSide.tools) || secondSide.tools.length !== 0) fail("second side request exposed tools");

	const sessionFiles = (await readdir(sessionDirectory))
		.filter((entry) => entry.endsWith(".jsonl"))
		.map((entry) => join(sessionDirectory, entry));
	if (sessionFiles.length !== 2)
		fail(`expected original and promoted sessions, received ${String(sessionFiles.length)}`);
	const sessions = await Promise.all(sessionFiles.map(readSession));
	const original = sessions.find((session) => session.messageText.includes("main request"));
	const promoted = sessions.find((session) => session.messageText.includes("second question"));
	if (!original || !promoted || original === promoted) fail("could not distinguish original and promoted sessions");
	if (!original.messageText.includes("MAIN_START MAIN_DONE")) fail("the main turn did not finish while BTW was open");
	for (const forbidden of ["side question", "second question", "BTW_STREAM", "BTW_DONE", "DRAFT_RESTORED"]) {
		if (original.messageText.some((text) => text.includes(forbidden))) {
			fail(`ephemeral text leaked into the original formal transcript: ${forbidden}`);
		}
	}
	const originalHistory = original.lines.filter(
		(line) => line["type"] === "custom" && line["customType"] === "@jczhang02/pi-stuff-btw/history/v1",
	);
	if (
		originalHistory.length !== 3 ||
		!originalHistory.some((line) => JSON.stringify(line).includes('"operation":"retain"')) ||
		!JSON.stringify(originalHistory).includes("second question")
	) {
		fail("the original session did not retain the confirmed BTW history reduction");
	}
	if (
		!promoted.messageText.includes("second question") ||
		!promoted.messageText.some((text) => text.includes("BTW_DONE"))
	) {
		fail("the selected BTW question and answer were not promoted as formal turns");
	}
	if (
		promoted.lines.some(
			(line) => line["type"] === "custom" && line["customType"] === "@jczhang02/pi-stuff-btw/history/v1",
		)
	) {
		fail("the promoted session inherited BTW display history");
	}
	const promotedHeader = promoted.lines.find((line) => line["type"] === "session");
	if (promotedHeader?.["parentSession"] !== original.path)
		fail("the promoted session lost its original-session lineage");
	return original.path;
}

async function verifyLargeBtwFit(
	options: BtwPtyVerificationOptions,
	baseEnvironment: NodeJS.ProcessEnv,
	requestLog: string,
	sessionDirectory: string,
): Promise<void> {
	const output = runExpect(
		LARGE_FIT_EXPECT_PROGRAM,
		{
			...baseEnvironment,
			PI_STUFF_PTY_LOG: requestLog,
			PI_STUFF_PTY_SESSIONS: sessionDirectory,
			PI_STUFF_PTY_SESSION_ID: `btw-large-pty-${String(options.columns)}x${String(options.rows)}`,
		},
		"large-fit",
	);
	const fitDuration = /BTW_LARGE_FIT_MS (\d+)/u.exec(output)?.[1];
	if (!fitDuration || Number(fitDuration) > 2_000) {
		fail(`large BTW fit took ${fitDuration ?? "an unknown number of"} ms`);
	}
	const requests = parseRequestRecords(await readFile(requestLog, "utf8"));
	if (requests.length !== 2) fail(`expected main and large BTW requests, received ${String(requests.length)}`);
	const request = requests[1];
	if (request?.lastUser !== "large fit question") fail("large BTW question was not observed");
	if (request.messageChars === undefined || request.messageChars > 750_000) {
		fail(`large BTW request was not fitted to the model window: ${String(request.messageChars)}`);
	}
	if (!Array.isArray(request.tools) || request.tools.length !== 0) fail("large BTW request exposed tools");
	const sessionFiles = (await readdir(sessionDirectory))
		.filter((entry) => entry.endsWith(".jsonl"))
		.map((entry) => join(sessionDirectory, entry));
	if (sessionFiles.length !== 1) fail(`expected one large-fit session, received ${String(sessionFiles.length)}`);
	const [sessionFile] = sessionFiles;
	if (!sessionFile) fail("large-fit session file was not found");
	const session = await readSession(sessionFile);
	const history = session.lines.filter(
		(line) => line["type"] === "custom" && line["customType"] === "@jczhang02/pi-stuff-btw/history/v1",
	);
	if (!JSON.stringify(history).includes('"contextTrimmed":true')) fail("large BTW fit was not recorded as trimmed");
}

export async function verifyBtwPty(options: BtwPtyVerificationOptions): Promise<void> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-btw-pty-"));
	const configDirectory = join(temporaryDirectory, "config");
	const largeRequestLog = join(temporaryDirectory, "large-requests.jsonl");
	const largeSessionDirectory = join(temporaryDirectory, "large-sessions");
	const sessionDirectory = join(temporaryDirectory, "sessions");
	const requestLog = join(temporaryDirectory, "requests.jsonl");
	await Promise.all([mkdir(configDirectory), mkdir(largeSessionDirectory), mkdir(sessionDirectory)]);
	await disableSessionNamingForTest(configDirectory);

	try {
		const baseEnvironment = {
			...process.env,
			MAGIC_CONTEXT_PI_SUBAGENT: "1",
			PI_CODING_AGENT_DIR: configDirectory,
			PI_STUFF_CODE_MODE_FROZEN: "off",
			PI_STUFF_PTY_BIN: options.piBinary,
			PI_STUFF_PTY_COLUMNS: String(options.columns),
			PI_STUFF_PTY_LOG: requestLog,
			PI_STUFF_PTY_PACKAGE: resolve(options.packagePath),
			PI_STUFF_PTY_PROVIDER_EXTENSION: providerExtension,
			PI_STUFF_PTY_ROWS: String(options.rows),
			PI_STUFF_PTY_RUNNER: runner,
			PI_STUFF_PTY_SESSIONS: sessionDirectory,
			PI_STUFF_PTY_SESSION_ID: `btw-pty-${options.columns}x${options.rows}`,
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
		};
		runExpect(EXPECT_PROGRAM, baseEnvironment, "fresh");
		const originalSession = await verifyFreshBtwState(requestLog, sessionDirectory);
		runExpect(RESUME_EXPECT_PROGRAM, { ...baseEnvironment, PI_STUFF_PTY_RESUME_SESSION: originalSession }, "resumed");
		const requestsAfterResume = (await readFile(requestLog, "utf8")).trim().split("\n");
		if (requestsAfterResume.length !== 3) fail("reopening durable BTW history made an unexpected model request");
		await verifyLargeBtwFit(options, baseEnvironment, largeRequestLog, largeSessionDirectory);
	} finally {
		await rm(temporaryDirectory, { recursive: true, force: true });
	}
}

if (import.meta.main) {
	const PI_BIN = resolvePiBinary();
	for (const [columns, rows] of selectAcceptanceMatrix(
		[
			[100, 32],
			[64, 28],
		] as const,
		[[100, 32]] as const,
	)) {
		await verifyBtwPty({
			piBinary: PI_BIN,
			packagePath: join(root, "packages/pi-stuff"),
			columns,
			rows,
		});
	}
	console.log("Certified BTW in selected PTYs");
}
