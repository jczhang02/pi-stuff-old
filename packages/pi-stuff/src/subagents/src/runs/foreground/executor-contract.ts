import { createHash } from "node:crypto";
import type { AgentToolResult as CoreAgentToolResult } from "@earendil-works/pi-agent-core";
import type { ContextEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { projectCurrentContext } from "../../../../context-management/index.ts";
import type { AgentWorkOrigin } from "../../../../conversation-ui/agent-run-origin.ts";
import type { AgentConfig, AgentScope } from "../../agents/agents.ts";
import { normalizeSkillInput } from "../../agents/skill-input.ts";
import type { ModelInfo } from "../../shared/model-info.ts";
import type {
	ArtifactConfig,
	Details,
	ResolvedToolBudget,
	SubagentState,
	ToolBudgetConfig,
} from "../../shared/types.ts";
import type { executeAsyncParallel, executeAsyncSingle } from "../background/async-execution.ts";
import type { AsyncExecutionContext, AsyncParallelTaskInput } from "../background/resolved-task.ts";
import type { resolveCurrentSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import type { ContextMode } from "../shared/context-mode.ts";
import type {
	createNestedRoute,
	resolveInheritedNestedRouteFromEnv,
	resolveNestedParentAddressFromEnv,
} from "../shared/nested-events.ts";
import type { runForegroundConfig } from "./execution.ts";

export type AgentToolResult<T> = CoreAgentToolResult<T> & { isError?: boolean };

export function errorResult(
	mode: Details["mode"],
	message: string,
	extras: Partial<Details> = {},
): AgentToolResult<Details> {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [], ...extras },
	};
}

export function resultIsError(value: AgentToolResult<Details>): boolean {
	return value.isError === true;
}

export interface LaunchIdentityScope {
	readonly sessionId: string;
	readonly ownerAgentPath: readonly string[];
}

/** Stable launch identity shared by the public tool, storage, and session-wide governor. */
export function deriveLaunchRunId(toolCallId: string, scope?: LaunchIdentityScope): string {
	const hash = createHash("sha256");
	if (scope) hash.update(JSON.stringify([scope.sessionId, scope.ownerAgentPath]));
	hash.update("\0").update(toolCallId);
	return hash.digest("hex").slice(0, 12);
}

export interface TaskParam {
	agent: string;
	description?: string;
	task: string;
	cwd?: string;
	model?: string;
	skill?: string | string[] | boolean;
	toolBudget?: ToolBudgetConfig;
	toolTimeoutMs?: number;
}

/** Private engine shape. The public Claude-style contract maps into this subset. */
export interface SubagentParamsLike {
	action?: "resume" | "status" | "steer" | "stop";
	id?: string;
	index?: number;
	agent?: string;
	description?: string;
	task?: string;
	message?: string;
	tasks?: TaskParam[];
	worktree?: boolean;
	context?: "fresh" | "fork";
	async?: boolean;
	timeoutMs?: number;
	toolBudget?: ToolBudgetConfig;
	toolTimeoutMs?: number;
	cwd?: string;
	model?: string;
	thinking?: string | false;
	skill?: string | string[] | boolean;
	/** Suite-owned, bounded reference context. Never part of the public tool schema. */
	contextProjection?: string | undefined;
	/** Suite-owned launch identity already bound to the physical parent session. */
	launchRunId?: string;
}

export interface ExecutorEngines {
	backgroundSingle: typeof executeAsyncSingle;
	backgroundParallel: typeof executeAsyncParallel;
	foreground: typeof runForegroundConfig;
}

export function taskInputs(params: SubagentParamsLike): TaskParam[] {
	if (params.tasks?.length) return params.tasks;
	if (!params.agent || !params.task) return [];
	const task: TaskParam = { agent: params.agent, task: params.task };
	if (params.description) task.description = params.description;
	if (params.model) task.model = params.model;
	if (params.skill !== undefined) task.skill = params.skill;
	if (params.toolBudget) task.toolBudget = params.toolBudget;
	if (params.toolTimeoutMs !== undefined) task.toolTimeoutMs = params.toolTimeoutMs;
	return [task];
}

export function resolvedTaskInput(
	task: TaskParam,
	projectedTask: string,
	delegatedTask?: string,
): AsyncParallelTaskInput {
	const input: AsyncParallelTaskInput = { agent: task.agent, task: projectedTask };
	if (task.description) input.description = task.description;
	if (delegatedTask) input.delegatedTask = delegatedTask;
	if (task.cwd) input.cwd = task.cwd;
	if (task.model) input.model = task.model;
	const skill = normalizeSkillInput(task.skill);
	if (skill !== undefined) input.skill = skill;
	if (task.toolBudget) input.toolBudget = task.toolBudget;
	if (task.toolTimeoutMs !== undefined) input.toolTimeoutMs = task.toolTimeoutMs;
	return input;
}

export interface ExecutorDeps {
	pi: ExtensionAPI;
	state: SubagentState;
	asyncByDefault: boolean;
	getSubagentSessionRoot: (parentSessionFile: string | null) => string;
	discoverAgents: (
		cwd: string,
		scope: AgentScope,
	) =>
		| { agents: AgentConfig[]; modelScope?: import("../shared/model-scope.ts").ModelScopeConfig }
		| Promise<{ agents: AgentConfig[]; modelScope?: import("../shared/model-scope.ts").ModelScopeConfig }>;
	projectContext?: typeof projectCurrentContext | undefined;
	childBaseExtensionPath?: string | undefined;
	codeModeProviderTools?: readonly string[] | undefined;
	resolveCodeModeEnabled?: (() => boolean) | undefined;
	onForegroundStatus?: (() => void) | undefined;
	allowMutatingManagementActions?: boolean;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	engines?: Partial<ExecutorEngines>;
}

export interface ForegroundStartBinding {
	readonly runId: string;
	readonly asyncDir: string;
	readonly writerCount: number;
	/** Release a committed start only after proving that no status or writer exists. */
	readonly abortStart: () => boolean;
}

export interface SubagentExecutionHooks {
	/** Called after every fallible launch preflight but before any child writer starts. */
	readonly beforeForegroundStart?: (binding: ForegroundStartBinding) => void | Promise<void>;
	/** Parent Agent attribution captured by the root Capability before launch. */
	readonly parentRunOrigin?: AgentWorkOrigin;
}

export interface PreparedLaunch {
	params: SubagentParamsLike;
	mode: "single" | "parallel";
	effectiveCwd: string;
	agents: AgentConfig[];
	executionContext: AsyncExecutionContext;
	parentSessionFile: string | null;
	availableModels: ModelInfo[];
	runId: string;
	sessionRoot: string;
	artifactConfig: ArtifactConfig;
	artifactsDir: string;
	toolBudget?: ResolvedToolBudget | undefined;
	timeoutMs?: number | undefined;
	context: ContextMode;
	forkContextTokens?: number | undefined;
	/** Frozen persisted branch used for both fork admission and projected fallback. */
	forkSourceMessages?: ContextEvent["messages"] | undefined;
	/** true uses Pi's native raw branch; false uses a bounded projected fork. */
	rawForkByIndex: boolean[];
	fixedInputTokensByIndex: number[];
	modelCandidatesByIndex: Array<string[] | undefined>;
	nestedRoute: ReturnType<typeof createNestedRoute>;
	inheritedNestedRoute?: ReturnType<typeof resolveInheritedNestedRouteFromEnv> | undefined;
	nestedParentAddress?: ReturnType<typeof resolveNestedParentAddressFromEnv> | undefined;
	sessionFiles: Array<string | undefined>;
	thinkingOverrides: Array<AgentConfig["thinking"] | undefined>;
	capabilityCeiling?: ReturnType<typeof resolveCurrentSubagentCapabilityCeiling> | undefined;
	maxSubagentDepth: number;
}
