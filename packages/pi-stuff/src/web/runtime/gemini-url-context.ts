import * as Effect from "effect/Effect";
import { isJsonInputObject, type JsonInputValue, requireJsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { activityMonitor } from "./activity.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import type { ExtractedContent } from "./extract.ts";
import { DEFAULT_MODEL, fetchGeminiApi, getApiKey, getVersionedApiBase, isGatewayConfigured } from "./gemini-api.ts";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.ts";
import { extractHeadingTitle } from "./rsc-extract.ts";
import { nativePromise } from "./utils.ts";

const EXTRACTION_PROMPT = `Extract the complete readable content from this URL as clean markdown.
Include the page title, all text content, code blocks, and tables.
Do not summarize — extract the full content.

URL: `;

function shouldRethrow<ErrorValue>(err: ErrorValue): boolean {
	const message = err instanceof Error ? err.message : String(err);
	return err instanceof CredentialResolutionError || message.startsWith("Failed to parse ");
}

export function extractWithUrlContext(
	url: string,
	signal?: AbortSignal,
): Effect.Effect<ExtractedContent | null, Error> {
	return getApiKey(signal).pipe(
		Effect.flatMap((apiKey) => {
			if (!apiKey && !isGatewayConfigured()) return Effect.succeed(null);
			const activityId = activityMonitor.logStart({ type: "api", query: `url_context: ${url}` });
			const model = DEFAULT_MODEL;
			const body = {
				contents: [{ role: "user", parts: [{ text: EXTRACTION_PROMPT + url }] }],
				tools: [{ url_context: {} }],
			};

			const request: RequestInit = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			};
			if (signal) request.signal = signal;
			return fetchGeminiApi(`${getVersionedApiBase()}/models/${model}:generateContent`, request, apiKey).pipe(
				Effect.timeout(60_000),
				Effect.flatMap((res) => {
					if (!res.ok) {
						activityMonitor.logComplete(activityId, res.status);
						return Effect.succeed(null);
					}
					return nativePromise(async () =>
						requireJsonInputValue(await res.json(), "Gemini URL context response"),
					).pipe(
						Effect.flatMap((data) =>
							Effect.try({
								try: () => mapUrlContextResponse(data, url, res.status, activityId),
								catch: (error) => (error instanceof Error ? error : new Error(String(error))),
							}),
						),
					);
				}),
				softExtractionFailure(activityId),
			);
		}),
	);
}

export function extractWithGeminiWeb(url: string, signal?: AbortSignal): Effect.Effect<ExtractedContent | null, Error> {
	return isGeminiWebAvailable().pipe(
		Effect.flatMap((cookies) => {
			if (!cookies) return Effect.succeed(null);
			const activityId = activityMonitor.logStart({ type: "api", query: `gemini_web: ${url}` });
			return queryWithCookies(EXTRACTION_PROMPT + url, cookies, { signal, timeoutMs: 60_000 }).pipe(
				Effect.map((text) => {
					activityMonitor.logComplete(activityId, 200);
					return text.length < 50
						? null
						: { url, title: extractTitleFromContent(text, url), content: text, error: null };
				}),
				softExtractionFailure(activityId),
			);
		}),
	);
}

function softExtractionFailure(activityId: string) {
	return <Value>(effect: Effect.Effect<Value, Error>): Effect.Effect<Value | null, Error> =>
		effect.pipe(
			Effect.catch((error) => {
				if (shouldRethrow(error)) return Effect.fail(error);
				return Effect.sync(() => {
					const message = error instanceof Error ? error.message : String(error);
					if (message.toLowerCase().includes("abort")) activityMonitor.logComplete(activityId, 0);
					else activityMonitor.logError(activityId, message);
					return null;
				});
			}),
			Effect.onInterrupt(() => Effect.sync(() => activityMonitor.logComplete(activityId, 0))),
		);
}

function mapUrlContextResponse(
	data: JsonInputValue,
	url: string,
	statusCode: number,
	activityId: string,
): ExtractedContent | null {
	if (!isJsonInputObject(data)) throw new Error("Gemini URL context returned an invalid response");
	activityMonitor.logComplete(activityId, statusCode);
	const candidate =
		Array.isArray(data["candidates"]) && isJsonInputObject(data["candidates"][0]) ? data["candidates"][0] : undefined;
	const metadata = isJsonInputObject(candidate?.url_context_metadata) ? candidate.url_context_metadata : undefined;
	const urlMetadata = Array.isArray(metadata?.url_metadata) ? metadata.url_metadata : [];
	if (isJsonInputObject(urlMetadata[0])) {
		const status = urlMetadata[0].url_retrieval_status;
		if (status === "URL_RETRIEVAL_STATUS_UNSAFE" || status === "URL_RETRIEVAL_STATUS_ERROR") return null;
	}
	const candidateContent = isJsonInputObject(candidate?.content) ? candidate.content : undefined;
	const parts: readonly JsonInputValue[] = Array.isArray(candidateContent?.parts) ? candidateContent.parts : [];
	const content = parts
		.map((part) => (isJsonInputObject(part) && isRuntimeString(part["text"]) ? part["text"] : ""))
		.filter(Boolean)
		.join("\n");
	if (content.length < 50) return null;
	return { url, title: extractTitleFromContent(content, url), content, error: null };
}

function extractTitleFromContent(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}
