import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { installWebCapability } from "./adapter.ts";

export { createWebAdapterApi, installWebCapability } from "./adapter.ts";
export { type DnsAddress, type DnsLookup, FakeIpCompatibility } from "./fake-ip.ts";
export { validateWebFetchInput, type WebFetchInput, type WebFetchValidation } from "./url-policy.ts";

export default async function piStuffWeb(pi: ExtensionAPI): Promise<void> {
	await installWebCapability(pi);
}
