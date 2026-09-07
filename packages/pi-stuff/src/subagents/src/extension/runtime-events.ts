import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requestStatuslineGitRefreshAfterUserWork } from "../../../conversation-ui/index.ts";
import { isRuntimeFunction, isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import type { AgentExecutionCoordinatorPort } from "../runtime/agent-execution-coordinator.ts";
import { reportAgentDiagnostic } from "../shared/diagnostics.ts";
import { sessionArtifactMatches } from "../shared/session-identity.ts";
import {
	SUBAGENT_ASYNC_COMPLETE_EVENT,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_ASYNC_STATUS_EVENT,
	SUBAGENT_FOREGROUND_COMPLETE_EVENT,
	SUBAGENT_PROCESS_TERMINAL_EVENT,
	type SubagentState,
} from "../shared/types.ts";

type ExtensionEventHandler = Parameters<ExtensionAPI["events"]["on"]>[1];

interface RuntimeEventTracker {
	handleComplete<Data>(data: Data): void;
	handleProcessTerminal<Data>(data: Data): void;
	handleStarted<Data>(data: Data): void;
	handleStatus<Data>(data: Data): void;
}

interface RuntimeEventInput {
	readonly pi: ExtensionAPI;
	readonly state: SubagentState;
	readonly governor: AgentExecutionCoordinatorPort;
	readonly tracker: RuntimeEventTracker;
	readonly isActive: () => boolean;
	readonly bindContext: (ctx: ExtensionContext) => void;
	readonly refresh: () => void;
}

/** Bind current-Session runtime events and return their explicit bus teardown. */
export function registerAgentRuntimeEvents(input: RuntimeEventInput): () => void {
	const { pi, state, governor, tracker, isActive, bindContext, refresh } = input;
	const eventUnsubscribes: Array<() => void> = [];
	const onBus = (event: string, handler: ExtensionEventHandler): void => {
		const unsubscribe = pi.events.on(event, handler);
		if (isRuntimeFunction(unsubscribe)) eventUnsubscribes.push(unsubscribe);
	};
	const belongsToCurrentSession = <Data>(data: Data): boolean => {
		if (!data || !isRuntimeObject(data) || data === null || Array.isArray(data)) return false;
		const sessionId = "sessionId" in data ? data.sessionId : undefined;
		const runId = "runId" in data ? data.runId : undefined;
		const id = "id" in data ? data.id : undefined;
		const artifactSessionId = isRuntimeString(sessionId) ? sessionId : undefined;
		const artifactRunId = isRuntimeString(runId) ? runId : isRuntimeString(id) ? id : undefined;
		return sessionArtifactMatches(state.currentSessionScope, artifactSessionId, artifactRunId);
	};
	const normalizeCurrentSessionEvent = <Event>(data: Event) =>
		data && isRuntimeObject(data) && state.currentSessionId ? { ...data, sessionId: state.currentSessionId } : data;

	onBus(SUBAGENT_ASYNC_STARTED_EVENT, (data) => {
		if (!isActive() || !belongsToCurrentSession(data)) return;
		const normalized = normalizeCurrentSessionEvent(data);
		void governor.observeAsyncStarted(normalized).catch((error) => {
			reportAgentDiagnostic("Failed to bind Agent governor runtime identity:", error);
		});
		tracker.handleStarted(normalized);
		refresh();
	});
	onBus(SUBAGENT_ASYNC_STATUS_EVENT, (data) => {
		if (!isActive() || !belongsToCurrentSession(data)) return;
		tracker.handleStatus(normalizeCurrentSessionEvent(data));
	});
	onBus(SUBAGENT_ASYNC_COMPLETE_EVENT, (data) => {
		if (!isActive() || !belongsToCurrentSession(data)) return;
		const normalized = normalizeCurrentSessionEvent(data);
		void governor.complete(normalized).catch((error) => {
			reportAgentDiagnostic("Failed to release completed background Agent lease:", error);
		});
		tracker.handleComplete(normalized);
		refresh();
		if (
			isRuntimeObject(normalized) &&
			normalized !== null &&
			!Array.isArray(normalized) &&
			"parentRunOrigin" in normalized &&
			normalized.parentRunOrigin === "user"
		) {
			requestStatuslineGitRefreshAfterUserWork(pi);
		}
	});
	onBus(SUBAGENT_FOREGROUND_COMPLETE_EVENT, (data) => {
		if (!isActive() || !belongsToCurrentSession(data)) return;
		void governor.complete(normalizeCurrentSessionEvent(data)).catch((error) => {
			reportAgentDiagnostic("Failed to release completed foreground Agent lease:", error);
		});
		// Foreground summaries already return through the active Tool call.
		refresh();
	});
	onBus(SUBAGENT_PROCESS_TERMINAL_EVENT, (data) => {
		if (!isActive() || !belongsToCurrentSession(data)) return;
		tracker.handleProcessTerminal(normalizeCurrentSessionEvent(data));
		void governor.reconcileDead().catch((error) => {
			reportAgentDiagnostic("Failed to reconcile Agent leases after a runner terminal event:", error);
		});
	});

	const refreshFromTool = (event: { toolName?: string }, ctx: ExtensionContext): void => {
		if (!isActive() || event.toolName !== "subagent") return;
		bindContext(ctx);
		refresh();
	};
	pi.on("tool_execution_start", refreshFromTool);
	pi.on("tool_execution_update", refreshFromTool);
	pi.on("tool_execution_end", refreshFromTool);
	pi.on("tool_result", refreshFromTool);

	return () => {
		for (const unsubscribe of eventUnsubscribes.splice(0)) {
			try {
				unsubscribe();
			} catch {
				// Event-bus teardown is best effort after the Host has begun shutdown.
			}
		}
	};
}
