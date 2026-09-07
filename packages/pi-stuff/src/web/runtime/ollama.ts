import * as Effect from "effect/Effect";
import type { JsonInputValue } from "../../shared/json-value.ts";
import { isJsonInputObject, requireJsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { activityMonitor, throwRedactedActivityError } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { hasCredentialSource, redactCredential, requireCredential } from "./credential-source.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import {
	fetchRemoteUrl,
	loadFetchContentDomainPolicy,
	loadSsrfConfig,
	type SsrfConfig,
	validateRemoteUrl,
} from "./ssrf-protection.ts";
import {
	errorMessage,
	formatSearchSources,
	getWebSearchConfigPath,
	nativePromise,
	nativeRequest,
	normalizeCount,
} from "./utils.ts";

const OLLAMA_SEARCH_URL = "https://ollama.com/api/web_search";
const OLLAMA_FETCH_URL = "https://ollama.com/api/web_fetch";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const SEARCH_TIMEOUT_MS = 60_000;

interface OllamaSearchResult {
	title: string;
	url: string;
	content: string;
}

interface OllamaSearchResponse {
	results: OllamaSearchResult[];
}

interface OllamaFetchResponse {
	title: string;
	content: string;
	links?: JsonInputValue;
}

interface OllamaSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

export interface OllamaExtractOptions extends Pick<ExtractOptions, "timeoutMs" | "lookup"> {
	ssrf?: SsrfConfig;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	return requireCredential(
		{
			provider: "Ollama",
			configuredValue: loadConfig()["ollamaApiKey"],
			environmentValue: process.env["OLLAMA_API_KEY"],
			signal,
		},
		"Ollama API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "ollamaApiKey": "your-key" }\n` +
			"  2. Set OLLAMA_API_KEY environment variable\n" +
			"Create a key at https://ollama.com/settings/keys",
	);
}

function invalidResponse(message: string): Error {
	return new Error(`Ollama API returned invalid response: ${message}`);
}

function parseSearchResponse(value: JsonInputValue): OllamaSearchResponse {
	if (!isJsonInputObject(value)) throw invalidResponse("expected an object envelope");
	if (!Array.isArray(value["results"])) throw invalidResponse("expected results array");
	const results: OllamaSearchResult[] = [];
	for (const [index, item] of value["results"].entries()) {
		if (!isJsonInputObject(item)) throw invalidResponse(`expected results[${index}] object`);
		if (!isRuntimeString(item.title)) throw invalidResponse(`expected results[${index}].title string`);
		if (!isRuntimeString(item.url) || !item.url)
			throw invalidResponse(`expected results[${index}].url non-empty string`);
		if (!isRuntimeString(item.content)) throw invalidResponse(`expected results[${index}].content string`);
		results.push({ title: item.title, url: item.url, content: item.content });
	}
	return { results };
}

function parseFetchResponse(value: JsonInputValue): OllamaFetchResponse {
	if (!isJsonInputObject(value)) throw invalidResponse("expected fetch object envelope");
	if (!isRuntimeString(value["title"])) throw invalidResponse("expected title string");
	if (!isRuntimeString(value["content"])) throw invalidResponse("expected content string");
	return { title: value["title"], content: value["content"], links: value["links"] };
}

export function isOllamaAvailable(): boolean {
	return hasCredentialSource({
		provider: "Ollama",
		configuredValue: loadConfig()["ollamaApiKey"],
		environmentValue: process.env["OLLAMA_API_KEY"],
	});
}

async function searchWithOllamaRequest(
	query: string,
	options: OllamaSearchOptions,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const numResults = normalizeCount(options.numResults, 5, 10);
	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetch(OLLAMA_SEARCH_URL, {
			method: "POST",
			redirect: "error",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ query, max_results: numResults }),
			signal,
		});
	} catch (error) {
		throwRedactedActivityError(activityId, error, apiKey);
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Ollama API error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	let rawData: JsonInputValue;
	try {
		rawData = requireJsonInputValue(await response.json(), "Ollama search response");
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Ollama API returned invalid JSON: ${errorMessage(err)}`);
	}

	const data = parseSearchResponse(rawData);
	activityMonitor.logComplete(activityId, response.status);
	const results = data.results
		.slice(0, numResults)
		.map((result) => ({ title: result.title, url: result.url, snippet: result.content }));
	const mapped: SearchResponse = { answer: formatSearchSources(results), results };
	if (options.includeContent) {
		const inlineContent: ExtractedContent[] = data.results
			.slice(0, numResults)
			.filter((result) => result.content.trim().length > 0)
			.map((result) => ({ url: result.url, title: result.title, content: result.content, error: null }));
		if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
	}
	return mapped;
}

export function searchWithOllama(query: string, options: OllamaSearchOptions = {}) {
	return nativePromise(requireApiKey, options.signal).pipe(
		Effect.flatMap((apiKey) =>
			nativeRequest(
				(signal) => searchWithOllamaRequest(query, options, apiKey, signal),
				SEARCH_TIMEOUT_MS,
				options.signal,
			),
		),
	);
}

export function isOllamaFetchAvailable(): boolean {
	return isOllamaAvailable();
}

async function extractWithOllamaRequest(
	url: string,
	options: OllamaExtractOptions,
	ssrf: SsrfConfig,
	apiKey: string,
	signal: AbortSignal,
): Promise<ExtractedContent | null> {
	const activityId = activityMonitor.logStart({ type: "api", query: `ollama fetch: ${url}` });
	let response: Response;
	try {
		const remoteOptions = {
			allowRanges: ssrf.allowRanges,
			trustEnvProxy: ssrf.trustEnvProxy,
			onRedirect: ({ from, to, init }: { from: URL; to: URL; init: RequestInit }) =>
				to.origin === from.origin ? init : { ...init, headers: { "Content-Type": "application/json" } },
		};
		if (options.lookup) Object.assign(remoteOptions, { lookup: options.lookup });
		response = await fetchRemoteUrl(
			OLLAMA_FETCH_URL,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({ url }),
				signal,
			},
			remoteOptions,
		);
	} catch (error) {
		throwRedactedActivityError(activityId, error, apiKey);
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Ollama Web Fetch error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	let rawData: JsonInputValue;
	try {
		rawData = requireJsonInputValue(await response.json(), "Ollama fetch response");
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Ollama Web Fetch returned invalid JSON: ${errorMessage(err)}`);
	}
	const data = parseFetchResponse(rawData);
	activityMonitor.logComplete(activityId, response.status);
	const content = data.content.trim();
	if (!content) return null;
	return { url, title: data.title, content, error: null };
}

export function extractWithOllama(url: string, signal?: AbortSignal, options: OllamaExtractOptions = {}) {
	return Effect.try({
		try: () => {
			const ssrf = options.ssrf ?? loadSsrfConfig();
			const validationOptions = {
				allowRanges: ssrf.allowRanges,
				trustEnvProxy: ssrf.trustEnvProxy,
				domainPolicy: loadFetchContentDomainPolicy(),
			};
			if (options.lookup) Object.assign(validationOptions, { lookup: options.lookup });
			return { ssrf, validationOptions };
		},
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	}).pipe(
		Effect.flatMap(({ ssrf, validationOptions }) =>
			nativePromise(() => validateRemoteUrl(url, validationOptions), signal).pipe(Effect.as(ssrf)),
		),
		Effect.flatMap((ssrf) => nativePromise(requireApiKey, signal).pipe(Effect.map((apiKey) => ({ apiKey, ssrf })))),
		Effect.flatMap(({ apiKey, ssrf }) =>
			nativeRequest(
				(requestSignal) => extractWithOllamaRequest(url, options, ssrf, apiKey, requestSignal),
				options.timeoutMs ?? SEARCH_TIMEOUT_MS,
				signal,
			),
		),
	);
}
