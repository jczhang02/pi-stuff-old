import { type SettingItem, SettingsList, type SettingsListTheme, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type CommandDialogComponent,
	type CommandDialogView,
	type CommandDialogViewContext,
	commandDialogRows,
	fitCommandDialogRows,
} from "../conversation-ui/index.ts";

const GUTTER = "  ";
const MIN_RENDER_WIDTH = 24;

export type CodeModeEffectiveSource = "frozen" | "project" | "global" | "environment" | "default";

export interface CodeModeDialogSnapshot {
	readonly effectiveSource: CodeModeEffectiveSource;
	readonly enabled: boolean;
	readonly fallbackEnabled: boolean;
	readonly frozen: boolean;
	readonly globalEnabled: boolean | undefined;
	readonly history: { readonly retainedCount: number; readonly totalCount: number };
	readonly pendingCount: number;
	readonly projectEnabled: boolean | undefined;
	readonly projectTrusted: boolean;
	readonly snippetCount: number;
	readonly toolCount: number;
}

export interface CodeModeDialogControls {
	getSnapshot(): CodeModeDialogSnapshot;
	setGlobalEnabled(enabled: boolean): Promise<void> | void;
	setProjectEnabled(enabled: boolean | undefined): Promise<void> | void;
}

function settingsListTheme(context: CommandDialogViewContext<void>): SettingsListTheme {
	const theme = context.theme;
	return {
		label: (text, selected) => (selected ? theme.fg("accent", text) : text),
		value: (text, selected) => (selected ? theme.fg("accent", text) : theme.fg("muted", text)),
		description: (text) => theme.fg("dim", text),
		cursor: theme.fg("accent", "→ "),
		hint: (text) => theme.fg("dim", text),
	};
}

function countLabel(count: number, singular: string): string {
	return `${String(count)} ${singular}${count === 1 ? "" : "s"}`;
}

function projectValue(snapshot: CodeModeDialogSnapshot): string {
	if (snapshot.frozen) return "locked";
	if (!snapshot.projectTrusted) return "unavailable";
	return snapshot.projectEnabled === undefined ? "inherit" : snapshot.projectEnabled ? "on" : "off";
}

function globalValue(snapshot: CodeModeDialogSnapshot): string {
	if (snapshot.frozen) return "locked";
	return (snapshot.globalEnabled ?? snapshot.fallbackEnabled) ? "on" : "off";
}

class CodeModeDialog implements CommandDialogComponent {
	private readonly context: CommandDialogViewContext<void>;
	private readonly controls: CodeModeDialogControls;
	private readonly settingsList: SettingsList;
	private error: string | undefined;
	private saving = false;

	constructor(context: CommandDialogViewContext<void>, controls: CodeModeDialogControls) {
		this.context = context;
		this.controls = controls;
		const snapshot = controls.getSnapshot();
		const items: SettingItem[] = [
			{
				currentValue: projectValue(snapshot),
				description: snapshot.frozen
					? "Locked by the parent Agent"
					: snapshot.projectTrusted
						? "Override or inherit the global default"
						: "Unavailable for an untrusted project",
				id: "project",
				label: "This project",
				values: snapshot.frozen ? ["locked"] : snapshot.projectTrusted ? ["inherit", "off", "on"] : ["unavailable"],
			},
			{
				currentValue: globalValue(snapshot),
				description: snapshot.frozen ? "Locked by the parent Agent" : "Default for projects without an override",
				id: "global",
				label: "Global default",
				values: snapshot.frozen ? ["locked"] : ["off", "on"],
			},
		];
		this.settingsList = new SettingsList(
			items,
			1,
			settingsListTheme(context),
			(id, value) => {
				if (id === "project" && snapshot.projectTrusted && !snapshot.frozen) {
					void this.updateProject(value === "inherit" ? undefined : value === "on");
				} else if (id === "global" && !snapshot.frozen) {
					void this.updateGlobal(value === "on");
				}
			},
			() => context.close(),
			{ enableSearch: false },
		);
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
		const snapshot = this.controls.getSnapshot();
		this.settingsList.updateValue("project", projectValue(snapshot));
		this.settingsList.updateValue("global", globalValue(snapshot));
		const nativeBody = this.settingsList
			.render(Math.max(MIN_RENDER_WIDTH, renderWidth))
			.filter((line) => !line.includes("Enter/Space to change") && !line.includes("Enter/Space change"));
		const selected = nativeBody.find((line) => line.includes("→"));
		const effective = `${GUTTER}${this.context.theme.bold("Effective")}  ${snapshot.enabled ? "on" : "off"} · ${snapshot.effectiveSource}`;
		const session = [
			`${countLabel(snapshot.history.totalCount, "execution")} total`,
			`${String(snapshot.history.retainedCount)} retained`,
			countLabel(snapshot.pendingCount, "pending"),
			countLabel(snapshot.snippetCount, "snippet"),
		].join(" · ");
		const body = [
			effective,
			"",
			...nativeBody,
			...(this.error ? [`${GUTTER}${this.context.theme.fg("error", this.error)}`] : []),
			"",
			`${GUTTER}${this.context.theme.bold("Provider surface")}`,
			`${GUTTER}${this.context.theme.fg("muted", "codemode · tool_search")}`,
			"",
			`${GUTTER}${this.context.theme.bold("Local catalog")}`,
			`${GUTTER}${this.context.theme.fg("muted", countLabel(snapshot.toolCount, "Package Tool"))}`,
			"",
			`${GUTTER}${this.context.theme.bold("Session")}`,
			`${GUTTER}${this.context.theme.fg("muted", session)}`,
		];
		const lines = fitCommandDialogRows(
			{
				header: [
					this.context.theme.fg("border", "━".repeat(renderWidth)),
					`${GUTTER}${this.context.theme.bold("Code Mode")}`,
				],
				body,
				footer: [
					`${GUTTER}${this.context.theme.fg("dim", this.saving ? "Saving setting… · Esc close" : "Enter change · Esc close")}`,
				],
				priority: [this.error ? `${GUTTER}${this.context.theme.fg("error", this.error)}` : (selected ?? effective)],
			},
			commandDialogRows(this.context),
		);
		return lines.map((line) => truncateToWidth(line, renderWidth, "…"));
	}

	private async updateProject(enabled: boolean | undefined): Promise<void> {
		await this.update(() => this.controls.setProjectEnabled(enabled));
	}

	private async updateGlobal(enabled: boolean): Promise<void> {
		await this.update(() => this.controls.setGlobalEnabled(enabled));
	}

	private async update(operation: () => Promise<void> | void): Promise<void> {
		if (this.saving) return;
		this.error = undefined;
		this.saving = true;
		this.context.requestRender();
		try {
			await operation();
		} catch {
			this.error = "Unable to save Code Mode setting";
		} finally {
			this.saving = false;
			this.context.requestRender();
		}
	}
}

export function createCodeModeDialogView(controls: CodeModeDialogControls): CommandDialogView<void> {
	return { priority: "normal", create: (context) => new CodeModeDialog(context, controls) };
}
