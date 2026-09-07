import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { reportDiagnostic } from "./diagnostics.ts";
import { commandDialogRows, fitCommandDialogRows } from "./dialog-layout.ts";
import type { CommandDialogComponent, CommandDialogView, CommandDialogViewContext } from "./index.ts";
import type { RegisteredUiSetting, UiSettingRegistry } from "./settings.ts";

const GUTTER = "  ";
const MIN_RENDER_WIDTH = 24;

export interface UiSettingsViewOptions {
	readonly onPersistenceError?: (message: string) => void;
}

function oneLine(value: string): string {
	let result = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0) ?? 0;
		result += codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
	}
	return result.replaceAll(/\s+/gu, " ").trim();
}

function settingsHint(width: number): string {
	const candidates = [
		"  Type to search · Enter/Space to change · Esc to close",
		"  Type search · Enter/Space change · Esc close",
		"  Enter/Space · Esc close",
		"  Enter · Esc close",
		"  Esc close",
	];
	return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? "Esc";
}

class UiSettingsDialog implements CommandDialogComponent {
	private readonly context: CommandDialogViewContext<void>;
	private disposed = false;
	private error = "";
	private readonly generations = new Map<string, number>();
	private readonly onPersistenceError: ((message: string) => void) | undefined;
	private readonly settings: readonly RegisteredUiSetting[];
	private readonly settingsList: SettingsList;
	private readonly unsubscribers: Array<() => void>;

	constructor(context: CommandDialogViewContext<void>, registry: UiSettingRegistry, options: UiSettingsViewOptions) {
		this.context = context;
		this.onPersistenceError = options.onPersistenceError;
		this.settings = registry.list();
		const items = this.settings.map<SettingItem>((setting) => ({
			currentValue: setting.get(),
			description: setting.description,
			id: setting.id,
			label: setting.label,
			values: [...setting.values],
		}));
		this.settingsList = new SettingsList(
			items,
			Math.max(1, items.length),
			getSettingsListTheme(),
			(id, value) => this.setValue(id, value),
			() => context.close(),
			{ enableSearch: true },
		);
		this.unsubscribers = this.settings.map((setting) => {
			try {
				return setting.subscribe(() => this.sync(setting));
			} catch (error) {
				reportDiagnostic({
					action: "/ui",
					capability: "UI",
					error,
					key: `setting-observer-${setting.id}`,
					severity: "warning",
					summary: `The ${setting.label} setting could not refresh live`,
					visibility: "notice",
				});
				return () => {};
			}
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribers.splice(0)) {
			try {
				unsubscribe();
			} catch (error) {
				reportDiagnostic({
					capability: "UI",
					error,
					key: "setting-observer-release",
					severity: "warning",
					summary: "A UI setting observer could not be released",
				});
			}
		}
	}

	handleInput(data: string): void {
		this.settingsList.handleInput?.(data);
		this.context.requestRender();
	}

	invalidate(): void {
		this.settingsList.invalidate();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, Math.floor(width));
		const maximumRows = commandDialogRows(this.context);
		if (maximumRows === 0) return [];
		const nativeLines = this.settingsList.render(Math.max(MIN_RENDER_WIDTH, renderWidth));
		let nativeHintIndex = -1;
		for (let index = nativeLines.length - 1; index >= 0; index -= 1) {
			const line = nativeLines[index] ?? "";
			if (!line.includes("Type to search") && !line.includes("Enter/Space to change")) continue;
			nativeHintIndex = index;
			break;
		}
		const footer = [
			nativeHintIndex >= 0
				? this.context.theme.fg("dim", settingsHint(renderWidth))
				: `${GUTTER}${this.context.theme.fg("dim", "Esc close")}`,
		];
		const nativeBody = nativeLines.filter((_line, index) => index !== nativeHintIndex);
		const errorLine = this.error ? `${GUTTER}${this.context.theme.fg("error", this.error)}` : undefined;
		const body = [...nativeBody, ...(errorLine ? ["", errorLine] : [])];
		const selected = nativeBody.find((line) => line.includes("→"));
		const lines = fitCommandDialogRows(
			{
				header: [
					this.context.theme.fg("border", "─".repeat(renderWidth)),
					`${GUTTER}${this.context.theme.bold("UI")}`,
				],
				body,
				footer,
				priority: [errorLine ?? selected ?? `${GUTTER}${this.context.theme.fg("muted", "No UI settings")}`],
			},
			maximumRows,
		);
		return lines.map((line) => truncateToWidth(line, renderWidth, "…"));
	}

	private setValue(id: string, value: string): void {
		const setting = this.settings.find((candidate) => candidate.id === id);
		if (!setting?.values.includes(value)) return;
		const generation = (this.generations.get(id) ?? 0) + 1;
		this.generations.set(id, generation);
		this.error = "";
		void setting.set(value).catch((error) => {
			if (this.generations.get(id) !== generation) return;
			const message = oneLine(String(error)) || "Unable to save UI setting.";
			if (this.disposed) {
				try {
					this.onPersistenceError?.(message);
				} catch {
					// A notification adapter cannot turn a handled persistence failure into an unhandled rejection.
				}
				return;
			}
			this.error = message;
			this.sync(setting);
		});
	}

	private sync(setting: RegisteredUiSetting): void {
		if (this.disposed) return;
		this.settingsList.updateValue(setting.id, setting.get());
		this.context.requestRender();
	}
}

export function createUiSettingsView(
	registry: UiSettingRegistry,
	options: UiSettingsViewOptions = {},
): CommandDialogView<void> {
	return {
		priority: "normal",
		create: (context) => new UiSettingsDialog(context, registry, options),
	};
}
