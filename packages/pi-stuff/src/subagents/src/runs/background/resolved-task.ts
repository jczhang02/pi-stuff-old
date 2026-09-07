/** Resolve Agent launch contracts without owning process or lifecycle state. */

import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentWorkOrigin } from "../../../../conversation-ui/agent-run-origin.ts";
import type { PonytailMode } from "../../../../ponytail/types.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import { normalizeSkillInput } from "../../agents/skill-input.ts";
import { resolveDisplayDescription } from "../../shared/display-description.ts";
import { agentDefinitionDigest, type LaunchBindingInput, launchBindingDigest } from "../../shared/launch-contract.ts";
import { findModelInfo, resolveEffectiveThinking } from "../../shared/model-info.ts";
import {
	type ArtifactConfig,
	type ResolvedControlConfig,
	type ResolvedToolBudget,
	type ResolvedTurnBudget,
	resolveChildMaxSubagentDepth,
	type ToolBudgetConfig,
} from "../../shared/types.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import {
	decodeSubagentCapabilityCeiling,
	type ResolvedSubagentCapabilityCeiling,
	SUBAGENT_CAPABILITY_CEILING_ENV,
} from "../shared/capability-ceiling.ts";
import type { ContextMode } from "../shared/context-mode.ts";
import {
	resolveMcpDirectToolSelections,
	unresolvedMcpDirectToolSelectors,
} from "../shared/mcp-direct-tool-allowlist.ts";
import {
	type AvailableModelInfo,
	assertModelCandidateLimit,
	buildModelCandidates,
	type ModelOrigin,
	type ParentModel,
	resolveEffectiveSubagentModel,
	resolveModelOrigin,
} from "../shared/model-fallback.ts";
import type { ModelScopeConfig } from "../shared/model-scope.ts";
import type { RunnerAgentTask } from "../shared/parallel-utils.ts";
import { resolvePiLaunchToolPlan } from "../shared/pi-args.ts";
import { validateToolBudgetConfig } from "../shared/tool-budget.ts";
import { resolveToolTimeoutMs, TOOL_TIMEOUT_ENV } from "../shared/tool-timeout.ts";

export interface AsyncExecutionContext {
	pi: ExtensionAPI;
	cwd: string;
	currentSessionId: string;
	/** Ledger namespace used by the cross-process Agent governor. */
	governorSessionId?: string | undefined;
	/** Physical v2 identity written by every new child. */
	physicalSessionId?: string | undefined;
	/** Direct parent session used for supervisor routing from the child. */
	parentSessionId?: string | undefined;
	currentModelProvider?: string | undefined;
	currentModel?: ParentModel | undefined;
	modelScope?: ModelScopeConfig | undefined;
	interactive?: boolean | undefined;
}

export interface AsyncParallelTaskInput {
	agent: string;
	description?: string | undefined;
	delegatedTask?: string | undefined;
	task: string;
	cwd?: string;
	model?: string;
	skill?: string | string[] | false;
	toolBudget?: ToolBudgetConfig;
	toolTimeoutMs?: number;
}

export interface CommonBuildParams {
	ctx: AsyncExecutionContext;
	/** Parent Agent attribution captured before asynchronous launch begins. */
	parentRunOrigin?: AgentWorkOrigin | undefined;
	/** Effective parent Code Mode state captured before child process launch. */
	codeModeEnabled?: boolean | undefined;
	/** Effective parent Ponytail mode captured before child process launch. */
	ponytailMode?: PonytailMode | undefined;
	codeModeProviderTools?: readonly string[] | undefined;
	availableModels?: AvailableModelInfo[] | undefined;
	cwd?: string | undefined;
	maxSubagentDepth: number;
	toolBudget?: ResolvedToolBudget | undefined;
	toolTimeoutMs?: number | undefined;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling | undefined;
	controlConfig?: ResolvedControlConfig | undefined;
	absoluteDeadlineAt?: number | undefined;
	artifactsDir?: string | undefined;
	artifactConfig?: ArtifactConfig | undefined;
	sessionDir?: string | undefined;
	/** Preserve the original governor identity when reviving under a new runtime id. */
	logicalSourceRunId?: string | undefined;
	logicalChildIndex?: number | undefined;
	childBaseExtensionPath?: string | undefined;
}

export interface BackgroundRecoveryDescriptor {
	version: 2;
	sourceRunId: string;
	childIndex: number;
	launchContractDigest?: string;
	agent: string;
	context?: ContextMode;
	sessionFile?: string;
	cwd: string;
	model?: string;
	modelOrigin?: ModelOrigin;
	fallbackModels?: string[];
	thinking?: string;
	tools?: string[];
	excludeTools?: string[];
	extensions?: string[];
	subagentOnlyExtensions?: string[];
	mcpDirectTools?: string[];
	systemPrompt?: string;
	systemPromptMode: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	skills?: string[];
	skillPath?: string[];
	agentFilePath?: string;
	controlConfig?: ResolvedControlConfig;
	absoluteDeadlineAt?: number;
	initialTurnBudget?: ResolvedTurnBudget;
	initialToolBudget?: ResolvedToolBudget;
	toolTimeoutMs?: number;
	maxSubagentDepth: number;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	sessionDir?: string;
	artifactsDir?: string;
	artifactConfig?: ArtifactConfig;
}

export interface BuiltTask {
	task: RunnerAgentTask;
	recovery: BackgroundRecoveryDescriptor;
}

export interface ResolvedTaskBuildInput {
	runId: string;
	index: number;
	taskInput: AsyncParallelTaskInput;
	agent: AgentConfig;
	params: CommonBuildParams;
	runnerCwd: string;
	context?: ContextMode | undefined;
	skills?: string[] | undefined;
	sessionFile?: string | undefined;
	modelOverride?: string | undefined;
	modelOriginOverride?: ModelOrigin | undefined;
	modelCandidatesOverride?: string[] | undefined;
	thinkingOverride?: AgentConfig["thinking"] | undefined;
}

export interface ResolvedTaskProjection {
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	maxSubagentDepth: number;
	modelCandidates: string[];
	modelOrigin: ModelOrigin;
	primaryModel?: string;
	skillNames: string[];
	systemPrompt: string;
	taskCwd: string;
	thinking?: string;
	toolBudget?: ResolvedToolBudget;
	toolPlan: ReturnType<typeof resolvePiLaunchToolPlan>;
	toolTimeoutMs?: number;
}

function resolveTaskToolBudget(
	explicit: ToolBudgetConfig | undefined,
	runBudget: ResolvedToolBudget | undefined,
	agentBudget: ToolBudgetConfig | undefined,
) {
	if (explicit !== undefined) {
		const resolved = validateToolBudgetConfig(explicit, "toolBudget");
		return { toolBudget: resolved.budget, error: resolved.error };
	}
	if (runBudget !== undefined) return { toolBudget: runBudget };
	if (agentBudget !== undefined) {
		const resolved = validateToolBudgetConfig(agentBudget, "agent.toolBudget");
		return { toolBudget: resolved.budget, error: resolved.error };
	}
	return {};
}

function projectBuiltTask(input: ResolvedTaskBuildInput, resolved: ResolvedTaskProjection): BuiltTask {
	const { agent, params, taskInput } = input;
	const definitionDigest = agentDefinitionDigest(agent);
	const launchContractDigest = resolvedLaunchContractDigest(input, resolved, definitionDigest);
	const task: RunnerAgentTask = {
		governorSessionId: params.ctx.governorSessionId ?? params.ctx.currentSessionId,
		physicalSessionId: params.ctx.physicalSessionId ?? params.ctx.currentSessionId,
		parentSessionId: params.ctx.parentSessionId ?? params.ctx.currentSessionId,
		logicalAgentPathComponent: `${params.logicalSourceRunId ?? input.runId}:${
			params.logicalChildIndex ?? input.index
		}`,
		agent: agent.name,
		description: resolveDisplayDescription(taskInput.description, taskInput.task),
		delegatedTask: taskInput.delegatedTask ?? taskInput.task,
		task: taskInput.task,
		cwd: resolved.taskCwd,
		modelCandidates: [...resolved.modelCandidates],
		systemPrompt: resolved.systemPrompt,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		skills: [...resolved.skillNames],
		maxSubagentDepth: resolved.maxSubagentDepth,
		definitionDigest,
		launchBindingTask: taskInput.task,
		launchContractDigest,
	};
	if (input.context) task.context = input.context;
	if (resolved.primaryModel) task.model = resolved.primaryModel;
	if (resolved.thinking) task.thinking = resolved.thinking;
	if (agent.tools) task.tools = [...agent.tools];
	if (agent.excludeTools) task.excludeTools = [...agent.excludeTools];
	if (agent.extensions) task.extensions = [...agent.extensions];
	if (agent.subagentOnlyExtensions) task.subagentOnlyExtensions = [...agent.subagentOnlyExtensions];
	if (agent.mcpDirectTools) task.mcpDirectTools = [...agent.mcpDirectTools];
	if (params.childBaseExtensionPath) task.childBaseExtensionPath = params.childBaseExtensionPath;
	if (input.sessionFile) task.sessionFile = input.sessionFile;
	if (resolved.toolBudget) task.toolBudget = resolved.toolBudget;
	if (resolved.toolTimeoutMs !== undefined) task.toolTimeoutMs = resolved.toolTimeoutMs;
	if (resolved.capabilityCeiling) task.capabilityCeiling = resolved.capabilityCeiling;
	const recovery: BackgroundRecoveryDescriptor = {
		version: 2,
		sourceRunId: params.logicalSourceRunId ?? input.runId,
		childIndex: params.logicalChildIndex ?? input.index,
		launchContractDigest,
		agent: agent.name,
		cwd: resolved.taskCwd,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		maxSubagentDepth: resolved.maxSubagentDepth,
	};
	if (input.context) recovery.context = input.context;
	if (input.sessionFile) recovery.sessionFile = input.sessionFile;
	if (resolved.primaryModel) recovery.model = resolved.primaryModel;
	recovery.modelOrigin = resolved.modelOrigin;
	if (resolved.modelCandidates.length > 1) recovery.fallbackModels = resolved.modelCandidates.slice(1);
	if (resolved.thinking) recovery.thinking = resolved.thinking;
	if (agent.tools) recovery.tools = [...agent.tools];
	if (agent.excludeTools) recovery.excludeTools = [...agent.excludeTools];
	if (agent.extensions) recovery.extensions = [...agent.extensions];
	if (agent.subagentOnlyExtensions) recovery.subagentOnlyExtensions = [...agent.subagentOnlyExtensions];
	if (agent.mcpDirectTools) recovery.mcpDirectTools = [...agent.mcpDirectTools];
	if (resolved.systemPrompt) recovery.systemPrompt = resolved.systemPrompt;
	if (resolved.skillNames.length > 0) recovery.skills = [...resolved.skillNames];
	if (agent.skillPath) recovery.skillPath = [...agent.skillPath];
	if (agent.filePath) recovery.agentFilePath = agent.filePath;
	if (params.controlConfig) recovery.controlConfig = params.controlConfig;
	if (params.absoluteDeadlineAt) recovery.absoluteDeadlineAt = params.absoluteDeadlineAt;
	if (resolved.toolBudget) recovery.initialToolBudget = resolved.toolBudget;
	if (resolved.toolTimeoutMs !== undefined) recovery.toolTimeoutMs = resolved.toolTimeoutMs;
	if (resolved.capabilityCeiling) recovery.capabilityCeiling = resolved.capabilityCeiling;
	if (params.sessionDir) recovery.sessionDir = params.sessionDir;
	if (params.artifactsDir) recovery.artifactsDir = params.artifactsDir;
	if (params.artifactConfig) recovery.artifactConfig = params.artifactConfig;
	return { task, recovery };
}

function resolvedLaunchContractDigest(
	input: ResolvedTaskBuildInput,
	resolved: ResolvedTaskProjection,
	definitionDigest: string,
): string {
	const { agent, taskInput } = input;
	const { toolPlan } = resolved;
	const launchBinding: LaunchBindingInput = {
		definitionDigest,
		task: taskInput.task,
		modelCandidates: resolved.modelCandidates,
		systemPrompt: resolved.systemPrompt,
		systemPromptMode: agent.systemPromptMode,
		inheritProjectContext: agent.inheritProjectContext,
		inheritSkills: agent.inheritSkills,
		skills: resolved.skillNames,
		maxSubagentDepth: resolved.maxSubagentDepth,
	};
	if (resolved.thinking) launchBinding.thinking = resolved.thinking;
	if (toolPlan.effectiveToolAllowlist) launchBinding.tools = toolPlan.effectiveToolAllowlist;
	if (toolPlan.excludeTools.length > 0) launchBinding.excludeTools = toolPlan.excludeTools;
	if (toolPlan.extensionArgs) launchBinding.extensions = toolPlan.extensionArgs;
	if (toolPlan.effectiveMcpTools) launchBinding.mcpDirectTools = toolPlan.effectiveMcpTools;
	if (resolved.toolBudget) launchBinding.toolBudget = resolved.toolBudget;
	if (resolved.toolTimeoutMs !== undefined) launchBinding.toolTimeoutMs = resolved.toolTimeoutMs;
	if (resolved.capabilityCeiling) launchBinding.capabilityCeiling = resolved.capabilityCeiling;
	return launchBindingDigest(launchBinding);
}

function mcpContractError(
	agent: AgentConfig,
	parentCwd: string,
	toolPlan: ReturnType<typeof resolvePiLaunchToolPlan>,
): string | undefined {
	const selectors = agent.mcpDirectTools;
	if (!selectors?.length || toolPlan.capabilityCeiling?.denyExtensions) return undefined;
	const advertisedSelections = resolveMcpDirectToolSelections(selectors, parentCwd);
	const advertisedMissing = unresolvedMcpDirectToolSelectors(selectors, advertisedSelections);
	if (advertisedMissing.length)
		return `Agent '${agent.name}' direct MCP Tool selectors do not resolve in the parent project: ${advertisedMissing.join(", ")}.`;
	const executionMissing = unresolvedMcpDirectToolSelectors(selectors, toolPlan.resolvedMcpSelections);
	if (executionMissing.length)
		return `Agent '${agent.name}' direct MCP Tool selectors do not resolve in the execution cwd: ${executionMissing.join(", ")}.`;
	const signature = (selections: typeof advertisedSelections) =>
		selections
			.map((selection) => `${selection.selector}:${selection.name}`)
			.sort()
			.join(",");
	if (signature(advertisedSelections) === signature(toolPlan.resolvedMcpSelections)) return undefined;
	const names = (selections: typeof advertisedSelections) =>
		selections
			.map((selection) => selection.name)
			.sort()
			.join(", ");
	return `Agent '${agent.name}' direct MCP Tool contract changes with cwd (parent: ${names(advertisedSelections)}; execution: ${names(toolPlan.resolvedMcpSelections)}).`;
}

function resolveTaskModels(input: ResolvedTaskBuildInput) {
	const { agent, params, taskInput } = input;
	const explicitModel = input.modelOverride ?? taskInput.model;
	const modelOrigin =
		input.modelOriginOverride ??
		resolveModelOrigin({
			explicitModel,
			agentModel: agent.model,
			parentModel: params.ctx.currentModel,
		});
	const resolvedPrimaryModel = resolveEffectiveSubagentModel(
		explicitModel,
		agent.model,
		params.ctx.currentModel,
		params.availableModels,
		params.ctx.currentModelProvider,
		{ scope: params.ctx.modelScope, source: modelOrigin === "explicit" ? "explicit" : "inherited" },
	);
	const modelCandidates = input.modelCandidatesOverride?.length
		? [...input.modelCandidatesOverride]
		: buildModelCandidates(
				resolvedPrimaryModel,
				agent.fallbackModels,
				params.availableModels,
				params.ctx.currentModelProvider,
				{ scope: params.ctx.modelScope, origin: modelOrigin },
			);
	assertModelCandidateLimit(modelCandidates);
	const primaryModel = modelCandidates[0] ?? resolvedPrimaryModel;
	return {
		modelCandidates,
		modelOrigin,
		primaryModel,
		thinking: resolveEffectiveThinking(primaryModel, input.thinkingOverride ?? agent.thinking),
	};
}

/** Validate planning inputs without materializing execution or recovery records. */
export async function resolveTaskProjection(
	input: ResolvedTaskBuildInput,
): Promise<ResolvedTaskProjection | { error: string }> {
	const { taskInput, agent, params } = input;
	const taskCwd = resolveChildCwd(input.runnerCwd, taskInput.cwd);
	const normalizedTaskSkills = normalizeSkillInput(taskInput.skill);
	const requestedSkills =
		input.skills ?? (normalizedTaskSkills === false ? [] : normalizedTaskSkills) ?? agent.skills ?? [];
	let systemPrompt = agent.systemPrompt?.trim() ?? "";
	let skillNames: string[] = [];
	if (requestedSkills.length > 0) {
		const { buildSkillInjection, resolveSkillsWithFallback } = await import("../../agents/skills.ts");
		const { resolved: resolvedSkills, missing } = resolveSkillsWithFallback(
			requestedSkills,
			taskCwd,
			params.ctx.cwd,
			agent.skillPath,
			agent.filePath ? path.dirname(agent.filePath) : taskCwd,
		);
		if (missing.length > 0) return { error: `Skills not found: ${missing.join(", ")}` };
		skillNames = resolvedSkills.map((skill) => skill.name);
		if (resolvedSkills.length > 0) {
			const injection = buildSkillInjection(resolvedSkills);
			systemPrompt = systemPrompt ? `${systemPrompt}\n\n${injection}` : injection;
		}
	}

	const { modelCandidates, modelOrigin, primaryModel, thinking } = resolveTaskModels(input);
	const toolBudget = resolveTaskToolBudget(taskInput.toolBudget, params.toolBudget, agent.toolBudget);
	if (toolBudget.error) return { error: toolBudget.error };
	const toolTimeout = resolveToolTimeoutMs({
		callValue: taskInput.toolTimeoutMs ?? params.toolTimeoutMs,
		agentValue: agent.toolTimeoutMs,
		envValue: process.env[TOOL_TIMEOUT_ENV],
	});
	if (toolTimeout.error) return { error: toolTimeout.error };

	const maxSubagentDepth = resolveChildMaxSubagentDepth(params.maxSubagentDepth, agent.maxSubagentDepth);
	const capabilityCeiling = params.capabilityCeiling;
	const toolPlan = resolvePiLaunchToolPlan({
		tools: agent.tools,
		excludeTools: agent.excludeTools,
		extensions: agent.extensions,
		subagentOnlyExtensions: agent.subagentOnlyExtensions,
		mcpDirectTools: agent.mcpDirectTools,
		cwd: taskCwd,
		childBaseExtensionPath: params.childBaseExtensionPath,
		requireReadTool: agent.inheritSkills || skillNames.length > 0,
		capabilityCeiling,
		inheritedCapabilityCeiling: decodeSubagentCapabilityCeiling(process.env[SUBAGENT_CAPABILITY_CEILING_ENV]),
	});
	const directMcpError = mcpContractError(agent, params.ctx.cwd, toolPlan);
	if (directMcpError) return { error: directMcpError };
	const projection: ResolvedTaskProjection = {
		maxSubagentDepth,
		modelCandidates,
		modelOrigin,
		skillNames,
		systemPrompt,
		taskCwd,
		toolPlan,
	};
	if (primaryModel) projection.primaryModel = primaryModel;
	if (thinking) projection.thinking = thinking;
	if (toolBudget.toolBudget) projection.toolBudget = toolBudget.toolBudget;
	if (toolTimeout.toolTimeoutMs !== undefined) projection.toolTimeoutMs = toolTimeout.toolTimeoutMs;
	if (capabilityCeiling) projection.capabilityCeiling = capabilityCeiling;
	return projection;
}

export async function buildResolvedTask(input: ResolvedTaskBuildInput): Promise<BuiltTask | { error: string }> {
	const resolved = await resolveTaskProjection(input);
	if ("error" in resolved) return resolved;
	const built = projectBuiltTask(input, resolved);
	const modelContextWindows: NonNullable<RunnerAgentTask["modelContextWindows"]> = [];
	const modelVerificationRegistry: NonNullable<RunnerAgentTask["modelVerificationRegistry"]> = [];
	for (const model of resolved.modelCandidates) {
		const info = findModelInfo(model, input.params.availableModels, input.params.ctx.currentModelProvider);
		if (!info) continue;
		const { contextWindow } = info;
		if (contextWindow !== undefined && Number.isSafeInteger(contextWindow) && contextWindow > 0) {
			modelContextWindows.push({ model, contextWindow });
		}
		modelVerificationRegistry.push({ provider: info.provider, id: info.id, fullId: info.fullId });
	}
	if (modelContextWindows.length > 0) built.task.modelContextWindows = modelContextWindows;
	if (modelVerificationRegistry.length > 0) built.task.modelVerificationRegistry = modelVerificationRegistry;
	return built;
}
