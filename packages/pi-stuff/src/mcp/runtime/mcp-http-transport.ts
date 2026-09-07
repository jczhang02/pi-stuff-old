import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import {
	StreamableHTTPClientTransport,
	type StreamableHTTPClientTransportOptions,
	StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { isRuntimeFunction } from "../../shared/runtime-type.ts";
import { logger } from "./logger.ts";
import type { AuthStorageOptions } from "./mcp-auth.ts";
import { extractOAuthConfig, supportsOAuth } from "./mcp-auth-flow.ts";
import { McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { type McpTraceObserver, wrapTransportWithMcpTrace } from "./mcp-trace.ts";
import type { ServerDefinition, Transport } from "./types.ts";
import { resolveBearerToken, resolveCommandSecret, resolveCommandSecretsRecord, resolveServerUrl } from "./utils.ts";

type HttpAuthProviderState =
	| { status: "disabled" }
	| { status: "implicit-deferred" }
	| { status: "explicit"; provider: McpOAuthProvider }
	| { status: "implicit-challenged"; provider: McpOAuthProvider };

interface HttpTransportInput {
	authStorageOptions: AuthStorageOptions;
	definition: ServerDefinition;
	oauthSignal: AbortSignal | undefined;
	requestOptions: RequestOptions | undefined;
	serverName: string;
	traceObserver: McpTraceObserver | undefined;
}

export function isUnauthorizedHttpError<ErrorValue>(error: ErrorValue): boolean {
	return error instanceof UnauthorizedError || (error instanceof StreamableHTTPError && error.code === 401);
}

function normalizeStreamableTransport(transport: StreamableHTTPClientTransport): Transport {
	// SAFETY: SDK 1.30 implements Transport but models its undefined sessionId differently.
	return transport as Transport;
}

function withEffectSignal(requestOptions: RequestOptions | undefined, signal: AbortSignal): RequestOptions {
	const requestSignal = requestOptions?.signal;
	return {
		...requestOptions,
		signal: requestSignal ? AbortSignal.any([requestSignal, signal]) : signal,
	};
}

function closeFailedConnection(
	client: Pick<Client, "close">,
	transport: Transport,
	cause: Cause.Cause<unknown>,
	nativeSignal: AbortSignal | undefined,
	failureCleanupMessage: string,
): Effect.Effect<void, AggregateError> {
	const interrupted = Cause.hasInterrupts(cause);
	const originalError = interrupted ? (nativeSignal?.reason ?? Cause.squash(cause)) : Cause.squash(cause);
	return Effect.tryPromise({
		try: () => (interrupted ? transport.close() : client.close()),
		catch: (cleanupError) =>
			new AggregateError(
				[originalError, cleanupError],
				interrupted ? "MCP connection abort cleanup failed" : failureCleanupMessage,
			),
	});
}

/** Connect one native SDK client and close its owner exactly once if connection acquisition fails. */
export function connectClient(
	client: Pick<Client, "close" | "connect">,
	transport: Transport,
	requestOptions?: RequestOptions,
	failureCleanupMessage = "MCP connection setup failed",
): Effect.Effect<void, unknown> {
	let nativeSignal: AbortSignal | undefined;
	const connect = Effect.tryPromise({
		try: (signal) => {
			nativeSignal = signal;
			return client.connect(transport, withEffectSignal(requestOptions, signal));
		},
		catch: (error) => error,
	});
	return Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const exit = yield* Effect.exit(restore(connect));
			if (Exit.isSuccess(exit)) return;
			yield* closeFailedConnection(client, transport, exit.cause, nativeSignal, failureCleanupMessage);
			return yield* Effect.failCause(exit.cause);
		}),
	);
}

export function createSessionTerminator(transport: Transport, serverName: string): (() => Promise<void>) | undefined {
	if (!("terminateSession" in transport) || !isRuntimeFunction(transport.terminateSession)) return undefined;
	const terminateSession = transport.terminateSession.bind(transport);
	return async () => {
		try {
			await terminateSession();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.debug(`MCP: Failed to terminate HTTP session for ${serverName}: ${message}`);
		}
	};
}

function resolveHttpHeaders(
	definition: ServerDefinition,
	serverName: string,
): Effect.Effect<Record<string, string>, unknown> {
	return Effect.gen(function* () {
		const hasCommandHeader = Object.values(definition.headers ?? {}).some(
			(value) => value.startsWith("!") && !value.startsWith("!!"),
		);
		const headers =
			(yield* Effect.tryPromise({
				try: (signal) =>
					resolveCommandSecretsRecord(
						definition.headers,
						(key) => `MCP server "${serverName}" HTTP header "${key}"`,
						signal,
					),
				catch: (error) => error,
			})) ?? {};
		const commandBearer =
			definition.bearerToken?.startsWith("!") && !definition.bearerToken.startsWith("!!")
				? definition.bearerToken
				: undefined;
		if (definition.auth === "bearer") {
			const token = commandBearer
				? yield* Effect.tryPromise({
						try: (signal) =>
							resolveCommandSecret(commandBearer, `MCP server "${serverName}" HTTP bearer token`, signal),
						catch: (error) => error,
					})
				: resolveBearerToken(definition);
			if (token) headers["Authorization"] = `Bearer ${token}`;
		}
		if (hasCommandHeader || commandBearer) {
			try {
				new Headers(headers);
			} catch {
				return yield* Effect.fail(
					new Error(
						`Failed to resolve MCP server "${serverName}" HTTP command secret: command returned an invalid header value`,
					),
				);
			}
		}
		return headers;
	});
}

function probeStreamableTransport(
	testClient: Client,
	probeTransport: Transport,
	streamableTransport: Transport,
	requestOptions: RequestOptions | undefined,
	serverName: string,
): Effect.Effect<void, unknown> {
	return Effect.uninterruptibleMask((restore) =>
		Effect.gen(function* () {
			const connectExit = yield* Effect.exit(
				restore(connectClient(testClient, probeTransport, requestOptions, "MCP HTTP probe cleanup failed")),
			);
			if (Exit.isFailure(connectExit)) return yield* Effect.failCause(connectExit.cause);
			yield* Effect.tryPromise({
				try: async () => {
					await createSessionTerminator(streamableTransport, serverName)?.();
					await testClient.close();
				},
				catch: (cleanupError) => new AggregateError([cleanupError], "MCP HTTP probe cleanup failed"),
			});
		}),
	);
}

/** Negotiate the native SDK HTTP transport without exposing Effect through the MCP contract. */
export function createHttpTransport(input: HttpTransportInput): Effect.Effect<Transport, unknown> {
	const { authStorageOptions, definition, oauthSignal, requestOptions, serverName, traceObserver } = input;
	return Effect.gen(function* () {
		const serverUrl = resolveServerUrl(definition);
		if (!serverUrl) return yield* Effect.fail(new Error(`Server ${serverName} has no HTTP URL`));
		const url = new URL(serverUrl);
		const headers = yield* resolveHttpHeaders(definition, serverName);
		const requestInit = Object.keys(headers).length > 0 ? { headers } : undefined;
		const createAuthProvider = (): McpOAuthProvider =>
			new McpOAuthProvider(
				serverName,
				serverUrl,
				extractOAuthConfig(definition),
				{ onRedirect: async () => undefined },
				authStorageOptions,
				oauthSignal,
			);
		let authState: HttpAuthProviderState = supportsOAuth(definition)
			? definition.auth === undefined
				? { status: "implicit-deferred" }
				: { status: "explicit", provider: createAuthProvider() }
			: { status: "disabled" };

		for (;;) {
			const authProvider = "provider" in authState ? authState.provider : undefined;
			const transportOptions: StreamableHTTPClientTransportOptions = {};
			if (requestInit !== undefined) transportOptions.requestInit = requestInit;
			if (authProvider !== undefined) transportOptions.authProvider = authProvider;
			const streamableTransport = normalizeStreamableTransport(
				new StreamableHTTPClientTransport(url, transportOptions),
			);
			const probeTransport = traceObserver
				? wrapTransportWithMcpTrace(streamableTransport, serverName, "streamable-http", traceObserver)
				: streamableTransport;
			const testClient = new Client({ name: "pi-mcp-probe", version: "2.1.2" });
			const probeExit = yield* Effect.exit(
				probeStreamableTransport(testClient, probeTransport, streamableTransport, requestOptions, serverName),
			);
			if (Exit.isSuccess(probeExit)) {
				return normalizeStreamableTransport(new StreamableHTTPClientTransport(url, transportOptions));
			}
			if (Cause.hasInterrupts(probeExit.cause)) return yield* Effect.failCause(probeExit.cause);
			const error = Cause.squash(probeExit.cause);
			if (
				error instanceof AggregateError &&
				(error.message === "MCP connection abort cleanup failed" ||
					error.message === "MCP HTTP probe cleanup failed")
			) {
				return yield* Effect.fail(error);
			}
			if (authState.status === "implicit-deferred" && isUnauthorizedHttpError(error)) {
				authState = { status: "implicit-challenged", provider: createAuthProvider() };
				continue;
			}
			if (isUnauthorizedHttpError(error)) return yield* Effect.fail(error);
			return new SSEClientTransport(url, transportOptions);
		}
	});
}
