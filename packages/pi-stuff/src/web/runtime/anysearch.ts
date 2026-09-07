import * as Effect from "effect/Effect";
import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";
import { isJsonInputObject, requireJsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { activityMonitor, throwRedactedActivityError } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { redactCredential, resolveCredential } from "./credential-source.ts";
import type { ExtractedContent } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { errorMessage, formatSearchSources, nativePromise, nativeRequest, normalizeCount } from "./utils.ts";

const ANYSEARCH_API_URL = "https://api.anysearch.com/v1/search";
const SEARCH_TIMEOUT_MS = 30_000;

interface AnySearchResult {
	title: string;
	url: string;
	snippet: string;
	content: string;
}

interface AnySearchSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

interface AnySearchResponse {
	code: 0;
	data: {
		results: AnySearchResult[];
		metadata: JsonInputObject;
	};
}

function loadConfig() {
	return readWebConfig() ?? {};
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "AnySearch",
		configuredValue: loadConfig()["anysearchApiKey"],
		environmentValue: process.env["ANYSEARCH_API_KEY"],
		signal,
	});
}

function invalidResponse(message: string): Error {
	return new Error(`AnySearch API returned invalid response: ${message}`);
}

function parseResponse(value: JsonInputValue): AnySearchResponse {
	if (!isJsonInputObject(value)) {
		throw invalidResponse("expected an object envelope");
	}
	if (value["code"] !== 0) throw invalidResponse("expected code 0");
	if (!isJsonInputObject(value["data"])) {
		throw invalidResponse("expected data object");
	}
	const data = value["data"];
	if (!Array.isArray(data["results"])) throw invalidResponse("expected data.results array");
	if (!isJsonInputObject(data["metadata"])) {
		throw invalidResponse("expected data.metadata object");
	}

	const results: AnySearchResult[] = [];
	for (const [index, value] of data["results"].entries()) {
		if (!isJsonInputObject(value)) {
			throw invalidResponse(`expected data.results[${index}] object`);
		}
		const { title, url, snippet, content } = value;
		if (!isRuntimeString(title)) throw invalidResponse(`expected data.results[${index}].title string`);
		if (!isRuntimeString(url)) throw invalidResponse(`expected data.results[${index}].url string`);
		if (!isRuntimeString(snippet)) throw invalidResponse(`expected data.results[${index}].snippet string`);
		if (!isRuntimeString(content)) throw invalidResponse(`expected data.results[${index}].content string`);
		if (!url) throw invalidResponse(`expected data.results[${index}].url to be non-empty`);
		results.push({ title, url, snippet, content });
	}

	return { code: 0, data: { results, metadata: data["metadata"] } };
}

export function isAnySearchAvailable(): boolean {
	return true;
}

async function searchWithAnySearchRequest(
	query: string,
	options: AnySearchSearchOptions,
	apiKey: string | null,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const numResults = normalizeCount(options.numResults);
	const body = { query, max_results: numResults };
	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;

	try {
		const headers = new Headers({ "Content-Type": "application/json" });
		if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
		response = await fetch(ANYSEARCH_API_URL, {
			method: "POST",
			redirect: "error",
			headers,
			body: JSON.stringify(body),
			signal,
		});
	} catch (error) {
		throwRedactedActivityError(activityId, error, apiKey);
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`AnySearch API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let rawData: JsonInputValue;
	try {
		rawData = requireJsonInputValue(await response.json(), "AnySearch response");
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`AnySearch API returned invalid JSON: ${errorMessage(err)}`);
	}

	let data: AnySearchResponse;
	try {
		data = parseResponse(rawData);
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw err;
	}

	activityMonitor.logComplete(activityId, response.status);
	const results = data.data.results.slice(0, numResults).map((result) => ({
		title: result.title,
		url: result.url,
		snippet: result.snippet,
	}));
	const mapped: SearchResponse = { answer: formatSearchSources(results), results };
	if (options.includeContent) {
		const inlineContent: ExtractedContent[] = data.data.results
			.slice(0, numResults)
			.filter((result) => result.content.length > 0)
			.map((result) => ({ url: result.url, title: result.title, content: result.content, error: null }));
		if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
	}
	return mapped;
}

export function searchWithAnySearch(query: string, options: AnySearchSearchOptions = {}) {
	return nativePromise(getApiKey, options.signal).pipe(
		Effect.flatMap((apiKey) =>
			nativeRequest(
				(signal) => searchWithAnySearchRequest(query, options, apiKey, signal),
				SEARCH_TIMEOUT_MS,
				options.signal,
			),
		),
	);
}
