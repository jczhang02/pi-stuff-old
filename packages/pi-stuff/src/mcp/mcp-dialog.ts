import { isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import {
	type CommandDialogComponent,
	type CommandDialogKeyHelpEntry,
	type CommandDialogView,
	type CommandDialogViewContext,
	commandDialogHintLines,
	commandDialogListIndex,
	commandDialogListKeyHelp,
	commandDialogNavigation,
	commandDialogPrimaryKey,
	commandDialogReadKeyHelp,
	commandDialogReadOnlyPageHint,
	commandDialogRows,
	commandDialogSectionHeading,
	fitCommandDialogRows,
	matchesCommandDialogCancel,
	matchesCommandDialogConfirm,
	matchesCommandDialogHelp,
	renderCommandDialogKeyHelp,
} from "../conversation-ui/index.ts";
import { type McpDialogRows, mcpDialogPriority } from "./mcp-dialog-rows.ts";
import type { McpServerStatusSnapshot, McpStatusSnapshot } from "./runtime/index.js";
import type { McpStatusStore } from "./status-store.ts";

const GUTTER = "  ";

export interface McpControlActions {
	authenticate(server: string): Promise<boolean>;
	logout(server: string): Promise<boolean>;
	reconnect(server: string): Promise<boolean>;
}

export type McpControlResult =
	| { readonly action: "setup" }
	| { readonly action: "set-disabled"; readonly disabled: boolean; readonly server: string }
	| { readonly action: "set-auto-connect"; readonly enabled: boolean; readonly server: string };

type ServerAction = "authenticate" | "auto-connect" | "disable" | "enable" | "logout" | "on-demand" | "reconnect";

interface Confirmation {
	readonly action: "logout" | "set-auto-connect" | "set-disabled";
	readonly server: string;
	readonly disabled?: boolean;
	readonly enabled?: boolean;
}

function statusLabel(server: McpServerStatusSnapshot): string {
	switch (server.status) {
		case "connected":
			return "connected";
		case "cached":
			return "cached";
		case "failed":
			return server.failedAgoSeconds === undefined ? "failed" : `failed ${String(server.failedAgoSeconds)}s ago`;
		case "needs-auth":
			return "needs auth";
		case "disabled":
			return "disabled";
		case "not-connected":
			return "not connected";
	}
}

function serverLine(
	context: Pick<CommandDialogViewContext<unknown>, "theme">,
	server: McpServerStatusSnapshot,
	selected: boolean,
): string {
	const { theme } = context;
	const marker =
		server.status === "connected"
			? theme.fg("success", "✓")
			: server.status === "failed"
				? theme.fg("error", "×")
				: server.status === "needs-auth"
					? theme.fg("warning", "!")
					: server.status === "disabled"
						? theme.fg("dim", "■")
						: theme.fg("dim", "○");
	const name = theme.fg(server.status === "connected" ? "text" : "muted", server.name);
	const statusColor = server.status === "failed" ? "error" : server.status === "needs-auth" ? "warning" : "muted";
	const status = theme.fg(statusColor, statusLabel(server));
	const counts = server.disabled
		? ""
		: [
				...(server.toolCount > 0 ? [`${String(server.toolCount)} tool${server.toolCount === 1 ? "" : "s"}`] : []),
				...(server.resourceCount && server.resourceCount > 0
					? [`${String(server.resourceCount)} resource${server.resourceCount === 1 ? "" : "s"}`]
					: []),
			].join(" · ");
	return `${GUTTER}${selected ? theme.fg("accent", "›") : " "} ${marker} ${name} ${theme.fg("dim", "·")} ${status}${counts ? theme.fg("dim", ` · ${counts}`) : ""}`;
}

function headerLine(
	context: Pick<CommandDialogViewContext<unknown>, "theme">,
	snapshot: McpStatusSnapshot | undefined,
): string {
	if (!snapshot) return `${GUTTER}${context.theme.bold("MCP")} ${context.theme.fg("muted", "· initializing")}`;
	const enabled = Math.max(0, snapshot.servers.length - snapshot.disabledCount);
	const resources =
		snapshot.totalResources > 0
			? ` · ${String(snapshot.totalResources)} resource${snapshot.totalResources === 1 ? "" : "s"}`
			: "";
	return `${GUTTER}${context.theme.bold("MCP")} ${context.theme.fg(
		"muted",
		`· ${String(snapshot.connectedCount)}/${String(enabled)} connected · ${String(snapshot.totalTools)} tool${snapshot.totalTools === 1 ? "" : "s"}${resources}`,
	)}`;
}

class McpControlDialog implements CommandDialogComponent {
	private readonly actions: McpControlActions;
	private actionCursor = 0;
	private busy = false;
	private confirmation: Confirmation | undefined;
	private confirmCursor = 0;
	private readonly context: CommandDialogViewContext<McpControlResult>;
	private disposed = false;
	private lastViewportRows = 1;
	private notice: { readonly text: string; readonly tone: "error" | "success" | "warning" } | undefined;
	private screen: "servers" | "actions" = "servers";
	private selectedServer = 0;
	private showKeyHelp = false;
	private snapshot: McpStatusSnapshot | undefined;
	private readonly unsubscribe: () => void;

	constructor(context: CommandDialogViewContext<McpControlResult>, store: McpStatusStore, actions: McpControlActions) {
		this.actions = actions;
		this.context = context;
		this.snapshot = store.get();
		this.unsubscribe = store.subscribe((snapshot) => {
			if (this.disposed) return;
			const selectedName = this.currentServer()?.name;
			this.snapshot = snapshot;
			const selectedIndex = selectedName ? this.servers().findIndex((server) => server.name === selectedName) : -1;
			if (selectedIndex >= 0) this.selectedServer = selectedIndex;
			else this.clampSelection();
			const server = this.currentServer();
			if (this.screen === "actions" && (!server || server.name !== selectedName)) {
				this.screen = "servers";
				this.confirmation = undefined;
				this.actionCursor = 0;
			} else if (server) {
				if (this.confirmation && !this.confirmationApplies(this.confirmation, server))
					this.confirmation = undefined;
				this.actionCursor = Math.min(this.actionItems(server).length - 1, Math.max(0, this.actionCursor));
			}
			this.context.requestRender();
		});
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe();
	}

	handleInput(data: string): void {
		if (this.disposed || isKeyRelease(data)) return;
		if (this.busy) {
			if (matchesCommandDialogCancel(data, this.context.keybindings)) this.context.close(undefined);
			return;
		}
		if (this.confirmation) {
			this.handleConfirmationInput(data);
			return;
		}
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
			if (this.screen === "actions") {
				this.screen = "servers";
				this.notice = undefined;
				this.context.requestRender();
			} else this.context.close(undefined);
			return;
		}
		if (this.screen === "servers") this.handleServerInput(data);
		else this.handleActionInput(data);
	}

	invalidate(): void {}

	render(width: number): string[] {
		const renderWidth = Math.max(1, Math.floor(width));
		if (this.showKeyHelp) return renderCommandDialogKeyHelp(this.context, renderWidth, "MCP", this.keyHelp());
		const maximumRows = commandDialogRows(this.context);
		if (maximumRows === 0) return [];
		let footer = this.renderFooter(renderWidth, false);
		if (this.screen === "servers") {
			this.lastViewportRows = Math.max(1, maximumRows - 2 - footer.length);
			footer = this.renderFooter(renderWidth, this.servers().length > this.lastViewportRows);
			this.lastViewportRows = Math.max(1, maximumRows - 2 - footer.length);
			this.clampSelection();
		}
		const header = [
			this.context.theme.fg("border", "━".repeat(renderWidth)),
			this.screen === "servers"
				? headerLine(this.context, this.snapshot)
				: `${GUTTER}${this.context.theme.bold(`MCP / ${this.currentServer()?.name ?? "server"}`)}`,
		];
		const body = this.confirmation
			? this.renderConfirmation()
			: this.screen === "servers"
				? this.renderServers()
				: this.renderActions();
		const priority = mcpDialogPriority(body, [
			"question",
			"failure",
			"notice",
			"selected",
			"preview-heading",
			"preview-detail",
		]);
		if (priority.length === 0) priority.push(body.lines[0] ?? footer[0] ?? "");
		const lines = fitCommandDialogRows(
			{
				header,
				body: body.lines,
				footer,
				priority,
			},
			maximumRows,
		);
		return lines.map((line) => truncateToWidth(line, renderWidth, "…"));
	}

	private handleServerInput(data: string): void {
		const servers = this.servers();
		if (data === "s" || data === "S") {
			this.context.close({ action: "setup" });
			return;
		}
		if (matchesKey(data, "ctrl+r")) {
			const server = this.currentServer();
			if (server && !server.disabled) this.runInline("reconnect", server.name);
			return;
		}
		if (matchesKey(data, "ctrl+a")) {
			const server = this.currentServer();
			if (server?.oauth && !server.disabled) this.runInline("authenticate", server.name);
			return;
		}
		if (matchesCommandDialogConfirm(data, this.context.keybindings)) {
			if (servers.length === 0) this.context.close({ action: "setup" });
			else {
				this.screen = "actions";
				this.actionCursor = 0;
				this.notice = undefined;
				this.context.requestRender();
			}
			return;
		}
		const navigation = commandDialogNavigation(data, this.context.keybindings);
		if (!navigation) return;
		if ((navigation === "pageUp" || navigation === "pageDown") && servers.length <= this.lastViewportRows) return;
		this.selectedServer = commandDialogListIndex(
			this.selectedServer,
			servers.length,
			this.lastViewportRows,
			navigation,
		);
		this.context.requestRender();
	}

	private handleActionInput(data: string): void {
		const server = this.currentServer();
		if (!server) return;
		const actions = this.actionItems(server);
		if (matchesKey(data, "ctrl+r") && !server.disabled) {
			this.runInline("reconnect", server.name);
			return;
		}
		if (matchesKey(data, "ctrl+a") && server.oauth && !server.disabled) {
			this.runInline("authenticate", server.name);
			return;
		}
		if (matchesCommandDialogConfirm(data, this.context.keybindings)) {
			const action = actions[this.actionCursor];
			if (action === "reconnect" || action === "authenticate") this.runInline(action, server.name);
			else if (action === "logout") this.beginConfirmation({ action: "logout", server: server.name });
			else if (action === "disable" || action === "enable") {
				this.beginConfirmation({
					action: "set-disabled",
					disabled: action === "disable",
					server: server.name,
				});
			} else if (action === "auto-connect" || action === "on-demand") {
				this.beginConfirmation({
					action: "set-auto-connect",
					enabled: action === "auto-connect",
					server: server.name,
				});
			}
			return;
		}
		const navigation = commandDialogNavigation(data, this.context.keybindings);
		if (!navigation) return;
		this.actionCursor = commandDialogListIndex(
			this.actionCursor,
			actions.length,
			Math.max(1, actions.length),
			navigation,
		);
		this.context.requestRender();
	}

	private handleConfirmationInput(data: string): void {
		if (matchesCommandDialogCancel(data, this.context.keybindings)) {
			this.confirmation = undefined;
			this.context.requestRender();
			return;
		}
		if (this.context.keybindings.matches(data, "tui.select.up")) this.confirmCursor = 0;
		else if (this.context.keybindings.matches(data, "tui.select.down")) this.confirmCursor = 1;
		else if (matchesCommandDialogConfirm(data, this.context.keybindings)) {
			const confirmation = this.confirmation;
			this.confirmation = undefined;
			if (!confirmation) return;
			if (this.confirmCursor === 0) {
				this.context.requestRender();
				return;
			}
			if (confirmation.action === "logout") this.runInline("logout", confirmation.server);
			else if (confirmation.action === "set-disabled") {
				this.context.close({
					action: "set-disabled",
					disabled: confirmation.disabled === true,
					server: confirmation.server,
				});
			} else {
				this.context.close({
					action: "set-auto-connect",
					enabled: confirmation.enabled === true,
					server: confirmation.server,
				});
			}
			return;
		} else return;
		this.context.requestRender();
	}

	private beginConfirmation(confirmation: Confirmation): void {
		this.confirmation = confirmation;
		this.confirmCursor = 0;
		this.context.requestRender();
	}

	private runInline(action: "authenticate" | "logout" | "reconnect", server: string): void {
		this.busy = true;
		const verb =
			action === "authenticate" ? "Authenticating" : action === "logout" ? "Logging out of" : "Reconnecting";
		const failure =
			action === "authenticate"
				? `Authentication failed for ${server}.`
				: action === "logout"
					? `Logout failed for ${server}.`
					: `Reconnect failed for ${server}. See /diagnostics for details.`;
		this.notice = { text: `${verb} ${server}…`, tone: "warning" };
		this.context.requestRender();
		void this.actions[action](server)
			.then((succeeded) => {
				if (this.disposed) return;
				if (!succeeded) this.notice = { text: failure, tone: "error" };
				else if (action === "logout") this.notice = { text: `Logged out of ${server}.`, tone: "success" };
				else if (action === "authenticate") this.notice = { text: `Authenticated ${server}.`, tone: "success" };
				else this.notice = { text: `Reconnected ${server}.`, tone: "success" };
			})
			.catch(() => {
				if (!this.disposed) this.notice = { text: failure, tone: "error" };
			})
			.finally(() => {
				if (this.disposed) return;
				this.busy = false;
				this.context.requestRender();
			});
	}

	private renderServers(): McpDialogRows {
		const servers = this.servers();
		if (servers.length === 0) {
			return {
				lines: [
					`${GUTTER}${this.context.theme.fg("muted", "No MCP servers configured.")}`,
					`${GUTTER}${this.context.theme.fg("text", "Press Enter to set up your first server.")}`,
				],
				roles: {},
			};
		}
		const window = this.serverWindow();
		const lines = window.map((server) => serverLine(this.context, server, server === this.currentServer()));
		const selected = this.currentServer();
		const selectedLine = selected ? lines[window.indexOf(selected)] : undefined;
		return { lines, roles: selectedLine ? { selected: selectedLine } : {} };
	}

	private renderActions(): McpDialogRows {
		const server = this.currentServer();
		if (!server) return { lines: [], roles: {} };
		const roles: McpDialogRows["roles"] = {};
		const lines = [
			`${GUTTER}${this.context.theme.fg("muted", `State  ${statusLabel(server)}`)}`,
			`${GUTTER}${this.context.theme.fg("muted", `Connection  ${server.autoConnect ? "automatic" : "on demand"}`)}`,
		];
		if (server.failureDetail) {
			const failureLine = `${GUTTER}${this.context.theme.fg("error", server.failureDetail)}`;
			lines.push("", commandDialogSectionHeading(this.context.theme, "Error"), failureLine);
			roles.failure = failureLine;
		}
		if (this.notice) {
			const noticeLine = `${GUTTER}${this.context.theme.fg(this.notice.tone, this.notice.text)}`;
			lines.push(noticeLine);
			roles.notice = noticeLine;
		}
		lines.push("", commandDialogSectionHeading(this.context.theme, "Actions"));
		for (const [index, action] of this.actionItems(server).entries()) {
			const line = `${GUTTER}${index === this.actionCursor ? this.context.theme.fg("accent", "› ") : "  "}${this.actionLabel(action)}`;
			lines.push(line);
			if (index === this.actionCursor) roles.selected = line;
		}
		return { lines, roles };
	}

	private renderConfirmation(): McpDialogRows {
		const confirmation = this.confirmation;
		if (!confirmation) return { lines: [], roles: {} };
		const logout = confirmation.action === "logout";
		const connection = confirmation.action === "set-auto-connect";
		const verb = confirmation.disabled ? "Disable" : "Enable";
		const question = logout
			? `Log out of ${confirmation.server}?`
			: connection
				? `Connect ${confirmation.server} ${confirmation.enabled ? "automatically" : "on demand"}?`
				: `${verb} ${confirmation.server}?`;
		const preview = connection
			? `Change  lifecycle = ${confirmation.enabled ? "keep-alive" : "lazy"}`
			: confirmation.disabled
				? "Change  disabled = true"
				: "Change  remove disabled override; preserve enabled state";
		const headingLine = commandDialogSectionHeading(this.context.theme, "Confirm change");
		const questionLine = `${GUTTER}${this.context.theme.fg("warning", `! ${question}`)}`;
		const previewHeading = commandDialogSectionHeading(this.context.theme, "Preview");
		const previewDetail = `${GUTTER}${this.context.theme.fg("muted", "Target  .pi/mcp.json")}`;
		const cancelLine = `${GUTTER}${this.confirmCursor === 0 ? this.context.theme.fg("accent", "› ") : "  "}Cancel`;
		const confirmLine = `${GUTTER}${this.confirmCursor === 1 ? this.context.theme.fg("accent", "› ") : "  "}${logout ? "Log out" : connection ? `${confirmation.enabled ? "Automatic" : "On demand"} and reload` : `${verb} and reload`}`;
		const lines = [
			headingLine,
			questionLine,
			...(logout
				? [`${GUTTER}${this.context.theme.fg("muted", "Saved OAuth credentials will be removed.")}`]
				: [previewHeading, previewDetail, `${GUTTER}${this.context.theme.fg("muted", preview)}`]),
			"",
			cancelLine,
			confirmLine,
		];
		const roles: McpDialogRows["roles"] = {
			confirmation: headingLine,
			question: questionLine,
			selected: this.confirmCursor === 0 ? cancelLine : confirmLine,
		};
		if (!logout) {
			roles["preview-heading"] = previewHeading;
			roles["preview-detail"] = previewDetail;
		}
		return {
			lines,
			roles,
		};
	}

	private renderFooter(width: number, overflow: boolean): string[] {
		const up = commandDialogPrimaryKey(this.context.keybindings, "tui.select.up", "↑");
		const down = commandDialogPrimaryKey(this.context.keybindings, "tui.select.down", "↓");
		const confirm = commandDialogPrimaryKey(this.context.keybindings, "tui.select.confirm", "Enter");
		const cancel = commandDialogPrimaryKey(this.context.keybindings, "tui.select.cancel", "Esc");
		if (this.confirmation) {
			return commandDialogHintLines(this.context.theme, width, [
				`${up}/${down} choose`,
				`${confirm} select`,
				`${cancel} back`,
			]);
		}
		const page = commandDialogReadOnlyPageHint(this.screen === "servers" && overflow);
		return commandDialogHintLines(this.context.theme, width, [
			`${up}/${down} navigate`,
			...(page ? [page] : []),
			`${confirm} ${this.screen === "servers" ? "manage" : "run"}`,
			...(this.screen === "servers" ? ["s setup"] : []),
			"? keys",
			`${cancel} ${this.screen === "servers" ? "close" : "back"}`,
		]);
	}

	private keyHelp(): readonly CommandDialogKeyHelpEntry[] {
		if (this.screen === "servers") {
			return commandDialogListKeyHelp(this.context.keybindings, "server", [
				{ keys: "s", description: "Open MCP setup" },
				{ keys: "Ctrl+R", description: "Reconnect selected server" },
				{ keys: "Ctrl+A", description: "Authenticate selected OAuth server" },
			]);
		}
		const confirm = commandDialogPrimaryKey(this.context.keybindings, "tui.select.confirm", "Enter");
		return commandDialogReadKeyHelp(this.context.keybindings, "action", [
			{ keys: confirm, description: "Run selected action" },
			{ keys: "Ctrl+R", description: "Reconnect this server" },
			{ keys: "Ctrl+A", description: "Authenticate this OAuth server" },
		]);
	}

	private actionItems(server: McpServerStatusSnapshot): ServerAction[] {
		if (server.disabled) return ["enable"];
		const actions: ServerAction[] = ["reconnect", server.autoConnect ? "on-demand" : "auto-connect"];
		if (server.oauth) {
			actions.push("authenticate");
			if (server.status !== "needs-auth") actions.push("logout");
		}
		actions.push("disable");
		return actions;
	}

	private confirmationApplies(confirmation: Confirmation, server: McpServerStatusSnapshot): boolean {
		if (confirmation.server !== server.name) return false;
		if (confirmation.action === "logout") return this.actionItems(server).includes("logout");
		if (confirmation.action === "set-disabled") return confirmation.disabled === !server.disabled;
		return confirmation.enabled === !server.autoConnect;
	}

	private actionLabel(action: ServerAction): string {
		switch (action) {
			case "authenticate":
				return "Authenticate";
			case "auto-connect":
				return "Connect automatically";
			case "disable":
				return "Disable";
			case "enable":
				return "Enable";
			case "logout":
				return "Log out";
			case "on-demand":
				return "Connect on demand";
			case "reconnect":
				return "Reconnect";
		}
	}

	private currentServer(): McpServerStatusSnapshot | undefined {
		return this.servers()[this.selectedServer];
	}

	private clampSelection(): void {
		const maximum = Math.max(0, this.servers().length - 1);
		this.selectedServer = Math.min(maximum, Math.max(0, this.selectedServer));
	}

	private serverWindow(): readonly McpServerStatusSnapshot[] {
		const servers = this.servers();
		if (servers.length <= this.lastViewportRows) return servers;
		const start = Math.min(
			servers.length - this.lastViewportRows,
			Math.max(0, this.selectedServer - Math.floor(this.lastViewportRows / 2)),
		);
		return servers.slice(start, start + this.lastViewportRows);
	}

	private servers(): readonly McpServerStatusSnapshot[] {
		return this.snapshot?.servers ?? [];
	}
}

export function createMcpControlView(
	store: McpStatusStore,
	actions: McpControlActions,
): CommandDialogView<McpControlResult> {
	return {
		priority: "normal",
		create: (context) => new McpControlDialog(context, store, actions),
	};
}
