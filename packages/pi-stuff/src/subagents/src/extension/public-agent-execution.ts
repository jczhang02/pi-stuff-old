import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentWorkOrigin } from "../../../conversation-ui/index.js";
import type { SubagentExecutionHooks, SubagentParamsLike } from "../runs/foreground/executor-contract.ts";
import { PI_STUFF_AGENT_PATH_ENV } from "../runs/shared/pi-args.ts";
import {
	type AgentExecutionCoordinatorPort,
	type AgentExecutionInvocation,
	AgentRuntimeBindingRejectedError,
	parseAgentOwnerPath,
} from "../runtime/agent-execution-coordinator.ts";
import { reportAgentDiagnostic } from "../shared/diagnostics.ts";
import { resolveCurrentSessionIdentity } from "../shared/session-identity.ts";
import type { Details, SubagentState } from "../shared/types.ts";
import { routeLiveNestedAgentControl } from "./nested-control-router.ts";
import {
	type AgentEngineResult,
	type PublicAgentParams,
	projectEngineResult,
	toEngineParams,
} from "./product-executor.ts";

export interface PublicAgentEngine {
	execute(
		id: string,
		params: SubagentParamsLike,
		signal: AbortSignal,
		onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
		ctx: ExtensionContext,
		hooks?: SubagentExecutionHooks,
	): Promise<AgentToolResult<Details>>;
}

interface PublicAgentRootState {
	readonly active: boolean;
	readonly sessionEpoch: number;
	readonly ephemeralSessionNonce: string;
	readonly compatibilityReady: boolean;
	readonly compatibilityError?: string;
}

export interface PublicAgentExecutionRuntime {
	readonly state: SubagentState;
	readonly governor: AgentExecutionCoordinatorPort;
	readonly engine: PublicAgentEngine;
	readonly rootState: () => PublicAgentRootState;
	readonly activate: (ctx: ExtensionContext) => Promise<void>;
	readonly refreshCompatibility: (ctx: ExtensionContext) => Promise<void>;
	readonly startRunRuntime: (options: { createDirectories: boolean; primeExisting: boolean }) => void;
	readonly scheduleMaintenance: () => void;
	readonly refresh: () => void;
	readonly endRun?: (runId: string) => void;
}

export interface PublicAgentRequest {
	readonly id: string;
	readonly params: PublicAgentParams;
	readonly signal: AbortSignal;
	readonly onUpdate: ((result: AgentToolResult<Details>) => void) | undefined;
	readonly ctx: ExtensionContext;
	readonly parentRunOrigin: AgentWorkOrigin;
}

export type ExecutePublicAgent = (
	id: string,
	params: PublicAgentParams,
	signal: AbortSignal,
	onUpdate: ((result: AgentToolResult<Details>) => void) | undefined,
	ctx: ExtensionContext,
	parentRunOrigin: AgentWorkOrigin,
) => Promise<AgentEngineResult>;

let executorModulePromise: Promise<typeof import("../runs/foreground/subagent-executor.ts")> | undefined;

export function loadSubagentExecutorModule(): Promise<typeof import("../runs/foreground/subagent-executor.ts")> {
	if (!executorModulePromise) {
		executorModulePromise = import("../runs/foreground/subagent-executor.ts").catch((error) => {
			executorModulePromise = undefined;
			throw error;
		});
	}
	return executorModulePromise;
}

export function projectPublicAgentFailure(params: PublicAgentParams, message: string): AgentEngineResult {
	return projectEngineResult(params, {
		content: [{ type: "text", text: message }],
		isError: true,
		details: {
			mode: params.action ? "management" : params.tasks?.length ? "parallel" : "single",
			results: [],
		},
	});
}

function sessionChanged(runtime: PublicAgentExecutionRuntime, epoch: number, sessionId: string | null): boolean {
	const root = runtime.rootState();
	return !root.active || root.sessionEpoch !== epoch || runtime.state.currentSessionId !== sessionId;
}

interface PreparedDispatch {
	readonly targetParams: PublicAgentParams;
	readonly launchRunId: string;
	readonly invocation: AgentExecutionInvocation | undefined;
	readonly invocationEpoch: number;
	readonly invocationSessionId: string | null;
}

async function dispatchPreparedAgent(
	runtime: PublicAgentExecutionRuntime,
	request: PublicAgentRequest,
	prepared: PreparedDispatch,
): Promise<AgentEngineResult> {
	const { id, params, signal, onUpdate, ctx, parentRunOrigin } = request;
	const { targetParams, launchRunId, invocation, invocationEpoch, invocationSessionId } = prepared;
	let foregroundStarted = false;
	try {
		if (invocation) runtime.startRunRuntime({ createDirectories: true, primeExisting: true });
		const engineParams = { ...toEngineParams(targetParams), launchRunId };
		let hooks: SubagentExecutionHooks = { parentRunOrigin };
		if (invocation && params.foreground === true) {
			hooks = {
				...hooks,
				beforeForegroundStart: async ({ runId, asyncDir, abortStart }) => {
					await runtime.governor.observeAsyncStarted({
						id: runId,
						pid: process.pid,
						asyncDir,
						abortStart,
					});
					foregroundStarted = true;
				},
			};
		}
		const result = await runtime.engine.execute(
			id,
			engineParams,
			signal,
			onUpdate
				? (update) => {
						runtime.refresh();
						onUpdate(projectEngineResult(params, update));
					}
				: undefined,
			ctx,
			hooks,
		);
		if (invocation && sessionChanged(runtime, invocationEpoch, invocationSessionId)) {
			if (params.foreground === true && foregroundStarted) {
				try {
					// The foreground engine already ran under the original session's durable authority.
					await runtime.governor.settle(invocation, result);
				} catch (error) {
					reportAgentDiagnostic("Failed to settle a session-changed foreground Agent result:", error);
				}
			} else {
				const binding = result.details.lifecycleBinding;
				let safeToRelease = !binding && !result.details.asyncId;
				if (binding?.abortStart) {
					try {
						safeToRelease = binding.abortStart();
					} catch (error) {
						// A failed abort is not proof that the runner stopped. Keep authority fail-closed.
						reportAgentDiagnostic("Failed to abort a session-changed Agent runtime:", error);
						safeToRelease = false;
					}
				}
				try {
					if (safeToRelease) await runtime.governor.fail(invocation);
					else await runtime.governor.settle(invocation, result);
				} catch (error) {
					reportAgentDiagnostic(
						safeToRelease
							? "Failed to release a session-changed Agent reservation:"
							: "Failed to retain a session-changed Agent runtime binding:",
						error,
					);
				}
			}
			return projectPublicAgentFailure(
				params,
				"Agent launch cancelled because the parent session ended or changed.",
			);
		}
		if (invocation) {
			try {
				await runtime.governor.settle(invocation, result);
			} catch (error) {
				if (error instanceof AgentRuntimeBindingRejectedError) {
					return projectPublicAgentFailure(params, error.message);
				}
				// Detached work may already be running; reconciliation retains authority.
				reportAgentDiagnostic(
					"Failed to persist the launched Agent lease binding; retaining it for reconciliation:",
					error,
				);
			}
		}
		const projected = projectEngineResult(params, result);
		if (
			params.action === "stop" &&
			targetParams.index === undefined &&
			projected.isError !== true &&
			targetParams.id
		) {
			runtime.endRun?.(targetParams.id);
		}
		return projected;
	} catch (error) {
		if (invocation) {
			try {
				await runtime.governor.fail(invocation);
			} catch (releaseError) {
				reportAgentDiagnostic("Failed to release an Agent reservation after engine launch failure:", releaseError);
			}
		}
		throw error;
	} finally {
		runtime.scheduleMaintenance();
		runtime.refresh();
	}
}

/** Execute one public Agent request under the current Session's durable governor authority. */
export async function runPublicAgent(
	runtime: PublicAgentExecutionRuntime,
	request: PublicAgentRequest,
): Promise<AgentEngineResult> {
	const { id, params, signal, ctx, parentRunOrigin } = request;
	const requestedRoot = runtime.rootState();
	const requestedSessionId = runtime.state.currentSessionId;
	await runtime.activate(ctx);
	if (sessionChanged(runtime, requestedRoot.sessionEpoch, requestedSessionId)) {
		return projectPublicAgentFailure(params, "Agent request cancelled because the parent session ended or changed.");
	}
	if ((!params.action || params.action === "resume") && !runtime.rootState().compatibilityReady) {
		await runtime.refreshCompatibility(ctx);
		if (sessionChanged(runtime, requestedRoot.sessionEpoch, requestedSessionId)) {
			return projectPublicAgentFailure(
				params,
				"Agent request cancelled because the parent session ended or changed.",
			);
		}
		const compatibility = runtime.rootState();
		if (!compatibility.compatibilityReady) {
			return projectPublicAgentFailure(
				params,
				compatibility.compatibilityError ??
					"Agent launches are paused because governor compatibility was not verified for this session.",
			);
		}
	}
	const { deriveLaunchRunId, resolveLegacyAgentParams, resolveResumeTargetRunId } = await loadSubagentExecutorModule();
	if (sessionChanged(runtime, requestedRoot.sessionEpoch, requestedSessionId)) {
		return projectPublicAgentFailure(params, "Agent request cancelled because the parent session ended or changed.");
	}
	const launchRoot = runtime.rootState();
	const launchIdentity = {
		// The header id differentiates a newly-created session that intentionally
		// reuses an old --session path without changing the persisted compatibility
		// namespace used to cold-resume existing Agent artifacts.
		sessionId: `${
			runtime.state.currentSessionId ??
			resolveCurrentSessionIdentity(ctx.sessionManager, ctx.cwd, launchRoot.ephemeralSessionNonce).sessionId
		}\0header:${ctx.sessionManager.getSessionId() ?? "unknown"}`,
		ownerAgentPath: parseAgentOwnerPath(process.env[PI_STUFF_AGENT_PATH_ENV]),
	};
	const launchRunId = deriveLaunchRunId(id, launchIdentity);
	const invocationEpoch = launchRoot.sessionEpoch;
	const invocationSessionId = runtime.state.currentSessionId;
	let targetParams = params;
	if (params.action === "resume" || params.action === "steer" || params.action === "stop") {
		try {
			targetParams = resolveLegacyAgentParams(params, runtime.state);
		} catch (error) {
			return projectPublicAgentFailure(params, error instanceof Error ? error.message : String(error));
		}
	}
	const nestedControl = await routeLiveNestedAgentControl(targetParams, runtime.state, signal, { parentRunOrigin });
	if (nestedControl) return projectEngineResult(params, nestedControl);
	let resumeTargetRunId: string | undefined;
	try {
		resumeTargetRunId = resolveResumeTargetRunId(targetParams, runtime.state);
	} catch (error) {
		return projectPublicAgentFailure(params, error instanceof Error ? error.message : String(error));
	}
	let prepareInput: Parameters<typeof runtime.governor.prepare>[0] = { launchRunId, params: targetParams };
	if (resumeTargetRunId) prepareInput = { ...prepareInput, resumeTargetRunId };
	if (targetParams.acknowledgeCost === true) {
		if (parentRunOrigin !== "user") {
			return projectPublicAgentFailure(params, "Cost acknowledgement requires a direct user-started Agent request.");
		}
		prepareInput = { ...prepareInput, acknowledgeCost: true };
	}
	const prepared = await runtime.governor.prepare(prepareInput);
	if (!prepared.ok) return projectPublicAgentFailure(params, prepared.message);
	const invocation = prepared.invocation;
	if (sessionChanged(runtime, invocationEpoch, invocationSessionId)) {
		if (invocation) {
			try {
				await runtime.governor.fail(invocation);
			} catch (error) {
				reportAgentDiagnostic("Failed to release a cancelled Agent launch reservation:", error);
			}
		}
		return projectPublicAgentFailure(params, "Agent launch cancelled because the parent session ended or changed.");
	}
	return dispatchPreparedAgent(runtime, request, {
		targetParams,
		launchRunId,
		invocation,
		invocationEpoch,
		invocationSessionId,
	});
}
