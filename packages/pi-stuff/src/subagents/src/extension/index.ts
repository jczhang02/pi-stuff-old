import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { projectCurrentContext } from "../../../context-management/index.js";
import {
	type CommandDialogCoordinator,
	getCommandDialogCoordinator,
	readCurrentAgentWorkOrigin,
} from "../../../conversation-ui/index.js";
import { installEffectFoundation } from "../../../shared/effect-foundation.js";
import { isRuntimeFunction } from "../../../shared/runtime-type.js";
import { registerSuiteOwnedTool } from "../../../tool-display/index.js";
import { type AgentConfig, type AgentDiscoveryResult, type AgentScope, discoverAgents } from "../agents/agents.ts";
import { createNativeSupervisorChannel } from "../intercom/native-supervisor-channel.ts";
import { createAsyncJobTracker } from "../runs/background/async-job-tracker.ts";
import { createResultWatcher } from "../runs/background/result-watcher.ts";
import { inspectWriterProcessLivenessEffect } from "../runs/background/writer-process-registry.ts";
import { resolvePiLaunchToolPlan, SUBAGENT_CHILD_ENV } from "../runs/shared/pi-args.ts";
import { AgentEffectOwner } from "../runtime/agent-effect-owner.ts";
import type { AgentExecutionCoordinatorPort } from "../runtime/agent-execution-coordinator.ts";
import { createDurableAgentExecutionCoordinator } from "../runtime/durable-agent-execution-coordinator.ts";
import { maintainAgentRuntime } from "../runtime/runtime-maintenance.ts";
import {
	type PrepareSessionGovernorCompatibilityInput,
	prepareSessionGovernorCompatibility,
} from "../runtime/session-governor-compatibility.ts";
import {
	type AgentControlAcknowledgement,
	type AgentRow,
	CurrentAgents,
	type CurrentAgentsOptions,
} from "../session/current-agents.ts";
import { ensureAccessibleDir } from "../shared/accessible-dir.ts";
import { maintainAgentArtifacts } from "../shared/artifacts.ts";
import {
	ASYNC_DIR,
	DEFAULT_ARTIFACT_CONFIG,
	type Details,
	RESULTS_DIR,
	SESSION_GOVERNOR_ROOT,
	type SubagentState,
	TEMP_ROOT_DIR,
} from "../shared/types.ts";
import { type AgentDialogOptions, openAgentDialog } from "../ui/agent-dialog.ts";
import { AgentRoster, type AgentRosterOptions } from "../ui/agent-roster.ts";
import { readAgentTranscript } from "../ui/agent-transcript.ts";
import { createAgentToolPresentation } from "./agent-tool-presentation.ts";
import { type CompactCompletionNotifier, installCompletionHandling } from "./completion-handling.ts";
import { loadConfig, type PiStuffAgentsConfig } from "./config.ts";
import { agentResultText, normalizePublicAgentParams, type PublicAgentParams } from "./product-executor.ts";
import {
	type ExecutePublicAgent,
	loadSubagentExecutorModule,
	type PublicAgentEngine,
	type PublicAgentExecutionRuntime,
	projectPublicAgentFailure,
	runPublicAgent,
} from "./public-agent-execution.ts";
import { RootSessionRuntime, type RootSupervisor, type RootTracker, type RootWatcher } from "./root-session-runtime.ts";
import { registerAgentRuntimeEvents } from "./runtime-events.ts";
import { SubagentParams } from "./schemas.ts";
import { type AgentToolRosterEntry, buildSubagentToolDescription } from "./tool-description.ts";

export { loadConfig } from "./config.ts";

const RUNTIME_CLEANUP_KEY = "__piStuffAgentsRootCleanup";

const inspectWriterLiveness = (directory: string): Promise<boolean | undefined> =>
	Effect.runPromise(inspectWriterProcessLivenessEffect(directory));

interface RootExecutorInput {
	readonly codeModeProviderTools?: readonly string[] | undefined;
	readonly discoverAgents: (cwd: string, scope: AgentScope) => Promise<AgentDiscoveryResult>;
	readonly pi: ExtensionAPI;
	readonly projectContext: typeof projectCurrentContext;
	readonly resolveCodeModeEnabled?: (() => boolean) | undefined;
	readonly onForegroundStatus?: (() => void) | undefined;
	readonly state: SubagentState;
	readonly childBaseExtensionPath?: string | undefined;
}

interface RootWatcherInput {
	readonly notifier: CompactCompletionNotifier;
	readonly pi: ExtensionAPI;
	readonly state: SubagentState;
}

interface AgentsRuntimeGlobal {
	[RUNTIME_CLEANUP_KEY]?: () => void | Promise<void>;
}

type ExtensionRootRoster = Pick<
	AgentRoster,
	"createFooterTail" | "dispose" | "setContext" | "setFooterHosted" | "setSuppressed"
>;

function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		return path.join(path.dirname(parentSessionFile), path.basename(parentSessionFile, ".jsonl"));
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

const PRODUCTION_DEPENDENCIES = {
	createCurrentAgents: (state: SubagentState, options: CurrentAgentsOptions) => new CurrentAgents(state, options),
	createExecutor: ({
		childBaseExtensionPath,
		codeModeProviderTools,
		discoverAgents: discoverAgentDefinitions,
		onForegroundStatus,
		pi,
		projectContext,
		resolveCodeModeEnabled,
		state,
	}: RootExecutorInput): PublicAgentEngine => {
		let executorPromise: Promise<PublicAgentEngine> | undefined;
		return {
			async execute(...args: Parameters<PublicAgentEngine["execute"]>) {
				if (!executorPromise) {
					executorPromise = loadSubagentExecutorModule()
						.then(({ createSubagentExecutor }) =>
							createSubagentExecutor({
								pi,
								state,
								asyncByDefault: true,
								getSubagentSessionRoot,
								discoverAgents: discoverAgentDefinitions,
								projectContext,
								childBaseExtensionPath,
								codeModeProviderTools,
								resolveCodeModeEnabled,
								onForegroundStatus,
							}),
						)
						.catch((error) => {
							executorPromise = undefined;
							throw error;
						});
				}
				const executor = await executorPromise;
				return executor.execute(...args);
			},
		};
	},
	createGovernorCoordinator: (config: PiStuffAgentsConfig, effects: AgentEffectOwner): AgentExecutionCoordinatorPort =>
		createDurableAgentExecutionCoordinator({
			effects,
			rootDir: SESSION_GOVERNOR_ROOT,
			limits: {
				maxDepth: config.maxSubagentDepth,
				maxRunning: config.maxRunningAgents,
			},
		}),
	prepareGovernorCompatibility: (input: Omit<PrepareSessionGovernorCompatibilityInput, "inspectWriterLiveness">) =>
		prepareSessionGovernorCompatibility({ ...input, inspectWriterLiveness }),
	createRoster: (current: CurrentAgents, options: AgentRosterOptions): ExtensionRootRoster =>
		new AgentRoster(current, options),
	createSupervisor: (pi: ExtensionAPI, state: SubagentState, effects: AgentEffectOwner): RootSupervisor =>
		createNativeSupervisorChannel(pi, state, effects),
	createTracker: (
		pi: ExtensionAPI,
		state: SubagentState,
		onRefresh: () => void,
		effects: AgentEffectOwner,
	): RootTracker => createAsyncJobTracker(pi, state, ASYNC_DIR, { effects, onRefresh }),
	createWatcher: ({ notifier, pi, state }: RootWatcherInput, effects: AgentEffectOwner): RootWatcher =>
		createResultWatcher(pi, state, RESULTS_DIR, 10 * 60 * 1_000, {
			effects,
			notifier,
		}),
	discoverAgents,
	ensureDirectory: ensureAccessibleDir,
	getCoordinator: getCommandDialogCoordinator,
	isChildProcess: () => process.env[SUBAGENT_CHILD_ENV] === "1",
	loadConfiguration: loadConfig,
	maintainRuntime: async (): Promise<void> => {
		await maintainAgentRuntime(TEMP_ROOT_DIR, { inspectWriterLiveness });
		await maintainAgentArtifacts(DEFAULT_ARTIFACT_CONFIG.cleanupDays);
	},
	monotonicNow: () => performance.now(),
	openDialog: openAgentDialog,
	projectContext: projectCurrentContext,
	randomId: (): string => randomUUID(),
};
export type ExtensionRootDependencies = Omit<typeof PRODUCTION_DEPENDENCIES, "maintainRuntime"> & {
	readonly childBaseExtensionPath?: string;
	readonly codeModeProviderTools?: readonly string[];
	readonly maintainRuntime: () => Promise<void> | void;
	readonly resolveCodeModeEnabled?: () => boolean;
};

function createState(): SubagentState {
	const state: SubagentState = {
		baseCwd: "",
		currentSessionId: null,
		currentSessionScope: null,
		parentSessionFile: null,
		asyncJobs: new Map(),
		recentAgentJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
		completionSeen: new Map(),
	};
	return state;
}

function projectAgentRoster(agents: readonly AgentConfig[], cwd: string): AgentToolRosterEntry[] {
	return agents
		.map((agent) => {
			const plan = resolvePiLaunchToolPlan({
				tools: agent.tools,
				extensions: agent.extensions,
				subagentOnlyExtensions: agent.subagentOnlyExtensions,
				mcpDirectTools: agent.mcpDirectTools,
				cwd,
			});
			const entry = { name: agent.name, description: agent.description };
			return plan.explicitToolAllowlist ? { ...entry, tools: plan.effectiveToolAllowlist } : entry;
		})
		.sort((left, right) => left.name.localeCompare(right.name));
}

interface RootAgentSurface {
	readonly current: CurrentAgents;
	bindContext(ctx: ExtensionContext): void;
	dispose(): void;
	showAgents(ctx: ExtensionContext, initialKey?: string): Promise<void>;
}

interface RootAgentSurfaceInput {
	readonly activate: (ctx: ExtensionContext) => Promise<void>;
	readonly coordinator: CommandDialogCoordinator;
	readonly createCurrentAgents: ExtensionRootDependencies["createCurrentAgents"];
	readonly createRoster: ExtensionRootDependencies["createRoster"];
	readonly effects: AgentEffectOwner;
	readonly execute: ExecutePublicAgent;
	readonly openDialog: ExtensionRootDependencies["openDialog"];
	readonly randomId: () => string;
	readonly recoverHistory: (ctx: ExtensionContext) => Promise<void>;
	readonly state: SubagentState;
}

function createRootAgentSurface(input: RootAgentSurfaceInput): RootAgentSurface {
	let current!: CurrentAgents;
	const showAgents = async (ctx: ExtensionContext, initialKey?: string): Promise<void> => {
		if (!ctx.hasUI) return;
		await input.activate(ctx);
		await input.recoverHistory(ctx);
		const options: AgentDialogOptions = initialKey
			? { readTranscript: readAgentTranscript, initialKey }
			: { readTranscript: readAgentTranscript };
		return input.openDialog(ctx, input.coordinator, current, options);
	};
	const runEngineControl = async (
		row: AgentRow,
		action: "resume" | "steer" | "stop",
		message?: string,
	): Promise<AgentControlAcknowledgement> => {
		const ctx = input.state.lastUiContext;
		if (!ctx) return { acknowledged: false, message: "No active parent session is available." };
		let params: PublicAgentParams = { action, id: row.runId, index: row.childIndex };
		if (action === "resume") params = { ...params, acknowledgeCost: true };
		if (message) params = { ...params, message };
		const result = await input.execute(
			input.randomId(),
			params,
			new AbortController().signal,
			undefined,
			ctx,
			"user",
		);
		current.refresh();
		const isError = result.isError === true;
		return {
			acknowledged: !isError,
			message: agentResultText(result) || (isError ? "Agent request failed." : "Agent request acknowledged."),
		};
	};
	current = input.createCurrentAgents(input.state, {
		inspect: async (row) => {
			const ctx = input.state.lastUiContext;
			if (!ctx?.hasUI) return { acknowledged: false, message: "Agent details require the interactive parent." };
			await showAgents(ctx, row.key);
			return { acknowledged: true, message: "Agent details opened." };
		},
		steer: (row, message) => {
			if (input.state.foregroundControls.has(row.runId)) {
				return { acknowledged: false, message: "Live foreground Agents cannot be steered through this surface." };
			}
			return runEngineControl(row, "steer", message);
		},
		stop: (row) => {
			const foreground = input.state.foregroundControls.get(row.runId);
			if (!foreground) return runEngineControl(row, "stop");
			const child = foreground.activeChildren?.get(row.childIndex);
			const accepted =
				child?.interrupt?.() === true ||
				(foreground.currentIndex === row.childIndex && foreground.interrupt?.() === true);
			current.refresh();
			return {
				acknowledged: accepted,
				message: accepted
					? "Foreground Agent interrupt requested."
					: "Foreground Agent is no longer interruptible.",
			};
		},
		resume: (row, message) => runEngineControl(row, "resume", message),
	});
	const roster = input.createRoster(current, {
		effects: input.effects,
		onOpen: (key) => {
			const ctx = input.state.lastUiContext;
			return ctx ? showAgents(ctx, key) : undefined;
		},
	});
	const unregisterChrome = input.coordinator.registerChrome("agents-roster", roster);
	const unregisterFooter =
		input.coordinator.registerFooterTail?.("agents-roster", (tui, theme) => roster.createFooterTail(tui, theme)) ??
		(() => {});
	return {
		current,
		showAgents,
		bindContext: (ctx) => {
			input.state.lastUiContext = ctx;
			roster.setFooterHosted(input.coordinator.hasInstalledFooter?.(ctx) === true);
			roster.setContext(ctx);
		},
		dispose: () => {
			unregisterFooter();
			unregisterChrome();
			roster.dispose();
			current.dispose();
		},
	};
}

function createPublicAgentTool(
	pi: ExtensionAPI,
	getRoster: () => readonly AgentToolRosterEntry[],
	executePublicAgent: ExecutePublicAgent,
): ToolDefinition<typeof SubagentParams, Details> {
	return {
		name: "subagent",
		label: "Agent",
		get description() {
			return buildSubagentToolDescription(getRoster());
		},
		parameters: SubagentParams,
		async execute(id, rawParams, signal, onUpdate, ctx) {
			// SAFETY: ToolDefinition validates rawParams against SubagentParams before invoking execute.
			const supplied = rawParams as PublicAgentParams;
			let params: PublicAgentParams;
			try {
				params = normalizePublicAgentParams(supplied);
			} catch (error) {
				return projectPublicAgentFailure(supplied, error instanceof Error ? error.message : String(error));
			}
			return executePublicAgent(
				id,
				params,
				signal ?? new AbortController().signal,
				onUpdate,
				ctx,
				readCurrentAgentWorkOrigin(pi),
			);
		},
	};
}

function retirePreviousRoot(globalStore: AgentsRuntimeGlobal): Promise<void> {
	const previousCleanup = globalStore[RUNTIME_CLEANUP_KEY];
	if (!isRuntimeFunction(previousCleanup)) return Promise.resolve();
	try {
		return Promise.resolve(previousCleanup()).catch(() => undefined);
	} catch {
		// A stale reload must not prevent the replacement root from registering.
		return Promise.resolve();
	}
}

/** Product composition root: one public tool, one command, and current-session UI only. */
export default function registerSubagentExtension(
	pi: ExtensionAPI,
	overrides: Partial<ExtensionRootDependencies> = {},
): void {
	const deps: ExtensionRootDependencies = { ...PRODUCTION_DEPENDENCIES, ...overrides };
	if (deps.isChildProcess()) return;

	// SAFETY: this Extension owns one literal global slot whose only value is its cleanup callback.
	const globalStore = globalThis as typeof globalThis & AgentsRuntimeGlobal;
	const previousCleanupPromise = retirePreviousRoot(globalStore);
	const config = deps.loadConfiguration();
	const state = createState();
	const effects = new AgentEffectOwner(installEffectFoundation(pi, { deferShutdown: true }));
	const coordinator = deps.getCoordinator(pi);
	let runtime!: RootSessionRuntime;
	let executePublicAgent!: ExecutePublicAgent;
	const surface = createRootAgentSurface({
		activate: (ctx) => runtime.activate(ctx),
		coordinator,
		createCurrentAgents: deps.createCurrentAgents,
		createRoster: deps.createRoster,
		effects,
		execute: (...args) => executePublicAgent(...args),
		openDialog: deps.openDialog,
		randomId: deps.randomId,
		recoverHistory: (ctx) => runtime.recoverHistory(ctx),
		state,
	});
	const current = surface.current;
	const executor = deps.createExecutor({
		onForegroundStatus: () => current.refresh(),
		pi,
		projectContext: deps.projectContext,
		resolveCodeModeEnabled: deps.resolveCodeModeEnabled,
		state,
		childBaseExtensionPath: deps.childBaseExtensionPath,
		codeModeProviderTools: deps.codeModeProviderTools,
		discoverAgents: deps.discoverAgents,
	});
	const executionGovernor = deps.createGovernorCoordinator(config, effects);
	const tracker = deps.createTracker(pi, state, () => current.refresh(), effects);
	const supervisor = deps.createSupervisor(pi, state, effects);
	const notifier = installCompletionHandling(pi, state, coordinator);
	const watcher = deps.createWatcher({ notifier, pi, state }, effects);
	let agentRoster: AgentToolRosterEntry[] = [];
	let disposeRuntimeEvents = (): void => {};
	let cleanup!: () => Promise<void>;
	runtime = new RootSessionRuntime({
		effects,
		bindContext: (ctx) => surface.bindContext(ctx),
		clearGlobalCleanup: () => {
			if (globalStore[RUNTIME_CLEANUP_KEY] === cleanup) delete globalStore[RUNTIME_CLEANUP_KEY];
		},
		config,
		disposeRuntimeEvents: () => disposeRuntimeEvents(),
		disposeSurface: () => surface.dispose(),
		ensureDirectory: deps.ensureDirectory,
		governor: executionGovernor,
		maintainRuntime: deps.maintainRuntime,
		monotonicNow: deps.monotonicNow,
		notifier,
		prepareGovernorCompatibility: deps.prepareGovernorCompatibility,
		previousCleanup: previousCleanupPromise,
		refresh: () => current.refresh(),
		resetAgentRoster: () => {
			agentRoster = [];
		},
		state,
		supervisor,
		tracker,
		watcher,
	});

	const publicAgentRuntime: PublicAgentExecutionRuntime = {
		state,
		governor: executionGovernor,
		engine: executor,
		rootState: () => runtime.rootState(),
		activate: (ctx) => runtime.activate(ctx),
		refreshCompatibility: (ctx) => runtime.refreshGovernorCompatibility(ctx),
		startRunRuntime: (options) => runtime.startRunRuntime(options),
		scheduleMaintenance: () => runtime.scheduleMaintenance(),
		refresh: () => current.refresh(),
		endRun: (runId) => notifier.endRun(runId),
	};
	executePublicAgent = (id, params, signal, onUpdate, ctx, parentRunOrigin) => {
		return runPublicAgent(publicAgentRuntime, { id, params, signal, onUpdate, ctx, parentRunOrigin });
	};
	const tool = createPublicAgentTool(pi, () => agentRoster, executePublicAgent);
	const registeredTool = registerSuiteOwnedTool(pi, tool, createAgentToolPresentation());
	pi.on("before_agent_start", async (_event, ctx) => {
		const root = runtime.rootState();
		if (!root.active) return;
		const discovered = await deps.discoverAgents(ctx.cwd, "both");
		const currentRoot = runtime.rootState();
		if (!currentRoot.active || root.sessionEpoch !== currentRoot.sessionEpoch) return;
		agentRoster = projectAgentRoster(discovered.agents, ctx.cwd);
		// Pi snapshots Tool fields into its provider registry, so refresh after discovery.
		pi.registerTool(registeredTool);
	});
	pi.registerCommand("agents", {
		description: "Inspect and control Agents in the current session",
		handler: async (_args, ctx) => surface.showAgents(ctx),
	});
	disposeRuntimeEvents = registerAgentRuntimeEvents({
		pi,
		state,
		governor: executionGovernor,
		tracker,
		isActive: () => runtime.rootState().active,
		bindContext: (ctx) => surface.bindContext(ctx),
		refresh: () => current.refresh(),
	});
	pi.on("session_start", async (_event, ctx) => runtime.startSession(ctx));

	cleanup = () => runtime.dispose();
	globalStore[RUNTIME_CLEANUP_KEY] = cleanup;
	pi.on("session_shutdown", cleanup);
}
