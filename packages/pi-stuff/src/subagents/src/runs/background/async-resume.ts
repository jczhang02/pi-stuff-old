import * as fs from "node:fs";
import * as path from "node:path";
import { parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";
import type { AgentConfig } from "../../agents/agents.ts";
import { readBoundedOwnedFile, validateOwnedRegularFile } from "../../shared/private-directory.ts";
import { type SessionCompatibilityScope, sessionArtifactMatches } from "../../shared/session-identity.ts";
import { ASYNC_DIR, type AsyncStatus, RESULTS_DIR } from "../../shared/types.ts";
import { getErrorMessage, isNotFoundError, readStatus } from "../../shared/utils.ts";
import {
	intersectSubagentCapabilityCeilings,
	parseSubagentCapabilityCeiling,
	type ResolvedSubagentCapabilityCeiling,
} from "../shared/capability-ceiling.ts";
import type { ContextMode } from "../shared/context-mode.ts";
import { type AsyncRecoveryDescriptor, readAsyncRecoveryDescriptor } from "./recovery-descriptor.ts";
import { type AsyncResultFile, MAX_ASYNC_RESULT_BYTES, parseAsyncResultFile } from "./result-file.ts";
import { reconcileAsyncRun } from "./stale-run-reconciler.ts";

export {
	type AsyncRecoveryDescriptor,
	type LegacyRecoveryDescriptor,
	readAsyncRecoveryDescriptor,
} from "./recovery-descriptor.ts";

export interface AsyncResumeParams {
	id?: string;
	runId?: string;
	dir?: string;
	index?: number;
}

export interface AsyncResumeDeps {
	asyncDirRoot?: string;
	resultsDir?: string;
	kill?: ((pid: number, signal?: NodeJS.Signals | 0) => boolean) | undefined;
	now?: () => number;
}

export interface AsyncResumeOptions {
	requireSessionFile?: boolean;
	sessionId?: string;
	sessionScope?: SessionCompatibilityScope;
}

export type AsyncResumeTarget = {
	kind: "live" | "revive";
	runId: string;
	asyncDir?: string | undefined;
	state: AsyncStatus["state"];
	agent: string;
	index: number;
	cwd?: string | undefined;
	sessionFile?: string | undefined;
	model?: string | undefined;
	thinking?: string | undefined;
	context?: ContextMode | undefined;
	recoveryDescriptor?: AsyncRecoveryDescriptor | undefined;
	capabilityCeiling?: ResolvedSubagentCapabilityCeiling | undefined;
	launchContractDigest?: string | undefined;
};

export interface AsyncRunLocation {
	asyncDir: string | null;
	resultPath: string | null;
	resolvedId?: string;
}

function readResultFile(resultPath: string): AsyncResultFile {
	let raw: string;
	try {
		raw = readBoundedOwnedFile(resultPath, MAX_ASYNC_RESULT_BYTES);
	} catch (error) {
		throw new Error(`Failed to read async result file '${resultPath}': ${getErrorMessage(error)}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
	try {
		return parseAsyncResultFile(parseJsonValue(raw), resultPath);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new Error(`Failed to parse async result file '${resultPath}': ${getErrorMessage(error)}`, {
				cause: error,
			});
		}
		throw error;
	}
}

function assertRunId(value: string | undefined, field: "id" | "runId"): string | undefined {
	if (value === undefined) return undefined;
	if (value.trim() === "") throw new Error(`${field} must not be empty.`);
	if (path.isAbsolute(value) || /[\\/]/.test(value) || value.includes("..")) {
		throw new Error(`${field} must be an async run id or prefix, not a path.`);
	}
	return value;
}

function assertInsideRoot(root: string, target: string, label: string): void {
	const rootPath = path.resolve(root);
	const targetPath = path.resolve(target);
	const relative = path.relative(rootPath, targetPath);
	if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return;
	throw new Error(`${label} must be inside ${rootPath}.`);
}

function isSafeDirectEntry(root: string, target: string, kind: "directory" | "file"): boolean {
	assertInsideRoot(root, target, kind === "directory" ? "Async run directory" : "Async result file");
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(target);
	} catch (error) {
		if (isNotFoundError(error)) return false;
		throw error;
	}
	if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) return false;
	const canonicalRoot = fs.realpathSync(root);
	const canonicalTarget = fs.realpathSync(target);
	return path.dirname(canonicalTarget) === canonicalRoot;
}

function prefixedRunIds(dir: string, prefix: string, suffix = ""): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir)
		.filter(
			(entry) =>
				entry.startsWith(prefix) &&
				(!suffix || entry.endsWith(suffix)) &&
				isSafeDirectEntry(dir, path.join(dir, entry), suffix ? "file" : "directory"),
		)
		.map((entry) => (suffix ? entry.slice(0, -suffix.length) : entry))
		.sort();
}

function exactResultPath(resultsDir: string, runId: string): string | null {
	const resultPath = path.join(resultsDir, `${runId}.json`);
	assertInsideRoot(resultsDir, resultPath, "Async result file");
	return isSafeDirectEntry(resultsDir, resultPath, "file") ? resultPath : null;
}

export function findAsyncRunPrefixMatches(
	prefix: string,
	asyncDirRoot: string,
	resultsDir: string,
	session?: string | SessionCompatibilityScope,
): Array<{ id: string; location: AsyncRunLocation }> {
	const requestedId = assertRunId(prefix, "id");
	if (!requestedId) return [];
	const asyncRoot = path.resolve(asyncDirRoot);
	const resultRoot = path.resolve(resultsDir);
	const matchingIds = [
		...new Set([...prefixedRunIds(asyncRoot, requestedId), ...prefixedRunIds(resultRoot, requestedId, ".json")]),
	].sort();
	return matchingIds.flatMap((id) => {
		const asyncDir = path.join(asyncRoot, id);
		assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
		const location = {
			asyncDir: isSafeDirectEntry(asyncRoot, asyncDir, "directory") ? asyncDir : null,
			resultPath: exactResultPath(resultRoot, id),
			resolvedId: id,
		};
		if (session !== undefined) {
			let storedSessionId: string | undefined;
			try {
				storedSessionId = location.asyncDir ? readStatus(location.asyncDir)?.sessionId : undefined;
			} catch {
				// A malformed candidate outside the active session cannot make a valid
				// current-session prefix ambiguous.
			}
			if (storedSessionId === undefined && location.resultPath) {
				try {
					storedSessionId = readResultFile(location.resultPath).sessionId;
				} catch {
					// Conservatively exclude unreadable or unowned candidates.
				}
			}
			if (
				isRuntimeString(session)
					? storedSessionId !== session
					: !sessionArtifactMatches(session, storedSessionId, id)
			)
				return [];
		}
		return [
			{
				id,
				location,
			},
		];
	});
}

export function resolveAsyncRunLocation(
	params: AsyncResumeParams,
	asyncDirRoot: string,
	resultsDir: string,
): AsyncRunLocation {
	const asyncRoot = path.resolve(asyncDirRoot);
	const resultRoot = path.resolve(resultsDir);
	const requestedId = assertRunId(params.id, "id") ?? assertRunId(params.runId, "runId");
	if (params.dir) {
		const asyncDir = path.resolve(params.dir);
		assertInsideRoot(asyncRoot, asyncDir, "Async run directory");
		if (!isSafeDirectEntry(asyncRoot, asyncDir, "directory")) {
			throw new Error(`Async run directory '${asyncDir}' is not a safe direct child of ${asyncRoot}.`);
		}
		const resolvedId = requestedId ?? path.basename(asyncDir);
		if (requestedId && requestedId !== path.basename(asyncDir)) {
			throw new Error(`Async run id '${requestedId}' does not match directory '${path.basename(asyncDir)}'.`);
		}
		return { asyncDir, resultPath: exactResultPath(resultRoot, resolvedId), resolvedId };
	}
	if (!requestedId) return { asyncDir: null, resultPath: null };

	const directAsyncDir = path.join(asyncRoot, requestedId);
	assertInsideRoot(asyncRoot, directAsyncDir, "Async run directory");
	const directResultPath = exactResultPath(resultRoot, requestedId);
	const directAsyncExists = isSafeDirectEntry(asyncRoot, directAsyncDir, "directory");
	if (directAsyncExists || directResultPath) {
		return {
			asyncDir: directAsyncExists ? directAsyncDir : null,
			resultPath: directResultPath,
			resolvedId: requestedId,
		};
	}

	const matching = findAsyncRunPrefixMatches(requestedId, asyncRoot, resultRoot);
	if (matching.length === 0) return { asyncDir: null, resultPath: null, resolvedId: requestedId };
	if (matching.length > 1) {
		throw new Error(
			`Ambiguous async run id prefix '${requestedId}' matched: ${matching.map((match) => match.id).join(", ")}. Provide a longer id.`,
		);
	}
	const match = matching[0];
	if (!match) return { asyncDir: null, resultPath: null, resolvedId: requestedId };
	return match.location;
}

function resultState(result: AsyncResultFile): AsyncStatus["state"] {
	if (
		result.state === "complete" ||
		result.state === "failed" ||
		result.state === "paused" ||
		result.state === "stopped" ||
		result.state === "running" ||
		result.state === "queued"
	) {
		return result.state;
	}
	return result.success ? "complete" : "failed";
}

function validateStatusForResume(status: AsyncStatus | null, source: string): void {
	if (!status) return;
	if (!isRuntimeString(status.runId)) throw new Error(`Invalid async status '${source}': runId must be a string.`);
	if (status.sessionId !== undefined && !isRuntimeString(status.sessionId))
		throw new Error(`Invalid async status '${source}': sessionId must be a string.`);
	if (status.cwd !== undefined && !isRuntimeString(status.cwd))
		throw new Error(`Invalid async status '${source}': cwd must be a string.`);
	if (status.sessionFile !== undefined && !isRuntimeString(status.sessionFile))
		throw new Error(`Invalid async status '${source}': sessionFile must be a string.`);
	if (status.capabilityCeiling !== undefined)
		status.capabilityCeiling = parseSubagentCapabilityCeiling(
			status.capabilityCeiling,
			`async status '${source}' capabilityCeiling`,
		);
	if (status.steps !== undefined) {
		if (!Array.isArray(status.steps)) throw new Error(`Invalid async status '${source}': steps must be an array.`);
		status.steps.forEach((step, index) => {
			if (!step || !isRuntimeObject(step) || Array.isArray(step))
				throw new Error(`Invalid async status '${source}': steps[${index}] must be an object.`);
			const stepRecord = step;
			if (!isRuntimeString(stepRecord.agent))
				throw new Error(`Invalid async status '${source}': steps[${index}].agent must be a string.`);
			if (stepRecord.sessionFile !== undefined && !isRuntimeString(stepRecord.sessionFile))
				throw new Error(`Invalid async status '${source}': steps[${index}].sessionFile must be a string.`);
			if (stepRecord.model !== undefined && !isRuntimeString(stepRecord.model))
				throw new Error(`Invalid async status '${source}': steps[${index}].model must be a string.`);
			if (stepRecord.thinking !== undefined && !isRuntimeString(stepRecord.thinking))
				throw new Error(`Invalid async status '${source}': steps[${index}].thinking must be a string.`);
			if (stepRecord.launchContractDigest !== undefined && !isRuntimeString(stepRecord.launchContractDigest))
				throw new Error(`Invalid async status '${source}': steps[${index}].launchContractDigest must be a string.`);
			if (stepRecord.capabilityCeiling !== undefined)
				stepRecord.capabilityCeiling = parseSubagentCapabilityCeiling(
					stepRecord.capabilityCeiling,
					`async status '${source}' steps[${index}].capabilityCeiling`,
				);
		});
	}
}

function validateResumeSessionFile(runId: string, sessionFile: string): string {
	if (path.extname(sessionFile) !== ".jsonl")
		throw new Error(`Async run '${runId}' session file must be a .jsonl file: ${sessionFile}`);
	try {
		return validateOwnedRegularFile(sessionFile);
	} catch (error) {
		if (isNotFoundError(error)) {
			throw new Error(`Async run '${runId}' session file does not exist: ${sessionFile}`, { cause: error });
		}
		throw new Error(`Async run '${runId}' session file is not a safe regular file: ${sessionFile}`, {
			cause: error instanceof Error ? error : undefined,
		});
	}
}

function readResumeRecords(params: AsyncResumeParams, deps: AsyncResumeDeps, options: AsyncResumeOptions) {
	const asyncDirRoot = deps.asyncDirRoot ?? ASYNC_DIR;
	const resultsDir = deps.resultsDir ?? RESULTS_DIR;
	const location = resolveAsyncRunLocation(params, asyncDirRoot, resultsDir);
	if (!location.asyncDir && !location.resultPath) {
		throw new Error("Async run not found. Provide id or dir.");
	}

	// Establish immutable session ownership from safe, read-only records before
	// stale reconciliation is allowed to signal a process or rewrite status.
	const storedStatus = location.asyncDir ? readStatus(location.asyncDir) : null;
	const result = location.resultPath ? readResultFile(location.resultPath) : undefined;
	const expectedRunId =
		location.resolvedId ??
		(location.asyncDir
			? path.basename(location.asyncDir)
			: location.resultPath
				? path.basename(location.resultPath, ".json")
				: undefined);
	if (!expectedRunId) throw new Error("Async run identity could not be established from its storage location.");
	for (const [field, value] of [
		["status.runId", storedStatus?.runId],
		["result.runId", result?.runId],
		["result.id", result?.id],
	] as const) {
		if (value !== undefined && value !== expectedRunId) {
			throw new Error(`Async run '${expectedRunId}' has mismatched ${field} '${value}'.`);
		}
	}
	const storedRunId = storedStatus?.runId ?? result?.runId ?? result?.id ?? expectedRunId;
	const recordMatchesSession = (sessionId: string | undefined): boolean =>
		options.sessionScope
			? sessionArtifactMatches(options.sessionScope, sessionId, storedRunId)
			: !options.sessionId || sessionId === options.sessionId;
	if (
		(options.sessionId || options.sessionScope) &&
		((storedStatus && !recordMatchesSession(storedStatus.sessionId)) ||
			(result && !recordMatchesSession(result.sessionId)) ||
			(!storedStatus && !result))
	) {
		throw new Error(`Async run '${storedRunId}' was not found in the active session.`);
	}
	const reconciliation = location.asyncDir
		? reconcileAsyncRun(location.asyncDir, { resultsDir, kill: deps.kill, now: deps.now })
		: undefined;
	const status = reconciliation?.status ?? storedStatus;
	validateStatusForResume(status, location.asyncDir ? path.join(location.asyncDir, "status.json") : "status.json");
	const recoveryDescriptor = readAsyncRecoveryDescriptor(location.asyncDir ?? undefined, params.index);
	const runId = status?.runId ?? storedRunId;
	if (recoveryDescriptor && recoveryDescriptor.sourceRunId !== runId)
		throw new Error(`Async run '${runId}' has a recovery descriptor for a different source run.`);
	const state = status?.state ?? (result ? resultState(result) : undefined);
	if (!state) throw new Error(`Status file not found for async run '${runId}'.`);

	const statusSteps = status?.steps ?? [];
	const resultSteps = result?.results ?? [];
	const stepCount = statusSteps.length || resultSteps.length || (result?.agent ? 1 : 0);
	return { location, status, result, recoveryDescriptor, runId, state, statusSteps, resultSteps, stepCount };
}

type ResumeRecords = ReturnType<typeof readResumeRecords>;

function liveResumeTarget(records: ResumeRecords, requestedIndex: number | undefined): AsyncResumeTarget | undefined {
	const { location, status, result, recoveryDescriptor, runId, state, statusSteps, stepCount } = records;
	const liveTarget = (step: (typeof statusSteps)[number], index: number): AsyncResumeTarget => {
		const target: AsyncResumeTarget = {
			kind: "live",
			runId,
			asyncDir: location.asyncDir ?? undefined,
			state,
			agent: step.agent,
			index,
			cwd: recoveryDescriptor?.cwd ?? status?.cwd ?? result?.cwd,
			sessionFile: step.sessionFile ?? status?.sessionFile ?? result?.sessionFile,
			model: step.model,
			thinking: step.thinking,
			launchContractDigest:
				step.launchContractDigest ??
				result?.results?.[index]?.launchContractDigest ??
				result?.launchContractDigest ??
				recoveryDescriptor?.launchContractDigest,
		};
		if (recoveryDescriptor?.version === 2 && recoveryDescriptor.context) {
			target.context = recoveryDescriptor.context;
		}
		const ceiling = intersectSubagentCapabilityCeilings(status?.capabilityCeiling, step.capabilityCeiling);
		if (ceiling) target.capabilityCeiling = ceiling;
		if (recoveryDescriptor) target.recoveryDescriptor = recoveryDescriptor;
		return target;
	};

	if (requestedIndex !== undefined) {
		if (requestedIndex < 0 || requestedIndex >= stepCount)
			throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${requestedIndex} is out of range.`);
		const selectedStep = statusSteps[requestedIndex];
		if (selectedStep?.status === "running") return liveTarget(selectedStep, requestedIndex);
		if (selectedStep?.status === "pending")
			throw new Error(
				`Async run '${runId}' child ${requestedIndex} is pending and has not started yet. Wait for it to run or complete before resuming.`,
			);
		if (selectedStep && !new Set(["complete", "completed", "failed", "paused"]).has(selectedStep.status))
			throw new Error(
				`Async run '${runId}' child ${requestedIndex} is ${selectedStep.status} and cannot be revived yet.`,
			);
		return undefined;
	}
	const running = statusSteps.map((step, index) => ({ step, index })).filter(({ step }) => step.status === "running");
	const selected = running.length === 1 ? running[0] : undefined;
	if (!selected)
		throw new Error(`Async run '${runId}' has ${running.length} running children. Provide index to choose one.`);
	return liveTarget(selected.step, selected.index);
}

function revivedResumeTarget(
	records: ResumeRecords,
	requestedIndex: number | undefined,
	requireSessionFile: boolean,
): AsyncResumeTarget {
	const { location, status, result, recoveryDescriptor, runId, state, statusSteps, resultSteps, stepCount } = records;
	if (stepCount > 1 && requestedIndex === undefined) {
		throw new Error(`Async run '${runId}' has ${stepCount} children. Provide index to choose one.`);
	}
	const index = requestedIndex ?? 0;
	if (index < 0 || index >= stepCount)
		throw new Error(`Async run '${runId}' has ${stepCount} children. Index ${index} is out of range.`);
	const selectedStopped =
		statusSteps[index]?.status === "stopped" ||
		resultSteps[index]?.state === "stopped" ||
		resultSteps[index]?.stopped === true ||
		(stepCount === 1 && state === "stopped");
	if (selectedStopped) {
		throw new Error(
			`Async run '${runId}' child ${index} was stopped and cannot be resumed. Start a new run instead.`,
		);
	}
	const agent = statusSteps[index]?.agent ?? resultSteps[index]?.agent ?? result?.agent;
	if (!agent) throw new Error(`Could not determine child agent for async run '${runId}'.`);
	if (recoveryDescriptor && recoveryDescriptor.agent !== agent)
		throw new Error(
			`Async run '${runId}' has a recovery descriptor for '${recoveryDescriptor.agent}', not '${agent}'.`,
		);
	const sessionFile =
		statusSteps[index]?.sessionFile ??
		resultSteps[index]?.sessionFile ??
		(stepCount === 1 ? (status?.sessionFile ?? result?.sessionFile) : undefined);
	if (!sessionFile && requireSessionFile)
		throw new Error(`Async run '${runId}' child ${index} does not have a persisted session file to resume from.`);
	const resolvedSessionFile = sessionFile ? validateResumeSessionFile(runId, sessionFile) : undefined;
	const stepModel =
		statusSteps[index]?.model ?? resultSteps[index]?.model ?? (stepCount === 1 ? result?.model : undefined);
	const stepThinking =
		statusSteps[index]?.thinking ?? resultSteps[index]?.thinking ?? (stepCount === 1 ? result?.thinking : undefined);
	const capabilityCeiling = intersectSubagentCapabilityCeilings(
		status?.capabilityCeiling,
		statusSteps[index]?.capabilityCeiling,
		result?.capabilityCeiling,
		resultSteps[index]?.capabilityCeiling,
	);

	const target: AsyncResumeTarget = {
		kind: "revive",
		runId,
		asyncDir: location.asyncDir ?? undefined,
		state,
		agent,
		index,
		cwd: recoveryDescriptor?.cwd ?? status?.cwd ?? result?.cwd,
		launchContractDigest:
			statusSteps[index]?.launchContractDigest ??
			resultSteps[index]?.launchContractDigest ??
			result?.launchContractDigest ??
			recoveryDescriptor?.launchContractDigest,
	};
	if (resolvedSessionFile) target.sessionFile = resolvedSessionFile;
	if (stepModel) target.model = stepModel;
	if (stepThinking) target.thinking = stepThinking;
	if (recoveryDescriptor?.version === 2 && recoveryDescriptor.context) target.context = recoveryDescriptor.context;
	if (capabilityCeiling) target.capabilityCeiling = capabilityCeiling;
	if (recoveryDescriptor) target.recoveryDescriptor = recoveryDescriptor;
	return target;
}

export function resolveAsyncResumeTarget(
	params: AsyncResumeParams,
	deps: AsyncResumeDeps = {},
	options: AsyncResumeOptions = {},
): AsyncResumeTarget {
	const records = readResumeRecords(params, deps, options);
	const requestedIndex = params.index;
	if (requestedIndex !== undefined && !Number.isInteger(requestedIndex))
		throw new Error(`Async run '${records.runId}' index must be an integer.`);
	const liveTarget = records.state === "running" ? liveResumeTarget(records, requestedIndex) : undefined;
	return liveTarget ?? revivedResumeTarget(records, requestedIndex, options.requireSessionFile ?? true);
}

export function applySteeringRecoveryAgentConfig(
	agentConfig: AgentConfig,
	descriptor: AsyncRecoveryDescriptor,
): AgentConfig {
	const recovered = { ...agentConfig };
	if (descriptor.model === undefined) delete recovered.model;
	else recovered.model = descriptor.model;
	if (descriptor.fallbackModels === undefined) delete recovered.fallbackModels;
	else recovered.fallbackModels = [...descriptor.fallbackModels];
	if (descriptor.thinking === undefined) delete recovered.thinking;
	else recovered.thinking = descriptor.thinking;
	if (descriptor.tools === undefined) delete recovered.tools;
	else recovered.tools = [...descriptor.tools];
	if (descriptor.excludeTools === undefined) delete recovered.excludeTools;
	else recovered.excludeTools = [...descriptor.excludeTools];
	if (descriptor.extensions === undefined) delete recovered.extensions;
	else recovered.extensions = [...descriptor.extensions];
	if (descriptor.subagentOnlyExtensions === undefined) delete recovered.subagentOnlyExtensions;
	else recovered.subagentOnlyExtensions = [...descriptor.subagentOnlyExtensions];
	if (descriptor.mcpDirectTools === undefined) delete recovered.mcpDirectTools;
	else recovered.mcpDirectTools = [...descriptor.mcpDirectTools];
	if (descriptor.systemPrompt !== undefined) recovered.systemPrompt = descriptor.systemPrompt;
	recovered.systemPromptMode = descriptor.systemPromptMode;
	recovered.inheritProjectContext = descriptor.inheritProjectContext;
	recovered.inheritSkills = descriptor.inheritSkills;
	if (descriptor.skills === undefined) delete recovered.skills;
	else recovered.skills = [...descriptor.skills];
	if (descriptor.skillPath === undefined) delete recovered.skillPath;
	else recovered.skillPath = [...descriptor.skillPath];
	if (descriptor.agentFilePath !== undefined) recovered.filePath = descriptor.agentFilePath;
	if (descriptor.initialToolBudget === undefined) delete recovered.toolBudget;
	else recovered.toolBudget = descriptor.initialToolBudget;
	if (descriptor.maxSubagentDepth === undefined) delete recovered.maxSubagentDepth;
	else recovered.maxSubagentDepth = descriptor.maxSubagentDepth;
	return recovered;
}

export function buildRevivedAsyncTask(target: AsyncResumeTarget, message: string): string {
	return [
		"You are reviving a previous subagent conversation.",
		"",
		`Original run: ${target.runId}`,
		`Original agent: ${target.agent}`,
		target.sessionFile ? `Original session file: ${target.sessionFile}` : undefined,
		"",
		"Use the stored session context as background. Answer the orchestrator's follow-up below. Do not assume the original child process is still alive.",
		"",
		"Follow-up:",
		message,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}
