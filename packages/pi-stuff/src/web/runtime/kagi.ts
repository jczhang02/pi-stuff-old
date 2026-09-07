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

const KAGI_SEARCH_URL = "https://kagi.com/api/v0/search";
const KAGI_EXTRACT_URL = "https://kagi.com/api/v1/extract";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const SEARCH_TIMEOUT_MS = 60_000;

interface KagiSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

export interface KagiExtractOptions extends Pick<ExtractOptions, "timeoutMs" | "lookup"> {
	ssrf?: SsrfConfig;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

async function requireApiKey(signal?: AbortSignal): Promise<string> {
	return requireCredential(
		{
			provider: "Kagi",
			configuredValue: loadConfig()["kagiApiKey"],
			environmentValue: process.env["KAGI_API_KEY"],
			signal,
		},
		"Kagi API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "kagiApiKey": "your-key" }\n` +
			"  2. Set KAGI_API_KEY environment variable\n" +
			"Create a key at https://kagi.com/settings?p=api",
	);
}

function invalidResponse(message: string): Error {
	return new Error(`Kagi API returned invalid response: ${message}`);
}

function firstString<Value>(...values: Value[]): string | null {
	for (const value of values) {
		if (isRuntimeString(value) && value.trim()) return value.trim();
	}
	return null;
}

function appendSearchItems(
	value: JsonInputValue,
	results: SearchResponse["results"],
	inlineContent: ExtractedContent[],
): void {
	if (Array.isArray(value)) {
		for (const item of value) appendSearchItems(item, results, inlineContent);
		return;
	}
	if (!isJsonInputObject(value)) return;
	const nested = value["results"] ?? value["items"] ?? value["list"];
	if (Array.isArray(nested)) appendSearchItems(nested, results, inlineContent);
	const url = firstString(value["url"], value["href"], value["link"]);
	if (!url) return;
	const title = firstString(value["title"], value["name"]) ?? url;
	const snippet =
		firstString(
			value["snippet"],
			value["description"],
			value["summary"],
			value["content"],
			value["markdown"],
			value["text"],
		) ?? "";
	results.push({ title, url, snippet });
	const content = firstString(value["markdown"], value["content"], value["text"]);
	if (content) inlineContent.push({ url, title, content, error: null });
}

function parseErrors(value: JsonInputValue): string | null {
	if (!isJsonInputObject(value)) return null;
	const rawErrors = value["errors"] ?? value["error"];
	if (!Array.isArray(rawErrors)) return null;
	const messages = rawErrors.map((entry) => {
		if (!isJsonInputObject(entry)) return String(entry);
		return firstString(entry.message, entry.msg, entry.code) ?? JSON.stringify(entry);
	});
	return messages.length > 0 ? messages.join("; ") : null;
}

interface ParsedSearchResponse {
	results: SearchResponse["results"];
	inlineContent: ExtractedContent[];
}

function parseSearchResponse(value: JsonInputValue): ParsedSearchResponse {
	if (!isJsonInputObject(value)) throw invalidResponse("expected an object envelope");
	const message = parseErrors(value);
	if (message) throw invalidResponse(message);
	const results: SearchResponse["results"] = [];
	const inlineContent: ExtractedContent[] = [];
	appendSearchItems(value["data"], results, inlineContent);
	if (results.length === 0 && value["data"] !== null) appendSearchItems(value, results, inlineContent);
	return { results, inlineContent };
}

function parseExtractResponse(value: JsonInputValue, requestedUrl: string): ExtractedContent | null {
	if (!isJsonInputObject(value)) throw invalidResponse("expected extract object envelope");
	const message = parseErrors(value);
	if (message) throw invalidResponse(message);
	const candidates = Array.isArray(value["data"]) ? value["data"] : [value["data"] ?? value];
	for (const candidate of candidates) {
		if (!isJsonInputObject(candidate)) continue;
		const content = firstString(candidate.markdown, candidate.content, candidate.text);
		if (!content) continue;
		return {
			url: firstString(candidate.url, candidate.href, candidate.link) ?? requestedUrl,
			title: firstString(candidate.title, candidate.name) ?? requestedUrl,
			content,
			error: null,
		};
	}
	return null;
}

export function isKagiAvailable(): boolean {
	return hasCredentialSource({
		provider: "Kagi",
		configuredValue: loadConfig()["kagiApiKey"],
		environmentValue: process.env["KAGI_API_KEY"],
	});
}

async function searchWithKagiRequest(
	query: string,
	options: KagiSearchOptions,
	apiKey: string,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const numResults = normalizeCount(options.numResults);
	const url = new URL(KAGI_SEARCH_URL);
	url.searchParams.set("q", query);
	url.searchParams.set("limit", String(numResults));
	const activityId = activityMonitor.logStart({ type: "api", query });
	let response: Response;
	try {
		response = await fetch(url, {
			redirect: "error",
			headers: { Authorization: `Bot ${apiKey}`, Accept: "application/json" },
			signal,
		});
	} catch (error) {
		throwRedactedActivityError(activityId, error, apiKey);
	}
	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Kagi API error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	let rawData: JsonInputValue;
	try {
		rawData = requireJsonInputValue(await response.json(), "Kagi search response");
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Kagi API returned invalid JSON: ${errorMessage(err)}`);
	}
	const parsed = parseSearchResponse(rawData);
	activityMonitor.logComplete(activityId, response.status);
	const results = parsed.results.slice(0, numResults);
	const mapped: SearchResponse = { answer: formatSearchSources(results), results };
	if (options.includeContent) {
		const urls = new Set(results.map((result) => result.url));
		const inlineContent = parsed.inlineContent.filter((content) => urls.has(content.url));
		if (inlineContent.length > 0) mapped.inlineContent = inlineContent;
	}
	return mapped;
}

export function searchWithKagi(query: string, options: KagiSearchOptions = {}) {
	return nativePromise(requireApiKey, options.signal).pipe(
		Effect.flatMap((apiKey) =>
			nativeRequest(
				(signal) => searchWithKagiRequest(query, options, apiKey, signal),
				SEARCH_TIMEOUT_MS,
				options.signal,
			),
		),
	);
}

export function isKagiExtractAvailable(): boolean {
	return isKagiAvailable();
}

async function extractWithKagiRequest(
	url: string,
	ssrf: SsrfConfig,
	options: KagiExtractOptions,
	apiKey: string,
	signal: AbortSignal,
): Promise<ExtractedContent | null> {
	const activityId = activityMonitor.logStart({ type: "api", query: `kagi extract: ${url}` });
	let response: Response;
	try {
		const remoteOptions = {
			allowRanges: ssrf.allowRanges,
			trustEnvProxy: ssrf.trustEnvProxy,
			onRedirect: ({ from, to, init }: { from: URL; to: URL; init: RequestInit }) =>
				to.origin === from.origin
					? init
					: { ...init, headers: { "Content-Type": "application/json", Accept: "application/json" } },
		};
		if (options.lookup) Object.assign(remoteOptions, { lookup: options.lookup });
		response = await fetchRemoteUrl(
			KAGI_EXTRACT_URL,
			{
				method: "POST",
				headers: { Authorization: `Bot ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({ urls: [url] }),
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
		throw new Error(`Kagi Extract API error ${response.status}: ${errorText.slice(0, 300)}`);
	}
	let rawData: JsonInputValue;
	try {
		rawData = requireJsonInputValue(await response.json(), "Kagi extract response");
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Kagi Extract API returned invalid JSON: ${errorMessage(err)}`);
	}
	const parsed = parseExtractResponse(rawData, url);
	activityMonitor.logComplete(activityId, response.status);
	return parsed;
}

export function extractWithKagi(url: string, signal?: AbortSignal, options: KagiExtractOptions = {}) {
	return Effect.gen(function* () {
		const { ssrf, validationOptions } = yield* Effect.try({
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
		});
		yield* nativePromise(() => validateRemoteUrl(url, validationOptions));
		const apiKey = yield* nativePromise(requireApiKey, signal);
		return yield* nativeRequest(
			(requestSignal) => extractWithKagiRequest(url, ssrf, options, apiKey, requestSignal),
			options.timeoutMs ?? SEARCH_TIMEOUT_MS,
			signal,
		);
	});
}
