import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isRuntimeNumber } from "../../../shared/runtime-type.ts";
import type { AgentRow } from "../session/current-agents.ts";
import { boundedTerminalLine } from "../shared/display-description.ts";

const NORMAL_CHILD_LIMIT = 5;
const NARROW_CHILD_LIMIT = 4;
const NARROW_WIDTH = 64;
const CONTEXT_WARNING_PERCENT = 70;
const CONTEXT_ERROR_PERCENT = 90;
const TERMINAL_STATUSES = new Set(["agent_stopped", "completed", "crashed", "failed", "user_cancelled"]);

export function renderAgentRoster(
	rows: readonly AgentRow[],
	navigationActive: boolean,
	selectedKey: string,
	theme: Theme,
	width: number,
	now: number,
): string[] {
	if (rows.length === 0) return [];
	const renderWidth = Math.max(1, width);
	const limit = renderWidth <= NARROW_WIDTH ? NARROW_CHILD_LIMIT : NORMAL_CHILD_LIMIT;
	const visible = visibleRows(rows, limit, navigationActive ? selectedKey : "main");
	const lines = navigationActive ? [renderHint(rows, selectedKey, theme, renderWidth)] : [];
	lines.push(
		renderMain(navigationActive, selectedKey, theme, renderWidth),
		...visible.map((row) =>
			renderAgentRow(row, selectedMarker(row.key, navigationActive, selectedKey, theme), theme, renderWidth, now),
		),
	);
	const hidden = rows.length - visible.length;
	if (hidden > 0) lines.push(truncateToWidth(theme.fg("dim", `… +${hidden} more`), renderWidth, ""));
	return lines;
}

export function isTerminalAgentRow(row: AgentRow): boolean {
	return TERMINAL_STATUSES.has(row.status);
}

function visibleRows(rows: readonly AgentRow[], limit: number, selectedKey: string): AgentRow[] {
	if (rows.length <= limit) return [...rows];
	const visible = rows.slice(0, limit);
	if (selectedKey === "main" || visible.some((row) => row.key === selectedKey)) return visible;
	const selected = rows.find((row) => row.key === selectedKey);
	if (!selected) return visible;
	visible[visible.length - 1] = selected;
	const order = new Map(rows.map((row, index) => [row.key, index]));
	return visible.sort((left, right) => (order.get(left.key) ?? 0) - (order.get(right.key) ?? 0));
}

function renderHint(rows: readonly AgentRow[], selectedKey: string, theme: Theme, width: number): string {
	const selected = rows.find((row) => row.key === selectedKey);
	const action = selected ? (isTerminalAgentRow(selected) ? "dismiss" : "stop") : undefined;
	const hint =
		width <= NARROW_WIDTH
			? `↑/↓ · Enter${action ? ` · x ${action}` : ""} · Esc`
			: `↑/↓ select · Enter view${action ? ` · x ${action}` : ""} · Esc return`;
	return truncateToWidth(theme.fg("dim", hint), width, "");
}

function renderMain(navigationActive: boolean, selectedKey: string, theme: Theme, width: number): string {
	const marker = selectedMarker("main", navigationActive, selectedKey, theme);
	return truncateToWidth(`${marker} ${theme.fg("text", "main")}`, width, "");
}

function selectedMarker(key: string, navigationActive: boolean, selectedKey: string, theme: Theme): string {
	if (navigationActive) return selectedKey === key ? theme.fg("accent", "●") : theme.fg("muted", "○");
	return key === "main" ? theme.fg("text", "●") : theme.fg("muted", "○");
}

function renderAgentRow(row: AgentRow, marker: string, theme: Theme, width: number, now: number): string {
	const name = boundedTerminalLine(row.name) || "agent";
	const description = boundedTerminalLine(row.description ?? row.task);
	const state = styledState(row, theme, now);
	const context = styledContextUsage(row, theme);
	const markerPrefix = `${marker} `;
	let right = context ? context + theme.fg("dim", " · ") + state : state;
	if (context && visibleWidth(markerPrefix) + visibleWidth(name) + 2 + visibleWidth(right) > width) right = state;
	const rightWidth = visibleWidth(right);
	const leftWidth = Math.max(1, width - (rightWidth > 0 ? rightWidth + 2 : 0));
	const plainPrefixWidth = visibleWidth(markerPrefix);
	const nameBudget = Math.max(1, leftWidth - plainPrefixWidth);
	const boundedName = truncateToWidth(name, nameBudget, "…");
	const styledName = theme.fg("text", boundedName);
	const descriptionBudget = Math.max(0, leftWidth - plainPrefixWidth - visibleWidth(styledName) - 2);
	const fittedDescription = fitAgentDescription(description, descriptionBudget);
	const left = truncateToWidth(
		`${markerPrefix}${styledName}${fittedDescription ? `  ${theme.fg("muted", fittedDescription)}` : ""}`,
		leftWidth,
		"",
	);
	if (rightWidth === 0) return truncateToWidth(left, width, "");
	const gap = Math.max(2, width - visibleWidth(left) - rightWidth);
	return truncateToWidth(`${left}${" ".repeat(gap)}${right}`, width, "");
}

function styledContextUsage(row: AgentRow, theme: Theme): string {
	const usage = row.contextUsage;
	if (!usage || usage.contextWindow <= 0 || usage.tokens < 0) return "";
	const percent = (usage.tokens / usage.contextWindow) * 100;
	if (!Number.isFinite(percent)) return "";
	const rounded = Math.round(percent);
	const label = percent > 0 && percent < 1 ? "<1%" : rounded > 999 ? ">999%" : `${String(Math.max(0, rounded))}%`;
	const color = percent > CONTEXT_ERROR_PERCENT ? "error" : percent > CONTEXT_WARNING_PERCENT ? "warning" : "muted";
	return theme.fg(color, label);
}

function styledState(row: AgentRow, theme: Theme, now: number): string {
	const elapsed = elapsedText(row, now);
	switch (row.status) {
		case "queued":
			return theme.fg("muted", "queued");
		case "waiting_supervisor":
			return theme.fg("warning", "waiting");
		case "stopping":
			return theme.fg("muted", "stopping");
		case "resuming":
			return theme.fg("muted", "resuming");
		case "completed":
			return theme.fg("muted", elapsed ? `done · ${elapsed}` : "done");
		case "failed":
			return theme.fg("error", elapsed ? `failed · ${elapsed}` : "failed");
		case "crashed":
			return theme.fg("error", elapsed ? `crashed · ${elapsed}` : "crashed");
		case "agent_stopped":
			return theme.fg("muted", elapsed ? `stopped · ${elapsed}` : "stopped");
		case "user_cancelled":
			return theme.fg("muted", elapsed ? `cancelled · ${elapsed}` : "cancelled");
		case "running":
			return theme.fg("muted", elapsed || "running");
	}
}

function elapsedText(row: AgentRow, now: number): string {
	const elapsedMs =
		!isTerminalAgentRow(row) && isRuntimeNumber(row.startedAt) && Number.isFinite(row.startedAt)
			? now - row.startedAt
			: isRuntimeNumber(row.elapsedMs) && Number.isFinite(row.elapsedMs)
				? row.elapsedMs
				: undefined;
	if (elapsedMs === undefined) return "";
	const seconds = Math.max(0, Math.floor(elapsedMs / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Keep a description only when the complete short label remains readable. */
export function fitAgentDescription(description: string, availableWidth: number): string {
	const safe = boundedTerminalLine(description);
	return safe && visibleWidth(safe) <= availableWidth ? safe : "";
}
