import { isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import type { McpOAuthConfig } from "./mcp-oauth-provider.ts";
import type { ServerEntry } from "./types.ts";
import { interpolateEnvVars } from "./utils.ts";

export type AuthDiscovery = {
	resourceMetadataUrl?: URL;
	scope?: string;
};

export function applyConfiguredScope(discovery: AuthDiscovery, config: McpOAuthConfig): AuthDiscovery {
	return config.scope !== undefined ? { ...discovery, scope: config.scope } : discovery;
}

/** Extract OAuth configuration from a server definition. */
export function extractOAuthConfig(definition: ServerEntry): McpOAuthConfig {
	if (definition.oauth === false) return {};

	const config: McpOAuthConfig = {};
	if (definition.oauth?.grantType !== undefined) config.grantType = definition.oauth.grantType;
	if (definition.oauth?.clientId !== undefined) {
		if (!isRuntimeString(definition.oauth.clientId)) throw new Error("OAuth clientId must be a string");
		config.clientId = interpolateEnvVars(definition.oauth.clientId);
	}
	if (definition.oauth?.clientSecret !== undefined) {
		if (!isRuntimeString(definition.oauth.clientSecret)) throw new Error("OAuth clientSecret must be a string");
		// Preserve command expressions for the provider; interpolation remains eager for ordinary values.
		config.clientSecret = definition.oauth.clientSecret.startsWith("!")
			? definition.oauth.clientSecret
			: interpolateEnvVars(definition.oauth.clientSecret);
	}
	if (definition.oauth?.scope !== undefined) {
		if (!isRuntimeString(definition.oauth.scope)) throw new Error("OAuth scope must be a string");
		config.scope = interpolateEnvVars(definition.oauth.scope);
	}
	if (definition.oauth?.authorizationParams !== undefined) {
		const params = definition.oauth.authorizationParams;
		if (!params || !isRuntimeObject(params) || Array.isArray(params)) {
			throw new Error("OAuth authorizationParams must be an object");
		}
		config.authorizationParams = {};
		for (const [key, value] of Object.entries(params)) {
			if (!key) throw new Error("OAuth authorizationParams keys must not be empty");
			if (!isRuntimeString(value)) throw new Error(`OAuth authorizationParams.${key} must be a string`);
			config.authorizationParams[key] = interpolateEnvVars(value);
		}
	}
	if (definition.oauth?.redirectUri !== undefined) {
		if (!isRuntimeString(definition.oauth.redirectUri)) throw new Error("OAuth redirectUri must be a string");
		const redirectUri = interpolateEnvVars(definition.oauth.redirectUri).trim();
		if (!redirectUri) throw new Error("OAuth redirectUri must not be empty");
		config.redirectUri = redirectUri;
	}
	if (definition.oauth?.clientName !== undefined) {
		if (!isRuntimeString(definition.oauth.clientName)) throw new Error("OAuth clientName must be a string");
		const clientName = interpolateEnvVars(definition.oauth.clientName).trim();
		if (!clientName) throw new Error("OAuth clientName must not be empty");
		config.clientName = clientName;
	}
	if (definition.oauth?.clientUri !== undefined) {
		if (!isRuntimeString(definition.oauth.clientUri)) throw new Error("OAuth clientUri must be a string");
		const clientUri = interpolateEnvVars(definition.oauth.clientUri).trim();
		if (!clientUri) throw new Error("OAuth clientUri must not be empty");
		config.clientUri = clientUri;
	}
	return config;
}

export type OAuthRedirect = {
	port: number;
	callbackHost: string;
	callbackPath: string;
};

export function parseOAuthRedirectUri(redirectUri: string): OAuthRedirect {
	let url: URL;
	try {
		url = new URL(redirectUri);
	} catch (error) {
		throw new Error(`Invalid OAuth redirectUri: ${redirectUri}`, { cause: error });
	}

	const hostname = url.hostname.toLowerCase();
	const isLocalhost =
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
	if (url.protocol !== "http:" || !isLocalhost) {
		throw new Error("OAuth redirectUri must be an http:// localhost or loopback URI");
	}
	if (url.username || url.password) throw new Error("OAuth redirectUri must not include username or password");
	if (url.hash) throw new Error("OAuth redirectUri must not include a fragment");
	if (!url.port) throw new Error("OAuth redirectUri must include an explicit numeric port");

	const port = Number.parseInt(url.port, 10);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		throw new Error("OAuth redirectUri must include an explicit numeric port");
	}

	return {
		port,
		callbackHost: hostname === "[::1]" ? "::1" : hostname,
		callbackPath: url.pathname,
	};
}

function getSearchParamsFromInput(input: string): URLSearchParams | undefined {
	try {
		const url = new URL(input);
		const params = new URLSearchParams(url.search);
		if (url.hash) {
			const hashParams = new URLSearchParams(url.hash.slice(1));
			for (const [key, value] of hashParams) {
				if (!params.has(key)) params.set(key, value);
			}
		}
		return params;
	} catch {
		const query = input.includes("?") ? input.slice(input.indexOf("?") + 1) : input;
		const params = new URLSearchParams(query.startsWith("#") ? query.slice(1) : query);
		return params.has("code") || params.has("state") || params.has("error") ? params : undefined;
	}
}

/** Authorization code plus the optional RFC 9207 `iss` callback parameter. */
export interface AuthorizationCodeInput {
	code: string;
	iss?: string;
}

/** Extract an OAuth authorization result from a raw code, query string, or redirect URL. */
export function parseAuthorizationRedirectInput(input: string, expectedState?: string): AuthorizationCodeInput {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Authorization code or redirect URL is required");

	const params = getSearchParamsFromInput(trimmed);
	if (params) {
		const error = params.get("error");
		if (error) {
			const description = params.get("error_description");
			throw new Error(description ? `${error}: ${description}` : error);
		}

		const state = params.get("state");
		if (expectedState && !state) throw new Error("OAuth state missing from redirect URL");
		if (expectedState && state !== expectedState) throw new Error("OAuth state mismatch - potential CSRF attack");

		const code = params.get("code");
		if (code) {
			const iss = params.get("iss");
			const result: AuthorizationCodeInput = { code };
			if (iss !== null) result.iss = iss;
			return result;
		}
	}

	if (/^[A-Za-z0-9._~+/=-]+$/.test(trimmed)) return { code: trimmed };
	throw new Error("Could not find an OAuth authorization code in the provided input");
}

/** Extract only the authorization code from a raw code, query string, or redirect URL. */
export function parseAuthorizationCodeInput(input: string, expectedState?: string): string {
	return parseAuthorizationRedirectInput(input, expectedState).code;
}

/** OAuth is supported for HTTP servers unless their configuration disables it. */
export function supportsOAuth(definition: ServerEntry): boolean {
	if (!definition.url || definition.auth === false || definition.oauth === false) return false;
	if (definition.auth === "oauth") return true;
	if (definition.headers && Object.keys(definition.headers).length > 0) return false;
	return definition.auth === undefined;
}
