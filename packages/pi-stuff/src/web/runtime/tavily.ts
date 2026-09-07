import * as Effect from "effect/Effect";
import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";
import { isJsonInputObject } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { normalizeProviderDomain as normalizeDomain } from "../provider-domain-filter.ts";
import { activityMonitor, throwRedactedActivityError } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { hasCredentialSource, redactCredential, requireCredential } from "./credential-source.ts";
import type { ExtractedContent } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { errorMessage, getWebSearchConfigPath, nativePromise, nativeRequest, normalizeCount } from "./utils.ts";

const TAVILY_API_URL = "https://api.tavily.com/search";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const SEARCH_TIMEOUT_MS = 60_000;

interface TavilySearchOptions extends SearchOptions {
	includeContent?: boolean;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	return requireCredential(
		{
			provider: "Tavily",
			configuredValue: loadConfig()["tavilyApiKey"],
			environmentValue: process.env["TAVILY_API_KEY"],
			signal,
		},
		"Tavily API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "tavilyApiKey": "your-key" }\n` +
			"  2. Set TAVILY_API_KEY environment variable\n" +
			"Get a key at https://app.tavily.com/",
	);
}

interface TavilyDomainFilter {
	include_domains?: string[];
	exclude_domains?: string[];
}

function mapDomainFilter(domainFilter: string[] | undefined): TavilyDomainFilter {
	if (!domainFilter?.length) return {};
	const include_domains: string[] = [];
	const exclude_domains: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? exclude_domains : include_domains;
		if (!target.includes(domain)) target.push(domain);
	}
	const filter: TavilyDomainFilter = {};
	if (include_domains.length > 0) filter.include_domains = include_domains;
	if (exclude_domains.length > 0) filter.exclude_domains = exclude_domains;
	return filter;
}

function mapResults(results: JsonInputValue, numResults: number): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResponse["results"] = [];
	for (const item of results) {
		if (!isJsonInputObject(item) || !isRuntimeString(item.url)) continue;
		mapped.push({
			title: isRuntimeString(item.title) ? item.title : `Source ${mapped.length + 1}`,
			url: item.url,
			snippet: isRuntimeString(item.content) ? item.content.replace(/\s+/g, " ").trim() : "",
		});
		if (mapped.length >= numResults) break;
	}
	return mapped;
}

function mapInlineContent(results: JsonInputValue): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		if (
			!isJsonInputObject(item) ||
			!isRuntimeString(item.url) ||
			!isRuntimeString(item.raw_content) ||
			item.raw_content.trim().length === 0
		)
			return [];
		return [
			{
				url: item.url,
				title: isRuntimeString(item.title) ? item.title : "",
				content: item.raw_content,
				error: null,
			},
		];
	});
}

export function isTavilyAvailable(): boolean {
	return hasCredentialSource({
		provider: "Tavily",
		configuredValue: loadConfig()["tavilyApiKey"],
		environmentValue: process.env["TAVILY_API_KEY"],
	});
}

async function searchWithTavilyRequest(
	query: string,
	options: TavilySearchOptions,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const numResults = normalizeCount(options.numResults);
	const body: JsonInputObject = {
		query,
		search_depth: "basic",
		max_results: numResults,
		include_answer: "basic",
		include_raw_content: options.includeContent ? "markdown" : false,
	};
	if (options.recencyFilter) body["time_range"] = options.recencyFilter;
	Object.assign(body, mapDomainFilter(options.domainFilter));

	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetch(TAVILY_API_URL, {
			method: "POST",
			redirect: "error",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal,
		});
	} catch (error) {
		throwRedactedActivityError(activityId, error, apiKey);
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Tavily API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let data: JsonInputObject;
	try {
		const responseBody = await response.json();
		if (!isJsonInputObject(responseBody)) throw new TypeError("expected an object");
		data = responseBody;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Tavily API returned invalid JSON: ${errorMessage(err)}`);
	}

	activityMonitor.logComplete(activityId, response.status);
	const result: SearchResponse = {
		answer: isRuntimeString(data["answer"]) ? data["answer"] : "",
		results: mapResults(data["results"], numResults),
	};
	if (options.includeContent) {
		const inlineContent = mapInlineContent(data["results"]);
		if (inlineContent.length > 0) result.inlineContent = inlineContent;
	}
	return result;
}

export function searchWithTavily(query: string, options: TavilySearchOptions = {}) {
	return nativePromise(requireApiKey, options.signal).pipe(
		Effect.flatMap((apiKey) =>
			nativeRequest(
				(signal) => searchWithTavilyRequest(query, options, apiKey, signal),
				SEARCH_TIMEOUT_MS,
				options.signal,
			),
		),
	);
}
