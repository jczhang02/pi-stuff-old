import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";
import { isJsonInputObject } from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { normalizeProviderDomain as normalizeDomain } from "../provider-domain-filter.ts";
import { activityMonitor, throwRedactedActivityError } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.ts";
import { getWebSearchConfigPath, nativePromise, nativeRequest, normalizeHeaders } from "./utils.ts";

// xAI's Agent Tools API: a hosted `web_search` tool on an OpenAI-compatible
// Responses endpoint. The search runs inside xAI's own inference, so — unlike
// every keyed backend here — it is paid for by whatever credential answers for
// the model, including a SuperGrok / X Premium subscription resolved through
// pi's model registry.
//
// Note for anyone extending this: xAI's older Live Search (`search_parameters`
// on /v1/chat/completions) is GONE. It now answers 410 with "Live search is
// deprecated. Please switch to the Agent Tools API". Do not add it back.
//
// The request body is deliberately minimal — model, input, tools — because that
// is the shape verified against a live subscription account. `stream`,
// `include`, `tool_choice` and `parallel_tool_calls` are all sent by the OpenAI
// backend but were NOT verified here, and a 400 from an unsupported field would
// cost the user their search. Sources come back in `web_search_call.action.sources`
// without asking for them via `include`.

const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const SEARCH_TIMEOUT_MS = 60_000;

// Ordered best-first. pi's builtin xai catalog is small and xAI retires models
// briskly, so this is a preference list, not an assumption: the first one the
// registry actually knows wins, and an unknown id is skipped rather than sent.
const AUTH_MODEL_CANDIDATES = ["grok-4.5", "grok-4.3", "grok-build-0.1"] as const;

interface XaiAuth {
	apiKey: string;
	model: string;
	headers: Record<string, string>;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

function resolveConfiguredSearchModel(value: JsonInputValue): string | undefined {
	if (value == null) return undefined;
	if (!isRuntimeString(value) || value.trim().length === 0) {
		throw new Error(`xaiSearchModel in ${CONFIG_PATH} must be a non-empty string`);
	}
	return value.trim();
}

/**
 * Resolve auth from pi's model registry first, so a Grok subscription pays for
 * its own searches and no api key has to be configured at all. Mirrors how the
 * OpenAI backend picks up a Codex sign-in.
 */
async function resolvePiAuth(ctx: ExtensionContext, modelOverride?: string): Promise<XaiAuth | undefined> {
	for (const modelId of AUTH_MODEL_CANDIDATES) {
		try {
			const model = ctx.modelRegistry.find("xai", modelId);
			if (!model) continue;
			const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
			if (resolved.ok && resolved.apiKey) {
				return {
					apiKey: resolved.apiKey,
					model: modelOverride ?? modelId,
					headers: normalizeHeaders(resolved.headers),
				};
			}
		} catch {}
	}
	return undefined;
}

async function resolveXaiAuthNative(
	ctx: ExtensionContext | undefined,
	signal: AbortSignal,
): Promise<XaiAuth | undefined> {
	const config = loadConfig();
	const modelOverride = resolveConfiguredSearchModel(config["xaiSearchModel"]);
	if (ctx) {
		const auth = await resolvePiAuth(ctx, modelOverride);
		if (auth) return auth;
	}

	const hasSource = hasCredentialSource({
		provider: "xAI",
		configuredValue: config["xaiApiKey"],
		environmentValue: process.env["XAI_API_KEY"],
	});
	if (!hasSource) return undefined;
	const apiKey = await resolveCredential({
		provider: "xAI",
		configuredValue: config["xaiApiKey"],
		environmentValue: process.env["XAI_API_KEY"],
		signal,
	});
	return apiKey ? { apiKey, model: modelOverride ?? AUTH_MODEL_CANDIDATES[0], headers: {} } : undefined;
}

export function resolveXaiAuth(ctx?: ExtensionContext, signal?: AbortSignal) {
	return nativePromise((requestSignal) => resolveXaiAuthNative(ctx, requestSignal), signal);
}

async function isXaiSearchAvailableNative(ctx?: ExtensionContext): Promise<boolean> {
	if (ctx && (await resolvePiAuth(ctx))) return true;
	const config = loadConfig();
	return hasCredentialSource({
		provider: "xAI",
		configuredValue: config["xaiApiKey"],
		environmentValue: process.env["XAI_API_KEY"],
	});
}

export function isXaiSearchAvailable(ctx?: ExtensionContext, signal?: AbortSignal) {
	return nativePromise(() => isXaiSearchAvailableNative(ctx), signal);
}

/**
 * Recency, result count and domain filters are folded into the prompt rather
 * than sent as tool parameters. xAI's filter field names are not verified, and
 * an unknown field risks a 400 that costs the whole search; steering through
 * the instruction text degrades to "the model ignored it" instead.
 */
function buildInput(query: string, options: SearchOptions): string {
	const lines = ["Search the web and answer using only what the web results say.", "Cite your sources inline."];

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

	const allowed: string[] = [];
	const blocked: string[] = [];
	for (const raw of options.domainFilter ?? []) {
		const domain = normalizeDomain(raw);
		if (!domain) continue;
		const target = raw.trim().startsWith("-") ? blocked : allowed;
		if (!target.includes(domain)) target.push(domain);
	}
	if (allowed.length > 0) lines.push(`Only use sources from: ${allowed.slice(0, 100).join(", ")}.`);
	if (blocked.length > 0) lines.push(`Do not use sources from: ${blocked.slice(0, 100).join(", ")}.`);

	return `${lines.join(" ")}\n\n${query}`;
}

function addResult(
	results: SearchResult[],
	seen: Set<string>,
	url: JsonInputValue,
	title: JsonInputValue,
	snippet = "",
): void {
	if (!isRuntimeString(url) || url.trim().length === 0) return;
	if (seen.has(url)) return;
	seen.add(url);
	results.push({
		title: isRuntimeString(title) && title.trim().length > 0 ? title : url,
		url,
		snippet,
	});
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

/**
 * Sources live in two places and neither is a top-level `citations` array:
 * `url_citation` annotations on the answer text (these carry titles and offsets,
 * so they go first and win the dedupe), and the raw `sources` each
 * `web_search_call` visited. A third-party extension that reads `data.citations`
 * silently returns answers with no sources at all — hence both paths here.
 */
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
		for (const group of [actionSources, item["sources"], item["results"]]) {
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

async function searchWithXaiRequest(
	query: string,
	options: SearchOptions,
	auth: XaiAuth,
	signal: AbortSignal,
): Promise<SearchResponse> {
	const activityId = activityMonitor.logStart({ type: "api", query });
	try {
		const response = await fetch(XAI_RESPONSES_URL, {
			method: "POST",
			redirect: "error",
			headers: {
				...auth.headers,
				Authorization: `Bearer ${auth.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				model: auth.model,
				input: buildInput(query, options),
				tools: [{ type: "web_search" }],
			}),
			signal,
		});

		if (!response.ok) {
			activityMonitor.logError(activityId, `HTTP ${response.status}`);
			const errorText = redactCredential(await response.text(), auth.apiKey);
			throw new Error(`xAI API error ${response.status}: ${errorText.slice(0, 300)}`);
		}

		let parsed: JsonInputObject;
		try {
			const responseValue = await response.json();
			if (!isJsonInputObject(responseValue)) throw new TypeError("expected a JSON object");
			parsed = responseValue;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new Error(`xAI API returned invalid JSON: ${message}`);
		}
		const output = Array.isArray(parsed["output"]) ? parsed["output"] : [];
		const answer = extractAnswer(output);
		const results = extractSearchResults(output, options.numResults);

		if (!answer && results.length === 0) {
			throw new Error("xAI web_search returned no answer or sources");
		}

		activityMonitor.logComplete(activityId, response.status);
		return { answer, results };
	} catch (error) {
		throwRedactedActivityError(activityId, error, auth.apiKey);
	}
}

export function searchWithXai(query: string, options: SearchOptions = {}, ctx?: ExtensionContext) {
	return resolveXaiAuth(ctx, options.signal).pipe(
		Effect.flatMap((auth) =>
			auth
				? nativeRequest(
						(signal) => searchWithXaiRequest(query, options, auth, signal),
						SEARCH_TIMEOUT_MS,
						options.signal,
					)
				: Effect.fail(
						new Error(
							"xAI web search unavailable. Either:\n" +
								"  1. Use /login to sign in with a SuperGrok or X Premium subscription\n" +
								`  2. Create ${CONFIG_PATH} with { "xaiApiKey": "your-key" }\n` +
								"  3. Set XAI_API_KEY environment variable",
						),
					),
		),
	);
}
