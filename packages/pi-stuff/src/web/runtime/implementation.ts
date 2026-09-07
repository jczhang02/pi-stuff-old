import type { ImageContent, TextContent } from "@earendil-works/pi-ai/compat";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import type { SettingsRecord } from "../../shared/settings-io/index.ts";
import {
	WEB_CONTENT_PARAMETERS,
	WEB_FETCH_PARAMETERS,
	WEB_SEARCH_PARAMETERS,
	type WebContentParams,
	type WebFetchParams,
	type WebSearchParams,
} from "../tool-contracts.ts";
import type { WebFetchInput } from "../url-policy.ts";
import { readWebConfig, withWebConfigSnapshot } from "./config.ts";
import { type FindMode, findContent } from "./content-find.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { normalizeFetchContentParams } from "./fetch-params.ts";
import type { SearchResult } from "./perplexity.ts";
import {
	clearResults,
	generateId,
	getResult,
	type QueryResultData,
	restoreFromSession,
	type StoredSearchData,
	storeResult,
} from "./storage.ts";
import { errorMessage, getWebSearchConfigPath, isAbortError, nativePromise } from "./utils.ts";

export type PiWebAccessHost = Pick<ExtensionAPI, "appendEntry" | "on" | "registerTool">;

export class WebContentSessionError extends Error {}

export interface WebRuntimeEffectOptions {
	readonly prepareFetch: (input: WebFetchInput) => Effect.Effect<void, Error>;
	readonly readSettings: () => SettingsRecord;
	readonly runContentOperation: <A, E, Result>(
		ctx: ExtensionContext,
		program: Effect.Effect<A, E>,
		handlers: { readonly interrupted?: () => Result; readonly success: (value: A) => Result },
		signal?: AbortSignal | undefined,
	) => Promise<Result>;
}

export { configureRuntimeSsrfDefaults, type RuntimeSsrfDefaults } from "./ssrf-protection.ts";

const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();

function fetchAllContent(urls: string[], options?: ExtractOptions): Effect.Effect<ExtractedContent[], Error> {
	return nativePromise(() => import("./extract.ts")).pipe(
		Effect.flatMap((extractModule) => extractModule.fetchAllContent(urls, options)),
	);
}

function resolveFindMode(value: JsonInputValue): FindMode {
	return value === "exact" || value === "fuzzy" ? value : "case-insensitive";
}

interface WebSearchConfig {
	anysearchApiKey?: JsonInputValue;
	brightdataApiKey?: JsonInputValue;
	brightdataSerpZone?: JsonInputValue;
	kagiApiKey?: JsonInputValue;
	ollamaApiKey?: JsonInputValue;
	serpbaseApiKey?: JsonInputValue;
	tinyfishApiKey?: JsonInputValue;
	xaiApiKey?: JsonInputValue;
	provider?: JsonInputValue;
	searchProvider?: JsonInputValue;
	webSearch?: {
		enabled?: boolean;
	};
	toolNames?: Partial<ToolNames>;
	ssrf?: {
		/** CIDR ranges exempted from the SSRF guard (e.g. fake-IP proxy ranges). */
		allowRanges?: string[];
		/** Skip local hostname DNS preflight when an HTTP(S)_PROXY env var applies. */
		trustEnvProxy?: boolean;
	};
}

function loadConfig(): WebSearchConfig {
	return readWebConfig() ?? {};
}

type ToolNames = {
	webSearch: string;
	fetchContent: string;
	getSearchContent: string;
};

const DEFAULT_TOOL_NAMES: ToolNames = {
	webSearch: "web_search",
	fetchContent: "fetch_content",
	getSearchContent: "get_search_content",
};
const TOOL_NAME_KEYS = ["webSearch", "fetchContent", "getSearchContent"] as const;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

function resolveToolNames(config: WebSearchConfig): ToolNames {
	if (
		config.toolNames !== undefined &&
		(!config.toolNames || !isRuntimeObject(config.toolNames) || Array.isArray(config.toolNames))
	) {
		throw new Error(`toolNames in ${WEB_SEARCH_CONFIG_PATH} must be an object`);
	}
	const names = { ...DEFAULT_TOOL_NAMES };
	for (const key of TOOL_NAME_KEYS) {
		const value = config.toolNames?.[key];
		if (value === undefined) continue;
		if (!isRuntimeString(value)) throw new Error(`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must be a string`);
		const trimmed = value.trim();
		if (!TOOL_NAME_PATTERN.test(trimmed)) {
			throw new Error(
				`toolNames.${key} in ${WEB_SEARCH_CONFIG_PATH} must start with a letter and contain only letters, numbers, underscores, or hyphens`,
			);
		}
		names[key] = trimmed;
	}
	const registeredKeys: Array<keyof ToolNames> =
		config.webSearch?.enabled === false
			? ["fetchContent", "getSearchContent"]
			: ["webSearch", "fetchContent", "getSearchContent"];
	const seen = new Map<string, keyof ToolNames>();
	for (const key of registeredKeys) {
		const name = names[key];
		const previous = seen.get(name);
		if (previous) throw new Error(`toolNames.${key} duplicates toolNames.${previous} in ${WEB_SEARCH_CONFIG_PATH}`);
		seen.set(name, key);
	}
	return names;
}

function normalizeRecencyFilter(value: JsonInputValue): "day" | "week" | "month" | "year" | undefined {
	return value === "day" || value === "week" || value === "month" || value === "year" ? value : undefined;
}

function normalizeQueryList(queryList: JsonInputValue[]): string[] {
	const normalized: string[] = [];
	for (const query of queryList) {
		if (!isRuntimeString(query)) continue;
		const trimmed = query.trim();
		if (trimmed.length > 0) normalized.push(trimmed);
	}
	return normalized;
}

const MAX_INLINE_CONTENT = 30000; // Content returned directly to agent
const DEFAULT_CONTENT_SLICE_LENGTH = MAX_INLINE_CONTENT;
const MAX_CONTENT_SLICE_LENGTH = MAX_INLINE_CONTENT;

function stripThumbnails(results: ExtractedContent[]): ExtractedContent[] {
	return results.map(({ thumbnail: _thumbnail, ...rest }) => rest);
}

interface InitialContentSlice {
	text: string;
	endOffset: number;
	totalBytes: number;
	totalLines: number;
	shownBytes: number;
	shownLines: number;
}

function initialContentSlice(content: string): InitialContentSlice {
	let endOffset = Math.min(content.length, MAX_INLINE_CONTENT);
	if (endOffset < content.length) {
		const lineBreak = content.lastIndexOf("\n", endOffset);
		if (lineBreak >= Math.floor(MAX_INLINE_CONTENT * 0.8)) endOffset = lineBreak + 1;
	}
	const text = content.slice(0, endOffset);
	return {
		text,
		endOffset,
		totalBytes: Buffer.byteLength(content),
		totalLines: content.length === 0 ? 0 : content.split("\n").length,
		shownBytes: Buffer.byteLength(text),
		shownLines: text.length === 0 ? 0 : text.split("\n").length,
	};
}

function normalizeFindQueries(value: string | string[]): string[] {
	const queries = (Array.isArray(value) ? value : [value]).map((query) => query.trim()).filter(Boolean);
	if (queries.length === 0) throw new Error("findText must contain at least one non-empty string");
	return queries;
}

function formatSearchSummary(results: SearchResult[], answer: string): string {
	if (results.length === 0) {
		return answer ? `${answer}\n\n---\n\n**Sources:**\nNo sources returned.` : "No results found.";
	}
	let output = answer ? `${answer}\n\n---\n\n**Sources:**\n` : "";
	output += results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}`).join("\n\n");
	return output;
}

function formatFullResults(queryData: QueryResultData): string {
	let output = `## Results for: "${queryData.query}"\n\n`;
	if (queryData.answer) {
		output += `${queryData.answer}\n\n---\n\n`;
	}
	for (const r of queryData.results) {
		output += `### ${r.title}\n${r.url}\n\n`;
	}
	return output;
}

interface WebRuntime {
	readonly effects: WebRuntimeEffectOptions;
	readonly pi: PiWebAccessHost;
	readonly storedContentSources: string;
	readonly toolNames: ToolNames;
}

type WebUpdate = (result: AgentToolResult<JsonInputObject>) => void;

function handleSessionChange(ctx: ExtensionContext): void {
	restoreFromSession(ctx);
}

function storeAndPublish(runtime: WebRuntime, data: StoredSearchData): string {
	storeResult(data.id, data);
	runtime.pi.appendEntry("web-search-results", data);
	return data.id;
}

function buildSearchReturn(
	runtime: WebRuntime,
	queryList: string[],
	results: QueryResultData[],
): AgentToolResult<JsonInputObject> {
	let output = "";
	for (const { query, answer, results: sources, error } of results) {
		if (queryList.length > 1) output += `## Query: "${query}"\n\n`;
		output += error ? `Error: ${error}\n\n` : `${formatSearchSummary(sources, answer)}\n\n`;
	}
	const searchId = storeAndPublish(runtime, {
		id: generateId(),
		type: "search",
		timestamp: Date.now(),
		queries: results,
	});
	return {
		content: [{ type: "text", text: output.trim() }],
		details: {
			queries: queryList,
			queryCount: queryList.length,
			successfulQueries: results.filter((result) => !result.error).length,
			totalResults: results.reduce((sum, result) => sum + result.results.length, 0),
			searchId,
		},
	};
}

async function executeSearch(
	runtime: WebRuntime,
	params: WebSearchParams,
	signal: AbortSignal | undefined,
	onUpdate: WebUpdate | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<JsonInputObject>> {
	const rawQueryList: JsonInputValue[] = Array.isArray(params.queries)
		? params.queries
		: params.query !== undefined
			? [params.query]
			: [];
	const queryList = normalizeQueryList(rawQueryList);
	if (queryList.length === 0) {
		return {
			content: [{ type: "text", text: "Error: No query provided. Use 'query' or 'queries' parameter." }],
			details: { error: "No query provided" },
		};
	}
	const recencyFilter = normalizeRecencyFilter(params.recencyFilter);
	const program = Effect.gen(function* () {
		const { normalizeSearchProviderSelection, search } = yield* nativePromise(() => import("./gemini-search.ts"));
		let provider = params.provider === undefined ? undefined : normalizeSearchProviderSelection(params.provider);
		if (!provider || provider === "auto") {
			const config = loadConfig();
			const configured = config.searchProvider ?? config.provider;
			provider =
				configured === undefined
					? "auto"
					: normalizeSearchProviderSelection(configured, `provider in ${WEB_SEARCH_CONFIG_PATH}`);
		}
		const results: QueryResultData[] = [];
		for (const [index, query] of queryList.entries()) {
			yield* Effect.sync(() =>
				onUpdate?.({
					content: [{ type: "text", text: `Searching ${index + 1}/${queryList.length}: "${query}"...` }],
					details: { phase: "search", progress: index / queryList.length, currentQuery: query },
				}),
			);
			const outcome = yield* search(query, {
				provider,
				numResults: params.numResults,
				recencyFilter,
				domainFilter: params.domainFilter,
				extensionContext: ctx,
			}).pipe(
				Effect.map((response) => ({ ok: true as const, response })),
				Effect.catch((error) => Effect.succeed({ error, ok: false as const })),
			);
			if (outcome.ok) {
				results.push({
					query,
					answer: outcome.response.answer,
					results: outcome.response.results,
					error: null,
					provider: outcome.response.provider,
				});
				continue;
			}
			if (isAbortError(outcome.error)) return yield* Effect.fail(outcome.error);
			results.push({
				query,
				answer: "",
				results: [],
				error: errorMessage(outcome.error),
				provider: Array.isArray(provider) ? "all" : provider,
			});
		}
		return results;
	});
	return runtime.effects.runContentOperation(
		ctx,
		program,
		{ success: (results) => buildSearchReturn(runtime, queryList, results) },
		signal,
	);
}

function singleFetchResult(
	runtime: WebRuntime,
	urlList: string[],
	result: ExtractedContent | undefined,
	options: ExtractOptions,
	responseId: string,
): AgentToolResult<JsonInputObject> {
	if (!result) {
		return {
			content: [{ type: "text", text: "Error: Fetch returned no result." }],
			details: { urls: urlList, urlCount: 1, successful: 0, responseId },
		};
	}
	if (result.error) {
		return {
			content: [{ type: "text", text: `Error: ${result.error}` }],
			details: { urls: urlList, urlCount: 1, successful: 0, error: result.error, responseId },
		};
	}
	const slice = initialContentSlice(result.content);
	const truncated = slice.endOffset < result.content.length;
	let output = slice.text;
	if (truncated) {
		output +=
			`\n\n---\nShowing ${slice.endOffset} of ${result.content.length} chars, ${slice.shownBytes} of ${slice.totalBytes} bytes, and ${slice.shownLines} of ${slice.totalLines} lines. ` +
			`Use ${runtime.toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0, offset: ${slice.endOffset} }) for the next slice.`;
	}
	const content: Array<TextContent | ImageContent> = [];
	if (result.thumbnail)
		content.push({ type: "image", data: result.thumbnail.data, mimeType: result.thumbnail.mimeType });
	content.push({ type: "text", text: output });
	return {
		content,
		details: {
			urls: urlList,
			urlCount: 1,
			successful: 1,
			totalChars: result.content.length,
			title: result.title,
			responseId,
			truncated,
			hasImage: Boolean(result.thumbnail),
			imageCount: result.thumbnail ? 1 : 0,
			mode: options.mode ?? "readable",
			mimeType: result.mimeType,
			status: result.status,
			totalBytes: slice.totalBytes,
			totalLines: slice.totalLines,
			shownBytes: slice.shownBytes,
			shownLines: slice.shownLines,
		},
	};
}

function multipleFetchResult(
	runtime: WebRuntime,
	urlList: string[],
	results: ExtractedContent[],
	responseId: string,
): AgentToolResult<JsonInputObject> {
	let output = "## Fetched URLs\n\n";
	for (const { url, title, content, error } of results) {
		output += error ? `- ${url}: Error - ${error}\n` : `- ${title || url} (${content.length} chars)\n`;
	}
	output += `\n---\nUse ${runtime.toolNames.getSearchContent}({ responseId: "${responseId}", urlIndex: 0 }) to retrieve bounded content slices.`;
	return {
		content: [{ type: "text", text: output }],
		details: {
			urls: urlList,
			urlCount: urlList.length,
			successful: results.filter((result) => !result.error).length,
			totalChars: results.reduce((sum, result) => sum + result.content.length, 0),
			responseId,
		},
	};
}

async function executeFetch(
	runtime: WebRuntime,
	params: WebFetchParams,
	signal: AbortSignal | undefined,
	onUpdate: WebUpdate | undefined,
	ctx: ExtensionContext,
): Promise<AgentToolResult<JsonInputObject>> {
	let normalized: ReturnType<typeof normalizeFetchContentParams>;
	try {
		normalized = normalizeFetchContentParams(params);
	} catch (err) {
		const error = errorMessage(err);
		return { content: [{ type: "text", text: `Error: ${error}` }], details: { error } };
	}
	const { urlList, options } = normalized;
	if (urlList.length === 0) {
		return {
			content: [{ type: "text", text: "Error: No URL provided." }],
			details: { error: "No URL provided" },
		};
	}
	onUpdate?.({
		content: [{ type: "text", text: `Fetching ${urlList.length} URL(s)...` }],
		details: { phase: "fetch", progress: 0 },
	});
	const project = (results: ExtractedContent[]) => {
		const responseId = storeAndPublish(runtime, {
			id: generateId(),
			type: "fetch",
			timestamp: Date.now(),
			urls: stripThumbnails(results),
		});
		return urlList.length === 1
			? singleFetchResult(runtime, urlList, results[0], options, responseId)
			: multipleFetchResult(runtime, urlList, results, responseId);
	};
	return runtime.effects.runContentOperation(
		ctx,
		Effect.andThen(runtime.effects.prepareFetch({ urls: urlList }), fetchAllContent(urlList, options)),
		{
			interrupted: () => project(urlList.map((url) => ({ url, title: "", content: "", error: "Aborted" }))),
			success: project,
		},
		signal,
	);
}

function storedSearchResult(queries: QueryResultData[], params: WebContentParams): AgentToolResult<JsonInputObject> {
	let queryData: QueryResultData | undefined;
	if (params.query !== undefined) {
		queryData = queries.find((query) => query.query === params.query);
		if (!queryData) {
			const available = queries.map((query) => `"${query.query}"`).join(", ");
			return {
				content: [{ type: "text", text: `Query "${params.query}" not found. Available: ${available}` }],
				details: { error: "Query not found" },
			};
		}
	} else if (params.queryIndex !== undefined) {
		queryData = queries[params.queryIndex];
		if (!queryData) {
			return {
				content: [{ type: "text", text: `Index ${params.queryIndex} out of range (0-${queries.length - 1})` }],
				details: { error: "Index out of range" },
			};
		}
	} else {
		const available = queries.map((query, index) => `${index}: "${query.query}"`).join(", ");
		return {
			content: [{ type: "text", text: `Specify query or queryIndex. Available: ${available}` }],
			details: { error: "No query specified" },
		};
	}
	if (queryData.error) {
		return {
			content: [{ type: "text", text: `Error for "${queryData.query}": ${queryData.error}` }],
			details: { error: queryData.error, query: queryData.query },
		};
	}
	const fullResults = formatFullResults(queryData);
	if (params.findText !== undefined) {
		try {
			const findMode = resolveFindMode(params.findMode);
			const found = findContent(fullResults, normalizeFindQueries(params.findText), findMode);
			const { text, ...findDetails } = found;
			return {
				content: [{ type: "text", text }],
				details: { query: queryData.query, resultCount: queryData.results.length, findMode, ...findDetails },
			};
		} catch (err) {
			const error = errorMessage(err);
			return { content: [{ type: "text", text: error }], details: { error, query: queryData.query } };
		}
	}
	return {
		content: [{ type: "text", text: fullResults }],
		details: { query: queryData.query, resultCount: queryData.results.length },
	};
}

function sliceStoredUrl(
	runtime: WebRuntime,
	urlData: ExtractedContent,
	selectedUrlIndex: number,
	params: WebContentParams,
): AgentToolResult<JsonInputObject> {
	const offset = params.offset ?? 0;
	const limit = params.limit ?? DEFAULT_CONTENT_SLICE_LENGTH;
	if (!Number.isInteger(offset) || offset < 0) {
		return {
			content: [{ type: "text", text: "offset must be a non-negative integer" }],
			details: { error: "Invalid offset", offset },
		};
	}
	if (!Number.isInteger(limit) || limit <= 0 || limit > MAX_CONTENT_SLICE_LENGTH) {
		return {
			content: [{ type: "text", text: `limit must be an integer from 1 to ${MAX_CONTENT_SLICE_LENGTH}` }],
			details: { error: "Invalid limit", limit, maxLimit: MAX_CONTENT_SLICE_LENGTH },
		};
	}
	if (offset > urlData.content.length) {
		return {
			content: [{ type: "text", text: `offset ${offset} is out of range (0-${urlData.content.length})` }],
			details: { error: "Offset out of range", offset, contentLength: urlData.content.length },
		};
	}
	const endOffset = Math.min(offset + limit, urlData.content.length);
	const contentSlice = urlData.content.slice(offset, endOffset);
	const hasMore = endOffset < urlData.content.length;
	let text = `# ${urlData.title || urlData.url}\n\n${contentSlice}`;
	if (hasMore || offset > 0) {
		text += `\n\n---\nShowing chars ${offset}-${endOffset} of ${urlData.content.length}.`;
		if (hasMore) {
			text += ` Use ${runtime.toolNames.getSearchContent}({ responseId: "${params.responseId}", urlIndex: ${selectedUrlIndex}, offset: ${endOffset}, limit: ${limit} }) for the next slice.`;
		}
	}
	return {
		content: [{ type: "text", text }],
		details: {
			url: urlData.url,
			title: urlData.title,
			contentLength: urlData.content.length,
			offset,
			limit,
			returnedChars: contentSlice.length,
			nextOffset: hasMore ? endOffset : null,
			truncated: hasMore,
		},
	};
}

function storedFetchResult(
	runtime: WebRuntime,
	urls: ExtractedContent[],
	params: WebContentParams,
): AgentToolResult<JsonInputObject> {
	let urlData: ExtractedContent | undefined;
	let selectedUrlIndex = -1;
	if (params.url !== undefined) {
		selectedUrlIndex = urls.findIndex((url) => url.url === params.url);
		urlData = urls[selectedUrlIndex];
		if (!urlData) {
			const available = urls.map((url) => url.url).join("\n  ");
			return {
				content: [{ type: "text", text: `URL not found. Available:\n  ${available}` }],
				details: { error: "URL not found" },
			};
		}
	} else if (params.urlIndex !== undefined) {
		selectedUrlIndex = params.urlIndex;
		urlData = urls[selectedUrlIndex];
		if (!urlData) {
			return {
				content: [{ type: "text", text: `Index ${params.urlIndex} out of range (0-${urls.length - 1})` }],
				details: { error: "Index out of range" },
			};
		}
	} else {
		const available = urls.map((url, index) => `${index}: ${url.url}`).join("\n  ");
		return {
			content: [{ type: "text", text: `Specify url or urlIndex. Available:\n  ${available}` }],
			details: { error: "No URL specified" },
		};
	}
	if (urlData.error) {
		return {
			content: [{ type: "text", text: `Error for ${urlData.url}: ${urlData.error}` }],
			details: { error: urlData.error, url: urlData.url },
		};
	}
	if (params.findText === undefined) return sliceStoredUrl(runtime, urlData, selectedUrlIndex, params);
	try {
		const findMode = resolveFindMode(params.findMode);
		const found = findContent(urlData.content, normalizeFindQueries(params.findText), findMode);
		const { text, ...findDetails } = found;
		return {
			content: [{ type: "text", text: `# ${urlData.title || urlData.url}\n\n${text}` }],
			details: {
				url: urlData.url,
				title: urlData.title,
				contentLength: urlData.content.length,
				findMode,
				...findDetails,
			},
		};
	} catch (err) {
		const error = errorMessage(err);
		return { content: [{ type: "text", text: error }], details: { error, url: urlData.url } };
	}
}

function executeStoredContent(runtime: WebRuntime, params: WebContentParams): AgentToolResult<JsonInputObject> {
	if (params.findText !== undefined && (params.offset !== undefined || params.limit !== undefined)) {
		return {
			content: [{ type: "text", text: "findText cannot be combined with offset or limit" }],
			details: { error: "Incompatible find options" },
		};
	}
	if (params.findMode !== undefined && params.findText === undefined) {
		return {
			content: [{ type: "text", text: "findMode requires findText" }],
			details: { error: "findMode requires findText" },
		};
	}
	const data = getResult(params.responseId);
	if (!data) {
		return {
			content: [{ type: "text", text: `Error: No stored results for "${params.responseId}"` }],
			details: { error: "Not found", responseId: params.responseId },
		};
	}
	if (data.type === "search" && data.queries) return storedSearchResult(data.queries, params);
	if (data.type === "fetch" && data.urls) return storedFetchResult(runtime, data.urls, params);
	return {
		content: [{ type: "text", text: "Invalid stored data format" }],
		details: { error: "Invalid data" },
	};
}

function registerSearchTool(runtime: WebRuntime): void {
	runtime.pi.registerTool({
		name: runtime.toolNames.webSearch,
		label: "Web Search",
		description:
			"Search the web using the configured provider or an explicit provider selection. Returns synthesized answers with source URLs. Use multiple varied queries for broader coverage.",
		promptSnippet:
			"Use for web research questions. Prefer {queries:[...]} with 2-4 varied angles over a single query for broader coverage. Omit provider unless explicitly overriding the configured default.",
		parameters: WEB_SEARCH_PARAMETERS,
		execute: (_callId, params, signal, onUpdate, ctx) =>
			withWebConfigSnapshot(runtime.effects.readSettings(), () =>
				executeSearch(runtime, params, signal, onUpdate, ctx),
			),
	});
}

function registerFetchTool(runtime: WebRuntime): void {
	runtime.pi.registerTool({
		name: runtime.toolNames.fetchContent,
		label: "Fetch Content",
		description: `Fetch public HTTP(S) URL(s) as readable markdown or exact raw text. Direct images return resized image content, PDFs return temporary Markdown artifacts, and GitHub URLs use bounded API reads. Full content is stored for retrieval with ${runtime.toolNames.getSearchContent}.`,
		promptSnippet:
			"Read public HTTP(S) pages, direct images, GitHub URLs, and PDFs. Use raw only for exact textual response bodies.",
		parameters: WEB_FETCH_PARAMETERS,
		execute: (_callId, params, signal, onUpdate, ctx) =>
			withWebConfigSnapshot(runtime.effects.readSettings(), () =>
				executeFetch(runtime, params, signal, onUpdate, ctx),
			),
	});
}

function registerContentTool(runtime: WebRuntime): void {
	runtime.pi.registerTool({
		name: runtime.toolNames.getSearchContent,
		label: "Get Search Content",
		description: `Retrieve bounded content slices or find matching passages in a previous ${runtime.storedContentSources} call.`,
		promptSnippet: `Use after ${runtime.storedContentSources} to retrieve stored content via responseId. Use findText to locate passages without paging through the full content.`,
		parameters: WEB_CONTENT_PARAMETERS,
		execute: async (_callId, params) => executeStoredContent(runtime, params),
	});
}

function installPiWebAccess(pi: PiWebAccessHost, effects: WebRuntimeEffectOptions): void {
	const initConfig = withWebConfigSnapshot(effects.readSettings(), loadConfig);
	const toolNames = resolveToolNames(initConfig);
	const runtime: WebRuntime = {
		effects,
		pi,
		toolNames,
		storedContentSources:
			initConfig.webSearch?.enabled === false
				? toolNames.fetchContent
				: `${toolNames.webSearch} or ${toolNames.fetchContent}`,
	};
	pi.on("session_start", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_tree", async (_event, ctx) => handleSessionChange(ctx));
	pi.on("session_shutdown", clearResults);
	if (initConfig.webSearch?.enabled !== false) registerSearchTool(runtime);
	registerFetchTool(runtime);
	registerContentTool(runtime);
}

export default installPiWebAccess;
