import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { withWebConfigSnapshot } from "../../../packages/pi-stuff/src/web/runtime/config.ts";
import { extractWithFirecrawl } from "../../../packages/pi-stuff/src/web/runtime/firecrawl.ts";
import { search } from "../../../packages/pi-stuff/src/web/runtime/gemini-search.ts";
import { queryWithCookies } from "../../../packages/pi-stuff/src/web/runtime/gemini-web.ts";
import { searchWithSearch1API } from "../../../packages/pi-stuff/src/web/runtime/search1api.ts";
import { searchWithTavily } from "../../../packages/pi-stuff/src/web/runtime/tavily.ts";
import { searchWithTinyFish } from "../../../packages/pi-stuff/src/web/runtime/tinyfish.ts";

const originalFetch = globalThis.fetch;
const originalAgentDirectory = process.env["PI_CODING_AGENT_DIR"];
const originalCredentials = {
	firecrawlApiKey: process.env["FIRECRAWL_API_KEY"],
	firecrawlBaseUrl: process.env["FIRECRAWL_BASE_URL"],
	search1api: process.env["SEARCH1API_KEY"],
	serpdive: process.env["SERPDIVE_API_KEY"],
	tavily: process.env["TAVILY_API_KEY"],
};
const roots: string[] = [];

function installFetchMock(mock: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
	// SAFETY: Provider tests exercise only fetch's request/response call signature; preconnect is never used.
	globalThis.fetch = mock as typeof fetch;
}

async function expectTavilyAbort<Result>(start: (signal: AbortSignal) => Promise<Result>): Promise<void> {
	process.env["TAVILY_API_KEY"] = "tavily-secret";
	let requestSignal: AbortSignal | undefined;
	let started!: () => void;
	const requestStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	installFetchMock((_input, init) => {
		requestSignal = init?.signal ?? undefined;
		started();
		return new Promise<Response>((_resolve, reject) => {
			requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
		});
	});

	const controller = new AbortController();
	const operation = start(controller.signal);
	await requestStarted;
	controller.abort();
	await expect(operation).rejects.toThrow();
	expect(requestSignal?.aborted).toBe(true);
}

function restoreEnvironment(name: keyof typeof originalCredentials, variable: string): void {
	const value = originalCredentials[name];
	if (value === undefined) delete process.env[variable];
	else process.env[variable] = value;
}

afterEach(async () => {
	globalThis.fetch = originalFetch;
	if (originalAgentDirectory === undefined) delete process.env["PI_CODING_AGENT_DIR"];
	else process.env["PI_CODING_AGENT_DIR"] = originalAgentDirectory;
	restoreEnvironment("firecrawlApiKey", "FIRECRAWL_API_KEY");
	restoreEnvironment("firecrawlBaseUrl", "FIRECRAWL_BASE_URL");
	restoreEnvironment("search1api", "SEARCH1API_KEY");
	restoreEnvironment("serpdive", "SERPDIVE_API_KEY");
	restoreEnvironment("tavily", "TAVILY_API_KEY");
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

test("Search1API preserves request shaping and result projection through Effect", async () => {
	process.env["SEARCH1API_KEY"] = "search1-secret";
	let request: RequestInit | undefined;
	installFetchMock(async (_input, init) => {
		request = init;
		return new Response(
			JSON.stringify({
				results: [
					{ content: "full text", link: "https://example.com/a", snippet: "  useful   result ", title: "A" },
				],
			}),
		);
	});

	const result = await Effect.runPromise(
		searchWithSearch1API("effect search", {
			domainFilter: ["example.com", "-blocked.example"],
			includeContent: true,
			numResults: 2,
			recencyFilter: "week",
		}),
	);

	expect(new Headers(request?.headers).get("authorization")).toBe("Bearer search1-secret");
	expect(request?.redirect).toBe("error");
	expect(request?.signal).toBeInstanceOf(AbortSignal);
	expect(JSON.parse(String(request?.body))).toEqual({
		query: "effect search",
		max_results: 2,
		crawl_results: 2,
		include_sites: ["example.com"],
		exclude_sites: ["blocked.example"],
		time_range: "week",
	});
	expect(result.results).toEqual([{ title: "A", url: "https://example.com/a", snippet: "useful result" }]);
	expect(result.inlineContent?.[0]?.content).toBe("full text");
});

test("selected standard providers retain partial-success aggregation", async () => {
	const agentDirectory = await mkdtemp(join(tmpdir(), "pi-stuff-web-provider-"));
	roots.push(agentDirectory);
	process.env["PI_CODING_AGENT_DIR"] = agentDirectory;
	process.env["TAVILY_API_KEY"] = "tavily-secret";
	process.env["SERPDIVE_API_KEY"] = "serpdive-secret";
	installFetchMock(async (input) => {
		const url = String(input);
		if (url.includes("tavily")) {
			return Response.json({
				answer: "Tavily answer",
				results: [{ title: "Tavily", url: "https://example.com/tavily", content: "source" }],
			});
		}
		return new Response("temporarily unavailable", { status: 503 });
	});

	const result = await Effect.runPromise(search("effect", { provider: ["tavily", "serpdive"] }));

	expect(result.provider).toBe("all");
	expect(result.providerResponses?.map((response) => response.provider)).toEqual(["tavily"]);
	expect(result.providerErrors?.[0]?.provider).toBe("serpdive");
	expect(result.results[0]?.url).toBe("https://example.com/tavily");
});

test("interrupting a provider Effect aborts its native request", async () => {
	await expectTavilyAbort((signal) => Effect.runPromise(searchWithTavily("cancel me"), { signal }));
});

test("a provider's caller signal still aborts its native request", async () => {
	await expectTavilyAbort((signal) => Effect.runPromise(searchWithTavily("cancel me", { signal })));
});

test("Firecrawl keeps SSRF validation and extraction projection inside the Effect path", async () => {
	process.env["FIRECRAWL_BASE_URL"] = "https://firecrawl.example";
	process.env["FIRECRAWL_API_KEY"] = "firecrawl-secret";
	let request: RequestInit | undefined;
	installFetchMock(async (_input, init) => {
		request = init;
		return Response.json({ success: true, data: { markdown: "# Extracted\n\nBody", metadata: { title: "Page" } } });
	});

	const result = await Effect.runPromise(
		extractWithFirecrawl("https://target.example/page", undefined, {
			lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			ssrf: { allowRanges: [], trustEnvProxy: false },
		}),
	);

	expect(new Headers(request?.headers).get("authorization")).toBe("Bearer firecrawl-secret");
	expect(request?.signal).toBeInstanceOf(AbortSignal);
	expect(result).toEqual({
		url: "https://target.example/page",
		title: "Page",
		content: "# Extracted\n\nBody",
		error: null,
	});
});

test("configured model-provider routing falls back on network failure", async () => {
	installFetchMock(async (input) => {
		if (String(input).includes("openai.com")) throw new TypeError("fetch failed");
		return Response.json({
			results: [{ title: "Fallback", url: "https://example.com/fallback", content: "Ollama result" }],
		});
	});
	const settings = {
		openaiApiKey: "$$openai-secret",
		ollamaApiKey: "$$ollama-secret",
		searchRouting: { providers: ["openai", "ollama"], fallbackOn: ["network"] },
	};
	const result = await withWebConfigSnapshot(settings, () => Effect.runPromise(search("fallback")));

	expect(result.provider).toBe("ollama");
	expect(result.results[0]?.url).toBe("https://example.com/fallback");
});

test("TinyFish keeps bounded paging and sequential inline batches", async () => {
	const calls: string[] = [];
	installFetchMock(async (input, init) => {
		const url = String(input);
		calls.push(url);
		if (url.includes("api.search.tinyfish.ai")) {
			const page = Number(new URL(url).searchParams.get("page") ?? "0");
			const count = page === 0 ? 10 : 2;
			return Response.json({
				results: Array.from({ length: count }, (_, index) => {
					const id = page * 10 + index;
					return { title: `Result ${String(id)}`, url: `https://example.com/${String(id)}`, snippet: "source" };
				}),
			});
		}
		// SAFETY: the production TinyFish request builder serializes this captured body as { urls: string[] }.
		const body = JSON.parse(String(init?.body)) as { urls: string[] };
		return Response.json({
			results: body.urls.map((url) => ({ url, title: url, text: `Content for ${url}` })),
			errors: [],
		});
	});
	const result = await withWebConfigSnapshot({ tinyfishApiKey: "$$tinyfish-secret" }, () =>
		Effect.runPromise(searchWithTinyFish("bounded", { includeContent: true, numResults: 12 })),
	);

	expect(result.results).toHaveLength(12);
	expect(result.inlineContent).toHaveLength(12);
	expect(calls.filter((url) => url.includes("api.search.tinyfish.ai"))).toHaveLength(2);
	expect(calls.filter((url) => url.includes("api.fetch.tinyfish.ai"))).toHaveLength(2);
});

test("Gemini Web preserves same-origin cookie redirects and uploads", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-gemini-upload-"));
	roots.push(root);
	const uploadPath = join(root, "note.txt");
	await writeFile(uploadPath, "upload body");
	const requests: Array<{ headers: Headers; url: string }> = [];
	let appRequests = 0;
	installFetchMock(async (input, init) => {
		const url = String(input);
		requests.push({ headers: new Headers(init?.headers), url });
		if (url.startsWith("https://gemini.google.com/app")) {
			appRequests += 1;
			return appRequests === 1
				? new Response("", { status: 302, headers: { location: "/app?redirected=1" } })
				: new Response('"SNlM0e":"access-token"');
		}
		if (url.includes("content-push.googleapis.com")) return new Response("uploaded-file-id");
		return new Response(
			JSON.stringify([[null, null, JSON.stringify([null, null, null, null, [[null, ["Gemini answer"]]]])]]),
		);
	});
	const answer = await Effect.runPromise(
		queryWithCookies("question", { "__Secure-1PSID": "cookie-value" }, { files: [uploadPath] }),
	);

	expect(answer).toBe("Gemini answer");
	expect(appRequests).toBe(2);
	expect(requests.map(({ url }) => url)).toHaveLength(4);
	for (const request of requests) expect(request.headers.get("cookie")).toContain("__Secure-1PSID=cookie-value");
});

test("interrupting Gemini Web aborts the active cookie request", async () => {
	let requestSignal: AbortSignal | undefined;
	let started!: () => void;
	const requestStarted = new Promise<void>((resolve) => {
		started = resolve;
	});
	installFetchMock((_input, init) => {
		requestSignal = init?.signal ?? undefined;
		started();
		return new Promise<Response>((_resolve, reject) => {
			requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true });
		});
	});
	const controller = new AbortController();
	const operation = Effect.runPromise(queryWithCookies("cancel", { "__Secure-1PSID": "cookie-value" }), {
		signal: controller.signal,
	});
	await requestStarted;
	controller.abort();

	await expect(operation).rejects.toThrow();
	expect(requestSignal?.aborted).toBe(true);
});
