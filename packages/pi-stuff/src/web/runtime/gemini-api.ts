import * as Effect from "effect/Effect";
import {
	isJsonInputObject,
	type JsonInputObject,
	type JsonInputValue,
	parseJsonObject,
	requireJsonInputValue,
} from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { activityMonitor } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { hasCredentialSource, redactCredential, resolveCredential } from "./credential-source.ts";
import type { SearchOptions, SearchResult } from "./perplexity.ts";
import { getWebSearchConfigPath, nativePromise, nativeRequest } from "./utils.ts";

const DEFAULT_API_HOST = "https://generativelanguage.googleapis.com";
const GROUNDING_REDIRECT_ORIGIN = "https://vertexaisearch.cloud.google.com";
const GROUNDING_REDIRECT_PATH = "/grounding-api-redirect";
const API_VERSION = "v1beta";
export const API_BASE = `${DEFAULT_API_HOST}/${API_VERSION}`;
const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
export const DEFAULT_MODEL = "gemini-3.6-flash";

function loadConfig() {
	return readWebConfig() ?? {};
}

function normalizeApiKey(value: JsonInputValue): string | null {
	if (!isRuntimeString(value)) return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeBaseUrl(value: JsonInputValue): string | null {
	if (!isRuntimeString(value)) return null;
	const normalized = value.trim().replace(/\/+$/, "");
	return normalized.length > 0 ? normalized : null;
}

function isCloudflareGateway(): boolean {
	return getApiHost().includes("gateway.ai.cloudflare.com");
}

async function getApiKeyNative(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Gemini",
		configuredValue: loadConfig()["geminiApiKey"],
		environmentValue: process.env["GEMINI_API_KEY"],
		signal,
	});
}

export function getApiKey(signal?: AbortSignal) {
	return nativePromise(getApiKeyNative, signal);
}

export function getApiHost(): string {
	return (
		normalizeBaseUrl(process.env["GOOGLE_GEMINI_BASE_URL"]) ??
		normalizeBaseUrl(loadConfig()["geminiBaseUrl"]) ??
		DEFAULT_API_HOST
	);
}

export function getVersionedApiBase(): string {
	return `${getApiHost()}/${API_VERSION}`;
}

function getLegacyCloudflareApiKey(): string | null {
	return normalizeApiKey(process.env["CLOUDFLARE_API_KEY"]) ?? normalizeApiKey(loadConfig()["cloudflareApiKey"]);
}

async function resolveCloudflareApiKey(signal?: AbortSignal): Promise<string | null> {
	return resolveCredential({
		provider: "Cloudflare",
		configuredValue: loadConfig()["cloudflareApiKey"],
		environmentValue: process.env["CLOUDFLARE_API_KEY"],
		signal,
	});
}

export function getCloudflareApiKey(): string | null {
	return getLegacyCloudflareApiKey();
}

export function isGatewayConfigured(): boolean {
	return (
		isCloudflareGateway() &&
		hasCredentialSource({
			provider: "Cloudflare",
			configuredValue: loadConfig()["cloudflareApiKey"],
			environmentValue: process.env["CLOUDFLARE_API_KEY"],
		})
	);
}

export function buildAuthHeaders(
	apiKey: string | null = null,
	cloudflareApiKey: string | null = getLegacyCloudflareApiKey(),
): Record<string, string> {
	if (!isCloudflareGateway()) return apiKey ? { "x-goog-api-key": apiKey } : {};
	return cloudflareApiKey ? { "cf-aig-authorization": `Bearer ${cloudflareApiKey}` } : {};
}

function redactGeminiCredentials(
	text: string,
	apiKey: string | null | undefined,
	cloudflareApiKey: string | null | undefined,
): string {
	return redactCredential(redactCredential(text, apiKey), cloudflareApiKey);
}

const responseCredentials = new WeakMap<
	Response,
	{
		apiKey: string | null | undefined;
		cloudflareApiKey: string | null | undefined;
	}
>();

export function redactGeminiApiResponse(response: Response, text: string, apiKey?: string | null): string {
	const credentials = responseCredentials.get(response);
	return redactGeminiCredentials(text, credentials?.apiKey ?? apiKey, credentials?.cloudflareApiKey);
}

async function fetchGeminiApiNative(
	url: string | URL,
	init: RequestInit = {},
	apiKey?: string | null,
): Promise<Response> {
	const parsedUrl = new URL(url);
	for (const name of parsedUrl.searchParams.keys()) {
		if (["key", "api_key"].includes(name.toLowerCase())) {
			throw new Error("Gemini API credential query parameters are not allowed");
		}
	}
	const resolvedApiKey = apiKey === undefined ? await getApiKeyNative(init.signal ?? undefined) : apiKey;
	const cloudflareApiKey = isCloudflareGateway() ? await resolveCloudflareApiKey(init.signal ?? undefined) : null;
	const allowedOrigins = new Set([new URL(getApiHost()).origin, new URL(DEFAULT_API_HOST).origin]);
	if ((resolvedApiKey || isGatewayConfigured()) && !allowedOrigins.has(parsedUrl.origin)) {
		throw new Error("Gemini API request host is not allowed");
	}
	const headers = new Headers(init.headers);
	headers.delete("x-goog-api-key");
	headers.delete("cf-aig-authorization");
	for (const [name, value] of Object.entries(buildAuthHeaders(resolvedApiKey, cloudflareApiKey))) {
		headers.set(name, value);
	}
	try {
		const response = await fetch(parsedUrl, { ...init, headers, redirect: "error" });
		responseCredentials.set(response, { apiKey: resolvedApiKey, cloudflareApiKey });
		return response;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const redactedMessage = redactGeminiCredentials(message, resolvedApiKey, cloudflareApiKey);
		if (redactedMessage === message) throw error;
		const redactedError = new Error(redactedMessage);
		if (error instanceof Error) redactedError.name = error.name;
		throw redactedError;
	}
}

export function fetchGeminiApi(url: string | URL, init: RequestInit = {}, apiKey?: string | null) {
	return nativePromise((signal) => fetchGeminiApiNative(url, { ...init, signal }, apiKey), init.signal ?? undefined);
}

export function isGeminiApiAvailable(): boolean {
	return (
		hasCredentialSource({
			provider: "Gemini",
			configuredValue: loadConfig()["geminiApiKey"],
			environmentValue: process.env["GEMINI_API_KEY"],
		}) || isGatewayConfigured()
	);
}

async function searchWithGeminiApiRequest(
	query: string,
	model: string,
	apiKey: string | null,
	signal: AbortSignal,
): Promise<{ payload: GeminiSearchPayload; status: number }> {
	const res = await fetchGeminiApiNative(
		`${getVersionedApiBase()}/models/${model}:generateContent`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ role: "user", parts: [{ text: query }] }],
				tools: [{ google_search: {} }],
			}),
			signal,
		},
		apiKey,
	);
	if (!res.ok) {
		const errorText = redactGeminiApiResponse(res, await res.text(), apiKey);
		throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
	}
	return { payload: parseGeminiSearchPayload(parseJsonObject(await res.text())), status: res.status };
}

export function searchWithGeminiApi(query: string, options: SearchOptions = {}) {
	return getApiKey(options.signal).pipe(
		Effect.flatMap((apiKey) => {
			if (!apiKey && !isGatewayConfigured()) return Effect.succeed(null);
			const activityId = activityMonitor.logStart({ type: "api", query });
			const configuredModel = loadConfig()["searchModel"];
			const model =
				isRuntimeString(configuredModel) && configuredModel.trim() ? configuredModel.trim() : DEFAULT_MODEL;
			return nativeRequest(
				(signal) => searchWithGeminiApiRequest(query, model, apiKey, signal),
				60_000,
				options.signal,
			).pipe(
				Effect.flatMap(({ payload, status }) =>
					resolveGroundingChunks(payload.groundingChunks, options.signal).pipe(
						Effect.map((results) => {
							activityMonitor.logComplete(activityId, status);
							const answer = payload.parts
								.map((part) => part.text)
								.filter(Boolean)
								.join("\n");
							return answer || results.length > 0 ? { answer, results } : null;
						}),
					),
				),
				Effect.catch((error) =>
					Effect.andThen(
						Effect.sync(() => {
							const message = error instanceof Error ? error.message : String(error);
							if (message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
							else activityMonitor.logError(activityId, message);
						}),
						Effect.fail(error),
					),
				),
				Effect.onInterrupt(() => Effect.sync(() => activityMonitor.logComplete(activityId, 0))),
			);
		}),
	);
}

interface GeminiSearchPayload {
	parts: Array<{ text: string }>;
	groundingChunks: GroundingChunk[];
}

interface GroundingChunk {
	web: { uri: string; title: string } | undefined;
}

function resolveGroundingChunks(chunks: GroundingChunk[], signal?: AbortSignal) {
	return Effect.forEach(
		chunks,
		(chunk) => {
			if (!chunk.web) return Effect.succeed(null);
			const { title = "", uri = "" } = chunk.web;
			return resolveRedirect(uri, signal).pipe(
				Effect.map((resolved) => {
					const url = resolved ?? uri;
					return url ? ({ title, url, snippet: "" } satisfies SearchResult) : null;
				}),
			);
		},
		{ concurrency: 1 },
	).pipe(Effect.map((results) => results.filter((result): result is SearchResult => result !== null)));
}

function resolveRedirect(proxyUrl: string, signal?: AbortSignal) {
	return Effect.try({
		try: () => {
			const url = new URL(proxyUrl);
			if (
				url.origin !== GROUNDING_REDIRECT_ORIGIN ||
				(url.pathname !== GROUNDING_REDIRECT_PATH && !url.pathname.startsWith(`${GROUNDING_REDIRECT_PATH}/`))
			) {
				return undefined;
			}
			return url;
		},
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	}).pipe(
		Effect.flatMap((url) =>
			url
				? nativeRequest(
						(requestSignal) =>
							fetch(url, { method: "HEAD", redirect: "manual", signal: requestSignal }).then((response) =>
								response.headers.get("location"),
							),
						5_000,
						signal,
					)
				: Effect.succeed(null),
		),
		Effect.catch(() => Effect.succeed(null)),
	);
}

function readOptionalObject(value: JsonInputValue, label: string): JsonInputObject | undefined {
	if (value === undefined) return undefined;
	if (!isJsonInputObject(value)) throw new Error(`Gemini API returned invalid ${label}`);
	return value;
}

function readOptionalArray(value: JsonInputValue, label: string): JsonInputValue[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new Error(`Gemini API returned invalid ${label}`);
	return value;
}

function readOptionalString(value: JsonInputValue, label: string): string {
	if (value === undefined) return "";
	if (!isRuntimeString(value)) throw new Error(`Gemini API returned invalid ${label}`);
	return value;
}

function parseGeminiSearchPayload(value: JsonInputObject): GeminiSearchPayload {
	const candidates = readOptionalArray(value["candidates"], "candidates");
	const candidate = readOptionalObject(candidates[0], "candidates[0]");
	const content = readOptionalObject(candidate?.["content"], "candidates[0].content");
	const parts = readOptionalArray(content?.["parts"], "candidates[0].content.parts").map((part, index) => {
		const entry = readOptionalObject(part, `candidates[0].content.parts[${index}]`);
		if (!entry) throw new Error(`Gemini API returned invalid candidates[0].content.parts[${index}]`);
		return { text: readOptionalString(entry["text"], `candidates[0].content.parts[${index}].text`) };
	});

	const metadata = readOptionalObject(candidate?.["groundingMetadata"], "candidates[0].groundingMetadata");
	const groundingChunks = readOptionalArray(
		metadata?.["groundingChunks"],
		"candidates[0].groundingMetadata.groundingChunks",
	).map((chunk, index) => {
		const entry = readOptionalObject(chunk, `groundingChunks[${index}]`);
		if (!entry) throw new Error(`Gemini API returned invalid groundingChunks[${index}]`);
		const web = readOptionalObject(entry["web"], `groundingChunks[${index}].web`);
		return {
			web: web
				? {
						uri: readOptionalString(web["uri"], `groundingChunks[${index}].web.uri`),
						title: readOptionalString(web["title"], `groundingChunks[${index}].web.title`),
					}
				: undefined,
		};
	});

	return { parts, groundingChunks };
}

export interface GeminiApiOptions {
	apiKey?: string;
	model?: string;
	mimeType?: string;
	signal?: AbortSignal | undefined;
	timeoutMs?: number;
}

export interface GeminiGenerateContentResult {
	text: string;
	finishReason?: string;
	blockReason?: string;
}

interface GeminiFileData {
	fileUri: string;
	mimeType?: string;
}

function parseGenerateContentResponse(value: JsonInputValue): GeminiGenerateContentResult {
	if (!isJsonInputObject(value)) throw new Error("Gemini API returned an invalid response");
	const candidate =
		Array.isArray(value["candidates"]) && isJsonInputObject(value["candidates"][0])
			? value["candidates"][0]
			: undefined;
	const content = isJsonInputObject(candidate?.content) ? candidate.content : undefined;
	const parts: readonly JsonInputValue[] = Array.isArray(content?.parts) ? content.parts : [];
	const text = parts
		.flatMap((part) =>
			isJsonInputObject(part) && isRuntimeString(part["text"]) && part["text"].length > 0 ? [part["text"]] : [],
		)
		.join("\n");
	const promptFeedback = isJsonInputObject(value["promptFeedback"]) ? value["promptFeedback"] : undefined;
	const result: GeminiGenerateContentResult = { text };
	if (isRuntimeString(candidate?.finishReason)) result.finishReason = candidate.finishReason;
	if (isRuntimeString(promptFeedback?.["blockReason"])) result.blockReason = promptFeedback["blockReason"];
	return result;
}

async function queryGeminiApiWithInlineDataRequest(
	prompt: string,
	data: string,
	mimeType: string,
	options: GeminiApiOptions,
	apiKey: string | null,
	signal: AbortSignal,
): Promise<GeminiGenerateContentResult> {
	const model = options.model ?? DEFAULT_MODEL;
	const url = `${getVersionedApiBase()}/models/${model}:generateContent`;
	const body = {
		contents: [
			{
				role: "user",
				parts: [{ inlineData: { mimeType, data } }, { text: prompt }],
			},
		],
	};

	const res = await fetchGeminiApiNative(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		},
		apiKey,
	);

	if (!res.ok) {
		const errorText = redactGeminiApiResponse(res, await res.text(), apiKey);
		throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
	}

	return parseGenerateContentResponse(requireJsonInputValue(await res.json(), "Gemini response"));
}

function requireGeminiConfiguration(apiKey: string | null): Effect.Effect<void, Error> {
	return apiKey || isGatewayConfigured()
		? Effect.void
		: Effect.fail(
				new Error(
					"Gemini API not configured. Either:\n" +
						`  1. Configure geminiApiKey in ${CONFIG_PATH} or set GEMINI_API_KEY\n` +
						"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing",
				),
			);
}

export function queryGeminiApiWithInlineData(
	prompt: string,
	data: string,
	mimeType: string,
	options: GeminiApiOptions = {},
) {
	const apiKey = options.apiKey === undefined ? getApiKey(options.signal) : Effect.succeed(options.apiKey);
	return apiKey.pipe(
		Effect.flatMap((resolvedApiKey) =>
			Effect.andThen(
				requireGeminiConfiguration(resolvedApiKey),
				nativeRequest(
					(signal) => queryGeminiApiWithInlineDataRequest(prompt, data, mimeType, options, resolvedApiKey, signal),
					options.timeoutMs ?? 120_000,
					options.signal,
				),
			),
		),
	);
}

async function queryGeminiApiWithVideoRequest(
	prompt: string,
	videoUri: string,
	options: GeminiApiOptions,
	apiKey: string | null,
	signal: AbortSignal,
): Promise<string> {
	const model = options.model ?? DEFAULT_MODEL;
	const url = `${getVersionedApiBase()}/models/${model}:generateContent`;

	const fileData: GeminiFileData = { fileUri: videoUri };
	if (options.mimeType) fileData.mimeType = options.mimeType;

	const body = {
		contents: [
			{
				role: "user",
				parts: [{ fileData }, { text: prompt }],
			},
		],
	};

	const res = await fetchGeminiApiNative(
		url,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal,
		},
		apiKey,
	);

	if (!res.ok) {
		const errorText = redactGeminiApiResponse(res, await res.text(), apiKey);
		throw new Error(`Gemini API error ${res.status}: ${errorText.slice(0, 300)}`);
	}

	const { text } = parseGenerateContentResponse(requireJsonInputValue(await res.json(), "Gemini response"));

	if (!text) throw new Error("Gemini API returned empty response");
	return text;
}

export function queryGeminiApiWithVideo(prompt: string, videoUri: string, options: GeminiApiOptions = {}) {
	const apiKey = options.apiKey === undefined ? getApiKey(options.signal) : Effect.succeed(options.apiKey);
	return apiKey.pipe(
		Effect.flatMap((resolvedApiKey) =>
			Effect.andThen(
				requireGeminiConfiguration(resolvedApiKey),
				nativeRequest(
					(signal) => queryGeminiApiWithVideoRequest(prompt, videoUri, options, resolvedApiKey, signal),
					options.timeoutMs ?? 120_000,
					options.signal,
				),
			),
		),
	);
}
