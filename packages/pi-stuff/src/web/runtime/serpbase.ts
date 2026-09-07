import * as Effect from "effect/Effect";
import { isJsonInputObject, type JsonInputValue, requireJsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import {
	hostMatchesProviderDomain as domainMatches,
	type ProviderDomainFilters,
	partitionProviderDomains,
} from "../provider-domain-filter.ts";
import { activityMonitor, throwRedactedActivityError } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { hasCredentialSource, redactCredential, requireCredential } from "./credential-source.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import {
	errorMessage,
	formatSearchSources,
	getWebSearchConfigPath,
	nativePromise,
	nativeRequest,
	normalizeCount,
} from "./utils.ts";

const SERPBASE_API_URL = "https://api.serpbase.dev/google/search";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const SEARCH_TIMEOUT_MS = 60_000;
const RECENCY_TBS = {
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
} satisfies Record<NonNullable<SearchOptions["recencyFilter"]>, string>;

interface SerpBaseOrganicResult {
	title?: JsonInputValue;
	link?: JsonInputValue;
	url?: JsonInputValue;
	snippet?: JsonInputValue;
	description?: JsonInputValue;
}

interface SerpBaseResponse {
	organic_results?: SerpBaseOrganicResult[];
	organic?: SerpBaseOrganicResult[];
	results?: SerpBaseOrganicResult[];
	status?: JsonInputValue;
	error?: JsonInputValue;
	message?: JsonInputValue;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	return requireCredential(
		{
			provider: "SerpBase",
			configuredValue: loadConfig()["serpbaseApiKey"],
			environmentValue: process.env["SERPBASE_API_KEY"],
			signal,
		},
		"SerpBase API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "serpbaseApiKey": "your-key" }\n` +
			"  2. Set SERPBASE_API_KEY environment variable\n" +
			"Get a key at https://serpbase.dev",
	);
}

function passesDomainFilters(url: string, filters: ProviderDomainFilters): boolean {
	if (filters.include.length === 0 && filters.exclude.length === 0) return true;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (filters.exclude.some((domain) => domainMatches(hostname, domain))) return false;
	if (filters.include.length === 0) return true;
	return filters.include.some((domain) => domainMatches(hostname, domain));
}

function buildQuery(query: string, filters: ProviderDomainFilters): string {
	const parts = [query];
	if (filters.include.length === 1) parts.push(`site:${filters.include[0]}`);
	if (filters.include.length > 1) parts.push(`(${filters.include.map((domain) => `site:${domain}`).join(" OR ")})`);
	for (const domain of filters.exclude) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

function invalidResponse(message: string): Error {
	return new Error(`SerpBase API returned invalid response: ${message}`);
}

function parseResponse(value: JsonInputValue): SerpBaseResponse {
	if (!isJsonInputObject(value)) throw invalidResponse("expected an object envelope");
	if (isRuntimeString(value["error"]) && value["error"].trim()) {
		const suffix =
			isRuntimeNumber(value["status"]) || isRuntimeString(value["status"]) ? ` (status ${value["status"]})` : "";
		throw invalidResponse(`${value["error"]}${suffix}`);
	}
	const organic = value["organic_results"] ?? value["organic"] ?? value["results"];
	if (!Array.isArray(organic)) throw invalidResponse("expected organic_results array");
	const organicResults: SerpBaseOrganicResult[] = organic.flatMap((item) =>
		isJsonInputObject(item)
			? [
					{
						title: item.title,
						link: item.link,
						url: item.url,
						snippet: item.snippet,
						description: item.description,
					},
				]
			: [],
	);
	return { organic_results: organicResults };
}

export function isSerpBaseAvailable(): boolean {
	return hasCredentialSource({
		provider: "SerpBase",
		configuredValue: loadConfig()["serpbaseApiKey"],
		environmentValue: process.env["SERPBASE_API_KEY"],
	});
}

async function searchWithSerpBaseRequest(
	query: string,
	options: SearchOptions,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const numResults = normalizeCount(options.numResults, 10);
	const filters = partitionProviderDomains(options.domainFilter);
	const url = new URL(SERPBASE_API_URL);
	url.searchParams.set("q", buildQuery(query, filters));
	// SerpBase's Google Search endpoint authenticates with an `api_key` query parameter.
	url.searchParams.set("api_key", apiKey);
	url.searchParams.set("num", String(numResults));
	if (options.recencyFilter && RECENCY_TBS[options.recencyFilter])
		url.searchParams.set("tbs", RECENCY_TBS[options.recencyFilter]);
	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "error",
			headers: { Accept: "application/json" },
			signal,
		});
	} catch (error) {
		throwRedactedActivityError(activityId, error, apiKey);
	}
	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`SerpBase API error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	let rawData: JsonInputValue;
	try {
		rawData = requireJsonInputValue(await response.json(), "SerpBase response");
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`SerpBase API returned invalid JSON: ${errorMessage(err)}`);
	}
	const data = parseResponse(rawData);
	activityMonitor.logComplete(activityId, response.status);
	const results: SearchResponse["results"] = [];
	for (const item of data.organic_results ?? []) {
		const url = isRuntimeString(item.link) ? item.link : isRuntimeString(item.url) ? item.url : "";
		if (!url || !passesDomainFilters(url, filters)) continue;
		results.push({
			title: isRuntimeString(item.title) && item.title.trim() ? item.title : `Source ${results.length + 1}`,
			url,
			snippet: isRuntimeString(item.snippet)
				? item.snippet
				: isRuntimeString(item.description)
					? item.description
					: "",
		});
		if (results.length >= numResults) break;
	}
	return { answer: formatSearchSources(results), results };
}

export function searchWithSerpBase(query: string, options: SearchOptions = {}) {
	return nativePromise(requireApiKey, options.signal).pipe(
		Effect.flatMap((apiKey) =>
			nativeRequest(
				(signal) => searchWithSerpBaseRequest(query, options, apiKey, signal),
				SEARCH_TIMEOUT_MS,
				options.signal,
			),
		),
	);
}
