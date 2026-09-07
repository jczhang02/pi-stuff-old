import type { AgentWorkOrigin } from "../../../../conversation-ui/agent-run-origin.ts";
import type { PonytailMode } from "../../../../ponytail/types.ts";
import type { LaunchBindingInput } from "../../shared/launch-contract.ts";
import type {
	ArtifactConfig,
	ArtifactPaths,
	CostSummary,
	NestedRouteInfo,
	ResolvedControlConfig,
	ResolvedToolBudget,
} from "../../shared/types.ts";
import type { PiWriterProcessInstanceExitV1 } from "../background/process-terminal.ts";
import type { ResolvedSubagentCapabilityCeiling } from "./capability-ceiling.ts";
import type { SingleResult } from "./run-result.ts";

/**
 * Fully-resolved input for one background child.
 *
 * The launcher owns policy resolution. The detached runner consumes this shape
 * without rediscovering agents or inheriting settings.
 */
export interface RunnerAgentTask
	extends Omit<
		Partial<LaunchBindingInput>,
		"task" | "inheritProjectContext" | "inheritSkills" | "toolBudget" | "capabilityCeiling"
	> {
	/** Durable ledger namespace; may be v1 only while finishing an in-flight upgrade. */
	governorSessionId?: string;
	/** Immutable physical root-session identity used by lifecycle artifacts. */
	physicalSessionId?: string;
	/** Session id of the direct parent session for supervisor routing. */
	parentSessionId?: string;
	/** Durable governor path component; resume keeps the original logical child identity. */
	logicalAgentPathComponent?: string;
	agent: string;
	/** Short launcher-normalized label for terminal surfaces. */
	description?: string;
	/** Original delegated task before Suite-owned execution context is prepended. */
	delegatedTask?: string;
	task: string;
	/** Resolved launch context for this child. */
	context?: "fresh" | "fork";
	label?: string;
	cwd: string;
	model?: string;
	thinking?: string;
	/** Context windows frozen from the launcher's model registry for the selected candidates. */
	modelContextWindows?: Array<{ model: string; contextWindow: number }>;
	/** Registry entries used to verify that Pi honored a launch candidate. */
	modelVerificationRegistry?: Array<{ provider: string; id: string; fullId: string }>;
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	excludeTools?: string[];
	childBaseExtensionPath?: string;
	sessionFile?: string;
	launchBindingTask?: string;
	launchContractDigest?: string;
	toolBudget?: ResolvedToolBudget;
	toolTimeoutMs?: number;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
}

export interface RunnerParallelGroup {
	tasks: RunnerAgentTask[];
	concurrency: number;
	worktree: boolean;
}

export type BackgroundRunnerWork =
	| { mode: "single"; task: RunnerAgentTask }
	| { mode: "parallel"; group: RunnerParallelGroup };

export interface BackgroundRunnerConfig {
	version: 2;
	id: string;
	/** Persisted parent attribution used by observation-only completion UI. */
	parentRunOrigin?: AgentWorkOrigin;
	/** Effective parent Code Mode state frozen when this Agent run launches. */
	codeModeEnabled?: boolean;
	/** Effective parent Ponytail mode frozen when this Agent run launches. */
	ponytailMode?: PonytailMode;
	/** Provider carrier Tools required to preserve Code Mode under a strict child allowlist. */
	codeModeProviderTools?: string[];
	work: BackgroundRunnerWork;
	resultPath: string;
	cwd: string;
	asyncDir: string;
	sessionId?: string | null;
	artifactsDir?: string;
	artifactConfig?: Partial<ArtifactConfig>;
	sessionDir?: string;
	piPackageRoot?: string;
	piArgv1?: string;
	piExecutable?: string;
	controlConfig?: ResolvedControlConfig;
	controlIntercomTarget?: string;
	/** Native child→root supervisor requests; safe only for detached root runs. */
	nativeSupervisor?: boolean;
	childIntercomTargets?: Array<string | undefined>;
	nestedRoute?: NestedRouteInfo;
	nestedSelf?: {
		parentRunId: string;
		parentStepIndex?: number;
		depth: number;
		path?: Array<{ runId: string; stepIndex?: number; agent?: string }>;
	};
	timeoutMs?: number;
	deadlineAt?: number;
	revivalLease?: import("./session-lease.ts").SessionLeaseRequest;
	revivalLeaseToken?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	launchContractDigest?: string;
	runnerProcessInstanceId?: string;
	/** One-way launcher gate used after durable status/registry precommit. */
	startupGateToken?: string;
	/** Timestamp shared by the launcher-precommitted and runner-loaded status. */
	startedAt?: number;
}

export interface BackgroundTaskResult
	extends Omit<
		SingleResult,
		"task" | "cwd" | "exitCode" | "detached" | "detachedReason" | "crashed" | "usage" | "finalOutput" | "children"
	> {
	output: string;
	success: boolean;
	exitCode: number | null;
	preStartTerminalCause?: "pause" | "timeout" | "stop";
	intercomTarget?: string;
	totalCost?: CostSummary;
	artifactPaths?: ArtifactPaths;
	writerProcesses?: PiWriterProcessInstanceExitV1[];
	writerAttemptCount?: number;
}

export async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const safeLimit = Math.max(1, Math.floor(limit) || 1);
	const results: R[] = [];
	const pending = items.entries();

	async function worker(): Promise<void> {
		for (const [index, item] of pending) {
			results[index] = await fn(item, index);
		}
	}

	await Promise.all(Array.from({ length: Math.min(safeLimit, items.length) }, () => worker()));
	return results;
}

export const MAX_PARALLEL_CONCURRENCY = 4;
export const MAX_BACKGROUND_TASKS = 20;
