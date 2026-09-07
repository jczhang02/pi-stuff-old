import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { projectCurrentContext } from "../../../../context-management/index.ts";
import { isRuntimeNumber } from "../../../../shared/runtime-type.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import { getArtifactsDir } from "../../shared/artifacts.ts";
import { createForkContextResolver, forkedChildRequiresThinkingOff } from "../../shared/fork-context.ts";
import { type ModelInfo, toModelInfo } from "../../shared/model-info.ts";
import { resolveCurrentSessionId } from "../../shared/session-identity.ts";
import {
	checkSubagentDepth,
	DEFAULT_ARTIFACT_CONFIG,
	type Details,
	resolveCurrentMaxSubagentDepth,
} from "../../shared/types.ts";
import type { AsyncExecutionContext } from "../background/resolved-task.ts";
import { resolveCurrentSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import type { ContextMode } from "../shared/context-mode.ts";
import { deferredModule } from "../shared/deferred-module.ts";
import { normalizeParentModel, type ParentModel } from "../shared/model-fallback.ts";
import {
	createNestedRoute,
	resolveInheritedNestedRouteFromEnv,
	resolveNestedParentAddressFromEnv,
} from "../shared/nested-events.ts";
import { SUBAGENT_PARENT_PHYSICAL_SESSION_ENV, SUBAGENT_PARENT_SESSION_ENV } from "../shared/pi-args.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import {
	type AgentToolResult,
	deriveLaunchRunId,
	type ExecutorDeps,
	errorResult,
	type PreparedLaunch,
	type SubagentParamsLike,
	taskInputs,
} from "./executor-contract.ts";
import type { prepareLaunchModelPlan } from "./launch-model-planning.ts";

const loadModelPlanning = deferredModule(() => import("./launch-model-planning.ts"));

function requestedMode(params: SubagentParamsLike): "single" | "parallel" {
	return params.tasks?.length ? "parallel" : "single";
}

export function availableModels(ctx: ExtensionContext): ModelInfo[] {
	try {
		return ctx.modelRegistry.getAvailable().map(toModelInfo);
	} catch {
		return [];
	}
}

export function attachContextProjection(
	data: PreparedLaunch,
	ctx: ExtensionContext,
	projectContext: typeof projectCurrentContext | undefined,
): Effect.Effect<void, never> {
	return Effect.gen(function* () {
		data.params.contextProjection = undefined;
		if (!projectContext) return;
		if (data.context === "fork" && data.rawForkByIndex.every(Boolean)) return;
		const { projectionTokenBudget } = yield* Effect.promise(loadModelPlanning);
		const maxTokens = projectionTokenBudget(data);
		if (maxTokens <= 0) return;
		const audience = data.context === "fork" ? "agent-fork" : "agent-fresh";
		const options =
			data.context === "fork" && data.forkSourceMessages
				? { maxTokens, sourceMessages: data.forkSourceMessages }
				: { maxTokens };
		const projection = yield* Effect.tryPromise({
			try: () => projectContext(audience, ctx, options),
			catch: (error) => error,
		}).pipe(Effect.catch(() => Effect.succeed(undefined)));
		if (projection?.text) data.params.contextProjection = projection.text;
	});
}

export function rememberParentModel(
	state: { currentSessionId?: string | null; lastParentModel?: ParentModel },
	sessionId: string,
	model: ExtensionContext["model"],
): ParentModel | undefined {
	if (state.currentSessionId !== sessionId) delete state.lastParentModel;
	state.currentSessionId = sessionId;
	const current = normalizeParentModel(model);
	if (current) state.lastParentModel = current;
	return current ?? state.lastParentModel;
}

function validateLaunchInput(params: SubagentParamsLike, agents: readonly AgentConfig[]): string | undefined {
	const hasSingle = Boolean(params.agent);
	const hasParallel = Boolean(params.tasks?.length);
	if (Number(hasSingle) + Number(hasParallel) !== 1) return "Provide exactly one Agent or one non-empty tasks list.";
	if (hasSingle && !params.task?.trim()) return "A single Agent launch requires task.";
	if (hasSingle && !agents.some((agent) => agent.name === params.agent)) return `Unknown Agent: ${params.agent}`;
	for (const [index, task] of (params.tasks ?? []).entries()) {
		if (!task.task.trim()) return `Agent task ${index + 1} requires task text.`;
		if (!agents.some((agent) => agent.name === task.agent)) return `Unknown Agent: ${task.agent} (task ${index + 1})`;
	}
	return undefined;
}

export function resolveTimeout(value: SubagentParamsLike["timeoutMs"]) {
	if (value === undefined) return {};
	if (!isRuntimeNumber(value) || !Number.isInteger(value) || value <= 0) {
		return { error: "timeoutMs must be a positive integer." };
	}
	return { timeoutMs: value };
}

function contextFor(params: SubagentParamsLike): ContextMode {
	return params.context === "fork" ? "fork" : "fresh";
}

function prepareForkSessions(input: {
	params: SubagentParamsLike;
	ctx: ExtensionContext;
	context: ContextMode;
	parentModel?: ParentModel | undefined;
	availableModels: ModelInfo[];
	modelCandidatesByIndex: Array<string[] | undefined>;
	rawForkByIndex: boolean[];
}) {
	const tasks = taskInputs(input.params);
	if (input.context !== "fork" || !input.rawForkByIndex.some(Boolean)) {
		return {
			sessionFiles: tasks.map(() => undefined),
			thinkingOverrides: tasks.map(() => input.params.thinking),
		};
	}

	const forceThinkingOff = new Map<number, boolean>();
	for (const index of tasks.keys()) {
		if (!input.rawForkByIndex[index]) {
			forceThinkingOff.set(index, false);
			continue;
		}
		const candidates = input.modelCandidatesByIndex[index] ?? [];
		forceThinkingOff.set(
			index,
			candidates.length === 0 ||
				candidates.some((candidate) =>
					forkedChildRequiresThinkingOff(candidate, input.availableModels, input.parentModel?.provider),
				),
		);
	}

	const resolver = createForkContextResolver(input.ctx.sessionManager, "fork", {
		forceThinkingOffForIndex: (index) => forceThinkingOff.get(index) ?? true,
	});
	const sessionFiles = tasks.map((_, index) =>
		input.rawForkByIndex[index] ? resolver.sessionFileForIndex(index) : undefined,
	);
	const thinkingOverrides = tasks.map((_, index) =>
		input.rawForkByIndex[index]
			? (resolver.thinkingOverrideForIndex(index) ?? input.params.thinking)
			: input.params.thinking,
	);
	return { sessionFiles, thinkingOverrides };
}

async function resolveLaunchPreflight(
	params: SubagentParamsLike,
	ctx: ExtensionContext,
	deps: ExecutorDeps,
	mode: "single" | "parallel",
) {
	const depth = checkSubagentDepth();
	if (depth.blocked) {
		return errorResult(
			mode,
			`Nested Agent launch blocked at depth ${depth.depth} (maximum ${depth.maxDepth}). Complete this task directly.`,
		);
	}
	let currentSessionId: string;
	try {
		currentSessionId =
			deps.state.currentSessionId ??
			process.env[SUBAGENT_PARENT_PHYSICAL_SESSION_ENV]?.trim() ??
			resolveCurrentSessionId(ctx.sessionManager, ctx.cwd);
	} catch (error) {
		return errorResult(mode, error instanceof Error ? error.message : String(error));
	}
	const effectiveCwd = path.resolve(ctx.cwd, params.cwd ?? ".");
	const discovered = await deps.discoverAgents(ctx.cwd, "both");
	const validationError = validateLaunchInput(params, discovered.agents);
	if (validationError) return errorResult(mode, validationError);
	return {
		currentSessionId,
		effectiveCwd,
		agents: discovered.agents,
		modelScope: discovered.modelScope,
		parentModel: rememberParentModel(deps.state, currentSessionId, ctx.model),
	};
}

function resolveLaunchBudgets(params: SubagentParamsLike) {
	const timeout = resolveTimeout(params.timeoutMs);
	if (timeout.error) return { error: timeout.error };
	const tool = validateToolBudgetConfig(params.toolBudget, "toolBudget");
	if (tool.error) return { error: tool.error };
	return {
		timeoutMs: timeout.timeoutMs,
		toolBudget: tool.budget,
	};
}

export async function prepareLaunch(
	id: string,
	params: SubagentParamsLike,
	ctx: ExtensionContext,
	deps: ExecutorDeps,
): Promise<PreparedLaunch | AgentToolResult<Details>> {
	const mode = requestedMode(params);
	const preflight = await resolveLaunchPreflight(params, ctx, deps, mode);
	if ("content" in preflight) return preflight;
	const { agents, currentSessionId, effectiveCwd, modelScope, parentModel } = preflight;
	const budgets = resolveLaunchBudgets(params);
	if (budgets.error) return errorResult(mode, budgets.error);

	const parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;
	const runId = params.launchRunId ?? deriveLaunchRunId(id);
	if (!/^[a-f0-9]{12}$/u.test(runId)) return errorResult(mode, "Invalid internal Agent launch identity.");
	const executionContext: AsyncExecutionContext = {
		pi: deps.pi,
		cwd: ctx.cwd,
		currentSessionId,
		governorSessionId: process.env[SUBAGENT_PARENT_SESSION_ENV]?.trim() || currentSessionId,
		physicalSessionId: currentSessionId,
		parentSessionId: ctx.sessionManager.getSessionId()?.trim() || undefined,
		currentModelProvider: parentModel?.provider,
		currentModel: parentModel,
		modelScope,
		interactive: ctx.hasUI,
	};
	const artifactConfig = DEFAULT_ARTIFACT_CONFIG;
	const artifactsDir = getArtifactsDir(parentSessionFile, effectiveCwd, artifactConfig.dir);
	const models = availableModels(ctx);
	const context = contextFor(params);
	const capabilityCeiling = resolveCurrentSubagentCapabilityCeiling(currentSessionId);
	const maxSubagentDepth = resolveCurrentMaxSubagentDepth();
	let modelPlan: Awaited<ReturnType<typeof prepareLaunchModelPlan>>;
	try {
		const { prepareLaunchModelPlan } = await loadModelPlanning();
		modelPlan = await prepareLaunchModelPlan({
			runId,
			params,
			agents,
			ctx,
			executionContext,
			context,
			effectiveCwd,
			availableModels: models,
			toolBudget: budgets.toolBudget,
			toolTimeoutMs: params.toolTimeoutMs,
			capabilityCeiling,
			maxSubagentDepth,
			childBaseExtensionPath: deps.childBaseExtensionPath,
		});
	} catch (error) {
		return errorResult(mode, error instanceof Error ? error.message : String(error));
	}
	let fork: ReturnType<typeof prepareForkSessions>;
	try {
		fork = prepareForkSessions({
			params,
			ctx,
			context,
			parentModel,
			availableModels: models,
			modelCandidatesByIndex: modelPlan.modelCandidatesByIndex,
			rawForkByIndex: modelPlan.rawForkByIndex,
		});
	} catch (error) {
		return errorResult(mode, error instanceof Error ? error.message : String(error));
	}
	const sessionRoot = path.join(deps.getSubagentSessionRoot(parentSessionFile), runId);
	try {
		fs.mkdirSync(sessionRoot, { recursive: true });
	} catch (error) {
		return errorResult(
			mode,
			`Failed to create Agent session directory: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedParentAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const prepared: PreparedLaunch = {
		params,
		mode,
		effectiveCwd,
		agents,
		executionContext,
		parentSessionFile,
		availableModels: models,
		runId,
		sessionRoot,
		artifactConfig,
		artifactsDir,
		toolBudget: budgets.toolBudget,
		timeoutMs: budgets.timeoutMs,
		context,
		rawForkByIndex: modelPlan.rawForkByIndex,
		fixedInputTokensByIndex: modelPlan.fixedInputTokensByIndex,
		modelCandidatesByIndex: modelPlan.modelCandidatesByIndex,
		nestedRoute: inheritedNestedRoute ?? createNestedRoute(runId),
		inheritedNestedRoute,
		nestedParentAddress,
		sessionFiles: fork.sessionFiles,
		thinkingOverrides: fork.thinkingOverrides,
		capabilityCeiling,
		maxSubagentDepth,
	};
	if (modelPlan.forkContextTokens !== undefined) prepared.forkContextTokens = modelPlan.forkContextTokens;
	if (modelPlan.forkSourceMessages) prepared.forkSourceMessages = modelPlan.forkSourceMessages;
	return prepared;
}
