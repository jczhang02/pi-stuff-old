import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import { writePrivateAtomicJson } from "../../shared/atomic-json.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import {
	assertPrivateDirectory,
	assertPrivateDirectoryWithin,
	ensurePrivateDirectory,
	readBoundedOwnedFile,
} from "../../shared/private-directory.ts";
import { tryAcquireStatusMutationClaim } from "../../shared/status-mutation.ts";
import type { AsyncStatus, NestedRunSummary } from "../../shared/types.ts";
import { TEMP_ROOT_DIR } from "../../shared/types.ts";
import { readStatus } from "../../shared/utils.ts";
import { readProcessTerminal } from "../background/process-terminal.ts";
import * as nestedEventModel from "./nested-events-model.ts";
import { isSafeNestedPathId, type NestedPathEntry, parseNestedPathEnv } from "./nested-path.ts";
import { MAX_DEPTH } from "./nested-summary.ts";
import {
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
} from "./pi-args.ts";

export const NESTED_EVENTS_DIR = path.join(TEMP_ROOT_DIR, "nested-subagent-events");
export const ROUTE_FILE = "route.json";
export const MAX_ROUTE_METADATA_BYTES = 16 * 1024;

type NestedRoute = nestedEventModel.NestedRoute;

interface RawNestedRoute {
	rootRunId?: unknown;
	eventSink?: unknown;
	controlInbox?: unknown;
	capabilityToken?: unknown;
}

interface NestedParentAddress {
	parentRunId: string;
	parentStepIndex?: number;
	depth: number;
	path: NestedPathEntry[];
}

export function isSafeNestedId<Value>(value: Value): value is Value & string {
	return isSafeNestedPathId(value);
}

export function assertSafeNestedId(label: string, value: string): void {
	if (!isSafeNestedId(value)) throw new Error(`${label} must be a non-empty safe id token.`);
}

export function containedPath(base: string, candidate: string): boolean {
	const resolvedBase = path.resolve(base);
	const resolvedCandidate = path.resolve(candidate);
	return resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(`${resolvedBase}${path.sep}`);
}

export function commonRouteRoot(route: Pick<NestedRoute, "eventSink" | "controlInbox">): string {
	return path.dirname(path.resolve(route.eventSink));
}

function validateRoutePaths(route: NestedRoute): void {
	assertSafeNestedId("rootRunId", route.rootRunId);
	assertSafeNestedId("capabilityToken", route.capabilityToken);
	if (!containedPath(NESTED_EVENTS_DIR, route.eventSink))
		throw new Error("Nested event sink is outside the subagent nested event root.");
	if (!containedPath(NESTED_EVENTS_DIR, route.controlInbox))
		throw new Error("Nested control inbox is outside the subagent nested event root.");
	if (commonRouteRoot(route) !== path.dirname(path.resolve(route.controlInbox)))
		throw new Error("Nested event sink and control inbox must share one route root.");
}

export function validateRouteStorage(route: NestedRoute): void {
	validateRoutePaths(route);
	assertPrivateDirectory(TEMP_ROOT_DIR);
	assertPrivateDirectory(NESTED_EVENTS_DIR);
	const routeRoot = commonRouteRoot(route);
	assertPrivateDirectory(routeRoot);
	assertPrivateDirectory(route.eventSink);
	assertPrivateDirectory(route.controlInbox);
	const metadata = parseJsonValue(readBoundedOwnedFile(path.join(routeRoot, ROUTE_FILE), MAX_ROUTE_METADATA_BYTES));
	if (!isRuntimeObject(metadata) || metadata === null || Array.isArray(metadata)) {
		throw new Error("Nested event route metadata is not an object.");
	}
	if (metadata["rootRunId"] !== route.rootRunId || metadata["capabilityToken"] !== route.capabilityToken) {
		throw new Error("Nested event route metadata does not match the provided root id and capability token.");
	}
}

export function createNestedRoute(rootRunId: string): NestedRoute {
	assertSafeNestedId("rootRunId", rootRunId);
	const capabilityToken = randomUUID();
	const routeRoot = path.join(NESTED_EVENTS_DIR, `${rootRunId}-${capabilityToken}`);
	const stagingRoot = path.join(NESTED_EVENTS_DIR, `.creating-${rootRunId}-${capabilityToken}`);
	const eventSink = path.join(routeRoot, "events");
	const controlInbox = path.join(routeRoot, "controls");
	ensurePrivateDirectory(TEMP_ROOT_DIR);
	ensurePrivateDirectory(NESTED_EVENTS_DIR);
	fs.mkdirSync(stagingRoot, { mode: 0o700 });
	const staged = fs.lstatSync(stagingRoot);
	try {
		ensurePrivateDirectory(stagingRoot);
		ensurePrivateDirectory(path.join(stagingRoot, "events"));
		ensurePrivateDirectory(path.join(stagingRoot, "controls"));
		fs.writeFileSync(
			path.join(stagingRoot, ROUTE_FILE),
			`${JSON.stringify({ rootRunId, capabilityToken, createdAt: Date.now() })}\n`,
			{ mode: 0o600, flag: "wx" },
		);
		fs.renameSync(stagingRoot, routeRoot);
	} catch (error) {
		try {
			const current = fs.lstatSync(stagingRoot);
			if (current.isDirectory() && current.dev === staged.dev && current.ino === staged.ino) {
				fs.rmSync(stagingRoot, { recursive: true });
			}
		} catch {
			// Preserve the original route construction failure.
		}
		throw error;
	}
	const route = { rootRunId, eventSink, controlInbox, capabilityToken };
	validateRouteStorage(route);
	return route;
}

export function resolveNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRoute | undefined {
	const rootRunId = env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV];
	const eventSink = env[SUBAGENT_PARENT_EVENT_SINK_ENV];
	const controlInbox = env[SUBAGENT_PARENT_CONTROL_INBOX_ENV];
	const capabilityToken = env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV];
	if (!rootRunId || !eventSink || !controlInbox || !capabilityToken) return undefined;
	const route = { rootRunId, eventSink, controlInbox, capabilityToken };
	validateRouteStorage(route);
	return route;
}

export function resolveInheritedNestedRouteFromEnv(env: NodeJS.ProcessEnv = process.env): NestedRoute | undefined {
	try {
		return resolveNestedRouteFromEnv(env);
	} catch (error) {
		reportAgentDiagnostic("Ignoring invalid nested subagent event route:", error);
		return undefined;
	}
}

/** Validate one exact persisted route without falling back to another route with the same root id. */
export function resolvePersistedNestedRoute<Value>(value: Value, expectedRootRunId: string): NestedRoute | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	// SAFETY: the object guard proves the persisted route can be inspected through its optional raw fields.
	const raw = value as Value & RawNestedRoute;
	if (
		raw.rootRunId !== expectedRootRunId ||
		!isSafeNestedId(raw.rootRunId) ||
		!isRuntimeString(raw.eventSink) ||
		!isRuntimeString(raw.controlInbox) ||
		!isSafeNestedId(raw.capabilityToken)
	) {
		return undefined;
	}
	const route: NestedRoute = {
		rootRunId: raw.rootRunId,
		eventSink: raw.eventSink,
		controlInbox: raw.controlInbox,
		capabilityToken: raw.capabilityToken,
	};
	try {
		validateRouteStorage(route);
		return route;
	} catch {
		return undefined;
	}
}

/**
 * Recover a terminal root after its exact route was already retired. This also
 * repairs a stale status overlay that resurrected the retired route pointer.
 */
export function recoverRetiredNestedRouteStatus(route: NestedRoute, rootAsyncDir: string): AsyncStatus | undefined {
	validateRoutePaths(route);
	if (path.basename(rootAsyncDir) !== route.rootRunId) return undefined;
	assertPrivateDirectoryWithin(TEMP_ROOT_DIR, rootAsyncDir);
	try {
		fs.lstatSync(commonRouteRoot(route));
		return undefined;
	} catch (error) {
		if (!isRuntimeObject(error) || error === null || !("code" in error) || error.code !== "ENOENT") return undefined;
	}
	const claim = tryAcquireStatusMutationClaim(rootAsyncDir);
	if (!claim) return undefined;
	try {
		const status = readStatus(rootAsyncDir);
		if (!status || status.runId !== route.rootRunId || !nestedEventModel.isTerminalNestedRunState(status.state))
			return undefined;
		if (status.nestedRoute) {
			const persisted = status.nestedRoute;
			if (
				persisted.rootRunId !== route.rootRunId ||
				persisted.capabilityToken !== route.capabilityToken ||
				path.resolve(persisted.eventSink) !== path.resolve(route.eventSink) ||
				path.resolve(persisted.controlInbox) !== path.resolve(route.controlInbox)
			)
				return undefined;
		}
		const processTerminal = readProcessTerminal(rootAsyncDir, {
			runId: status.runId,
			runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId,
		});
		const repaired: AsyncStatus = {
			...status,
			nestedRoute: undefined,
		};
		if (processTerminal) repaired.processTerminal = processTerminal;
		writePrivateAtomicJson(path.join(rootAsyncDir, "status.json"), repaired);
		return repaired;
	} finally {
		claim.release();
	}
}

export function resolveNestedParentAddressFromEnv(
	env: NodeJS.ProcessEnv = process.env,
): NestedParentAddress | undefined {
	const parentRunId = env[SUBAGENT_PARENT_RUN_ID_ENV];
	if (!isSafeNestedId(parentRunId)) return undefined;
	const rawIndex = env[SUBAGENT_PARENT_CHILD_INDEX_ENV];
	const parentStepIndex = rawIndex && /^\d+$/.test(rawIndex) ? Number(rawIndex) : undefined;
	const rawDepth = Number(env[SUBAGENT_PARENT_DEPTH_ENV]);
	const depth = Math.min(Math.max(1, Number.isFinite(rawDepth) ? rawDepth : 1), MAX_DEPTH);
	const parsedPath = parseNestedPathEnv(env[SUBAGENT_PARENT_PATH_ENV]);
	const parentPath: NestedPathEntry = { runId: parentRunId };
	if (parentStepIndex !== undefined) parentPath.stepIndex = parentStepIndex;
	const nestedPath = parsedPath.length ? parsedPath : [parentPath];
	const address: NestedParentAddress = {
		parentRunId,
		depth,
		path: nestedPath,
	};
	if (parentStepIndex !== undefined) address.parentStepIndex = parentStepIndex;
	return address;
}

export function resolveNestedAsyncDir(rootRunId: string, run: NestedRunSummary): string | undefined {
	if (!isSafeNestedId(rootRunId) || !isSafeNestedId(run.id)) return undefined;
	const expected = path.resolve(TEMP_ROOT_DIR, "nested-subagent-runs", rootRunId, run.id);
	// The nested run directory is a trusted, deterministic address. Event
	// projections may deliberately omit an unusually long locator to stay
	// bounded; when they do, control and transcript fallback must still work.
	if (run.asyncDir && path.resolve(run.asyncDir) !== expected) return undefined;
	try {
		assertPrivateDirectoryWithin(TEMP_ROOT_DIR, expected);
		return expected;
	} catch {
		return undefined;
	}
}

export interface NestedRouteEnvironment {
	readonly [SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: string;
	readonly [SUBAGENT_PARENT_CONTROL_INBOX_ENV]: string;
	readonly [SUBAGENT_PARENT_EVENT_SINK_ENV]: string;
	readonly [SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: string;
}

export function nestedRouteEnv(route: NestedRoute): NestedRouteEnvironment {
	validateRouteStorage(route);
	return {
		[SUBAGENT_PARENT_EVENT_SINK_ENV]: route.eventSink,
		[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: route.controlInbox,
		[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: route.rootRunId,
		[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: route.capabilityToken,
	};
}
