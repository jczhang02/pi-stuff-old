import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import * as Effect from "effect/Effect";
import type { AgentWorkOrigin } from "../../../conversation-ui/agent-run-origin.ts";
import { deliverStopRequest, requestAsyncSteer } from "../runs/background/control-channel.ts";
import { waitForSteeringAction } from "../runs/background/steering.ts";
import { findNestedRunMatchesByIdAuthoritatively, resolveNestedAsyncDir } from "../runs/shared/nested-events.ts";
import type { Details, NestedRouteInfo, SubagentState } from "../shared/types.ts";

const DEFAULT_CONTROL_TIMEOUT_MS = 3_000;

interface NestedControlParams {
	readonly action?: "steer" | "stop" | string;
	readonly id?: string;
	readonly index?: number;
	readonly message?: string;
}

interface NestedControlRouterOptions {
	readonly now?: () => number;
	readonly parentRunOrigin: AgentWorkOrigin;
	readonly timeoutMs?: number;
	readonly requestId?: () => string;
}

function managementResult(text: string, isError = false): AgentToolResult<Details> & { isError?: boolean } {
	const result: AgentToolResult<Details> & { isError?: boolean } = {
		content: [{ type: "text", text }],
		details: { mode: "management", results: [] },
	};
	if (isError) Object.assign(result, { isError: true });
	return result;
}

function belongsToCurrentSession(sessionId: string | undefined, currentSessionId: string | null): boolean {
	return sessionId === undefined || (currentSessionId !== null && sessionId === currentSessionId);
}

function currentRoutes(state: SubagentState): NestedRouteInfo[] {
	const routes: NestedRouteInfo[] = [];
	for (const job of [...state.asyncJobs.values(), ...(state.recentAgentJobs?.values() ?? [])]) {
		if (job.nestedRoute && belongsToCurrentSession(job.sessionId, state.currentSessionId))
			routes.push(job.nestedRoute);
	}
	for (const run of state.foregroundControls.values()) {
		if (run.nestedRoute && belongsToCurrentSession(run.sessionId, state.currentSessionId))
			routes.push(run.nestedRoute);
	}
	for (const run of state.foregroundRuns?.values() ?? []) {
		if (run.nestedRoute && belongsToCurrentSession(run.sessionId, state.currentSessionId))
			routes.push(run.nestedRoute);
	}
	const seen = new Set<string>();
	return routes.filter((route) => {
		const key = `${route.rootRunId}\0${route.eventSink}\0${route.controlInbox}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

function currentTopLevelIds(state: SubagentState): string[] {
	const ids = new Set<string>();
	for (const job of [...state.asyncJobs.values(), ...(state.recentAgentJobs?.values() ?? [])]) {
		if (belongsToCurrentSession(job.sessionId, state.currentSessionId)) ids.add(job.asyncId);
	}
	for (const run of state.foregroundControls.values()) {
		if (belongsToCurrentSession(run.sessionId, state.currentSessionId)) ids.add(run.runId);
	}
	for (const run of state.foregroundRuns?.values() ?? []) {
		if (belongsToCurrentSession(run.sessionId, state.currentSessionId)) ids.add(run.runId);
	}
	return [...ids];
}

type NestedRunMatch = Awaited<ReturnType<typeof findNestedRunMatchesByIdAuthoritatively>>[number];

function errorMessage<Cause>(error: Cause): string {
	return error instanceof Error ? error.message : String(error);
}

function stopNestedAgent(
	match: NestedRunMatch,
	asyncDir: string,
	index: number | undefined,
): AgentToolResult<Details> & { isError?: boolean } {
	try {
		const request: Parameters<typeof deliverStopRequest>[0] = { asyncDir, source: "nested-agent-stop" };
		if (index !== undefined) Object.assign(request, { targetIndex: index });
		deliverStopRequest(request);
		return managementResult(
			`Interrupt requested for nested Agent ${match.run.id}${index === undefined ? "" : ` child ${index}`}.`,
		);
	} catch (error) {
		return managementResult(`Failed to stop nested Agent '${match.run.id}': ${errorMessage(error)}`, true);
	}
}

async function steerNestedAgent(
	params: NestedControlParams,
	match: NestedRunMatch,
	asyncDir: string,
	signal: AbortSignal,
	options: NestedControlRouterOptions,
	startedAt: number,
	timeoutMs: number,
): Promise<AgentToolResult<Details> & { isError?: boolean }> {
	const steps = match.run.steps ?? [];
	const liveIndexes = steps
		.map((step, index) => (step.status === "pending" || step.status === "running" ? index : undefined))
		.filter((index): index is number => index !== undefined);
	if (steps.length > 0 && params.index === undefined && liveIndexes.length === 0) {
		return managementResult(`Nested Agent '${match.run.id}' has no live child to steer.`, true);
	}
	const requestId = (options.requestId ?? randomUUID)();
	try {
		requestAsyncSteer(asyncDir, {
			id: requestId,
			message: params.message?.trim() ?? "",
			parentRunOrigin: options.parentRunOrigin,
			source: "nested-agent-steer",
			...(params.index !== undefined
				? { targetIndex: params.index }
				: liveIndexes.length > 0
					? { targetIndexes: liveIndexes }
					: {}),
		});
	} catch (error) {
		return managementResult(`Failed to steer nested Agent '${match.run.id}': ${errorMessage(error)}`, true);
	}
	const now = options.now ?? Date.now;
	const waited = await Effect.runPromise(
		waitForSteeringAction({
			asyncDir,
			sourceRunId: match.run.id,
			requestId,
			timeoutMs: Math.max(0, timeoutMs - (now() - startedAt)),
			signal,
		}),
	);
	const targetIndexes = params.index !== undefined ? [params.index] : liveIndexes;
	const steering =
		waited ??
		({
			requestId,
			state: "pending",
			sourceRunId: match.run.id,
			targets: targetIndexes.map((index) => ({ index, state: "routed" as const })),
		} as const);
	const failed = steering.state === "failed" || steering.state === "partial";
	const label =
		steering.state === "delivered"
			? "delivered"
			: steering.state === "scheduled"
				? "scheduled"
				: steering.state === "pending"
					? "pending acknowledgment"
					: steering.state;
	const result: AgentToolResult<Details> & { isError?: boolean } = {
		content: [{ type: "text", text: `Steering ${label} for nested Agent ${match.run.id} (request ${requestId}).` }],
		details: { mode: "management", results: [], steering },
	};
	if (failed) Object.assign(result, { isError: true });
	return result;
}

/**
 * Route steer/stop to an owner-blocking nested run. Returning undefined means
 * the id belongs to the ordinary top-level engine (or no nested run matched).
 */
export async function routeLiveNestedAgentControl(
	params: NestedControlParams,
	state: SubagentState,
	signal: AbortSignal,
	options: NestedControlRouterOptions,
): Promise<(AgentToolResult<Details> & { isError?: boolean }) | undefined> {
	if ((params.action !== "steer" && params.action !== "stop") || !params.id?.trim()) return undefined;
	const requested = params.id.trim();
	const topLevelIds = currentTopLevelIds(state);
	// Exact top-level control belongs to the ordinary engine. Do not let an
	// unrelated busy/corrupt nested projector delay or reject that operation.
	if (topLevelIds.includes(requested)) return undefined;
	const routes = currentRoutes(state);
	if (routes.length === 0) return undefined;
	const now = options.now ?? Date.now;
	const timeoutMs = options.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
	const startedAt = now();

	const topLevel = topLevelIds.filter((id) => id.startsWith(requested));
	let matches: Awaited<ReturnType<typeof findNestedRunMatchesByIdAuthoritatively>>;
	try {
		matches = await findNestedRunMatchesByIdAuthoritatively(requested, {
			prefix: true,
			scope: { routes },
			signal,
			timeoutMs,
		});
	} catch (error) {
		return managementResult(`Nested Agent control lookup could not complete: ${errorMessage(error)}`, true);
	}
	const exactNested = matches.filter(({ run }) => run.id === requested);
	const candidates = exactNested.length > 0 ? exactNested : matches;
	const unique = new Map(candidates.map((match) => [`${match.rootRunId}\0${match.run.id}`, match]));
	if (unique.size === 0) return undefined;
	if (unique.size > 1 || (exactNested.length === 0 && topLevel.length > 0)) {
		const ids = [...new Set([...topLevel, ...[...unique.values()].map(({ run }) => run.id)])];
		return managementResult(`Agent id '${requested}' is ambiguous: ${ids.join(", ")}.`, true);
	}
	const match = [...unique.values()][0];
	if (!match) return undefined;
	if (match.run.state !== "queued" && match.run.state !== "running") {
		return managementResult(
			`Nested Agent '${match.run.id}' is ${match.run.state}; only live nested Agents can be steered or stopped.`,
			true,
		);
	}
	if (params.action === "steer" && !params.message?.trim()) {
		return managementResult("action='steer' requires message.", true);
	}
	const asyncDir = resolveNestedAsyncDir(match.rootRunId, match.run);
	if (!asyncDir) {
		return managementResult(`Nested Agent '${match.run.id}' has no trusted live control directory.`, true);
	}
	const steps = match.run.steps ?? [];
	if (params.index !== undefined) {
		const step = steps[params.index];
		if (!step) {
			return managementResult(
				`Nested Agent '${match.run.id}' has ${steps.length} children. Index ${params.index} is out of range.`,
				true,
			);
		}
		if (step.status !== "pending" && step.status !== "running") {
			return managementResult(
				`Nested Agent '${match.run.id}' child ${params.index} is already ${step.status}.`,
				true,
			);
		}
	}

	if (params.action === "stop") return stopNestedAgent(match, asyncDir, params.index);
	return steerNestedAgent(params, match, asyncDir, signal, options, startedAt, timeoutMs);
}
