/**
 * MCP Auth Storage Module
 *
 * Handles secure storage of OAuth credentials, tokens, client information,
 * and legacy PKCE state for MCP servers.
 *
 * Persistent OAuth entries are stored in the operating system credential store.
 * Legacy plaintext entries are read from $MCP_OAUTH_DIR/sha256-<server-hash>/tokens.json
 * when set, otherwise <Pi agent dir>/mcp-oauth/sha256-<server-hash>/tokens.json.
 * An explicit OAuth write moves them to the secure store and removes the plaintext file.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	isJsonInputObject,
	type JsonInputObject,
	type JsonInputValue,
	parseJsonValue,
} from "../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { getAgentPath } from "./agent-dir.ts";
import { resolveConfiguredOAuthDir } from "./config.ts";
import {
	type AuthSecretStore,
	getAuthSecretStore,
	isRevokedKeyringError,
	linuxKeyringRecoveryAuthSecretStore,
	shouldAttemptLinuxKeyringRecovery,
} from "./mcp-auth-keyring.ts";

export {
	getTestAuthSecretStoreEntries,
	loadTestKeyringEntryClass,
	removeTestAuthSecretStoreEntry,
	resetTestAuthSecretStore,
} from "./mcp-auth-keyring.ts";

const AUTH_SECRET_CHUNK_SIZE = 1800;
const AUTH_SECRET_MAX_PAYLOAD_BYTES = 1024 * 1024;
const AUTH_SECRET_MAX_CHUNKS = Math.ceil(AUTH_SECRET_MAX_PAYLOAD_BYTES / AUTH_SECRET_CHUNK_SIZE);
const AUTH_CHUNK_MANIFEST_KEY = "__piMcpAdapterOAuthChunked";

/** OAuth token storage format */
export interface StoredTokens {
	accessToken: string;
	refreshToken?: string;
	expiresAt?: number; // Unix timestamp in seconds
	scope?: string;
	/** SEP-2352 authorization-server issuer binding */
	issuer?: string;
}

/** OAuth client information from dynamic or static registration */
export interface StoredClientInfo {
	clientId: string;
	clientSecret?: string;
	clientIdIssuedAt?: number;
	clientSecretExpiresAt?: number;
	redirectUris?: string[];
	/** SEP-2352 authorization-server issuer binding */
	issuer?: string;
	/**
	 * True when this entry is a secretless SEP-2352 issuer stub persisted for a
	 * config-pre-registered client (written by the config-clientId path of
	 * saveClientInformation). Such a stub is only usable when paired with the
	 * config that supplies the client secret; it must never be served as
	 * standalone client information.
	 */
	configPreRegistered?: boolean;
}

/** Complete auth entry for a server */
export interface AuthEntry {
	tokens?: StoredTokens;
	clientInfo?: StoredClientInfo;
	codeVerifier?: string;
	oauthState?: string;
	serverUrl?: string; // Track the URL these credentials are for
}

export interface AuthStorageOptions {
	/** Legacy plaintext import directory. Persistent secrets no longer use this as their store. */
	baseDir?: string;
}

export class OAuthCredentialStoreError extends Error {
	readonly code = "OAUTH_CREDENTIAL_STORE_UNAVAILABLE";
	readonly operation: "read" | "write" | "remove";

	constructor(message: string, operation: "read" | "write" | "remove", cause: unknown) {
		super(message, { cause });
		this.name = "OAuthCredentialStoreError";
		this.operation = operation;
	}
}

export type OAuthCredentialStatus =
	| { status: "present"; entry: AuthEntry }
	| { status: "absent" }
	| { status: "unavailable"; message: string };

export function formatOAuthCredentialStoreUnavailable(error: OAuthCredentialStoreError): string {
	if (process.platform === "linux" && isRevokedKeyringError(error)) {
		return "OAuth credential store unavailable: the Linux session keyring may be revoked. Start Pi from a fresh login/keyring session and retry.";
	}
	return "OAuth credential store unavailable. Configure or unlock the OS credential store and retry.";
}

interface AuthEntryChunkManifest {
	[AUTH_CHUNK_MANIFEST_KEY]: 1;
	chunkCount: number;
	chunkDigest: string;
}

export function getAuthStorageOptions(oauthDir: JsonInputValue, cwd = process.cwd()): AuthStorageOptions {
	const baseDir = resolveConfiguredOAuthDir(oauthDir, cwd);
	return baseDir ? { baseDir } : {};
}

export function getAuthBaseDir(options: AuthStorageOptions = {}): string {
	const override = process.env["MCP_OAUTH_DIR"]?.trim();
	if (override) return override;
	return options.baseDir ?? getAgentPath("mcp-oauth");
}

/**
 * Get the legacy server-specific directory path.
 */
function getServerDir(serverName: string, options?: AuthStorageOptions): string {
	return join(getAuthBaseDir(options), getAuthEntryAccount(serverName));
}

function getAuthEntryAccount(serverName: string): string {
	if (!isRuntimeString(serverName)) {
		throw new Error(`Invalid MCP server name: ${JSON.stringify(serverName)}`);
	}
	return `sha256-${createHash("sha256").update(serverName, "utf8").digest("hex")}`;
}

/**
 * Get the legacy plaintext tokens file path for a server.
 */
export function getAuthEntryFilePath(serverName: string, options?: AuthStorageOptions): string {
	return join(getServerDir(serverName, options), "tokens.json");
}

function parseJsonPayload(serverName: string, payload: string, source: string): JsonInputValue {
	try {
		return parseJsonValue(payload);
	} catch (error) {
		throw new Error(`Failed to parse OAuth credentials for ${serverName} from ${source}`, { cause: error });
	}
}

function parseAuthEntryPayload(serverName: string, payload: string, source: string): AuthEntry {
	const value = parseJsonPayload(serverName, payload, source);
	if (!isJsonInputObject(value)) throw new Error(`Invalid OAuth credentials for ${serverName} from ${source}`);
	const entry: AuthEntry = {};
	if (value["tokens"] !== undefined) entry.tokens = parseStoredTokens(value["tokens"], serverName, source);
	if (value["clientInfo"] !== undefined)
		entry.clientInfo = parseStoredClientInfo(value["clientInfo"], serverName, source);
	assignOptionalString(entry, "codeVerifier", value["codeVerifier"], serverName, source);
	assignOptionalString(entry, "oauthState", value["oauthState"], serverName, source);
	assignOptionalString(entry, "serverUrl", value["serverUrl"], serverName, source);
	return entry;
}

function parseStoredTokens(value: JsonInputValue, serverName: string, source: string): StoredTokens {
	const record = requireAuthObject(value, "tokens", serverName, source);
	if (!isRuntimeString(record["accessToken"])) throw invalidAuthField("tokens.accessToken", serverName, source);
	const tokens: StoredTokens = { accessToken: record["accessToken"] };
	assignOptionalString(tokens, "refreshToken", record["refreshToken"], serverName, source);
	assignOptionalNumber(tokens, "expiresAt", record["expiresAt"], serverName, source);
	assignOptionalString(tokens, "scope", record["scope"], serverName, source);
	assignOptionalString(tokens, "issuer", record["issuer"], serverName, source);
	return tokens;
}

function parseStoredClientInfo(value: JsonInputValue, serverName: string, source: string): StoredClientInfo {
	const record = requireAuthObject(value, "clientInfo", serverName, source);
	if (!isRuntimeString(record["clientId"])) throw invalidAuthField("clientInfo.clientId", serverName, source);
	const info: StoredClientInfo = { clientId: record["clientId"] };
	assignOptionalString(info, "clientSecret", record["clientSecret"], serverName, source);
	assignOptionalNumber(info, "clientIdIssuedAt", record["clientIdIssuedAt"], serverName, source);
	assignOptionalNumber(info, "clientSecretExpiresAt", record["clientSecretExpiresAt"], serverName, source);
	assignOptionalString(info, "issuer", record["issuer"], serverName, source);
	if (record["redirectUris"] !== undefined) {
		if (!Array.isArray(record["redirectUris"]) || !record["redirectUris"].every(isRuntimeString)) {
			throw invalidAuthField("clientInfo.redirectUris", serverName, source);
		}
		info.redirectUris = record["redirectUris"];
	}
	if (record["configPreRegistered"] !== undefined) {
		if (!isRuntimeBoolean(record["configPreRegistered"]))
			throw invalidAuthField("clientInfo.configPreRegistered", serverName, source);
		info.configPreRegistered = record["configPreRegistered"];
	}
	return info;
}

function requireAuthObject(value: JsonInputValue, field: string, serverName: string, source: string): JsonInputObject {
	if (!isJsonInputObject(value)) throw invalidAuthField(field, serverName, source);
	return value;
}

function invalidAuthField(field: string, serverName: string, source: string): Error {
	return new Error(`Invalid OAuth credential field ${field} for ${serverName} from ${source}`);
}

function assignOptionalString<Target extends object, Key extends keyof Target>(
	target: Target,
	key: Key,
	value: JsonInputValue,
	serverName: string,
	source: string,
): void {
	if (value === undefined) return;
	if (!isRuntimeString(value)) throw invalidAuthField(String(key), serverName, source);
	Object.assign(target, { [key]: value });
}

function assignOptionalNumber<Target extends object, Key extends keyof Target>(
	target: Target,
	key: Key,
	value: JsonInputValue,
	serverName: string,
	source: string,
): void {
	if (value === undefined) return;
	if (!isRuntimeNumber(value) || !Number.isFinite(value)) throw invalidAuthField(String(key), serverName, source);
	Object.assign(target, { [key]: value });
}

function getAuthEntryChunkAccount(account: string, manifest: AuthEntryChunkManifest, index: number): string {
	return `${account}.chunk.${manifest.chunkDigest}.${index}`;
}

function getAuthEntryChunkAccounts(account: string, manifest: AuthEntryChunkManifest): string[] {
	return Array.from({ length: manifest.chunkCount }, (_, index) => getAuthEntryChunkAccount(account, manifest, index));
}

function readChunkManifestFromPayload(
	serverName: string,
	payload: string,
	source: string,
): AuthEntryChunkManifest | undefined {
	const parsed = parseJsonPayload(serverName, payload, source);
	if (!isJsonInputObject(parsed) || parsed[AUTH_CHUNK_MANIFEST_KEY] === undefined) return undefined;
	const chunkCount = parsed["chunkCount"];
	const chunkDigest = parsed["chunkDigest"];
	if (
		parsed[AUTH_CHUNK_MANIFEST_KEY] !== 1 ||
		!isRuntimeNumber(chunkCount) ||
		!Number.isInteger(chunkCount) ||
		chunkCount <= 1 ||
		chunkCount > AUTH_SECRET_MAX_CHUNKS ||
		!isRuntimeString(chunkDigest) ||
		!/^[a-f0-9]{16}$/.test(chunkDigest)
	) {
		throw new Error(`Invalid OAuth credential chunk manifest for ${serverName} from ${source}`);
	}
	return { [AUTH_CHUNK_MANIFEST_KEY]: 1, chunkCount, chunkDigest };
}

function readExistingChunkManifest(
	store: AuthSecretStore,
	serverName: string,
	account: string,
): AuthEntryChunkManifest | undefined {
	let payload: string | undefined;
	try {
		payload = store.read(account);
	} catch {
		return undefined;
	}
	return payload === undefined
		? undefined
		: readChunkManifestFromPayload(serverName, payload, "OS secure credential store");
}

function removeChunkPayloads(store: AuthSecretStore, account: string, manifest: AuthEntryChunkManifest): void {
	for (const chunkAccount of getAuthEntryChunkAccounts(account, manifest)) {
		store.remove(chunkAccount);
	}
}

function tryRemoveChunkPayloads(
	store: AuthSecretStore,
	account: string,
	manifest: AuthEntryChunkManifest | undefined,
): void {
	if (!manifest) return;
	try {
		removeChunkPayloads(store, account, manifest);
	} catch {
		// Stale chunk cleanup must not hide a successful credential write.
	}
}

function createChunkManifest(payload: string): AuthEntryChunkManifest {
	return {
		[AUTH_CHUNK_MANIFEST_KEY]: 1,
		chunkCount: Math.ceil(payload.length / AUTH_SECRET_CHUNK_SIZE),
		chunkDigest: createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16),
	};
}

function readChunkedAuthEntry(
	store: AuthSecretStore,
	serverName: string,
	account: string,
	manifest: AuthEntryChunkManifest,
): AuthEntry {
	const chunks = getAuthEntryChunkAccounts(account, manifest).map((chunkAccount, index) => {
		try {
			const chunk = store.read(chunkAccount);
			const lastChunk = index === manifest.chunkCount - 1;
			if (
				chunk === undefined ||
				chunk.length === 0 ||
				chunk.length > AUTH_SECRET_CHUNK_SIZE ||
				(!lastChunk && chunk.length !== AUTH_SECRET_CHUNK_SIZE)
			) {
				throw new Error(`Invalid OAuth credential chunk ${chunkAccount} for ${serverName}`);
			}
			return chunk;
		} catch (error) {
			throw new OAuthCredentialStoreError(
				`Failed to read OAuth credentials for ${serverName} from the OS secure credential store`,
				"read",
				error,
			);
		}
	});
	const payload = chunks.join("");
	if (
		Buffer.byteLength(payload, "utf8") > AUTH_SECRET_MAX_PAYLOAD_BYTES ||
		createChunkManifest(payload).chunkDigest !== manifest.chunkDigest
	) {
		throw new OAuthCredentialStoreError(
			`OAuth credential chunk integrity check failed for ${serverName}`,
			"read",
			new Error("OAuth credential chunk digest mismatch"),
		);
	}
	return parseAuthEntryPayload(serverName, payload, "OS secure credential store chunks");
}

function readLegacyAuthEntry(serverName: string, options?: AuthStorageOptions): AuthEntry | undefined {
	const filePath = getAuthEntryFilePath(serverName, options);
	if (!existsSync(filePath)) return undefined;
	const data = readFileSync(filePath, "utf-8");
	return parseAuthEntryPayload(serverName, data, filePath);
}

function removeLegacyAuthEntry(serverName: string, options?: AuthStorageOptions): void {
	const filePath = getAuthEntryFilePath(serverName, options);
	if (!existsSync(filePath)) return;
	try {
		rmSync(filePath, { force: true });
	} catch (error) {
		throw new Error(`Failed to remove legacy plaintext OAuth credentials for ${serverName} at ${filePath}`, {
			cause: error,
		});
	}

	const dir = getServerDir(serverName, options);
	try {
		rmSync(dir, { recursive: true });
	} catch {
		// Directory may contain future non-secret metadata; the plaintext file was already removed.
	}
}

function writeSecureAuthEntryToStore(store: AuthSecretStore, serverName: string, entry: AuthEntry): void {
	const account = getAuthEntryAccount(serverName);
	const payload = JSON.stringify(entry);
	if (Buffer.byteLength(payload, "utf8") > AUTH_SECRET_MAX_PAYLOAD_BYTES) {
		throw new Error(`OAuth credentials for ${serverName} exceed the 1 MiB secure-store limit`);
	}
	const manifest = payload.length > AUTH_SECRET_CHUNK_SIZE ? createChunkManifest(payload) : undefined;
	const previousManifest = readExistingChunkManifest(store, serverName, account);

	try {
		if (manifest) {
			for (let index = 0; index < manifest.chunkCount; index++) {
				const chunk = payload.slice(index * AUTH_SECRET_CHUNK_SIZE, (index + 1) * AUTH_SECRET_CHUNK_SIZE);
				store.write(getAuthEntryChunkAccount(account, manifest, index), chunk);
			}
			store.write(account, JSON.stringify(manifest));
		} else {
			// Compact: multiline secrets corrupt gnome-keyring plaintext (GKeyFile) collections.
			store.write(account, payload);
		}
		if (previousManifest?.chunkDigest !== manifest?.chunkDigest) {
			tryRemoveChunkPayloads(store, account, previousManifest);
		}
	} catch (error) {
		tryRemoveChunkPayloads(store, account, manifest);
		throw new OAuthCredentialStoreError(
			`Failed to write OAuth credentials for ${serverName} to the OS secure credential store`,
			"write",
			error,
		);
	}
}

function writeSecureAuthEntry(serverName: string, entry: AuthEntry): void {
	try {
		writeSecureAuthEntryToStore(getAuthSecretStore(), serverName, entry);
	} catch (error) {
		if (!shouldAttemptLinuxKeyringRecovery(error)) throw error;
		writeSecureAuthEntryToStore(linuxKeyringRecoveryAuthSecretStore, serverName, entry);
	}
}

/** Read the auth entry without mutating either credential store. */
function readAuthEntryFromStore(
	store: AuthSecretStore,
	serverName: string,
	options?: AuthStorageOptions,
): AuthEntry | undefined {
	const account = getAuthEntryAccount(serverName);
	let payload: string | undefined;
	try {
		payload = store.read(account);
	} catch (error) {
		throw new OAuthCredentialStoreError(
			`Failed to read OAuth credentials for ${serverName} from the OS secure credential store`,
			"read",
			error,
		);
	}

	if (payload !== undefined) {
		const manifest = readChunkManifestFromPayload(serverName, payload, "OS secure credential store");
		const entry = manifest
			? readChunkedAuthEntry(store, serverName, account, manifest)
			: parseAuthEntryPayload(serverName, payload, "OS secure credential store");
		return entry;
	}

	return readLegacyAuthEntry(serverName, options);
}

function readAuthEntry(serverName: string, options?: AuthStorageOptions): AuthEntry | undefined {
	try {
		return readAuthEntryFromStore(getAuthSecretStore(), serverName, options);
	} catch (error) {
		if (!shouldAttemptLinuxKeyringRecovery(error)) throw error;
		return readAuthEntryFromStore(linuxKeyringRecoveryAuthSecretStore, serverName, options);
	}
}

/**
 * Get auth entry for a server.
 */
export function getAuthEntry(serverName: string, options?: AuthStorageOptions): AuthEntry | undefined {
	return readAuthEntry(serverName, options);
}

/**
 * Get auth entry and validate it's for the correct URL.
 * Returns undefined if URL has changed (credentials are invalid).
 */
export function getAuthForUrl(
	serverName: string,
	serverUrl: string,
	options?: AuthStorageOptions,
): AuthEntry | undefined {
	const entry = getAuthEntry(serverName, options);
	return entry?.serverUrl && entry.serverUrl === serverUrl ? entry : undefined;
}

/**
 * Inspect credentials for status-only UI paths without treating an unavailable
 * secure store as missing credentials. Authentication operations continue to
 * use getAuthForUrl() directly and therefore remain fail-closed.
 */
export function inspectAuthForUrl(
	serverName: string,
	serverUrl: string,
	options?: AuthStorageOptions,
): OAuthCredentialStatus {
	try {
		const entry = readAuthEntry(serverName, options);
		if (!entry?.serverUrl || entry.serverUrl !== serverUrl) return { status: "absent" };
		return { status: "present", entry };
	} catch (error) {
		if (!(error instanceof OAuthCredentialStoreError)) throw error;
		return { status: "unavailable", message: formatOAuthCredentialStoreUnavailable(error) };
	}
}

/**
 * Save auth entry for a server.
 */
export function saveAuthEntry(
	serverName: string,
	entry: AuthEntry,
	serverUrl?: string,
	options?: AuthStorageOptions,
): void {
	// Always update serverUrl if provided
	if (serverUrl) {
		entry.serverUrl = serverUrl;
	}
	writeSecureAuthEntry(serverName, entry);
	removeLegacyAuthEntry(serverName, options);
}

/**
 * Remove auth entry for a server.
 */
function removeAuthEntryFromStore(store: AuthSecretStore, serverName: string): void {
	const account = getAuthEntryAccount(serverName);
	try {
		const payload = store.read(account);
		const manifest =
			payload === undefined
				? undefined
				: readChunkManifestFromPayload(serverName, payload, "OS secure credential store");
		if (manifest) removeChunkPayloads(store, account, manifest);
		store.remove(account);
	} catch (error) {
		throw new OAuthCredentialStoreError(
			`Failed to remove OAuth credentials for ${serverName} from the OS secure credential store`,
			"remove",
			error,
		);
	}
}

export function removeAuthEntry(serverName: string, options?: AuthStorageOptions): void {
	try {
		removeAuthEntryFromStore(getAuthSecretStore(), serverName);
	} catch (error) {
		if (!shouldAttemptLinuxKeyringRecovery(error)) throw error;
		removeAuthEntryFromStore(linuxKeyringRecoveryAuthSecretStore, serverName);
	}
	removeLegacyAuthEntry(serverName, options);
}

function getAuthEntryForUpdate(
	serverName: string,
	serverUrl: string | undefined,
	options: AuthStorageOptions | undefined,
): AuthEntry {
	const entry = getAuthEntry(serverName, options) ?? {};
	return serverUrl && entry.serverUrl !== serverUrl ? {} : entry;
}

type ClearableAuthField = "clientInfo" | "codeVerifier" | "oauthState" | "tokens";

function clearAuthField(serverName: string, field: ClearableAuthField, options?: AuthStorageOptions): void {
	const entry = getAuthEntry(serverName, options);
	if (!entry) return;
	delete entry[field];
	saveAuthEntry(serverName, entry, undefined, options);
}

/**
 * Update tokens for a server.
 */
export function updateTokens(
	serverName: string,
	tokens: StoredTokens,
	serverUrl?: string,
	options?: AuthStorageOptions,
): void {
	const entry = getAuthEntryForUpdate(serverName, serverUrl, options);
	entry.tokens = tokens;
	saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Update client info for a server.
 */
export function updateClientInfo(
	serverName: string,
	clientInfo: StoredClientInfo,
	serverUrl?: string,
	options?: AuthStorageOptions,
): void {
	const entry = getAuthEntryForUpdate(serverName, serverUrl, options);
	entry.clientInfo = clientInfo;
	saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Update code verifier for a server.
 */
export function updateCodeVerifier(
	serverName: string,
	codeVerifier: string,
	serverUrl?: string,
	options?: AuthStorageOptions,
): void {
	const entry = getAuthEntryForUpdate(serverName, serverUrl, options);
	entry.codeVerifier = codeVerifier;
	saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Clear code verifier for a server.
 */
export function clearCodeVerifier(serverName: string, options?: AuthStorageOptions): void {
	clearAuthField(serverName, "codeVerifier", options);
}

/**
 * Update OAuth state for a server.
 */
export function updateOAuthState(
	serverName: string,
	state: string,
	serverUrl?: string,
	options?: AuthStorageOptions,
): void {
	const entry = getAuthEntryForUpdate(serverName, serverUrl, options);
	entry.oauthState = state;
	saveAuthEntry(serverName, entry, serverUrl, options);
}

/**
 * Get OAuth state for a server.
 */
export function getOAuthState(serverName: string, options?: AuthStorageOptions): string | undefined {
	return getAuthEntry(serverName, options)?.oauthState;
}

/**
 * Clear OAuth state for a server.
 */
export function clearOAuthState(serverName: string, options?: AuthStorageOptions): void {
	clearAuthField(serverName, "oauthState", options);
}

/**
 * Check if stored tokens are expired.
 * Returns null if no tokens exist, false if no expiry or not expired, true if expired.
 */
export function isTokenExpired(serverName: string, options?: AuthStorageOptions): boolean | null {
	const entry = getAuthEntry(serverName, options);
	if (!entry?.tokens) return null;
	if (!entry.tokens.expiresAt) return false;
	return entry.tokens.expiresAt < Date.now() / 1000;
}

/**
 * Check if a server has stored tokens.
 */
export function hasStoredTokens(serverName: string, options?: AuthStorageOptions): boolean {
	return Boolean(getAuthEntry(serverName, options)?.tokens);
}

/**
 * Clear all credentials for a server.
 */
export function clearAllCredentials(serverName: string, options?: AuthStorageOptions): void {
	removeAuthEntry(serverName, options);
}

/**
 * Clear only client info for a server.
 */
export function clearClientInfo(serverName: string, options?: AuthStorageOptions): void {
	clearAuthField(serverName, "clientInfo", options);
}

/**
 * Clear only tokens for a server.
 */
export function clearTokens(serverName: string, options?: AuthStorageOptions): void {
	clearAuthField(serverName, "tokens", options);
}
