// npx-resolver.ts - Resolve npx/npm exec binaries to avoid npm parent processes

import { spawn, spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, extname, join, resolve, sep } from "node:path";
import { isJsonInputObject, parseJsonObject } from "../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeString } from "../../shared/runtime-type.ts";
import { piStuffCachePath } from "../../xdg/index.ts";
import { throwIfAborted } from "./abort.ts";

const CACHE_VERSION = 1;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";
const EXACT_PACKAGE_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/;

interface NpxCacheEntry {
	resolvedBin: string;
	resolvedAt: number;
	packageVersion?: string;
	isJs: boolean;
}

interface NpxCache {
	version: number;
	entries: Record<string, NpxCacheEntry>;
}

interface NpmPackageJson {
	bin?: string | Record<string, string>;
	version?: string;
}

export interface NpxResolution {
	binPath: string;
	extraArgs: string[];
	isJs: boolean;
}

interface ParsedInvocation {
	packageSpec: string;
	binName?: string;
	extraArgs: string[];
}

interface ParsedPackageSpec {
	packageName: string;
	exactVersion?: string;
}

export async function resolveNpxBinary(
	command: string,
	args: string[],
	signal?: AbortSignal,
): Promise<NpxResolution | null> {
	throwIfAborted(signal);
	const parsed = command === "npx" ? parseNpxArgs(args) : command === "npm" ? parseNpmExecArgs(args) : null;

	if (!parsed) return null;

	const packageSpec = parsePackageSpec(parsed.packageSpec);
	const cacheKey = JSON.stringify([command, ...args]);
	const cache = loadCache();
	const cached = cache?.entries?.[cacheKey];

	if (
		cached &&
		Date.now() - cached.resolvedAt < CACHE_TTL_MS &&
		existsSync(cached.resolvedBin) &&
		(!packageSpec?.exactVersion || cached.packageVersion === packageSpec.exactVersion)
	) {
		return { binPath: cached.resolvedBin, extraArgs: parsed.extraArgs, isJs: cached.isJs };
	}

	const resolved = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
	if (resolved) {
		saveCacheEntry(cacheKey, resolved);
		return { binPath: resolved.resolvedBin, extraArgs: parsed.extraArgs, isJs: resolved.isJs };
	}

	// Slow path: force npx cache population
	await forceNpxCache(parsed.packageSpec, signal);
	const resolvedAfterInstall = resolveFromNpmCache(parsed.packageSpec, parsed.binName);
	if (resolvedAfterInstall) {
		saveCacheEntry(cacheKey, resolvedAfterInstall);
		return {
			binPath: resolvedAfterInstall.resolvedBin,
			extraArgs: parsed.extraArgs,
			isJs: resolvedAfterInstall.isJs,
		};
	}

	return null;
}

function parseNpxArgs(args: string[]): ParsedInvocation | null {
	const separatorIndex = args.indexOf("--");
	const before = separatorIndex >= 0 ? args.slice(0, separatorIndex) : args;
	const after = separatorIndex >= 0 ? args.slice(separatorIndex + 1) : [];

	const positionals: string[] = [];
	let packageSpec: string | undefined;
	let sawPackageFlag = false;
	let foundFirstPositional = false;

	for (let i = 0; i < before.length; i++) {
		const arg = before[i];
		if (arg === undefined) return null;
		if (foundFirstPositional) {
			positionals.push(arg);
			continue;
		}
		if (arg === "-y" || arg === "--yes") continue;
		if (arg === "-p" || arg === "--package") {
			const value = before[i + 1];
			if (!value || value.startsWith("-")) return null;
			if (!packageSpec) packageSpec = value;
			sawPackageFlag = true;
			i++;
			continue;
		}
		if (arg.startsWith("--package=")) {
			const value = arg.slice("--package=".length);
			if (!value) return null;
			if (!packageSpec) packageSpec = value;
			sawPackageFlag = true;
			continue;
		}
		if (arg.startsWith("-")) {
			return null;
		}
		positionals.push(arg);
		foundFirstPositional = true;
	}

	const separatedAfter = separatorIndex >= 0 && after.length > 0 ? ["--", ...after] : after;

	if (sawPackageFlag) {
		const binName = positionals[0];
		if (!packageSpec || !binName) return null;
		const extraArgs = positionals.slice(1).concat(separatedAfter);
		return { packageSpec, binName, extraArgs };
	}

	const packagePositional = positionals[0];
	if (!packagePositional) return null;
	const extraArgs = positionals.slice(1).concat(separatedAfter);
	return { packageSpec: packagePositional, extraArgs };
}

function parseNpmExecArgs(args: string[]): ParsedInvocation | null {
	if (args[0] !== "exec") return null;
	const execArgs = args.slice(1);
	const separatorIndex = execArgs.indexOf("--");
	if (separatorIndex < 0) return null;

	const before = execArgs.slice(0, separatorIndex);
	const after = execArgs.slice(separatorIndex + 1);

	let packageSpec: string | undefined;
	for (let i = 0; i < before.length; i++) {
		const arg = before[i];
		if (arg === undefined) return null;
		if (arg === "-y" || arg === "--yes") continue;
		if (arg === "--package") {
			const value = before[i + 1];
			if (!value || value.startsWith("-")) return null;
			if (!packageSpec) packageSpec = value;
			i++;
			continue;
		}
		if (arg.startsWith("--package=")) {
			const value = arg.slice("--package=".length);
			if (!value) return null;
			if (!packageSpec) packageSpec = value;
			continue;
		}
		if (arg.startsWith("-")) {
			return null;
		}
	}

	const binName = after[0];
	if (!packageSpec || !binName) return null;
	const extraArgs = after.slice(1);
	return { packageSpec, binName, extraArgs };
}

function resolveFromNpmCache(packageSpec: string, binName?: string): NpxCacheEntry | null {
	const cacheDir = getNpmCacheDir();
	if (!cacheDir) return null;

	const parsedSpec = parsePackageSpec(packageSpec);
	if (!parsedSpec) return null;

	const { packageName, exactVersion } = parsedSpec;
	const packageDir = findCachedPackageDir(cacheDir, packageName, exactVersion);
	if (!packageDir) return null;

	const packageJsonPath = join(packageDir, "package.json");
	if (!existsSync(packageJsonPath)) return null;

	let pkg: NpmPackageJson | null = null;
	try {
		pkg = parseNpmPackageJson(readFileSync(packageJsonPath, "utf-8"));
	} catch {
		return null;
	}

	const binField = pkg?.bin;
	if (!binField) return null;

	const candidates = buildBinCandidates(packageName, binName);
	let chosenBinName: string | undefined;
	let binRel: string | undefined;

	if (isRuntimeString(binField)) {
		chosenBinName = defaultBinName(packageName);
		binRel = binField;
	} else {
		for (const candidate of candidates) {
			if (binField[candidate]) {
				chosenBinName = candidate;
				binRel = binField[candidate];
				break;
			}
		}
		if (!binRel) {
			const firstEntry = Object.entries(binField)[0];
			if (firstEntry) {
				chosenBinName = firstEntry[0];
				binRel = firstEntry[1];
			}
		}
	}

	if (!binRel) return null;

	const nodeModulesDir = findNodeModulesDir(packageDir);
	const binLink = chosenBinName ? join(nodeModulesDir, ".bin", chosenBinName) : null;
	let resolvedBin = binLink && existsSync(binLink) ? safeRealpath(binLink) : "";
	if (!resolvedBin) {
		resolvedBin = resolve(packageDir, binRel);
		if (!existsSync(resolvedBin)) return null;
	}

	const isJs = detectJsBinary(resolvedBin);
	const entry: NpxCacheEntry = {
		resolvedBin,
		resolvedAt: Date.now(),
		isJs,
	};
	if (pkg?.version !== undefined) entry.packageVersion = pkg.version;
	return entry;
}

const FORCE_CACHE_TIMEOUT_MS = 30_000;

async function forceNpxCache(packageSpec: string, signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	try {
		await new Promise<void>((resolve, reject) => {
			const proc = spawn(NPM_COMMAND, ["exec", "--yes", "--package", packageSpec, "--", "node", "-e", "1"], {
				stdio: "ignore",
			});
			const timer = setTimeout(() => {
				proc.kill();
				reject(new Error("timeout"));
			}, FORCE_CACHE_TIMEOUT_MS);
			const abort = () => {
				proc.kill();
				reject(signal?.reason instanceof Error ? signal.reason : new Error("MCP request aborted"));
			};
			signal?.addEventListener("abort", abort, { once: true });
			timer.unref();
			proc.on("close", () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				resolve();
			});
			proc.on("error", (err) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", abort);
				reject(err);
			});
		});
	} catch {
		if (signal?.aborted) throwIfAborted(signal);
		// Ignore failures, resolution will fall back to original command
	}
	throwIfAborted(signal);
}

function buildBinCandidates(packageName: string, explicitBin?: string): string[] {
	const candidates: string[] = [];
	if (explicitBin) candidates.push(explicitBin);

	if (packageName.startsWith("@")) {
		const namePart = packageName.split("/")[1] ?? "";
		const scopePart = packageName.split("/")[0]?.replace("@", "") ?? "";
		if (namePart) candidates.push(namePart);
		if (scopePart && namePart) candidates.push(`${scopePart}-${namePart}`);
	} else {
		candidates.push(packageName);
	}

	return [...new Set(candidates.filter(Boolean))];
}

function parsePackageSpec(spec: string): ParsedPackageSpec | null {
	const trimmed = spec.trim();
	if (!trimmed) return null;

	let packageName: string;
	let requestedVersion: string | undefined;
	if (trimmed.startsWith("@")) {
		const slashIndex = trimmed.indexOf("/");
		if (slashIndex < 0) return null;
		const atIndex = trimmed.lastIndexOf("@");
		if (atIndex > slashIndex) {
			packageName = trimmed.slice(0, atIndex);
			requestedVersion = trimmed.slice(atIndex + 1);
		} else {
			packageName = trimmed;
		}
	} else {
		const atIndex = trimmed.indexOf("@");
		if (atIndex >= 0) {
			packageName = trimmed.slice(0, atIndex);
			requestedVersion = trimmed.slice(atIndex + 1);
		} else {
			packageName = trimmed;
		}
	}

	if (!packageName) return null;
	const normalizedVersion = requestedVersion?.replace(/^=/, "").replace(/^v/i, "");
	const exactVersion =
		normalizedVersion && EXACT_PACKAGE_VERSION_RE.test(normalizedVersion) ? normalizedVersion : undefined;
	const parsed: ParsedPackageSpec = { packageName };
	if (exactVersion !== undefined) parsed.exactVersion = exactVersion;
	return parsed;
}

function defaultBinName(packageName: string): string {
	if (packageName.startsWith("@")) {
		const parts = packageName.split("/");
		return parts[1] ?? packageName.replace("@", "").replace("/", "-");
	}
	return packageName;
}

function findCachedPackageDir(cacheDir: string, packageName: string, exactVersion?: string): string | null {
	const npxDir = join(cacheDir, "_npx");
	if (!existsSync(npxDir)) return null;

	const packagePathParts = packageName.startsWith("@") ? packageName.split("/") : [packageName];

	const candidates = readdirSync(npxDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => {
			const full = join(npxDir, entry.name);
			const mtime = safeStatMtime(full);
			return { name: entry.name, mtime };
		})
		.sort((a, b) => b.mtime - a.mtime);

	for (const entry of candidates) {
		const pkgDir = join(npxDir, entry.name, "node_modules", ...packagePathParts);
		const packageJsonPath = join(pkgDir, "package.json");
		if (!existsSync(packageJsonPath)) continue;
		if (exactVersion) {
			try {
				const pkg = parseNpmPackageJson(readFileSync(packageJsonPath, "utf-8"));
				if (pkg.version !== exactVersion) continue;
			} catch {
				continue;
			}
		}
		return pkgDir;
	}

	return null;
}

function findNodeModulesDir(packageDir: string): string {
	const parts = packageDir.split(sep);
	const idx = parts.lastIndexOf("node_modules");
	if (idx >= 0) {
		return parts.slice(0, idx + 1).join(sep);
	}
	return join(packageDir, "..");
}

function detectJsBinary(binPath: string): boolean {
	const ext = extname(binPath).toLowerCase();
	if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return true;
	try {
		const fd = openSync(binPath, "r");
		try {
			const buf = Buffer.alloc(256);
			readSync(fd, buf, 0, 256, 0);
			const firstLine = buf.toString("utf-8").split("\n")[0] ?? "";
			return firstLine.startsWith("#!") && firstLine.includes("node");
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

let npmCacheDirCached: string | null | undefined;

function getNpmCacheDir(): string | null {
	if (npmCacheDirCached !== undefined) return npmCacheDirCached;
	if (process.env["NPM_CONFIG_CACHE"]) {
		npmCacheDirCached = process.env["NPM_CONFIG_CACHE"];
		return npmCacheDirCached;
	}
	try {
		const result = spawnSync(NPM_COMMAND, ["config", "get", "cache"], { encoding: "utf-8" });
		if (result.status === 0) {
			const path = String(result.stdout).trim();
			npmCacheDirCached = path || null;
			return npmCacheDirCached;
		}
	} catch {
		npmCacheDirCached = null;
		return null;
	}
	npmCacheDirCached = null;
	return null;
}

export function getNpxCachePath(): string {
	return piStuffCachePath("mcp", "mcp-npx-cache.json");
}

function loadCache(): NpxCache | null {
	const cachePath = getNpxCachePath();
	if (!existsSync(cachePath)) return null;
	try {
		return parseNpxCache(readFileSync(cachePath, "utf-8"));
	} catch {
		return null;
	}
}

function saveCacheEntry(key: string, entry: NpxCacheEntry): void {
	const cachePath = getNpxCachePath();
	const dir = dirname(cachePath);
	mkdirSync(dir, { recursive: true });

	const merged: NpxCache = { version: CACHE_VERSION, entries: {} };
	try {
		if (existsSync(cachePath)) {
			const existing = parseNpxCache(readFileSync(cachePath, "utf-8"));
			if (existing) {
				merged.entries = { ...existing.entries };
			}
		}
	} catch {
		// Ignore parse errors
	}

	merged.entries[key] = entry;
	const tmpPath = `${cachePath}.${process.pid}.tmp`;
	writeFileSync(tmpPath, JSON.stringify(merged, null, 2), "utf-8");
	renameSync(tmpPath, cachePath);
}

function parseNpmPackageJson(text: string): NpmPackageJson {
	const value = parseJsonObject(text);
	const pkg: NpmPackageJson = {};
	if (value["version"] !== undefined) {
		if (!isRuntimeString(value["version"])) throw new Error("Invalid package version");
		pkg.version = value["version"];
	}
	if (value["bin"] === undefined) return pkg;
	if (isRuntimeString(value["bin"])) {
		pkg.bin = value["bin"];
		return pkg;
	}
	if (!isJsonInputObject(value["bin"])) throw new Error("Invalid package bin field");
	const bins: Record<string, string> = {};
	for (const [name, target] of Object.entries(value["bin"])) {
		if (!isRuntimeString(target)) throw new Error("Invalid package bin target");
		Object.defineProperty(bins, name, { configurable: true, enumerable: true, value: target, writable: true });
	}
	pkg.bin = bins;
	return pkg;
}

function parseNpxCache(text: string): NpxCache | null {
	const value = parseJsonObject(text);
	if (value["version"] !== CACHE_VERSION || !isJsonInputObject(value["entries"])) return null;
	const entries: Record<string, NpxCacheEntry> = {};
	for (const [key, rawEntry] of Object.entries(value["entries"])) {
		if (
			!isJsonInputObject(rawEntry) ||
			!isRuntimeString(rawEntry["resolvedBin"]) ||
			!isRuntimeNumber(rawEntry["resolvedAt"]) ||
			!Number.isFinite(rawEntry["resolvedAt"]) ||
			!isRuntimeBoolean(rawEntry["isJs"]) ||
			(rawEntry["packageVersion"] !== undefined && !isRuntimeString(rawEntry["packageVersion"]))
		)
			continue;
		const entry: NpxCacheEntry = {
			resolvedBin: rawEntry["resolvedBin"],
			resolvedAt: rawEntry["resolvedAt"],
			isJs: rawEntry["isJs"],
		};
		if (isRuntimeString(rawEntry["packageVersion"])) entry.packageVersion = rawEntry["packageVersion"];
		Object.defineProperty(entries, key, { configurable: true, enumerable: true, value: entry, writable: true });
	}
	return { version: CACHE_VERSION, entries };
}

function safeRealpath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return "";
	}
}

function safeStatMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}
