import * as Effect from "effect/Effect";
import type { JsonInputValue } from "../../shared/json-value.ts";
import { isJsonInputObject, type JsonInputObject, parseJsonObject } from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { normalizeProviderDomain as normalizeDomain } from "../provider-domain-filter.ts";
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

const SEARCHINFINITY_SEARCH_URL = "https://torchlight.byteintlapi.com/search_api/web_search";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
// API Key authenticated requests time out server-side after 30 seconds.
const SEARCH_TIMEOUT_MS = 30_000;

interface SearchinfinitySearchOptions extends SearchOptions {
	includeContent?: boolean;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	return requireCredential(
		{
			provider: "Searchinfinity",
			configuredValue: loadConfig()["searchinfinityApiKey"],
			environmentValue: process.env["SEARCHINFINITY_API_KEY"],
			signal,
		},
		"Searchinfinity API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "searchinfinityApiKey": "your-key" }\n` +
			"  2. Set SEARCHINFINITY_API_KEY environment variable\n" +
			"Create a key at https://console.byteplus.com/search-infinity/api-key",
	);
}

export function isSearchinfinityAvailable(): boolean {
	return hasCredentialSource({
		provider: "Searchinfinity",
		configuredValue: loadConfig()["searchinfinityApiKey"],
		environmentValue: process.env["SEARCHINFINITY_API_KEY"],
	});
}

function mapRecencyFilter(recency: SearchOptions["recencyFilter"]): string | undefined {
	if (recency === "day") return "OneDay";
	if (recency === "week") return "OneWeek";
	if (recency === "month") return "OneMonth";
	if (recency === "year") return "OneYear";
	return undefined;
}

function buildSearchBody(query: string, options: SearchinfinitySearchOptions): JsonInputObject {
	const includeSites: string[] = [];
	const blockHosts: string[] = [];
	for (const raw of options.domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? blockHosts : includeSites;
		if (target.length < 5 && !target.includes(domain)) target.push(domain);
	}
	const filter: JsonInputObject = {};
	if (includeSites.length > 0) filter["Sites"] = includeSites.join("|");
	if (blockHosts.length > 0) filter["BlockHosts"] = blockHosts.join("|");

	const timeRange = mapRecencyFilter(options.recencyFilter);
	const body: JsonInputObject = {
		Query: query,
		Count: normalizeCount(options.numResults),
	};
	if (Object.keys(filter).length > 0) body["Filter"] = filter;
	if (timeRange) body["TimeRange"] = timeRange;
	return body;
}

// Map Searchinfinity business error codes to the closest HTTP semantics so
// error classification (auth/quota/invalid-request/transient) keeps working.
// CodeN carries the numeric code (e.g. 700901); Code may be a slug (e.g.
// "invalid_api_key"), so match both.
function businessErrorStatus(codeN: number | undefined, code: string, message: string): number | undefined {
	if (codeN === 700901 || code === "invalid_api_key") return 401;
	if (codeN === 700429 || code === "700429") return 429;
	if (codeN === 10400 || code === "10400") return 400;
	if (codeN === 10500 || code === "10500") return 500;
	if (codeN === 10403 || code === "10403") return /quota|exhaust/i.test(message) ? 429 : 403;
	return undefined;
}

async function searchinfinityJsonRequest(
	apiKey: string,
	body: JsonInputObject,
	signal: AbortSignal,
): Promise<JsonInputObject> {
	let response: Response;
	try {
		response = await fetch(SEARCHINFINITY_SEARCH_URL, {
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
			`Searchinfinity Search API error ${response.status}: ${redactCredential(raw, apiKey).slice(0, 300)}`,
		);
	}
	let data: JsonInputObject;
	try {
		data = parseJsonObject(raw);
	} catch (err) {
		throw new Error(`Searchinfinity Search API returned invalid JSON: ${errorMessage(err)}`);
	}
	const responseMetadata = isJsonInputObject(data["ResponseMetadata"]) ? data["ResponseMetadata"] : undefined;
	const businessError = isJsonInputObject(responseMetadata?.["Error"]) ? responseMetadata["Error"] : undefined;
	if (businessError && (businessError["Code"] || businessError["Message"])) {
		const code = isRuntimeString(businessError["Code"]) && businessError["Code"] ? businessError["Code"] : "unknown";
		const message =
			isRuntimeString(businessError["Message"]) && businessError["Message"]
				? businessError["Message"]
				: "unknown error";
		const codeN = isRuntimeNumber(businessError["CodeN"]) ? businessError["CodeN"] : undefined;
		const status = businessErrorStatus(codeN, code, message);
		const codeLabel = isRuntimeNumber(businessError["CodeN"]) ? `${businessError["CodeN"]} ${code}` : code;
		throw new Error(`Searchinfinity Search API error ${status ?? "unknown"}: ${message} (code ${codeLabel})`);
	}
	return data;
}

function mapSearchResults(results: JsonInputValue): SearchResponse["results"] {
	if (!Array.isArray(results)) {
		throw new Error("Searchinfinity Search API returned an unexpected response shape");
	}
	return results.flatMap((item) => {
		if (!isJsonInputObject(item) || !isRuntimeString(item.Url) || item.Url.trim().length === 0) return [];
		const url = item.Url.trim();
		const summary = isRuntimeString(item.Summary) ? item.Summary.replace(/\s+/g, " ").trim() : "";
		const snippet = isRuntimeString(item.Snippet) ? item.Snippet.replace(/\s+/g, " ").trim() : "";
		return [
			{
				title: isRuntimeString(item.Title) && item.Title.trim() ? item.Title.trim() : url,
				url,
				snippet: summary || snippet,
			},
		];
	});
}

async function searchWithSearchinfinityRequest(
	query: string,
	options: SearchinfinitySearchOptions,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const activityId = activityMonitor.logStart({ type: "api", query });
	try {
		const data = await searchinfinityJsonRequest(apiKey, buildSearchBody(query, options), signal);
		const resultEnvelope = isJsonInputObject(data["Result"]) ? data["Result"] : undefined;
		const results = mapSearchResults(resultEnvelope?.["WebResults"]);
		const response: SearchResponse = { answer: formatSearchSources(results), results };
		activityMonitor.logComplete(activityId, 200);
		return response;
	} catch (error) {
		throwRedactedActivityError(activityId, error, apiKey);
	}
}

export function searchWithSearchinfinity(query: string, options: SearchinfinitySearchOptions = {}) {
	return nativePromise(getApiKey, options.signal).pipe(
		Effect.flatMap((apiKey) =>
			nativeRequest(
				(signal) => searchWithSearchinfinityRequest(query, options, apiKey, signal),
				SEARCH_TIMEOUT_MS,
				options.signal,
			),
		),
	);
}
