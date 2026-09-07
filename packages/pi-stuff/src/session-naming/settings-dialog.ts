import { getSelectListTheme, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	type CommandDialogComponent,
	type CommandDialogView,
	type CommandDialogViewContext,
	commandDialogRows,
	fitCommandDialogRows,
} from "../conversation-ui/index.ts";
import type { SessionNamingSettings, SessionNamingSettingsPatch, SessionNamingSettingsStore } from "./settings.ts";

const GUTTER = "  ";
const MIN_RENDER_WIDTH = 40;
const BOOLEAN_VALUES = ["on", "off"] as const;
const COOLDOWN_PRESETS = [10, 30, 60, 360, 1_440] as const;
export const SESSION_MODEL_VALUE = "Session model";

export interface SessionNamingModelChoice {
	readonly description?: string;
	readonly value: string;
}

export interface SessionNamingSettingsViewOptions {
	readonly modelChoices?: readonly SessionNamingModelChoice[];
	readonly onPersistenceError?: (message: string) => void;
}

export interface SessionNamingSettingsActions {
	update(patch: SessionNamingSettingsPatch): Promise<void>;
}

function settingsHint(width: number, selectingModel: boolean): string {
	const candidates = selectingModel
		? [
				"  Type to search · Enter select · Esc back",
				"  Search · Enter select · Esc back",
				"  Enter select · Esc back",
				"  Enter · Esc back",
				"  Esc back",
			]
		: [
				"  Enter/Space to change · Esc to close",
				"  Enter/Space change · Esc close",
				"  Enter/Space · Esc close",
				"  Enter · Esc close",
				"  Esc close",
			];
	return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? "Esc";
}

function oneLine(value: string): string {
	return value
		.replaceAll(/[\p{Cc}\p{Cf}]+/gu, " ")
		.replaceAll(/\s+/gu, " ")
		.trim();
}

function formatCooldown(minutes: number): string {
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `${String(hours)} ${hours === 1 ? "hour" : "hours"}`;
	}
	return `${String(minutes)} min`;
}

function cooldownValues(current: number): string[] {
	return [...new Set<number>([...COOLDOWN_PRESETS, current])].sort((left, right) => left - right).map(formatCooldown);
}

function compactNativeLine(line: string, width: number, model: string | undefined): string {
	if (width >= 40) return line;
	const modelRow = line.includes("Naming model");
	const compact = line
		.replace(/Automatic naming +/u, "Auto naming  ")
		.replace(/Rename cooldown +/u, "Cooldown  ")
		.replace(/Keep manually assigned names +/u, "Keep manual names  ")
		.replace(/Naming model +/u, "Model  ");
	if (!modelRow) return compact;
	const configured = model ?? SESSION_MODEL_VALUE;
	const valueRegion = compact.indexOf("Model") + "Model".length;
	for (let length = configured.length; length > 0; length -= 1) {
		const prefix = configured.slice(0, length);
		const index = compact.indexOf(prefix, valueRegion);
		if (index >= 0) {
			return `${compact.slice(0, index)}${model ? "Fixed" : "Session"}${compact.slice(index + prefix.length)}`;
		}
	}
	return compact;
}

function normalizeModelChoices(
	settings: SessionNamingSettings,
	choices: readonly SessionNamingModelChoice[],
): SessionNamingModelChoice[] {
	const byValue = new Map<string, SessionNamingModelChoice>();
	for (const choice of choices) {
		if (!choice.value.includes("/") || byValue.has(choice.value)) continue;
		byValue.set(choice.value, choice);
	}
	if (settings.model && !byValue.has(settings.model)) {
		byValue.set(settings.model, {
			description: "Configured model is not available in this Session",
			value: settings.model,
		});
	}
	const available = [...byValue.values()].sort((left, right) =>
		left.value < right.value ? -1 : left.value > right.value ? 1 : 0,
	);
	return [
		{
			description: "Follow the active Session model",
			value: SESSION_MODEL_VALUE,
		},
		...available,
	];
}

class ModelSelectSubmenu implements Component {
	private readonly choices: readonly SessionNamingModelChoice[];
	private readonly currentValue: string;
	private readonly input = new Input();
	private list: SelectList;
	private readonly onDone: (selectedValue?: string) => void;

	constructor(
		choices: readonly SessionNamingModelChoice[],
		currentValue: string,
		onDone: (selectedValue?: string) => void,
	) {
		this.choices = choices;
		this.currentValue = currentValue;
		this.onDone = onDone;
		this.input.focused = true;
		this.list = this.createList(choices, currentValue);
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (
			keybindings.matches(data, "tui.select.up") ||
			keybindings.matches(data, "tui.select.down") ||
			keybindings.matches(data, "tui.select.confirm")
		) {
			this.list.handleInput(data);
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.onDone();
			return;
		}
		const previous = this.input.getValue();
		this.input.handleInput(data);
		const query = this.input.getValue();
		if (query === previous) return;
		const filtered = fuzzyFilter([...this.choices], query, (choice) =>
			[choice.value, choice.description ?? ""].join(" "),
		);
		this.list = this.createList(filtered, query ? undefined : this.currentValue);
	}

	invalidate(): void {
		this.input.invalidate();
		this.list.invalidate();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, Math.floor(width));
		return [
			"  Search models",
			...this.input.render(Math.max(1, renderWidth - 2)).map((line) => `  ${line}`),
			"",
			...this.list.render(renderWidth),
			"",
		];
	}

	private createList(choices: readonly SessionNamingModelChoice[], selectedValue?: string): SelectList {
		const items: SelectItem[] = choices.map((choice) => {
			const item: SelectItem = { label: choice.value, value: choice.value };
			if (choice.description) item.description = choice.description;
			return item;
		});
		const list = new SelectList(items, Math.max(1, Math.min(items.length, 8)), getSelectListTheme(), {
			minPrimaryColumnWidth: 16,
			maxPrimaryColumnWidth: 44,
		});
		if (selectedValue) {
			const selectedIndex = items.findIndex((item) => item.value === selectedValue);
			if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
		}
		list.onSelect = (item) => this.onDone(item.value);
		list.onCancel = () => this.onDone();
		return list;
	}
}

function settingsItems(
	settings: SessionNamingSettings,
	createModelSubmenu: (currentValue: string, done: (selectedValue?: string) => void) => Component,
): SettingItem[] {
	return [
		{
			currentValue: settings.enabled ? "on" : "off",
			description: "Name settled direct-user Sessions automatically",
			id: "enabled",
			label: "Automatic naming",
			values: [...BOOLEAN_VALUES],
		},
		{
			currentValue: formatCooldown(settings.cooldownMinutes),
			description: "Wait this long before reconsidering an existing name",
			id: "cooldownMinutes",
			label: "Rename cooldown",
			values: cooldownValues(settings.cooldownMinutes),
		},
		{
			currentValue: settings.respectManualName ? "on" : "off",
			description: "Keep names assigned through Pi instead of replacing them",
			id: "respectManualName",
			label: "Keep manually assigned names",
			values: [...BOOLEAN_VALUES],
		},
		{
			currentValue: settings.model ?? SESSION_MODEL_VALUE,
			description: "Use the Session model or fix automatic naming to one available model",
			id: "model",
			label: "Naming model",
			submenu: createModelSubmenu,
		},
	];
}

function settingPatch(id: string, value: string): SessionNamingSettingsPatch | undefined {
	if (id === "enabled" || id === "respectManualName") {
		if (!BOOLEAN_VALUES.some((candidate) => candidate === value)) return undefined;
		return id === "enabled" ? { enabled: value === "on" } : { respectManualName: value === "on" };
	}
	if (id === "model") {
		if (value === SESSION_MODEL_VALUE) return { model: null };
		if (!value.includes("/")) return undefined;
		return { model: value };
	}
	if (id !== "cooldownMinutes") return undefined;
	const match = /^(\d+) (hour|hours|min)$/u.exec(value);
	if (!match?.[1]) return undefined;
	const quantity = Number.parseInt(match[1], 10);
	const cooldownMinutes = match[2] === "min" ? quantity : quantity * 60;
	if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 1_440) return undefined;
	return { cooldownMinutes };
}

class SessionNamingSettingsDialog implements CommandDialogComponent {
	private readonly actions: SessionNamingSettingsActions;
	private readonly context: CommandDialogViewContext<void>;
	private disposed = false;
	private error = "";
	private readonly generations = new Map<string, number>();
	private readonly options: SessionNamingSettingsViewOptions;
	private readonly modelChoices: readonly SessionNamingModelChoice[];
	private selectingModel = false;
	private readonly settings: SessionNamingSettingsStore;
	private readonly settingsList: SettingsList;
	private readonly unsubscribe: () => void;

	constructor(
		context: CommandDialogViewContext<void>,
		settings: SessionNamingSettingsStore,
		actions: SessionNamingSettingsActions,
		options: SessionNamingSettingsViewOptions,
	) {
		this.actions = actions;
		this.context = context;
		this.options = options;
		this.settings = settings;
		this.modelChoices = normalizeModelChoices(settings.get(), options.modelChoices ?? []);
		const items = settingsItems(settings.get(), (currentValue, done) => this.createModelSubmenu(currentValue, done));
		this.settingsList = new SettingsList(
			items,
			items.length,
			getSettingsListTheme(),
			(id, value) => this.setValue(id, value),
			() => context.close(),
			{ enableSearch: false },
		);
		this.unsubscribe = settings.subscribe(() => this.sync());
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		try {
			this.unsubscribe();
		} catch {
			// A presentation observer cannot block Dialog teardown.
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
		const nativeBody = nativeLines
			.slice(0, -1)
			.map((line) => compactNativeLine(line, renderWidth, this.settings.get().model));
		const errorLine = this.error ? `${GUTTER}${this.context.theme.fg("error", this.error)}` : undefined;
		const selected = nativeBody.find((line) => line.includes("→"));
		const lines = fitCommandDialogRows(
			{
				header: [
					this.context.theme.fg("border", "─".repeat(renderWidth)),
					`${GUTTER}${this.context.theme.bold("Session Naming")}`,
				],
				body: [...nativeBody, ...(errorLine ? ["", errorLine] : [])],
				footer: [this.context.theme.fg("dim", settingsHint(renderWidth, this.selectingModel))],
				priority: [errorLine ?? selected ?? `${GUTTER}No Session Naming settings`],
			},
			maximumRows,
		);
		return lines.map((line) => truncateToWidth(line, renderWidth, "…"));
	}

	private setValue(id: string, value: string): void {
		if (id === "model" && !this.modelChoices.some((choice) => choice.value === value)) return;
		const patch = settingPatch(id, value);
		if (!patch) return;
		const generation = (this.generations.get(id) ?? 0) + 1;
		this.generations.set(id, generation);
		this.error = "";
		void this.actions.update(patch).catch((error) => {
			if (this.generations.get(id) !== generation) return;
			const message = oneLine(String(error)) || "Unable to save Session Naming setting.";
			if (this.disposed) {
				try {
					this.options.onPersistenceError?.(message);
				} catch {
					// A notification adapter cannot turn a handled persistence failure into an unhandled rejection.
				}
				return;
			}
			this.error = message;
			this.sync();
		});
	}

	private sync(): void {
		if (this.disposed) return;
		for (const item of settingsItems(this.settings.get(), (currentValue, done) =>
			this.createModelSubmenu(currentValue, done),
		)) {
			this.settingsList.updateValue(item.id, item.currentValue);
		}
		this.context.requestRender();
	}

	private createModelSubmenu(currentValue: string, done: (selectedValue?: string) => void): ModelSelectSubmenu {
		this.selectingModel = true;
		return new ModelSelectSubmenu(this.modelChoices, currentValue, (selectedValue) => {
			this.selectingModel = false;
			done(selectedValue);
			this.context.requestRender();
		});
	}
}

export function createSessionNamingSettingsView(
	settings: SessionNamingSettingsStore,
	actions: SessionNamingSettingsActions,
	options: SessionNamingSettingsViewOptions = {},
): CommandDialogView<void> {
	return {
		priority: "normal",
		create: (context) => new SessionNamingSettingsDialog(context, settings, actions, options),
	};
}
