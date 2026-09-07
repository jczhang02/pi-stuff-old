import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { extractContent, fetchAllContent } from "../../../packages/pi-stuff/src/web/runtime/extract.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

test("bounds Jina reader responses without following redirects", async () => {
	const originalFetch = globalThis.fetch;
	let cancelled = false;
	let jinaRedirect: string | undefined;
	let jinaRequests = 0;
	let pulls = 0;
	const prefix = "Markdown Content:\n# Title\n";
	const firstChunk = new TextEncoder().encode(`${prefix}${"a".repeat(5 * 1024 * 1024 - prefix.length)}`);
	// SAFETY: This test double implements only fetch's request/response contract; preconnect is never used.
	const mockFetch = (async (input, init) => {
		if (!String(input).startsWith("https://r.jina.ai/")) return new Response(null, { status: 503 });
		jinaRedirect = init?.redirect;
		jinaRequests += 1;
		return new Response(
			new ReadableStream<Uint8Array>(
				{
					cancel() {
						cancelled = true;
					},
					pull(controller) {
						pulls += 1;
						if (pulls === 1) controller.enqueue(firstChunk);
						else if (pulls === 2) controller.enqueue(new Uint8Array([1]));
						else controller.close();
					},
				},
				{ highWaterMark: 0 },
			),
			{ headers: { "content-type": "text/markdown" } },
		);
	}) as typeof fetch;
	globalThis.fetch = mockFetch;

	try {
		const result = await Effect.runPromise(extractContent("https://example.com/article", { lookup: publicLookup }));
		expect(jinaRequests).toBe(1);
		expect(jinaRedirect).toBe("error");
		expect(cancelled).toBe(true);
		expect(result.error).toContain("HTTP 503");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("times out a raw HTTP read through Effect cancellation", async () => {
	const originalFetch = globalThis.fetch;
	let aborted = false;
	// SAFETY: This test double implements only fetch's request/response contract; preconnect is never used.
	globalThis.fetch = ((_, init) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener(
				"abort",
				() => {
					aborted = true;
					reject(init.signal?.reason);
				},
				{ once: true },
			);
		})) as typeof fetch;

	try {
		const result = await Effect.runPromise(
			extractContent("https://example.com/slow.txt", { lookup: publicLookup, mode: "raw", timeoutMs: 5 }),
		);
		expect(aborted).toBe(true);
		expect(result.error?.toLowerCase()).toContain("abort");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("fetches at most three URLs concurrently and preserves input order", async () => {
	const originalFetch = globalThis.fetch;
	let active = 0;
	let maximum = 0;
	// SAFETY: This test double implements only fetch's request/response contract; preconnect is never used.
	globalThis.fetch = (async (_input, init) => {
		const host = new Headers(init?.headers).get("Host") ?? "unknown";
		active += 1;
		maximum = Math.max(maximum, active);
		await Bun.sleep(host.startsWith("one") ? 20 : 5);
		active -= 1;
		return new Response(host, { headers: { "content-type": "text/plain" } });
	}) as typeof fetch;
	const urls = ["one", "two", "three", "four", "five"].map((name) => `https://${name}.example/file.txt`);

	try {
		const results = await Effect.runPromise(fetchAllContent(urls, { lookup: publicLookup, mode: "raw" }));
		expect(maximum).toBe(3);
		expect(results.map((result) => result.url)).toEqual(urls);
		expect(results.every((result) => result.error === null)).toBe(true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
