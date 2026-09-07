import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	SELF_RENDERED_TRANSCRIPT_PADDING,
	TRANSCRIPT_CONTINUATION,
	TRANSCRIPT_MARKER,
} from "../conversation-ui/transcript.ts";
import type { ToolActivityOutcome } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import { DETAIL_LINE_LIMIT, ROW_PREVIEW_CODE_UNIT_LIMIT } from "./limits.ts";
import {
	type OperationBlockRowModel,
	renderOperationBlockRow,
	sameOperationBlock,
} from "./operation-block-renderer.ts";
import { boundTerminalText, graphemePrefix, sanitizeTerminalText } from "./terminal.ts";
import { oneLine } from "./tool-text.ts";

const MAX_ROW_CACHE_WIDTHS = 6;
const MAX_TRUNCATED_SUMMARY_WIDTH = 12;
const MIN_TRUNCATED_LABEL_WIDTH = 4;
const MIN_TRUNCATED_SUMMARY_WIDTH = 6;
const SELF_RENDERED_TRANSCRIPT_GUTTER = " ".repeat(SELF_RENDERED_TRANSCRIPT_PADDING);

export interface ToolRowModel {
	readonly kind?: "tool";
	readonly durationMs: number | undefined;
	readonly label: string;
	readonly state: ToolActivityState;
	readonly summary: string;
	readonly target: string;
}

export interface RetrievalGroupRowModel {
	readonly active: boolean;
	readonly elapsed?: string;
	readonly expandable: boolean;
	readonly hint?: string;
	readonly issueDetail?: string;
	readonly issueText?: string;
	readonly kind: "activity";
	readonly outcome: ToolActivityOutcome | "stopped";
	readonly semanticSummary?: string;
	readonly summary: string;
	readonly target?: string;
}

export interface BashOperationRowModel {
	readonly active: boolean;
	readonly command: string;
	readonly expandable: boolean;
	readonly expanded: boolean;
	readonly kind: "bash-operation";
	readonly output: string;
	readonly outputTruncated?: boolean;
	readonly state: ToolActivityState;
}

export type ToolTranscriptRowModel =
	| RetrievalGroupRowModel
	| BashOperationRowModel
	| OperationBlockRowModel
	| ToolRowModel;

export class EmptyToolComponent implements Component {
	invalidate(): void {}

	render(): string[] {
		return [];
	}
}

function sameModel(left: ToolTranscriptRowModel, right: ToolTranscriptRowModel): boolean {
	if (left.kind === "operation-block" || right.kind === "operation-block") {
		return left.kind === "operation-block" && right.kind === "operation-block" && sameOperationBlock(left, right);
	}
	if (left.kind === "bash-operation" || right.kind === "bash-operation") {
		return (
			left.kind === "bash-operation" &&
			right.kind === "bash-operation" &&
			left.active === right.active &&
			left.command === right.command &&
			left.expandable === right.expandable &&
			left.expanded === right.expanded &&
			left.output === right.output &&
			left.outputTruncated === right.outputTruncated &&
			left.state === right.state
		);
	}
	if (left.kind === "activity" || right.kind === "activity") {
		return (
			left.kind === "activity" &&
			right.kind === "activity" &&
			left.active === right.active &&
			left.elapsed === right.elapsed &&
			left.expandable === right.expandable &&
			left.issueDetail === right.issueDetail &&
			left.issueText === right.issueText &&
			left.outcome === right.outcome &&
			left.semanticSummary === right.semanticSummary &&
			left.summary === right.summary &&
			left.target === right.target
		);
	}
	return (
		left.label === right.label &&
		left.state === right.state &&
		left.summary === right.summary &&
		left.target === right.target
	);
}

/** Settled rows retain their already-fitted result for every recently seen width. */
export class CachedToolRow implements Component {
	private readonly cache = new Map<number, string[]>();
	private computationCountValue = 0;
	private markerVisible = true;
	private model: ToolTranscriptRowModel;
	private readonly theme: Theme;
	private visible = true;

	constructor(theme: Theme, model: ToolTranscriptRowModel) {
		this.theme = theme;
		this.model = model;
	}

	get computationCount(): number {
		return this.computationCountValue;
	}

	invalidate(): void {
		// Pi invalidates settled transcript rows during unrelated repaint work. The
		// width cache remains valid until setModel() changes semantic content.
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		const normalizedWidth = Math.max(1, Math.floor(width));
		const cached = this.cache.get(normalizedWidth);
		if (cached) return cached;
		const rendered =
			this.model.kind === "activity"
				? renderRetrievalGroupRow(this.model, this.theme, normalizedWidth, this.markerVisible)
				: this.model.kind === "operation-block"
					? renderOperationBlockRow(this.model, this.theme, normalizedWidth, this.markerVisible)
					: this.model.kind === "bash-operation"
						? renderBashOperationRow(this.model, this.theme, normalizedWidth, this.markerVisible)
						: [renderToolRow(this.model, this.theme, normalizedWidth, this.markerVisible)];
		this.computationCountValue += 1;
		this.cache.set(normalizedWidth, rendered);
		while (this.cache.size > MAX_ROW_CACHE_WIDTHS) {
			const oldest = this.cache.keys().next();
			if (oldest.done) break;
			this.cache.delete(oldest.value);
		}
		return rendered;
	}

	setModel(model: ToolTranscriptRowModel): boolean {
		if (sameModel(this.model, model)) return false;
		this.model = model;
		this.cache.clear();
		return true;
	}

	setMarkerVisible(visible: boolean): boolean {
		if (this.markerVisible === visible) return false;
		this.markerVisible = visible;
		this.cache.clear();
		return true;
	}

	setVisible(visible: boolean): boolean {
		if (this.visible === visible) return false;
		this.visible = visible;
		this.cache.clear();
		return true;
	}
}

/** Non-transcript controls retain their larger state glyph. */
export function toolStateGlyph(state: ToolActivityOutcome | ToolActivityState | "stopped"): string {
	switch (state) {
		case "running":
			return "●";
		case "success":
			return "✓";
		case "error":
			return "×";
		case "warning":
		case "rejected":
			return "!";
		case "stopped":
		case "cancelled":
			return "■";
	}
}

function styleState(theme: Theme, state: ToolActivityState, text: string): string {
	switch (state) {
		case "running":
			return theme.fg("muted", text);
		case "success":
			return theme.fg("success", text);
		case "error":
			return theme.fg("error", text);
		case "rejected":
		case "cancelled":
			return theme.fg("warning", text);
	}
}

const BASH_COMMAND_MAX_CODE_UNITS = 160;
const BASH_COMMAND_MAX_LINES = 2;
const BASH_OUTPUT_PREVIEW_LINES = 3;

function activityMarkerColor(
	outcome: ToolActivityOutcome | "stopped",
): "dim" | "error" | "muted" | "success" | "warning" {
	if (outcome === "error") return "error";
	if (outcome === "success") return "success";
	if (outcome === "warning") return "warning";
	if (outcome === "stopped") return "dim";
	return "muted";
}

function renderRetrievalGroupRow(
	model: RetrievalGroupRowModel,
	theme: Theme,
	width: number,
	markerVisible: boolean,
): string[] {
	if (!model.summary) return [];
	const marker = model.active && !markerVisible ? " " : TRANSCRIPT_MARKER;
	const markerSlot = `${SELF_RENDERED_TRANSCRIPT_GUTTER}${theme.fg(activityMarkerColor(model.outcome), marker)} `;
	const contentWidth = Math.max(1, width - visibleWidth(markerSlot));
	const semantic = oneLine(model.semanticSummary ?? model.summary);
	const issue = oneLine(model.issueText ?? "");
	const expandHint = model.expandable ? "  (ctrl+o to expand)" : "";
	let content = semantic;

	if (issue) {
		const separator = semantic ? " · " : "";
		if (visibleWidth(`${semantic}${separator}${issue}`) > contentWidth) {
			const reserved = visibleWidth(issue) + visibleWidth(separator);
			content =
				semantic && reserved < contentWidth
					? `${truncateToWidth(semantic, contentWidth - reserved, "…")}${separator}${issue}`
					: truncateToWidth(issue, contentWidth, "…");
		} else {
			content = `${semantic}${separator}${issue}`;
		}
		if (expandHint && visibleWidth(`${content}${expandHint}`) <= contentWidth) content += expandHint;
	} else if (model.active) {
		content = `${semantic}…`;
		const elapsed = oneLine(model.elapsed ?? "");
		const target = oneLine(model.target ?? model.hint ?? "");
		if (elapsed && visibleWidth(`${content} · ${elapsed}`) <= contentWidth) content += ` · ${elapsed}`;
		if (
			target &&
			(!elapsed || content.endsWith(` · ${elapsed}`)) &&
			visibleWidth(`${content} · ${target}`) <= contentWidth
		) {
			content += ` · ${target}`;
		}
	} else if (expandHint && visibleWidth(`${content}${expandHint}`) <= contentWidth) {
		content += expandHint;
	}

	const first = `${markerSlot}${truncateToWidth(theme.fg(model.active ? "text" : "muted", content), contentWidth, "…")}`;
	if (!issue) return [first];
	const detailPrefix = `${SELF_RENDERED_TRANSCRIPT_GUTTER}${TRANSCRIPT_CONTINUATION}⎿ `;
	const detailWidth = Math.max(1, width - visibleWidth(detailPrefix));
	const detail = oneLine(model.issueDetail ?? model.hint ?? "") || issue;
	return [first, `${detailPrefix}${truncateToWidth(theme.fg("dim", detail), detailWidth, "…")}`];
}

function bashCommandLines(command: string, expanded: boolean): string[] {
	const maximumCodeUnits = expanded ? ROW_PREVIEW_CODE_UNIT_LIMIT : BASH_COMMAND_MAX_CODE_UNITS;
	const maximumLines = expanded ? DETAIL_LINE_LIMIT : BASH_COMMAND_MAX_LINES;
	const source = command.slice(0, (maximumCodeUnits + 1) * 4);
	const sourceTruncated = source.length < command.length;
	const safe = boundTerminalText(source, maximumCodeUnits + 1, "").trim();
	const clipped = graphemePrefix(safe, maximumCodeUnits);
	const truncatedByCodeUnits = sourceTruncated || clipped.length < safe.length;
	const sourceLines = clipped.split("\n");
	const truncatedByLines = sourceLines.length > maximumLines;
	const lines = sourceLines.slice(0, maximumLines);
	if (lines.length === 0) lines.push("");
	if (truncatedByCodeUnits || truncatedByLines) {
		const last = lines.length - 1;
		lines[last] = `${lines[last]?.trimEnd() ?? ""}…`;
	}
	const last = lines.length - 1;
	lines[last] = `${lines[last] ?? ""})`;
	return lines;
}

function bashOutputLines(model: BashOperationRowModel) {
	const normalized = boundTerminalText(model.output, ROW_PREVIEW_CODE_UNIT_LIMIT, "")
		.replaceAll("\r", "")
		.split("\n", DETAIL_LINE_LIMIT + 1)
		.slice(0, DETAIL_LINE_LIMIT)
		.join("\n")
		.trim();
	if (!normalized || normalized === "(no output)") {
		return { hidden: 0, lines: [model.active ? "Running…" : "(No output)"], truncated: false };
	}
	let lines = normalized.split("\n");
	if (model.state === "rejected") {
		lines = ["Rejected", ...lines];
		const visible = model.expanded ? lines : lines.slice(0, BASH_OUTPUT_PREVIEW_LINES);
		return {
			hidden: model.expanded ? 0 : Math.max(0, lines.length - visible.length),
			lines: visible,
			truncated: model.outputTruncated === true,
		};
	}
	if (model.state === "cancelled") {
		const cancellationLine = lines.at(-1)?.trim();
		if (cancellationLine === "Command aborted" || cancellationLine === "Operation aborted") {
			lines = lines.slice(0, -1);
			while (lines.at(-1)?.trim() === "") lines.pop();
		}
		if (!lines.some((line) => line.trim() === "Interrupted")) lines.unshift("Interrupted");
	}
	const terminal = lines.at(-1)?.trim() ?? "";
	const exit = /^Command exited with code (\d+)$/u.exec(terminal);
	if (exit) {
		lines = lines.slice(0, -1);
		while (lines.at(-1)?.trim() === "") lines.pop();
		if (model.state !== "cancelled") lines.unshift(`Error: Exit code ${exit[1] ?? "?"}`);
	} else if (terminal === "Command aborted" || terminal.startsWith("Command timed out")) {
		lines = lines.slice(0, -1);
		while (lines.at(-1)?.trim() === "") lines.pop();
		lines.unshift(terminal === "Command aborted" ? "Interrupted" : `Error: ${terminal}`);
	}
	const hidden = model.expanded ? 0 : Math.max(0, lines.length - BASH_OUTPUT_PREVIEW_LINES);
	return {
		hidden,
		lines: model.expanded ? lines : lines.slice(0, BASH_OUTPUT_PREVIEW_LINES),
		truncated: model.outputTruncated === true,
	};
}

function renderBashOperationRow(
	model: BashOperationRowModel,
	theme: Theme,
	width: number,
	markerVisible: boolean,
): string[] {
	const marker = model.active && !markerVisible ? " " : TRANSCRIPT_MARKER;
	const markerSlot = `${SELF_RENDERED_TRANSCRIPT_GUTTER}${styleState(theme, model.state, marker)} `;
	const label = "Bash";
	const headerPrefix = `${markerSlot}${theme.bold(label)}(`;
	const continuationPrefix = `${SELF_RENDERED_TRANSCRIPT_GUTTER}${" ".repeat(visibleWidth(label) + 1)}`;
	const commandLines = bashCommandLines(model.command, model.expanded);
	const rendered: string[] = [];
	for (const [index, sourceLine] of commandLines.entries()) {
		const prefix = index === 0 ? headerPrefix : continuationPrefix;
		const available = Math.max(1, width - visibleWidth(prefix));
		const wrapped = wrapTextWithAnsi(theme.fg("text", sourceLine), available);
		for (const [wrapIndex, line] of wrapped.entries()) {
			rendered.push(`${wrapIndex === 0 ? prefix : continuationPrefix}${line}`);
		}
	}
	const preview = bashOutputLines(model);
	// Pi's self-rendered Tool row already follows the one-cell Host outputPad. Bash
	// child rows use Claude's own two-cell operation gutter so their connector and
	// text origins match the reference even though Pi Stuff keeps its accepted `•`.
	const outputPrefix = theme.fg("muted", `${TRANSCRIPT_CONTINUATION}⎿  `);
	const outputContinuation = `${SELF_RENDERED_TRANSCRIPT_GUTTER}${TRANSCRIPT_CONTINUATION}${" ".repeat(visibleWidth("⎿ "))}`;
	const outputWidth = Math.max(1, width - visibleWidth(outputPrefix));
	for (const [index, outputLine] of preview.lines.entries()) {
		const colored = theme.fg(
			model.state !== "success" && model.state !== "running"
				? model.state === "error"
					? "error"
					: "warning"
				: model.active
					? "muted"
					: outputLine === "(No output)"
						? "muted"
						: "text",
			outputLine,
		);
		const wrapped = wrapTextWithAnsi(colored, outputWidth);
		for (const [wrapIndex, line] of wrapped.entries()) {
			rendered.push(`${index === 0 && wrapIndex === 0 ? outputPrefix : outputContinuation}${line}`);
		}
	}
	if (preview.hidden > 0 || preview.truncated) {
		const detail = preview.truncated ? "more output" : `+${String(preview.hidden)} lines`;
		const hint = model.expanded ? " (output capped)" : model.expandable ? " (ctrl+o to expand)" : "";
		rendered.push(`${outputContinuation}${theme.fg("dim", `… ${detail}${hint}`)}`);
	}
	return rendered.map((line) => truncateToWidth(line, width, "…"));
}

function fitIdentity(markerSlot: string, label: string, width: number): string {
	const markerWidth = visibleWidth(markerSlot);
	if (width <= markerWidth) return truncateToWidth(markerSlot, width, "");
	return `${markerSlot}${truncateToWidth(label, width - markerWidth, "…")}`;
}

function fitIdentityAndSummary(markerSlot: string, label: string, summary: string, width: number): string {
	const markerWidth = visibleWidth(markerSlot);
	const separator = " · ";
	const separatorWidth = visibleWidth(separator);
	const available = width - markerWidth - separatorWidth;
	if (available <= 1) return fitIdentity(markerSlot, label, width);

	const summaryWidth = visibleWidth(summary);
	const minimumSummaryWidth = Math.min(summaryWidth, MIN_TRUNCATED_SUMMARY_WIDTH);
	const labelFloor = Math.min(MIN_TRUNCATED_LABEL_WIDTH, Math.max(1, available - minimumSummaryWidth));
	const maximumSummaryWidth = available - labelFloor;
	if (maximumSummaryWidth < minimumSummaryWidth) return fitIdentity(markerSlot, label, width);

	const summaryBudget = Math.min(summaryWidth, MAX_TRUNCATED_SUMMARY_WIDTH, maximumSummaryWidth);
	const fittedSummary = truncateToWidth(summary, summaryBudget, "…");
	const labelBudget = Math.max(1, available - visibleWidth(fittedSummary));
	return `${markerSlot}${truncateToWidth(label, labelBudget, "…")}${separator}${fittedSummary}`;
}

/** Use the complete target budget without splitting terminal graphemes. */
function fitOptionalTarget(targetPart: string, width: number): string {
	const budget = Math.max(0, Math.floor(width));
	if (budget === 0) return "";
	if (visibleWidth(targetPart) <= budget) return targetPart;
	const fitted = truncateToWidth(targetPart, budget, "…");
	return /[\p{L}\p{N}\p{Extended_Pictographic}]/u.test(sanitizeTerminalText(fitted)) ? fitted : "";
}

/** Fit one Tool row with identity first, result second, and optional target last. */
function fitToolRowParts(markerSlot: string, label: string, target: string, summary: string, width: number): string {
	const identity = `${markerSlot}${label}`;
	if (visibleWidth(identity) >= width) {
		return summary ? fitIdentityAndSummary(markerSlot, label, summary, width) : fitIdentity(markerSlot, label, width);
	}

	const targetPart = target ? ` ${target}` : "";
	const summaryPart = summary ? ` · ${summary}` : "";
	const full = `${identity}${targetPart}${summaryPart}`;
	if (visibleWidth(full) <= width) return full;

	const remaining = width - visibleWidth(identity);
	if (!summary) return `${identity}${fitOptionalTarget(targetPart, remaining)}`;

	const summarySeparator = " · ";
	const separatorWidth = visibleWidth(summarySeparator);
	if (remaining <= separatorWidth) return fitIdentityAndSummary(markerSlot, label, summary, width);
	const fullSummaryPart = `${summarySeparator}${summary}`;
	const fullSummaryWidth = visibleWidth(fullSummaryPart);
	if (fullSummaryWidth > remaining) return fitIdentityAndSummary(markerSlot, label, summary, width);

	const targetBudget = remaining - fullSummaryWidth;
	const fittedTarget = fitOptionalTarget(targetPart, targetBudget);
	return `${identity}${fittedTarget}${fullSummaryPart}`;
}

function renderToolRow(model: ToolRowModel, theme: Theme, width: number, markerVisible: boolean): string {
	const marker = model.state === "running" && !markerVisible ? " " : TRANSCRIPT_MARKER;
	const markerSlot = `${SELF_RENDERED_TRANSCRIPT_GUTTER}${styleState(theme, model.state, marker)} `;
	const safeLabel = oneLine(model.label);
	const safeTarget = oneLine(model.target);
	const safeSummary = oneLine(model.summary);
	const label = theme.fg("toolTitle", theme.bold(safeLabel));
	const target = safeTarget ? theme.fg("muted", safeTarget) : "";
	const summary =
		model.state === "success" ? theme.fg("muted", safeSummary) : styleState(theme, model.state, safeSummary);
	return fitToolRowParts(markerSlot, label, target, summary, width);
}
