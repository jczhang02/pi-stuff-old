import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	type Focusable,
	Input,
	type SelectItem,
	SelectList,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type CommandDialogComponent,
	type CommandDialogView,
	type CommandDialogViewContext,
	commandDialogRows,
	commandDialogSectionHeading,
	fitCommandDialogRows,
} from "../conversation-ui/index.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import { boundTerminalText } from "../tool-display/index.ts";

export type ContextDialogAction = "flush" | "recomp" | "upgrade" | "wrapup";

export interface ContextDialogCommand {
	readonly args: string;
	readonly confirmed?: true;
	readonly operation: ContextDialogAction;
}

export interface ContextUsageSnapshot {
	readonly contextWindow?: number | null;
	readonly percent?: number | null;
	readonly tokens?: number | null;
}

export interface MagicStatusMessage {
	readonly details?: unknown;
	readonly level?: string;
	readonly text?: string;
	readonly title?: string;
}

export interface ContextDialogSnapshot {
	readonly activeTags: number;
	readonly cache: string;
	readonly compartmentCount: number;
	readonly continuity?: "degraded";
	readonly continuityDetail?: string;
	readonly contextWindow?: number;
	readonly droppedTags: number;
	readonly error?: string;
	readonly historian: "idle" | "running";
	readonly historyTokens?: number;
	readonly memoryCount: number;
	readonly noteCount: number;
	readonly pendingOps: number;
	readonly percent?: number;
	readonly tokens?: number;
	readonly upgradeNeeded?: number;
}

export interface ContextDialogOptions {
	readonly refresh?: () => Promise<ContextDialogSnapshot>;
	readonly refreshIntervalMs?: number;
}

type ContextDialogScreen =
	| { readonly kind: "overview" }
	| { readonly kind: "recomp" }
	| { readonly args: string; readonly kind: "recomp-confirm" }
	| { readonly kind: "recomp-range" }
	| { readonly kind: "wrapup" }
	| { readonly kind: "wrapup-input" };

const GUTTER = "  ";
const ERROR_MAX_CELLS = 2_000;
const REFRESH_INTERVAL_MS = 1_000;

interface ParsedMagicStatusDetails {
	activeTags?: number;
	compartmentCount?: number;
	droppedTags?: number;
	historianError?: string;
	historianRunning: boolean;
	memoryCount?: number;
	noteCount?: number;
	pendingOps?: number;
}

type ContextDialogSnapshotBuilder = { -readonly [Key in keyof ContextDialogSnapshot]: ContextDialogSnapshot[Key] };

function finite<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) ? value : undefined;
}

function parseMagicStatusDetails<Value>(value: Value): ParsedMagicStatusDetails {
	const parsed: ParsedMagicStatusDetails = { historianRunning: false };
	if (!isRuntimeObject(value) || value === null || Array.isArray(value)) return parsed;
	const activeTags = "activeTags" in value ? finite(value.activeTags) : undefined;
	const compartmentCount = "compartmentCount" in value ? finite(value.compartmentCount) : undefined;
	const droppedTags = "droppedTags" in value ? finite(value.droppedTags) : undefined;
	const memoryCount = "memoryCount" in value ? finite(value.memoryCount) : undefined;
	const noteCount = "noteCount" in value ? finite(value.noteCount) : undefined;
	const pendingOps = "pendingOps" in value ? finite(value.pendingOps) : undefined;
	if (activeTags !== undefined) parsed.activeTags = activeTags;
	if (compartmentCount !== undefined) parsed.compartmentCount = compartmentCount;
	if (droppedTags !== undefined) parsed.droppedTags = droppedTags;
	if (memoryCount !== undefined) parsed.memoryCount = memoryCount;
	if (noteCount !== undefined) parsed.noteCount = noteCount;
	if (pendingOps !== undefined) parsed.pendingOps = pendingOps;
	const historian = "historian" in value ? value.historian : undefined;
	if (isRuntimeObject(historian) && historian !== null && !Array.isArray(historian)) {
		parsed.historianRunning = "inProgress" in historian && historian.inProgress === true;
		if ("lastError" in historian && isRuntimeString(historian.lastError)) {
			parsed.historianError = historian.lastError;
		}
	}
	return parsed;
}

function textNumber(text: string, pattern: RegExp): number | undefined {
	const match = pattern.exec(text);
	if (!match?.[1]) return undefined;
	const value = Number(match[1].replaceAll(",", ""));
	return Number.isFinite(value) ? value : undefined;
}

function count(detail: number | undefined, text: string, pattern: RegExp): number {
	return detail ?? textNumber(text, pattern) ?? 0;
}

function usageValue(value: number | null | undefined): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeDialogError(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const safe = boundTerminalText(value, ERROR_MAX_CELLS).trim();
	return safe.length > 0 ? safe : undefined;
}

function cacheStatus(text: string): string {
	const remaining = /^- Remaining:\s*(.+)$/imu.exec(text)?.[1]?.trim();
	if (!remaining) return "unknown";
	if (remaining.toLowerCase() === "expired") return "expired";
	return `${remaining} remaining`;
}

export function statusSnapshotFromMagic(
	message: MagicStatusMessage | undefined,
	usage: ContextUsageSnapshot | undefined,
	fallbackError?: string,
	continuityDetail?: string,
): ContextDialogSnapshot {
	const text = message?.text ?? "";
	const details = parseMagicStatusDetails(message?.details);
	const tokens = usageValue(usage?.tokens) ?? textNumber(text, /Last input tokens:\s*([\d,]+)/iu);
	const contextWindow = usageValue(usage?.contextWindow) ?? textNumber(text, /Resolved context limit:\s*([\d,]+)/iu);
	const percent =
		usageValue(usage?.percent) ??
		textNumber(text, /Last percentage:\s*([\d,.]+)%/iu) ??
		(tokens !== undefined && contextWindow !== undefined && contextWindow > 0
			? (tokens / contextWindow) * 100
			: undefined);
	const messageError = message?.level === "error" ? text.replace(/^#{1,6}\s+.*$/mu, "").trim() : undefined;
	const error =
		safeDialogError(fallbackError) ?? safeDialogError(messageError) ?? safeDialogError(details.historianError);
	const historyTokens = textNumber(text, /History block:\s*~?([\d,]+)\s+tokens/iu);
	const upgradeNeeded = textNumber(text, /([\d,]+)\s+compartments?\s+need upgrade/iu);
	const snapshot: ContextDialogSnapshotBuilder = {
		activeTags: count(details.activeTags, text, /- Active:\s*([\d,]+)/iu),
		cache: cacheStatus(text),
		compartmentCount: count(details.compartmentCount, text, /- Compartments:\s*([\d,]+)/iu),
		droppedTags: count(details.droppedTags, text, /- Dropped:\s*([\d,]+)/iu),
		historian: details.historianRunning ? "running" : "idle",
		memoryCount: count(details.memoryCount, text, /Memories:\s*([\d,]+)/iu),
		noteCount: count(details.noteCount, text, /Notes:\s*([\d,]+)/iu),
		pendingOps: count(details.pendingOps, text, /- Drops:\s*([\d,]+)/iu),
	};
	const safeContinuityDetail = safeDialogError(continuityDetail);
	if (safeContinuityDetail !== undefined) {
		snapshot.continuity = "degraded";
		snapshot.continuityDetail = safeContinuityDetail;
	}
	if (contextWindow !== undefined) snapshot.contextWindow = contextWindow;
	if (error !== undefined) snapshot.error = error;
	if (historyTokens !== undefined) snapshot.historyTokens = historyTokens;
	if (percent !== undefined) snapshot.percent = percent;
	if (tokens !== undefined) snapshot.tokens = tokens;
	if (upgradeNeeded !== undefined) snapshot.upgradeNeeded = upgradeNeeded;
	return snapshot;
}

function compactNumber(value: number | undefined): string {
	if (value === undefined) return "?";
	const absolute = Math.abs(value);
	if (absolute >= 1_000_000) return `${trimDecimal(value / 1_000_000)}M`;
	if (absolute >= 1_000) return `${trimDecimal(value / 1_000)}K`;
	return String(Math.round(value));
}

function trimDecimal(value: number): string {
	const fixed = value.toFixed(1);
	return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

function plural(value: number, singular: string, pluralForm = `${singular}s`): string {
	return `${String(value)} ${value === 1 ? singular : pluralForm}`;
}

function summaryLine(context: CommandDialogViewContext<ContextDialogCommand>, snapshot: ContextDialogSnapshot): string {
	const usage =
		snapshot.percent === undefined
			? "usage unavailable"
			: `${snapshot.percent.toFixed(1)}% · ${compactNumber(snapshot.tokens)} / ${compactNumber(snapshot.contextWindow)} tokens`;
	const color =
		snapshot.percent !== undefined && snapshot.percent >= 80
			? "error"
			: snapshot.percent !== undefined && snapshot.percent >= 65
				? "warning"
				: "accent";
	return `${GUTTER}${context.theme.bold("Context")} ${context.theme.fg("muted", "·")} ${context.theme.fg(color, usage)}`;
}

function overviewItems(snapshot: ContextDialogSnapshot): SelectItem[] {
	const items: SelectItem[] = [
		{
			description: "Choose recent messages to keep raw",
			label: "Wrap up history",
			value: "wrapup",
		},
	];
	if (snapshot.pendingOps > 0) {
		items.push({
			description: `${String(snapshot.pendingOps)} queued · apply on next request`,
			label: "Flush pending drops",
			value: "flush",
		});
	}
	items.push({
		description: "Choose scope, then confirm",
		label: "Rebuild compartments",
		value: "recomp",
	});
	if (snapshot.upgradeNeeded === undefined || snapshot.upgradeNeeded > 0) {
		items.push({
			description: "Upgrade legacy history and memories",
			label: "Upgrade session",
			value: "upgrade",
		});
	}
	return items;
}

function screenItems(screen: ContextDialogScreen, snapshot: ContextDialogSnapshot): SelectItem[] {
	if (screen.kind === "overview") return overviewItems(snapshot);
	if (screen.kind === "wrapup") {
		return [
			{
				description: "Recommended · compact everything older",
				label: "Keep 20 recent messages",
				value: "default",
			},
			{
				description: "Enter a different positive whole number",
				label: "Choose another amount",
				value: "custom",
			},
		];
	}
	if (screen.kind === "recomp") {
		return [
			{
				description: "Rebuild all eligible derived history",
				label: "Full session",
				value: "full",
			},
			{
				description: "Rebuild a message range such as 1-500",
				label: "Message range",
				value: "range",
			},
		];
	}
	if (screen.kind === "recomp-confirm") {
		return [
			{
				description: "Return without changing derived history",
				label: "Cancel",
				value: "cancel",
			},
			{
				description: "Start the Historian rebuild",
				label: "Rebuild now",
				value: "confirm",
			},
		];
	}
	return [];
}

function parsePositiveInteger(value: string): string | undefined {
	const trimmed = value.trim();
	if (!/^\d+$/u.test(trimmed)) return undefined;
	const parsed = Number(trimmed);
	return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : undefined;
}

function parseMessageRange(value: string): string | undefined {
	const match = /^(\d+)\s*-\s*(\d+)$/u.exec(value.trim());
	if (!match?.[1] || !match[2]) return undefined;
	const start = Number(match[1]);
	const end = Number(match[2]);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) return undefined;
	return `${String(start)}-${String(end)}`;
}

function stripSelectHelp(lines: readonly string[]): string[] {
	return lines.filter(
		(line) =>
			!line.includes("Enter to select") && !line.includes("Esc to cancel") && !line.includes("Type to filter"),
	);
}

class ContextDialog implements CommandDialogComponent, Focusable {
	private readonly context: CommandDialogViewContext<ContextDialogCommand>;
	private disposed = false;
	private error: string | undefined;
	private _focused = false;
	private input: Input | undefined;
	private readonly options: ContextDialogOptions;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private refreshing = false;
	private screen: ContextDialogScreen = { kind: "overview" };
	private selectList: SelectList | undefined;
	private snapshot: ContextDialogSnapshot;

	constructor(
		context: CommandDialogViewContext<ContextDialogCommand>,
		snapshot: ContextDialogSnapshot,
		options: ContextDialogOptions,
	) {
		this.context = context;
		this.snapshot = snapshot;
		this.options = options;
		this.rebuildControl();
		if (options.refresh) {
			this.refreshTimer = setInterval(() => void this.refresh(), options.refreshIntervalMs ?? REFRESH_INTERVAL_MS);
			this.refreshTimer.unref?.();
		}
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.input) this.input.focused = value;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.refreshTimer) clearInterval(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.input) this.input.handleInput(data);
		else this.selectList?.handleInput(data);
		this.context.requestRender();
	}

	invalidate(): void {
		this.input?.invalidate();
		this.selectList?.invalidate();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, Math.floor(width));
		const selectedLines = this.selectList ? stripSelectHelp(this.selectList.render(renderWidth)) : [];
		const inputLines = this.input
			? this.input.render(Math.max(1, renderWidth - GUTTER.length)).map((line) => `${GUTTER}${line}`)
			: [];
		const selected = selectedLines.find((line) => line.includes("→") || line.includes("›")) ?? selectedLines[0];
		const error = this.error ?? (this.screen.kind === "overview" ? this.snapshot.error : undefined);
		const safeError = safeDialogError(error);
		const errorLines = safeError
			? safeError.split("\n").flatMap((paragraph) => {
					const line = paragraph.trim();
					if (line.length === 0) return [];
					return wrapTextWithAnsi(line, Math.max(1, renderWidth - GUTTER.length)).map(
						(wrapped) => `${GUTTER}${this.context.theme.fg("error", wrapped)}`,
					);
				})
			: [];
		const continuityLines = this.snapshot.continuityDetail
			? wrapTextWithAnsi(
					`Continuity degraded · ${this.snapshot.continuityDetail}`,
					Math.max(1, renderWidth - GUTTER.length),
				).map((line) => `${GUTTER}${this.context.theme.fg("warning", line)}`)
			: [];
		const sections = this.renderScreen(selectedLines, inputLines, errorLines, continuityLines);
		const lines = fitCommandDialogRows(
			{
				body: sections.body,
				footer: [`${GUTTER}${this.context.theme.fg("dim", sections.footer)}`],
				header: [
					this.context.theme.fg("border", "━".repeat(renderWidth)),
					`${GUTTER}${this.context.theme.bold(sections.title)}`,
				],
				priority: [
					errorLines[0] ??
						(this.screen.kind === "overview" ? continuityLines[0] : undefined) ??
						selected ??
						inputLines[0] ??
						`${GUTTER}${sections.title}`,
				],
			},
			commandDialogRows(this.context),
		);
		return lines.map((line) => truncateToWidth(line, renderWidth, "…"));
	}

	private back(): void {
		if (this.screen.kind === "overview") {
			this.context.close();
			return;
		}
		if (this.screen.kind === "wrapup-input") this.setScreen({ kind: "wrapup" });
		else if (this.screen.kind === "wrapup") this.setScreen({ kind: "overview" });
		else if (this.screen.kind === "recomp-range" || this.screen.kind === "recomp-confirm") {
			this.setScreen({ kind: "recomp" });
		} else this.setScreen({ kind: "overview" });
	}

	private rebuildControl(selected?: string): void {
		this.input = undefined;
		this.selectList = undefined;
		if (this.screen.kind === "wrapup-input" || this.screen.kind === "recomp-range") {
			const input = new Input();
			input.focused = this._focused;
			input.onEscape = () => this.back();
			input.onSubmit = (value) => this.submitInput(value);
			this.input = input;
			return;
		}
		const items = screenItems(this.screen, this.snapshot);
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.onCancel = () => this.back();
		list.onSelect = (item) => this.select(item.value);
		if (selected) {
			const index = items.findIndex((item) => item.value === selected);
			if (index >= 0) list.setSelectedIndex(index);
		}
		this.selectList = list;
	}

	private renderScreen(
		selectedLines: readonly string[],
		inputLines: readonly string[],
		errorLines: readonly string[],
		continuityLines: readonly string[],
	) {
		if (this.screen.kind === "overview") {
			const counts = `${plural(this.snapshot.compartmentCount, "compartment")} · ${plural(this.snapshot.memoryCount, "memory", "memories")} · ${plural(this.snapshot.noteCount, "note")}`;
			const runtime = `Historian ${this.snapshot.historian} · cache ${this.snapshot.cache}`;
			const history = `History ${this.snapshot.historyTokens === undefined ? "unavailable" : `~${compactNumber(this.snapshot.historyTokens)} tokens`} · ${plural(this.snapshot.activeTags, "active tag")} · ${plural(this.snapshot.droppedTags, "dropped tag")}`;
			return {
				body: [
					"",
					commandDialogSectionHeading(this.context.theme, "Overview"),
					`${GUTTER}${this.context.theme.fg("muted", counts)}`,
					`${GUTTER}${this.context.theme.fg("muted", runtime)}`,
					`${GUTTER}${this.context.theme.fg("muted", history)}`,
					...(this.snapshot.pendingOps > 0 || errorLines.length > 0 || continuityLines.length > 0
						? [
								"",
								commandDialogSectionHeading(this.context.theme, "Attention"),
								...(this.snapshot.pendingOps > 0
									? [
											`${GUTTER}${this.context.theme.fg(
												"warning",
												`! ${plural(this.snapshot.pendingOps, "pending drop")} · removals waiting to apply`,
											)}`,
										]
									: []),
								...continuityLines,
								...errorLines,
							]
						: []),
					"",
					commandDialogSectionHeading(this.context.theme, "Actions"),
					...selectedLines,
				],
				footer: "↑/↓ select · Enter choose · Esc close",
				title: summaryLine(this.context, this.snapshot).slice(GUTTER.length),
			};
		}
		if (this.screen.kind === "wrapup") {
			return {
				body: [
					`${GUTTER}${this.context.theme.fg("muted", "Older messages become compact compartments; the newest messages stay raw.")}`,
					"",
					...selectedLines,
				],
				footer: "↑/↓ select · Enter choose · Esc back",
				title: "Context · Wrap up history",
			};
		}
		if (this.screen.kind === "wrapup-input") {
			return {
				body: [
					`${GUTTER}${this.context.theme.fg("muted", "How many newest messages should stay uncompressed?")}`,
					`${GUTTER}${this.context.theme.fg("dim", "Enter a positive whole number, for example 40.")}`,
					"",
					...inputLines,
					...errorLines,
				],
				footer: "Enter continue · Esc back",
				title: "Context · Messages to keep",
			};
		}
		if (this.screen.kind === "recomp") {
			return {
				body: [
					`${GUTTER}${this.context.theme.fg("muted", "Rebuild compartments from the original Pi session history.")}`,
					"",
					...selectedLines,
				],
				footer: "↑/↓ select · Enter choose · Esc back",
				title: "Context · Rebuild scope",
			};
		}
		if (this.screen.kind === "recomp-range") {
			return {
				body: [
					`${GUTTER}${this.context.theme.fg("muted", "Enter the inclusive message range to rebuild.")}`,
					`${GUTTER}${this.context.theme.fg("dim", "Use start-end, for example 1-500.")}`,
					"",
					...inputLines,
					...errorLines,
				],
				footer: "Enter continue · Esc back",
				title: "Context · Message range",
			};
		}
		const scope = this.screen.args ? `Messages ${this.screen.args}` : "Full eligible session";
		return {
			body: [
				`${GUTTER}${this.context.theme.fg("warning", scope)}`,
				`${GUTTER}${this.context.theme.fg("muted", "Derived compartments and facts will be regenerated with Historian model usage.")}`,
				`${GUTTER}${this.context.theme.fg("muted", "The original Pi session history is kept.")}`,
				"",
				...selectedLines,
			],
			footer: "↑/↓ select · Enter choose · Esc back",
			title: "Context · Confirm rebuild",
		};
	}

	private select(value: string): void {
		if (this.screen.kind === "overview") {
			if (value === "flush" || value === "upgrade") {
				this.context.close({ args: "", operation: value });
				return;
			}
			if (value === "wrapup") this.setScreen({ kind: "wrapup" });
			else if (value === "recomp") this.setScreen({ kind: "recomp" });
			return;
		}
		if (this.screen.kind === "wrapup") {
			if (value === "default") this.context.close({ args: "20", operation: "wrapup" });
			else if (value === "custom") this.setScreen({ kind: "wrapup-input" });
			return;
		}
		if (this.screen.kind === "recomp") {
			if (value === "full") this.setScreen({ args: "", kind: "recomp-confirm" });
			else if (value === "range") this.setScreen({ kind: "recomp-range" });
			return;
		}
		if (this.screen.kind === "recomp-confirm") {
			if (value === "confirm") {
				this.context.close({ args: this.screen.args, confirmed: true, operation: "recomp" });
			} else this.back();
		}
	}

	private setScreen(screen: ContextDialogScreen): void {
		this.screen = screen;
		this.error = undefined;
		this.rebuildControl();
		this.context.requestRender();
	}

	private submitInput(value: string): void {
		if (this.screen.kind === "wrapup-input") {
			const parsed = parsePositiveInteger(value);
			if (!parsed) {
				this.error = "Enter a positive whole number.";
				return;
			}
			this.context.close({ args: parsed, operation: "wrapup" });
			return;
		}
		if (this.screen.kind === "recomp-range") {
			const parsed = parseMessageRange(value);
			if (!parsed) {
				this.error = "Enter a valid range with end at or after start, for example 1-500.";
				return;
			}
			this.setScreen({ args: parsed, kind: "recomp-confirm" });
		}
	}

	private async refresh(): Promise<void> {
		if (this.disposed || this.refreshing || !this.options.refresh) return;
		this.refreshing = true;
		try {
			const selected = this.screen.kind === "overview" ? this.selectList?.getSelectedItem()?.value : undefined;
			this.snapshot = await this.options.refresh();
			if (this.disposed) return;
			if (this.screen.kind === "overview") this.rebuildControl(selected);
			this.context.requestRender();
		} catch (error) {
			if (this.disposed) return;
			const detail =
				safeDialogError(error instanceof Error ? error.message : String(error)) ?? "Context status refresh failed.";
			this.snapshot = {
				...this.snapshot,
				error: detail,
			};
			this.context.requestRender();
		} finally {
			this.refreshing = false;
		}
	}
}

export function createContextDialogView(
	snapshot: ContextDialogSnapshot,
	options: ContextDialogOptions = {},
): CommandDialogView<ContextDialogCommand> {
	return {
		priority: "normal",
		create: (context) => new ContextDialog(context, snapshot, options),
	};
}
