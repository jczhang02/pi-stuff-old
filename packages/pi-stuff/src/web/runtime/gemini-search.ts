import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { isJsonInputObject, type JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { isAnySearchAvailable, searchWithAnySearch } from "./anysearch.ts";
import { isBraveAvailable, searchWithBrave } from "./brave.ts";
import { isBrightDataAvailable, searchWithBrightData } from "./brightdata.ts";
import { readWebConfig } from "./config.ts";
import { CredentialResolutionError } from "./credential-source.ts";
import { isExaAvailable, searchWithExa } from "./exa.ts";
import { isGeminiApiAvailable, searchWithGeminiApi } from "./gemini-api.ts";
import { getGeminiWebAvailabilityDiagnostic, isGeminiWebAvailable, searchWithGeminiWeb } from "./gemini-web.ts";
import { isKagiAvailable, searchWithKagi } from "./kagi.ts";
import { isOllamaAvailable, searchWithOllama } from "./ollama.ts";
import { isOpenAISearchAvailable, searchWithOpenAI } from "./openai-search.ts";
import { isParallelAvailable, searchWithParallel } from "./parallel.ts";
import {
	isPerplexityAvailable,
	type SearchOptions,
	type SearchResponse,
	type SearchResult,
	searchWithPerplexity,
} from "./perplexity.ts";
import { isQueritAvailable, searchWithQuerit } from "./querit.ts";
import { isSearch1APIAvailable, searchWithSearch1API } from "./search1api.ts";
import { isSearchinfinityAvailable, searchWithSearchinfinity } from "./searchinfinity.ts";
import { isSearXNGAvailable, searchWithSearXNG } from "./searxng.ts";
import { isSerpBaseAvailable, searchWithSerpBase } from "./serpbase.ts";
import { isSerpdiveAvailable, searchWithSerpdive } from "./serpdive.ts";
import { isTavilyAvailable, searchWithTavily } from "./tavily.ts";
import { isTinyFishAvailable, searchWithTinyFish } from "./tinyfish.ts";
import { errorMessage, getWebSearchConfigPath, isAbortError } from "./utils.ts";
import { isXaiSearchAvailable, searchWithXai } from "./xai-search.ts";

const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;

interface ProviderRuntimeOptions extends SearchOptions {
	extensionContext?: ExtensionContext;
}

type ProviderSearch = (query: string, options: ProviderRuntimeOptions) => Effect.Effect<SearchResponse | null, Error>;
type ProviderAvailability = (options: ProviderRuntimeOptions) => Effect.Effect<boolean, Error>;

interface SearchProviderDefinition<Provider extends string = string> {
	readonly id: Provider;
	readonly label: string;
	readonly search: ProviderSearch;
	readonly available: ProviderAvailability;
	readonly automaticAvailable?: ProviderAvailability;
	readonly catchAutomaticAvailabilityError?: boolean;
	readonly automaticPriority?: number;
	readonly automaticSearch?: ProviderSearch;
	readonly aggregateAvailable?: ProviderAvailability;
	readonly aggregateEmptyResultMessage?: string;
	readonly aggregateSearch?: ProviderSearch;
	readonly emptyResultMessage?: string;
	readonly stopAutomaticOnCredentialError?: boolean;
}

function providerAvailability(available: (options: ProviderRuntimeOptions) => boolean): ProviderAvailability {
	return (options) =>
		Effect.try({
			try: () => available(options),
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
}

const SEARCH_PROVIDER_DEFINITIONS = [
	{
		id: "openai",
		label: "OpenAI",
		search: (query, options) => searchWithOpenAI(query, options, options.extensionContext),
		available: (options) => isOpenAISearchAvailable(options.extensionContext, options.signal),
		automaticAvailable: (options) =>
			shouldTryOpenAIInAuto(options)
				? isOpenAISearchAvailable(options.extensionContext, options.signal)
				: Effect.succeed(false),
		catchAutomaticAvailabilityError: true,
		automaticPriority: 1,
	},
	{
		id: "brave",
		label: "Brave",
		search: searchWithBrave,
		available: providerAvailability(isBraveAvailable),
		automaticPriority: 3,
	},
	{
		id: "parallel",
		label: "Parallel",
		search: searchWithParallel,
		available: providerAvailability(isParallelAvailable),
		automaticPriority: 4,
	},
	{
		id: "tinyfish",
		label: "TinyFish",
		search: searchWithTinyFish,
		available: providerAvailability(isTinyFishAvailable),
		automaticPriority: 5,
	},
	{
		id: "search1api",
		label: "Search1API",
		search: searchWithSearch1API,
		available: providerAvailability(isSearch1APIAvailable),
		automaticPriority: 6,
	},
	{
		id: "searchinfinity",
		label: "Searchinfinity",
		search: searchWithSearchinfinity,
		available: providerAvailability(isSearchinfinityAvailable),
		automaticPriority: 7,
	},
	{
		id: "querit",
		label: "Querit",
		search: searchWithQuerit,
		available: providerAvailability(isQueritAvailable),
		automaticPriority: 8,
	},
	{
		id: "tavily",
		label: "Tavily",
		search: searchWithTavily,
		available: providerAvailability(isTavilyAvailable),
		automaticPriority: 9,
	},
	{
		id: "searxng",
		label: "SearXNG",
		search: searchWithSearXNG,
		available: providerAvailability(isSearXNGAvailable),
		automaticPriority: 0,
	},
	{
		id: "perplexity",
		label: "Perplexity",
		search: searchWithPerplexity,
		available: providerAvailability(isPerplexityAvailable),
		automaticPriority: 13,
	},
	{
		id: "gemini",
		label: "Gemini",
		search: (query, options) => searchWithGemini(query, options, true),
		available: () =>
			isGeminiApiAvailable()
				? Effect.succeed(true)
				: isGeminiWebAvailable().pipe(Effect.map((cookies) => Boolean(cookies))),
		automaticAvailable: providerAvailability(() => true),
		automaticPriority: 14,
		automaticSearch: (query, options) => searchWithGemini(query, options, false),
		aggregateAvailable: providerAvailability(isGeminiApiAvailable),
		aggregateEmptyResultMessage: "Gemini API search returned no results.",
		aggregateSearch: searchWithGeminiApi,
		emptyResultMessage:
			"Gemini search unavailable. Either:\n" +
			`  1. Configure geminiApiKey in ${CONFIG_PATH} or set GEMINI_API_KEY\n` +
			"  2. Set GOOGLE_GEMINI_BASE_URL + CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
			"  3. Sign into gemini.google.com in a supported Chromium-based browser",
	},
	{
		id: "exa",
		label: "Exa",
		search: searchWithExa,
		available: providerAvailability(isExaAvailable),
		automaticPriority: 2,
		emptyResultMessage: "Exa search returned no results.",
		stopAutomaticOnCredentialError: true,
	},
	{
		id: "serpdive",
		label: "SERPdive",
		search: searchWithSerpdive,
		available: providerAvailability(isSerpdiveAvailable),
		automaticPriority: 10,
	},
	{
		id: "kagi",
		label: "Kagi",
		search: searchWithKagi,
		available: providerAvailability(isKagiAvailable),
		automaticPriority: 11,
	},
	{
		id: "ollama",
		label: "Ollama",
		search: searchWithOllama,
		available: providerAvailability(isOllamaAvailable),
		automaticPriority: 12,
	},
	{
		id: "anysearch",
		label: "AnySearch",
		search: searchWithAnySearch,
		available: providerAvailability(isAnySearchAvailable),
	},
	{
		id: "xai",
		label: "xAI",
		search: (query, options) => searchWithXai(query, options, options.extensionContext),
		available: (options) => isXaiSearchAvailable(options.extensionContext, options.signal),
	},
	{
		id: "brightdata",
		label: "Bright Data",
		search: searchWithBrightData,
		available: providerAvailability(isBrightDataAvailable),
	},
	{
		id: "serpbase",
		label: "SerpBase",
		search: searchWithSerpBase,
		available: providerAvailability(isSerpBaseAvailable),
	},
] as const satisfies readonly SearchProviderDefinition[];

export type ResolvedSearchProvider = (typeof SEARCH_PROVIDER_DEFINITIONS)[number]["id"];
const PROVIDER_DEFINITIONS: readonly SearchProviderDefinition<ResolvedSearchProvider>[] = SEARCH_PROVIDER_DEFINITIONS;
export const RESOLVED_SEARCH_PROVIDERS: readonly ResolvedSearchProvider[] = SEARCH_PROVIDER_DEFINITIONS.map(
	({ id }) => id,
);
export const SEARCH_PROVIDERS = ["auto", "all", ...RESOLVED_SEARCH_PROVIDERS] as const;
export type SearchProvider = (typeof SEARCH_PROVIDERS)[number];
export type SearchProviderSelection = SearchProvider | ResolvedSearchProvider[];
export type SearchProviderErrorKind =
	| "transient"
	| "quota"
	| "network"
	| "credential"
	| "config"
	| "auth"
	| "invalid-request"
	| "invalid-response"
	| "aborted"
	| "unknown";

export interface SearchRoutingConfig {
	providers: ResolvedSearchProvider[];
	fallbackOn: Array<Extract<SearchProviderErrorKind, "transient" | "quota" | "network">>;
}

export class SearchProviderError extends Error {
	readonly provider: ResolvedSearchProvider;
	readonly kind: SearchProviderErrorKind;
	readonly status: number | undefined;
	readonly causeError: unknown;

	constructor(
		provider: ResolvedSearchProvider,
		kind: SearchProviderErrorKind,
		message: string,
		status: number | undefined,
		cause: unknown,
	) {
		super(`${provider} search failed (${kind}): ${message}`);
		this.name = "SearchProviderError";
		this.provider = provider;
		this.kind = kind;
		this.status = status;
		this.causeError = cause;
	}
}

export interface ProviderSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
}

export interface ProviderSearchFailure {
	provider: ResolvedSearchProvider;
	error: string;
}

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider | "all";
	providerResponses?: ProviderSearchResponse[];
	providerErrors?: ProviderSearchFailure[];
}

// Explicit-only providers have no automatic priority. `all` uses the same safe set,
// so it never fans out to a paid or surprising provider without an explicit choice.
const AUTOMATIC_PROVIDER_DEFINITIONS = PROVIDER_DEFINITIONS.filter(
	(provider) => provider.automaticPriority !== undefined,
).sort((left, right) => (left.automaticPriority ?? 0) - (right.automaticPriority ?? 0));
const VALID_ROUTING_KINDS = ["transient", "quota", "network"] as const;

type SearchConfig = {
	searchProvider: SearchProviderSelection;
	searchProviderConfigured: boolean;
	searchRouting?: SearchRoutingConfig;
};

function getSearchConfig(): SearchConfig {
	const raw = readWebConfig();
	if (!raw) return { searchProvider: "auto", searchProviderConfigured: false };

	const searchProviderConfigured = Object.hasOwn(raw, "searchProvider") || Object.hasOwn(raw, "provider");
	const config: SearchConfig = {
		searchProvider: normalizeSearchProviderSelection(
			raw["searchProvider"] ?? raw["provider"],
			`provider in ${CONFIG_PATH}`,
		),
		searchProviderConfigured,
	};
	if (Object.hasOwn(raw, "searchRouting")) config.searchRouting = normalizeSearchRouting(raw["searchRouting"]);
	return config;
}

function normalizeSearchRouting(value: JsonInputValue): SearchRoutingConfig {
	if (!isJsonInputObject(value)) {
		throw new Error(`searchRouting in ${CONFIG_PATH} must be an object`);
	}
	const providers = normalizeResolvedProviderList(value["providers"], `searchRouting.providers in ${CONFIG_PATH}`);
	if (!Array.isArray(value["fallbackOn"]) || value["fallbackOn"].length === 0) {
		throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} must be a non-empty array`);
	}
	const fallbackOn: SearchRoutingConfig["fallbackOn"] = [];
	for (const kind of value["fallbackOn"]) {
		if (!isRoutingFallbackKind(kind)) {
			throw new Error(`searchRouting.fallbackOn in ${CONFIG_PATH} may only contain transient, quota, or network`);
		}
		if (!fallbackOn.includes(kind)) {
			fallbackOn.push(kind);
		}
	}
	return { providers, fallbackOn };
}

export function getConfiguredSearchRouting(): SearchRoutingConfig | undefined {
	const config = getSearchConfig();
	return config.searchProviderConfigured ? undefined : config.searchRouting;
}

function isRoutingFallbackKind(value: JsonInputValue): value is SearchRoutingConfig["fallbackOn"][number] {
	return isRuntimeString(value) && VALID_ROUTING_KINDS.some((kind) => kind === value);
}

function isResolvedSearchProvider(value: string): value is ResolvedSearchProvider {
	return RESOLVED_SEARCH_PROVIDERS.some((provider) => provider === value);
}

function isSearchProvider(value: string): value is SearchProvider {
	return SEARCH_PROVIDERS.some((provider) => provider === value);
}

function normalizeResolvedProviderList(value: JsonInputValue, label: string): ResolvedSearchProvider[] {
	if (!Array.isArray(value) || value.length === 0) {
		throw new Error(`${label} must be a non-empty array`);
	}
	const providers: ResolvedSearchProvider[] = [];
	for (const provider of value) {
		const normalized = isRuntimeString(provider) ? provider.trim().toLowerCase() : "";
		if (!isResolvedSearchProvider(normalized)) {
			throw new Error(`${label} contains an invalid provider: ${String(provider)}`);
		}
		if (providers.includes(normalized)) {
			throw new Error(`${label} must not contain duplicates: ${normalized}`);
		}
		providers.push(normalized);
	}
	return providers;
}

export function normalizeSearchProviderSelection(value: JsonInputValue, label = "provider"): SearchProviderSelection {
	if (Array.isArray(value)) return normalizeResolvedProviderList(value, label);
	const normalized = isRuntimeString(value) ? value.trim().toLowerCase() : "";
	return isSearchProvider(normalized) ? normalized : "auto";
}

export interface FullSearchOptions extends ProviderRuntimeOptions {
	provider?: SearchProviderSelection;
	includeContent?: boolean;
}

function shouldTryOpenAIInAuto(options: SearchOptions): boolean {
	if (options.recencyFilter) return false;
	if (
		isRuntimeNumber(options.numResults) &&
		Number.isFinite(options.numResults) &&
		Math.floor(options.numResults) !== 5
	) {
		return false;
	}
	return true;
}

function searchWithGemini(query: string, options: SearchOptions, strictErrors: boolean) {
	return Effect.gen(function* () {
		const errors: string[] = [];
		const api = yield* searchWithGeminiApi(query, options).pipe(
			Effect.map((result) => ({ result })),
			Effect.catch((error) =>
				error instanceof CredentialResolutionError || isAbortError(error)
					? Effect.fail(error)
					: Effect.succeed({ error }),
			),
		);
		if ("result" in api && api.result) return api.result;
		if ("error" in api) errors.push(`Gemini API: ${errorMessage(api.error)}`);

		const web = yield* searchWithGeminiWeb(query, options).pipe(
			Effect.map((result) => ({ result })),
			Effect.catch((error) => (isAbortError(error) ? Effect.fail(error) : Effect.succeed({ error }))),
		);
		if ("result" in web && web.result) return web.result;
		if ("error" in web) errors.push(`Gemini Web: ${errorMessage(web.error)}`);
		else {
			const diagnostic = getGeminiWebAvailabilityDiagnostic();
			if (diagnostic) errors.push(`Gemini Web: ${diagnostic}`);
		}

		if (strictErrors && errors.length > 0) {
			return yield* Effect.fail(new Error(`Gemini search failed:\n  - ${errors.join("\n  - ")}`));
		}
		return null;
	});
}

function providerErrorStatus(message: string): number | undefined {
	const match = message.match(/\b(?:error|status|http)\s+(\d{3})\b/i);
	if (!match) return undefined;
	return Number(match[1]);
}

function classifyProviderError<ErrorValue>(provider: ResolvedSearchProvider, err: ErrorValue): SearchProviderError {
	if (err instanceof SearchProviderError) return err;
	const message = errorMessage(err);
	const lower = message.toLowerCase();
	const status = providerErrorStatus(message);
	let kind: SearchProviderErrorKind = "unknown";
	if (
		err instanceof CredentialResolutionError ||
		/(?:api )?key (?:not found|missing)|credential resolution/.test(lower)
	) {
		kind = "credential";
	} else if (isAbortError(err)) {
		kind = "aborted";
	} else if (status === 401 || status === 403) {
		kind = "auth";
	} else if (status === 400 || status === 422) {
		kind = "invalid-request";
	} else if (status === 402 || status === 429) {
		kind = "quota";
	} else if (status !== undefined && (status === 408 || status === 425 || status >= 500)) {
		kind = "transient";
	} else if (/rate limit|quota|too many requests/.test(lower)) {
		kind = "quota";
	} else if (/unauthorized|forbidden|permission denied/.test(lower)) {
		kind = "auth";
	} else if (/bad request|invalid request/.test(lower)) {
		kind = "invalid-request";
	} else if (/invalid json|no parseable response|returned invalid response|returned empty response/.test(lower)) {
		kind = "invalid-response";
	} else if (/temporar|service unavailable|server error/.test(lower)) {
		kind = "transient";
	} else if (
		err instanceof TypeError ||
		/fetch failed|network|econnreset|econnrefused|enotfound|etimedout|timed out|socket/.test(lower)
	) {
		kind = "network";
	} else if (/invalid or missing|invalid config|failed to parse|must be an? |configuration/.test(lower)) {
		kind = "config";
	}
	return new SearchProviderError(provider, kind, message, status, err);
}

function providerDefinition(provider: ResolvedSearchProvider): SearchProviderDefinition<ResolvedSearchProvider> {
	const definition = PROVIDER_DEFINITIONS.find((candidate) => candidate.id === provider);
	if (!definition) throw new Error(`Unknown search provider: ${provider}`);
	return definition;
}

function searchWithResolvedProvider(
	provider: ResolvedSearchProvider,
	query: string,
	options: FullSearchOptions,
): Effect.Effect<ProviderSearchResponse, Error> {
	const definition = providerDefinition(provider);
	return definition
		.search(query, options)
		.pipe(
			Effect.flatMap((result) =>
				result
					? Effect.succeed({ ...result, provider })
					: Effect.fail(
							new Error(definition.emptyResultMessage ?? `${definition.label} search returned no results.`),
						),
			),
		);
}

function isResolvedProviderAvailable(
	provider: ResolvedSearchProvider,
	options: FullSearchOptions,
): Effect.Effect<boolean, Error> {
	return providerDefinition(provider).available(options);
}

function providerLabel(provider: ResolvedSearchProvider): string {
	return providerDefinition(provider).label;
}

function searchWithAllProvider(
	provider: ResolvedSearchProvider,
	query: string,
	options: FullSearchOptions,
): Effect.Effect<ProviderSearchResponse, Error> {
	const definition = providerDefinition(provider);
	return (definition.aggregateSearch ?? definition.search)(query, options).pipe(
		Effect.flatMap((result) =>
			result
				? Effect.succeed({ ...result, provider })
				: Effect.fail(
						new Error(
							definition.aggregateEmptyResultMessage ??
								definition.emptyResultMessage ??
								`${definition.label} search returned no results.`,
						),
					),
		),
	);
}

type Settled<Value> = { readonly ok: true; readonly value: Value } | { readonly error: Error; readonly ok: false };

function settle<Value>(effect: Effect.Effect<Value, Error>): Effect.Effect<Settled<Value>> {
	return effect.pipe(
		Effect.map((value) => ({ ok: true as const, value })),
		Effect.catch((error) => Effect.succeed({ error, ok: false as const })),
	);
}

function searchWithProviders(
	query: string,
	options: FullSearchOptions,
	selectedProviders?: ResolvedSearchProvider[],
): Effect.Effect<AttributedSearchResponse, Error> {
	return Effect.gen(function* () {
		const providers =
			selectedProviders ??
			(yield* Effect.forEach(
				AUTOMATIC_PROVIDER_DEFINITIONS,
				(definition) =>
					(definition.aggregateAvailable ?? definition.available)(options).pipe(
						Effect.map((available) => ({ available, provider: definition.id })),
					),
				{ concurrency: "unbounded" },
			))
				.filter((entry) => entry.available)
				.map((entry) => entry.provider);
		if (providers.length === 0) {
			return yield* Effect.fail(
				new Error(
					'No configured search provider available for provider "all". AnySearch, xAI, Bright Data, and SerpBase are excluded.',
				),
			);
		}

		const outcomes = yield* Effect.forEach(
			providers,
			(provider) =>
				settle(
					selectedProviders
						? searchWithResolvedProvider(provider, query, options)
						: searchWithAllProvider(provider, query, options),
				),
			{ concurrency: "unbounded" },
		);
		const successes: ProviderSearchResponse[] = [];
		const failures: Array<{ provider: ResolvedSearchProvider; error: string }> = [];
		for (const [index, outcome] of outcomes.entries()) {
			const provider = providers[index];
			if (!provider) {
				return yield* Effect.fail(new Error("Search provider result did not match its request"));
			}
			if (outcome.ok) successes.push(outcome.value);
			else failures.push({ provider, error: errorMessage(outcome.error) });
		}
		if (successes.length === 0) {
			const label = selectedProviders ? "Selected-provider" : "All-provider";
			return yield* Effect.fail(
				new Error(
					`${label} search failed:\n  - ${failures.map(({ provider, error }) => `${providerLabel(provider)}: ${error}`).join("\n  - ")}`,
				),
			);
		}

		const results: SearchResult[] = [];
		const seenResultUrls = new Set<string>();
		const inlineContent: NonNullable<SearchResponse["inlineContent"]> = [];
		const seenInlineUrls = new Set<string>();
		for (const response of successes) {
			for (const result of response.results) {
				if (seenResultUrls.has(result.url)) continue;
				seenResultUrls.add(result.url);
				results.push(result);
			}
			for (const content of response.inlineContent ?? []) {
				if (seenInlineUrls.has(content.url)) continue;
				seenInlineUrls.add(content.url);
				inlineContent.push(content);
			}
		}

		const answerSections = successes.map(
			(response) => `## ${providerLabel(response.provider)}\n\n${response.answer || "(No answer text returned.)"}`,
		);
		if (failures.length > 0) {
			answerSections.push(
				`## Provider errors\n\n${failures.map(({ provider, error }) => `- **${providerLabel(provider)}:** ${error}`).join("\n")}`,
			);
		}

		const response: AttributedSearchResponse = {
			provider: "all",
			answer: answerSections.join("\n\n"),
			results,
			providerResponses: successes,
		};
		if (failures.length > 0) response.providerErrors = failures;
		if (inlineContent.length > 0) response.inlineContent = inlineContent;
		return response;
	});
}

function searchWithConfiguredRouting(
	query: string,
	options: FullSearchOptions,
	routing: SearchRoutingConfig,
): Effect.Effect<AttributedSearchResponse, Error> {
	return Effect.gen(function* () {
		const diagnostics: string[] = [];
		for (const provider of routing.providers) {
			if (!(yield* isResolvedProviderAvailable(provider, options))) {
				diagnostics.push(`${provider}: unavailable`);
				continue;
			}
			const outcome = yield* settle(searchWithResolvedProvider(provider, query, options));
			if (outcome.ok) return outcome.value;
			const classified = classifyProviderError(provider, outcome.error);
			diagnostics.push(`${provider} [${classified.kind}]: ${errorMessage(outcome.error)}`);
			if (!isRoutingFallbackKind(classified.kind) || !routing.fallbackOn.includes(classified.kind)) {
				return yield* Effect.fail(classified);
			}
		}
		return yield* Effect.fail(new Error(`Configured search routing exhausted:\n  - ${diagnostics.join("\n  - ")}`));
	});
}

export function search(query: string, options: FullSearchOptions = {}): Effect.Effect<AttributedSearchResponse, Error> {
	return Effect.gen(function* () {
		const { config, provider } = yield* Effect.try({
			try: () => {
				const config = getSearchConfig();
				const provider =
					options.provider === undefined || options.provider === "auto" ? config.searchProvider : options.provider;
				return { config, provider };
			},
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
		if (Array.isArray(provider)) {
			const providers = yield* Effect.try({
				try: () => normalizeResolvedProviderList(provider, "provider"),
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			});
			return yield* searchWithProviders(query, options, providers);
		}
		if (provider === "all") return yield* searchWithProviders(query, options);
		if (provider !== "auto") return yield* searchWithResolvedProvider(provider, query, options);
		if (!config.searchProviderConfigured && config.searchRouting) {
			return yield* searchWithConfiguredRouting(query, options, config.searchRouting);
		}

		const fallbackErrors: string[] = [];
		for (const definition of AUTOMATIC_PROVIDER_DEFINITIONS) {
			const available = definition.automaticAvailable ?? definition.available;
			const availability = yield* settle(available(options));
			if (!availability.ok) {
				if (!definition.catchAutomaticAvailabilityError || isAbortError(availability.error)) {
					return yield* Effect.fail(availability.error);
				}
				fallbackErrors.push(`${definition.label}: ${errorMessage(availability.error)}`);
				continue;
			}
			if (!availability.value) continue;
			const outcome = yield* settle((definition.automaticSearch ?? definition.search)(query, options));
			if (outcome.ok) {
				if (outcome.value) return { ...outcome.value, provider: definition.id };
				continue;
			}
			if (
				isAbortError(outcome.error) ||
				(definition.stopAutomaticOnCredentialError && outcome.error instanceof CredentialResolutionError)
			) {
				return yield* Effect.fail(outcome.error);
			}
			fallbackErrors.push(`${definition.label}: ${errorMessage(outcome.error)}`);
		}

		if (fallbackErrors.length > 0) {
			return yield* Effect.fail(new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`));
		}

		return yield* Effect.fail(
			new Error(
				"No search provider available. Either:\n" +
					"  1. Use /login to sign in with a Codex subscription for OpenAI web search\n" +
					`  2. Set openaiApiKey, braveApiKey, parallelApiKey, tinyfishApiKey, search1apiApiKey, searchinfinityApiKey, queritApiKey, tavilyApiKey, serpdiveApiKey, kagiApiKey, ollamaApiKey, searxngBaseUrl, perplexityApiKey, exaApiKey, geminiApiKey, or cloudflareApiKey in ${CONFIG_PATH}\n` +
					"  3. Set OPENAI_API_KEY, BRAVE_API_KEY, PARALLEL_API_KEY, TINYFISH_API_KEY, SEARCH1API_KEY, SEARCHINFINITY_API_KEY, QUERIT_API_KEY, TAVILY_API_KEY, SERPDIVE_API_KEY, KAGI_API_KEY, OLLAMA_API_KEY, SEARXNG_BASE_URL, EXA_API_KEY, PERPLEXITY_API_KEY, GEMINI_API_KEY, or CLOUDFLARE_API_KEY env vars\n" +
					"  4. Set GOOGLE_GEMINI_BASE_URL with CLOUDFLARE_API_KEY for Cloudflare AI Gateway routing\n" +
					"  5. Sign into gemini.google.com in a supported Chromium-based browser\n" +
					'  6. Explicitly select provider: "anysearch" for anonymous AnySearch, "xai" for Grok, "brightdata" with brightdataSerpZone for paid Bright Data SERP, or "serpbase" with serpbaseApiKey for paid Google SERP',
			),
		);
	});
}
