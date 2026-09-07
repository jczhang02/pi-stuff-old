/** Run one resolved Agent task, including model fallback and result artifacts. */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import { parseAgentOwnerPath } from "../../runtime/agent-runtime-event.ts";
import { type AgentWorkUnitSnapshot, SessionAgentGovernor } from "../../runtime/session-governor.ts";
import { formatOutputArtifactContent, getArtifactPaths, withArtifactGroupWriteClaim } from "../../shared/artifacts.ts";
import { writePrivateAtomicText } from "../../shared/atomic-json.ts";
import { createChildTranscriptWriter } from "../../shared/child-transcript.ts";
import { reportAgentDiagnostic } from "../../shared/diagnostics.ts";
import {
	type ArtifactPaths,
	type ModelAttempt,
	SESSION_GOVERNOR_ROOT,
	type ToolBudgetState,
} from "../../shared/types.ts";
import { detectSubagentError, findLatestSessionFile } from "../../shared/utils.ts";
import {
	formatModelAttemptNote,
	formatSubagentModelVerificationError,
	isRetryableModelFailureAttempt,
} from "../shared/model-fallback.ts";
import type { BackgroundRunnerConfig, BackgroundTaskResult, RunnerAgentTask } from "../shared/parallel-utils.ts";
import { PI_STUFF_AGENT_PATH_ENV } from "../shared/pi-args.ts";
import { terminalOutcome } from "../shared/terminal-outcome.ts";
import { toolBudgetState } from "../shared/tool-budget.ts";
import {
	ChildProcessEngine,
	type ChildProcessEngineInput,
	type ChildProcessResult,
	type ChildRuntimeControl,
	type WriterProcess,
} from "./child-process-engine.ts";
import { createSessionFallbackSnapshot } from "./fallback-session.ts";
import type {
	BackgroundRunnerStatus as RunnerStatus,
	BackgroundRunnerStatusStep as RunnerStatusStep,
} from "./initial-status.ts";
import {
	appendDiagnosticEvent,
	appendRecentOutput,
	boundResultText,
	costSummary,
	DEFAULT_MAX_TASK_RESULT_BYTES,
	emptyUsage,
	MAX_MODEL_ATTEMPT_ERROR_BYTES,
	MAX_RESULT_ERROR_BYTES,
	positiveByteLimit,
	TASK_RESULT_MAX_BYTES_ENV,
} from "./runner-output.ts";
import { applyTerminalResultToStep, stoppedResult, taskList, writeStatus } from "./runner-state.ts";
import type { WriterRuntimeState } from "./writer-process-registry.ts";

function createTranscript(config: BackgroundRunnerConfig, task: RunnerAgentTask, index: number, count: number) {
	let artifactPaths: ArtifactPaths | undefined;
	let transcriptPath = path.join(
		config.asyncDir,
		"transcripts",
		`${index}-${task.agent.replace(/[^\w.-]/g, "_")}.jsonl`,
	);
	if (config.artifactsDir && config.artifactConfig?.enabled !== false) {
		try {
			fs.mkdirSync(config.artifactsDir, { recursive: true });
			artifactPaths = getArtifactPaths(config.artifactsDir, config.id, task.agent, count > 1 ? index : undefined);
			if (config.artifactConfig?.includeTranscript !== false) transcriptPath = artifactPaths.transcriptPath;
		} catch (error) {
			reportAgentDiagnostic(`Failed to initialize optional Agent artifacts for '${config.id}:${index}':`, error);
		}
	}
	return {
		writer: createChildTranscriptWriter({
			transcriptPath,
			source: "async",
			runId: config.id,
			agent: task.agent,
			childIndex: index,
			cwd: task.cwd,
			artifactManaged: transcriptPath === artifactPaths?.transcriptPath,
		}),
		path: transcriptPath,
		artifactPaths,
	};
}

function writeOptionalArtifact(filePath: string, content: string): string | undefined {
	try {
		fs.mkdirSync(path.dirname(filePath), { recursive: true });
		withArtifactGroupWriteClaim(filePath, () => writePrivateAtomicText(filePath, content));
		return undefined;
	} catch (error) {
		return `Failed to write optional Agent artifact '${filePath}': ${
			error instanceof Error ? error.message : String(error)
		}`;
	}
}

interface ResolvedTaskInput {
	config: BackgroundRunnerConfig;
	task: RunnerAgentTask;
	index: number;
	taskCwd: string;
	status: RunnerStatus;
	statusPath: string;
	eventsPath: string;
	activeControls: Map<number, ChildRuntimeControl>;
	consumeScheduledStop: (index: number) => boolean;
	preStartTerminalCause?: () => "pause" | "timeout" | "stop" | undefined;
	onWriterProcess?: ((writer: WriterRuntimeState) => void) | undefined;
}

type TaskTranscript = ReturnType<typeof createTranscript>;

interface AttemptSummary {
	attempts: ModelAttempt[];
	attemptedModels: string[];
	writerProcesses: WriterProcess[];
	final: ChildProcessResult | undefined;
	workUnit?: AgentWorkUnitSnapshot;
}

function stoppedChildResult(
	task: RunnerAgentTask,
	cause: NonNullable<BackgroundTaskResult["preStartTerminalCause"]>,
	runId: string,
	index: number,
): ChildProcessResult {
	return {
		...stoppedResult(task, cause, runId, index),
		signal: null,
		stderr: "",
		messages: [],
		usage: emptyUsage(),
		toolCount: 0,
		durationMs: 0,
	};
}

function workUsageGovernor(task: RunnerAgentTask): SessionAgentGovernor | undefined {
	if (!task.governorSessionId || !task.logicalAgentPathComponent) return undefined;
	return new SessionAgentGovernor({
		rootDir: SESSION_GOVERNOR_ROOT,
		sessionId: task.governorSessionId,
		ownerAgentPath: parseAgentOwnerPath(process.env[PI_STUFF_AGENT_PATH_ENV]),
	});
}

async function recordSettledAttempt(
	governor: SessionAgentGovernor | undefined,
	task: RunnerAgentTask,
	run: ChildProcessResult,
): Promise<AgentWorkUnitSnapshot | undefined> {
	const logicalAgentId = task.logicalAgentPathComponent;
	if (!governor || !logicalAgentId) return;
	const settled = {
		logicalAgentId,
		turns: run.usage.turns,
		toolCalls: run.toolCount,
		inputTokens: run.usage.input,
		outputTokens: run.usage.output,
	};
	const request: Parameters<SessionAgentGovernor["recordWorkAttempt"]>[0] = run.costReported
		? { ...settled, reportedCostUsd: run.usage.cost }
		: settled;
	return governor.recordWorkAttempt(request);
}

function writeStartingArtifacts(input: ResolvedTaskInput, transcript: TaskTranscript, startedAt: number): void {
	const { config, task, index } = input;
	if (transcript.artifactPaths && config.artifactConfig?.includeInput !== false) {
		const error = writeOptionalArtifact(
			transcript.artifactPaths.inputPath,
			`# Task for ${task.agent}\n\n${task.task}`,
		);
		if (error) reportAgentDiagnostic(error);
	}
	if (!transcript.artifactPaths || config.artifactConfig?.includeMetadata === false) return;
	const error = writeOptionalArtifact(
		transcript.artifactPaths.metadataPath,
		JSON.stringify(
			{
				state: "running",
				runId: config.id,
				index,
				agent: task.agent,
				cwd: input.taskCwd,
				startedAt,
				transcriptPath: transcript.path,
			},
			null,
			2,
		),
	);
	if (error) reportAgentDiagnostic(error);
}

function startTask(input: ResolvedTaskInput, statusStep: RunnerStatusStep) {
	const { config, task, index, status, statusPath } = input;
	const startedAt = Date.now();
	statusStep.status = "running";
	statusStep.startedAt = startedAt;
	statusStep.lastActivityAt = startedAt;
	writeStatus(statusPath, status);
	appendDiagnosticEvent(input.eventsPath, {
		type: "subagent.child.started",
		ts: startedAt,
		runId: config.id,
		index,
		agent: task.agent,
	});
	const transcript = createTranscript(config, task, index, taskList(config.work).length);
	transcript.writer.writeInitialUserMessage(task.task);
	writeStartingArtifacts(input, transcript, startedAt);
	statusStep.transcriptPath = transcript.path;
	const childSessionDir = task.sessionFile
		? undefined
		: config.sessionDir
			? path.join(config.sessionDir, String(index))
			: undefined;
	return {
		transcript,
		childSessionDir,
		outputFile: path.join(config.asyncDir, `output-${index}.log`),
	};
}

function clearStaleContextUsage(input: ResolvedTaskInput, statusStep: RunnerStatusStep): void {
	if (statusStep.contextUsage === undefined) return;
	statusStep.contextUsage = undefined;
	try {
		writeStatus(input.statusPath, input.status);
	} catch (error) {
		reportAgentDiagnostic(`Failed to clear stale Agent context usage for child ${String(input.index)}:`, error);
	}
}

function failedLaunch(message: string, model: string | undefined) {
	return {
		attempt: {
			model: model ?? "default",
			success: false,
			exitCode: 1,
			error: boundResultText(message, MAX_MODEL_ATTEMPT_ERROR_BYTES),
			usage: emptyUsage(),
		} satisfies ModelAttempt,
		final: {
			exitCode: 1,
			signal: null,
			stderr: "",
			messages: [],
			output: "",
			error: message,
			usage: emptyUsage(),
			costReported: false,
			toolCount: 0,
			durationMs: 0,
			model,
		} satisfies ChildProcessResult,
	};
}

function classifyRun(run: ChildProcessResult, model: string | undefined, task: RunnerAgentTask) {
	const modelVerificationError =
		model && run.model
			? formatSubagentModelVerificationError(model, run.model, task.modelVerificationRegistry)
			: undefined;
	const detected =
		!run.error && !modelVerificationError
			? detectSubagentError(run.messages.filter((message): message is Message => message.role !== "custom"))
			: undefined;
	const emptyOutput = !run.error && run.exitCode === 0 && !run.output.trim() ? "Agent produced no output." : undefined;
	const expectedManagerSignal =
		run.process?.terminationOrigin === "manager-final-drain" ||
		run.process?.terminationOrigin === "manager-request" ||
		run.interrupted ||
		run.timedOut ||
		run.stopped;
	const unexplainedExit = !run.error
		? run.signal && !expectedManagerSignal
			? `Agent process terminated by ${run.signal} without a diagnostic.`
			: run.exitCode === null
				? "Agent process ended without an exit code or diagnostic."
				: run.exitCode !== 0
					? `Agent process exited with code ${String(run.exitCode)} without a diagnostic.`
					: undefined
		: undefined;
	const error =
		modelVerificationError ??
		run.error ??
		(detected?.hasError ? (detected.details ?? detected.errorType) : undefined) ??
		emptyOutput ??
		unexplainedExit;
	const exitCode = error && run.exitCode === 0 ? 1 : run.exitCode;
	const attempt: ModelAttempt = {
		model: model ?? run.model ?? "default",
		success: exitCode === 0 && !error,
		exitCode,
		error: error ? boundResultText(error, MAX_MODEL_ATTEMPT_ERROR_BYTES) : undefined,
		usage: run.usage,
	};
	if (run.costReported) attempt.costReported = true;
	return {
		attempt,
		final: { ...run, exitCode, error },
		error,
	};
}

function shouldStopFallback(
	run: ChildProcessResult,
	attempt: ModelAttempt,
	error: string | undefined,
	candidateIndex: number,
	candidateCount: number,
): boolean {
	return Boolean(
		attempt.success ||
			run.interrupted ||
			run.timedOut ||
			run.stopped ||
			!isRetryableModelFailureAttempt({ error, messages: run.messages, toolCount: run.toolCount }) ||
			candidateIndex === candidateCount - 1,
	);
}

async function runAttempts(
	input: ResolvedTaskInput,
	statusStep: RunnerStatusStep,
	transcript: TaskTranscript,
	childSessionDir: string | undefined,
	outputFile: string,
): Promise<AttemptSummary> {
	const candidates = input.task.modelCandidates?.length ? input.task.modelCandidates : [input.task.model];
	const summary: AttemptSummary = { attempts: [], attemptedModels: [], writerProcesses: [], final: undefined };
	const fallbackSnapshot = createSessionFallbackSnapshot(input.task.sessionFile, candidates.length);
	const usageGovernor = workUsageGovernor(input.task);
	try {
		for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
			const candidate = candidates[candidateIndex];
			const terminalCause = input.preStartTerminalCause?.();
			if (terminalCause) {
				summary.final = stoppedChildResult(input.task, terminalCause, input.config.id, input.index);
				break;
			}
			clearStaleContextUsage(input, statusStep);
			let run: ChildProcessResult;
			try {
				const engineInput: ChildProcessEngineInput = {
					config: input.config,
					task: input.task,
					index: input.index,
					model: candidate,
					taskCwd: input.taskCwd,
					sessionDir: childSessionDir,
					outputFile,
					transcript: transcript.writer,
					artifactJsonlPath:
						transcript.artifactPaths && input.config.artifactConfig?.includeJsonl !== false
							? transcript.artifactPaths.jsonlPath
							: undefined,
					statusStep,
					statusPath: input.statusPath,
					status: input.status,
					activeControls: input.activeControls,
					consumeScheduledStop: () => input.consumeScheduledStop(input.index),
					onWriterProcess: input.onWriterProcess,
				};
				if (input.preStartTerminalCause) engineInput.preStartTerminalCause = input.preStartTerminalCause;
				run = await Effect.runPromise(new ChildProcessEngine(engineInput).run());
			} catch (error) {
				const failed = failedLaunch(error instanceof Error ? error.message : String(error), candidate);
				summary.attempts.push(failed.attempt);
				if (candidate) summary.attemptedModels.push(candidate);
				summary.final = failed.final;
				const workUnit = await recordSettledAttempt(usageGovernor, input.task, failed.final);
				if (workUnit) summary.workUnit = workUnit;
				break;
			}
			if (run.process) summary.writerProcesses.push({ ...run.process, attempt: candidateIndex });
			const classified = classifyRun(run, candidate, input.task);
			summary.attempts.push(classified.attempt);
			if (candidate) summary.attemptedModels.push(candidate);
			summary.final = classified.final;
			try {
				const workUnit = await recordSettledAttempt(usageGovernor, input.task, classified.final);
				if (workUnit) summary.workUnit = workUnit;
			} catch (error) {
				summary.final = {
					...classified.final,
					exitCode: 1,
					error: error instanceof Error ? error.message : String(error),
				};
				break;
			}
			if (shouldStopFallback(run, classified.attempt, classified.error, candidateIndex, candidates.length)) break;
			if (usageGovernor && input.task.logicalAgentPathComponent) {
				const expansion = await usageGovernor.authorizeWorkExpansion(input.task.logicalAgentPathComponent);
				if (!expansion.allowed) {
					summary.final = { ...classified.final, exitCode: 1, error: expansion.message };
					break;
				}
			}
			try {
				fallbackSnapshot?.restore();
			} catch (restoreError) {
				const message = `Agent model fallback stopped because the frozen fork session could not be restored: ${
					restoreError instanceof Error ? restoreError.message : String(restoreError)
				}`;
				summary.final = { ...run, exitCode: 1, error: message };
				break;
			}
			appendRecentOutput(statusStep, formatModelAttemptNote(classified.attempt, candidates[candidateIndex + 1]));
			try {
				writeStatus(input.statusPath, input.status);
			} catch (error) {
				reportAgentDiagnostic(`Failed to persist Agent fallback status for child ${String(input.index)}:`, error);
			}
		}
	} finally {
		fallbackSnapshot?.dispose();
	}
	return summary;
}

function createTaskResult(
	input: ResolvedTaskInput,
	transcript: TaskTranscript,
	childSessionDir: string | undefined,
	summary: AttemptSummary,
) {
	const { config, task, index } = input;
	const final = summary.final;
	const resultError = final?.error ? boundResultText(final.error, MAX_RESULT_ERROR_BYTES) : undefined;
	const fullOutput = final?.output || resultError || "(no output)";
	const result: BackgroundTaskResult = {
		agent: task.agent,
		output: boundResultText(fullOutput, positiveByteLimit(TASK_RESULT_MAX_BYTES_ENV, DEFAULT_MAX_TASK_RESULT_BYTES)),
		success: final?.exitCode === 0 && !final.error,
		exitCode: final?.exitCode ?? 1,
		modelAttempts: summary.attempts,
		transcriptPath: transcript.path,
		writerProcesses: summary.writerProcesses,
		writerAttemptCount: summary.writerProcesses.length,
	};
	if (task.context) result.context = task.context;
	if (resultError) result.error = resultError;
	if (final?.protocolError) result.protocolError = final.protocolError;
	if (final?.interrupted) result.interrupted = true;
	if (final?.timedOut) result.timedOut = true;
	if (final?.stopped) result.stopped = true;
	if (final?.contextNudgeObserved) result.contextNudgeObserved = true;
	const toolBudget: ToolBudgetState | undefined = task.toolBudget
		? toolBudgetState(task.toolBudget, final?.toolCount ?? 0, final?.toolBudgetBlockedTool)
		: undefined;
	if (toolBudget) {
		result.toolBudget = toolBudget;
		if (toolBudget.outcome === "hard-blocked") result.toolBudgetBlocked = true;
	}
	const sessionFile = task.sessionFile ?? findLatestSessionFile(childSessionDir);
	if (sessionFile) result.sessionFile = sessionFile;
	const intercomTarget = config.childIntercomTargets?.[index];
	if (intercomTarget) result.intercomTarget = intercomTarget;
	const model = final?.model ?? task.model;
	if (model) result.model = model;
	if (final?.contextUsage) result.contextUsage = final.contextUsage;
	if (task.thinking) result.thinking = task.thinking;
	if (summary.attemptedModels.length > 0) result.attemptedModels = summary.attemptedModels;
	const totalCost = costSummary(summary.attempts);
	if (totalCost) result.totalCost = totalCost;
	if (transcript.artifactPaths) result.artifactPaths = transcript.artifactPaths;
	const transcriptError = transcript.writer.getError();
	if (transcriptError) result.transcriptError = transcriptError;
	if (task.launchContractDigest) result.launchContractDigest = task.launchContractDigest;
	if (task.capabilityCeiling) result.capabilityCeiling = task.capabilityCeiling;
	if (summary.workUnit) result.cumulativeUsage = { ...summary.workUnit.usage };
	const outcomeInput: Parameters<typeof terminalOutcome>[0] = {
		runId: config.id,
		index,
		success: result.success,
	};
	if (result.error) outcomeInput.error = result.error;
	if (result.sessionFile) outcomeInput.sessionFile = result.sessionFile;
	if (result.interrupted) outcomeInput.interrupted = true;
	if (result.timedOut) outcomeInput.timedOut = true;
	if (result.stopped) outcomeInput.stopped = true;
	if (result.protocolError) outcomeInput.protocolError = result.protocolError;
	if (result.turnBudgetExceeded) outcomeInput.turnBudgetExceeded = true;
	if (summary.workUnit) outcomeInput.workUnit = summary.workUnit;
	result.terminalOutcome = terminalOutcome(outcomeInput);
	return { result, fullOutput };
}

function writeTerminalArtifacts(
	input: ResolvedTaskInput,
	transcript: TaskTranscript,
	result: BackgroundTaskResult,
	fullOutput: string,
	endedAt: number,
): void {
	const { config, task, index } = input;
	if (transcript.artifactPaths && config.artifactConfig?.includeOutput !== false) {
		const content: Parameters<typeof formatOutputArtifactContent>[0] = {
			output: fullOutput,
			transcriptPath: transcript.path,
		};
		if (result.error) content.error = result.error;
		if (config.artifactConfig?.includeMetadata !== false)
			content.metadataPath = transcript.artifactPaths.metadataPath;
		const error = writeOptionalArtifact(transcript.artifactPaths.outputPath, formatOutputArtifactContent(content));
		if (error) {
			reportAgentDiagnostic(error);
			delete result.artifactPaths;
		}
	}
	if (!transcript.artifactPaths || config.artifactConfig?.includeMetadata === false) return;
	const error = writeOptionalArtifact(
		transcript.artifactPaths.metadataPath,
		JSON.stringify(
			{
				state:
					result.interrupted || result.timedOut || result.stopped
						? "stopped"
						: result.success
							? "complete"
							: "failed",
				runId: config.id,
				index,
				agent: task.agent,
				cwd: input.taskCwd,
				model: result.model,
				thinking: result.thinking,
				skills: task.skills,
				toolBudget: result.toolBudget,
				exitCode: result.exitCode,
				error: result.error,
				transcriptPath: transcript.path,
				timestamp: endedAt,
			},
			null,
			2,
		),
	);
	if (error) {
		reportAgentDiagnostic(error);
		delete result.artifactPaths;
	}
}

function persistTaskCompletion(
	input: ResolvedTaskInput,
	statusStep: RunnerStatusStep,
	result: BackgroundTaskResult,
	endedAt: number,
): void {
	applyTerminalResultToStep(statusStep, result, endedAt);
	try {
		writeStatus(input.statusPath, input.status);
		appendDiagnosticEvent(input.eventsPath, {
			type: "subagent.child.completed",
			ts: endedAt,
			runId: input.config.id,
			index: input.index,
			agent: input.task.agent,
			success: result.success,
		});
	} catch (error) {
		reportAgentDiagnostic(`Failed to persist terminal Agent step ${String(input.index)}:`, error);
	}
}

export async function runResolvedTask(input: ResolvedTaskInput): Promise<BackgroundTaskResult> {
	const statusStep = input.status.steps[input.index];
	if (!statusStep) throw new Error(`Missing status step for Agent index ${input.index}.`);
	if (input.consumeScheduledStop(input.index)) {
		return stoppedResult(input.task, "stop", input.config.id, input.index);
	}
	const started = startTask(input, statusStep);
	const summary = await runAttempts(
		input,
		statusStep,
		started.transcript,
		started.childSessionDir,
		started.outputFile,
	);
	const endedAt = Date.now();
	const built = createTaskResult(input, started.transcript, started.childSessionDir, summary);
	writeTerminalArtifacts(input, started.transcript, built.result, built.fullOutput, endedAt);
	persistTaskCompletion(input, statusStep, built.result, endedAt);
	return built.result;
}
