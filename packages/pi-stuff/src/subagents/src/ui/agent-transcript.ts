import * as fs from "node:fs";
import * as path from "node:path";
import { type JsonObject, type JsonValue, parseJsonValue } from "../../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import { isTaskOnlyAgentText } from "../shared/display-description.ts";
import { readStatusAsync } from "../shared/utils.ts";
import type {
	AgentToolOutcome,
	AgentTranscriptDocument,
	AgentTranscriptItem,
	AgentTranscriptReader,
	AgentTranscriptRequest,
} from "./agent-dialog.ts";

const READ_BYTE_MULTIPLIER = 4;
const MIN_READ_BYTES = 16 * 1024;
const MAX_READ_BYTES = 2 * 1024 * 1024;
const OMITTED_NOTICE = "… earlier transcript omitted";

function cleanTerminalText(value: string): string {
	let result = "";
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 0x1b) {
			const introducer = value.charCodeAt(index + 1);
			if (introducer === 0x5b) {
				index += 2;
				while (index < value.length) {
					const terminator = value.charCodeAt(index);
					if (terminator >= 0x40 && terminator <= 0x7e) break;
					index += 1;
				}
				continue;
			}
			if (
				introducer === 0x5d ||
				introducer === 0x50 ||
				introducer === 0x58 ||
				introducer === 0x5e ||
				introducer === 0x5f
			) {
				index += 2;
				while (index < value.length) {
					const candidate = value.charCodeAt(index);
					if (candidate === 0x07 || candidate === 0x9c) break;
					if (candidate === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
						index += 1;
						break;
					}
					index += 1;
				}
				continue;
			}
			if (index + 1 < value.length) {
				index += 1;
				while (index + 1 < value.length) {
					const candidate = value.charCodeAt(index);
					if (candidate < 0x20 || candidate > 0x2f) break;
					index += 1;
				}
			}
			continue;
		}
		if (code === 0x9b) {
			index += 1;
			while (index < value.length) {
				const terminator = value.charCodeAt(index);
				if (terminator >= 0x40 && terminator <= 0x7e) break;
				index += 1;
			}
			continue;
		}
		if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
			index += 1;
			while (index < value.length) {
				const candidate = value.charCodeAt(index);
				if (candidate === 0x07 || candidate === 0x9c) break;
				if (candidate === 0x1b && value.charCodeAt(index + 1) === 0x5c) {
					index += 1;
					break;
				}
				index += 1;
			}
			continue;
		}
		if (
			code === 0x061c ||
			code === 0x200b ||
			code === 0x200e ||
			code === 0x200f ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069) ||
			code === 0xfeff
		) {
			result += " ";
			continue;
		}
		if (code === 0x09 || code === 0x0a || code === 0x0d) {
			result += value[index] ?? "";
			continue;
		}
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			result += " ";
			continue;
		}
		result += value[index] ?? "";
	}
	return result.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function boundedTail(value: string, maxChars: number) {
	const clean = cleanTerminalText(value).trim();
	if (clean.length <= maxChars) return { text: clean, truncated: false };
	return {
		text: clean
			.slice(-maxChars)
			.replace(/^\S*\n?/, "")
			.trim(),
		truncated: true,
	};
}

async function readTail(
	filePath: string,
	maxChars: number,
): Promise<{ readonly text: string; readonly truncated: boolean } | null> {
	let file: fs.promises.FileHandle | undefined;
	try {
		const noFollow = isRuntimeNumber(fs.constants.O_NOFOLLOW) ? fs.constants.O_NOFOLLOW : 0;
		file = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
		const stat = await file.stat();
		if (!stat.isFile() || stat.size === 0) return null;
		const maximumBytes = Math.min(MAX_READ_BYTES, Math.max(MIN_READ_BYTES, maxChars * READ_BYTE_MULTIPLIER));
		const bytes = Math.min(stat.size, maximumBytes);
		const start = stat.size - bytes;
		const buffer = Buffer.alloc(bytes);
		const { bytesRead } = await file.read(buffer, 0, bytes, start);
		return { text: buffer.subarray(0, bytesRead).toString("utf8"), truncated: start > 0 };
	} catch (error) {
		if (error && isRuntimeObject(error) && "code" in error && error.code === "ENOENT") return null;
		throw error;
	} finally {
		await file?.close();
	}
}

function record(value: JsonValue | undefined): JsonObject | undefined {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value) ? value : undefined;
}

function contentText(value: JsonValue | undefined): string {
	if (isRuntimeString(value)) return value;
	if (!Array.isArray(value)) return "";
	return value
		.map((item) => {
			if (isRuntimeString(item)) return item;
			const part = record(item);
			if (!part) return "";
			if (isRuntimeString(part["text"])) return part["text"];
			if (isRuntimeString(part["content"])) return part["content"];
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function field(entry: JsonObject, message: JsonObject | undefined, key: string): JsonValue | undefined {
	return entry[key] ?? message?.[key];
}

function stringField(entry: JsonObject, message: JsonObject | undefined, key: string): string | undefined {
	const value = field(entry, message, key);
	return isRuntimeString(value) && value ? value : undefined;
}

function booleanField(entry: JsonObject, message: JsonObject | undefined, key: string): boolean | undefined {
	const value = field(entry, message, key);
	return isRuntimeBoolean(value) ? value : undefined;
}

function oneLine(value: string): string {
	return cleanTerminalText(value).replace(/\s+/gu, " ").trim();
}

function sameOutcome(value: string, outcome: string | null): boolean {
	if (!outcome) return false;
	const actual = oneLine(value);
	const expected = oneLine(outcome);
	return actual === expected || (expected.endsWith("…") && actual.startsWith(expected.slice(0, -1).trimEnd()));
}

function isInternalAgentPrompt(value: string): boolean {
	return /^(?:<pi-stuff-context\b|<file\b[^>]*>\s*Task:\s*<pi-stuff-context\b)/u.test(value.trimStart());
}

interface MessageProjection {
	readonly speaker: string | null;
	readonly text: string;
}

function messageBlock(entry: JsonObject, agentName: string): MessageProjection | null {
	const message = record(entry["message"]);
	const role = isRuntimeString(entry["role"])
		? entry["role"]
		: isRuntimeString(message?.["role"])
			? message["role"]
			: undefined;
	const text =
		(isRuntimeString(entry["text"]) ? entry["text"] : "") ||
		contentText(entry["content"]) ||
		(isRuntimeString(message?.["text"]) ? message["text"] : "") ||
		contentText(message?.["content"]);
	if (!text.trim()) return null;
	if (role === "assistant") return { speaker: agentName, text: text.trim() };
	if (role === "user") return { speaker: "You", text: text.trim() };
	if (role === "toolResult" || role === "tool_result") return null;
	return { speaker: null, text: text.trim() };
}

interface ToolProjection {
	ended: boolean;
	isError: boolean | undefined;
	name: string;
	result: string;
	resultSeen: boolean;
	target: string;
	toolCallId: string | undefined;
}

type ParsedTranscriptItem =
	| { readonly kind: "message"; readonly speaker: string | null; readonly text: string }
	| { readonly kind: "tool"; tool: ToolProjection };

function toolResultText(entry: JsonObject): string {
	const message = record(entry["message"]);
	return (
		(isRuntimeString(entry["text"]) ? entry["text"] : "") ||
		contentText(entry["content"]) ||
		(isRuntimeString(message?.["text"]) ? message["text"] : "") ||
		contentText(message?.["content"])
	).trim();
}

function toolOutcome(tool: ToolProjection): AgentToolOutcome {
	if (!tool.ended && !tool.resultSeen) return "running";
	if (tool.isError !== true) return "completed";
	const result = cleanTerminalText(tool.result).trim();
	if (/^Tool execution was blocked\b/iu.test(result)) return "rejected";
	if (/\b(?:operation|request|command) (?:was )?abort(?:ed)?\b|\bcancel(?:led|ed)\b/iu.test(result)) {
		return "cancelled";
	}
	return "failed";
}

function createToolProjection(
	items: ParsedTranscriptItem[],
	byId: Map<string, ToolProjection>,
	input: {
		readonly name?: string | undefined;
		readonly target?: string | undefined;
		readonly toolCallId?: string | undefined;
	},
): ToolProjection {
	const tool: ToolProjection = {
		ended: false,
		isError: undefined,
		name: input.name ?? "Tool",
		result: "",
		resultSeen: false,
		target: input.target ?? "",
		toolCallId: input.toolCallId,
	};
	items.push({ kind: "tool", tool });
	if (input.toolCallId) byId.set(input.toolCallId, tool);
	return tool;
}

function unresolvedTools(items: readonly ParsedTranscriptItem[], name: string | undefined): ToolProjection[] {
	return items
		.filter((item): item is Extract<ParsedTranscriptItem, { readonly kind: "tool" }> => item.kind === "tool")
		.map((item) => item.tool)
		.filter((tool) => !tool.resultSeen && (name === undefined || tool.name === name));
}

function resolveTool(
	items: readonly ParsedTranscriptItem[],
	byId: ReadonlyMap<string, ToolProjection>,
	toolCallId: string | undefined,
	name: string | undefined,
): ToolProjection | undefined {
	if (toolCallId) return byId.get(toolCallId);
	const candidates = unresolvedTools(items, name);
	return candidates.length === 1 ? candidates[0] : undefined;
}

function boundedDocument(
	items: readonly ParsedTranscriptItem[],
	maxChars: number,
	sourceTruncated: boolean,
): AgentTranscriptDocument {
	const limit = Math.max(1, Math.floor(maxChars));
	const projected: AgentTranscriptItem[] = [];
	let omitted = sourceTruncated;
	for (const item of items) {
		if (item.kind === "message") {
			const bounded = boundedTail(item.text, limit);
			omitted ||= bounded.truncated;
			if (bounded.text) {
				projected.push({
					kind: "message",
					speaker: item.speaker ? oneLine(item.speaker) : null,
					text: bounded.text,
				});
			}
			continue;
		}
		const bounded = boundedTail(item.tool.result, limit);
		omitted ||= bounded.truncated;
		projected.push({
			kind: "tool",
			name: oneLine(item.tool.name) || "Tool",
			outcome: toolOutcome(item.tool),
			result: bounded.text,
			target: oneLine(item.tool.target),
		});
	}

	return {
		items: [
			...(omitted ? [{ kind: "notice", text: OMITTED_NOTICE } satisfies AgentTranscriptItem] : []),
			...projected,
		],
	};
}

function jsonlTranscript(
	source: string,
	sourceTruncated: boolean,
	task: string,
	agentName: string,
	outcome: string | null,
	maxChars: number,
): AgentTranscriptDocument {
	let lines = source.split(/\r?\n/);
	if (sourceTruncated && lines.length > 0) lines = lines.slice(1);
	let transcriptTruncated = sourceTruncated;
	const items: ParsedTranscriptItem[] = [];
	const toolsById = new Map<string, ToolProjection>();
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: JsonObject | undefined;
		try {
			entry = record(parseJsonValue(line));
		} catch {
			continue;
		}
		if (!entry) continue;
		const recordType = isRuntimeString(entry["recordType"]) ? entry["recordType"] : undefined;
		if (recordType === "truncated") {
			transcriptTruncated = true;
			continue;
		}
		if (recordType === "tool_start") {
			const toolCallId = stringField(entry, undefined, "toolCallId");
			const name = stringField(entry, undefined, "toolName") ?? "Tool";
			const target = stringField(entry, undefined, "argsPreview") ?? "";
			const existing = toolCallId ? toolsById.get(toolCallId) : undefined;
			if (existing) {
				existing.name = name;
				existing.target = target;
			} else createToolProjection(items, toolsById, { name, target, toolCallId });
			continue;
		}
		if (recordType === "tool_end") {
			const toolCallId = stringField(entry, undefined, "toolCallId");
			const name = stringField(entry, undefined, "toolName");
			const tool =
				resolveTool(items, toolsById, toolCallId, name) ??
				createToolProjection(items, toolsById, { name, toolCallId });
			tool.ended = true;
			tool.isError = booleanField(entry, undefined, "isError") ?? tool.isError;
			continue;
		}
		if (recordType && recordType !== "message") continue;
		const message = record(entry["message"]);
		const role = isRuntimeString(entry["role"])
			? entry["role"]
			: isRuntimeString(message?.["role"])
				? message["role"]
				: undefined;
		if (role === "toolResult" || role === "tool_result") {
			const toolCallId = stringField(entry, message, "toolCallId");
			const name = stringField(entry, message, "toolName");
			const tool =
				resolveTool(items, toolsById, toolCallId, name) ??
				createToolProjection(items, toolsById, { name, toolCallId });
			if (name) tool.name = name;
			tool.result = toolResultText(entry);
			tool.resultSeen = true;
			tool.ended = true;
			tool.isError = booleanField(entry, message, "isError") ?? tool.isError ?? false;
			continue;
		}
		const block = messageBlock(entry, agentName);
		const previous = items.at(-1);
		const blockText = block ? `${block.speaker ? `${block.speaker}\n` : ""}${block.text}` : "";
		const duplicatesOutcome = role === "assistant" && block !== null && sameOutcome(block.text, outcome);
		if (
			block &&
			!duplicatesOutcome &&
			!(role === "user" && (isInternalAgentPrompt(block.text) || isTaskOnlyAgentText(blockText, task))) &&
			!(previous?.kind === "message" && previous.speaker === block.speaker && previous.text === block.text)
		) {
			items.push({ kind: "message", speaker: block.speaker, text: block.text });
		}
	}
	return boundedDocument(items, maxChars, transcriptTruncated);
}

async function transcriptCandidate(request: AgentTranscriptRequest): Promise<string | null> {
	const direct = request.row.transcriptPath ?? request.row.savedOutputPath ?? request.row.sessionFile;
	if (direct) return direct;
	if (!request.row.asyncDir || request.row.childIndex === undefined) return null;
	try {
		const status = await readStatusAsync(request.row.asyncDir);
		const step = status?.steps?.[request.row.childIndex];
		return step?.transcriptPath ?? step?.sessionFile ?? null;
	} catch {
		return null;
	}
}

/** Bounded, no-follow transcript reader for the shared Agent Command Dialog. */
export const readAgentTranscript: AgentTranscriptReader = async (request) => {
	if (request.signal.aborted) return null;
	const partial = isTaskOnlyAgentText(request.row.partialResult, request.row.task) ? null : request.row.partialResult;
	const candidate = await transcriptCandidate(request);
	if (!candidate || !path.isAbsolute(candidate)) return null;
	const tail = await readTail(candidate, request.maxChars);
	if (request.signal.aborted) return null;
	if (!tail) return null;
	if (candidate.endsWith(".jsonl")) {
		const document = jsonlTranscript(
			tail.text,
			tail.truncated,
			request.row.task,
			oneLine(request.row.name ?? "Agent") || "Agent",
			partial,
			request.maxChars,
		);
		return document.items.length > 0 ? document : null;
	}

	const bounded = boundedTail(tail.text, request.maxChars);
	const text =
		!bounded.text || isTaskOnlyAgentText(bounded.text, request.row.task) || sameOutcome(bounded.text, partial)
			? ""
			: bounded.text;
	const items: AgentTranscriptItem[] = [
		...(tail.truncated || bounded.truncated
			? [{ kind: "notice", text: OMITTED_NOTICE } satisfies AgentTranscriptItem]
			: []),
		...(text ? [{ kind: "message", speaker: null, text } satisfies AgentTranscriptItem] : []),
	];
	return items.length > 0 ? { items } : null;
};
