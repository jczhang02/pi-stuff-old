import { createHash } from "node:crypto";
import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { markLifecyclePhase } from "./lifecycle-performance.ts";
import { isRuntimeObject } from "./shared/runtime-type.ts";
import { piStuffCachePath } from "./xdg/index.ts";

const SUITE_RUNTIME_CACHE_KEY = Symbol.for("@jczhang02/pi-stuff/suite-runtime-cache/v2");

export interface SuiteInstallationOptions {
	readonly childBaseExtensionPath: string;
}

export interface SuiteRuntimeModule {
	installPiStuff(pi: ExtensionAPI, options: SuiteInstallationOptions): void | Promise<void>;
}

interface SuiteRuntimeLoadBase {
	readonly sourceRoot: string;
}

export type SuiteRuntimeLoadRequest = SuiteRuntimeLoadBase &
	Readonly<{
		load: (fingerprint: string, mode: "initial" | "refresh") => Promise<SuiteRuntimeModule>;
	}>;

interface SuiteRuntimeCacheEntry {
	readonly fingerprint: string;
	readonly modulePromise: Promise<SuiteRuntimeModule>;
}

interface SuiteRuntimeCache {
	readonly attemptedRoots: Set<string>;
	readonly entries: Map<string, SuiteRuntimeCacheEntry>;
}

function isSuiteRuntimeCache<Value>(value: Value): value is Value & SuiteRuntimeCache {
	return (
		isRuntimeObject(value) &&
		value !== null &&
		"entries" in value &&
		value.entries instanceof Map &&
		"attemptedRoots" in value &&
		value.attemptedRoots instanceof Set
	);
}

function runtimeCache(): SuiteRuntimeCache {
	const existing = Object.getOwnPropertyDescriptor(globalThis, SUITE_RUNTIME_CACHE_KEY)?.value;
	if (isSuiteRuntimeCache(existing)) return existing;
	const created: SuiteRuntimeCache = { attemptedRoots: new Set(), entries: new Map() };
	Object.defineProperty(globalThis, SUITE_RUNTIME_CACHE_KEY, {
		configurable: true,
		value: created,
		writable: true,
	});
	return created;
}

async function updateFingerprint(hash: ReturnType<typeof createHash>, sourceRoot: string, path: string): Promise<void> {
	const metadata = await lstat(path);
	const relativePath = relative(sourceRoot, path);
	hash.update(relativePath);
	hash.update("\0");
	hash.update(String(metadata.mode));
	hash.update("\0");
	hash.update(String(metadata.size));
	hash.update("\0");
	hash.update(String(metadata.mtimeMs));
	hash.update("\0");
	hash.update(String(metadata.ctimeMs));
	hash.update("\0");
	if (metadata.isSymbolicLink()) hash.update(await readlink(path));
	hash.update("\0");
}

async function fingerprintSourceTree(sourceRoot: string): Promise<string> {
	const hash = createHash("sha256");
	const visit = async (directory: string): Promise<void> => {
		for (const entry of (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
			left.name.localeCompare(right.name),
		)) {
			const path = join(directory, entry.name);
			await updateFingerprint(hash, sourceRoot, path);
			if (entry.isDirectory()) await visit(path);
		}
	};
	await visit(sourceRoot);
	return hash.digest("hex");
}

export async function importFreshSuiteRuntime(runtimePath: string): Promise<SuiteRuntimeModule> {
	const [{ createJiti }, piAgentCore, piAi, piAiCompat, piCodingAgent, piTui] = await Promise.all([
		import("jiti"),
		import("@earendil-works/pi-agent-core"),
		import("@earendil-works/pi-ai"),
		import("@earendil-works/pi-ai/compat"),
		import("@earendil-works/pi-coding-agent"),
		import("@earendil-works/pi-tui"),
	]);
	const jiti = createJiti(import.meta.url, {
		fsCache: piStuffCachePath("jiti"),
		moduleCache: false,
		tryNative: false,
		virtualModules: {
			"@earendil-works/pi-agent-core": piAgentCore,
			"@earendil-works/pi-ai": piAi,
			"@earendil-works/pi-ai/compat": piAiCompat,
			"@earendil-works/pi-coding-agent": piCodingAgent,
			"@earendil-works/pi-tui": piTui,
		},
	});
	return jiti.import<SuiteRuntimeModule>(runtimePath);
}

/**
 * Reuse an unchanged TypeScript Suite module graph across Host reloads while
 * leaving the Extension factory and every Capability installer fresh.
 */
export async function loadSuiteRuntime(request: SuiteRuntimeLoadRequest): Promise<SuiteRuntimeModule> {
	const sourceRoot = await realpath(request.sourceRoot);
	markLifecyclePhase("suite.loader.fingerprint.start");
	const fingerprint = await fingerprintSourceTree(sourceRoot);
	markLifecyclePhase("suite.loader.fingerprint.end");

	const cache = runtimeCache();
	const cached = cache.entries.get(sourceRoot);
	if (cached?.fingerprint === fingerprint) {
		markLifecyclePhase("suite.loader.cache.hit");
		return cached.modulePromise;
	}

	markLifecyclePhase("suite.loader.cache.miss");
	const mode = cache.attemptedRoots.has(sourceRoot) ? "refresh" : "initial";
	cache.attemptedRoots.add(sourceRoot);
	const entry: SuiteRuntimeCacheEntry = {
		fingerprint,
		modulePromise: Promise.resolve().then(() => request.load(fingerprint, mode)),
	};
	cache.entries.set(sourceRoot, entry);
	try {
		const runtime = await entry.modulePromise;
		markLifecyclePhase("suite.loader.runtime.loaded");
		return runtime;
	} catch (error) {
		if (cache.entries.get(sourceRoot) === entry) cache.entries.delete(sourceRoot);
		throw error;
	}
}
