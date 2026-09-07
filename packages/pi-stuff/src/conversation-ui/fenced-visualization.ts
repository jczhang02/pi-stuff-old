import { renderTreeSource } from "./indentation-tree.ts";
import { renderChartSource } from "./unicode-chart.ts";

const TARGET_FENCE = /(?:^|\n) {0,3}(?:\x60{3,}|~{3,})[\t ]*(?:chart|tree)(?=[\t \r\n]|$)/iu;
const OPENING_FENCE = /^( {0,3})(\x60{3,}|~{3,})[^\S\r\n]*(.*)$/u;
const BACKTICK = String.fromCharCode(0x60);
const MAX_SOURCE_LENGTH = 12_000;
const MAX_PROJECTED_BLOCKS = 16;
const MAX_LANGUAGE_VARIANT = 32;
const VISUALIZATION_CODE_LANGUAGE = "pi-stuff-visualization";

type FenceCharacter = "backtick" | "tilde";
type VisualizationLanguage = "chart" | "tree";

interface Fence {
	readonly character: FenceCharacter;
	readonly length: number;
}

interface OpeningFence {
	readonly fence: Fence;
	readonly indentation: number;
	readonly language: string;
}

export interface ProjectedVisualizationBlock {
	readonly firstLine: string;
	readonly language: string;
}

export interface FencedVisualizationProjection {
	readonly markdown: string;
	readonly projectedBlocks: readonly ProjectedVisualizationBlock[];
}

/** Project complete chart/tree fences into safe Markdown while preserving canonical source. */
export function projectFencedVisualizations(
	markdown: string,
	availableWidth: number,
	measureWidth: (value: string) => number,
): string {
	return prepareFencedVisualizations(markdown, availableWidth, measureWidth).markdown;
}

/** Return projection metadata needed by the owning Host Markdown adapter. */
export function prepareFencedVisualizations(
	markdown: string,
	availableWidth: number,
	measureWidth: (value: string) => number,
): FencedVisualizationProjection {
	if (!Number.isFinite(availableWidth) || availableWidth < 1 || !TARGET_FENCE.test(markdown)) {
		return { markdown, projectedBlocks: [] };
	}
	const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
	const lines = markdown.split(/\r?\n/u);
	const output: string[] = [];
	const projectedBlocks: ProjectedVisualizationBlock[] = [];
	const projectionLanguage = selectProjectionLanguage(lines);
	if (!projectionLanguage) return { markdown, projectedBlocks: [] };

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const opening = parseOpeningFence(line);
		if (!opening) {
			output.push(line);
			continue;
		}

		const close = findClosingFence(lines, index + 1, opening.fence);
		if (close === undefined) {
			output.push(...lines.slice(index));
			break;
		}
		const language = visualizationLanguage(opening.language);
		if (!language) {
			output.push(...lines.slice(index, close + 1));
			index = close;
			continue;
		}

		if (projectedBlocks.length >= MAX_PROJECTED_BLOCKS) {
			output.push(...lines.slice(index, close + 1));
			index = close;
			continue;
		}
		if (sourceLengthExceedsLimit(lines, index + 1, close)) {
			output.push(...lines.slice(index, close + 1));
			index = close;
			continue;
		}
		const source = lines.slice(index + 1, close).join("\n");
		const width = Math.max(0, Math.floor(availableWidth) - opening.indentation);
		const rendered = sourceIsSafe(source) ? renderVisualization(language, source, width, measureWidth) : [];
		if (rendered.length === 0) {
			output.push(...lines.slice(index, close + 1));
		} else {
			output.push(...markdownCodeBlock(rendered, opening.indentation, projectionLanguage));
			projectedBlocks.push({ firstLine: rendered[0] ?? "", language: projectionLanguage });
		}
		index = close;
	}
	return {
		markdown: projectedBlocks.length > 0 ? output.join(newline) : markdown,
		projectedBlocks,
	};
}

function sourceLengthExceedsLimit(lines: readonly string[], start: number, end: number): boolean {
	let length = Math.max(0, end - start - 1);
	for (let index = start; index < end; index += 1) {
		length += lines[index]?.length ?? 0;
		if (length > MAX_SOURCE_LENGTH) return true;
	}
	return false;
}

function visualizationLanguage(value: string): VisualizationLanguage | undefined {
	if (value === "chart" || value === "tree") return value;
	return undefined;
}

function renderVisualization(
	language: VisualizationLanguage,
	source: string,
	width: number,
	measureWidth: (value: string) => number,
): readonly string[] {
	return language === "chart"
		? renderChartSource(source, width, measureWidth)
		: renderTreeSource(source, width, measureWidth);
}

function parseOpeningFence(line: string): OpeningFence | undefined {
	const match = OPENING_FENCE.exec(line);
	const marker = match?.[2];
	if (!marker) return undefined;
	const character: FenceCharacter = marker.charCodeAt(0) === 0x60 ? "backtick" : "tilde";
	const info = (match[3] ?? "").trim();
	if (character === "backtick" && info.includes(BACKTICK)) return undefined;
	return {
		fence: { character, length: marker.length },
		indentation: match[1]?.length ?? 0,
		language: info.split(/\s+/u, 1)[0]?.toLowerCase() ?? "",
	};
}

function findClosingFence(lines: readonly string[], start: number, fence: Fence): number | undefined {
	const marker = fence.character === "backtick" ? BACKTICK : "~";
	for (let index = start; index < lines.length; index += 1) {
		const trimmed = (lines[index] ?? "").replace(/^ {0,3}/u, "").trimEnd();
		if (trimmed.length < fence.length) continue;
		let valid = true;
		for (const character of trimmed) {
			if (character !== marker) {
				valid = false;
				break;
			}
		}
		if (valid) return index;
	}
	return undefined;
}

function sourceIsSafe(source: string): boolean {
	for (let index = 0; index < source.length; index += 1) {
		const code = source.charCodeAt(index);
		if (
			(code < 0x20 && code !== 0x09 && code !== 0x0a) ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x061c ||
			code === 0x200b ||
			code === 0x200e ||
			code === 0x200f ||
			code === 0x2028 ||
			code === 0x2029 ||
			(code >= 0x202a && code <= 0x202e) ||
			(code >= 0x2066 && code <= 0x2069) ||
			code === 0xfeff
		) {
			return false;
		}
	}
	return true;
}

function selectProjectionLanguage(lines: readonly string[]): string | undefined {
	const occupied = new Uint8Array(MAX_LANGUAGE_VARIANT + 1);
	for (const line of lines) {
		const language = parseOpeningFence(line)?.language;
		if (language === VISUALIZATION_CODE_LANGUAGE) {
			occupied[0] = 1;
			continue;
		}
		const prefix = `${VISUALIZATION_CODE_LANGUAGE}-`;
		if (!language?.startsWith(prefix)) continue;
		const suffix = language.slice(prefix.length);
		const variant = Number(suffix);
		if (Number.isInteger(variant) && variant > 0 && variant <= MAX_LANGUAGE_VARIANT && suffix === String(variant)) {
			occupied[variant] = 1;
		}
	}
	for (let variant = 0; variant <= MAX_LANGUAGE_VARIANT; variant += 1) {
		if (occupied[variant] === 0) {
			return variant === 0 ? VISUALIZATION_CODE_LANGUAGE : `${VISUALIZATION_CODE_LANGUAGE}-${String(variant)}`;
		}
	}
	return undefined;
}

function markdownCodeBlock(lines: readonly string[], indentationWidth: number, language: string): readonly string[] {
	let longestRun = 2;
	for (const line of lines) {
		for (const match of line.matchAll(/\x60+/gu)) longestRun = Math.max(longestRun, match[0].length);
	}
	const indentation = " ".repeat(indentationWidth);
	const delimiter = BACKTICK.repeat(longestRun + 1);
	return [
		`${indentation}${delimiter}${language}`,
		...lines.slice(1).map((line) => `${indentation}${line}`),
		`${indentation}${delimiter}`,
	];
}
