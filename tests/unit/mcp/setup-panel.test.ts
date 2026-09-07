import { expect, test } from "bun:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { McpDiscoverySummary } from "../../../packages/pi-stuff/src/mcp/runtime/config.js";
import {
	createMcpSetupPanel,
	type SetupPanelCallbacks,
} from "../../../packages/pi-stuff/src/mcp/runtime/mcp-setup-panel.js";

const discovery: McpDiscoverySummary = {
	conflicts: [],
	fingerprint: "fixture",
	hasAnyConfig: false,
	hasAnyDetectedPaths: false,
	hasPiOwnedServers: false,
	hasSharedServers: false,
	hostConfigDiscovery: "off",
	hostConfigs: [],
	imports: [],
	repoPrompt: { configured: false },
	sources: [],
	totalServerCount: 0,
};

const preview = {
	afterText: "{}\n",
	beforeText: "",
	changed: true,
	diffText: "+{}",
	existed: false,
	path: "/project/.mcp.json",
};

function callbacks(scaffoldProjectConfig: SetupPanelCallbacks["scaffoldProjectConfig"]): SetupPanelCallbacks {
	return {
		addKnownServer: async () => ({ path: "/project/.mcp.json", serverName: "known" }),
		addRepoPrompt: async () => ({ path: "/project/.mcp.json", serverName: "repoprompt" }),
		adoptImports: async () => ({ added: [], path: "/agent/mcp.json" }),
		markSetupCompleted: async () => undefined,
		openPath: async () => undefined,
		previewImports: () => preview,
		previewKnownServer: () => preview,
		previewRepoPrompt: () => preview,
		previewStarterProject: () => preview,
		scaffoldProjectConfig,
	};
}

function createPanel(
	panelCallbacks: SetupPanelCallbacks,
	rows = 28,
	panelDiscovery = discovery,
	done: () => void = () => undefined,
) {
	return createMcpSetupPanel(
		panelDiscovery,
		panelCallbacks,
		{
			keybindings: {
				getKeys: (binding) => (binding === "tui.select.confirm" ? ["enter"] : []),
				matches: (data, binding) =>
					(data === "confirm" && binding === "tui.select.confirm") ||
					(data === "down" && binding === "tui.select.down") ||
					(data === "page-down" && binding === "tui.select.pageDown"),
			},
			mode: "setup",
			onboardingState: { setupCompleted: false, version: 1 },
		},
		{ requestRender: () => undefined, terminal: { rows } },
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		{ bold: (value: string) => value, fg: (_color: string, value: string) => value } as Theme,
		done,
	);
}

test("MCP Setup follows the Command Dialog hierarchy at wide, narrow, and low heights", () => {
	const panel = createPanel(callbacks(async () => ({ path: "/project/.mcp.json" })));
	const wide = panel.render(64);
	const wideText = wide.join("\n");
	expect(wide[0]).toBe("━".repeat(64));
	expect(wideText).toContain("MCP setup");
	expect(wideText).toContain("Setup");
	expect(wideText).toContain("Preview");
	expect(wideText).not.toContain("◆ Setup");
	expect(wideText).toContain("› View example");
	expect(wideText.indexOf("No MCP config")).toBeLessThan(wideText.indexOf("Setup"));
	expect(wideText.indexOf("Setup")).toBeLessThan(wideText.indexOf("› View example"));
	expect(wideText.indexOf("› View example")).toBeLessThan(wideText.indexOf("Preview"));
	expect(wide.at(-1)).toContain("Esc close");
	expect(wideText).not.toMatch(/[╭╮╰╯│]/u);
	expect(wide.every((line) => visibleWidth(line) <= 64)).toBe(true);

	const narrow = panel.render(48);
	expect(narrow[0]).toBe("━".repeat(48));
	expect(narrow.join("\n")).not.toContain("Preview");
	expect(narrow.every((line) => visibleWidth(line) <= 48)).toBe(true);

	const lowPanel = createPanel(
		callbacks(async () => ({ path: "/project/.mcp.json" })),
		6,
	);
	const low = lowPanel.render(48);
	expect(low).toHaveLength(3);
	expect(low.join("\n")).toContain("MCP setup");
	expect(low.join("\n")).toContain("View example");
	expect(low.at(-1)).toContain("Esc close");
	lowPanel.handleInput("page-down");
	expect(lowPanel.render(48).join("\n")).toContain("› Scaffold project");
	panel.dispose();
	lowPanel.dispose();
});

test("MCP Setup keeps the selected import ahead of path glyph collisions", () => {
	const collisionDiscovery: McpDiscoverySummary = {
		...discovery,
		hasAnyConfig: true,
		hasAnyDetectedPaths: true,
		imports: [
			{ kind: "cursor", path: "/decoy ! attention › ◆ Preview", serverCount: 1 },
			{ kind: "claude-code", path: "/actual-selection", serverCount: 1 },
		],
	};
	for (const rows of [28, 6]) {
		const panel = createPanel(
			callbacks(async () => ({ path: "/project/.mcp.json" })),
			rows,
			collisionDiscovery,
		);
		panel.handleInput("confirm");
		panel.handleInput("down");
		const rendered = panel.render(64).join("\n");
		expect(rendered).toContain("actual-selection");
		if (rows === 28) expect(rendered).toContain("decoy ! attention › ◆ Preview");
		else expect(rendered).not.toContain("decoy ! attention › ◆ Preview");
		panel.dispose();
	}
});

test("MCP Setup honors compact list aliases and keeps import Space as selection", () => {
	const panel = createPanel(callbacks(async () => ({ path: "/project/.mcp.json" })));

	panel.handleInput(" ");
	expect(panel.render(64).join("\n")).toContain("› Chrome DevTools");
	panel.handleInput("\u001b[H");
	expect(panel.render(64).join("\n")).toContain("› View example");
	panel.handleInput("\u001b[F");
	panel.handleInput("\u0010");
	expect(panel.render(64).join("\n")).toContain("› GitHub");
	panel.handleInput("\u000e");
	panel.handleInput("b");
	expect(panel.render(64).join("\n")).toContain("› View example");
	panel.dispose();

	const importsPanel = createPanel(
		callbacks(async () => ({ path: "/project/.mcp.json" })),
		28,
		{
			...discovery,
			hasAnyConfig: true,
			hasAnyDetectedPaths: true,
			imports: [{ kind: "cursor", path: "/host/cursor.json", serverCount: 1 }],
		},
	);
	importsPanel.handleInput("confirm");
	expect(importsPanel.render(64).join("\n")).toContain("[x] cursor");
	importsPanel.handleInput(" ");
	expect(importsPanel.render(64).join("\n")).toContain("[ ] cursor");
	importsPanel.dispose();
});

test("MCP Setup pages only overflowing lists and renders active Pi bindings", () => {
	const panel = createMcpSetupPanel(
		{
			...discovery,
			hasAnyConfig: true,
			hasAnyDetectedPaths: true,
			sources: [
				{
					exists: true,
					id: "shared-project",
					kind: "shared",
					label: "project",
					path: "/project/.mcp.json",
					scope: "project",
					serverCount: 0,
				},
				{
					exists: true,
					id: "pi-project",
					kind: "pi",
					label: "Pi project",
					path: "/project/.pi/mcp.json",
					scope: "project",
					serverCount: 0,
				},
			],
		},
		callbacks(async () => ({ path: "/project/.mcp.json" })),
		{
			keybindings: {
				getKeys: (binding) => {
					switch (binding) {
						case "tui.select.confirm":
							return ["ctrl+y"];
						case "tui.select.down":
							return ["ctrl+j"];
						case "tui.select.pageDown":
							return ["ctrl+f"];
						case "tui.select.pageUp":
							return ["ctrl+b"];
						case "tui.select.up":
							return ["ctrl+k"];
						default:
							return [];
					}
				},
				matches: (data, binding) =>
					(data === "accept" && binding === "tui.select.confirm") ||
					(data === "go-down" && binding === "tui.select.down"),
			},
			mode: "setup",
			onboardingState: { setupCompleted: false, version: 1 },
		},
		{ requestRender: () => undefined, terminal: { rows: 28 } },
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		{ bold: (value: string) => value, fg: (_color: string, value: string) => value } as Theme,
		() => undefined,
	);

	panel.handleInput("go-down");
	panel.handleInput("go-down");
	panel.handleInput("\r");
	expect(panel.render(64).join("\n")).not.toContain("◆");
	panel.handleInput("accept");
	panel.handleInput(" ");
	const rendered = panel.render(64).join("\n");
	expect(rendered).toContain("› /project/.mcp.json");
	expect(rendered).toContain("Ctrl+K/Ctrl+J navigate");
	expect(rendered).toContain("Ctrl+Y open");
	expect(rendered).not.toContain("page");
	panel.dispose();
});

test("MCP Setup honors the active Pi cancel binding", () => {
	let closed = 0;
	const panel = createMcpSetupPanel(
		discovery,
		callbacks(async () => ({ path: "/project/.mcp.json" })),
		{
			keybindings: {
				getKeys: (binding) => (binding === "tui.select.cancel" ? ["ctrl+g"] : []),
				matches: (data, binding) =>
					(data === "cancel" && binding === "tui.select.cancel") ||
					(data === "confirm" && binding === "tui.select.confirm") ||
					(data === "down" && binding === "tui.select.down"),
			},
			mode: "setup",
			onboardingState: { setupCompleted: false, version: 1 },
		},
		{ requestRender: () => undefined, terminal: { rows: 28 } },
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		{ bold: (value: string) => value, fg: (_color: string, value: string) => value } as Theme,
		() => {
			closed += 1;
		},
	);

	panel.handleInput("down");
	panel.handleInput("confirm");
	expect(panel.render(64).join("\n")).toContain("Confirm change");
	panel.handleInput("cancel");
	expect(panel.render(64).join("\n")).not.toContain("Confirm change");
	expect(panel.render(64).join("\n")).toContain("Ctrl+G close");
	panel.handleInput("cancel");
	expect(closed).toBe(1);
	panel.dispose();
});

test("MCP Setup previews writes and defaults confirmation to Cancel", async () => {
	let writes = 0;
	const panel = createPanel(
		callbacks(async () => {
			writes += 1;
			return { path: "/project/.mcp.json" };
		}),
		14,
	);

	panel.handleInput("down");
	panel.handleInput("confirm");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(writes).toBe(0);
	const confirmation = panel.render(64).join("\n");
	expect(confirmation).toContain("Confirm change");
	expect(confirmation).toContain("Preview");
	expect(confirmation).not.toContain("◆ Confirm change");
	expect(confirmation).toContain("Write starter project .mcp.json?");
	expect(confirmation).toContain("› Cancel");
	expect(confirmation.indexOf("Write starter project .mcp.json?")).toBeLessThan(confirmation.indexOf("› Cancel"));
	panel.handleInput("confirm");
	expect(writes).toBe(0);
	panel.handleInput("confirm");
	panel.handleInput("down");
	panel.handleInput("confirm");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(writes).toBe(1);
	const lines = panel.render(64);
	expect(lines[0]).toBe("━".repeat(64));
	expect(lines.join("\n")).not.toMatch(/[┌┐└┘│]/u);
	expect(lines.at(-1)).toContain("Esc");
	expect(panel.render(12).every((line) => visibleWidth(line) <= 12)).toBe(true);
	panel.dispose();
});

test("MCP Setup cannot close while a confirmed write is pending", async () => {
	const pendingWrite = Promise.withResolvers<{ path: string }>();
	let closed = 0;
	const panel = createPanel(
		callbacks(() => pendingWrite.promise),
		28,
		discovery,
		() => {
			closed += 1;
		},
	);

	panel.handleInput("down");
	panel.handleInput("confirm");
	panel.handleInput("down");
	panel.handleInput("confirm");
	panel.handleInput("\u001b");
	expect(closed).toBe(0);
	expect(panel.render(64).join("\n")).toContain("Working...");
	pendingWrite.resolve({ path: "/项目配置/服务.json" });
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(closed).toBe(0);
	expect(panel.render(24).join("")).toContain("项目配置");
	panel.handleInput("\u001b");
	expect(closed).toBe(1);
	panel.dispose();
});

test("MCP Setup can close while a non-writing open action is pending", async () => {
	const pendingOpen = Promise.withResolvers<void>();
	let closed = 0;
	const panelCallbacks = callbacks(async () => ({ path: "/project/.mcp.json" }));
	panelCallbacks.openPath = () => pendingOpen.promise;
	const panel = createPanel(
		panelCallbacks,
		28,
		{
			...discovery,
			hasAnyConfig: true,
			hasAnyDetectedPaths: true,
			sources: [
				{
					exists: true,
					id: "shared-project",
					kind: "shared",
					label: "project",
					path: "/project/.mcp.json",
					scope: "project",
					serverCount: 0,
				},
			],
		},
		() => {
			closed += 1;
		},
	);

	panel.handleInput("down");
	panel.handleInput("down");
	panel.handleInput("confirm");
	panel.handleInput("confirm");
	expect(panel.render(64).join("\n")).toContain("Working...");
	panel.handleInput("\u001b");
	expect(closed).toBe(1);
	pendingOpen.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(closed).toBe(1);
	panel.dispose();
});

test("MCP Setup bounds and redacts write errors", async () => {
	const panel = createPanel(
		callbacks(async () => {
			throw new Error("token=SECRET\u001b]8;;https://malicious.invalid\u0007link");
		}),
	);

	panel.handleInput("down");
	panel.handleInput("confirm");
	panel.handleInput("down");
	panel.handleInput("confirm");
	await new Promise((resolve) => setTimeout(resolve, 0));
	const rendered = panel.render(64).join("\n");
	expect(rendered).toContain("[REDACTED]");
	expect(rendered).not.toContain("SECRET");
	expect(rendered).not.toContain("malicious.invalid");
	expect(rendered).not.toContain("\u001b");
	panel.dispose();
});

test("MCP Setup renders malformed-config preview errors instead of crashing", () => {
	const panelCallbacks = callbacks(async () => ({ path: "/project/.mcp.json" }));
	const panel = createPanel({
		...panelCallbacks,
		previewKnownServer: () => {
			throw new Error("Failed to read MCP config at /project/.mcp.json");
		},
	});
	for (let index = 0; index < 4; index += 1) panel.handleInput("down");
	const rendered = panel.render(64).join("\n");
	expect(rendered).toContain("Failed to read MCP config");
	expect(rendered).toContain("Fix the config file before writing.");
	panel.dispose();
});
