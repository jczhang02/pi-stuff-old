import type { JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeString } from "../../shared/runtime-type.ts";
export interface FetchContentParams {
	url?: JsonInputValue;
	urls?: JsonInputValue;
	mode?: JsonInputValue;
}

export interface NormalizedFetchContentParams {
	urlList: string[];
	options: {
		mode?: "readable" | "raw";
	};
}

export function normalizeFetchContentParams(params: FetchContentParams): NormalizedFetchContentParams {
	const normalizedUrls = uniqueUrls(normalizeUrlArray(params.urls));
	const urlList = normalizedUrls.length > 0 ? normalizedUrls : normalizeSingleUrl(params.url);
	const mode = normalizeMode(params.mode);
	const options: NormalizedFetchContentParams["options"] = {};
	if (mode !== undefined) options.mode = mode;

	return {
		urlList,
		options,
	};
}

function normalizeUrlArray(value: JsonInputValue): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap(normalizeSingleUrl);
}

function normalizeSingleUrl(value: JsonInputValue): string[] {
	if (!isRuntimeString(value)) return [];
	const trimmed = value.trim();
	return trimmed ? [trimmed] : [];
}

function normalizeMode(value: JsonInputValue): "readable" | "raw" | undefined {
	if (value === undefined) return undefined;
	if (value === "readable" || value === "raw") return value;
	throw new Error('mode must be "readable" or "raw"');
}

function uniqueUrls(urls: string[]): string[] {
	return [...new Set(urls)];
}
