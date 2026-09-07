import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { isRuntimeObject } from "../packages/pi-stuff/src/shared/runtime-type.js";
import { resolvePiBinary } from "./installed-tools.ts";
import { stripTerminalControls } from "./terminal-controls.js";

const root = resolve(import.meta.dir, "..");
const providerExtension = join(root, "tests/fixtures/mcp-pty-provider.ts");
const runner = join(root, "tests/fixtures/mcp-pty-runner.sh");
const server = join(root, "tests/fixtures/mcp/stdio-server.mjs");
const httpServer = join(root, "tests/fixtures/mcp/http-server.mjs");
const DEFAULT_COLUMNS = 64;
const NARROW_COLUMNS = 48;
const DEFAULT_ROWS = 28;
const LOW_ROWS = 12;
const SETUP_THEMES = [
	{ accent: "\u001b[38;2;136;57;239m", name: "catppuccin-latte" },
	{ accent: "\u001b[38;2;203;166;247m", name: "catppuccin-mocha" },
] as const;
const RESUME_FIRST_FRAME_BOUNDARY = "MCP_RESUME_FIRST_FRAME_BOUNDARY";
const RESUME_RAW_MARKER = "RAW_MCP_RESUME_RESULT_MARKER";
const SETUP_FRAME_START = "MCP_SETUP_FRAME_START";
const SETUP_FRAME_END = "MCP_SETUP_FRAME_END";
const ERRNO_SCHEMA = Type.Object({ code: Type.Optional(Type.String()) }, { additionalProperties: true });
const MCP_CONFIG_SCHEMA = Type.Object(
	{
		mcpServers: Type.Optional(
			Type.Record(
				Type.String(),
				Type.Object(
					{ lifecycle: Type.Optional(Type.String()), url: Type.Optional(Type.String()) },
					{ additionalProperties: true },
				),
			),
		),
	},
	{ additionalProperties: true },
);
const HTTP_LOG_SCHEMA = Type.Object({ method: Type.Optional(Type.String()) }, { additionalProperties: true });

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface McpPtyVerificationOptions {
	readonly piBinary: string;
	readonly packagePath: string;
	readonly columns?: number;
	readonly rows?: number;
}

function fail(message: string): never {
	throw new Error(`MCP PTY verification failed: ${message}`);
}

function seedResumeTarget(sessionDirectory: string, cwd: string): string {
	const manager = SessionManager.create(cwd, sessionDirectory, { id: "mcp-resume-target" });
	manager.appendModelChange("pi-stuff-mcp-pty", "fixture-model");
	const user: UserMessage = {
		role: "user",
		content: "historical MCP operation",
		timestamp: Date.now(),
	};
	const toolCall = {
		type: "toolCall" as const,
		id: "mcp-resume-call-1",
		name: "mcp",
		arguments: { args: { text: "historical" }, server: "local", tool: "local_resume_echo" },
	};
	const assistant: AssistantMessage = {
		role: "assistant",
		content: [toolCall],
		api: "openai-completions",
		provider: "pi-stuff-mcp-pty",
		model: "fixture-model",
		usage: ZERO_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	const result: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: RESUME_RAW_MARKER }],
		details: { mode: "call", server: "local", tool: "echo" },
		isError: false,
		timestamp: Date.now(),
	};
	manager.appendMessage(user);
	manager.appendMessage(assistant);
	manager.appendMessage(result);
	const sessionFile = manager.getSessionFile();
	if (!sessionFile) fail("resume target session was not persisted");
	return sessionFile;
}

const EXPECT_PROGRAM = `
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

proc wait_for_marker {} {
    global env
    for {set index 0} {$index < 100} {incr index} {
        if {[file exists $env(PI_STUFF_MCP_PTY_MARKER)]} { return }
        after 50
    }
    puts stderr "MCP stdio fixture was not started"
    exit 5
}

spawn -noecho script -qefc $env(PI_STUFF_MCP_PTY_RUNNER) /dev/null
set mcp_pty $spawn_out(slave,name)
must_expect "Welcome back!"
after 150
if {[file exists $env(PI_STUFF_MCP_PTY_MARKER)]} {
    puts stderr "MCP stdio fixture started during Pi startup"
    exit 6
}
send -- "/mcp\\r"
must_expect "MCP"
must_expect "0/3 connected"
must_expect "broken"
must_expect "local"
must_expect "remote"
must_expect "Esc close"
if {[file exists $env(PI_STUFF_MCP_PTY_MARKER)]} {
    puts stderr "Opening /mcp connected a server"
    exit 7
}
if {[file size $env(PI_STUFF_MCP_PTY_HTTP_LOG)] != 0} {
    puts stderr "Opening /mcp contacted the HTTP server"
    exit 8
}
send -- " "
after 100
if {[file exists $env(PI_STUFF_MCP_PTY_MARKER)]} {
    puts stderr "Space connected a server"
    exit 9
}
if {[file size $env(PI_STUFF_MCP_PTY_HTTP_LOG)] != 0} {
    puts stderr "Space contacted the HTTP server"
    exit 10
}
send -- "\\r"
must_expect "MCP / broken"
send -- "\\033\\[B"
send -- "\\033\\[B"
send -- "\\r"
must_expect "Disable broken?"
must_expect "Cancel"
if {[file exists $env(PI_STUFF_MCP_PTY_OVERRIDE)]} {
    puts stderr "Opening disable confirmation wrote an override"
    exit 16
}
send -- "\\r"
after 100
if {[file exists $env(PI_STUFF_MCP_PTY_OVERRIDE)]} {
    puts stderr "Default Cancel wrote a disable override"
    exit 17
}
send -- "\\r"
must_expect "Disable broken?"
send -- "\\033\\[B"
send -- "\\r"
must_expect "Disabled server"
must_expect "Reloading keybindings"
must_expect "Reloaded keybindings"
send -- "/mcp\\r"
must_expect "0/2 connected"
must_expect "broken"
must_expect "disabled"
send -- "\\r"
must_expect "MCP / broken"
must_expect "Enable"
send -- "\\r"
must_expect "Enable broken?"
send -- "\\033\\[B"
send -- "\\r"
must_expect "Enabled server"
must_expect "Reloading keybindings"
must_expect "Reloaded keybindings"
send -- "/mcp\\r"
must_expect "0/3 connected"
send -- "\\033\\[B"
send -- "\\r"
must_expect "MCP / local"
must_expect "Reconnect"
must_expect "Connect automatically"
must_expect "Disable"
send -- "\\033\\[B"
send -- "\\r"
must_expect "Connect local automatically?"
must_expect "Cancel"
send -- "\\033\\[B"
send -- "\\r"
must_expect "Automatic connection saved"
must_expect "Reloading keybindings"
must_expect "Reloaded keybindings"
send -- "/mcp\\r"
must_expect "0/3 connected"
send -- "\\033\\[B"
send -- "\\r"
must_expect "MCP / local"
must_expect "Connection  automatic"
must_expect "Connect on demand"
send -- "\\r"
wait_for_marker
must_expect "MCP: Reconnected to local"
after 100
send -- "\\033"
must_expect "1/3 connected"
must_expect "local"
must_expect "1 tool"
must_expect "Esc close"
send -- "\\033"
after 100
send -- "/mcp\\r"
must_expect "1/3 connected"
send -- "\\r"
must_expect "MCP / broken"
send -- "\\r"
must_expect "MCP: Failed to reconnect to broken"
must_expect "State  failed"
must_expect "Error"
after 100
send -- "\\033"
must_expect "1/3 connected"
must_expect "failed"
must_expect "Esc close"
send -- "\\033"
after 100
send -- "/mcp\\r"
must_expect "1/3 connected"
send -- "\\033\\[B"
send -- "\\033\\[B"
send -- "\\r"
must_expect "MCP / remote"
send -- "\\r"
must_expect "MCP: Reconnected to remote"
after 100
send -- "\\033"
must_expect "2/3 connected"
must_expect "remote"
must_expect "1 tool"
must_expect "Esc close"
send -- "\\033"
after 100
send -- "/mcp\\r"
must_expect "2/3 connected"
send -- "\\033\\[B"
send -- "\\033\\[B"
send -- "\\r"
must_expect "MCP / remote"
must_expect "Authenticate"
must_expect "Log out"
send -- "\\033"
must_expect "2/3 connected"
send -- "\\033"
stty rows $env(PI_STUFF_MCP_PTY_ROWS) columns $env(PI_STUFF_MCP_PTY_NARROW_COLUMNS) < $mcp_pty
after 200
send -- "/mcp\\r"
must_expect "2/3 connected"
must_expect "Esc close"
send -- "\\033"
after 100
send -- "DRAFT_AFTER_MCP"
must_expect "DRAFT_AFTER_MCP"
send -- "\\003"
after 200
send -- "invoke local MCP\\r"
must_expect "MCP_TOOL_CALL_"
send -- "/fixture-resume\\r"
must_expect "Resumed session"
after 150
puts "MCP_RESUME_FIRST_FRAME_BOUNDARY"
send -- "probe after resume\\r"
must_expect "MCP_RESUME_PROBE_DONE"
send -- "/mcp reconnect remote\\r"
must_expect "MCP: Reconnected to remote"
send -- "\\004"
expect {
    eof {}
    timeout {
        puts stderr "Timed out waiting for Pi to exit"
        exit 4
    }
}
`;

const NOOB_EXPECT_PROGRAM = `
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

spawn -noecho script -qefc $env(PI_STUFF_MCP_PTY_RUNNER) /dev/null
set mcp_pty $spawn_out(slave,name)
must_expect "Welcome back!"
after 150
if {[file exists $env(PI_STUFF_MCP_PTY_FRESH_CONFIG)]} {
    puts stderr "Fresh project already had MCP config"
    exit 11
}
send -- "/mcp\\r"
must_expect "0/0 connected"
must_expect "No MCP servers configured."
must_expect "Press Enter to set up your first server."
send -- " "
after 100
if {[file exists $env(PI_STUFF_MCP_PTY_FRESH_CONFIG)]} {
    puts stderr "Space wrote MCP config"
    exit 12
}
puts "${SETUP_FRAME_START}"
send -- "\\r"
must_expect "MCP setup"
must_expect "Setup"
must_expect "View example"
must_expect "Scaffold project"
must_expect "Preview"
must_expect "Esc close"
set setup_probe_columns [expr {$env(PI_STUFF_MCP_PTY_COLUMNS) - 1}]
stty rows $env(PI_STUFF_MCP_PTY_ROWS) columns $setup_probe_columns < $mcp_pty
after 150
stty rows $env(PI_STUFF_MCP_PTY_ROWS) columns $env(PI_STUFF_MCP_PTY_COLUMNS) < $mcp_pty
after 200
must_expect "MCP setup"
stty rows $env(PI_STUFF_MCP_PTY_ROWS) columns $env(PI_STUFF_MCP_PTY_NARROW_COLUMNS) < $mcp_pty
after 200
must_expect "Setup"
must_expect "Esc close"
stty rows $env(PI_STUFF_MCP_PTY_LOW_ROWS) columns $env(PI_STUFF_MCP_PTY_NARROW_COLUMNS) < $mcp_pty
after 200
must_expect "MCP setup"
must_expect "View example"
must_expect "Esc close"
stty rows $env(PI_STUFF_MCP_PTY_ROWS) columns $env(PI_STUFF_MCP_PTY_NARROW_COLUMNS) < $mcp_pty
after 200
send -- "\\033\\[B"
send -- "\\033\\[B"
send -- "\\033\\[B"
send -- "\\033\\[B"
send -- "\\r"
must_expect "Confirm change"
must_expect "Add Context7 to the MCP config?"
must_expect "Preview"
must_expect "Cancel"
if {[file exists $env(PI_STUFF_MCP_PTY_FRESH_CONFIG)]} {
    puts stderr "Opening write confirmation wrote MCP config"
    exit 13
}
send -- "\\r"
after 100
if {[file exists $env(PI_STUFF_MCP_PTY_FRESH_CONFIG)]} {
    puts stderr "Default Cancel wrote MCP config"
    exit 14
}
send -- "\\r"
must_expect "Add Context7 to the MCP config?"
send -- "\\033\\[B"
send -- "\\r"
must_expect "Added Context7 to"
for {set index 0} {$index < 100} {incr index} {
    if {[file exists $env(PI_STUFF_MCP_PTY_FRESH_CONFIG)]} { break }
    after 50
}
if {![file exists $env(PI_STUFF_MCP_PTY_FRESH_CONFIG)]} {
    puts stderr "Confirmed setup did not write MCP config"
    exit 15
}
puts "${SETUP_FRAME_END}"
send -- "\\033"
after 1000
send -- "/mcp\\r"
must_expect "0/1 connected"
must_expect "context7"
must_expect "not connected"
send -- "\\033"
after 100
send -- "\\004"
expect {
    eof {}
    timeout {
        puts stderr "Timed out waiting for fresh Pi session to exit"
        exit 4
    }
}
`;

function outputBetweenMarkers(output: string, start: string, end: string): string {
	const startIndex = output.indexOf(start);
	const endIndex = output.indexOf(end, startIndex + start.length);
	if (startIndex < 0 || endIndex < 0) fail(`terminal output is missing ${startIndex < 0 ? start : end}`);
	return output.slice(startIndex + start.length, endIndex);
}

async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		try {
			await access(path);
			return;
		} catch {
			await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
		}
	}
	fail(`timed out waiting for fixture file ${path}`);
}

async function processExists(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return Check(ERRNO_SCHEMA, error) && error.code === "EPERM";
	}
}

function runExpect(program: string, cwd: string, env: Record<string, string | undefined>): string {
	const result = Bun.spawnSync(["expect", "-c", program], {
		cwd,
		env,
		stderr: "pipe",
		stdout: "pipe",
	});
	const output = `${result.stdout.toString()}\n${result.stderr.toString()}`;
	if (result.exitCode !== 0) fail(output.trim() || `expect exited ${String(result.exitCode)}`);
	return output;
}

async function verifyNoobSetup(
	temporaryDirectory: string,
	commonEnv: NodeJS.ProcessEnv,
	columns: number,
): Promise<void> {
	const cases = SETUP_THEMES.map((theme) => ({
		...theme,
		config: join(temporaryDirectory, `noob-${theme.name}-agent`),
		home: join(temporaryDirectory, `noob-${theme.name}-home`),
		project: join(temporaryDirectory, `noob-${theme.name}`),
		sessions: join(temporaryDirectory, `noob-${theme.name}-sessions`),
		xdgCache: join(temporaryDirectory, `noob-${theme.name}-xdg-cache`),
		xdgConfig: join(temporaryDirectory, `noob-${theme.name}-xdg-config`),
		xdgState: join(temporaryDirectory, `noob-${theme.name}-xdg-state`),
	}));
	await Promise.all(
		cases.flatMap((noobCase) => [
			mkdir(noobCase.config),
			mkdir(noobCase.home),
			mkdir(noobCase.xdgCache),
			mkdir(noobCase.xdgConfig),
			mkdir(noobCase.xdgState),
			mkdir(noobCase.project),
			mkdir(noobCase.sessions),
		]),
	);
	for (const noobCase of cases) {
		await writeFile(
			join(noobCase.config, "settings.json"),
			`${JSON.stringify({ defaultProjectTrust: "always", enableInstallTelemetry: false, quietStartup: true, theme: noobCase.name }, null, "\t")}\n`,
		);
		const freshConfig = join(noobCase.project, ".mcp.json");
		const noobOutput = runExpect(NOOB_EXPECT_PROGRAM, noobCase.project, {
			...commonEnv,
			HOME: noobCase.home,
			PI_CODING_AGENT_DIR: noobCase.config,
			PI_STUFF_MCP_PTY_FRESH_CONFIG: freshConfig,
			PI_STUFF_MCP_PTY_RESUME_TARGET: join(noobCase.sessions, "unused.jsonl"),
			PI_STUFF_MCP_PTY_SESSIONS: noobCase.sessions,
			PI_STUFF_MCP_PTY_SESSION_ID: `mcp-noob-${noobCase.name}`,
			XDG_CACHE_HOME: noobCase.xdgCache,
			XDG_CONFIG_HOME: noobCase.xdgConfig,
			XDG_STATE_HOME: noobCase.xdgState,
		});
		const setupOutput = outputBetweenMarkers(noobOutput, SETUP_FRAME_START, SETUP_FRAME_END);
		const visible = stripTerminalControls(setupOutput);
		if (!setupOutput.includes(noobCase.accent)) {
			fail(`MCP setup did not render the ${noobCase.name} semantic accent`);
		}
		if (!visible.includes("Write and reload")) fail("fresh-state flow never exposed the confirmed write action");
		for (const width of [columns, NARROW_COLUMNS]) {
			if (!visible.includes("━".repeat(width))) {
				fail(`MCP setup did not render a ${String(width)}-column divider`);
			}
		}
		const freshDocument = JSON.parse(await readFile(freshConfig, "utf8"));
		if (
			!Check(MCP_CONFIG_SCHEMA, freshDocument) ||
			!freshDocument.mcpServers ||
			!isRuntimeObject(freshDocument.mcpServers) ||
			Array.isArray(freshDocument.mcpServers)
		) {
			fail("fresh-state setup did not write a valid MCP server map");
		}
		if (freshDocument.mcpServers["context7"]?.url !== "https://mcp.context7.com/mcp") {
			fail("fresh-state setup did not persist the selected Context7 server");
		}
	}
}

async function verifyMcpEvidence(
	output: string,
	columns: number,
	override: string,
	marker: string,
	httpLog: string,
): Promise<void> {
	const visible = stripTerminalControls(output);
	for (const required of [
		"2/3 connected",
		"local",
		"remote",
		"2 tools",
		"DRAFT_AFTER_MCP",
		"MCP_TOOL_CALL_DONE",
		"MCP local:local_echo · done",
		"MCP_RESUME_PROBE_DONE",
	]) {
		if (!visible.includes(required)) {
			const toolFailure = /MCP_TOOL_CALL_BAD_RESULT[^\n]*/u.exec(visible)?.[0];
			fail(`terminal output is missing ${required}${toolFailure ? `: ${toolFailure}` : ""}`);
		}
	}
	const resumeBoundary = output.indexOf(RESUME_FIRST_FRAME_BOUNDARY);
	if (resumeBoundary < 0) fail("did not capture the first resumed MCP frame boundary");
	const firstResumeFrame = stripTerminalControls(output.slice(0, resumeBoundary));
	if (!firstResumeFrame.includes("MCP local:local_resume_echo · done")) {
		fail("first resumed frame did not contain the standalone MCP Tool row");
	}
	if (firstResumeFrame.includes(RESUME_RAW_MARKER)) {
		fail("first resumed frame exposed the raw historical MCP Tool result");
	}
	for (const width of [columns, NARROW_COLUMNS]) {
		if (!visible.includes("━".repeat(width))) fail(`Command Dialog did not render a ${String(width)}-column divider`);
	}
	if (/mcp:\d+/u.test(visible)) fail("terminal output exposed a Capability-specific MCP Statusline segment");
	if (visible.includes("MCP_SECRET_SHOULD_NOT_APPEAR")) fail("terminal output exposed an MCP configuration secret");
	const overrideDocument = JSON.parse(await readFile(override, "utf8"));
	if (!Check(MCP_CONFIG_SCHEMA, overrideDocument)) fail("project MCP override is malformed");
	if (overrideDocument.mcpServers && Object.hasOwn(overrideDocument.mcpServers, "broken")) {
		fail("re-enabling the server left a stale disabled override");
	}
	if (overrideDocument.mcpServers?.["local"]?.lifecycle !== "keep-alive") {
		fail("automatic connection choice was not persisted in the project MCP override");
	}

	await access(marker);
	const markerLines = (await readFile(marker, "utf8")).trim().split("\n");
	const pid = Number(markerLines[0]);
	if (!Number.isSafeInteger(pid) || pid <= 0) fail("stdio fixture did not record a valid process id");
	if (await processExists(pid)) fail(`stdio fixture process ${String(pid)} survived Pi shutdown`);
	if (!markerLines.some((line) => line.startsWith("exit:"))) fail("stdio fixture did not observe graceful shutdown");
	if (!markerLines.includes("call:MCP_STDIO_ECHO_OK")) fail("stdio fixture did not receive the real MCP Tool call");
	const httpMethods = (await readFile(httpLog, "utf8"))
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const record = JSON.parse(line);
			if (!Check(HTTP_LOG_SCHEMA, record)) fail("HTTP fixture log contains a malformed record");
			return record.method;
		});
	if (!httpMethods.includes("initialize") || !httpMethods.includes("tools/list")) {
		fail("Streamable HTTP fixture did not complete initialize and Tool discovery");
	}
	if (!httpMethods.includes("HTTP DELETE")) {
		fail(`Streamable HTTP fixture did not observe graceful session termination: ${JSON.stringify(httpMethods)}`);
	}
}

export async function verifyMcpPty(options: McpPtyVerificationOptions): Promise<void> {
	const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-pty-"));
	const config = join(temporaryDirectory, "agent");
	const home = join(temporaryDirectory, "home");
	const xdgCache = join(temporaryDirectory, "xdg-cache");
	const xdgConfig = join(temporaryDirectory, "xdg-config");
	const xdgState = join(temporaryDirectory, "xdg-state");
	const project = join(temporaryDirectory, "project");
	const sessions = join(temporaryDirectory, "sessions");
	const marker = join(temporaryDirectory, "stdio-marker.txt");
	const override = join(project, ".pi/mcp.json");
	const httpEndpoint = join(temporaryDirectory, "http-endpoint.txt");
	const httpLog = join(temporaryDirectory, "http-requests.jsonl");
	const columns = options.columns ?? DEFAULT_COLUMNS;
	const rows = options.rows ?? DEFAULT_ROWS;
	await Promise.all([
		mkdir(config),
		mkdir(home),
		mkdir(xdgCache),
		mkdir(xdgConfig),
		mkdir(xdgState),
		mkdir(project),
		mkdir(sessions),
	]);
	let httpChild: ReturnType<typeof Bun.spawn> | undefined;

	try {
		await writeFile(httpLog, "");
		httpChild = Bun.spawn([process.execPath, httpServer], {
			env: {
				...process.env,
				PI_STUFF_MCP_HTTP_ENDPOINT: httpEndpoint,
				PI_STUFF_MCP_HTTP_LOG: httpLog,
			},
			stderr: "pipe",
			stdout: "ignore",
		});
		await waitForFile(httpEndpoint);
		const httpUrl = (await readFile(httpEndpoint, "utf8")).trim();
		const commonEnv = {
			...process.env,
			COLORTERM: "truecolor",
			HOME: home,
			PI_CODING_AGENT_DIR: config,
			PI_OFFLINE: "1",
			PI_STUFF_MCP_PTY_BIN: options.piBinary,
			PI_STUFF_MCP_PTY_COLUMNS: String(columns),
			PI_STUFF_MCP_PTY_LOW_ROWS: String(LOW_ROWS),
			PI_STUFF_MCP_PTY_NARROW_COLUMNS: String(NARROW_COLUMNS),
			PI_STUFF_MCP_PTY_PACKAGE: resolve(options.packagePath),
			PI_STUFF_MCP_PTY_PROVIDER_EXTENSION: providerExtension,
			PI_STUFF_MCP_PTY_ROWS: String(rows),
			PI_STUFF_MCP_PTY_RUNNER: runner,
			PI_TELEMETRY: "0",
			SHELL: "/bin/sh",
			TERM: "xterm-256color",
			XDG_CACHE_HOME: xdgCache,
			XDG_CONFIG_HOME: xdgConfig,
			XDG_STATE_HOME: xdgState,
		};
		await verifyNoobSetup(temporaryDirectory, commonEnv, columns);
		await writeFile(
			join(config, "settings.json"),
			`${JSON.stringify({ defaultProjectTrust: "always", enableInstallTelemetry: false, quietStartup: true, theme: "catppuccin-mocha" }, null, "\t")}\n`,
		);

		await writeFile(
			join(project, ".mcp.json"),
			`${JSON.stringify(
				{
					mcpServers: {
						broken: {
							command: join(temporaryDirectory, "missing-mcp-server"),
							env: { MCP_SECRET: "MCP_SECRET_SHOULD_NOT_APPEAR" },
						},
						local: {
							args: [server],
							command: process.execPath,
							env: {
								MCP_SECRET: "MCP_SECRET_SHOULD_NOT_APPEAR",
								PI_STUFF_MCP_MARKER: marker,
							},
						},
						remote: { url: httpUrl },
					},
				},
				null,
				"\t",
			)}\n`,
		);
		const resumeTarget = seedResumeTarget(sessions, project);
		const output = runExpect(EXPECT_PROGRAM, project, {
			...commonEnv,
			PI_STUFF_MCP_PTY_MARKER: marker,
			PI_STUFF_MCP_PTY_HTTP_LOG: httpLog,
			PI_STUFF_MCP_PTY_OVERRIDE: override,
			PI_STUFF_MCP_PTY_RESUME_TARGET: resumeTarget,
			PI_STUFF_MCP_PTY_SESSIONS: sessions,
			PI_STUFF_MCP_PTY_SESSION_ID: "mcp-source-session",
		});

		await verifyMcpEvidence(output, columns, override, marker, httpLog);
	} finally {
		if (httpChild) {
			httpChild.kill("SIGTERM");
			await httpChild.exited;
		}
		await rm(temporaryDirectory, { force: true, recursive: true });
	}
}

if (import.meta.main) {
	const PI_BIN = resolvePiBinary();
	await verifyMcpPty({ packagePath: join(root, "packages/pi-stuff"), piBinary: PI_BIN });
	console.log(
		"Certified light/dark responsive setup at wide, narrow, and low sizes; reload/re-read, persisted connection policy, OAuth detail actions, MCP lifecycle, Tool call/resume rendering, and Command Dialog in real Pi TUI",
	);
}
