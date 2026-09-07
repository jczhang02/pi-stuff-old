import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
	isJsonInputObject,
	type JsonInputObject,
	type JsonInputValue,
	parseJsonObject,
	parseJsonValue,
} from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { normalizeProviderDomain as normalizeDomain } from "../provider-domain-filter.ts";
import { activityMonitor, throwRedactedActivityError } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.ts";
import { getWebSearchConfigPath, nativePromise, nativeRequest, normalizeHeaders } from "./utils.ts";

const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const SEARCH_TIMEOUT_MS = 60_000;

// The selected model runs the server-side web_search call and writes the cited summary.
// Prefer the newest mid-tier ("terra") model, then the newest bare mainline id; price
// tiers ("pro"/"ultra" id segments) are excluded, and the numeric-aware sort keeps
// e.g. gpt-5.10 ahead of gpt-5.9.
const EXCLUDED_MODEL_SEGMENTS = new Set(["pro", "ultra"]);
const MODEL_PREFERENCE = [(id: string) => id.includes("terra"), (id: string) => /^gpt-\d+(\.\d+)?$/.test(id)];
const SEARCH_PROVIDERS = ["openai-codex", "openai"] as const;

function pickSearchModel<T extends { id: string }>(models: readonly T[]): T | undefined {
	const candidates = models
		.filter((model) => !model.id.split("-").some((segment) => EXCLUDED_MODEL_SEGMENTS.has(segment)))
		.sort((a, b) => b.id.localeCompare(a.id, undefined, { numeric: true }));
	for (const prefers of MODEL_PREFERENCE) {
		const preferred = candidates.find((model) => prefers(model.id));
		if (preferred) return preferred;
	}
	return candidates[0];
}

interface OpenAIAuth {
	provider: "openai-codex" | "openai";
	apiKey: string;
	model: string;
	headers: Record<string, string>;
	responsesUrl: string;
}

interface NormalizedDomainFilters {
	allowedDomains?: string[];
	blockedDomains?: string[];
}

function loadConfig() {
	return readWebConfig() ?? {};
}

function normalizeDomainFilters(domainFilter: string[] | undefined): NormalizedDomainFilters | null {
	if (!domainFilter?.length) return null;

	const allowedDomains: string[] = [];
	const blockedDomains: string[] = [];
	for (const raw of domainFilter) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? blockedDomains : allowedDomains;
		if (!target.includes(domain)) target.push(domain);
	}

	if (allowedDomains.length === 0 && blockedDomains.length === 0) return null;
	const filters: NormalizedDomainFilters = {};
	if (allowedDomains.length > 0) filters.allowedDomains = allowedDomains.slice(0, 100);
	if (blockedDomains.length > 0) filters.blockedDomains = blockedDomains.slice(0, 100);
	return filters;
}

function decodeJwtPayload(token: string): JsonInputObject | null {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return null;
	try {
		const padded = parts[1]
			.replace(/-/g, "+")
			.replace(/_/g, "/")
			.padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
		return parseJsonObject(Buffer.from(padded, "base64").toString("utf8"));
	} catch {
		return null;
	}
}

function isCodexJwt(token: string): boolean {
	const payload = decodeJwtPayload(token);
	return !!payload?.["https://api.openai.com/auth"];
}

function extractAccountId(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"];
	if (!isJsonInputObject(auth)) return undefined;
	const id = auth["chatgpt_account_id"];
	return isRuntimeString(id) && id.trim().length > 0 ? id.trim() : undefined;
}

function resolveConfiguredResponsesUrl(value: JsonInputValue): string {
	if (value === undefined) return OPENAI_RESPONSES_URL;
	if (!isRuntimeString(value) || value.trim().length === 0) {
		throw new Error(`openaiResponsesUrl in ${CONFIG_PATH} must be an absolute http(s) URL`);
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		throw new Error(`openaiResponsesUrl in ${CONFIG_PATH} must be an absolute http(s) URL`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`openaiResponsesUrl in ${CONFIG_PATH} must use http or https`);
	}
	return url.toString();
}

function resolveConfiguredSearchModel(value: JsonInputValue): string | undefined {
	if (value == null) return undefined;
	if (!isRuntimeString(value) || value.trim().length === 0) {
		throw new Error(`openaiSearchModel in ${CONFIG_PATH} must be a non-empty string`);
	}
	return value.trim();
}

async function resolvePiAuth(
	ctx: ExtensionContext,
	responsesUrl: string,
	modelOverride?: string,
): Promise<OpenAIAuth | undefined> {
	let models: ReturnType<typeof ctx.modelRegistry.getAll>;
	try {
		models = ctx.modelRegistry.getAll();
	} catch {
		return undefined;
	}
	for (const provider of SEARCH_PROVIDERS) {
		const preferred = pickSearchModel(models.filter((model) => model.provider === provider));
		if (!preferred) continue;
		try {
			const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(preferred);
			if (resolved.ok && resolved.apiKey) {
				return {
					provider,
					apiKey: resolved.apiKey,
					model: modelOverride ?? preferred.id,
					headers: normalizeHeaders(resolved.headers),
					responsesUrl,
				};
			}
		} catch {}
	}
	return undefined;
}

async function resolveOpenAIAuthNative(
	ctx: ExtensionContext | undefined,
	signal: AbortSignal,
): Promise<OpenAIAuth | undefined> {
	const config = loadConfig();
	const responsesUrl = resolveConfiguredResponsesUrl(config["openaiResponsesUrl"]);
	const modelOverride = resolveConfiguredSearchModel(config["openaiSearchModel"]);
	if (ctx) {
		const auth = await resolvePiAuth(ctx, responsesUrl, modelOverride);
		if (auth) return auth;
	}

	const hasSource = hasCredentialSource({
		provider: "OpenAI",
		configuredValue: config["openaiApiKey"],
		environmentValue: process.env["OPENAI_API_KEY"],
	});
	if (!hasSource) return undefined;
	const apiKey = await resolveCredential({
		provider: "OpenAI",
		configuredValue: config["openaiApiKey"],
		environmentValue: process.env["OPENAI_API_KEY"],
		signal,
	});
	return apiKey
		? { provider: "openai", apiKey, model: modelOverride ?? "gpt-5.6-terra", headers: {}, responsesUrl }
		: undefined;
}

export function resolveOpenAIAuth(ctx?: ExtensionContext, signal?: AbortSignal) {
	return nativePromise((requestSignal) => resolveOpenAIAuthNative(ctx, requestSignal), signal);
}

async function isOpenAISearchAvailableNative(ctx?: ExtensionContext): Promise<boolean> {
	const config = loadConfig();
	const responsesUrl = resolveConfiguredResponsesUrl(config["openaiResponsesUrl"]);
	if (ctx && (await resolvePiAuth(ctx, responsesUrl))) return true;
	return hasCredentialSource({
		provider: "OpenAI",
		configuredValue: config["openaiApiKey"],
		environmentValue: process.env["OPENAI_API_KEY"],
	});
}

export function isOpenAISearchAvailable(ctx?: ExtensionContext, signal?: AbortSignal) {
	return nativePromise(() => isOpenAISearchAvailableNative(ctx), signal);
}

function buildInstructions(options: SearchOptions): string {
	const lines = [
		"Search the web and return a concise answer grounded only in the web results.",
		"Include clickable source citations in the response text when possible.",
	];

	if (options.recencyFilter) {
		const labels = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		lines.push(`Prefer sources from the ${labels[options.recencyFilter]}.`);
	}

	if (isRuntimeNumber(options.numResults) && Number.isFinite(options.numResults) && options.numResults > 0) {
		lines.push(`Prefer around ${Math.min(Math.floor(options.numResults), 20)} distinct sources.`);
	}

	const filters = normalizeDomainFilters(options.domainFilter);
	if (filters?.allowedDomains?.length) lines.push(`Only use sources from: ${filters.allowedDomains.join(", ")}.`);
	if (filters?.blockedDomains?.length) lines.push(`Do not use sources from: ${filters.blockedDomains.join(", ")}.`);

	return lines.join(" ");
}

function buildWebSearchTool(options: SearchOptions): JsonInputObject {
	const tool: JsonInputObject = { type: "web_search" };
	const filters = normalizeDomainFilters(options.domainFilter);
	if (filters) {
		const filterValues: JsonInputObject = {};
		if (filters.allowedDomains) filterValues["allowed_domains"] = filters.allowedDomains;
		if (filters.blockedDomains) filterValues["blocked_domains"] = filters.blockedDomains;
		tool["filters"] = filterValues;
	}
	return tool;
}

async function parseOpenAIResponse(response: Response): Promise<JsonInputObject> {
	const text = await response.text();
	const trimmed = text.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = parseJsonValue(trimmed);
			if (Array.isArray(parsed)) return { output: parsed };
			return isJsonInputObject(parsed) ? parsed : { output: [] };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`OpenAI API returned invalid JSON: ${message}`);
		}
	}

	const outputItems: JsonInputValue[] = [];
	let completedResponse: JsonInputObject | null = null;
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const data = line.slice(6).trim();
		if (!data || data === "[DONE]") continue;
		try {
			const parsed = parseJsonValue(data);
			if (!isJsonInputObject(parsed)) continue;
			if (parsed["type"] === "response.output_item.done" && parsed["item"]) outputItems.push(parsed["item"]);
			if (
				(parsed["type"] === "response.done" || parsed["type"] === "response.completed") &&
				isJsonInputObject(parsed["response"])
			) {
				completedResponse = parsed["response"];
			}
		} catch {}
	}

	if (completedResponse) {
		const output = Array.isArray(completedResponse["output"]) ? completedResponse["output"] : [];
		return output.length > 0 ? completedResponse : { ...completedResponse, output: outputItems };
	}
	if (outputItems.length > 0) return { output: outputItems };
	throw new Error("OpenAI API returned no parseable response output");
}

function cleanSourceUrl(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		if (url.searchParams.get("utm_source") === "openai") url.searchParams.delete("utm_source");
		return url.toString();
	} catch {
		return rawUrl.replace(/[?&]utm_source=openai$/, "");
	}
}

function extractSnippetAround(text: string, start: JsonInputValue, end: JsonInputValue): string {
	if (!isRuntimeNumber(start) || !isRuntimeNumber(end) || !text) return "";
	const before = Math.max(0, start - 100);
	const after = Math.min(text.length, end + 100);
	const snippet = text
		.slice(before, after)
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.trim();
	return snippet.length > 300 ? `${snippet.slice(0, 297)}...` : snippet;
}

function addResult(
	results: SearchResult[],
	seen: Set<string>,
	url: JsonInputValue,
	title: JsonInputValue,
	snippet = "",
): void {
	if (!isRuntimeString(url) || url.trim().length === 0) return;
	const cleanUrl = cleanSourceUrl(url);
	if (seen.has(cleanUrl)) return;
	seen.add(cleanUrl);
	results.push({
		title: isRuntimeString(title) && title.trim().length > 0 ? title : cleanUrl,
		url: cleanUrl,
		snippet,
	});
}

function extractSearchResults(output: JsonInputValue[], numResults: number | undefined): SearchResult[] {
	const results: SearchResult[] = [];
	const seenUrls = new Set<string>();

	for (const item of output) {
		if (!isJsonInputObject(item) || item["type"] !== "message") continue;
		const content = item["content"];
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!isJsonInputObject(part)) continue;
			const text = isRuntimeString(part.text) ? part.text : "";
			const annotations = part.annotations;
			if (!Array.isArray(annotations)) continue;
			for (const annotation of annotations) {
				if (!isJsonInputObject(annotation) || annotation.type !== "url_citation") continue;
				addResult(
					results,
					seenUrls,
					annotation.url,
					annotation.title,
					extractSnippetAround(text, annotation.start_index, annotation.end_index),
				);
			}
		}
	}

	for (const item of output) {
		if (!isJsonInputObject(item) || item["type"] !== "web_search_call") continue;
		const action = item["action"];
		const actionSources = isJsonInputObject(action) ? action["sources"] : undefined;
		const sourceGroups = [actionSources, item["sources"], item["results"]];
		for (const group of sourceGroups) {
			if (!Array.isArray(group)) continue;
			for (const source of group) {
				if (!isJsonInputObject(source)) continue;
				addResult(results, seenUrls, source.url ?? source.source_website_url, source.title ?? source.caption);
			}
		}
	}

	if (isRuntimeNumber(numResults) && Number.isFinite(numResults) && numResults > 0) {
		return results.slice(0, Math.min(Math.floor(numResults), 20));
	}
	return results;
}

function extractAnswer(output: JsonInputValue[]): string {
	const parts: string[] = [];
	for (const item of output) {
		if (!isJsonInputObject(item) || item["type"] !== "message") continue;
		const content = item["content"];
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			if (!isJsonInputObject(part)) continue;
			const text = part.text;
			if (isRuntimeString(text) && text.trim().length > 0) parts.push(text);
		}
	}
	return parts.join("\n").trim();
}

async function searchWithOpenAIRequest(
	query: string,
	options: SearchOptions,
	auth: OpenAIAuth,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const activityId = activityMonitor.logStart({ type: "api", query });
	const headers = new Headers(auth.headers);
	headers.set("Authorization", `Bearer ${auth.apiKey}`);
	headers.set("Content-Type", "application/json");
	headers.set("OpenAI-Beta", "responses=experimental");
	const useCodexEndpoint = auth.provider === "openai-codex" || isCodexJwt(auth.apiKey);
	if (useCodexEndpoint) {
		const accountId = extractAccountId(auth.apiKey);
		if (accountId) headers.set("chatgpt-account-id", accountId);
		headers.set("originator", "pi");
	}

	const body = {
		model: auth.model,
		instructions: buildInstructions(options),
		input: [{ role: "user", content: [{ type: "input_text", text: query }] }],
		tools: [buildWebSearchTool(options)],
		include: ["web_search_call.action.sources"],
		store: false,
		stream: true,
		tool_choice: "required" as const,
		parallel_tool_calls: true,
	};

	try {
		const response = await fetch(useCodexEndpoint ? CODEX_RESPONSES_URL : auth.responsesUrl, {
			method: "POST",
			redirect: "error",
			headers,
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = redactCredential(await response.text(), auth.apiKey);
			throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		const parsed = await parseOpenAIResponse(response);
		const output = Array.isArray(parsed["output"]) ? parsed["output"] : [];
		const answer = extractAnswer(output);
		const results = extractSearchResults(output, options.numResults);

		if (!answer && results.length === 0) {
			throw new Error("OpenAI web_search returned no answer or sources");
		}

		activityMonitor.logComplete(activityId, response.status);
		return { answer, results };
	} catch (error) {
		throwRedactedActivityError(activityId, error, auth.apiKey);
	}
}

export function searchWithOpenAI(query: string, options: SearchOptions = {}, ctx?: ExtensionContext) {
	return resolveOpenAIAuth(ctx, options.signal).pipe(
		Effect.flatMap((auth) =>
			auth
				? nativeRequest(
						(signal) => searchWithOpenAIRequest(query, options, auth, signal),
						SEARCH_TIMEOUT_MS,
						options.signal,
					)
				: Effect.fail(
						new Error(
							"OpenAI web search unavailable. Either:\n" +
								"  1. Use /login to sign in with a Codex subscription\n" +
								`  2. Create ${CONFIG_PATH} with { "openaiApiKey": "your-key" }\n` +
								"  3. Set OPENAI_API_KEY environment variable",
						),
					),
		),
	);
}
