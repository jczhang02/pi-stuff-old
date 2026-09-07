import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { projectCurrentContext } from "../../../context-management/index.ts";
import { installEffectFoundation } from "../../../shared/effect-foundation.ts";
import { isRuntimeFunction } from "../../../shared/runtime-type.ts";
import { registerSuiteOwnedTool } from "../../../tool-display/index.ts";
import { discoverAgents } from "../agents/agents.ts";
import {
	createSubagentExecutor,
	deriveLaunchRunId,
	type SubagentExecutionHooks,
	type SubagentParamsLike,
} from "../runs/foreground/subagent-executor.ts";
import {
	PI_STUFF_AGENT_PATH_ENV,
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_PHYSICAL_SESSION_ENV,
	SUBAGENT_PARENT_SESSION_ENV,
} from "../runs/shared/pi-args.ts";
import { AgentEffectOwner } from "../runtime/agent-effect-owner.ts";
import {
	type AgentExecutionCoordinatorPort,
	type AgentExecutionInvocation,
	AgentRuntimeBindingRejectedError,
	parseAgentOwnerPath,
} from "../runtime/agent-execution-coordinator.ts";
import { createDurableAgentExecutionCoordinator } from "../runtime/durable-agent-execution-coordinator.ts";
import { reportAgentDiagnostic } from "../shared/diagnostics.ts";
import {
	type Details,
	SESSION_GOVERNOR_ROOT,
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_PROCESS_TERMINAL_EVENT,
	type SubagentState,
} from "../shared/types.ts";
import { createAgentToolPresentation } from "./agent-tool-presentation.ts";
import { loadConfig, type PiStuffAgentsConfig } from "./config.ts";
import {
	normalizePublicAgentParams,
	type PublicAgentParams,
	projectEngineResult,
	toEngineParams,
} from "./product-executor.ts";
import { FanoutChildSubagentParams } from "./schemas.ts";
import { buildFanoutChildSubagentToolDescription } from "./tool-description.ts";

interface FanoutChildGlobalStore {
	__piSubagentFanoutChildRegisteredApis?: WeakSet<ExtensionAPI>;
}

type AgentPrepareInput = Parameters<AgentExecutionCoordinatorPort["prepare"]>[0];
type AgentToolFailureResult = AgentToolResult<Details> & { readonly isError: true };
type ExtensionEventPayload = Parameters<Parameters<ExtensionAPI["events"]["on"]>[1]>[0];

interface FanoutExecutor {
	execute(
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
		hooks?: SubagentExecutionHooks,
	): Promise<AgentToolResult<Details>>;
}

interface FanoutExecutorInput {
	readonly pi: ExtensionAPI;
	readonly projectContext: typeof projectCurrentContext;
	readonly state: SubagentState;
}

export interface FanoutChildDependencies {
	readonly createExecutor: (input: FanoutExecutorInput) => FanoutExecutor;
	readonly createGovernorCoordinator: (
		config: PiStuffAgentsConfig,
		effects: AgentEffectOwner,
	) => AgentExecutionCoordinatorPort;
	readonly loadConfiguration: () => PiStuffAgentsConfig;
}

function getSubagentSessionRoot(parentSessionFile: string | null): string {
	if (parentSessionFile) {
		const baseName = path.basename(parentSessionFile, ".jsonl");
		const sessionsDir = path.dirname(parentSessionFile);
		return path.join(sessionsDir, baseName);
	}
	return fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-session-"));
}

const PRODUCTION_DEPENDENCIES: FanoutChildDependencies = {
	createExecutor: ({ pi, projectContext, state }) =>
		createSubagentExecutor({
			pi,
			state,
			asyncByDefault: false,
			getSubagentSessionRoot,
			discoverAgents,
			projectContext,
			allowMutatingManagementActions: false,
		}),
	createGovernorCoordinator: (config, effects) =>
		createDurableAgentExecutionCoordinator({
			effects,
			rootDir: SESSION_GOVERNOR_ROOT,
			limits: {
				maxDepth: config.maxSubagentDepth,
				maxRunning: config.maxRunningAgents,
			},
		}),
	loadConfiguration: loadConfig,
};

function createChildSafeState(): SubagentState {
	return {
		baseCwd: "",
		currentSessionId: null,
		asyncJobs: new Map(),
		foregroundRuns: new Map(),
		foregroundControls: new Map(),
		lastForegroundControlId: null,
		pendingForegroundControlNotices: new Map(),
		lastUiContext: null,
		completionSeen: new Map(),
	};
}

type FanoutPreparation =
	| { readonly ok: true; readonly launchRunId: string; readonly invocation?: AgentExecutionInvocation }
	| { readonly ok: false; readonly message: string };

class FanoutChildRuntime {
	private readonly pi: ExtensionAPI;
	private readonly registeredApis: WeakSet<ExtensionAPI>;
	private readonly config: PiStuffAgentsConfig;
	private readonly state: SubagentState;
	private readonly executor: FanoutExecutor;
	private readonly effects: AgentEffectOwner;
	private readonly executionGovernor: AgentExecutionCoordinatorPort;
	private readonly eventUnsubscribes: Array<() => void> = [];
	private active = true;
	private boundLaunchIdentity: { sessionId: string; ownerAgentPath: readonly string[] } | undefined;

	constructor(pi: ExtensionAPI, deps: FanoutChildDependencies, registeredApis: WeakSet<ExtensionAPI>) {
		this.pi = pi;
		this.registeredApis = registeredApis;
		this.config = deps.loadConfiguration();
		this.state = createChildSafeState();
		this.effects = new AgentEffectOwner(installEffectFoundation(pi, { deferShutdown: true }));
		this.executor = deps.createExecutor({
			pi,
			projectContext: projectCurrentContext,
			state: this.state,
		});
		this.executionGovernor = deps.createGovernorCoordinator(this.config, this.effects);
	}

	private bindExecutionGovernor(): string | undefined {
		const parentSessionId = process.env[SUBAGENT_PARENT_SESSION_ENV]?.trim();
		if (!parentSessionId) return "Cannot start an Agent because the child has no parent session identity.";
		const physicalSessionId = process.env[SUBAGENT_PARENT_PHYSICAL_SESSION_ENV]?.trim();
		if (!physicalSessionId) return "Cannot start an Agent because the child has no physical parent session identity.";
		const rawOwnerPath = process.env[PI_STUFF_AGENT_PATH_ENV];
		const rawComponents = rawOwnerPath?.split("›") ?? [];
		const ownerAgentPath = parseAgentOwnerPath(rawOwnerPath);
		const validOwnerPath =
			rawComponents.length > 0 &&
			rawComponents.length <= this.config.maxSubagentDepth &&
			rawComponents.every((component) => component.trim().length > 0) &&
			ownerAgentPath.length === rawComponents.length &&
			ownerAgentPath.every((component) => {
				const separator = component.lastIndexOf(":");
				if (separator <= 0) return false;
				const index = component.slice(separator + 1);
				return /^\d+$/.test(index) && Number.isSafeInteger(Number(index)) && Number(index) <= 1_000_000;
			});
		if (!validOwnerPath) {
			return "Cannot start an Agent because PI_STUFF_AGENT_PATH is missing or invalid for this child.";
		}
		this.executionGovernor.bindSession({ sessionId: parentSessionId, ownerAgentPath });
		this.boundLaunchIdentity = { sessionId: physicalSessionId, ownerAgentPath };
		return undefined;
	}

	private failureResult(params: PublicAgentParams, message: string): AgentToolResult<Details> {
		const result: AgentToolFailureResult = {
			content: [{ type: "text", text: message }],
			isError: true,
			details: {
				mode: params.action ? "management" : params.tasks?.length ? "parallel" : "single",
				results: [],
			},
		};
		return result;
	}

	private projectFailure(params: PublicAgentParams, message: string): AgentToolResult<Details> {
		return projectEngineResult(params, this.failureResult(params, message));
	}

	private async prepareLaunch(id: string, params: PublicAgentParams): Promise<FanoutPreparation> {
		const bindingError = this.bindExecutionGovernor();
		if (bindingError) return { ok: false, message: bindingError };
		const identity = this.boundLaunchIdentity;
		if (!identity) return { ok: false, message: "Nested Agent governor is not bound." };
		const launchRunId = deriveLaunchRunId(id, identity);
		const prepareInput = { launchRunId, params } satisfies AgentPrepareInput;
		const prepared = await this.executionGovernor.prepare(prepareInput);
		if (!prepared.ok) return prepared;
		return prepared.invocation
			? { ok: true, launchRunId, invocation: prepared.invocation }
			: { ok: true, launchRunId };
	}

	private async failInvocation(invocation: AgentExecutionInvocation, diagnostic: string): Promise<void> {
		try {
			await this.executionGovernor.fail(invocation);
		} catch (error) {
			reportAgentDiagnostic(diagnostic, error);
		}
	}

	private async settleSessionEnded(
		invocation: AgentExecutionInvocation,
		result: AgentToolResult<Details>,
		foregroundStarted: boolean,
	): Promise<void> {
		if (foregroundStarted) {
			try {
				await this.executionGovernor.settle(invocation, result);
			} catch (error) {
				reportAgentDiagnostic("Failed to settle a session-ended nested foreground Agent result:", error);
			}
			return;
		}
		const binding = result.details.lifecycleBinding;
		let safeToRelease = !binding && !result.details.asyncId;
		if (binding?.abortStart) {
			try {
				safeToRelease = binding.abortStart();
			} catch (error) {
				// Failed control transport cannot prove the runner stopped; retain authority fail-closed.
				reportAgentDiagnostic("Failed to abort a session-ended nested Agent runtime:", error);
				safeToRelease = false;
			}
		}
		if (safeToRelease) {
			await this.failInvocation(invocation, "Failed to release a session-ended nested Agent reservation:");
			return;
		}
		try {
			await this.executionGovernor.settle(invocation, result);
		} catch (error) {
			reportAgentDiagnostic("Failed to retain a session-ended nested Agent runtime binding:", error);
		}
	}

	private async settleInvocation(
		invocation: AgentExecutionInvocation,
		result: AgentToolResult<Details>,
	): Promise<string | undefined> {
		try {
			await this.executionGovernor.settle(invocation, result);
		} catch (error) {
			if (error instanceof AgentRuntimeBindingRejectedError) return error.message;
			reportAgentDiagnostic(
				"Failed to persist the launched nested Agent lease binding; retaining it for reconciliation:",
				error,
			);
		}
		return undefined;
	}

	private async execute(
		id: string,
		rawParams: PublicAgentParams,
		signal: AbortSignal | undefined,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Details>> {
		const forbiddenField = ["action", "id", "index", "message", "foreground"].find((field) =>
			Object.hasOwn(rawParams, field),
		);
		if (forbiddenField) {
			const params = { ...rawParams, foreground: true };
			return this.projectFailure(
				params,
				`Nested Agent calls are launch-only; field '${forbiddenField}' is unavailable.`,
			);
		}
		let params: PublicAgentParams;
		try {
			params = normalizePublicAgentParams({ ...rawParams, foreground: true });
		} catch (error) {
			const supplied = { ...rawParams, foreground: true };
			return this.projectFailure(supplied, error instanceof Error ? error.message : String(error));
		}
		const prepared = await this.prepareLaunch(id, params);
		if (!prepared.ok) return this.projectFailure(params, prepared.message);
		const invocation = prepared.invocation;
		if (!this.active) {
			if (invocation)
				await this.failInvocation(invocation, "Failed to release a cancelled nested Agent launch reservation:");
			return this.projectFailure(params, "Nested Agent launch cancelled because the parent session ended.");
		}
		let foregroundStarted = false;
		try {
			const result = await this.executor.execute(
				id,
				{ ...toEngineParams(params), launchRunId: prepared.launchRunId },
				signal ?? new AbortController().signal,
				onUpdate ? (update) => onUpdate(projectEngineResult(params, update)) : undefined,
				ctx,
				invocation
					? {
							beforeForegroundStart: async ({ runId, asyncDir, abortStart }) => {
								await this.executionGovernor.observeAsyncStarted({
									id: runId,
									pid: process.pid,
									asyncDir,
									abortStart,
								});
								foregroundStarted = true;
							},
						}
					: undefined,
			);
			if (!this.active && invocation) {
				await this.settleSessionEnded(invocation, result, foregroundStarted);
				return this.projectFailure(params, "Nested Agent launch cancelled because the parent session ended.");
			}
			if (invocation) {
				const settlementError = await this.settleInvocation(invocation, result);
				if (settlementError) return this.projectFailure(params, settlementError);
			}
			return projectEngineResult(params, result);
		} catch (error) {
			if (invocation) {
				await this.failInvocation(
					invocation,
					"Failed to release a nested Agent reservation after engine launch failure:",
				);
			}
			throw error;
		}
	}

	private toolDefinition(): ToolDefinition<typeof FanoutChildSubagentParams, Details> {
		return {
			name: "subagent",
			label: "Agent",
			description: buildFanoutChildSubagentToolDescription(),
			parameters: FanoutChildSubagentParams,
			execute: (id, rawParams, signal, onUpdate, ctx) => {
				// SAFETY: FanoutChildSubagentParams is an explicit launch-only subset of PublicAgentParams.
				return this.execute(id, rawParams as PublicAgentParams, signal, onUpdate, ctx);
			},
		};
	}

	private onBus(event: string, handler: (data: ExtensionEventPayload) => void): void {
		const unsubscribe = this.pi.events.on(event, handler);
		if (isRuntimeFunction(unsubscribe)) this.eventUnsubscribes.push(unsubscribe);
	}

	private disposeComposition(): void {
		for (const unsubscribe of this.eventUnsubscribes.splice(0)) {
			try {
				unsubscribe();
			} catch (error) {
				reportAgentDiagnostic("Failed to unsubscribe a nested Agent event handler:", error);
			}
		}
		try {
			this.executionGovernor.dispose();
		} catch (error) {
			reportAgentDiagnostic("Failed to dispose the nested Agent execution governor:", error);
		}
	}

	register(): void {
		try {
			this.pi.on("session_start", async (_event, ctx) => {
				if (this.active) await this.effects.startSession(ctx.sessionManager);
			});
			const complete = (data: ExtensionEventPayload): void => {
				if (!this.active) return;
				void this.executionGovernor.complete(data).catch((error) => {
					reportAgentDiagnostic("Failed to release completed nested Agent lease:", error);
				});
			};
			this.onBus(SUBAGENT_ASYNC_COMPLETE_EVENT, complete);
			this.onBus(SUBAGENT_FOREGROUND_COMPLETE_EVENT, complete);
			this.onBus(SUBAGENT_PROCESS_TERMINAL_EVENT, () => {
				if (!this.active) return;
				void this.executionGovernor.reconcileDead().catch((error) => {
					reportAgentDiagnostic("Failed to reconcile nested Agent leases after runner exit:", error);
				});
			});
			this.pi.on("session_shutdown", async () => {
				if (!this.active) return;
				this.active = false;
				this.registeredApis.delete(this.pi);
				await this.effects.stop();
				this.disposeComposition();
			});
			// Register the public Tool last so earlier initialization failures can retry cleanly.
			registerSuiteOwnedTool(this.pi, this.toolDefinition(), createAgentToolPresentation());
			this.registeredApis.add(this.pi);
		} catch (error) {
			this.active = false;
			this.disposeComposition();
			this.registeredApis.delete(this.pi);
			throw error;
		}
	}
}

export default function registerFanoutChildSubagentExtension(
	pi: ExtensionAPI,
	overrides: Partial<FanoutChildDependencies> = {},
): void {
	if (process.env[SUBAGENT_CHILD_ENV] !== "1" || process.env[SUBAGENT_FANOUT_CHILD_ENV] !== "1") return;
	const deps: FanoutChildDependencies = { ...PRODUCTION_DEPENDENCIES, ...overrides };

	// SAFETY: this module owns the single optional global WeakSet slot and validates it before reuse.
	const globalStore = globalThis as typeof globalThis & FanoutChildGlobalStore;
	const registeredApis =
		globalStore.__piSubagentFanoutChildRegisteredApis instanceof WeakSet
			? globalStore.__piSubagentFanoutChildRegisteredApis
			: new WeakSet<ExtensionAPI>();
	globalStore.__piSubagentFanoutChildRegisteredApis = registeredApis;
	if (registeredApis.has(pi)) return;
	new FanoutChildRuntime(pi, deps, registeredApis).register();
}
