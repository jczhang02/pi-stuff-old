import { readProcessStartIdentity } from "../../shared/process-identity.ts";
import { type AsyncStatus, SUBAGENT_LIFECYCLE_ARTIFACT_VERSION } from "../../shared/types.ts";
import type { BackgroundRunnerConfig } from "../shared/parallel-utils.ts";
import { initialToolBudgetState } from "../shared/tool-budget.ts";
import { createSteeringStatus } from "./steering.ts";

export type BackgroundRunnerStatusStep = NonNullable<AsyncStatus["steps"]>[number] & {
	cwd?: string;
	exitCode?: number | null;
};

export type BackgroundRunnerStatus = AsyncStatus & {
	pid: number;
	cwd: string;
	steps: BackgroundRunnerStatusStep[];
	lastUpdate: number;
	artifactsDir?: string;
};

/**
 * Build the first durable status for a detached runner. The launcher can call
 * this with the actual child PID before it allows the child to start work.
 */
export function createInitialStatus(
	config: BackgroundRunnerConfig,
	startedAt: number,
	runnerPid = process.pid,
	processStartIdentity = readProcessStartIdentity(runnerPid),
): BackgroundRunnerStatus {
	const status: BackgroundRunnerStatus = {
		lifecycleArtifactVersion: SUBAGENT_LIFECYCLE_ARTIFACT_VERSION,
		runId: config.id,
		mode: config.work.mode,
		state: "running",
		turnCount: 0,
		toolCount: 0,
		startedAt,
		lastUpdate: startedAt,
		pid: runnerPid,
		cwd: config.cwd,
		steering: createSteeringStatus(),
		steps: (config.work.mode === "single" ? [config.work.task] : config.work.group.tasks).map((task) => {
			const step: BackgroundRunnerStatusStep = {
				agent: task.agent,
				cwd: task.cwd,
				task: task.task,
				status: "pending",
			};
			if (task.context) step.context = task.context;
			if (task.description) step.label = task.description;
			if (task.delegatedTask && task.delegatedTask !== task.task) step.delegatedTask = task.delegatedTask;
			if (task.sessionFile) step.sessionFile = task.sessionFile;
			if (task.model) step.model = task.model;
			if (task.thinking) step.thinking = task.thinking;
			if (task.skills?.length) step.skills = task.skills;
			if (task.toolBudget) step.toolBudget = initialToolBudgetState(task.toolBudget);
			if (task.launchContractDigest) step.launchContractDigest = task.launchContractDigest;
			if (task.capabilityCeiling) step.capabilityCeiling = task.capabilityCeiling;
			return step;
		}),
	};
	if (config.sessionId) status.sessionId = config.sessionId;
	if (config.parentRunOrigin) status.parentRunOrigin = config.parentRunOrigin;
	if (config.nestedRoute) status.nestedRoute = config.nestedRoute;
	if (processStartIdentity) status.processStartIdentity = processStartIdentity;
	if (config.runnerProcessInstanceId) {
		status.processTerminal = {
			version: 1,
			state: "pending",
			runId: config.id,
			runnerProcessInstanceId: config.runnerProcessInstanceId,
		};
	}
	if (config.timeoutMs !== undefined) status.timeoutMs = config.timeoutMs;
	if (config.deadlineAt !== undefined) status.deadlineAt = config.deadlineAt;
	if (config.capabilityCeiling) status.capabilityCeiling = config.capabilityCeiling;
	if (config.artifactsDir) status.artifactsDir = config.artifactsDir;
	return status;
}
