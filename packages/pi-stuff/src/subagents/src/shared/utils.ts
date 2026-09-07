/**
 * General utility functions for the subagent extension
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import { CONFIG_DIR_NAME, getAgentDir as getPiAgentDir } from "@earendil-works/pi-coding-agent";
import { type JsonObject, type JsonValue, parseJsonValue } from "../../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import type { ToolArguments } from "../../../tool-display/activity.ts";
import { boundTerminalLine } from "../../../tool-display/index.ts";
import {
	assertPrivateDirectory,
	readBoundedOwnedFileSnapshot,
	readBoundedOwnedFileSnapshotAsync,
} from "./private-directory.ts";
import type { AsyncStatus, ErrorInfo } from "./types.ts";

// ============================================================================
// File System Utilities
// ============================================================================

export const PI_CODING_AGENT_PACKAGE_ROOT_ENV = "PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT";

export function resolveWatchPath(
	watchPath: string,
	nativeRealpath: (filePath: string) => string = fs.realpathSync.native,
): string {
	// libuv's Windows watcher cannot mix 8.3 registration paths with long event paths.
	try {
		return nativeRealpath(watchPath);
	} catch {
		return watchPath;
	}
}

export function getProjectConfigDir(projectRoot: string): string {
	return path.join(projectRoot, CONFIG_DIR_NAME);
}

export function getAgentDir(): string {
	return getPiAgentDir();
}

export function getAgentSessionsDir(environment: NodeJS.ProcessEnv = process.env): string {
	const configured = environment["PI_CODING_AGENT_SESSION_DIR"];
	const home = environment["HOME"] ?? os.homedir();
	if (configured === "~") return home;
	if (configured?.startsWith("~/")) return path.join(home, configured.slice(2));
	return configured || path.join(getAgentDir(), "sessions");
}

const statusCache = new Map<
	string,
	{ mtime: number; ctime: number; size: number; ino: number; dev: number; status: AsyncStatus }
>();
export const MAX_ASYNC_STATUS_FILE_BYTES = 8 * 1024 * 1024;

export function getErrorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function resolveChildCwd(baseCwd: string, childCwd: string | undefined): string {
	if (!childCwd) return baseCwd;
	return path.isAbsolute(childCwd) ? childCwd : path.resolve(baseCwd, childCwd);
}

export function isTerminalAsyncState(state: AsyncStatus["state"]): boolean {
	return state === "complete" || state === "failed" || state === "paused" || state === "stopped";
}

export function pickFields<Source extends object, Key extends keyof Source>(
	source: Source,
	fields: readonly Key[],
): Partial<Pick<Source, Key>> {
	const picked: Partial<Pick<Source, Key>> = {};
	for (const field of fields) if (source[field] !== undefined) picked[field] = source[field];
	return picked;
}

export function isNotFoundError<Cause>(cause: Cause): boolean {
	return isRuntimeObject(cause) && cause !== null && "code" in cause && cause.code === "ENOENT";
}

function asyncStatusForRun(status: JsonValue, statusPath: string, expectedRunId: string): AsyncStatus {
	if (
		!isRuntimeObject(status) ||
		status === null ||
		Array.isArray(status) ||
		!("runId" in status) ||
		status["runId"] !== expectedRunId
	) {
		throw new Error(`Async status file '${statusPath}' runId must exactly match its run directory.`);
	}
	// SAFETY: the bounded file is read from a verified private directory, Suite writers serialize AsyncStatus,
	// and the checked runId binds this typed artifact to the directory selected by the caller.
	return status as JsonObject & AsyncStatus;
}

/**
 * Read async job status from disk (with mtime-based caching)
 */
export function readStatus(asyncDir: string): AsyncStatus | null {
	const statusPath = path.join(asyncDir, "status.json");

	let snapshot: ReturnType<typeof readBoundedOwnedFileSnapshot>;
	try {
		assertPrivateDirectory(asyncDir);
		if (fs.realpathSync(asyncDir) !== path.resolve(asyncDir))
			throw new Error(`Async run directory '${asyncDir}' contains a redirected path component.`);
		snapshot = readBoundedOwnedFileSnapshot(statusPath, MAX_ASYNC_STATUS_FILE_BYTES);
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw new Error(`Failed to inspect async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	const cached = statusCache.get(statusPath);
	if (
		cached &&
		cached.mtime === snapshot.mtimeMs &&
		cached.ctime === snapshot.ctimeMs &&
		cached.size === snapshot.size &&
		cached.ino === snapshot.ino &&
		cached.dev === snapshot.dev
	) {
		return cached.status;
	}

	let parsed: JsonValue;
	try {
		parsed = parseJsonValue(snapshot.text);
	} catch (error) {
		throw new Error(`Failed to parse async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	const status = asyncStatusForRun(parsed, statusPath, path.basename(asyncDir));

	statusCache.set(statusPath, {
		mtime: snapshot.mtimeMs,
		ctime: snapshot.ctimeMs,
		size: snapshot.size,
		ino: snapshot.ino,
		dev: snapshot.dev,
		status,
	});
	if (statusCache.size > 50) {
		const firstKey = statusCache.keys().next().value;
		if (firstKey) statusCache.delete(firstKey);
	}
	return status;
}

/** Read one persisted Agent status without performing filesystem work on the Host event-loop thread. */
export async function readStatusAsync(asyncDir: string): Promise<AsyncStatus | null> {
	const statusPath = path.join(asyncDir, "status.json");
	let snapshot: Awaited<ReturnType<typeof readBoundedOwnedFileSnapshotAsync>>;
	try {
		const directoryStat = await fs.promises.lstat(asyncDir);
		assertPrivateDirectory(asyncDir, directoryStat);
		if ((await fs.promises.realpath(asyncDir)) !== path.resolve(asyncDir)) {
			throw new Error(`Async run directory '${asyncDir}' contains a redirected path component.`);
		}
		snapshot = await readBoundedOwnedFileSnapshotAsync(statusPath, MAX_ASYNC_STATUS_FILE_BYTES);
	} catch (error) {
		if (isNotFoundError(error)) return null;
		throw new Error(`Failed to inspect async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	const cached = statusCache.get(statusPath);
	if (
		cached &&
		cached.mtime === snapshot.mtimeMs &&
		cached.ctime === snapshot.ctimeMs &&
		cached.size === snapshot.size &&
		cached.ino === snapshot.ino &&
		cached.dev === snapshot.dev
	) {
		return cached.status;
	}

	let parsed: JsonValue;
	try {
		parsed = parseJsonValue(snapshot.text);
	} catch (error) {
		throw new Error(`Failed to parse async status file '${statusPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	const status = asyncStatusForRun(parsed, statusPath, path.basename(asyncDir));
	statusCache.set(statusPath, {
		mtime: snapshot.mtimeMs,
		ctime: snapshot.ctimeMs,
		size: snapshot.size,
		ino: snapshot.ino,
		dev: snapshot.dev,
		status,
	});
	if (statusCache.size > 50) {
		const firstKey = statusCache.keys().next().value;
		if (firstKey) statusCache.delete(firstKey);
	}
	return status;
}

/**
 * Find the latest session file in a directory
 */
export function findLatestSessionFile(sessionDir: string | undefined): string | undefined {
	if (!sessionDir || !fs.existsSync(sessionDir)) return undefined;
	try {
		const files = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => {
				const filePath = path.join(sessionDir, f);
				return { path: filePath, mtime: fs.statSync(filePath).mtimeMs };
			})
			.sort((a, b) => b.mtime - a.mtime);
		return files[0]?.path;
	} catch {
		return undefined;
	}
}

// ============================================================================
// Message Parsing Utilities
// ============================================================================

function acceptanceMessageText(content: readonly unknown[]): string {
	const texts: string[] = [];
	for (const part of content) {
		if (
			part !== null &&
			isRuntimeObject(part) &&
			"type" in part &&
			part.type === "text" &&
			"text" in part &&
			isRuntimeString(part.text) &&
			part.text.trim().length > 0
		)
			texts.push(part.text);
	}
	return texts.join("\n");
}

/**
 * Get the final text output from a list of messages
 */
export function getFinalOutput(messages: readonly { role?: string; content?: unknown }[]): string {
	let latestText: string | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg || !isRuntimeObject(msg) || msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		const hasAssistantError =
			("errorMessage" in msg && isRuntimeString(msg.errorMessage) && msg.errorMessage.length > 0) ||
			("stopReason" in msg && msg.stopReason === "error");
		if (hasAssistantError) continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j];
			if (
				!part ||
				!isRuntimeObject(part) ||
				part.type !== "text" ||
				!isRuntimeString(part.text) ||
				part.text.trim().length === 0
			)
				continue;
			latestText ??= part.text;
			if (/```acceptance[-_]report\s*\n[\s\S]*?```/i.test(part.text)) return acceptanceMessageText(msg.content);
			for (const match of part.text.matchAll(/```(?:json|jsonc|json5)\s*\n([\s\S]*?)```/gi)) {
				const body = match[1] ?? "";
				if (
					/"(?:criteriaSatisfied|criteria_satisfied)"/.test(body) &&
					/"(?:changedFiles|changed_files|testsAddedOrUpdated|tests_added_or_updated|commandsRun|commands_run|validationOutput|validation_output|residualRisks|residual_risks|noStagedFiles|no_staged_files|diffSummary|diff_summary|reviewFindings|review_findings|manualNotes|manual_notes)"/.test(
						body,
					)
				) {
					return acceptanceMessageText(msg.content);
				}
			}
			if (/ACCEPTANCE_REPORT\s*:/i.test(part.text)) return acceptanceMessageText(msg.content);
		}
	}
	return latestText ?? "";
}

export const MAX_STREAMED_OUTPUT_LINE_CHARS = 2000;

/** Cap per-line length of recent output so one long line can't inflate a snapshot. */
export function boundStreamedRecentOutput(recentOutput: string[]): string[] {
	return recentOutput.map((line) => boundTerminalLine(line, MAX_STREAMED_OUTPUT_LINE_CHARS, "… [truncated]"));
}

/**
 * Detect errors in subagent execution from messages (only errors with no subsequent success)
 */
export function detectSubagentError(messages: Message[]): ErrorInfo {
	let lastAssistantTextIndex = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg && isRuntimeObject(msg) && msg.role === "assistant") {
			const hasText =
				Array.isArray(msg.content) &&
				msg.content.some(
					(c) =>
						c !== null &&
						isRuntimeObject(c) &&
						c.type === "text" &&
						"text" in c &&
						isRuntimeString(c.text) &&
						c.text.trim().length > 0,
				);
			if (hasText) {
				lastAssistantTextIndex = i;
				break;
			}
		}
	}

	const scanStart = lastAssistantTextIndex >= 0 ? lastAssistantTextIndex + 1 : 0;

	for (let i = messages.length - 1; i >= scanStart; i--) {
		const msg = messages[i];
		if (!msg || !isRuntimeObject(msg) || msg.role !== "toolResult" || !Array.isArray(msg.content)) continue;
		const toolName = "toolName" in msg && isRuntimeString(msg.toolName) ? msg.toolName : undefined;
		const isError = "isError" in msg && msg.isError === true;

		if (!isError) continue;

		const text = msg.content.find(
			(c) => c !== null && isRuntimeObject(c) && c.type === "text" && isRuntimeString(c.text),
		);
		const details = text && "text" in text && isRuntimeString(text.text) ? text.text : undefined;
		const exitMatch = details?.match(/exit(?:ed)?\s*(?:with\s*)?(?:code|status)?\s*[:\s]?\s*(\d+)/i);
		const error: ErrorInfo = {
			hasError: true,
			exitCode: exitMatch?.[1] ? parseInt(exitMatch[1], 10) : 1,
			errorType: toolName || "tool",
		};
		if (details !== undefined) error.details = details.slice(0, 200);
		return error;
	}

	return { hasError: false };
}

/**
 * Extract a preview of tool arguments for display
 */
export function extractToolArgsPreview(args: ToolArguments): string {
	const truncatePreview = (value: string, maximumWidth: number): string =>
		boundTerminalLine(value, maximumWidth, "...");

	const stringifyPreviewValue = <Value>(value: Value): string | undefined => {
		if (isRuntimeString(value) && value.trim().length > 0) return value;
		if (isRuntimeNumber(value) || isRuntimeBoolean(value)) return String(value);
		return undefined;
	};

	const previewArray = <Value>(value: Value): string | undefined => {
		if (!Array.isArray(value) || value.length === 0) return undefined;
		const first = stringifyPreviewValue(value[0]);
		if (!first) return undefined;
		const suffix = value.length > 1 ? ` (+${value.length - 1} more)` : "";
		return `${first}${suffix}`;
	};

	// Handle MCP tool calls - show server/tool info
	if (args["tool"] && isRuntimeString(args["tool"])) {
		const server = args["server"] && isRuntimeString(args["server"]) ? `${args["server"]}/` : "";
		const toolArgs = args["args"] && isRuntimeString(args["args"]) ? ` ${truncatePreview(args["args"], 40)}` : "";
		return `${server}${args["tool"]}${toolArgs}`;
	}

	const queriesPreview = previewArray(args["queries"]);
	if (queriesPreview) return truncatePreview(queriesPreview, 60);
	if (isRuntimeString(args["query"]) && args["query"].trim().length > 0) return truncatePreview(args["query"], 60);

	if (isRuntimeString(args["url"]) && args["url"].trim().length > 0) return truncatePreview(args["url"], 60);
	const urlsPreview = previewArray(args["urls"]);
	if (urlsPreview) return truncatePreview(urlsPreview, 60);
	if (isRuntimeString(args["prompt"]) && args["prompt"].trim().length > 0) return truncatePreview(args["prompt"], 60);

	const previewKeys = ["command", "path", "file_path", "pattern", "query", "url", "task", "describe", "search"];
	for (const key of previewKeys) {
		const value = args[key];
		if (value && isRuntimeString(value)) return truncatePreview(value, 60);
	}

	// Fallback: show first string value found
	for (const [key, value] of Object.entries(args)) {
		const arrayPreview = previewArray(value);
		if (arrayPreview) return `${key}=${truncatePreview(arrayPreview, 50)}`;
		if (isRuntimeString(value) && value.length > 0) {
			const preview = truncatePreview(value, 50);
			return `${key}=${preview}`;
		}
	}
	return "";
}

/**
 * Extract text content from various message content formats
 */
export function extractTextFromContent<Content>(content: Content): string {
	if (!content) return "";
	// Handle string content directly
	if (isRuntimeString(content)) return content;
	// Handle array content
	if (!Array.isArray(content)) return "";
	const texts: string[] = [];
	for (const part of content) {
		if (part && isRuntimeObject(part)) {
			// Handle { type: "text", text: "..." }
			if ("type" in part && part.type === "text" && "text" in part) {
				texts.push(String(part.text));
			}
			// Handle { type: "tool_result", content: "..." }
			else if ("type" in part && part.type === "tool_result" && "content" in part) {
				const inner = extractTextFromContent(part.content);
				if (inner) texts.push(inner);
			}
			// Handle { text: "..." } without type
			else if ("text" in part) {
				texts.push(String(part.text));
			}
		}
	}
	return texts.join("\n");
}

// ============================================================================
// Concurrency Utilities
// ============================================================================

export { mapConcurrent } from "../runs/shared/parallel-utils.ts";
