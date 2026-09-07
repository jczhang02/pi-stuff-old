/**
 * MCP Auth Flow
 *
 * High-level OAuth flow management using the MCP SDK's built-in auth functions.
 */

import { isRuntimeString } from "../../shared/runtime-type.ts";
import { abortable, throwIfAborted } from "./abort.ts";
import { logger } from "./logger.ts";
import {
	type AuthStorageOptions,
	clearAllCredentials,
	clearClientInfo,
	clearCodeVerifier,
	clearOAuthState,
	clearTokens,
	getAuthBaseDir,
	getAuthForUrl,
	getOAuthState,
	hasStoredTokens,
	isTokenExpired,
	type StoredTokens,
} from "./mcp-auth.ts";
import {
	type AuthDiscovery,
	type AuthorizationCodeInput,
	applyConfiguredScope,
	extractOAuthConfig,
	parseAuthorizationRedirectInput,
	parseOAuthRedirectUri,
} from "./mcp-auth-config.ts";
import { probeAuthDiscovery, sdkAuthOptions } from "./mcp-auth-discovery.ts";
import {
	cancelPendingCallback,
	ensureCallbackServer,
	releaseCallbackServer,
	stopCallbackServer,
	waitForCallback,
} from "./mcp-callback-server.ts";
import type { McpOAuthConfig, McpOAuthProvider } from "./mcp-oauth-provider.ts";
import { combineAbortSignals, isAbortError } from "./runtime-owner.ts";
import { isServerDisabled, type ServerEntry } from "./types.ts";
import { formatTerminalError } from "./utils.ts";

export {
	type AuthorizationCodeInput,
	extractOAuthConfig,
	parseAuthorizationCodeInput,
	parseAuthorizationRedirectInput,
	supportsOAuth,
} from "./mcp-auth-config.ts";

/** Auth status for a server */
export type AuthStatus = "authenticated" | "expired" | "not_authenticated";

export interface McpOAuthRuntime {
	readonly signal: AbortSignal;
}

export interface AuthenticateOptions {
	onAuthorizationUrl?: (authorizationUrl: string) => void | Promise<void>;
	authStorageOptions?: AuthStorageOptions;
	signal?: AbortSignal;
	runtime?: McpOAuthRuntime;
}

type PendingAuth = {
	serverName: string;
	authProvider: McpOAuthProvider;
	serverUrl: string;
	authorizationUrl: string;
	discovery: AuthDiscovery;
	authStorageOptions: AuthStorageOptions;
};

type RuntimeState = {
	controller: AbortController;
	generation: number;
	pendingAuths: Map<string, PendingAuth>;
	pendingAuthStates: Map<string, string>;
	pendingAuthCleanupTimers: Map<string, ReturnType<typeof setTimeout>>;
	pendingAuthentications: Map<string, Promise<AuthStatus>>;
};

const runtimeStates = new WeakMap<McpOAuthRuntime, RuntimeState>();
const activeRuntimes = new Set<McpOAuthRuntime>();

export function createOAuthRuntime(signal?: AbortSignal): McpOAuthRuntime {
	const controller = new AbortController();
	const runtime = {
		signal: combineAbortSignals(signal, controller.signal) ?? controller.signal,
	} satisfies McpOAuthRuntime;
	runtimeStates.set(runtime, {
		controller,
		generation: 0,
		pendingAuths: new Map(),
		pendingAuthStates: new Map(),
		pendingAuthCleanupTimers: new Map(),
		pendingAuthentications: new Map(),
	});
	activeRuntimes.add(runtime);
	return runtime;
}

let legacyRuntime = createOAuthRuntime();
activeRuntimes.delete(legacyRuntime);

function getRuntime(options?: AuthenticateOptions): McpOAuthRuntime {
	if (options?.runtime) {
		options.runtime.signal.throwIfAborted();
		activeRuntimes.add(options.runtime);
		return options.runtime;
	}
	if (legacyRuntime.signal.aborted) legacyRuntime = createOAuthRuntime();
	activeRuntimes.add(legacyRuntime);
	return legacyRuntime;
}

function getRuntimeState(runtime: McpOAuthRuntime): RuntimeState {
	const state = runtimeStates.get(runtime);
	if (!state) throw new Error("Unknown OAuth runtime");
	return state;
}

function getPendingAuthKey(serverName: string, options: AuthStorageOptions): string {
	return `${serverName}|${getAuthBaseDir(options)}`;
}

export function hasPendingAuth(serverName: string, options?: AuthStorageOptions, runtime?: McpOAuthRuntime): boolean {
	const state = getRuntimeState(runtime ?? legacyRuntime);
	if (options) {
		return state.pendingAuths.has(getPendingAuthKey(serverName, options));
	}
	return Array.from(state.pendingAuths.values()).some((pendingAuth) => pendingAuth.serverName === serverName);
}

/** Timeout for manual auth completion (5 minutes) */
const MANUAL_AUTH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Generate a cryptographically secure random state parameter.
 */
function generateState(): string {
	return Array.from(crypto.getRandomValues(new Uint8Array(32)))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

type AuthStartContext = {
	serverName: string;
	serverUrl: string;
	definition: ServerEntry | undefined;
	config: McpOAuthConfig;
	authStorageOptions: AuthStorageOptions;
	runtime: McpOAuthRuntime;
	runtimeState: RuntimeState;
	signal: AbortSignal;
	generation: number;
};

async function startClientCredentialsAuth(context: AuthStartContext): Promise<{ authorizationUrl: string }> {
	const { serverName, serverUrl, definition, config, authStorageOptions, runtime, signal } = context;
	const [{ auth: runSdkAuth, UnauthorizedError }, { McpOAuthProvider }] = await Promise.all([
		import("@modelcontextprotocol/sdk/client/auth.js"),
		import("./mcp-oauth-provider.ts"),
	]);
	const storedAuth = await getAuthForUrl(serverName, serverUrl, authStorageOptions);
	if (storedAuth?.clientInfo && !storedAuth.tokens && !config.clientId) {
		clearClientInfo(serverName, authStorageOptions);
		clearCodeVerifier(serverName, authStorageOptions);
		await clearOAuthState(serverName, authStorageOptions);
	}

	const authProvider = new McpOAuthProvider(
		serverName,
		serverUrl,
		config,
		{
			onRedirect: async () => {
				throw new Error("Browser redirect is not used for client_credentials flow");
			},
		},
		authStorageOptions,
		runtime.signal,
	);
	try {
		const discovery = applyConfiguredScope(await probeAuthDiscovery(serverUrl, definition, signal), config);
		throwIfAborted(signal);
		const result = await abortable(runSdkAuth(authProvider, sdkAuthOptions(serverUrl, discovery)), signal);
		throwIfAborted(signal);
		if (result !== "AUTHORIZED") throw new UnauthorizedError("Failed to authorize");
		return { authorizationUrl: "" };
	} finally {
		authProvider.deactivate();
	}
}

async function reserveOAuthCallback(context: AuthStartContext, oauthState: string): Promise<void> {
	const { serverName, config, authStorageOptions, signal } = context;
	const redirectCallback = config.redirectUri !== undefined ? parseOAuthRedirectUri(config.redirectUri) : undefined;
	try {
		await ensureCallbackServer({
			strictPort: Boolean(config.clientId) || config.redirectUri !== undefined,
			oauthState,
			reserveState: true,
			...redirectCallback,
		});
		throwIfAborted(signal);
	} catch (error) {
		releaseCallbackServer(oauthState);
		try {
			await clearOAuthState(serverName, authStorageOptions);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "OAuth startup cleanup failed");
		}
		throw error;
	}
}

async function startInteractiveAuth(context: AuthStartContext): Promise<{ authorizationUrl: string }> {
	const { serverName, serverUrl, definition, config, authStorageOptions, runtime, runtimeState, signal, generation } =
		context;
	const [{ auth: runSdkAuth, UnauthorizedError }, { McpOAuthProvider }] = await Promise.all([
		import("@modelcontextprotocol/sdk/client/auth.js"),
		import("./mcp-oauth-provider.ts"),
	]);
	const existingPendingAuth = runtimeState.pendingAuths.get(getPendingAuthKey(serverName, authStorageOptions));
	if (existingPendingAuth?.serverUrl === serverUrl) {
		return { authorizationUrl: existingPendingAuth.authorizationUrl };
	}

	const oauthState = generateState();
	await reserveOAuthCallback(context, oauthState);
	let capturedUrl: URL | undefined;
	const authProvider = new McpOAuthProvider(
		serverName,
		serverUrl,
		config,
		{
			onRedirect: async (url) => {
				capturedUrl = url;
			},
		},
		authStorageOptions,
		runtime.signal,
		oauthState,
	);

	try {
		const storedAuth = await getAuthForUrl(serverName, serverUrl, authStorageOptions);
		if (storedAuth?.clientInfo && !config.clientId) {
			if (!storedAuth.tokens) {
				clearClientInfo(serverName, authStorageOptions);
				clearCodeVerifier(serverName, authStorageOptions);
				await clearOAuthState(serverName, authStorageOptions);
			} else {
				const redirectUris = storedAuth.clientInfo.redirectUris;
				if (!Array.isArray(redirectUris) || !redirectUris.includes(authProvider.redirectUrl ?? "")) {
					clearClientInfo(serverName, authStorageOptions);
					clearTokens(serverName, authStorageOptions);
					clearCodeVerifier(serverName, authStorageOptions);
					await clearOAuthState(serverName, authStorageOptions);
				}
			}
		}

		throwIfAborted(signal);
		const discovery = applyConfiguredScope(await probeAuthDiscovery(serverUrl, definition, signal), config);
		throwIfAborted(signal);
		const result = await abortable(runSdkAuth(authProvider, sdkAuthOptions(serverUrl, discovery)), signal);
		throwIfAborted(signal);
		if (result === "AUTHORIZED") {
			authProvider.deactivate();
			releaseCallbackServer(oauthState);
			await clearOAuthState(serverName, authStorageOptions);
			return { authorizationUrl: "" };
		}
		if (!capturedUrl) throw new UnauthorizedError("OAuth authorization URL was not provided");

		const authorizationUrl = capturedUrl.toString();
		await setPendingAuth(
			runtime,
			serverName,
			{ serverName, authProvider, serverUrl, authorizationUrl, discovery, authStorageOptions },
			oauthState,
			signal,
			generation,
		);
		return { authorizationUrl };
	} catch (error) {
		authProvider.deactivate();
		try {
			await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "OAuth startup cleanup failed");
		}
		throw error;
	}
}

/** Start OAuth authentication and return the browser URL when interaction is required. */
export async function startAuth(
	serverName: string,
	serverUrl: string,
	definition?: ServerEntry,
	options: AuthenticateOptions = {},
): Promise<{ authorizationUrl: string }> {
	if (isServerDisabled(definition)) throw new Error(`MCP server "${serverName}" is disabled`);
	const runtime = getRuntime(options);
	const runtimeState = getRuntimeState(runtime);
	const context: AuthStartContext = {
		serverName,
		serverUrl,
		definition,
		config: definition ? extractOAuthConfig(definition) : {},
		authStorageOptions: options.authStorageOptions ?? {},
		runtime,
		runtimeState,
		signal: combineAbortSignals(runtime.signal, options.signal),
		generation: runtimeState.generation,
	};
	throwIfAborted(context.signal);
	return context.config.grantType === "client_credentials"
		? startClientCredentialsAuth(context)
		: startInteractiveAuth(context);
}

async function setPendingAuth(
	runtime: McpOAuthRuntime,
	serverName: string,
	pendingAuth: PendingAuth,
	oauthState: string,
	signal?: AbortSignal,
	generation = getRuntimeState(runtime).generation,
): Promise<void> {
	const state = getRuntimeState(runtime);
	const key = getPendingAuthKey(serverName, pendingAuth.authStorageOptions);
	await clearPendingAuth(runtime, serverName, undefined, pendingAuth.authStorageOptions);
	throwIfAborted(signal);
	if (generation !== state.generation) throw new Error("OAuth runtime stopped");
	state.pendingAuths.set(key, pendingAuth);
	state.pendingAuthStates.set(key, oauthState);
	const cleanupTimer = setTimeout(() => {
		void clearPendingAuth(runtime, serverName, oauthState, pendingAuth.authStorageOptions).catch((error) => {
			logger.error(
				"MCP Auth: Timed-out flow cleanup failed",
				error instanceof Error ? error : new Error(formatTerminalError(error)),
				{ server: serverName },
			);
		});
	}, MANUAL_AUTH_TIMEOUT_MS);
	cleanupTimer.unref?.();
	state.pendingAuthCleanupTimers.set(key, cleanupTimer);
}

async function clearPendingAuth(
	runtime: McpOAuthRuntime,
	serverName: string,
	oauthState?: string,
	fallbackStorageOptions: AuthStorageOptions = {},
): Promise<void> {
	const state = getRuntimeState(runtime);
	const key = getPendingAuthKey(serverName, fallbackStorageOptions);
	const pendingAuth = state.pendingAuths.get(key);
	const authStorageOptions = pendingAuth?.authStorageOptions ?? fallbackStorageOptions;
	const pendingState = state.pendingAuthStates.get(key);
	if (oauthState && pendingState && pendingState !== oauthState) return;

	const timer = state.pendingAuthCleanupTimers.get(key);
	if (timer) {
		clearTimeout(timer);
		state.pendingAuthCleanupTimers.delete(key);
	}

	pendingAuth?.authProvider.deactivate();
	state.pendingAuths.delete(key);
	state.pendingAuthStates.delete(key);
	const stateToRelease = pendingState ?? oauthState;
	if (stateToRelease) {
		cancelPendingCallback(stateToRelease);
		const storedState = await getOAuthState(serverName, authStorageOptions);
		if (storedState === stateToRelease) {
			await clearOAuthState(serverName, authStorageOptions);
		}
	}
}

/**
 * Complete OAuth authentication from manual user input.
 */
export async function completeAuthFromInput(
	serverName: string,
	input: string,
	options: AuthenticateOptions = {},
): Promise<AuthStatus> {
	const runtime = getRuntime(options);
	const runtimeState = getRuntimeState(runtime);
	const fallbackAuthStorageOptions = options.authStorageOptions ?? {};
	const signal = combineAbortSignals(runtime.signal, options.signal);
	throwIfAborted(signal);
	const key = getPendingAuthKey(serverName, fallbackAuthStorageOptions);
	const oauthState = runtimeState.pendingAuthStates.get(key);
	throwIfAborted(signal);
	const parsed = parseAuthorizationRedirectInput(input, oauthState);
	return completeAuth(serverName, parsed, options);
}

/**
 * Complete OAuth authentication with the authorization code.
 */
export async function completeAuth(
	serverName: string,
	authorizationCode: string | AuthorizationCodeInput,
	options: AuthenticateOptions = {},
): Promise<AuthStatus> {
	const runtime = getRuntime(options);
	const runtimeState = getRuntimeState(runtime);
	const { code, iss } = isRuntimeString(authorizationCode)
		? { code: authorizationCode, iss: undefined }
		: authorizationCode;
	const fallbackAuthStorageOptions = options.authStorageOptions ?? {};
	const signal = combineAbortSignals(runtime.signal, options.signal);
	throwIfAborted(signal);
	const key = getPendingAuthKey(serverName, fallbackAuthStorageOptions);
	const pendingAuth = runtimeState.pendingAuths.get(key);
	const authStorageOptions = pendingAuth?.authStorageOptions ?? fallbackAuthStorageOptions;
	if (!pendingAuth) {
		throw new Error(`No pending OAuth flow for server: ${serverName}`);
	}

	const oauthState = runtimeState.pendingAuthStates.get(key);
	throwIfAborted(signal);

	let keepPendingForRetry = false;
	try {
		const discoveryState = await pendingAuth.authProvider.discoveryState();
		const metadata = discoveryState?.authorizationServerMetadata;
		const expectedIssuer = metadata?.issuer ?? discoveryState?.authorizationServerUrl;
		const requiresIssuer =
			metadata !== undefined &&
			"authorization_response_iss_parameter_supported" in metadata &&
			metadata["authorization_response_iss_parameter_supported"] === true;
		if (expectedIssuer !== undefined && iss === undefined && requiresIssuer) {
			keepPendingForRetry = true;
			throw new Error(
				`The authorization server for ${serverName} requires the RFC 9207 "iss" parameter. ` +
					"Paste the full redirect URL from the browser address bar (not just the authorization code).",
			);
		}
		if (expectedIssuer !== undefined && iss !== undefined && iss !== expectedIssuer) {
			throw new Error(
				`The OAuth authorization response issuer does not match the discovered issuer for ${serverName}.`,
			);
		}
		const { auth: runSdkAuth, UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js");

		const result = await abortable(
			runSdkAuth(pendingAuth.authProvider, {
				...sdkAuthOptions(pendingAuth.serverUrl, pendingAuth.discovery),
				authorizationCode: code,
			}),
			signal,
		);
		throwIfAborted(signal);
		if (result !== "AUTHORIZED") {
			throw new UnauthorizedError("Failed to authorize");
		}
	} catch (error) {
		if (!keepPendingForRetry) {
			try {
				await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "OAuth completion cleanup failed");
			}
		}
		throw error;
	}
	await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions);
	return "authenticated";
}

/**
 * Perform the complete OAuth authentication flow for a server.
 *
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server
 * @param definition - The server definition (optional)
 * @returns The final auth status
 */
export async function authenticate(
	serverName: string,
	serverUrl: string,
	definition?: ServerEntry,
	options: AuthenticateOptions = {},
): Promise<AuthStatus> {
	if (isServerDisabled(definition)) throw new Error(`MCP server "${serverName}" is disabled`);
	const runtime = getRuntime(options);
	const runtimeState = getRuntimeState(runtime);
	const authStorageOptions = options.authStorageOptions ?? {};
	const signal = combineAbortSignals(runtime.signal, options.signal);
	throwIfAborted(signal);
	const authKey = `${serverName}|${serverUrl}|${getAuthBaseDir(authStorageOptions)}`;
	const inFlight = runtimeState.pendingAuthentications.get(authKey);
	if (inFlight) {
		return inFlight;
	}

	const operation = (async (): Promise<AuthStatus> => {
		// Start auth flow
		const { authorizationUrl } = await startAuth(serverName, serverUrl, definition, { ...options, signal, runtime });

		// If no auth URL needed, already authenticated
		if (!authorizationUrl) {
			return "authenticated";
		}

		let oauthState: string | undefined;
		try {
			// Get the state that was already generated and stored in startAuth().
			// Keep this lookup and its abort check inside the cleanup boundary because
			// startAuth has already reserved callback state at this point.
			oauthState = runtimeState.pendingAuthStates.get(getPendingAuthKey(serverName, authStorageOptions));
			throwIfAborted(signal);
			if (!oauthState) {
				throw new Error("OAuth state not found - this should not happen");
			}

			// Register the callback BEFORE opening the browser.
			const callbackPromise = waitForCallback(oauthState);
			void callbackPromise.catch(() => {});

			// Open browser. Always surface the URL first so remote/headless users can copy it
			// even when the OS browser handoff is unavailable or invisible.
			if (options.onAuthorizationUrl) {
				await abortable(Promise.resolve(options.onAuthorizationUrl(authorizationUrl)), signal);
			} else {
				logger.info(`MCP Auth: Authorization URL is ready for ${serverName}`, {
					server: serverName,
					uri: authorizationUrl,
				});
			}
			try {
				const { default: open } = await import("open");
				await abortable(open(authorizationUrl), signal);
			} catch (error) {
				if (isAbortError(error, signal)) throw error;
				logger.warn(`MCP Auth: Failed to open a browser for ${serverName}; waiting for manual callback`, {
					error: error instanceof Error ? error.message : String(error),
					server: serverName,
				});
			}

			// Wait for callback
			const callbackResult = await abortable(callbackPromise, signal);

			// The callback server accepted only the flow-local reserved state.
			throwIfAborted(signal);

			// Complete the auth
			return await completeAuth(serverName, callbackResult, { ...options, signal, runtime });
		} catch (error) {
			if (oauthState) cancelPendingCallback(oauthState);
			try {
				await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions);
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], "OAuth cancellation cleanup failed");
			}
			throw error;
		}
	})();

	runtimeState.pendingAuthentications.set(authKey, operation);

	try {
		return await operation;
	} finally {
		if (runtimeState.pendingAuthentications.get(authKey) === operation) {
			runtimeState.pendingAuthentications.delete(authKey);
		}
	}
}

/**
 * Get a valid access token for a server, refreshing if necessary.
 *
 * @param serverName - The name of the MCP server
 * @param serverUrl - The URL of the MCP server
 * @returns The valid tokens or null if not authenticated
 */
export async function getValidToken(
	serverName: string,
	serverUrl: string,
	options: AuthenticateOptions = {},
): Promise<StoredTokens | null> {
	const runtime = getRuntime(options);
	const authStorageOptions = options.authStorageOptions ?? {};
	const signal = combineAbortSignals(runtime.signal, options.signal);
	throwIfAborted(signal);
	// Check if we have valid tokens
	const entry = await getAuthForUrl(serverName, serverUrl, authStorageOptions);
	throwIfAborted(signal);
	if (!entry?.tokens) {
		return null;
	}

	// Check expiration
	const expired = await isTokenExpired(serverName, authStorageOptions);
	if (expired === false) {
		return entry.tokens;
	}

	if (expired === true && entry.tokens.refreshToken) {
		// Token is expired, try to refresh
		logger.info(`MCP Auth: Token expired for ${serverName}; attempting refresh`, { server: serverName });

		try {
			// Create auth provider for token refresh
			const [{ auth: runSdkAuth }, { McpOAuthProvider }] = await Promise.all([
				import("@modelcontextprotocol/sdk/client/auth.js"),
				import("./mcp-oauth-provider.ts"),
			]);
			const authProvider = new McpOAuthProvider(
				serverName,
				serverUrl,
				{},
				{
					onRedirect: async () => {},
				},
				authStorageOptions,
				runtime.signal,
			);

			try {
				const clientInfo = await authProvider.clientInformation();
				throwIfAborted(signal);
				if (!clientInfo) {
					logger.info(`MCP Auth: No client information is available to refresh ${serverName}`, {
						server: serverName,
					});
					return null;
				}

				const discovery = await probeAuthDiscovery(serverUrl, undefined, signal);
				throwIfAborted(signal);
				const result = await abortable(runSdkAuth(authProvider, sdkAuthOptions(serverUrl, discovery)), signal);
				throwIfAborted(signal);
				if (result !== "AUTHORIZED") {
					return null;
				}
				const refreshed = await getAuthForUrl(serverName, serverUrl, authStorageOptions);
				throwIfAborted(signal);
				return refreshed?.tokens ?? null;
			} finally {
				authProvider.deactivate();
			}
		} catch (error) {
			if (isAbortError(error, signal)) throw error;
			logger.error(
				`MCP Auth: Token refresh failed for ${serverName}`,
				error instanceof Error ? error : new Error(formatTerminalError(error)),
				{ server: serverName },
			);
			return null;
		}
	}

	// No expiration info or no refresh token, assume valid
	return entry.tokens;
}

/**
 * Check the authentication status for a server.
 *
 * @param serverName - The name of the MCP server
 * @returns The current auth status
 */
export async function getAuthStatus(serverName: string, options: AuthenticateOptions = {}): Promise<AuthStatus> {
	const signal = combineAbortSignals(getRuntime(options).signal, options.signal);
	throwIfAborted(signal);
	const authStorageOptions = options.authStorageOptions ?? {};
	const hasTokens = await hasStoredTokens(serverName, authStorageOptions);
	throwIfAborted(signal);
	if (!hasTokens) return "not_authenticated";

	const expired = await isTokenExpired(serverName, authStorageOptions);
	throwIfAborted(signal);
	return expired ? "expired" : "authenticated";
}

/**
 * Remove all OAuth credentials for a server.
 *
 * @param serverName - The name of the MCP server
 */
export async function removeAuth(serverName: string, options: AuthenticateOptions = {}): Promise<void> {
	const runtime = getRuntime(options);
	const signal = combineAbortSignals(runtime.signal, options.signal);
	throwIfAborted(signal);
	const authStorageOptions = options.authStorageOptions ?? {};
	const oauthState = await getOAuthState(serverName, authStorageOptions);
	throwIfAborted(signal);
	if (oauthState) {
		cancelPendingCallback(oauthState);
	}
	await clearPendingAuth(runtime, serverName, oauthState, authStorageOptions);
	throwIfAborted(signal);
	clearAllCredentials(serverName, authStorageOptions);
	await clearOAuthState(serverName, authStorageOptions);
	throwIfAborted(signal);
	logger.info(`MCP Auth: Removed credentials for ${serverName}`, { server: serverName });
}

/**
 * Initialize the OAuth system on startup.
 * OAuth callback binding is lazy and starts from startAuth() only.
 */
export async function initializeOAuth(runtimeOrSignal?: McpOAuthRuntime | AbortSignal): Promise<McpOAuthRuntime> {
	if (runtimeOrSignal !== undefined && "signal" in runtimeOrSignal) {
		runtimeOrSignal.signal.throwIfAborted();
		activeRuntimes.add(runtimeOrSignal);
		return runtimeOrSignal;
	}

	await shutdownOAuth(legacyRuntime);
	const signal = runtimeOrSignal !== undefined && "aborted" in runtimeOrSignal ? runtimeOrSignal : undefined;
	legacyRuntime = createOAuthRuntime(signal);
	return legacyRuntime;
}

/**
 * Shutdown one OAuth runtime. The callback server remains process-shared while
 * another runtime has pending/reserved callback state or is still active.
 */
export async function shutdownOAuth(runtime: McpOAuthRuntime = legacyRuntime): Promise<void> {
	const state = getRuntimeState(runtime);
	if (state.controller.signal.aborted) return;
	state.generation += 1;
	state.controller.abort(new Error("OAuth runtime stopped"));
	for (const callbackState of Array.from(state.pendingAuthStates.values())) cancelPendingCallback(callbackState);
	for (const pendingAuth of Array.from(state.pendingAuths.values())) {
		await clearPendingAuth(runtime, pendingAuth.serverName, undefined, pendingAuth.authStorageOptions);
	}
	state.pendingAuthentications.clear();
	activeRuntimes.delete(runtime);

	if (activeRuntimes.size === 0) {
		await stopCallbackServer();
	}
}
