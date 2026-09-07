import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isJsonInputObject,
	type JsonInputObject,
	type JsonInputValue,
	jsonInputKind,
} from "../../shared/json-value.ts";
import {
	isRuntimeBigInt,
	isRuntimeBoolean,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
} from "../../shared/runtime-type.ts";
import type { ContentBlock, McpSettings } from "./types.ts";

export const DEFAULT_MCP_OUTPUT_MAX_BYTES = 50 * 1024;
export const DEFAULT_MCP_OUTPUT_MAX_LINES = 2000;
export const DEFAULT_MCP_DETAILS_MAX_BYTES = 16 * 1024;

const CONTENT_SUMMARY_LIMIT = 20;
const KEY_PREVIEW_LIMIT = 20;
const KEY_MAX_CHARS = 120;

type Recordish = JsonInputObject;

interface OutputBudget {
	maxBytes: number;
	maxLines: number;
}

interface TruncatedText {
	bytes: number;
	content: string;
	lines: number;
}

interface TextStats {
	bytes: number;
	lines: number;
}

export interface McpOutputGuardDetails extends JsonInputObject {
	truncated: true;
	originalBytes: number;
	returnedBytes: number;
	originalLines: number;
	returnedLines: number;
	/** Number of image content blocks returned untouched alongside the truncated text. */
	imageBlocksPassedThrough?: number;
	fullOutputPath?: string;
	writeError?: string;
}

export interface McpResultSummary extends JsonInputObject {
	omitted: true;
	reason: string;
	isError: boolean;
	contentBlocks: number;
	contentSummary: Array<JsonInputObject>;
	structuredContent?: JsonInputObject;
	meta?: JsonInputObject;
	extraFields?: Array<JsonInputObject>;
	rawResultBytes: number;
	fullResultPath?: string;
	resultWriteError?: string;
}

export interface McpOutputGuardOptions {
	enabled?: boolean;
	prefix?: string;
	suffix?: string;
	emptyTextFallback?: string;
	maxBytes?: number;
	maxLines?: number;
	detailsMaxBytes?: number;
	/**
	 * Raw MCP result to expose as details.mcpResult. Kept raw when its JSON
	 * fits detailsMaxBytes (or when the guard is disabled); otherwise replaced
	 * with a compact summary and spilled to a temp file. Omit for call sites
	 * whose details never carried the raw result.
	 */
	rawMcpResult?: JsonInputValue;
}

export interface GuardedMcpOutput {
	content: ContentBlock[];
	outputGuard?: McpOutputGuardDetails;
	mcpResult?: JsonInputValue;
}

export function resolveMcpOutputGuardOptions(
	settings?: McpSettings,
): Pick<McpOutputGuardOptions, "enabled" | "maxBytes" | "maxLines" | "detailsMaxBytes"> {
	const configured = settings?.outputGuard;
	const tuning = isRuntimeObject(configured) && configured !== null ? configured : undefined;
	return {
		enabled: envKillSwitch("MCP_OUTPUT_GUARD") ?? configured !== false,
		maxBytes: positiveInt(tuning?.maxBytes) ?? DEFAULT_MCP_OUTPUT_MAX_BYTES,
		maxLines: positiveInt(tuning?.maxLines) ?? DEFAULT_MCP_OUTPUT_MAX_LINES,
		detailsMaxBytes: positiveInt(tuning?.detailsMaxBytes) ?? DEFAULT_MCP_DETAILS_MAX_BYTES,
	};
}

/** Spread helper for tool-result details: includes mcpResult/outputGuard only when present. */
export function guardedMcpDetails(guarded: GuardedMcpOutput): JsonInputObject {
	const details: JsonInputObject = {};
	if (guarded.mcpResult !== undefined) details["mcpResult"] = guarded.mcpResult;
	if (guarded.outputGuard) details["outputGuard"] = guarded.outputGuard;
	return details;
}

/**
 * Bound model-facing MCP text output. Text is capped at maxBytes/maxLines and
 * spilled to a temp file when oversized. Image blocks bypass this text budget;
 * Pi's post-extension Tool-result seam owns their normalization before history
 * and provider delivery.
 */
export async function guardMcpOutput(
	content: ContentBlock[],
	options: McpOutputGuardOptions = {},
): Promise<GuardedMcpOutput> {
	const maxBytes = options.maxBytes ?? DEFAULT_MCP_OUTPUT_MAX_BYTES;
	const maxLines = options.maxLines ?? DEFAULT_MCP_OUTPUT_MAX_LINES;
	const detailsMaxBytes = options.detailsMaxBytes ?? DEFAULT_MCP_DETAILS_MAX_BYTES;
	const prefix = options.prefix ?? "";
	const suffix = options.suffix ?? "";

	const normalizedContent = withEmptyTextFallback(
		content.length > 0
			? sanitizeContent(content)
			: [{ type: "text" as const, text: options.emptyTextFallback ?? "(empty result)" }],
		options.emptyTextFallback,
	);

	if (options.enabled === false) {
		return {
			content: addAffixes(normalizedContent, prefix, suffix),
			mcpResult: options.rawMcpResult,
		};
	}

	const imageBlocks = normalizedContent.filter((block) => block.type === "image");
	const textOutput = normalizedContent
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n");
	const composedOutput = `${prefix}${textOutput}${suffix}`;
	const stats = textStats(composedOutput);

	let guardedContent: ContentBlock[] = addAffixes(normalizedContent, prefix, suffix);
	let outputGuard: McpOutputGuardDetails | undefined;

	if (stats.bytes > maxBytes || stats.lines > maxLines) {
		const { path: fullOutputPath, error: writeError } = await saveArtifact("output", composedOutput);
		const notice = formatTruncationNotice(stats, fullOutputPath, writeError);
		const boundedNotice = truncateHead(notice, maxBytes, maxLines).content;
		const previewBudget = reserveBudget(maxBytes, maxLines, boundedNotice);
		const preview = truncateHead(composedOutput, previewBudget.maxBytes, previewBudget.maxLines);
		const candidate = preview.content ? `${preview.content}\n\n${boundedNotice}` : boundedNotice;
		const finalText = truncateHead(candidate, maxBytes, maxLines).content;
		const finalStats = textStats(finalText);

		guardedContent = [{ type: "text" as const, text: finalText }, ...imageBlocks];
		const details: McpOutputGuardDetails = {
			truncated: true,
			originalBytes: stats.bytes,
			returnedBytes: finalStats.bytes,
			originalLines: stats.lines,
			returnedLines: finalStats.lines,
		};
		if (fullOutputPath !== undefined) details.fullOutputPath = fullOutputPath;
		if (writeError !== undefined) details.writeError = writeError;
		if (imageBlocks.length > 0) details.imageBlocksPassedThrough = imageBlocks.length;
		outputGuard = details;
	}

	const mcpResult =
		options.rawMcpResult === undefined ? undefined : await boundMcpResult(options.rawMcpResult, detailsMaxBytes);

	const guarded: GuardedMcpOutput = { content: guardedContent };
	if (outputGuard !== undefined) guarded.outputGuard = outputGuard;
	if (mcpResult !== undefined) guarded.mcpResult = mcpResult;
	return guarded;
}

function sanitizeContent(content: ContentBlock[]): ContentBlock[] {
	return content.map((block) => {
		if (block.type !== "image") return block;
		const mimeType =
			isRuntimeString(block.mimeType) && block.mimeType.trim() ? block.mimeType.trim().slice(0, 100) : "image/png";
		return { ...block, mimeType };
	});
}

function withEmptyTextFallback(content: ContentBlock[], fallback: string | undefined): ContentBlock[] {
	if (!fallback) return content;
	const textOutput = content
		.filter(isTextBlock)
		.map((block) => block.text)
		.join("\n");
	if (textOutput) return content;
	return [{ type: "text", text: fallback }, ...content.filter((block) => block.type === "image")];
}

function addAffixes(content: ContentBlock[], prefix: string, suffix: string): ContentBlock[] {
	if (!prefix && !suffix) return content;
	const next: ContentBlock[] = [...content];

	if (prefix) {
		const index = next.findIndex((block) => block.type === "text");
		const block = index >= 0 ? next[index] : undefined;
		if (block?.type === "text") {
			next[index] = { ...block, text: `${prefix}${block.text}` };
		} else {
			next.unshift({ type: "text", text: prefix });
		}
	}

	if (suffix) {
		let index = -1;
		for (let i = next.length - 1; i >= 0; i--) {
			if (next[i]?.type === "text") {
				index = i;
				break;
			}
		}
		const block = index >= 0 ? next[index] : undefined;
		if (block?.type === "text") {
			next[index] = { ...block, text: `${block.text}${suffix}` };
		} else {
			next.push({ type: "text", text: suffix });
		}
	}

	return next;
}

function isTextBlock(block: ContentBlock): block is Extract<ContentBlock, { type: "text" }> {
	return block.type === "text";
}

function reserveBudget(maxBytes: number, maxLines: number, notice: string): OutputBudget {
	const noticeStats = textStats(`\n\n${notice}`);
	return {
		maxBytes: Math.max(0, maxBytes - noticeStats.bytes),
		maxLines: Math.max(0, maxLines - noticeStats.lines),
	};
}

function truncateHead(text: string, maxBytes: number, maxLines: number): TruncatedText {
	const lines = text.split("\n");
	const output: string[] = [];
	let bytes = 0;

	for (const line of lines) {
		if (output.length >= maxLines) break;
		const separatorBytes = output.length > 0 ? 1 : 0;
		const lineBytes = byteLength(line);
		if (bytes + separatorBytes + lineBytes > maxBytes) {
			const remaining = maxBytes - bytes - separatorBytes;
			if (remaining > 0) {
				output.push(truncateStringToBytes(line, remaining));
			}
			break;
		}
		output.push(line);
		bytes += separatorBytes + lineBytes;
	}

	const content = output.join("\n");
	const stats = textStats(content);
	return { content, bytes: stats.bytes, lines: stats.lines };
}

function truncateStringToBytes(value: string, maxBytes: number): string {
	if (byteLength(value) <= maxBytes) return value;
	const buffer = Buffer.from(value, "utf8");
	let end = Math.max(0, maxBytes);
	while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
	return buffer.subarray(0, end).toString("utf8");
}

function formatTruncationNotice(
	stats: TextStats,
	fullOutputPath: string | undefined,
	writeError: string | undefined,
): string {
	const base = `[MCP text output truncated: original ${stats.lines.toLocaleString()} lines / ${formatSize(stats.bytes)}.`;
	if (fullOutputPath) {
		return `${base} Full text saved to: ${fullOutputPath} — use read with offset/limit or grep to inspect.]`;
	}
	return `${base} Full output could not be saved: ${writeError ?? "unknown error"}]`;
}

/**
 * Bound details.mcpResult: keep the raw result when its JSON fits within
 * detailsMaxBytes; otherwise replace it with a compact summary and spill the
 * raw JSON to a temp file.
 */
async function boundMcpResult(
	result: JsonInputValue,
	detailsMaxBytes: number,
): Promise<JsonInputValue | McpResultSummary> {
	const raw = safeStringify(result);
	const rawBytes = byteLength(raw);
	if (rawBytes <= detailsMaxBytes) return result;
	return summarizeMcpResult(result, raw, rawBytes);
}

async function summarizeMcpResult(result: JsonInputValue, raw: string, rawBytes: number): Promise<McpResultSummary> {
	const { path: fullResultPath, error: resultWriteError } = await saveArtifact("mcp-result", raw);

	const record = asRecord(result);
	const content = Array.isArray(record?.["content"]) ? record["content"] : [];
	const summary: McpResultSummary = {
		omitted: true,
		reason:
			"Raw MCP result exceeded the details size limit and was replaced with this summary to keep session context bounded.",
		isError: record?.["isError"] === true,
		contentBlocks: content.length,
		contentSummary: summarizeContent(content),
		rawResultBytes: rawBytes,
	};
	if (fullResultPath !== undefined) summary.fullResultPath = fullResultPath;
	if (resultWriteError !== undefined) summary.resultWriteError = resultWriteError;

	if (record && "structuredContent" in record) {
		summary.structuredContent = summarizeValue(record["structuredContent"]);
	}
	if (record && "_meta" in record) {
		summary.meta = summarizeValue(record["_meta"]);
	}
	if (record) {
		const standard = new Set(["content", "isError", "structuredContent", "_meta"]);
		const extraFields = Object.keys(record)
			.filter((key) => !standard.has(key))
			.slice(0, KEY_PREVIEW_LIMIT)
			.map((key) => ({
				key: truncateKey(key),
				type: jsonInputKind(record[key]),
				estimatedBytes: estimateValueBytes(record[key]),
				omitted: true,
			}));
		if (extraFields.length > 0) summary.extraFields = extraFields;
	}

	return summary;
}

function summarizeContent(content: JsonInputValue[]): Array<JsonInputObject> {
	const summaries: Array<JsonInputObject> = content.slice(0, CONTENT_SUMMARY_LIMIT).map((block) => {
		const record = asRecord(block);
		if (!record) return { type: jsonInputKind(block), omitted: true };
		if (record["type"] === "text") {
			const text = isRuntimeString(record["text"]) ? record["text"] : "";
			return { type: "text", bytes: byteLength(text), lines: textStats(text).lines, textOmitted: true };
		}
		if (record["type"] === "image") {
			const data = isRuntimeString(record["data"]) ? record["data"] : "";
			return {
				type: "image",
				mimeType: isRuntimeString(record["mimeType"]) ? record["mimeType"] : undefined,
				dataBytes: byteLength(data),
				dataOmitted: true,
			};
		}
		return {
			type: isRuntimeString(record["type"]) ? record["type"] : "unknown",
			estimatedBytes: estimateValueBytes(record),
			omitted: true,
		};
	});
	if (content.length > CONTENT_SUMMARY_LIMIT) {
		summaries.push({ type: "omitted", count: content.length - CONTENT_SUMMARY_LIMIT });
	}
	return summaries;
}

function summarizeValue(value: JsonInputValue): JsonInputObject {
	const record = asRecord(value);
	if (!record) {
		return { type: jsonInputKind(value), estimatedBytes: estimateValueBytes(value), omitted: true };
	}
	const keys = Object.keys(record);
	return {
		type: Array.isArray(value) ? "array" : "object",
		estimatedBytes: estimateValueBytes(value),
		keyCount: keys.length,
		keysPreview: keys.slice(0, KEY_PREVIEW_LIMIT).map(truncateKey),
		omitted: true,
	};
}

function estimateValueBytes(value: JsonInputValue, depth = 0): number {
	if (value === null || value === undefined) return 0;
	if (isRuntimeString(value)) return byteLength(value);
	if (isRuntimeNumber(value) || isRuntimeBoolean(value) || isRuntimeBigInt(value)) return byteLength(String(value));
	if (Array.isArray(value)) {
		if (depth >= 2) return 0;
		return value.slice(0, KEY_PREVIEW_LIMIT).reduce((total, item) => total + estimateValueBytes(item, depth + 1), 0);
	}
	const record = asRecord(value);
	if (!record || depth >= 2) return 0;
	const values = Object.values(record).slice(0, KEY_PREVIEW_LIMIT);
	return values.reduce<number>((total, item) => total + estimateValueBytes(item, depth + 1), 0);
}

function truncateKey(key: string): string {
	return key.length <= KEY_MAX_CHARS ? key : `${key.slice(0, KEY_MAX_CHARS - 1)}…`;
}

async function saveArtifact(kind: string, text: string): Promise<{ path?: string; error?: string }> {
	try {
		const dir = await mkdtemp(join(tmpdir(), "pi-mcp-output-"));
		const path = join(dir, `${kind}-${randomBytes(4).toString("hex")}.txt`);
		await writeFile(path, text, { encoding: "utf8", mode: 0o600 });
		return { path };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

function asRecord(value: JsonInputValue): Recordish | undefined {
	return isJsonInputObject(value) ? value : undefined;
}

function safeStringify(value: JsonInputValue): string {
	try {
		// The output guard measures and spills raw MCP results; it does not render this JSON for the model.
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function textStats(text: string): TextStats {
	return { bytes: byteLength(text), lines: text.length === 0 ? 0 : text.split("\n").length };
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function positiveInt(value: JsonInputValue): number | undefined {
	if (!isRuntimeNumber(value) || !Number.isFinite(value)) return undefined;
	const integer = Math.floor(value);
	return integer > 0 ? integer : undefined;
}

function envKillSwitch(name: string): boolean | undefined {
	const value = process.env[name]?.trim().toLowerCase();
	if (!value) return undefined;
	if (["0", "false", "no", "off"].includes(value)) return false;
	if (["1", "true", "yes", "on"].includes(value)) return true;
	return undefined;
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
