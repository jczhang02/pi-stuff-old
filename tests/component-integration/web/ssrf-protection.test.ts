import { describe, expect, test } from "bun:test";
import { fetchRemoteUrl } from "../../../packages/pi-stuff/src/web/runtime/ssrf-protection.ts";

describe("Web SSRF protection", () => {
	test("connects to the validated DNS address while preserving the HTTP and TLS host", async () => {
		const calls: Array<{
			input: string | URL | Request;
			init: BunFetchRequestInit | undefined;
		}> = [];
		const fetchImpl = (input: string | URL | Request, init?: BunFetchRequestInit) => {
			calls.push({ input, init });
			return Promise.resolve(new Response("ok"));
		};

		await fetchRemoteUrl(
			"https://example.com:8443/report?format=full",
			{},
			{
				fetch: fetchImpl,
				lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			},
		);

		expect(calls).toHaveLength(1);
		expect(String(calls[0]?.input)).toBe("https://93.184.216.34:8443/report?format=full");
		expect(new Headers(calls[0]?.init?.headers).get("host")).toBe("example.com:8443");
		expect(calls[0]?.init?.keepalive).toBe(false);
		expect(calls[0]?.init?.tls?.serverName).toBe("example.com");
	});

	test("does not echo URL secrets after the redirect limit", async () => {
		const request = fetchRemoteUrl(
			"https://example.com/start?token=secret-value#private",
			{},
			{
				fetch: async () => new Response(null, { headers: { location: "/next?token=other-secret" }, status: 302 }),
				lookup: async () => [{ address: "93.184.216.34", family: 4 }],
				maxRedirects: 0,
			},
		);

		await expect(request).rejects.toThrow(/^Too many redirects while fetching remote URL$/u);
	});

	test("cancels redirect bodies before following the validated location", async () => {
		let cancelled = false;
		let requests = 0;
		const response = await fetchRemoteUrl(
			"https://example.com/start",
			{},
			{
				fetch: async () => {
					requests += 1;
					return requests === 1
						? new Response(
								new ReadableStream({
									cancel: () => {
										cancelled = true;
									},
								}),
								{ headers: { location: "/done" }, status: 302 },
							)
						: new Response("done");
				},
				lookup: async () => [{ address: "93.184.216.34", family: 4 }],
			},
		);

		expect(cancelled).toBe(true);
		expect(await response.text()).toBe("done");
	});
});
