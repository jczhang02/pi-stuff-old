import { Buffer } from "node:buffer";
import { type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";

export const SUBAGENT_CAPABILITY_CEILING_VERSION = 1 as const;
export const SUBAGENT_CAPABILITY_CEILING_ENV = "PI_SUBAGENT_CAPABILITY_CEILING_V1";

export interface ResolvedSubagentCapabilityCeiling {
	version: typeof SUBAGENT_CAPABILITY_CEILING_VERSION;
	allowedTools?: string[];
	denyExtensions: boolean;
	sources: string[];
}

export interface SubagentCapabilityAudit {
	ceiling: ResolvedSubagentCapabilityCeiling;
	requestedTools?: string[];
	effectiveTools: string[];
	removedTools: string[];
	internalTools: string[];
	extensionsDenied: boolean;
	removedExtensionCount: number;
	requestedMcpToolCount: number;
	effectiveMcpTools: string[];
}

function hasControlCharacter(value: string): boolean {
	for (const character of value) {
		const code = character.charCodeAt(0);
		if (code <= 0x1f || code === 0x7f) return true;
	}
	return false;
}

function validateText<Value>(value: Value, field: string): string {
	if (
		!isRuntimeString(value) ||
		!value.trim() ||
		hasControlCharacter(value) ||
		Buffer.byteLength(value.trim(), "utf8") > 256
	) {
		throw new Error(
			`Invalid capability ceiling ${field}; expected a non-empty string without control characters (max 256 UTF-8 bytes).`,
		);
	}
	return value.trim();
}

function normalizeCeiling<Ceiling>(ceiling: Ceiling): ResolvedSubagentCapabilityCeiling {
	if (!ceiling || !isRuntimeObject(ceiling) || Array.isArray(ceiling))
		throw new Error("Invalid capability ceiling; expected an object.");
	const hasAllowedTools = Object.hasOwn(ceiling, "allowedTools");
	const hasDenyExtensions = Object.hasOwn(ceiling, "denyExtensions");
	if (!hasAllowedTools && !hasDenyExtensions)
		throw new Error("Invalid capability ceiling; expected allowedTools or denyExtensions.");
	const denyExtensions = "denyExtensions" in ceiling ? ceiling.denyExtensions : undefined;
	if (hasDenyExtensions && !isRuntimeBoolean(denyExtensions))
		throw new Error("Invalid capability ceiling denyExtensions; expected a boolean.");
	let allowedTools: string[] | undefined;
	if (hasAllowedTools) {
		const rawAllowedTools = "allowedTools" in ceiling ? ceiling.allowedTools : undefined;
		if (!Array.isArray(rawAllowedTools))
			throw new Error("Invalid capability ceiling allowedTools; expected an array.");
		if (rawAllowedTools.length > 256)
			throw new Error("Invalid capability ceiling allowedTools; expected at most 256 names.");
		allowedTools = [
			...new Set(
				rawAllowedTools.map((tool) => {
					const name = validateText(tool, "allowedTools entry");
					if (!/^[A-Za-z0-9_.:-]+$/u.test(name))
						throw new Error(`Invalid capability ceiling allowedTools entry '${name}'.`);
					if (Buffer.byteLength(name, "utf8") > 128)
						throw new Error(`Invalid capability ceiling allowedTools entry '${name}'; max 128 UTF-8 bytes.`);
					return name;
				}),
			),
		].sort();
	}
	const normalized: ResolvedSubagentCapabilityCeiling = {
		version: SUBAGENT_CAPABILITY_CEILING_VERSION,
		denyExtensions: denyExtensions === true,
		sources: [],
	};
	if (allowedTools) normalized.allowedTools = allowedTools;
	return normalized;
}

export function parseSubagentCapabilityCeiling<Value>(
	value: Value,
	field = "capability ceiling",
): ResolvedSubagentCapabilityCeiling {
	if (!value || !isRuntimeObject(value) || Array.isArray(value))
		throw new Error(`Invalid ${field}; expected an object.`);
	if (!("version" in value) || value.version !== SUBAGENT_CAPABILITY_CEILING_VERSION)
		throw new Error(`Invalid ${field} version.`);
	const normalized = normalizeCeiling(value);
	const sources = "sources" in value ? value.sources : undefined;
	if (!Array.isArray(sources) || sources.some((source) => !isRuntimeString(source)))
		throw new Error(`Invalid ${field} sources; expected an array of strings.`);
	normalized.sources = [...new Set(sources.map((source) => validateText(source, `${field} source`)))].sort();
	return normalized;
}

export function intersectSubagentCapabilityCeilings(
	...ceilings: Array<ResolvedSubagentCapabilityCeiling | undefined>
): ResolvedSubagentCapabilityCeiling | undefined {
	const active = ceilings.filter((ceiling): ceiling is ResolvedSubagentCapabilityCeiling => ceiling !== undefined);
	if (active.length === 0) return undefined;
	const definedLists = active
		.filter((ceiling) => ceiling.allowedTools !== undefined)
		.map((ceiling) => new Set(ceiling.allowedTools));
	let allowedTools: string[] | undefined;
	const firstDefinedList = definedLists.at(0);
	if (firstDefinedList) {
		allowedTools = [...firstDefinedList].filter((tool) => definedLists.every((list) => list.has(tool))).sort();
	}
	const intersection: ResolvedSubagentCapabilityCeiling = {
		version: SUBAGENT_CAPABILITY_CEILING_VERSION,
		denyExtensions: active.some((ceiling) => ceiling.denyExtensions),
		sources: [...new Set(active.flatMap((ceiling) => ceiling.sources))].sort(),
	};
	if (allowedTools) intersection.allowedTools = allowedTools;
	return intersection;
}

export function resolveCurrentSubagentCapabilityCeiling(
	_sessionId?: string,
): ResolvedSubagentCapabilityCeiling | undefined {
	return decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV]);
}

export function encodeSubagentCapabilityCeiling(
	ceiling: ResolvedSubagentCapabilityCeiling | undefined,
): string | undefined {
	if (!ceiling) return undefined;
	return Buffer.from(JSON.stringify(ceiling), "utf8").toString("base64url");
}

export function decodeSubagentCapabilityCeiling(
	value: string | undefined,
): ResolvedSubagentCapabilityCeiling | undefined {
	if (value === undefined || value === "") return undefined;
	let parsed: JsonValue;
	try {
		parsed = parseJsonValue(Buffer.from(value, "base64url").toString("utf8"));
	} catch (error) {
		throw new Error(
			`Invalid inherited capability ceiling: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (
		!parsed ||
		!isRuntimeObject(parsed) ||
		Array.isArray(parsed) ||
		!("version" in parsed) ||
		parsed["version"] !== SUBAGENT_CAPABILITY_CEILING_VERSION
	) {
		throw new Error("Invalid inherited capability ceiling version.");
	}
	return parseSubagentCapabilityCeiling(parsed, "inherited capability ceiling");
}
