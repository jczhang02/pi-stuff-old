import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Key,
	type Keybinding,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { isRuntimeNumber } from "../shared/runtime-type.ts";
import type { CommandDialogKeybindings, CommandDialogViewContext } from "./index.ts";

const DEFAULT_TERMINAL_ROWS = 24;
const DEFAULT_NORMAL_SCREEN_RESERVE_ROWS = 3;

export const WIDE_COMMAND_DIALOG_MIN_WIDTH = 96;

export function commandDialogSectionHeading(theme: Theme, label: string, gutter = "  "): string {
	const color = label === "Error" ? "error" : label === "Rejection" || label === "Cancellation" ? "warning" : "accent";
	return `${gutter}${theme.bold(theme.fg(color, label))}`;
}

export type CommandDialogNavigation = "down" | "end" | "home" | "pageDown" | "pageUp" | "up";

export interface CommandDialogKeyHelpEntry {
	readonly description: string;
	readonly keys: string;
}

export interface CommandDialogRowSections {
	readonly body: readonly string[];
	/** Divider and title lines in their natural display order. */
	readonly header: readonly string[];
	/** Semantic title used only when overflow forces the ordinary layout to collapse. */
	readonly overflowTitle?: string;
	/** The selected row, current error, or state line that must survive overflow. */
	readonly priority?: readonly string[];
	/** Hint lines in their natural display order; the final line must contain the escape route. */
	readonly footer: readonly string[];
}

/** Shared vertical budget for a focused full-width Command Dialog. */
export function commandDialogRows(
	context: Pick<CommandDialogViewContext<unknown>, "tui">,
	reserveRows = DEFAULT_NORMAL_SCREEN_RESERVE_ROWS,
): number {
	const terminalRows = context.tui.terminal.rows;
	const rows =
		isRuntimeNumber(terminalRows) && Number.isFinite(terminalRows)
			? Math.max(0, Math.floor(terminalRows))
			: DEFAULT_TERMINAL_ROWS;
	if (rows === 0) return 0;
	return Math.max(1, rows - Math.max(0, Math.floor(reserveRows)));
}

export function commandDialogNavigation(
	data: string,
	keybindings: Pick<CommandDialogKeybindings, "matches">,
): CommandDialogNavigation | undefined {
	if (keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.ctrl("p"))) return "up";
	if (keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.ctrl("n"))) return "down";
	if (keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, "b")) return "pageUp";
	if (keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.space)) return "pageDown";
	if (matchesKey(data, Key.home)) return "home";
	if (matchesKey(data, Key.end)) return "end";
	return undefined;
}

export function commandDialogListIndex(
	current: number,
	length: number,
	page: number,
	navigation: CommandDialogNavigation,
): number {
	const maximum = Math.max(0, length - 1);
	if (navigation === "home") return 0;
	if (navigation === "end") return maximum;
	const delta = navigation === "up" ? -1 : navigation === "down" ? 1 : navigation === "pageUp" ? -page : page;
	return Math.max(0, Math.min(maximum, current + delta));
}

export function commandDialogScrollOffset(
	current: number,
	maximum: number,
	page: number,
	navigation: CommandDialogNavigation,
	line = 1,
): number {
	const boundedMaximum = Math.max(0, maximum);
	if (navigation === "home") return 0;
	if (navigation === "end") return boundedMaximum;
	const delta = navigation === "up" ? -line : navigation === "down" ? line : navigation === "pageUp" ? -page : page;
	return Math.max(0, Math.min(boundedMaximum, current + delta));
}

export function commandDialogReadOnlyPageHint(hasOverflow: boolean, suffix = ""): string | undefined {
	return hasOverflow ? `b/Space page${suffix}` : undefined;
}

export function matchesCommandDialogCancel(
	data: string,
	keybindings: Pick<CommandDialogKeybindings, "matches">,
): boolean {
	return keybindings.matches(data, "tui.select.cancel");
}

export function matchesCommandDialogConfirm(data: string, keybindings: CommandDialogKeybindings): boolean {
	return keybindings.matches(data, "tui.select.confirm");
}

export function matchesCommandDialogHelp(data: string): boolean {
	return matchesKey(data, "?");
}

export function matchesCommandDialogPaneSwitch(data: string): boolean {
	return matchesKey(data, Key.tab) || matchesKey(data, Key.shift(Key.tab));
}

function formatCommandDialogKey(key: string): string {
	interface KeyLabels {
		readonly [key: string]: string;
	}
	const labels: KeyLabels = {
		alt: "Alt",
		ctrl: "Ctrl",
		down: "↓",
		end: "End",
		enter: "Enter",
		escape: "Esc",
		home: "Home",
		left: "←",
		meta: "Meta",
		pageDown: "PgDn",
		pageUp: "PgUp",
		right: "→",
		shift: "Shift",
		space: "Space",
		tab: "Tab",
		up: "↑",
	};
	const parts = key.split("+");
	return parts
		.map(
			(part, index) => labels[part] ?? (parts.length > 1 && index === parts.length - 1 ? part.toUpperCase() : part),
		)
		.join("+");
}

export function commandDialogKeys(
	keybindings: Pick<CommandDialogKeybindings, "getKeys">,
	binding: Keybinding,
	fallback: string,
): string {
	const keys = keybindings.getKeys(binding);
	return keys.length > 0 ? keys.map(formatCommandDialogKey).join("/") : fallback;
}

export function commandDialogPrimaryKey(
	keybindings: Pick<CommandDialogKeybindings, "getKeys">,
	binding: Keybinding,
	fallback: string,
): string {
	const key = keybindings.getKeys(binding)[0];
	return key ? formatCommandDialogKey(key) : fallback;
}

export function commandDialogHintLines(theme: Theme, width: number, hints: readonly string[], gutter = "  "): string[] {
	const available = Math.max(1, width - visibleWidth(gutter));
	const lines: string[] = [];
	let current = "";
	for (const hint of hints) {
		const candidate = current ? `${current} · ${hint}` : hint;
		if (current && visibleWidth(candidate) > available) {
			lines.push(current);
			current = hint;
		} else current = candidate;
	}
	if (current) lines.push(current);
	return lines.flatMap((line) =>
		wrapTextWithAnsi(line, available).map((wrapped) => `${gutter}${theme.fg("dim", wrapped)}`),
	);
}

function commandDialogNavigationKeyHelp(
	keybindings: CommandDialogKeybindings,
	unit: string,
): CommandDialogKeyHelpEntry[] {
	return [
		{
			keys: `${commandDialogKeys(keybindings, "tui.select.up", "↑")}/${commandDialogKeys(keybindings, "tui.select.down", "↓")}, Ctrl+P/Ctrl+N`,
			description: `Previous/next ${unit}`,
		},
		{
			keys: `${commandDialogKeys(keybindings, "tui.select.pageUp", "PgUp")}/${commandDialogKeys(keybindings, "tui.select.pageDown", "PgDn")}, b/Space`,
			description: "Previous/next page",
		},
	];
}

export function commandDialogExitKeyHelp(keybindings: CommandDialogKeybindings): CommandDialogKeyHelpEntry[] {
	return [
		{ keys: "?", description: "Show this key guide" },
		{
			keys: commandDialogKeys(keybindings, "tui.select.cancel", "Esc"),
			description: "Return one level",
		},
	];
}

export function commandDialogListKeyHelp(
	keybindings: CommandDialogKeybindings,
	item: string,
	extra: readonly CommandDialogKeyHelpEntry[] = [],
): CommandDialogKeyHelpEntry[] {
	return [
		...commandDialogNavigationKeyHelp(keybindings, item),
		{ keys: "Home/End", description: `First/last ${item}` },
		{
			keys: commandDialogKeys(keybindings, "tui.select.confirm", "Enter"),
			description: "Open details",
		},
		...extra,
		...commandDialogExitKeyHelp(keybindings),
	];
}

export function commandDialogReadKeyHelp(
	keybindings: CommandDialogKeybindings,
	unit: string,
	extra: readonly CommandDialogKeyHelpEntry[] = [],
): CommandDialogKeyHelpEntry[] {
	return [
		...commandDialogNavigationKeyHelp(keybindings, unit),
		{ keys: "Home/End", description: "Top/bottom" },
		...extra,
		...commandDialogExitKeyHelp(keybindings),
	];
}

export function renderCommandDialogKeyHelp(
	context: Pick<CommandDialogViewContext<unknown>, "keybindings" | "theme" | "tui">,
	width: number,
	title: string,
	entries: readonly CommandDialogKeyHelpEntry[],
): string[] {
	const renderWidth = Math.max(1, Math.floor(width));
	const keyWidth = Math.min(
		Math.max(8, Math.min(40, Math.floor(renderWidth * 0.55))),
		Math.max(8, ...entries.map((entry) => visibleWidth(entry.keys))),
	);
	const descriptionWidth = Math.max(1, renderWidth - 4 - keyWidth);
	const body = [
		"",
		...entries.flatMap((entry) => {
			const key = truncateToWidth(entry.keys, keyWidth, "…");
			const descriptions = wrapTextWithAnsi(entry.description, descriptionWidth);
			return descriptions.map((description, index) =>
				index === 0
					? `  ${context.theme.fg("accent", key)}${" ".repeat(Math.max(1, keyWidth - visibleWidth(key) + 1))}${description}`
					: `${" ".repeat(keyWidth + 3)}${description}`,
			);
		}),
		"",
	];
	const cancel = commandDialogPrimaryKey(context.keybindings, "tui.select.cancel", "Esc");
	return fitCommandDialogRows(
		{
			header: [context.theme.fg("border", "━".repeat(renderWidth)), `  ${context.theme.bold(`${title} / Keys`)}`],
			body,
			footer: [`  ${context.theme.fg("dim", `${cancel} back`)}`],
			priority: [body.find((line) => line.trim().length > 0) ?? `  ${title}`],
		},
		commandDialogRows(context),
	).map((line) => truncateToWidth(line, renderWidth, "…"));
}

function withoutPriority(body: readonly string[], priority: readonly string[]): string[] {
	const remaining = [...body];
	for (const line of priority) {
		const index = remaining.indexOf(line);
		if (index >= 0) remaining.splice(index, 1);
	}
	return remaining.filter((line) => line.trim().length > 0);
}

/**
 * Preserve the ordinary layout when it fits. During low-height overflow, keep
 * one escape line first, then the current state/selection and title before
 * allocating optional hints, divider chrome, and body rows.
 */
export function fitCommandDialogRows(sections: CommandDialogRowSections, maximumRows: number): string[] {
	const limit = Math.max(0, Math.floor(maximumRows));
	if (limit === 0) return [];
	const full = [...sections.header, ...sections.body, ...sections.footer];
	if (full.length <= limit) return full;

	const title = sections.overflowTitle ?? sections.header.at(-1);
	const titleIndex = title === undefined ? -1 : sections.header.indexOf(title);
	const headerPrefix =
		titleIndex < 0
			? [...sections.header]
			: [...sections.header.slice(0, titleIndex), ...sections.header.slice(titleIndex + 1)];
	const close = sections.footer.at(-1);
	const footerPrefix = close === undefined ? [...sections.footer] : sections.footer.slice(0, -1);
	const priority = [...new Set((sections.priority ?? []).filter((line) => line.trim().length > 0))];
	const primary =
		priority.find((line) => line !== title) ?? sections.body.find((line) => line !== title && line.trim().length > 0);

	if (limit === 1) return [close ?? primary ?? title ?? full[0] ?? ""];
	if (limit === 2) return [primary ?? title ?? full[0] ?? "", close ?? title ?? full.at(-1) ?? ""];

	let remaining = limit;
	const visibleClose = close ? [close] : [];
	remaining -= visibleClose.length;
	const visiblePriority = primary ? [primary] : [];
	remaining -= visiblePriority.length;
	const visibleTitle = title && remaining > 0 ? [title] : [];
	remaining -= visibleTitle.length;

	const visibleFooterPrefix = remaining > 0 ? footerPrefix.slice(-Math.min(remaining, footerPrefix.length)) : [];
	remaining -= visibleFooterPrefix.length;
	const visibleHeaderPrefix = remaining > 0 ? headerPrefix.slice(-Math.min(remaining, headerPrefix.length)) : [];
	remaining -= visibleHeaderPrefix.length;
	const additionalPriority = priority.filter((line) => line !== title && line !== primary).slice(0, remaining);
	remaining -= additionalPriority.length;
	const visibleBody = withoutPriority(sections.body, priority).slice(0, remaining);

	return [
		...visibleHeaderPrefix,
		...visibleTitle,
		...visiblePriority,
		...additionalPriority,
		...visibleBody,
		...visibleFooterPrefix,
		...visibleClose,
	];
}

/** Keep a stable Dialog height while anchoring its footer to the bottom row. */
export function fitFixedCommandDialogRows(sections: CommandDialogRowSections, maximumRows: number): string[] {
	const fitted = fitCommandDialogRows(sections, maximumRows);
	const missingRows = Math.max(0, maximumRows - fitted.length);
	if (missingRows === 0) return fitted;
	const footerStart = Math.max(0, fitted.length - sections.footer.length);
	return [
		...fitted.slice(0, footerStart),
		...Array.from({ length: missingRows }, () => ""),
		...fitted.slice(footerStart),
	];
}

/** Render list and detail as one full-width Dialog with one structural divider. */
export function renderCommandDialogSplit(
	theme: Theme,
	width: number,
	renderLeft: (width: number) => readonly string[],
	renderRight: (width: number) => readonly string[],
	preferredLeftWidth = 36,
	minimumLeftWidth = 30,
	minimumRightWidth = 30,
): string[] {
	const totalWidth = Math.max(1, Math.floor(width));
	const leftWidth = Math.min(
		Math.max(1, totalWidth - 1),
		Math.max(minimumLeftWidth, Math.min(preferredLeftWidth, totalWidth - minimumRightWidth - 1)),
	);
	const rightWidth = Math.max(1, totalWidth - leftWidth - 1);
	const left = renderLeft(leftWidth);
	const right = renderRight(rightWidth);
	const rows = Math.max(left.length, right.length);
	const divider = theme.fg("border", "┃");

	return Array.from({ length: rows }, (_, index) => {
		if (index === 0) return theme.fg("border", "━".repeat(totalWidth));
		const leftLine = truncateToWidth(left[index] ?? "", leftWidth, "…");
		const rightLine = truncateToWidth(right[index] ?? "", rightWidth, "…");
		return `${leftLine}${" ".repeat(Math.max(0, leftWidth - visibleWidth(leftLine)))}${divider}${rightLine}`;
	});
}
