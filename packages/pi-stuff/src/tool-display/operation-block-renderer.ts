import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	SELF_RENDERED_TRANSCRIPT_PADDING,
	TRANSCRIPT_CONTINUATION,
	TRANSCRIPT_MARKER,
} from "../conversation-ui/transcript.ts";
import type { ToolActivityState } from "./activity-store.ts";
import type { OperationEvidenceLine } from "./contract.ts";
import { ROW_PREVIEW_CODE_UNIT_LIMIT } from "./limits.ts";
import { boundTerminalText, graphemePrefix, sanitizeTerminalText } from "./terminal.ts";

export type { OperationEvidenceLine } from "./contract.ts";

const COMPACT_IDENTITY_CODE_UNITS = 160;
const COMPACT_IDENTITY_LINES = 2;
const GUTTER = " ".repeat(SELF_RENDERED_TRANSCRIPT_PADDING);

export interface OperationBlockRowModel {
	readonly active: boolean;
	readonly evidence: readonly OperationEvidenceLine[];
	readonly expandable: boolean;
	readonly expanded: boolean;
	readonly identity: string;
	readonly identityCodeUnits?: number;
	readonly identityLineLimit?: number;
	readonly identityMultiline?: boolean;
	readonly kind: "operation-block";
	readonly label: string;
	readonly languagePath?: string;
	readonly state: ToolActivityState;
}

export function sameOperationBlock(left: OperationBlockRowModel, right: OperationBlockRowModel): boolean {
	return (
		left.active === right.active &&
		left.expandable === right.expandable &&
		left.expanded === right.expanded &&
		left.identity === right.identity &&
		left.identityCodeUnits === right.identityCodeUnits &&
		left.identityLineLimit === right.identityLineLimit &&
		left.identityMultiline === right.identityMultiline &&
		left.label === right.label &&
		left.languagePath === right.languagePath &&
		left.state === right.state &&
		left.evidence.length === right.evidence.length &&
		left.evidence.every((line, index) => {
			const other = right.evidence[index];
			return (
				other !== undefined &&
				line.diffKind === other.diffKind &&
				line.kind === other.kind &&
				line.languagePath === other.languagePath &&
				line.newLine === other.newLine &&
				line.oldLine === other.oldLine &&
				line.text === other.text &&
				line.tone === other.tone
			);
		})
	);
}

function stateColor(state: ToolActivityState): "error" | "muted" | "success" | "warning" {
	if (state === "error") return "error";
	if (state === "rejected" || state === "cancelled") return "warning";
	if (state === "success") return "success";
	return "muted";
}

function identityLines(model: OperationBlockRowModel): string[] {
	const maximumCodeUnits =
		model.identityCodeUnits ?? (model.expanded ? ROW_PREVIEW_CODE_UNIT_LIMIT : COMPACT_IDENTITY_CODE_UNITS);
	const maximumLines = model.identityMultiline
		? model.expanded
			? (model.identityLineLimit ?? 240)
			: COMPACT_IDENTITY_LINES
		: 1;
	const source = model.identity.slice(0, (maximumCodeUnits + 1) * 4);
	const sourceTruncated = source.length < model.identity.length;
	const safe = boundTerminalText(source, maximumCodeUnits + 1, "").trim();
	const clipped = graphemePrefix(safe, maximumCodeUnits);
	const sourceLines = clipped.split("\n");
	const lines = sourceLines.slice(0, maximumLines);
	if (lines.length === 0) lines.push("");
	if (sourceTruncated || clipped.length < safe.length || sourceLines.length > maximumLines) {
		const last = lines.length - 1;
		lines[last] = `${lines[last]?.trimEnd() ?? ""}…`;
	}
	const last = lines.length - 1;
	lines[last] = `${lines[last] ?? ""})`;
	return lines;
}

function highlightedEvidence(evidence: readonly OperationEvidenceLine[], fallbackPath?: string): string[] {
	const source = evidence.filter((line) => line.kind === "source" || line.kind === "diff");
	const highlighted: string[] = [];
	for (let start = 0; start < source.length; ) {
		const path = sanitizeTerminalText(source[start]?.languagePath ?? fallbackPath ?? "");
		let end = start + 1;
		while (end < source.length && sanitizeTerminalText(source[end]?.languagePath ?? fallbackPath ?? "") === path) {
			end += 1;
		}
		const lines = source.slice(start, end).map((line) => sanitizeTerminalText(line.text));
		const language = path ? getLanguageFromPath(path) : undefined;
		highlighted.push(...(language ? highlightCode(lines.join("\n"), language) : lines));
		start = end;
	}
	return highlighted;
}

function lineNumberWidth(evidence: readonly OperationEvidenceLine[]): number {
	let maximum = 1;
	for (const line of evidence) maximum = Math.max(maximum, line.oldLine ?? 0, line.newLine ?? 0);
	return String(maximum).length;
}

export function styleOperationEvidence(
	evidence: readonly OperationEvidenceLine[],
	theme: Theme,
	state: ToolActivityState,
	languagePath?: string,
): string[] {
	const highlighted = highlightedEvidence(evidence, languagePath);
	const numberWidth = lineNumberWidth(evidence);
	let sourceIndex = 0;
	return evidence.map((line) => {
		const safeText = sanitizeTerminalText(line.text);
		if (line.kind === "source") {
			const number = String(line.newLine ?? line.oldLine ?? "").padStart(numberWidth);
			const gutter = theme.fg("dim", `${number} │ `);
			const content = highlighted[sourceIndex] ?? safeText;
			sourceIndex += 1;
			return `${gutter}${content}`;
		}
		if (line.kind === "diff") {
			const oldLine = String(line.oldLine ?? "").padStart(numberWidth);
			const newLine = String(line.newLine ?? "").padStart(numberWidth);
			const marker = line.diffKind === "add" ? "+" : line.diffKind === "delete" ? "-" : " ";
			const markerColor = marker === "+" ? "success" : marker === "-" ? "error" : "dim";
			const content = highlighted[sourceIndex] ?? safeText;
			sourceIndex += 1;
			return `${theme.fg("dim", `${oldLine} ${newLine} │ `)}${theme.fg(markerColor, marker)} ${content}`;
		}
		const color = line.tone ?? (line.kind === "outcome" ? stateColor(state) : "muted");
		return theme.fg(color, safeText);
	});
}

function renderEvidence(
	model: OperationBlockRowModel,
	theme: Theme,
	width: number,
	firstPrefix: string,
	continuationPrefix: string,
): string[] {
	const rendered: string[] = [];
	const styled = styleOperationEvidence(model.evidence, theme, model.state, model.languagePath);
	for (const [index, content] of styled.entries()) {
		const prefix = index === 0 ? firstPrefix : continuationPrefix;
		const available = Math.max(1, width - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(content, available);
		for (const [wrapIndex, value] of wrapped.entries()) {
			rendered.push(`${wrapIndex === 0 ? prefix : continuationPrefix}${value}`);
		}
	}
	return rendered;
}

export function renderOperationBlockRow(
	model: OperationBlockRowModel,
	theme: Theme,
	width: number,
	markerVisible: boolean,
): string[] {
	const marker = model.active && !markerVisible ? " " : TRANSCRIPT_MARKER;
	const markerSlot = `${GUTTER}${theme.fg(stateColor(model.state), marker)} `;
	const headerPrefix = `${markerSlot}${theme.bold(model.label)}(`;
	const continuationPrefix = `${GUTTER}${" ".repeat(visibleWidth(model.label) + 1)}`;
	const rendered: string[] = [];
	for (const [index, sourceLine] of identityLines(model).entries()) {
		const prefix = index === 0 ? headerPrefix : continuationPrefix;
		const available = Math.max(1, width - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(theme.fg("text", sourceLine), available);
		for (const [wrapIndex, line] of wrapped.entries()) {
			rendered.push(`${wrapIndex === 0 ? prefix : continuationPrefix}${line}`);
		}
	}
	const childPrefix = theme.fg("muted", `${TRANSCRIPT_CONTINUATION}⎿  `);
	const childContinuation = `${GUTTER}${TRANSCRIPT_CONTINUATION}${" ".repeat(visibleWidth("⎿ "))}`;
	rendered.push(...renderEvidence(model, theme, width, childPrefix, childContinuation));
	return rendered.map((line) => truncateToWidth(line, width, "…"));
}
