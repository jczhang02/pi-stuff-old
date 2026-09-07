import { homedir } from "node:os";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type CommandDialogComponent,
	type CommandDialogView,
	type CommandDialogViewContext,
	commandDialogHintLines,
	commandDialogPrimaryKey,
	commandDialogRows,
	commandDialogSectionHeading,
	fitCommandDialogRows,
	matchesCommandDialogCancel,
	matchesCommandDialogHelp,
	renderCommandDialogKeyHelp,
} from "../conversation-ui/index.js";
import { boundTerminalLine, compactTerminalPath } from "../tool-display/index.js";
import type { RtkProjectionAdapter } from "./projection.js";
import type { RtkRuntime } from "./runtime.js";
import type { RtkSettingsStore } from "./settings.js";

const GUTTER = "  ";
const MIN_RENDER_WIDTH = 24;
const SETTING_IDS = ["rewriteCommands", "outputProjection"] as const;
type SettingId = (typeof SETTING_IDS)[number];

export interface RtkDialogOptions {
	readonly onPersistenceError?: (message: string) => void;
	readonly projection: RtkProjectionAdapter;
	readonly runtime: RtkRuntime;
	readonly setOutputProjection: (enabled: boolean) => Promise<void>;
	readonly setRewriteCommands: (enabled: boolean) => Promise<void>;
	readonly settings: RtkSettingsStore;
	readonly verify?: (signal: AbortSignal) => Promise<void>;
}

function percent(saved: number, original: number): string {
	return original > 0 ? `${String(Math.round((saved / original) * 100))}%` : "0%";
}

function oneLine(value: string): string {
	return value
		.replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
		.replaceAll(/\s+/gu, " ")
		.trim();
}

const RUNTIME_STYLES = {
	drifted: { color: "warning", glyph: "!" },
	ready: { color: "success", glyph: "✓" },
	unavailable: { color: "error", glyph: "×" },
	unchecked: { color: "muted", glyph: "○" },
} as const;

/** Keep the executable identity useful without letting a package-manager path consume the dialog. */
export function compactRtkBinaryPath(value: string, maximumWidth: number): string {
	const width = Math.max(1, Math.floor(maximumWidth));
	const clean = boundTerminalLine(value, Number.MAX_SAFE_INTEGER);
	const home = boundTerminalLine(homedir(), Number.MAX_SAFE_INTEGER);
	const display = home && (clean === home || clean.startsWith(`${home}/`)) ? `~${clean.slice(home.length)}` : clean;
	return compactTerminalPath(display, width);
}

function behaviorValue(configured: boolean, effective: string): string {
	return `configured ${configured ? "on" : "off"} · effective ${configured ? effective : "off"}`;
}

class RtkDialogComponent implements CommandDialogComponent {
	private readonly context: CommandDialogViewContext<void>;
	private disposed = false;
	private error = "";
	private feedback = "";
	private readonly generations = new Map<string, number>();
	private readonly options: RtkDialogOptions;
	private selectedSetting: SettingId = "rewriteCommands";
	private settingsList: SettingsList;
	private showKeyHelp = false;
	private readonly unsubscribe: () => void;
	private verifying = false;

	constructor(context: CommandDialogViewContext<void>, options: RtkDialogOptions) {
		this.context = context;
		this.options = options;
		this.settingsList = this.createSettingsList();
		this.unsubscribe = options.settings.subscribe(() => this.sync());
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.unsubscribe();
		} catch {
			// A presentation observer cannot block dialog teardown.
		}
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;
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
			this.context.close();
			return;
		}
		if (data === "v") {
			void this.verifyRuntime();
			return;
		}
		if (data === "c") {
			this.options.projection.reset();
			this.feedback = "Session savings cleared.";
			this.context.requestRender();
			return;
		}
		if (this.context.keybindings.matches(data, "tui.select.up")) {
			this.selectedSetting = this.selectedSetting === SETTING_IDS[0] ? SETTING_IDS[1] : SETTING_IDS[0];
			this.settingsList.selectItem(this.selectedSetting);
			this.context.requestRender();
			return;
		}
		if (this.context.keybindings.matches(data, "tui.select.down")) {
			this.selectedSetting = this.selectedSetting === SETTING_IDS[1] ? SETTING_IDS[0] : SETTING_IDS[1];
			this.settingsList.selectItem(this.selectedSetting);
			this.context.requestRender();
			return;
		}
		this.settingsList.handleInput?.(data);
		this.context.requestRender();
	}

	invalidate(): void {
		this.settingsList.invalidate();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, Math.floor(width));
		if (this.showKeyHelp) {
			return renderCommandDialogKeyHelp(this.context, renderWidth, "RTK", [
				{ keys: "↑/↓", description: "Select a behavior" },
				{ keys: "Enter/Space", description: "Toggle the selected behavior" },
				{ keys: "v", description: "Verify the RTK Runtime" },
				{ keys: "c", description: "Clear Session savings" },
				{ keys: "?", description: "Show this key guide" },
				{
					keys: commandDialogPrimaryKey(this.context.keybindings, "tui.select.cancel", "Esc"),
					description: "Close",
				},
			]);
		}
		const maximumRows = commandDialogRows(this.context);
		if (maximumRows === 0) return [];
		const theme = this.context.theme;
		const runtime = this.options.runtime.snapshot();
		const stats = this.options.projection.stats();
		const { color: runtimeColor, glyph: runtimeGlyph } = RUNTIME_STYLES[runtime.state];
		const version = runtime.version
			? runtime.version.startsWith("v")
				? runtime.version
				: `v${runtime.version}`
			: "";
		const runtimeLine = `${GUTTER}${theme.fg(runtimeColor, `${runtimeGlyph} ${runtime.state}`)}${
			this.verifying ? theme.fg("accent", " · verifying") : version ? theme.fg("dim", ` · ${version}`) : ""
		}`;
		const behaviorLines = this.behaviorLines(renderWidth);
		const savings =
			stats.resultCount === 0
				? "No eligible result projected yet."
				: `${String(stats.savedChars)} chars saved (${percent(stats.savedChars, stats.originalChars)}) · ${String(stats.resultCount)} ${stats.resultCount === 1 ? "result" : "results"}`;
		const savingsLine = `${GUTTER}${savings}`;
		const cancel = commandDialogPrimaryKey(this.context.keybindings, "tui.select.cancel", "Esc");
		if (maximumRows <= 6) {
			return this.renderLowHeight(
				renderWidth,
				maximumRows,
				runtimeLine,
				behaviorLines,
				savingsLine,
				`${runtimeGlyph} ${runtime.state} · ${savings} · ${cancel} close`,
			);
		}

		const techniques = Object.entries(stats.techniques)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([name, count]) => `${name} ${String(count)}`)
			.join(" · ");
		const errors = [runtime.lastError, this.error].filter((value): value is string => Boolean(value));
		const body = [
			"",
			commandDialogSectionHeading(theme, "Runtime"),
			runtimeLine,
			...(runtime.path
				? [
						`${GUTTER}Binary  ${compactRtkBinaryPath(
							runtime.path,
							Math.max(1, renderWidth - GUTTER.length - "Binary  ".length),
						)}`,
					]
				: []),
			...(runtime.state === "unchecked" && !this.verifying
				? [`${GUTTER}${theme.fg("muted", "Not verified yet.")}`]
				: []),
			...(errors.length > 0
				? [
						"",
						commandDialogSectionHeading(theme, "Error"),
						...errors.flatMap((error) =>
							this.wrapped(renderWidth, theme.fg("error", boundTerminalLine(error, 220))),
						),
					]
				: []),
			"",
			commandDialogSectionHeading(theme, "Behavior"),
			...this.settingsBody(renderWidth),
			"",
			commandDialogSectionHeading(theme, "Session savings"),
			savingsLine,
			...(techniques ? this.wrapped(renderWidth, `Techniques  ${techniques}`) : []),
			...(this.feedback
				? ["", commandDialogSectionHeading(theme, "Feedback"), ...this.wrapped(renderWidth, this.feedback)]
				: []),
		];
		const footer = commandDialogHintLines(theme, renderWidth, [
			"↑/↓ select",
			"Enter/Space toggle",
			"v verify",
			"c clear savings",
			"? keys",
			`${cancel} close`,
		]);
		return fitCommandDialogRows(
			{
				header: [theme.fg("border", "━".repeat(renderWidth)), `${GUTTER}${theme.bold("RTK")}`],
				body,
				footer,
				priority: [runtimeLine, ...behaviorLines, savingsLine],
			},
			maximumRows,
		).map((line) => truncateToWidth(line, renderWidth, "…"));
	}

	private behaviorLines(width: number): [string, string] {
		const settings = this.options.settings.get();
		const runtimeState = this.options.runtime.snapshot().state;
		return [
			this.behaviorLine(
				"rewriteCommands",
				"Command rewriting",
				behaviorValue(settings.rewriteCommands, runtimeState),
				width,
			),
			this.behaviorLine(
				"outputProjection",
				"Model projection",
				behaviorValue(settings.outputProjection, "active"),
				width,
			),
		];
	}

	private behaviorLine(id: SettingId, label: string, value: string, width: number): string {
		const prefix = this.selectedSetting === id ? "→ " : GUTTER;
		return truncateToWidth(`${prefix}${label}  ${value}`, width, "…");
	}

	private createSettingsList(): SettingsList {
		const settings = this.options.settings.get();
		const runtimeState = this.options.runtime.snapshot().state;
		const rewriteValues = [behaviorValue(true, runtimeState), behaviorValue(false, "off")];
		const projectionValues = [behaviorValue(true, "active"), behaviorValue(false, "off")];
		const items: SettingItem[] = [
			{
				currentValue: rewriteValues[settings.rewriteCommands ? 0 : 1] ?? rewriteValues[0] ?? "",
				description: "Rewrites supported Bash commands only when the certified Runtime is ready.",
				id: "rewriteCommands",
				label: "Command rewriting",
				values: rewriteValues,
			},
			{
				currentValue: projectionValues[settings.outputProjection ? 0 : 1] ?? projectionValues[0] ?? "",
				description: "Projects eligible Tool results into model context; independent of Runtime availability.",
				id: "outputProjection",
				label: "Model projection",
				values: projectionValues,
			},
		];
		const nativeTheme = getSettingsListTheme();
		const listTheme = {
			...nativeTheme,
			value: (text: string, selected: boolean) =>
				selected ? nativeTheme.value(text, true) : this.context.theme.fg(this.valueColor(text), text),
		} satisfies SettingsListTheme;
		const list = new SettingsList(
			items,
			items.length,
			listTheme,
			(id, value) => this.setValue(id, value),
			() => this.context.close(),
			{ enableSearch: false },
		);
		list.selectItem(this.selectedSetting);
		return list;
	}

	private renderLowHeight(
		width: number,
		maximumRows: number,
		runtimeLine: string,
		behaviorLines: readonly string[],
		savingsLine: string,
		combinedSummary: string,
	): string[] {
		const cancel = commandDialogPrimaryKey(this.context.keybindings, "tui.select.cancel", "Esc");
		const close = `${GUTTER}${this.context.theme.fg("dim", `${cancel} close`)}`;
		const summary = `${GUTTER}${combinedSummary}`;
		const rows =
			maximumRows >= 6
				? [`${GUTTER}${this.context.theme.bold("RTK")}`, runtimeLine, ...behaviorLines, savingsLine, close]
				: maximumRows === 5
					? [runtimeLine, ...behaviorLines, savingsLine, close]
					: maximumRows === 4
						? [`${GUTTER}${this.context.theme.bold("RTK")}`, ...behaviorLines, summary]
						: maximumRows === 3
							? [...behaviorLines, summary]
							: maximumRows === 2
								? [behaviorLines[0] ?? runtimeLine, summary]
								: [summary];
		return rows.map((line) => truncateToWidth(line, width, "…"));
	}

	private setValue(id: string, value: string): void {
		if (id !== "rewriteCommands" && id !== "outputProjection") return;
		const generation = (this.generations.get(id) ?? 0) + 1;
		this.generations.set(id, generation);
		this.error = "";
		this.feedback = "";
		const enabled = value.startsWith("configured on");
		const update =
			id === "rewriteCommands"
				? this.options.setRewriteCommands(enabled)
				: this.options.setOutputProjection(enabled);
		void update.catch((error) => {
			if (this.generations.get(id) !== generation) return;
			const message = oneLine(String(error)) || "Unable to save RTK setting.";
			if (this.disposed) {
				try {
					this.options.onPersistenceError?.(message);
				} catch {
					// A notification adapter cannot turn a handled persistence failure into an unhandled rejection.
				}
				return;
			}
			this.error = message;
			this.context.requestRender();
		});
	}

	private settingsBody(width: number): string[] {
		const nativeLines = this.settingsList.render(Math.max(MIN_RENDER_WIDTH, width));
		let hintIndex = -1;
		for (let index = nativeLines.length - 1; index >= 0; index -= 1) {
			if (!nativeLines[index]?.includes("Enter/Space to change")) continue;
			hintIndex = index;
			break;
		}
		const body = hintIndex >= 0 ? nativeLines.slice(0, hintIndex) : nativeLines;
		while (body.at(-1)?.trim().length === 0) body.pop();
		return body.map((line) => truncateToWidth(line, width, "…"));
	}

	private sync(): void {
		if (this.disposed) return;
		this.settingsList = this.createSettingsList();
		this.context.requestRender();
	}

	private valueColor(value: string): "error" | "muted" | "success" | "warning" {
		if (value.endsWith("effective active") || value.endsWith("effective ready")) return "success";
		if (value.endsWith("effective unavailable")) return "error";
		if (value.endsWith("effective drifted")) return "warning";
		return "muted";
	}

	private async verifyRuntime(): Promise<void> {
		if (this.verifying || !this.options.verify) return;
		this.verifying = true;
		this.error = "";
		this.feedback = "";
		this.context.requestRender();
		try {
			await this.options.verify(this.context.signal);
		} catch (error) {
			if (!this.context.signal.aborted) this.error = oneLine(String(error)) || "Unable to verify RTK Runtime.";
		} finally {
			this.verifying = false;
			this.settingsList = this.createSettingsList();
			if (!this.disposed) this.context.requestRender();
		}
	}

	private wrapped(width: number, value: string): string[] {
		const available = Math.max(1, width - GUTTER.length);
		return wrapTextWithAnsi(value, available).map((line) => `${GUTTER}${line}`);
	}
}

export function createRtkDialogView(options: RtkDialogOptions): CommandDialogView<void> {
	return {
		priority: "normal",
		create: (context) => new RtkDialogComponent(context, options),
	};
}
