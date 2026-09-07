import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	ExtensionUIContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { type Static, type TSchema, Type } from "typebox";
import { type DiagnosticReport, reportDiagnostic } from "../conversation-ui/diagnostics.ts";
import {
	type CommandDialogKeybindings,
	type CommandDialogView,
	getCommandDialogCoordinator,
} from "../conversation-ui/index.ts";
import { readHostProxyProperty } from "../shared/host-proxy.ts";
import { isJsonSourceValue } from "../shared/json-value.ts";
import { isRuntimeFunction, isRuntimeNumber, isRuntimeString } from "../shared/runtime-type.ts";
import { registerSuiteOwnedTool, type SuiteToolRegistrationHost } from "../tool-display/index.ts";
import { createMcpControlView } from "./mcp-dialog.ts";
import { MCP_PRESENTATION } from "./presentation.ts";
import {
	createMcpAdapter,
	MCP_STATUS_EVENT,
	type McpAdapterCommandSpec,
	type McpAdapterExtensionAPI,
} from "./runtime/index.js";
import { logger } from "./runtime/logger.ts";
import { McpStatusStore } from "./status-store.ts";

type CapturedTool = ToolDefinition<TSchema, unknown, unknown>;
export type McpAdapterHost = SuiteToolRegistrationHost & Pick<ExtensionAPI, "registerCommand">;
type CommandSpec = Parameters<ExtensionAPI["registerCommand"]>[1];
type CommandContext = Parameters<CommandSpec["handler"]>[1];
type CapturedCommandSpec = McpAdapterCommandSpec;
type EventHandler = (event: ExtensionEvent, ctx: ExtensionContext) => object | undefined | Promise<object | undefined>;
type McpCustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type McpCustomKeybindings = Parameters<McpCustomFactory>[2];

interface McpCustomUiContext {
	readonly ui: Pick<ExtensionUIContext, "custom">;
}

interface McpCustomUiCoordinator<Context> {
	show<Result>(ctx: Context, view: CommandDialogView<Result>): Promise<Result | undefined>;
}

function isMcpCustomKeybindings(value: CommandDialogKeybindings): value is McpCustomKeybindings {
	return (
		"reload" in value &&
		isRuntimeFunction(value.reload) &&
		"getEffectiveConfig" in value &&
		isRuntimeFunction(value.getEffectiveConfig)
	);
}

interface CapturedCommands {
	mcp?: CapturedCommandSpec;
}

const MCP_GATEWAY_DESCRIPTION =
	"MCP gateway for configured servers. List or search first, then pass one returned prefixed Tool name with its args. Connect a server when cached metadata is unavailable. Authentication is user-driven through /mcp.";

const MCP_PARAMETERS = Type.Object({
	tool: Type.Optional(
		Type.String({
			description: "Prefixed MCP Tool name returned by list, search, or describe",
			maxLength: 256,
			minLength: 1,
		}),
	),
	args: Type.Optional(
		Type.Union([Type.String({ maxLength: 64 * 1_024 }), Type.Object({}, { additionalProperties: true })], {
			description: "Arguments for the selected MCP Tool as an object or JSON string",
		}),
	),
	connect: Type.Optional(
		Type.String({ description: "Configured server name to connect and refresh", maxLength: 200, minLength: 1 }),
	),
	describe: Type.Optional(
		Type.String({
			description: "Prefixed MCP Tool name whose parameters should be shown",
			maxLength: 256,
			minLength: 1,
		}),
	),
	search: Type.Optional(
		Type.String({ description: "Search cached MCP Tools by name or description", maxLength: 500 }),
	),
	includeSchemas: Type.Optional(Type.Boolean({ description: "Include parameter schemas in search results" })),
	limit: Type.Optional(Type.Integer({ description: "Maximum search results", maximum: 20, minimum: 1 })),
	offset: Type.Optional(Type.Integer({ description: "Search result offset", minimum: 0 })),
	server: Type.Optional(
		Type.String({ description: "Configured server to list or filter MCP Tools", maxLength: 200, minLength: 1 }),
	),
});

type McpParameters = Static<typeof MCP_PARAMETERS>;

function boundedMcpParameters(params: McpParameters): McpParameters {
	const bounded: McpParameters = {};
	if (params.tool !== undefined) bounded.tool = params.tool;
	if (params.args !== undefined) bounded.args = params.args;
	if (params.connect !== undefined) bounded.connect = params.connect;
	if (params.describe !== undefined) bounded.describe = params.describe;
	if (params.search !== undefined) bounded.search = params.search;
	if (params.includeSchemas !== undefined) bounded.includeSchemas = params.includeSchemas;
	if (params.limit !== undefined) bounded.limit = params.limit;
	if (params.offset !== undefined) bounded.offset = params.offset;
	if (params.server !== undefined) bounded.server = params.server;
	if (isRuntimeNumber(bounded["limit"])) bounded["limit"] = Math.min(20, Math.max(1, bounded["limit"]));
	const serverOnly =
		isRuntimeString(bounded["server"]) &&
		bounded.tool === undefined &&
		bounded.connect === undefined &&
		bounded.describe === undefined &&
		bounded.search === undefined;
	if (serverOnly) {
		bounded["search"] = "";
		bounded["limit"] ??= 12;
	}
	return bounded;
}

function sharedToolFields(upstream: CapturedTool) {
	const fields = {
		label: upstream.label,
		name: upstream.name,
	};
	if (upstream.constrainedSampling !== undefined) {
		Object.assign(fields, { constrainedSampling: upstream.constrainedSampling });
	}
	if (upstream.executionMode !== undefined) Object.assign(fields, { executionMode: upstream.executionMode });
	return fields;
}

function registerGateway(pi: SuiteToolRegistrationHost, upstream: CapturedTool): void {
	const tool: ToolDefinition<typeof MCP_PARAMETERS, unknown> = {
		...sharedToolFields(upstream),
		description: MCP_GATEWAY_DESCRIPTION,
		execute: (toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult<unknown>> =>
			upstream.execute(toolCallId, boundedMcpParameters(params), signal, onUpdate, ctx),
		parameters: MCP_PARAMETERS,
		promptSnippet: "Discover and call configured MCP servers through one bounded, lazy gateway.",
	};
	registerSuiteOwnedTool(pi, tool, MCP_PRESENTATION);
}

/** Remove only the fork's persistent footer segment while retaining auth progress and notifications. */
export function suppressMcpFooterContext(ctx: ExtensionContext): ExtensionContext {
	const setStatus: ExtensionUIContext["setStatus"] = (key, value) => {
		if (key !== "mcp") ctx.ui.setStatus(key, value);
	};
	const ui = new Proxy(ctx.ui, {
		get(target, property) {
			if (property === "setStatus") return setStatus;
			return readHostProxyProperty(target, property);
		},
	});
	return new Proxy(ctx, {
		get(target, property) {
			if (property === "ui") return ui;
			return readHostProxyProperty(target, property);
		},
	});
}

/** Keep retained MCP custom components inside the Suite-owned focused surface. */
export function routeMcpCustomUiThroughCommandDialog<Context extends McpCustomUiContext>(
	ctx: Context,
	coordinator: McpCustomUiCoordinator<Context>,
): Context {
	// SAFETY: the wrapper preserves Pi's generic custom-UI result and synchronously delegates the same factory contract.
	const custom = (async (factory: McpCustomFactory) => {
		const result = await coordinator.show<unknown>(ctx, {
			priority: "normal",
			create: (context) => {
				if (!isMcpCustomKeybindings(context.keybindings)) {
					throw new Error("MCP custom UI requires Pi application keybindings");
				}
				const component = factory(context.tui, context.theme, context.keybindings, (value) => context.close(value));
				if (component instanceof Promise) {
					throw new Error("Async MCP custom component factories are unsupported");
				}
				return component;
			},
		});
		return result;
	}) as ExtensionUIContext["custom"];
	const ui = new Proxy(ctx.ui, {
		get(target, property) {
			if (property === "custom") return custom;
			return readHostProxyProperty(target, property);
		},
	});
	// SAFETY: the proxy forwards every Context property and replaces only ui with the same structural contract.
	return new Proxy(ctx, {
		get(target, property) {
			if (property === "ui") return ui;
			return readHostProxyProperty(target, property);
		},
	}) as Context;
}

/** Build the narrow host facade supplied to the pinned fork. */
export function createMcpAdapterApi<Host extends McpAdapterHost>(
	pi: Host,
	commands: CapturedCommands,
): Host & McpAdapterExtensionAPI {
	// SAFETY: the pinned MCP fork calls registerTool with Pi Tool definitions; the adapter intentionally retains only mcp.
	const registerTool = ((tool: CapturedTool) => {
		if (tool.name === "mcp") registerGateway(pi, tool);
	}) as ExtensionAPI["registerTool"];
	// SAFETY: the pinned fork's mcp handler returns only its documented handled boolean or undefined.
	const registerCommand = (name: string, spec: CapturedCommandSpec) => {
		if (name === "mcp") {
			commands.mcp = spec;
		}
	};
	// SAFETY: the pinned fork registers Pi extension events; this facade changes only session_start's UI context.
	const on = ((event: string, handler: EventHandler) => {
		// SAFETY: pi.on accepts the same ExtensionEvent and ExtensionContext pair after event-name dispatch.
		const hostOn = pi.on as (eventName: string, eventHandler: EventHandler) => void;
		if (event === "session_start") {
			return hostOn(event, (eventData, ctx) => handler(eventData, suppressMcpFooterContext(ctx)));
		}
		return hostOn(event, handler);
	}) as ExtensionAPI["on"];
	// SAFETY: this proxy forwards the Host unchanged and replaces registerCommand with the fork-private handled-result contract.
	return new Proxy(pi, {
		get(target, property) {
			if (property === "registerTool") return registerTool;
			if (property === "registerCommand") return registerCommand;
			if (property === "on") return on;
			return readHostProxyProperty(target, property);
		},
	}) as Host & McpAdapterExtensionAPI;
}

function firstArgument(args: string): string {
	return args.trim().split(/\s+/u)[0] ?? "";
}

function installCommands(pi: ExtensionAPI, commands: CapturedCommands, store: McpStatusStore): void {
	const coordinator = getCommandDialogCoordinator(pi);
	const invoke = async (
		command: CapturedCommandSpec | undefined,
		args: string,
		ctx: CommandContext,
	): Promise<boolean> => {
		if (!command) throw new Error("MCP command is unavailable");
		return (await command.handler(args, ctx)) === true;
	};
	const invokeAction = async (args: string, ctx: CommandContext): Promise<boolean> => invoke(commands.mcp, args, ctx);
	pi.registerCommand("mcp", {
		description: "Manage MCP servers",
		getArgumentCompletions: (prefix) => {
			const options = [
				"auth",
				"status",
				"reconnect",
				"logout",
				"disable",
				"enable",
				"auto-connect",
				"on-demand",
				"setup",
			];
			const normalized = prefix.trimStart();
			const matches = options
				.filter((option) => option.startsWith(normalized))
				.map((option) => ({ label: option, value: option }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const subcommand = firstArgument(args);
			if (!subcommand || subcommand === "status") {
				if (!ctx.hasUI) return;
				const result = await coordinator.show(
					ctx,
					createMcpControlView(store, {
						authenticate: (server) => invokeAction(`auth ${server}`, ctx),
						logout: (server) => invokeAction(`logout ${server}`, ctx),
						reconnect: (server) => invokeAction(`reconnect ${server}`, ctx),
					}),
				);
				if (result?.action === "setup") {
					await invoke(
						commands.mcp,
						"setup",
						routeMcpCustomUiThroughCommandDialog<CommandContext>(ctx, coordinator),
					);
				} else if (result?.action === "set-disabled") {
					await invoke(commands.mcp, `${result.disabled ? "disable" : "enable"} ${result.server}`, ctx);
				} else if (result?.action === "set-auto-connect") {
					await invoke(commands.mcp, `${result.enabled ? "auto-connect" : "on-demand"} ${result.server}`, ctx);
				}
				return;
			}
			if (subcommand === "setup") {
				await invoke(commands.mcp, args, routeMcpCustomUiThroughCommandDialog<CommandContext>(ctx, coordinator));
				return;
			}
			if (
				["auth", "reconnect", "logout", "disable", "enable", "auto-connect", "on-demand"].includes(subcommand) &&
				commands.mcp
			) {
				await commands.mcp.handler(args, ctx);
				return;
			}
			ctx.ui.notify(`Unknown /mcp subcommand: ${subcommand}`, "warning");
		},
	});
}

/** Installation performs local configuration reads only; connection starts on explicit use. */
export function installMcpCapability(pi: ExtensionAPI): void {
	const removeDiagnosticHandler = logger.addHandler((entry) => {
		const context =
			entry.context && Object.keys(entry.context).length > 0 ? JSON.stringify(entry.context) : undefined;
		const diagnostic: DiagnosticReport = {
			capability: "MCP",
			severity: entry.level === "error" ? "error" : entry.level === "warn" ? "warning" : "info",
			summary: entry.message,
		};
		if (context) Object.assign(diagnostic, { details: context });
		if (entry.error) Object.assign(diagnostic, { error: entry.error });
		reportDiagnostic(diagnostic);
	});
	const commands: CapturedCommands = {};
	const store = new McpStatusStore();
	const unsubscribeStatus = pi.events.on(MCP_STATUS_EVENT, (value) => {
		if (isJsonSourceValue(value)) store.set(value);
	});
	const adapter = createMcpAdapter({
		deferStartupConnections: true,
	});
	adapter(createMcpAdapterApi(pi, commands));
	installCommands(pi, commands, store);
	pi.on("session_shutdown", () => {
		removeDiagnosticHandler();
		store.clear();
		if (isRuntimeFunction(unsubscribeStatus)) unsubscribeStatus();
	});
}
