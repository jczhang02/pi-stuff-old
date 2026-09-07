import type { Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	type CommandDialogComponent,
	type CommandDialogView,
	type CommandDialogViewContext,
	commandDialogExitKeyHelp,
	commandDialogListIndex,
	commandDialogListKeyHelp,
	commandDialogNavigation,
	commandDialogPrimaryKey,
	commandDialogReadKeyHelp,
	commandDialogReadOnlyPageHint,
	commandDialogRows,
	commandDialogScrollOffset,
	commandDialogSectionHeading,
	fitCommandDialogRows,
	fitFixedCommandDialogRows,
	matchesCommandDialogCancel,
	matchesCommandDialogConfirm,
	matchesCommandDialogHelp,
	matchesCommandDialogPaneSwitch,
	renderCommandDialogKeyHelp,
	renderCommandDialogSplit,
	WIDE_COMMAND_DIALOG_MIN_WIDTH,
} from "../../conversation-ui/index.ts";
import type { BackgroundWorkOutcome, BackgroundWorkSnapshot } from "./runtime.ts";

type TaskDialogMode = "detail" | "list";

interface TaskRow {
	command?: string;
	description?: string;
	readonly id: string;
	readonly kind: BackgroundWorkSnapshot["kind"];
	monitorFailureText?: string;
	monitorSource?: "command" | "file" | "http" | "log";
	monitorSuccessText?: string;
	monitorTarget?: string;
	monitorTimeoutSeconds?: number;
	output?: string;
	readonly startedAt?: number;
	readonly status: string;
	readonly title: string;
}

const GUTTER = "  ";
const LIST_ROWS = 9;

interface TasksDialogRuntime {
	scheduleRefresh(callback: () => void, intervalMs: number): () => void;
	snapshot(): readonly BackgroundWorkSnapshot[];
	stop(id: string): Promise<BackgroundWorkOutcome>;
	subscribe(listener: () => void): () => void;
}
const NARROW_LIST_ROWS = 6;
const NARROW_WIDTH = 64;
const TASK_DIALOG_ROWS = 18;

function oneLine(value: string): string {
	return value
		.replace(/[\r\n\t]+/gu, " ")
		.replace(/\s+/gu, " ")
		.trim();
}

function bounded(width: number, line: string): string {
	return truncateToWidth(line, Math.max(1, width), "…");
}

function elapsed(startedAt: number | undefined): string {
	if (startedAt === undefined) return "—";
	const seconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
	if (seconds < 60) return `${String(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60)}s`;
	return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60)}m`;
}

function kindLabel(kind: TaskRow["kind"]): string {
	switch (kind) {
		case "monitor":
			return "Monitor";
		case "shell":
			return "Shell";
	}
}

function statusText(theme: Theme, status: string, value: string): string {
	if (status === "failed") return theme.fg("error", value);
	if (status === "complete" || status === "completed") return theme.fg("success", value);
	if (status === "stopping" || status === "waiting" || status === "queued") return theme.fg("warning", value);
	if (status === "running" || status === "resuming") return theme.fg("accent", value);
	return theme.fg("muted", value);
}

function statusGlyph(status: string): string {
	if (status === "queued" || status === "waiting") return "○";
	if (status === "stopping") return "◐";
	if (status === "resuming") return "↻";
	if (status === "complete" || status === "completed") return "✓";
	if (status === "failed") return "×";
	if (status === "paused" || status === "stopped") return "■";
	return "●";
}

function fromOwned(snapshot: BackgroundWorkSnapshot): TaskRow {
	const row: TaskRow = {
		id: snapshot.id,
		kind: snapshot.kind,
		startedAt: snapshot.startedAt,
		status: snapshot.status,
		title: snapshot.title,
	};
	if (snapshot.command) row.command = snapshot.command;
	if (snapshot.description) row.description = snapshot.description;
	if (snapshot.monitorFailureText) row.monitorFailureText = snapshot.monitorFailureText;
	if (snapshot.monitorSource) row.monitorSource = snapshot.monitorSource;
	if (snapshot.monitorSuccessText) row.monitorSuccessText = snapshot.monitorSuccessText;
	if (snapshot.monitorTarget) row.monitorTarget = snapshot.monitorTarget;
	if (snapshot.monitorTimeoutSeconds !== undefined) row.monitorTimeoutSeconds = snapshot.monitorTimeoutSeconds;
	if (snapshot.recentOutput) row.output = snapshot.recentOutput;
	return row;
}

function fitRow(theme: Theme, row: TaskRow, selected: boolean, width: number): string {
	const cursor = selected ? theme.fg("accent", "›") : " ";
	const label = selected ? theme.bold(kindLabel(row.kind)) : kindLabel(row.kind);
	const title = oneLine(row.title);
	const description = row.description && oneLine(row.description) !== title ? `  ${oneLine(row.description)}` : "";
	const suffix = statusText(theme, row.status, `${statusGlyph(row.status)} ${elapsed(row.startedAt)}`);
	const available = Math.max(1, width - visibleWidth(GUTTER));
	const identityWidth = Math.max(1, available - visibleWidth(suffix) - 1);
	const identity = truncateToWidth(
		`${cursor} ${label}  ${selected ? theme.bold(title) : title}${theme.fg("muted", description)}`,
		identityWidth,
		"…",
	);
	const spacing = " ".repeat(Math.max(1, available - visibleWidth(identity) - visibleWidth(suffix)));
	return `${GUTTER}${identity}${spacing}${suffix}`;
}

function hint(theme: Theme, width: number, values: readonly string[]): string[] {
	const contentWidth = Math.max(1, width - visibleWidth(GUTTER));
	const lines: string[] = [];
	let current = "";
	for (const value of values) {
		const candidate = current ? `${current} · ${value}` : value;
		if (current && visibleWidth(candidate) > contentWidth) {
			lines.push(current);
			current = value;
		} else current = candidate;
	}
	if (current) lines.push(current);
	return lines.map((line) => `${GUTTER}${theme.fg("dim", line)}`);
}

class TasksDialogComponent implements CommandDialogComponent {
	private readonly context: CommandDialogViewContext<void>;
	private disposed = false;
	private lastDetailWidth = 80;
	private lastListViewportRows = NARROW_LIST_ROWS;
	private lastWidth = 80;
	private mode: TaskDialogMode = "list";
	private note = "";
	private rows: readonly TaskRow[] = [];
	private scrollOffset = 0;
	private selectedId: string | undefined;
	private showKeyHelp = false;
	private splitFocus: "left" | "right" = "left";
	private stopping = false;
	private readonly cancelRefresh: () => void;
	private readonly runtime: TasksDialogRuntime;
	private readonly unsubscribe: () => void;

	constructor(runtime: TasksDialogRuntime, context: CommandDialogViewContext<void>) {
		this.context = context;
		this.runtime = runtime;
		this.refresh();
		this.unsubscribe = runtime.subscribe(() => this.refresh());
		this.cancelRefresh = runtime.scheduleRefresh(() => context.requestRender(), 1_000);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelRefresh();
		this.unsubscribe();
	}

	handleInput(data: string): void {
		if (this.disposed || isKeyRelease(data)) return;
		if (this.showKeyHelp) {
			if (matchesCommandDialogCancel(data, this.context.keybindings)) {
				this.showKeyHelp = false;
				this.context.requestRender();
			}
			return;
		}
		if (matchesCommandDialogHelp(data)) {
			this.showKeyHelp = true;
			this.context.requestRender();
			return;
		}
		if (matchesCommandDialogCancel(data, this.context.keybindings)) {
			if (this.isSplit()) {
				if (this.splitFocus === "right") this.splitFocus = "left";
				else this.context.close();
				this.scrollOffset = 0;
				this.context.requestRender();
				return;
			}
			if (this.mode === "detail") {
				this.mode = "list";
				this.scrollOffset = 0;
				this.context.requestRender();
			} else {
				this.context.close();
			}
			return;
		}
		if (this.isSplit() && matchesCommandDialogPaneSwitch(data)) {
			this.splitFocus = this.splitFocus === "left" ? "right" : "left";
			this.scrollOffset = 0;
			this.context.requestRender();
			return;
		}
		if (this.stopping) return;
		if (matchesKey(data, "x")) {
			void this.stopSelected();
			return;
		}
		if (this.isSplit()) {
			if (this.splitFocus === "left") this.handleListInput(data);
			else this.handleDetailInput(data);
		} else if (this.mode === "list") this.handleListInput(data);
		else this.handleDetailInput(data);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const wasSplit = this.isSplit();
		this.lastWidth = Math.max(1, Math.floor(width));
		const isSplit = this.isSplit();
		if (wasSplit !== isSplit) {
			if (isSplit) this.splitFocus = this.mode === "detail" ? "right" : "left";
			else this.mode = this.splitFocus === "right" ? "detail" : "list";
		}
		if (this.showKeyHelp) {
			const list = isSplit ? this.splitFocus === "left" : this.mode === "list";
			const extra = [
				...(isSplit ? [{ keys: "Tab/Shift+Tab", description: "Switch panes" }] : []),
				...(this.selected()?.status !== "stopping" ? [{ keys: "x", description: "Stop selected task" }] : []),
			];
			let keyHelp = commandDialogReadKeyHelp(this.context.keybindings, "line", extra);
			if (list) {
				keyHelp =
					this.rows.length > 0
						? commandDialogListKeyHelp(this.context.keybindings, "task", extra)
						: commandDialogExitKeyHelp(this.context.keybindings);
			}
			return renderCommandDialogKeyHelp(this.context, this.lastWidth, "Tasks", keyHelp);
		}
		const lines = isSplit ? this.renderSplit() : this.mode === "list" ? this.renderList() : this.renderDetail();
		return lines.map((line) => bounded(this.lastWidth, line));
	}

	private isSplit(): boolean {
		return this.lastWidth >= WIDE_COMMAND_DIALOG_MIN_WIDTH && this.rows.length > 0;
	}

	private renderSplit(): string[] {
		return renderCommandDialogSplit(
			this.context.theme,
			this.lastWidth,
			(leftWidth) => this.renderList(leftWidth, this.splitFocus === "left", true),
			(rightWidth) => this.renderDetail(rightWidth, this.splitFocus === "right", true),
		);
	}

	private refresh(): void {
		this.rows = this.runtime.snapshot().map(fromOwned);
		if (!this.selectedId || !this.rows.some((row) => row.id === this.selectedId)) {
			this.selectedId = this.rows[0]?.id;
			this.scrollOffset = 0;
			if (!this.selectedId) this.mode = "list";
		}
		this.context.requestRender();
	}

	private selected(): TaskRow | undefined {
		return this.rows.find((row) => row.id === this.selectedId);
	}

	private handleListInput(data: string): void {
		if (matchesCommandDialogConfirm(data, this.context.keybindings)) {
			const selected = this.selected();
			if (!selected) return;
			if (this.isSplit()) {
				this.splitFocus = "right";
				this.scrollOffset = 0;
				this.context.requestRender();
				return;
			}
			this.mode = "detail";
			this.scrollOffset = 0;
			this.context.requestRender();
			return;
		}
		const navigation = commandDialogNavigation(data, this.context.keybindings);
		if (!navigation) return;
		const current = Math.max(
			0,
			this.rows.findIndex((row) => row.id === this.selectedId),
		);
		const next = commandDialogListIndex(current, this.rows.length, this.lastListViewportRows, navigation);
		this.selectedId = this.rows[next]?.id;
		this.note = "";
		this.scrollOffset = 0;
		this.context.requestRender();
	}

	private handleDetailInput(data: string): void {
		const navigation = commandDialogNavigation(data, this.context.keybindings);
		if (!navigation) return;
		const document = this.detailDocument(this.selected());
		const page = Math.max(1, commandDialogRows(this.context) - 10);
		const maximum = Math.max(0, document.length - page);
		this.scrollOffset = commandDialogScrollOffset(this.scrollOffset, maximum, page, navigation);
		this.context.requestRender();
	}

	private async stopSelected(): Promise<void> {
		const row = this.selected();
		if (!row) return;
		if (row.status === "stopping") return;
		this.stopping = true;
		this.note = `Stopping ${row.id}…`;
		this.context.requestRender();
		try {
			const outcome = await this.runtime.stop(row.id);
			this.note = outcome.summary;
		} catch (error) {
			this.note = error instanceof Error ? error.message : String(error);
		} finally {
			this.stopping = false;
			this.context.requestRender();
		}
	}

	private renderList(width = this.lastWidth, focused = false, stable = false): string[] {
		const theme = this.context.theme;
		const selected = this.selected();
		const up = commandDialogPrimaryKey(this.context.keybindings, "tui.select.up", "↑");
		const down = commandDialogPrimaryKey(this.context.keybindings, "tui.select.down", "↓");
		const confirm = commandDialogPrimaryKey(this.context.keybindings, "tui.select.confirm", "Enter");
		const cancel = commandDialogPrimaryKey(this.context.keybindings, "tui.select.cancel", "Esc");
		const rowHints: string[] = [];
		if (this.rows.length > 0) {
			rowHints.push(`${up}/${down} select`);
			if (this.isSplit()) rowHints.push("Tab pane");
			rowHints.push(`${confirm} details`);
		}
		const baseHints = [
			...rowHints,
			...(selected && selected.status !== "stopping" ? ["x stop"] : []),
			"? keys",
			`${cancel} close`,
		];
		let footer = hint(theme, width, baseHints);
		const maximum = stable
			? Math.min(TASK_DIALOG_ROWS, commandDialogRows(this.context))
			: commandDialogRows(this.context);
		const preferred = width <= NARROW_WIDTH ? NARROW_LIST_ROWS : LIST_ROWS;
		let viewport = Math.min(preferred, Math.max(0, maximum - footer.length - 4));
		const page = commandDialogReadOnlyPageHint(this.rows.length > viewport);
		if (page) {
			baseHints.splice(1, 0, page);
			footer = hint(theme, width, baseHints);
			viewport = Math.min(preferred, Math.max(0, maximum - footer.length - 4));
		}
		this.lastListViewportRows = Math.max(1, viewport);
		const selectedIndex = Math.max(
			0,
			this.rows.findIndex((row) => row.id === this.selectedId),
		);
		const start = Math.max(0, Math.min(selectedIndex - Math.floor(viewport / 2), this.rows.length - viewport));
		const visible = viewport > 0 ? this.rows.slice(start, start + viewport) : [];
		const title = focused ? theme.bold(theme.fg("accent", "Tasks")) : theme.bold("Tasks");
		const header = [
			theme.fg("border", "━".repeat(width)),
			`${GUTTER}${title}${theme.fg("dim", ` · ${String(this.rows.length)} current`)}`,
		];
		const emptyLine = `${GUTTER}${theme.fg("dim", "No background work in this session.")}`;
		const rowLines = [
			...(start > 0 ? [`${GUTTER}${theme.fg("dim", `… ${String(start)} earlier`)}`] : []),
			...visible.map((row) => fitRow(theme, row, row.id === this.selectedId, width)),
			...(start + visible.length < this.rows.length
				? [`${GUTTER}${theme.fg("dim", `… ${String(this.rows.length - start - visible.length)} later`)}`]
				: []),
		];
		const noteLine = this.note ? `${GUTTER}${theme.fg("dim", oneLine(this.note))}` : undefined;
		const body = ["", ...(rowLines.length === 0 ? [emptyLine] : rowLines), ...(noteLine ? [noteLine] : [])];
		while (header.length + body.length + footer.length < maximum && body.length < preferred + 1) body.push("");
		const selectedLine = selected ? fitRow(theme, selected, true, width) : undefined;
		const sections = { header, body, footer, priority: [noteLine ?? selectedLine ?? emptyLine] };
		return stable ? fitFixedCommandDialogRows(sections, maximum) : fitCommandDialogRows(sections, maximum);
	}

	private renderDetail(width = this.lastWidth, focused = false, stable = false): string[] {
		this.lastDetailWidth = width;
		const row = this.selected();
		if (!row) {
			this.mode = "list";
			return this.renderList(width, focused, stable);
		}
		const theme = this.context.theme;
		const up = commandDialogPrimaryKey(this.context.keybindings, "tui.select.up", "↑");
		const down = commandDialogPrimaryKey(this.context.keybindings, "tui.select.down", "↓");
		const cancel = commandDialogPrimaryKey(this.context.keybindings, "tui.select.cancel", "Esc");
		const maximum = stable
			? Math.min(TASK_DIALOG_ROWS, commandDialogRows(this.context))
			: commandDialogRows(this.context);
		const document = this.detailDocument(row, width);
		let footer = hint(theme, width, [
			`${up}/${down} scroll`,
			...(this.isSplit() ? ["Tab pane"] : []),
			...(row.status !== "stopping" ? ["x stop"] : []),
			"? keys",
			`${cancel} back`,
		]);
		let fixedRows = 7 + footer.length + (this.note ? 1 : 0);
		if (document.length > Math.max(0, maximum - fixedRows)) {
			const page = commandDialogReadOnlyPageHint(true);
			footer = hint(theme, width, [
				`${up}/${down} scroll`,
				...(page ? [page] : []),
				...(this.isSplit() ? ["Tab pane"] : []),
				...(row.status !== "stopping" ? ["x stop"] : []),
				"? keys",
				`${cancel} back`,
			]);
			fixedRows = 7 + footer.length + (this.note ? 1 : 0);
		}
		const viewport = Math.max(0, maximum - fixedRows);
		const maxOffset = Math.max(0, document.length - viewport);
		this.scrollOffset = Math.min(maxOffset, this.scrollOffset);
		const visible = document.slice(this.scrollOffset, this.scrollOffset + viewport);
		const stateLine = `${GUTTER}${statusText(theme, row.status, `${statusGlyph(row.status)} ${row.status}`)} ${theme.fg("dim", `· ${elapsed(row.startedAt)} · task ${oneLine(row.id)}`)}`;
		const noteLine = this.note ? `${GUTTER}${theme.fg("dim", oneLine(this.note))}` : undefined;
		const breadcrumb = `Tasks / ${kindLabel(row.kind)}`;
		const title = focused ? theme.bold(theme.fg("accent", breadcrumb)) : theme.bold(breadcrumb);
		const header = [theme.fg("border", "━".repeat(width)), `${GUTTER}${title}`];
		const body = [
			"",
			`${GUTTER}${theme.bold(oneLine(row.title))}`,
			stateLine,
			"",
			...visible.map((line) => `${GUTTER}${line}`),
			...(noteLine ? [noteLine] : []),
			"",
		];
		const sections = { header, body, footer, priority: [noteLine ?? stateLine] };
		return stable ? fitFixedCommandDialogRows(sections, maximum) : fitCommandDialogRows(sections, maximum);
	}

	private detailDocument(row: TaskRow | undefined, paneWidth = this.lastDetailWidth): readonly string[] {
		if (!row) return [];
		const width = Math.max(1, paneWidth - visibleWidth(GUTTER));
		const wrap = (value: string) => value.split(/\r?\n/gu).flatMap((line) => wrapTextWithAnsi(line || " ", width));
		if (row.kind === "shell") {
			return [
				commandDialogSectionHeading(this.context.theme, "Command", ""),
				...wrap(row.command ?? "Command unavailable."),
				"",
				commandDialogSectionHeading(this.context.theme, "Output", ""),
				...wrap(row.output ?? "No output yet."),
			];
		}
		const source = row.monitorSource
			? `${row.monitorSource.toUpperCase()} · ${row.monitorTarget ?? row.command ?? "target unavailable"}`
			: row.command
				? `COMMAND · ${row.command}`
				: "Source unavailable.";
		const conditions = [
			...(row.monitorSuccessText ? [`success contains ${JSON.stringify(row.monitorSuccessText)}`] : []),
			...(row.monitorFailureText ? [`failure contains ${JSON.stringify(row.monitorFailureText)}`] : []),
			...(row.monitorTimeoutSeconds !== undefined ? [`timeout ${String(row.monitorTimeoutSeconds)}s`] : []),
		];
		return [
			commandDialogSectionHeading(this.context.theme, "Source", ""),
			...wrap(source),
			"",
			commandDialogSectionHeading(this.context.theme, "Condition", ""),
			...wrap(conditions.join(" · ") || "No completion text; any successful probe completes the monitor."),
			"",
			commandDialogSectionHeading(this.context.theme, "Latest evidence", ""),
			...wrap(row.output ?? "No evidence yet."),
		];
	}
}

export function createTasksDialogView(runtime: TasksDialogRuntime): CommandDialogView<void> {
	return {
		priority: "normal",
		create: (context) => new TasksDialogComponent(runtime, context),
	};
}
