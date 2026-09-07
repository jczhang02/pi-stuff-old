import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import stripJsonComments from "strip-json-comments";
import { type TSchema, Type } from "typebox";
import { Value } from "typebox/value";
import {
	isJsonInputObject,
	isJsonInputValue,
	type JsonInputObject,
	type JsonInputValue,
	parseJsonValue,
} from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { xdgConfigHome } from "../../xdg/index.ts";
import { logger } from "./logger.ts";
import type { ImportKind, McpConfig, McpSettings, ServerEntry } from "./types.ts";
import { toStringRecord } from "./utils.ts";

const IMPORT_PATHS = {
	cursor: [join(homedir(), ".cursor", "mcp.json")],
	"claude-code": [
		join(homedir(), ".claude", "mcp.json"),
		join(homedir(), ".claude.json"),
		join(homedir(), ".claude", "claude_desktop_config.json"),
	],
	"claude-desktop": [join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")],
	codex: [join(homedir(), ".codex", "config.toml"), join(homedir(), ".codex", "config.json")],
	opencode: [join(xdgConfigHome(), "opencode", "opencode.json"), "./opencode.json"],
	windsurf: [join(homedir(), ".windsurf", "mcp.json")],
	vscode: [".vscode/mcp.json"],
} satisfies Record<ImportKind, string[]>;

export interface ServerMap {
	[serverName: string]: ServerEntry;
}

export function isImportKind(value: string): value is ImportKind {
	return Object.hasOwn(IMPORT_PATHS, value);
}

export function importKinds(): ImportKind[] {
	return Object.keys(IMPORT_PATHS).filter(isImportKind);
}

function optionalFields(schema: TSchema, fields: readonly string[]) {
	return Object.fromEntries(fields.map((field) => [field, Type.Optional(schema)]));
}

function literals(...values: Array<string | boolean>) {
	return Type.Union(values.map((value) => Type.Literal(value)));
}

const STRING_LIST_SCHEMA = Type.Array(Type.String());
const STRING_RECORD_SCHEMA = Type.Record(Type.String(), Type.String());
const APPROVE_TOOLS_SCHEMA = Type.Union([Type.Boolean(), STRING_LIST_SCHEMA]);
const TOOL_PREFIX_SCHEMA = literals("server", "none", "short", "mcp");
const OAUTH_SCHEMA = Type.Union([
	Type.Literal(false),
	Type.Object({
		...optionalFields(Type.String(), ["clientId", "clientSecret", "scope", "redirectUri", "clientName", "clientUri"]),
		authorizationParams: Type.Optional(STRING_RECORD_SCHEMA),
		grantType: Type.Optional(literals("authorization_code", "client_credentials")),
	}),
]);
const SERVER_ENTRY_SCHEMA = Type.Object({
	...optionalFields(Type.String(), ["command", "socket", "cwd", "url", "bearerToken", "bearerTokenEnv"]),
	...optionalFields(Type.Boolean(), ["exposeResources", "debug", "trace", "disabled"]),
	...optionalFields(Type.Number(), ["idleTimeout", "requestTimeoutMs"]),
	...optionalFields(STRING_LIST_SCHEMA, ["args", "includeTools", "excludeTools"]),
	...optionalFields(STRING_RECORD_SCHEMA, ["env", "headers"]),
	approveTools: Type.Optional(APPROVE_TOOLS_SCHEMA),
	auth: Type.Optional(literals("oauth", "bearer", false)),
	lifecycle: Type.Optional(literals("keep-alive", "lazy", "lazy-keep-alive", "eager")),
	oauth: Type.Optional(OAUTH_SCHEMA),
	toolPrefix: Type.Optional(TOOL_PREFIX_SCHEMA),
});
const MCP_SETTINGS_SCHEMA = Type.Object({
	...optionalFields(Type.Boolean(), ["showStatusIcon", "autoAuth"]),
	...optionalFields(Type.Number(), ["idleTimeout", "requestTimeoutMs"]),
	...optionalFields(Type.String(), ["authRequiredMessage", "oauthDir"]),
	approveTools: Type.Optional(APPROVE_TOOLS_SCHEMA),
	hostConfigDiscovery: Type.Optional(literals("off", "prompt", "on")),
	mcpFooterStatus: Type.Optional(literals("full", "compact", "off")),
	outputGuard: Type.Optional(
		Type.Union([
			Type.Boolean(),
			Type.Object(optionalFields(Type.Number(), ["maxBytes", "maxLines", "detailsMaxBytes"])),
		]),
	),
	toolPrefix: Type.Optional(TOOL_PREFIX_SCHEMA),
	trace: Type.Optional(
		Type.Object({
			...optionalFields(Type.Number(), ["maxBytes", "maxEvents"]),
			enabled: Type.Optional(Type.Boolean()),
			file: Type.Optional(Type.String()),
		}),
	),
});

function assertSchema(schema: TSchema, value: JsonInputValue, label: string): void {
	if (Value.Check(schema, value)) return;
	const error = Value.Errors(schema, value)[0];
	const field = error?.instancePath.slice(1).replaceAll("/", ".");
	throw new TypeError(`${label}${field ? `.${field}` : ""} ${error?.message ?? "is invalid"}`);
}

function parseServerEntry(value: JsonInputValue, label: string): ServerEntry {
	if (!isJsonInputObject(value)) throw new TypeError(`${label} must be an object`);
	assertSchema(SERVER_ENTRY_SCHEMA, value, label);
	// SAFETY: every typed ServerEntry field is validated above; extra JSON fields remain inert compatibility data.
	return value as ServerEntry;
}

function parseMcpSettings(value: JsonInputValue): McpSettings | undefined {
	if (value === undefined) return undefined;
	if (!isJsonInputObject(value)) throw new TypeError("MCP config settings must be an object");
	assertSchema(MCP_SETTINGS_SCHEMA, value, "settings");
	// SAFETY: every McpSettings field and nested settings object is validated above.
	return value as McpSettings;
}

export function parseServerMap(value: JsonInputValue, label: string): ServerMap {
	if (!isJsonInputObject(value)) throw new TypeError(`${label} must be an object`);
	const servers: ServerMap = {};
	for (const [name, entry] of Object.entries(value)) {
		setServer(servers, name, parseServerEntry(entry, `${label}.${name}`));
	}
	return servers;
}

export function setServer(map: ServerMap, name: string, entry: ServerEntry): void {
	Object.defineProperty(map, name, { configurable: true, enumerable: true, value: entry, writable: true });
}

function setJsonInputProperty(map: JsonInputObject, name: string, value: JsonInputValue): void {
	Object.defineProperty(map, name, { configurable: true, enumerable: true, value, writable: true });
}

function copyJsonInputObject(...sources: readonly JsonInputObject[]): JsonInputObject {
	const result: JsonInputObject = {};
	for (const source of sources) {
		for (const [name, value] of Object.entries(source)) setJsonInputProperty(result, name, value);
	}
	return result;
}

function resolveImportCandidates(importKind: ImportKind, cwd: string): string[] {
	return (IMPORT_PATHS[importKind] ?? []).map((candidate) => {
		if (importKind === "opencode" && candidate === "./opencode.json") {
			const start = resolve(cwd);
			let gitRoot: string | undefined;
			let current = start;
			while (true) {
				if (existsSync(join(current, ".git"))) {
					gitRoot = current;
					break;
				}
				const parent = dirname(current);
				if (parent === current) break;
				current = parent;
			}

			if (!gitRoot) return join(start, "opencode.json");
			current = start;
			while (true) {
				const projectConfig = join(current, "opencode.json");
				if (existsSync(projectConfig) || current === gitRoot) return projectConfig;
				current = dirname(current);
			}
		}
		return candidate.startsWith(".") ? resolve(cwd, candidate) : candidate;
	});
}

function parseJsonConfig(raw: string): JsonInputValue {
	return parseJsonValue(stripJsonComments(raw, { trailingCommas: true }));
}

function readImportedConfig(path: string): JsonInputValue {
	const raw = readFileSync(path, "utf-8");
	const value = path.endsWith(".toml") ? parseToml(raw) : parseJsonConfig(raw);
	if (!isJsonInputValue(value)) throw new TypeError(`Imported MCP config at ${path} is not JSON-compatible`);
	return value;
}

export function loadImportedConfig(
	importKind: ImportKind,
	cwd: string,
	warningPrefix: string,
): { path: string; value: JsonInputValue } | null {
	if (importKind === "opencode") {
		let merged: JsonInputObject = {};
		let highestPrecedencePath: string | undefined;

		for (const path of resolveImportCandidates(importKind, cwd)) {
			if (!existsSync(path)) continue;

			try {
				const value = readImportedConfig(path);
				if (isJsonInputObject(value)) {
					merged = mergeOpenCodeConfigs(merged, value);
					highestPrecedencePath = path;
				}
			} catch (error) {
				logger.warn(warningPrefix, { error: error instanceof Error ? error.message : String(error), path });
			}
		}

		return highestPrecedencePath ? { path: highestPrecedencePath, value: merged } : null;
	}

	for (const path of resolveImportCandidates(importKind, cwd)) {
		if (!existsSync(path)) continue;

		try {
			return { path, value: readImportedConfig(path) };
		} catch (error) {
			logger.warn(warningPrefix, { error: error instanceof Error ? error.message : String(error), path });
		}
	}

	return null;
}

export function readValidatedConfig(path: string, label: string): McpConfig | null {
	if (!existsSync(path)) return null;

	try {
		return validateConfig(parseJsonConfig(readFileSync(path, "utf-8")));
	} catch (error) {
		logger.warn(`Failed to load ${label}`, {
			error: error instanceof Error ? error.message : String(error),
			path,
		});
		return null;
	}
}

function validateConfig(raw: JsonInputValue): McpConfig {
	if (!isJsonInputObject(raw)) {
		return { mcpServers: {} };
	}

	const servers = raw["mcpServers"] ?? raw["mcp-servers"] ?? {};
	const rawImports = raw["imports"];
	let imports: ImportKind[] | undefined;
	if (rawImports !== undefined) {
		if (!Array.isArray(rawImports) || !rawImports.every((kind) => isRuntimeString(kind) && isImportKind(kind))) {
			throw new TypeError("MCP config imports contains an unsupported config kind");
		}
		imports = rawImports.filter((kind): kind is ImportKind => isRuntimeString(kind) && isImportKind(kind));
	}
	const settings = parseMcpSettings(raw["settings"]);
	const config: McpConfig = {
		mcpServers: parseServerMap(servers, "MCP config mcpServers"),
	};
	if (imports !== undefined) config.imports = imports;
	if (settings !== undefined) config.settings = settings;
	return config;
}

function mergeOpenCodeConfigs(base: JsonInputObject, next: JsonInputObject): JsonInputObject {
	const baseMcp = base["mcp"];
	const nextMcp = next["mcp"];
	const mergedMcp: JsonInputObject = isJsonInputObject(baseMcp) ? copyJsonInputObject(baseMcp) : {};

	if (isJsonInputObject(nextMcp)) {
		for (const [name, nextEntry] of Object.entries(nextMcp)) {
			const baseEntry = Object.hasOwn(mergedMcp, name) ? mergedMcp[name] : undefined;
			if (isJsonInputObject(baseEntry) && isJsonInputObject(nextEntry)) {
				const safeBase = copyJsonInputObject(baseEntry);
				const override = nextEntry;
				if (isRuntimeString(override["type"]) && override["type"] !== safeBase["type"]) {
					for (const field of ["command", "environment", "cwd", "url", "headers", "oauth"]) delete safeBase[field];
				}
				if (isRuntimeString(override["url"]) && override["url"] !== safeBase["url"]) {
					delete safeBase["headers"];
					delete safeBase["oauth"];
				}
				if (Array.isArray(override["command"])) {
					const baseCommand = safeBase["command"];
					const commandChanged =
						!Array.isArray(baseCommand) ||
						override["command"].length !== baseCommand.length ||
						override["command"].some((value, index) => value !== baseCommand[index]);
					if (commandChanged) {
						delete safeBase["environment"];
						delete safeBase["cwd"];
					}
				}

				const mergedEntry = copyJsonInputObject(safeBase, override);
				for (const field of ["environment", "headers", "oauth"]) {
					const baseField = safeBase[field];
					const nextField = override[field];
					if (isJsonInputObject(baseField) && isJsonInputObject(nextField)) {
						mergedEntry[field] = copyJsonInputObject(baseField, nextField);
					}
				}
				setJsonInputProperty(mergedMcp, name, mergedEntry);
			} else {
				setJsonInputProperty(mergedMcp, name, nextEntry);
			}
		}
	}

	return { ...base, ...next, mcp: mergedMcp };
}

export function extractServers(config: JsonInputValue, kind: ImportKind): ServerMap {
	if (!isJsonInputObject(config)) return {};

	let servers: JsonInputValue;
	switch (kind) {
		case "claude-desktop":
		case "claude-code":
			servers = config["mcpServers"];
			break;
		case "codex":
			servers = config["mcp_servers"] ?? config["mcpServers"];
			break;
		case "cursor":
		case "windsurf":
		case "vscode":
			servers = config["mcpServers"] ?? config["mcp-servers"];
			break;
		case "opencode":
			servers = config["mcp"];
			break;
		default:
			return {};
	}

	if (!isJsonInputObject(servers)) {
		return {};
	}

	const mappedServers: ServerMap = {};
	for (const [name, entry] of Object.entries(servers)) {
		if (kind === "opencode") {
			if (!isJsonInputObject(entry)) continue;
			const raw = entry;
			if (raw["enabled"] === false) continue;

			if (
				raw["type"] === "local" &&
				Array.isArray(raw["command"]) &&
				raw["command"].length > 0 &&
				raw["command"].every((value): value is string => isRuntimeString(value))
			) {
				const [command, ...args] = raw["command"];
				if (!command) continue;
				const env = toStringRecord(raw["environment"]);
				const mapped: ServerEntry = {
					command,
					args,
				};
				if (env) mapped.env = env;
				if (isRuntimeString(raw["cwd"])) mapped.cwd = raw["cwd"];
				setServer(mappedServers, name, mapped);
				continue;
			}

			if (raw["type"] === "remote" && isRuntimeString(raw["url"])) {
				const headers = toStringRecord(raw["headers"]);
				const mapped: ServerEntry = { url: raw["url"] };
				if (headers) mapped.headers = headers;
				if (raw["oauth"] === false) {
					mapped.oauth = false;
				} else if (isJsonInputObject(raw["oauth"])) {
					const oauth = raw["oauth"];
					mapped.auth = "oauth";
					const oauthConfig: NonNullable<Exclude<ServerEntry["oauth"], false>> = {};
					if (isRuntimeString(oauth["clientId"])) oauthConfig.clientId = oauth["clientId"];
					if (isRuntimeString(oauth["clientSecret"])) oauthConfig.clientSecret = oauth["clientSecret"];
					if (isRuntimeString(oauth["scope"])) oauthConfig.scope = oauth["scope"];
					mapped.oauth = oauthConfig;
				}
				setServer(mappedServers, name, mapped);
			}
			continue;
		}

		if (kind !== "codex" || !isJsonInputObject(entry)) {
			setServer(mappedServers, name, parseServerEntry(entry, `${kind} MCP server ${name}`));
			continue;
		}

		const mapped = copyJsonInputObject(entry);
		const bearerTokenEnv = mapped["bearer_token_env_var"];
		const httpHeaders = mapped["http_headers"];
		const envHttpHeaders = mapped["env_http_headers"];

		if (isRuntimeString(bearerTokenEnv)) {
			mapped["bearerTokenEnv"] = bearerTokenEnv;
			if (mapped["auth"] === undefined) mapped["auth"] = "bearer";
		}
		const parsedHttpHeaders = toStringRecord(httpHeaders);
		if (parsedHttpHeaders) {
			mapped["headers"] = { ...toStringRecord(mapped["headers"]), ...parsedHttpHeaders };
		}
		if (isJsonInputObject(envHttpHeaders)) {
			const headers = { ...toStringRecord(mapped["headers"]) };
			for (const [header, envVar] of Object.entries(envHttpHeaders)) {
				if (isRuntimeString(envVar) && !Object.hasOwn(headers, header)) {
					Object.defineProperty(headers, header, {
						configurable: true,
						enumerable: true,
						value: `$env:${envVar}`,
						writable: true,
					});
				}
			}
			mapped["headers"] = headers;
		}

		delete mapped["bearer_token_env_var"];
		delete mapped["http_headers"];
		delete mapped["env_http_headers"];
		setServer(mappedServers, name, parseServerEntry(mapped, `codex MCP server ${name}`));
	}

	return mappedServers;
}
