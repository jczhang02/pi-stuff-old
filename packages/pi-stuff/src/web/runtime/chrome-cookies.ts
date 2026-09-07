import { execFile } from "node:child_process";
import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import type { SQLOutputValue } from "node:sqlite";
import * as Effect from "effect/Effect";
import type { JsonInputValue } from "../../shared/json-value.ts";
import { isJsonInputObject, type JsonInputObject, parseJsonValue } from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { isBrowserCookieAccessAllowed } from "./gemini-web-config.ts";

export type CookieMap = Record<string, string>;

interface BrowserConfig {
	name: string;
	baseDir: string;
	keychainService?: string;
	keychainAccount?: string;
	secretToolApp?: string;
}

type SqliteRow = JsonInputObject;
type SqliteFailure = "unavailable" | "query";

interface CookieSearchOutcome {
	readonly missingRequiredCookies: boolean;
	readonly requestedProfile: string | undefined;
	readonly sawBackendFailure: SqliteFailure | undefined;
	readonly sawCookieDatabase: boolean;
	readonly sawUnsafeProfilePath: boolean;
	readonly warningSet: ReadonlySet<string>;
}

const GOOGLE_ORIGINS = ["https://gemini.google.com", "https://accounts.google.com", "https://www.google.com"];

const ALL_COOKIE_NAMES = new Set([
	"__Secure-1PSID",
	"__Secure-1PSIDTS",
	"__Secure-1PSIDCC",
	"__Secure-1PAPISID",
	"NID",
	"AEC",
	"SOCS",
	"__Secure-BUCKET",
	"__Secure-ENID",
	"SID",
	"HSID",
	"SSID",
	"APISID",
	"SAPISID",
	"__Secure-3PSID",
	"__Secure-3PSIDTS",
	"__Secure-3PAPISID",
	"SIDCC",
]);

const MACOS_BROWSER_CONFIGS: BrowserConfig[] = [
	{
		name: "Helium",
		baseDir: "Library/Application Support/net.imput.helium",
		keychainService: "Helium Storage Key",
		keychainAccount: "Helium",
	},
	{
		name: "Chrome",
		baseDir: "Library/Application Support/Google/Chrome",
		keychainService: "Chrome Safe Storage",
		keychainAccount: "Chrome",
	},
	{
		name: "Arc",
		baseDir: "Library/Application Support/Arc/User Data",
		keychainService: "Arc Safe Storage",
		keychainAccount: "Arc",
	},
];

const LINUX_BROWSER_CONFIGS: BrowserConfig[] = [
	{ name: "Chromium", baseDir: ".config/chromium", secretToolApp: "chromium" },
	{ name: "Chrome", baseDir: ".config/google-chrome", secretToolApp: "chrome" },
];

const browserPasswordCache = new Map<string, string>();
let lastCookieDiagnostic: string | null = null;
let sqliteModule: typeof import("node:sqlite") | null = null;
let sqliteImportAttempted = false;

export function getLastGoogleCookieDiagnostic(): string | null {
	return lastCookieDiagnostic;
}

async function getGoogleCookiesNative(
	options:
		| {
				profile?: string | undefined;
				requiredCookies?: string[];
		  }
		| undefined,
	signal: AbortSignal,
): Promise<{ cookies: CookieMap; warnings: string[] } | null> {
	signal.throwIfAborted();
	lastCookieDiagnostic = null;
	if (!isBrowserCookieAccessAllowed()) {
		lastCookieDiagnostic = "Browser cookie access is disabled; enable allowBrowserCookies to use Gemini Web cookies.";
		return null;
	}

	const currentPlatform = platform();
	const configs =
		currentPlatform === "darwin" ? MACOS_BROWSER_CONFIGS : currentPlatform === "linux" ? LINUX_BROWSER_CONFIGS : [];
	if (configs.length === 0) {
		lastCookieDiagnostic = "Chromium cookie extraction is unsupported on this platform.";
		return null;
	}

	const warningSet = new Set<string>();
	const requestedProfile = normalizeProfileName(options?.profile);
	if (!requestedProfile && isRuntimeString(options?.profile) && options.profile.trim()) {
		lastCookieDiagnostic = "Configured Chromium profile must be a profile directory name, not a path.";
		return null;
	}
	const requiredCookies = normalizeCookieNames(options?.requiredCookies);
	const hosts = GOOGLE_ORIGINS.map((origin) => new URL(origin).hostname);
	const home = homedir();
	let sawCookieDatabase = false;
	let sawRequiredCookies = false;
	let sawBackendFailure: SqliteFailure | undefined;
	let sawUnsafeProfilePath = false;

	for (const config of configs) {
		signal.throwIfAborted();
		const profiles = requestedProfile ? [requestedProfile] : listBrowserProfiles(home, config);
		for (const profile of profiles) {
			signal.throwIfAborted();
			const profilePath = resolveProfilePath(home, config, profile);
			if (profilePath === "outside-root") {
				sawUnsafeProfilePath = true;
				continue;
			}
			if (!profilePath) continue;
			const cookiesPath = join(profilePath, "Cookies");
			sawCookieDatabase = true;

			const tempDir = mkdtempSync(join(tmpdir(), "pi-chrome-cookies-"));
			try {
				const tempDb = join(tempDir, "Cookies");
				copyFileSync(cookiesPath, tempDb);
				copySidecar(cookiesPath, tempDb, "-wal");
				copySidecar(cookiesPath, tempDb, "-shm");

				if (requiredCookies?.length) {
					const preflight = await hasCookieNames(tempDb, hosts, requiredCookies, signal);
					if (preflight.failure) sawBackendFailure = preflight.failure;
					if (!preflight.present) continue;
					sawRequiredCookies = true;
				}

				const password = await readBrowserPassword(config, currentPlatform, signal);
				if (!password) {
					warningSet.add(`Could not read ${config.name} cookie encryption password`);
					continue;
				}

				const key = pbkdf2Sync(password, "saltysalt", currentPlatform === "darwin" ? 1003 : 1, 16, "sha1");
				const metaVersion = await readMetaVersion(tempDb, signal);
				if (metaVersion.failure) sawBackendFailure = metaVersion.failure;
				if (metaVersion.value === null) continue;
				const rowsResult = await queryCookieRows(tempDb, hosts, ALL_COOKIE_NAMES, signal);
				if (rowsResult.status === "failure") {
					sawBackendFailure = rowsResult.failure;
					continue;
				}

				const cookies: CookieMap = {};
				for (const row of rowsResult.rows) {
					const name = isRuntimeString(row["name"]) ? row["name"] : "";
					if (!ALL_COOKIE_NAMES.has(name) || cookies[name]) continue;
					let value = isRuntimeString(row["value"]) && row["value"].length > 0 ? row["value"] : null;
					if (
						!value &&
						isRuntimeString(row["encrypted_value_hex"]) &&
						/^[0-9a-f]*$/i.test(row["encrypted_value_hex"])
					) {
						value = decryptCookieValue(
							Buffer.from(row["encrypted_value_hex"], "hex"),
							key,
							metaVersion.value >= 24,
						);
					}
					if (value) cookies[name] = value;
				}

				if (requiredCookies?.length && !requiredCookies.every((name) => Boolean(cookies[name]))) continue;
				return { cookies, warnings: [...warningSet] };
			} finally {
				rmSync(tempDir, { recursive: true, force: true });
			}
		}
	}

	lastCookieDiagnostic = unavailableCookieDiagnostic({
		missingRequiredCookies: Boolean(requiredCookies?.length) && !sawRequiredCookies,
		requestedProfile,
		sawBackendFailure,
		sawCookieDatabase,
		sawUnsafeProfilePath,
		warningSet,
	});
	return null;
}

function unavailableCookieDiagnostic(outcome: CookieSearchOutcome): string {
	if (outcome.sawBackendFailure === "unavailable") {
		return "SQLite backend unavailable: install sqlite3 or use a runtime with SQLite support.";
	}
	if (outcome.sawBackendFailure === "query") {
		return "SQLite query failed while reading the copied Chromium cookie database.";
	}
	if (outcome.sawUnsafeProfilePath) {
		return "Configured Chromium profile must resolve inside the browser profile root.";
	}
	if (!outcome.sawCookieDatabase) {
		return outcome.requestedProfile
			? `Chromium profile '${outcome.requestedProfile}' does not contain a cookie database.`
			: "No detected Chromium profile contains a cookie database.";
	}
	if (outcome.missingRequiredCookies) return "No detected Chromium profile contains the required Gemini cookies.";
	return (
		outcome.warningSet.values().next().value ??
		"Required Gemini cookies were not available or could not be decrypted."
	);
}

export function getGoogleCookies(options?: { profile?: string | undefined; requiredCookies?: string[] }) {
	return Effect.tryPromise({
		try: (signal) => getGoogleCookiesNative(options, signal),
		catch: (error) => (error instanceof Error ? error : new Error(String(error))),
	});
}

function normalizeProfileName(value: string | undefined): string | undefined {
	if (!isRuntimeString(value)) return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (
		isAbsolute(normalized) ||
		normalized === "." ||
		normalized === ".." ||
		normalized.includes("/") ||
		normalized.includes("\\")
	) {
		return undefined;
	}
	return normalized;
}

function resolveProfilePath(home: string, config: BrowserConfig, profile: string): string | "outside-root" | null {
	const basePath = join(home, config.baseDir);
	const profilePath = join(basePath, profile);
	const cookiesPath = join(profilePath, "Cookies");
	if (!existsSync(cookiesPath)) return null;
	try {
		const baseRealPath = realpathSync(basePath);
		const profileRealPath = realpathSync(profilePath);
		if (profileRealPath !== baseRealPath && !profileRealPath.startsWith(`${baseRealPath}${sep}`))
			return "outside-root";
		return profileRealPath;
	} catch {
		return null;
	}
}

function normalizeCookieNames(names: string[] | undefined): string[] | undefined {
	if (!names?.length) return undefined;
	const normalized = names
		.filter((name): name is string => isRuntimeString(name))
		.map((name) => name.trim())
		.filter(Boolean);
	return normalized.length > 0 ? [...new Set(normalized)] : undefined;
}

function listBrowserProfiles(home: string, config: BrowserConfig): string[] {
	const basePath = join(home, config.baseDir);
	if (!existsSync(basePath)) return ["Default"];
	const profiles = new Set<string>();
	try {
		for (const entry of readdirSync(basePath, { withFileTypes: true })) {
			if (entry.isDirectory() && existsSync(join(basePath, entry.name, "Cookies"))) profiles.add(entry.name);
		}
	} catch {}
	if (profiles.size === 0) return ["Default"];
	return [...profiles].sort(compareProfileNames);
}

function compareProfileNames(a: string, b: string): number {
	const key = (name: string): [number, number] => {
		if (name === "Default") return [0, 0];
		const profile = /^Profile\s+(\d+)$/i.exec(name);
		if (profile) return [1, Number(profile[1])];
		const person = /^Person\s+(\d+)$/i.exec(name);
		if (person) return [2, Number(person[1])];
		return [3, Number.MAX_SAFE_INTEGER];
	};
	const [ap, ai] = key(a);
	const [bp, bi] = key(b);
	return ap - bp || ai - bi || a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });
}

function decryptCookieValue(encrypted: Uint8Array, key: Buffer, stripHash: boolean): string | null {
	const buf = Buffer.from(encrypted);
	if (buf.length < 3 || !/^v\d\d$/.test(buf.subarray(0, 3).toString("utf8"))) return null;
	const ciphertext = buf.subarray(3);
	if (!ciphertext.length) return "";
	try {
		const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
		decipher.setAutoPadding(false);
		const unpadded = removePkcs7Padding(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
		const bytes = stripHash && unpadded.length >= 32 ? unpadded.subarray(32) : unpadded;
		const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		let i = 0;
		while (i < decoded.length && decoded.charCodeAt(i) < 0x20) i++;
		return decoded.slice(i);
	} catch {
		return null;
	}
}

function removePkcs7Padding(buf: Buffer): Buffer {
	if (!buf.length) return buf;
	const padding = buf[buf.length - 1];
	return !padding || padding > 16 ? buf : buf.subarray(0, buf.length - padding);
}

async function readBrowserPassword(
	config: BrowserConfig,
	currentPlatform: ReturnType<typeof platform>,
	signal: AbortSignal,
): Promise<string | null> {
	const cacheKey = `${currentPlatform}:${config.name}`;
	const cached = browserPasswordCache.get(cacheKey);
	if (cached) return cached;
	const result =
		currentPlatform === "darwin"
			? config.keychainAccount && config.keychainService
				? { password: await readKeychainPassword(config.keychainAccount, config.keychainService, signal) }
				: { password: null }
			: currentPlatform === "linux"
				? await readLinuxPassword(config.secretToolApp, signal)
				: { password: null, cacheable: false };
	if (result.password && ("cacheable" in result ? result.cacheable : true)) {
		browserPasswordCache.set(cacheKey, result.password);
	}
	return result.password;
}

function readKeychainPassword(account: string, service: string, signal: AbortSignal): Promise<string | null> {
	return new Promise((resolve, reject) => {
		execFile(
			"security",
			["find-generic-password", "-w", "-a", account, "-s", service],
			{ timeout: 5000, signal },
			(err, stdout) => {
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				if (err) {
					resolve(null);
					return;
				}
				resolve(stdout.trim() || null);
			},
		);
	});
}

function readLinuxPassword(
	secretToolApp: string | undefined,
	signal: AbortSignal,
): Promise<{ password: string; cacheable: boolean }> {
	if (!secretToolApp) return Promise.resolve({ password: "peanuts", cacheable: true });
	return new Promise((resolve, reject) => {
		execFile("secret-tool", ["lookup", "application", secretToolApp], { timeout: 5000, signal }, (err, stdout) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			if (err) {
				resolve({ password: "peanuts", cacheable: false });
				return;
			}
			const password = stdout.trim();
			resolve(password ? { password, cacheable: true } : { password: "peanuts", cacheable: false });
		});
	});
}

async function importSqlite(): Promise<typeof import("node:sqlite") | null> {
	if (process.env["PI_WEB_ACCESS_DISABLE_NODE_SQLITE"] === "1") return null;
	if (sqliteImportAttempted) return sqliteModule;
	sqliteImportAttempted = true;
	const originalEmitWarning = process.emitWarning;
	process.emitWarning = new Proxy(originalEmitWarning, {
		apply(target, _thisArgument, argumentsList) {
			const warning = argumentsList[0];
			const msg = isRuntimeString(warning) ? warning : warning instanceof Error ? warning.message : "";
			if (msg.includes("SQLite is an experimental feature")) return;
			switch (argumentsList.length) {
				case 1:
					return target(warning);
				case 2:
					return target(warning, argumentsList[1]);
				case 3:
					return target(warning, argumentsList[1], argumentsList[2]);
				default:
					return target(warning, argumentsList[1], argumentsList[2], argumentsList[3]);
			}
		},
	});
	try {
		sqliteModule = await import("node:sqlite");
	} catch {
		sqliteModule = null;
	} finally {
		process.emitWarning = originalEmitWarning;
	}
	return sqliteModule;
}

type QueryResult = { status: "success"; rows: SqliteRow[] } | { status: "failure"; failure: SqliteFailure };

async function runSqliteQuery(dbPath: string, sql: string, signal: AbortSignal): Promise<QueryResult> {
	signal.throwIfAborted();
	const sqlite = await importSqlite();
	let queryFailed = false;
	if (sqlite) {
		try {
			const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
			try {
				const rows = db.prepare(sql).all();
				if (!isSqliteRows(rows)) throw new TypeError("SQLite returned non-object rows");
				return { status: "success", rows };
			} finally {
				db.close();
			}
		} catch {
			queryFailed = true;
		}
	}

	const cli = await runSqliteCli(dbPath, sql, signal);
	if (cli.status === "success") return cli;
	if (cli.failure === "query") queryFailed = true;
	const python = await runPythonSqlite(dbPath, sql, signal);
	if (python.status === "success") return python;
	if (python.failure === "query") queryFailed = true;
	return { status: "failure", failure: queryFailed ? "query" : "unavailable" };
}

function runSqliteCli(dbPath: string, sql: string, signal: AbortSignal): Promise<QueryResult> {
	return new Promise((resolve, reject) => {
		execFile(
			"sqlite3",
			["-readonly", "-json", dbPath, sql],
			{ timeout: 5000, maxBuffer: 1024 * 1024, signal },
			(err, stdout) => {
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				if (err) {
					resolve({ status: "failure", failure: err.code === "ENOENT" ? "unavailable" : "query" });
					return;
				}
				try {
					const parsed = parseJsonValue(stdout || "[]");
					resolve(
						isSqliteRows(parsed) ? { status: "success", rows: parsed } : { status: "failure", failure: "query" },
					);
				} catch {
					resolve({ status: "failure", failure: "query" });
				}
			},
		);
	});
}

function runPythonSqlite(dbPath: string, sql: string, signal: AbortSignal): Promise<QueryResult> {
	const script =
		"import json,sqlite3,sys\ntry:\n c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)\n c.row_factory=sqlite3.Row\n print(json.dumps([dict(r) for r in c.execute(sys.argv[2]).fetchall()]))\nexcept Exception:\n sys.exit(1)";
	return new Promise((resolve, reject) => {
		execFile(
			"python3",
			["-c", script, dbPath, sql],
			{ timeout: 5000, maxBuffer: 1024 * 1024, signal },
			(err, stdout) => {
				if (signal.aborted) {
					reject(signal.reason);
					return;
				}
				if (err) {
					resolve({ status: "failure", failure: err.code === "ENOENT" ? "unavailable" : "query" });
					return;
				}
				try {
					const parsed = parseJsonValue(stdout || "[]");
					resolve(
						isSqliteRows(parsed) ? { status: "success", rows: parsed } : { status: "failure", failure: "query" },
					);
				} catch {
					resolve({ status: "failure", failure: "query" });
				}
			},
		);
	});
}

function isSqliteRows(value: JsonInputValue | Record<string, SQLOutputValue>[]): value is SqliteRow[] {
	return Array.isArray(value) && value.every(isJsonInputObject);
}

async function readMetaVersion(
	dbPath: string,
	signal: AbortSignal,
): Promise<{ value: number | null; failure?: SqliteFailure }> {
	const result = await runSqliteQuery(dbPath, "SELECT value FROM meta WHERE key = 'version'", signal);
	if (result.status === "failure") {
		return result.failure === "unavailable" ? { value: null, failure: result.failure } : { value: 0 };
	}
	const value = result.rows[0]?.["value"];
	if (isRuntimeNumber(value)) return { value: Math.floor(value) };
	if (isRuntimeString(value)) return { value: parseInt(value, 10) || 0 };
	return { value: 0 };
}

async function hasCookieNames(
	dbPath: string,
	hosts: string[],
	names: string[],
	signal: AbortSignal,
): Promise<{ present: boolean; failure?: SqliteFailure }> {
	const result = await runSqliteQuery(
		dbPath,
		`SELECT DISTINCT name FROM cookies WHERE ${buildCookieWhere(hosts, names)}`,
		signal,
	);
	if (result.status === "failure") return { present: false, failure: result.failure };
	const present = new Set(result.rows.map((row) => (isRuntimeString(row["name"]) ? row["name"] : "")));
	return { present: names.every((name) => present.has(name)) };
}

async function queryCookieRows(
	dbPath: string,
	hosts: string[],
	names: Iterable<string>,
	signal: AbortSignal,
): Promise<QueryResult> {
	return runSqliteQuery(
		dbPath,
		`SELECT name, value, host_key, hex(encrypted_value) AS encrypted_value_hex FROM cookies WHERE ${buildCookieWhere(hosts, names)} ORDER BY expires_utc DESC`,
		signal,
	);
}

function buildCookieWhere(hosts: string[], cookieNames?: Iterable<string>): string {
	const hostClauses: string[] = [];
	for (const host of hosts) {
		for (const candidate of expandHosts(host)) {
			const escaped = escapeSqlString(candidate);
			hostClauses.push(`host_key = '${escaped}'`, `host_key = '.${escaped}'`, `host_key LIKE '%.${escaped}'`);
		}
	}
	let where = `(${hostClauses.join(" OR ")})`;
	const names = cookieNames ? [...cookieNames].filter(Boolean) : [];
	if (names.length) where += ` AND name IN (${names.map((name) => `'${escapeSqlString(name)}'`).join(", ")})`;
	return where;
}

function escapeSqlString(value: string): string {
	return value.replaceAll("'", "''");
}

function expandHosts(host: string): string[] {
	const parts = host.split(".").filter(Boolean);
	if (parts.length <= 1) return [host];
	const candidates = new Set([host]);
	for (let i = 1; i <= parts.length - 2; i++) candidates.add(parts.slice(i).join("."));
	return [...candidates];
}

function copySidecar(srcDb: string, targetDb: string, suffix: string): void {
	const sidecar = `${srcDb}${suffix}`;
	if (!existsSync(sidecar)) return;
	try {
		copyFileSync(sidecar, `${targetDb}${suffix}`);
	} catch {}
}
