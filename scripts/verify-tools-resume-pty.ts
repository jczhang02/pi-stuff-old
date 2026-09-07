import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { isRuntimeString } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { resolvePiBinary } from "./installed-tools.ts";
import { CERTIFIED_PI_VERSION } from "./pi-host-contract.ts";
import { disableSessionNamingForTest } from "./session-naming-test-settings.ts";
import { stripTerminalControls } from "./terminal-controls.js";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/tools-resume-pty-provider.ts");
const runner = join(root, "tests/fixtures/tools-resume-pty-runner.sh");
const BUILTINS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
const BUILTIN_SET = new Set<string>(BUILTINS);
const COLD_FIRST_FRAME_BOUNDARY = "COLD_FIRST_FRAME_BOUNDARY";
const FIRST_FRAME_BOUNDARY = "RESUME_FIRST_FRAME_BOUNDARY";

type ResumeMode = "allowlist" | "default" | "disabled" | "supervisor";

const REQUEST_RECORD_SCHEMA = Type.Object(
	{ tools: Type.Optional(Type.Array(Type.String())) },
	{ additionalProperties: true },
);
type RequestRecord = Static<typeof REQUEST_RECORD_SCHEMA>;

interface ResumeFixture {
	readonly compactRow?: string;
	readonly expectedBuiltins: readonly string[];
	readonly forbiddenProviderTools?: readonly string[];
	readonly forbiddenText?: string;
	readonly mode: ResumeMode;
	readonly rawMarker?: string;
	readonly resultText?: string;
}

interface ToolsResumePtyOptions {
	readonly packagePath: string;
	readonly piBinary: string;
}

const RESUME_FIXTURES = [
	{
		compactRow: "Read 1 file",
		expectedBuiltins: ["bash", "edit", "read", "write"],
		mode: "default",
		rawMarker: "RAW_RESUME_READ_RESULT_MARKER",
	},
	{ expectedBuiltins: [], mode: "disabled" },
	{
		compactRow: "Searched 1 pattern",
		expectedBuiltins: ["find", "grep", "ls"],
		mode: "allowlist",
		rawMarker: "resume-target.txt:1:RAW_RESUME_GREP_RESULT_MARKER",
	},
	{
		compactRow: "Subagent Supervisor pending · No pending supervisor requests.",
		expectedBuiltins: ["bash", "edit", "read", "write"],
		forbiddenProviderTools: ["subagent_supervisor", "intercom"],
		forbiddenText: '"action": "pending"',
		mode: "supervisor",
		resultText: "No pending supervisor requests.",
	},
] satisfies readonly ResumeFixture[];

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function fail(message: string): never {
	throw new Error(`Tools resume PTY verification failed: ${message}`);
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

spawn -noecho script -qefc $env(PI_STUFF_TOOLS_RESUME_PTY_RUNNER) /dev/null
must_expect "tools-resume-pty-provider.ts"
send -- "probe before resume\\r"
must_expect "RESUME_PROBE_DONE"
send -- "/fixture-resume\\r"
must_expect "Resumed session"
after 150
puts "RESUME_FIRST_FRAME_BOUNDARY"
send -- "probe after resume\\r"
must_expect "RESUME_PROBE_DONE"
send -- "\\004"
expect {
    eof {}
    timeout {
        puts stderr "Timed out waiting for Pi to exit"
        exit 4
    }
}
`;

const COLD_EXPECT_PROGRAM = `
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

spawn -noecho script -qefc $env(PI_STUFF_TOOLS_RESUME_PTY_RUNNER) /dev/null
must_expect "historical supervisor operation"
after 150
puts "COLD_FIRST_FRAME_BOUNDARY"
send -- "probe before activation\\r"
must_expect "RESUME_PROBE_DONE"
send -- "/agents\\r"
must_expect "No Agents in the current session."
send -- "\\033"
after 150
send -- "probe after activation\\r"
must_expect "RESUME_PROBE_DONE"
send -- "\\004"
expect {
    eof {}
    timeout {
        puts stderr "Timed out waiting for cold Pi to exit"
        exit 4
    }
}
`;

function verifyHostVersion(piBinary: string): void {
	const result = Bun.spawnSync([piBinary, "--version"], { stdout: "pipe", stderr: "pipe" });
	const version = result.stdout.toString().trim();
	if (result.exitCode !== 0 || version !== CERTIFIED_PI_VERSION) {
		fail(`expected Pi ${CERTIFIED_PI_VERSION}, received ${version || `exit ${String(result.exitCode)}`}`);
	}
}

function seedTargetSession(sessionDirectory: string, cwd: string, fixture: ResumeFixture): string {
	const manager = SessionManager.create(cwd, sessionDirectory, { id: `tools-resume-target-${fixture.mode}` });
	manager.appendModelChange("pi-stuff-tools-resume-pty", "fixture-model");
	const user: UserMessage = {
		role: "user",
		content: `historical ${fixture.mode} operation`,
		timestamp: Date.now(),
	};
	manager.appendMessage(user);
	if (fixture.mode !== "disabled") {
		const toolCall =
			fixture.mode === "supervisor"
				? {
						type: "toolCall" as const,
						id: "resume-supervisor-1",
						name: "subagent_supervisor",
						arguments: { action: "pending" },
					}
				: fixture.mode === "default"
					? {
							type: "toolCall" as const,
							id: "resume-read-1",
							name: "read",
							arguments: { path: "resume-target.txt" },
						}
					: {
							type: "toolCall" as const,
							id: "resume-grep-1",
							name: "grep",
							arguments: { pattern: "NEEDLE", path: "." },
						};
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [toolCall],
			api: "openai-completions",
			provider: "pi-stuff-tools-resume-pty",
			model: "fixture-model",
			usage: ZERO_USAGE,
			stopReason: "toolUse",
			timestamp: Date.now(),
		};
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			content: [{ type: "text", text: fixture.resultText ?? fixture.rawMarker ?? "" }],
			isError: false,
			timestamp: Date.now(),
		};
		manager.appendMessage(assistant);
		manager.appendMessage(result);
	}
	const path = manager.getSessionFile();
	if (!path) fail(`${fixture.mode} target session was not persisted`);
	return path;
}

function verifyRequest(record: RequestRecord | undefined, fixture: ResumeFixture): void {
	if (!record || !Array.isArray(record.tools)) fail(`${fixture.mode} did not record active tools after resume`);
	const providerTools = record.tools.filter((name): name is string => isRuntimeString(name));
	const actual = record.tools.filter((name): name is string => isRuntimeString(name) && BUILTIN_SET.has(name));
	const normalizedActual = [...actual].sort();
	const normalizedExpected = [...fixture.expectedBuiltins].sort();
	if (JSON.stringify(normalizedActual) !== JSON.stringify(normalizedExpected)) {
		fail(
			`${fixture.mode} changed active built-ins: expected ${normalizedExpected.join(", ") || "none"}; received ${normalizedActual.join(", ") || "none"}`,
		);
	}
	const leaked = fixture.forbiddenProviderTools?.filter((name) => providerTools.includes(name)) ?? [];
	if (leaked.length > 0) fail(`${fixture.mode} exposed replay-only Tools to the provider: ${leaked.join(", ")}`);
}

function verifyActiveToolOrder(
	before: RequestRecord | undefined,
	after: RequestRecord | undefined,
	mode: string,
): void {
	const beforeTools = before?.tools;
	const afterTools = after?.tools;
	if (!Array.isArray(beforeTools) || !Array.isArray(afterTools)) {
		fail(`${mode} did not record active Tool order on both sides of resume`);
	}
	if (JSON.stringify(beforeTools) !== JSON.stringify(afterTools)) {
		fail(`${mode} changed active Tool order across resume`);
	}
}

function readRequestRecords(content: string): RequestRecord[] {
	return content
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const record = JSON.parse(line);
			if (!Check(REQUEST_RECORD_SCHEMA, record)) fail("provider log contains a malformed request record");
			return record;
		});
}

async function verifySupervisorColdStart(
	options: ToolsResumePtyOptions,
	fixture: ResumeFixture,
	temporaryDirectory: string,
	configDirectory: string,
	sessionDirectory: string,
	targetDirectory: string,
	targetSession: string,
	resumedRecords: readonly RequestRecord[],
): Promise<void> {
	const requestLog = join(temporaryDirectory, "cold-requests.jsonl");
	const result = Bun.spawnSync(["expect", "-c", COLD_EXPECT_PROGRAM], {
		cwd: targetDirectory,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: configDirectory,
			PI_STUFF_TOOLS_RESUME_PTY_BIN: options.piBinary,
			PI_STUFF_TOOLS_RESUME_PTY_COLD: "1",
			PI_STUFF_TOOLS_RESUME_PTY_LOG: requestLog,
			PI_STUFF_TOOLS_RESUME_PTY_MODE: fixture.mode,
			PI_STUFF_TOOLS_RESUME_PTY_PACKAGE: resolve(options.packagePath),
			PI_STUFF_TOOLS_RESUME_PTY_PROVIDER_EXTENSION: providerExtension,
			PI_STUFF_TOOLS_RESUME_PTY_RUNNER: runner,
			PI_STUFF_TOOLS_RESUME_PTY_SESSIONS: sessionDirectory,
			PI_STUFF_TOOLS_RESUME_PTY_TARGET: targetSession,
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const output = result.stdout.toString();
	if (result.exitCode !== 0) {
		fail(`supervisor cold start failed: ${result.stderr.toString().trim()}\nPTY tail:\n${output.slice(-10_000)}`);
	}
	const boundary = output.indexOf(COLD_FIRST_FRAME_BOUNDARY);
	if (boundary < 0) fail("supervisor cold start did not capture the first frame boundary");
	const firstFrame = stripTerminalControls(output.slice(0, boundary));
	if (fixture.forbiddenText && firstFrame.includes(fixture.forbiddenText)) {
		fail("supervisor cold first frame used the generic Tool renderer");
	}
	if (fixture.compactRow && !firstFrame.includes(fixture.compactRow)) {
		fail(`supervisor cold first frame did not contain compact row: ${fixture.compactRow}`);
	}
	const records = readRequestRecords(await readFile(requestLog, "utf8"));
	if (records.length !== 2) {
		fail(`supervisor cold start expected pre- and post-activation requests; received ${String(records.length)}`);
	}
	verifyActiveToolOrder(resumedRecords[1], records[0], "supervisor cold startup");
	verifyRequest(records[0], fixture);
	if (!Array.isArray(records[1]?.tools) || !records[1].tools.includes("subagent_supervisor")) {
		fail("live subagent_supervisor did not replace the replay definition after /agents activation");
	}
}

export async function verifyToolsResumePty(options: ToolsResumePtyOptions): Promise<void> {
	verifyHostVersion(options.piBinary);
	for (const fixture of RESUME_FIXTURES) {
		const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-tools-resume-"));
		const configDirectory = join(temporaryDirectory, "config");
		const sessionDirectory = join(temporaryDirectory, "sessions");
		const sourceDirectory = join(temporaryDirectory, "source");
		const targetDirectory = join(temporaryDirectory, "target");
		const requestLog = join(temporaryDirectory, "requests.jsonl");
		await Promise.all([
			mkdir(configDirectory),
			mkdir(sessionDirectory),
			mkdir(sourceDirectory),
			mkdir(join(targetDirectory, ".pi"), { recursive: true }),
		]);
		await disableSessionNamingForTest(configDirectory);
		await Promise.all([
			writeFile(
				join(configDirectory, "settings.json"),
				`${JSON.stringify({ defaultProjectTrust: "always" }, null, "\t")}\n`,
				{ mode: 0o600 },
			),
			writeFile(join(targetDirectory, "resume-target.txt"), "NEEDLE\n", { mode: 0o600 }),
			writeFile(
				join(targetDirectory, ".pi", "settings.json"),
				`${JSON.stringify({ shellCommandPrefix: "printf 'TARGET_RESUME_PREFIX\\n';" }, null, "\t")}\n`,
				{ mode: 0o600 },
			),
		]);
		const targetSession = seedTargetSession(sessionDirectory, targetDirectory, fixture);
		try {
			const result = Bun.spawnSync(["expect", "-c", EXPECT_PROGRAM], {
				cwd: sourceDirectory,
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: configDirectory,
					PI_STUFF_TOOLS_RESUME_PTY_BIN: options.piBinary,
					PI_STUFF_TOOLS_RESUME_PTY_LOG: requestLog,
					PI_STUFF_TOOLS_RESUME_PTY_MODE: fixture.mode,
					PI_STUFF_TOOLS_RESUME_PTY_PACKAGE: resolve(options.packagePath),
					PI_STUFF_TOOLS_RESUME_PTY_PROVIDER_EXTENSION: providerExtension,
					PI_STUFF_TOOLS_RESUME_PTY_RUNNER: runner,
					PI_STUFF_TOOLS_RESUME_PTY_SESSIONS: sessionDirectory,
					PI_STUFF_TOOLS_RESUME_PTY_TARGET: targetSession,
					SHELL: "/bin/sh",
					TERM: "xterm-256color",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const output = result.stdout.toString();
			if (result.exitCode !== 0) {
				fail(
					`${fixture.mode} resume failed: ${result.stderr.toString().trim()}\nPTY tail:\n${output.slice(-10_000)}`,
				);
			}
			const boundary = output.indexOf(FIRST_FRAME_BOUNDARY);
			if (boundary < 0) fail(`${fixture.mode} did not capture the first resumed frame boundary`);
			const firstFrame = stripTerminalControls(output.slice(0, boundary));
			if (fixture.rawMarker && firstFrame.includes(fixture.rawMarker)) {
				fail(`${fixture.mode} first resumed frame exposed the raw built-in result`);
			}
			if (fixture.forbiddenText && firstFrame.includes(fixture.forbiddenText)) {
				fail(`${fixture.mode} first resumed frame used the generic Tool renderer`);
			}
			if (fixture.compactRow && !firstFrame.includes(fixture.compactRow)) {
				fail(
					`${fixture.mode} first resumed frame did not contain compact row: ${fixture.compactRow}\nFrame tail:\n${firstFrame.slice(-2_000)}`,
				);
			}
			const records = readRequestRecords(await readFile(requestLog, "utf8"));
			if (records.length !== 2)
				fail(`${fixture.mode} expected pre- and post-resume requests; received ${String(records.length)}`);
			verifyActiveToolOrder(records[0], records[1], fixture.mode);
			verifyRequest(records[1], fixture);

			if (fixture.mode === "supervisor") {
				await verifySupervisorColdStart(
					options,
					fixture,
					temporaryDirectory,
					configDirectory,
					sessionDirectory,
					targetDirectory,
					targetSession,
					records,
				);
			}
		} finally {
			await rm(temporaryDirectory, { force: true, recursive: true });
		}
	}
}

if (import.meta.main) {
	const PI_BIN = resolvePiBinary();
	await verifyToolsResumePty({ piBinary: PI_BIN, packagePath: join(root, "packages/pi-stuff") });
	console.log("Certified compact Tool rows across in-process /resume and cold --session startup");
}
