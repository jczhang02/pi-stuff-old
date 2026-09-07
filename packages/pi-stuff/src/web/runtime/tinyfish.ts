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

const TINYFISH_SEARCH_URL = "https://api.search.tinyfish.ai";
const TINYFISH_FETCH_URL = "https://api.fetch.tinyfish.ai";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const SEARCH_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 150_000;
const MAX_FETCH_URLS = 10;
const MAX_FETCH_PER_URL_TIMEOUT_MS = 110_000;

interface TinyFishSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	return requireCredential(
		{
			provider: "TinyFish",
			configuredValue: loadConfig()["tinyfishApiKey"],
			environmentValue: process.env["TINYFISH_API_KEY"],
			signal,
		},
		"TinyFish API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "tinyfishApiKey": "your-key" }\n` +
			"  2. Set TINYFISH_API_KEY environment variable\n" +
			"Get a key at https://agent.tinyfish.ai/api-keys",
	);
}

export function isTinyFishAvailable(): boolean {
	return hasCredentialSource({
		provider: "TinyFish",
		configuredValue: loadConfig()["tinyfishApiKey"],
		environmentValue: process.env["TINYFISH_API_KEY"],
	});
}

function mapDomainFilter(domainFilter: string[] | undefined) {
	const includeDomains: string[] = [];
	const excludeDomains: string[] = [];
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? excludeDomains : includeDomains;
		if (!target.includes(domain)) target.push(domain);
	}
	return { includeDomains, excludeDomains };
}

function recencyMinutes(filter: SearchOptions["recencyFilter"]): number | undefined {
	if (!filter) return undefined;
	const minutes = {
		day: 1_440,
		week: 10_080,
		month: 43_200,
		year: 525_600,
	} satisfies Record<NonNullable<SearchOptions["recencyFilter"]>, number>;
	return minutes[filter];
}

function buildSearchUrl(query: string, options: SearchOptions, page: number): string {
	const params = new URLSearchParams({ query });
	const { includeDomains, excludeDomains } = mapDomainFilter(options.domainFilter);
	if (includeDomains.length > 0) params.set("include_domains", includeDomains.join(","));
	if (excludeDomains.length > 0) params.set("exclude_domains", excludeDomains.join(","));
	const recency = recencyMinutes(options.recencyFilter);
	if (recency !== undefined) params.set("recency_minutes", String(recency));
	if (page > 0) params.set("page", String(page));
	return `${TINYFISH_SEARCH_URL}?${params.toString()}`;
}

async function tinyFishJsonRequestNative(
	label: "Search" | "Fetch",
	url: string,
	apiKey: string,
	init: RequestInit,
	signal: AbortSignal,
): Promise<JsonInputObject> {
	let response: Response;
	try {
		const headers = new Headers(init.headers);
		headers.set("X-API-Key", apiKey);
		if (init.body) headers.set("Content-Type", "application/json");
		response = await fetch(url, {
			...init,
			redirect: "error",
			headers,
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
		throw new Error(`TinyFish ${label} API error ${response.status}: ${redactCredential(raw, apiKey).slice(0, 300)}`);
	}
	try {
		return parseJsonObject(raw);
	} catch (err) {
		throw new Error(`TinyFish ${label} API returned invalid JSON: ${errorMessage(err)}`);
	}
}

function tinyFishJsonRequest(
	label: "Search" | "Fetch",
	url: string,
	apiKey: string,
	init: RequestInit,
	timeoutMs: number,
	signal?: AbortSignal,
) {
	return nativeRequest(
		(requestSignal) => tinyFishJsonRequestNative(label, url, apiKey, init, requestSignal),
		timeoutMs,
		signal,
	);
}

function mapSearchResults(results: JsonInputValue): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		if (!isJsonInputObject(item) || !isRuntimeString(item.url) || item.url.trim().length === 0) return [];
		const url = item.url.trim();
		return [
			{
				title: isRuntimeString(item.title) && item.title.trim() ? item.title.trim() : url,
				url,
				snippet: isRuntimeString(item.snippet) ? item.snippet.replace(/\s+/g, " ").trim() : "",
			},
		];
	});
}

function deduplicateResults(results: SearchResponse["results"], limit: number): SearchResponse["results"] {
	const seen = new Set<string>();
	const unique: SearchResponse["results"] = [];
	for (const result of results) {
		if (seen.has(result.url)) continue;
		seen.add(result.url);
		unique.push(result);
		if (unique.length >= limit) break;
	}
	return unique;
}

function fetchPerUrlTimeout(value: number | undefined): number {
	if (!isRuntimeNumber(value) || !Number.isFinite(value)) return MAX_FETCH_PER_URL_TIMEOUT_MS;
	return Math.max(1, Math.min(Math.floor(value), MAX_FETCH_PER_URL_TIMEOUT_MS));
}

function fetchBody(urls: string[], options: ExtractOptions = {}): JsonInputObject {
	const body: JsonInputObject = {
		urls,
		format: "markdown",
		per_url_timeout_ms: fetchPerUrlTimeout(options.timeoutMs),
	};
	return body;
}

function findFetchError(errors: JsonInputValue, url: string): JsonInputObject | undefined {
	if (!Array.isArray(errors)) return undefined;
	const exact = errors.find((item): item is JsonInputObject => isJsonInputObject(item) && item.url === url);
	return exact ?? (isJsonInputObject(errors[0]) ? errors[0] : undefined);
}

function fetchResultContent(result: JsonInputObject): string {
	if (isRuntimeString(result["text"])) return result["text"].trim();
	if (isJsonInputObject(result["text"])) return JSON.stringify(result["text"], null, 2);
	return "";
}

function mapFetchResult(result: JsonInputValue, requestedUrl: string): ExtractedContent | null {
	if (!isJsonInputObject(result)) return null;
	const content = fetchResultContent(result);
	if (!content) return null;
	return {
		url: requestedUrl,
		title: isRuntimeString(result["title"]) ? result["title"].trim() : "",
		content,
		error: null,
	};
}

function fetchBatch(
	urls: string[],
	apiKey: string,
	signal?: AbortSignal,
	options: ExtractOptions = {},
): Effect.Effect<JsonInputObject, Error> {
	return tinyFishJsonRequest(
		"Fetch",
		TINYFISH_FETCH_URL,
		apiKey,
		{ method: "POST", body: JSON.stringify(fetchBody(urls, options)) },
		FETCH_TIMEOUT_MS,
		signal,
	);
}

function fetchInlineContent(urls: string[], apiKey: string, signal?: AbortSignal) {
	return Effect.gen(function* () {
		const content: ExtractedContent[] = [];
		for (let offset = 0; offset < urls.length; offset += MAX_FETCH_URLS) {
			const batch = urls.slice(offset, offset + MAX_FETCH_URLS);
			const data = yield* fetchBatch(batch, apiKey, signal);
			if (!Array.isArray(data["results"]) || !Array.isArray(data["errors"])) {
				return yield* Effect.fail(new Error("TinyFish Fetch API returned an unexpected response shape"));
			}
			for (const url of batch) {
				const result = data["results"].find(
					(item) => isJsonInputObject(item) && (item.url === url || item.final_url === url),
				);
				const mapped = mapFetchResult(result, url);
				if (mapped) content.push(mapped);
			}
		}
		return content;
	});
}

function redactedActivityFailure(activityId: string, error: Error, apiKey: string) {
	return Effect.try({
		try: () => throwRedactedActivityError(activityId, error, apiKey),
		catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
	});
}

export function searchWithTinyFish(query: string, options: TinyFishSearchOptions = {}) {
	return nativePromise(getApiKey, options.signal).pipe(
		Effect.flatMap((apiKey) => {
			const numResults = normalizeCount(options.numResults);
			const activityId = activityMonitor.logStart({ type: "api", query });
			return Effect.gen(function* () {
				const combined: SearchResponse["results"] = [];
				const pages = numResults > 10 ? 2 : 1;
				for (let page = 0; page < pages; page++) {
					const data = yield* tinyFishJsonRequest(
						"Search",
						buildSearchUrl(query, options, page),
						apiKey,
						{ method: "GET" },
						SEARCH_TIMEOUT_MS,
						options.signal,
					);
					if (!Array.isArray(data["results"])) {
						return yield* Effect.fail(new Error("TinyFish Search API returned an unexpected response shape"));
					}
					combined.push(...mapSearchResults(data["results"]));
					if (data["results"].length < 10) break;
				}

				const results = deduplicateResults(combined, numResults);
				const response: SearchResponse = { answer: formatSearchSources(results), results };
				if (options.includeContent && results.length > 0) {
					const inlineContent = yield* fetchInlineContent(
						results.map((result) => result.url),
						apiKey,
						options.signal,
					);
					if (inlineContent.length > 0) response.inlineContent = inlineContent;
				}
				activityMonitor.logComplete(activityId, 200);
				return response;
			}).pipe(Effect.catch((error) => redactedActivityFailure(activityId, error, apiKey)));
		}),
	);
}

export function extractWithTinyFish(
	url: string,
	signal?: AbortSignal,
	options: ExtractOptions = {},
): Effect.Effect<ExtractedContent | null, Error> {
	return nativePromise(getApiKey, signal).pipe(
		Effect.flatMap((apiKey) => {
			const activityId = activityMonitor.logStart({ type: "fetch", url });
			return Effect.gen(function* () {
				const data = yield* fetchBatch([url], apiKey, signal, options);
				if (!Array.isArray(data["results"]) || !Array.isArray(data["errors"])) {
					return yield* Effect.fail(new Error("TinyFish Fetch API returned an unexpected response shape"));
				}
				const result =
					data["results"].find(
						(item) => isJsonInputObject(item) && (item.url === url || item.final_url === url),
					) ?? data["results"][0];
				const mapped = mapFetchResult(result, url);
				if (mapped) {
					activityMonitor.logComplete(activityId, 200);
					return mapped;
				}
				const fetchError = findFetchError(data["errors"], url);
				if (fetchError) {
					const status = isRuntimeNumber(fetchError["status"]) ? ` (HTTP ${fetchError["status"]})` : "";
					return yield* Effect.fail(
						new Error(
							`TinyFish Fetch failed for ${url}: ${isRuntimeString(fetchError["error"]) ? fetchError["error"] : "unknown error"}${status}`,
						),
					);
				}
				activityMonitor.logComplete(activityId, 200);
				return null;
			}).pipe(Effect.catch((error) => redactedActivityFailure(activityId, error, apiKey)));
		}),
	);
}
