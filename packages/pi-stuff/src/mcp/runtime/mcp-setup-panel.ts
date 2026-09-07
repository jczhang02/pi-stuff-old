import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { matchesCommandDialogCancel } from "../../conversation-ui/index.ts";
import { isRuntimeNumber } from "../../shared/runtime-type.ts";
import { KNOWN_SERVER_PRESETS, type KnownServerPreset, type McpDiscoverySummary } from "./config.ts";
import {
	type Action,
	LIST_WINDOW_ROWS,
	type PendingWrite,
	renderMcpSetupPanel,
	type Screen,
	type SetupNotice,
	type SetupPreviewCallbacks,
} from "./mcp-setup-panel-view.ts";
import { redactTraceText } from "./mcp-trace.ts";
import type { McpOnboardingState } from "./onboarding-state.ts";
import { createPanelKeys, type PanelKeybindings, type PanelKeys } from "./panel-keys.ts";
import type { ImportKind } from "./types.ts";
import { formatTerminalError } from "./utils.ts";

export interface SetupPanelCallbacks extends SetupPreviewCallbacks {
	adoptImports: (imports: ImportKind[]) => Promise<{ added: ImportKind[]; path: string }>;
	scaffoldProjectConfig: () => Promise<{ path: string }>;
	addRepoPrompt: () => Promise<{ path: string; serverName: string }>;
	addKnownServer: (preset: KnownServerPreset) => Promise<{ path: string; serverName: string }>;
	openPath: (path: string) => Promise<void>;
	markSetupCompleted: () => Promise<void>;
}

export interface SetupPanelOptions {
	mode: "empty" | "setup";
	onboardingState: McpOnboardingState;
	keybindings?: PanelKeybindings;
}

interface SetupTui {
	requestRender(): void;
	readonly terminal?: { readonly rows?: number };
}

export class McpSetupPanel {
	private screen: Screen;
	private actionCursor = 0;
	private importCursor = 0;
	private pathCursor = 0;
	private selectedImports = new Set<ImportKind>();
	private busy = false;
	private busyCanClose = false;
	private disposed = false;
	private confirmation: PendingWrite | null = null;
	private confirmCursor = 0;
	private pageRows = LIST_WINDOW_ROWS;
	private notice: SetupNotice | null = null;
	private tui: SetupTui;
	private readonly theme: Theme;
	private keys: PanelKeys;
	private inactivityTimeout: ReturnType<typeof setTimeout> | null = null;
	private static readonly INACTIVITY_MS = 60_000;
	private discovery: McpDiscoverySummary;
	private callbacks: SetupPanelCallbacks;
	private options: SetupPanelOptions;
	private done: () => void;

	constructor(
		discovery: McpDiscoverySummary,
		callbacks: SetupPanelCallbacks,
		options: SetupPanelOptions,
		tui: SetupTui,
		theme: Theme,
		done: () => void,
	) {
		this.discovery = discovery;
		this.callbacks = callbacks;
		this.options = options;
		this.done = done;
		this.tui = tui;
		this.theme = theme;
		this.keys = createPanelKeys(options.keybindings);
		this.screen = options.mode;
		this.selectedImports = new Set(discovery.imports.map((entry) => entry.kind));
		this.resetInactivityTimeout();
	}

	private resetInactivityTimeout(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
		this.inactivityTimeout = null;
		if (this.busy || this.disposed) return;
		this.inactivityTimeout = setTimeout(() => this.close(), McpSetupPanel.INACTIVITY_MS);
	}

	private cleanup(): void {
		if (this.inactivityTimeout) clearTimeout(this.inactivityTimeout);
		this.inactivityTimeout = null;
	}

	private close(): void {
		this.dispose();
		this.done();
	}

	private getActions(): Action[] {
		const actions: Action[] = [];
		if (this.screen === "empty") {
			actions.push({ id: "run-setup", label: "Run setup" });
		}
		if (this.discovery.imports.length > 0) {
			actions.push({ id: "adopt-imports", label: "Adopt detected compatibility imports" });
		}
		actions.push({ id: "view-example", label: "View example `.mcp.json`" });
		if (!this.discovery.sources.some((source) => source.id === "shared-project" && source.exists)) {
			actions.push({ id: "scaffold-project", label: "Scaffold project `.mcp.json`" });
		}
		actions.push({ id: "show-precedence", label: "Explain config precedence" });
		if (this.getDetectedPaths().length > 0) {
			actions.push({ id: "open-paths", label: "Open detected config paths" });
		}
		for (const preset of KNOWN_SERVER_PRESETS) {
			actions.push({ id: "add-known-server", label: preset.name, preset });
		}
		if (
			!this.discovery.repoPrompt.configured &&
			this.discovery.repoPrompt.executablePath &&
			this.discovery.repoPrompt.targetPath &&
			this.discovery.repoPrompt.entry &&
			this.discovery.repoPrompt.serverName
		) {
			actions.push({ id: "add-repoprompt", label: "Add RepoPrompt to shared MCP config" });
		}
		return actions;
	}

	private getDetectedPaths(): string[] {
		const paths = [
			...this.discovery.sources.filter((source) => source.exists).map((source) => source.path),
			...this.discovery.imports.map((entry) => entry.path),
		];
		return [...new Set(paths)];
	}

	handleInput(data: string): void {
		if (this.disposed) return;
		if (this.busy) {
			const cancel =
				matchesKey(data, "ctrl+c") ||
				matchesKey(data, "escape") ||
				!!(this.options.keybindings && matchesCommandDialogCancel(data, this.options.keybindings));
			if (!this.busyCanClose || !cancel) return;
			this.close();
			return;
		}
		this.resetInactivityTimeout();
		this.notice = null;

		if (matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}

		if (this.confirmation) {
			this.handleConfirmationInput(data);
			return;
		}

		if (
			matchesKey(data, "escape") ||
			(this.options.keybindings && matchesCommandDialogCancel(data, this.options.keybindings))
		) {
			if (this.screen === "imports" || this.screen === "paths") {
				this.screen = this.discovery.hasAnyConfig ? "setup" : "empty";
				this.tui.requestRender();
				return;
			}
			this.close();
			return;
		}

		if (this.screen === "imports") {
			this.handleImportsInput(data);
			return;
		}
		if (this.screen === "paths") {
			this.handlePathsInput(data);
			return;
		}

		const actions = this.getActions();
		if (this.keys.selectUp(data)) {
			this.actionCursor = Math.max(0, this.actionCursor - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectDown(data)) {
			this.actionCursor = Math.min(actions.length - 1, this.actionCursor + 1);
			this.tui.requestRender();
			return;
		}
		if (actions.length > this.pageRows && this.keys.selectPageUp(data)) {
			this.actionCursor = Math.max(0, this.actionCursor - this.pageRows);
			this.tui.requestRender();
			return;
		}
		if (actions.length > this.pageRows && this.keys.selectPageDown(data)) {
			this.actionCursor = Math.min(actions.length - 1, this.actionCursor + this.pageRows);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
			this.actionCursor = matchesKey(data, Key.home) ? 0 : Math.max(0, actions.length - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectConfirm(data)) {
			const selected = actions[this.actionCursor] ?? null;
			if (!selected) return;
			if (this.isWriteAction(selected)) {
				this.confirmation = { kind: "action", action: selected };
				this.confirmCursor = 0;
				this.tui.requestRender();
			} else void this.runAction(selected);
		}
	}

	private handleImportsInput(data: string): void {
		const imports = this.discovery.imports;
		if (this.keys.selectUp(data)) {
			this.importCursor = Math.max(0, this.importCursor - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectDown(data)) {
			this.importCursor = Math.min(imports.length - 1, this.importCursor + 1);
			this.tui.requestRender();
			return;
		}
		if (imports.length > this.pageRows && this.keys.selectPageUp(data)) {
			this.importCursor = Math.max(0, this.importCursor - this.pageRows);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "space")) {
			const current = imports[this.importCursor];
			if (!current) return;
			if (this.selectedImports.has(current.kind)) {
				this.selectedImports.delete(current.kind);
			} else {
				this.selectedImports.add(current.kind);
			}
			this.tui.requestRender();
			return;
		}
		if (imports.length > this.pageRows && this.keys.selectPageDown(data)) {
			this.importCursor = Math.min(imports.length - 1, this.importCursor + this.pageRows);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
			this.importCursor = matchesKey(data, Key.home) ? 0 : Math.max(0, imports.length - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectConfirm(data)) {
			const selected = this.discovery.imports.filter((entry) => this.selectedImports.has(entry.kind));
			if (selected.length === 0) {
				this.notice = { text: "Select at least one compatibility import first.", tone: "warning" };
				this.tui.requestRender();
				return;
			}
			this.confirmation = { kind: "imports" };
			this.confirmCursor = 0;
			this.tui.requestRender();
		}
	}

	private handleConfirmationInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			(this.options.keybindings && matchesCommandDialogCancel(data, this.options.keybindings))
		) {
			this.confirmation = null;
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectUp(data)) {
			this.confirmCursor = 0;
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectDown(data)) {
			this.confirmCursor = 1;
			this.tui.requestRender();
			return;
		}
		if (!this.keys.selectConfirm(data)) return;
		const pending = this.confirmation;
		this.confirmation = null;
		if (!pending) return;
		if (this.confirmCursor === 0) {
			this.tui.requestRender();
			return;
		}
		if (pending.kind === "imports") void this.applySelectedImports();
		else void this.runAction(pending.action);
	}

	private isWriteAction(action: Action): boolean {
		return action.id === "scaffold-project" || action.id === "add-repoprompt" || action.id === "add-known-server";
	}

	private handlePathsInput(data: string): void {
		const paths = this.getDetectedPaths();
		if (this.keys.selectUp(data)) {
			this.pathCursor = Math.max(0, this.pathCursor - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectDown(data)) {
			this.pathCursor = Math.min(paths.length - 1, this.pathCursor + 1);
			this.tui.requestRender();
			return;
		}
		if (paths.length > this.pageRows && this.keys.selectPageUp(data)) {
			this.pathCursor = Math.max(0, this.pathCursor - this.pageRows);
			this.tui.requestRender();
			return;
		}
		if (paths.length > this.pageRows && this.keys.selectPageDown(data)) {
			this.pathCursor = Math.min(paths.length - 1, this.pathCursor + this.pageRows);
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, Key.home) || matchesKey(data, Key.end)) {
			this.pathCursor = matchesKey(data, Key.home) ? 0 : Math.max(0, paths.length - 1);
			this.tui.requestRender();
			return;
		}
		if (this.keys.selectConfirm(data)) {
			const selected = paths[this.pathCursor];
			if (!selected) return;
			void this.runBusy(async () => {
				await this.callbacks.openPath(selected);
				this.notice = { text: `Opened ${selected}`, tone: "success" };
			}, true);
		}
	}

	private async runAction(action: Action): Promise<void> {
		if (action.id === "run-setup") {
			this.screen = "setup";
			this.actionCursor = 0;
			this.tui.requestRender();
			return;
		}
		if (action.id === "adopt-imports") {
			this.screen = "imports";
			this.importCursor = 0;
			this.tui.requestRender();
			return;
		}
		if (action.id === "open-paths") {
			this.screen = "paths";
			this.pathCursor = 0;
			this.tui.requestRender();
			return;
		}
		if (action.id === "scaffold-project") {
			await this.runBusy(async () => {
				const result = await this.callbacks.scaffoldProjectConfig();
				await this.callbacks.markSetupCompleted();
				this.notice = {
					text: `Wrote starter config to ${result.path}. Pi will reload after this panel closes.`,
					tone: "success",
				};
			});
			return;
		}
		if (action.id === "add-repoprompt") {
			await this.runBusy(async () => {
				const result = await this.callbacks.addRepoPrompt();
				await this.callbacks.markSetupCompleted();
				this.notice = {
					text: `Added ${result.serverName} to ${result.path}. Pi will reload after this panel closes.`,
					tone: "success",
				};
			});
			return;
		}
		if (action.id === "add-known-server" && action.preset) {
			const preset = action.preset;
			await this.runBusy(async () => {
				const result = await this.callbacks.addKnownServer(preset);
				await this.callbacks.markSetupCompleted();
				this.notice = {
					text: `Added ${result.serverName} to ${result.path}. Pi will reload after this panel closes.`,
					tone: "success",
				};
			});
			return;
		}
		this.notice = {
			text: "Review the details below. Press Enter on an action with a side effect to apply it.",
			tone: "muted",
		};
		this.tui.requestRender();
	}

	private async applySelectedImports(): Promise<void> {
		const selected = this.discovery.imports
			.filter((entry) => this.selectedImports.has(entry.kind))
			.map((entry) => entry.kind);
		if (selected.length === 0) {
			this.notice = { text: "Select at least one compatibility import first.", tone: "warning" };
			this.tui.requestRender();
			return;
		}

		await this.runBusy(async () => {
			const result = await this.callbacks.adoptImports(selected);
			await this.callbacks.markSetupCompleted();
			this.notice =
				result.added.length > 0
					? {
							text: `Added ${result.added.join(", ")} to ${result.path}. Pi will reload after this panel closes.`,
							tone: "success",
						}
					: { text: `No changes needed in ${result.path}.`, tone: "muted" };
			this.screen = this.discovery.hasAnyConfig ? "setup" : "empty";
			this.actionCursor = 0;
		});
	}

	private async runBusy(fn: () => Promise<void>, canClose = false): Promise<void> {
		this.busy = true;
		this.busyCanClose = canClose;
		this.cleanup();
		this.notice = { text: "Working...", tone: "muted" };
		this.tui.requestRender();
		try {
			await fn();
		} catch (error) {
			this.notice = {
				text: redactTraceText(formatTerminalError(error), 240),
				tone: "warning",
			};
		} finally {
			this.busy = false;
			this.busyCanClose = false;
			if (!this.disposed) {
				this.resetInactivityTimeout();
				this.tui.requestRender();
			}
		}
	}

	render(width: number): string[] {
		const rendered = renderMcpSetupPanel(
			{
				actionCursor: this.actionCursor,
				actions: this.getActions(),
				busy: this.busy,
				callbacks: this.callbacks,
				confirmation: this.confirmation,
				confirmCursor: this.confirmCursor,
				discovery: this.discovery,
				importCursor: this.importCursor,
				keybindings: this.options.keybindings,
				maximumRows: this.maximumRows(),
				notice: this.notice,
				onboardingState: this.options.onboardingState,
				pathCursor: this.pathCursor,
				paths: this.getDetectedPaths(),
				screen: this.screen,
				selectedImports: this.selectedImports,
				theme: this.theme,
			},
			width,
		);
		this.pageRows = rendered.pageRows;
		return rendered.lines;
	}

	private maximumRows(): number {
		const rows = this.tui.terminal?.rows;
		return isRuntimeNumber(rows) && Number.isFinite(rows) ? Math.max(1, Math.floor(rows) - 3) : 21;
	}

	invalidate(): void {}

	dispose(): void {
		this.disposed = true;
		this.cleanup();
	}
}

export const createMcpSetupPanel = (
	discovery: McpDiscoverySummary,
	callbacks: SetupPanelCallbacks,
	options: SetupPanelOptions,
	tui: SetupTui,
	theme: Theme,
	done: () => void,
) => new McpSetupPanel(discovery, callbacks, options, tui, theme, done);
