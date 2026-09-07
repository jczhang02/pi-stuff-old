import type { AgentToolResult, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { type Component, Text, visibleWidth } from "@earendil-works/pi-tui";
import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { boundTerminalLine, boundTerminalText, graphemePrefix } from "../../tool-display/index.ts";
import { buildToolResultLines } from "../../tool-display/tool-text.ts";

type McpToolResultDetails = JsonInputObject & { error?: JsonInputValue };

type RenderTheme = Pick<Theme, "fg"> & Partial<Pick<Theme, "bold">>;

const plainTheme: RenderTheme = { fg: (_name, text) => text };

export interface McpProxyToolCallInput {
	tool?: string;
	args?: string | object;
	connect?: string;
	describe?: string;
	search?: string;
	regex?: boolean;
	includeSchemas?: boolean;
	server?: string;
	action?: string;
}

interface McpToolRenderContext {
	isError: boolean;
}

export interface McpToolResultDisplay {
	lines: string[];
	truncated: boolean;
}

const DEFAULT_MAX_CALL_INPUT_CHARS = 1500;
const DEFAULT_MAX_COLLAPSED_LINES = 3;
const DEFAULT_MAX_COLLAPSED_CHARS = 8000;
const COLLAPSED_RENDER_CHAR_SLACK = 8;
const MCP_INPUT_SCAN_FACTOR = 4;

function boundedCallPart(value: string, maxChars = DEFAULT_MAX_CALL_INPUT_CHARS): string {
	const limit = Math.max(0, Math.floor(maxChars));
	const sourceLimit = Math.max(1, limit) * MCP_INPUT_SCAN_FACTOR;
	const source = value.slice(0, sourceLimit + 1);
	return boundTerminalLine(source.slice(0, sourceLimit), limit, source.length < value.length ? "…" : "");
}

class CollapsibleText implements Component {
	private readonly text: string;
	private readonly expanded: boolean;
	private readonly maxCollapsedLines: number;
	readonly ellipsis: string;
	readonly expandHint: string;
	private readonly preTruncated: boolean;
	private readonly fullText: Text;
	private readonly footerText: Text;
	private collapsedText: { charBudget: number; fullyIncluded: boolean; text: Text } | null = null;

	constructor(
		text: string,
		expanded: boolean,
		maxCollapsedLines: number,
		ellipsis: string,
		expandHint: string,
		preTruncated = false,
	) {
		this.text = text;
		this.expanded = expanded;
		this.maxCollapsedLines = maxCollapsedLines;
		this.ellipsis = ellipsis;
		this.expandHint = expandHint;
		this.preTruncated = preTruncated;
		this.fullText = new Text(text, 0, 0);
		this.footerText = new Text(`${ellipsis}\n${expandHint}`, 0, 0);
	}

	render(width: number): string[] {
		if (this.expanded) {
			return this.fullText.render(width);
		}

		const safeWidth = Math.max(1, Math.floor(width));
		const charBudget = safeWidth * (this.maxCollapsedLines + 1) * COLLAPSED_RENDER_CHAR_SLACK;
		if (!this.collapsedText || this.collapsedText.charBudget !== charBudget) {
			const prefix = graphemePrefix(this.text, charBudget);
			this.collapsedText = {
				charBudget,
				fullyIncluded: prefix === this.text,
				text: new Text(prefix, 0, 0),
			};
		}

		const lines = this.collapsedText.text.render(width);
		if (!this.preTruncated && this.collapsedText.fullyIncluded && lines.length <= this.maxCollapsedLines)
			return lines;

		return [...lines.slice(0, this.maxCollapsedLines), ...this.footerText.render(width)];
	}

	invalidate(): void {}
}

function truncateText(value: string, maxChars: number): string {
	return boundTerminalText(value, maxChars);
}

function formatJsonish(value: NonNullable<McpProxyToolCallInput["args"]>, maxChars: number): string {
	if (isRuntimeString(value)) {
		const scanLimit = Math.max(1, Math.floor(maxChars)) * MCP_INPUT_SCAN_FACTOR;
		const source = value.slice(0, scanLimit + 1);
		if (source.length < value.length) return `${truncateText(source.slice(0, scanLimit), maxChars)}…`;
		try {
			return truncateText(JSON.stringify(JSON.parse(source), null, 2), maxChars);
		} catch {
			return truncateText(source, maxChars);
		}
	}
	return "[argument object preview omitted]";
}

export function formatMcpProxyToolCallLines(
	args: McpProxyToolCallInput,
	maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
	if (args.action === "ui-messages") return [`mcp ${args.action}`];

	if (args.tool) {
		const tool = boundedCallPart(args.tool, maxInputChars);
		const target = args.server ? `${tool} @ ${boundedCallPart(args.server, maxInputChars)}` : tool;
		const lines = [`mcp call ${target}`];
		if (args.args) lines.push(formatJsonish(args.args, maxInputChars));
		return lines;
	}

	if (args.connect) return [`mcp connect ${boundedCallPart(args.connect, maxInputChars)}`];
	if (args.describe) return [`mcp describe ${boundedCallPart(args.describe, maxInputChars)}`];

	if (args.search) {
		let line = `mcp search ${boundedCallPart(args.search, maxInputChars)}`;
		if (args.server) line += ` @ ${boundedCallPart(args.server, maxInputChars)}`;
		if (args.regex === true) line += " (regex)";
		if (args.includeSchemas === false) line += " (schemas hidden)";
		return [line];
	}

	if (args.server) return [`mcp list ${boundedCallPart(args.server, maxInputChars)}`];
	if (args.action) return [`mcp ${boundedCallPart(args.action, maxInputChars)}`];

	return ["mcp status"];
}

export function formatMcpDirectToolCallLines(
	displayName: string,
	args: JsonInputObject,
	maxInputChars = DEFAULT_MAX_CALL_INPUT_CHARS,
): string[] {
	return [boundedCallPart(displayName, maxInputChars), formatJsonish(args, maxInputChars)];
}

function renderToolCallLines(lines: string[], theme?: RenderTheme) {
	const activeTheme = theme ?? plainTheme;
	const [rawTitle = "mcp", ...rest] = lines;
	const title = boundedCallPart(rawTitle);
	const styledTitle = activeTheme.fg("toolTitle", activeTheme.bold ? activeTheme.bold(title) : title);
	const styledRest = rest.map((line) =>
		activeTheme.fg("muted", boundTerminalText(line, DEFAULT_MAX_CALL_INPUT_CHARS)),
	);
	return new Text([styledTitle, ...styledRest].join("\n"), 0, 0);
}

export function renderMcpProxyToolCall(args: McpProxyToolCallInput, theme?: RenderTheme) {
	return renderToolCallLines(formatMcpProxyToolCallLines(args), theme);
}

export function createMcpDirectToolCallRenderer(displayName: string) {
	return (args: JsonInputObject, theme?: RenderTheme) => {
		return renderToolCallLines(formatMcpDirectToolCallLines(displayName, args), theme);
	};
}

function collectCollapsedResultLines(
	content: AgentToolResult<McpToolResultDetails>["content"],
	maxLines: number,
	maxChars: number,
): McpToolResultDisplay {
	if (content.length === 0) return { lines: ["(empty result)"], truncated: false };

	const lines: string[] = [];
	let remainingCells = maxChars;
	let truncated = false;

	const appendLine = (line: string) => {
		if (lines.length >= maxLines || remainingCells <= 0) {
			truncated = true;
			return false;
		}

		const scanLimit = Math.max(1_024, remainingCells * MCP_INPUT_SCAN_FACTOR);
		const source = line.slice(0, scanLimit + 1);
		const sourceTruncated = source.length < line.length;
		const safeSource = boundTerminalLine(source.slice(0, scanLimit), scanLimit, "");
		if (sourceTruncated || visibleWidth(safeSource) > remainingCells) {
			lines.push(boundTerminalLine(safeSource, remainingCells, ""));
			truncated = true;
			remainingCells = 0;
			return false;
		}

		lines.push(safeSource);
		remainingCells -= visibleWidth(safeSource) + 1;
		return true;
	};

	for (const block of content) {
		if (block.type !== "text") {
			if (!appendLine(`[image: ${block.mimeType}]`)) break;
			continue;
		}

		let start = 0;
		while (start <= block.text.length) {
			const scanLimit = Math.max(1_024, remainingCells * MCP_INPUT_SCAN_FACTOR);
			const scanEnd = Math.min(block.text.length, start + scanLimit + 1);
			const source = block.text.slice(start, scanEnd);
			const relativeNewline = source.indexOf("\n");
			const newline = relativeNewline < 0 ? -1 : start + relativeNewline;
			const line = newline === -1 ? source : source.slice(0, relativeNewline);
			if (!appendLine(line)) break;
			if (newline === -1) {
				if (scanEnd < block.text.length) truncated = true;
				break;
			}
			start = newline + 1;
		}

		if (truncated) break;
	}

	if (lines.length === 0) lines.push("");
	if (truncated && lines.length >= maxLines) lines.push("…");
	return { lines, truncated };
}

export function formatMcpToolResultIdentity(details: McpToolResultDetails | undefined): string | null {
	if (details?.["mode"] !== "call") return null;
	const server = isRuntimeString(details["server"])
		? details["server"]
		: isRuntimeString(details["hintServer"])
			? details["hintServer"]
			: null;
	if (!server) return null;
	const safeServer = boundedCallPart(server);
	if (isRuntimeString(details["tool"])) return `MCP ${safeServer}/${boundedCallPart(details["tool"])}`;
	if (isRuntimeString(details["resourceUri"])) {
		return `MCP ${safeServer} resource ${boundedCallPart(details["resourceUri"])}`;
	}
	if (isRuntimeString(details["requestedTool"])) {
		return `MCP ${safeServer}/${boundedCallPart(details["requestedTool"])}`;
	}
	return null;
}

export function formatMcpToolResultLines(
	result: Pick<AgentToolResult<McpToolResultDetails>, "content">,
	expanded: boolean,
	maxCollapsedLines = 3,
	maxCollapsedChars = DEFAULT_MAX_COLLAPSED_CHARS,
): McpToolResultDisplay {
	if (!expanded) {
		return collectCollapsedResultLines(result.content, maxCollapsedLines, maxCollapsedChars);
	}

	if (result.content.length === 0) return { lines: ["(empty result)"], truncated: false };
	// SAFETY: the shared renderer reads only the content property present on this narrowed result view.
	const lines = buildToolResultLines(result as AgentToolResult<unknown>);
	return { lines, truncated: lines.at(-1)?.startsWith("… detail capped") === true };
}

export function renderMcpToolResult(
	result: AgentToolResult<McpToolResultDetails>,
	options: ToolRenderResultOptions,
	theme?: RenderTheme,
	context?: McpToolRenderContext,
) {
	const activeTheme = theme ?? plainTheme;
	if (options.isPartial) {
		return new Text(activeTheme.fg("warning", "Running MCP tool..."), 0, 0);
	}

	const hasErrorDetails = Boolean(result.details.error);
	const expanded = options.expanded || context?.isError === true || hasErrorDetails;
	const display = formatMcpToolResultLines(result, expanded);
	const identity = formatMcpToolResultIdentity(result.details);
	const output = [
		...(identity ? [activeTheme.fg("muted", identity)] : []),
		...display.lines.map((line) => activeTheme.fg("toolOutput", line)),
	].join("\n");

	return new CollapsibleText(
		output,
		expanded,
		DEFAULT_MAX_COLLAPSED_LINES + (identity ? 1 : 0),
		activeTheme.fg("muted", "…"),
		activeTheme.fg("muted", "(Ctrl+O to expand)"),
		display.truncated,
	);
}
