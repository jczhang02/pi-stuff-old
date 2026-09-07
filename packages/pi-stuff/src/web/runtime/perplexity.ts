import * as Effect from "effect/Effect";
import type { JsonInputObject } from "../../shared/json-value.ts";
import { isJsonInputObject } from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { activityMonitor, throwRedactedActivityError } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { hasCredentialSource, redactCredential, requireCredential } from "./credential-source.ts";
import type { ExtractedContent } from "./extract.ts";
import { getWebSearchConfigPath, nativePromise } from "./utils.ts";

const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;

const RATE_LIMIT = {
	maxRequests: 10,
	windowMs: 60 * 1000,
};

const requestTimestamps: number[] = [];

export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearchResponse {
	answer: string;
	results: SearchResult[];
	inlineContent?: ExtractedContent[];
}

export interface SearchOptions {
	numResults?: number | undefined;
	recencyFilter?: "day" | "week" | "month" | "year" | undefined;
	domainFilter?: string[] | undefined;
	signal?: AbortSignal | undefined;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	return requireCredential(
		{
			provider: "Perplexity",
			configuredValue: loadConfig()["perplexityApiKey"],
			environmentValue: process.env["PERPLEXITY_API_KEY"],
			signal,
		},
		"Perplexity API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "perplexityApiKey": "your-key" }\n` +
			"  2. Set PERPLEXITY_API_KEY environment variable\n" +
			"Get a key at https://perplexity.ai/settings/api",
	);
}

function checkRateLimit(): void {
	const now = Date.now();
	const windowStart = now - RATE_LIMIT.windowMs;

	while (requestTimestamps[0] !== undefined && requestTimestamps[0] < windowStart) {
		requestTimestamps.shift();
	}

	const oldest = requestTimestamps[0];
	if (requestTimestamps.length >= RATE_LIMIT.maxRequests && oldest !== undefined) {
		const waitMs = oldest + RATE_LIMIT.windowMs - now;
		throw new Error(`Rate limited. Try again in ${Math.ceil(waitMs / 1000)}s`);
	}

	requestTimestamps.push(now);
}

function validateDomainFilter(domains: string[]): string[] {
	return domains.filter((d) => {
		const domain = d.startsWith("-") ? d.slice(1) : d;
		return /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/.test(domain);
	});
}

export function isPerplexityAvailable(): boolean {
	return hasCredentialSource({
		provider: "Perplexity",
		configuredValue: loadConfig()["perplexityApiKey"],
		environmentValue: process.env["PERPLEXITY_API_KEY"],
	});
}

async function searchWithPerplexityRequest(
	query: string,
	options: SearchOptions,
	apiKey: string,
	activityId: string,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const numResults =
		isRuntimeNumber(options.numResults) && Number.isFinite(options.numResults)
			? Math.max(1, Math.min(Math.floor(options.numResults), 20))
			: 5;

	const requestBody: JsonInputObject = {
		model: "sonar",
		messages: [{ role: "user", content: query }],
		max_tokens: 1024,
		return_related_questions: false,
	};

	if (options.recencyFilter) {
		requestBody["search_recency_filter"] = options.recencyFilter;
	}

	if (options.domainFilter && options.domainFilter.length > 0) {
		const validated = validateDomainFilter(options.domainFilter);
		if (validated.length > 0) {
			requestBody["search_domain_filter"] = validated;
		}
	}

	let response: Response;
	try {
		const request: RequestInit = {
			method: "POST",
			redirect: "error",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
		};
		request.signal = signal;
		response = await fetch(PERPLEXITY_API_URL, request);
	} catch (error) {
		throwRedactedActivityError(activityId, error, apiKey);
	}

	if (!response.ok) {
		activityMonitor.logComplete(activityId, response.status);
		const errorText = redactCredential(await response.text(), apiKey);
		throw new Error(`Perplexity API error ${response.status}: ${errorText}`);
	}

	let data: JsonInputObject;
	try {
		const responseBody = await response.json();
		if (!isJsonInputObject(responseBody)) throw new TypeError("expected an object");
		data = responseBody;
	} catch (err) {
		activityMonitor.logComplete(activityId, response.status);
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Perplexity API returned invalid JSON: ${message}`);
	}

	const firstChoice =
		Array.isArray(data["choices"]) && isJsonInputObject(data["choices"][0]) ? data["choices"][0] : undefined;
	const message = isJsonInputObject(firstChoice?.message) ? firstChoice.message : undefined;
	const answer = isRuntimeString(message?.content) ? message.content : "";
	const citations = Array.isArray(data["citations"]) ? data["citations"] : [];

	const results: SearchResult[] = [];
	for (let i = 0; i < Math.min(citations.length, numResults); i++) {
		const citation = citations[i];
		if (isRuntimeString(citation)) {
			results.push({ title: `Source ${i + 1}`, url: citation, snippet: "" });
		} else if (isJsonInputObject(citation) && isRuntimeString(citation.url)) {
			results.push({
				title: isRuntimeString(citation.title) ? citation.title : `Source ${i + 1}`,
				url: citation.url,
				snippet: "",
			});
		}
	}

	activityMonitor.logComplete(activityId, response.status);
	return { answer, results };
}

export function searchWithPerplexity(query: string, options: SearchOptions = {}) {
	return Effect.try({
		try: () => {
			checkRateLimit();
			const activityId = activityMonitor.logStart({ type: "api", query });
			activityMonitor.updateRateLimit({
				used: requestTimestamps.length,
				max: RATE_LIMIT.maxRequests,
				oldestTimestamp: requestTimestamps[0] ?? null,
				windowMs: RATE_LIMIT.windowMs,
			});
			return activityId;
		},
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	}).pipe(
		Effect.flatMap((activityId) =>
			nativePromise(getApiKey, options.signal).pipe(
				Effect.flatMap((apiKey) =>
					nativePromise(
						(signal) => searchWithPerplexityRequest(query, options, apiKey, activityId, signal),
						options.signal,
					),
				),
			),
		),
	);
}
