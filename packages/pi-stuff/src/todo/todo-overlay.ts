/**
 * Compact, editor-above Todo widget.
 *
 * The store remains the source of truth. This controller owns only ephemeral
 * presentation state: collapse, recent-completion ordering, and the five
 * second all-complete linger before the widget is removed.
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { SELF_RENDERED_TRANSCRIPT_PADDING } from "../conversation-ui/transcript.ts";
import { getRenderState } from "./state/store.ts";
import type { TaskStatus } from "./tool/types.ts";
import {
	formatCollapsedNextLine,
	formatOverlayOverflowLine,
	formatOverlayTaskLine,
	selectOverlayLayout,
} from "./view/format.ts";

const WIDGET_KEY = "rpiv-todos";
const SUMMARY_GUTTER = " ".repeat(SELF_RENDERED_TRANSCRIPT_PADDING);
const COLLAPSED_GUTTER = "  ";
const TASK_ROW_GUTTER = "  ";
const ALL_COMPLETE_LINGER_MS = 5_000;
const RECENT_COMPLETION_MS = 30_000;

export interface TodoOverlayRefreshOptions {
	readonly forceExpanded?: boolean;
	readonly lingerCompleted?: boolean;
}

function currentTasks() {
	return getRenderState().tasks;
}

function renderableTasks(tasks: ReturnType<typeof currentTasks>) {
	return tasks.filter((task) => task.status !== "deleted");
}

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private collapsed = false;
	private suppressed = false;
	private completedHidden = false;
	private completedHideTimer: ReturnType<typeof setTimeout> | undefined;
	private previousStatusById = new Map<string, TaskStatus>();
	private completedAtById = new Map<string, number>();
	private hasObservedSnapshot = false;

	setUICtx(ctx: ExtensionUIContext): void {
		if (ctx === this.uiCtx) return;
		this.cancelCompletedHide();
		this.uiCtx = ctx;
		this.widgetRegistered = false;
		this.tui = undefined;
		this.completedHidden = false;
		this.previousStatusById.clear();
		this.completedAtById.clear();
		this.hasObservedSnapshot = false;
	}

	refresh(options: TodoOverlayRefreshOptions = {}): void {
		if (!this.uiCtx) return;
		const { forceExpanded = false, lingerCompleted = false } = options;
		const shouldForceRender = forceExpanded && this.collapsed;
		if (forceExpanded) this.collapsed = false;

		const tasks = currentTasks();
		const renderable = renderableTasks(tasks);
		this.trackRecentCompletions(tasks, Date.now());
		if (renderable.length === 0) {
			this.completedHidden = false;
			this.cancelCompletedHide();
			this.unregisterWidget();
			return;
		}

		const allCompleted = renderable.every((task) => task.status === "completed");
		if (!allCompleted) {
			this.completedHidden = false;
			this.cancelCompletedHide();
		} else if (lingerCompleted) {
			this.completedHidden = false;
			this.scheduleCompletedHide();
		} else if (!this.completedHideTimer) {
			this.completedHidden = true;
		}

		if (this.suppressed || this.completedHidden) {
			this.unregisterWidget();
			return;
		}
		this.registerOrRenderWidget(shouldForceRender);
	}

	toggle(): void {
		this.collapsed = !this.collapsed;
		this.tui?.requestRender(true);
	}

	isRegistered(): boolean {
		return this.widgetRegistered;
	}

	setSuppressed(suppressed: boolean): void {
		if (suppressed === this.suppressed) return;
		this.suppressed = suppressed;
		if (suppressed) this.unregisterWidget();
		else this.refresh();
	}

	dispose(): void {
		this.cancelCompletedHide();
		this.unregisterWidget();
		this.uiCtx = undefined;
		this.collapsed = false;
		this.suppressed = false;
		this.completedHidden = false;
		this.previousStatusById.clear();
		this.completedAtById.clear();
		this.hasObservedSnapshot = false;
	}

	private registerOrRenderWidget(forceRender = false): void {
		if (!this.uiCtx) return;
		if (this.widgetRegistered) {
			this.tui?.requestRender(forceRender);
			return;
		}

		this.uiCtx.setWidget(
			WIDGET_KEY,
			(tui, factoryTheme) => {
				this.tui = tui;
				return {
					render: (width: number) => this.renderWidget(this.uiCtx?.theme ?? factoryTheme, width),
					invalidate: () => {},
				};
			},
			{ placement: "aboveEditor" },
		);
		this.widgetRegistered = true;
	}

	private unregisterWidget(): void {
		if (!this.widgetRegistered || !this.uiCtx) return;
		this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}

	private renderWidget(theme: Theme, width: number): string[] {
		if (this.completedHidden) return [];
		const tasks = currentTasks();
		if (renderableTasks(tasks).length === 0) return [];

		const now = Date.now();
		this.trackRecentCompletions(tasks, now);
		const recentCompletedIds = new Set(
			[...this.completedAtById]
				.filter(([, completedAt]) => now - completedAt < RECENT_COMPLETION_MS)
				.map(([id]) => id),
		);
		const layout = selectOverlayLayout(tasks, recentCompletedIds);
		const truncate = (line: string): string => truncateToWidth(line, Math.max(0, width), "…");

		if (this.collapsed) return [truncate(`${COLLAPSED_GUTTER}${formatCollapsedNextLine(layout.next, theme)}`)];

		const renderable = renderableTasks(tasks);
		const completed = renderable.filter((task) => task.status === "completed").length;
		const open = renderable.length - completed;
		const summary = theme.fg(
			"accent",
			theme.bold(`${String(renderable.length)} tasks (${String(completed)} done, ${String(open)} open)`),
		);
		const taskWidth = Math.max(0, width - visibleWidth(TASK_ROW_GUTTER));
		const lines = [truncate(`${SUMMARY_GUTTER}${summary}`)];
		lines.push(
			...layout.visible.map((row) => truncate(`${TASK_ROW_GUTTER}${formatOverlayTaskLine(row, theme, taskWidth)}`)),
		);
		if (layout.hidden.length > 0) {
			lines.push(truncate(`${TASK_ROW_GUTTER}${formatOverlayOverflowLine(layout.hidden, theme)}`));
		}
		return lines;
	}

	private trackRecentCompletions(tasks: ReturnType<typeof currentTasks>, now: number): void {
		const isInitialSnapshot = !this.hasObservedSnapshot;
		const nextStatuses = new Map<string, TaskStatus>();
		for (const task of tasks) {
			const id = String(task.id);
			const previousStatus = this.previousStatusById.get(id);
			nextStatuses.set(id, task.status);
			if (!isInitialSnapshot && task.status === "completed" && previousStatus !== "completed") {
				this.completedAtById.set(id, now);
			} else if (task.status !== "completed") {
				this.completedAtById.delete(id);
			}
		}
		for (const id of this.completedAtById.keys()) {
			if (!nextStatuses.has(id)) this.completedAtById.delete(id);
		}
		this.previousStatusById = nextStatuses;
		this.hasObservedSnapshot = true;
	}

	private scheduleCompletedHide(): void {
		if (this.completedHideTimer) return;
		this.completedHideTimer = setTimeout(() => {
			this.completedHideTimer = undefined;
			const tasks = renderableTasks(currentTasks());
			if (tasks.length === 0 || !tasks.every((task) => task.status === "completed")) return;
			this.completedHidden = true;
			this.unregisterWidget();
		}, ALL_COMPLETE_LINGER_MS);
		this.completedHideTimer.unref();
	}

	private cancelCompletedHide(): void {
		if (!this.completedHideTimer) return;
		clearTimeout(this.completedHideTimer);
		this.completedHideTimer = undefined;
	}
}
