import {
	type SettingItem,
	SettingsList,
	type SettingsListTheme,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type CommandDialogComponent,
	type CommandDialogView,
	type CommandDialogViewContext,
	commandDialogRows,
	fitCommandDialogRows,
} from "../conversation-ui/index.ts";
import { type CodexUsageSnapshot, formatCodexUsage } from "./usage.ts";

const GUTTER = "  ";
const MIN_RENDER_WIDTH = 24;
const TOOL_SEPARATOR = " · ";
const TOOL_LABELS = ["apply_patch", "view_image", "imagegen · gpt-image-2"] as const;

/** Pack complete semantic Tool labels without ever clipping a name or model mid-token. */
export function formatCodexToolLines(width: number): string[] {
	const available = Math.max(1, Math.floor(width));
	const labels = TOOL_LABELS.map((label) =>
		label === "imagegen · gpt-image-2" && visibleWidth(label) > available ? "imagegen" : label,
	);
	const lines: string[] = [];
	for (const label of labels) {
		const current = lines.at(-1);
		const candidate = current ? `${current}${TOOL_SEPARATOR}${label}` : label;
		if (current && visibleWidth(candidate) > available) lines.push(label);
		else if (current) lines[lines.length - 1] = candidate;
		else lines.push(label);
	}
	return lines;
}

export interface CodexControls {
	getFast(): boolean;
	getUsage(): CodexUsageSnapshot | undefined;
	refreshUsage(signal: AbortSignal | undefined): Promise<CodexUsageSnapshot>;
	setFast(enabled: boolean): Promise<void>;
}

function oneLine(value: string): string {
	return value
		.split("")
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint < 32 || (codePoint >= 127 && codePoint <= 159) ? " " : character;
		})
		.join("")
		.replaceAll(/\s+/gu, " ")
		.trim();
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

class CodexDialog implements CommandDialogComponent {
	private readonly context: CommandDialogViewContext<void>;
	private readonly controls: CodexControls;
	private disposed = false;
	private error = "";
	private loading = false;
	private readonly settingsList: SettingsList;
	private usage: CodexUsageSnapshot | undefined;

	constructor(context: CommandDialogViewContext<void>, controls: CodexControls) {
		this.context = context;
		this.controls = controls;
		this.usage = controls.getUsage();
		const items: SettingItem[] = [
			{
				currentValue: controls.getFast() ? "on" : "off",
				description: "Use OpenAI priority service tier for Codex turns",
				id: "fast",
				label: "Fast mode",
				values: ["off", "on"],
			},
		];
		this.settingsList = new SettingsList(
			items,
			1,
			settingsListTheme(context),
			(_id, value) => this.updateFast(value === "on"),
			() => context.close(),
			{ enableSearch: false },
		);
		void this.refreshUsage();
	}

	dispose(): void {
		this.disposed = true;
	}

	handleInput(data: string): void {
		if (data === "r" || data === "R") void this.refreshUsage();
		else this.settingsList.handleInput?.(data);
		this.context.requestRender();
	}

	invalidate(): void {
		this.settingsList.invalidate();
	}

	render(width: number): string[] {
		const renderWidth = Math.max(1, Math.floor(width));
		const contentWidth = Math.max(1, renderWidth - GUTTER.length);
		const nativeLines = this.settingsList.render(Math.max(MIN_RENDER_WIDTH, renderWidth));
		const nativeBody = nativeLines.filter(
			(line) => !line.includes("Enter/Space to change") && !line.includes("Enter/Space change"),
		);
		const usageLines = this.loading
			? [this.context.theme.fg("muted", "Loading usage…")]
			: this.usage
				? formatCodexUsage(this.usage).split("\n")
				: [this.context.theme.fg("muted", "Usage unavailable")];
		const errorLine = this.error ? `${GUTTER}${this.context.theme.fg("error", this.error)}` : undefined;
		const body = [
			...nativeBody,
			"",
			`${GUTTER}${this.context.theme.bold("Usage")}`,
			...usageLines.flatMap((line) => wrapTextWithAnsi(line, contentWidth).map((part) => `${GUTTER}${part}`)),
			"",
			`${GUTTER}${this.context.theme.bold("Tools")}`,
			...formatCodexToolLines(contentWidth).map((line) => `${GUTTER}${this.context.theme.fg("muted", line)}`),
			...(errorLine ? ["", errorLine] : []),
		];
		const selected = nativeBody.find((line) => line.includes("→"));
		const usage =
			body.find((line) => line.includes("Weekly")) ?? body.find((line) => line.includes("Usage unavailable"));
		const lines = fitCommandDialogRows(
			{
				header: [
					this.context.theme.fg("border", "━".repeat(renderWidth)),
					`${GUTTER}${this.context.theme.bold("Codex")}`,
				],
				body,
				footer: [`${GUTTER}${this.context.theme.fg("dim", "Enter toggle · R refresh · Esc close")}`],
				priority: [errorLine ?? selected ?? usage ?? `${GUTTER}Usage unavailable`],
			},
			commandDialogRows(this.context),
		);
		return lines.map((line) => truncateToWidth(line, renderWidth, "…"));
	}

	private async refreshUsage(): Promise<void> {
		if (this.loading || this.disposed) return;
		this.loading = true;
		this.error = "";
		this.context.requestRender();
		try {
			this.usage = await this.controls.refreshUsage(this.context.signal);
		} catch (error) {
			this.error = oneLine(String(error)) || "Unable to load Codex usage.";
		} finally {
			this.loading = false;
			if (!this.disposed) this.context.requestRender();
		}
	}

	private async updateFast(enabled: boolean): Promise<void> {
		this.error = "";
		try {
			await this.controls.setFast(enabled);
		} catch (error) {
			this.error = oneLine(String(error)) || "Unable to save Fast mode.";
		} finally {
			this.settingsList.updateValue("fast", this.controls.getFast() ? "on" : "off");
			if (!this.disposed) this.context.requestRender();
		}
	}
}

export function createCodexDialogView(controls: CodexControls): CommandDialogView<void> {
	return {
		priority: "normal",
		create: (context) => new CodexDialog(context, controls),
	};
}
