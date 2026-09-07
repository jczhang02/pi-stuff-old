import { readFileSync } from "node:fs";
import { basename } from "node:path";
import * as Effect from "effect/Effect";
import type { JsonInputValue } from "../../shared/json-value.ts";
import { isJsonInputObject, parseJsonValue } from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { activityMonitor } from "./activity.ts";
import { type CookieMap, getGoogleCookies, getLastGoogleCookieDiagnostic } from "./chrome-cookies.ts";
import {
	getChromeProfileFromConfig,
	isBrowserCookieAccessAllowed,
	normalizeChromeProfile,
} from "./gemini-web-config.ts";
import type { SearchOptions, SearchResult } from "./perplexity.ts";
import { nativeRequest } from "./utils.ts";

const GEMINI_APP_URL = "https://gemini.google.com/app";
const GEMINI_STREAM_GENERATE_URL =
	"https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const GEMINI_UPLOAD_URL = "https://content-push.googleapis.com/upload";
const GEMINI_UPLOAD_PUSH_ID = "feeds/mcudyrk2a4khkz";
const GOOGLE_LIST_ACCOUNTS_URL =
	"https://accounts.google.com/ListAccounts?gpsia=1&source=ChromiumBrowser&laf=b64bin&json=standard";

const USER_AGENT =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MODEL_HEADER_NAME = "x-goog-ext-525001261-jspb";
export const DEFAULT_GEMINI_WEB_MODEL = "gemini-3.1-pro";
const MODEL_HEADERS = new Map([
	[DEFAULT_GEMINI_WEB_MODEL, '[1,null,null,null,"9d8ca3786ebdfbea",null,null,0,[4]]'],
	["gemini-2.5-pro", '[1,null,null,null,"4af6c7f5da75d65d",null,null,0,[4]]'],
	["gemini-2.5-flash", '[1,null,null,null,"9ec249fc9ad08861",null,null,0,[4]]'],
]);

const REQUIRED_COOKIES = ["__Secure-1PSID", "__Secure-1PSIDTS"];

export interface GeminiWebOptions {
	model?: string;
	files?: string[];
	signal?: AbortSignal | undefined;
	timeoutMs?: number;
}

export function isGeminiWebAvailable(chromeProfile?: string) {
	if (!isBrowserCookieAccessAllowed()) return Effect.succeed(null);
	return getGoogleCookies({
		profile: normalizeChromeProfile(chromeProfile) ?? getChromeProfileFromConfig(),
		requiredCookies: REQUIRED_COOKIES,
	}).pipe(Effect.map((result) => result?.cookies ?? null));
}

export function getGeminiWebAvailabilityDiagnostic(): string | null {
	return isBrowserCookieAccessAllowed() ? getLastGoogleCookieDiagnostic() : null;
}

export function searchWithGeminiWeb(query: string, options: SearchOptions = {}) {
	return isGeminiWebAvailable().pipe(
		Effect.flatMap((cookies) => {
			if (!cookies) return Effect.succeed(null);
			const activityId = activityMonitor.logStart({ type: "api", query });
			return queryWithCookies(buildSearchPrompt(query, options), cookies, {
				signal: options.signal,
				timeoutMs: 60_000,
			}).pipe(
				Effect.map((answer) => {
					activityMonitor.logComplete(activityId, 200);
					return { answer, results: extractSourceUrls(answer) };
				}),
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

function buildSearchPrompt(query: string, options: SearchOptions): string {
	let prompt = `Search the web and answer the following question. Include source URLs for your claims.\nFormat your response as:\n1. A direct answer to the question\n2. Cited sources as markdown links\n\nQuestion: ${query}`;
	if (options.recencyFilter) {
		const labels = { day: "past 24 hours", week: "past week", month: "past month", year: "past year" };
		prompt += `\n\nOnly include results from the ${labels[options.recencyFilter]}.`;
	}
	if (options.domainFilter?.length) {
		const included = options.domainFilter.filter((domain) => !domain.startsWith("-"));
		const excluded = options.domainFilter.filter((domain) => domain.startsWith("-")).map((domain) => domain.slice(1));
		if (included.length > 0) prompt += `\n\nOnly cite sources from: ${included.join(", ")}`;
		if (excluded.length > 0) prompt += `\n\nDo not cite sources from: ${excluded.join(", ")}`;
	}
	return prompt;
}

function extractSourceUrls(markdown: string): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	for (const match of markdown.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)) {
		const title = match[1];
		const url = match[2];
		if (!title || !url || seen.has(url)) continue;
		seen.add(url);
		results.push({ title, url, snippet: "" });
	}
	return results;
}

export function getActiveGoogleEmail(cookies: CookieMap) {
	const cookieHeader = buildCookieHeader(cookies);
	if (!cookieHeader) return Effect.succeed(null);
	return nativeRequest((signal) => fetchWithCookieRedirects(GEMINI_APP_URL, cookieHeader, 10, signal), 10_000).pipe(
		Effect.map(extractEmailFromGeminiHtml),
		Effect.catch(() => Effect.succeed(null)),
		Effect.flatMap((email) =>
			email
				? Effect.succeed(email)
				: nativeRequest(
						(signal) => fetchWithCookieRedirects(GOOGLE_LIST_ACCOUNTS_URL, cookieHeader, 10, signal),
						10_000,
					).pipe(
						Effect.map(extractEmailFromListAccounts),
						Effect.catch(() => Effect.succeed(null)),
					),
		),
	);
}

export function queryWithCookies(
	prompt: string,
	cookieMap: CookieMap,
	options: GeminiWebOptions = {},
): Effect.Effect<string, Error> {
	const model = options.model ?? DEFAULT_GEMINI_WEB_MODEL;
	if (!MODEL_HEADERS.has(model)) {
		return Effect.fail(
			new Error(
				`Gemini Web does not support model ${model}; configure Gemini API or choose a supported Gemini Web model.`,
			),
		);
	}
	return nativeRequest(
		(signal) => runGeminiWebOnce(prompt, cookieMap, model, options.files, signal),
		options.timeoutMs ?? 120_000,
		options.signal,
	).pipe(
		Effect.flatMap((result) => {
			if (result.errorMessage) return Effect.fail(new Error(result.errorMessage));
			return result.text
				? Effect.succeed(result.text)
				: Effect.fail(new Error("Gemini Web returned empty response"));
		}),
	);
}

interface GeminiWebResult {
	text: string;
	errorCode?: number | undefined;
	errorMessage?: string;
}

async function runGeminiWebOnce(
	prompt: string,
	cookieMap: CookieMap,
	model: string,
	files: string[] | undefined,
	signal: AbortSignal,
): Promise<GeminiWebResult> {
	const modelHeader = MODEL_HEADERS.get(model);
	if (!modelHeader) throw new Error(`Gemini Web does not support model ${model}`);
	const cookieHeader = buildCookieHeader(cookieMap);
	const accessToken = await fetchAccessToken(cookieHeader, signal);

	const uploaded: Array<{ id: string; name: string }> = [];
	if (files) {
		for (const filePath of files) {
			uploaded.push(await uploadFile(filePath, cookieHeader, signal));
		}
	}

	const fReq = buildFReqPayload(prompt, uploaded);
	const params = new URLSearchParams();
	params.set("at", accessToken);
	params.set("f.req", fReq);

	const res = await fetch(GEMINI_STREAM_GENERATE_URL, {
		method: "POST",
		redirect: "error",
		headers: {
			"content-type": "application/x-www-form-urlencoded;charset=utf-8",
			host: "gemini.google.com",
			origin: "https://gemini.google.com",
			referer: "https://gemini.google.com/",
			"x-same-domain": "1",
			"user-agent": USER_AGENT,
			cookie: cookieHeader,
			[MODEL_HEADER_NAME]: modelHeader,
		},
		body: params.toString(),
		signal,
	});

	const rawText = await res.text();

	if (!res.ok) {
		return { text: "", errorMessage: `Gemini request failed: ${res.status}` };
	}

	try {
		return parseStreamGenerateResponse(rawText);
	} catch (err) {
		let errorCode: number | undefined;
		try {
			const json = parseJsonValue(trimJsonEnvelope(rawText));
			errorCode = extractErrorCode(json);
		} catch {}
		return {
			text: "",
			errorCode,
			errorMessage: err instanceof Error ? err.message : String(err),
		};
	}
}

async function fetchAccessToken(cookieHeader: string, signal: AbortSignal): Promise<string> {
	const html = await fetchWithCookieRedirects(GEMINI_APP_URL, cookieHeader, 10, signal);

	for (const key of ["SNlM0e", "thykhd"]) {
		const match = html.match(new RegExp(`"${key}":"(.*?)"`));
		if (match?.[1]) return match[1];
	}

	throw new Error(
		"Unable to authenticate with Gemini. Make sure you're signed into gemini.google.com in a supported Chromium-based browser.",
	);
}

async function fetchWithCookieRedirects(
	url: string,
	cookieHeader: string,
	maxRedirects: number,
	signal: AbortSignal,
): Promise<string> {
	let current = url;
	const allowedOrigin = new URL(url).origin;
	for (let i = 0; i <= maxRedirects; i++) {
		const res = await fetch(current, {
			headers: { "user-agent": USER_AGENT, cookie: cookieHeader },
			redirect: "manual",
			signal,
		});
		if (res.status >= 300 && res.status < 400) {
			const location = res.headers.get("location");
			if (location) {
				const next = new URL(location, current);
				if (next.origin !== allowedOrigin) {
					throw new Error(`Refusing to send Google cookies across origins: ${allowedOrigin} -> ${next.origin}`);
				}
				current = next.toString();
				continue;
			}
		}
		return await res.text();
	}
	throw new Error(`Too many redirects (>${maxRedirects})`);
}

function extractEmailFromGeminiHtml(html: string): string | null {
	const patterns = [
		// Gemini bootstraps the active account in oPEP7c. Prefer it over generic
		// feature/config entries that may contain other signed-in Google accounts.
		/"oPEP7c"\s*:\s*"([^"]+)"/,
		// The Google account menu aria-label is rendered for the active account.
		/aria-label="Google Account:[^"]*?\(([^)]+)\)"/,
		/"displayEmail"\s*:\s*"([^"]+)"/,
		/"defaultEmail"\s*:\s*"([^"]+)"/,
		/"email"\s*:\s*"([^"]+)"/,
		/"identifier"\s*:\s*"([^"]+)"/,
		/"gaiaIdentifier"\s*:\s*"([^"]+)"/,
	];

	for (const pattern of patterns) {
		const match = html.match(pattern);
		const email = normalizeEmail(match?.[1]);
		if (email) return email;
	}

	return findFirstEmail(html);
}

function extractEmailFromListAccounts(text: string): string | null {
	const trimmed = text.replace(/^\)\]\}'\s*/, "");
	try {
		return findEmailInValue(parseJsonValue(trimmed)) ?? findFirstEmail(trimmed);
	} catch {
		return findFirstEmail(trimmed);
	}
}

function findEmailInValue(value: JsonInputValue): string | null {
	if (isRuntimeString(value)) return normalizeEmail(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			const email = findEmailInValue(item);
			if (email) return email;
		}
		return null;
	}
	if (isJsonInputObject(value)) {
		for (const item of Object.values(value)) {
			const email = findEmailInValue(item);
			if (email) return email;
		}
	}
	return null;
}

function findFirstEmail(text: string): string | null {
	const normalized = decodeEmailEscapes(text);
	const match = normalized.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i);
	return match?.[0] ?? null;
}

function normalizeEmail(value: string | undefined): string | null {
	if (!value) return null;
	const normalized = decodeEmailEscapes(value.trim());
	return /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(normalized) ? normalized : null;
}

function decodeEmailEscapes(value: string): string {
	return value
		.replace(/\\u0040/gi, "@")
		.replace(/\\x40/gi, "@")
		.replace(/&#64;/gi, "@")
		.replace(/&commat;/gi, "@")
		.replace(/\\"/g, '"')
		.replace(/\\\\/g, "\\");
}

async function uploadFile(
	filePath: string,
	cookieHeader: string,
	signal: AbortSignal,
): Promise<{ id: string; name: string }> {
	const data = readFileSync(filePath);
	const fileName = basename(filePath);
	const boundary = `----FormBoundary${Math.random().toString(36).slice(2)}`;
	const header = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
	const footer = `\r\n--${boundary}--\r\n`;

	const body = Buffer.concat([Buffer.from(header, "utf-8"), data, Buffer.from(footer, "utf-8")]);

	const res = await fetch(GEMINI_UPLOAD_URL, {
		method: "POST",
		redirect: "error",
		headers: {
			"content-type": `multipart/form-data; boundary=${boundary}`,
			"push-id": GEMINI_UPLOAD_PUSH_ID,
			"user-agent": USER_AGENT,
			cookie: cookieHeader,
		},
		body,
		signal,
	});

	if (!res.ok) {
		const text = await res.text();
		throw new Error(`File upload failed: ${res.status} (${text.slice(0, 200)})`);
	}

	return { id: await res.text(), name: fileName };
}

function buildFReqPayload(prompt: string, uploaded: Array<{ id: string; name: string }>): string {
	const promptPayload = uploaded.length > 0 ? [prompt, 0, null, uploaded.map((file) => [[file.id, 1]])] : [prompt];
	const innerList = [promptPayload, null, null];
	return JSON.stringify([null, JSON.stringify(innerList)]);
}

function buildCookieHeader(cookieMap: CookieMap): string {
	return Object.entries(cookieMap)
		.filter(([, value]) => isRuntimeString(value) && value.length > 0)
		.map(([name, value]) => `${name}=${value}`)
		.join("; ");
}

function getNestedValue(value: JsonInputValue, pathParts: number[]): JsonInputValue {
	let current: JsonInputValue = value;
	for (const part of pathParts) {
		if (current == null) return undefined;
		if (!Array.isArray(current)) return undefined;
		current = current[part];
	}
	return current;
}

function trimJsonEnvelope(text: string): string {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("Gemini response did not contain a JSON payload.");
	}
	return text.slice(start, end + 1);
}

function extractErrorCode(responseJson: JsonInputValue): number | undefined {
	const code = getNestedValue(responseJson, [0, 5, 2, 0, 1, 0]);
	return isRuntimeNumber(code) && code >= 0 ? code : undefined;
}

function extractCandidateText(candidate: JsonInputValue): string {
	const textRaw = getNestedValue(candidate, [1, 0]);
	let text = isRuntimeString(textRaw) ? textRaw : "";

	if (/^http:\/\/googleusercontent\.com\/card_content\/\d+/.test(text)) {
		const alt = getNestedValue(candidate, [22, 0]);
		if (isRuntimeString(alt) && alt.length > 0) text = alt;
	}

	return text;
}

function parseStreamGenerateResponse(rawText: string): GeminiWebResult {
	const responseJson = parseJsonValue(trimJsonEnvelope(rawText));
	const errorCode = extractErrorCode(responseJson);

	const parts = Array.isArray(responseJson) ? responseJson : [];
	let firstCandidateSeen: JsonInputValue;
	let latestNonEmptyText = "";

	for (let i = 0; i < parts.length; i++) {
		const partBody = getNestedValue(parts[i], [2]);
		if (!partBody || !isRuntimeString(partBody)) continue;
		try {
			const parsed = parseJsonValue(partBody);
			const candidateList = getNestedValue(parsed, [4]);
			if (!Array.isArray(candidateList) || candidateList.length === 0) continue;

			const firstCandidate = candidateList[0];
			if (firstCandidateSeen === undefined) firstCandidateSeen = firstCandidate;

			const text = extractCandidateText(firstCandidate);
			if (text.length > 0) latestNonEmptyText = text;
		} catch {}
	}

	const text = latestNonEmptyText.length > 0 ? latestNonEmptyText : extractCandidateText(firstCandidateSeen);

	return { text, errorCode };
}
