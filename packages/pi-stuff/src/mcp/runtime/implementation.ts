import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { Type } from "typebox";
import { HOST_SHUTDOWN_GRACE_MS } from "../../lifecycle-deadline.ts";
import {
	type EffectFoundation,
	type EffectScopeOwner,
	installEffectFoundation,
} from "../../shared/effect-foundation.ts";
import { type JsonInputObject, parseJsonObject } from "../../shared/json-value.ts";
import { isRuntimeFunction, isRuntimeString } from "../../shared/runtime-type.ts";
import type { McpCommandContext } from "./commands.ts";
import {
	cloneMcpConfig,
	loadMcpConfig,
	writeProjectServerDisabledOverride,
	writeProjectServerLifecycleOverride,
} from "./config.ts";
import { toolErrorOverride } from "./error-signal.ts";
import { initializeMcp, type McpInitializationContext, updateStatusBar } from "./init.ts";
import { logger } from "./logger.ts";
import type { McpOAuthRuntime } from "./mcp-auth-flow.ts";
import { createOAuthRuntime, shutdownOAuth } from "./mcp-auth-flow.ts";
import { mcpNativePromise, runMcpEffect, runMcpEffectExit } from "./mcp-effect-runner.ts";
import { publishMcpStatusShutdown } from "./mcp-status.ts";
import { createMcpRuntimeOwner, createOwnedUi, isAbortError, type McpRuntimeOwner } from "./runtime-owner.ts";
import type { McpExtensionState } from "./state.ts";
import { renderMcpProxyToolCall, renderMcpToolResult } from "./tool-result-renderer.ts";
import type { McpAdapterOptions, McpConfig } from "./types.ts";
import { formatTerminalError, getConfigPathFromArgv } from "./utils.ts";

export type { McpAdapterOptions } from "./types.ts";
export {
	MCP_STATUS_EVENT,
	MCP_STATUS_SNAPSHOT_VERSION,
	type McpServerRuntimeStatus,
	type McpServerStatusSnapshot,
	type McpStatusSnapshot,
} from "./types.ts";

type AdapterCommandSpec = Parameters<ExtensionAPI["registerCommand"]>[1];
type AdapterCommandContext = Parameters<AdapterCommandSpec["handler"]>[1];
export type McpAdapterCommandSpec = Omit<AdapterCommandSpec, "handler"> & {
	handler(args: string, ctx: AdapterCommandContext): boolean | undefined | Promise<boolean | undefined>;
};

export type McpAdapterExtensionAPI = ExtensionAPI & {
	registerCommand(name: string, spec: McpAdapterCommandSpec): void;
};

export interface ParsedMcpCommand {
	serverName?: string;
	subcommand: string;
}

const INIT_WAIT_TIMEOUT_MS = 30_000;
const MCP_COMMAND_COMPLETIONS = [
	{ value: "auth", label: "auth — Authenticate a server" },
	{ value: "reconnect", label: "reconnect — Reconnect servers" },
	{ value: "setup", label: "setup — Configure MCP servers" },
	{ value: "logout", label: "logout — Clear server credentials" },
	{ value: "disable", label: "disable — Disable a server" },
	{ value: "enable", label: "enable — Enable a server" },
	{ value: "auto-connect", label: "auto-connect — Persist automatic connection" },
	{ value: "on-demand", label: "on-demand — Persist lazy connection" },
	{ value: "status", label: "status — Show server status" },
] as const;
const MCP_SERVER_COMMANDS = new Set(["auth", "reconnect", "logout", "disable", "enable", "auto-connect", "on-demand"]);
const MCP_PROXY_PARAMETERS = Type.Object({
	tool: Type.Optional(Type.String({ description: "Tool name to call (e.g., 'xcodebuild_list_sims')" })),
	args: Type.Optional(
		Type.Union(
			[
				Type.String({ description: 'Arguments as a JSON string (e.g., \'{"key": "value"}\')' }),
				Type.Object(
					{},
					{
						additionalProperties: true,
						description: 'Arguments as a JSON object (e.g., { "key": "value" })',
					},
				),
			],
			{ description: "Tool arguments as a JSON object, or as a JSON string encoding one" },
		),
	),
	connect: Type.Optional(Type.String({ description: "Server name to connect (lazy connect + metadata refresh)" })),
	describe: Type.Optional(Type.String({ description: "Tool name to describe (shows parameters)" })),
	instructions: Type.Optional(Type.String({ description: "Server name to show that server's usage instructions" })),
	search: Type.Optional(Type.String({ description: "Search tools by name/description" })),
	includeSchemas: Type.Optional(
		Type.Boolean({ description: "Include parameter schemas in search results (default: true)" }),
	),
	// Raw JSON schema: host TypeBox shims may omit Type.Number (see index-lifecycle shim test).
	limit: Type.Optional({ type: "number", minimum: 1, description: "Maximum search results to return (default: 12)" }),
	offset: Type.Optional({ type: "number", minimum: 0, description: "Search result offset (default: 0)" }),
	server: Type.Optional(Type.String({ description: "Filter to specific server (also disambiguates tool calls)" })),
	action: Type.Optional(Type.String({ description: "Action: 'auth-start' or 'auth-complete'" })),
});

type McpAdapterRuntime = {
	currentCapability: EffectScopeOwner | null;
	currentOAuthRuntime: McpOAuthRuntime | null;
	currentOwner: McpRuntimeOwner | null;
	earlyConfigPath: string | undefined;
	foundation: EffectFoundation;
	initialization: Promise<Exit.Exit<McpExtensionState, Error>> | null;
	initializationToken: object | null;
	lifecycleGeneration: number;
	options: McpAdapterOptions;
	pi: McpAdapterExtensionAPI;
	sessionConfig: McpConfig | undefined;
	state: McpExtensionState | null;
};

type McpProxyParams = {
	action?: string;
	args?: string | JsonInputObject;
	connect?: string;
	describe?: string;
	includeSchemas?: boolean;
	instructions?: string;
	limit?: number;
	offset?: number;
	search?: string;
	server?: string;
	tool?: string;
};

type PersistentMcpCommand = "auto-connect" | "disable" | "enable" | "on-demand";

function cleanupMcpResources(
	owner: McpRuntimeOwner | null,
	oauthRuntime: McpOAuthRuntime | null,
	reason: string,
): Effect.Effect<void, Error> {
	return Effect.all(
		[
			owner ? Effect.exit(owner.stop(reason)) : Effect.succeed(Exit.void),
			oauthRuntime ? Effect.exit(mcpNativePromise(() => shutdownOAuth(oauthRuntime))) : Effect.succeed(Exit.void),
		] as const,
		{ concurrency: "unbounded" },
	).pipe(
		Effect.flatMap((exits) => {
			const failures = exits.flatMap((exit) => (Exit.isFailure(exit) ? [Cause.squash(exit.cause)] : []));
			return failures.length > 0
				? Effect.fail(new AggregateError(failures, "MCP Session cleanup failed"))
				: Effect.void;
		}),
	);
}

function startMcpInitialization(
	runtime: McpAdapterRuntime,
	ctx: McpInitializationContext,
	owner: McpRuntimeOwner,
	oauthRuntime: McpOAuthRuntime,
	generation: number,
	staleReason: string,
	capability?: EffectScopeOwner,
): void {
	const initializationOptions: McpAdapterOptions & {
		oauthRuntime: McpOAuthRuntime;
		statusEvents: McpExtensionState["statusEvents"];
	} = { oauthRuntime, statusEvents: runtime.pi.events };
	if (runtime.options.deferStartupConnections !== undefined) {
		initializationOptions.deferStartupConnections = runtime.options.deferStartupConnections;
	}
	if (runtime.sessionConfig !== undefined) initializationOptions.config = runtime.sessionConfig;
	if (
		runtime.sessionConfig === undefined &&
		runtime.options.configPath !== undefined &&
		runtime.earlyConfigPath !== undefined
	) {
		initializationOptions.configPath = runtime.earlyConfigPath;
	}
	const token = {};
	const isCurrent = () =>
		owner.isActive() &&
		generation === runtime.lifecycleGeneration &&
		runtime.initializationToken === token &&
		(capability === undefined || runtime.foundation.isCurrent(capability));
	const logCleanupFailure = (message: string) => (error: Error) => Effect.sync(() => logger.error(message, error));
	const program = initializeMcp(runtime.pi, ctx, owner, initializationOptions).pipe(
		Effect.tap((nextState) => {
			if (!isCurrent()) {
				return cleanupMcpResources(owner, oauthRuntime, staleReason).pipe(
					Effect.catch(logCleanupFailure("MCP: failed to clean stale initialization state")),
				);
			}
			return Effect.sync(() => {
				runtime.state = nextState;
				updateStatusBar(nextState);
			});
		}),
		Effect.tapError((error) => {
			if (!isCurrent()) return Effect.void;
			logger.error("MCP initialization failed", error);
			if (runtime.state) return Effect.void;
			return cleanupMcpResources(owner, oauthRuntime, "MCP initialization failed").pipe(
				Effect.catch(logCleanupFailure("MCP: failed to clean rejected initialization")),
			);
		}),
		Effect.ensuring(
			Effect.sync(() => {
				if (runtime.initializationToken !== token) return;
				runtime.initialization = null;
				runtime.initializationToken = null;
			}),
		),
	);
	runtime.initializationToken = token;
	runtime.initialization = capability
		? runtime.foundation.run(
				capability,
				Effect.addFinalizer(() =>
					cleanupMcpResources(owner, oauthRuntime, "MCP capability Scope closed").pipe(
						Effect.catch(logCleanupFailure("MCP: capability cleanup failed")),
					),
				).pipe(Effect.andThen(program)),
				{ signal: owner.signal },
			)
		: runMcpEffectExit(program, owner.signal);
}

function startLoadTimeMcpInitialization(runtime: McpAdapterRuntime): void {
	if (runtime.options.deferStartupConnections === true) return;
	setImmediate(() => {
		void runMcpEffect(
			Effect.gen(function* () {
				if (runtime.lifecycleGeneration !== 0 || runtime.state || runtime.initialization) return;
				const config =
					runtime.sessionConfig !== undefined
						? cloneMcpConfig(runtime.sessionConfig)
						: yield* loadMcpConfig(runtime.earlyConfigPath);
				const hasStartupServer = Object.values(config.mcpServers).some(
					(definition) =>
						definition.disabled !== true &&
						(definition.lifecycle === "eager" || definition.lifecycle === "keep-alive"),
				);
				if (!hasStartupServer || runtime.lifecycleGeneration !== 0 || runtime.state || runtime.initialization)
					return;
				const generation = ++runtime.lifecycleGeneration;
				const owner = createMcpRuntimeOwner();
				const oauthRuntime = createOAuthRuntime(owner.signal);
				runtime.currentOwner = owner;
				runtime.currentOAuthRuntime = oauthRuntime;
				startMcpInitialization(
					runtime,
					{ hasUI: false, cwd: process.cwd(), signal: undefined, ui: undefined },
					owner,
					oauthRuntime,
					generation,
					"stale_load_time_initialization",
				);
			}),
		).catch((error) => {
			logger.error(
				"MCP load-time initialization failed",
				error instanceof Error ? error : new Error(formatTerminalError(error)),
			);
		});
	});
}

function detachMcpSession(runtime: McpAdapterRuntime) {
	const detached = {
		oauthRuntime: runtime.currentOAuthRuntime,
		owner: runtime.currentOwner,
		state: runtime.state,
	};
	runtime.currentCapability = null;
	runtime.currentOwner = null;
	runtime.currentOAuthRuntime = null;
	runtime.state = null;
	runtime.initialization = null;
	runtime.initializationToken = null;
	return detached;
}

function cleanupMcpSession(
	detached: ReturnType<typeof detachMcpSession>,
	stopReason: string,
	stateReason: string,
	timeoutMessage: string,
	failureMessage: string,
): Effect.Effect<void> {
	const reason = detached.state ? stateReason : stopReason;
	return Effect.exit(cleanupMcpResources(detached.owner, detached.oauthRuntime, reason)).pipe(
		Effect.timeoutOption(HOST_SHUTDOWN_GRACE_MS),
		Effect.tap((result) =>
			Effect.sync(() => {
				if (Option.isNone(result)) {
					logger.error(timeoutMessage, new Error("cleanup timed out"));
					return;
				}
				if (Exit.isFailure(result.value)) {
					const error = Cause.squash(result.value.cause);
					logger.error(failureMessage, error instanceof Error ? error : new Error(formatTerminalError(error)));
				}
			}),
		),
		Effect.asVoid,
	);
}

function startMcpSession(runtime: McpAdapterRuntime, ctx: ExtensionContext): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		const generation = ++runtime.lifecycleGeneration;
		const previous = detachMcpSession(runtime);
		publishMcpStatusShutdown(runtime.pi.events);
		const capability = yield* Effect.try({
			try: () => {
				const session = runtime.foundation.sessionFor(ctx.sessionManager);
				if (!session || !runtime.foundation.isCurrent(session)) {
					throw new Error("MCP Session Scope was not initialized");
				}
				return runtime.foundation.forkCapability(session);
			},
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
		const owner = createMcpRuntimeOwner();
		const oauthRuntime = createOAuthRuntime(owner.signal);
		runtime.currentCapability = capability;
		runtime.currentOwner = owner;
		runtime.currentOAuthRuntime = oauthRuntime;
		yield* cleanupMcpSession(
			previous,
			"MCP extension session restarted",
			"session_restart",
			"MCP: previous session cleanup exceeded its shutdown deadline",
			"MCP: failed to shut down previous session state",
		);
		if (
			generation !== runtime.lifecycleGeneration ||
			!owner.isActive() ||
			!runtime.foundation.isCurrent(capability)
		) {
			return;
		}
		startMcpInitialization(runtime, ctx, owner, oauthRuntime, generation, "stale_session_start", capability);
	});
}

function shutdownMcpSession(runtime: McpAdapterRuntime): Effect.Effect<void> {
	return Effect.gen(function* () {
		++runtime.lifecycleGeneration;
		const detached = detachMcpSession(runtime);
		publishMcpStatusShutdown(runtime.pi.events);
		yield* cleanupMcpSession(
			detached,
			"MCP extension session shutdown",
			"session_shutdown",
			"MCP: session cleanup exceeded its shutdown deadline",
			"MCP: session shutdown cleanup failed",
		);
	});
}

function registerMcpLifecycle(runtime: McpAdapterRuntime): void {
	runtime.pi.on("session_start", (_event, ctx) => runMcpEffect(startMcpSession(runtime, ctx)));
	runtime.pi.on("session_shutdown", () => runMcpEffect(shutdownMcpSession(runtime)));
	runtime.pi.on("tool_result", (event) => toolErrorOverride(event.details));
}

function awaitMcpInitialization(runtime: McpAdapterRuntime): Effect.Effect<void, Error> {
	const initialization = runtime.initialization;
	if (!initialization) return Effect.void;
	return mcpNativePromise(() => initialization, runtime.currentOwner?.signal).pipe(
		Effect.flatMap((exit) => {
			if (Exit.isSuccess(exit)) return Effect.void;
			const error = Cause.squash(exit.cause);
			return Effect.fail(error instanceof Error ? error : new Error(formatTerminalError(error)));
		}),
	);
}

function getMcpCommandCompletions(runtime: McpAdapterRuntime, prefix: string) {
	const normalized = prefix.trimStart();
	const argumentMatch = normalized.match(/^(\S+)\s+(.*)$/);
	if (!argumentMatch) {
		const subcommands = MCP_COMMAND_COMPLETIONS.filter(({ value }) => value.startsWith(normalized));
		return subcommands.length > 0 ? [...subcommands] : null;
	}
	const [, subcommand = "", argumentPrefix = ""] = argumentMatch;
	if (!MCP_SERVER_COMMANDS.has(subcommand) || !runtime.state) return null;
	const servers = Object.keys(runtime.state.config.mcpServers)
		.filter((serverName) => serverName.startsWith(argumentPrefix.trimStart()))
		.map((serverName) => ({ value: `${subcommand} ${serverName}`, label: serverName }));
	return servers.length > 0 ? servers : null;
}

function handlePersistentMcpCommand(
	runtime: McpAdapterRuntime,
	state: McpExtensionState,
	commandCtx: McpCommandContext,
	commandReload: () => Promise<void>,
	commandOwner: McpRuntimeOwner | null,
	subcommand: PersistentMcpCommand,
	serverName: string | undefined,
): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		if (runtime.sessionConfig !== undefined) {
			commandCtx.ui?.notify(
				`/mcp ${subcommand} is unavailable when config is supplied by createMcpAdapter().`,
				"info",
			);
			return;
		}
		if (!serverName) {
			commandCtx.ui?.notify(`Usage: /mcp ${subcommand} <server>`, "error");
			return;
		}
		if (!Object.hasOwn(state.config.mcpServers, serverName)) {
			commandCtx.ui?.notify(`Server "${serverName}" not found in effective config`, "error");
			return;
		}
		commandOwner?.throwIfInactive();
		if (subcommand === "disable" || subcommand === "enable") {
			const disabled = subcommand === "disable";
			const result = yield* writeProjectServerDisabledOverride(
				runtime.earlyConfigPath,
				commandCtx.cwd,
				serverName,
				disabled,
			);
			if (!result.changed) {
				commandCtx.ui?.notify(`Server "${serverName}" is already ${disabled ? "disabled" : "enabled"}`, "info");
				return;
			}
			commandCtx.ui?.notify(
				`${disabled ? "Disabled" : "Enabled"} server "${serverName}" in ${result.path}. Reloading Pi…`,
				"info",
			);
			yield* mcpNativePromise(() => commandReload(), commandCtx.signal);
			return;
		}

		const autoConnect = subcommand === "auto-connect";
		const result = yield* writeProjectServerLifecycleOverride(
			commandCtx.cwd,
			serverName,
			autoConnect ? "keep-alive" : "lazy",
		);
		if (!result.changed) {
			commandCtx.ui?.notify(
				`Server "${serverName}" already uses ${autoConnect ? "automatic" : "on-demand"} connection`,
				"info",
			);
			return;
		}
		commandCtx.ui?.notify(
			`${autoConnect ? "Automatic" : "On-demand"} connection saved for "${serverName}" in ${result.path}. Reloading Pi…`,
			"info",
		);
		yield* mcpNativePromise(() => commandReload(), commandCtx.signal);
	});
}

function handleMcpCommand(
	runtime: McpAdapterRuntime,
	args: string,
	ctx: AdapterCommandContext,
): Effect.Effect<boolean | undefined, Error> {
	const commandOwner = runtime.currentOwner;
	const commandReload = isRuntimeFunction(ctx.reload) ? ctx.reload.bind(ctx) : async () => {};
	const commandCtx: McpCommandContext = {
		hasUI: ctx.hasUI,
		ui: ctx.hasUI ? (commandOwner ? createOwnedUi(ctx.ui, commandOwner) : ctx.ui) : undefined,
		cwd: ctx.cwd,
		signal: commandOwner?.signal ?? ctx.signal,
	};
	return Effect.gen(function* () {
		if (!runtime.state && runtime.initialization) {
			const initialized = yield* Effect.exit(awaitMcpInitialization(runtime));
			if (Exit.isFailure(initialized)) {
				const error = Cause.squash(initialized.cause);
				const message = error instanceof Error ? error.message : String(error);
				commandCtx.ui?.notify(`MCP initialization failed: ${message}`, "error");
				return;
			}
			commandOwner?.throwIfInactive();
		}
		const state = runtime.state;
		if (!state) {
			commandCtx.ui?.notify("MCP not initialized", "error");
			return;
		}
		const { authenticateServer, logoutServer, openMcpSetup, reconnectServer, reconnectServers, showStatus } =
			yield* mcpNativePromise(() => import("./commands.ts"), commandCtx.signal);

		const { subcommand, serverName } = parseMcpCommand(args);
		switch (subcommand) {
			case "auth": {
				if (!serverName) {
					commandCtx.ui?.notify("Usage: /mcp auth <server>", "error");
					return false;
				}
				commandOwner?.throwIfInactive();
				const result = yield* authenticateServer(
					serverName,
					state.config,
					commandCtx,
					commandCtx.signal,
					state.oauthRuntime,
				);
				if (result.ok) {
					commandOwner?.throwIfInactive();
					yield* reconnectServer(state, commandCtx, serverName);
				}
				return result.ok;
			}
			case "reconnect":
				commandOwner?.throwIfInactive();
				return yield* reconnectServers(state, commandCtx, serverName);
			case "setup": {
				commandOwner?.throwIfInactive();
				if (runtime.sessionConfig !== undefined) {
					commandCtx.ui?.notify("MCP setup is unavailable when config is supplied by createMcpAdapter().", "info");
					return;
				}
				const result = yield* openMcpSetup(state, runtime.pi, commandCtx, runtime.earlyConfigPath, "setup");
				if (!result.configChanged) return;
				commandOwner?.throwIfInactive();
				yield* mcpNativePromise(() => commandReload(), commandCtx.signal);
				return;
			}
			case "logout": {
				if (!serverName) {
					commandCtx.ui?.notify("Usage: /mcp logout <server>", "error");
					return false;
				}
				commandOwner?.throwIfInactive();
				return (yield* logoutServer(serverName, state, commandCtx)).ok;
			}
			case "disable":
			case "enable":
			case "auto-connect":
			case "on-demand":
				yield* handlePersistentMcpCommand(
					runtime,
					state,
					commandCtx,
					commandReload,
					commandOwner,
					subcommand,
					serverName,
				);
				return;
			default:
				commandOwner?.throwIfInactive();
				if (runtime.sessionConfig !== undefined) {
					commandCtx.ui?.notify(
						"MCP status is shown from the in-memory SDK config; configuration discovery is unavailable.",
						"info",
					);
				}
				showStatus(state, commandCtx);
		}
	});
}

function registerMcpCommandSurface(runtime: McpAdapterRuntime): void {
	runtime.pi.registerCommand("mcp", {
		description: "Show MCP server status",
		getArgumentCompletions: (prefix: string) => getMcpCommandCompletions(runtime, prefix),
		handler: (args: string, ctx: AdapterCommandContext) =>
			runMcpEffect(handleMcpCommand(runtime, args, ctx), runtime.currentOwner?.signal ?? ctx.signal),
	});
}

function proxyFailure(text: string, details: JsonInputObject): AgentToolResult<JsonInputObject> {
	return { content: [{ type: "text" as const, text }], details };
}

function parseMcpProxyArgs(params: McpProxyParams): JsonInputObject | undefined {
	if (params.args === undefined || params.args === "") return;
	if (!isRuntimeString(params.args)) return params.args;
	try {
		return parseJsonObject(params.args);
	} catch (error) {
		if (error instanceof SyntaxError) throw new Error(`Invalid args JSON: ${error.message}`, { cause: error });
		throw error;
	}
}

function executeMcpAuthAction(
	state: McpExtensionState,
	params: McpProxyParams,
	parsedArgs: JsonInputObject | undefined,
	signal: AbortSignal | undefined,
): Effect.Effect<ReturnType<typeof proxyFailure> | undefined, Error> {
	if (params.action !== "auth-start" && params.action !== "auth-complete") return Effect.succeed(undefined);
	return Effect.gen(function* () {
		const { executeAuthComplete, executeAuthStart } = yield* mcpNativePromise(
			() => import("./proxy-modes.ts"),
			signal,
		);
		if (params.action === "auth-start") {
			if (!params.server) {
				return proxyFailure(
					'auth-start requires `server`. Example: mcp({ action: "auth-start", server: "linear-server" })',
					{ mode: "auth-start", error: "missing_server" },
				);
			}
			return yield* executeAuthStart(state, params.server, signal);
		}
		if (!params.server) {
			return proxyFailure("auth-complete requires `server`.", {
				mode: "auth-complete",
				error: "missing_server",
			});
		}
		const input = parsedArgs?.["redirectUrl"] ?? parsedArgs?.["code"] ?? parsedArgs?.["input"];
		if (!isRuntimeString(input) || input.trim().length === 0) {
			return proxyFailure("auth-complete requires args with `redirectUrl`, `code`, or `input`.", {
				mode: "auth-complete",
				error: "missing_input",
			});
		}
		return yield* executeAuthComplete(state, params.server, input, signal);
	});
}

function executeMcpProxyTool(
	runtime: McpAdapterRuntime,
	params: McpProxyParams,
	signal: AbortSignal | undefined,
): Effect.Effect<ReturnType<typeof proxyFailure>, Error> {
	const executeOwner = runtime.currentOwner;
	return Effect.gen(function* () {
		const parsedArgs = yield* Effect.try({
			try: () => parseMcpProxyArgs(params),
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
		if (!runtime.state && runtime.initialization) {
			const initialized = yield* Effect.timeoutOption(
				Effect.exit(awaitMcpInitialization(runtime)),
				INIT_WAIT_TIMEOUT_MS,
			);
			if (Option.isNone(initialized)) {
				return proxyFailure("MCP initialization is still in progress. Try again shortly.", {
					error: "init_timeout",
					timeoutMs: INIT_WAIT_TIMEOUT_MS,
				});
			}
			if (Exit.isFailure(initialized.value)) {
				const error = Cause.squash(initialized.value.cause);
				if (executeOwner && isAbortError(error, executeOwner.signal)) {
					return yield* Effect.fail(error instanceof Error ? error : new Error(String(error)));
				}
				const message = error instanceof Error ? error.message : String(error);
				return proxyFailure(`MCP initialization failed: ${message}`, { error: "init_failed", message });
			}
			executeOwner?.throwIfInactive();
		}
		const state = runtime.state;
		if (!state) return proxyFailure("MCP not initialized", { error: "not_initialized" });
		executeOwner?.throwIfInactive();

		const authResult = yield* executeMcpAuthAction(state, params, parsedArgs, signal);
		if (authResult !== undefined) return authResult;
		if (params.tool) {
			const { executeCall } = yield* mcpNativePromise(() => import("./proxy-call.ts"), signal);
			return yield* executeCall(
				state,
				params.tool,
				parsedArgs,
				params.server,
				() => runtime.pi.getAllTools(),
				signal,
			);
		}
		const { executeConnect, executeDescribe, executeInstructions, executeList, executeSearch, executeStatus } =
			yield* mcpNativePromise(() => import("./proxy-modes.ts"), signal);
		if (params.connect) return yield* executeConnect(state, params.connect, signal);
		if (params.describe) return executeDescribe(state, params.describe);
		if (params.instructions) return executeInstructions(state, params.instructions);
		if (params.search !== undefined) {
			return executeSearch(
				state,
				params.search,
				false,
				params.server,
				params.includeSchemas,
				params.limit,
				params.offset,
			);
		}
		if (params.server) return executeList(state, params.server);
		return executeStatus(state);
	});
}

function registerMcpProxyTool(runtime: McpAdapterRuntime): void {
	runtime.pi.registerTool({
		name: "mcp",
		label: "MCP",
		description: "MCP gateway — status, search, describe, auth, and single tool calls",
		promptSnippet: "MCP gateway — status, search, describe, auth, and single MCP tool calls",
		renderCall: renderMcpProxyToolCall,
		parameters: MCP_PROXY_PARAMETERS,
		renderResult: renderMcpToolResult,
		execute: (_toolCallId, params: McpProxyParams, signal) =>
			runMcpEffect(executeMcpProxyTool(runtime, params, signal), signal),
	});
}

function installMcpAdapter(pi: McpAdapterExtensionAPI, options: McpAdapterOptions) {
	const sessionConfig = options.config !== undefined ? cloneMcpConfig(options.config) : undefined;
	const earlyConfigPath = sessionConfig !== undefined ? undefined : (options.configPath ?? getConfigPathFromArgv());
	const runtime: McpAdapterRuntime = {
		currentCapability: null,
		currentOAuthRuntime: null,
		currentOwner: null,
		earlyConfigPath,
		foundation: installEffectFoundation(pi),
		initialization: null,
		initializationToken: null,
		lifecycleGeneration: 0,
		options,
		pi,
		sessionConfig,
		state: null,
	};

	pi.registerFlag("mcp-config", {
		description: "Path to MCP config file",
		type: "string",
	});
	registerMcpLifecycle(runtime);
	registerMcpCommandSurface(runtime);
	registerMcpProxyTool(runtime);
	startLoadTimeMcpInitialization(runtime);
}

export function parseMcpCommand(args: string | undefined): ParsedMcpCommand {
	const match = args?.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
	const command: ParsedMcpCommand = {
		subcommand: match?.[1] ?? "",
	};
	if (match?.[2]) command.serverName = match[2];
	return command;
}

export function createMcpAdapter(options: McpAdapterOptions = {}) {
	const factoryConfig = options.config !== undefined ? cloneMcpConfig(options.config) : undefined;
	return function mcpAdapter(pi: McpAdapterExtensionAPI) {
		const adapterOptions: McpAdapterOptions = {};
		if (options.configPath !== undefined) adapterOptions.configPath = options.configPath;
		if (factoryConfig !== undefined) adapterOptions.config = cloneMcpConfig(factoryConfig);
		if (options.deferStartupConnections !== undefined) {
			adapterOptions.deferStartupConnections = options.deferStartupConnections;
		}
		installMcpAdapter(pi, adapterOptions);
	};
}

export default createMcpAdapter();
