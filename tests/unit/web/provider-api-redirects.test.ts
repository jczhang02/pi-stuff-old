import { expect, test } from "bun:test";
import { auditProviderRedirectPolicy } from "../../../scripts/repository-safety/provider-redirect-policy.ts";

test("direct Provider API declaration checks ignore comments and formatting", () => {
	const path = "packages/pi-stuff/src/web/runtime/tavily.ts";
	expect(auditProviderRedirectPolicy(path, "fetch (url, {redirect: 'error'}); // fetch( without options")).toEqual([]);
	expect(auditProviderRedirectPolicy(path, 'fetch(url); // redirect: "error"')).toHaveLength(1);
	expect(auditProviderRedirectPolicy(path, 'fetch(url, {redirect: "follow"})')).toHaveLength(1);
	expect(auditProviderRedirectPolicy(path, "fetch(url, opts)")).toHaveLength(1);
	expect(auditProviderRedirectPolicy(path, 'const request = {redirect: "error"}; fetch(url, request);')).toEqual([]);
	expect(auditProviderRedirectPolicy("other.ts", "fetch(url)")).toEqual([]);
});
