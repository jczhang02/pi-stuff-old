/** Nested Agent graph and route contracts. */

import type { AgentWorkOrigin } from "../../../../conversation-ui/agent-run-origin.ts";
import type {
	ActivityState,
	CostSummary,
	SubagentRunMode,
	TokenUsage,
	ToolBudgetState,
	TurnBudgetState,
} from "../../shared/types.ts";
import type { ProcessTerminalV1 } from "../background/process-terminal.ts";
import type { ResolvedSubagentCapabilityCeiling, SubagentCapabilityAudit } from "./capability-ceiling.ts";

export type PublicNestedStepSummary = Pick<
	NestedStepSummary,
	| "agent"
	| "agentStatus"
	| "task"
	| "description"
	| "status"
	| "sessionFile"
	| "transcriptPath"
	| "transcriptError"
	| "activityState"
	| "lastActivityAt"
	| "currentTool"
	| "currentToolStartedAt"
	| "currentPath"
	| "turnCount"
	| "toolCount"
	| "toolBudget"
	| "toolBudgetBlocked"
	| "startedAt"
	| "endedAt"
	| "error"
	| "timedOut"
	| "stopped"
> & {
	children?: PublicNestedRunSummary[];
};

export type PublicNestedRunSummary = Pick<
	NestedRunSummary,
	| "id"
	| "agentStatus"
	| "parentRunId"
	| "parentStepIndex"
	| "parentAgent"
	| "depth"
	| "path"
	| "asyncDir"
	| "sessionId"
	| "sessionFile"
	| "intercomTarget"
	| "ownerIntercomTarget"
	| "leafIntercomTarget"
	| "parentRunOrigin"
	| "ownerState"
	| "mode"
	| "state"
	| "agent"
	| "agents"
	| "currentStep"
	| "parallelGroups"
	| "activityState"
	| "lastActivityAt"
	| "currentTool"
	| "currentToolStartedAt"
	| "currentPath"
	| "turnCount"
	| "toolCount"
	| "toolBudget"
	| "toolBudgetBlocked"
	| "totalTokens"
	| "totalCost"
	| "startedAt"
	| "endedAt"
	| "lastUpdate"
	| "error"
	| "timeoutMs"
	| "deadlineAt"
	| "timedOut"
	| "stopped"
	| "turnBudget"
	| "turnBudgetExceeded"
	| "wrapUpRequested"
> & {
	steps?: PublicNestedStepSummary[];
	children?: PublicNestedRunSummary[];
};

export interface AsyncParallelGroupStatus {
	start: number;
	count: number;
	stepIndex: number;
}

export type NestedRunState = "queued" | "running" | "complete" | "failed" | "paused" | "stopped";
export type NestedOwnerState = "live" | "gone" | "unknown";

export interface NestedRunAddress {
	id: string;
	parentRunId: string;
	parentStepIndex?: number | undefined;
	parentAgent?: string;
	depth: number;
	path: Array<{ runId: string; stepIndex?: number; agent?: string }>;
}

export interface NestedRuntimeEvidence {
	/** Small UI projection retained when full process proof is intentionally omitted. */
	agentStatus?: "crashed";
	activityState?: ActivityState | undefined;
	lastActivityAt?: number | undefined;
	currentTool?: string | undefined;
	currentToolStartedAt?: number | undefined;
	currentPath?: string | undefined;
	turnCount?: number | undefined;
	toolCount?: number | undefined;
	startedAt?: number | undefined;
	endedAt?: number | undefined;
	error?: string | undefined;
	timedOut?: boolean | undefined;
	stopped?: boolean | undefined;
	turnBudget?: TurnBudgetState | undefined;
	turnBudgetExceeded?: boolean | undefined;
	wrapUpRequested?: boolean | undefined;
	toolBudget?: ToolBudgetState | undefined;
	toolBudgetBlocked?: boolean | undefined;
	/** Detached runner/writer proof; pending or unknown keeps physical recovery polled. */
	processTerminal?: ProcessTerminalV1 | undefined;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	children?: NestedRunSummary[] | undefined;
}

export interface NestedStepSummary extends NestedRuntimeEvidence {
	agent: string;
	/** Bounded task text used to distinguish same-named nested Agents. */
	task?: string;
	/** Original delegated task before Suite-owned execution context is prepended. */
	delegatedTask?: string;
	description?: string;
	status: "pending" | "running" | "complete" | "completed" | "failed" | "paused" | "stopped";
	sessionFile?: string | undefined;
	transcriptPath?: string | undefined;
	transcriptError?: string | undefined;
}

export interface NestedRunSummary extends NestedRunAddress, NestedRuntimeEvidence {
	/** User takeover is monotonic across nested lifecycle projections. */
	parentRunOrigin?: AgentWorkOrigin;
	asyncDir?: string;
	pid?: number;
	sessionId?: string;
	sessionFile?: string;
	intercomTarget?: string;
	ownerIntercomTarget?: string;
	leafIntercomTarget?: string;
	ownerState?: NestedOwnerState;
	controlInbox?: string;
	capabilityToken?: string;
	mode?: SubagentRunMode;
	state: NestedRunState;
	agent?: string;
	agents?: string[];
	currentStep?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps?: NestedStepSummary[];
	totalTokens?: TokenUsage;
	totalCost?: CostSummary;
	lastUpdate?: number;
	timeoutMs?: number;
	deadlineAt?: number;
}

export interface NestedRouteInfo {
	rootRunId: string;
	eventSink: string;
	controlInbox: string;
	capabilityToken: string;
}
