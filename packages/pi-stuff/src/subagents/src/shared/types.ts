/**
 * Type definitions for the subagent extension
 */

import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonInputObject } from "../../../shared/json-value.ts";
import { isRuntimeFunction, isRuntimeNumber, isRuntimeString } from "../../../shared/runtime-type.ts";
import { xdgRuntimeHome, xdgStateHome } from "../../../xdg/index.ts";

export type * from "../runs/background/async-contract.ts";
export type * from "../runs/background/process-terminal.ts";
export type * from "../runs/shared/nested-contract.ts";
export type * from "../runs/shared/run-result.ts";
export type * from "../runtime/runtime-state.ts";

// ============================================================================
// Basic Types
// ============================================================================

export interface JsonSchemaObject extends JsonInputObject {}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface TurnBudgetConfig {
	maxTurns: number;
	graceTurns?: number;
}

export interface ResolvedTurnBudget {
	maxTurns: number;
	graceTurns: number;
}

export interface ToolBudgetConfig {
	soft?: number;
	hard: number;
	block?: string[] | "*";
}

export interface ResolvedToolBudget {
	soft?: number;
	hard: number;
	block: string[] | "*";
}

export type ToolBudgetOutcome = "within-budget" | "soft-reached" | "hard-blocked";

export interface ToolBudgetState extends ResolvedToolBudget {
	outcome: ToolBudgetOutcome;
	toolCount: number;
	softReachedAt?: number;
	hardReachedAt?: number;
	blockedTool?: string;
}

export type TurnBudgetOutcome = "within-budget" | "wrap-up-requested" | "termination-deferred" | "exceeded";

export interface TurnBudgetState extends ResolvedTurnBudget {
	outcome: TurnBudgetOutcome;
	turnCount: number;
	wrapUpRequestedAtTurn?: number;
	terminationDeferredAtTurn?: number;
	exceededAtTurn?: number;
}

export interface TokenUsage {
	input: number;
	output: number;
	total: number;
}

export type ActivityState = "active_long_running" | "needs_attention";
export type ControlEventType = "active_long_running" | "needs_attention";
export type ControlNotificationChannel = "event" | "async" | "intercom";

export interface ResolvedControlConfig {
	enabled: boolean;
	needsAttentionAfterMs: number;
	activeNoticeAfterMs: number;
	activeNoticeAfterTurns?: number;
	activeNoticeAfterTokens?: number;
	failedToolAttemptsBeforeAttention: number;
	notifyOn: ControlEventType[];
	notifyChannels: ControlNotificationChannel[];
}

export interface ControlEvent {
	type: ControlEventType;
	from?: ActivityState;
	to: ActivityState;
	ts: number;
	agent: string;
	index?: number;
	runId: string;
	message: string;
	reason?:
		| "idle"
		| "completion_guard"
		| "active_long_running"
		| "tool_failures"
		| "supervisor_request"
		| "time_threshold"
		| "turn_threshold"
		| "token_threshold";
	turns?: number;
	tokens?: number;
	toolCount?: number;
	currentTool?: string;
	currentToolDurationMs?: number;
	currentPath?: string;
	elapsedMs?: number;
	recentFailureSummary?: string;
}

export type SubagentResultStatus = "completed" | "failed" | "paused" | "stopped" | "detached";
export type SubagentRunMode = "single" | "parallel";

export const SUBAGENT_LIFECYCLE_ARTIFACT_VERSION = 3;
export type SubagentLifecycleArtifactVersion = typeof SUBAGENT_LIFECYCLE_ARTIFACT_VERSION;

export type SteeringActionState = "delivered" | "scheduled" | "pending" | "partial" | "recovered" | "failed";
export type SteeringTargetState = "scheduled" | "routed" | "delivered" | "late" | "failed" | "recovered";

export interface SteeringTargetStatus {
	index: number;
	state: SteeringTargetState;
	routedAt?: number;
	deliveredAt?: number;
	lateDeliveredAt?: number;
	failedAt?: number;
	recoveredAt?: number;
	reason?: string;
	replacementRunId?: string;
}

export interface SteeringRequestStatus {
	id: string;
	requestedAt: number;
	source?: string;
	messagePreview: string;
	targets: SteeringTargetStatus[];
}

export interface SteeringStatus {
	requested: number;
	scheduled: number;
	pending: number;
	delivered: number;
	failed: number;
	recovered: number;
	lastRequestedAt?: number;
	lastDeliveredAt?: number;
	recent: SteeringRequestStatus[];
}

export type SteerActionTarget = Omit<SteeringTargetStatus, "routedAt" | "failedAt" | "recoveredAt">;

export interface SteerActionResult {
	requestId: string;
	state: SteeringActionState;
	sourceRunId: string;
	replacementRunId?: string;
	targets: SteerActionTarget[];
}

export interface SteeringNotice {
	type: "subagent.steering.notice";
	ts: number;
	runId: string;
	requestId: string;
	state: "failed" | "partial" | "recovered";
	message: string;
	currentSessionId?: string;
}

export type CostSummary = {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
};

/** Latest child Provider context occupancy, not cumulative run usage. */
export interface AgentContextUsage {
	tokens: number;
	contextWindow: number;
}

// ============================================================================
// Artifacts
// ============================================================================

export interface ArtifactPaths {
	inputPath: string;
	outputPath: string;
	jsonlPath: string;
	transcriptPath: string;
	metadataPath: string;
}

export type ArtifactDirPreference = "project" | "session" | "temp";

export interface ArtifactConfig {
	enabled: boolean;
	dir?: ArtifactDirPreference | undefined;
	includeInput: boolean;
	includeOutput: boolean;
	includeJsonl: boolean;
	includeTranscript?: boolean;
	includeMetadata: boolean;
	cleanupDays: number;
}

// ============================================================================
// Display
// ============================================================================

// ============================================================================
// Error Handling
// ============================================================================

export interface ErrorInfo {
	hasError: boolean;
	exitCode?: number;
	errorType?: string;
	details?: string;
}

export type IntercomEventBus = Pick<ExtensionAPI["events"], "emit" | "on">;

export const INTERCOM_DETACH_REQUEST_EVENT = "pi-intercom:detach-request";
export const SUBAGENT_ASYNC_STARTED_EVENT = "subagent:async-started";
export const SUBAGENT_ASYNC_STATUS_EVENT = "subagent:async-status";
export const SUBAGENT_ASYNC_COMPLETE_EVENT = "subagent:async-complete";
export const SUBAGENT_PROCESS_TERMINAL_EVENT = "subagent:process-terminal";
export const SUBAGENT_FOREGROUND_COMPLETE_EVENT = "subagent:foreground-complete";
export const SUBAGENT_CONTROL_EVENT = "subagent:control-event";
export const SUBAGENT_CONTROL_INTERCOM_EVENT = "subagent:control-intercom";
export const SUBAGENT_STEERING_NOTICE_EVENT = "subagent:steering-notice";
export const SUBAGENT_RESULT_INTERCOM_EVENT = "subagent:result-intercom";
export const SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT = "subagent:result-intercom-delivery";

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_ARTIFACT_CONFIG: ArtifactConfig = {
	enabled: true,
	dir: "session",
	includeInput: true,
	includeOutput: true,
	includeJsonl: false,
	includeTranscript: true,
	includeMetadata: true,
	cleanupDays: 7,
};

function sanitizeTempScopeSegment(value: string): string {
	const sanitized = value
		.trim()
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return sanitized || "unknown";
}

export function resolveTempScopeId(options?: {
	env?: NodeJS.ProcessEnv;
	getuid?: (() => number) | undefined;
	userInfo?: (() => { username?: string | null }) | undefined;
	homedir?: (() => string) | undefined;
}): string {
	const env = options?.env ?? process.env;
	const getuid = options && Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);
	if (isRuntimeFunction(getuid)) {
		return `uid-${getuid()}`;
	}

	for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
		const value = env[key];
		if (value) return `user-${sanitizeTempScopeSegment(value)}`;
	}

	const userInfo = options && Object.hasOwn(options, "userInfo") ? options.userInfo : os.userInfo;
	try {
		const username = userInfo?.().username;
		if (username) return `user-${sanitizeTempScopeSegment(username)}`;
	} catch {
		// Fall through to home-directory-based scoping.
	}

	const homedir = env["USERPROFILE"] ?? env["HOME"];
	if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

	const resolveHomedir = options && Object.hasOwn(options, "homedir") ? options.homedir : os.homedir;
	try {
		const fallbackHomedir = resolveHomedir?.();
		if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
	} catch {
		// Fall through to the last-resort shared scope.
	}

	return "shared";
}

type NumericConfigInput = number | string | undefined;
export function resolveTempRootDir(options?: {
	env?: NodeJS.ProcessEnv;
	getuid?: (() => number) | undefined;
	userInfo?: (() => { username?: string | null }) | undefined;
	homedir?: (() => string) | undefined;
	tmpdir?: (() => string) | undefined;
}): string {
	const scope = resolveTempScopeId(options);
	const runtimeHome = xdgRuntimeHome(options?.env ?? process.env);
	return runtimeHome
		? path.join(runtimeHome, "pi-stuff", `agents-${scope}`)
		: path.join((options?.tmpdir ?? os.tmpdir)(), `pi-stuff-agents-${scope}`);
}

export const TEMP_ROOT_DIR = resolveTempRootDir();
export function resolveSessionGovernorRoot(env: NodeJS.ProcessEnv = process.env, homeDirectory = os.homedir()): string {
	return path.join(xdgStateHome(env, homeDirectory), "pi-stuff", "agents", "session-governor");
}

export const SESSION_GOVERNOR_ROOT = resolveSessionGovernorRoot();
/** Read-only compatibility location used by releases before the durable governor root. */
export const LEGACY_SESSION_GOVERNOR_ROOT = path.join(TEMP_ROOT_DIR, "session-governor");
export const RESULTS_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-results");
export const ASYNC_DIR = path.join(TEMP_ROOT_DIR, "async-subagent-runs");
export const TEMP_ARTIFACTS_DIR = path.join(TEMP_ROOT_DIR, "artifacts");
export const POLL_INTERVAL_MS = 250;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 3;

export const DEFAULT_FORK_PREAMBLE =
	"You are a delegated subagent running from a fork of the parent session. " +
	"Treat the inherited conversation as reference-only context, not a live thread to continue. " +
	"Do not continue or answer prior messages as if they are waiting for a reply. " +
	"Your sole job is to execute the task below and return a focused result for that task using your tools.";

export function getAsyncConfigPath(suffix: string): string {
	return path.join(TEMP_ROOT_DIR, `async-cfg-${suffix}.json`);
}

export function wrapForkTask(task: string, preamble?: string | false): string {
	if (preamble === false) return task;
	const effectivePreamble = preamble ?? DEFAULT_FORK_PREAMBLE;
	const wrappedPrefix = `${effectivePreamble}\n\nTask:\n`;
	if (task.startsWith(wrappedPrefix)) return task;
	return `${wrappedPrefix}${task}`;
}

// ============================================================================
// Recursion Depth Guard
// ============================================================================

function normalizeNonNegativeInteger(value: NumericConfigInput): number | undefined {
	const parsed = isRuntimeNumber(value) ? value : isRuntimeString(value) ? Number(value) : NaN;
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

export function normalizeMaxSubagentDepth(value: NumericConfigInput): number | undefined {
	return normalizeNonNegativeInteger(value);
}

export function resolveCurrentMaxSubagentDepth(configMaxDepth?: number): number {
	return (
		normalizeMaxSubagentDepth(process.env["PI_SUBAGENT_MAX_DEPTH"]) ??
		normalizeMaxSubagentDepth(configMaxDepth) ??
		DEFAULT_SUBAGENT_MAX_DEPTH
	);
}

export function resolveChildMaxSubagentDepth(parentMaxDepth: number, agentMaxDepth?: number): number {
	const normalizedParent = normalizeMaxSubagentDepth(parentMaxDepth) ?? DEFAULT_SUBAGENT_MAX_DEPTH;
	const normalizedAgent = normalizeMaxSubagentDepth(agentMaxDepth);
	return normalizedAgent === undefined ? normalizedParent : Math.min(normalizedParent, normalizedAgent);
}

export function checkSubagentDepth(configMaxDepth?: number) {
	const depth = Number(process.env["PI_SUBAGENT_DEPTH"] ?? "0");
	const maxDepth = resolveCurrentMaxSubagentDepth(configMaxDepth);
	const blocked = Number.isFinite(depth) && depth >= maxDepth;
	return { blocked, depth, maxDepth };
}

export interface SubagentDepthEnvironment {
	readonly PI_SUBAGENT_DEPTH: string;
	readonly PI_SUBAGENT_MAX_DEPTH: string;
}

export function getSubagentDepthEnv(maxDepth?: number, env: NodeJS.ProcessEnv = process.env): SubagentDepthEnvironment {
	const parentDepth = Number(env["PI_SUBAGENT_DEPTH"] ?? "0");
	const nextDepth = Number.isFinite(parentDepth) ? parentDepth + 1 : 1;
	return {
		PI_SUBAGENT_DEPTH: String(nextDepth),
		PI_SUBAGENT_MAX_DEPTH: String(
			normalizeMaxSubagentDepth(maxDepth) ??
				normalizeMaxSubagentDepth(env["PI_SUBAGENT_MAX_DEPTH"]) ??
				DEFAULT_SUBAGENT_MAX_DEPTH,
		),
	};
}
