import { resizeImage } from "@earendil-works/pi-coding-agent";
import { Readability } from "@mozilla/readability";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { activityMonitor } from "./activity.ts";
import { extractWithBrightDataUnlocker, isBrightDataUnlockerAvailable } from "./brightdata-unlocker.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { appendDeclaredWebLinks, type DeclaredWebLink, discoverDeclaredWebLinks } from "./declared-web-links.ts";
import { extractWithFirecrawl, isFirecrawlAvailable } from "./firecrawl.ts";
import { extractWithGeminiWeb, extractWithUrlContext } from "./gemini-url-context.ts";
import { extractGitHub } from "./github-extract.ts";
import { extractWithKagi, isKagiExtractAvailable } from "./kagi.ts";
import { extractWithOllama, isOllamaFetchAvailable } from "./ollama.ts";
import { extractWithParallel, isParallelAvailable } from "./parallel.ts";
import { extractPDFToMarkdown, isPDF, loadPDFConfig, type PDFConfig } from "./pdf-extract.ts";
import { extractWithQuerit, isQueritAvailable } from "./querit.ts";
import { extractHeadingTitle, extractRSCContent } from "./rsc-extract.ts";
import { extractWithSearch1API, isSearch1APIAvailable } from "./search1api.ts";
import {
	fetchRemoteUrl,
	type Lookup,
	loadFetchContentDomainPolicy,
	loadSsrfConfig,
	validateRemoteUrl,
} from "./ssrf-protection.ts";
import { extractWithTinyFish, isTinyFishAvailable } from "./tinyfish.ts";
import { errorMessage, getWebSearchConfigPath, isAbortError, nativePromise } from "./utils.ts";

const DEFAULT_TIMEOUT_MS = 30000;
const CONCURRENT_LIMIT = 3;

const NON_RECOVERABLE_ERRORS = ["Unsupported content type", "Response too large"];
const MIN_USEFUL_CONTENT = 500;
const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const WEB_SEARCH_CONFIG_PATH = getWebSearchConfigPath();
const PAGE_REQUEST_HEADERS = {
	"User-Agent":
		"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
	Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
	"Accept-Language": "en-US,en;q=0.9",
	"Cache-Control": "no-cache",
	"Sec-Fetch-Dest": "document",
	"Sec-Fetch-Mode": "navigate",
	"Sec-Fetch-Site": "none",
	"Sec-Fetch-User": "?1",
	"Upgrade-Insecure-Requests": "1",
};

export { loadSsrfConfig } from "./ssrf-protection.ts";

export function loadSsrfAllowRanges(): string[] {
	return loadSsrfConfig().allowRanges;
}

function abortedResult(url: string): ExtractedContent {
	return { url, title: "", content: "", error: "Aborted" };
}

const turndown = new TurndownService({
	headingStyle: "atx",
	codeBlockStyle: "fenced",
});

export interface ExtractedContent {
	url: string;
	title: string;
	content: string;
	error: string | null;
	thumbnail?: { data: string; mimeType: string };
	mimeType?: string;
	status?: number;
}

type HttpExtractedContent = ExtractedContent & { declaredLinks?: DeclaredWebLink[] };

export interface ExtractOptions {
	timeoutMs?: number | undefined;
	mode?: "readable" | "raw";
	/** Custom DNS resolver used for SSRF validation. Primarily a test seam. */
	lookup?: Lookup | undefined;
}

const JINA_READER_BASE = "https://r.jina.ai/";
const JINA_TIMEOUT_MS = 30000;

function extractWithJinaReader(url: string, lookup?: Lookup): Effect.Effect<ExtractedContent | null> {
	return Effect.suspend(() => {
		const activityId = activityMonitor.logStart({ type: "api", query: `jina: ${url}` });
		const program = Effect.gen(function* () {
			const ssrf = loadSsrfConfig();
			yield* nativePromise(() =>
				validateRemoteUrl(url, {
					allowRanges: ssrf.allowRanges,
					trustEnvProxy: ssrf.trustEnvProxy,
					domainPolicy: loadFetchContentDomainPolicy(),
					lookup,
				}),
			);
			const response = yield* nativePromise((signal) =>
				fetch(JINA_READER_BASE + url, {
					headers: { Accept: "text/markdown", "X-No-Cache": "true" },
					redirect: "error",
					signal,
				}),
			);
			if (!response.ok) return { content: null, response };
			const content = yield* readTextResponseWithLimit(response, 5 * 1024 * 1024);
			return { content, response };
		});
		return program.pipe(
			Effect.timeout(JINA_TIMEOUT_MS),
			Effect.mapError((error) =>
				Cause.isTimeoutError(error) ? new DOMException("This operation was aborted", "AbortError") : error,
			),
			Effect.map(({ content, response }) => {
				activityMonitor.logComplete(activityId, response.status);
				if (content === null) return null;
				const contentStart = content.indexOf("Markdown Content:");
				if (contentStart < 0) return null;
				const markdownPart = content.slice(contentStart + 17).trim();
				if (
					markdownPart.length < 100 ||
					markdownPart.startsWith("Loading...") ||
					markdownPart.startsWith("Please enable JavaScript")
				) {
					return null;
				}
				const title = extractHeadingTitle(markdownPart) ?? (new URL(url).pathname.split("/").pop() || url);
				return { url, title, content: markdownPart, error: null };
			}),
			Effect.catch((error) =>
				Effect.sync(() => {
					const message = errorMessage(error);
					if (isAbortError(error)) activityMonitor.logComplete(activityId, 0);
					else activityMonitor.logError(activityId, message);
					return null;
				}),
			),
			Effect.onInterrupt(() => Effect.sync(() => activityMonitor.logComplete(activityId, 0))),
		);
	});
}

interface ContentFallback {
	readonly available: () => boolean;
	readonly extract: Effect.Effect<ExtractedContent | null, Error>;
	readonly label?: string;
}

interface ContentFallbackResult {
	readonly errors: string[];
	readonly result: ExtractedContent | null;
}

function appendLinks(result: ExtractedContent, declaredLinks: DeclaredWebLink[]): ExtractedContent {
	return { ...result, content: appendDeclaredWebLinks(result.content, declaredLinks) };
}

function contentFallbacks(url: string, options: ExtractOptions | undefined): readonly ContentFallback[] {
	const ssrfOptions = () => {
		const ssrf = loadSsrfConfig();
		return { timeoutMs: options?.timeoutMs, lookup: options?.lookup, ssrf };
	};
	return [
		{
			available: isFirecrawlAvailable,
			extract: extractWithFirecrawl(url, undefined, ssrfOptions()),
			label: "Firecrawl",
		},
		{ available: () => true, extract: extractWithJinaReader(url, options?.lookup) },
		{
			available: isTinyFishAvailable,
			extract: extractWithTinyFish(url, undefined, options),
			label: "TinyFish",
		},
		{
			available: isSearch1APIAvailable,
			extract: extractWithSearch1API(url, undefined, options),
			label: "Search1API",
		},
		{
			available: isQueritAvailable,
			extract: extractWithQuerit(url, undefined, options),
			label: "Querit",
		},
		{
			available: isKagiExtractAvailable,
			extract: extractWithKagi(url, undefined, ssrfOptions()),
			label: "Kagi",
		},
		{
			available: isOllamaFetchAvailable,
			extract: extractWithOllama(url, undefined, ssrfOptions()),
			label: "Ollama",
		},
		{
			available: isParallelAvailable,
			extract: extractWithParallel(url),
			label: "Parallel",
		},
		{
			available: isBrightDataUnlockerAvailable,
			extract: extractWithBrightDataUnlocker(url, undefined, ssrfOptions()),
			label: "Bright Data",
		},
	] satisfies readonly ContentFallback[];
}

function tryContentFallbacks(
	url: string,
	options: ExtractOptions | undefined,
	declaredLinks: DeclaredWebLink[],
): Effect.Effect<ContentFallbackResult> {
	return Effect.gen(function* () {
		const errors: string[] = [];
		for (const fallback of contentFallbacks(url, options)) {
			const result = yield* Effect.try({
				try: fallback.available,
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			}).pipe(
				Effect.flatMap((available) => (available ? fallback.extract : Effect.succeed(null))),
				Effect.map((value) => ({ ok: true as const, value })),
				Effect.catch((error) => Effect.succeed({ error, ok: false as const })),
			);
			if (result.ok) {
				if (result.value) return { errors, result: appendLinks(result.value, declaredLinks) };
				continue;
			}
			if (isAbortError(result.error)) return { errors, result: abortedResult(url) };
			if (fallback.label) errors.push(`${fallback.label} fallback failed: ${errorMessage(result.error)}`);
		}
		return { errors, result: null };
	});
}

function extractionGuidance(httpError: string, fallbackErrors: readonly string[]): string {
	return [
		httpError,
		...fallbackErrors,
		"",
		"Fallback options:",
		`  \u2022 Set firecrawlBaseUrl in ${WEB_SEARCH_CONFIG_PATH} to a self-hosted Firecrawl instance`,
		`  • Set tinyfishApiKey in ${WEB_SEARCH_CONFIG_PATH} or TINYFISH_API_KEY`,
		`  • Set search1apiApiKey in ${WEB_SEARCH_CONFIG_PATH} or SEARCH1API_KEY`,
		`  • Set queritApiKey in ${WEB_SEARCH_CONFIG_PATH} or QUERIT_API_KEY`,
		`  • Set kagiApiKey in ${WEB_SEARCH_CONFIG_PATH} or KAGI_API_KEY`,
		`  • Set ollamaApiKey in ${WEB_SEARCH_CONFIG_PATH} or OLLAMA_API_KEY`,
		`  • Set parallelApiKey in ${WEB_SEARCH_CONFIG_PATH} or PARALLEL_API_KEY`,
		`  • Set brightdataApiKey and brightdataUnlockerZone in ${WEB_SEARCH_CONFIG_PATH} or BRIGHTDATA_API_KEY and BRIGHTDATA_UNLOCKER_ZONE`,
		`  \u2022 Set GEMINI_API_KEY in ${WEB_SEARCH_CONFIG_PATH}`,
		"  \u2022 Sign into gemini.google.com in Chrome",
		"  \u2022 Use web_search to find content about this topic",
	].join("\n");
}

export function extractContent(url: string, options?: ExtractOptions): Effect.Effect<ExtractedContent> {
	return Effect.gen(function* () {
		let remoteUrl: URL | null = null;
		try {
			const parsed = new URL(url);
			if (parsed.protocol === "http:" || parsed.protocol === "https:") remoteUrl = parsed;
		} catch {}
		if (remoteUrl) {
			const ssrf = loadSsrfConfig();
			const validationError = yield* nativePromise(() =>
				validateRemoteUrl(remoteUrl, {
					allowRanges: ssrf.allowRanges,
					trustEnvProxy: ssrf.trustEnvProxy,
					domainPolicy: loadFetchContentDomainPolicy(),
					lookup: options?.lookup,
				}),
			).pipe(
				Effect.map((): Error | null => null),
				Effect.catch((error) => Effect.succeed(error)),
			);
			if (validationError) return { url, title: "", content: "", error: errorMessage(validationError) };
		}
		if (options?.mode === "raw") return yield* extractViaHttp(url, options);
		try {
			if (!remoteUrl) new URL(url);
		} catch (error) {
			return { url, title: "", content: "", error: errorMessage(error) };
		}
		const ghResult = yield* extractGitHub(url);
		if (ghResult) return ghResult;
		const { declaredLinks = [], ...httpResult } = yield* extractViaHttp(url, options);
		if (!httpResult.error) return httpResult;
		const httpError = httpResult.error;
		if (NON_RECOVERABLE_ERRORS.some((prefix) => httpError.startsWith(prefix))) return httpResult;
		const fallback = yield* tryContentFallbacks(url, options, declaredLinks);
		if (fallback.result) return fallback.result;
		let geminiError: Error | undefined;
		const geminiResult = yield* extractWithUrlContext(url).pipe(
			Effect.flatMap((result) => (result ? Effect.succeed(result) : extractWithGeminiWeb(url))),
			Effect.catch((error) => {
				geminiError = error;
				return Effect.succeed(null);
			}),
		);
		if (geminiError && isAbortError(geminiError)) return abortedResult(url);
		if (geminiError instanceof CredentialResolutionError) {
			return { ...httpResult, error: errorMessage(geminiError) };
		}
		if (geminiResult) return appendLinks(geminiResult, declaredLinks);
		if (declaredLinks.length > 0) return { ...httpResult, error: null };
		return { ...httpResult, error: extractionGuidance(httpError, fallback.errors) };
	});
}

function isLikelyJSRendered(html: string): boolean {
	// Extract body content
	const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
	if (!bodyMatch) return false;

	const bodyHtml = bodyMatch[1] ?? "";

	// Strip tags to get text content
	const textContent = bodyHtml
		.replace(/<script[\s\S]*?<\/script>/gi, "")
		.replace(/<style[\s\S]*?<\/style>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();

	// Count scripts
	const scriptCount = (html.match(/<script/gi) || []).length;

	// Heuristic: little text content but many scripts suggests JS rendering
	return textContent.length < 500 && scriptCount > 3;
}

export function readPDFResponseBuffer(response: Response, maxSizeMB: number): Effect.Effect<ArrayBuffer, Error> {
	const maxBytes = maxSizeMB * 1024 * 1024;
	return readResponseBufferWithLimit(response, maxBytes, () => pdfSizeLimitError(maxSizeMB));
}

function readTextResponseWithLimit(response: Response, maxBytes: number): Effect.Effect<string, Error> {
	return readResponseBufferWithLimit(response, maxBytes, () => responseSizeLimitError(maxBytes)).pipe(
		Effect.map((buffer) => {
			const charset = response.headers.get("content-type")?.match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1];
			try {
				// SAFETY: Bun narrows TextDecoder labels to Encoding, while the runtime accepts arbitrary labels and throws below.
				return new TextDecoder((charset || "utf-8") as ConstructorParameters<typeof TextDecoder>[0]).decode(buffer);
			} catch {
				return new TextDecoder("utf-8").decode(buffer);
			}
		}),
	);
}

function isTextContentType(contentType: string): boolean {
	const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return (
		mimeType.startsWith("text/") ||
		mimeType === "application/json" ||
		mimeType === "application/ld+json" ||
		mimeType === "application/xml" ||
		mimeType === "application/xhtml+xml" ||
		mimeType === "application/javascript" ||
		mimeType === "application/x-javascript" ||
		mimeType.endsWith("+json") ||
		mimeType.endsWith("+xml")
	);
}

function readResponseBufferWithLimit(
	response: Response,
	maxBytes: number,
	buildError: () => Error,
): Effect.Effect<ArrayBuffer, Error> {
	return Effect.suspend(() => {
		const reader = response.body?.getReader();
		if (!reader) {
			return nativePromise(() => response.arrayBuffer()).pipe(
				Effect.flatMap((buffer) =>
					buffer.byteLength > maxBytes ? Effect.fail(buildError()) : Effect.succeed(buffer),
				),
			);
		}

		let finished = false;
		const read = nativePromise(async () => {
			const chunks: Uint8Array[] = [];
			let totalBytes = 0;
			while (true) {
				const chunk = await reader.read();
				if (chunk.done) {
					finished = true;
					break;
				}
				if (!chunk.value) continue;
				totalBytes += chunk.value.byteLength;
				if (totalBytes > maxBytes) {
					await reader.cancel();
					finished = true;
					throw buildError();
				}
				chunks.push(chunk.value);
			}
			const combined = new Uint8Array(totalBytes);
			let offset = 0;
			for (const chunk of chunks) {
				combined.set(chunk, offset);
				offset += chunk.byteLength;
			}
			return combined.buffer;
		});
		const release = Effect.suspend(() =>
			(finished ? Effect.void : nativePromise(() => reader.cancel()).pipe(Effect.catch(() => Effect.void))).pipe(
				Effect.andThen(Effect.sync(() => reader.releaseLock())),
			),
		);
		return read.pipe(Effect.ensuring(release));
	});
}

function pdfSizeLimitError(maxSizeMB: number): Error {
	return new Error(`PDF exceeds configured pdf.maxSizeMB limit (${maxSizeMB} MB)`);
}

function responseSizeLimitError(maxBytes: number): Error {
	return new Error(`Response too large (${Math.round(maxBytes / 1024 / 1024)}MB)`);
}

function oversizedResponse(
	response: Response,
	url: string,
	maxResponseSize: number,
	pdfConfig: PDFConfig | null,
	activityId: string,
): HttpExtractedContent | null {
	const header = response.headers.get("content-length");
	if (!header) return null;
	const contentLength = Number.parseInt(header, 10);
	if (!Number.isFinite(contentLength) || contentLength <= maxResponseSize) return null;
	activityMonitor.logComplete(activityId, response.status);
	return {
		url,
		title: "",
		content: "",
		error: pdfConfig
			? pdfSizeLimitError(pdfConfig.maxSizeMB).message
			: `Response too large (${Math.round(contentLength / 1024 / 1024)}MB)`,
	};
}

function extractRawResponse(
	response: Response,
	url: string,
	contentType: string,
	mimeType: string,
	maxResponseSize: number,
	activityId: string,
): Effect.Effect<HttpExtractedContent, Error> {
	if (!isTextContentType(contentType)) {
		activityMonitor.logComplete(activityId, response.status);
		return Effect.succeed({
			url,
			title: "",
			content: "",
			error: `Unsupported content type in raw mode: ${mimeType || "missing"}`,
			mimeType,
			status: response.status,
		});
	}
	return readTextResponseWithLimit(response, maxResponseSize).pipe(
		Effect.map((text) => {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: extractTextTitle(text, url),
				content: text,
				error: null,
				mimeType,
				status: response.status,
			};
		}),
	);
}

function extractImageResponse(
	response: Response,
	url: string,
	mimeType: string,
	maxResponseSize: number,
	activityId: string,
): Effect.Effect<HttpExtractedContent> {
	return Effect.gen(function* () {
		const buffer = yield* readResponseBufferWithLimit(response, maxResponseSize, () =>
			responseSizeLimitError(maxResponseSize),
		);
		const resized = yield* nativePromise(() =>
			resizeImage(new Uint8Array(buffer), mimeType, { maxWidth: 2000, maxHeight: 2000 }),
		);
		activityMonitor.logComplete(activityId, response.status);
		if (!resized) {
			return {
				url,
				title: "",
				content: "",
				error: `Could not decode image: ${mimeType}`,
				mimeType,
				status: response.status,
			};
		}
		return {
			url,
			title: new URL(response.url || url).pathname.split("/").pop() || url,
			content: `Image fetched (${String(resized.width)}×${String(resized.height)}, ${resized.mimeType})`,
			error: null,
			thumbnail: { data: resized.data, mimeType: resized.mimeType },
			mimeType: resized.mimeType,
			status: response.status,
		};
	}).pipe(
		Effect.catch((error) =>
			Effect.sync(() => {
				const message = errorMessage(error);
				activityMonitor.logError(activityId, message);
				return { url, title: "", content: "", error: message, mimeType, status: response.status };
			}),
		),
	);
}

function extractPdfResponse(
	response: Response,
	url: string,
	pdfConfig: PDFConfig,
	activityId: string,
): Effect.Effect<HttpExtractedContent> {
	return Effect.gen(function* () {
		const buffer = yield* readPDFResponseBuffer(response, pdfConfig.maxSizeMB);
		const result = yield* extractPDFToMarkdown(buffer, url);
		activityMonitor.logComplete(activityId, response.status);
		return {
			url,
			title: result.title,
			content: `PDF extracted and saved to: ${result.outputPath}\n\nPages: ${String(result.pages)}\nCharacters: ${String(result.chars)}`,
			error: null,
		};
	}).pipe(
		Effect.catch((error) =>
			Effect.sync(() => {
				const message = errorMessage(error);
				activityMonitor.logError(activityId, message);
				if (message.startsWith("PDF exceeds configured pdf.maxSizeMB limit")) {
					return { url, title: "", content: "", error: message };
				}
				if (error instanceof CredentialResolutionError) return { url, title: "", content: "", error: message };
				return { url, title: "", content: "", error: `PDF extraction failed: ${message}` };
			}),
		),
	);
}

function isUnsupportedBinary(contentType: string): boolean {
	return (
		contentType.includes("application/octet-stream") ||
		contentType.includes("image/") ||
		contentType.includes("audio/") ||
		contentType.includes("video/") ||
		contentType.includes("application/zip")
	);
}

function extractHtmlResponse(response: Response, url: string, text: string, activityId: string): HttpExtractedContent {
	const { document } = parseHTML(text);
	const documentTitle = document.title?.trim() ?? "";
	const declaredLinks = discoverDeclaredWebLinks(document, response.headers.get("link"), response.url || url);
	const article = new Readability(document).parse();
	if (!article) {
		const rscResult = extractRSCContent(text);
		if (rscResult) {
			activityMonitor.logComplete(activityId, response.status);
			return {
				url,
				title: rscResult.title,
				content: appendDeclaredWebLinks(rscResult.content, declaredLinks),
				error: null,
				declaredLinks,
			};
		}
		activityMonitor.logComplete(activityId, response.status);
		return {
			url,
			title: documentTitle,
			content: appendDeclaredWebLinks("", declaredLinks),
			error: isLikelyJSRendered(text)
				? "Page appears to be JavaScript-rendered (content loads dynamically)"
				: "Could not extract readable content from HTML structure",
			declaredLinks,
		};
	}
	if (!isRuntimeString(article.content)) throw new Error("Readability returned invalid article content");
	const markdown = turndown.turndown(article.content);
	activityMonitor.logComplete(activityId, response.status);
	return {
		url,
		title: article.title || documentTitle,
		content: appendDeclaredWebLinks(markdown, declaredLinks),
		error:
			markdown.length >= MIN_USEFUL_CONTENT
				? null
				: isLikelyJSRendered(text)
					? "Page appears to be JavaScript-rendered (content loads dynamically)"
					: "Extracted content appears incomplete",
		declaredLinks,
	};
}

function extractHttpResponse(
	response: Response,
	url: string,
	options: ExtractOptions | undefined,
	activityId: string,
): Effect.Effect<HttpExtractedContent, Error> {
	if (!response.ok && options?.mode !== "raw") {
		activityMonitor.logComplete(activityId, response.status);
		return Effect.succeed({
			url,
			title: "",
			content: "",
			error: `HTTP ${response.status}: ${response.statusText}`,
			status: response.status,
		});
	}
	const contentType = response.headers.get("content-type") || "";
	const mimeType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	const pdfConfig = isPDF(url, contentType) ? loadPDFConfig() : null;
	const maxResponseSize = (pdfConfig?.maxSizeMB ?? 5) * 1024 * 1024;
	const sizeError = oversizedResponse(response, url, maxResponseSize, pdfConfig, activityId);
	if (sizeError) return Effect.succeed(sizeError);
	if (options?.mode === "raw") {
		return extractRawResponse(response, url, contentType, mimeType, maxResponseSize, activityId);
	}
	if (SUPPORTED_IMAGE_TYPES.has(mimeType)) {
		return extractImageResponse(response, url, mimeType, maxResponseSize, activityId);
	}
	if (pdfConfig) return extractPdfResponse(response, url, pdfConfig, activityId);
	if (isUnsupportedBinary(contentType)) {
		activityMonitor.logComplete(activityId, response.status);
		return Effect.succeed({
			url,
			title: "",
			content: "",
			error: `Unsupported content type: ${contentType.split(";")[0]}`,
		});
	}
	return readTextResponseWithLimit(response, maxResponseSize).pipe(
		Effect.flatMap((text): Effect.Effect<HttpExtractedContent, Error> => {
			if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
				activityMonitor.logComplete(activityId, response.status);
				return Effect.succeed({ url, title: extractTextTitle(text, url), content: text, error: null });
			}
			return Effect.try({
				try: () => extractHtmlResponse(response, url, text, activityId),
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			});
		}),
	);
}

function extractViaHttp(url: string, options?: ExtractOptions): Effect.Effect<HttpExtractedContent> {
	return Effect.suspend(() => {
		const activityId = activityMonitor.logStart({ type: "fetch", url });
		const ssrf = loadSsrfConfig();
		return nativePromise((signal) =>
			fetchRemoteUrl(
				url,
				{ headers: PAGE_REQUEST_HEADERS, signal },
				{
					allowRanges: ssrf.allowRanges,
					trustEnvProxy: ssrf.trustEnvProxy,
					domainPolicy: loadFetchContentDomainPolicy(),
					lookup: options?.lookup,
				},
			),
		).pipe(
			Effect.flatMap((response) => extractHttpResponse(response, url, options, activityId)),
			Effect.timeout(options?.timeoutMs ?? DEFAULT_TIMEOUT_MS),
			Effect.mapError((error) =>
				Cause.isTimeoutError(error) ? new DOMException("This operation was aborted", "AbortError") : error,
			),
			Effect.catch((error) =>
				Effect.sync(() => {
					const message = errorMessage(error);
					if (isAbortError(error)) activityMonitor.logComplete(activityId, 0);
					else activityMonitor.logError(activityId, message);
					return { url, title: "", content: "", error: message };
				}),
			),
			Effect.onInterrupt(() => Effect.sync(() => activityMonitor.logComplete(activityId, 0))),
		);
	});
}

function extractTextTitle(text: string, url: string): string {
	return extractHeadingTitle(text) ?? (new URL(url).pathname.split("/").pop() || url);
}

export function fetchAllContent(urls: string[], options?: ExtractOptions): Effect.Effect<ExtractedContent[]> {
	return Effect.forEach(urls, (url) => extractContent(url, options), { concurrency: CONCURRENT_LIMIT });
}
