import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	createEventBus,
	createSyntheticSourceInfo,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type SessionEntry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import type { AgentConfig } from "../../packages/pi-stuff/src/subagents/src/agents/agents.js";
import type { executeAsyncSingle } from "../../packages/pi-stuff/src/subagents/src/runs/background/async-execution.js";
import { steerRequestsDir } from "../../packages/pi-stuff/src/subagents/src/runs/background/control-channel.js";
import { createInitialStatus } from "../../packages/pi-stuff/src/subagents/src/runs/background/initial-status.js";
import { initializeWriterProcessRegistry } from "../../packages/pi-stuff/src/subagents/src/runs/background/writer-process-registry.js";
import {
	type ForegroundExecutionDependencies,
	runForegroundConfig,
} from "../../packages/pi-stuff/src/subagents/src/runs/foreground/execution.js";
import { projectForegroundCompletion } from "../../packages/pi-stuff/src/subagents/src/runs/foreground/result-projection.js";
import {
	createSubagentExecutor,
	deriveLaunchRunId,
} from "../../packages/pi-stuff/src/subagents/src/runs/foreground/subagent-executor.js";
import {
	createNestedRoute,
	projectNestedEvents,
	writeNestedEvent,
} from "../../packages/pi-stuff/src/subagents/src/runs/shared/nested-events.js";
import type {
	BackgroundRunnerConfig,
	BackgroundTaskResult,
} from "../../packages/pi-stuff/src/subagents/src/runs/shared/parallel-utils.js";
import {
	SUBAGENT_CHILD_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_PHYSICAL_SESSION_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_SESSION_ENV,
} from "../../packages/pi-stuff/src/subagents/src/runs/shared/pi-args.js";
import {
	observeForegroundRuntimeRunsAsync,
	recoverForegroundRuntimeRunsAsync,
	refreshForegroundRuntimeRunAsync,
	replayForegroundRuns,
} from "../../packages/pi-stuff/src/subagents/src/session/foreground-replay.js";
import { resolveCurrentSessionId } from "../../packages/pi-stuff/src/subagents/src/shared/session-identity.js";
import { type SubagentState, TEMP_ROOT_DIR } from "../../packages/pi-stuff/src/subagents/src/shared/types.js";
import { createExtensionApi } from "../fixtures/extension-api.js";
import { createExtensionCommandContext } from "../fixtures/extension-context.js";

const temporaryDirectories: string[] = [];
const environment = new Map<string, string | undefined>();

type ForegroundTestDependencies = Omit<Partial<ForegroundExecutionDependencies>, "reapWriters" | "runConfigured"> & {
	readonly reapWriters?: (asyncDir: string) => Promise<{ remaining: number; terminated: number }>;
	readonly runConfigured?: (
		config: BackgroundRunnerConfig,
		onStatus: (status: Parameters<ForegroundExecutionDependencies["onStatus"]>[0]) => void,
	) => Promise<void>;
};

function executeForegroundConfig(
	config: BackgroundRunnerConfig,
	signal?: AbortSignal,
	dependencies: ForegroundTestDependencies = {},
) {
	const { reapWriters, runConfigured, ...rest } = dependencies;
	const adapted: Partial<ForegroundExecutionDependencies> = { ...rest };
	if (reapWriters) {
		adapted.reapWriters = (asyncDir) =>
			Effect.tryPromise({ try: () => reapWriters(asyncDir), catch: (error) => error });
	}
	if (runConfigured) {
		adapted.runConfigured = (foregroundConfig, onStatus) =>
			Effect.tryPromise({ try: () => runConfigured(foregroundConfig, onStatus), catch: (error) => error });
	}
	return Effect.runPromise(runForegroundConfig(config, signal, adapted));
}

function clearEnvironment(name: string): void {
	if (!environment.has(name)) environment.set(name, process.env[name]);
	delete process.env[name];
}

function setEnvironment(name: string, value: string): void {
	if (!environment.has(name)) environment.set(name, process.env[name]);
	process.env[name] = value;
}

const MOCK_SESSION_ENVIRONMENT_KEYS = [
	SUBAGENT_CHILD_ENV,
	"PI_SUBAGENT_DEPTH",
	"PI_SUBAGENT_MAX_DEPTH",
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_PATH_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_SESSION_ENV,
	SUBAGENT_PARENT_PHYSICAL_SESSION_ENV,
] as const;
let sessionEnvironment: Map<(typeof MOCK_SESSION_ENVIRONMENT_KEYS)[number], string | undefined>;

function agent(): AgentConfig {
	return {
		name: "general-purpose",
		description: "General Agent",
		systemPrompt: "Complete the delegated task.",
		systemPromptMode: "append",
		inheritProjectContext: true,
		inheritSkills: true,
		source: "user",
		filePath: "/user-agents/general-purpose.md",
	};
}

function state(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		recentAgentJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		lastUiContext: null,
		completionSeen: new Map(),
	};
}

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];

function toolInfo(tool: Pick<ToolDefinition, "description" | "name" | "parameters" | "promptGuidelines">): ToolInfo {
	const info: ToolInfo = {
		description: tool.description,
		name: tool.name,
		parameters: tool.parameters,
		sourceInfo: createSyntheticSourceInfo(`/test/${tool.name}`, { source: "extension" }),
	};
	if (tool.promptGuidelines !== undefined) info.promptGuidelines = tool.promptGuidelines;
	return info;
}

function userEntry(content: string): SessionEntry {
	return {
		id: "parent-message",
		message: { content, role: "user", timestamp: 0 },
		parentId: null,
		timestamp: "2026-08-06T10:00:00.000Z",
		type: "message",
	};
}

function extensionApiWithoutToolIntrospection(
	overrides: Partial<ExtensionAPI> = {},
	missing: ReadonlySet<"getActiveTools" | "getAllTools"> = new Set(["getActiveTools", "getAllTools"]),
): ExtensionAPI {
	return new Proxy(createExtensionApi(overrides), {
		get(target, property) {
			if (property === "getActiveTools" && missing.has(property)) return undefined;
			if (property === "getAllTools" && missing.has(property)) return undefined;
			// SAFETY: Proxy property keys come from reads against this exact ExtensionAPI target.
			return target[property as keyof ExtensionAPI];
		},
	});
}

type ForegroundTestContext = ExtensionCommandContext & {
	readonly sessionManager: ExtensionCommandContext["sessionManager"] & {
		openSession: () => object | undefined;
	};
};

function context(
	cwd: string,
	models: Array<{ provider: string; id: string; contextWindow: number; maxTokens: number }> = [],
	usageTokens?: number,
): ForegroundTestContext {
	const availableModels = models.map(({ contextWindow, id, maxTokens, provider }) => ({
		api: "openai-responses" as const,
		baseUrl: "https://example.invalid",
		contextWindow,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
		id,
		input: ["text" as const],
		maxTokens,
		name: id,
		provider,
		reasoning: false,
	}));
	const base = createExtensionCommandContext({
		cwd,
		model: {
			api: "openai-responses",
			baseUrl: "https://example.invalid",
			contextWindow: 200_000,
			cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
			id: "model",
			input: ["text"],
			maxTokens: 8_000,
			name: "model",
			provider: "test",
			reasoning: false,
		},
		sessionManager: {
			buildContextEntries: () => [],
			getLeafId: () => "leaf",
			getSessionFile: () => path.join(cwd, "parent.jsonl"),
			getSessionId: () => "parent-session",
		},
		getContextUsage: () =>
			usageTokens === undefined ? undefined : { tokens: usageTokens, contextWindow: 200_000, percent: 1 },
	});
	base.modelRegistry.getAvailable = () => availableModels;
	const sessionManager = Object.assign(base.sessionManager, {
		openSession: () => ({ createBranchedSession: () => path.join(cwd, "parent.jsonl") }),
	});
	return Object.assign(base, { sessionManager });
}

function executor(
	cwd: string,
	runState: SubagentState,
	onBackgroundSingle?: (launch: Parameters<typeof executeAsyncSingle>[1]) => void,
	options: {
		agent?: AgentConfig;
		agents?: AgentConfig[];
		discoverAgents?: (cwd: string) => { agents: AgentConfig[] };
		foregroundCrash?: boolean;
		foregroundDelayMs?: number;
		foregroundError?: Error;
		onForegroundConfig?: (config: BackgroundRunnerConfig) => void;
		onForegroundStatus?: () => void;
		codeModeEnabled?: boolean;
		pi?: ExtensionAPI;
		projectContext?: Parameters<typeof createSubagentExecutor>[0]["projectContext"];
	} = {},
) {
	const pi = options.pi ?? extensionApiWithoutToolIntrospection();
	const delegate = createSubagentExecutor({
		pi,
		state: runState,
		asyncByDefault: true,
		getSubagentSessionRoot: () => path.join(cwd, "sessions"),
		discoverAgents: options.discoverAgents ?? (() => ({ agents: options.agents ?? [options.agent ?? agent()] })),
		projectContext: options.projectContext,
		onForegroundStatus: options.onForegroundStatus,
		resolveCodeModeEnabled:
			options.codeModeEnabled === undefined ? undefined : () => options.codeModeEnabled === true,
		engines: {
			backgroundSingle: async (id, launch) => {
				onBackgroundSingle?.(launch);
				return {
					content: [{ type: "text", text: `Background Agent started [${id}]` }],
					details: { asyncId: id, mode: "single", results: [], runId: id },
				};
			},
			foreground: (config, _signal, dependencies) =>
				Effect.gen(function* () {
					temporaryDirectories.push(config.asyncDir);
					const status = createInitialStatus(config, config.startedAt ?? Date.now());
					const child = status.steps[0];
					if (child) {
						child.status = "running";
						child.currentTool = "read";
						child.turnCount = 2;
					}
					dependencies?.onStatus?.(status);
					options.onForegroundConfig?.(config);
					if (options.foregroundError) return yield* Effect.fail(options.foregroundError);
					if (options.foregroundDelayMs) yield* Effect.sleep(options.foregroundDelayMs);
					return projectForegroundCompletion(config, {
						id: config.id,
						runId: config.id,
						mode: config.work.mode,
						state: options.foregroundCrash ? "failed" : "complete",
						success: !options.foregroundCrash,
						results: (config.work.mode === "single" ? [config.work.task] : config.work.group.tasks).map(
							(task, index) => {
								const result: BackgroundTaskResult = {
									agent: task.agent,
									output: `result-${index + 1}`,
									success: !options.foregroundCrash,
									exitCode: options.foregroundCrash ? 1 : 0,
									sessionFile: path.join(cwd, `child-${index}.jsonl`),
								};
								if (task.context !== undefined) result.context = task.context;
								if (options.foregroundCrash)
									result.writerProcesses = [
										{
											attempt: 0,
											closeObservedAt: Date.now(),
											exitCode: null,
											kind: "pi-writer",
											processInstanceId: "external-crash",
											signal: "SIGSEGV",
											terminationOrigin: "external",
										},
									];
								return result;
							},
						),
					});
				}),
		},
	});
	return {
		execute: (...args: Parameters<typeof delegate.execute>) => {
			const [id, params, signal, onUpdate, ctx, hooks] = args;
			return delegate.execute(
				id,
				{
					...params,
					launchRunId: params.launchRunId ?? deriveLaunchRunId(id, { sessionId: cwd, ownerAgentPath: [] }),
				},
				signal,
				onUpdate,
				ctx,
				hooks,
			);
		},
	};
}

export type { BackgroundRunnerConfig };
export {
	agent,
	clearEnvironment,
	context,
	createEventBus,
	createExtensionApi,
	createInitialStatus,
	createNestedRoute,
	deriveLaunchRunId,
	type executeAsyncSingle,
	executeForegroundConfig,
	executor,
	extensionApiWithoutToolIntrospection,
	fs,
	initializeWriterProcessRegistry,
	observeForegroundRuntimeRunsAsync,
	os,
	path,
	projectForegroundCompletion,
	projectNestedEvents,
	recoverForegroundRuntimeRunsAsync,
	refreshForegroundRuntimeRunAsync,
	replayForegroundRuns,
	resolveCurrentSessionId,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PHYSICAL_SESSION_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_SESSION_ENV,
	setEnvironment,
	state,
	steerRequestsDir,
	TEMP_ROOT_DIR,
	temporaryDirectories,
	toolInfo,
	userEntry,
	writeNestedEvent,
};

export function setupForegroundEngineFixtures(): void {
	sessionEnvironment = new Map(MOCK_SESSION_ENVIRONMENT_KEYS.map((key) => [key, process.env[key]] as const));
	for (const key of MOCK_SESSION_ENVIRONMENT_KEYS) delete process.env[key];
}

export function cleanupForegroundEngineFixtures(): void {
	for (const [name, value] of environment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	environment.clear();
	for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
	for (const [key, value] of sessionEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}
