import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DiagnosticChannel, DiagnosticRecord, DiagnosticSeverity } from "./diagnostics.ts";
import type { CommandDialogChrome } from "./index.ts";

const WIDGET_KEY = "pi-stuff-diagnostic-notice";
const GUTTER = "  ";

function glyph(severity: DiagnosticSeverity): string {
	switch (severity) {
		case "info":
			return "●";
		case "warning":
			return "!";
		case "error":
			return "×";
	}
}

function severityColor(severity: DiagnosticSeverity): "accent" | "error" | "warning" {
	switch (severity) {
		case "info":
			return "accent";
		case "warning":
			return "warning";
		case "error":
			return "error";
	}
}

function oneNotice(theme: Theme, record: DiagnosticRecord): string {
	const marker = theme.fg(severityColor(record.severity), glyph(record.severity));
	const source = theme.bold(theme.fg("text", record.capability));
	const separator = theme.fg("dim", " · ");
	return `${GUTTER}${marker} ${source}${separator}${theme.fg("muted", record.summary)}`;
}

function manyNotices(theme: Theme, records: readonly DiagnosticRecord[]): string {
	const severity = records[0]?.severity ?? "warning";
	const marker = theme.fg(severityColor(severity), glyph(severity));
	return `${GUTTER}${marker} ${theme.bold(theme.fg("text", "Pi Stuff"))}${theme.fg("dim", " · ")}${theme.fg(
		"muted",
		`${String(records.length)} issues need attention`,
	)}`;
}

export function renderDiagnosticNotice(theme: Theme, width: number, records: readonly DiagnosticRecord[]): string[] {
	const renderWidth = Math.max(0, Math.floor(width));
	if (renderWidth === 0 || records.length === 0) return [];
	const action = theme.fg("dim", "/diagnostics");
	const suffix = `${theme.fg("dim", " · ")}${action}`;
	const content = records.length === 1 && records[0] ? oneNotice(theme, records[0]) : manyNotices(theme, records);
	const minimum = `${GUTTER}${glyph(records[0]?.severity ?? "warning")} ${action}`;
	if (visibleWidth(minimum) >= renderWidth) return [truncateToWidth(minimum, renderWidth, "…")];
	const available = Math.max(1, renderWidth - visibleWidth(suffix));
	return [`${truncateToWidth(content, available, "…")}${suffix}`];
}

/** Owns the single focus-neutral notice row above the editor. */
export class DiagnosticNoticeController implements CommandDialogChrome {
	private readonly channel: DiagnosticChannel;
	private disposed = false;
	private suppressed = false;
	private tui: TUI | undefined;
	private readonly ui: ExtensionUIContext;
	private readonly unsubscribe: () => void;
	private widgetRegistered = false;

	constructor(ui: ExtensionUIContext, channel: DiagnosticChannel) {
		this.ui = ui;
		this.channel = channel;
		this.unsubscribe = channel.subscribe(() => this.refresh());
		this.refresh();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
		this.unregisterWidget();
	}

	setSuppressed(suppressed: boolean): void {
		if (this.suppressed === suppressed) return;
		this.suppressed = suppressed;
		this.refresh();
	}

	private refresh(): void {
		if (this.disposed || this.suppressed || this.channel.listNotices().length === 0) {
			this.unregisterWidget();
			return;
		}
		if (this.widgetRegistered) {
			this.tui?.requestRender();
			return;
		}
		this.ui.setWidget(
			WIDGET_KEY,
			(tui, theme) => {
				this.tui = tui;
				return {
					invalidate: () => {},
					render: (width: number) =>
						renderDiagnosticNotice(this.ui.theme ?? theme, width, this.channel.listNotices()),
				};
			},
			{ placement: "aboveEditor" },
		);
		this.widgetRegistered = true;
	}

	private unregisterWidget(): void {
		if (!this.widgetRegistered) return;
		this.ui.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
	}
}
