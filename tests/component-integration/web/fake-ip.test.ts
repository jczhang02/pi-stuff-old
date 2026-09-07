import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { type DnsLookup, FakeIpCompatibility } from "../../../packages/pi-stuff/src/web/fake-ip.js";

interface ResolverHarness {
	readonly calls: string[];
	readonly lookup: DnsLookup;
}

function resolver(records: Record<string, readonly string[]>): ResolverHarness {
	const calls: string[] = [];
	return {
		calls,
		lookup: async (hostname) => {
			calls.push(hostname);
			const addresses = records[hostname];
			if (!addresses) throw new Error("fixture DNS miss");
			return addresses.map((address) => ({ address }));
		},
	};
}

describe("safe fake-IP compatibility", () => {
	test("enables the in-memory range only when target and canary both use fake IP", async () => {
		const dns = resolver({ "docs.example": ["198.18.4.8"], "example.com": ["198.19.2.3"] });
		const configured: string[][] = [];
		const compatibility = new FakeIpCompatibility(dns.lookup, ({ allowRanges }) => {
			configured.push([...allowRanges]);
		});

		await Effect.runPromise(compatibility.prepare({ url: "https://docs.example/page" }));
		await Effect.runPromise(compatibility.prepare({ url: "https://docs.example/again" }));

		expect(configured).toEqual([["198.18.0.0/15"]]);
		expect(dns.calls).toEqual(["docs.example", "example.com"]);
	});

	test("coalesces concurrent detection and configures exactly once", async () => {
		const { promise: lookupStarted, resolve: releaseLookup } = Promise.withResolvers<void>();
		const { promise: continueLookupPromise, resolve: continueLookup } = Promise.withResolvers<void>();
		const dns = resolver({ "docs.example": ["198.18.4.8"], "example.com": ["198.19.2.3"] });
		const configured: string[][] = [];
		const compatibility = new FakeIpCompatibility(
			async (hostname) => {
				releaseLookup();
				await continueLookupPromise;
				return dns.lookup(hostname);
			},
			({ allowRanges }) => configured.push([...allowRanges]),
		);

		const first = Effect.runPromise(compatibility.prepare({ url: "https://docs.example/one" }));
		await lookupStarted;
		const second = Effect.runPromise(compatibility.prepare({ url: "https://docs.example/two" }));
		continueLookup();
		await Promise.all([first, second]);

		expect(configured).toEqual([["198.18.0.0/15"]]);
		expect(dns.calls).toEqual(["docs.example", "example.com"]);
	});

	test("retries detection after the owning Effect operation is cancelled", async () => {
		const { promise: lookupStarted, resolve: markLookupStarted } = Promise.withResolvers<void>();
		const { promise: releaseLookup, resolve: release } = Promise.withResolvers<void>();
		let calls = 0;
		const compatibility = new FakeIpCompatibility(async () => {
			calls += 1;
			if (calls === 1) {
				markLookupStarted();
				await releaseLookup;
			}
			return [{ address: "93.184.216.34" }];
		});
		const controller = new AbortController();
		const first = Effect.runPromise(compatibility.prepare({ url: "https://docs.example/one" }), {
			signal: controller.signal,
		});
		await lookupStarted;
		controller.abort();
		await expect(first).rejects.toThrow();
		release();

		await Effect.runPromise(compatibility.prepare({ url: "https://docs.example/two" }));
		expect(calls).toBe(2);
	});

	test("keeps strict SSRF policy when either side is not entirely fake-IP", async () => {
		const targetPublic = resolver({ "docs.example": ["93.184.216.34"] });
		const publicConfigured: string[][] = [];
		await Effect.runPromise(
			new FakeIpCompatibility(targetPublic.lookup, ({ allowRanges }) =>
				publicConfigured.push([...allowRanges]),
			).prepare({ url: "https://docs.example" }),
		);
		expect(publicConfigured).toEqual([]);
		expect(targetPublic.calls).toEqual(["docs.example"]);

		const canaryPublic = resolver({ "docs.example": ["198.18.1.1"], "example.com": ["93.184.216.34"] });
		const canaryConfigured: string[][] = [];
		await Effect.runPromise(
			new FakeIpCompatibility(canaryPublic.lookup, ({ allowRanges }) =>
				canaryConfigured.push([...allowRanges]),
			).prepare({ url: "https://docs.example" }),
		);
		expect(canaryConfigured).toEqual([]);
		expect(canaryPublic.calls).toEqual(["docs.example", "example.com"]);
	});

	test("degrades to the fork's normal error path when DNS detection fails", async () => {
		const configured: string[][] = [];
		const compatibility = new FakeIpCompatibility(
			async () => {
				throw new Error("resolver unavailable");
			},
			({ allowRanges }) => configured.push([...allowRanges]),
		);
		await expect(
			Effect.runPromise(compatibility.prepare({ urls: ["https://docs.example", "https://other.example"] })),
		).resolves.toBe(undefined);
		expect(configured).toEqual([]);
	});
});
