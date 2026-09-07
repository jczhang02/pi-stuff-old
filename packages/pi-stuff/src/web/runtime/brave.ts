import * as Effect from "effect/Effect";
import { isJsonInputObject } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import {
	hostMatchesProviderDomain as hostMatchesDomain,
	normalizeProviderDomain as normalizeDomain,
} from "../provider-domain-filter.ts";
import { activityMonitor, throwRedactedActivityError } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { hasCredentialSource, redactCredential, requireCredential } from "./credential-source.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.ts";
import { formatSearchSources, getWebSearchConfigPath, nativePromise, nativeRequest, normalizeCount } from "./utils.ts";

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const SEARCH_TIMEOUT_MS = 30_000;

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

function loadConfig() {
	return readWebConfig() ?? {};
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	return requireCredential(
		{
			provider: "Brave",
			configuredValue: loadConfig()["braveApiKey"],
			environmentValue: process.env["BRAVE_API_KEY"],
			signal,
		},
		"Brave Search API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "braveApiKey": "your-key" }\n` +
			"  2. Set BRAVE_API_KEY environment variable\n" +
			"Get a key at https://brave.com/search/api/",
	);
}

function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters {
	const filters: NormalizedDomainFilters = { allowed: [], blocked: [] };
	if (!domainFilter?.length) return filters;

	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) target.push(domain);
	}

	return filters;
}

function buildBraveQuery(query: string, domainFilter: string[] | undefined): string {
	const filters = normalizeDomainFilters(domainFilter);
	const parts = [query];

	if (filters.allowed.length === 1) {
		parts.push(`site:${filters.allowed[0]}`);
	} else if (filters.allowed.length > 1) {
		parts.push(filters.allowed.map((domain) => `site:${domain}`).join(" OR "));
	}

	for (const domain of filters.blocked) {
		parts.push(`NOT site:${domain}`);
	}

	return parts.join(" ");
}

function matchesDomainFilters(url: string, filters: NormalizedDomainFilters): boolean {
	if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;

	let hostname = "";
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}

	if (filters.allowed.length > 0 && !filters.allowed.some((domain) => hostMatchesDomain(hostname, domain))) {
		return false;
	}

	return !filters.blocked.some((domain) => hostMatchesDomain(hostname, domain));
}

export function isBraveAvailable(): boolean {
	return hasCredentialSource({
		provider: "Brave",
		configuredValue: loadConfig()["braveApiKey"],
		environmentValue: process.env["BRAVE_API_KEY"],
	});
}

async function searchWithBraveRequest(
	query: string,
	options: SearchOptions,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const numResults = normalizeCount(options.numResults);
	const domainFilters = normalizeDomainFilters(options.domainFilter);
	const searchQuery = buildBraveQuery(query, options.domainFilter);
	const activityId = activityMonitor.logStart({ type: "api", query: searchQuery });
	const params = new URLSearchParams({
		q: searchQuery,
		count: String(options.domainFilter?.length ? 20 : numResults),
	});

	if (options.recencyFilter) {
		const freshnessMap = {
			day: "pd",
			week: "pw",
			month: "pm",
			year: "py",
		} satisfies Record<NonNullable<SearchOptions["recencyFilter"]>, string>;
		const freshness = freshnessMap[options.recencyFilter];
		if (freshness) params.set("freshness", freshness);
	}

	try {
		const response = await fetch(`${BRAVE_API_URL}?${params.toString()}`, {
			method: "GET",
			redirect: "error",
			headers: {
				"X-Subscription-Token": apiKey,
				Accept: "application/json",
				"Accept-Encoding": "gzip",
			},
			signal,
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = redactCredential(await response.text(), apiKey);
			throw new Error(`Brave Search API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await response.json();
		if (!isJsonInputObject(data)) throw new Error("Brave Search API returned an invalid response");
		activityMonitor.logComplete(activityId, response.status);

		const results: SearchResult[] = [];
		const web = isJsonInputObject(data["web"]) ? data["web"] : undefined;
		const responseResults = Array.isArray(web?.["results"]) ? web["results"] : [];
		for (const item of responseResults) {
			if (!isJsonInputObject(item) || !isRuntimeString(item.url) || !matchesDomainFilters(item.url, domainFilters))
				continue;
			results.push({
				title: isRuntimeString(item.title) ? item.title : item.url,
				url: item.url,
				snippet: isRuntimeString(item.description) ? item.description : "",
			});
			if (results.length >= numResults) break;
		}

		return { answer: formatSearchSources(results), results };
	} catch (error) {
		throwRedactedActivityError(activityId, error, apiKey);
	}
}

export function searchWithBrave(query: string, options: SearchOptions = {}) {
	return nativePromise(getApiKey, options.signal).pipe(
		Effect.flatMap((apiKey) =>
			nativeRequest(
				(signal) => searchWithBraveRequest(query, options, apiKey, signal),
				SEARCH_TIMEOUT_MS,
				options.signal,
			),
		),
	);
}
