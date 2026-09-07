import { exec } from "node:child_process";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isJsonInputObject, type JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeFunction, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import { sanitizeTerminalText as sanitizeUntrustedTerminalText } from "../../shared/terminal-text.ts";
import type { McpConfig, ServerEntry } from "./types.ts";

const execAsync = promisify(exec);

async function execOpen(pi: ExtensionAPI, target: string, browser?: string, signal?: AbortSignal) {
	const os = platform();
	const options = signal === undefined ? {} : { signal };

	if (os === "darwin") {
		return browser ? pi.exec("open", ["-a", browser, target], options) : pi.exec("open", [target], options);
	}
	if (os === "win32") {
		return browser
			? pi.exec("cmd", ["/c", "start", "", browser, target], options)
			: pi.exec("cmd", ["/c", "start", "", target], options);
	}
	return browser ? pi.exec(browser, [target], options) : pi.exec("xdg-open", [target], options);
}

export async function openUrl(pi: ExtensionAPI, url: string, browser?: string, signal?: AbortSignal): Promise<void> {
	const result = await execOpen(pi, url, browser, signal);
	if (result.code !== 0) {
		throw new Error(result.stderr || `Failed to open browser (exit code ${result.code})`);
	}
}

export async function openPath(pi: ExtensionAPI, targetPath: string): Promise<void> {
	const result = await execOpen(pi, targetPath);
	if (result.code !== 0) {
		throw new Error(result.stderr || `Failed to open path (exit code ${result.code})`);
	}
}

export function getConfigPathFromArgv(): string | undefined {
	const idx = process.argv.indexOf("--mcp-config");
	if (idx >= 0 && idx + 1 < process.argv.length) {
		return process.argv[idx + 1];
	}
	return undefined;
}

export function interpolateEnvVars(value: string): string {
	return value
		.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_, name) => process.env[name] ?? "")
		.replace(/\{env:(\w+)\}/g, (_, name) => process.env[name] ?? "");
}

function getMissingEnvVars(value: string): string[] {
	const missing = new Set<string>();
	for (const match of value.matchAll(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g)) {
		const name = match[1] ?? match[2] ?? match[3];
		if (name && process.env[name] === undefined) {
			missing.add(name);
		}
	}
	return [...missing];
}

export function toStringRecord(value: JsonInputValue): Record<string, string> | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;

	const result: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (isRuntimeString(entry)) result[key] = entry;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function interpolateSecretExpression(value: string): string {
	if (value.startsWith("!!")) return interpolateEnvVars(value.slice(1));
	return value.startsWith("!") ? value : interpolateEnvVars(value);
}

export function interpolateEnvRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!values) return undefined;

	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolateSecretExpression(value)]));
}

const COMMAND_SECRET_TIMEOUT_MS = 10_000;
const COMMAND_SECRET_MAX_OUTPUT_BYTES = 1024 * 1024;

/** Resolve a secret value, executing only a single leading `!` command marker. */
export function resolveCommandSecret(value: string, context: string, signal?: AbortSignal): Promise<string>;
export function resolveCommandSecret(value: undefined, context: string, signal?: AbortSignal): Promise<undefined>;
export async function resolveCommandSecret(
	value: string | undefined,
	context: string,
	signal?: AbortSignal,
): Promise<string | undefined> {
	if (value === undefined) return undefined;
	if (value.startsWith("!!")) return interpolateEnvVars(value.slice(1));
	if (!value.startsWith("!")) return interpolateEnvVars(value);

	signal?.throwIfAborted();
	let stdout: string;
	try {
		({ stdout } = await execAsync(value.slice(1), {
			encoding: "utf8",
			timeout: COMMAND_SECRET_TIMEOUT_MS,
			maxBuffer: COMMAND_SECRET_MAX_OUTPUT_BYTES,
			windowsHide: true,
			signal,
		}));
	} catch (error) {
		signal?.throwIfAborted();
		const code = isJsonInputObject(error) ? error["code"] : undefined;
		const killed = isJsonInputObject(error) ? error["killed"] : undefined;
		const terminationSignal = isJsonInputObject(error) ? error["signal"] : undefined;
		const reason =
			code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
				? "command output exceeded 1 MiB"
				: killed === true && terminationSignal === "SIGTERM"
					? "command timed out after 10 seconds"
					: isRuntimeNumber(code)
						? `command exited with code ${code}`
						: "command failed to start";
		throw new Error(`Failed to resolve ${context}: ${reason}`);
	}

	const resolved = stdout.trim();
	if (!resolved) throw new Error(`Failed to resolve ${context}: command returned empty output`);
	return resolved;
}

/** Resolve command markers in a configured record without mutating the input. */
export async function resolveCommandSecretsRecord(
	values: Record<string, string> | undefined,
	context: (key: string) => string,
	signal?: AbortSignal,
): Promise<Record<string, string> | undefined> {
	if (!values) return undefined;

	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(values)) {
		resolved[key] = await resolveCommandSecret(value, context(key), signal);
	}
	return resolved;
}

export function resolveServerUrl(definition: Pick<ServerEntry, "url">): string | undefined {
	if (definition.url == null) return undefined;
	if (!isRuntimeString(definition.url)) {
		throw new Error("MCP server URL must be a string");
	}

	const missing = getMissingEnvVars(definition.url);
	if (missing.length > 0) {
		throw new Error(
			`Missing environment variable${missing.length === 1 ? "" : "s"} in MCP server URL: ${missing.join(", ")}`,
		);
	}

	const resolved = interpolateEnvVars(definition.url);
	try {
		new URL(resolved);
	} catch {
		throw new Error("Invalid MCP server URL after environment interpolation");
	}
	return resolved;
}

export function resolveConfigPath(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;

	const resolved = interpolateEnvVars(value);
	if (resolved === "~") return homedir();
	if (resolved.startsWith("~/") || resolved.startsWith("~\\")) {
		return join(homedir(), resolved.slice(2));
	}
	return resolved;
}

export function resolveBearerToken(
	definition: Pick<ServerEntry, "bearerToken" | "bearerTokenEnv">,
): string | undefined {
	if (definition.bearerToken !== undefined) {
		return interpolateSecretExpression(definition.bearerToken);
	}
	return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;
}

export function sanitizeTerminalText(text: string): string {
	return sanitizeUntrustedTerminalText(text).replace(/\s+/gu, " ").trim();
}

const MAX_CAPTURED_STDERR_BYTES = 8 * 1024;
const MAX_CAPTURED_STDERR_LINES = 3;

function boundedStderrChunk(chunk: Buffer | string): Buffer {
	if (Buffer.isBuffer(chunk)) {
		const start = Math.max(0, chunk.byteLength - MAX_CAPTURED_STDERR_BYTES);
		return Buffer.from(chunk.subarray(start));
	}

	// Limit string conversion before encoding; Buffer.from(largeString) would
	// otherwise allocate the entire stderr event before applying the cap.
	const suffix = chunk.length > MAX_CAPTURED_STDERR_BYTES ? chunk.slice(-MAX_CAPTURED_STDERR_BYTES) : chunk;
	const bytes = Buffer.from(suffix, "utf8");
	return bytes.byteLength > MAX_CAPTURED_STDERR_BYTES
		? Buffer.from(bytes.subarray(bytes.byteLength - MAX_CAPTURED_STDERR_BYTES))
		: bytes;
}

export function appendStderrTail(tail: Buffer, chunk: Buffer | string): Buffer {
	const bytes = boundedStderrChunk(chunk);
	if (bytes.length === 0) return tail;
	if (tail.length === 0) return bytes;
	const combined = Buffer.concat([tail, bytes]);
	return combined.length > MAX_CAPTURED_STDERR_BYTES
		? Buffer.from(combined.subarray(combined.length - MAX_CAPTURED_STDERR_BYTES))
		: combined;
}

export function withStderrTail<ErrorValue>(error: ErrorValue, stderrTail: Buffer): Error {
	const reportedError = error instanceof Error ? error : new Error(String(error));
	const lines = stderrTail
		.toString("utf8")
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return reportedError;
	const detail = lines.slice(-MAX_CAPTURED_STDERR_LINES).join(" — ");
	return new Error(`${reportedError.message} (${detail})`, { cause: reportedError });
}

export function formatTerminalError<Value>(error: Value): string {
	const messages: string[] = [];
	const seen = new Set<object>();
	function collect<ErrorValue>(value: ErrorValue): void {
		if ((isRuntimeObject(value) && value !== null) || isRuntimeFunction(value)) {
			if (seen.has(value)) return;
			seen.add(value);
		}

		if (value instanceof AggregateError) {
			const countBefore = messages.length;
			for (const nested of value.errors) collect(nested);
			if (value.cause !== undefined) collect(value.cause);
			if (messages.length === countBefore && value.message) messages.push(value.message);
			return;
		}
		if (value instanceof Error) {
			if (value.message) messages.push(value.message);
			if (value.cause !== undefined) collect(value.cause);
			return;
		}
		messages.push(String(value));
	}

	collect(error);
	return sanitizeTerminalText([...new Set(messages)].join(": "));
}

export function truncateAtWord(text: string, target: number): string {
	if (!text || text.length <= target) return text;

	const truncated = text.slice(0, target);
	const lastSpace = truncated.lastIndexOf(" ");

	if (lastSpace > target * 0.6) {
		return `${truncated.slice(0, lastSpace)}...`;
	}

	return `${truncated}...`;
}

export function formatAuthRequiredMessage(
	config: Pick<McpConfig, "settings">,
	serverName: string,
	defaultMessage: string,
): string {
	const template = config.settings?.authRequiredMessage;
	return template ? template.replaceAll(`\${server}`, serverName) : defaultMessage;
}

export function formatMcpStatus(config: Pick<McpConfig, "settings">, message: string): string | undefined {
	if (config.settings?.mcpFooterStatus === "off") return undefined;
	return `${config.settings?.showStatusIcon === false ? "MCP: " : "🔌 MCP: "}${message}`;
}
