import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { readHostProxyProperty } from "../shared/host-proxy.ts";
import {
	isRuntimeBigInt,
	isRuntimeBoolean,
	isRuntimeFunction,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
	isRuntimeSymbol,
	isRuntimeUndefined,
} from "../shared/runtime-type.ts";
import type { ToolArguments } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import {
	DETAIL_BYTE_LIMIT,
	DETAIL_LINE_LIMIT,
	ROW_PREVIEW_BYTE_LIMIT,
	ROW_PREVIEW_CODE_UNIT_LIMIT,
	TOOL_DISPLAY_ITEM_LIMIT,
	TOOL_DISPLAY_MEDIA_CODE_UNIT_LIMIT,
} from "./limits.ts";
import { graphemePrefix, graphemeSuffix, sanitizeTerminalText, truncateUtf8Graphemes } from "./terminal.ts";

const DETAIL_RAW_SCAN_FACTOR = 4;
const SUMMARY_TEXT_MAX_CODE_UNITS = 64 * 1024;
const TOOL_VALUE_ARRAY_LIMIT = TOOL_DISPLAY_ITEM_LIMIT;
const TOOL_VALUE_DEPTH_LIMIT = 8;
const TOOL_VALUE_VISIT_LIMIT = 256;

interface BoundedSourceText {
	readonly clipped: boolean;
	readonly text: string;
}

interface BoundedToolObject {
	[key: string]: BoundedToolValue;
}

type BoundedToolValue = boolean | null | number | string | undefined | BoundedToolValue[] | BoundedToolObject;

interface ToolValueBudget {
	remaining: number;
	readonly seen: WeakSet<object>;
	truncated: boolean;
}

type BoundedToolProjection = Readonly<{
	truncated: boolean;
	value: BoundedToolValue;
}>;
export const TOOL_DISPLAY_ARGUMENT_KEYS = [
	"action",
	"agent",
	"code",
	"command",
	"content",
	"description",
	"describe",
	"edits",
	"file_path",
	"foreground",
	"id",
	"input",
	"message",
	"name",
	"newText",
	"oldText",
	"path",
	"patch",
	"pattern",
	"prompt",
	"query",
	"request",
	"range",
	"search",
	"server",
	"sources",
	"start",
	"summary",
	"tag",
	"target",
	"task",
	"tasks",
	"tool",
	"to",
	"url",
	"value",
] as const;
const TOOL_DISPLAY_RESULT_KEYS = [
	"absolute_path",
	"action",
	"afterContentIndex",
	"asyncId",
	"backgroundTaskId",
	"cancelled",
	"changedFiles",
	"count",
	"confirmed",
	"content",
	"createdFiles",
	"deletedFiles",
	"detached",
	"diff",
	"error",
	"evidence",
	"exitCode",
	"failed",
	"finalContent",
	"fullOutputPath",
	"hintServer",
	"images",
	"interrupted",
	"kind",
	"latest_path",
	"matchCount",
	"matches",
	"mediaIndex",
	"mediaPlacements",
	"mimeType",
	"mode",
	"model",
	"movedFiles",
	"operations",
	"outputGuard",
	"patch",
	"path",
	"paths",
	"proof",
	"queryCount",
	"requirement",
	"requestedTool",
	"resourceUri",
	"result",
	"resultCount",
	"results",
	"returnedChars",
	"returnedMatches",
	"server",
	"source",
	"state",
	"status",
	"stopped",
	"successful",
	"successfulQueries",
	"summary",
	"taskId",
	"tasks",
	"tool",
	"total",
	"totalResults",
	"truncated",
	"urlCount",
] as const;

function sourcePrefix(value: string, maximumCodeUnits: number): BoundedSourceText {
	const limit = Math.max(0, Math.floor(maximumCodeUnits));
	const text = value.slice(0, limit);
	return { clipped: text.length < value.length, text };
}

export function formatElapsed(milliseconds: number): string {
	if (milliseconds < 1_000) return "<1s";
	const seconds = Math.floor(milliseconds / 1_000);
	if (seconds < 60) return `${String(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	const remainingSeconds = seconds % 60;
	if (minutes < 60) return `${String(minutes)}m ${String(remainingSeconds).padStart(2, "0")}s`;
	const hours = Math.floor(minutes / 60);
	return `${String(hours)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function oneLine(value: string): string {
	const source = sourcePrefix(value, ROW_PREVIEW_CODE_UNIT_LIMIT * DETAIL_RAW_SCAN_FACTOR);
	const normalized = sanitizeTerminalText(source.text).replace(/\s+/gu, " ").trim();
	const raw = graphemePrefix(normalized, ROW_PREVIEW_CODE_UNIT_LIMIT);
	const clipped = source.clipped || raw.length < normalized.length;
	const suffix = clipped ? "…" : "";
	return truncateUtf8Graphemes(`${raw}${suffix}`, ROW_PREVIEW_BYTE_LIMIT);
}

function stringArgument(args: ToolArguments, key: string): string {
	const value = args[key];
	return isRuntimeString(value) ? value : "";
}

export function describeBuiltinTarget(name: string, args: ToolArguments): string {
	if (name === "bash") return oneLine(stringArgument(args, "command"));
	if (name === "grep" || name === "find") {
		const pattern = oneLine(stringArgument(args, "pattern"));
		const path = oneLine(stringArgument(args, "path"));
		return oneLine(path ? `${pattern} in ${path}` : pattern);
	}
	return oneLine(stringArgument(args, "path") || stringArgument(args, "name"));
}

function textFromResult(result: AgentToolResult<unknown>): string {
	let output = "";
	for (let index = 0; index < Math.min(result.content.length, TOOL_VALUE_ARRAY_LIMIT); index += 1) {
		const entry = result.content[index];
		if (!entry) continue;
		if (entry.type !== "text") continue;
		const separator = output ? "\n" : "";
		const remaining = SUMMARY_TEXT_MAX_CODE_UNITS - output.length - separator.length;
		if (remaining <= 0) break;
		if (entry.text.length <= remaining) {
			output += `${separator}${entry.text}`;
			continue;
		}
		const marker = "\n…\n";
		const contentBudget = Math.max(0, remaining - marker.length);
		const headLength = Math.ceil(contentBudget / 2);
		const tailLength = Math.floor(contentBudget / 2);
		const headSource = entry.text.slice(0, headLength + 2);
		const tailSource = tailLength > 0 ? entry.text.slice(-(tailLength + 2)) : "";
		const tail = tailLength > 0 ? graphemeSuffix(tailSource, tailLength) : "";
		output += `${separator}${graphemePrefix(headSource, headLength)}${marker}${tail}`;
		break;
	}
	return output.trim();
}

function firstNonEmptyLine(value: string): string {
	return (
		value
			.split("\n")
			.find((line) => line.trim().length > 0)
			?.trim() ?? "error"
	);
}

function lastNonEmptyLine(value: string): string {
	const lines = value.split("\n").filter((line) => line.trim().length > 0);
	return lines.at(-1)?.trim() ?? "error";
}

export function classifyTerminalState(
	result: AgentToolResult<unknown>,
	isError: boolean,
): Exclude<ToolActivityState, "running"> {
	if (!isError) return "success";
	const text = textFromResult(result);
	if (/^Tool execution was blocked\b/iu.test(text)) {
		return "rejected";
	}
	if (/\b(?:operation|request|command) (?:was )?abort(?:ed)?\b|\bcancel(?:led|ed)\b/iu.test(text)) {
		return "cancelled";
	}
	return "error";
}

function lineCount(value: string): number {
	if (!value) return 0;
	let lines = 1;
	for (let index = 0; index < value.length; index += 1) {
		if (value.charCodeAt(index) === 0x0a) lines += 1;
	}
	return lines;
}

function writeLineCount(value: string) {
	if (!value) return { count: 0, truncated: false };
	const scanLength = Math.min(value.length, SUMMARY_TEXT_MAX_CODE_UNITS);
	let count = 1;
	for (let index = 0; index < scanLength; index += 1) {
		if (value.charCodeAt(index) === 0x0a && index < value.length - 1) count += 1;
	}
	return { count, truncated: scanLength < value.length };
}

function nonEmptyLineCount(value: string): number {
	return value.split("\n").filter((line) => line.trim().length > 0).length;
}

function diffCounts(value: string) {
	let additions = 0;
	let deletions = 0;
	for (const line of value.slice(0, SUMMARY_TEXT_MAX_CODE_UNITS).split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
		if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
	}
	return { additions, deletions };
}

function diffDetail(result: AgentToolResult<unknown>): string | undefined {
	const details = result.details;
	return isRuntimeObject(details) &&
		details !== null &&
		!Array.isArray(details) &&
		"diff" in details &&
		isRuntimeString(details.diff)
		? details.diff
		: undefined;
}

export function summarizeBuiltin(
	name: string,
	args: ToolArguments,
	result: AgentToolResult<unknown>,
	state: Exclude<ToolActivityState, "running">,
	durationMs: number | undefined,
): string {
	if (state === "rejected") return "rejected";
	if (state === "cancelled") return "cancelled";
	if (state === "error") {
		const text = textFromResult(result);
		return oneLine(name === "bash" ? lastNonEmptyLine(text) : firstNonEmptyLine(text));
	}
	for (let index = 0; index < Math.min(result.content.length, DETAIL_LINE_LIMIT); index += 1) {
		if (result.content[index]?.type === "image") return "image loaded";
	}
	if (name === "write") {
		const content = stringArgument(args, "content");
		const lines = writeLineCount(content);
		return `${lines.truncated ? "≥" : ""}${String(lines.count)} ${lines.count === 1 ? "line" : "lines"}`;
	}
	if (name === "edit") {
		const diff = diffDetail(result);
		if (!diff) return "applied";
		const counts = diffCounts(diff);
		return `+${String(counts.additions)}/-${String(counts.deletions)}`;
	}
	if (name === "bash") return durationMs === undefined ? "done" : `done in ${formatElapsed(durationMs)}`;
	const text = textFromResult(result);
	if (name === "read") return `${String(lineCount(text))} lines`;
	if (name === "grep") {
		if (/^No matches found/iu.test(text)) return "0 matches";
		const matches = text
			.split("\n")
			.map((line) => line.match(/^(.+?):\d+:/u))
			.filter((match) => match !== null);
		const files = new Set(matches.map((match) => match[1])).size;
		return `${String(matches.length)} ${matches.length === 1 ? "match" : "matches"} in ${String(files)} ${files === 1 ? "file" : "files"}`;
	}
	if (name === "find" || name === "ls") {
		const count = nonEmptyLineCount(text);
		const singular = name === "find" ? "file" : "entry";
		const plural = name === "find" ? "files" : "entries";
		return `${String(count)} ${count === 1 ? singular : plural}`;
	}
	return oneLine(firstNonEmptyLine(text || "done"));
}

interface BoundedValuePreview {
	readonly text: string;
	readonly truncated: boolean;
}

/** Build a display-only argument view without enumerating arbitrary objects. */
export function boundedToolArguments(
	args: ToolArguments,
	argumentKeys: readonly string[] | undefined = TOOL_DISPLAY_ARGUMENT_KEYS,
): ToolArguments {
	const projected = projectBoundedToolValue(args, argumentKeys ?? TOOL_DISPLAY_ARGUMENT_KEYS).value;
	return isRuntimeObject(projected) && projected !== null && !Array.isArray(projected) ? projected : {};
}

/** Build a display-only result view before Suite presentation callbacks run. */
export function boundedToolResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
	const content: AgentToolResult<unknown>["content"] = [];
	const visibleBlocks = Math.min(result.content.length, TOOL_VALUE_ARRAY_LIMIT);
	for (let index = 0; index < visibleBlocks; index += 1) {
		const entry = result.content[index];
		if (!entry) continue;
		if (entry.type === "text") {
			const source = sourcePrefix(entry.text, SUMMARY_TEXT_MAX_CODE_UNITS);
			content.push({
				type: "text",
				text: source.clipped ? `${source.text}\n… result text truncated` : source.text,
			});
		} else if (isRuntimeString(entry.data) && isRuntimeString(entry.mimeType)) {
			content.push({
				data: entry.data.slice(0, TOOL_DISPLAY_MEDIA_CODE_UNIT_LIMIT),
				mimeType: entry.mimeType.slice(0, 256),
				type: "image",
			});
		}
	}
	if (visibleBlocks < result.content.length) {
		content.push({ type: "text", text: "… result content omitted" });
	}
	const projected: AgentToolResult<unknown> = {
		content,
		details: projectBoundedToolValue(result.details, TOOL_DISPLAY_RESULT_KEYS).value,
	};
	if (Object.getOwnPropertyDescriptor(result, "isError")?.value === true) Object.assign(projected, { isError: true });
	return projected;
}

function boundedToolValue<Value>(
	value: Value,
	depth: number,
	visits: ToolValueBudget,
	objectKeys?: readonly string[],
): BoundedToolValue {
	if (visits.remaining <= 0) {
		visits.truncated = true;
		return "[work limit]";
	}
	visits.remaining -= 1;
	if (isRuntimeString(value)) {
		const source = sourcePrefix(value, SUMMARY_TEXT_MAX_CODE_UNITS);
		if (source.clipped) visits.truncated = true;
		return source.clipped ? `${source.text}…` : source.text;
	}
	if (value === null) return null;
	if (isRuntimeBoolean(value)) return Boolean(value);
	if (isRuntimeNumber(value)) return Number(value);
	if (isRuntimeUndefined(value)) return undefined;
	if (isRuntimeBigInt(value)) return "[bigint]";
	if (isRuntimeFunction(value)) return "[function]";
	if (isRuntimeSymbol(value)) return "[symbol]";
	if (!isRuntimeObject(value)) return "[unsupported value]";
	if (depth >= TOOL_VALUE_DEPTH_LIMIT) {
		visits.truncated = true;
		return "[depth limit]";
	}
	if (visits.seen.has(value)) return "[circular]";
	visits.seen.add(value);
	if (Array.isArray(value)) {
		const output: BoundedToolValue[] = [];
		const visibleItems = Math.min(value.length, TOOL_VALUE_ARRAY_LIMIT);
		for (let index = 0; index < visibleItems; index += 1) {
			try {
				output.push(boundedToolValue(readHostProxyProperty(value, index), depth + 1, visits, objectKeys));
			} catch {
				output.push("[unavailable]");
			}
			if (visits.remaining <= 0) break;
		}
		if (output.length < value.length) {
			visits.truncated = true;
			const marker = visits.remaining <= 0 ? "[work limit]" : "[items omitted]";
			if (output.length >= TOOL_VALUE_ARRAY_LIMIT) output[output.length - 1] = marker;
			else output.push(marker);
		}
		return output;
	}
	if (!objectKeys) {
		visits.truncated = true;
		return "[object fields omitted]";
	}
	const projected: BoundedToolObject = {};
	const visibleKeys = objectKeys.slice(0, TOOL_VALUE_ARRAY_LIMIT);
	if (visibleKeys.length < objectKeys.length) visits.truncated = true;
	for (const key of visibleKeys) {
		if (visits.remaining <= 0) {
			visits.truncated = true;
			projected["…"] = "[work limit]";
			break;
		}
		visits.remaining -= 1;
		try {
			const child = readHostProxyProperty(value, key);
			if (!isRuntimeUndefined(child)) {
				projected[key] = boundedToolValue(child, depth + 1, visits, objectKeys);
			}
		} catch {
			projected[key] = "[unavailable]";
		}
	}
	if (visits.remaining <= 0) {
		visits.truncated = true;
		projected["…"] = "[work limit]";
	}
	return projected;
}

function projectBoundedToolValue<Value>(value: Value, objectKeys?: readonly string[]): BoundedToolProjection {
	const visits: ToolValueBudget = {
		remaining: TOOL_VALUE_VISIT_LIMIT,
		seen: new WeakSet<object>(),
		truncated: false,
	};
	try {
		const projected = boundedToolValue(value, 0, visits, objectKeys);
		return { truncated: visits.truncated, value: projected };
	} catch {
		return { truncated: visits.truncated, value: "[unavailable]" };
	}
}

/** Serialize only the bounded plain-data projection; never inspect a Host value here. */
function serializeBoundedToolProjection(projection: BoundedToolProjection, maxCodeUnits: number): BoundedValuePreview {
	const parts: string[] = [];
	let remaining = Math.max(1, Math.floor(maxCodeUnits));
	let outputTruncated = false;
	const append = (text: string): boolean => {
		if (remaining <= 0) {
			outputTruncated = true;
			return false;
		}
		const next = graphemePrefix(text, remaining);
		parts.push(next);
		remaining -= next.length;
		if (next.length < text.length) outputTruncated = true;
		return !outputTruncated;
	};
	const visit = (candidate: BoundedToolValue): void => {
		if (outputTruncated) return;
		if (candidate === null) {
			append("null");
			return;
		}
		if (isRuntimeString(candidate)) {
			const source = sourcePrefix(candidate, Math.max(0, remaining - 2) + 2);
			const slice = graphemePrefix(source.text, Math.max(0, remaining - 2));
			append(JSON.stringify(slice));
			if (source.clipped || slice.length < source.text.length) outputTruncated = true;
			return;
		}
		if (isRuntimeNumber(candidate) || isRuntimeBoolean(candidate)) {
			append(String(candidate));
			return;
		}
		if (isRuntimeUndefined(candidate)) {
			append("undefined");
			return;
		}
		if (Array.isArray(candidate)) {
			append("[");
			for (let index = 0; index < candidate.length && !outputTruncated; index += 1) {
				if (index > 0) append(", ");
				visit(candidate[index]);
			}
			append("]");
			return;
		}
		append("{");
		let first = true;
		for (const [key, child] of Object.entries(candidate)) {
			if (outputTruncated) break;
			if (!first) append(", ");
			first = false;
			append(JSON.stringify(sourcePrefix(key, ROW_PREVIEW_CODE_UNIT_LIMIT).text));
			append(": ");
			visit(child);
		}
		append("}");
	};
	visit(projection.value);
	const output = parts.join("");
	const truncated = projection.truncated || outputTruncated;
	return {
		text: truncated ? `${graphemePrefix(output, Math.max(0, maxCodeUnits - 1))}…` : output,
		truncated,
	};
}

class DetailCollector {
	private bytes = 0;
	private capped = false;
	private readonly lineLimit: number;
	private readonly byteLimit: number;
	private readonly lines: string[] = [];

	constructor(maxLines: number, maxBytes: number) {
		this.lineLimit = Math.max(1, Math.floor(maxLines));
		this.byteLimit = Math.max(0, Math.floor(maxBytes));
	}

	add(rawLine: string): boolean {
		if (this.capped) return false;
		if (this.lines.length >= this.lineLimit) {
			this.capped = true;
			return false;
		}
		const separatorBytes = this.lines.length > 0 ? 1 : 0;
		const available = this.byteLimit - this.bytes - separatorBytes;
		if (available < 0) {
			this.capped = true;
			return false;
		}
		const scanLimit = Math.max(1_024, available * DETAIL_RAW_SCAN_FACTOR);
		const source = sourcePrefix(rawLine, scanLimit + 1);
		const safe = sanitizeTerminalText(source.text);
		const rawSlice = graphemePrefix(safe, scanLimit);
		const bounded = truncateUtf8Graphemes(rawSlice, available);
		this.lines.push(bounded);
		this.bytes += separatorBytes + Buffer.byteLength(bounded);
		if (source.clipped || rawSlice.length < safe.length || bounded.length < rawSlice.length) {
			this.capped = true;
			return false;
		}
		return true;
	}

	finish(): string[] {
		if (!this.capped) return this.lines;
		const fullMarker = `… detail capped at ${String(this.lineLimit)} lines / ${String(this.byteLimit)} bytes`;
		const marker = truncateUtf8Graphemes(fullMarker, this.byteLimit);
		if (!marker) return [];
		const markerBytes = Buffer.byteLength(marker);
		while (this.lines.length > 0) {
			const separatorBytes = this.lines.length > 0 ? 1 : 0;
			if (this.lines.length < this.lineLimit && this.bytes + separatorBytes + markerBytes <= this.byteLimit) break;
			const removed = this.lines.pop() ?? "";
			this.bytes -= Buffer.byteLength(removed) + (this.lines.length > 0 ? 1 : 0);
		}
		if (this.lines.length === 0 && markerBytes > this.byteLimit) return [];
		this.lines.push(marker);
		return this.lines;
	}

	isCapped(): boolean {
		return this.capped;
	}

	markCapped(): void {
		this.capped = true;
	}
}

function addMultiline(collector: DetailCollector, value: string, prefix = ""): void {
	let offset = 0;
	const rawChunkLimit = Math.max(1_024, DETAIL_BYTE_LIMIT * DETAIL_RAW_SCAN_FACTOR);
	while (!collector.isCapped()) {
		const scanEnd = Math.min(value.length, offset + rawChunkLimit + 1);
		let newline = -1;
		for (let index = offset; index < scanEnd; index += 1) {
			if (value.charCodeAt(index) === 0x0a) {
				newline = index;
				break;
			}
		}
		if (newline >= 0) {
			if (!collector.add(`${prefix}${value.slice(offset, newline)}`)) return;
			offset = newline + 1;
			if (offset === value.length) collector.add(prefix);
			continue;
		}
		if (value.length - offset > rawChunkLimit) {
			collector.add(`${prefix}${graphemePrefix(value.slice(offset, scanEnd), rawChunkLimit)}`);
			collector.markCapped();
			return;
		}
		collector.add(`${prefix}${value.slice(offset)}`);
		return;
	}
}

export function capDetailLines(
	lines: readonly string[],
	maxLines = DETAIL_LINE_LIMIT,
	maxBytes = DETAIL_BYTE_LIMIT,
): string[] {
	const collector = new DetailCollector(maxLines, maxBytes);
	for (const line of lines) {
		if (!collector.add(line)) break;
	}
	return collector.finish();
}

/** Bounded formatted result text without protocol headings or argument dumps. */
export function buildToolResultLines(result: AgentToolResult<unknown>): string[] {
	const collector = new DetailCollector(DETAIL_LINE_LIMIT, DETAIL_BYTE_LIMIT);
	for (const entry of result.content) {
		if (collector.isCapped()) break;
		if (entry.type === "text") addMultiline(collector, entry.text);
		else collector.add(`[image ${oneLine(entry.mimeType)}]`);
	}
	if (result.content.length === 0) collector.add("(no result content)");
	return collector.finish();
}

/** Bounded raw protocol projection built only for the selected Tool call. */
export function buildRawToolDetailLines(
	id: string,
	name: string,
	args: ToolArguments,
	result: AgentToolResult<unknown> | undefined,
	argumentKeys?: readonly string[],
): string[] {
	const argumentPreview = serializeBoundedToolProjection(
		projectBoundedToolValue(args, argumentKeys),
		DETAIL_BYTE_LIMIT,
	);
	const detailsPreview =
		result?.details === undefined
			? { text: "(none)", truncated: false }
			: serializeBoundedToolProjection(
					projectBoundedToolValue(result.details, TOOL_DISPLAY_RESULT_KEYS),
					DETAIL_BYTE_LIMIT,
				);
	const lines = [
		`Call ID: ${oneLine(id)}`,
		`Tool name: ${oneLine(name)}`,
		"",
		"Arguments",
		argumentPreview.text,
		"",
		"Result content",
		...(result ? buildToolResultLines(result) : ["(pending)"]),
		"",
		"Details",
		detailsPreview.text,
	];
	if (argumentPreview.truncated || detailsPreview.truncated) {
		lines.push(`… detail capped at ${String(DETAIL_LINE_LIMIT)} lines / ${String(DETAIL_BYTE_LIMIT)} bytes`);
	}
	return capDetailLines(lines);
}
