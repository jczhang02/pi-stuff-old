import * as fs from "node:fs";
import * as path from "node:path";
import { isRuntimeNumber, isRuntimeString } from "../../../../shared/runtime-type.js";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { type SessionCompatibilityScope, sessionArtifactMatches } from "../../shared/session-identity.ts";
import type {
	ActivityState,
	AgentContextUsage,
	AsyncJobStep,
	AsyncParallelGroupStatus,
	AsyncStatus,
	CostSummary,
	NestedRouteInfo,
	NestedRunSummary,
	SteeringStatus,
	SubagentRunMode,
	TokenUsage,
	TurnBudgetState,
} from "../../shared/types.ts";
import { getErrorMessage, isNotFoundError, pickFields, readStatus } from "../../shared/utils.ts";
import type { ResolvedSubagentCapabilityCeiling, SubagentCapabilityAudit } from "../shared/capability-ceiling.ts";
import { type ContextMode, type ContextSummary, summarizeContextModes } from "../shared/context-mode.ts";
import {
	attachRootChildrenToSteps,
	buildNestedRouteIndex,
	type NestedRoute,
	projectNestedEvents,
	readNestedRegistry,
	resolvePersistedNestedRoute,
} from "../shared/nested-events.ts";
import { sanitizeSummary } from "../shared/nested-summary.ts";
import { normalizeParallelGroups } from "./parallel-groups.ts";
import { readProcessTerminal, sanitizeProcessTerminal } from "./process-terminal.ts";
import { reconcileAsyncRun, reconcileNestedAsyncDescendants } from "./stale-run-reconciler.ts";

interface AsyncRunStepSummary {
	index: number;
	agent: string;
	context?: ContextMode;
	delegatedTask?: string;
	task?: string;
	label?: string;
	phase?: string;
	outputName?: string;
	structured?: boolean;
	status: AsyncJobStep["status"];
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	recentOutput?: string[];
	finalOutput?: string;
	turnCount?: number;
	toolCount?: number;
	steering?: SteeringStatus;
	durationMs?: number;
	tokens?: TokenUsage;
	contextUsage?: AgentContextUsage;
	totalCost?: CostSummary;
	skills?: string[];
	model?: string;
	thinking?: string;
	attemptedModels?: string[];
	sessionFile?: string;
	transcriptPath?: string;
	transcriptError?: string;
	error?: string;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	acceptance?: AsyncJobStep["acceptance"];
	launchContractDigest?: string;
	processTerminal?: AsyncJobStep["processTerminal"];
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
	children?: NestedRunSummary[];
}

export interface AsyncRunSummary {
	id: string;
	asyncDir: string;
	sessionId?: string;
	state: "queued" | "running" | "complete" | "failed" | "paused" | "stopped";
	error?: string;
	activityState?: ActivityState;
	lastActivityAt?: number;
	currentTool?: string;
	currentToolStartedAt?: number;
	currentPath?: string;
	turnCount?: number;
	toolCount?: number;
	steering?: SteeringStatus;
	mode: SubagentRunMode;
	context?: ContextSummary;
	cwd?: string;
	startedAt: number;
	lastUpdate?: number;
	endedAt?: number;
	timeoutMs?: number;
	deadlineAt?: number;
	timedOut?: boolean;
	stopped?: boolean;
	turnBudget?: TurnBudgetState;
	turnBudgetExceeded?: boolean;
	wrapUpRequested?: boolean;
	currentStep?: number;
	parallelGroups?: AsyncParallelGroupStatus[];
	steps: AsyncRunStepSummary[];
	/** Exact validated nested route retained across Host reload. */
	nestedRoute?: NestedRouteInfo;
	sessionDir?: string;
	outputFile?: string;
	totalTokens?: TokenUsage;
	totalCost?: CostSummary;
	sessionFile?: string;
	nestedChildren?: NestedRunSummary[];
	nestedWarnings?: string[];
	processTerminal?: AsyncStatus["processTerminal"];
	launchContractDigest?: string;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling;
	capabilityAudit?: SubagentCapabilityAudit;
}

interface AsyncRunListOptions {
	states?: Array<AsyncRunSummary["state"]>;
	sessionId?: string;
	sessionScope?: SessionCompatibilityScope;
	limit?: number;
	resultsDir?: string;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => boolean;
	now?: () => number;
	reconcile?: boolean;
	runId?: string;
	/** Order lightweight status candidates newest-first and stop after limit matches. */
	preselectRecent?: boolean;
}

type TargetedAsyncRunResolution = { kind: "exact"; id: string } | { kind: "scan" } | { kind: "reject" };

/**
 * Resolve an exact targeted run without following a run-directory symlink or
 * accepting a path whose canonical location escaped the async root.
 */
export function resolveTargetedAsyncRun(
	asyncDirRoot: string,
	id: string,
	sessionId?: string,
): TargetedAsyncRunResolution {
	if (!id || id === "." || id === ".." || path.basename(id) !== id) return { kind: "reject" };
	const asyncDir = path.join(asyncDirRoot, id);
	let entryStat: fs.Stats;
	try {
		entryStat = fs.lstatSync(asyncDir);
	} catch (error) {
		if (isNotFoundError(error)) return { kind: "scan" };
		throw new Error(`Failed to inspect async run path '${asyncDir}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) return { kind: "reject" };
	try {
		const canonicalRoot = fs.realpathSync(asyncDirRoot);
		const canonicalDir = fs.realpathSync(asyncDir);
		if (canonicalDir !== canonicalRoot && !canonicalDir.startsWith(`${canonicalRoot}${path.sep}`))
			return { kind: "reject" };
	} catch (error) {
		if (isNotFoundError(error)) return { kind: "reject" };
		throw new Error(`Failed to resolve async run path '${asyncDir}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	if (sessionId !== undefined) {
		const status = readStatus(asyncDir);
		if (status?.sessionId !== sessionId) return { kind: "scan" };
	}
	return { kind: "exact", id };
}

function outputFileMtime(outputFile: string | undefined): number | undefined {
	if (!outputFile) return undefined;
	try {
		return fs.statSync(outputFile).mtimeMs;
	} catch (error) {
		if (isNotFoundError(error)) return undefined;
		throw new Error(`Failed to inspect async output file '${outputFile}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function deriveAsyncActivityState(asyncDir: string, status: AsyncStatus) {
	if (status.state !== "running")
		return { activityState: status.activityState, lastActivityAt: status.lastActivityAt };
	const outputPath = status.outputFile
		? path.isAbsolute(status.outputFile)
			? status.outputFile
			: path.join(asyncDir, status.outputFile)
		: undefined;
	const currentStep = isRuntimeNumber(status.currentStep) ? status.steps?.[status.currentStep] : undefined;
	return {
		activityState: status.activityState,
		lastActivityAt:
			status.lastActivityAt ??
			outputFileMtime(outputPath) ??
			currentStep?.lastActivityAt ??
			currentStep?.startedAt ??
			status.startedAt,
	};
}

function summarizeAsyncStep(
	asyncDir: string,
	status: AsyncStatus,
	step: AsyncJobStep,
	index: number,
): AsyncRunStepSummary {
	const summary: AsyncRunStepSummary = {
		index,
		agent: step.agent,
		status: step.status,
	};
	if (step.context) summary.context = step.context;
	if (step.delegatedTask) summary.delegatedTask = step.delegatedTask;
	if (step.task) summary.task = step.task;
	if (step.label) summary.label = step.label;
	if (step.phase) summary.phase = step.phase;
	if (step.outputName) summary.outputName = step.outputName;
	if (step.structured) summary.structured = step.structured;
	if (step.activityState) summary.activityState = step.activityState;
	if (step.lastActivityAt) summary.lastActivityAt = step.lastActivityAt;
	if (step.currentTool) summary.currentTool = step.currentTool;
	if (step.currentToolArgs) summary.currentToolArgs = step.currentToolArgs;
	if (step.currentToolStartedAt) summary.currentToolStartedAt = step.currentToolStartedAt;
	if (step.currentPath) summary.currentPath = step.currentPath;
	if (step.recentOutput) summary.recentOutput = [...step.recentOutput];
	if (step.finalOutput !== undefined) summary.finalOutput = step.finalOutput;
	Object.assign(summary, pickFields(step, ["turnCount", "toolCount"]));
	if (step.steering) summary.steering = step.steering;
	if (step.durationMs !== undefined) summary.durationMs = step.durationMs;
	if (step.tokens) summary.tokens = step.tokens;
	if (step.contextUsage) summary.contextUsage = step.contextUsage;
	if (step.totalCost) summary.totalCost = step.totalCost;
	if (step.skills) summary.skills = step.skills;
	if (step.model) summary.model = step.model;
	if (step.thinking) summary.thinking = step.thinking;
	if (step.attemptedModels) summary.attemptedModels = step.attemptedModels;
	if (step.sessionFile) summary.sessionFile = step.sessionFile;
	if (step.transcriptPath) summary.transcriptPath = step.transcriptPath;
	if (step.transcriptError) summary.transcriptError = step.transcriptError;
	if (step.error) summary.error = step.error;
	Object.assign(summary, pickFields(step, ["timedOut", "stopped"]));
	if (step.turnBudget) summary.turnBudget = step.turnBudget;
	Object.assign(summary, pickFields(step, ["turnBudgetExceeded", "wrapUpRequested"]));
	if (step.acceptance) summary.acceptance = step.acceptance;
	if (step.launchContractDigest) summary.launchContractDigest = step.launchContractDigest;
	if (step.processTerminal) {
		summary.processTerminal = sanitizeProcessTerminal(
			step.processTerminal,
			{ runId: status.runId, runnerProcessInstanceId: step.processTerminal.runnerProcessInstanceId },
			`${path.join(asyncDir, "status.json")} step ${index}`,
		);
	}
	if (step.capabilityCeiling) summary.capabilityCeiling = step.capabilityCeiling;
	if (step.capabilityAudit) summary.capabilityAudit = step.capabilityAudit;
	if (step.children?.length) {
		summary.children = step.children
			.map((child) => sanitizeSummary(child))
			.filter((child): child is NestedRunSummary => child !== undefined);
	}
	return summary;
}

function statusToSummary(
	asyncDir: string,
	status: AsyncStatus,
	nestedWarnings: string[] = [],
	nestedRoute?: NestedRoute,
	projectNested = true,
): AsyncRunSummary {
	if (status.sessionId !== undefined && !isRuntimeString(status.sessionId)) {
		throw new Error(`Invalid async status '${path.join(asyncDir, "status.json")}': sessionId must be a string.`);
	}
	const { activityState, lastActivityAt } = deriveAsyncActivityState(asyncDir, status);
	const processTerminal =
		readProcessTerminal(asyncDir, {
			runId: status.runId,
			runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId,
		}) ??
		sanitizeProcessTerminal(
			status.processTerminal,
			{ runId: status.runId, runnerProcessInstanceId: status.processTerminal?.runnerProcessInstanceId },
			path.join(asyncDir, "status.json"),
		);
	const steps = status.steps ?? [];
	const parallelGroups = normalizeParallelGroups(status.parallelGroups, steps.length);
	let nestedChildren: NestedRunSummary[] = [];
	let nestedProjectionAvailable = false;
	if (nestedWarnings.length === 0 && nestedRoute) {
		try {
			// The route is resolved by the caller via buildNestedRouteIndex, so this
			// avoids a fresh scan of the nested-events directory per run.
			nestedChildren = (projectNested ? projectNestedEvents(nestedRoute) : readNestedRegistry(nestedRoute)).children;
			nestedProjectionAvailable = true;
		} catch (error) {
			nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
		}
	}
	const summarizedSteps = steps.map((step, index) => summarizeAsyncStep(asyncDir, status, step, index));
	if (nestedProjectionAvailable) {
		attachRootChildrenToSteps(status.runId || path.basename(asyncDir), summarizedSteps, nestedChildren);
	} else {
		// Terminal status already contains a bounded nested projection. Preserve it
		// when the route has been reclaimed or is temporarily unreadable so cold
		// `/agents` inspection does not erase known descendants.
		nestedChildren = summarizedSteps.flatMap((step) => step.children ?? []);
	}
	const context = summarizeContextModes(summarizedSteps.map((step) => step.context));
	const summary: AsyncRunSummary = {
		id: status.runId || path.basename(asyncDir),
		asyncDir,
		state: status.state,
		mode: status.mode,
		startedAt: status.startedAt,
		steps: summarizedSteps,
	};
	if (activityState !== undefined) summary.activityState = activityState;
	if (lastActivityAt !== undefined) summary.lastActivityAt = lastActivityAt;
	Object.assign(summary, pickFields(status, ["currentTool", "currentToolStartedAt", "currentPath"]));
	Object.assign(summary, pickFields(status, ["turnCount", "toolCount", "steering", "cwd"]));
	Object.assign(summary, pickFields(status, ["lastUpdate", "endedAt", "currentStep"]));
	if (status.sessionId) summary.sessionId = status.sessionId;
	if (status.error) summary.error = status.error;
	if (context) summary.context = context;
	Object.assign(summary, pickFields(status, ["timeoutMs", "deadlineAt", "timedOut", "stopped"]));
	if (status.turnBudget) summary.turnBudget = status.turnBudget;
	Object.assign(summary, pickFields(status, ["turnBudgetExceeded", "wrapUpRequested"]));
	if (parallelGroups.length) summary.parallelGroups = parallelGroups;
	if (nestedRoute) summary.nestedRoute = nestedRoute;
	if (nestedChildren.length) summary.nestedChildren = nestedChildren;
	if (nestedWarnings.length) summary.nestedWarnings = nestedWarnings;
	if (processTerminal) summary.processTerminal = processTerminal;
	if (status.launchContractDigest) summary.launchContractDigest = status.launchContractDigest;
	if (status.capabilityCeiling) summary.capabilityCeiling = status.capabilityCeiling;
	if (status.capabilityAudit) summary.capabilityAudit = status.capabilityAudit;
	if (status.sessionDir) summary.sessionDir = status.sessionDir;
	if (status.outputFile) summary.outputFile = status.outputFile;
	if (status.totalTokens) summary.totalTokens = status.totalTokens;
	if (status.totalCost) summary.totalCost = status.totalCost;
	if (status.sessionFile) summary.sessionFile = status.sessionFile;
	return summary;
}

function sortRuns(runs: AsyncRunSummary[]): AsyncRunSummary[] {
	const rank = (state: AsyncRunSummary["state"]): number => {
		switch (state) {
			case "running":
				return 0;
			case "queued":
				return 1;
			case "failed":
			case "stopped":
			case "paused":
				return 2;
			case "complete":
				return 3;
		}
	};
	return [...runs].sort((a, b) => {
		const byState = rank(a.state) - rank(b.state);
		if (byState !== 0) return byState;
		const aTime = a.lastUpdate ?? a.endedAt ?? a.startedAt;
		const bTime = b.lastUpdate ?? b.endedAt ?? b.startedAt;
		return bTime - aTime;
	});
}

function listAsyncRunEntries(asyncDirRoot: string, options: AsyncRunListOptions): string[] {
	try {
		if (options.runId === undefined)
			return fs
				.readdirSync(asyncDirRoot)
				.filter((entry) => resolveTargetedAsyncRun(asyncDirRoot, entry).kind === "exact");
		const { runId } = options;
		const resolution = resolveTargetedAsyncRun(
			asyncDirRoot,
			runId,
			options.sessionScope ? undefined : options.sessionId,
		);
		if (resolution.kind === "exact") return [resolution.id];
		if (resolution.kind !== "scan") return [];
		return fs
			.readdirSync(asyncDirRoot)
			.filter(
				(entry) =>
					(entry === runId || entry.startsWith(runId)) &&
					resolveTargetedAsyncRun(asyncDirRoot, entry, options.sessionScope ? undefined : options.sessionId)
						.kind === "exact",
			);
	} catch (error) {
		if (isNotFoundError(error)) return [];
		throw new Error(`Failed to list async runs in '${asyncDirRoot}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

export function listAsyncRuns(asyncDirRoot: string, options: AsyncRunListOptions = {}): AsyncRunSummary[] {
	const matchesSession = (status: AsyncStatus): boolean =>
		options.sessionScope
			? sessionArtifactMatches(options.sessionScope, status.sessionId, status.runId)
			: !options.sessionId || status.sessionId === options.sessionId;
	const entries = listAsyncRunEntries(asyncDirRoot, options);
	if (options.preselectRecent) {
		const statusMtimes = new Map<string, number>();
		for (const entry of entries) {
			try {
				const stat = fs.lstatSync(path.join(asyncDirRoot, entry, "status.json"));
				statusMtimes.set(entry, stat.isFile() && !stat.isSymbolicLink() ? stat.mtimeMs : Number.NEGATIVE_INFINITY);
			} catch {
				statusMtimes.set(entry, Number.NEGATIVE_INFINITY);
			}
		}
		entries.sort(
			(left, right) =>
				(statusMtimes.get(right) ?? Number.NEGATIVE_INFINITY) -
					(statusMtimes.get(left) ?? Number.NEGATIVE_INFINITY) || left.localeCompare(right),
		);
	}

	const allowedStates = options.states ? new Set(options.states) : undefined;
	const runs: AsyncRunSummary[] = [];
	// Route resolution for every run shares a single index built from the
	// nested-events directory, so the per-run lookup is O(1) instead of scanning
	// the directory once per run. The index is built lazily on first use, so
	// load-time restoration (which only wants queued/running runs) skips it
	// entirely when no active runs match.
	let nestedRouteIndex: Map<string, NestedRoute> | undefined;
	const resolveNestedRoute = (rootRunId: string): NestedRoute | undefined => {
		if (!nestedRouteIndex) nestedRouteIndex = buildNestedRouteIndex();
		return nestedRouteIndex.get(rootRunId);
	};
	for (const entry of entries) {
		const asyncDir = path.join(asyncDirRoot, entry);
		try {
			const preselectedStatus = options.preselectRecent ? readStatus(asyncDir) : null;
			if (preselectedStatus) {
				if (allowedStates && !allowedStates.has(preselectedStatus.state)) continue;
				if (!matchesSession(preselectedStatus)) continue;
			}
			const reconciliation =
				options.reconcile === false
					? undefined
					: reconcileAsyncRun(asyncDir, {
							resultsDir: options.resultsDir,
							kill: options.kill,
							now: options.now,
						});
			const status = reconciliation?.status ?? preselectedStatus ?? readStatus(asyncDir);
			if (!status) continue;
			// Filter before the nested-route lookup: the lookup builds an index over
			// the nested-events directory, so deferring it for filtered-out runs keeps
			// restoration at load from scanning that directory when no active runs
			// match.
			if (allowedStates && !allowedStates.has(status.state)) continue;
			if (!matchesSession(status)) continue;
			const nestedWarnings: string[] = [];
			let nestedRoute: NestedRoute | undefined;
			try {
				if (status.nestedRoute !== undefined) {
					nestedRoute = resolvePersistedNestedRoute(status.nestedRoute, status.runId);
					if (!nestedRoute) nestedWarnings.push("Persisted nested route is unavailable or no longer trusted.");
				} else {
					// Compatibility path for status files created before exact route
					// persistence. New statuses never select an arbitrary same-root route.
					nestedRoute = resolveNestedRoute(status.runId || path.basename(asyncDir));
				}
				if (nestedRoute && options.reconcile !== false)
					reconcileNestedAsyncDescendants(nestedRoute, {
						resultsDir: options.resultsDir,
						kill: options.kill,
						now: options.now,
					});
			} catch (error) {
				nestedWarnings.push(`Nested status unavailable: ${getErrorMessage(error)}`);
			}
			const summary = statusToSummary(asyncDir, status, nestedWarnings, nestedRoute, options.reconcile !== false);
			runs.push(options.sessionScope ? { ...summary, sessionId: options.sessionScope.sessionId } : summary);
			if (options.preselectRecent && options.limit !== undefined && runs.length >= options.limit) break;
		} catch (error) {
			// One transiently unreadable or corrupt run must not hide every healthy
			// sibling during session restoration. The result watcher remains active
			// and a later scan can recover this run once its durable state is readable.
			reportAgentDiagnostic(`Failed to inspect async run '${asyncDir}'; leaving it untouched for retry:`, error);
		}
	}

	const sorted = sortRuns(runs);
	return options.limit !== undefined ? sorted.slice(0, options.limit) : sorted;
}
