import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	getAuthEntryFilePath,
	getAuthForUrl,
	getTestAuthSecretStoreEntries,
	resetTestAuthSecretStore,
	saveAuthEntry,
	updateClientInfo,
	updateTokens,
} from "../../../packages/pi-stuff/src/mcp/runtime/mcp-auth.js";
import {
	extractOAuthConfig,
	parseAuthorizationRedirectInput,
	parseOAuthRedirectUri,
	supportsOAuth,
} from "../../../packages/pi-stuff/src/mcp/runtime/mcp-auth-config.js";
import {
	createOAuthRuntime,
	shutdownOAuth,
	startAuth,
} from "../../../packages/pi-stuff/src/mcp/runtime/mcp-auth-flow.js";
import {
	getAuthSecretStore,
	isRevokedKeyringError,
} from "../../../packages/pi-stuff/src/mcp/runtime/mcp-auth-keyring.js";
import {
	ensureCallbackServer,
	stopCallbackServer,
} from "../../../packages/pi-stuff/src/mcp/runtime/mcp-callback-server.js";
import { getOAuthCallbackPort } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-oauth-provider.js";

interface CyclicCause {
	cause?: CyclicCause;
}

test("validates OAuth configuration and authorization redirects at the trust boundary", () => {
	expect(
		extractOAuthConfig({
			url: "https://mcp.example/api",
			oauth: {
				clientId: "client",
				clientSecret: "!read-secret",
				authorizationParams: { audience: "https://mcp.example" },
				redirectUri: "http://127.0.0.1:3210/callback",
			},
		}),
	).toEqual({
		clientId: "client",
		clientSecret: "!read-secret",
		authorizationParams: { audience: "https://mcp.example" },
		redirectUri: "http://127.0.0.1:3210/callback",
	});
	expect(extractOAuthConfig({ url: "https://mcp.example", oauth: false })).toEqual({});
	for (const oauth of [
		{ clientId: 1 },
		{ clientSecret: 1 },
		{ scope: 1 },
		{ authorizationParams: [] },
		{ authorizationParams: { audience: 1 } },
		{ redirectUri: " " },
		{ clientName: " " },
		{ clientUri: " " },
	]) {
		// SAFETY: Deliberately bypass static config typing to exercise runtime validation of external input.
		expect(() => extractOAuthConfig({ url: "https://mcp.example", oauth: oauth as never })).toThrow();
	}
	expect(parseOAuthRedirectUri("http://127.0.0.1:3210/callback")).toEqual({
		port: 3210,
		callbackHost: "127.0.0.1",
		callbackPath: "/callback",
	});
	expect(parseOAuthRedirectUri("http://[::1]:3210/callback").callbackHost).toBe("::1");
	for (const redirectUri of [
		"https://localhost:3210/callback",
		"http://example.com:3210/callback",
		"http://localhost/callback",
		"http://user:pass@localhost:3210/callback",
		"http://localhost:3210/callback#fragment",
		"http://localhost:0/callback",
	]) {
		expect(() => parseOAuthRedirectUri(redirectUri)).toThrow();
	}
	expect(
		parseAuthorizationRedirectInput(
			"http://localhost:3210/callback?code=abc&state=expected&iss=https%3A%2F%2Fissuer.example",
			"expected",
		),
	).toEqual({ code: "abc", iss: "https://issuer.example" });
	expect(parseAuthorizationRedirectInput("abc", "expected")).toEqual({ code: "abc" });
	expect(() => parseAuthorizationRedirectInput("?code=abc", "expected")).toThrow("state missing");
	expect(() => parseAuthorizationRedirectInput("?code=abc&state=wrong", "expected")).toThrow("state mismatch");
	expect(() => parseAuthorizationRedirectInput("?error=access_denied&error_description=Nope")).toThrow(
		"access_denied: Nope",
	);
	expect(supportsOAuth({ url: "https://mcp.example" })).toBe(true);
	expect(supportsOAuth({ url: "https://mcp.example", headers: { Authorization: "Bearer token" } })).toBe(false);
	expect(supportsOAuth({ url: "https://mcp.example", auth: "oauth", headers: { Authorization: "token" } })).toBe(true);
});

test("OAuth callback requests ignore a malformed Host header", async () => {
	await ensureCallbackServer({ callbackHost: "127.0.0.1", callbackPath: "/callback" });
	try {
		const status = await new Promise<number | undefined>((resolve, reject) => {
			const callbackRequest = request(
				{
					headers: { host: "[" },
					host: "127.0.0.1",
					path: "/not-callback",
					port: getOAuthCallbackPort(),
				},
				(response) => {
					response.resume();
					response.on("end", () => resolve(response.statusCode));
				},
			);
			callbackRequest.on("error", reject);
			callbackRequest.end();
		});
		expect(status).toBe(404);
	} finally {
		await stopCallbackServer();
	}
});

test("OAuth discovery never follows redirects with configured headers", async () => {
	const authStoreEnv = "PI_MCP_ADAPTER_TEST_AUTH_STORE";
	const previousAuthStore = process.env[authStoreEnv];
	const originalFetch = globalThis.fetch;
	const controller = new AbortController();
	const runtime = createOAuthRuntime();
	let requestInit: RequestInit | undefined;
	process.env[authStoreEnv] = "memory";
	resetTestAuthSecretStore();
	globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			requestInit = init;
			controller.abort(new Error("OAuth discovery captured"));
			return new Response(null, { headers: { location: "https://redirect.example" }, status: 302 });
		},
		{ preconnect: originalFetch.preconnect },
	);
	try {
		await expect(
			startAuth(
				"redirecting",
				"https://mcp.example",
				{
					headers: { "X-API-Key": "configured-secret" },
					oauth: {
						clientId: "client",
						clientSecret: "secret",
						grantType: "client_credentials",
					},
					url: "https://mcp.example",
				},
				{ runtime, signal: controller.signal },
			),
		).rejects.toThrow("OAuth discovery captured");
		expect(requestInit?.redirect).toBe("manual");
	} finally {
		globalThis.fetch = originalFetch;
		await shutdownOAuth(runtime);
		resetTestAuthSecretStore();
		if (previousAuthStore === undefined) delete process.env[authStoreEnv];
		else process.env[authStoreEnv] = previousAuthStore;
	}
});

test("OAuth SDK discovery never requests private URLs advertised by a remote server", async () => {
	const authStoreEnv = "PI_MCP_ADAPTER_TEST_AUTH_STORE";
	const previousAuthStore = process.env[authStoreEnv];
	const originalFetch = globalThis.fetch;
	const runtime = createOAuthRuntime();
	const requests: string[] = [];
	process.env[authStoreEnv] = "memory";
	resetTestAuthSecretStore();
	globalThis.fetch = Object.assign(
		async (input: string | URL | Request) => {
			requests.push(String(input));
			if (requests.length === 1) {
				return new Response(null, {
					headers: { "www-authenticate": 'Bearer resource_metadata="http://127.0.0.1/private"' },
					status: 401,
				});
			}
			throw new Error("OAuth discovery stopped");
		},
		{ preconnect: originalFetch.preconnect },
	);
	try {
		await expect(
			startAuth(
				"private-discovery",
				"https://mcp.example",
				{
					oauth: { clientId: "client", clientSecret: "secret", grantType: "client_credentials" },
					url: "https://mcp.example",
				},
				{ runtime },
			),
		).rejects.toThrow("OAuth discovery stopped");
		expect(requests).not.toContain("http://127.0.0.1/private");
	} finally {
		globalThis.fetch = originalFetch;
		await shutdownOAuth(runtime);
		resetTestAuthSecretStore();
		if (previousAuthStore === undefined) delete process.env[authStoreEnv];
		else process.env[authStoreEnv] = previousAuthStore;
	}
});

test("binds secure OAuth credentials to their server URL and detects chunk tampering", () => {
	const authStoreEnv = "PI_MCP_ADAPTER_TEST_AUTH_STORE";
	const previousAuthStore = process.env[authStoreEnv];
	process.env[authStoreEnv] = "memory";
	resetTestAuthSecretStore();
	try {
		updateClientInfo("server", { clientId: "old-client" }, "https://old.example");
		updateTokens("server", { accessToken: "token" }, "https://new.example");
		expect(getAuthForUrl("server", "https://old.example")).toBeUndefined();
		expect(getAuthForUrl("server", "https://new.example")).toEqual({
			tokens: { accessToken: "token" },
			serverUrl: "https://new.example",
		});

		const chunkServerUrl = "https://chunked.example";
		updateTokens("chunked", { accessToken: "x".repeat(4_000) }, chunkServerUrl);
		const storedEntries = getTestAuthSecretStoreEntries();
		const chunk = storedEntries.find(([account]) => account.includes(".chunk."));
		if (!chunk) throw new Error("Expected chunked test credentials");
		getAuthSecretStore().write(chunk[0], chunk[1].replace("x", "y"));
		expect(() => getAuthForUrl("chunked", chunkServerUrl)).toThrow("integrity check failed");
		const manifest = storedEntries.find(([, payload]) => payload.includes("__piMcpAdapterOAuthChunked"));
		if (!manifest) throw new Error("Expected a chunk manifest");
		const invalidManifest =
			'{"__piMcpAdapterOAuthChunked":1,"chunkCount":999999999,"chunkDigest":"0123456789abcdef"}';
		getAuthSecretStore().write(manifest[0], invalidManifest);
		expect(() => getAuthForUrl("chunked", chunkServerUrl)).toThrow("Invalid OAuth credential chunk manifest");
		expect(() => saveAuthEntry("chunked", { tokens: { accessToken: "replacement" } }, chunkServerUrl)).toThrow(
			"Invalid OAuth credential chunk manifest",
		);
		expect(getAuthSecretStore().read(manifest[0])).toBe(invalidManifest);
		expect(() =>
			updateTokens("oversized", { accessToken: "x".repeat(1024 * 1024) }, "https://oversized.example"),
		).toThrow("1 MiB secure-store limit");
	} finally {
		resetTestAuthSecretStore();
		if (previousAuthStore === undefined) delete process.env[authStoreEnv];
		else process.env[authStoreEnv] = previousAuthStore;
	}
});

test("keeps legacy plaintext OAuth credentials read-only until an explicit auth write", async () => {
	const authStoreEnv = "PI_MCP_ADAPTER_TEST_AUTH_STORE";
	const previousAuthStore = process.env[authStoreEnv];
	const baseDir = await mkdtemp(join(tmpdir(), "pi-stuff-mcp-auth-"));
	const options = { baseDir };
	const serverUrl = "https://legacy.example";
	const legacyPath = getAuthEntryFilePath("legacy", options);
	process.env[authStoreEnv] = "memory";
	resetTestAuthSecretStore();
	try {
		await mkdir(dirname(legacyPath), { recursive: true });
		await Bun.write(legacyPath, JSON.stringify({ serverUrl, tokens: { accessToken: "legacy-token" } }));

		expect(getAuthForUrl("legacy", serverUrl, options)?.tokens?.accessToken).toBe("legacy-token");
		expect(await Bun.file(legacyPath).exists()).toBe(true);
		expect(getTestAuthSecretStoreEntries()).toEqual([]);

		updateTokens("legacy", { accessToken: "secure-token" }, serverUrl, options);
		expect(await Bun.file(legacyPath).exists()).toBe(false);

		await mkdir(dirname(legacyPath), { recursive: true });
		await Bun.write(legacyPath, JSON.stringify({ serverUrl, tokens: { accessToken: "stale-token" } }));
		expect(getAuthForUrl("legacy", serverUrl, options)?.tokens?.accessToken).toBe("secure-token");
		expect(await Bun.file(legacyPath).exists()).toBe(true);
	} finally {
		resetTestAuthSecretStore();
		if (previousAuthStore === undefined) delete process.env[authStoreEnv];
		else process.env[authStoreEnv] = previousAuthStore;
		await rm(baseDir, { force: true, recursive: true });
	}
});

test("recognizes native revoked-key errors without invoking hostile properties", () => {
	expect(isRevokedKeyringError(new Error("outer", { cause: new Error("KeyRevoked") }))).toBe(true);
	const cyclic: CyclicCause = {};
	cyclic.cause = cyclic;
	expect(isRevokedKeyringError(cyclic)).toBe(false);
	const accessor = Object.defineProperties(
		{},
		{
			message: {
				get: () => {
					throw new Error("must not run");
				},
			},
			cause: { value: new Error("key has been revoked") },
		},
	);
	expect(isRevokedKeyringError(accessor)).toBe(true);
	const hostile = new Proxy(
		{},
		{
			getOwnPropertyDescriptor: () => {
				throw new Error("hostile descriptor");
			},
		},
	);
	expect(isRevokedKeyringError(hostile)).toBe(false);
});
