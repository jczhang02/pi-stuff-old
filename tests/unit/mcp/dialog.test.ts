import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Keybinding, KeybindingsManager, type KeyId, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { createMcpControlView } from "../../../packages/pi-stuff/src/mcp/mcp-dialog.js";
import { McpStatusStore } from "../../../packages/pi-stuff/src/mcp/status-store.js";
import { TestTui } from "../../fixtures/test-tui.js";

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

class ExplicitTestKeybindings extends KeybindingsManager {
	constructor() {
		super(TUI_KEYBINDINGS);
	}

	getEffectiveConfig(): Record<string, never> {
		return {};
	}

	override getKeys(_keybinding: Keybinding): KeyId[] {
		return [];
	}

	override matches(data: string, binding: Keybinding): boolean {
		return (
			(data === "confirm" && binding === "tui.select.confirm") || (data === "down" && binding === "tui.select.down")
		);
	}

	reload(): void {}
}

test("renders live status as a full-width bounded surface", () => {
	const store = new McpStatusStore();
	store.set({
		connectedCount: 1,
		disabledCount: 1,
		servers: [
			{
				disabled: false,
				name: "本地-文件🧪-e\u0301-with-a-very-long-name",
				resourceCount: 1,
				status: "connected",
				toolCount: 8,
			},
			{ disabled: true, name: "remote", status: "disabled", toolCount: 0 },
		],
		totalResources: 1,
		totalTools: 8,
		version: 1,
	});
	let closed = 0;
	const terminal = new TestTui(20);
	const component = createMcpControlView(store, {
		authenticate: async () => true,
		logout: async () => true,
		reconnect: async () => true,
	}).create({
		close: () => {
			closed += 1;
		},
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		tui: terminal,
	});
	const lines = component.render(36);
	const wide = component.render(100).join("\n");

	expect(lines[0]).toBe("━".repeat(36));
	expect(lines.join("\n")).toContain("MCP · 1/1 connected · 8 tools");
	expect(lines.join("\n")).toContain("本地-文件");
	expect(wide).toContain("🧪-e\u0301");
	expect(lines.join("\n")).toContain("✓");
	expect(wide).toContain("1 resource");
	expect(lines.join("\n")).toContain("■");
	expect(lines.join("\n")).not.toMatch(/[╭╮╰╯]/u);
	expect(lines.every((line) => visibleWidth(line) <= 36)).toBe(true);
	component.handleInput?.(" ");
	expect(closed).toBe(0);
	component.handleInput?.("?");
	expect(component.render(36).join("\n")).toContain("MCP / Keys");
	component.handleInput?.("\u001b");
	expect(closed).toBe(0);
	terminal.rows = 6;
	const low = component.render(36);
	expect(low).toHaveLength(3);
	expect(low.join("\n")).toContain("MCP");
	expect(low.join("\n")).toContain("本地-文件");
	expect(low.at(-1)).toContain("Esc close");
	component.handleInput?.("\u001b");
	expect(closed).toBe(1);
	component.dispose?.();
});

test("uses the shared list aliases without turning Space into a server toggle", () => {
	const store = new McpStatusStore();
	store.set({
		connectedCount: 0,
		disabledCount: 0,
		servers: Array.from({ length: 12 }, (_, index) => ({
			disabled: false,
			name: `server-${String(index)}`,
			status: "not-connected" as const,
			toolCount: 0,
		})),
		totalResources: 0,
		totalTools: 0,
		version: 1,
	});
	let result: unknown;
	const component = createMcpControlView(store, {
		authenticate: async () => true,
		logout: async () => true,
		reconnect: async () => true,
	}).create({
		close: (value) => {
			result = value;
		},
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		tui: new TestTui(10),
	});

	const overflow = component.render(64).join("\n");
	expect(overflow).toContain("b/Space page");
	expect(overflow).not.toContain("PgUp/PgDn page");
	component.handleInput?.(" ");
	expect(component.render(64).join("\n")).toContain("› ○ server-3");
	expect(result).toBeUndefined();
	component.handleInput?.("\u001b[F");
	expect(component.render(64).join("\n")).toContain("› ○ server-11");
	component.handleInput?.("\u0010");
	expect(component.render(64).join("\n")).toContain("› ○ server-10");
	component.handleInput?.("b");
	expect(component.render(64).join("\n")).toContain("› ○ server-7");
	component.handleInput?.("\u001b[H");
	expect(component.render(64).join("\n")).toContain("› ○ server-0");
	component.dispose?.();
});

test("keeps structural selection ahead of server-name glyph collisions at normal and low heights", () => {
	const store = new McpStatusStore();
	store.set({
		connectedCount: 0,
		disabledCount: 0,
		servers: [
			{ disabled: false, name: "decoy ! attention › ◆ Preview", status: "not-connected", toolCount: 0 },
			{ disabled: false, name: "actual-selection", status: "not-connected", toolCount: 0 },
		],
		totalResources: 0,
		totalTools: 0,
		version: 1,
	});
	const terminal = new TestTui(20);
	const component = createMcpControlView(store, {
		authenticate: async () => true,
		logout: async () => true,
		reconnect: async () => true,
	}).create({
		close: () => undefined,
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		tui: terminal,
	});

	component.handleInput?.("\u001b[B");
	const normal = component.render(64).join("\n");
	expect(normal).toContain("decoy ! attention › ◆ Preview");
	expect(normal).toContain("› ○ actual-selection");
	terminal.rows = 6;
	const low = component.render(64).join("\n");
	expect(low).toContain("actual-selection");
	expect(low).not.toContain("decoy ! attention › ◆ Preview");
	component.dispose?.();
});

test("colors inline action notices from semantic outcomes instead of server prose", async () => {
	const store = new McpStatusStore();
	store.set({
		connectedCount: 0,
		disabledCount: 0,
		servers: [{ disabled: false, name: "failed-proxy", status: "not-connected", toolCount: 0 }],
		totalResources: 0,
		totalTools: 0,
		version: 1,
	});
	let succeeds = true;
	// SAFETY: this test theme implements the exact Host color methods exercised by the MCP Dialog.
	const semanticTheme = {
		bold: (value: string) => value,
		fg: (color: string, value: string) => `[${color}]${value}`,
	} as Theme;
	const terminal = new TestTui(20);
	const component = createMcpControlView(store, {
		authenticate: async () => true,
		logout: async () => true,
		reconnect: async () => succeeds,
	}).create({
		close: () => undefined,
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme: semanticTheme,
		tui: terminal,
	});

	component.handleInput?.("\r");
	component.handleInput?.("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(component.render(72).join("\n")).toContain("[success]Reconnected failed-proxy.");
	terminal.rows = 6;
	expect(component.render(72).join("\n")).toContain("[success]Reconnected failed-proxy.");
	succeeds = false;
	component.handleInput?.("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(component.render(72).join("\n")).toContain("[error]Reconnect failed for failed-proxy.");
	component.dispose?.();
});

test("lets a user inspect a server and reconnect without knowing a subcommand", async () => {
	const store = new McpStatusStore();
	store.set({
		connectedCount: 0,
		disabledCount: 0,
		servers: [{ disabled: false, name: "local", status: "not-connected", toolCount: 0 }],
		totalResources: 0,
		totalTools: 0,
		version: 1,
	});
	const reconnected: string[] = [];
	const component = createMcpControlView(store, {
		authenticate: async () => true,
		logout: async () => true,
		reconnect: async (server) => {
			reconnected.push(server);
			return true;
		},
	}).create({
		close: () => undefined,
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		tui: new TestTui(20),
	});

	expect(component.render(64).join("\n")).toContain("Enter manage");
	component.handleInput?.("\x12");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(reconnected).toEqual(["local"]);
	component.handleInput?.("\r");
	expect(component.render(64).join("\n")).toContain("MCP / local");
	component.handleInput?.("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(reconnected).toEqual(["local", "local"]);
	component.dispose?.();
});

test("keeps Space harmless and requires an explicit confirmation before disabling", () => {
	const store = new McpStatusStore();
	store.set({
		connectedCount: 1,
		disabledCount: 0,
		servers: [{ disabled: false, name: "local", oauth: true, status: "connected", toolCount: 1 }],
		totalResources: 0,
		totalTools: 1,
		version: 1,
	});
	let result: unknown;
	const component = createMcpControlView(store, {
		authenticate: async () => true,
		logout: async () => true,
		reconnect: async () => true,
	}).create({
		close: (value) => {
			result = value;
		},
		keybindings: new ExplicitTestKeybindings(),
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		tui: new TestTui(24),
	});

	component.handleInput?.(" ");
	expect(result).toBeUndefined();
	component.handleInput?.("confirm");
	const actions = component.render(72).join("\n");
	expect(actions).toContain("Authenticate");
	expect(actions).toContain("Log out");
	expect(actions).toContain("Disable");
	component.handleInput?.("down");
	component.handleInput?.("down");
	component.handleInput?.("down");
	component.handleInput?.("down");
	component.handleInput?.("confirm");
	const disableConfirmation = component.render(72).join("\n");
	expect(disableConfirmation).toContain("Disable local?");
	expect(disableConfirmation).toContain("Preview");
	expect(disableConfirmation).not.toContain("◆ Preview");
	expect(disableConfirmation).toContain("Target  .pi/mcp.json");
	expect(disableConfirmation).toContain("Change  disabled = true");
	component.handleInput?.("confirm");
	expect(result).toBeUndefined();
	component.handleInput?.("confirm");
	component.handleInput?.("down");
	component.handleInput?.("confirm");
	expect(result).toEqual({ action: "set-disabled", disabled: true, server: "local" });
	component.dispose?.();
});

test("confirms and returns a persistent automatic-connection choice", () => {
	const store = new McpStatusStore();
	store.set({
		connectedCount: 0,
		disabledCount: 0,
		servers: [{ disabled: false, name: "docs", status: "cached", toolCount: 4 }],
		totalResources: 0,
		totalTools: 4,
		version: 1,
	});
	let result: unknown;
	const component = createMcpControlView(store, {
		authenticate: async () => true,
		logout: async () => true,
		reconnect: async () => true,
	}).create({
		close: (value) => {
			result = value;
		},
		keybindings: new ExplicitTestKeybindings(),
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		tui: new TestTui(24),
	});

	component.handleInput?.("confirm");
	expect(component.render(72).join("\n")).toContain("Connection  on demand");
	component.handleInput?.("down");
	component.handleInput?.("confirm");
	const confirmation = component.render(72).join("\n");
	expect(confirmation).toContain("Confirm change");
	expect(confirmation).toContain("Preview");
	expect(confirmation).not.toContain("◆ Confirm change");
	expect(confirmation).toContain("Change  lifecycle = keep-alive");
	expect(confirmation).toContain("Connect docs automatically?");
	expect(confirmation).toContain("› Cancel");
	component.handleInput?.("down");
	component.handleInput?.("confirm");
	expect(result).toEqual({ action: "set-auto-connect", enabled: true, server: "docs" });
	component.dispose?.();
});

test("shows a bounded failure reason without claiming reconnect success", async () => {
	const store = new McpStatusStore();
	store.set({
		connectedCount: 0,
		disabledCount: 0,
		servers: [
			{
				disabled: false,
				failureDetail: "Executable was not found.",
				name: "broken",
				status: "failed",
				toolCount: 0,
			},
		],
		totalResources: 0,
		totalTools: 0,
		version: 1,
	});
	const component = createMcpControlView(store, {
		authenticate: async () => true,
		logout: async () => true,
		reconnect: async () => {
			store.set({
				connectedCount: 0,
				disabledCount: 0,
				servers: [
					{
						disabled: false,
						failureDetail: "Executable was not found.",
						name: "broken",
						status: "failed",
						toolCount: 0,
					},
				],
				totalResources: 0,
				totalTools: 0,
				version: 1,
			});
			return false;
		},
	}).create({
		close: () => undefined,
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		tui: new TestTui(20),
	});

	component.handleInput?.("\r");
	const detail = component.render(64).join("\n");
	expect(detail).toContain("Executable was not found.");
	expect(detail).toContain("Reconnect");
	component.handleInput?.("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const failed = component.render(64).join("\n");
	expect(failed).toContain("Reconnect failed for broken. See /diagnostics for details.");
	expect(failed).not.toContain("Reconnected broken.");
	component.dispose?.();
});

test("invalidates stale actions and confirmations when live status changes", () => {
	const store = new McpStatusStore();
	const snapshot = (name: string, disabled: boolean) => ({
		connectedCount: 0,
		disabledCount: disabled ? 1 : 0,
		servers: [
			{ disabled, name, status: disabled ? ("disabled" as const) : ("not-connected" as const), toolCount: 0 },
		],
		totalResources: 0,
		totalTools: 0,
		version: 1 as const,
	});
	store.set(snapshot("local", false));
	let result: unknown;
	const component = createMcpControlView(store, {
		authenticate: async () => true,
		logout: async () => true,
		reconnect: async () => true,
	}).create({
		close: (value) => {
			result = value;
		},
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		tui: new TestTui(20),
	});

	component.handleInput?.("\r");
	component.handleInput?.("\u001b[B");
	component.handleInput?.("\u001b[B");
	store.set(snapshot("local", true));
	expect(component.render(64).join("\n")).toContain("› Enable");
	component.handleInput?.("\r");
	expect(component.render(64).join("\n")).toContain("Enable local?");
	store.set(snapshot("replacement", false));
	const refreshed = component.render(64).join("\n");
	expect(refreshed).toContain("replacement");
	expect(refreshed).not.toContain("Enable local?");
	component.handleInput?.("\r");
	expect(result).toBeUndefined();
	component.dispose?.();
});

test("reports OAuth authentication and logout failures at their owning actions", async () => {
	const store = new McpStatusStore();
	store.set({
		connectedCount: 0,
		disabledCount: 0,
		servers: [{ disabled: false, name: "oauth-server", oauth: true, status: "needs-auth", toolCount: 0 }],
		totalResources: 0,
		totalTools: 0,
		version: 1,
	});
	const authenticated: string[] = [];
	const loggedOut: string[] = [];
	const component = createMcpControlView(store, {
		authenticate: async (server) => {
			authenticated.push(server);
			throw new Error("token=SECRET\u001b]8;;https://malicious.invalid\u0007link");
		},
		logout: async (server) => {
			loggedOut.push(server);
			return false;
		},
		reconnect: async () => true,
	}).create({
		close: () => undefined,
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		tui: new TestTui(20),
	});

	const list = component.render(64).join("\n");
	expect(list).toContain("MCP");
	expect(list).toContain("oauth-server");
	component.handleInput?.("\r");
	const actions = component.render(64).join("\n");
	expect(actions).toContain("Authenticate");
	expect(actions).toContain("Disable");
	component.handleInput?.("\u001b[B");
	component.handleInput?.("\u001b[B");
	component.handleInput?.("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(authenticated).toEqual(["oauth-server"]);
	const failed = component.render(64).join("\n");
	expect(failed).toContain("Authentication failed for oauth-server.");
	expect(failed).not.toContain("SECRET");
	expect(failed).not.toContain("malicious.invalid");
	store.set({
		connectedCount: 1,
		disabledCount: 0,
		servers: [{ disabled: false, name: "oauth-server", oauth: true, status: "connected", toolCount: 1 }],
		totalResources: 0,
		totalTools: 1,
		version: 1,
	});
	component.handleInput?.("\u001b[B");
	component.handleInput?.("\r");
	component.handleInput?.("\u001b[B");
	component.handleInput?.("\r");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(loggedOut).toEqual(["oauth-server"]);
	expect(component.render(64).join("\n")).toContain("Logout failed for oauth-server.");
	component.dispose?.();
});

test("makes Setup discoverable from the server list", () => {
	const store = new McpStatusStore();
	store.set({
		connectedCount: 0,
		disabledCount: 0,
		servers: [{ disabled: false, name: "local", status: "not-connected", toolCount: 0 }],
		totalResources: 0,
		totalTools: 0,
		version: 1,
	});
	let result: unknown;
	const component = createMcpControlView(store, {
		authenticate: async () => true,
		logout: async () => true,
		reconnect: async () => true,
	}).create({
		close: (value) => {
			result = value;
		},
		keybindings: new KeybindingsManager(TUI_KEYBINDINGS),
		requestRender: () => undefined,
		signal: new AbortController().signal,
		theme,
		tui: new TestTui(20),
	});

	expect(component.render(64).join("\n")).toContain("s setup");
	expect(component.render(64).join("\n")).not.toContain("b/Space page");
	component.handleInput?.("?");
	const help = component.render(64).join("\n");
	expect(help).toMatch(/\bs\s+Open MCP setup/u);
	expect(help).not.toMatch(/\bS\s+Open MCP setup/u);
	component.handleInput?.("\u001b");
	component.handleInput?.("s");
	expect(result).toEqual({ action: "setup" });
	component.dispose?.();
});
