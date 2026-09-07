import { stripVTControlCharacters } from "node:util";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { type Focusable, type SelectItem, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	PONYTAIL_ICON,
	PONYTAIL_MODES,
	PONYTAIL_SPECIALIZED_SKILLS,
	type PonytailMode,
	type PonytailSpecializedSkill,
} from "../ponytail/types.ts";
import { commandDialogRows, fitCommandDialogRows } from "./dialog-layout.ts";
import type { CommandDialogComponent, CommandDialogView, CommandDialogViewContext } from "./index.ts";

export interface PonytailDialogSnapshot {
	readonly mode: PonytailMode;
	readonly defaultMode: PonytailMode;
	readonly savedDefaultMode: PonytailMode;
	readonly hideStatus: boolean;
	readonly savedHideStatus: boolean;
	readonly quietStartup: boolean;
	readonly savedQuietStartup: boolean;
	readonly defaultModeOverridden: boolean;
	readonly hideStatusOverridden: boolean;
	readonly quietStartupOverridden: boolean;
	readonly source: "defaults" | "legacy" | "merged";
	readonly error?: string;
}

export type PonytailDialogAction =
	| { readonly type: "set-mode"; readonly mode: PonytailMode }
	| { readonly type: "set-default"; readonly mode: PonytailMode }
	| { readonly type: "set-status"; readonly hide: boolean }
	| { readonly type: "set-startup"; readonly quiet: boolean };

export interface PonytailDialogOptions {
	readonly apply: (action: PonytailDialogAction) => Promise<PonytailDialogSnapshot>;
}

type Screen = "overview" | "mode" | "default";
const GUTTER = "  ";

const SKILL_LABELS = {
	"ponytail-review": { label: "Review complexity", description: "Find over-engineering in this diff" },
	"ponytail-audit": { label: "Audit repository", description: "Find code to delete or simplify" },
	"ponytail-debt": { label: "Show debt ledger", description: "Collect ponytail: shortcut markers" },
	"ponytail-gain": { label: "Show gain", description: "Show upstream benchmark savings" },
	"ponytail-help": { label: "Show help", description: "Open modes and commands" },
} satisfies Record<PonytailSpecializedSkill, { description: string; label: string }>;

function isPonytailSpecializedSkill(value: string): value is PonytailSpecializedSkill {
	return PONYTAIL_SPECIALIZED_SKILLS.some((skill) => skill === value);
}

function stateWord(value: boolean, on: string, off: string): string {
	return value ? on : off;
}

function configurationSummary(snapshot: PonytailDialogSnapshot): string {
	if (snapshot.defaultModeOverridden || snapshot.hideStatusOverridden || snapshot.quietStartupOverridden) {
		return `Configuration ${snapshot.source} · environment override`;
	}
	return `Configuration ${snapshot.source} · Statusline ${stateWord(snapshot.hideStatus, "hidden", "shown")}`;
}

function overviewItems(snapshot: PonytailDialogSnapshot): SelectItem[] {
	return [
		{ value: "mode", label: "Session mode", description: snapshot.mode },
		{
			value: "default",
			label: "Default mode",
			description: snapshot.defaultModeOverridden
				? `${snapshot.defaultMode} effective · ${snapshot.savedDefaultMode} saved`
				: snapshot.defaultMode,
		},
		{
			value: "status",
			label: "Statusline",
			description: `${stateWord(snapshot.hideStatus, "hidden", "shown")}${snapshot.hideStatusOverridden ? " · environment override" : ""}`,
		},
		{
			value: "startup",
			label: "Startup notification",
			description: `${stateWord(snapshot.quietStartup, "quiet", "shown")}${snapshot.quietStartupOverridden ? " · environment override" : ""}`,
		},
		...PONYTAIL_SPECIALIZED_SKILLS.map((skill) => ({ value: skill, ...SKILL_LABELS[skill] })),
	];
}

function screenItems(screen: Screen, snapshot: PonytailDialogSnapshot): SelectItem[] {
	if (screen === "overview") return overviewItems(snapshot);
	return PONYTAIL_MODES.map((mode) => ({
		value: mode,
		label: mode[0]?.toUpperCase() + mode.slice(1),
		description:
			screen === "mode"
				? mode === snapshot.mode
					? "Current Session mode"
					: "Use for the current Session"
				: mode === snapshot.defaultMode
					? "Current effective default"
					: "Save as the global default",
	}));
}

function stripSelectHelp(lines: readonly string[]): string[] {
	return lines.filter(
		(line) =>
			!line.includes("Enter to select") && !line.includes("Esc to cancel") && !line.includes("Type to filter"),
	);
}

function safeMessage(value: string | undefined): string | undefined {
	const cleaned = value ? stripVTControlCharacters(value).trim() : undefined;
	if (!cleaned) return undefined;
	return cleaned.length <= 500 ? cleaned : `${cleaned.slice(0, 499)}…`;
}

class PonytailDialog implements CommandDialogComponent, Focusable {
	private readonly context: CommandDialogViewContext<PonytailSpecializedSkill>;
	private readonly options: PonytailDialogOptions;
	private snapshot: PonytailDialogSnapshot;
	private screen: Screen = "overview";
	private selectList: SelectList;
	private _focused = false;
	private busy = false;
	private message: string | undefined;
	private error: string | undefined;

	constructor(
		context: CommandDialogViewContext<PonytailSpecializedSkill>,
		snapshot: PonytailDialogSnapshot,
		options: PonytailDialogOptions,
	) {
		this.context = context;
		this.snapshot = snapshot;
		this.options = options;
		this.selectList = this.createList();
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
	}

	dispose(): void {}

	handleInput(data: string): void {
		if (this.busy) return;
		this.selectList.handleInput(data);
		this.context.requestRender();
	}

	invalidate(): void {
		this.selectList.invalidate();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, Math.floor(width));
		const selectedLines = stripSelectHelp(this.selectList.render(renderWidth));
		const selected = selectedLines.find((line) => line.includes("→") || line.includes("›")) ?? selectedLines[0];
		const notices = [
			...(safeMessage(this.error ?? this.snapshot.error)
				? wrapTextWithAnsi(safeMessage(this.error ?? this.snapshot.error) ?? "", Math.max(1, renderWidth - 4)).map(
						(line) => `${GUTTER}${this.context.theme.fg("error", line)}`,
					)
				: []),
			...(safeMessage(this.message)
				? [`${GUTTER}${this.context.theme.fg("accent", safeMessage(this.message) ?? "")}`]
				: []),
		];
		const title =
			this.screen === "overview"
				? `${PONYTAIL_ICON} Ponytail · ${this.snapshot.mode}`
				: `Ponytail · ${this.screen === "mode" ? "Session mode" : "Default mode"}`;
		const body =
			this.screen === "overview"
				? [
						"",
						`${GUTTER}${this.context.theme.fg("accent", PONYTAIL_ICON)} ${this.context.theme.bold("Control")}`,
						`${GUTTER}${this.context.theme.fg("muted", configurationSummary(this.snapshot))}`,
						...notices,
						"",
						...selectedLines,
					]
				: [
						`${GUTTER}${this.context.theme.fg("muted", this.screen === "mode" ? "Choose the current Session mode." : "Choose the default for Sessions without a saved mode.")}`,
						...notices,
						"",
						...selectedLines,
					];
		const rows = fitCommandDialogRows(
			{
				header: [
					this.context.theme.fg("border", "━".repeat(renderWidth)),
					`${GUTTER}${this.context.theme.bold(title)}`,
				],
				body,
				footer: [
					`${GUTTER}${this.context.theme.fg("dim", this.busy ? "Saving…" : this.screen === "overview" ? "↑/↓ select · Enter choose · Esc close" : "↑/↓ select · Enter apply · Esc back")}`,
				],
				priority: [this.error ? (notices[0] ?? selected ?? title) : (selected ?? title)],
			},
			commandDialogRows(this.context),
		);
		return rows.map((line) => truncateToWidth(line, renderWidth, "…"));
	}

	private createList(selected?: string): SelectList {
		const items = screenItems(this.screen, this.snapshot);
		const list = new SelectList(items, Math.max(1, items.length), getSelectListTheme());
		list.onCancel = () => this.back();
		list.onSelect = (item) => this.select(item.value);
		if (selected) {
			const index = items.findIndex((item) => item.value === selected);
			if (index >= 0) list.setSelectedIndex(index);
		}
		return list;
	}

	private back(): void {
		if (this.screen === "overview") this.context.close();
		else this.setScreen("overview");
	}

	private select(value: string): void {
		if (this.screen === "overview") {
			if (value === "mode" || value === "default") {
				this.setScreen(value);
				return;
			}
			if (value === "status") {
				void this.apply({ type: "set-status", hide: !this.snapshot.hideStatus }, "status");
				return;
			}
			if (value === "startup") {
				void this.apply({ type: "set-startup", quiet: !this.snapshot.quietStartup }, "startup");
				return;
			}
			if (isPonytailSpecializedSkill(value)) this.context.close(value);
			return;
		}
		const mode = PONYTAIL_MODES.find((candidate) => candidate === value);
		if (!mode) return;
		void this.apply(this.screen === "mode" ? { type: "set-mode", mode } : { type: "set-default", mode }, this.screen);
	}

	private async apply(action: PonytailDialogAction, selected: string): Promise<void> {
		this.busy = true;
		this.error = undefined;
		this.message = undefined;
		this.context.requestRender();
		try {
			this.snapshot = await this.options.apply(action);
			this.message = this.successMessage(action);
			this.screen = "overview";
			this.selectList = this.createList(selected);
		} catch (error) {
			this.error = error instanceof Error ? error.message : String(error);
		} finally {
			this.busy = false;
			this.context.requestRender();
		}
	}

	private setScreen(screen: Screen): void {
		this.screen = screen;
		this.error = undefined;
		this.message = undefined;
		this.selectList = this.createList();
		this.context.requestRender();
	}

	private successMessage(action: PonytailDialogAction): string {
		if (action.type === "set-mode") return `Session mode set to ${this.snapshot.mode}.`;
		if (action.type === "set-default") {
			return this.snapshot.defaultModeOverridden
				? `Saved ${this.snapshot.savedDefaultMode}; environment keeps ${this.snapshot.defaultMode} effective.`
				: `Default mode set to ${this.snapshot.defaultMode}.`;
		}
		if (action.type === "set-status") {
			return this.snapshot.hideStatusOverridden
				? `Saved ${stateWord(this.snapshot.savedHideStatus, "hidden", "shown")}; environment override remains effective.`
				: `Statusline ${stateWord(this.snapshot.hideStatus, "hidden", "shown")}.`;
		}
		return this.snapshot.quietStartupOverridden
			? `Saved ${stateWord(this.snapshot.savedQuietStartup, "quiet", "shown")}; environment override remains effective.`
			: `Startup notification ${stateWord(this.snapshot.quietStartup, "quiet", "shown")}.`;
	}
}

export function createPonytailDialogView(
	snapshot: PonytailDialogSnapshot,
	options: PonytailDialogOptions,
): CommandDialogView<PonytailSpecializedSkill> {
	return { priority: "normal", create: (context) => new PonytailDialog(context, snapshot, options) };
}
