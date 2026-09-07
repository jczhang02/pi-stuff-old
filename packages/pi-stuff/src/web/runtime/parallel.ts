import * as Effect from "effect/Effect";
import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";
import { parseJsonObject } from "../../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import { normalizeProviderDomain as normalizeDomain } from "../provider-domain-filter.ts";
import { type ActivityEntry, activityMonitor, throwRedactedActivityError } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import type { ExtractedContent } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { errorMessage, getWebSearchConfigPath, nativePromise, nativeRequest } from "./utils.ts";

const PARALLEL_SEARCH_URL = "https://api.parallel.ai/v1/search";
const PARALLEL_EXTRACT_URL = "https://api.parallel.ai/v1/extract";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const MIN_PARALLEL_API_KEY_LENGTH = 8;
const MIN_USEFUL_CONTENT = 500;
const SEARCH_TIMEOUT_MS = 60_000;

const PLACEHOLDER_API_KEY_DENYLIST = new Set([
	"replace_with_your_parallel_api_key",
	"parallel_api_key",
	"your-key",
	"your-key-here",
	"your-api-key-here",
	"dummy",
	"placeholder",
	"changeme",
	"insert-your-key",
	"insert-your-key-here",
	"api-key",
	"xxx",
]);

interface V1WebSearchResult {
	url: string;
	title: string | null;
	excerpts: string[];
}

interface V1ExtractResult {
	url: string;
	title: string | null;
	excerpts: string[];
	full_content: string | null;
}

type ActivityContext = Omit<ActivityEntry, "id" | "startTime" | "status">;

interface ParallelDomainFilter extends JsonInputObject {
	include_domains?: string[];
	exclude_domains?: string[];
}

interface ParallelSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

function normalizeApiKey(value: JsonInputValue): string | null {
	if (!isRuntimeString(value)) return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function isPlaceholderApiKey(key: string): boolean {
	const normalized = key.trim();
	return normalized.length < MIN_PARALLEL_API_KEY_LENGTH || PLACEHOLDER_API_KEY_DENYLIST.has(normalized.toLowerCase());
}

async function resolveApiKey(signal?: AbortSignal): Promise<string | null> {
	const configKey = normalizeApiKey(loadConfig()["parallelApiKey"]);
	if (configKey?.startsWith("$") || configKey?.startsWith("!")) {
		const resolved = await resolveCredential({
			provider: "Parallel",
			configuredValue: configKey,
			environmentValue: process.env["PARALLEL_API_KEY"],
			signal,
		});
		return resolved && !isPlaceholderApiKey(resolved) ? resolved : null;
	}

	const envKey = normalizeApiKey(process.env["PARALLEL_API_KEY"]);
	if (envKey && !isPlaceholderApiKey(envKey)) return envKey;
	if (configKey && !isPlaceholderApiKey(configKey)) return configKey;
	return null;
}

function hasConfiguredApiKey(): boolean {
	const configKey = normalizeApiKey(loadConfig()["parallelApiKey"]);
	if (configKey?.startsWith("$") || configKey?.startsWith("!")) {
		return hasCredentialSource({
			provider: "Parallel",
			configuredValue: configKey,
			environmentValue: process.env["PARALLEL_API_KEY"],
		});
	}
	const envKey = normalizeApiKey(process.env["PARALLEL_API_KEY"]);
	return (envKey !== null && !isPlaceholderApiKey(envKey)) || (configKey !== null && !isPlaceholderApiKey(configKey));
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	const key = await resolveApiKey(signal);
	if (!key) {
		throw new Error(
			"Parallel API key not found. Either:\n" +
				`  1. Create ${CONFIG_PATH} with { "parallelApiKey": "your-key" }\n` +
				"  2. Set PARALLEL_API_KEY environment variable\n" +
				"Get a key at https://platform.parallel.ai",
		);
	}
	return key;
}

export function hasParallelApiKey(): boolean {
	return hasConfiguredApiKey();
}

export function isParallelAvailable(): boolean {
	return hasParallelApiKey();
}

function activityContext(url: string, body: JsonInputObject): ActivityContext {
	if (isRuntimeString(body["objective"]) && body["objective"].trim().length > 0) {
		return { type: "api", query: body["objective"] };
	}

	const searchQueries = body["search_queries"];
	if (Array.isArray(searchQueries) && isRuntimeString(searchQueries[0])) {
		return { type: "api", query: searchQueries[0] };
	}

	const urls = body["urls"];
	if (Array.isArray(urls) && isRuntimeString(urls[0])) {
		return { type: "fetch", url: urls[0] };
	}

	return url.includes("/search") ? { type: "api", query: "Parallel search" } : { type: "fetch", url };
}

function recencyToAfterDate(filter: string): string {
	const now = new Date();
	const offsets = new Map([
		["day", 1],
		["week", 7],
		["month", 30],
		["year", 365],
	]);
	const days = offsets.get(filter) ?? 0;
	return new Date(now.getTime() - days * 86_400_000).toISOString().slice(0, 10);
}

function mapDomainFilter(domainFilter: string[] | undefined): ParallelDomainFilter {
	if (!domainFilter?.length) return {};
	const include_domains: string[] = [];
	const exclude_domains: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? exclude_domains : include_domains;
		if (!target.includes(domain)) target.push(domain);
	}
	const filter: ParallelDomainFilter = {};
	if (include_domains.length > 0) filter.include_domains = include_domains;
	if (exclude_domains.length > 0) filter.exclude_domains = exclude_domains;
	return filter;
}

function buildSearchRequestBody(query: string, options: ParallelSearchOptions = {}): JsonInputObject {
	const numResults = Math.max(1, Math.min(Math.floor(options.numResults ?? 5), 20));
	const sourcePolicy: JsonInputObject = mapDomainFilter(options.domainFilter);
	if (options.recencyFilter) sourcePolicy["after_date"] = recencyToAfterDate(options.recencyFilter);
	const advancedSettings: JsonInputObject = { max_results: numResults };
	if (Object.keys(sourcePolicy).length > 0) advancedSettings["source_policy"] = sourcePolicy;
	return {
		objective: query,
		search_queries: [query],
		advanced_settings: advancedSettings,
	};
}

function normalizeExcerpts(value: JsonInputValue): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => isRuntimeString(item) && item.trim().length > 0);
}

function parseSearchResults(value: JsonInputValue): V1WebSearchResult[] {
	if (!Array.isArray(value)) return [];
	const results: V1WebSearchResult[] = [];
	for (const item of value) {
		if (!isRuntimeObject(item) || item === null || !isRuntimeString(item.url)) continue;
		results.push({
			url: item.url,
			title: isRuntimeString(item.title) ? item.title : null,
			excerpts: normalizeExcerpts(item.excerpts),
		});
	}
	return results;
}

function parseExtractResults(value: JsonInputValue): V1ExtractResult[] {
	if (!Array.isArray(value)) return [];
	const results: V1ExtractResult[] = [];
	for (const item of value) {
		if (!isRuntimeObject(item) || item === null || !isRuntimeString(item.url)) continue;
		results.push({
			url: item.url,
			title: isRuntimeString(item.title) ? item.title : null,
			excerpts: normalizeExcerpts(item.excerpts),
			full_content: isRuntimeString(item.full_content) ? item.full_content : null,
		});
	}
	return results;
}

function mapSearchResults(results: V1WebSearchResult[] | undefined): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResponse["results"] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const excerpts = normalizeExcerpts(item.excerpts);
		mapped.push({
			title: item.title || `Source ${i + 1}`,
			url: item.url,
			snippet: excerpts[0]?.replace(/\s+/g, " ").trim().slice(0, 200) ?? "",
		});
	}
	return mapped;
}

function buildAnswerFromExcerpts(results: V1WebSearchResult[] | undefined): string {
	if (!Array.isArray(results)) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!item?.url) continue;
		const excerpts = normalizeExcerpts(item.excerpts);
		if (excerpts.length === 0) continue;
		parts.push(`${excerpts.join(" ")}\nSource: ${item.title || `Source ${i + 1}`} (${item.url})`);
	}
	return parts.join("\n\n");
}

function mapInlineContent(results: V1WebSearchResult[] | undefined): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results.flatMap((result) => {
		if (!result?.url) return [];
		const excerpts = normalizeExcerpts(result.excerpts);
		if (excerpts.length === 0) return [];
		return [{ url: result.url, title: result.title || "", content: excerpts.join("\n\n"), error: null }];
	});
}

function resolveExtractContent(result: V1ExtractResult): string {
	const fullContent = isRuntimeString(result.full_content) ? result.full_content.trim() : "";
	return fullContent.length > 0 ? fullContent : normalizeExcerpts(result.excerpts).join("\n\n");
}

function mapExtractResult(result: V1ExtractResult | undefined | null): ExtractedContent | null {
	if (!result?.url) return null;
	const content = resolveExtractContent(result);
	if (content.length < MIN_USEFUL_CONTENT) return null;
	return {
		url: result.url,
		title: isRuntimeString(result.title) ? result.title.trim() : "",
		content,
		error: null,
	};
}

function buildExtractRequestBody(url: string, fullContent = false): JsonInputObject {
	const body: JsonInputObject = { urls: [url] };
	if (fullContent) body["advanced_settings"] = { full_content: true };
	return body;
}

function findExtractResult(results: V1ExtractResult[] | undefined, url: string): V1ExtractResult | undefined {
	if (!Array.isArray(results)) return undefined;
	return results.find((item) => item?.url === url) ?? results[0];
}

function hasExtractUrlError(errors: JsonInputValue, url: string): boolean {
	if (!Array.isArray(errors)) return false;
	return errors.some((entry) => {
		if (isRuntimeString(entry)) return entry === url;
		return isRuntimeObject(entry) && entry !== null && entry.url === url;
	});
}

function fetchAndMapExtractResult(
	url: string,
	body: JsonInputObject,
	signal?: AbortSignal,
): Effect.Effect<{ mapped: ExtractedContent | null; result: V1ExtractResult | undefined }, Error> {
	return parallelFetch(PARALLEL_EXTRACT_URL, body, signal).pipe(
		Effect.map((data) => {
			if (hasExtractUrlError(data["errors"], url)) return { mapped: null, result: undefined };
			const result = findExtractResult(parseExtractResults(data["results"]), url);
			return { mapped: mapExtractResult(result), result };
		}),
	);
}

export function searchWithParallel(query: string, options: ParallelSearchOptions = {}) {
	return parallelFetch(PARALLEL_SEARCH_URL, buildSearchRequestBody(query, options), options.signal).pipe(
		Effect.map((data) => {
			const results = parseSearchResults(data["results"]);
			const response: SearchResponse = {
				answer: buildAnswerFromExcerpts(results),
				results: mapSearchResults(results),
			};
			if (options.includeContent) {
				const inlineContent = mapInlineContent(results);
				if (inlineContent.length > 0) response.inlineContent = inlineContent;
			}
			return response;
		}),
	);
}

export function extractWithParallel(url: string, signal?: AbortSignal) {
	return Effect.gen(function* () {
		const initial = yield* fetchAndMapExtractResult(url, buildExtractRequestBody(url), signal);
		if (initial.mapped) return initial.mapped;
		if (!initial.result || resolveExtractContent(initial.result).length >= MIN_USEFUL_CONTENT) return null;

		const retry = yield* fetchAndMapExtractResult(url, buildExtractRequestBody(url, true), signal);
		return retry.mapped;
	});
}

async function parallelFetchNative(
	url: string,
	body: JsonInputObject,
	apiKey: string,
	signal: AbortSignal,
): Promise<JsonInputObject> {
	const activityId = activityMonitor.logStart(activityContext(url, body));
	let response: Response;
	try {
		response = await fetch(url, {
			method: "POST",
			redirect: "error",
			headers: {
				"x-api-key": apiKey,
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
		throw new Error(`Parallel API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	try {
		const data = parseJsonObject(await response.text());
		activityMonitor.logComplete(activityId, response.status);
		return data;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Parallel API returned invalid JSON: ${errorMessage(err)}`);
	}
}

function parallelFetch(url: string, body: JsonInputObject, signal?: AbortSignal) {
	return nativePromise(getApiKey, signal).pipe(
		Effect.flatMap((apiKey) =>
			nativeRequest(
				(requestSignal) => parallelFetchNative(url, body, apiKey, requestSignal),
				SEARCH_TIMEOUT_MS,
				signal,
			),
		),
	);
}
