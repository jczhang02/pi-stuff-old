// metadata-cache.ts - Persistent MCP metadata cache

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	isJsonInputObject,
	type JsonInputObject,
	type JsonInputValue,
	parseJsonObject,
} from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import { piStuffCachePath } from "../../xdg/index.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import type {
	CachedResource,
	CachedTool,
	McpResource,
	McpTool,
	MetadataCache,
	ServerCacheEntry,
	ServerEntry,
	ToolMetadata,
} from "./types.ts";
import { formatToolName, isToolAllowed, resolveToolPrefix, type ToolPrefix } from "./types.ts";
import { interpolateEnvRecord, resolveBearerToken, resolveConfigPath, resolveServerUrl } from "./utils.ts";

export const METADATA_CACHE_VERSION = 2;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type { CachedResource, CachedTool, MetadataCache, ServerCacheEntry } from "./types.ts";

export function getMetadataCachePath(): string {
	return piStuffCachePath("mcp", "mcp-cache.json");
}

export function loadMetadataCache(): MetadataCache | null {
	const cachePath = getMetadataCachePath();
	if (!existsSync(cachePath)) return null;
	try {
		return parseMetadataCache(readFileSync(cachePath, "utf-8"));
	} catch {
		return null;
	}
}

export function saveMetadataCache(cache: MetadataCache): void {
	const cachePath = getMetadataCachePath();
	const dir = dirname(cachePath);
	mkdirSync(dir, { recursive: true });

	const merged: MetadataCache = { version: METADATA_CACHE_VERSION, servers: {} };
	try {
		if (existsSync(cachePath)) {
			const existing = parseMetadataCache(readFileSync(cachePath, "utf-8"));
			if (existing) {
				merged.servers = { ...existing.servers };
			}
		}
	} catch {
		// Ignore parse errors and proceed with empty cache
	}

	merged.version = METADATA_CACHE_VERSION;
	merged.servers = { ...merged.servers, ...cache.servers };

	const tmpPath = `${cachePath}.${process.pid}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
	renameSync(tmpPath, cachePath);
}

export function computeServerHash(definition: ServerEntry): string {
	// Hash only fields that affect server identity and tool/resource output.
	// Exclude lifecycle, idleTimeout, requestTimeoutMs, debug — those are runtime behavior settings
	// that don't change which tools a server exposes.
	const identity: JsonInputObject = {
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
	const normalized = stableStringify(identity);
	return createHash("sha256").update(normalized).digest("hex");
}

export function isServerCacheValid(
	entry: ServerCacheEntry,
	definition: ServerEntry,
	maxAgeMs: number = CACHE_MAX_AGE_MS,
): boolean {
	let configHash: string;
	try {
		configHash = computeServerHash(definition);
	} catch {
		return false;
	}
	if (!entry || entry.configHash !== configHash) return false;
	if (!entry.cachedAt || !isRuntimeNumber(entry.cachedAt)) return false;
	if (maxAgeMs > 0 && Date.now() - entry.cachedAt > maxAgeMs) return false;
	return true;
}

export function reconstructToolMetadata(
	serverName: string,
	entry: ServerCacheEntry,
	prefix: ToolPrefix,
	definition: Pick<ServerEntry, "exposeResources" | "includeTools" | "excludeTools" | "toolPrefix">,
): ToolMetadata[] {
	const metadata: ToolMetadata[] = [];
	const seenNames = new Set<string>();
	const effectivePrefix = resolveToolPrefix(definition, prefix);

	for (const tool of entry.tools ?? []) {
		if (!tool?.name) continue;
		if (!isToolAllowed(tool.name, serverName, effectivePrefix, definition.includeTools, definition.excludeTools)) {
			continue;
		}

		const name = formatToolName(tool.name, serverName, effectivePrefix);
		if (seenNames.has(name)) {
			continue;
		}
		seenNames.add(name);

		metadata.push({
			name,
			originalName: tool.name,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
		});
	}

	if (definition.exposeResources !== false) {
		for (const resource of entry.resources ?? []) {
			if (!resource?.name || !resource?.uri) continue;
			const baseName = `read_${resourceNameToToolName(resource.name)}`;
			if (!isToolAllowed(baseName, serverName, effectivePrefix, definition.includeTools, definition.excludeTools)) {
				continue;
			}

			const name = formatToolName(baseName, serverName, effectivePrefix);
			if (seenNames.has(name)) {
				continue;
			}
			seenNames.add(name);

			metadata.push({
				name,
				originalName: baseName,
				description: resource.description ?? `Read resource: ${resource.uri}`,
				resourceUri: resource.uri,
			});
		}
	}

	return metadata;
}

export function serializeTools(tools: McpTool[]): CachedTool[] {
	return tools
		.filter((t) => t?.name)
		.map((t) => {
			const cached: CachedTool = { name: t.name };
			if (t.description !== undefined) cached.description = t.description;
			if (t.inputSchema !== undefined) cached.inputSchema = t.inputSchema;
			return cached;
		});
}

export function serializeResources(resources: McpResource[]): CachedResource[] {
	return resources
		.filter((r) => r?.name && r?.uri)
		.map((r) => {
			const cached: CachedResource = { uri: r.uri, name: r.name };
			if (r.description !== undefined) cached.description = r.description;
			return cached;
		});
}

function stableStringify(value: JsonInputValue): string {
	if (value === null || value === undefined || !isRuntimeObject(value)) {
		const serialized = JSON.stringify(value);
		return serialized === undefined ? "undefined" : serialized;
	}
	if (Array.isArray(value)) {
		return `[${value.map((v) => stableStringify(v)).join(",")}]`;
	}
	if (!isJsonInputObject(value)) return "undefined";
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

function parseMetadataCache(text: string): MetadataCache | null {
	const value = parseJsonObject(text);
	if (value["version"] !== METADATA_CACHE_VERSION || !isJsonInputObject(value["servers"])) return null;
	const servers: Record<string, ServerCacheEntry> = {};
	for (const [name, entry] of Object.entries(value["servers"])) {
		const parsed = parseServerCacheEntry(entry);
		if (!parsed) return null;
		Object.defineProperty(servers, name, { configurable: true, enumerable: true, value: parsed, writable: true });
	}
	return { version: METADATA_CACHE_VERSION, servers };
}

function parseServerCacheEntry(value: JsonInputValue): ServerCacheEntry | null {
	if (
		!isJsonInputObject(value) ||
		!isRuntimeString(value["configHash"]) ||
		!isRuntimeNumber(value["cachedAt"]) ||
		!Number.isFinite(value["cachedAt"])
	)
		return null;
	const tools = parseCacheList(value["tools"], parseCachedTool);
	const resources = parseCacheList(value["resources"], parseCachedResource);
	if (!tools || !resources) return null;
	const entry: ServerCacheEntry = { configHash: value["configHash"], tools, resources, cachedAt: value["cachedAt"] };
	if (value["instructions"] !== undefined) {
		if (!isRuntimeString(value["instructions"])) return null;
		entry.instructions = value["instructions"];
	}
	return entry;
}

function parseCachedTool(value: JsonInputValue): CachedTool | null {
	if (!isJsonInputObject(value) || !isRuntimeString(value["name"])) return null;
	const tool: CachedTool = { name: value["name"] };
	if (!assignCacheString(tool, "description", value["description"])) return null;
	if (value["inputSchema"] !== undefined) tool.inputSchema = value["inputSchema"];
	return tool;
}

function parseCachedResource(value: JsonInputValue): CachedResource | null {
	if (!isJsonInputObject(value) || !isRuntimeString(value["uri"]) || !isRuntimeString(value["name"])) return null;
	const resource: CachedResource = { uri: value["uri"], name: value["name"] };
	return assignCacheString(resource, "description", value["description"]) ? resource : null;
}

function parseCacheList<Value>(value: JsonInputValue, parse: (entry: JsonInputValue) => Value | null): Value[] | null {
	if (!Array.isArray(value)) return null;
	const parsed: Value[] = [];
	for (const entry of value) {
		const item = parse(entry);
		if (!item) return null;
		parsed.push(item);
	}
	return parsed;
}

function assignCacheString<Target extends object, Key extends keyof Target>(
	target: Target,
	key: Key,
	value: JsonInputValue,
): boolean {
	if (value === undefined) return true;
	if (!isRuntimeString(value)) return false;
	Object.assign(target, { [key]: value });
	return true;
}
