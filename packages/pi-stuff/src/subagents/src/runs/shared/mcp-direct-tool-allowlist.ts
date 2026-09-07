import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type JsonInputValue, type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import {
	isRuntimeBoolean,
	isRuntimeNumber,
	isRuntimeObject,
	isRuntimeString,
} from "../../../../shared/runtime-type.ts";
import { piStuffCachePath, xdgConfigHome } from "../../../../xdg/index.ts";
import { getAgentDir, getProjectConfigDir } from "../../shared/utils.ts";

const CACHE_VERSION = 2;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const BUILTIN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell", "mcp"]);
const IMPORT_PATHS = {
	cursor: [path.join(os.homedir(), ".cursor", "mcp.json")],
	"claude-code": [
		path.join(os.homedir(), ".claude", "mcp.json"),
		path.join(os.homedir(), ".claude.json"),
		path.join(os.homedir(), ".claude", "claude_desktop_config.json"),
	],
	"claude-desktop": [
		path.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json"),
	],
	codex: [path.join(os.homedir(), ".codex", "config.json")],
	windsurf: [path.join(os.homedir(), ".windsurf", "mcp.json")],
	vscode: [".vscode/mcp.json"],
} as const;

type ToolPrefix = "server" | "none" | "short";
type ImportKind = keyof typeof IMPORT_PATHS;

interface McpDirectToolServerEntry {
	args?: string[];
	auth?: "bearer" | "oauth" | false;
	bearerToken?: string;
	bearerTokenEnv?: string;
	command?: string;
	cwd?: string;
	directTools?: boolean | string[];
	env?: Record<string, string>;
	excludeTools?: string[];
	exposeResources?: boolean;
	headers?: Record<string, string>;
	includeTools?: string[];
	socket?: string;
	url?: string;
}

interface McpConfig {
	mcpServers: Record<string, McpDirectToolServerEntry>;
	imports?: ImportKind[];
	settings?: {
		toolPrefix?: ToolPrefix;
		directTools?: boolean;
	};
}

interface CachedTool {
	name?: string;
}

interface CachedResource {
	uri?: string;
	name?: string;
}

interface ServerCacheEntry {
	configHash?: string;
	tools?: CachedTool[];
	resources?: CachedResource[];
	cachedAt?: number;
}

interface MetadataCache {
	version: number;
	servers: Record<string, ServerCacheEntry>;
}

function cachedTool(value: JsonValue): CachedTool | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	return isRuntimeString(value["name"]) ? { name: value["name"] } : {};
}

function cachedResource(value: JsonValue): CachedResource | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	const resource: CachedResource = {};
	if (isRuntimeString(value["name"])) resource.name = value["name"];
	if (isRuntimeString(value["uri"])) resource.uri = value["uri"];
	return resource;
}

function serverCacheEntry(value: JsonValue): ServerCacheEntry | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	const entry: ServerCacheEntry = {};
	if (isRuntimeString(value["configHash"])) entry.configHash = value["configHash"];
	if (isRuntimeNumber(value["cachedAt"])) entry.cachedAt = value["cachedAt"];
	if (Array.isArray(value["tools"])) entry.tools = value["tools"].flatMap((tool) => cachedTool(tool) ?? []);
	if (Array.isArray(value["resources"])) {
		entry.resources = value["resources"].flatMap((resource) => cachedResource(resource) ?? []);
	}
	return entry;
}

export interface ResolvedMcpDirectToolSelection {
	name: string;
	selector: string;
}

export function resolveMcpDirectToolSelections(
	mcpDirectTools: string[] | undefined,
	cwd = process.cwd(),
): ResolvedMcpDirectToolSelection[] {
	if (!mcpDirectTools?.length) return [];

	try {
		const config = loadMcpConfig(cwd);
		const cache = loadMetadataCache();
		if (!cache) return [];
		return resolveDirectToolSelections(config, cache, getToolPrefix(config.settings?.toolPrefix), mcpDirectTools);
	} catch {
		return [];
	}
}

export function unresolvedMcpDirectToolSelectors(
	requested: readonly string[],
	resolved: readonly ResolvedMcpDirectToolSelection[],
): string[] {
	return requested
		.map((selector) => selector.replace(/\/+$/u, ""))
		.filter(
			(selector) =>
				!resolved.some((selection) =>
					selector.includes("/") ? selection.selector === selector : selection.selector.startsWith(`${selector}/`),
				),
		);
}

function loadMetadataCache(): MetadataCache | null {
	const cachePath = piStuffCachePath("mcp", "mcp-cache.json");
	let parsed: JsonValue;
	try {
		parsed = parseJsonValue(fs.readFileSync(cachePath, "utf-8"));
	} catch {
		return null;
	}

	if (
		!parsed ||
		!isRuntimeObject(parsed) ||
		Array.isArray(parsed) ||
		parsed["version"] !== CACHE_VERSION ||
		!parsed["servers"] ||
		!isRuntimeObject(parsed["servers"]) ||
		Array.isArray(parsed["servers"])
	) {
		return null;
	}
	const servers = Object.fromEntries(
		Object.entries(parsed["servers"]).flatMap(([name, value]) => {
			const entry = serverCacheEntry(value);
			return entry ? [[name, entry]] : [];
		}),
	);
	return { servers, version: CACHE_VERSION };
}

function loadMcpConfig(cwd: string): McpConfig {
	let config: McpConfig = { mcpServers: {} };
	for (const sourcePath of getConfigPaths(cwd)) {
		const loaded = readConfig(sourcePath);
		if (!loaded) continue;
		config = mergeConfigs(config, expandImports(loaded, cwd));
	}
	return config;
}

function getConfigPaths(cwd: string): string[] {
	const genericGlobalConfigPath = path.join(xdgConfigHome(), "mcp", "mcp.json");
	const piGlobalPath = path.join(getAgentDir(), "mcp.json");
	const projectPath = path.resolve(cwd, ".mcp.json");
	const projectPiPath = path.resolve(getProjectConfigDir(cwd), "mcp.json");
	const sources: string[] = [];
	if (genericGlobalConfigPath !== piGlobalPath) sources.push(genericGlobalConfigPath);
	sources.push(piGlobalPath);
	if (projectPath !== piGlobalPath) sources.push(projectPath);
	if (projectPiPath !== piGlobalPath && projectPiPath !== projectPath) sources.push(projectPiPath);
	return sources;
}

function readConfig(configPath: string): McpConfig | null {
	let parsed: JsonValue;
	try {
		parsed = parseJsonValue(fs.readFileSync(configPath, "utf-8"));
	} catch {
		return null;
	}
	return validateConfig(parsed);
}

function stringArray(value: JsonValue | undefined): string[] | undefined {
	return Array.isArray(value) && value.every(isRuntimeString) ? [...value] : undefined;
}

function stringRecord(value: JsonValue | undefined): Record<string, string> | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isRuntimeString(entry)) return undefined;
		record[key] = entry;
	}
	return record;
}

function serverEntry(value: JsonValue): McpDirectToolServerEntry | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	const entry: McpDirectToolServerEntry = {};
	for (const key of ["bearerToken", "bearerTokenEnv", "command", "cwd", "socket", "url"] as const) {
		const field = value[key];
		if (field !== undefined && !isRuntimeString(field)) return undefined;
		if (isRuntimeString(field)) entry[key] = field;
	}
	for (const key of ["args", "excludeTools", "includeTools"] as const) {
		const field = value[key];
		const parsed = stringArray(field);
		if (field !== undefined && !parsed) return undefined;
		if (parsed) entry[key] = parsed;
	}
	for (const key of ["env", "headers"] as const) {
		const field = value[key];
		const parsed = stringRecord(field);
		if (field !== undefined && !parsed) return undefined;
		if (parsed) entry[key] = parsed;
	}
	if (
		value["auth"] !== undefined &&
		value["auth"] !== "oauth" &&
		value["auth"] !== "bearer" &&
		value["auth"] !== false
	) {
		return undefined;
	}
	if (value["auth"] === "oauth" || value["auth"] === "bearer" || value["auth"] === false) entry.auth = value["auth"];
	if (value["exposeResources"] !== undefined && !isRuntimeBoolean(value["exposeResources"])) return undefined;
	if (isRuntimeBoolean(value["exposeResources"])) entry.exposeResources = value["exposeResources"];
	if (value["directTools"] !== undefined) {
		const directTools = stringArray(value["directTools"]);
		if (!isRuntimeBoolean(value["directTools"]) && !directTools) return undefined;
		if (isRuntimeBoolean(value["directTools"])) entry.directTools = value["directTools"];
		else if (directTools) entry.directTools = directTools;
	}
	return entry;
}

function serverEntries(value: JsonValue | undefined): Record<string, McpDirectToolServerEntry> {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).flatMap(([name, definition]) => {
			const parsed = serverEntry(definition);
			return parsed ? [[name, parsed]] : [];
		}),
	);
}

function configSettings(value: JsonValue | undefined): McpConfig["settings"] | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	const settings: NonNullable<McpConfig["settings"]> = {};
	if (value["toolPrefix"] === "server" || value["toolPrefix"] === "none" || value["toolPrefix"] === "short") {
		settings.toolPrefix = value["toolPrefix"];
	}
	if (isRuntimeBoolean(value["directTools"])) settings.directTools = value["directTools"];
	return settings;
}

function validateConfig(raw: JsonValue): McpConfig {
	if (!raw || !isRuntimeObject(raw) || Array.isArray(raw)) return { mcpServers: {} };
	const config: McpConfig = { mcpServers: serverEntries(raw["mcpServers"] ?? raw["mcp-servers"] ?? {}) };
	if (Array.isArray(raw["imports"])) config.imports = raw["imports"].filter(isImportKind);
	const settings = configSettings(raw["settings"]);
	if (settings) config.settings = settings;
	return config;
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
	const imports = [...(base.imports ?? []), ...(next.imports ?? [])];
	const merged: McpConfig = { mcpServers: { ...base.mcpServers, ...next.mcpServers } };
	if (imports.length) merged.imports = [...new Set(imports)];
	const settings = next.settings ? { ...base.settings, ...next.settings } : base.settings;
	if (settings) merged.settings = settings;
	return merged;
}

function expandImports(config: McpConfig, cwd: string): McpConfig {
	if (!config.imports?.length) return config;

	const importedServers: Record<string, McpDirectToolServerEntry> = {};
	for (const importKind of config.imports) {
		const importPath = resolveImportPath(importKind, cwd);
		if (!importPath) continue;
		let imported: JsonValue;
		try {
			imported = parseJsonValue(fs.readFileSync(importPath, "utf-8"));
		} catch {
			continue;
		}
		for (const [name, definition] of Object.entries(extractServers(imported, importKind))) {
			if (!importedServers[name]) importedServers[name] = definition;
		}
	}

	const expanded: McpConfig = {
		imports: config.imports,
		mcpServers: { ...importedServers, ...config.mcpServers },
	};
	if (config.settings) expanded.settings = config.settings;
	return expanded;
}

function resolveImportPath(importKind: ImportKind, cwd: string): string | null {
	for (const candidate of IMPORT_PATHS[importKind]) {
		const fullPath = candidate.startsWith(".") ? path.resolve(cwd, candidate) : candidate;
		if (fs.existsSync(fullPath)) return fullPath;
	}
	return null;
}

function extractServers(config: JsonValue, kind: ImportKind): Record<string, McpDirectToolServerEntry> {
	if (!config || !isRuntimeObject(config) || Array.isArray(config)) return {};
	const servers =
		kind === "cursor" || kind === "windsurf" || kind === "vscode"
			? (config["mcpServers"] ?? config["mcp-servers"])
			: config["mcpServers"];
	return serverEntries(servers);
}

function resolveDirectToolSelections(
	config: McpConfig,
	cache: MetadataCache,
	prefix: ToolPrefix,
	envOverride: string[],
): ResolvedMcpDirectToolSelection[] {
	const names: ResolvedMcpDirectToolSelection[] = [];
	const seenNames = new Set<string>();
	const { servers: selectedServers, tools: selectedTools } = parseSelections(envOverride);

	for (const [serverName, definition] of Object.entries(config.mcpServers)) {
		const serverCache = cache.servers[serverName];
		if (!isServerCacheValid(serverCache, definition)) continue;

		const toolFilter = selectedServers.has(serverName) ? true : selectedTools.get(serverName);
		if (!toolFilter) continue;

		for (const tool of Array.isArray(serverCache.tools) ? serverCache.tools : []) {
			if (!isRuntimeString(tool?.name) || !tool.name) continue;
			if (toolFilter !== true && !toolFilter.has(tool.name)) continue;
			if (isToolExcluded(tool.name, serverName, prefix, definition.excludeTools)) continue;
			const prefixedName = formatToolName(tool.name, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(prefixedName) || seenNames.has(prefixedName)) continue;
			seenNames.add(prefixedName);
			names.push({ name: prefixedName, selector: `${serverName}/${tool.name}` });
		}

		if (definition.exposeResources === false) continue;
		for (const resource of Array.isArray(serverCache.resources) ? serverCache.resources : []) {
			if (!isRuntimeString(resource?.name) || !resource.name || !isRuntimeString(resource.uri) || !resource.uri)
				continue;
			const baseName = `get_${resourceNameToToolName(resource.name)}`;
			if (toolFilter !== true && !toolFilter.has(baseName)) continue;
			if (isToolExcluded(baseName, serverName, prefix, definition.excludeTools)) continue;
			const prefixedName = formatToolName(baseName, serverName, prefix);
			if (BUILTIN_TOOL_NAMES.has(prefixedName) || seenNames.has(prefixedName)) continue;
			seenNames.add(prefixedName);
			names.push({ name: prefixedName, selector: `${serverName}/${baseName}` });
		}
	}

	return names;
}

function parseSelections(selections: string[]) {
	const servers = new Set<string>();
	const tools = new Map<string, Set<string>>();
	for (let item of selections) {
		item = item.replace(/\/+$/, "");
		if (item.includes("/")) {
			const [server, tool] = item.split("/", 2);
			if (server && tool) {
				let serverTools = tools.get(server);
				if (!serverTools) {
					serverTools = new Set();
					tools.set(server, serverTools);
				}
				serverTools.add(tool);
			} else if (server) {
				servers.add(server);
			}
		} else if (item) {
			servers.add(item);
		}
	}
	return { servers, tools };
}

function isServerCacheValid(
	entry: ServerCacheEntry | undefined,
	definition: McpDirectToolServerEntry,
): entry is ServerCacheEntry {
	if (!entry || entry.configHash !== computeMcpServerHash(definition)) return false;
	if (!entry.cachedAt || !isRuntimeNumber(entry.cachedAt)) return false;
	return Date.now() - entry.cachedAt <= CACHE_MAX_AGE_MS;
}

export function computeMcpServerHash(definition: McpDirectToolServerEntry): string {
	const identity = {
		command: definition.command,
		args: definition.args,
		socket: resolveConfigPath(definition.socket),
		env: interpolateEnvRecord(definition.env),
		cwd: resolveConfigPath(definition.cwd),
		url: resolveServerUrl(definition),
		headers: interpolateEnvRecord(definition.headers),
		auth: definition.auth,
		bearerToken: resolveBearerToken(definition),
		bearerTokenEnv: definition.bearerTokenEnv,
		exposeResources: definition.exposeResources,
		includeTools: definition.includeTools,
		excludeTools: definition.excludeTools,
	};
	return createHash("sha256").update(stableStringify(identity)).digest("hex");
}

function getToolPrefix(value: NonNullable<McpConfig["settings"]>["toolPrefix"]): ToolPrefix {
	return value === "none" || value === "short" || value === "server" ? value : "server";
}

function isImportKind(value: JsonValue): value is ImportKind {
	return isRuntimeString(value) && Object.hasOwn(IMPORT_PATHS, value);
}

function getServerPrefix(serverName: string, mode: ToolPrefix): string {
	if (mode === "none") return "";
	if (mode === "short") {
		const short = serverName.replace(/-?mcp$/i, "").replace(/-/g, "_");
		return short || "mcp";
	}
	return serverName.replace(/-/g, "_");
}

function formatToolName(toolName: string, serverName: string, prefix: ToolPrefix): string {
	const serverPrefix = getServerPrefix(serverName, prefix);
	return serverPrefix ? `${serverPrefix}_${toolName}` : toolName;
}

function isToolExcluded(
	toolName: string,
	serverName: string,
	prefix: ToolPrefix,
	excludeTools: readonly string[] | undefined,
): boolean {
	if (!excludeTools?.length) return false;
	const candidates = new Set([
		normalizeToolName(toolName),
		normalizeToolName(formatToolName(toolName, serverName, prefix)),
		normalizeToolName(formatToolName(toolName, serverName, "server")),
		normalizeToolName(formatToolName(toolName, serverName, "short")),
	]);
	return excludeTools.some((excluded) => candidates.has(normalizeToolName(excluded)));
}

function normalizeToolName(value: string): string {
	return value.replace(/-/g, "_");
}

function resourceNameToToolName(name: string): string {
	let result = name
		.replace(/[^a-zA-Z0-9]/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+/, "")
		.replace(/_+$/, "")
		.toLowerCase();
	if (!result || /^\d/.test(result)) result = `resource${result ? `_${result}` : ""}`;
	return result;
}

function interpolateEnvRecord(values: Record<string, string> | undefined): Record<string, string> | undefined {
	if (!values) return undefined;
	return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, interpolateSecretExpression(value)]));
}

function interpolateEnvVars(value: string): string {
	return value
		.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "")
		.replace(/\$env:(\w+)/g, (_, name: string) => process.env[name] ?? "")
		.replace(/\{env:(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
}

function interpolateSecretExpression(value: string): string {
	if (value.startsWith("!!")) return interpolateEnvVars(value.slice(1));
	return value.startsWith("!") ? value : interpolateEnvVars(value);
}

function getMissingEnvVars(value: string): string[] {
	const missing = new Set<string>();
	for (const match of value.matchAll(/\$\{(\w+)\}|\$env:(\w+)|\{env:(\w+)\}/g)) {
		const name = match[1] ?? match[2] ?? match[3];
		if (name && process.env[name] === undefined) missing.add(name);
	}
	return [...missing];
}

function resolveServerUrl(definition: Pick<McpDirectToolServerEntry, "url">): string | undefined {
	if (definition.url == null) return undefined;
	if (!isRuntimeString(definition.url)) throw new Error("MCP server URL must be a string");

	const missing = getMissingEnvVars(definition.url);
	if (missing.length > 0) {
		throw new Error(
			`Missing environment variable${missing.length === 1 ? "" : "s"} in MCP server URL: ${missing.join(", ")}`,
		);
	}

	const resolved = interpolateEnvVars(definition.url);
	try {
		new URL(resolved);
	} catch (error) {
		throw new Error(`Invalid MCP server URL after environment interpolation: ${resolved}`, { cause: error });
	}
	return resolved;
}

function resolveConfigPath(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const resolved = interpolateEnvVars(value);
	if (resolved === "~") return os.homedir();
	if (resolved.startsWith("~/") || resolved.startsWith("~\\")) return path.join(os.homedir(), resolved.slice(2));
	return resolved;
}

function resolveBearerToken(
	definition: Pick<McpDirectToolServerEntry, "bearerToken" | "bearerTokenEnv">,
): string | undefined {
	if (definition.bearerToken !== undefined) return interpolateSecretExpression(definition.bearerToken);
	return definition.bearerTokenEnv ? process.env[definition.bearerTokenEnv] : undefined;
}

function stableStringify(value: JsonInputValue): string {
	if (value === null || value === undefined || !isRuntimeObject(value)) {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "undefined" : serialized;
	}
	if (Array.isArray(value)) return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	return `{${Object.entries(value)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
		.join(",")}}`;
}
