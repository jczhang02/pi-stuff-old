import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { type SettingItem, SettingsList, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	type CommandDialogComponent,
	type CommandDialogView,
	type CommandDialogViewContext,
	commandDialogRows,
	fitCommandDialogRows,
} from "../conversation-ui/index.ts";
import { boundTerminalLine } from "../tool-display/index.ts";
import type { NotificationSettings, NotificationSettingsChanges, NotificationSettingsStore } from "./settings.ts";

const GUTTER = "  ";
const MIN_RENDER_WIDTH = 24;
const BOOLEAN_VALUES = ["true", "false"] as const;
const MINIMUM_DURATION_VALUES = ["0s", "5s", "10s", "30s", "60s"] as const;
const GRACE_VALUES = ["0s", "1s", "2s", "5s"] as const;
const DELIVERY_VALUES = ["auto", "kitty", "osc9", "osc777", "bell"] as const;
const ON_OFF_VALUES = ["on", "off"] as const;

export interface NotificationSettingsViewOptions {
	readonly onPersistenceError?: (message: string) => void;
	readonly onTest?: () => void;
}

export interface NotificationSettingsActions {
	update(patch: NotificationSettingsChanges): Promise<void>;
}

function settingsHint(width: number): string {
	const candidates = [
		"  T test · Enter/Space to change · Esc to close",
		"  T test · Enter/Space change · Esc close",
		"  T test · Enter/Space · Esc close",
		"  T test · Enter · Esc close",
		"  T test · Esc close",
	];
	return candidates.find((candidate) => visibleWidth(candidate) <= width) ?? "Esc";
}

function durationLabel(milliseconds: number): string {
	return `${String(milliseconds / 1_000)}s`;
}

function settingsItems(settings: NotificationSettings): SettingItem[] {
	return [
		{
			currentValue: String(settings.enabled),
			description: "Send alerts after settled user-started work",
			id: "enabled",
			label: "Notifications",
			values: [...BOOLEAN_VALUES],
		},
		{
			currentValue: String(settings.completionAlerts),
			description: "Notify when work is ready for review",
			id: "completionAlerts",
			label: "Completion alerts",
			values: [...BOOLEAN_VALUES],
		},
		{
			currentValue: String(settings.failureAlerts),
			description: "Notify when work ends with an error",
			id: "failureAlerts",
			label: "Failure alerts",
			values: [...BOOLEAN_VALUES],
		},
		{
			currentValue: durationLabel(settings.minimumDurationMs),
			description: "Ignore work shorter than this duration",
			id: "minimumDurationMs",
			label: "Notify after",
			values: [...MINIMUM_DURATION_VALUES],
		},
		{
			currentValue: durationLabel(settings.gracePeriodMs),
			description: "Wait for terminal activity before alerting",
			id: "gracePeriodMs",
			label: "Wait after completion",
			values: [...GRACE_VALUES],
		},
		{
			currentValue: settings.delivery,
			description: "Select the terminal notification protocol",
			id: "delivery",
			label: "Delivery",
			values: [...DELIVERY_VALUES],
		},
		{
			currentValue: settings.tmuxNotification ? "on" : "off",
			description: "Control tmux attention for every delivery mode",
			id: "tmuxNotification",
			label: "Tmux notification",
			values: [...ON_OFF_VALUES],
		},
		{
			currentValue: String(settings.responsePreview),
			description: "Include bounded final-response prose in desktop history",
			id: "responsePreview",
			label: "Response preview",
			values: [...BOOLEAN_VALUES],
		},
		{
			currentValue: String(settings.terminalBell),
			description: "Also send BEL with visual delivery outside tmux",
			id: "terminalBell",
			label: "Also ring terminal bell",
			values: [...BOOLEAN_VALUES],
		},
	];
}

function settingPatch(id: string, value: string): Partial<Omit<NotificationSettings, "schemaVersion">> | undefined {
	if (id === "minimumDurationMs" && MINIMUM_DURATION_VALUES.some((candidate) => candidate === value)) {
		return { minimumDurationMs: Number.parseInt(value, 10) * 1_000 };
	}
	if (id === "gracePeriodMs" && GRACE_VALUES.some((candidate) => candidate === value)) {
		return { gracePeriodMs: Number.parseInt(value, 10) * 1_000 };
	}
	if (id === "delivery") {
		for (const delivery of DELIVERY_VALUES) {
			if (delivery === value) return { delivery };
		}
	}
	if (id === "tmuxNotification" && ON_OFF_VALUES.some((candidate) => candidate === value)) {
		return { tmuxNotification: value === "on" };
	}
	if (!BOOLEAN_VALUES.some((candidate) => candidate === value)) return undefined;
	const enabled = value === "true";
	if (id === "enabled") return { enabled };
	if (id === "completionAlerts") return { completionAlerts: enabled };
	if (id === "failureAlerts") return { failureAlerts: enabled };
	if (id === "responsePreview") return { responsePreview: enabled };
	if (id === "terminalBell") return { terminalBell: enabled };
	return undefined;
}

class NotificationSettingsDialog implements CommandDialogComponent {
	private readonly actions: NotificationSettingsActions;
	private readonly context: CommandDialogViewContext<void>;
	private disposed = false;
	private error = "";
	private readonly generations = new Map<string, number>();
	private readonly options: NotificationSettingsViewOptions;
	private readonly settings: NotificationSettingsStore;
	private readonly settingsList: SettingsList;
	private readonly unsubscribe: () => void;

	constructor(
		context: CommandDialogViewContext<void>,
		settings: NotificationSettingsStore,
		actions: NotificationSettingsActions,
		options: NotificationSettingsViewOptions,
	) {
		this.actions = actions;
		this.context = context;
		this.options = options;
		this.settings = settings;
		const items = settingsItems(settings.get());
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
			// A presentation observer cannot block dialog teardown.
		}
	}

	handleInput(data: string): void {
		if (data === "t" || data === "T") {
			this.options.onTest?.();
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
		const maximumRows = commandDialogRows(this.context);
		if (maximumRows === 0) return [];
		const nativeLines = this.settingsList.render(Math.max(MIN_RENDER_WIDTH, renderWidth));
		const nativeHintIndex = nativeLines.map((line) => line.includes("Enter/Space to change")).lastIndexOf(true);
		const nativeBody = nativeLines.filter((_line, index) => index !== nativeHintIndex);
		const errorLine = this.error ? `${GUTTER}${this.context.theme.fg("error", this.error)}` : undefined;
		const selected = nativeBody.find((line) => line.includes("→"));
		const lines = fitCommandDialogRows(
			{
				header: [
					this.context.theme.fg("border", "─".repeat(renderWidth)),
					`${GUTTER}${this.context.theme.bold("Notifications")}`,
				],
				body: [...nativeBody, ...(errorLine ? ["", errorLine] : [])],
				footer: [this.context.theme.fg("dim", settingsHint(renderWidth))],
				priority: [errorLine ?? selected ?? `${GUTTER}No Notification settings`],
			},
			maximumRows,
		);
		return lines.map((line) => truncateToWidth(line, renderWidth, "…"));
	}

	private setValue(id: string, value: string): void {
		const patch = settingPatch(id, value);
		if (!patch) return;
		const generation = (this.generations.get(id) ?? 0) + 1;
		this.generations.set(id, generation);
		this.error = "";
		void this.actions.update(patch).catch((error) => {
			if (this.generations.get(id) !== generation) return;
			const message = boundTerminalLine(String(error), 160) || "Unable to save Notification setting.";
			if (this.disposed) {
				this.options.onPersistenceError?.(message);
				return;
			}
			this.error = message;
			this.sync();
		});
	}

	private sync(): void {
		if (this.disposed) return;
		for (const item of settingsItems(this.settings.get())) {
			this.settingsList.updateValue(item.id, item.currentValue);
		}
		this.context.requestRender();
	}
}

export function createNotificationSettingsView(
	settings: NotificationSettingsStore,
	actions: NotificationSettingsActions,
	options: NotificationSettingsViewOptions = {},
): CommandDialogView<void> {
	return {
		priority: "normal",
		create: (context) => new NotificationSettingsDialog(context, settings, actions, options),
	};
}
