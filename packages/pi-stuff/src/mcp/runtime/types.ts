// types.ts - Core type definitions

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { Transport as McpTransport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";

export type Transport = McpTransport;

/** Versioned shared-event-bus channel for read-only MCP runtime snapshots. */
export const MCP_STATUS_EVENT = "pi-mcp-adapter/status/v1";

export const MCP_STATUS_SNAPSHOT_VERSION = 1 as const;

export type McpServerRuntimeStatus = "connected" | "cached" | "failed" | "needs-auth" | "not-connected" | "disabled";

export interface McpServerStatusSnapshot extends JsonInputObject {
	readonly name: string;
	readonly status: McpServerRuntimeStatus;
	readonly toolCount: number;
	readonly resourceCount?: number;
	readonly failedAgoSeconds?: number;
	readonly failureDetail?: string;
	readonly disabled: boolean;
	readonly oauth?: boolean;
	/** Whether this server is configured to connect and recover automatically. */
	readonly autoConnect?: boolean;
}

export interface McpStatusSnapshot extends JsonInputObject {
	readonly version: typeof MCP_STATUS_SNAPSHOT_VERSION;
	readonly servers: ReadonlyArray<McpServerStatusSnapshot>;
	readonly totalTools: number;
	readonly totalResources: number;
	readonly connectedCount: number;
	readonly disabledCount: number;
}

// Import sources for config
export type ImportKind = "cursor" | "claude-code" | "claude-desktop" | "codex" | "opencode" | "windsurf" | "vscode";

// Tool definition from MCP server
export interface McpTool {
	name: string;
	title?: string;
	description?: string;
	inputSchema?: JsonInputValue; // JSON Schema
	_meta?: JsonInputObject;
}

// Resource definition from MCP server
export interface McpResource {
	uri: string;
	name: string;
	description?: string;
	mimeType?: string;
	_meta?: JsonInputObject;
}

// Pi content block type
export type ContentBlock = TextContent | ImageContent;

// OAuth configuration (SDK handles auto-discovery and dynamic registration)
export interface OAuthConfig {
	/** OAuth grant type (defaults to authorization_code) */
	grantType?: "authorization_code" | "client_credentials";
	/** Pre-registered client ID (optional, dynamic registration used if not provided) */
	clientId?: string;
	/** Client secret for confidential clients */
	clientSecret?: string;
	/** Requested OAuth scopes */
	scope?: string;
	/** Extra authorization URL parameters for provider-specific extensions. Flow-owned parameters cannot be overridden. */
	authorizationParams?: Record<string, string>;
	/** Exact authorization-code redirect URI for pre-registered clients */
	redirectUri?: string;
	/** Client display name for dynamic registration */
	clientName?: string;
	/** Client homepage URI for dynamic registration */
	clientUri?: string;
}

// Server configuration
export interface ServerEntry {
	command?: string;
	args?: string[];
	/** Explicit rmcp-mux Unix-domain socket path. Mutually exclusive with command and url. */
	socket?: string;
	env?: Record<string, string>;
	cwd?: string;
	// HTTP fields
	url?: string;
	headers?: Record<string, string>;
	/**
	 * Authentication type:
	 * - 'oauth' - Use OAuth 2.1 (auto-discovers endpoints, supports dynamic client registration)
	 * - 'bearer' - Use static Bearer token
	 * - false - Disable authentication
	 * If not specified and url is present, OAuth will be auto-detected unless custom headers are configured
	 */
	auth?: "oauth" | "bearer" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	/**
	 * OAuth configuration (optional).
	 * If not provided, the SDK will attempt dynamic client registration.
	 * Set to false to explicitly disable OAuth for this server.
	 */
	oauth?: OAuthConfig | false;
	lifecycle?: "keep-alive" | "lazy" | "lazy-keep-alive" | "eager";
	idleTimeout?: number; // minutes, overrides global setting
	requestTimeoutMs?: number; // milliseconds, overrides global request timeout when > 0
	// Resource handling
	exposeResources?: boolean;
	// Override settings.toolPrefix for this server.
	toolPrefix?: ToolPrefix;
	// Include/exclude specific MCP tools/resources by original or prefixed name
	includeTools?: string[];
	excludeTools?: string[];
	// Require interactive approval before calling matching MCP tools/resources.
	approveTools?: boolean | string[];
	// Debug
	debug?: boolean; // Show server stderr (default: false)
	/** Enable metadata-only JSONL protocol tracing for this server. */
	trace?: boolean;
	// Keep configuration visible without allowing connections or execution.
	disabled?: boolean;
}

/** Only the literal boolean `true` disables a server. */
export function isServerDisabled(definition: ServerEntry | undefined): boolean {
	return definition?.disabled === true;
}

// Output guard tuning (settings.outputGuard object form)
export interface McpOutputGuardSettings {
	/** Maximum inline MCP text output bytes before truncation/spill-to-disk. Defaults to 51200 (50 KiB). */
	maxBytes?: number;
	/** Maximum inline MCP text output lines before truncation/spill-to-disk. Defaults to 2000. */
	maxLines?: number;
	/** Maximum details.mcpResult JSON bytes kept raw; larger results are summarized and spilled to disk. Defaults to 16384 (16 KiB). */
	detailsMaxBytes?: number;
}

// Settings
export type ToolPrefix = "server" | "none" | "short" | "mcp";
export type HostConfigDiscovery = "off" | "prompt" | "on";
export type McpFooterStatus = "full" | "compact" | "off";

export interface McpTraceSettings {
	/** Enable tracing for all servers unless a server sets trace to false. */
	enabled?: boolean;
	/** JSONL destination; relative paths are resolved from the session cwd. */
	file?: string;
	/** Maximum per-session trace file size in bytes. */
	maxBytes?: number;
	/** Maximum events retained in the per-session trace file. */
	maxEvents?: number;
}

export interface McpSettings {
	toolPrefix?: ToolPrefix;
	/** Show the plug prefix in MCP status and connection text (default: true). Set to false to disable it. */
	showStatusIcon?: boolean;
	/** Footer status verbosity: full details, compact connected/enabled count, or no footer status. Defaults to full. */
	mcpFooterStatus?: McpFooterStatus;
	/** Discover detected host-specific MCP configs only when explicitly enabled. */
	hostConfigDiscovery?: HostConfigDiscovery;
	idleTimeout?: number; // minutes, default 10, 0 to disable
	requestTimeoutMs?: number; // milliseconds, overrides the SDK request timeout when > 0
	/** Default approval gate for matching tools/resources; per-server settings override it. */
	approveTools?: boolean | string[];
	autoAuth?: boolean;
	/**
	 * Guard oversized MCP tool/resource output before it is returned to the model.
	 * Defaults to true (50 KiB / 2,000 lines inline text, 16 KiB details.mcpResult).
	 * Set to false to restore raw MCP output behavior, or pass an object to tune
	 * the limits. Env kill switch: MCP_OUTPUT_GUARD=0.
	 */
	outputGuard?: boolean | McpOutputGuardSettings;
	/**
	 * Opt-in metadata-only MCP protocol tracing. Payloads, prompts, tool
	 * arguments/results, authorization data, and URLs are never persisted.
	 */
	trace?: McpTraceSettings;
	/**
	 * Message returned in tool results when a server needs (re-)authentication.
	 * "${server}" is substituted with the server name. Defaults to a TUI
	 * instruction when unset.
	 */
	authRequiredMessage?: string;
	/**
	 * Legacy OAuth tokens.json import directory.
	 * Relative paths are resolved from the project root (cwd).
	 * Takes precedence over the agent's mcp-oauth/ legacy import directory but
	 * can still be overridden by the MCP_OAUTH_DIR env variable.
	 *
	 * Persistent OAuth credentials are stored in the operating system credential
	 * store, not this directory. Existing plaintext tokens.json files found here
	 * remain a read-only compatibility fallback until an explicit OAuth mutation
	 * moves the entry to secure storage and removes the plaintext file.
	 */
	oauthDir?: string;
}

// Root config
export interface McpConfig {
	mcpServers: Record<string, ServerEntry>;
	imports?: ImportKind[];
	settings?: McpSettings;
}

export interface McpAdapterOptions {
	config?: McpConfig;
	configPath?: string;
	/** Keep every configured server disconnected until an explicit MCP tool or command uses it. */
	deferStartupConnections?: boolean;
}

// Alias for clarity
export type ServerDefinition = ServerEntry;

export interface ToolMetadata extends JsonInputObject {
	name: string; // Prefixed tool name (e.g., "xcodebuild_list_sims")
	originalName: string; // Original MCP tool name (e.g., "list_sims")
	description: string;
	resourceUri?: string; // For resource tools: the URI to read
	inputSchema?: JsonInputValue; // JSON Schema for parameters (stored for describe/errors)
}

export interface McpAuthResult {
	ok: boolean;
	message?: string;
}

export interface CachedTool {
	name: string;
	description?: string;
	inputSchema?: JsonInputValue;
}

export interface CachedResource {
	uri: string;
	name: string;
	description?: string;
}

export interface ServerCacheEntry {
	configHash: string;
	tools: CachedTool[];
	resources: CachedResource[];
	instructions?: string;
	cachedAt: number;
}

export interface MetadataCache {
	version: number;
	servers: Record<string, ServerCacheEntry>;
}

/**
 * Get server prefix based on tool prefix mode.
 */
export function getServerPrefix(serverName: string, mode: ToolPrefix): string {
	if (mode === "none") return "";
	if (mode === "short") {
		let short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
		if (!short) short = "mcp";
		return short;
	}
	if (mode === "mcp") return `mcp__${serverName.replace(/-/g, "_")}`;
	return serverName.replace(/-/g, "_");
}

/**
 * Format a tool name with server prefix.
 */
export function formatToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
	const p = getServerPrefix(serverName, prefix);
	const sanitized = toolName.replace(/\./g, "_");
	return p ? `${p}_${sanitized}` : sanitized;
}

export function resolveToolPrefix(definition?: Pick<ServerEntry, "toolPrefix">, globalPrefix?: ToolPrefix): ToolPrefix {
	return definition?.toolPrefix ?? globalPrefix ?? "server";
}

function normalizeToolName(value: string): string {
	return value.replace(/-/g, "_");
}

export function getToolNameCandidates(toolName: string, serverName: string, prefix: ToolPrefix): Set<string> {
	return new Set<string>([
		normalizeToolName(toolName),
		normalizeToolName(formatToolName(toolName, serverName, prefix)),
		normalizeToolName(formatToolName(toolName, serverName, "server")),
		normalizeToolName(formatToolName(toolName, serverName, "short")),
		normalizeToolName(formatToolName(toolName, serverName, "mcp")),
	]);
}

function globToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`);
}

export function matchesToolPattern(candidates: Set<string>, patterns?: JsonInputValue): boolean {
	if (!Array.isArray(patterns) || patterns.length === 0) return false;

	for (const pattern of patterns) {
		if (!isRuntimeString(pattern)) continue;
		const normalized = normalizeToolName(pattern);
		if (!normalized.includes("*") && !normalized.includes("?") && candidates.has(normalized)) {
			return true;
		}
		if (
			(normalized.includes("*") || normalized.includes("?")) &&
			[...candidates].some((candidate) => globToRegExp(normalized).test(candidate))
		) {
			return true;
		}
	}

	return false;
}

export function isToolIncluded(
	toolName: string,
	serverName: string,
	prefix: ToolPrefix,
	includeTools?: JsonInputValue,
): boolean {
	if (!Array.isArray(includeTools) || includeTools.length === 0) return true;
	return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), includeTools);
}

export function isToolExcluded(
	toolName: string,
	serverName: string,
	prefix: ToolPrefix,
	excludeTools?: JsonInputValue,
): boolean {
	return matchesToolPattern(getToolNameCandidates(toolName, serverName, prefix), excludeTools);
}

export function isToolAllowed(
	toolName: string,
	serverName: string,
	prefix: ToolPrefix,
	includeTools?: JsonInputValue,
	excludeTools?: JsonInputValue,
): boolean {
	return (
		isToolIncluded(toolName, serverName, prefix, includeTools) &&
		!isToolExcluded(toolName, serverName, prefix, excludeTools)
	);
}
