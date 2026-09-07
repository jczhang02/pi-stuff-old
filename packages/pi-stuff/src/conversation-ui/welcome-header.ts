import { homedir } from "node:os";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isRuntimeNumber } from "../shared/runtime-type.ts";
import { sanitizeOneLine } from "./terminal-text.ts";

const MIN_BOX_WIDTH = 13;
const WIDE_LEFT_COLUMN_WIDTH = 52;
const WIDE_MIN_WIDTH = 82;

interface WelcomeHeaderToggle {
	get(): boolean;
}

export interface WelcomeHeaderInventory {
	readonly contextFiles: number | undefined;
	readonly extensions: number;
	readonly skills: number;
	readonly tools: number;
}

export interface WelcomeHeaderInventorySource {
	get(): WelcomeHeaderInventory;
	subscribe(listener: () => void): () => void;
}

export interface WelcomeHeaderControllerOptions {
	readonly enabled: WelcomeHeaderToggle;
	readonly inventory: WelcomeHeaderInventorySource;
}

interface WelcomeRegistryHost {
	getAllTools(): readonly { readonly sourceInfo: { readonly path: string; readonly source: string } }[];
	getCommands(): readonly {
		readonly name: string;
		readonly source: string;
		readonly sourceInfo: { readonly path: string };
	}[];
}

interface WelcomeHeaderTui {
	requestRender(force?: boolean): void;
	readonly terminal?: { readonly rows?: number };
}

interface WelcomeHeaderContext {
	readonly cwd: string;
	readonly model: { readonly id?: string; readonly name?: string; readonly provider?: string } | undefined;
	readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getCwd">;
}

/**
 * Registry-backed inventory available through Pi's public Extension API.
 * Context-file count is supplied later from `before_agent_start` because the
 * Host does not expose it on `ExtensionContext` during initial startup.
 */
export class WelcomeRegistrySource implements WelcomeHeaderInventorySource {
	private contextFiles: number | undefined;
	private inventory: WelcomeHeaderInventory;
	private readonly listeners = new Set<() => void>();
	private readonly pi: WelcomeRegistryHost;

	constructor(pi: WelcomeRegistryHost, contextFiles?: number) {
		this.pi = pi;
		this.contextFiles = normalizeCount(contextFiles);
		this.inventory = readWelcomeRegistryInventory(pi, this.contextFiles);
	}

	get(): WelcomeHeaderInventory {
		return this.inventory;
	}

	refresh(): void {
		this.set(readWelcomeRegistryInventory(this.pi, this.contextFiles));
	}

	setContextFileCount(count: number | undefined): void {
		const normalized = normalizeCount(count);
		if (this.contextFiles === normalized) return;
		this.contextFiles = normalized;
		this.set({ ...this.inventory, contextFiles: normalized });
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private set(next: WelcomeHeaderInventory): void {
		if (sameInventory(this.inventory, next)) return;
		this.inventory = next;
		for (const listener of this.listeners) callObserver(listener);
	}
}

/** Read the exact public registries and count registry-visible extensions. */
export function readWelcomeRegistryInventory(pi: WelcomeRegistryHost, contextFiles?: number): WelcomeHeaderInventory {
	const commands = pi.getCommands();
	const tools = pi.getAllTools();
	const extensionPaths = new Set<string>();
	const skills = new Set<string>();
	for (const command of commands) {
		if (command.source === "skill") skills.add(command.name);
		if (command.source === "extension") extensionPaths.add(command.sourceInfo.path);
	}
	for (const tool of tools) {
		if (tool.sourceInfo.source === "builtin" || tool.sourceInfo.source === "sdk") continue;
		extensionPaths.add(tool.sourceInfo.path);
	}
	return {
		contextFiles: normalizeCount(contextFiles),
		extensions: extensionPaths.size,
		skills: skills.size,
		tools: tools.length,
	};
}

/**
 * Captures the Welcome setting once so changing it in `/ui` takes effect only
 * on the next launch, while live model and inventory data may still repaint.
 */
export class WelcomeHeaderController {
	readonly enabledAtLaunch: boolean;
	private readonly ctx: WelcomeHeaderContext;
	private readonly inventory: WelcomeHeaderInventorySource;

	constructor(ctx: WelcomeHeaderContext, options: WelcomeHeaderControllerOptions) {
		this.ctx = ctx;
		this.inventory = options.inventory;
		this.enabledAtLaunch = options.enabled.get();
	}

	createHeader(tui: WelcomeHeaderTui, theme: Theme): Component & { dispose(): void } {
		return new WelcomeHeaderComponent(this.ctx, tui, theme, this.inventory, this.enabledAtLaunch);
	}
}

class WelcomeHeaderComponent implements Component {
	private readonly ctx: WelcomeHeaderContext;
	private disposed = false;
	private readonly enabled: boolean;
	private readonly inventory: WelcomeHeaderInventorySource;
	private readonly theme: Theme;
	private readonly tui: WelcomeHeaderTui;
	private readonly unsubscribe: () => void;

	constructor(
		ctx: WelcomeHeaderContext,
		tui: WelcomeHeaderTui,
		theme: Theme,
		inventory: WelcomeHeaderInventorySource,
		enabled: boolean,
	) {
		this.ctx = ctx;
		this.tui = tui;
		this.theme = theme;
		this.inventory = inventory;
		this.enabled = enabled;
		try {
			this.unsubscribe = inventory.subscribe(() => callObserver(() => this.tui.requestRender()));
		} catch {
			this.unsubscribe = () => {};
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		callObserver(this.unsubscribe);
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.disposed || !this.enabled) return [];
		const renderWidth = Math.max(0, Math.floor(width));
		if (renderWidth < 1) return [];
		const inventory = this.inventory.get();
		if (renderWidth >= WIDE_MIN_WIDTH) return wideLines(this.ctx, inventory, this.theme, renderWidth);
		return narrowLines(this.ctx, this.theme, renderWidth, terminalRows(this.tui));
	}
}

function wideLines(
	ctx: WelcomeHeaderContext,
	inventory: WelcomeHeaderInventory,
	theme: Theme,
	width: number,
): string[] {
	const rightWidth = Math.max(1, width - WIDE_LEFT_COLUMN_WIDTH - 3);
	const logo = piLogo(theme, false);
	const rightDivider = theme.fg("borderMuted", "─".repeat(Math.max(0, rightWidth - 2)));
	const counts = welcomeInventoryLines(inventory, theme);
	const loadedRows = [theme.bold("Loaded"), counts[0] ?? "", counts[1] ?? ""];
	const identityRows = Array.from({ length: Math.max(logo.length, loadedRows.length) }, (_unused, index) =>
		wideBoxRow(theme, width, logo[index] ?? "", loadedRows[index] ?? ""),
	);
	return [
		boxTop(theme, width, "Pi Stuff", true),
		wideBoxRow(theme, width, "", theme.bold("Tips for getting started")),
		wideBoxRow(theme, width, theme.bold("Welcome back!"), "Type / to browse commands"),
		wideBoxRow(theme, width, "", rightDivider),
		...identityRows,
		wideBoxRow(theme, width, "", ""),
		wideBoxRow(theme, width, modelIdentity(ctx, theme, true), ""),
		wideBoxRow(theme, width, theme.fg("muted", displayCwd(ctx)), ""),
		boxBottom(theme, width),
	];
}

function narrowLines(ctx: WelcomeHeaderContext, theme: Theme, width: number, rows: number | undefined): string[] {
	if (width < MIN_BOX_WIDTH) return [clip(theme.bold("Pi Stuff"), width)];
	const logo = piLogo(theme, width < 48 || (rows !== undefined && rows <= 18));
	const provider = sanitizeOneLine(ctx.model?.provider ?? "");
	return [
		boxTop(theme, width, "Pi Stuff", false),
		boxRow(theme, width, theme.bold("Welcome back!")),
		boxRow(theme, width, ""),
		...logo.map((line) => boxRow(theme, width, line)),
		boxRow(theme, width, ""),
		boxRow(theme, width, modelIdentity(ctx, theme, false)),
		boxRow(theme, width, provider ? theme.fg("muted", provider) : ""),
		boxRow(theme, width, theme.fg("muted", abbreviatePath(displayCwd(ctx)))),
		boxBottom(theme, width),
	];
}

function terminalRows(tui: WelcomeHeaderTui): number | undefined {
	const rows = tui.terminal?.rows;
	return isRuntimeNumber(rows) && Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : undefined;
}

function boxTop(theme: Theme, width: number, title: string, wide: boolean): string {
	const leading = wide ? "───" : "─";
	const titleText = ` ${title} `;
	const remaining = Math.max(0, width - visibleWidth(leading) - visibleWidth(titleText) - 2);
	return `${theme.fg("borderMuted", `╭${leading}`)}${theme.bold(titleText)}${theme.fg(
		"borderMuted",
		`${"─".repeat(remaining)}╮`,
	)}`;
}

function boxBottom(theme: Theme, width: number): string {
	return theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`);
}

function boxRow(theme: Theme, width: number, content: string): string {
	const interiorWidth = Math.max(0, width - 2);
	return `${theme.fg("borderMuted", "│")}${centerCell(content, interiorWidth)}${theme.fg("borderMuted", "│")}`;
}

function wideBoxRow(theme: Theme, width: number, left: string, right: string): string {
	const rightWidth = Math.max(0, width - WIDE_LEFT_COLUMN_WIDTH - 3);
	return `${theme.fg("borderMuted", "│")}${centerCell(left, WIDE_LEFT_COLUMN_WIDTH, 3)}${theme.fg(
		"borderMuted",
		"│",
	)}${startCell(right, rightWidth)}${theme.fg("borderMuted", "│")}`;
}

function centerCell(content: string, width: number, minimumInset = 0): string {
	const inset = Math.min(Math.max(0, minimumInset), Math.floor(Math.max(0, width) / 2));
	const fitted = truncateToWidth(content, Math.max(0, width - inset * 2), "…");
	const padding = Math.max(0, width - visibleWidth(fitted));
	const left = Math.floor(padding / 2);
	return `${" ".repeat(left)}${fitted}${" ".repeat(padding - left)}`;
}

function startCell(content: string, width: number): string {
	if (width < 1) return "";
	const fitted = truncateToWidth(content, Math.max(0, width - 2), "…");
	const line = ` ${fitted}`;
	return `${line}${" ".repeat(Math.max(0, width - visibleWidth(line)))}`;
}

function piLogo(theme: Theme, compact: boolean): readonly string[] {
	const rows = compact ? ["█▀█ ", "█▀ █"] : ["██████  ", "██  ██  ", "████  ██", "██    ██"];
	return rows.map((row) => theme.fg("accent", row));
}

function welcomeInventoryLines(inventory: WelcomeHeaderInventory, theme: Theme): readonly [string, string] {
	const context = inventory.contextFiles === undefined ? undefined : `${String(inventory.contextFiles)} context`;
	const first = [context, `${String(inventory.extensions)} extensions`].filter(Boolean).join(" · ");
	const second = `${String(inventory.tools)} tools · ${String(inventory.skills)} skills`;
	return [theme.fg("muted", first), theme.fg("muted", second)];
}

function modelIdentity(ctx: WelcomeHeaderContext, theme: Theme, includeProvider: boolean): string {
	const model = sanitizeOneLine(ctx.model?.name ?? ctx.model?.id ?? "").replace(/^Claude\s+/u, "");
	if (!model) return "";
	const provider = sanitizeOneLine(ctx.model?.provider ?? "");
	return `${theme.fg("accent", model)}${includeProvider && provider ? theme.fg("dim", ` · ${provider}`) : ""}`;
}

function displayCwd(ctx: WelcomeHeaderContext): string {
	const cwd = sanitizeOneLine(ctx.sessionManager.getCwd()) || sanitizeOneLine(ctx.cwd) || ".";
	const home = sanitizeOneLine(homedir());
	return home && (cwd === home || cwd.startsWith(`${home}/`)) ? `~${cwd.slice(home.length)}` : cwd;
}

function abbreviatePath(path: string): string {
	const pieces = path.split("/");
	if (pieces.length <= 3) return path;
	return pieces
		.map((piece, index) => (index > 0 && index < pieces.length - 1 ? abbreviatedPathPiece(piece) : piece))
		.join("/");
}

function abbreviatedPathPiece(value: string): string {
	if (value.startsWith(".") && value.length > 1) return `.${firstGrapheme(value.slice(1))}`;
	return firstGrapheme(value);
}

function firstGrapheme(value: string): string {
	return GRAPHEME_SEGMENTER.segment(value)[Symbol.iterator]().next().value?.segment ?? "";
}

function clip(line: string, width: number): string {
	return truncateToWidth(line, Math.max(1, width), "…");
}

function normalizeCount(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isFinite(value)) return undefined;
	return Math.max(0, Math.floor(value));
}

function sameInventory(left: WelcomeHeaderInventory, right: WelcomeHeaderInventory): boolean {
	return (
		left.contextFiles === right.contextFiles &&
		left.extensions === right.extensions &&
		left.tools === right.tools &&
		left.skills === right.skills
	);
}

function callObserver(observer: () => void): void {
	try {
		observer();
	} catch {
		// Welcome presentation observers are recoverable and independent.
	}
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter("und", {
	granularity: "grapheme",
});
