import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import {
	commandDialogPrimaryKey,
	commandDialogSectionHeading,
	fitCommandDialogRows,
} from "../../conversation-ui/index.ts";
import { type McpDialogRows, mcpDialogPriority } from "../mcp-dialog-rows.ts";
import type { ConfigWritePreview, KnownServerPreset, McpDiscoverySummary } from "./config.ts";
import { redactTraceText } from "./mcp-trace.ts";
import type { McpOnboardingState } from "./onboarding-state.ts";
import type { PanelKeybindings } from "./panel-keys.ts";
import type { ImportKind } from "./types.ts";
import { formatTerminalError } from "./utils.ts";

const COMPACT_WIDTH = 60;
export const LIST_WINDOW_ROWS = 7;
const PREVIEW_ROWS = 5;
const DESKTOP_PREVIEW_WIDTH = 74;
const VERBOSE_WIDTH = 80;

export type Screen = "empty" | "setup" | "imports" | "paths";

export type ActionId =
	| "run-setup"
	| "adopt-imports"
	| "view-example"
	| "show-precedence"
	| "open-paths"
	| "add-repoprompt"
	| "add-known-server"
	| "scaffold-project";

export interface Action {
	id: ActionId;
	label: string;
	preset?: KnownServerPreset;
}

export type PendingWrite = { readonly kind: "action"; readonly action: Action } | { readonly kind: "imports" };
export type SetupNotice = { readonly text: string; readonly tone: "success" | "warning" | "muted" };

export interface SetupPreviewCallbacks {
	previewImports: (imports: ImportKind[]) => ConfigWritePreview;
	previewKnownServer: (preset: KnownServerPreset) => ConfigWritePreview;
	previewRepoPrompt: () => ConfigWritePreview | null;
	previewStarterProject: () => ConfigWritePreview;
}

export interface McpSetupPanelViewState {
	readonly actionCursor: number;
	readonly actions: readonly Action[];
	readonly busy: boolean;
	readonly callbacks: SetupPreviewCallbacks;
	readonly confirmation: PendingWrite | null;
	readonly confirmCursor: number;
	readonly discovery: McpDiscoverySummary;
	readonly importCursor: number;
	readonly keybindings: PanelKeybindings | undefined;
	readonly maximumRows: number;
	readonly notice: SetupNotice | null;
	readonly onboardingState: McpOnboardingState;
	readonly pathCursor: number;
	readonly paths: readonly string[];
	readonly screen: Screen;
	readonly selectedImports: ReadonlySet<ImportKind>;
	readonly theme: Theme;
}

interface SetupRows extends McpDialogRows {
	readonly selectableRows?: readonly string[];
}

export interface McpSetupPanelRender {
	readonly lines: string[];
	readonly pageRows: number;
}

export function renderMcpSetupPanel(state: McpSetupPanelViewState, width: number): McpSetupPanelRender {
	const panelW = Math.max(1, Math.floor(width));
	const contentW = contentWidth(panelW);
	const header = [state.theme.fg("border", "━".repeat(panelW)), padLine(state.theme.bold("MCP setup"), panelW)];
	const body: string[] = [];
	const roles: McpDialogRows["roles"] = {};
	const summary = discoverySummary(state);
	for (const line of wrapTextWithAnsi(summary.text, contentW)) {
		body.push(padLine(state.theme.fg(summary.tone === "warning" ? "warning" : "dim", line), panelW));
	}
	if (panelW >= VERBOSE_WIDTH) {
		for (const line of wrapTextWithAnsi(secondarySummaryLine(state), contentW)) {
			body.push(padLine(state.theme.fg("muted", line), panelW));
		}
	}
	body.push(padLine("", panelW));

	let noticeLine: string | undefined;
	if (state.notice) {
		const tone = state.notice.tone === "success" ? "success" : state.notice.tone === "warning" ? "warning" : "dim";
		const icon = state.busy
			? "●"
			: state.notice.tone === "success"
				? "✓"
				: state.notice.tone === "warning"
					? "!"
					: "○";
		for (const [index, line] of wrapTextWithAnsi(state.notice.text, Math.max(1, contentW - 2)).entries()) {
			const rendered = padLine(state.theme.fg(tone, `${index === 0 ? `${icon} ` : "  "}${line}`), panelW);
			body.push(rendered);
			noticeLine ??= rendered;
		}
		body.push(padLine("", panelW));
	}
	if (noticeLine !== undefined) roles.notice = noticeLine;

	const content: SetupRows = state.confirmation
		? renderConfirmation(state, panelW)
		: state.screen === "imports"
			? renderImports(state, panelW)
			: state.screen === "paths"
				? renderPaths(state, panelW)
				: renderActions(state, panelW);
	body.push(...content.lines);
	Object.assign(roles, content.roles);
	const dialogBody = { lines: body, roles };
	const priority = mcpDialogPriority(dialogBody, [
		"question",
		"selected",
		"notice",
		"confirmation",
		"preview-heading",
		"preview-detail",
	]);
	if (priority.length === 0 && body[0]) priority.push(body[0]);
	const sections = { header, body, footer: renderFooter(state, panelW, false), priority };
	const firstPass = fitCommandDialogRows(sections, state.maximumRows);
	const pageRows = Math.max(1, content.selectableRows?.filter((line) => firstPass.includes(line)).length ?? 0);
	const lines = fitCommandDialogRows(
		{ ...sections, footer: renderFooter(state, panelW, activeItemCount(state) > pageRows) },
		state.maximumRows,
	);
	return { lines: lines.map((line) => truncateToWidth(line, panelW, "…")), pageRows };
}

function renderConfirmation(view: McpSetupPanelViewState, innerW: number): McpDialogRows {
	const pending = view.confirmation;
	if (!pending) return { lines: [], roles: {} };
	const contentW = contentWidth(innerW);
	const action = pending.kind === "action" ? pending.action : undefined;
	const question =
		pending.kind === "imports"
			? "Write selected compatibility imports?"
			: action?.id === "scaffold-project"
				? "Write starter project .mcp.json?"
				: action?.id === "add-repoprompt"
					? "Add RepoPrompt to the MCP config?"
					: `Add ${action?.label ?? "this server"} to the MCP config?`;
	const lines = [
		padLine(commandDialogSectionHeading(view.theme, "Confirm change", ""), innerW),
		padLine(view.theme.fg("warning", `! ${question}`), innerW),
		padLine(view.theme.fg("muted", "Review the target and exact diff before writing."), innerW),
		padLine("", innerW),
		padLine(commandDialogSectionHeading(view.theme, "Preview", ""), innerW),
	];
	const preview = safePreview(
		view,
		() =>
			pending.kind === "imports"
				? formatWritePreview(
						"Compatibility import write preview",
						view.callbacks.previewImports(
							view.discovery.imports
								.filter((entry) => view.selectedImports.has(entry.kind))
								.map((entry) => entry.kind),
						),
						[],
						previewWidth(innerW),
					)
				: getActionPreview(view, action, previewWidth(innerW)),
		previewWidth(innerW),
	);
	for (const line of boundedPreview(view, preview, innerW < COMPACT_WIDTH ? 4 : PREVIEW_ROWS)) {
		lines.push(padLine(truncateToWidth(line, contentW, "…"), innerW));
	}
	lines.push(
		padLine("", innerW),
		padLine(`${view.confirmCursor === 0 ? view.theme.fg("accent", "›") : " "} Cancel`, innerW),
		padLine(`${view.confirmCursor === 1 ? view.theme.fg("accent", "›") : " "} Write and reload`, innerW),
		padLine("", innerW),
	);
	const roles: McpDialogRows["roles"] = {};
	if (lines[0] !== undefined) roles.confirmation = lines[0];
	if (lines[1] !== undefined) roles.question = lines[1];
	if (lines[4] !== undefined) roles["preview-heading"] = lines[4];
	if (lines[5] !== undefined) roles["preview-detail"] = lines[5];
	const selected = lines.at(view.confirmCursor === 0 ? -3 : -2);
	if (selected !== undefined) roles.selected = selected;
	return { lines, roles };
}

function renderActions(view: McpSetupPanelViewState, innerW: number): SetupRows {
	const lines: string[] = [];
	const selectableRows: string[] = [];
	const roles: McpDialogRows["roles"] = {};
	const actions = view.actions;
	const { start, end } = visibleRange(actions.length, view.actionCursor);

	if (start > 0) {
		lines.push(padLine(view.theme.fg("muted", `… ${start} earlier`), innerW));
	}
	let section: string | undefined;
	for (let index = start; index < end; index++) {
		const action = actions[index];
		if (!action) continue;
		const nextSection = actionSection(action);
		if (nextSection !== section) {
			lines.push(padLine(commandDialogSectionHeading(view.theme, nextSection, ""), innerW));
			section = nextSection;
		}
		const selected = index === view.actionCursor;
		const cursor = selected ? view.theme.fg("accent", "›") : " ";
		const line = padLine(`${cursor} ${truncateToWidth(action.label, contentWidth(innerW) - 2)}`, innerW);
		lines.push(line);
		selectableRows.push(line);
		if (selected) roles.selected = line;
	}
	if (end < actions.length) {
		lines.push(padLine(view.theme.fg("muted", `… ${actions.length - end} later`), innerW));
	}
	if (innerW >= COMPACT_WIDTH) {
		lines.push(padLine("", innerW));
		const previewHeading = padLine(commandDialogSectionHeading(view.theme, "Preview", ""), innerW);
		lines.push(previewHeading);
		roles["preview-heading"] = previewHeading;
		const preview = safePreview(
			view,
			() => getActionPreview(view, view.actions[view.actionCursor], previewWidth(innerW)),
			previewWidth(innerW),
		);
		for (const [index, line] of boundedPreview(view, preview).entries()) {
			const rendered = padLine(line, innerW);
			lines.push(rendered);
			if (index === 0) roles["preview-detail"] = rendered;
		}
	}
	lines.push(padLine("", innerW));
	return { lines, roles, selectableRows };
}

function renderImports(view: McpSetupPanelViewState, innerW: number): SetupRows {
	const lines: string[] = [];
	const selectableRows: string[] = [];
	const roles: McpDialogRows["roles"] = {};
	lines.push(padLine(commandDialogSectionHeading(view.theme, "Compatibility imports", ""), innerW));
	lines.push(padLine(view.theme.fg("muted", "Choose sources to copy into Pi-owned compatibility config."), innerW));
	lines.push(padLine("", innerW));
	const { start, end } = visibleRange(view.discovery.imports.length, view.importCursor);
	if (start > 0) lines.push(padLine(view.theme.fg("muted", `… ${start} earlier`), innerW));
	for (let index = start; index < end; index++) {
		const entry = view.discovery.imports[index];
		if (!entry) continue;
		const selected = view.selectedImports.has(entry.kind) ? "[x]" : "[ ]";
		const cursor = index === view.importCursor ? view.theme.fg("accent", "›") : " ";
		const line = padLine(`${cursor} ${selected} ${entry.kind}  ${entry.path}`, innerW);
		lines.push(line);
		selectableRows.push(line);
		if (index === view.importCursor) roles.selected = line;
	}
	if (end < view.discovery.imports.length) {
		lines.push(padLine(view.theme.fg("muted", `… ${view.discovery.imports.length - end} later`), innerW));
	}
	lines.push(padLine("", innerW));
	const selected = view.discovery.imports
		.filter((entry) => view.selectedImports.has(entry.kind))
		.map((entry) => entry.kind);
	lines.push(padLine(view.theme.fg("muted", `${selected.length} selected`), innerW));
	if (innerW >= COMPACT_WIDTH) {
		lines.push(padLine("", innerW));
		const previewHeading = padLine(commandDialogSectionHeading(view.theme, "Preview", ""), innerW);
		lines.push(previewHeading);
		roles["preview-heading"] = previewHeading;
		const preview = safePreview(
			view,
			() =>
				formatWritePreview(
					"Compatibility import write preview",
					view.callbacks.previewImports(selected),
					[],
					previewWidth(innerW),
				),
			previewWidth(innerW),
		);
		for (const [index, line] of boundedPreview(view, preview).entries()) {
			const rendered = padLine(line, innerW);
			lines.push(rendered);
			if (index === 0) roles["preview-detail"] = rendered;
		}
	}
	return { lines, roles, selectableRows };
}

function renderPaths(view: McpSetupPanelViewState, innerW: number): SetupRows {
	const lines: string[] = [];
	const selectableRows: string[] = [];
	const roles: McpDialogRows["roles"] = {};
	lines.push(padLine(commandDialogSectionHeading(view.theme, "Detected paths", ""), innerW));
	lines.push(padLine(view.theme.fg("muted", "Open a discovered MCP config in the Host."), innerW));
	lines.push(padLine("", innerW));
	const paths = view.paths;
	const { start, end } = visibleRange(paths.length, view.pathCursor);
	if (start > 0) lines.push(padLine(view.theme.fg("muted", `… ${start} earlier`), innerW));
	for (let index = start; index < end; index++) {
		const cursor = index === view.pathCursor ? view.theme.fg("accent", "›") : " ";
		const line = padLine(`${cursor} ${paths[index]}`, innerW);
		lines.push(line);
		selectableRows.push(line);
		if (index === view.pathCursor) roles.selected = line;
	}
	if (end < paths.length) lines.push(padLine(view.theme.fg("muted", `… ${paths.length - end} later`), innerW));
	return { lines, roles, selectableRows };
}

function discoverySummary(view: McpSetupPanelViewState) {
	if (!view.discovery.hasAnyConfig) {
		return {
			text: view.onboardingState.setupCompleted
				? "No MCP servers are active right now."
				: "No MCP config is active yet.",
			tone: "warning",
		};
	}

	if (
		view.discovery.totalServerCount === 0 &&
		(view.discovery.imports.length > 0 || !!view.discovery.repoPrompt.executablePath)
	) {
		return { text: "Pi found MCP-related setup options, but none are active in Pi yet.", tone: "warning" };
	}

	const shared = view.discovery.sources.filter((source) => source.kind === "shared" && source.serverCount > 0).length;
	const piOwned = view.discovery.sources.filter((source) => source.kind === "pi" && source.serverCount > 0).length;
	return {
		text: `Detected ${view.discovery.totalServerCount} configured servers across ${shared} shared and ${piOwned} Pi-owned source${shared + piOwned === 1 ? "" : "s"}.`,
		tone: "hint",
	};
}

function secondarySummaryLine(view: McpSetupPanelViewState): string {
	const hostNote =
		view.discovery.hostConfigs.length > 0
			? ` Host discovery is ${view.discovery.hostConfigDiscovery}; ${view.discovery.hostConfigs.length} host source${view.discovery.hostConfigs.length === 1 ? "" : "s"} detected.`
			: "";
	const conflictNote =
		view.discovery.conflicts.length > 0
			? ` ${view.discovery.conflicts.length} same-name conflict${view.discovery.conflicts.length === 1 ? "" : "s"} reported.`
			: "";
	if (!view.discovery.hasAnyConfig) {
		return `Create a shared .mcp.json, adopt host imports, or quick-add RepoPrompt from this screen.${hostNote}${conflictNote}`;
	}
	if (view.discovery.totalServerCount === 0 && view.discovery.imports.length > 0) {
		return `Detected ${view.discovery.imports.length} compatibility import source${view.discovery.imports.length === 1 ? "" : "s"}. Adopt them into Pi or inspect the underlying files.${hostNote}${conflictNote}`;
	}
	return `Shared MCP files are preferred. Pi-owned files are only for compatibility imports and adapter-specific overrides.${hostNote}${conflictNote}`;
}

function visibleRange(total: number, cursor: number) {
	if (total <= LIST_WINDOW_ROWS) return { start: 0, end: total };
	const half = Math.floor(LIST_WINDOW_ROWS / 2);
	const start = Math.min(Math.max(0, cursor - half), Math.max(0, total - LIST_WINDOW_ROWS));
	return { start, end: Math.min(total, start + LIST_WINDOW_ROWS) };
}

function actionSection(action: Action): "Known servers" | "Setup" {
	return action.id === "add-known-server" || action.id === "add-repoprompt" ? "Known servers" : "Setup";
}

function boundedPreview(view: McpSetupPanelViewState, lines: string[], maximum = PREVIEW_ROWS): string[] {
	if (lines.length <= maximum) return lines;
	return [
		...lines.slice(0, Math.max(1, maximum - 1)),
		view.theme.fg("muted", `… ${lines.length - maximum + 1} more line${lines.length - maximum + 1 === 1 ? "" : "s"}`),
	];
}

function safePreview(view: McpSetupPanelViewState, render: () => string[], width: number): string[] {
	try {
		return render();
	} catch (error) {
		const lines = formatPreview(
			[`! ${redactTraceText(formatTerminalError(error), 240)}`, "Fix the config file before writing."],
			width,
		);
		return lines.map((line, index) => view.theme.fg(index === 0 ? "warning" : "dim", line));
	}
}

function contentWidth(innerW: number): number {
	return Math.max(1, innerW - 2);
}

function previewWidth(innerW: number): number {
	return Math.max(12, Math.min(DESKTOP_PREVIEW_WIDTH, contentWidth(innerW)));
}

function getActionPreview(view: McpSetupPanelViewState, action?: Action, previewW = DESKTOP_PREVIEW_WIDTH): string[] {
	switch (action?.id) {
		case "run-setup":
			return formatPreview(
				[
					"Run setup to adopt host-specific imports, inspect detected paths, and scaffold a minimal `.mcp.json` if needed.",
				],
				previewW,
			);
		case "adopt-imports":
			return formatWritePreview(
				"Compatibility import write preview",
				view.callbacks.previewImports(
					view.discovery.imports
						.filter((entry) => view.selectedImports.has(entry.kind))
						.map((entry) => entry.kind),
				),
				[
					`Detected imports: ${view.discovery.imports.map((entry) => `${entry.kind} (${entry.serverCount} servers)`).join(", ")}`,
					"Selected imports are written into the Pi agent dir config as Pi-owned compatibility state.",
				],
				previewW,
			);
		case "view-example":
			return formatPreview(
				[
					"Example shared `.mcp.json`:",
					"{",
					'  "mcpServers": {',
					'    "chrome-devtools": {',
					'      "command": "npx",',
					'      "args": ["-y", "chrome-devtools-mcp@latest"]',
					"    }",
					"  }",
					"}",
					"",
					"Use Scaffold project `.mcp.json` when you want a safe empty shell instead of a live example server.",
				],
				previewW,
			);
		case "show-precedence":
			return formatPreview(
				[
					"Read order (later entries win):",
					"0. detected host configs (opt-in lowest-precedence fallback)",
					`1. ${view.discovery.sources.find((source) => source.id === "shared-global")?.path ?? "$XDG_CONFIG_HOME/mcp/mcp.json"}`,
					"2. ~/.agents/mcp.json",
					"3. ~/.agents/mcp/mcp.json",
					"4. <Pi agent dir>/mcp.json",
					"5. .mcp.json",
					"6. .pi/mcp.json",
					`Host discovery: ${view.discovery.hostConfigDiscovery}. Conflicts reported: ${view.discovery.conflicts.length}.`,
					...view.discovery.conflicts
						.slice(0, 8)
						.map(
							(conflict) =>
								`${conflict.serverName}: ${conflict.sources.map((source) => source.path).join(" -> ")} (winner: ${conflict.winner.path})`,
						),
					"Pi writes compatibility imports and adapter-only overrides to Pi-owned files.",
				],
				previewW,
			);
		case "open-paths":
			return formatPreview(
				view.paths.length > 0 ? ["Detected paths:", ...view.paths] : ["No config paths were detected."],
				previewW,
			);
		case "add-repoprompt": {
			const repoPrompt = view.discovery.repoPrompt;
			const preview = view.callbacks.previewRepoPrompt();
			if (!preview) {
				return formatPreview(["RepoPrompt is not available to add from this setup screen."], previewW);
			}
			return formatWritePreview(
				"RepoPrompt write preview",
				preview,
				[
					`Executable: ${repoPrompt.executablePath ?? "not found"}`,
					`Target: ${repoPrompt.targetPath ?? "n/a"}`,
					`Server name: ${repoPrompt.serverName ?? "repoprompt"}`,
				],
				previewW,
			);
		}
		case "add-known-server": {
			const preset = action.preset;
			if (!preset) return formatPreview(["Known server preset is unavailable."], previewW);
			return formatWritePreview(
				`${preset.name} write preview`,
				view.callbacks.previewKnownServer(preset),
				[preset.summary],
				previewW,
			);
		}
		case "scaffold-project":
			return formatWritePreview(
				"Starter project `.mcp.json` write preview",
				view.callbacks.previewStarterProject(),
				[
					"This writes a minimal `.mcp.json` in the current project using the shared MCP layout.",
					"It intentionally avoids adding a fake placeholder server that would fail on first reload.",
				],
				previewW,
			);
		default:
			return [];
	}
}

function formatPreview(lines: string[], width = DESKTOP_PREVIEW_WIDTH): string[] {
	const preview: string[] = [];
	for (const line of lines) {
		if (/^\s|^[{}]$|^"/u.test(line)) preview.push(truncateToWidth(line, width, "…", true));
		else preview.push(...wrapTextWithAnsi(line, width));
	}
	return preview;
}

function formatWritePreview(
	title: string,
	preview: ConfigWritePreview,
	intro: string[] = [],
	width = DESKTOP_PREVIEW_WIDTH,
): string[] {
	const lines: string[] = [];
	for (const line of intro) {
		lines.push(...wrapTextWithAnsi(line, width));
	}
	if (intro.length > 0) lines.push("");
	lines.push(...wrapTextWithAnsi(`${title}: ${preview.path}`, width));
	lines.push(
		...wrapTextWithAnsi(
			preview.existed
				? "Existing file detected. Showing exact before/after diff."
				: "New file will be created. Showing exact content diff.",
			width,
		),
	);
	lines.push("");
	const diffLines = preview.diffText.split("\n");
	const maxLines = 18;
	const shown = diffLines.slice(0, maxLines);
	for (const line of shown) {
		lines.push(truncateToWidth(line, width, "…", true));
	}
	if (diffLines.length > maxLines) {
		lines.push(
			...wrapTextWithAnsi(
				`… ${diffLines.length - maxLines} more diff line${diffLines.length - maxLines === 1 ? "" : "s"}`,
				width,
			),
		);
	}
	return lines;
}

function padLine(text: string, innerW: number): string {
	const inset = 2;
	const contentW = Math.max(0, innerW - inset);
	const fitted = truncateToWidth(text, contentW, "…", true);
	return `${" ".repeat(Math.min(inset, innerW))}${fitted}`;
}

function activeItemCount(view: McpSetupPanelViewState): number {
	return view.screen === "imports"
		? view.discovery.imports.length
		: view.screen === "paths"
			? view.paths.length
			: view.actions.length;
}

function renderFooter(view: McpSetupPanelViewState, width: number, hasOverflow: boolean): string[] {
	const keybindings = view.keybindings;
	const up = keybindings ? commandDialogPrimaryKey(keybindings, "tui.select.up", "↑") : "↑";
	const down = keybindings ? commandDialogPrimaryKey(keybindings, "tui.select.down", "↓") : "↓";
	const pageUp = keybindings ? commandDialogPrimaryKey(keybindings, "tui.select.pageUp", "PgUp") : "PgUp";
	const pageDown = keybindings ? commandDialogPrimaryKey(keybindings, "tui.select.pageDown", "PgDn") : "PgDn";
	const confirm = keybindings ? commandDialogPrimaryKey(keybindings, "tui.select.confirm", "Enter") : "Enter";
	const cancel = keybindings ? commandDialogPrimaryKey(keybindings, "tui.select.cancel", "Esc") : "Esc";
	const page = hasOverflow ? ` · ${pageUp}/${pageDown} page` : "";
	const action = view.confirmation
		? `${up}/${down} navigate · ${confirm} select`
		: view.screen === "imports"
			? `${up}/${down} navigate${page} · Space toggle · ${confirm} review`
			: view.screen === "paths"
				? `${up}/${down} navigate${page} · ${confirm} open`
				: `${up}/${down} navigate${page} · ${confirm} select`;
	return [
		padLine(view.theme.fg("muted", action), width),
		padLine(
			view.theme.fg(
				"muted",
				`${cancel} ${view.screen === "imports" || view.screen === "paths" || view.confirmation ? "back" : "close"}`,
			),
			width,
		),
	];
}
