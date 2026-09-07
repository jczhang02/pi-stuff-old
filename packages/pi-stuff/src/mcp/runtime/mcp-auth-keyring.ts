/** OS credential-store loading and Linux revoked-key recovery. */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isJsonInputObject, type JsonInputValue, parseJsonValue } from "../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeFunction, isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";

const require = createRequire(import.meta.url);
const AUTH_SECRET_SERVICE = "pi-mcp-adapter.oauth";
const TEST_AUTH_STORE_ENV = "PI_MCP_ADAPTER_TEST_AUTH_STORE";
const KEYRING_RECOVERY_DISABLED_ENV = "PI_MCP_ADAPTER_DISABLE_KEYRING_RECOVERY";
const KEYRING_RECOVERY_KEYCTL_ENV = "PI_MCP_ADAPTER_KEYRING_RECOVERY_KEYCTL";
const KEYRING_RECOVERY_NODE_ENV = "PI_MCP_ADAPTER_KEYRING_RECOVERY_NODE";
const KEYRING_RECOVERY_HELPER_ENV = "PI_MCP_ADAPTER_KEYRING_RECOVERY_HELPER";
const TEST_LINUX_KEYRING_RECOVERY_ENV = "PI_MCP_ADAPTER_TEST_LINUX_KEYRING_RECOVERY";
const KEYRING_RECOVERY_TIMEOUT_MS = 10_000;
const KEY_REVOKED_PATTERN = /key\s*(?:has been\s*)?revoked|keyrevoked/i;

interface KeyringEntry {
	getPassword(): string | null;
	setPassword(password: string): void;
	deleteCredential(): boolean;
}

type KeyringEntryConstructor = new (service: string, account: string) => KeyringEntry;
interface KeyringModuleExport {
	Entry?: JsonInputValue | KeyringEntryConstructor;
}
type KeyringRequire = ((id: string) => KeyringModuleExport) & { resolve(id: string): string };

export interface AuthSecretStore {
	read(account: string): string | undefined;
	write(account: string, payload: string): void;
	remove(account: string): void;
}

let KeyringEntryClass: KeyringEntryConstructor | undefined;
const memoryAuthEntries = new Map<string, string>();

const memoryAuthSecretStore: AuthSecretStore = {
	read(account) {
		return memoryAuthEntries.get(account);
	},
	write(account, payload) {
		memoryAuthEntries.set(account, payload);
	},
	remove(account) {
		memoryAuthEntries.delete(account);
	},
};

const keyringAuthSecretStore: AuthSecretStore = {
	read(account) {
		return getKeyringEntry(account).getPassword() ?? undefined;
	},
	write(account, payload) {
		getKeyringEntry(account).setPassword(payload);
	},
	remove(account) {
		getKeyringEntry(account).deleteCredential();
	},
};

const unavailableAuthSecretStore: AuthSecretStore = {
	read() {
		throw new Error("simulated secure credential store unavailable");
	},
	write() {
		throw new Error("simulated secure credential store unavailable");
	},
	remove() {
		throw new Error("simulated secure credential store unavailable");
	},
};

function createKeyRevokedTestError(): Error {
	return new Error("Couldn't access platform storage: KeyRevoked", { cause: new Error("KeyRevoked") });
}

const keyRevokedAuthSecretStore: AuthSecretStore = {
	read() {
		throw createKeyRevokedTestError();
	},
	write() {
		throw createKeyRevokedTestError();
	},
	remove() {
		throw createKeyRevokedTestError();
	},
};

export function resetTestAuthSecretStore(): void {
	memoryAuthEntries.clear();
}

export function getTestAuthSecretStoreEntries(): [string, string][] {
	return [...memoryAuthEntries.entries()];
}

export function removeTestAuthSecretStoreEntry(account: string): void {
	memoryAuthEntries.delete(account);
}

export function getAuthSecretStore(): AuthSecretStore {
	if (process.env[TEST_AUTH_STORE_ENV] === "memory") return memoryAuthSecretStore;
	if (process.env[TEST_AUTH_STORE_ENV] === "unavailable") return unavailableAuthSecretStore;
	if (process.env[TEST_AUTH_STORE_ENV] === "keyrevoked") return keyRevokedAuthSecretStore;
	return keyringAuthSecretStore;
}

function getKeyringEntry(account: string): KeyringEntry {
	try {
		KeyringEntryClass ??= loadKeyringEntryClass();
		return new KeyringEntryClass(AUTH_SECRET_SERVICE, account);
	} catch (error) {
		throw new Error(
			"OAuth secure credential storage is unavailable. Configure the OS credential store and retry authentication.",
			{ cause: error },
		);
	}
}

function loadKeyringEntryClass(
	keyringRequire: KeyringRequire = require,
	platform: NodeJS.Platform = process.platform,
	arch: NodeJS.Architecture = process.arch,
): KeyringEntryConstructor {
	try {
		return parseKeyringEntry(keyringRequire("@napi-rs/keyring"));
	} catch (loaderError) {
		try {
			return loadKeyringNativeBindingFallback(keyringRequire, platform, arch);
		} catch (fallbackError) {
			throw new Error(
				`Failed to load @napi-rs/keyring; absolute-path native binding fallback also failed: ${formatErrorMessage(fallbackError)}`,
				{ cause: loaderError },
			);
		}
	}
}

function loadKeyringNativeBindingFallback(
	keyringRequire: KeyringRequire,
	platform: NodeJS.Platform,
	arch: NodeJS.Architecture,
): KeyringEntryConstructor {
	const suffixes = getKeyringNativeBindingSuffixes(platform, arch);
	if (suffixes.length === 0) {
		throw new Error(`Unsupported @napi-rs/keyring native binding target: ${platform}-${arch}`);
	}

	let lastError: Error | undefined;
	for (const suffix of suffixes) {
		try {
			const packageJsonPath = keyringRequire.resolve(`@napi-rs/keyring-${suffix}/package.json`);
			return parseKeyringEntry(keyringRequire(join(dirname(packageJsonPath), `keyring.${suffix}.node`)));
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
		}
	}

	throw lastError ?? new Error("Failed to load the keyring native binding");
}

function parseKeyringEntry(value: KeyringModuleExport): KeyringEntryConstructor {
	if (!isRuntimeFunction(value.Entry)) throw new Error("Keyring native binding did not export Entry");
	return value.Entry;
}

function getKeyringNativeBindingSuffixes(platform: NodeJS.Platform, arch: NodeJS.Architecture): string[] {
	if (platform === "darwin") {
		if (arch === "arm64") return ["darwin-arm64"];
		if (arch === "x64") return ["darwin-x64"];
	}
	if (platform === "win32") {
		if (arch === "arm64") return ["win32-arm64-msvc"];
		if (arch === "x64") return ["win32-x64-msvc"];
		if (arch === "ia32") return ["win32-ia32-msvc"];
	}
	if (platform === "linux") {
		if (arch === "arm64") return ["linux-arm64-gnu", "linux-arm64-musl"];
		if (arch === "arm") return ["linux-arm-gnueabihf"];
		if (arch === "riscv64") return ["linux-riscv64-gnu"];
		if (arch === "x64") return ["linux-x64-gnu", "linux-x64-musl"];
	}
	if (platform === "freebsd" && arch === "x64") return ["freebsd-x64"];
	return [];
}

function formatErrorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function isRevokedKeyringError(cause: unknown): boolean {
	const seen = new Set<object>();
	let current: unknown = cause;
	while (isRuntimeObject(current) && current !== null) {
		if (seen.has(current)) break;
		seen.add(current);
		let fields: unknown[];
		let next: unknown;
		try {
			fields = ["name", "message", "code"].map((key) => Object.getOwnPropertyDescriptor(current, key)?.value);
			next = Object.getOwnPropertyDescriptor(current, "cause")?.value;
		} catch {
			return false;
		}
		if (fields.some((value) => isRuntimeString(value) && KEY_REVOKED_PATTERN.test(value))) return true;
		current = next;
	}
	return false;
}

export function shouldAttemptLinuxKeyringRecovery(cause: unknown): boolean {
	return (
		process.env[KEYRING_RECOVERY_DISABLED_ENV] !== "1" &&
		(process.platform === "linux" || process.env[TEST_LINUX_KEYRING_RECOVERY_ENV] === "1") &&
		isRevokedKeyringError(cause)
	);
}

type KeyringRecoveryOperation = "read" | "write" | "remove";
type KeyringRecoveryResult = { found?: boolean; value?: string };

function runLinuxKeyringRecoveryOperation(
	operation: KeyringRecoveryOperation,
	account: string,
	payload?: string,
): KeyringRecoveryResult {
	const keyctl = process.env[KEYRING_RECOVERY_KEYCTL_ENV]?.trim() || "keyctl";
	const node = process.env[KEYRING_RECOVERY_NODE_ENV]?.trim() || "node";
	const helper =
		process.env[KEYRING_RECOVERY_HELPER_ENV]?.trim() ||
		fileURLToPath(new URL("./mcp-keyring-helper.cjs", import.meta.url));
	const request = JSON.stringify({ operation, service: AUTH_SECRET_SERVICE, account, payload });
	const result = spawnSync(keyctl, ["session", "-", node, helper], {
		input: `${request}\n`,
		encoding: "utf8",
		maxBuffer: 1024 * 1024,
		timeout: KEYRING_RECOVERY_TIMEOUT_MS,
		windowsHide: true,
	});

	if (result.error) {
		throw new Error(`Linux keyring recovery helper could not start: ${result.error.message}`, {
			cause: result.error,
		});
	}
	if (result.status !== 0) {
		throw new Error(`Linux keyring recovery helper failed with exit code ${result.status ?? "unknown"}`);
	}

	let response: JsonInputValue;
	try {
		response = parseJsonValue(result.stdout.trim());
	} catch (error) {
		throw new Error("Linux keyring recovery helper returned invalid JSON", { cause: error });
	}
	if (!isJsonInputObject(response) || !isRuntimeBoolean(response["ok"])) {
		throw new Error("Linux keyring recovery helper returned an invalid response");
	}
	const responseError = isRuntimeString(response["error"]) ? response["error"] : undefined;
	if (response["ok"] === false) {
		if (response["error"] !== undefined && responseError === undefined) {
			throw new Error("Linux keyring recovery helper returned an invalid error response");
		}
		throw new Error(responseError || "Linux keyring recovery helper failed");
	}
	if (response["found"] !== undefined && !isRuntimeBoolean(response["found"])) {
		throw new Error("Linux keyring recovery helper returned an invalid found flag");
	}
	if (response["value"] !== undefined && !isRuntimeString(response["value"])) {
		throw new Error("Linux keyring recovery helper returned an invalid read response");
	}
	if (operation === "read" && response["found"] === true && response["value"] === undefined) {
		throw new Error("Linux keyring recovery helper returned an invalid read response");
	}
	const recovery: KeyringRecoveryResult = {};
	const found = isRuntimeBoolean(response["found"]) ? response["found"] : undefined;
	const value = isRuntimeString(response["value"]) ? response["value"] : undefined;
	if (found !== undefined) recovery.found = found;
	if (value !== undefined) recovery.value = value;
	return recovery;
}

export const linuxKeyringRecoveryAuthSecretStore: AuthSecretStore = {
	read(account) {
		const response = runLinuxKeyringRecoveryOperation("read", account);
		return response.found === true ? response.value : undefined;
	},
	write(account, payload) {
		runLinuxKeyringRecoveryOperation("write", account, payload);
	},
	remove(account) {
		runLinuxKeyringRecoveryOperation("remove", account);
	},
};

export function loadTestKeyringEntryClass(
	keyringRequire: KeyringRequire,
	platform: NodeJS.Platform,
	arch: NodeJS.Architecture,
): KeyringEntryConstructor {
	return loadKeyringEntryClass(keyringRequire, platform, arch);
}
