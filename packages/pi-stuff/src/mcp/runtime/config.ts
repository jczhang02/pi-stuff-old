// config.ts - Config loading with import support

import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import * as Effect from "effect/Effect";
import {
	isJsonInputObject,
	type JsonInputObject,
	type JsonInputValue,
	requireJsonInputValue,
} from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import {
	buildConfigWritePreview,
	type ConfigWritePreview,
	readProjectServerOverride,
	readRawConfigObject,
	type ServerDisabledOverrideResult,
	withConfigWriteLock,
	withProjectConfigWriteLock,
	writeProjectServerOverride,
	writeRawConfigObject,
} from "../config-persistence.ts";
import {
	extractServers,
	importKinds,
	isImportKind,
	loadImportedConfig,
	parseServerMap,
	readValidatedConfig,
	type ServerMap,
	setServer,
} from "./config-codecs.ts";
import {
	getConfigSources,
	getConfiguredHostConfigDiscovery,
	getPiGlobalConfigPath,
	getProjectConfigPath,
	getProjectPiConfigPath,
	readConfigSources,
} from "./config-sources.ts";
import { type ImportKind, isServerDisabled, type McpConfig, type ServerEntry } from "./types.ts";

export type { ConfigWritePreview, ServerDisabledOverrideResult } from "../config-persistence.ts";
export {
	type ConfigDiscoverySource,
	getGenericGlobalConfigPath,
	getMcpDiscoverySummary,
	getPiGlobalConfigPath,
	getProjectConfigPath,
	getProjectPiConfigPath,
	type HostConfigSummary,
	type ImportConfigSummary,
	KNOWN_SERVER_PRESETS,
	type KnownServerPreset,
	type McpConfigConflict,
	type McpDiscoverySummary,
	type RepoPromptDiscovery,
} from "./config-sources.ts";

export function cloneMcpConfig(config: McpConfig): McpConfig {
	return structuredClone(config);
}

export function loadMcpConfig(overridePath?: string, cwd = process.cwd()): Effect.Effect<McpConfig, Error> {
	return Effect.try({
		try: () => loadMcpConfigValue(overridePath, cwd),
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});
}

function loadMcpConfigValue(overridePath?: string, cwd = process.cwd()): McpConfig {
	const sources = readConfigSources(overridePath, cwd);
	const hostConfigDiscovery = getConfiguredHostConfigDiscovery(sources);
	// Host files are a lower-precedence fallback. This ordering means an opt-in
	// discovery cannot override a shared or Pi-owned definition, and all normal
	// URL-bound credential stripping remains in mergeServerMaps.
	let config: McpConfig = hostConfigDiscovery === "on" ? loadDiscoveredHostConfigs(cwd) : { mcpServers: {} };

	for (const { config: loaded } of sources) {
		if (!loaded) continue;
		config = mergeConfigs(config, expandImports(loaded, cwd));
	}

	return config;
}

function loadDiscoveredHostConfigs(cwd: string): McpConfig {
	let config: McpConfig = { mcpServers: {} };
	for (const importKind of importKinds()) {
		const imported = loadImportedConfig(
			importKind,
			cwd,
			`Failed to discover imported MCP config from ${importKind}:`,
		);
		if (!imported) continue;
		config = mergeConfigs(config, {
			mcpServers: extractServers(imported.value, importKind),
		});
	}
	return config;
}

function mergeConfigs(base: McpConfig, next: McpConfig): McpConfig {
	const imports = mergeImports(base.imports, next.imports);
	const settings = next.settings ? { ...base.settings, ...next.settings } : base.settings;
	const merged: McpConfig = {
		mcpServers: mergeServerMaps(base.mcpServers, next.mcpServers),
	};
	if (imports !== undefined) merged.imports = imports;
	if (settings !== undefined) merged.settings = settings;
	return merged;
}

// Credential-bearing fields whose value is bound to a specific server `url`.
// When a higher-precedence config source repoints an existing server at a
// different url, these MUST NOT be inherited from the lower-precedence entry —
// otherwise the original endpoint's credentials would be shipped to the new
// url. See the SECURITY note in mergeServerMaps.
const URL_BOUND_AUTH_FIELDS = ["headers", "bearerToken", "bearerTokenEnv"] as const;

function mergeServerMaps(base: ServerMap, next: ServerMap): ServerMap {
	const merged = { ...base };
	for (const [name, definition] of Object.entries(next)) {
		const existing = Object.hasOwn(merged, name) ? merged[name] : undefined;
		// SECURITY (credential/url binding): the merge is per-field, so a
		// higher-precedence source that supplies only a new `url` for an existing
		// server would otherwise retain the lower-precedence entry's auth material
		// (Authorization header, bearer token, OAuth config) and send it to the new
		// url — a credential-exfiltration vector when the higher-precedence source
		// is less trusted than the one that first defined the server. Bind auth to
		// the url that supplied it: when the url changes, drop inherited auth
		// material before merging. Auth explicitly re-supplied by `definition` still
		// applies (it is spread last). Behaviour is unchanged when the url is
		// identical or the override omits `url` (partial overrides still inherit).
		let baseEntry: ServerEntry = existing ?? {};
		if (existing && isRuntimeString(definition.socket)) {
			baseEntry = { ...existing };
			for (const field of [
				"command",
				"args",
				"env",
				"cwd",
				"url",
				"headers",
				"auth",
				"bearerToken",
				"bearerTokenEnv",
				"oauth",
			] as const) {
				delete baseEntry[field];
			}
		} else if (existing?.socket && (isRuntimeString(definition.command) || isRuntimeString(definition.url))) {
			baseEntry = { ...existing };
			delete baseEntry.socket;
		}
		if (existing && isRuntimeString(definition.url) && definition.url !== existing.url) {
			if (baseEntry === existing) baseEntry = { ...existing };
			for (const field of URL_BOUND_AUTH_FIELDS) {
				delete baseEntry[field];
			}
			if (baseEntry.oauth !== false) {
				delete baseEntry.oauth;
			}
		}
		setServer(merged, name, { ...baseEntry, ...definition });
	}
	return merged;
}

function mergeImports(left: ImportKind[] | undefined, right: ImportKind[] | undefined): ImportKind[] | undefined {
	const merged = [...(left ?? []), ...(right ?? [])];
	if (merged.length === 0) return undefined;
	return [...new Set(merged)];
}

function expandImports(config: McpConfig, cwd = process.cwd()): McpConfig {
	if (!config.imports?.length) return config;

	const importedServers: Record<string, ServerEntry> = {};
	for (const importKind of config.imports) {
		const imported = loadImportedConfig(importKind, cwd, `Failed to import MCP config from ${importKind}:`);
		if (!imported) continue;

		const servers = extractServers(imported.value, importKind);
		for (const [name, definition] of Object.entries(servers)) {
			if (!Object.hasOwn(importedServers, name)) {
				setServer(importedServers, name, definition);
			}
		}
	}

	const expanded: McpConfig = {
		imports: config.imports,
		mcpServers: mergeServerMaps(importedServers, config.mcpServers),
	};
	if (config.settings !== undefined) expanded.settings = config.settings;
	return expanded;
}

function getServersObject(raw: JsonInputObject): ServerMap {
	const existing = raw["mcpServers"] ?? raw["mcp-servers"] ?? {};
	if (!isJsonInputObject(existing)) {
		throw new Error("MCP config mcpServers must be an object");
	}
	return parseServerMap(existing, "MCP config mcpServers");
}

function setServersObject(raw: JsonInputObject, servers: Record<string, ServerEntry>): void {
	delete raw["mcp-servers"];
	raw["mcpServers"] = requireJsonInputValue(servers, "MCP server configuration");
}

/**
 * Persist only the disabled field in the project Pi layer. Enabling writes an
 * explicit false only when a lower-precedence source is itself disabled; this
 * writer never copies a server definition or its credentials into the file.
 * A custom global config participates only in that lower-precedence lookup;
 * the mutation target remains the project Pi layer.
 */
export function writeProjectServerDisabledOverride(
	globalConfigPath: string | undefined,
	cwd: string,
	serverName: string,
	disabled: boolean,
): Effect.Effect<ServerDisabledOverrideResult, Error> {
	return withProjectConfigWriteLock(getProjectPiConfigPath(cwd), cwd, (writePath) =>
		writeProjectServerDisabledOverrideUnlocked(globalConfigPath, cwd, writePath, serverName, disabled),
	);
}

function writeProjectServerDisabledOverrideUnlocked(
	globalConfigPath: string | undefined,
	cwd: string,
	writePath: string,
	serverName: string,
	disabled: boolean,
): ServerDisabledOverrideResult {
	const override = readProjectServerOverride(writePath, getProjectPiConfigPath(cwd), serverName);
	const { existing, filePath, raw } = override;

	let next: JsonInputObject;
	if (disabled) {
		next = { ...existing, disabled: true };
	} else {
		next = Object.fromEntries(Object.entries(existing ?? {}).filter(([key]) => key !== "disabled"));
		let lowerConfig: McpConfig = { mcpServers: {} };
		const projectTarget = existsSync(writePath) ? realpathSync(writePath) : null;
		for (const source of getConfigSources(globalConfigPath, cwd)) {
			if (
				source.id === "pi-project" ||
				source.readPath === filePath ||
				(projectTarget !== null && existsSync(source.readPath) && realpathSync(source.readPath) === projectTarget)
			)
				continue;
			const loaded = readValidatedConfig(source.readPath, `MCP config from ${source.readPath}`);
			if (loaded) lowerConfig = mergeConfigs(lowerConfig, expandImports(loaded, cwd));
		}
		if (raw["imports"] !== undefined) {
			if (
				!Array.isArray(raw["imports"]) ||
				raw["imports"].some((kind) => !isRuntimeString(kind) || !isImportKind(kind))
			) {
				throw new Error(
					`Failed to update project MCP override at ${filePath}: imports contains an unsupported config kind`,
				);
			}
			const imports = raw["imports"].filter(
				(kind): kind is ImportKind => isRuntimeString(kind) && isImportKind(kind),
			);
			lowerConfig = mergeConfigs(lowerConfig, expandImports({ mcpServers: {}, imports }, cwd));
		}
		if (isServerDisabled(lowerConfig.mcpServers[serverName])) next["disabled"] = false;
	}
	return writeProjectServerOverride(override, serverName, next);
}

/** Persist only a server's connection policy in the project Pi layer. */
export function writeProjectServerLifecycleOverride(
	cwd: string,
	serverName: string,
	lifecycle: "keep-alive" | "lazy",
): Effect.Effect<ServerDisabledOverrideResult, Error> {
	return withProjectConfigWriteLock(getProjectPiConfigPath(cwd), cwd, (writePath) => {
		const override = readProjectServerOverride(writePath, getProjectPiConfigPath(cwd), serverName);
		return writeProjectServerOverride(override, serverName, { ...override.existing, lifecycle });
	});
}

export function previewCompatibilityImports(importKinds: ImportKind[], overridePath?: string): ConfigWritePreview {
	const targetPath = getPiGlobalConfigPath(overridePath);
	const raw = readRawConfigObject(targetPath);
	const currentImports = Array.isArray(raw["imports"])
		? raw["imports"].filter((value): value is ImportKind => isRuntimeString(value))
		: [];
	const merged = [...new Set([...currentImports, ...importKinds])];
	const nextRaw = { ...raw, imports: merged };
	setServersObject(nextRaw, getServersObject(nextRaw));
	return buildConfigWritePreview(targetPath, nextRaw);
}

export function ensureCompatibilityImports(
	importKinds: ImportKind[],
	overridePath?: string,
): Effect.Effect<{ path: string; added: ImportKind[] }, Error> {
	const targetPath = getPiGlobalConfigPath(overridePath);
	return withConfigWriteLock(targetPath, (writePath) => {
		const raw = readRawConfigObject(writePath);
		const currentImports = Array.isArray(raw["imports"])
			? raw["imports"].filter((value): value is ImportKind => isRuntimeString(value))
			: [];
		const merged = [...new Set([...currentImports, ...importKinds])];
		const added = merged.filter((kind) => !currentImports.includes(kind));
		if (added.length === 0) return { path: targetPath, added: [] };

		raw["imports"] = merged;
		setServersObject(raw, getServersObject(raw));
		writeRawConfigObject(writePath, raw);
		return { path: targetPath, added };
	});
}

export function previewStarterProjectConfig(cwd = process.cwd()): ConfigWritePreview {
	const targetPath = getProjectConfigPath(cwd);
	const nextRaw: JsonInputObject = { mcpServers: {} };
	return buildConfigWritePreview(targetPath, nextRaw);
}

export function writeStarterProjectConfig(cwd = process.cwd()): Effect.Effect<string, Error> {
	const targetPath = getProjectConfigPath(cwd);
	return withConfigWriteLock(targetPath, (writePath) => {
		if (existsSync(targetPath)) throw new Error(`Refusing to replace existing MCP config at ${targetPath}`);
		writeRawConfigObject(writePath, { mcpServers: {} });
		return targetPath;
	});
}

export function previewSharedServerEntry(filePath: string, serverName: string, entry: ServerEntry): ConfigWritePreview {
	const raw = readRawConfigObject(filePath);
	const nextRaw = { ...raw };
	const servers = getServersObject(nextRaw);
	setServer(servers, serverName, entry);
	setServersObject(nextRaw, servers);
	return buildConfigWritePreview(filePath, nextRaw);
}

export function writeSharedServerEntry(
	filePath: string,
	serverName: string,
	entry: ServerEntry,
): Effect.Effect<string, Error> {
	return withConfigWriteLock(filePath, (writePath) => {
		const raw = readRawConfigObject(writePath);
		const servers = getServersObject(raw);
		setServer(servers, serverName, entry);
		setServersObject(raw, servers);
		writeRawConfigObject(writePath, raw);
		return filePath;
	});
}

export function resolveConfiguredOAuthDir(raw: JsonInputValue, cwd = process.cwd()): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	if (!isRuntimeString(raw)) {
		throw new Error("settings.oauthDir must be a string");
	}

	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	return resolve(cwd, trimmed);
}
