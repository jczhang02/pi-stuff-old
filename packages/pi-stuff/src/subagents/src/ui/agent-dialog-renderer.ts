import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type CommandDialogViewContext,
	commandDialogPrimaryKey,
	commandDialogReadOnlyPageHint,
	commandDialogRows,
	commandDialogSectionHeading,
	fitCommandDialogRows,
	fitFixedCommandDialogRows,
} from "../../../conversation-ui/index.ts";
import { isRuntimeNumber } from "../../../shared/runtime-type.ts";
import { boundTerminalText as boundTerminalPreview } from "../../../tool-display/index.ts";
import type { AgentNestedDetail, AgentRow, AgentSessionSnapshot, AgentStatus } from "../session/current-agents.ts";
import { boundedTerminalLine, isTaskOnlyAgentText } from "../shared/display-description.ts";
import { fitAgentDescription } from "./agent-roster.ts";

const GUTTER = "  ";
const NARROW_WIDTH = 64;
export const AGENT_LIST_ROWS = 8;
const NARROW_LIST_ROWS = 6;
const AGENT_DIALOG_ROWS = 20;
const TOOL_RESULT_PREVIEW_CHARS = 4_000;
const TOOL_RESULT_PREVIEW_LINES = 8;

export const TERMINAL_STATUSES = new Set<AgentStatus>([
	"agent_stopped",
	"completed",
	"crashed",
	"failed",
	"user_cancelled",
]);
export const RESUMABLE_STATUSES = new Set<AgentStatus>(["agent_stopped", "completed", "crashed", "failed"]);

export type AgentToolOutcome = "cancelled" | "completed" | "failed" | "rejected" | "running";

export type AgentTranscriptItem =
	| { readonly kind: "message"; readonly speaker: string | null; readonly text: string }
	| {
			readonly kind: "tool";
			readonly name: string;
			readonly outcome: AgentToolOutcome;
			readonly result: string;
			readonly target: string;
	  }
	| { readonly kind: "notice"; readonly text: string };

export type DialogMode = "detail" | "list" | "nested-detail" | "nested-list" | "resume-input" | "steer-input";
type FeedbackKind = "error" | "pending" | "success";
type TranscriptState = "error" | "loading" | "ready" | "unavailable";

export interface Feedback {
	readonly kind: FeedbackKind;
	readonly message: string;
}

export interface Transcript {
	readonly items: readonly AgentTranscriptItem[];
	readonly state: TranscriptState;
	readonly text: string;
}

export interface AgentDialogRenderMetrics {
	lastDetailMaxOffset: number;
	lastDetailViewportRows: number;
	listPageRows: number;
	nestedListPageRows: number;
	scrollOffset: number;
}

export interface AgentDialogRenderState {
	readonly feedback: Feedback | undefined;
	readonly followActivity: boolean;
	readonly input: string;
	readonly listSelectedKey: string | undefined;
	readonly maxTranscriptChars: number;
	readonly metrics: AgentDialogRenderMetrics;
	readonly mode: DialogMode;
	readonly nestedSelectedKey: string | undefined;
	readonly selectedKey: string | undefined;
	readonly showToolDetails: boolean;
	readonly snapshotValue: AgentSessionSnapshot;
	readonly transcript: Transcript;
}

export function renderAgentDialog(
	context: CommandDialogViewContext<void>,
	markdown: Markdown,
	state: AgentDialogRenderState,
	width: number,
): string[] {
	return new AgentDialogRenderFrame(context, markdown, state).render(width);
}

class AgentDialogRenderFrame {
	private readonly context: CommandDialogViewContext<void>;
	private readonly markdown: Markdown;
	private readonly state: AgentDialogRenderState;

	constructor(context: CommandDialogViewContext<void>, markdown: Markdown, state: AgentDialogRenderState) {
		this.context = context;
		this.markdown = markdown;
		this.state = state;
	}

	render(width: number): string[] {
		return this.state.mode === "list"
			? this.renderList(width)
			: this.state.mode === "nested-list"
				? this.renderNestedList(width)
				: this.state.mode === "nested-detail"
					? this.renderNestedDetail(width)
					: this.state.mode === "detail"
						? this.renderDetail(width)
						: this.renderComposer(width);
	}

	private listRow(): AgentRow | undefined {
		return this.state.snapshotValue.rows.find((row) => row.key === this.state.listSelectedKey);
	}

	private detailRow(): AgentRow | undefined {
		return this.state.snapshotValue.rows.find((row) => row.key === this.state.selectedKey);
	}

	private nestedDetailRow(): AgentNestedDetail | undefined {
		return this.detailRow()?.nestedAgents.find((row) => row.key === this.state.nestedSelectedKey);
	}

	private hasToolActivity(): boolean {
		return this.state.transcript.items.some((item) => item.kind === "tool");
	}

	private renderList(width: number): string[] {
		const rows = this.state.snapshotValue.rows;
		const limit = width <= NARROW_WIDTH ? NARROW_LIST_ROWS : AGENT_LIST_ROWS;
		const up = commandDialogPrimaryKey(this.context.keybindings, "tui.select.up", "↑");
		const down = commandDialogPrimaryKey(this.context.keybindings, "tui.select.down", "↓");
		const confirm = commandDialogPrimaryKey(this.context.keybindings, "tui.select.confirm", "Enter");
		const cancel = commandDialogPrimaryKey(this.context.keybindings, "tui.select.cancel", "Esc");
		this.state.metrics.listPageRows = limit;
		const window = selectedWindow(rows, this.state.listSelectedKey, limit);
		const header = [divider(this.context.theme, width), title(this.context.theme, "Agents")];
		const feedbackLine = this.state.feedback
			? renderFeedback(this.context.theme, this.state.feedback, width)
			: undefined;
		const body = [...(feedbackLine ? [feedbackLine] : []), ""];
		const emptyLine = `${GUTTER}${this.context.theme.fg("muted", "No Agents in the current session.")}`;
		const rowLines: string[] = [];
		if (rows.length === 0) {
			body.push(emptyLine);
		} else {
			if (window.start > 0) body.push(`${GUTTER}${this.context.theme.fg("dim", `… ${window.start} earlier`)}`);
			for (const row of window.rows) {
				const line = this.renderListRow(row, width);
				rowLines.push(line);
				body.push(line);
			}
			const later = rows.length - window.start - window.rows.length;
			if (later > 0) body.push(`${GUTTER}${this.context.theme.fg("dim", `… ${later} later`)}`);
		}
		const hints = rows.length > 0 ? [`${up}/${down} select`, `${confirm} details`] : [];
		const page = commandDialogReadOnlyPageHint(rows.length > window.rows.length);
		if (page) hints.splice(1, 0, page);
		const selected = this.listRow();
		if (selected && !TERMINAL_STATUSES.has(selected.status)) hints.push("x stop");
		hints.push("? keys", `${cancel} close`);
		body.push("");
		const footer = hintLines(this.context.theme, width, hints);
		const selectedIndex = window.rows.findIndex((row) => row.key === this.state.listSelectedKey);
		return fitCommandDialogRows(
			{
				header,
				body,
				footer,
				priority: [feedbackLine ?? rowLines[selectedIndex] ?? emptyLine],
			},
			commandDialogRows(this.context),
		);
	}

	private renderListRow(row: AgentRow, width: number): string {
		const theme = this.context.theme;
		const selected = row.key === this.state.listSelectedKey;
		const prefix = `${GUTTER}${selected ? theme.fg("accent", "› ") : "  "}`;
		const name = oneLine(row.name) || "agent";
		const description = oneLine(row.description ?? row.task);
		const state = styledStatus(row, theme);
		const rightWidth = visibleWidth(state);
		const contentWidth = Math.max(1, width - visibleWidth(prefix) - rightWidth - 3);
		const renderedName = truncateToWidth(name, contentWidth, "…");
		const remaining = Math.max(0, contentWidth - visibleWidth(renderedName) - 2);
		const renderedDescription =
			visibleWidth(name) <= contentWidth && remaining >= 10 ? fitAgentDescription(description, remaining) : "";
		const left = `${prefix}${selected ? theme.fg("text", renderedName) : theme.fg("muted", renderedName)}${
			renderedDescription ? `  ${theme.fg("dim", renderedDescription)}` : ""
		}`;
		const gap = Math.max(1, width - visibleWidth(left) - rightWidth);
		return `${left}${" ".repeat(gap)}${state}`;
	}

	private renderNestedList(width: number): string[] {
		const parent = this.detailRow();
		if (!parent) return this.renderList(width);
		const rows = parent.nestedAgents;
		const limit = width <= NARROW_WIDTH ? NARROW_LIST_ROWS : AGENT_LIST_ROWS;
		this.state.metrics.nestedListPageRows = limit;
		const window = selectedWindow(rows, this.state.nestedSelectedKey, limit);
		const theme = this.context.theme;
		const up = commandDialogPrimaryKey(this.context.keybindings, "tui.select.up", "↑");
		const down = commandDialogPrimaryKey(this.context.keybindings, "tui.select.down", "↓");
		const confirm = commandDialogPrimaryKey(this.context.keybindings, "tui.select.confirm", "Enter");
		const cancel = commandDialogPrimaryKey(this.context.keybindings, "tui.select.cancel", "Esc");
		const header = [divider(theme, width), title(theme, `Agents / ${oneLine(parent.name) || "agent"} / nested`)];
		const body = ["", `${GUTTER}${theme.fg("muted", `${rows.length} nested Agent${rows.length === 1 ? "" : "s"}`)}`];
		const rowLines: string[] = [];
		if (window.start > 0) body.push(`${GUTTER}${theme.fg("dim", `… ${window.start} earlier`)}`);
		for (const row of window.rows) {
			const line = this.renderNestedListRow(row, width);
			rowLines.push(line);
			body.push(line);
		}
		const later = rows.length - window.start - window.rows.length;
		if (later > 0) body.push(`${GUTTER}${theme.fg("dim", `… ${later} later`)}`);
		body.push("");
		const hints = rows.length > 0 ? [`${up}/${down} select`, `${confirm} details`] : [];
		const page = commandDialogReadOnlyPageHint(rows.length > window.rows.length);
		if (page) hints.splice(1, 0, page);
		hints.push("? keys", `${cancel} back`);
		const selectedIndex = window.rows.findIndex((row) => row.key === this.state.nestedSelectedKey);
		return fitCommandDialogRows(
			{
				header,
				body,
				footer: hintLines(theme, width, hints),
				priority: [rowLines[selectedIndex] ?? body[1] ?? ""],
			},
			commandDialogRows(this.context),
		);
	}

	private renderNestedListRow(row: AgentNestedDetail, width: number): string {
		const theme = this.context.theme;
		const selected = row.key === this.state.nestedSelectedKey;
		const prefix = `${GUTTER}${selected ? theme.fg("accent", "› ") : "  "}`;
		const state = `${theme.fg("dim", `d${row.depth}`)} · ${styledNestedStatus(row.status, theme)}`;
		const contentWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(state) - 3);
		const fullName = oneLine(row.name) || "agent";
		const name = truncateToWidth(fullName, contentWidth, "…");
		const remaining = Math.max(0, contentWidth - visibleWidth(name) - 2);
		const description =
			visibleWidth(fullName) <= contentWidth && remaining >= 10
				? fitAgentDescription(oneLine(row.description), remaining)
				: "";
		const left = `${prefix}${selected ? theme.fg("text", name) : theme.fg("muted", name)}${
			description ? `  ${theme.fg("dim", description)}` : ""
		}`;
		const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(state));
		return `${left}${" ".repeat(gap)}${state}`;
	}

	private renderDetail(width: number): string[] {
		const row = this.detailRow();
		if (!row) return this.renderList(width);
		const theme = this.context.theme;
		const stateLine = `${GUTTER}${styledStatus(row, theme, true)}${
			row.nestedCount > 0 ? theme.fg("dim", ` · ${row.nestedCount} nested`) : ""
		}`;
		const header = [divider(theme, width), title(theme, `Agents / ${oneLine(row.name) || "agent"}`), stateLine];
		const feedbackLine = this.state.feedback ? renderFeedback(theme, this.state.feedback, width) : undefined;
		const detail = this.detailContent(row, width);
		return this.renderDetailSurface(
			header,
			detail.document,
			(scrollable) => this.renderDetailFooter(row, width, scrollable),
			!TERMINAL_STATUSES.has(row.status),
			[feedbackLine ?? detail.priority ?? stateLine, ...detail.taskLines.slice(0, 1)],
			feedbackLine,
		);
	}

	private renderNestedDetail(width: number): string[] {
		const parent = this.detailRow();
		const row = this.nestedDetailRow();
		if (!parent || !row) return this.renderNestedList(width);
		const theme = this.context.theme;
		const up = commandDialogPrimaryKey(this.context.keybindings, "tui.select.up", "↑");
		const down = commandDialogPrimaryKey(this.context.keybindings, "tui.select.down", "↓");
		const cancel = commandDialogPrimaryKey(this.context.keybindings, "tui.select.cancel", "Esc");
		const header = [
			divider(theme, width),
			title(theme, `Agents / ${oneLine(parent.name) || "agent"} / ${oneLine(row.name) || "nested"}`),
		];
		const stateLine = `${GUTTER}${styledNestedStatus(row.status, theme, true)}${theme.fg(
			"dim",
			` · depth ${row.depth}${row.nestedCount > 0 ? ` · ${row.nestedCount} nested` : ""}`,
		)}`;
		header.push(stateLine);
		const detail = this.detailContent(row, width);
		return this.renderDetailSurface(
			header,
			detail.document,
			(scrollable) => {
				const page = commandDialogReadOnlyPageHint(scrollable);
				return hintLines(theme, width, [
					...(page ? [`${up}/${down} scroll`, page] : []),
					...(this.hasToolActivity() ? ["t tool details"] : []),
					"? keys",
					`${cancel} back`,
				]);
			},
			!TERMINAL_STATUSES.has(row.status),
			[detail.priority ?? stateLine, ...detail.taskLines.slice(0, 1)],
		);
	}

	private detailContent(row: AgentRow | AgentNestedDetail, width: number) {
		const taskLines = sectionBody(row.task || "(no task)", width);
		const outcome = agentOutcome(row, width, this.context.theme, this.markdown);
		const lifecycle = agentLifecycle(row, width);
		const activity = this.activityLines(width);
		return {
			document: [
				commandDialogSectionHeading(this.context.theme, "Task"),
				...taskLines,
				...(lifecycle.length ? ["", commandDialogSectionHeading(this.context.theme, "Run"), ...lifecycle] : []),
				...(outcome ? ["", commandDialogSectionHeading(this.context.theme, outcome.label), ...outcome.lines] : []),
				"",
				commandDialogSectionHeading(this.context.theme, "Activity"),
				...activity,
			],
			priority:
				outcome?.lines[0] ??
				(this.state.transcript.state === "error" ? activity.find((line) => line.trim()) : undefined),
			taskLines,
		};
	}

	private renderDetailSurface(
		header: readonly string[],
		document: readonly string[],
		footerFor: (scrollable: boolean) => string[],
		live: boolean,
		priority: readonly string[],
		feedbackLine?: string,
	): string[] {
		const maximum = Math.min(AGENT_DIALOG_ROWS, commandDialogRows(this.context));
		const fixedRows = header.length + 2 + (feedbackLine ? 2 : 0);
		let footer = footerFor(false);
		let viewport = Math.max(0, maximum - fixedRows - footer.length);
		if (document.length > viewport) {
			footer = footerFor(true);
			viewport = Math.max(0, maximum - fixedRows - footer.length);
		}
		const content = viewport <= 3 ? document.filter((line) => line.trim().length > 0) : document;
		const maxOffset = Math.max(0, content.length - viewport);
		this.state.metrics.lastDetailMaxOffset = maxOffset;
		this.state.metrics.lastDetailViewportRows = Math.max(1, viewport);
		this.state.metrics.scrollOffset =
			this.state.followActivity && live
				? maxOffset
				: Math.min(maxOffset, Math.max(0, this.state.metrics.scrollOffset));
		const visible = content.slice(this.state.metrics.scrollOffset, this.state.metrics.scrollOffset + viewport);
		if (this.state.metrics.scrollOffset > 0 && visible.length > 0) {
			visible[0] = `${GUTTER}${this.context.theme.fg("dim", `… ${this.state.metrics.scrollOffset} earlier lines`)}`;
		}
		const later = content.length - this.state.metrics.scrollOffset - visible.length;
		if (later > 0 && visible.length > 0) {
			visible[visible.length - 1] = `${GUTTER}${this.context.theme.fg("dim", `… ${later} later lines`)}`;
		}
		const sections = {
			header,
			body: ["", ...(feedbackLine ? [feedbackLine, ""] : []), ...visible, ""],
			footer,
			priority,
		};
		return fitFixedCommandDialogRows(
			header[1] === undefined ? sections : { ...sections, overflowTitle: header[1] },
			maximum,
		);
	}

	private activityLines(width: number): string[] {
		const theme = this.context.theme;
		const contentWidth = Math.max(1, width - GUTTER.length);
		const allLines: string[] = [];
		switch (this.state.transcript.state) {
			case "loading":
				allLines.push(theme.fg("muted", "Loading Activity…"));
				break;
			case "unavailable":
				allLines.push(theme.fg("muted", "No Activity yet."));
				break;
			case "error":
				allLines.push(theme.fg("error", truncateToWidth(this.state.transcript.text, contentWidth, "…")));
				break;
			case "ready":
				for (const item of this.state.transcript.items) {
					if (allLines.length > 0) allLines.push("");
					if (item.kind === "notice") {
						allLines.push(theme.fg("dim", oneLine(item.text)));
						continue;
					}
					if (item.kind === "tool") {
						allLines.push(...renderAgentTool(item, contentWidth, theme, this.state.showToolDetails));
						continue;
					}
					const speaker = item.speaker ? oneLine(item.speaker) : "";
					if (speaker) allLines.push(theme.fg("text", theme.bold(speaker)));
					const body = boundedTerminalText(item.text, this.state.maxTranscriptChars);
					this.markdown.setText(body);
					allLines.push(...this.markdown.render(contentWidth));
				}
				break;
		}
		return allLines.map((line) => `${GUTTER}${line || " "}`);
	}

	private renderDetailFooter(row: AgentRow, width: number, scrollable: boolean): string[] {
		const up = commandDialogPrimaryKey(this.context.keybindings, "tui.select.up", "↑");
		const down = commandDialogPrimaryKey(this.context.keybindings, "tui.select.down", "↓");
		const cancel = commandDialogPrimaryKey(this.context.keybindings, "tui.select.cancel", "Esc");
		const page = commandDialogReadOnlyPageHint(scrollable);
		const actions = page ? [`${up}/${down} scroll`, page] : [];
		if (row.nestedAgents.length > 0) actions.push("n nested");
		if (!TERMINAL_STATUSES.has(row.status) && row.status !== "stopping") actions.push("s steer");
		if (RESUMABLE_STATUSES.has(row.status)) actions.push("r resume");
		if (!TERMINAL_STATUSES.has(row.status)) actions.push("x stop");
		if (this.hasToolActivity()) actions.push("t tool details");
		actions.push("? keys", `${cancel} back`);
		return hintLines(this.context.theme, width, actions);
	}

	private renderComposer(width: number): string[] {
		const row = this.detailRow();
		if (!row) return this.renderList(width);
		const theme = this.context.theme;
		const resume = this.state.mode === "resume-input";
		const inputLine = `${GUTTER}${theme.fg("accent", "›")} ${this.state.input || theme.fg("dim", resume ? "Continue the task…" : "Send new guidance…")}`;
		const feedbackLine = this.state.feedback ? renderFeedback(theme, this.state.feedback, width) : undefined;
		const body = [
			"",
			`${GUTTER}${theme.fg("muted", resume ? "Resume message (optional)" : "Steer Agent")}`,
			inputLine,
			...(feedbackLine ? [feedbackLine] : []),
			"",
		];
		return fitCommandDialogRows(
			{
				header: [divider(theme, width), title(theme, `Agents / ${oneLine(row.name) || "agent"}`)],
				body,
				footer: hintLines(theme, width, [`Enter ${resume ? "resume" : "send"}`, "Esc cancel"]),
				priority: [feedbackLine ?? inputLine],
			},
			commandDialogRows(this.context),
		);
	}
}

function agentLifecycle(row: AgentRow | AgentNestedDetail, width: number): string[] {
	if (!("cumulativeUsage" in row) || !("terminalOutcome" in row)) return [];
	const lines: string[] = [];
	const usage = row.cumulativeUsage;
	if (usage) {
		const cost = usage.reportedCostUsd === undefined ? "unreported" : `$${usage.reportedCostUsd.toFixed(6)}`;
		lines.push(
			`${usage.turns} turns · ${usage.toolCalls} Tools · ${usage.inputTokens} input + ${usage.outputTokens} output tokens`,
			`Reported cost ${cost} · ${usage.modelAttempts} attempts · ${usage.resumes} resumes`,
		);
	}
	const outcome = row.terminalOutcome;
	if (outcome) {
		lines.push(`${outcome.class} · ${outcome.state} · ${outcome.reason}`);
		const { continuation } = outcome;
		lines.push(
			`Target ${continuation.target.id} index ${String(continuation.target.index)} · ${continuation.resumeSupported ? "resumable" : "not resumable"}${continuation.acknowledgementRequired ? " · acknowledgement required" : ""}`,
		);
	}
	return lines.flatMap((line) => sectionBody(line, width));
}

function selectedWindow<T extends { readonly key: string }>(
	rows: readonly T[],
	selectedKey: string | undefined,
	limit: number,
) {
	if (rows.length <= limit) return { rows, start: 0 };
	const selectedIndex = Math.max(
		0,
		rows.findIndex((row) => row.key === selectedKey),
	);
	const start = Math.min(rows.length - limit, Math.max(0, selectedIndex - Math.floor(limit / 2)));
	return { rows: rows.slice(start, start + limit), start };
}

function divider(theme: Theme, width: number): string {
	return theme.fg("border", "━".repeat(width));
}

function title(theme: Theme, value: string): string {
	return `${GUTTER}${theme.fg("text", theme.bold(value))}`;
}

function sectionBody(value: string, width: number): string[] {
	const contentWidth = Math.max(1, width - visibleWidth(GUTTER));
	const safe = boundedTerminalText(value, 4_000) || "—";
	return transcriptLines(safe, contentWidth).map((line) => `${GUTTER}${line || " "}`);
}

function markdownSectionBody(value: string, width: number, markdown: Markdown): string[] {
	const contentWidth = Math.max(1, width - visibleWidth(GUTTER));
	const safe = boundedTerminalText(value, 4_000) || "—";
	markdown.setText(safe);
	return markdown.render(contentWidth).map((line) => `${GUTTER}${line || " "}`);
}

function agentOutcome(
	row: AgentRow | AgentNestedDetail,
	width: number,
	theme: Theme,
	markdown: Markdown,
): { readonly label: "Error" | "Partial result" | "Result"; readonly lines: readonly string[] } | undefined {
	const partial = row.partialResult && !isTaskOnlyAgentText(row.partialResult, row.task) ? row.partialResult : "";
	if (row.error) {
		const errorLines = sectionBody(row.error, width).map((line) => theme.fg("error", line));
		return {
			label: "Error",
			lines: [
				...errorLines,
				...(partial
					? [
							"",
							`${GUTTER}${theme.fg("muted", "Partial result")}`,
							...markdownSectionBody(partial, width, markdown),
						]
					: []),
			],
		};
	}
	if (!partial) return undefined;
	return {
		label: row.status === "completed" ? "Result" : "Partial result",
		lines: markdownSectionBody(partial, width, markdown),
	};
}

function renderAgentTool(
	item: Extract<AgentTranscriptItem, { readonly kind: "tool" }>,
	width: number,
	theme: Theme,
	showDetails: boolean,
): string[] {
	const target = oneLine(item.target);
	const glyph = styleToolOutcome(theme, item.outcome, toolOutcomeGlyph(item.outcome));
	const header = `${glyph} ${theme.fg("text", toolLabel(item.name))}${target ? ` · ${theme.fg("muted", target)}` : ""}${theme.fg("dim", ` · ${item.outcome}`)}`;
	const result = boundedTerminalText(item.result, TOOL_RESULT_PREVIEW_CHARS).trim();
	if (!result || (!showDetails && item.outcome === "completed")) return [header];

	const logicalLines = result.split("\n");
	const lines = logicalLines
		.slice(0, TOOL_RESULT_PREVIEW_LINES)
		.flatMap((line, index) => transcriptLines(`${index === 0 ? "⎿ " : ""}${line}`, width));
	const omitted = logicalLines.length - Math.min(logicalLines.length, TOOL_RESULT_PREVIEW_LINES);
	if (omitted > 0) lines.push(`⎿ … ${String(omitted)} lines omitted`);
	return [header, ...lines];
}

function toolLabel(value: string): string {
	const safe = oneLine(value) || "Tool";
	return `${safe.charAt(0).toUpperCase()}${safe.slice(1)}`;
}

function toolOutcomeGlyph(outcome: AgentToolOutcome): string {
	if (outcome === "running") return "●";
	if (outcome === "completed") return "✓";
	if (outcome === "rejected") return "!";
	if (outcome === "cancelled") return "■";
	return "×";
}

function styleToolOutcome(theme: Theme, outcome: AgentToolOutcome, value: string): string {
	if (outcome === "running") return theme.fg("accent", value);
	if (outcome === "completed") return theme.fg("success", value);
	if (outcome === "failed") return theme.fg("error", value);
	return theme.fg("warning", value);
}

function renderFeedback(theme: Theme, feedback: Feedback, width: number): string {
	const color = feedback.kind === "error" ? "error" : feedback.kind === "success" ? "success" : "warning";
	return truncateToWidth(`${GUTTER}${theme.fg(color, feedback.message)}`, width, "…");
}

function hintLines(theme: Theme, width: number, hints: readonly string[]): string[] {
	const available = Math.max(1, width - visibleWidth(GUTTER));
	const lines: string[] = [];
	let current = "";
	for (const hint of hints) {
		const safeHint = oneLine(hint);
		if (!safeHint) continue;
		const candidate = current ? `${current} · ${safeHint}` : safeHint;
		if (current && visibleWidth(candidate) > available) {
			lines.push(current);
			current = "";
		}
		if (visibleWidth(safeHint) <= available) {
			current = current ? `${current} · ${safeHint}` : safeHint;
			continue;
		}
		const wrapped = wrapTextWithAnsi(safeHint, available);
		lines.push(...wrapped.slice(0, -1));
		current = wrapped.at(-1) ?? "";
	}
	if (current) lines.push(current);
	if (lines.length === 0) lines.push("Esc close");
	return lines.map((line) => `${GUTTER}${theme.fg("dim", line)}`);
}

function agentStatusGlyph(status: AgentStatus): string {
	switch (status) {
		case "queued":
		case "waiting_supervisor":
			return "○";
		case "running":
			return "●";
		case "stopping":
			return "◐";
		case "resuming":
			return "↻";
		case "completed":
			return "✓";
		case "failed":
		case "crashed":
			return "×";
		case "agent_stopped":
		case "user_cancelled":
			return "■";
	}
}

function agentStatusLabel(status: AgentStatus): string {
	if (status === "waiting_supervisor") return "waiting";
	if (status === "agent_stopped") return "stopped";
	if (status === "user_cancelled") return "cancelled";
	return status;
}

function styleAgentStatus(theme: Theme, status: AgentStatus, value: string): string {
	switch (status) {
		case "running":
		case "resuming":
			return theme.fg("accent", value);
		case "completed":
			return theme.fg("success", value);
		case "failed":
		case "crashed":
			return theme.fg("error", value);
		case "agent_stopped":
		case "user_cancelled":
			return theme.fg("muted", value);
		case "queued":
		case "waiting_supervisor":
		case "stopping":
			return theme.fg("warning", value);
	}
}

function styledStatus(row: AgentRow, theme: Theme, detailed = false): string {
	const elapsed = elapsedText(row);
	const glyph = agentStatusGlyph(row.status);
	const value = detailed
		? `${glyph} ${agentStatusLabel(row.status)}${elapsed ? ` · ${elapsed}` : ""}`
		: `${glyph}${elapsed ? ` ${elapsed}` : row.status === "queued" ? ` #${String(row.childIndex + 1)}` : ""}`;
	return styleAgentStatus(theme, row.status, value);
}

function styledNestedStatus(status: AgentStatus, theme: Theme, detailed = false): string {
	const glyph = agentStatusGlyph(status);
	return styleAgentStatus(theme, status, detailed ? `${glyph} ${agentStatusLabel(status)}` : glyph);
}

function elapsedText(row: AgentRow): string {
	const value = row.elapsedMs;
	if (!isRuntimeNumber(value) || !Number.isFinite(value)) return "";
	const seconds = Math.max(0, Math.floor(value / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function transcriptLines(text: string, width: number): string[] {
	return text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, width) : [""]));
}

export function oneLine(value: string): string {
	return boundedTerminalLine(value);
}

export function boundedTerminalText(value: string, limit: number): string {
	return boundTerminalPreview(value, limit);
}
