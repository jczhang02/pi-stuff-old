import * as Effect from "effect/Effect";
import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";
import { isJsonInputObject, parseJsonObject } from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { activityMonitor } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { redactCredential, resolveCredential } from "./credential-source.ts";
import type { ExtractedContent } from "./extract.ts";
import type { SearchOptions, SearchResponse } from "./perplexity.ts";
import { getWebSearchConfigPath, nativePromise, nativeRequest } from "./utils.ts";

const EXA_ANSWER_URL = "https://api.exa.ai/answer";
const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_MCP_URL = "https://mcp.exa.ai/mcp";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const EXA_MCP_ADVANCED_TOOL = "web_search_advanced_exa";
const EXA_MCP_BASIC_TOOL = "web_search_exa";

export type ExaSearchResult = SearchResponse | null;

export interface ExaSearchOptions extends SearchOptions {
	includeContent?: boolean;
}

type McpParsedResult = { title: string; url: string; content: string };

function loadConfig() {
	return readWebConfig() ?? {};
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Exa",
		configuredValue: loadConfig()["exaApiKey"],
		environmentValue: process.env["EXA_API_KEY"],
		signal,
	});
}

function exaApiHeaders(apiKey: string): Headers {
	return new Headers({
		"x-api-key": apiKey,
		"Content-Type": "application/json",
		"x-exa-integration": "pi-web-access",
	});
}

function recencyToStartDate(filter: NonNullable<SearchOptions["recencyFilter"]>): string {
	const now = new Date();
	const offsets = {
		day: 1,
		week: 7,
		month: 30,
		year: 365,
	} satisfies Record<NonNullable<SearchOptions["recencyFilter"]>, number>;
	const days = offsets[filter];
	return new Date(now.getTime() - days * 86400000).toISOString();
}

interface ExaDomainFilter {
	includeDomains?: string[];
	excludeDomains?: string[];
}

function mapDomainFilter(domainFilter: string[] | undefined): ExaDomainFilter {
	if (!domainFilter?.length) return {};
	const includeDomains = domainFilter.filter((d) => !d.startsWith("-") && d.trim().length > 0).map((d) => d.trim());
	const excludeDomains = domainFilter
		.filter((d) => d.startsWith("-"))
		.map((d) => d.slice(1).trim())
		.filter(Boolean);
	const filter: ExaDomainFilter = {};
	if (includeDomains.length) filter.includeDomains = includeDomains;
	if (excludeDomains.length) filter.excludeDomains = excludeDomains;
	return filter;
}

function exaSearchArgs(query: string, options: ExaSearchOptions): JsonInputObject {
	const startDate = options.recencyFilter ? recencyToStartDate(options.recencyFilter) : null;
	const args: JsonInputObject = {
		query,
		type: "auto",
		numResults: options.numResults ?? 5,
	};
	Object.assign(args, mapDomainFilter(options.domainFilter));
	if (startDate) args["startPublishedDate"] = startDate;
	return args;
}

function normalizeHighlights(value: JsonInputValue): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => isRuntimeString(item) && item.trim().length > 0);
}

function buildAnswerFromSearchResults(results: JsonInputValue): string {
	if (!Array.isArray(results) || results.length === 0) return "";
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!isJsonInputObject(item) || !isRuntimeString(item.url)) continue;
		const highlights = normalizeHighlights(item.highlights);
		const content =
			highlights.length > 0
				? highlights.join(" ")
				: isRuntimeString(item.text)
					? item.text.trim().slice(0, 1000)
					: "";
		if (!content) continue;
		const sourceTitle = isRuntimeString(item.title) ? item.title : `Source ${i + 1}`;
		parts.push(`${content}\nSource: ${sourceTitle} (${item.url})`);
	}
	return parts.join("\n\n");
}

function mapResults(results: JsonInputValue): SearchResponse["results"] {
	if (!Array.isArray(results)) return [];
	const mapped: SearchResponse["results"] = [];
	for (let i = 0; i < results.length; i++) {
		const item = results[i];
		if (!isJsonInputObject(item) || !isRuntimeString(item.url)) continue;
		mapped.push({
			title: isRuntimeString(item.title) ? item.title : `Source ${i + 1}`,
			url: item.url,
			snippet: "",
		});
	}
	return mapped;
}

function mapInlineContent(results: JsonInputValue): ExtractedContent[] {
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		if (
			!isJsonInputObject(item) ||
			!isRuntimeString(item.url) ||
			!isRuntimeString(item.text) ||
			item.text.length === 0
		)
			return [];
		return [
			{
				url: item.url,
				title: isRuntimeString(item.title) ? item.title : "",
				content: item.text,
				error: null,
			},
		];
	});
}

function toSearchResponse(
	answer: string,
	results: SearchResponse["results"],
	inlineContent: ExtractedContent[] | null,
): SearchResponse {
	const response: SearchResponse = { answer, results };
	if (inlineContent?.length) response.inlineContent = inlineContent;
	return response;
}

async function callExaMcpNative(toolName: string, args: JsonInputObject, signal: AbortSignal): Promise<string> {
	const response = await fetch(`${EXA_MCP_URL}?tools=${toolName}`, {
		method: "POST",
		redirect: "error",
		headers: {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
			"x-exa-source": "pi-web-access",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: {
				name: toolName,
				arguments: args,
			},
		}),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		if (response.status === 429) {
			throw new Error(
				`Exa MCP rate limit reached (429). Add "exaApiKey" to ${CONFIG_PATH} for unthrottled Exa search: ${errorText.slice(0, 200)}`,
			);
		}
		throw new Error(`Exa MCP error ${response.status}: ${errorText.slice(0, 300)}`);
	}

	const body = await response.text();
	const dataLines = body.split("\n").filter((line) => line.startsWith("data:"));

	let parsed: JsonInputObject | null = null;
	for (const line of dataLines) {
		const payload = line.slice(5).trim();
		if (!payload) continue;
		try {
			const candidate = parseJsonObject(payload);
			if (isJsonInputObject(candidate["result"]) || isJsonInputObject(candidate["error"])) {
				parsed = candidate;
				break;
			}
		} catch {}
	}

	if (!parsed) {
		try {
			const candidate = parseJsonObject(body);
			if (isJsonInputObject(candidate["result"]) || isJsonInputObject(candidate["error"])) {
				parsed = candidate;
			}
		} catch {}
	}

	if (!parsed) {
		throw new Error("Exa MCP returned an empty response");
	}

	const parsedError = isJsonInputObject(parsed["error"]) ? parsed["error"] : undefined;
	if (parsedError) {
		const code = isRuntimeNumber(parsedError["code"]) ? ` ${parsedError["code"]}` : "";
		const message = isRuntimeString(parsedError["message"]) ? parsedError["message"] : "Unknown error";
		throw new Error(`Exa MCP error${code}: ${message}`);
	}

	const parsedResult = isJsonInputObject(parsed["result"]) ? parsed["result"] : undefined;
	const contentItems = Array.isArray(parsedResult?.["content"]) ? parsedResult["content"] : [];
	if (parsedResult?.["isError"] === true) {
		const errorItem = contentItems.find(
			(item) => isJsonInputObject(item) && item.type === "text" && isRuntimeString(item.text),
		);
		const message = isJsonInputObject(errorItem) && isRuntimeString(errorItem.text) ? errorItem.text.trim() : "";
		throw new Error(message || "Exa MCP returned an error");
	}

	const textItem = contentItems.find(
		(item) =>
			isJsonInputObject(item) && item.type === "text" && isRuntimeString(item.text) && item.text.trim().length > 0,
	);
	const text = isJsonInputObject(textItem) && isRuntimeString(textItem.text) ? textItem.text : undefined;

	if (!text) {
		throw new Error("Exa MCP returned empty content");
	}

	return text;
}

export function callExaMcp(toolName: string, args: JsonInputObject, signal?: AbortSignal) {
	return nativeRequest((requestSignal) => callExaMcpNative(toolName, args, requestSignal), 60_000, signal);
}

function parseMcpResults(text: string): McpParsedResult[] | null {
	const blocks = text.split(/(?=^Title: )/m).filter((block) => block.trim().length > 0);
	const parsed = blocks
		.map((block) => {
			const title = block.match(/^Title: (.+)/m)?.[1]?.trim() ?? "";
			const url = block.match(/^URL: (.+)/m)?.[1]?.trim() ?? "";
			let content = "";
			const textStart = block.indexOf("\nText: ");
			if (textStart >= 0) {
				content = block.slice(textStart + 7).trim();
			} else {
				const hlMatch = block.match(/\nHighlights:\s*\n/);
				if (hlMatch?.index != null) {
					content = block.slice(hlMatch.index + hlMatch[0].length).trim();
				}
			}
			content = content.replace(/\n---\s*$/, "").trim();
			return { title, url, content };
		})
		.filter((result) => result.url.length > 0);
	return parsed.length > 0 ? parsed : null;
}

function buildAnswerFromMcpResults(results: McpParsedResult[]): string {
	if (results.length === 0) return "";
	const parts: string[] = [];
	for (const [i, result] of results.entries()) {
		const snippet = result.content.replace(/\s+/g, " ").trim().slice(0, 500);
		if (!snippet) continue;
		const sourceTitle = result.title || `Source ${i + 1}`;
		parts.push(`${snippet}\nSource: ${sourceTitle} (${result.url})`);
	}
	return parts.join("\n\n");
}

function mapMcpInlineContent(results: McpParsedResult[]): ExtractedContent[] {
	return results
		.filter((result) => result.content.length > 0)
		.map((result) => ({
			url: result.url,
			title: result.title,
			content: result.content,
			error: null,
		}));
}

function buildMcpQuery(query: string, options: ExaSearchOptions): string {
	const parts = [query];
	if (options.domainFilter?.length) {
		for (const d of options.domainFilter) {
			parts.push(d.startsWith("-") ? `-site:${d.slice(1)}` : `site:${d}`);
		}
	}
	if (options.recencyFilter) {
		const now = new Date();
		switch (options.recencyFilter) {
			case "day":
				parts.push("past 24 hours");
				break;
			case "week":
				parts.push("past week");
				break;
			case "month":
				parts.push(`${now.toLocaleString("en", { month: "long" })} ${now.getFullYear()}`);
				break;
			case "year":
				parts.push(String(now.getFullYear()));
				break;
		}
	}
	return parts.join(" ");
}

function isAbortMessage(message: string): boolean {
	return message.toLowerCase().includes("abort");
}

function parseJsonMcpResults(text: string): JsonInputValue {
	try {
		const results = parseJsonObject(text)["results"];
		return Array.isArray(results) && results.length > 0 ? results : null;
	} catch {
		return null;
	}
}

/**
 * Calls one Exa MCP search tool and normalizes its payload. `web_search_advanced_exa`
 * returns the raw Exa search JSON; `web_search_exa` returns a formatted text block.
 */
function searchWithExaMcpTool(
	tool: string,
	args: JsonInputObject,
	options: ExaSearchOptions,
): Effect.Effect<SearchResponse | null, Error> {
	return callExaMcp(tool, args, options.signal).pipe(
		Effect.map((text) => {
			const jsonResults = parseJsonMcpResults(text);
			if (jsonResults) {
				return toSearchResponse(
					buildAnswerFromSearchResults(jsonResults),
					mapResults(jsonResults),
					options.includeContent ? mapInlineContent(jsonResults) : null,
				);
			}

			const textResults = parseMcpResults(text);
			if (!textResults) return null;
			return toSearchResponse(
				buildAnswerFromMcpResults(textResults),
				mapResults(textResults),
				options.includeContent ? mapMcpInlineContent(textResults) : null,
			);
		}),
	);
}

/** Filtered searches need the advanced tool, which not every deployment exposes. */
function searchWithFilteredExaMcp(
	query: string,
	options: ExaSearchOptions,
	basicArgs: JsonInputObject,
): Effect.Effect<SearchResponse | null, Error> {
	return searchWithExaMcpTool(
		EXA_MCP_ADVANCED_TOOL,
		{
			...exaSearchArgs(query, options),
			enableHighlights: true,
			textMaxCharacters: options.includeContent ? 50000 : 3000,
		},
		options,
	).pipe(
		Effect.catch((error) => {
			if (isAbortMessage(error.message)) return Effect.fail(error);
			// The basic tool ignores every argument except query/numResults, so the
			// filters degrade into the query text.
			return searchWithExaMcpTool(EXA_MCP_BASIC_TOOL, basicArgs, options);
		}),
	);
}

function searchWithExaMcp(query: string, options: ExaSearchOptions = {}): Effect.Effect<SearchResponse | null, Error> {
	const activityId = activityMonitor.logStart({ type: "api", query });
	const basicArgs = { query: buildMcpQuery(query, options), numResults: options.numResults ?? 5 };
	const filtered = !!options.includeContent || !!options.recencyFilter || !!options.domainFilter?.length;
	const request = filtered
		? searchWithFilteredExaMcp(query, options, basicArgs)
		: searchWithExaMcpTool(EXA_MCP_BASIC_TOOL, basicArgs, options);
	return request.pipe(
		Effect.tap(() => Effect.sync(() => activityMonitor.logComplete(activityId, 200))),
		Effect.catch((error) => {
			if (isAbortMessage(error.message)) activityMonitor.logComplete(activityId, 0);
			else activityMonitor.logError(activityId, error.message);
			return Effect.fail(error);
		}),
		Effect.onInterrupt(() => Effect.sync(() => activityMonitor.logComplete(activityId, 0))),
	);
}

export function isExaAvailable(): boolean {
	return true;
}

async function searchWithExaApiRequest(
	query: string,
	options: ExaSearchOptions,
	apiKey: string,
	signal: AbortSignal,
): Promise<ExaSearchResult> {
	const useSearch =
		options.includeContent ||
		!!options.recencyFilter ||
		!!options.domainFilter?.length ||
		!!(options.numResults && options.numResults !== 5);

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		if (!useSearch) {
			const response = await fetch(EXA_ANSWER_URL, {
				method: "POST",
				redirect: "error",
				headers: exaApiHeaders(apiKey),
				body: JSON.stringify({ query }),
				signal,
			});

			if (!response.ok) {
				const errorText = redactCredential(await response.text(), apiKey);
				throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
			}

			const data = await response.json();
			if (!isJsonInputObject(data)) throw new Error("Exa Answer API returned an invalid response");
			activityMonitor.logComplete(activityId, response.status);
			return {
				answer: isRuntimeString(data["answer"]) ? data["answer"] : "",
				results: mapResults(data["citations"]),
			};
		}

		const response = await fetch(EXA_SEARCH_URL, {
			method: "POST",
			redirect: "error",
			headers: exaApiHeaders(apiKey),
			body: JSON.stringify({
				...exaSearchArgs(query, options),
				contents: options.includeContent ? { text: true, highlights: true } : { highlights: true },
			}),
			signal,
		});

		if (!response.ok) {
			const errorText = redactCredential(await response.text(), apiKey);
			throw new Error(`Exa API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const data = await response.json();
		if (!isJsonInputObject(data)) throw new Error("Exa Search API returned an invalid response");
		activityMonitor.logComplete(activityId, response.status);

		return toSearchResponse(
			buildAnswerFromSearchResults(data["results"]),
			mapResults(data["results"]),
			options.includeContent ? mapInlineContent(data["results"]) : null,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (isAbortMessage(redactedMessage)) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, redactedMessage);
		}
		if (redactedMessage === message) throw err;
		throw new Error(redactedMessage);
	}
}

export function searchWithExa(query: string, options: ExaSearchOptions = {}) {
	return nativePromise(getApiKey, options.signal).pipe(
		Effect.flatMap((apiKey) =>
			apiKey
				? nativeRequest((signal) => searchWithExaApiRequest(query, options, apiKey, signal), 60_000, options.signal)
				: searchWithExaMcp(query, options),
		),
	);
}
