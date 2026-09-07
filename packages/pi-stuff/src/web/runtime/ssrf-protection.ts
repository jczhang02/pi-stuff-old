import net from "node:net";
import {
	isJsonInputObject,
	type JsonInputObject,
	type JsonInputValue,
	jsonInputKind,
} from "../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeString } from "../../shared/runtime-type.ts";
import { type DomainPolicy, validateRemoteAllowRanges } from "../../shared/ssrf-protection.ts";
import { readWebConfig } from "./config.ts";
import { getWebSearchConfigPath } from "./utils.ts";

export type { DomainPolicy } from "../../shared/ssrf-protection.ts";
export {
	fetchRemoteUrl,
	type Lookup,
	type LookupAddress,
	validateRemoteUrl,
} from "../../shared/ssrf-protection.ts";

const WEB_SEARCH_CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;

function loadConfigRoot(): JsonInputObject | null {
	return readWebConfig() ?? null;
}

export interface SsrfConfig {
	allowRanges: string[];
	trustEnvProxy: boolean;
}

export interface RuntimeSsrfDefaults {
	readonly allowRanges?: readonly string[];
	readonly trustEnvProxy?: boolean;
}

let runtimeSsrfDefaults: SsrfConfig = { allowRanges: [], trustEnvProxy: false };

/**
 * Configure process-local defaults for an embedding host. Explicit `web` namespace
 * fields still win, including an empty allowRanges array. This function never
 * reads or writes user settings and validates every range before applying it.
 */
export function configureRuntimeSsrfDefaults(defaults: RuntimeSsrfDefaults = {}): void {
	const allowRanges = [...(defaults.allowRanges ?? [])];
	validateRemoteAllowRanges(allowRanges);
	runtimeSsrfDefaults = {
		allowRanges,
		trustEnvProxy: defaults.trustEnvProxy === true,
	};
}

const DEFAULT_DOMAIN_POLICY: DomainPolicy = { allow: [], deny: [] };

export function loadFetchContentDomainPolicy(): DomainPolicy {
	const parsed = loadConfigRoot();
	if (!parsed) return { ...DEFAULT_DOMAIN_POLICY };
	const fetchContent = parsed["fetchContent"];
	if (fetchContent === undefined || fetchContent === null) return { ...DEFAULT_DOMAIN_POLICY };
	if (!isJsonInputObject(fetchContent)) {
		throw new Error(`fetchContent in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	const policy = fetchContent["domainPolicy"];
	if (policy === undefined || policy === null) return { ...DEFAULT_DOMAIN_POLICY };
	if (!isJsonInputObject(policy)) {
		throw new Error(`fetchContent.domainPolicy in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	return {
		allow: parseDomainEntries(policy["allow"], "allow"),
		deny: parseDomainEntries(policy["deny"], "deny"),
	};
}

function parseDomainEntries(value: JsonInputValue, field: "allow" | "deny"): string[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value)) {
		throw new Error(`fetchContent.domainPolicy.${field} in ${WEB_SEARCH_CONFIG_PATH} must be an array of hostnames`);
	}
	return value.map((entry, index) => {
		if (!isRuntimeString(entry)) {
			throw new Error(
				`fetchContent.domainPolicy.${field} in ${WEB_SEARCH_CONFIG_PATH} must contain only hostnames; entry ${index + 1} is ${jsonInputKind(entry)}`,
			);
		}
		const hostname = normalizeDomainEntry(entry);
		if (!hostname) {
			throw new Error(
				`fetchContent.domainPolicy.${field} in ${WEB_SEARCH_CONFIG_PATH} contains an invalid hostname: ${JSON.stringify(entry)}`,
			);
		}
		return hostname;
	});
}

function normalizeDomainEntry(entry: string): string | null {
	const hostname = entry
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
	if (!hostname || /\s|[\\/?:#@]/.test(hostname)) return null;
	if (net.isIP(hostname)) return hostname;
	if (
		hostname.length > 253 ||
		!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname)
	)
		return null;
	return hostname;
}

export function loadSsrfConfig(): SsrfConfig {
	const parsed = loadConfigRoot();
	if (!parsed) {
		return {
			allowRanges: [...runtimeSsrfDefaults.allowRanges],
			trustEnvProxy: runtimeSsrfDefaults.trustEnvProxy,
		};
	}
	const ssrf = parsed["ssrf"];
	if (ssrf === undefined || ssrf === null) {
		return {
			allowRanges: [...runtimeSsrfDefaults.allowRanges],
			trustEnvProxy: runtimeSsrfDefaults.trustEnvProxy,
		};
	}
	if (!isJsonInputObject(ssrf)) {
		throw new Error(`ssrf in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	if (ssrf["allowRanges"] !== undefined && ssrf["allowRanges"] !== null && !Array.isArray(ssrf["allowRanges"])) {
		throw new Error(`ssrf.allowRanges in ${WEB_SEARCH_CONFIG_PATH} must be an array of CIDR strings`);
	}
	if (ssrf["trustEnvProxy"] !== undefined && !isRuntimeBoolean(ssrf["trustEnvProxy"])) {
		throw new Error(`ssrf.trustEnvProxy in ${WEB_SEARCH_CONFIG_PATH} must be a boolean`);
	}
	const allowRanges = Array.isArray(ssrf["allowRanges"])
		? ssrf["allowRanges"]
				.map((entry, index) => {
					if (!isRuntimeString(entry)) {
						throw new Error(
							`ssrf.allowRanges in ${WEB_SEARCH_CONFIG_PATH} must contain only CIDR strings; entry ${index + 1} is ${jsonInputKind(entry)}`,
						);
					}
					return entry.trim();
				})
				.filter(Boolean)
		: [...runtimeSsrfDefaults.allowRanges];
	validateRemoteAllowRanges(allowRanges);
	return {
		allowRanges,
		trustEnvProxy: isRuntimeBoolean(ssrf["trustEnvProxy"])
			? ssrf["trustEnvProxy"]
			: runtimeSsrfDefaults.trustEnvProxy,
	};
}
