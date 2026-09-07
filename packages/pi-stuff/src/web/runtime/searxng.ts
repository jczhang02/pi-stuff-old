import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";
import { isJsonInputObject } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import {
	hostMatchesProviderDomain as hostMatchesDomain,
	normalizeProviderDomain as normalizeDomain,
} from "../provider-domain-filter.ts";
import { activityMonitor } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.ts";
import { fetchRemoteUrl, loadSsrfConfig } from "./ssrf-protection.ts";
import { formatSearchSources, getWebSearchConfigPath, nativeRequest, normalizeCount } from "./utils.ts";

const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const SEARCH_TIMEOUT_MS = 30_000;

interface NormalizedDomainFilters {
	allowed: string[];
	blocked: string[];
}

function loadConfig() {
	return readWebConfig() ?? {};
}

function normalizeBaseUrl(value: JsonInputValue): string | null {
	if (!isRuntimeString(value)) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		const url = new URL(trimmed);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		if (url.username || url.password) return null;
		url.pathname = url.pathname.replace(/\/+$/, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return null;
	}
}

function getBaseUrl(): string | null {
	const configured = process.env["SEARXNG_BASE_URL"];
	return configured !== undefined ? normalizeBaseUrl(configured) : normalizeBaseUrl(loadConfig()["searxngBaseUrl"]);
}

function normalizeHeaders(value: JsonInputValue): Headers {
	const headers = new Headers();
	if (!isJsonInputObject(value)) return headers;
	for (const [key, headerValue] of Object.entries(value)) {
		if (!isRuntimeString(headerValue)) continue;
		const name = key.trim();
		// RFC 7230 token chars only — reject empty or malformed header names.
		if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) continue;
		try {
			headers.set(name, headerValue);
		} catch {}
	}
	return headers;
}

function getConfiguredHeaders(): Headers {
	return normalizeHeaders(loadConfig()["searxngHeaders"]);
}

function mergeDefaultHeaders(configured: Headers): Headers {
	const headers = new Headers({ Accept: "application/json" });
	configured.forEach((value, name) => {
		headers.set(name, value);
	});
	return headers;
}

function requireBaseUrl(): string {
	const baseUrl = getBaseUrl();
	if (!baseUrl) {
		throw new Error(
			"SearXNG base URL is invalid or missing. Either:\n" +
				`  1. Create ${CONFIG_PATH} with { "searxngBaseUrl": "https://search.example.com" }\n` +
				"  2. Set SEARXNG_BASE_URL to an HTTP(S) URL",
		);
	}
	return baseUrl;
}

function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters {
	const filters: NormalizedDomainFilters = { allowed: [], blocked: [] };
	for (const raw of domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? filters.blocked : filters.allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	return filters;
}

function buildSearXNGQuery(query: string, filters: NormalizedDomainFilters): string {
	const parts = [query];
	if (filters.allowed.length === 1) {
		parts.push(`site:${filters.allowed[0]}`);
	} else if (filters.allowed.length > 1) {
		parts.push(filters.allowed.map((domain) => `site:${domain}`).join(" OR "));
	}
	for (const domain of filters.blocked) parts.push(`-site:${domain}`);
	return parts.join(" ");
}

function matchesDomainFilters(url: string, filters: NormalizedDomainFilters): boolean {
	if (filters.allowed.length === 0 && filters.blocked.length === 0) return true;
	let hostname: string;
	try {
		hostname = new URL(url).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (filters.allowed.length > 0 && !filters.allowed.some((domain) => hostMatchesDomain(hostname, domain)))
		return false;
	return !filters.blocked.some((domain) => hostMatchesDomain(hostname, domain));
}

function mapTimeRange(recencyFilter: SearchOptions["recencyFilter"]): string | null {
	return recencyFilter === "day" || recencyFilter === "week" || recencyFilter === "month" || recencyFilter === "year"
		? recencyFilter
		: null;
}

export function isSearXNGAvailable(): boolean {
	const baseUrl = getBaseUrl();
	if (baseUrl === null) return false;
	loadSsrfConfig();
	return true;
}

async function searchWithSearXNGRequest(
	query: string,
	options: SearchOptions,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const baseUrl = requireBaseUrl();
	const numResults = normalizeCount(options.numResults);
	const filters = normalizeDomainFilters(options.domainFilter);
	const searchQuery = buildSearXNGQuery(query, filters);
	const url = new URL(`${baseUrl}/search`);
	url.searchParams.set("q", searchQuery);
	url.searchParams.set("format", "json");
	const timeRange = mapTimeRange(options.recencyFilter);
	if (timeRange) url.searchParams.set("time_range", timeRange);
	const activityId = activityMonitor.logStart({ type: "api", query: searchQuery });

	try {
		const headers = mergeDefaultHeaders(getConfiguredHeaders());
		const response = await fetchRemoteUrl(
			url,
			{
				method: "GET",
				headers,
				signal,
			},
			{
				...loadSsrfConfig(),
				onRedirect: ({ from, to, init }) =>
					from.origin === to.origin ? init : { ...init, headers: { Accept: "application/json" } },
			},
		);

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = await response.text();
			throw new Error(`SearXNG search error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		let data: JsonInputObject;
		try {
			const responseBody = await response.json();
			if (!isJsonInputObject(responseBody)) throw new TypeError("expected an object");
			data = responseBody;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`SearXNG returned invalid JSON: ${message}`);
		}

		activityMonitor.logComplete(activityId, response.status);
		const results: SearchResult[] = [];
		const responseResults = Array.isArray(data["results"]) ? data["results"] : [];
		for (const item of responseResults) {
			if (!isJsonInputObject(item) || !isRuntimeString(item.url) || !matchesDomainFilters(item.url, filters))
				continue;
			results.push({
				title: isRuntimeString(item.title) ? item.title : item.url,
				url: item.url,
				snippet: isRuntimeString(item.content) ? item.content : "",
			});
			if (results.length >= numResults) break;
		}

		const answers = Array.isArray(data["answers"]) ? data["answers"] : [];
		const answerParts = answers
			.filter((answer): answer is string => isRuntimeString(answer) && answer.trim().length > 0)
			.map((answer) => answer.trim());
		const sources = formatSearchSources(results);
		if (sources) answerParts.push(sources);
		return { answer: answerParts.join("\n\n"), results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, message);
		throw err;
	}
}

export function searchWithSearXNG(query: string, options: SearchOptions = {}) {
	return nativeRequest(
		(signal) => searchWithSearXNGRequest(query, options, signal),
		SEARCH_TIMEOUT_MS,
		options.signal,
	);
}
