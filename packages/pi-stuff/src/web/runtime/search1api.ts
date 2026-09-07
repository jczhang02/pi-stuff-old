import * as Effect from "effect/Effect";
import type { JsonInputValue } from "../../shared/json-value.ts";
import { isJsonInputObject, type JsonInputObject, parseJsonObject } from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { normalizeProviderDomain as normalizeDomain } from "../provider-domain-filter.ts";
import { activityMonitor, throwRedactedActivityError } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { hasCredentialSource, redactCredential, requireCredential } from "./credential-source.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import {
	errorMessage,
	formatSearchSources,
	getWebSearchConfigPath,
	nativePromise,
	nativeRequest,
	normalizeCount,
} from "./utils.ts";

const SEARCH1API_SEARCH_URL = "https://api.search1api.com/search";
const SEARCH1API_CRAWL_URL = "https://api.search1api.com/crawl";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const SEARCH_TIMEOUT_MS = 60_000;
const CRAWL_TIMEOUT_MS = 60_000;

interface Search1APISearchOptions extends SearchOptions {
	includeContent?: boolean;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	return requireCredential(
		{
			provider: "Search1API",
			configuredValue: loadConfig()["search1apiApiKey"],
			environmentValue: process.env["SEARCH1API_KEY"],
			signal,
		},
		"Search1API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "search1apiApiKey": "your-key" }\n` +
			"  2. Set SEARCH1API_KEY environment variable\n" +
			"Create a key at https://dashboard.search1api.com",
	);
}

export function isSearch1APIAvailable(): boolean {
	return hasCredentialSource({
		provider: "Search1API",
		configuredValue: loadConfig()["search1apiApiKey"],
		environmentValue: process.env["SEARCH1API_KEY"],
	});
}

function mapDomainFilter(domainFilter: string[] | undefined) {
	const includeSites: string[] = [];
	const excludeSites: string[] = [];
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? excludeSites : includeSites;
		if (!target.includes(domain)) target.push(domain);
	}
	return { includeSites, excludeSites };
}

function buildSearchBody(query: string, options: Search1APISearchOptions): JsonInputObject {
	const numResults = normalizeCount(options.numResults);
	const { includeSites, excludeSites } = mapDomainFilter(options.domainFilter);
	const body: JsonInputObject = {
		query,
		max_results: numResults,
		crawl_results: options.includeContent ? numResults : 0,
	};
	if (includeSites.length > 0) body["include_sites"] = includeSites;
	if (excludeSites.length > 0) body["exclude_sites"] = excludeSites;
	if (options.recencyFilter) body["time_range"] = options.recencyFilter;
	return body;
}

async function search1APIJsonRequest(
	label: "Search" | "Crawl",
	url: string,
	apiKey: string,
	body: JsonInputObject,
	signal: AbortSignal,
): Promise<JsonInputObject> {
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			redirect: "error",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}

	const raw = await response.text();
	if (!response.ok) {
		throw new Error(
			`Search1API ${label} API error ${response.status}: ${redactCredential(raw, apiKey).slice(0, 300)}`,
		);
	}
	try {
		return parseJsonObject(raw);
	} catch (err) {
		throw new Error(`Search1API ${label} API returned invalid JSON: ${errorMessage(err)}`);
	}
}

function mapSearchResults(results: JsonInputValue): SearchResponse["results"] {
	if (!Array.isArray(results)) {
		throw new Error("Search1API Search API returned an unexpected response shape");
	}
	return results.flatMap((item) => {
		if (!isJsonInputObject(item) || !isRuntimeString(item.link) || item.link.trim().length === 0) return [];
		const url = item.link.trim();
		return [
			{
				title: isRuntimeString(item.title) && item.title.trim() ? item.title.trim() : url,
				url,
				snippet: isRuntimeString(item.snippet) ? item.snippet.replace(/\s+/g, " ").trim() : "",
			},
		];
	});
}

function mapInlineContent(results: JsonInputValue): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		if (!isJsonInputObject(item) || !isRuntimeString(item.link) || item.link.trim().length === 0) return [];
		if (!isRuntimeString(item.content) || item.content.trim().length === 0) return [];
		return [
			{
				url: item.link.trim(),
				title: isRuntimeString(item.title) ? item.title.trim() : "",
				content: item.content,
				error: null,
			},
		];
	});
}

async function searchWithSearch1APIRequest(
	query: string,
	options: Search1APISearchOptions,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const activityId = activityMonitor.logStart({ type: "api", query });
	try {
		const data = await search1APIJsonRequest(
			"Search",
			SEARCH1API_SEARCH_URL,
			apiKey,
			buildSearchBody(query, options),
			signal,
		);
		const results = mapSearchResults(data["results"]);
		const response: SearchResponse = { answer: formatSearchSources(results), results };
		if (options.includeContent) {
			const inlineContent = mapInlineContent(data["results"]);
			if (inlineContent.length > 0) response.inlineContent = inlineContent;
		}
		activityMonitor.logComplete(activityId, 200);
		return response;
	} catch (error) {
		throwRedactedActivityError(activityId, error, apiKey);
	}
}

export function searchWithSearch1API(query: string, options: Search1APISearchOptions = {}) {
	return nativePromise(getApiKey, options.signal).pipe(
		Effect.flatMap((apiKey) =>
			nativeRequest(
				(signal) => searchWithSearch1APIRequest(query, options, apiKey, signal),
				SEARCH_TIMEOUT_MS,
				options.signal,
			),
		),
	);
}

async function extractWithSearch1APIRequest(
	url: string,
	apiKey: string,
	signal: AbortSignal,
): Promise<ExtractedContent | null> {
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	try {
		const data = await search1APIJsonRequest("Crawl", SEARCH1API_CRAWL_URL, apiKey, { url }, signal);
		const result = data["results"];
		if (!isJsonInputObject(result)) {
			throw new Error("Search1API Crawl API returned an unexpected response shape");
		}
		const content = isRuntimeString(result["content"]) ? result["content"].trim() : "";
		if (!content) {
			activityMonitor.logComplete(activityId, 200);
			return null;
		}
		activityMonitor.logComplete(activityId, 200);
		return {
			url,
			title: isRuntimeString(result["title"]) ? result["title"].trim() : "",
			content,
			error: null,
		};
	} catch (error) {
		throwRedactedActivityError(activityId, error, apiKey);
	}
}

export function extractWithSearch1API(url: string, signal?: AbortSignal, options: ExtractOptions = {}) {
	const timeoutMs =
		isRuntimeNumber(options.timeoutMs) && Number.isFinite(options.timeoutMs)
			? Math.max(1, Math.floor(options.timeoutMs))
			: CRAWL_TIMEOUT_MS;
	return nativePromise(getApiKey, signal).pipe(
		Effect.flatMap((apiKey) =>
			nativeRequest((requestSignal) => extractWithSearch1APIRequest(url, apiKey, requestSignal), timeoutMs, signal),
		),
	);
}
