import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolArguments } from "../tool-display/activity.ts";
import { activityKey } from "../tool-display/index.ts";

interface WebResultDetails {
	readonly error?: unknown;
	readonly matchCount?: unknown;
	readonly queryCount?: unknown;
	readonly resultCount?: unknown;
	readonly returnedChars?: unknown;
	readonly returnedMatches?: unknown;
	readonly successful?: unknown;
	readonly successfulQueries?: unknown;
	readonly totalResults?: unknown;
	readonly urlCount?: unknown;
}

function resultDetails<Value>(value: Value): WebResultDetails {
	if (!isRuntimeObject(value) || value === null || Array.isArray(value)) return {};
	// SAFETY: presentation code reads only the declared fields and validates each before display.
	return value as Value & WebResultDetails;
}

function finiteNumber<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) ? value : undefined;
}

function stringValue<Value>(value: Value): string {
	return isRuntimeString(value) ? value : "";
}

function errorResult<Details>(_args: ToolArguments, result: AgentToolResult<Details>): boolean {
	return isRuntimeString(resultDetails(result.details).error);
}

function searchResultIsError<Details>(_args: ToolArguments, result: AgentToolResult<Details>): boolean {
	const details = resultDetails(result.details);
	if (isRuntimeString(details.error)) return true;
	const successful = finiteNumber(details.successfulQueries);
	const total = finiteNumber(details.queryCount);
	return total !== undefined && total > 0 && successful === 0;
}

function fetchResultIsError<Details>(_args: ToolArguments, result: AgentToolResult<Details>): boolean {
	const details = resultDetails(result.details);
	if (isRuntimeString(details.error)) return true;
	const successful = finiteNumber(details.successful);
	const total = finiteNumber(details.urlCount);
	return total !== undefined && total > 0 && successful === 0;
}

function firstQuery(args: ToolArguments): string {
	const query = stringValue(args["query"]).trim();
	if (query) return query;
	const queries = Array.isArray(args["queries"])
		? args["queries"].filter((value): value is string => isRuntimeString(value))
		: [];
	if (queries.length === 1) return queries[0] ?? "";
	return queries.length > 1 ? `${String(queries.length)} queries` : "";
}

function hostname<Value>(raw: Value): string {
	if (!isRuntimeString(raw)) return "";
	try {
		return new URL(raw).hostname;
	} catch {
		return raw;
	}
}

function fetchTarget(args: ToolArguments): string {
	if (isRuntimeString(args["url"])) return hostname(args["url"]);
	const urls = Array.isArray(args["urls"]) ? args["urls"] : [];
	const first = hostname(urls[0]);
	return urls.length > 1 ? `${first} +${String(urls.length - 1)}` : first;
}

function retrievalTarget(args: ToolArguments): string {
	const responseId = stringValue(args["responseId"]).slice(0, 8);
	const query = stringValue(args["query"]);
	const url = stringValue(args["url"]);
	const index = finiteNumber(args["queryIndex"]) ?? finiteNumber(args["urlIndex"]);
	const selector = query || hostname(url) || (index === undefined ? "" : `#${String(index)}`);
	return [responseId, selector].filter(Boolean).join(" ");
}

function searchSummary<Details>(args: ToolArguments, result: AgentToolResult<Details>): string {
	const details = resultDetails(result.details);
	if (searchResultIsError(args, result)) return "failed";
	const successful = finiteNumber(details.successfulQueries);
	const total = finiteNumber(details.queryCount);
	const sources = finiteNumber(details.totalResults);
	if (successful !== undefined && total !== undefined) {
		return `${String(successful)}/${String(total)} queries · ${String(sources ?? 0)} sources`;
	}
	return sources === undefined ? "done" : `${String(sources)} sources`;
}

function fetchSummary<Details>(args: ToolArguments, result: AgentToolResult<Details>): string {
	const details = resultDetails(result.details);
	if (fetchResultIsError(args, result)) return "failed";
	const successful = finiteNumber(details.successful);
	const total = finiteNumber(details.urlCount);
	if (successful !== undefined && total !== undefined) return `${String(successful)}/${String(total)} read`;
	return "done";
}

function retrievalSummary<Details>(_args: ToolArguments, result: AgentToolResult<Details>): string {
	const details = resultDetails(result.details);
	if (isRuntimeString(details.error)) return "failed";
	const matches = finiteNumber(details.returnedMatches) ?? finiteNumber(details.matchCount);
	if (matches !== undefined) return `${String(matches)} matches`;
	const returned = finiteNumber(details.returnedChars);
	if (returned !== undefined) return `${String(returned)} chars`;
	const count = finiteNumber(details.resultCount);
	return count === undefined ? "done" : `${String(count)} sources`;
}

export const WEB_SEARCH_PRESENTATION = {
	activity: {
		categories: ["search-web"] as const,
		classify: ({ args }: { readonly args: ToolArguments }) => {
			const queries = isRuntimeString(args["query"])
				? [args["query"]]
				: Array.isArray(args["queries"])
					? args["queries"].filter((value): value is string => isRuntimeString(value))
					: [];
			return [
				{
					category: "search-web" as const,
					countKeys: queries.map((query) => activityKey(query)),
					target: firstQuery(args),
				},
			];
		},
	} as const,
	label: "Web search",
	resultIsError: searchResultIsError,
	runningSummary: "searching",
	summarize: searchSummary,
	target: firstQuery,
};

export const WEB_FETCH_PRESENTATION = {
	activity: {
		categories: ["fetch-page"] as const,
		classify: ({ args }: { readonly args: ToolArguments }) => {
			const urls = isRuntimeString(args["url"])
				? [args["url"]]
				: Array.isArray(args["urls"])
					? args["urls"].filter((value): value is string => isRuntimeString(value))
					: [];
			return [
				{
					category: "fetch-page" as const,
					countKeys: urls.map((url) => activityKey(url)),
					target: fetchTarget(args),
				},
			];
		},
	} as const,
	label: "Web fetch",
	resultIsError: fetchResultIsError,
	runningSummary: "reading",
	summarize: fetchSummary,
	target: fetchTarget,
};

export const WEB_CONTENT_PRESENTATION = {
	activity: {
		categories: ["retrieve-passage"] as const,
		classify: ({ args }: { readonly args: ToolArguments }) => [
			{
				category: "retrieve-passage" as const,
				countKeys: [
					activityKey(
						args["responseId"],
						args["query"],
						args["queryIndex"],
						args["url"],
						args["urlIndex"],
						args["offset"],
					),
				],
				target: retrievalTarget(args),
			},
		],
	} as const,
	label: "Web content",
	resultIsError: errorResult,
	runningSummary: "retrieving",
	summarize: retrievalSummary,
	target: retrievalTarget,
};
