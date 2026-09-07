/** Durable background launch and status contracts. */

import type { AgentWorkOrigin } from "../../../../conversation-ui/agent-run-origin.ts";
import type { JsonInputValue } from "../../../../shared/json-value.ts";
import type { AgentWorkUsage } from "../../runtime/session-governor.ts";
import type {
	AgentContextUsage,
	CostSummary,
	SteeringStatus,
	SubagentLifecycleArtifactVersion,
	SubagentRunMode,
	TokenUsage,
	TurnBudgetState,
} from "../../shared/types.ts";
import type { ResolvedSubagentCapabilityCeiling } from "../shared/capability-ceiling.ts";
import type {
	AsyncParallelGroupStatus,
	NestedRouteInfo,
	NestedRunSummary,
	NestedRuntimeEvidence,
	NestedStepSummary,
} from "../shared/nested-contract.ts";
import type { AgentTerminalOutcome, ModelAttempt } from "../shared/run-result.ts";

export interface AsyncStartedEvent {
	lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
	id?: string;
	asyncDir?: string;
	/** Parent-resolved launch directory, used as a trusted artifact root while this session is live. */
	cwd?: string;
	pid?: number;
	processStartIdentity?: string;
	sessionId?: string;
	mode?: SubagentRunMode;
	agent?: string;
	agents?: string[];
	/** Short first-child UI description. */
	description?: string;
	/** Short per-child UI descriptions. */
	descriptions?: string[];
	/** Truncated first child task retained for backwards compatibility. */
	task?: string;
	/** Bounded per-child task previews retained by the current-session detail surface. */
	tasks?: string[];
	/** Caller task, falling back to the first child task. */
	goal?: string;
	parallelGroups?: AsyncParallelGroupStatus[];
	launchContractDigest?: string;
	timeoutMs?: number;
	deadlineAt?: number;
	turnBudget?: TurnBudgetState;
	nestedRoute?: NestedRouteInfo;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
}

export interface AsyncStatusStep extends NestedStepSummary {
	/** In-memory compatibility proof recovered asynchronously from a legacy transcript. */
	legacyFinalReportComplete?: true;
	/** Resolved launch context for this child step. */
	context?: "fresh" | "fork";
	phase?: string;
	label?: string;
	outputName?: string;
	structured?: boolean;
	/** Bounded final Agent answer retained separately from recent activity. */
	finalOutput?: string | undefined;
	savedOutputPath?: string | undefined;
	currentToolArgs?: string | undefined;
	recentOutput?: string[] | undefined;
	durationMs?: number | undefined;
	exitCode?: number | null | undefined;
	tokens?: TokenUsage | undefined;
	contextUsage?: AgentContextUsage | undefined;
	skills?: string[];
	model?: string | undefined;
	thinking?: string | undefined;
	attemptedModels?: string[] | undefined;
	modelAttempts?: ModelAttempt[] | undefined;
	cumulativeUsage?: AgentWorkUsage | undefined;
	terminalOutcome?: AgentTerminalOutcome | undefined;
	totalCost?: CostSummary | undefined;
	steering?: SteeringStatus;
	structuredOutput?: unknown;
	structuredOutputPath?: string;
	acceptance?: JsonInputValue;
	launchContractDigest?: string;
}

export interface AsyncStatus extends Omit<NestedRuntimeEvidence, "agentStatus" | "children"> {
	lifecycleArtifactVersion?: SubagentLifecycleArtifactVersion;
	runId: string;
	sessionId?: string;
	/** Origin of the parent Agent run; absent only on legacy lifecycle artifacts. */
	parentRunOrigin?: AgentWorkOrigin;
	mode: SubagentRunMode;
	/** Exact nested event route selected at launch; legacy statuses may omit it. */
	nestedRoute?: NestedRouteInfo | undefined;
	state: "queued" | "running" | "complete" | "failed" | "paused" | "stopped";
	steering?: SteeringStatus | undefined;
	startedAt: number;
	lastUpdate?: number | undefined;
	timeoutMs?: number | undefined;
	deadlineAt?: number | undefined;
	pid?: number;
	/** OS process-birth identity paired with pid to reject PID reuse. */
	processStartIdentity?: string;
	/** First escalation boundary for a proven, stale runner process. */
	runnerTerminationRequestedAt?: number;
	cwd?: string | undefined;
	currentStep?: number | undefined;
	parallelGroups?: AsyncParallelGroupStatus[];
	launchContractDigest?: string;
	steps?: AsyncStatusStep[] | undefined;
	sessionDir?: string | undefined;
	outputFile?: string | undefined;
	totalTokens?: TokenUsage | undefined;
	totalCost?: CostSummary;
	sessionFile?: string | undefined;
}

export type AsyncJobStep = AsyncStatusStep & {
	index?: number;
};

export interface AsyncJobState
	extends Omit<
		NestedRuntimeEvidence,
		"agentStatus" | "children" | "endedAt" | "capabilityCeiling" | "capabilityAudit"
	> {
	asyncId: string;
	asyncDir: string;
	/** Parent-resolved launch directory retained for trusted live artifact lookup. */
	cwd?: string | undefined;
	status: "queued" | "running" | "complete" | "failed" | "paused" | "stopped";
	/** Short caller-facing task/goal shown in Agent surfaces when available. */
	description?: string | undefined;
	/** Short per-child UI descriptions available before the first status poll. */
	descriptions?: string[] | undefined;
	/** Bounded per-child task previews available before the first status poll. */
	tasks?: string[] | undefined;
	pid?: number | undefined;
	sessionId?: string | undefined;
	steering?: SteeringStatus | undefined;
	mode?: SubagentRunMode | undefined;
	/** Run-level context summary derived from step contexts. */
	context?: "fresh" | "fork" | "mixed" | undefined;
	agents?: string[] | undefined;
	currentStep?: number | undefined;
	parallelGroups?: AsyncParallelGroupStatus[] | undefined;
	steps?: AsyncJobStep[];
	stepsTotal?: number | undefined;
	completedSteps?: number;
	hasParallelGroups?: boolean | undefined;
	activeParallelGroup?: boolean | undefined;
	updatedAt?: number | undefined;
	timeoutMs?: number | undefined;
	deadlineAt?: number | undefined;
	sessionDir?: string | undefined;
	outputFile?: string | undefined;
	totalTokens?: TokenUsage | undefined;
	totalCost?: CostSummary | undefined;
	sessionFile?: string | undefined;
	controlEventCursor?: number;
	controlEventIdentity?: string;
	/** Logical stream offset of physical byte zero in this retained log generation. */
	controlEventOffset?: number;
	/** A restored observer failed to stat events; first successful read starts at EOF. */
	controlEventCursorPending?: boolean | undefined;
	nestedRoute?: NestedRouteInfo | undefined;
	nestedChildren?: NestedRunSummary[];
}
