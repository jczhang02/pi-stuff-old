/** Project resolved Agent launch contracts into single or parallel runner work. */

import type { AgentConfig } from "../../agents/agents.ts";
import { resolveChildCwd } from "../../shared/utils.ts";
import type { ContextMode } from "../shared/context-mode.ts";
import type { ModelOrigin } from "../shared/model-fallback.ts";
import { type BackgroundRunnerWork, MAX_BACKGROUND_TASKS, MAX_PARALLEL_CONCURRENCY } from "../shared/parallel-utils.ts";
import {
	type AsyncParallelTaskInput,
	type BackgroundRecoveryDescriptor,
	type BuiltTask,
	buildResolvedTask,
	type CommonBuildParams,
} from "./resolved-task.ts";

export interface AsyncParallelRunnerWorkBuildParams extends CommonBuildParams {
	agents: AgentConfig[];
	tasks: AsyncParallelTaskInput[];
	contextForAgent?: ((agentName: string) => ContextMode) | undefined;
	thinking?: AgentConfig["thinking"] | undefined;
	thinkingOverridesByIndex?: Array<AgentConfig["thinking"] | undefined> | undefined;
	sessionFilesByIndex?: Array<string | undefined> | undefined;
	modelCandidatesByIndex?: Array<string[] | undefined> | undefined;
	concurrency?: number | undefined;
	globalConcurrencyLimit?: number | undefined;
	worktree?: boolean | undefined;
}

export interface AsyncSingleRunnerWorkBuildParams extends CommonBuildParams {
	agent: string;
	description?: string | undefined;
	delegatedTask?: string | undefined;
	task: string;
	agentConfig: AgentConfig;
	context?: ContextMode | undefined;
	skills?: string[] | undefined;
	sessionFile?: string | undefined;
	modelOverride?: string | undefined;
	modelOrigin?: ModelOrigin | undefined;
	modelCandidates?: string[] | undefined;
	thinkingOverride?: AgentConfig["thinking"] | undefined;
}

export type AsyncRunnerWorkBuildResult<Work extends BackgroundRunnerWork = BackgroundRunnerWork> =
	| {
			runnerCwd: string;
			work: Work;
			recoveries: BackgroundRecoveryDescriptor[];
	  }
	| { error: string };

export type AsyncSingleRunnerWorkBuildResult = AsyncRunnerWorkBuildResult<
	Extract<BackgroundRunnerWork, { mode: "single" }>
>;

export async function buildAsyncParallelRunnerWork(
	id: string,
	params: AsyncParallelRunnerWorkBuildParams,
): Promise<AsyncRunnerWorkBuildResult> {
	if (params.tasks.length === 0) return { error: "Parallel background work requires at least one task." };
	if (params.tasks.length > MAX_BACKGROUND_TASKS) {
		return { error: `Parallel background work supports at most ${MAX_BACKGROUND_TASKS} tasks per launch.` };
	}
	const runnerCwd = resolveChildCwd(params.ctx.cwd, params.cwd);
	const resolved: BuiltTask[] = [];
	for (let index = 0; index < params.tasks.length; index++) {
		const taskInput = params.tasks[index];
		if (!taskInput) return { error: `Parallel task ${index} is missing.` };
		const agent = params.agents.find((candidate) => candidate.name === taskInput.agent);
		if (!agent) return { error: `Unknown agent: ${taskInput.agent}` };
		const built = await buildResolvedTask({
			runId: id,
			index,
			taskInput,
			agent,
			params,
			runnerCwd,
			context: params.contextForAgent?.(taskInput.agent),
			sessionFile: params.sessionFilesByIndex?.[index],
			thinkingOverride: params.thinkingOverridesByIndex?.[index] ?? params.thinking,
			modelCandidatesOverride: params.modelCandidatesByIndex?.[index],
		});
		if ("error" in built) return built;
		resolved.push(built);
	}
	const configuredConcurrency = Math.max(1, Math.floor(params.concurrency ?? MAX_PARALLEL_CONCURRENCY) || 1);
	const concurrency = Math.min(
		params.tasks.length,
		configuredConcurrency,
		Math.max(1, Math.floor(params.globalConcurrencyLimit ?? configuredConcurrency) || 1),
	);
	return {
		runnerCwd,
		work: {
			mode: "parallel",
			group: {
				tasks: resolved.map((entry) => entry.task),
				concurrency,
				worktree: params.worktree === true,
			},
		},
		recoveries: resolved.map((entry) => entry.recovery),
	};
}

export async function buildAsyncSingleRunnerWork(
	id: string,
	params: AsyncSingleRunnerWorkBuildParams,
): Promise<AsyncSingleRunnerWorkBuildResult> {
	const runnerCwd = resolveChildCwd(params.ctx.cwd, params.cwd);
	const built = await buildResolvedTask({
		runId: id,
		index: 0,
		taskInput: {
			agent: params.agent,
			description: params.description,
			delegatedTask: params.delegatedTask,
			task: params.task,
		},
		agent: params.agentConfig,
		params,
		runnerCwd,
		context: params.context,
		skills: params.skills,
		sessionFile: params.sessionFile,
		modelOverride: params.modelOverride,
		modelOriginOverride: params.modelOrigin,
		modelCandidatesOverride: params.modelCandidates,
		thinkingOverride: params.thinkingOverride,
	});
	if ("error" in built) return built;
	return {
		runnerCwd,
		work: { mode: "single", task: built.task },
		recoveries: [built.recovery],
	};
}
