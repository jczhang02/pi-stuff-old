import * as Effect from "effect/Effect";
import type { JsonInputValue } from "../../shared/json-value.ts";
import { isJsonInputObject, type JsonInputObject, requireJsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeString } from "../../shared/runtime-type.ts";
import { activityMonitor } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { redactCredential, resolveCredential } from "./credential-source.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { fetchRemoteUrl, type Lookup, validateRemoteUrl } from "./ssrf-protection.ts";
import { errorMessage, getWebSearchConfigPath, isAbortError, nativePromise, nativeRequest } from "./utils.ts";

const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const DEFAULT_API_VERSION = "v2";
const EXTRACT_TIMEOUT_MS = 60_000;
const SUPPORTED_API_VERSIONS = ["v1", "v2"] as const;
type FirecrawlApiVersion = (typeof SUPPORTED_API_VERSIONS)[number];

export interface FirecrawlSsrfOptions {
	allowRanges: string[];
	trustEnvProxy: boolean;
}

export interface FirecrawlExtractOptions extends Pick<ExtractOptions, "timeoutMs" | "lookup"> {
	ssrf?: FirecrawlSsrfOptions;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

function normalizeBaseUrl(value: JsonInputValue): string | null {
	if (!isRuntimeString(value)) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`Invalid Firecrawl base URL in ${CONFIG_PATH}: expected an HTTP or HTTPS URL`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Invalid Firecrawl base URL in ${CONFIG_PATH}: expected an HTTP or HTTPS URL`);
	}
	if (parsed.username || parsed.password) {
		throw new Error(`Invalid Firecrawl base URL in ${CONFIG_PATH}: URL credentials are not allowed`);
	}
	parsed.pathname = parsed.pathname.replace(/\/+$/, "");
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString().replace(/\/+$/, "");
}

function getBaseUrl(): string | null {
	return normalizeBaseUrl(process.env["FIRECRAWL_BASE_URL"]) ?? normalizeBaseUrl(loadConfig()["firecrawlBaseUrl"]);
}

function requireBaseUrl(): string {
	const baseUrl = getBaseUrl();
	if (!baseUrl) {
		throw new Error(
			"Firecrawl base URL not configured. Either:\n" +
				`  1. Set firecrawlBaseUrl in ${CONFIG_PATH}\n` +
				"  2. Set FIRECRAWL_BASE_URL environment variable",
		);
	}
	return baseUrl;
}

function getApiVersion(): FirecrawlApiVersion {
	const environmentValue = isRuntimeString(process.env["FIRECRAWL_API_VERSION"])
		? process.env["FIRECRAWL_API_VERSION"].trim()
		: "";
	const raw = environmentValue || loadConfig()["firecrawlApiVersion"];
	if (raw === undefined || raw === null) return DEFAULT_API_VERSION;
	if (!isRuntimeString(raw)) {
		throw new Error(`firecrawlApiVersion in ${CONFIG_PATH} must be a string ("v1" or "v2")`);
	}
	const normalized = raw.trim().toLowerCase();
	if (!normalized) return DEFAULT_API_VERSION;
	if (normalized !== "v1" && normalized !== "v2") {
		throw new Error(
			`Unsupported Firecrawl API version "${raw}". Supported versions: ${SUPPORTED_API_VERSIONS.join(", ")}`,
		);
	}
	return normalized;
}

function allowFreshScrape(): boolean {
	const environmentValue = process.env["FIRECRAWL_FRESH_SCRAPE"];
	if (environmentValue !== undefined) return environmentValue === "1" || environmentValue.toLowerCase() === "true";
	const configured = loadConfig()["firecrawlFreshScrape"];
	if (configured === undefined || configured === null) return false;
	if (!isRuntimeBoolean(configured)) throw new Error(`firecrawlFreshScrape in ${CONFIG_PATH} must be a boolean`);
	return configured;
}

async function getApiKey(signal?: AbortSignal): Promise<string | null> {
	const configKey = loadConfig()["firecrawlApiKey"];
	return resolveCredential({
		provider: "Firecrawl",
		configuredValue: configKey,
		environmentValue: process.env["FIRECRAWL_API_KEY"],
		signal,
	});
}

interface FirecrawlValidationOptions {
	lookup?: Lookup;
	allowRanges: string[];
	trustEnvProxy: boolean;
}

function ssrfOptions(options?: FirecrawlExtractOptions): FirecrawlValidationOptions {
	const validation: FirecrawlValidationOptions = {
		allowRanges: options?.ssrf?.allowRanges ?? [],
		trustEnvProxy: options?.ssrf?.trustEnvProxy ?? false,
	};
	if (options?.lookup) validation.lookup = options.lookup;
	return validation;
}

function withoutSensitiveHeaders(headers: Headers): Headers {
	const next = new Headers(headers);
	next.delete("Authorization");
	next.delete("Cookie");
	next.delete("X-API-Key");
	return next;
}

async function fetchFirecrawlApi(
	url: string,
	init: { method: string; headers: Headers; body: string; signal: AbortSignal },
	options: FirecrawlExtractOptions | undefined,
): Promise<Response> {
	return fetchRemoteUrl(url, init, {
		...ssrfOptions(options),
		preserveRedirectMethod: true,
		onRedirect: ({ from, to, init: nextInit }) =>
			from.origin === to.origin
				? nextInit
				: { ...nextInit, headers: withoutSensitiveHeaders(new Headers(nextInit.headers)) },
	});
}

function scrapeBody(url: string): JsonInputObject {
	const body: JsonInputObject = {
		url,
		formats: ["markdown"],
		onlyMainContent: true,
	};
	if (!allowFreshScrape()) body["lockdown"] = true;
	return body;
}

async function firecrawlFetchNative(
	endpoint: string,
	body: JsonInputObject,
	baseUrl: string,
	version: FirecrawlApiVersion,
	apiKey: string | null,
	signal: AbortSignal,
	options: FirecrawlExtractOptions | undefined,
): Promise<JsonInputObject> {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
	const requestUrl = `${baseUrl}/${version}/${endpoint}`;
	const activityId = activityMonitor.logStart({ type: "fetch", url: requestUrl });
	try {
		const response = await fetchFirecrawlApi(
			requestUrl,
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
				signal,
			},
			options,
		);
		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Firecrawl scrape error ${response.status}: ${redactCredential(text.slice(0, 300), apiKey)}`);
		}
		let data: JsonInputValue;
		try {
			data = requireJsonInputValue(await response.json(), "Firecrawl response");
		} catch (err) {
			throw new Error(`Firecrawl scrape returned invalid JSON: ${errorMessage(err)}`);
		}
		if (!isJsonInputObject(data)) {
			throw new Error("Firecrawl scrape returned an unexpected response shape");
		}
		if (data["success"] === false) {
			const reason = isRuntimeString(data["error"]) && data["error"].trim() ? data["error"] : "unknown error";
			throw new Error(`Firecrawl scrape unsuccessful: ${redactCredential(reason, apiKey)}`);
		}
		if (data["success"] !== true) {
			throw new Error("Firecrawl scrape returned an unexpected response shape");
		}
		activityMonitor.logComplete(activityId, response.status);
		return data;
	} catch (err) {
		if (isAbortError(err)) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, errorMessage(err));
		throw err;
	}
}

export function isFirecrawlAvailable(): boolean {
	return getBaseUrl() !== null;
}

export function extractWithFirecrawl(url: string, signal?: AbortSignal, options?: FirecrawlExtractOptions) {
	return Effect.gen(function* () {
		const baseUrl = yield* Effect.try({
			try: requireBaseUrl,
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
		yield* nativePromise(() => validateRemoteUrl(url, ssrfOptions(options)));
		const { body, version } = yield* Effect.try({
			try: () => ({ body: scrapeBody(url), version: getApiVersion() }),
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
		const apiKey = yield* nativePromise(getApiKey, signal);
		const envelope = yield* nativeRequest(
			(requestSignal) => firecrawlFetchNative("scrape", body, baseUrl, version, apiKey, requestSignal, options),
			options?.timeoutMs ?? EXTRACT_TIMEOUT_MS,
			signal,
		);
		return yield* Effect.try({
			try: () => {
				const data = envelope["data"];
				if (!isJsonInputObject(data)) {
					throw new Error("Firecrawl scrape returned an unexpected data shape");
				}
				if (!isRuntimeString(data["markdown"])) {
					throw new Error("Firecrawl scrape returned markdown in an unexpected shape");
				}
				const content = data["markdown"].trim();
				if (!content) return null;
				const metadata = isJsonInputObject(data["metadata"]) ? data["metadata"] : undefined;
				const metadataTitle = metadata?.["title"];
				const title =
					isRuntimeString(metadataTitle) && metadataTitle.trim()
						? metadataTitle.trim()
						: isRuntimeString(data["title"])
							? data["title"].trim()
							: "";
				return { url, title, content, error: null } satisfies ExtractedContent;
			},
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
	});
}
