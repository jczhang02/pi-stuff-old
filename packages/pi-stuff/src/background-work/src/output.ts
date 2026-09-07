import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { sanitizeTerminalWhitespace as sanitizeTerminalText } from "../../shared/terminal-text.ts";
import { readRollingOutput, utf8SafeTail, visibleOmissionMarker } from "./rolling-output.ts";

export {
	BoundedOutputFile,
	boundedTextTail,
	DEFAULT_MODEL_OUTPUT_LIMIT,
	tryReadBoundedTail,
	utf8SafePrefix,
	utf8SafeTail,
} from "./rolling-output.ts";
export { sanitizeTerminalText };

interface BufferTruncation {
	readonly retainedBytes: number;
	readonly truncation: TruncationResult;
}

function splitBufferLines(buffer: Buffer): Buffer[] {
	if (buffer.length === 0) return [];
	const lines: Buffer[] = [];
	let start = 0;
	for (;;) {
		const end = buffer.indexOf(0x0a, start);
		if (end < 0) break;
		lines.push(buffer.subarray(start, end));
		start = end + 1;
	}
	if (start < buffer.length) lines.push(buffer.subarray(start));
	return lines;
}

function decodedTail(buffer: Buffer, maxBytes: number) {
	let selected = utf8SafeTail(buffer, maxBytes);
	let text = selected.toString("utf8");
	let bytes = Buffer.byteLength(text, "utf8");
	while (bytes > maxBytes && selected.length > 0) {
		const nextBytes = Math.max(1, selected.length - Math.max(1, Math.ceil((bytes - maxBytes) / 3)));
		selected = utf8SafeTail(selected, nextBytes);
		text = selected.toString("utf8");
		bytes = Buffer.byteLength(text, "utf8");
	}
	return { buffer: selected, text };
}

function truncateBufferTail(buffer: Buffer): BufferTruncation {
	const raw = buffer.toString("utf8");
	const renderedBytes = Buffer.byteLength(raw, "utf8");
	const totalBytes = buffer.length;
	const lines = splitBufferLines(buffer);
	const totalLines = lines.length;
	const trailingNewline = buffer.at(-1) === 0x0a;
	if (totalLines <= DEFAULT_MAX_LINES && renderedBytes <= DEFAULT_MAX_BYTES) {
		return {
			retainedBytes: buffer.length,
			truncation: {
				content: raw,
				firstLineExceedsLimit: false,
				lastLinePartial: false,
				maxBytes: DEFAULT_MAX_BYTES,
				maxLines: DEFAULT_MAX_LINES,
				outputBytes: renderedBytes,
				outputLines: totalLines,
				totalBytes,
				totalLines,
				truncated: false,
				truncatedBy: null,
			},
		};
	}

	const selected: Array<{ buffer: Buffer; text: string }> = [];
	let outputBytes = 0;
	let retainedBytes = 0;
	let lastLinePartial = false;
	let truncatedBy: "bytes" | "lines" = "lines";
	for (let index = lines.length - 1; index >= 0 && selected.length < DEFAULT_MAX_LINES; index -= 1) {
		const line = lines[index];
		if (line === undefined) continue;
		const text = line.toString("utf8");
		const separatorBytes = selected.length > 0 || trailingNewline ? 1 : 0;
		const lineBytes = Buffer.byteLength(text, "utf8") + separatorBytes;
		if (outputBytes + lineBytes > DEFAULT_MAX_BYTES) {
			truncatedBy = "bytes";
			if (selected.length === 0) {
				const suffixBytes = trailingNewline ? 1 : 0;
				const partial = decodedTail(line, DEFAULT_MAX_BYTES - suffixBytes);
				selected.unshift(partial);
				outputBytes = Buffer.byteLength(partial.text, "utf8") + suffixBytes;
				retainedBytes = partial.buffer.length + suffixBytes;
				lastLinePartial = true;
			}
			break;
		}
		selected.unshift({ buffer: line, text });
		outputBytes += lineBytes;
		retainedBytes += line.length + separatorBytes;
	}
	return {
		retainedBytes,
		truncation: {
			content: selected.map((line) => line.text).join("\n") + (trailingNewline ? "\n" : ""),
			firstLineExceedsLimit: false,
			lastLinePartial,
			maxBytes: DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
			outputBytes,
			outputLines: selected.length,
			totalBytes,
			totalLines,
			truncated: true,
			truncatedBy,
		},
	};
}

export function foregroundOutputSnapshot(outputPath: string | undefined, recentOutput: string | undefined) {
	if (!outputPath) return { text: recentOutput ?? "" };
	const output = readRollingOutput(outputPath);
	if (!output) return { text: recentOutput ?? "" };
	const { retainedBytes, truncation } = truncateBufferTail(output.buffer);
	const projectedBytesOmitted = output.buffer.length - retainedBytes;
	const prefix = output.omittedBytes > 0 ? visibleOmissionMarker(output.omittedBytes + projectedBytesOmitted) : "";
	if (!truncation.truncated) {
		return output.omittedBytes > 0
			? {
					details: {
						omittedBytes: output.omittedBytes,
						retainedOutputPath: outputPath,
						truncation: {
							...truncation,
							totalBytes: output.omittedBytes + output.buffer.length,
							truncated: true,
							truncatedBy: "bytes" as const,
						},
					},
					text: prefix + truncation.content,
				}
			: { text: truncation.content };
	}
	const startLine = truncation.totalLines - truncation.outputLines + 1;
	const endLine = truncation.totalLines;
	const outputLabel = output.omittedBytes > 0 ? "Retained output" : "Full output";
	let footer: string;
	if (truncation.lastLinePartial) {
		footer = `Showing last ${formatSize(truncation.outputBytes)} of line ${String(endLine)}. ${outputLabel}: ${outputPath}`;
	} else if (truncation.truncatedBy === "lines") {
		footer = `Showing lines ${String(startLine)}-${String(endLine)} of ${String(truncation.totalLines)}. ${outputLabel}: ${outputPath}`;
	} else {
		footer = `Showing lines ${String(startLine)}-${String(endLine)} of ${String(truncation.totalLines)} (${formatSize(DEFAULT_MAX_BYTES)} limit). ${outputLabel}: ${outputPath}`;
	}
	const details =
		output.omittedBytes > 0
			? {
					omittedBytes: output.omittedBytes,
					retainedOutputPath: outputPath,
					truncation: { ...truncation, totalBytes: output.omittedBytes + output.buffer.length },
				}
			: { fullOutputPath: outputPath, truncation };
	return { details, text: `${prefix + truncation.content}\n\n[${footer}]` };
}
