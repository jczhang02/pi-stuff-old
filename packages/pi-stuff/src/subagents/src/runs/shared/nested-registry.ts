import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeObject } from "../../../../shared/runtime-type.ts";
import { assertPrivateDirectory, readBoundedOwnedFile } from "../../shared/private-directory.ts";
import { type NestedRunSummary, TEMP_ROOT_DIR } from "../../shared/types.ts";
import type * as nestedEventModel from "./nested-events-model.ts";
import {
	AUTHORITATIVE_PROJECTION_TIMEOUT_MS,
	type AuthoritativeNestedProjectionOptions,
	projectNestedEventsAuthoritatively,
} from "./nested-registry-projection.ts";
import * as nestedRoute from "./nested-route.ts";

export type { AuthoritativeNestedProjectionOptions } from "./nested-registry-projection.ts";
export {
	finalizeNestedRouteRoot,
	projectNestedEvents,
	projectNestedEventsAuthoritatively,
	retireCompletedNestedRoute,
	retireUnusedNestedRoute,
} from "./nested-registry-projection.ts";
export { readNestedRegistry } from "./nested-registry-store.ts";

type NestedRegistry = nestedEventModel.NestedRegistry;
type NestedRoute = nestedEventModel.NestedRoute;

function nestedRouteEntries(): string[] {
	try {
		assertPrivateDirectory(TEMP_ROOT_DIR);
		assertPrivateDirectory(nestedRoute.NESTED_EVENTS_DIR);
		return fs.readdirSync(nestedRoute.NESTED_EVENTS_DIR);
	} catch (error) {
		if (isRuntimeObject(error) && error !== null && "code" in error && error.code === "ENOENT") return [];
		throw error;
	}
}

function routeFromRoot(routeRoot: string): NestedRoute | undefined {
	try {
		assertPrivateDirectory(routeRoot);
		const metadata = parseJsonValue(
			readBoundedOwnedFile(path.join(routeRoot, nestedRoute.ROUTE_FILE), nestedRoute.MAX_ROUTE_METADATA_BYTES),
		);
		if (!isRuntimeObject(metadata) || metadata === null || Array.isArray(metadata)) return undefined;
		if (
			!nestedRoute.isSafeNestedId(metadata["rootRunId"]) ||
			!nestedRoute.isSafeNestedId(metadata["capabilityToken"])
		)
			return undefined;
		if (path.basename(routeRoot) !== `${metadata["rootRunId"]}-${metadata["capabilityToken"]}`) return undefined;
		const route: NestedRoute = {
			rootRunId: metadata["rootRunId"],
			eventSink: path.join(routeRoot, "events"),
			controlInbox: path.join(routeRoot, "controls"),
			capabilityToken: metadata["capabilityToken"],
		};
		nestedRoute.validateRouteStorage(route);
		return route;
	} catch {
		return undefined;
	}
}

export function findNestedRouteForRootId(rootRunId: string): NestedRoute | undefined {
	nestedRoute.assertSafeNestedId("rootRunId", rootRunId);
	for (const entry of nestedRouteEntries()) {
		if (!entry.startsWith(`${rootRunId}-`)) continue;
		const route = routeFromRoot(path.join(nestedRoute.NESTED_EVENTS_DIR, entry));
		if (route?.rootRunId === rootRunId) return route;
	}
	return undefined;
}

/**
 * Scan the nested-events directory once and index every route by its root run
 * id. Use this when resolving routes for many runs (e.g. listAsyncRuns) so the
 * cost is O(routes) total instead of O(runs * routes) from calling
 * findNestedRouteForRootId per run.
 */
export function buildNestedRouteIndex(): Map<string, NestedRoute> {
	const index = new Map<string, NestedRoute>();
	for (const entry of nestedRouteEntries()) {
		const route = routeFromRoot(path.join(nestedRoute.NESTED_EVENTS_DIR, entry));
		if (route && !index.has(route.rootRunId)) index.set(route.rootRunId, route);
	}
	return index;
}

export async function projectNestedRegistryForRootAuthoritatively(
	rootRunId: string,
	options: AuthoritativeNestedProjectionOptions = {},
): Promise<NestedRegistry | undefined> {
	const route = findNestedRouteForRootId(rootRunId);
	return route ? projectNestedEventsAuthoritatively(route, options) : undefined;
}

export interface NestedRunMatch {
	rootRunId: string;
	route: NestedRoute;
	run: NestedRunSummary;
}

export interface NestedRunResolutionScope {
	routes: NestedRoute[];
	descendantOf?: { parentRunId: string; parentStepIndex?: number };
}

function collectNestedRuns(
	children: NestedRunSummary[] | undefined,
	output: NestedRunSummary[] = [],
): NestedRunSummary[] {
	for (const child of children ?? []) {
		output.push(child);
		collectNestedRuns(child.children, output);
		collectNestedRuns(
			child.steps?.flatMap((step) => step.children ?? []),
			output,
		);
	}
	return output;
}

function collectScopedNestedRuns(
	children: NestedRunSummary[] | undefined,
	scope: NestedRunResolutionScope["descendantOf"],
	output: NestedRunSummary[] = [],
): NestedRunSummary[] {
	if (!scope) return collectNestedRuns(children, output);
	for (const child of children ?? []) {
		if (
			child.parentRunId === scope.parentRunId &&
			(scope.parentStepIndex === undefined || child.parentStepIndex === scope.parentStepIndex)
		) {
			collectNestedRuns([child], output);
			continue;
		}
		collectScopedNestedRuns(child.children, scope, output);
		collectScopedNestedRuns(
			child.steps?.flatMap((step) => step.children ?? []),
			scope,
			output,
		);
	}
	return output;
}

function listNestedRoutes(): NestedRoute[] {
	const routes: NestedRoute[] = [];
	for (const entry of nestedRouteEntries()) {
		const route = routeFromRoot(path.join(nestedRoute.NESTED_EVENTS_DIR, entry));
		if (route) routes.push(route);
	}
	return routes;
}

function collectMatchesFromRegistry(
	matches: NestedRunMatch[],
	route: NestedRoute,
	registry: NestedRegistry,
	id: string,
	options: { prefix?: boolean; scope?: NestedRunResolutionScope },
): void {
	for (const run of collectScopedNestedRuns(registry.children, options.scope?.descendantOf)) {
		if (options.prefix ? run.id.startsWith(id) : run.id === id) {
			matches.push({ rootRunId: route.rootRunId, route, run });
		}
	}
}

/** Resolve a control target without treating another projector's live claim as an empty registry. */
export async function findNestedRunMatchesByIdAuthoritatively(
	id: string,
	options: { prefix?: boolean; scope?: NestedRunResolutionScope; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<NestedRunMatch[]> {
	nestedRoute.assertSafeNestedId("id", id);
	const routes = options.scope?.routes ?? listNestedRoutes();
	const deadline = Date.now() + (options.timeoutMs ?? AUTHORITATIVE_PROJECTION_TIMEOUT_MS);
	const matches: NestedRunMatch[] = [];
	for (const route of routes) {
		const remaining = Math.max(0, deadline - Date.now());
		const projectionOptions: AuthoritativeNestedProjectionOptions =
			options.signal === undefined ? { timeoutMs: remaining } : { timeoutMs: remaining, signal: options.signal };
		const registry = await projectNestedEventsAuthoritatively(route, projectionOptions);
		collectMatchesFromRegistry(matches, route, registry, id, options);
	}
	return matches;
}
