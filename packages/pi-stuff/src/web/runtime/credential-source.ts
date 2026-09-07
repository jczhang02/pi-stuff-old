import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import type { JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const COMMAND_TIMEOUT_MS = 5_000;
const ONE_PASSWORD_TIMEOUT_MS = 60_000;
const MAX_CREDENTIAL_BYTES = 16_384;
const ENV_SOURCE = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/;
const OP_SESSION_NAME = /^OP_SESSION_[A-Za-z0-9_]+$/;
const COMMAND_ENVIRONMENT_NAMES = [
	"HOME",
	"USER",
	"LOGNAME",
	"PATH",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"TMPDIR",
	"XDG_CONFIG_HOME",
	"XDG_RUNTIME_DIR",
	"DBUS_SESSION_BUS_ADDRESS",
	"SSH_AUTH_SOCK",
	"WSL_DISTRO_NAME",
	"WSL_INTEROP",
] as const;

export type CredentialFailureCategory =
	| "invalid-source"
	| "command-failed"
	| "command-timeout"
	| "command-aborted"
	| "command-empty"
	| "command-invalid-output"
	| "command-output-too-large"
	| "environment-empty";

export class CredentialResolutionError extends Error {
	readonly provider: string;
	readonly category: CredentialFailureCategory;

	constructor(provider: string, category: CredentialFailureCategory) {
		const suffix = category === "command-aborted" ? "aborted" : category;
		super(`${provider} credential resolution failed: ${suffix}`);
		this.name = "CredentialResolutionError";
		this.provider = provider;
		this.category = category;
	}
}

export interface CredentialCommandResult {
	stdout: string | Buffer;
}

export interface CredentialCommandOptions {
	signal?: AbortSignal;
	timeoutMs: number;
	maxOutputBytes: number;
	environment: Record<string, string>;
}

export type CredentialCommandRunner = (
	command: string,
	options: CredentialCommandOptions,
) => Promise<CredentialCommandResult>;

export type CredentialProgramRunner = (
	program: string,
	args: readonly string[],
	options: CredentialCommandOptions,
) => Promise<CredentialCommandResult>;

export interface CredentialOptions {
	provider: string;
	configuredValue?: JsonInputValue;
	environmentValue?: JsonInputValue;
	environment?: Record<string, string | undefined>;
	signal?: AbortSignal | undefined;
	runCommand?: CredentialCommandRunner;
	runProgram?: CredentialProgramRunner;
}

export function redactCredential(text: string, credential: string | null | undefined): string {
	return credential ? text.split(credential).join("[redacted]") : text;
}

function normalize(value: JsonInputValue): string | null {
	if (!isRuntimeString(value)) return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function commandEnvironment(source: Record<string, string | undefined>) {
	const environment: Record<string, string> = {};
	for (const name of COMMAND_ENVIRONMENT_NAMES) {
		const value = source[name];
		if (value !== undefined) environment[name] = value;
	}
	for (const [name, value] of Object.entries(source)) {
		if (value !== undefined && OP_SESSION_NAME.test(name)) environment[name] = value;
	}
	return environment;
}

function configuredSource(options: CredentialOptions): string | null {
	return normalize(options.configuredValue);
}

function explicitEnvironmentName(source: string): string | null {
	const match = source.match(ENV_SOURCE);
	return match ? (match[1] ?? match[2] ?? null) : null;
}

function escapedSource(source: string): string | null {
	if (source.startsWith("$$") || source.startsWith("$!")) return source.slice(1);
	return null;
}

function isMalformedExplicitSource(source: string): boolean {
	return source.startsWith("$") && escapedSource(source) === null && explicitEnvironmentName(source) === null;
}

async function defaultRunCommand(command: string, options: CredentialCommandOptions): Promise<CredentialCommandResult> {
	const result = await execAsync(command, {
		encoding: "utf8",
		env: options.environment,
		maxBuffer: options.maxOutputBytes + 1,
		signal: options.signal,
		timeout: options.timeoutMs,
		windowsHide: true,
	});
	return { stdout: result.stdout ?? "" };
}

async function defaultRunProgram(
	program: string,
	args: readonly string[],
	options: CredentialCommandOptions,
): Promise<CredentialCommandResult> {
	const result = await execFileAsync(program, [...args], {
		encoding: "utf8",
		env: options.environment,
		maxBuffer: options.maxOutputBytes + 1,
		signal: options.signal,
		timeout: options.timeoutMs,
		windowsHide: true,
	});
	return { stdout: result.stdout };
}

function onePasswordOutput(provider: string, output: string | Buffer): string {
	const stdout = Buffer.isBuffer(output) ? output.toString("utf8") : output;
	if (Buffer.byteLength(stdout, "utf8") > MAX_CREDENTIAL_BYTES) {
		throw new CredentialResolutionError(provider, "command-output-too-large");
	}
	const value = stdout.trim();
	if (!value) throw new CredentialResolutionError(provider, "command-empty");
	if (hasControlCharacter(value)) {
		throw new CredentialResolutionError(provider, "command-invalid-output");
	}
	return value;
}

function hasControlCharacter(value: string): boolean {
	return Array.from(value).some((character) => {
		const code = character.charCodeAt(0);
		return code < 32 || code === 127;
	});
}

function commandFailureCategory(error: Error, signal?: AbortSignal): CredentialFailureCategory {
	if (signal?.aborted) return "command-aborted";
	const code = "code" in error && isRuntimeString(error.code) ? error.code : undefined;
	if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "command-output-too-large";
	if (("killed" in error && error.killed === true) || code === "ETIMEDOUT") return "command-timeout";
	return "command-failed";
}

export function hasCredentialSource(options: CredentialOptions): boolean {
	const source = configuredSource(options);
	if (source?.startsWith("!")) return true;
	if (source?.startsWith("$")) return true;
	return normalize(options.environmentValue) !== null || source !== null;
}

export async function resolveCredential(options: CredentialOptions): Promise<string | null> {
	const source = configuredSource(options);
	const escaped = source ? escapedSource(source) : null;
	if (escaped !== null) return escaped;
	if (source?.startsWith("op://")) {
		let result: CredentialCommandResult;
		try {
			const commandOptions: CredentialCommandOptions = {
				timeoutMs: ONE_PASSWORD_TIMEOUT_MS,
				maxOutputBytes: MAX_CREDENTIAL_BYTES,
				environment: commandEnvironment(options.environment ?? process.env),
			};
			if (options.signal) commandOptions.signal = options.signal;
			result = await (options.runProgram ?? defaultRunProgram)(
				"op",
				["read", "--no-newline", source],
				commandOptions,
			);
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			throw new CredentialResolutionError(options.provider, commandFailureCategory(cause, options.signal));
		}
		return onePasswordOutput(options.provider, result.stdout);
	}
	if (source?.startsWith("!")) {
		const command = source.slice(1).trim();
		if (!command) throw new CredentialResolutionError(options.provider, "invalid-source");
		let result: CredentialCommandResult;
		try {
			const commandOptions: CredentialCommandOptions = {
				timeoutMs: COMMAND_TIMEOUT_MS,
				maxOutputBytes: MAX_CREDENTIAL_BYTES,
				environment: commandEnvironment(options.environment ?? process.env),
			};
			if (options.signal) commandOptions.signal = options.signal;
			result = await (options.runCommand ?? defaultRunCommand)(command, commandOptions);
		} catch (error) {
			const cause = error instanceof Error ? error : new Error(String(error));
			throw new CredentialResolutionError(options.provider, commandFailureCategory(cause, options.signal));
		}
		const stdout = Buffer.isBuffer(result.stdout) ? result.stdout.toString("utf8") : result.stdout;
		if (Buffer.byteLength(stdout, "utf8") > MAX_CREDENTIAL_BYTES) {
			throw new CredentialResolutionError(options.provider, "command-output-too-large");
		}
		const value = stdout.trim();
		if (!value) throw new CredentialResolutionError(options.provider, "command-empty");
		if (hasControlCharacter(value)) {
			throw new CredentialResolutionError(options.provider, "command-invalid-output");
		}
		return value;
	}
	if (source && isMalformedExplicitSource(source)) {
		throw new CredentialResolutionError(options.provider, "invalid-source");
	}
	if (source?.startsWith("$")) {
		const name = explicitEnvironmentName(source);
		if (!name) throw new CredentialResolutionError(options.provider, "invalid-source");
		const value = normalize((options.environment ?? process.env)[name]);
		if (!value) throw new CredentialResolutionError(options.provider, "environment-empty");
		return value;
	}
	return normalize(options.environmentValue) ?? source;
}

export async function requireCredential(options: CredentialOptions, missingMessage: string): Promise<string> {
	const credential = await resolveCredential(options);
	if (!credential) throw new Error(missingMessage);
	return credential;
}
