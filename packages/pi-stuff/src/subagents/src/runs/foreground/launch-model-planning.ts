import {
	type ContextEvent,
	type ExtensionAPI,
	type ExtensionContext,
	estimateTokens,
	formatSkillsForPrompt,
	getAgentDir,
	loadProjectContextFiles,
	loadSkills,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { isRuntimeFunction, isRuntimeNumber } from "../../../../shared/runtime-type.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import { findModelInfo, type ModelInfo } from "../../shared/model-info.ts";
import { type ResolvedToolBudget, wrapForkTask } from "../../shared/types.ts";
import type {
	AsyncExecutionContext,
	ResolvedTaskBuildInput,
	ResolvedTaskProjection,
} from "../background/resolved-task.ts";
import type { resolveCurrentSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import type { ContextMode } from "../shared/context-mode.ts";
import { deferredModule } from "../shared/deferred-module.ts";
import { buildModelCandidates, resolveEffectiveSubagentModel, resolveModelOrigin } from "../shared/model-fallback.ts";
import type { RunnerAgentTask } from "../shared/parallel-utils.ts";
import { resolvePiLaunchToolPlan } from "../shared/pi-args.ts";
import {
	type PreparedLaunch,
	resolvedTaskInput,
	type SubagentParamsLike,
	type TaskParam,
	taskInputs,
} from "./executor-contract.ts";

const CHILD_RUNTIME_RESERVE_RATIO = 0.25;
const loadResolvedTask = deferredModule(() => import("../background/resolved-task.ts"));
const CHILD_TOOL_REQUEST_FRAMING_TOKENS = 512;
const CHILD_UNKNOWN_TOOL_SURFACE_TOKENS = 32 * 1024;
const CHILD_EXPLICIT_EXTENSION_SURFACE_TOKENS = 16 * 1024;
const CHILD_RUNTIME_EXTENSION_SURFACE_TOKENS = 4 * 1024;
function estimateTextTokens(text: string): number {
	// Byte-level BPE and SentencePiece-family tokenizers cannot emit more tokens
	// than the UTF-8 bytes they consume. Use that strict cross-provider upper bound
	// instead of Pi's intentionally rough chars/4 estimate; the latter undercounts
	// astral CJK, emoji, Base64, hashes, and other high-entropy input.
	return Buffer.byteLength(text, "utf8");
}

function estimateContextMessageTokens(message: ContextEvent["messages"][number]): number {
	let piEstimate = 0;
	try {
		piEstimate = estimateTokens(message);
	} catch {
		// The serialized conservative estimate below remains available.
	}
	let serializedEstimate = Number.POSITIVE_INFINITY;
	try {
		const serialized = JSON.stringify(message);
		if (serialized !== undefined) serializedEstimate = estimateTextTokens(serialized);
	} catch {
		// A message that cannot be serialized must never be admitted as a raw fork.
	}
	return Math.max(piEstimate, serializedEstimate);
}

function inheritedContextSnapshot(ctx: ExtensionContext) {
	let effective: number | undefined;
	try {
		const value = ctx.getContextUsage()?.tokens;
		if (isRuntimeNumber(value) && Number.isFinite(value) && value >= 0) effective = value;
	} catch {
		// Continue with the persisted branch estimator.
	}
	try {
		const entries: SessionEntry[] = [...ctx.sessionManager.buildContextEntries()];
		const persistedMessages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
		const messages = entries
			.filter(
				(entry) =>
					entry.type !== "message" || entry.message.role !== "assistant" || entry.message.stopReason !== "pending",
			)
			.flatMap((entry) => sessionEntryToContextMessages(entry));
		const persisted = persistedMessages.reduce((total, message) => total + estimateContextMessageTokens(message), 0);
		// A native fork clones persisted branch entries, not the post-transform
		// prompt reported by getContextUsage(). Magic Context can make the latter
		// much smaller, so use the conservative larger estimate.
		return { messages: [...messages], tokens: Math.max(effective ?? 0, persisted) };
	} catch {
		// If the persisted branch cannot be measured, the live usage may be a
		// much smaller Magic-transformed prompt. Force the bounded projection path
		// instead of risking an oversized native clone.
		return { tokens: Number.POSITIVE_INFINITY };
	}
}

function inheritedLaunchPromptTokens(ctx: ExtensionContext): number {
	let promptTokens = 0;
	try {
		promptTokens = estimateTextTokens(ctx.getSystemPrompt());
	} catch {
		// Older compatible Hosts or focused tests may not expose this optional seam.
	}
	try {
		const getOptions =
			"getSystemPromptOptions" in ctx && isRuntimeFunction(ctx.getSystemPromptOptions)
				? ctx.getSystemPromptOptions
				: undefined;
		const options = getOptions?.call(ctx);
		const serialized = JSON.stringify(options);
		if (serialized !== undefined) promptTokens = Math.max(promptTokens, estimateTextTokens(serialized));
	} catch {
		// The proportional runtime reserve still covers the unknown Host surface.
	}
	return promptTokens;
}

function inheritedReplacementPromptTokens(
	cwd: string,
	agent: Pick<RunnerAgentTask, "inheritProjectContext" | "inheritSkills">,
) {
	try {
		let retained = "";
		if (agent.inheritProjectContext) {
			const contextFiles = loadProjectContextFiles({ cwd, agentDir: getAgentDir() });
			if (contextFiles.length > 0) {
				retained += "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
				for (const contextFile of contextFiles) {
					retained += `<project_instructions path="${contextFile.path}">\n${contextFile.content}\n</project_instructions>\n\n`;
				}
				retained += "</project_context>\n";
			}
		}
		if (agent.inheritSkills) {
			const skills = loadSkills({
				cwd,
				agentDir: getAgentDir(),
				skillPaths: [],
				includeDefaults: true,
			}).skills;
			if (skills.length > 0) retained += formatSkillsForPrompt(skills);
		}
		retained += `\nCurrent working directory: ${cwd.replace(/\\/gu, "/")}`;
		return {
			tokens: estimateTextTokens(retained),
			// ExtensionContext deliberately does not expose the command-only Host
			// construction options. When replacement mode retains any ambient
			// resources, use a bounded projection and let the final payload gate cover
			// package-provided resources that cannot be inspected at this seam.
			rawForkSafe: !agent.inheritProjectContext && !agent.inheritSkills,
		};
	} catch {
		// Resource discovery failure must not admit an unmeasured child payload.
	}
	if (!agent.inheritProjectContext && !agent.inheritSkills) {
		return { tokens: estimateTextTokens(cwd), rawForkSafe: true };
	}
	return { tokens: Number.POSITIVE_INFINITY, rawForkSafe: false };
}

function childLaunchSurfaceTokens(
	pi: ExtensionAPI,
	input: ResolvedTaskBuildInput,
	resolved: ResolvedTaskProjection,
): number {
	if (!isRuntimeFunction(pi.getAllTools) || !isRuntimeFunction(pi.getActiveTools)) return 0;
	const { agent, params } = input;
	try {
		const plan = resolvePiLaunchToolPlan({
			tools: agent.tools,
			extensions: agent.extensions,
			subagentOnlyExtensions: agent.subagentOnlyExtensions,
			mcpDirectTools: agent.mcpDirectTools,
			cwd: resolved.taskCwd,
			childBaseExtensionPath: params.childBaseExtensionPath,
			requireReadTool: agent.inheritSkills || resolved.skillNames.length > 0,
			capabilityCeiling: resolved.capabilityCeiling,
		});
		const requestedNames = [
			...new Set(
				plan.explicitToolAllowlist ? plan.effectiveToolAllowlist : [...pi.getActiveTools(), ...plan.internalTools],
			),
		];
		const configured = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
		let tokens = CHILD_RUNTIME_EXTENSION_SURFACE_TOKENS;
		for (const name of requestedNames) {
			const tool = configured.get(name);
			if (!tool) {
				tokens += CHILD_UNKNOWN_TOOL_SURFACE_TOKENS;
				continue;
			}
			try {
				// JSON omits executable callbacks while retaining every current and
				// future serializable prompt/schema field (including prompt guidelines).
				tokens += estimateTextTokens(JSON.stringify(tool));
			} catch {
				tokens += CHILD_UNKNOWN_TOOL_SURFACE_TOKENS;
			}
			tokens += CHILD_TOOL_REQUEST_FRAMING_TOKENS;
		}
		tokens += plan.configuredExtensions.length * CHILD_EXPLICIT_EXTENSION_SURFACE_TOKENS;
		tokens += estimateTextTokens(
			JSON.stringify({
				extensions: plan.extensionArgs,
				mcpTools: plan.effectiveMcpTools,
				inheritProjectContext: agent.inheritProjectContext,
				inheritSkills: agent.inheritSkills,
			}),
		);
		return tokens;
	} catch {
		// If the real Host surface exists but cannot be inspected or resolved, do
		// not pretend the missing child-only tools are free.
		return CHILD_UNKNOWN_TOOL_SURFACE_TOKENS;
	}
}

function taskModelCandidates(data: PreparedLaunch, task: TaskParam, agent: AgentConfig): string[] {
	const { currentModel, modelScope } = data.executionContext;
	const provider = currentModel?.provider;
	const origin = resolveModelOrigin({ explicitModel: task.model, agentModel: agent.model, parentModel: currentModel });
	const primary = resolveEffectiveSubagentModel(
		task.model,
		agent.model,
		currentModel,
		data.availableModels,
		provider,
		{ scope: modelScope },
	);
	return buildModelCandidates(primary, agent.fallbackModels, data.availableModels, provider, {
		scope: modelScope,
		origin,
	});
}

export function projectionTokenBudget(data: PreparedLaunch): number {
	let launchBudget = Number.POSITIVE_INFINITY;
	const provider = data.executionContext.currentModel?.provider;
	for (const [index, task] of taskInputs(data.params).entries()) {
		if (data.context === "fork" && data.rawForkByIndex[index]) continue;
		const agent = data.agents.find((candidate) => candidate.name === task.agent);
		if (!agent) return 0;
		const candidates = data.modelCandidatesByIndex[index] ?? taskModelCandidates(data, task, agent);
		if (candidates.length === 0) return 0;
		const knownTokens =
			data.fixedInputTokensByIndex[index] ??
			estimateTextTokens(task.task) + estimateTextTokens(agent.systemPrompt ?? "");
		for (const candidate of candidates) {
			const model = findModelInfo(candidate, data.availableModels, provider);
			if (!model?.contextWindow || !model.maxTokens) return 0;
			const reserve = Math.floor(model.contextWindow * CHILD_RUNTIME_RESERVE_RATIO);
			launchBudget = Math.min(launchBudget, model.contextWindow - model.maxTokens - reserve - knownTokens);
		}
	}
	return Number.isFinite(launchBudget) ? Math.max(0, Math.floor(launchBudget)) : 0;
}

function forkInputCapacity(model: ModelInfo): number | undefined {
	if (
		!isRuntimeNumber(model.contextWindow) ||
		!Number.isFinite(model.contextWindow) ||
		model.contextWindow <= 0 ||
		!isRuntimeNumber(model.maxTokens) ||
		!Number.isFinite(model.maxTokens) ||
		model.maxTokens <= 0
	)
		return undefined;
	const runtimeReserve = Math.floor(model.contextWindow * CHILD_RUNTIME_RESERVE_RATIO);
	return Math.max(0, Math.floor(model.contextWindow - model.maxTokens - runtimeReserve));
}

function approximateTokens(tokens: number): string {
	if (!Number.isFinite(tokens)) return "an unmeasurable number of";
	return tokens >= 1_000 ? `about ${Math.ceil(tokens / 1_000).toLocaleString("en-US")}k` : String(Math.ceil(tokens));
}

interface LaunchModelPlanInput {
	runId: string;
	params: SubagentParamsLike;
	agents: readonly AgentConfig[];
	ctx: ExtensionContext;
	executionContext: AsyncExecutionContext;
	context: ContextMode;
	effectiveCwd: string;
	availableModels: ModelInfo[];
	toolBudget?: ResolvedToolBudget | undefined;
	toolTimeoutMs?: number | undefined;
	capabilityCeiling?: ReturnType<typeof resolveCurrentSubagentCapabilityCeiling> | undefined;
	maxSubagentDepth: number;
	childBaseExtensionPath?: string | undefined;
}

interface TaskModelPlanState {
	readonly input: LaunchModelPlanInput;
	readonly taskCount: number;
	readonly forkTokens: number;
	readonly launchPromptTokens: number;
	readonly fixedInputTokensByIndex: number[];
	readonly rawForkByIndex: boolean[];
}

async function planTaskModels(
	state: TaskModelPlanState,
	task: TaskParam,
	index: number,
): Promise<string[] | undefined> {
	const { input } = state;
	const agent = input.agents.find((candidate) => candidate.name === task.agent);
	if (!agent) throw new Error(`Unknown Agent: ${task.agent}`);
	const taskInput = resolvedTaskInput(task, input.context === "fork" ? wrapForkTask(task.task) : task.task);
	const buildInput: ResolvedTaskBuildInput = {
		runId: input.runId,
		index,
		taskInput,
		agent,
		params: {
			ctx: input.executionContext,
			availableModels: input.availableModels,
			cwd: input.effectiveCwd,
			maxSubagentDepth: input.maxSubagentDepth,
			toolBudget: input.toolBudget,
			toolTimeoutMs: input.toolTimeoutMs,
			capabilityCeiling: input.capabilityCeiling,
			childBaseExtensionPath: input.childBaseExtensionPath,
		},
		runnerCwd: input.effectiveCwd,
		context: input.context,
		thinkingOverride: input.params.thinking,
	};
	if (taskInput.skill === false) buildInput.skills = [];
	const { resolveTaskProjection } = await loadResolvedTask();
	const resolved = await resolveTaskProjection(buildInput);
	if ("error" in resolved) throw new Error(resolved.error);
	const candidates = resolved.modelCandidates;
	const replacementPromptEstimate =
		agent.systemPromptMode === "replace"
			? inheritedReplacementPromptTokens(resolved.taskCwd, agent)
			: { tokens: state.launchPromptTokens, rawForkSafe: true };
	const taskTokens =
		estimateTextTokens(taskInput.task) +
		estimateTextTokens(resolved.systemPrompt.trim()) +
		replacementPromptEstimate.tokens +
		childLaunchSurfaceTokens(input.executionContext.pi, buildInput, resolved);
	state.fixedInputTokensByIndex[index] = taskTokens;
	if (input.context !== "fork") {
		state.rawForkByIndex[index] = false;
		return candidates.length > 0 ? candidates : undefined;
	}
	const provider = input.executionContext.currentModel?.provider;
	const projectedCandidates = candidates.filter((candidate) => {
		const model = findModelInfo(candidate, input.availableModels, provider);
		const capacity = model ? forkInputCapacity(model) : undefined;
		return capacity !== undefined && taskTokens <= capacity;
	});
	const allCandidatesFitRaw =
		replacementPromptEstimate.rawForkSafe &&
		candidates.length > 0 &&
		projectedCandidates.length === candidates.length &&
		candidates.every((candidate) => {
			const model = findModelInfo(candidate, input.availableModels, provider);
			const capacity = model ? forkInputCapacity(model) : undefined;
			return capacity !== undefined && state.forkTokens + taskTokens <= capacity;
		});
	if (allCandidatesFitRaw) {
		state.rawForkByIndex[index] = true;
		return candidates;
	}
	if (projectedCandidates.length > 0) {
		state.rawForkByIndex[index] = false;
		return projectedCandidates;
	}
	const capacities = candidates
		.map((candidate) => {
			const model = findModelInfo(candidate, input.availableModels, provider);
			const capacity = model ? forkInputCapacity(model) : undefined;
			return `${candidate}: ${capacity === undefined ? "limits unavailable" : `${approximateTokens(capacity)} input tokens`}`;
		})
		.join(", ");
	const taskLabel = state.taskCount > 1 ? ` task ${index + 1} (${task.agent})` : ` Agent '${task.agent}'`;
	throw new Error(
		`Cannot start forked${taskLabel}: the fixed child instruction requires ${approximateTokens(
			taskTokens,
		)} input tokens before any bounded parent projection, but no candidate model has safe capacity${capacities ? ` (${capacities})` : ""}. ` +
			"Shorten the task or choose a model with a larger context window.",
	);
}

export async function prepareLaunchModelPlan(input: LaunchModelPlanInput) {
	const tasks = taskInputs(input.params);
	const forkSnapshot: { readonly messages?: ContextEvent["messages"]; readonly tokens: number } =
		input.context === "fork" ? inheritedContextSnapshot(input.ctx) : { tokens: 0 };
	const fixedInputTokensByIndex: number[] = [];
	const rawForkByIndex: boolean[] = [];
	const state: TaskModelPlanState = {
		input,
		taskCount: tasks.length,
		forkTokens: forkSnapshot.tokens,
		launchPromptTokens: inheritedLaunchPromptTokens(input.ctx),
		fixedInputTokensByIndex,
		rawForkByIndex,
	};
	const modelCandidatesByIndex: Array<string[] | undefined> = [];
	for (const [index, task] of tasks.entries()) {
		modelCandidatesByIndex.push(await planTaskModels(state, task, index));
	}
	const plan: Pick<PreparedLaunch, "rawForkByIndex" | "fixedInputTokensByIndex" | "modelCandidatesByIndex"> &
		Partial<Pick<PreparedLaunch, "forkContextTokens" | "forkSourceMessages">> = {
		rawForkByIndex,
		fixedInputTokensByIndex,
		modelCandidatesByIndex,
	};
	if (input.context === "fork") plan.forkContextTokens = forkSnapshot.tokens;
	if (input.context === "fork" && forkSnapshot.messages) plan.forkSourceMessages = forkSnapshot.messages;
	return plan;
}
