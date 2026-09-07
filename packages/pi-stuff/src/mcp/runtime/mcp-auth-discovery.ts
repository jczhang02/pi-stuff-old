import { fetchRemoteUrl } from "../../shared/ssrf-protection.ts";
import { throwIfAborted } from "./abort.ts";
import type { AuthDiscovery } from "./mcp-auth-config.ts";
import { combineAbortSignals } from "./runtime-owner.ts";
import type { ServerEntry } from "./types.ts";
import { interpolateEnvRecord } from "./utils.ts";

type OAuthFetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

function createOAuthFetch(serverUrl: string): OAuthFetch {
	const serverHostname = new URL(serverUrl).hostname;
	return async (input, init) => {
		const url = new URL(input);
		if (url.hostname === serverHostname) return fetch(url, { ...init, redirect: "manual" });
		return fetchRemoteUrl(url, init, { maxRedirects: 0 });
	};
}

export function sdkAuthOptions(serverUrl: string, discovery: AuthDiscovery) {
	return { serverUrl, ...discovery, fetchFn: createOAuthFetch(serverUrl) };
}

export async function probeAuthDiscovery(
	serverUrl: string,
	definition?: ServerEntry,
	signal?: AbortSignal,
): Promise<AuthDiscovery> {
	const [{ extractWWWAuthenticateParams }, { LATEST_PROTOCOL_VERSION }] = await Promise.all([
		import("@modelcontextprotocol/sdk/client/auth.js"),
		import("@modelcontextprotocol/sdk/types.js"),
	]);
	// Discovery must not execute config commands or send their source text.
	const discoveryHeaders = definition?.headers
		? Object.fromEntries(
				Object.entries(definition.headers).filter(([, value]) => !value.startsWith("!") || value.startsWith("!!")),
			)
		: undefined;
	const headers = new Headers(interpolateEnvRecord(discoveryHeaders));
	headers.set("content-type", "application/json");

	const controller = new AbortController();
	const discoverySignal = combineAbortSignals(signal, controller.signal) ?? controller.signal;
	const timer = setTimeout(() => controller.abort(), 5000);

	try {
		headers.set("accept", "application/json, text/event-stream");

		const response = await fetch(new URL(serverUrl), {
			method: "POST",
			headers,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 0,
				method: "initialize",
				params: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "pi-mcp-adapter", version: "2.11.0" },
				},
			}),
			redirect: "manual",
			signal: discoverySignal,
		});
		const { resourceMetadataUrl, scope } = extractWWWAuthenticateParams(response);
		await response.body?.cancel().catch(() => {});
		const discovery: AuthDiscovery = {};
		if (resourceMetadataUrl) discovery.resourceMetadataUrl = resourceMetadataUrl;
		if (scope) discovery.scope = scope;
		return discovery;
	} catch {
		if (signal?.aborted) throwIfAborted(signal);
		return {};
	} finally {
		clearTimeout(timer);
	}
}
