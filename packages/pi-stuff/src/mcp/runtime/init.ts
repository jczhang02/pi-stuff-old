import { existsSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { cloneMcpConfig, loadMcpConfig } from "./config.ts";
import { McpLifecycleManager } from "./lifecycle.ts";
import { logger } from "./logger.ts";
import { getAuthStorageOptions } from "./mcp-auth.ts";
import { createOAuthRuntime, hasPendingAuth, type McpOAuthRuntime, shutdownOAuth } from "./mcp-auth-flow.ts";
import { publishMcpStatusSnapshot } from "./mcp-status.ts";
import {
	computeServerHash,
	getMetadataCachePath,
	isServerCacheValid,
	loadMetadataCache,
	METADATA_CACHE_VERSION,
	reconstructToolMetadata,
	type ServerCacheEntry,
	saveMetadataCache,
	serializeResources,
	serializeTools,
} from "./metadata-cache.ts";
import {
	combineAbortSignals,
	createMcpRuntimeOwner,
	createOwnedUi,
	isAbortError,
	type McpRuntimeOwner,
} from "./runtime-owner.ts";
import { McpServerManager } from "./server-manager.ts";
import type { McpExtensionState } from "./state.ts";
import { buildToolMetadata, totalToolCount } from "./tool-metadata.ts";
import {
	isServerDisabled,
	type McpAdapterOptions,
	type ServerDefinition,
	type ToolMetadata,
	type ToolPrefix,
} from "./types.ts";
import { formatMcpStatus, sanitizeTerminalText } from "./utils.ts";

const FAILURE_BACKOFF_MS = 60 * 1000;
const MAX_FAILURE_MESSAGE_CHARS = 8 * 1024;
const failureExpiryTimers = new WeakMap<McpExtensionState, Map<string, ReturnType<typeof setTimeout>>>();

function getFailureExpiryTimers(state: McpExtensionState): Map<string, ReturnType<typeof setTimeout>> {
	let timers = failureExpiryTimers.get(state);
	if (!timers) {
		timers = new Map();
		failureExpiryTimers.set(state, timers);
	}
	return timers;
}

export function clearFailure(state: McpExtensionState, serverName: string): void {
	state.failureTracker.delete(serverName);
	state.failureMessages?.delete(serverName);
	const timers = failureExpiryTimers.get(state);
	const timer = timers?.get(serverName);
	if (timer) clearTimeout(timer);
	timers?.delete(serverName);
}

export function recordFailure(state: McpExtensionState, serverName: string, message: string): void {
	clearFailure(state, serverName);
	const failedAt = Date.now();
	state.failureTracker.set(serverName, failedAt);
	state.failureMessages?.set(serverName, message.slice(0, MAX_FAILURE_MESSAGE_CHARS));
	const timer = setTimeout(() => {
		if (!state.owner.isActive()) {
			getFailureExpiryTimers(state).delete(serverName);
			return;
		}
		if (state.failureTracker.get(serverName) === failedAt) {
			state.failureTracker.delete(serverName);
			state.failureMessages?.delete(serverName);
			publishMcpStatusSnapshot(state);
		}
		getFailureExpiryTimers(state).delete(serverName);
	}, FAILURE_BACKOFF_MS);
	timer.unref?.();
	getFailureExpiryTimers(state).set(serverName, timer);
}

export interface McpInitializationContext {
	cwd: string;
	hasUI: boolean;
	signal: AbortSignal | undefined;
	ui: ExtensionContext["ui"] | undefined;
}

type McpInitializationOptions = McpAdapterOptions & {
	oauthRuntime?: McpOAuthRuntime;
	statusEvents?: McpExtensionState["statusEvents"];
};

type McpOwnedUi = ReturnType<typeof createOwnedUi>;

function prepareMcpServers(
	state: McpExtensionState,
	ui: McpOwnedUi | undefined,
	deferStartupConnections: boolean | undefined,
): { prefix: ToolPrefix; startupServers: [string, ServerDefinition][] } | undefined {
	const { config, lifecycle, resourceCounts, serverInstructions, toolMetadata } = state;
	const allServerEntries = Object.entries(config.mcpServers);
	const serverEntries = allServerEntries.filter(([, definition]) => !isServerDisabled(definition));
	if (serverEntries.length === 0) {
		if (allServerEntries.length > 0 && ui) {
			ui.notify(`MCP: All ${allServerEntries.length} server(s) are disabled`, "info");
		}
		return;
	}

	const idleSetting = isRuntimeNumber(config.settings?.idleTimeout) ? config.settings.idleTimeout : 10;
	lifecycle.setGlobalIdleTimeout(idleSetting);
	const cachePath = getMetadataCachePath();
	const cacheFileExists = existsSync(cachePath);
	let cache = loadMetadataCache();
	let bootstrapAll = false;
	if (!cacheFileExists) {
		bootstrapAll = true;
		saveMetadataCache({ version: METADATA_CACHE_VERSION, servers: {} });
	} else if (!cache) {
		cache = { version: METADATA_CACHE_VERSION, servers: {} };
		saveMetadataCache(cache);
	}

	const prefix = config.settings?.toolPrefix ?? "server";
	for (const [name, definition] of serverEntries) {
		const lifecycleMode = definition.lifecycle ?? "lazy";
		const persistsAfterFirstSpawn = lifecycleMode === "eager" || lifecycleMode === "lazy-keep-alive";
		const idleOverride = definition.idleTimeout ?? (persistsAfterFirstSpawn ? 0 : undefined);
		lifecycle.registerServer(
			name,
			definition,
			idleOverride !== undefined ? { idleTimeout: idleOverride } : undefined,
		);
		if (lifecycleMode === "keep-alive") lifecycle.markKeepAlive(name, definition);

		const cachedEntry = cache?.servers?.[name];
		if (!cachedEntry || !isServerCacheValid(cachedEntry, definition)) continue;
		toolMetadata.set(name, reconstructToolMetadata(name, cachedEntry, prefix, definition));
		if (Array.isArray(cachedEntry.resources)) resourceCounts.set(name, cachedEntry.resources.length);
		if (cachedEntry.instructions) serverInstructions.set(name, cachedEntry.instructions);
	}

	const startupServers =
		deferStartupConnections === true
			? []
			: bootstrapAll
				? serverEntries
				: serverEntries.filter(([, definition]) => {
						const mode = definition.lifecycle ?? "lazy";
						return mode === "keep-alive" || mode === "eager";
					});
	if (ui && startupServers.length > 0) {
		ui.setStatus("mcp", formatMcpStatus(config, `connecting to ${startupServers.length} servers...`));
	}
	return { prefix, startupServers };
}

function connectStartupServers(
	state: McpExtensionState,
	startupServers: [string, ServerDefinition][],
	prefix: ToolPrefix,
	ui: McpOwnedUi | undefined,
	initialSignal: AbortSignal | undefined,
	runtimeSignal: AbortSignal,
): Effect.Effect<boolean, Error> {
	return Effect.gen(function* () {
		const { manager, owner, resourceCounts, serverInstructions, toolMetadata } = state;
		const results = yield* Effect.forEach(
			startupServers,
			([name, definition]) =>
				manager.connectEffect(name, definition, runtimeSignal).pipe(
					Effect.map((connection) =>
						connection.status === "needs-auth"
							? {
									name,
									definition,
									connection: null,
									error: `OAuth authentication required. Run /mcp auth ${name}.`,
								}
							: { name, definition, connection, error: null },
					),
					Effect.catch((error) => {
						if (isAbortError(error, runtimeSignal) && owner.signal.aborted) return Effect.fail(error);
						return Effect.succeed({
							name,
							definition,
							connection: null,
							error: isAbortError(error, runtimeSignal)
								? null
								: error instanceof Error
									? error.message
									: String(error),
						});
					}),
				),
			{ concurrency: 10 },
		);
		if (initialSignal?.aborted) return false;
		owner.throwIfInactive();

		for (const { name, definition, connection, error } of results) {
			owner.throwIfInactive();
			if (error || !connection) {
				if (initialSignal?.aborted) continue;
				if (error) recordFailure(state, name, error);
				const displayError = sanitizeTerminalText(error ?? "Unknown connection failure");
				ui?.notify(`MCP: Failed to connect to ${name}: ${displayError}`, "error");
				logger.error(`MCP: Failed to connect to ${name}`, new Error(displayError), { server: name });
				continue;
			}

			const { metadata, failedTools } = buildToolMetadata(
				connection.tools,
				connection.resources,
				definition,
				name,
				prefix,
			);
			toolMetadata.set(name, metadata);
			resourceCounts.set(name, connection.resources.length);
			if (connection.instructions) serverInstructions.set(name, connection.instructions);
			else serverInstructions.delete(name);
			updateMetadataCache(state, name);
			notifyToolMetadataUpdated(state, name, "startup");
			markKeepAliveAfterConnect(state, name);
			if (failedTools.length > 0) ui?.notify(`MCP: ${name} - ${failedTools.length} tools skipped`, "warning");
		}

		const connectedCount = results.filter((result) => result.connection).length;
		const failedCount = results.filter((result) => result.error).length;
		if (ui && connectedCount > 0) {
			const totalTools = totalToolCount(state);
			const message =
				failedCount > 0
					? `MCP: ${connectedCount}/${startupServers.length} servers connected (${totalTools} tools)`
					: `MCP: ${connectedCount} servers connected (${totalTools} tools)`;
			ui.notify(message, "info");
		}
		return true;
	});
}

export function initializeMcp(
	pi: ExtensionAPI,
	ctx: McpInitializationContext,
	owner: McpRuntimeOwner = createMcpRuntimeOwner(),
	options: McpInitializationOptions = {},
): Effect.Effect<McpExtensionState, Error> {
	return Effect.gen(function* () {
		// Pi guards ExtensionContext getters after reload. Snapshot all values that
		// can be used by asynchronous work before the first await.
		const configFlag = options.config === undefined ? pi.getFlag("mcp-config") : undefined;
		const configPath =
			options.config !== undefined
				? undefined
				: (options.configPath ?? (isRuntimeString(configFlag) ? configFlag : undefined));
		const cwd = ctx.cwd;
		const hasUI = ctx.hasUI;
		const rawUi = hasUI ? ctx.ui : undefined;
		const initialSignal = ctx.signal;
		const ui = rawUi ? createOwnedUi(rawUi, owner) : undefined;
		const runtimeSignal = combineAbortSignals(owner.signal, initialSignal);
		const config =
			options.config !== undefined ? cloneMcpConfig(options.config) : yield* loadMcpConfig(configPath, cwd);
		const authStorageOptions = getAuthStorageOptions(config.settings?.oauthDir, cwd);

		const ownsOAuthRuntime = options.oauthRuntime === undefined;
		const oauthRuntime = options.oauthRuntime ?? createOAuthRuntime(owner.signal);
		const manager = yield* McpServerManager.make(owner, cwd);
		manager.setRuntimeSignal?.(owner.signal);
		manager.setOAuthRuntime?.(oauthRuntime);
		manager.setDefaultRequestTimeoutMs(config.settings?.requestTimeoutMs);
		manager.setTraceConfig?.(config.settings?.trace);
		manager.setAuthStorageOptions(authStorageOptions);
		const lifecycle = new McpLifecycleManager(manager, (serverName) =>
			hasPendingAuth(serverName, undefined, oauthRuntime),
		);
		const toolMetadata = new Map<string, ToolMetadata[]>();
		const resourceCounts = new Map<string, number>();
		const serverInstructions = new Map<string, string>();
		const failureTracker = new Map<string, number>();
		const failureMessages = new Map<string, string>();
		const approvedToolCalls = new Map<string, true>();
		const state: McpExtensionState = {
			owner,
			manager,
			lifecycle,
			toolMetadata,
			resourceCounts,
			serverInstructions,
			config,
			programmaticConfig: options.config !== undefined,
			oauthRuntime,
			authStorageOptions,
			failureTracker,
			failureMessages,
			approvedToolCalls,
		};
		if (ui !== undefined) state.ui = ui;
		if (options.statusEvents !== undefined) state.statusEvents = options.statusEvents;
		if (ownsOAuthRuntime) {
			yield* owner.addCleanup(() => shutdownOAuth(oauthRuntime));
		}
		manager.setMetadataListChangedListener?.((serverName, reason) => {
			if (!owner.isActive()) return;
			updateServerMetadata(state, serverName);
			updateMetadataCache(state, serverName, { preserveEmptyResources: false });
			notifyToolMetadataUpdated(state, serverName, reason);
			updateStatusBar(state);
		});
		yield* owner.addFinalizer(lifecycle.gracefulShutdown().pipe(Effect.orDie));
		yield* owner.addFinalizer(Effect.sync(() => flushMetadataCache(state)));

		const startup = prepareMcpServers(state, ui, options.deferStartupConnections);
		if (!startup) return state;
		if (
			!(yield* connectStartupServers(
				state,
				startup.startupServers,
				startup.prefix,
				ui,
				initialSignal,
				runtimeSignal,
			))
		) {
			return state;
		}

		lifecycle.setReconnectCallback((serverName) => {
			if (!owner.isActive()) return;
			updateServerMetadata(state, serverName);
			updateMetadataCache(state, serverName);
			notifyToolMetadataUpdated(state, serverName, "lifecycle-reconnect");
			clearFailure(state, serverName);
			updateStatusBar(state);
		});

		lifecycle.setReconnectFailureCallback((serverName, error) => {
			if (!owner.isActive()) return;
			const message = error instanceof Error ? error.message : String(error);
			recordFailure(state, serverName, message);
			updateStatusBar(state);
		});

		lifecycle.setIdleShutdownCallback((serverName) => {
			if (!owner.isActive()) return;
			const idleMinutes = getEffectiveIdleTimeoutMinutes(state, serverName);
			logger.debug(`${serverName} shut down (idle ${idleMinutes}m)`);
			updateStatusBar(state);
		});

		owner.throwIfInactive();
		yield* Scope.provide(owner.scope)(lifecycle.startHealthChecks(runtimeSignal));
		if (config.settings?.mcpFooterStatus === "off") {
			ui?.setStatus("mcp", undefined);
		}
		return state;
	});
}

export function markKeepAliveAfterConnect(state: McpExtensionState, serverName: string): void {
	const definition = state.config.mcpServers[serverName];
	if (!definition || isServerDisabled(definition)) return;
	if ((definition.lifecycle ?? "lazy") === "lazy-keep-alive") {
		state.lifecycle.markKeepAlive(serverName, definition);
	}
}

export function updateServerMetadata(state: McpExtensionState, serverName: string): void {
	const connection = state.manager.getConnection(serverName);
	if (connection?.status !== "connected") return;

	const definition = state.config.mcpServers[serverName];
	if (!definition) return;
	if (isServerDisabled(definition)) {
		state.toolMetadata.delete(serverName);
		state.resourceCounts?.delete(serverName);
		state.serverInstructions.delete(serverName);
		return;
	}

	const prefix = state.config.settings?.toolPrefix ?? "server";

	const { metadata } = buildToolMetadata(connection.tools, connection.resources, definition, serverName, prefix);
	state.toolMetadata.set(serverName, metadata);
	state.resourceCounts?.set(serverName, connection.resources.length);
	if (connection.instructions) {
		state.serverInstructions?.set(serverName, connection.instructions);
	} else {
		state.serverInstructions?.delete(serverName);
	}
}

export function updateMetadataCache(
	state: McpExtensionState,
	serverName: string,
	options: { preserveEmptyResources?: boolean } = {},
): void {
	const connection = state.manager.getConnection(serverName);
	if (connection?.status !== "connected") return;

	const definition = state.config.mcpServers[serverName];
	if (!definition || isServerDisabled(definition)) return;

	const configHash = computeServerHash(definition);
	const existing = loadMetadataCache();
	const existingEntry = existing?.servers?.[serverName];

	const tools = serializeTools(connection.tools);
	let resources = definition.exposeResources === false ? [] : serializeResources(connection.resources);

	if (
		definition.exposeResources !== false &&
		resources.length === 0 &&
		existingEntry?.resources?.length &&
		existingEntry.configHash === configHash &&
		options.preserveEmptyResources !== false
	) {
		resources = existingEntry.resources;
	}

	const entry: ServerCacheEntry = {
		configHash,
		tools,
		resources,
		cachedAt: Date.now(),
	};
	if (connection.instructions !== undefined) entry.instructions = connection.instructions;

	saveMetadataCache({ version: METADATA_CACHE_VERSION, servers: { [serverName]: entry } });
}

export function notifyToolMetadataUpdated(state: McpExtensionState, serverName: string, reason: string): void {
	try {
		const result = state.onToolMetadataUpdated?.(serverName, reason);
		if (result) {
			result.catch((error) => {
				const message = error instanceof Error ? error.message : String(error);
				logger.debug(`MCP: metadata update hook failed for ${serverName}: ${message}`);
			});
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.debug(`MCP: metadata update hook failed for ${serverName}: ${message}`);
	}
}

export function flushMetadataCache(state: McpExtensionState): void {
	for (const [name, connection] of state.manager.getAllConnections()) {
		if (connection.status === "connected") {
			updateMetadataCache(state, name);
		}
	}
}

export function updateStatusBar(state: McpExtensionState): void {
	publishMcpStatusSnapshot(state);
	const ui = state.ui;
	if (!ui) return;
	const entries = Object.entries(state.config.mcpServers);
	const disabledCount = entries.filter(([, definition]) => isServerDisabled(definition)).length;
	const enabledCount = entries.length - disabledCount;
	if (entries.length === 0) {
		ui.setStatus("mcp", undefined);
		return;
	}
	const connectedCount = [...state.manager.getAllConnections()].filter(([name, connection]) => {
		const definition = state.config.mcpServers[name];
		return connection.status === "connected" && definition !== undefined && !isServerDisabled(definition);
	}).length;
	const footerStatus = state.config.settings?.mcpFooterStatus ?? "full";
	if (footerStatus === "off") {
		ui.setStatus("mcp", undefined);
		return;
	}

	let status =
		footerStatus === "compact"
			? `MCP ${connectedCount}/${enabledCount}`
			: `${enabledCount} ${enabledCount === 1 ? "server" : "servers"} enabled`;
	if (footerStatus === "full") {
		if (connectedCount > 0) status += ` (${connectedCount} connected)`;
		if (disabledCount > 0) status += ` (${disabledCount} disabled)`;
	}
	const formattedStatus = footerStatus === "compact" ? status : formatMcpStatus(state.config, status);
	if (formattedStatus === undefined) {
		ui.setStatus("mcp", undefined);
		return;
	}
	ui.setStatus("mcp", ui.theme ? ui.theme.fg("accent", formattedStatus) : formattedStatus);
}

export function getFailureAgeSeconds(state: McpExtensionState, serverName: string): number | null {
	const failedAt = state.failureTracker.get(serverName);
	if (!failedAt) return null;
	const ageMs = Date.now() - failedAt;
	if (ageMs > FAILURE_BACKOFF_MS) return null;
	return Math.round(ageMs / 1000);
}

export function getFailureMessage(state: McpExtensionState, serverName: string): string | null {
	if (getFailureAgeSeconds(state, serverName) === null) return null;
	return state.failureMessages?.get(serverName) ?? null;
}

export function lazyConnect(
	state: McpExtensionState,
	serverName: string,
	signal?: AbortSignal,
	reason = "lazy-connect",
): Effect.Effect<boolean, Error> {
	const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
	return Effect.try({
		try: () => ownedSignal?.throwIfAborted(),
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	}).pipe(
		Effect.andThen(
			Effect.gen(function* () {
				const connection = state.manager.getConnection(serverName);
				if (connection?.status === "needs-auth") return false;
				if (connection?.status === "connected") {
					updateServerMetadata(state, serverName);
					markKeepAliveAfterConnect(state, serverName);
					return true;
				}

				if (getFailureAgeSeconds(state, serverName) !== null) return false;
				const definition = state.config.mcpServers[serverName];
				if (!definition || isServerDisabled(definition)) return false;

				if (state.ui) {
					const status = formatMcpStatus(state.config, `connecting to ${serverName}...`);
					state.ui.setStatus("mcp", status);
				}
				const newConnection = yield* state.manager.connectEffect(serverName, definition, ownedSignal);
				if (newConnection.status === "needs-auth") return false;
				clearFailure(state, serverName);
				updateServerMetadata(state, serverName);
				updateMetadataCache(state, serverName);
				notifyToolMetadataUpdated(state, serverName, reason);
				markKeepAliveAfterConnect(state, serverName);
				updateStatusBar(state);
				return true;
			}),
		),
		Effect.catch((error) => {
			if (ownedSignal?.aborted) {
				return Effect.fail(ownedSignal.reason instanceof Error ? ownedSignal.reason : error);
			}
			return Effect.sync(() => {
				const message = error instanceof Error ? error.message : String(error);
				recordFailure(state, serverName, message);
				logger.debug(`MCP: lazy connect failed for ${serverName}: ${sanitizeTerminalText(message)}`);
				updateStatusBar(state);
				return false;
			});
		}),
	);
}

function getEffectiveIdleTimeoutMinutes(state: McpExtensionState, serverName: string): number {
	const definition = state.config.mcpServers[serverName];
	if (!definition) {
		return isRuntimeNumber(state.config.settings?.idleTimeout) ? state.config.settings.idleTimeout : 10;
	}
	if (isRuntimeNumber(definition.idleTimeout)) return definition.idleTimeout;
	const mode = definition.lifecycle ?? "lazy";
	if (mode === "eager" || mode === "lazy-keep-alive") return 0;
	return isRuntimeNumber(state.config.settings?.idleTimeout) ? state.config.settings.idleTimeout : 10;
}
