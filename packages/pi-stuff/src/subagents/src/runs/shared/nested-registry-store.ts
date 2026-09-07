import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { type OwnedFileSnapshot, readBoundedOwnedFileSnapshot } from "../../shared/private-directory.ts";
import type { NestedRunSummary } from "../../shared/types.ts";
import * as nestedEventModel from "./nested-events-model.ts";
import * as nestedRoute from "./nested-route.ts";
import { sanitizeSummary } from "./nested-summary.ts";

export const REGISTRY_FILE = "registry.json";
const MAX_REGISTRY_CACHE_ENTRIES = 256;
const MAX_REGISTRY_CACHE_WEIGHT_BYTES = 64 * 1024 * 1024;
const REGISTRY_CACHE_OBJECT_WEIGHT_MULTIPLIER = 4;
const MIN_REGISTRY_CACHE_ENTRY_WEIGHT_BYTES = 4 * 1024;

type NestedRegistry = nestedEventModel.NestedRegistry;
type NestedRoute = nestedEventModel.NestedRoute;

type NestedRegistryFingerprint = Omit<OwnedFileSnapshot, "text">;

interface CachedNestedRegistry {
	readonly fingerprint: NestedRegistryFingerprint;
	readonly registry: NestedRegistry;
	readonly weightBytes: number;
}

interface RawNestedRegistry {
	rootRunId?: unknown;
	updatedAt?: unknown;
	children?: unknown;
	pendingChildren?: unknown;
	processedEvents?: unknown;
}

/** Bounded stat-keyed cache for the frequently refreshed CurrentAgents projection. */
const nestedRegistryCache = new Map<string, CachedNestedRegistry>();
let nestedRegistryCacheWeightBytes = 0;

export function registryPath(route: NestedRoute): string {
	return path.join(nestedRoute.commonRouteRoot(route), REGISTRY_FILE);
}

function sameRegistryFingerprint(stat: fs.Stats, fingerprint: NestedRegistryFingerprint): boolean {
	return (
		stat.dev === fingerprint.dev &&
		stat.ino === fingerprint.ino &&
		stat.size === fingerprint.size &&
		stat.ctimeMs === fingerprint.ctimeMs &&
		stat.mtimeMs === fingerprint.mtimeMs
	);
}

export function forgetNestedRegistry(filePath: string): void {
	const cached = nestedRegistryCache.get(filePath);
	if (!cached) return;
	nestedRegistryCache.delete(filePath);
	nestedRegistryCacheWeightBytes = Math.max(0, nestedRegistryCacheWeightBytes - cached.weightBytes);
}

function cachedNestedRegistry(filePath: string): NestedRegistry | undefined {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(filePath);
	} catch (error) {
		if (isRuntimeObject(error) && error !== null && "code" in error && error.code === "ENOENT") {
			forgetNestedRegistry(filePath);
			return undefined;
		}
		throw error;
	}
	if (stat.isSymbolicLink() || !stat.isFile()) {
		throw new Error(`Agent runtime file '${filePath}' must be a regular file.`);
	}
	const currentUid = process.getuid?.();
	if (currentUid !== undefined && stat.uid !== currentUid) {
		throw new Error(`Agent runtime file '${filePath}' is owned by another user.`);
	}
	if (stat.size > nestedEventModel.MAX_REGISTRY_BYTES) {
		throw new Error(
			`Agent runtime file '${filePath}' exceeds the ${nestedEventModel.MAX_REGISTRY_BYTES}-byte limit.`,
		);
	}

	const cached = nestedRegistryCache.get(filePath);
	if (!cached) return undefined;
	if (!sameRegistryFingerprint(stat, cached.fingerprint)) {
		forgetNestedRegistry(filePath);
		return undefined;
	}

	// Refresh insertion order to make the fixed-size map a simple LRU.
	nestedRegistryCache.delete(filePath);
	nestedRegistryCache.set(filePath, cached);
	return cached.registry;
}

function rememberNestedRegistry(filePath: string, snapshot: NestedRegistryFingerprint, registry: NestedRegistry): void {
	forgetNestedRegistry(filePath);
	const weightBytes = Math.max(
		MIN_REGISTRY_CACHE_ENTRY_WEIGHT_BYTES,
		snapshot.size * REGISTRY_CACHE_OBJECT_WEIGHT_MULTIPLIER,
	);
	nestedRegistryCache.set(filePath, { fingerprint: snapshot, registry, weightBytes });
	nestedRegistryCacheWeightBytes += weightBytes;
	while (
		nestedRegistryCache.size > MAX_REGISTRY_CACHE_ENTRIES ||
		nestedRegistryCacheWeightBytes > MAX_REGISTRY_CACHE_WEIGHT_BYTES
	) {
		const oldest = nestedRegistryCache.keys().next().value;
		if (oldest === undefined) break;
		forgetNestedRegistry(oldest);
	}
}
export function readNestedRegistry(route: NestedRoute): NestedRegistry {
	nestedRoute.validateRouteStorage(route);
	const filePath = registryPath(route);
	const cached = cachedNestedRegistry(filePath);
	if (cached) return cached;
	try {
		const snapshot = readBoundedOwnedFileSnapshot(filePath, nestedEventModel.MAX_REGISTRY_BYTES);
		const parsed = parseJsonValue(snapshot.text);
		if (!isRuntimeObject(parsed) || parsed === null || Array.isArray(parsed)) {
			throw new Error("Nested registry is not an object.");
		}
		// SAFETY: the parsed JSON object can be inspected through the registry schema's optional raw fields.
		const raw = parsed as RawNestedRegistry;
		if (raw.rootRunId !== route.rootRunId) {
			throw new Error("Nested registry root id does not match its route metadata.");
		}
		const registry = {
			rootRunId: route.rootRunId,
			updatedAt: isRuntimeNumber(raw.updatedAt) ? raw.updatedAt : 0,
			children: Array.isArray(raw.children)
				? raw.children
						.map((child) => sanitizeSummary(child))
						.filter((child): child is NestedRunSummary => Boolean(child))
				: [],
			pendingChildren: Array.isArray(raw.pendingChildren)
				? raw.pendingChildren
						.map((child) => sanitizeSummary(child))
						.filter((child): child is NestedRunSummary => Boolean(child))
				: [],
			processedEvents: Array.isArray(raw.processedEvents)
				? raw.processedEvents
						.filter(
							(item): item is string =>
								isRuntimeString(item) && path.basename(item) === item && item.length <= 256,
						)
						.slice(-nestedEventModel.MAX_PROCESSED_EVENTS)
				: [],
		};
		// Deliberately construct a text-free fingerprint. Passing the complete
		// snapshot would retain the raw JSON alongside the parsed registry.
		rememberNestedRegistry(
			filePath,
			{
				ctimeMs: snapshot.ctimeMs,
				dev: snapshot.dev,
				ino: snapshot.ino,
				mtimeMs: snapshot.mtimeMs,
				size: snapshot.size,
			},
			registry,
		);
		return registry;
	} catch (error) {
		if (!isRuntimeObject(error) || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
		forgetNestedRegistry(filePath);
		return {
			rootRunId: route.rootRunId,
			updatedAt: 0,
			children: [],
			pendingChildren: [],
			processedEvents: [],
		};
	}
}
