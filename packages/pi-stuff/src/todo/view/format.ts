import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "../../shared/terminal-text.ts";
import type { TaskStatus } from "../tool/types.ts";

export type OverlayTaskId = string;

/** Structural view input kept independent from persistence-only task fields. */
export interface OverlayTask {
	readonly activeForm?: string;
	readonly id: OverlayTaskId;
	readonly subject: string;
	readonly status: TaskStatus;
	readonly blockedBy?: readonly OverlayTaskId[];
}

export interface OverlayTaskRow {
	readonly task: OverlayTask;
	readonly openBlockers: readonly OverlayTaskId[];
}

export interface OverlayLayout {
	readonly visible: readonly OverlayTaskRow[];
	readonly hidden: readonly OverlayTaskRow[];
	readonly next: OverlayTaskRow | undefined;
}

const MAX_OVERLAY_TASK_ROWS = 5;
const MIN_TRUNCATED_SUBJECT_WIDTH = 6;
const UNTITLED_TASK = "untitled task";

function compareTaskIds(left: OverlayTask, right: OverlayTask): number {
	if (left.id === right.id) return 0;
	if (/^\d+$/.test(left.id) && /^\d+$/.test(right.id)) {
		const leftNumber = BigInt(left.id);
		const rightNumber = BigInt(right.id);
		if (leftNumber !== rightNumber) return leftNumber < rightNumber ? -1 : 1;
	}
	return left.id < right.id ? -1 : 1;
}

/** Remove terminal commands and collapse user-controlled content to one row. */
function singleLine(value: string): string {
	return sanitizeTerminalText(value).replace(/\s+/gu, " ").trim();
}

function taskText(task: OverlayTask): string {
	const active = task.status === "in_progress" ? singleLine(task.activeForm ?? "") : "";
	return active || singleLine(task.subject) || UNTITLED_TASK;
}

/**
 * Resolve dependencies against the complete task set. Missing references stay
 * open; completed and deleted dependencies are resolved.
 */
export function selectOpenBlockers(
	task: OverlayTask,
	tasksById: ReadonlyMap<string, OverlayTask>,
): readonly OverlayTaskId[] {
	return (task.blockedBy ?? []).filter((blockerId) => {
		const blocker = tasksById.get(blockerId);
		return blocker === undefined || (blocker.status !== "completed" && blocker.status !== "deleted");
	});
}

function rowRank(row: OverlayTaskRow, recentCompletedIds: ReadonlySet<string>): number {
	if (row.task.status === "completed") return recentCompletedIds.has(row.task.id) ? 0 : 4;
	if (row.task.status === "in_progress") return 1;
	if (row.task.status === "pending") return row.openBlockers.length === 0 ? 2 : 3;
	return 5;
}

/**
 * Order the bounded checklist as recent completions, active work, runnable
 * pending work, blocked pending work, then older completions. Rows inside each
 * group are deterministic by task id.
 */
export function selectOverlayLayout(
	tasks: readonly OverlayTask[],
	recentCompletedIds: ReadonlySet<string> = new Set<string>(),
	maxRows = MAX_OVERLAY_TASK_ROWS,
): OverlayLayout {
	const tasksById = new Map(tasks.map((task) => [task.id, task]));
	const rows = tasks
		.filter((task) => task.status !== "deleted")
		.map((task) => ({ task, openBlockers: selectOpenBlockers(task, tasksById) }))
		.sort((left, right) => {
			const rankDifference = rowRank(left, recentCompletedIds) - rowRank(right, recentCompletedIds);
			return rankDifference || compareTaskIds(left.task, right.task);
		});
	const rowLimit = Math.max(0, Math.min(MAX_OVERLAY_TASK_ROWS, Math.floor(maxRows)));
	const visible = rows.slice(0, rowLimit);
	const hidden = rows.slice(rowLimit);
	const next = rows.find((row) => row.task.status === "in_progress" || row.task.status === "pending");
	return { visible, hidden, next };
}

function overlayStatusGlyph(status: TaskStatus, blocked: boolean, theme: Theme): string {
	switch (status) {
		case "pending":
			return theme.fg(blocked ? "warning" : "muted", "□");
		case "in_progress":
			return theme.fg("accent", "■");
		case "completed":
			return theme.fg("dim", "✓");
		case "deleted":
			return theme.fg("error", "✗");
	}
}

function fitOptionalSubject(subject: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(subject) <= width) return subject;
	return width >= MIN_TRUNCATED_SUBJECT_WIDTH ? truncateToWidth(subject, width, "…") : "";
}

/** Format one unheaded, single-line task row with the subject always taking the available width. */
export function formatOverlayTaskLine(row: OverlayTaskRow, theme: Theme, width = Number.POSITIVE_INFINITY): string {
	const { task, openBlockers } = row;
	const glyph = overlayStatusGlyph(task.status, openBlockers.length > 0, theme);
	const text = taskText(task);
	let subject: string;
	if (task.status === "completed" || task.status === "deleted") {
		subject = theme.strikethrough(theme.fg("dim", text));
	} else if (task.status === "in_progress") {
		subject = theme.bold(theme.fg("accent", text));
	} else if (openBlockers.length > 0) {
		subject = theme.fg("muted", text);
	} else {
		subject = theme.fg("text", text);
	}

	const identity = `${glyph} `;
	if (!Number.isFinite(width)) return `${identity}${subject}`;
	const normalizedWidth = Math.max(0, Math.floor(width));
	if (normalizedWidth <= visibleWidth(identity)) return truncateToWidth(identity, normalizedWidth, "");
	return `${identity}${fitOptionalSubject(subject, normalizedWidth - visibleWidth(identity))}`;
}

export function formatOverlayOverflowLine(hidden: readonly OverlayTaskRow[], theme: Theme): string {
	const statuses = new Set(hidden.map((row) => row.task.status));
	let label = "more";
	if (statuses.size === 1) {
		const status = hidden[0]?.task.status;
		if (status === "pending") label = "pending";
		else if (status === "in_progress") label = "in progress";
		else if (status === "completed") label = "completed";
	}
	return theme.fg("dim", `… +${hidden.length} ${label}`);
}

export function formatCollapsedNextLine(next: OverlayTaskRow | undefined, theme: Theme): string {
	const label = theme.fg("muted", "Next:");
	if (!next) return `${label} ${theme.fg("dim", "all tasks complete")}`;
	const subject = taskText(next.task);
	if (next.openBlockers.length > 0) {
		return `${label} ${theme.fg("warning", "□")} ${theme.fg("muted", subject)}`;
	}
	return `${label} ${theme.fg("text", subject)}`;
}
