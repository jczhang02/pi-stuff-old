import { describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	WEB_CONTENT_PRESENTATION,
	WEB_FETCH_PRESENTATION,
	WEB_SEARCH_PRESENTATION,
} from "../../../packages/pi-stuff/src/web/presentation.js";

interface WebFixtureDetails {
	readonly queryCount?: number;
	readonly resultCount?: number;
	readonly successful?: number;
	readonly successfulQueries?: number;
	readonly totalResults?: number;
	readonly urlCount?: number;
}

function result(details: WebFixtureDetails): AgentToolResult<WebFixtureDetails> {
	return { content: [{ type: "text", text: "fixture" }], details };
}

describe("Web Tool presentation", () => {
	test("marks an all-query search failure as failed without requiring a top-level error", () => {
		const failed = result({ queryCount: 2, successfulQueries: 0, totalResults: 0 });
		expect(WEB_SEARCH_PRESENTATION.resultIsError?.({}, failed)).toBe(true);
		expect(WEB_SEARCH_PRESENTATION.summarize?.({}, failed)).toBe("failed");

		const partial = result({ queryCount: 2, successfulQueries: 1, totalResults: 3 });
		expect(WEB_SEARCH_PRESENTATION.resultIsError?.({}, partial)).toBe(false);
		expect(WEB_SEARCH_PRESENTATION.summarize?.({}, partial)).toBe("1/2 queries · 3 sources");
	});

	test("marks an all-URL fetch failure while preserving empty continuation results", () => {
		const failed = result({ successful: 0, urlCount: 2 });
		expect(WEB_FETCH_PRESENTATION.resultIsError?.({}, failed)).toBe(true);
		expect(WEB_FETCH_PRESENTATION.summarize?.({}, failed)).toBe("failed");

		const empty = result({ resultCount: 0 });
		expect(WEB_CONTENT_PRESENTATION.resultIsError?.({}, empty)).toBe(false);
		expect(WEB_CONTENT_PRESENTATION.summarize?.({}, empty)).toBe("0 sources");
	});
});
