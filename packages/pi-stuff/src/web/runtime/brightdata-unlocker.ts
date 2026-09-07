import * as Effect from "effect/Effect";
import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { activityMonitor } from "./activity.ts";
import { readWebConfig } from "./config.ts";
import { hasCredentialSource, redactCredential, requireCredential } from "./credential-source.ts";
import type { ExtractedContent, ExtractOptions } from "./extract.ts";
import { fetchRemoteUrl, type Lookup, validateRemoteUrl } from "./ssrf-protection.ts";
import { errorMessage, getWebSearchConfigPath, isAbortError, nativePromise, nativeRequest } from "./utils.ts";

const CONFIG_PATH = `${getWebSearchConfigPath()} under "web"`;
const BRIGHTDATA_REQUEST_URL = "https://api.brightdata.com/request";
const EXTRACT_TIMEOUT_MS = 60_000;
const ZONE_PATTERN = /^[a-z0-9_-]+$/i;

export interface BrightDataSsrfOptions {
	allowRanges: string[];
	trustEnvProxy: boolean;
}

export interface BrightDataExtractOptions extends Pick<ExtractOptions, "timeoutMs" | "lookup"> {
	ssrf?: BrightDataSsrfOptions;
}

function loadConfig() {
	return readWebConfig() ?? {};
}

function normalizeZone(value: JsonInputValue): string | null {
	if (!isRuntimeString(value)) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return ZONE_PATTERN.test(trimmed) ? trimmed : null;
}

interface ZoneSetting {
	raw: string;
	label: string;
}

function zoneSetting(): ZoneSetting | null {
	const fromEnv = process.env["BRIGHTDATA_UNLOCKER_ZONE"];
	if (isRuntimeString(fromEnv) && fromEnv.trim()) return { raw: fromEnv.trim(), label: "BRIGHTDATA_UNLOCKER_ZONE" };
	const configured = loadConfig()["brightdataUnlockerZone"];
	if (isRuntimeString(configured) && configured.trim())
		return { raw: configured.trim(), label: `brightdataUnlockerZone in ${CONFIG_PATH}` };
	return null;
}

function getZone(): string | null {
	const setting = zoneSetting();
	return setting ? normalizeZone(setting.raw) : null;
}

// A zone is never defaulted. Zones are per-account names bound to a product
// type, they are billed separately, and a guess is either an HTTP 400 or a
// charge against the wrong product. The SERP zone from the search provider is
// a different zone type and cannot serve Web Unlocker requests.
function requireZone(): string {
	const setting = zoneSetting();
	const zone = setting ? normalizeZone(setting.raw) : null;
	if (zone) return zone;
	if (setting) {
		throw new Error(
			`Invalid Bright Data Unlocker zone: ${setting.label} must be a zone name of letters, digits, "-", or "_". ` +
				'The zone must be of type "unblocker"; a SERP zone will not serve Web Unlocker requests.',
		);
	}
	throw new Error(
		"Bright Data Web Unlocker zone not configured. Either:\n" +
			`  1. Set brightdataUnlockerZone in ${CONFIG_PATH}\n` +
			"  2. Set BRIGHTDATA_UNLOCKER_ZONE environment variable\n" +
			'The zone must be of type "unblocker"; a SERP zone will not serve Web Unlocker requests.',
	);
}

async function getApiKey(signal?: AbortSignal): Promise<string> {
	return requireCredential(
		{
			provider: "Bright Data",
			configuredValue: loadConfig()["brightdataApiKey"],
			environmentValue: process.env["BRIGHTDATA_API_KEY"],
			signal,
		},
		"Bright Data API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "brightdataApiKey": "your-key" }\n` +
			"  2. Set BRIGHTDATA_API_KEY environment variable\n" +
			"Get a key at https://brightdata.com/cp/setting/users",
	);
}

interface BrightDataValidationOptions {
	lookup?: Lookup;
	allowRanges: string[];
	trustEnvProxy: boolean;
}

function ssrfOptions(options?: BrightDataExtractOptions): BrightDataValidationOptions {
	const validation: BrightDataValidationOptions = {
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

async function fetchBrightDataApi(
	url: string,
	init: { method: string; headers: Headers; body: string; signal: AbortSignal },
	options: BrightDataExtractOptions | undefined,
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

function unlockerBody(url: string, zone: string): JsonInputObject {
	return {
		url,
		zone,
		format: "raw",
		data_format: "markdown",
	};
}

async function brightDataRequestNative(
	url: string,
	zone: string,
	apiKey: string,
	signal: AbortSignal,
	options: BrightDataExtractOptions | undefined,
): Promise<string> {
	const headers = new Headers({
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
	});
	const activityId = activityMonitor.logStart({ type: "fetch", url });
	try {
		const response = await fetchBrightDataApi(
			BRIGHTDATA_REQUEST_URL,
			{
				method: "POST",
				headers,
				body: JSON.stringify(unlockerBody(url, zone)),
				signal,
			},
			options,
		);
		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			throw new Error(
				`Bright Data Web Unlocker error ${response.status}: ${redactCredential(errorText, apiKey).slice(0, 300)}`,
			);
		}
		const text = await response.text();
		activityMonitor.logComplete(activityId, response.status);
		return text;
	} catch (err) {
		const message = errorMessage(err);
		const redactedMessage = redactCredential(message, apiKey);
		if (isAbortError(err)) activityMonitor.logComplete(activityId, 0);
		else activityMonitor.logError(activityId, redactedMessage);
		if (redactedMessage === message) throw err;
		const redactedError = new Error(redactedMessage);
		if (err instanceof Error) redactedError.name = err.name;
		throw redactedError;
	}
}

function brightDataRequest(
	url: string,
	zone: string,
	apiKey: string,
	signal: AbortSignal | undefined,
	options: BrightDataExtractOptions | undefined,
) {
	return nativeRequest(
		(requestSignal) => brightDataRequestNative(url, zone, apiKey, requestSignal, options),
		options?.timeoutMs ?? EXTRACT_TIMEOUT_MS,
		signal,
	);
}

function headingTitle(text: string): string {
	const match = text.match(/^#{1,2}\s+(.+)/m);
	if (!match) return "";
	return (match[1] ?? "").replace(/\*+/g, "").trim();
}

export function isBrightDataUnlockerAvailable(): boolean {
	if (getZone() === null) return false;
	return hasCredentialSource({
		provider: "Bright Data",
		configuredValue: loadConfig()["brightdataApiKey"],
		environmentValue: process.env["BRIGHTDATA_API_KEY"],
	});
}

export function extractWithBrightDataUnlocker(url: string, signal?: AbortSignal, options?: BrightDataExtractOptions) {
	return Effect.gen(function* () {
		const zone = yield* Effect.try({
			try: requireZone,
			catch: (error) => (error instanceof Error ? error : new Error(String(error))),
		});
		yield* nativePromise(() => validateRemoteUrl(url, ssrfOptions(options)));
		const apiKey = yield* nativePromise(getApiKey, signal);
		const raw = yield* brightDataRequest(url, zone, apiKey, signal, options);
		// Bright Data bills a successful request whatever its length, so short
		// content is returned rather than discarded: a paywall stub or consent page
		// is a useful answer, and silently dropping it would hide the spend.
		const content = raw.trim();
		if (!content) return null;
		return { url, title: headingTitle(content), content, error: null } satisfies ExtractedContent;
	});
}
