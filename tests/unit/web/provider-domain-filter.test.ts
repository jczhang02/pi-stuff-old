import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	hostMatchesProviderDomain,
	normalizeProviderDomain,
	partitionProviderDomains,
} from "../../../packages/pi-stuff/src/web/provider-domain-filter.ts";
import { formatSearchSources } from "../../../packages/pi-stuff/src/web/runtime/utils.ts";

const PROVIDER_CONSUMERS = [
	"brave.ts",
	"brightdata.ts",
	"openai-search.ts",
	"parallel.ts",
	"querit.ts",
	"search1api.ts",
	"searchinfinity.ts",
	"searxng.ts",
	"serpbase.ts",
	"serpdive.ts",
	"tavily.ts",
	"tinyfish.ts",
	"xai-search.ts",
];

describe("provider domain filters", () => {
	test("normalizes the URL, path, exclusion, and case forms accepted by search providers", () => {
		expect(normalizeProviderDomain(" HTTPS://Docs.Example.COM/path ")).toBe("docs.example.com");
		expect(normalizeProviderDomain("- api.example.org:443/v1")).toBe("api.example.org");
		expect(normalizeProviderDomain("..example.net..")).toBe("example.net");
	});

	test("rejects empty, single-label, and literal-IP filters", () => {
		expect(normalizeProviderDomain(" - ")).toBeNull();
		expect(normalizeProviderDomain("localhost")).toBeNull();
		expect(normalizeProviderDomain("127.0.0.1")).toBeNull();
	});

	test("matches only an exact host or its subdomains", () => {
		expect(hostMatchesProviderDomain("example.com", "example.com")).toBe(true);
		expect(hostMatchesProviderDomain("docs.example.com", "example.com")).toBe(true);
		expect(hostMatchesProviderDomain("notexample.com", "example.com")).toBe(false);
	});

	test("partitions unique domains and formats provider source lists", () => {
		expect(partitionProviderDomains(["docs.example.com", "-api.example.com", "docs.example.com"])).toEqual({
			exclude: ["api.example.com"],
			include: ["docs.example.com"],
		});
		expect(formatSearchSources([{ title: "Docs", url: "https://docs.example.com", snippet: "Reference" }])).toBe(
			"Reference\nSource: Docs (https://docs.example.com)",
		);
	});

	test("keeps one maintained domain-filter implementation across the absorbed providers", async () => {
		const runtime = join(import.meta.dir, "../../../packages/pi-stuff/src/web/runtime");
		const files = (await readdir(runtime)).filter((file) => file.endsWith(".ts"));
		const sources = await Promise.all(
			files.map(async (file) => [file, await readFile(join(runtime, file), "utf8")] as const),
		);

		expect(
			sources
				.filter(
					([, source]) =>
						source.includes("domainFilter") &&
						/function (?:domainMatches|hostMatchesDomain|normalizeDomain)\(/u.test(source),
				)
				.map(([file]) => file),
		).toEqual([]);
		expect(
			sources
				.filter(([, source]) => source.includes('../provider-domain-filter.ts"'))
				.map(([file]) => file)
				.sort(),
		).toEqual([...PROVIDER_CONSUMERS].sort());
	});
});
