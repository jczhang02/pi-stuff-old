import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { JsonInputObject } from "../../shared/json-value.ts";
import { throwIfAborted } from "./abort.ts";
import {
	clearFailure,
	getFailureAgeSeconds,
	markKeepAliveAfterConnect,
	notifyToolMetadataUpdated,
	recordFailure,
	updateMetadataCache,
	updateServerMetadata,
	updateStatusBar,
} from "./init.ts";
import {
	type AuthenticateOptions,
	authenticate,
	completeAuthFromInput,
	startAuth,
	supportsOAuth,
} from "./mcp-auth-flow.ts";
import { mcpNativePromise } from "./mcp-effect-runner.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { paginate, rankSuggestions, rankToolMatches } from "./search-ranking.ts";
import type { McpExtensionState } from "./state.ts";
import { isToolCallApprovalRequired } from "./tool-approval.ts";
import { findToolByName, formatSchema } from "./tool-metadata.ts";
import { renderTsType } from "./ts-shape.ts";
import type { ToolMetadata } from "./types.ts";
import { isServerDisabled } from "./types.ts";
import { formatAuthRequiredMessage, formatMcpStatus, resolveServerUrl, truncateAtWord } from "./utils.ts";

type ProxyToolResult = AgentToolResult<JsonInputObject>;

const INSTRUCTIONS_PREVIEW_LENGTH = 300;

export type AutoAuthResult = { status: "skipped" } | { status: "success" } | { status: "failed"; message: string };

export function proxyTextResult(mode: string, text: string, details: JsonInputObject = {}): ProxyToolResult {
	return { content: [{ type: "text", text }], details: { mode, ...details } };
}

export function disabledResult(mode: string, serverName: string, details: JsonInputObject = {}): ProxyToolResult {
	const message = `Server "${serverName}" is disabled. Run /mcp enable ${serverName} and /reload to enable it.`;
	return proxyTextResult(mode, message, { error: "server_disabled", server: serverName, ...details, message });
}

export function missingServerResult(mode: string, serverName: string, details: JsonInputObject = {}): ProxyToolResult {
	return proxyTextResult(mode, `Server "${serverName}" not found. Use mcp({}) to see available servers.`, {
		error: "not_found",
		server: serverName,
		...details,
	});
}

function authOptions(state: McpExtensionState, signal?: AbortSignal): AuthenticateOptions {
	const options: AuthenticateOptions = {
		authStorageOptions: state.authStorageOptions,
		runtime: state.oauthRuntime,
	};
	if (signal) options.signal = signal;
	return options;
}

function ensureNotAborted(signal?: AbortSignal): Effect.Effect<void, Error> {
	return Effect.try({
		try: () => throwIfAborted(signal),
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});
}

export function getAuthRequiredMessage(
	state: McpExtensionState,
	serverName: string,
	defaultMessage = `Server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp auth ${serverName} in an interactive local session.`,
): string {
	return formatAuthRequiredMessage(state.config, serverName, defaultMessage);
}

function getAuthFailedMessage(state: McpExtensionState, serverName: string, message: string): string {
	const customGuidance = state.config.settings?.authRequiredMessage;
	if (customGuidance) {
		return `OAuth authentication failed for "${serverName}": ${message}. ${getAuthRequiredMessage(state, serverName)}`;
	}
	return `OAuth authentication failed for "${serverName}": ${message}. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp auth ${serverName} in an interactive local session.`;
}

function getRedirectPort(authorizationUrl: string): number | undefined {
	try {
		const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri");
		if (!redirectUri) return undefined;
		const port = Number.parseInt(new URL(redirectUri).port, 10);
		return Number.isInteger(port) ? port : undefined;
	} catch {
		return undefined;
	}
}

function formatManualAuthInstructions(serverName: string, authorizationUrl: string): string {
	const port = getRedirectPort(authorizationUrl);
	const portNote = port
		? `\nThe redirect URL will use local port ${port}. On a remote server it is expected for that localhost page to fail locally; copy the address bar URL anyway.`
		: "";

	return [
		`MCP OAuth required for "${serverName}".`,
		"",
		"Open this URL in your local browser:",
		"",
		authorizationUrl,
		"",
		"After approving, copy the full redirected localhost URL from your browser address bar and send it back with:",
		`mcp({ action: "auth-complete", server: "${serverName}", args: { redirectUrl: "PASTE_REDIRECT_URL_HERE" } })`,
		"",
		'You can also pass just the `code` query parameter as `args: { code: "PASTE_CODE_HERE" }`. JSON-string args remain supported.',
		portNote.trimEnd(),
	]
		.filter(Boolean)
		.join("\n");
}

export function attemptAutoAuth(
	state: McpExtensionState,
	serverName: string,
	signal?: AbortSignal,
): Effect.Effect<AutoAuthResult, Error> {
	return Effect.gen(function* () {
		if (state.config.settings?.autoAuth !== true) return { status: "skipped" } as const;

		const definition = state.config.mcpServers[serverName];
		if (!definition || isServerDisabled(definition) || !supportsOAuth(definition)) {
			return { status: "skipped" } as const;
		}

		let serverUrl: string | undefined;
		try {
			serverUrl = resolveServerUrl(definition);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { status: "failed", message: getAuthFailedMessage(state, serverName, message) } as const;
		}
		if (!serverUrl) return { status: "skipped" } as const;

		const grantType = definition.oauth ? (definition.oauth.grantType ?? "authorization_code") : "authorization_code";
		if (!state.ui && grantType !== "client_credentials") {
			return {
				status: "failed",
				message: getAuthRequiredMessage(
					state,
					serverName,
					`Server "${serverName}" requires OAuth authentication. Run mcp({ action: "auth-start", server: "${serverName}" }) to get a browser URL, or /mcp auth ${serverName} in an interactive local session.`,
				),
			} as const;
		}

		yield* mcpNativePromise(
			(effectSignal) => authenticate(serverName, serverUrl, definition, authOptions(state, effectSignal)),
			signal,
		);
		return { status: "success" } as const;
	}).pipe(
		Effect.catch((error) => {
			if (isAbortError(error, signal)) return Effect.fail(error);
			const message = error instanceof Error ? error.message : String(error);
			return Effect.succeed({
				status: "failed" as const,
				message: getAuthFailedMessage(state, serverName, message),
			});
		}),
	);
}

export function executeStatus(state: McpExtensionState): ProxyToolResult {
	const servers: Array<{
		name: string;
		status: string;
		toolCount: number;
		failedAgo: number | null;
		disabled?: boolean;
	}> = [];

	for (const name of Object.keys(state.config.mcpServers)) {
		const definition = state.config.mcpServers[name];
		const disabled = isServerDisabled(definition);
		const connection = disabled ? undefined : state.manager.getConnection(name);
		const metadata = disabled ? undefined : state.toolMetadata.get(name);
		const toolCount = metadata?.length ?? 0;
		const failedAgo = disabled ? null : getFailureAgeSeconds(state, name);
		const status = disabled
			? "disabled"
			: connection?.status === "connected"
				? "connected"
				: connection?.status === "needs-auth"
					? "needs-auth"
					: failedAgo !== null
						? "failed"
						: metadata === undefined
							? "not connected"
							: "cached";
		servers.push({ name, status, toolCount, failedAgo, disabled });
	}

	const disabledCount = servers.filter((s) => s.disabled).length;
	const enabledServers = servers.filter((s) => !s.disabled);
	const totalTools = enabledServers.reduce((sum, s) => sum + s.toolCount, 0);
	const connectedCount = enabledServers.filter((s) => s.status === "connected").length;

	let text = `MCP: ${connectedCount}/${enabledServers.length} servers, ${totalTools} tools`;
	if (disabledCount > 0) text += ` (${disabledCount} disabled)`;
	text += "\n\n";
	for (const server of servers) {
		const line = server.disabled
			? `⊘ ${server.name} (disabled)`
			: server.status === "connected"
				? `✓ ${server.name} (${server.toolCount} tools)`
				: server.status === "needs-auth"
					? `⚠ ${server.name} (needs auth)`
					: server.status === "cached"
						? `○ ${server.name} (${server.toolCount} tools, cached)`
						: server.status === "failed"
							? `✗ ${server.name} (failed ${server.failedAgo ?? 0}s ago)`
							: `○ ${server.name} (not connected)`;
		text += `${line}\n`;
	}

	if (servers.length > 0) {
		text += `\nmcp({ server: "name" }) to list tools, mcp({ search: "..." }) to search`;
	}

	return proxyTextResult("status", text.trim(), { servers, totalTools, connectedCount, disabledCount });
}

export function executeAuthStart(
	state: McpExtensionState,
	serverName: string,
	signal?: AbortSignal,
): Effect.Effect<ProxyToolResult, Error> {
	const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
	return ensureNotAborted(ownedSignal).pipe(
		Effect.andThen(
			Effect.gen(function* () {
				const definition = state.config.mcpServers[serverName];
				if (!definition) return missingServerResult("auth-start", serverName);
				if (isServerDisabled(definition)) return disabledResult("auth-start", serverName);

				const serverUrl = resolveServerUrl(definition);
				if (!serverUrl || !supportsOAuth(definition)) {
					return proxyTextResult("auth-start", `Server "${serverName}" is not configured for OAuth over HTTP.`, {
						error: "oauth_not_supported",
						server: serverName,
					});
				}

				const { authorizationUrl } = yield* mcpNativePromise(
					(effectSignal) => startAuth(serverName, serverUrl, definition, authOptions(state, effectSignal)),
					ownedSignal,
				);
				if (!authorizationUrl) {
					return proxyTextResult("auth-start", `OAuth authentication successful for "${serverName}".`, {
						server: serverName,
						authenticated: true,
					});
				}

				return proxyTextResult("auth-start", formatManualAuthInstructions(serverName, authorizationUrl), {
					server: serverName,
					authorizationUrl,
				});
			}).pipe(
				Effect.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					return Effect.succeed(
						proxyTextResult("auth-start", `Failed to start OAuth for "${serverName}": ${message}`, {
							error: "auth_start_failed",
							server: serverName,
							message,
						}),
					);
				}),
			),
		),
	);
}

export function executeAuthComplete(
	state: McpExtensionState,
	serverName: string,
	input: string,
	signal?: AbortSignal,
): Effect.Effect<ProxyToolResult, Error> {
	const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
	return ensureNotAborted(ownedSignal).pipe(
		Effect.andThen(
			Effect.gen(function* () {
				const definition = state.config.mcpServers[serverName];
				if (!definition) return missingServerResult("auth-complete", serverName);
				if (isServerDisabled(definition)) return disabledResult("auth-complete", serverName);

				const status = yield* mcpNativePromise(
					(effectSignal) => completeAuthFromInput(serverName, input, authOptions(state, effectSignal)),
					ownedSignal,
				);
				if (status !== "authenticated") {
					return proxyTextResult("auth-complete", `OAuth authentication did not complete for "${serverName}".`, {
						error: "not_authenticated",
						server: serverName,
						status,
					});
				}

				yield* state.manager.closeEffect(serverName);
				clearFailure(state, serverName);
				updateStatusBar(state);
				return proxyTextResult(
					"auth-complete",
					`OAuth authentication successful for "${serverName}". Run mcp({ connect: "${serverName}" }) to connect with the new token.`,
					{ server: serverName, authenticated: true },
				);
			}).pipe(
				Effect.catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					return Effect.succeed(
						proxyTextResult("auth-complete", `Failed to complete OAuth for "${serverName}": ${message}`, {
							error: "auth_complete_failed",
							server: serverName,
							message,
						}),
					);
				}),
			),
		),
	);
}

export function executeDescribe(state: McpExtensionState, toolName: string): ProxyToolResult {
	let serverName: string | undefined;
	let toolMeta: ToolMetadata | undefined;
	let disabledMatch: string | undefined;

	for (const [server, metadata] of state.toolMetadata.entries()) {
		const found = findToolByName(metadata, toolName);
		if (!found) continue;
		if (isServerDisabled(state.config.mcpServers[server])) {
			disabledMatch ??= server;
			continue;
		}
		serverName = server;
		toolMeta = found;
		break;
	}

	if (!serverName || !toolMeta) {
		if (disabledMatch) return disabledResult("describe", disabledMatch);
		const suggestions = rankSuggestions(state, toolName, 5);
		const suggestionText = suggestions.length > 0 ? ` Did you mean: ${suggestions.join(", ")}` : "";
		return proxyTextResult(
			"describe",
			`Tool "${toolName}" not found. Use mcp({ search: "..." }) to search.${suggestionText}`,
			{
				error: "tool_not_found",
				requestedTool: toolName,
				suggestions,
			},
		);
	}

	const approvalMarker = isToolCallApprovalRequired(state.config, serverName, toolMeta) ? " (requires approval)" : "";
	let text = `${toolMeta.name}${approvalMarker}\n`;
	text += `Server: ${serverName}\n`;
	if (toolMeta.resourceUri) {
		text += `Type: Resource (reads from ${toolMeta.resourceUri})\n`;
	}
	text += `\n${toolMeta.description || "(no description)"}\n`;

	if (toolMeta.inputSchema && !toolMeta.resourceUri) {
		const renderedType = renderTsType(toolMeta.inputSchema);
		text +=
			renderedType === null ? `\nParameters:\n${formatSchema(toolMeta.inputSchema)}` : `\nShape:\n${renderedType}`;
	} else if (toolMeta.resourceUri) {
		text += `\nNo parameters required (resource tool).`;
	} else {
		text += `\nNo parameters defined.`;
	}

	return proxyTextResult("describe", text.trim(), { tool: toolMeta, server: serverName });
}

export function executeSearch(
	state: McpExtensionState,
	query: string,
	regex?: boolean,
	server?: string,
	includeSchemas?: boolean,
	limit = 12,
	offset = 0,
): ProxyToolResult {
	const showSchemas = includeSchemas !== false;
	if (server && isServerDisabled(state.config.mcpServers[server])) return disabledResult("search", server);

	let matches: Array<{ server: string; tool: ToolMetadata; score: number }>;
	if (regex) {
		return proxyTextResult(
			"search",
			"Regex MCP tool search is unavailable in the Pi Stuff fork. Use literal search terms instead.",
			{ error: "regex_unavailable", query },
		);
	} else if (query.trim().length === 0) {
		if (!server) {
			return proxyTextResult("search", "Search query cannot be empty", { error: "empty_query" });
		}
		matches = (state.toolMetadata.get(server) ?? [])
			.map((tool) => ({ server, tool, score: 0 }))
			.sort((a, b) => a.tool.name.localeCompare(b.tool.name));
	} else {
		matches = rankToolMatches(state, query, server);
	}

	const page = paginate(matches, offset, limit);
	if (page.total === 0) {
		const msg = server ? `No tools matching "${query}" in "${server}"` : `No tools matching "${query}"`;
		return proxyTextResult("search", msg, {
			matches: [],
			count: 0,
			hasMore: false,
			nextOffset: null,
			query,
		});
	}

	let text = `Found ${page.total} tool${page.total === 1 ? "" : "s"} matching "${query}":\n\n`;
	for (const match of page.items) {
		const approvalMarker = isToolCallApprovalRequired(state.config, match.server, match.tool)
			? " (requires approval)"
			: "";
		if (showSchemas) {
			text += `${match.tool.name}${approvalMarker}\n`;
			text += `  ${match.tool.description || "(no description)"}\n`;
			if (match.tool.inputSchema && !match.tool.resourceUri) {
				const renderedType = renderTsType(match.tool.inputSchema);
				text +=
					renderedType === null
						? `\n  Parameters:\n${formatSchema(match.tool.inputSchema, "    ")}\n`
						: `\n  Shape:\n${renderedType
								.split("\n")
								.map((line) => `    ${line}`)
								.join("\n")}\n`;
			} else if (match.tool.resourceUri) {
				text += "  No parameters (resource tool).\n";
			}
			text += "\n";
		} else {
			text += `- ${match.tool.name}${approvalMarker}`;
			if (match.tool.description) text += ` - ${truncateAtWord(match.tool.description, 50)}`;
			text += "\n";
		}
	}
	if (page.hasMore) text += `\n${page.items.length} of ${page.total} — offset: ${page.nextOffset} for more\n`;

	return proxyTextResult("search", text.trim(), {
		matches: page.items.map((match) => ({ server: match.server, tool: match.tool.name, score: match.score })),
		count: page.total,
		hasMore: page.hasMore,
		nextOffset: page.nextOffset,
		query,
	});
}

export function executeList(state: McpExtensionState, server: string): ProxyToolResult {
	const definition = state.config.mcpServers[server];
	if (!definition) return missingServerResult("list", server, { tools: [], count: 0 });
	if (isServerDisabled(definition)) return disabledResult("list", server);

	const metadata = state.toolMetadata.get(server);
	const toolNames = metadata?.map((m) => m.name) ?? [];
	const connection = state.manager.getConnection(server);
	const instructions = state.serverInstructions.get(server);
	let instructionsText = "";
	if (instructions) {
		const preview = truncateAtWord(instructions, INSTRUCTIONS_PREVIEW_LENGTH);
		instructionsText = `\n\nServer instructions:\n${preview}`;
		if (preview !== instructions) {
			instructionsText += `\nUse mcp({ instructions: "${server}" }) for the full text.`;
		}
	}

	if (toolNames.length === 0) {
		if (connection?.status === "connected") {
			return proxyTextResult("list", `Server "${server}" has no tools.${instructionsText}`, {
				server,
				tools: [],
				count: 0,
				hasInstructions: Boolean(instructions),
			});
		}
		if (metadata !== undefined) {
			return proxyTextResult("list", `Server "${server}" has no cached tools (not connected).${instructionsText}`, {
				server,
				tools: [],
				count: 0,
				cached: true,
				hasInstructions: Boolean(instructions),
			});
		}
		return proxyTextResult(
			"list",
			`Server "${server}" is configured but not connected. Use mcp({ connect: "${server}" }) or /mcp reconnect ${server} to retry.${instructionsText}`,
			{ server, tools: [], count: 0, error: "not_connected", hasInstructions: Boolean(instructions) },
		);
	}

	const cachedNote = connection?.status === "connected" ? "" : " (not connected, cached)";
	let text = `${server} (${toolNames.length} tools${cachedNote}):\n\n`;

	for (const tool of metadata ?? []) {
		const truncated = truncateAtWord(tool.description, 50);
		text += `- ${tool.name}`;
		if (truncated) text += ` - ${truncated}`;
		text += "\n";
	}

	text += instructionsText;

	return proxyTextResult("list", text.trim(), {
		server,
		tools: toolNames,
		count: toolNames.length,
		hasInstructions: Boolean(instructions),
	});
}

export function executeInstructions(state: McpExtensionState, server: string): ProxyToolResult {
	const definition = state.config.mcpServers[server];
	if (!definition) return missingServerResult("instructions", server);
	if (isServerDisabled(definition)) return disabledResult("instructions", server);

	const instructions = state.serverInstructions.get(server);
	if (instructions) {
		return proxyTextResult("instructions", `${server} instructions:\n\n${instructions}`, {
			server,
			length: instructions.length,
		});
	}

	const connection = state.manager.getConnection(server);
	if (connection?.status === "connected") {
		return proxyTextResult("instructions", `Server "${server}" does not provide instructions.`, {
			server,
			error: "no_instructions",
		});
	}

	return proxyTextResult(
		"instructions",
		`No instructions cached for "${server}". Use mcp({ connect: "${server}" }) to connect and refresh.`,
		{ server, error: "not_connected" },
	);
}

export function executeConnect(
	state: McpExtensionState,
	serverName: string,
	signal?: AbortSignal,
): Effect.Effect<ProxyToolResult, Error> {
	const ownedSignal = combineAbortSignals(state.owner?.signal, signal);
	return ensureNotAborted(ownedSignal).pipe(
		Effect.andThen(
			Effect.gen(function* () {
				const definition = state.config.mcpServers[serverName];
				if (!definition) return missingServerResult("connect", serverName);
				if (isServerDisabled(definition)) return disabledResult("connect", serverName);

				if (state.ui) {
					state.ui.setStatus("mcp", formatMcpStatus(state.config, `connecting to ${serverName}...`));
				}
				const currentConnection = state.manager.getConnection(serverName);
				let connection =
					currentConnection?.status === "connected"
						? yield* state.manager.reconnectEffect(serverName, definition, currentConnection, ownedSignal)
						: yield* state.manager.connectEffect(serverName, definition, ownedSignal);
				if (connection.status === "needs-auth") {
					const autoAuth = yield* attemptAutoAuth(state, serverName, ownedSignal);
					if (autoAuth.status === "failed") {
						return proxyTextResult("connect", autoAuth.message, {
							error: "auth_required",
							server: serverName,
							message: autoAuth.message,
						});
					}
					if (autoAuth.status === "success") {
						yield* state.manager.closeEffect(serverName);
						yield* ensureNotAborted(ownedSignal);
						connection = yield* state.manager.connectEffect(serverName, definition, ownedSignal);
					}
					if (connection.status === "needs-auth") {
						const message = getAuthRequiredMessage(state, serverName);
						return proxyTextResult("connect", message, {
							error: "auth_required",
							server: serverName,
							message,
						});
					}
				}
				clearFailure(state, serverName);
				updateServerMetadata(state, serverName);
				updateMetadataCache(state, serverName);
				notifyToolMetadataUpdated(state, serverName, "proxy-connect");
				markKeepAliveAfterConnect(state, serverName);
				updateStatusBar(state);
				return executeList(state, serverName);
			}).pipe(
				Effect.catch((error) =>
					Effect.sync(() => {
						const message = error instanceof Error ? error.message : String(error);
						if (!isAbortError(error, ownedSignal)) recordFailure(state, serverName, message);
						updateStatusBar(state);
						return proxyTextResult("connect", `Failed to connect to "${serverName}": ${message}`, {
							error: isAbortError(error, ownedSignal) ? "aborted" : "connect_failed",
							server: serverName,
							message,
						});
					}),
				),
			),
		),
	);
}
