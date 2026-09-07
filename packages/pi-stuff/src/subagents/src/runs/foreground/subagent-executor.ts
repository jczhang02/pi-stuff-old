import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { AgentWorkOrigin } from "../../../../conversation-ui/agent-run-origin.js";
import { isRuntimeNumber } from "../../../../shared/runtime-type.js";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import { resolveDisplayDescription } from "../../shared/display-description.ts";
import { validateOwnedRegularFile } from "../../shared/private-directory.ts";
import { resolveCurrentSessionId, sessionArtifactMatches } from "../../shared/session-identity.ts";
import {
	ASYNC_DIR,
	checkSubagentDepth,
	DEFAULT_ARTIFACT_CONFIG,
	type Details,
	RESULTS_DIR,
	resolveCurrentMaxSubagentDepth,
	type SubagentState,
} from "../../shared/types.ts";
import { executeAsyncParallel, executeAsyncSingle } from "../background/async-execution.ts";
import {
	type AsyncResumeParams,
	type AsyncResumeTarget,
	applySteeringRecoveryAgentConfig,
	buildRevivedAsyncTask,
	findAsyncRunPrefixMatches,
	readAsyncRecoveryDescriptor,
	resolveAsyncResumeTarget,
} from "../background/async-resume.ts";
import { deliverStopRequest, requestAsyncSteer } from "../background/control-channel.ts";
import { inspectSubagentStatus, resolveLegacyAgentTarget } from "../background/run-status.ts";
import { reconcileAsyncRun } from "../background/stale-run-reconciler.ts";
import { waitForSteeringAction } from "../background/steering.ts";
import {
	intersectSubagentCapabilityCeilings,
	resolveCurrentSubagentCapabilityCeiling,
} from "../shared/capability-ceiling.ts";
import type { ParentModel } from "../shared/model-fallback.ts";
import {
	createNestedRoute,
	resolveInheritedNestedRouteFromEnv,
	retireUnusedNestedRoute,
} from "../shared/nested-events.ts";
import { SUBAGENT_PARENT_PHYSICAL_SESSION_ENV, SUBAGENT_PARENT_SESSION_ENV } from "../shared/pi-args.ts";
import type { SessionLeaseIntent } from "../shared/session-lease.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { runForegroundConfig } from "./execution.ts";
import type {
	AgentToolResult,
	ExecutorDeps,
	ExecutorEngines,
	PreparedLaunch,
	SubagentExecutionHooks,
	SubagentParamsLike,
} from "./executor-contract.ts";
import { errorResult, resultIsError } from "./executor-contract.ts";
import {
	effectiveCodeModeEnabled,
	launchBackground,
	launchForeground,
	ponytailLaunchSnapshot,
} from "./launch-builders.ts";
import {
	attachContextProjection,
	availableModels,
	prepareLaunch,
	rememberParentModel,
	resolveTimeout,
} from "./launch-preparation.ts";

export type {
	ForegroundStartBinding,
	LaunchIdentityScope,
	SubagentExecutionHooks,
	SubagentParamsLike,
} from "./executor-contract.ts";
export { deriveLaunchRunId } from "./launch-preparation.ts";
export { ponytailLaunchSnapshot };

const DEFAULT_ENGINES: ExecutorEngines = {
	backgroundSingle: executeAsyncSingle,
	backgroundParallel: executeAsyncParallel,
	foreground: runForegroundConfig,
};

function validateControlInput(params: SubagentParamsLike): string | undefined {
	if (params.index !== undefined && (!Number.isInteger(params.index) || params.index < 0)) {
		return "Agent index must be a non-negative integer.";
	}
	if (params.action !== "status" && !params.id?.trim()) return `action='${params.action}' requires id.`;
	if (params.action === "steer" && !params.message?.trim()) return "action='steer' requires message.";
	return undefined;
}

function resolveCurrentAsyncJob(state: SubagentState, requested: string) {
	const candidates = [...state.asyncJobs.values()].filter(
		(job) =>
			(!state.currentSessionId || job.sessionId === state.currentSessionId) && job.asyncId.startsWith(requested),
	);
	const exact = candidates.find((job) => job.asyncId === requested);
	if (exact) return exact;
	if (candidates.length > 1)
		throw new Error(`Agent id '${requested}' is ambiguous: ${candidates.map((job) => job.asyncId).join(", ")}.`);
	return candidates[0];
}

function stopRun(
	params: SubagentParamsLike,
	deps: ExecutorDeps,
	job: NonNullable<ReturnType<typeof resolveCurrentAsyncJob>>,
): AgentToolResult<Details> {
	const status = reconcileAsyncRun(job.asyncDir, { kill: deps.kill }).status;
	if (!status || (status.state !== "running" && status.state !== "queued")) {
		return errorResult("management", `Agent '${job.asyncId}' is no longer running.`);
	}
	const steps = status.steps ?? [];
	if (params.index !== undefined && !steps[params.index]) {
		return errorResult(
			"management",
			`Agent '${job.asyncId}' has ${steps.length} children. Index ${params.index} is out of range.`,
		);
	}
	if (
		params.index !== undefined &&
		steps[params.index]?.status !== "running" &&
		steps[params.index]?.status !== "pending"
	) {
		return errorResult("management", `Agent '${job.asyncId}' child ${params.index} is no longer running.`);
	}
	try {
		const input: Parameters<typeof deliverStopRequest>[0] = {
			asyncDir: job.asyncDir,
			source: "agent-stop",
		};
		if (isRuntimeNumber(status.pid)) input.pid = status.pid;
		if (deps.kill) input.kill = deps.kill;
		if (params.index !== undefined) input.targetIndex = params.index;
		deliverStopRequest(input);
		return {
			content: [
				{
					type: "text",
					text:
						params.index === undefined
							? `Stop requested for Agent ${job.asyncId}.`
							: `Stop requested for Agent ${job.asyncId} child ${params.index}.`,
				},
			],
			details: { mode: "management", results: [] },
		};
	} catch (error) {
		return errorResult(
			"management",
			`Failed to stop Agent ${job.asyncId}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function foregroundResumeTarget(
	params: SubagentParamsLike,
	state: SubagentState,
	resolvedRunId: string,
): AsyncResumeTarget | undefined {
	const run = [...(state.foregroundRuns?.values() ?? [])].find(
		(candidate) => candidate.sessionId === state.currentSessionId && candidate.runId === resolvedRunId,
	);
	if (!run) return undefined;
	if (run.children.length > 1 && params.index === undefined) {
		throw new Error(`Agent '${run.runId}' has ${run.children.length} children. Provide index.`);
	}
	const index = params.index ?? 0;
	const child = run.children[index];
	if (!child) throw new Error(`Agent '${run.runId}' child ${index} does not exist.`);
	if (child.status === "stopped") {
		throw new Error(`Agent '${run.runId}' child ${index} was stopped by the user and cannot be resumed.`);
	}
	if (!child.sessionFile) {
		throw new Error(`Agent '${run.runId}' child ${index} has no persisted session to resume.`);
	}
	if (path.extname(child.sessionFile) !== ".jsonl") {
		throw new Error(`Agent '${run.runId}' child ${index} session must be a .jsonl file.`);
	}
	let sessionFile: string;
	try {
		sessionFile = validateOwnedRegularFile(child.sessionFile);
	} catch (error) {
		throw new Error(`Agent '${run.runId}' child ${index} has no safe persisted session to resume.`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	const recoveryDescriptor = run.asyncDir ? readAsyncRecoveryDescriptor(run.asyncDir, index) : undefined;
	const target: AsyncResumeTarget = {
		kind: "revive" as const,
		runId: run.runId,
		state: child.status === "completed" ? "complete" : child.status === "detached" ? "running" : child.status,
		agent: child.agent,
		index,
		cwd: recoveryDescriptor?.cwd ?? child.cwd ?? run.cwd,
		sessionFile,
		model: child.model,
		thinking: child.thinking,
		context: child.context,
		launchContractDigest: child.launchContractDigest,
		capabilityCeiling: child.capabilityCeiling,
	};
	if (recoveryDescriptor) target.recoveryDescriptor = recoveryDescriptor;
	return target;
}

/** Resolve a public resume prefix before the governor reserves its logical Agent. */
export function resolveResumeTargetRunId(
	params: { readonly action?: string; readonly id?: string },
	state: SubagentState,
): string | undefined {
	if (params.action !== "resume" || !params.id) return undefined;
	const requested = params.id;
	const foreground = [...(state.foregroundRuns?.values() ?? [])].filter(
		(run) => run.sessionId === state.currentSessionId && run.runId.startsWith(requested),
	);
	const async = findAsyncRunPrefixMatches(
		requested,
		ASYNC_DIR,
		RESULTS_DIR,
		state.currentSessionScope ?? state.currentSessionId ?? undefined,
	);
	const candidates = [
		...foreground.map((run) => ({ id: run.runId, source: "foreground" as const })),
		...async.map((match) => ({ id: match.id, source: "background" as const })),
	];
	const exact = candidates.filter((candidate) => candidate.id === requested);
	if (exact.length === 1) return requested;
	if (exact.length > 1) {
		throw new Error(
			`Agent id '${requested}' exists in both foreground and background history; provide it through /agents.`,
		);
	}
	const uniqueIds = [...new Set(candidates.map((candidate) => candidate.id))];
	if (uniqueIds.length > 1) {
		throw new Error(`Agent id '${requested}' is ambiguous: ${uniqueIds.join(", ")}.`);
	}
	return uniqueIds[0] ?? requested;
}

/** Convert one current-session legacy row key before public control preflight. */
export function resolveLegacyAgentParams<Params extends { readonly id?: string; readonly index?: number }>(
	params: Params,
	state: SubagentState,
): Params {
	if (!params.id) return params;
	const requested = params.index === undefined ? { id: params.id } : { id: params.id, index: params.index };
	const target = resolveLegacyAgentTarget(requested, { state });
	if (target.id === params.id && target.index === params.index) return params;
	return target.index === undefined ? { ...params, id: target.id } : { ...params, id: target.id, index: target.index };
}

interface ResumeRunInput {
	params: SubagentParamsLike;
	ctx: ExtensionContext;
	deps: ExecutorDeps;
	engines: ExecutorEngines;
	parentModel?: ParentModel | undefined;
	parentRunOrigin?: AgentWorkOrigin | undefined;
}

async function prepareResumeRun(input: ResumeRunInput) {
	if (!input.params.id) throw new Error("action='resume' requires id.");
	const resolvedRunId = resolveResumeTargetRunId({ action: "resume", id: input.params.id }, input.deps.state);
	if (!resolvedRunId) throw new Error("Agent resume target could not be resolved.");
	const resumeTarget: AsyncResumeParams =
		input.params.index === undefined ? { id: resolvedRunId } : { id: resolvedRunId, index: input.params.index };
	const resumeOptions: Parameters<typeof resolveAsyncResumeTarget>[2] = input.deps.state.currentSessionScope
		? { requireSessionFile: true, sessionScope: input.deps.state.currentSessionScope }
		: input.deps.state.currentSessionId
			? { requireSessionFile: true, sessionId: input.deps.state.currentSessionId }
			: { requireSessionFile: true };
	const target =
		foregroundResumeTarget(input.params, input.deps.state, resolvedRunId) ??
		resolveAsyncResumeTarget(resumeTarget, { kill: input.deps.kill }, resumeOptions);
	if (target.kind === "live") throw new Error(`Agent '${target.runId}' is still running; use action='steer'.`);
	if (!target.sessionFile) throw new Error(`Agent '${target.runId}' has no persisted session to resume.`);
	const depth = checkSubagentDepth();
	if (depth.blocked) throw new Error(`Agent resume blocked at maximum nesting depth ${depth.maxDepth}.`);
	const effectiveCwd = target.cwd ?? input.ctx.cwd;
	try {
		if (!fs.statSync(effectiveCwd).isDirectory()) throw new Error("path is not a directory");
	} catch (error) {
		throw new Error(`Agent '${target.runId}' retained working directory is unavailable: ${effectiveCwd}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	const discovered = await input.deps.discoverAgents(input.ctx.cwd, "both");
	const descriptor = "recoveryDescriptor" in target ? target.recoveryDescriptor : undefined;
	const discoveredAgent = discovered.agents.find((agent) => agent.name === target.agent);
	const baseAgent =
		discoveredAgent ??
		(descriptor
			? {
					name: descriptor.agent,
					description: "Persisted Agent",
					systemPrompt: "",
					systemPromptMode: descriptor.systemPromptMode,
					inheritProjectContext: descriptor.inheritProjectContext,
					inheritSkills: descriptor.inheritSkills,
					source: "project" as const,
					filePath: descriptor.agentFilePath ?? path.join(effectiveCwd, ".pi-stuff-agent-recovery"),
				}
			: undefined);
	if (!baseAgent) throw new Error(`Unknown Agent for resume: ${target.agent}`);
	const agent = descriptor ? applySteeringRecoveryAgentConfig(baseAgent, descriptor) : baseAgent;
	const tool = validateToolBudgetConfig(input.params.toolBudget ?? descriptor?.initialToolBudget, "toolBudget");
	if (tool.error) throw new Error(tool.error);
	const timeout = resolveTimeout(input.params.timeoutMs);
	if (timeout.error) throw new Error(timeout.error);
	return {
		target,
		sessionFile: target.sessionFile,
		effectiveCwd,
		agent,
		descriptor,
		modelScope: discovered.modelScope,
		timeoutMs: timeout.timeoutMs,
		toolBudget: tool.budget,
		toolTimeoutMs: input.params.toolTimeoutMs ?? descriptor?.toolTimeoutMs,
	};
}

async function resumeRun(input: ResumeRunInput): Promise<AgentToolResult<Details>> {
	const followUp = input.params.message?.trim() || "Continue the previous task and report the current result.";
	let prepared: Awaited<ReturnType<typeof prepareResumeRun>>;
	try {
		prepared = await prepareResumeRun(input);
	} catch (error) {
		return errorResult("management", error instanceof Error ? error.message : String(error));
	}
	const { agent, descriptor, effectiveCwd, modelScope, sessionFile, target, timeoutMs, toolBudget, toolTimeoutMs } =
		prepared;
	const runId = randomUUID().replace(/-/g, "").slice(0, 12);
	const parentSessionFile = input.ctx.sessionManager.getSessionFile() ?? null;
	const artifactConfig = DEFAULT_ARTIFACT_CONFIG;
	const currentSessionId = input.deps.state.currentSessionId;
	if (!currentSessionId) return errorResult("management", "Current session identity is unavailable.");
	// A revived top-level Agent is a new lifecycle owner and needs a route for
	// any descendants it launches. A nested revival keeps its inherited route;
	// executeAsyncSingle derives nestedSelf from that same environment.
	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedRoute = inheritedNestedRoute ?? createNestedRoute(runId);
	let backgroundOwnsRoute = false;
	try {
		const revivalLease: SessionLeaseIntent = {
			sessionFile,
			runId,
			sourceRunId: target.runId,
		};
		if (input.deps.state.currentSessionId) revivalLease.parentSessionId = input.deps.state.currentSessionId;
		const resumeInput: Parameters<ExecutorEngines["backgroundSingle"]>[1] = {
			agent: target.agent,
			description: resolveDisplayDescription(undefined, followUp),
			task: buildRevivedAsyncTask(target, followUp),
			goal: followUp,
			agentConfig: agent,
			ctx: {
				pi: input.deps.pi,
				cwd: input.ctx.cwd,
				currentSessionId,
				governorSessionId: process.env[SUBAGENT_PARENT_SESSION_ENV]?.trim() || currentSessionId,
				physicalSessionId: currentSessionId,
				parentSessionId: input.ctx.sessionManager.getSessionId() ?? undefined,
				currentModelProvider: input.parentModel?.provider,
				currentModel: input.parentModel,
				modelScope,
				interactive: input.ctx.hasUI,
			},
			parentRunOrigin: input.parentRunOrigin,
			codeModeEnabled: effectiveCodeModeEnabled(input.deps),
			...ponytailLaunchSnapshot(input.deps.pi),
			codeModeProviderTools: input.deps.codeModeProviderTools,
			cwd: effectiveCwd,
			childBaseExtensionPath: input.deps.childBaseExtensionPath,
			artifactsDir: getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir),
			artifactConfig,
			nestedRoute,
			sessionRoot: input.deps.getSubagentSessionRoot(parentSessionFile),
			sessionFile,
			revivalLease,
			modelOverride: descriptor?.model ?? target.model,
			modelOrigin: descriptor?.modelOrigin ?? "inherited",
			thinkingOverride: descriptor?.thinking ?? target.thinking,
			logicalSourceRunId: descriptor?.sourceRunId ?? target.runId,
			logicalChildIndex: descriptor?.version === 2 ? descriptor.childIndex : target.index,
			maxSubagentDepth: descriptor?.maxSubagentDepth ?? resolveCurrentMaxSubagentDepth(),
			availableModels: availableModels(input.ctx),
			capabilityCeiling: intersectSubagentCapabilityCeilings(
				target.capabilityCeiling,
				descriptor?.capabilityCeiling,
				resolveCurrentSubagentCapabilityCeiling(input.deps.state.currentSessionId ?? undefined),
			),
		};
		if (timeoutMs !== undefined) resumeInput.timeoutMs = timeoutMs;
		if (toolBudget) resumeInput.toolBudget = toolBudget;
		if (toolTimeoutMs !== undefined) resumeInput.toolTimeoutMs = toolTimeoutMs;
		const result = await input.engines.backgroundSingle(runId, resumeInput);
		backgroundOwnsRoute = Boolean(result.details.asyncId);
		if (resultIsError(result)) return result;
		const revivedId = result.details.asyncId ?? runId;
		return {
			content: [{ type: "text", text: `Agent ${target.agent} resumed from ${target.runId} as ${revivedId}.` }],
			details: result.details,
		};
	} finally {
		if (!inheritedNestedRoute && !backgroundOwnsRoute) {
			try {
				await retireUnusedNestedRoute(nestedRoute);
			} catch {
				// Preserve any route that acquired real nested lifecycle evidence.
			}
		}
	}
}

async function controlAction(
	params: SubagentParamsLike,
	ctx: ExtensionContext,
	deps: ExecutorDeps,
	engines: ExecutorEngines,
	signal: AbortSignal,
	hooks?: SubagentExecutionHooks,
): Promise<AgentToolResult<Details>> {
	const validationError = validateControlInput(params);
	if (validationError) return errorResult("management", validationError);
	if (params.action === "status") {
		const statusParams: Parameters<typeof inspectSubagentStatus>[0] =
			params.id === undefined
				? params.index === undefined
					? { action: "status" }
					: { action: "status", index: params.index }
				: params.index === undefined
					? { action: "status", id: params.id }
					: { action: "status", id: params.id, index: params.index };
		return inspectSubagentStatus(statusParams, { state: deps.state });
	}
	let targetParams: SubagentParamsLike;
	try {
		targetParams = resolveLegacyAgentParams(params, deps.state);
	} catch (error) {
		return errorResult("management", error instanceof Error ? error.message : String(error));
	}
	if (targetParams.action === "resume") {
		let currentSessionId: string;
		try {
			currentSessionId =
				deps.state.currentSessionId ??
				process.env[SUBAGENT_PARENT_PHYSICAL_SESSION_ENV]?.trim() ??
				resolveCurrentSessionId(ctx.sessionManager, ctx.cwd);
		} catch (error) {
			return errorResult("management", error instanceof Error ? error.message : String(error));
		}
		return resumeRun({
			params: targetParams,
			ctx,
			deps,
			engines,
			parentModel: rememberParentModel(deps.state, currentSessionId, ctx.model),
			parentRunOrigin: hooks?.parentRunOrigin,
		});
	}
	if (targetParams.action === "stop" || targetParams.action === "steer") {
		if (!targetParams.id) return errorResult("management", `action='${targetParams.action}' requires id.`);
		let job: ReturnType<typeof resolveCurrentAsyncJob>;
		try {
			job = resolveCurrentAsyncJob(deps.state, targetParams.id);
		} catch (error) {
			return errorResult("management", error instanceof Error ? error.message : String(error));
		}
		if (!job) return errorResult("management", `Agent '${targetParams.id}' is not running in the current session.`);
		if (targetParams.action === "stop") return stopRun(targetParams, deps, job);
		if (!targetParams.message) return errorResult("management", "action='steer' requires message.");
		return steerRun(job, targetParams.message.trim(), targetParams.index, deps, signal, hooks?.parentRunOrigin);
	}
	return errorResult("management", "Unknown Agent action. Valid actions: status, steer, stop, resume.");
}

async function steerRun(
	job: NonNullable<ReturnType<typeof resolveCurrentAsyncJob>>,
	message: string,
	index: number | undefined,
	deps: ExecutorDeps,
	signal: AbortSignal,
	parentRunOrigin?: AgentWorkOrigin,
): Promise<AgentToolResult<Details>> {
	const status = reconcileAsyncRun(job.asyncDir, { kill: deps.kill }).status;
	if (!status || (status.state !== "running" && status.state !== "queued")) {
		return errorResult("management", `Agent '${job.asyncId}' is no longer running.`);
	}
	if (
		deps.state.currentSessionId &&
		!sessionArtifactMatches(deps.state.currentSessionScope, status.sessionId, status.runId) &&
		status.sessionId !== deps.state.currentSessionId
	) {
		return errorResult("management", `Agent '${job.asyncId}' is not in the current session.`);
	}
	const steps = status.steps ?? [];
	if (index !== undefined && (index >= steps.length || !steps[index])) {
		return errorResult(
			"management",
			`Agent '${job.asyncId}' has ${steps.length} children. Index ${index} is out of range.`,
		);
	}
	const targetIndexes =
		index !== undefined
			? [index]
			: steps
					.map((step, childIndex) =>
						step.status === "running" || step.status === "pending" ? childIndex : undefined,
					)
					.filter((childIndex): childIndex is number => childIndex !== undefined);
	if (targetIndexes.length === 0) {
		return errorResult("management", `Agent '${job.asyncId}' has no running child to steer.`);
	}
	const requestId = randomUUID();
	try {
		const request: Parameters<typeof requestAsyncSteer>[1] = {
			id: requestId,
			message,
			source: "agent-steer",
		};
		if (parentRunOrigin) request.parentRunOrigin = parentRunOrigin;
		if (index !== undefined) request.targetIndex = index;
		else request.targetIndexes = targetIndexes;
		requestAsyncSteer(job.asyncDir, request);
	} catch (error) {
		return errorResult(
			"management",
			`Failed to steer Agent ${job.asyncId}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const waited = await Effect.runPromise(
		waitForSteeringAction({
			asyncDir: job.asyncDir,
			sourceRunId: job.asyncId,
			requestId,
			timeoutMs: 3_000,
			signal,
		}),
	);
	const fallbackTargets = targetIndexes.map((childIndex) => ({
		index: childIndex,
		state: steps[childIndex]?.status === "pending" ? ("scheduled" as const) : ("routed" as const),
	}));
	const steering = waited ?? {
		requestId,
		state: fallbackTargets.every((target) => target.state === "scheduled")
			? ("scheduled" as const)
			: ("pending" as const),
		sourceRunId: job.asyncId,
		targets: fallbackTargets,
	};
	const failed = steering.state === "failed" || steering.state === "partial";
	const label =
		steering.state === "delivered"
			? "delivered"
			: steering.state === "scheduled"
				? "scheduled"
				: steering.state === "pending"
					? "pending acknowledgment"
					: steering.state;
	const result: AgentToolResult<Details> = {
		content: [{ type: "text", text: `Steering ${label} for Agent ${job.asyncId} (request ${requestId}).` }],
		details: { mode: "management", results: [], steering },
	};
	if (failed) result.isError = true;
	return result;
}

export function createSubagentExecutor(deps: ExecutorDeps) {
	const engines: ExecutorEngines = { ...DEFAULT_ENGINES, ...deps.engines };
	const execute = async (
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
		hooks?: SubagentExecutionHooks,
	): Promise<AgentToolResult<Details>> => {
		deps.state.baseCwd = ctx.cwd;
		deps.state.foregroundRuns ??= new Map();
		deps.state.foregroundControls ??= new Map();
		deps.state.lastForegroundControlId ??= null;
		if (params.action && deps.allowMutatingManagementActions === false) {
			return errorResult("management", "Agent management actions are unavailable inside a nested Agent owner.");
		}
		if (params.action) return controlAction(params, ctx, deps, engines, signal, hooks);

		const foreground = (params.async ?? deps.asyncByDefault) !== true;
		let ownedNestedRoute: PreparedLaunch["nestedRoute"] | undefined;
		let backgroundOwnsRoute = false;
		let foregroundLifecycleOwnsRoute = false;
		try {
			const prepared = await prepareLaunch(id, params, ctx, deps);
			if ("content" in prepared) return prepared;
			if (!prepared.inheritedNestedRoute) ownedNestedRoute = prepared.nestedRoute;
			let result: AgentToolResult<Details>;
			if (foreground) {
				result = await Effect.runPromise(
					Effect.scoped(
						Effect.gen(function* () {
							yield* attachContextProjection(prepared, ctx, deps.projectContext);
							return yield* launchForeground(prepared, deps, engines, signal, onUpdate, hooks, () => {
								foregroundLifecycleOwnsRoute = true;
							});
						}),
					),
				);
				// A foreground adapter may return detached children after losing its
				// owner while their writer liveness is still unknown. Their durable
				// runtime remains authoritative until the tracker terminalizes it.
				foregroundLifecycleOwnsRoute = result.details.results.some((child) => child.detached === true);
			} else {
				await Effect.runPromise(attachContextProjection(prepared, ctx, deps.projectContext));
				result = await launchBackground(prepared, deps, engines, hooks);
			}
			backgroundOwnsRoute = !foreground && Boolean(result.details.asyncId);
			return result;
		} catch (error) {
			return errorResult(
				params.tasks?.length ? "parallel" : "single",
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			if (ownedNestedRoute && !backgroundOwnsRoute && !foregroundLifecycleOwnsRoute) {
				try {
					await retireUnusedNestedRoute(ownedNestedRoute);
				} catch {
					// A committed runner retires its route after durable terminalization.
				}
			}
		}
	};
	return { execute };
}
