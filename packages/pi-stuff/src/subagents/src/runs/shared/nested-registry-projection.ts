import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { type DurableClaim, tryAcquireKernelClaim } from "../../shared/durable-claim.ts";
import { assertPrivateDirectoryWithin, readBoundedOwnedFile } from "../../shared/private-directory.ts";
import { tryAcquireStatusMutationClaim } from "../../shared/status-mutation.ts";
import { type AsyncStatus, TEMP_ROOT_DIR } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { readProcessTerminal } from "../background/process-terminal.ts";
import * as nestedEventModel from "./nested-events-model.ts";
import { forgetNestedRegistry, REGISTRY_FILE, readNestedRegistry, registryPath } from "./nested-registry-store.ts";
import * as nestedRoute from "./nested-route.ts";

type NestedRegistry = nestedEventModel.NestedRegistry;
type NestedRoute = nestedEventModel.NestedRoute;

const ROOT_TERMINAL_FILE = "root-terminal.json";
const MAX_EVENT_FILES_PER_PROJECTION = 2_000;
const REGISTRY_LOCK = "registry-project.lock";
export const AUTHORITATIVE_PROJECTION_TIMEOUT_MS = 3_000;
const AUTHORITATIVE_PROJECTION_RETRY_MS = 20;
export interface AuthoritativeNestedProjectionOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}
function discardInvalidImmutableEvent(eventPath: string, onlyStructurallyUnsafe = false): boolean {
	try {
		const stat = fs.lstatSync(eventPath);
		const currentUid = process.getuid?.();
		if (currentUid !== undefined && stat.uid !== currentUid) return false;
		if (!stat.isFile() && !stat.isSymbolicLink()) return false;
		if (onlyStructurallyUnsafe && !stat.isSymbolicLink() && stat.size <= nestedEventModel.MAX_EVENT_BYTES)
			return false;
		fs.unlinkSync(eventPath);
		return true;
	} catch (error) {
		return isRuntimeObject(error) && error !== null && "code" in error && error.code === "ENOENT";
	}
}

function projectNestedEventBatch(route: NestedRoute, registry: NestedRegistry) {
	const seen = new Set(registry.processedEvents);
	let changed = false;
	let entries: string[] = [];
	try {
		entries = fs
			.readdirSync(route.eventSink)
			.filter((entry) => entry.endsWith(".json") || entry.endsWith(".jsonl"))
			.sort()
			.filter((entry) => !seen.has(entry))
			.slice(0, MAX_EVENT_FILES_PER_PROJECTION);
	} catch (error) {
		if (!isRuntimeObject(error) || error === null || !("code" in error) || error.code !== "ENOENT") throw error;
	}
	for (const entry of entries) {
		const eventPath = path.join(route.eventSink, entry);
		if (!nestedRoute.containedPath(route.eventSink, eventPath)) continue;
		let content: string;
		try {
			content = readBoundedOwnedFile(eventPath, nestedEventModel.MAX_EVENT_BYTES);
		} catch {
			if (discardInvalidImmutableEvent(eventPath, true)) {
				seen.add(entry);
				changed = true;
			}
			continue;
		}
		const records = nestedEventModel.parseNestedEventRecords(content, route);
		if (records.length === 0) {
			if (discardInvalidImmutableEvent(eventPath)) {
				seen.add(entry);
				changed = true;
			}
			continue;
		}
		for (const event of records) {
			registry = nestedEventModel.applyNestedEvent(registry, event);
			changed = true;
		}
		seen.add(entry);
		changed = true;
	}
	if (changed) {
		const processedEvents = [...seen];
		const retainedEvents = processedEvents.slice(-nestedEventModel.MAX_PROCESSED_EVENTS);
		registry = nestedEventModel.boundedRegistry({ ...registry, processedEvents: retainedEvents });
		const retainedSet = new Set(registry.processedEvents);
		const evictedEvents = processedEvents.filter((entry) => !retainedSet.has(entry));
		// This route-level claim covers the complete read→project→write→cleanup
		// transaction across root, runner, and owner Pi processes.
		writePrivateAtomicJson(registryPath(route), registry);

		// Remove immutable records only after their projection is durable.
		for (const entry of evictedEvents) {
			const eventPath = path.join(route.eventSink, entry);
			if (!nestedRoute.containedPath(route.eventSink, eventPath)) continue;
			try {
				fs.unlinkSync(eventPath);
			} catch {
				// Cleanup is best-effort; the retained cursor remains authoritative.
			}
		}
	}
	return { registry, entriesRead: entries.length };
}

function projectNestedEventsUnderClaim(
	route: NestedRoute,
	options: { drain?: boolean; deadline?: number } = {},
): NestedRegistry {
	let registry = readNestedRegistry(route);
	for (;;) {
		const batch = projectNestedEventBatch(route, registry);
		registry = batch.registry;
		if (!options.drain || batch.entriesRead < MAX_EVENT_FILES_PER_PROJECTION) return registry;
		if (options.deadline !== undefined && Date.now() >= options.deadline) {
			throw new Error(
				`Nested registry for '${route.rootRunId}' could not drain all pending events before its authoritative deadline.`,
			);
		}
	}
}

function projectNestedEventsWithClaim(
	route: NestedRoute,
	claim: DurableClaim,
	options: { drain?: boolean; deadline?: number } = {},
): NestedRegistry {
	try {
		return projectNestedEventsUnderClaim(route, options);
	} finally {
		claim.release();
	}
}

/**
 * Best-effort projection for status and UI refreshes. If another process owns
 * the projector claim, return the last durable snapshot without blocking the
 * interactive host.
 */
export function projectNestedEvents(route: NestedRoute): NestedRegistry {
	nestedRoute.validateRouteStorage(route);
	const claim = tryAcquireKernelClaim(nestedRoute.commonRouteRoot(route), REGISTRY_LOCK);
	return claim ? projectNestedEventsWithClaim(route, claim) : readNestedRegistry(route);
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Nested registry projection was aborted.");
}

function waitForProjectionRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal ? abortReason(signal) : new Error("Nested registry projection was aborted."));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

function routeHasRetainedState(route: NestedRoute): boolean {
	if (fs.readdirSync(route.eventSink).length > 0 || fs.readdirSync(route.controlInbox).length > 0) return true;
	const routeRoot = nestedRoute.commonRouteRoot(route);
	const allowed = new Set([
		nestedRoute.ROUTE_FILE,
		REGISTRY_FILE,
		ROOT_TERMINAL_FILE,
		`${REGISTRY_LOCK}.lock`,
		"events",
		"controls",
	]);
	if (fs.readdirSync(routeRoot).some((entry) => !allowed.has(entry))) return true;
	try {
		const registry = readNestedRegistry(route);
		return registry.children.length > 0 || registry.pendingChildren.length > 0 || registry.processedEvents.length > 0;
	} catch (error) {
		if (isRuntimeObject(error) && error !== null && "code" in error && error.code === "ENOENT") return false;
		return true;
	}
}

/**
 * Retire the exact capability-owned route after its root run has durably
 * terminalized. Renaming while holding the projector claim makes stale route
 * users fail closed; the moved inode is removed only after the claim is closed.
 */
export async function retireUnusedNestedRoute(
	route: NestedRoute,
	options: AuthoritativeNestedProjectionOptions = {},
): Promise<boolean> {
	nestedRoute.validateRouteStorage(route);
	const timeoutMs = options.timeoutMs ?? AUTHORITATIVE_PROJECTION_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new Error("Nested route retirement timeout must be a finite non-negative number.");
	}
	const deadline = Date.now() + timeoutMs;
	const routeRoot = nestedRoute.commonRouteRoot(route);
	for (;;) {
		if (options.signal?.aborted) throw abortReason(options.signal);
		const claim = tryAcquireKernelClaim(routeRoot, REGISTRY_LOCK);
		if (claim) {
			let retiredRoot: string | undefined;
			try {
				nestedRoute.validateRouteStorage(route);
				if (routeHasRetainedState(route)) return false;
				const before = fs.lstatSync(routeRoot);
				retiredRoot = path.join(
					nestedRoute.NESTED_EVENTS_DIR,
					`.retired-${path.basename(routeRoot)}-${claim.token}`,
				);
				fs.renameSync(routeRoot, retiredRoot);
				forgetNestedRegistry(registryPath(route));
				const moved = fs.lstatSync(retiredRoot);
				if (!moved.isDirectory() || moved.dev !== before.dev || moved.ino !== before.ino) {
					throw new Error("Nested route inode changed during retirement.");
				}
			} finally {
				claim.release();
			}
			if (retiredRoot) fs.rmSync(retiredRoot, { recursive: true });
			return Boolean(retiredRoot);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await waitForProjectionRetry(Math.min(AUTHORITATIVE_PROJECTION_RETRY_MS, remaining), options.signal);
	}
}

interface NestedRootTerminalMarker {
	readonly version: 1;
	readonly rootRunId: string;
	readonly capabilityToken: string;
	readonly rootAsyncDir: string;
	readonly committedAt: number;
}

function readRootTerminalMarker(route: NestedRoute): NestedRootTerminalMarker | undefined {
	try {
		const marker = parseJsonValue(
			readBoundedOwnedFile(
				path.join(nestedRoute.commonRouteRoot(route), ROOT_TERMINAL_FILE),
				nestedRoute.MAX_ROUTE_METADATA_BYTES,
			),
		);
		if (!isRuntimeObject(marker) || marker === null || Array.isArray(marker)) return undefined;
		if (
			marker["version"] === 1 &&
			marker["rootRunId"] === route.rootRunId &&
			marker["capabilityToken"] === route.capabilityToken &&
			isRuntimeString(marker["rootAsyncDir"]) &&
			isRuntimeNumber(marker["committedAt"]) &&
			Number.isFinite(marker["committedAt"])
		) {
			return {
				version: 1,
				rootRunId: marker["rootRunId"],
				capabilityToken: marker["capabilityToken"],
				rootAsyncDir: marker["rootAsyncDir"],
				committedAt: marker["committedAt"],
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function persistTerminalRootProjection(
	route: NestedRoute,
	marker: NestedRootTerminalMarker,
	registry: NestedRegistry,
	retiring: boolean,
): boolean {
	let statusClaim: ReturnType<typeof tryAcquireStatusMutationClaim>;
	try {
		if (path.basename(marker.rootAsyncDir) !== route.rootRunId) return false;
		assertPrivateDirectoryWithin(TEMP_ROOT_DIR, marker.rootAsyncDir);
		statusClaim = tryAcquireStatusMutationClaim(marker.rootAsyncDir);
		if (!statusClaim) return false;
		const status = readStatus(marker.rootAsyncDir);
		if (!status || status.runId !== route.rootRunId || !nestedEventModel.isTerminalNestedRunState(status.state))
			return false;
		const processTerminal = readProcessTerminal(marker.rootAsyncDir, {
			runId: status.runId,
			runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId,
		});
		const steps = status.steps ?? [];
		nestedEventModel.attachRootChildrenToSteps(route.rootRunId, steps, registry.children);
		const parentRunOrigin =
			status.parentRunOrigin === "user" || nestedEventModel.nestedWorkIncludesUser(registry.children)
				? "user"
				: status.parentRunOrigin;
		const updated: AsyncStatus = {
			...status,
			steps,
			nestedRoute: retiring ? undefined : route,
			lastUpdate: Math.max(status.lastUpdate ?? 0, registry.updatedAt),
		};
		if (parentRunOrigin) updated.parentRunOrigin = parentRunOrigin;
		if (processTerminal) updated.processTerminal = processTerminal;
		writePrivateAtomicJson(path.join(marker.rootAsyncDir, "status.json"), updated);
		return true;
	} catch {
		return false;
	} finally {
		statusClaim?.release();
	}
}

function retireClaimedRoute(route: NestedRoute, claim: DurableClaim): string {
	const routeRoot = nestedRoute.commonRouteRoot(route);
	const before = fs.lstatSync(routeRoot);
	const retiredRoot = path.join(nestedRoute.NESTED_EVENTS_DIR, `.retired-${path.basename(routeRoot)}-${claim.token}`);
	fs.renameSync(routeRoot, retiredRoot);
	forgetNestedRegistry(registryPath(route));
	const moved = fs.lstatSync(retiredRoot);
	if (!moved.isDirectory() || moved.dev !== before.dev || moved.ino !== before.ino) {
		throw new Error("Nested route inode changed during retirement.");
	}
	return retiredRoot;
}

async function settleTerminalNestedRoute(
	route: NestedRoute,
	options: AuthoritativeNestedProjectionOptions,
	rootAsyncDir?: string,
): Promise<boolean> {
	nestedRoute.validateRouteStorage(route);
	const timeoutMs = options.timeoutMs ?? AUTHORITATIVE_PROJECTION_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new Error("Nested route settlement timeout must be a finite non-negative number.");
	}
	const deadline = Date.now() + timeoutMs;
	const routeRoot = nestedRoute.commonRouteRoot(route);
	for (;;) {
		if (options.signal?.aborted) throw abortReason(options.signal);
		const claim = tryAcquireKernelClaim(routeRoot, REGISTRY_LOCK);
		if (claim) {
			let retiredRoot: string | undefined;
			try {
				nestedRoute.validateRouteStorage(route);
				if (rootAsyncDir) {
					if (path.basename(rootAsyncDir) !== route.rootRunId) {
						throw new Error("Nested route root runtime does not match its root run id.");
					}
					assertPrivateDirectoryWithin(TEMP_ROOT_DIR, rootAsyncDir);
					// The projector claim serializes marker publication with route
					// retirement, so atomic writing cannot recreate a retired route root.
					writePrivateAtomicJson(path.join(routeRoot, ROOT_TERMINAL_FILE), {
						version: 1,
						rootRunId: route.rootRunId,
						capabilityToken: route.capabilityToken,
						rootAsyncDir,
						committedAt: Date.now(),
					} satisfies NestedRootTerminalMarker);
				}
				const registry = projectNestedEventsUnderClaim(route, { drain: true, deadline });
				const marker = readRootTerminalMarker(route);
				if (!marker) return false;
				const hasLiveDescendants = nestedEventModel.hasLiveNestedDescendants([
					...registry.children,
					...registry.pendingChildren,
				]);
				// Publish the latest authoritative descendants even when the root
				// cannot retire yet. The foreground result can then show live detached
				// children while status retains the route for subsequent projection.
				if (!persistTerminalRootProjection(route, marker, registry, !hasLiveDescendants)) return false;
				if (hasLiveDescendants) return false;
				retiredRoot = retireClaimedRoute(route, claim);
			} finally {
				claim.release();
			}
			if (retiredRoot) fs.rmSync(retiredRoot, { recursive: true });
			return Boolean(retiredRoot);
		}
		const remaining = deadline - Date.now();
		if (remaining <= 0) return false;
		await waitForProjectionRetry(Math.min(AUTHORITATIVE_PROJECTION_RETRY_MS, remaining), options.signal);
	}
}

/** Mark the root result durable and retire immediately only when no descendant remains live. */
export function finalizeNestedRouteRoot(
	route: NestedRoute,
	rootAsyncDir: string,
	options: AuthoritativeNestedProjectionOptions = {},
): Promise<boolean> {
	return settleTerminalNestedRoute(route, options, rootAsyncDir);
}

/** Let the final descendant retire a route whose root already committed terminal state. */
export function retireCompletedNestedRoute(
	route: NestedRoute,
	options: AuthoritativeNestedProjectionOptions = {},
): Promise<boolean> {
	return settleTerminalNestedRoute(route, options);
}

/**
 * Authoritative projection for control and terminal delivery paths. A busy
 * projector is not an empty registry: wait for its durable transaction to
 * finish, then project any newly-arrived immutable events ourselves.
 */
export async function projectNestedEventsAuthoritatively(
	route: NestedRoute,
	options: AuthoritativeNestedProjectionOptions = {},
): Promise<NestedRegistry> {
	nestedRoute.validateRouteStorage(route);
	const timeoutMs = options.timeoutMs ?? AUTHORITATIVE_PROJECTION_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
		throw new Error("Authoritative nested projection timeout must be a finite non-negative number.");
	}
	const deadline = Date.now() + timeoutMs;
	const routeRoot = nestedRoute.commonRouteRoot(route);
	for (;;) {
		if (options.signal?.aborted) throw abortReason(options.signal);
		const claim = tryAcquireKernelClaim(routeRoot, REGISTRY_LOCK);
		if (claim) return projectNestedEventsWithClaim(route, claim, { drain: true, deadline });
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			throw new Error(
				`Nested registry for '${route.rootRunId}' remained busy for ${timeoutMs}ms; authoritative projection was not completed.`,
			);
		}
		await waitForProjectionRetry(Math.min(AUTHORITATIVE_PROJECTION_RETRY_MS, remaining), options.signal);
	}
}
