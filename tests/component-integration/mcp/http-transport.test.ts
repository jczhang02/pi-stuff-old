import { expect, test } from "bun:test";
import { resetTestAuthSecretStore, updateTokens } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-auth.js";
import { runMcpEffect } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-effect-runner.js";
import { createHttpTransport } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-http-transport.js";
import { isJsonInputObject } from "../../../packages/pi-stuff/src/shared/json-value.js";

test("retries an implicit OAuth challenge with the native HTTP transport", async () => {
	const authStoreEnv = "PI_MCP_ADAPTER_TEST_AUTH_STORE";
	const previousAuthStore = process.env[authStoreEnv];
	const authorizations: Array<string | null> = [];
	process.env[authStoreEnv] = "memory";
	resetTestAuthSecretStore();
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const authorization = request.headers.get("authorization");
			authorizations.push(authorization);
			if (authorization !== "Bearer stored-token") {
				return Response.json(
					{ error: { code: -32_000, message: "authentication required" }, id: 1, jsonrpc: "2.0" },
					{ headers: { "www-authenticate": "Bearer" }, status: 401 },
				);
			}
			if (request.method === "GET") return new Response(null, { status: 405 });
			const message = await request.json();
			if (isJsonInputObject(message) && message["method"] === "initialize") {
				return Response.json({
					id: message["id"] ?? 1,
					jsonrpc: "2.0",
					result: {
						capabilities: {},
						protocolVersion: "2025-06-18",
						serverInfo: { name: "oauth-fixture", version: "1.0.0" },
					},
				});
			}
			return new Response(null, { status: 202 });
		},
	});
	const serverUrl = server.url.toString();
	updateTokens("implicit-oauth", { accessToken: "stored-token" }, serverUrl);

	try {
		const transport = await runMcpEffect(
			createHttpTransport({
				authStorageOptions: {},
				definition: { url: serverUrl },
				oauthSignal: undefined,
				requestOptions: undefined,
				serverName: "implicit-oauth",
				traceObserver: undefined,
			}),
		);
		expect(transport.constructor.name).toBe("StreamableHTTPClientTransport");
		expect(authorizations[0]).toBeNull();
		expect(authorizations).toContain("Bearer stored-token");
		await transport.close();
	} finally {
		await server.stop(true);
		resetTestAuthSecretStore();
		if (previousAuthStore === undefined) delete process.env[authStoreEnv];
		else process.env[authStoreEnv] = previousAuthStore;
	}
});
