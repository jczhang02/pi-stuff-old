/** Build and launch detached single-Agent or parallel-Agent runs. */

import * as path from "node:path";
import * as Effect from "effect/Effect";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import { resolveDisplayDescription } from "../../shared/display-description.ts";
import { claimPreparedRunDirectory, ensurePrivateDirectory } from "../../shared/private-directory.ts";
import {
	type ArtifactConfig,
	ASYNC_DIR,
	type AsyncStartedEvent,
	type Details,
	type NestedRouteInfo,
	type NestedRunSummary,
	RESULTS_DIR,
	SUBAGENT_ASYNC_STARTED_EVENT,
	SUBAGENT_ASYNC_STATUS_EVENT,
	SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
	SUBAGENT_PROCESS_TERMINAL_EVENT,
	TEMP_ROOT_DIR,
} from "../../shared/types.ts";
import { getErrorMessage } from "../../shared/utils.ts";
import {
	type ResolvedSubagentCapabilityCeiling,
	resolveCurrentSubagentCapabilityCeiling,
} from "../shared/capability-ceiling.ts";
import { deferredModule } from "../shared/deferred-module.ts";
import {
	nestedResultsPath,
	resolveInheritedNestedRouteFromEnv,
	resolveNestedParentAddressFromEnv,
	writeNestedEvent,
} from "../shared/nested-events.ts";
import type { BackgroundRunnerConfig, BackgroundRunnerWork } from "../shared/parallel-utils.ts";
import { resolvePiPackageRoot, resolveStandalonePiHostExecutable } from "../shared/pi-spawn.ts";
import type { SessionLeaseIntent } from "../shared/session-lease.ts";
import { persistRecoveries } from "./recovery-writer.ts";
import type { AsyncExecutionContext, BackgroundRecoveryDescriptor } from "./resolved-task.ts";
import type { SpawnedRunnerLifecycle } from "./runner-process.ts";
import type { AsyncParallelRunnerWorkBuildParams, AsyncSingleRunnerWorkBuildParams } from "./runner-work.ts";
import { buildAsyncParallelRunnerWork, buildAsyncSingleRunnerWork } from "./runner-work.ts";

export { persistRecoveries } from "./recovery-writer.ts";

export type {
	AsyncExecutionContext,
	AsyncParallelTaskInput,
	BackgroundRecoveryDescriptor,
	BuiltTask,
	CommonBuildParams,
	ResolvedTaskBuildInput,
} from "./resolved-task.ts";
export type {
	AsyncParallelRunnerWorkBuildParams,
	AsyncRunnerWorkBuildResult,
	AsyncSingleRunnerWorkBuildParams,
	AsyncSingleRunnerWorkBuildResult,
} from "./runner-work.ts";
export { buildAsyncParallelRunnerWork, buildAsyncSingleRunnerWork } from "./runner-work.ts";

const loadRunner = deferredModule(() => import("./runner-process.ts"));

const START_EVENT_TASK_PREVIEW_CODE_UNITS = 500;

const piPackageRoot = resolvePiPackageRoot();
const piExecutable = resolveStandalonePiHostExecutable();

interface AsyncStartedNotice extends AsyncStartedEvent {
	acknowledgeStart?: () => void;
	abortStart?: () => boolean;
}

function taskPreview(task: string): string {
	return task.length <= START_EVENT_TASK_PREVIEW_CODE_UNITS
		? task
		: `${task.slice(0, START_EVENT_TASK_PREVIEW_CODE_UNITS - 1)}…`;
}

interface AsyncLaunchParams {
	goal?: string | undefined;
	artifactsDir?: string | undefined;
	artifactConfig: ArtifactConfig;
	sessionRoot?: string | undefined;
	controlIntercomTarget?: string | undefined;
	childIntercomTarget?: ((agent: string, index: number) => string | undefined) | undefined;
	nestedRoute?: NestedRouteInfo | undefined;
	timeoutMs?: number | undefined;
}

type AsyncParallelParams = AsyncParallelRunnerWorkBuildParams & AsyncLaunchParams;

type AsyncSingleParams = AsyncSingleRunnerWorkBuildParams &
	AsyncLaunchParams & {
		revivalLease?: SessionLeaseIntent | undefined;
	};

interface AsyncExecutionResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export function formatAsyncStartedMessage(headline: string, interactive: boolean): string {
	const guidance = interactive
		? [
				"The Agent is running in the background and will report completion automatically.",
				"Continue independent work or return control to the user. Use Agent status for a one-shot inspection; start foreground work when its result is required before continuing.",
			]
		: [
				"The Agent is running in the background and will report completion automatically.",
				"Do not poll or sleep just to wait. Use Agent status only for a one-shot inspection.",
			];
	return [headline, "", ...guidance].join("\n");
}

function formatAsyncStartError(
	mode: "single" | "parallel",
	message: string,
	details: Partial<Details> = {},
): AsyncExecutionResult {
	return {
		content: [{ type: "text", text: message }],
		isError: true,
		details: { mode, results: [], ...details },
	};
}

function lifecycleRecoveryDetails(
	runId: string,
	asyncDir: string,
	lifecycleBinding?: NonNullable<Details["lifecycleBinding"]>,
): Partial<Details> {
	const details: Partial<Details> = { runId, asyncId: runId, asyncDir };
	if (lifecycleBinding) details.lifecycleBinding = lifecycleBinding;
	return details;
}

interface BackgroundRunDirectoryClaim {
	readonly asyncDir: string;
	readonly inheritedNestedRoute?: NestedRouteInfo;
	readonly nestedAddress?: ReturnType<typeof resolveNestedParentAddressFromEnv>;
	cleanup(): void;
	commit(): boolean;
}

export function cleanupBackgroundRunAfterAbort(
	location: Pick<BackgroundRunDirectoryClaim, "cleanup">,
	abortStart?: () => boolean,
): boolean {
	let safeToCleanup = false;
	try {
		safeToCleanup = abortStart?.() === true;
	} catch {
		// A failed abort transport is not proof that the runner and every writer
		// exited. Preserve lifecycle evidence and governor authority fail-closed.
		safeToCleanup = false;
	}
	if (safeToCleanup) location.cleanup();
	return safeToCleanup;
}

function retainedRunnerLifecycleBinding(
	asyncDir: string,
	spawned: SpawnedRunnerLifecycle,
): NonNullable<Details["lifecycleBinding"]> | undefined {
	if (!spawned.pid) return undefined;
	const binding: NonNullable<Details["lifecycleBinding"]> = {
		pid: spawned.pid,
		asyncDir,
	};
	if (spawned.processStartIdentity) binding.processStartIdentity = spawned.processStartIdentity;
	if (spawned.acknowledgeStart) binding.acknowledgeStart = spawned.acknowledgeStart;
	if (spawned.abortStart) binding.abortStart = spawned.abortStart;
	return binding;
}

export type BackgroundOwnershipFailureResolution =
	| { readonly safeToRelease: true }
	| {
			readonly safeToRelease: false;
			readonly lifecycleBinding?: NonNullable<Details["lifecycleBinding"]>;
	  };

/**
 * Resolve a post-spawn ownership failure without mistaking control failure for
 * process death. A retained runner is committed again best-effort so a
 * transient marker unlink failure does not leave preparation debris.
 */
export function resolveBackgroundOwnershipFailure(
	location: Pick<BackgroundRunDirectoryClaim, "asyncDir" | "cleanup" | "commit">,
	spawned: SpawnedRunnerLifecycle,
): BackgroundOwnershipFailureResolution {
	if (cleanupBackgroundRunAfterAbort(location, spawned.abortStart)) return { safeToRelease: true };
	location.commit();
	const lifecycleBinding = retainedRunnerLifecycleBinding(location.asyncDir, spawned);
	if (!lifecycleBinding) return { safeToRelease: false };
	return {
		safeToRelease: false,
		lifecycleBinding,
	};
}

export function claimBackgroundRunDirectory(id: string): BackgroundRunDirectoryClaim | { error: string } {
	if (!id || id.length > 128 || /[\\/]/u.test(id) || id.includes("..")) {
		return { error: "Invalid internal background Agent launch identity." };
	}
	const inheritedNestedRoute = resolveInheritedNestedRouteFromEnv();
	const nestedAddress = inheritedNestedRoute ? resolveNestedParentAddressFromEnv() : undefined;
	const asyncDir = inheritedNestedRoute
		? path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId, id)
		: path.join(ASYNC_DIR, id);
	try {
		ensurePrivateDirectory(TEMP_ROOT_DIR);
		if (inheritedNestedRoute) {
			ensurePrivateDirectory(path.join(TEMP_ROOT_DIR, "nested-subagent-runs"));
			ensurePrivateDirectory(path.join(TEMP_ROOT_DIR, "nested-subagent-runs", inheritedNestedRoute.rootRunId));
		} else {
			ensurePrivateDirectory(ASYNC_DIR);
		}
		const prepared = claimPreparedRunDirectory(asyncDir, "background");
		const claim: BackgroundRunDirectoryClaim = {
			asyncDir,
			cleanup: prepared.cleanup,
			commit: prepared.commit,
		};
		if (inheritedNestedRoute && nestedAddress) return { ...claim, inheritedNestedRoute, nestedAddress };
		if (inheritedNestedRoute) return { ...claim, inheritedNestedRoute };
		return claim;
	} catch (error) {
		return {
			error: `Failed to create background run directory '${asyncDir}': ${
				error instanceof Error ? error.message : String(error)
			}`,
		};
	}
}

function nestedSelfFromLocation(
	location: Exclude<ReturnType<typeof claimBackgroundRunDirectory>, { error: string }>,
): BackgroundRunnerConfig["nestedSelf"] {
	if (!location.inheritedNestedRoute || !location.nestedAddress) return undefined;
	const nestedSelf: NonNullable<BackgroundRunnerConfig["nestedSelf"]> = {
		parentRunId: location.nestedAddress.parentRunId,
		depth: location.nestedAddress.depth,
		path: location.nestedAddress.path,
	};
	if (location.nestedAddress.parentStepIndex !== undefined)
		nestedSelf.parentStepIndex = location.nestedAddress.parentStepIndex;
	return nestedSelf;
}

function emitStarted(input: {
	id: string;
	pid: number;
	processStartIdentity: string;
	work: BackgroundRunnerWork;
	runnerCwd: string;
	asyncDir: string;
	ctx: AsyncExecutionContext;
	goal?: string | undefined;
	timeoutMs?: number | undefined;
	deadlineAt?: number | undefined;
	nestedRoute?: NestedRouteInfo | undefined;
	nestedSelf?: BackgroundRunnerConfig["nestedSelf"] | undefined;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling | undefined;
	acknowledgeStart?: (() => void) | undefined;
	abortStart?: (() => boolean) | undefined;
}): void {
	const tasks = input.work.mode === "single" ? [input.work.task] : input.work.group.tasks;
	const first = tasks[0];
	if (!first) return;
	if (input.nestedRoute && input.nestedSelf) {
		const now = Date.now();
		try {
			const child: NestedRunSummary = {
				id: input.id,
				parentRunId: input.nestedSelf.parentRunId,
				depth: input.nestedSelf.depth,
				path: input.nestedSelf.path ?? [],
				asyncDir: input.asyncDir,
				pid: input.pid,
				ownerState: "live",
				mode: input.work.mode,
				state: "running",
				agent: first.agent,
				agents: tasks.map((task) => task.agent),
				startedAt: now,
				lastUpdate: now,
			};
			if (input.nestedSelf.parentStepIndex !== undefined) child.parentStepIndex = input.nestedSelf.parentStepIndex;
			const ownerIntercomTarget = process.env["PI_SUBAGENT_INTERCOM_SESSION_NAME"];
			if (ownerIntercomTarget !== undefined) child.ownerIntercomTarget = ownerIntercomTarget;
			if (input.timeoutMs !== undefined) {
				child.timeoutMs = input.timeoutMs;
				if (input.deadlineAt !== undefined) child.deadlineAt = input.deadlineAt;
			}
			if (input.capabilityCeiling) child.capabilityCeiling = input.capabilityCeiling;
			const event: Parameters<typeof writeNestedEvent>[1] = {
				type: "subagent.nested.started",
				ts: now,
				parentRunId: input.nestedSelf.parentRunId,
				child,
			};
			if (input.nestedSelf.parentStepIndex !== undefined) event.parentStepIndex = input.nestedSelf.parentStepIndex;
			writeNestedEvent(input.nestedRoute, event);
		} catch (error) {
			reportAgentDiagnostic("Failed to emit nested Agent start:", error);
		}
	}
	try {
		const started: AsyncStartedNotice = {
			lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
			id: input.id,
			pid: input.pid,
			processStartIdentity: input.processStartIdentity,
			sessionId: input.ctx.currentSessionId,
			mode: input.work.mode,
			agent: first.agent,
			agents: tasks.map((task) => task.agent),
			descriptions: tasks.map((task) => resolveDisplayDescription(task.description, task.task)),
			task: (first.delegatedTask ?? first.task).slice(0, 50),
			tasks: tasks.map((task) => taskPreview(task.delegatedTask ?? task.task)),
			goal: (input.goal ?? first.task).slice(0, 120),
			cwd: input.runnerCwd,
			asyncDir: input.asyncDir,
		};
		if (first.description !== undefined) started.description = first.description;
		if (input.nestedRoute !== undefined) started.nestedRoute = input.nestedRoute;
		if (input.timeoutMs !== undefined) {
			started.timeoutMs = input.timeoutMs;
			if (input.deadlineAt !== undefined) started.deadlineAt = input.deadlineAt;
		}
		if (input.capabilityCeiling) started.capabilityCeiling = input.capabilityCeiling;
		if (input.acknowledgeStart) started.acknowledgeStart = input.acknowledgeStart;
		if (input.abortStart) started.abortStart = input.abortStart;
		input.ctx.pi.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, started);
	} catch (error) {
		reportAgentDiagnostic(`Async Agent start observer failed for '${input.id}':`, error);
	}
}

function persistRecoveriesOrError(
	mode: "single" | "parallel",
	id: string,
	location: BackgroundRunDirectoryClaim,
	recoveries: BackgroundRecoveryDescriptor[],
): AsyncExecutionResult | undefined {
	try {
		persistRecoveries(location.asyncDir, recoveries);
	} catch (error) {
		location.cleanup();
		return formatAsyncStartError(
			mode,
			`Failed to persist background recovery data for '${id}': ${getErrorMessage(error)}`,
		);
	}
	return undefined;
}

interface PreparedAsyncLaunch {
	id: string;
	params: AsyncParallelParams | AsyncSingleParams;
	location: BackgroundRunDirectoryClaim;
	work: BackgroundRunnerWork;
	runnerCwd: string;
	timeoutMs?: number | undefined;
	deadlineAt?: number | undefined;
	sessionDir?: string | undefined;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling | undefined;
}

function createAsyncRunnerConfig(input: PreparedAsyncLaunch): BackgroundRunnerConfig {
	const { id, params, location, work } = input;
	const config: BackgroundRunnerConfig = {
		version: 2,
		id,
		parentRunOrigin: params.parentRunOrigin === "user" ? "user" : "automatic",
		work,
		resultPath: location.inheritedNestedRoute
			? nestedResultsPath(location.inheritedNestedRoute.rootRunId, id)
			: path.join(RESULTS_DIR, `${id}.json`),
		cwd: input.runnerCwd,
		asyncDir: location.asyncDir,
		sessionId: params.ctx.currentSessionId,
		artifactConfig: params.artifactConfig,
		nativeSupervisor: location.inheritedNestedRoute === undefined,
	};
	if (piPackageRoot) config.piPackageRoot = piPackageRoot;
	if (process.argv[1]) config.piArgv1 = process.argv[1];
	if (params.controlConfig) config.controlConfig = params.controlConfig;
	if (params.controlIntercomTarget) config.controlIntercomTarget = params.controlIntercomTarget;
	if (params.childIntercomTarget) {
		const tasks = work.mode === "single" ? [work.task] : work.group.tasks;
		config.childIntercomTargets = tasks.map((task, index) => params.childIntercomTarget?.(task.agent, index));
	}
	const nestedRoute = params.nestedRoute ?? location.inheritedNestedRoute;
	const nestedSelf = nestedSelfFromLocation(location);
	if (nestedRoute) config.nestedRoute = nestedRoute;
	if (nestedSelf) config.nestedSelf = nestedSelf;
	if (input.timeoutMs !== undefined) config.timeoutMs = input.timeoutMs;
	if (input.deadlineAt !== undefined) config.deadlineAt = input.deadlineAt;
	if (work.mode === "single" && "revivalLease" in params && params.revivalLease)
		config.revivalLease = { ...params.revivalLease, asyncDir: location.asyncDir };
	if (work.mode === "single" && work.task.launchContractDigest)
		config.launchContractDigest = work.task.launchContractDigest;
	if (params.codeModeEnabled !== undefined) config.codeModeEnabled = params.codeModeEnabled;
	if (params.ponytailMode !== undefined) config.ponytailMode = params.ponytailMode;
	if (params.codeModeProviderTools?.length) config.codeModeProviderTools = [...params.codeModeProviderTools];
	if (params.artifactConfig.enabled && params.artifactsDir) config.artifactsDir = params.artifactsDir;
	if (input.sessionDir) config.sessionDir = input.sessionDir;
	if (piExecutable) config.piExecutable = piExecutable;
	if (input.capabilityCeiling) config.capabilityCeiling = input.capabilityCeiling;
	return config;
}

function emitPreparedStarted(
	input: PreparedAsyncLaunch,
	binding: SpawnedRunnerLifecycle,
	acknowledgeStart = binding.acknowledgeStart,
): void {
	if (!binding.pid || !binding.processStartIdentity) return;
	emitStarted({
		id: input.id,
		pid: binding.pid,
		processStartIdentity: binding.processStartIdentity,
		work: input.work,
		runnerCwd: input.runnerCwd,
		asyncDir: input.location.asyncDir,
		ctx: input.params.ctx,
		goal: input.params.goal,
		timeoutMs: input.timeoutMs,
		deadlineAt: input.deadlineAt,
		nestedRoute: input.params.nestedRoute ?? input.location.inheritedNestedRoute,
		nestedSelf: nestedSelfFromLocation(input.location),
		capabilityCeiling: input.capabilityCeiling,
		acknowledgeStart,
		abortStart: binding.abortStart,
	});
}

async function executePreparedAsync(input: PreparedAsyncLaunch): Promise<AsyncExecutionResult> {
	const { id, params, location, work } = input;
	const { spawnRunner } = await loadRunner().catch((error) => {
		location.cleanup();
		throw error;
	});
	const mode = work.mode;
	const subject = mode === "single" ? "Background Agent" : "Background Agents";
	const config = createAsyncRunnerConfig(input);
	const spawned = await Effect.runPromise(
		spawnRunner(
			config,
			id,
			input.runnerCwd,
			(proof) => params.ctx.pi.events.emit(SUBAGENT_PROCESS_TERMINAL_EVENT, proof),
			(status) => params.ctx.pi.events.emit(SUBAGENT_ASYNC_STATUS_EVENT, status),
		),
	);
	if (spawned.error) {
		if (spawned.safeToCleanup !== false) {
			location.cleanup();
			return formatAsyncStartError(mode, `Failed to start ${subject} '${id}': ${spawned.error}`);
		}
		location.commit();
		const lifecycleBinding = retainedRunnerLifecycleBinding(location.asyncDir, spawned);
		emitPreparedStarted(input, spawned, undefined);
		return formatAsyncStartError(
			mode,
			`Failed to start ${subject} '${id}'; lifecycle recovery is still pending: ${spawned.error}`,
			lifecycleRecoveryDetails(id, location.asyncDir, lifecycleBinding),
		);
	}
	const ownershipError = (message: string): AsyncExecutionResult => {
		const resolution = resolveBackgroundOwnershipFailure(location, spawned);
		if (!resolution.safeToRelease && resolution.lifecycleBinding)
			emitPreparedStarted(input, resolution.lifecycleBinding);
		return formatAsyncStartError(
			mode,
			resolution.safeToRelease ? `${message}.` : `${message}; lifecycle recovery is still pending.`,
			resolution.safeToRelease ? {} : lifecycleRecoveryDetails(id, location.asyncDir, resolution.lifecycleBinding),
		);
	};
	if (!spawned.pid || !spawned.processStartIdentity || !spawned.acknowledgeStart || !spawned.abortStart)
		return ownershipError(`${subject} '${id}' started without a complete lifecycle binding`);
	if (!location.commit())
		return ownershipError(
			`${subject} '${id}' could not commit ownership of ${mode === "single" ? "its" : "their"} lifecycle directory`,
		);
	emitPreparedStarted(input, spawned);
	const details: Details = {
		mode,
		runId: id,
		results: [],
		asyncId: id,
		asyncDir: location.asyncDir,
		lifecycleBinding: {
			pid: spawned.pid,
			processStartIdentity: spawned.processStartIdentity,
			asyncDir: location.asyncDir,
			acknowledgeStart: spawned.acknowledgeStart,
			abortStart: spawned.abortStart,
		},
	};
	if (input.capabilityCeiling) details.capabilityCeiling = input.capabilityCeiling;
	if (input.timeoutMs !== undefined) {
		details.timeoutMs = input.timeoutMs;
		if (input.deadlineAt !== undefined) details.deadlineAt = input.deadlineAt;
	}
	const agents = work.mode === "single" ? [work.task.agent] : work.group.tasks.map((task) => task.agent);
	if (work.mode === "single") {
		if (work.task.launchContractDigest) details.launchContractDigest = work.task.launchContractDigest;
		if ("context" in params && params.context) details.context = params.context;
		if (work.task.toolBudget) details.toolBudget = work.task.toolBudget;
	}
	return {
		content: [
			{
				type: "text",
				text: formatAsyncStartedMessage(
					`${subject}: ${agents.join(", ")} [${id}]`,
					params.ctx.interactive === true,
				),
			},
		],
		details,
	};
}

export async function executeAsyncParallel(id: string, params: AsyncParallelParams): Promise<AsyncExecutionResult> {
	const location = claimBackgroundRunDirectory(id);
	if ("error" in location) return formatAsyncStartError("parallel", location.error);
	const capabilityCeiling =
		params.capabilityCeiling ?? resolveCurrentSubagentCapabilityCeiling(params.ctx.currentSessionId);
	const deadlineAt = params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined;
	const sessionDir = params.sessionRoot ? path.join(params.sessionRoot, `async-${id}`) : undefined;
	const built = await buildAsyncParallelRunnerWork(id, {
		...params,
		capabilityCeiling,
		absoluteDeadlineAt: deadlineAt,
		sessionDir,
	}).catch((error) => {
		location.cleanup();
		throw error;
	});
	if ("error" in built) {
		location.cleanup();
		return formatAsyncStartError("parallel", built.error);
	}
	if (built.work.mode !== "parallel") {
		location.cleanup();
		throw new Error("Parallel background builder returned single work.");
	}
	const recoveryError = persistRecoveriesOrError("parallel", id, location, built.recoveries);
	if (recoveryError) return recoveryError;
	return executePreparedAsync({
		id,
		params,
		location,
		work: built.work,
		runnerCwd: built.runnerCwd,
		timeoutMs: params.timeoutMs,
		deadlineAt,
		sessionDir,
		capabilityCeiling,
	});
}

export async function executeAsyncSingle(id: string, params: AsyncSingleParams): Promise<AsyncExecutionResult> {
	const location = claimBackgroundRunDirectory(id);
	if ("error" in location) return formatAsyncStartError("single", location.error);
	const capabilityCeiling =
		params.capabilityCeiling ?? resolveCurrentSubagentCapabilityCeiling(params.ctx.currentSessionId);
	const deadlineAt =
		params.absoluteDeadlineAt ?? (params.timeoutMs !== undefined ? Date.now() + params.timeoutMs : undefined);
	const timeoutMs =
		params.absoluteDeadlineAt !== undefined && deadlineAt !== undefined ? deadlineAt - Date.now() : params.timeoutMs;
	if (timeoutMs !== undefined && timeoutMs <= 0) {
		location.cleanup();
		return formatAsyncStartError(
			"single",
			"The source run's absolute deadline expired before recovery could launch.",
		);
	}
	const sessionDir =
		params.sessionDir ?? (params.sessionRoot ? path.join(params.sessionRoot, `async-${id}`) : undefined);
	const built = await buildAsyncSingleRunnerWork(id, {
		...params,
		capabilityCeiling,
		absoluteDeadlineAt: deadlineAt,
		sessionDir,
	}).catch((error) => {
		location.cleanup();
		throw error;
	});
	if ("error" in built) {
		location.cleanup();
		return formatAsyncStartError("single", built.error);
	}
	const recoveryError = persistRecoveriesOrError("single", id, location, built.recoveries);
	if (recoveryError) return recoveryError;
	return executePreparedAsync({
		id,
		params,
		location,
		work: built.work,
		runnerCwd: built.runnerCwd,
		timeoutMs,
		deadlineAt,
		sessionDir,
		capabilityCeiling,
	});
}
