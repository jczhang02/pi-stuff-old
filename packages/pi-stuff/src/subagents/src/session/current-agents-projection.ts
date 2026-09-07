import type { AgentWorkUsage } from "../runtime/session-governor.ts";
import { boundedTerminalLine, isTaskOnlyAgentText, resolveDisplayDescription } from "../shared/display-description.ts";
import type { AgentContextUsage, AgentTerminalOutcome, SubagentState } from "../shared/types.ts";
import {
	ACTIVE_SOURCE_STATUSES,
	type AgentNestedDetail,
	type AgentStatus,
	type AgentTranscriptTarget,
	asRecord,
	boundedTask,
	countNestedRuns,
	deriveStatus,
	finiteNumber,
	firstLocator,
	firstString,
	nestedForChild,
	partialResult,
	projectedContextUsage,
	projectedCumulativeUsage,
	projectedTerminalOutcome,
	projectNestedAgents,
	RESUMABLE_STATUSES,
	rowKey,
	STATUS_ORDER,
	sourceStatus,
	TERMINAL_SOURCE_STATUSES,
	TERMINAL_STATUSES,
	taskForDisplay,
	terminalError,
} from "./current-agents-projection-normalization.ts";

export type { AgentNestedDetail, AgentStatus, AgentTranscriptTarget };

export interface AgentRow extends AgentTranscriptTarget {
	readonly runId: string;
	readonly childIndex: number;
	readonly sessionId: string;
	readonly name: string;
	readonly description: string;
	readonly task: string;
	readonly status: AgentStatus;
	readonly startedAt: number | null;
	readonly endedAt: number | null;
	readonly elapsedMs: number | null;
	readonly contextUsage: Readonly<AgentContextUsage> | null;
	readonly cumulativeUsage: Readonly<AgentWorkUsage> | null;
	readonly terminalOutcome: Readonly<AgentTerminalOutcome> | null;
	readonly partialResult: string | null;
	readonly nestedCount: number;
	readonly nestedAgents: readonly AgentNestedDetail[];
	readonly sessionFile: string | null;
	readonly transcriptPath: string | null;
	readonly savedOutputPath: string | null;
}

export interface AgentSessionSnapshot {
	readonly sessionId: string | null;
	readonly revision: number;
	readonly rows: readonly AgentRow[];
}

export type CurrentAgentsState = Pick<
	SubagentState,
	"currentSessionId" | "asyncJobs" | "recentAgentJobs" | "foregroundControls" | "foregroundRuns"
>;

type AsyncJob = SubagentState["asyncJobs"] extends Map<string, infer Job> ? Job : never;
type ForegroundControl = SubagentState["foregroundControls"] extends Map<string, infer Control> ? Control : never;
type ForegroundRun = NonNullable<SubagentState["foregroundRuns"]> extends Map<string, infer Run> ? Run : never;
type ForegroundResumeChild = ForegroundRun["children"][number];

export type RowDraft = Omit<AgentRow, "contextUsage" | "elapsedMs" | "nestedAgents" | "status"> & {
	readonly contextUsage: AgentContextUsage | null;
	readonly nestedAgents: AgentNestedDetail[];
	status: AgentStatus;
};

function projectAsyncJob(job: AsyncJob, sessionId: string, terminalOnly: boolean): RowDraft[] {
	if (job.sessionId !== sessionId) return [];
	const jobStatus = sourceStatus(job.status);
	if (terminalOnly ? !TERMINAL_SOURCE_STATUSES.has(jobStatus) : !ACTIVE_SOURCE_STATUSES.has(jobStatus)) return [];

	const persistedSteps = job.steps?.length ? job.steps : undefined;
	const hasPersistedSteps = persistedSteps !== undefined;
	const steps = persistedSteps
		? persistedSteps.map((step, position) => ({ step, childIndex: step.index ?? position }))
		: (job.agents?.length ? job.agents : ["agent"]).map((name, childIndex) => ({
				step: { agent: name },
				childIndex,
			}));
	const directCount = steps.length;

	return steps.map(({ step, childIndex }) => {
		const stepRecord = asRecord(step);
		const persistedTask = taskForDisplay(stepRecord["delegatedTask"], job.tasks?.[childIndex], stepRecord["task"]);
		const taskSource = persistedTask ?? firstString(stepRecord["label"], stepRecord["phase"], job.description) ?? "";
		const explicitDescription = firstString(
			job.descriptions?.[childIndex],
			...(persistedTask ? [stepRecord["label"], stepRecord["phase"], job.description] : []),
		);
		const rawStepStatus = sourceStatus(stepRecord["status"] ?? jobStatus);
		const effectiveStatus =
			TERMINAL_SOURCE_STATUSES.has(jobStatus) && !TERMINAL_SOURCE_STATUSES.has(rawStepStatus)
				? jobStatus
				: rawStepStatus;
		let statusRecord = { ...stepRecord, status: effectiveStatus };
		if (!hasPersistedSteps || directCount <= 1) {
			statusRecord = { ...asRecord(job), ...stepRecord, status: effectiveStatus };
		}
		const status = deriveStatus(statusRecord, effectiveStatus);
		const nested =
			Array.isArray(stepRecord["children"]) && stepRecord["children"].length > 0
				? stepRecord["children"]
				: nestedForChild(job.nestedChildren, childIndex, directCount);
		return {
			key: rowKey(job.asyncId, childIndex),
			runId: job.asyncId,
			childIndex,
			sessionId,
			name: firstString(stepRecord["agent"], job.agents?.[childIndex]) ?? "agent",
			description: resolveDisplayDescription(explicitDescription, taskSource),
			task: boundedTask(taskSource),
			status,
			error: terminalError(status, stepRecord, job),
			startedAt: finiteNumber(stepRecord["startedAt"] ?? job.startedAt),
			endedAt: finiteNumber(
				stepRecord["endedAt"] ?? (TERMINAL_SOURCE_STATUSES.has(jobStatus) ? job.updatedAt : null),
			),
			contextUsage: projectedContextUsage(stepRecord, job),
			cumulativeUsage: projectedCumulativeUsage(stepRecord, job),
			terminalOutcome: projectedTerminalOutcome(stepRecord, job),
			partialResult: partialResult(status, stepRecord, job),
			nestedCount: countNestedRuns(nested),
			nestedAgents: projectNestedAgents(nested),
			sessionFile: firstLocator(stepRecord["sessionFile"], job.sessionFile),
			transcriptPath: firstLocator(stepRecord["transcriptPath"]),
			savedOutputPath: firstLocator(stepRecord["savedOutputPath"], stepRecord["structuredOutputPath"]),
		};
	});
}

function rememberedForegroundChildren(
	state: CurrentAgentsState,
	sessionId: string,
): Map<string, ForegroundResumeChild> {
	const remembered = new Map<string, ForegroundResumeChild>();
	for (const run of state.foregroundRuns?.values() ?? []) {
		if (run.sessionId !== sessionId) continue;
		for (const child of run.children) {
			if (!child) continue;
			remembered.set(rowKey(run.runId, child.index), child);
		}
	}
	return remembered;
}

function projectForegroundControl(
	control: ForegroundControl,
	sessionId: string,
	remembered: ReadonlyMap<string, ForegroundResumeChild>,
): RowDraft[] {
	if (control.sessionId !== sessionId) return [];
	const children = control.activeChildren?.size
		? [...control.activeChildren.entries()].sort(([left], [right]) => left - right)
		: control.currentAgent
			? [
					[
						control.currentIndex ?? 0,
						{
							agent: control.currentAgent,
							description: control.description,
							task: control.task,
							startedAt: control.startedAt,
							updatedAt: control.updatedAt,
							currentActivityState: control.currentActivityState,
							currentTool: control.currentTool,
						},
					] as const,
				]
			: [];
	const directCount = children.length;

	return children.map(([childIndex, child]) => {
		const childRecord = asRecord(child);
		const persistedTask = firstString(childRecord["task"], control.task);
		const taskSource = persistedTask ?? firstString(childRecord["description"], control.description) ?? "";
		const rememberedChild = asRecord(remembered.get(rowKey(control.runId, childIndex)));
		const statusRecord = {
			...asRecord(control),
			...childRecord,
			status: childRecord["status"] ?? "running",
			activityState: childRecord["currentActivityState"] ?? control.currentActivityState,
			currentTool: childRecord["currentTool"] ?? control.currentTool,
		};
		const status = deriveStatus(statusRecord, "running");
		const nested = nestedForChild(control.nestedChildren, childIndex, directCount);
		return {
			key: rowKey(control.runId, childIndex),
			runId: control.runId,
			childIndex,
			sessionId,
			name: firstString(childRecord["agent"], control.currentAgent) ?? "agent",
			description: resolveDisplayDescription(
				persistedTask ? firstString(childRecord["description"], control.description) : undefined,
				taskSource,
			),
			task: boundedTask(taskSource),
			status,
			error: terminalError(status, rememberedChild, childRecord, control),
			startedAt: finiteNumber(childRecord["startedAt"] ?? control.startedAt),
			endedAt: null,
			contextUsage: projectedContextUsage(childRecord, control),
			cumulativeUsage: projectedCumulativeUsage(rememberedChild, childRecord, control),
			terminalOutcome: projectedTerminalOutcome(rememberedChild, childRecord, control),
			partialResult: partialResult(status, rememberedChild, childRecord),
			nestedCount: countNestedRuns(nested),
			nestedAgents: projectNestedAgents(nested),
			sessionFile: firstLocator(rememberedChild["sessionFile"]),
			transcriptPath: firstLocator(
				rememberedChild["transcriptPath"],
				asRecord(rememberedChild["artifactPaths"])["transcriptPath"],
			),
			savedOutputPath: firstLocator(
				rememberedChild["savedOutputPath"],
				asRecord(rememberedChild["artifactPaths"])["outputPath"],
			),
		};
	});
}

function projectForegroundRun(run: ForegroundRun, sessionId: string): RowDraft[] {
	if (run.sessionId !== sessionId) return [];
	return run.children.flatMap((child) => {
		if (!child) return [];
		const childRecord = asRecord(child);
		const nested = Array.isArray(childRecord["children"]) ? childRecord["children"] : [];
		const persistedTask = firstString(childRecord["task"]);
		const taskSource = persistedTask ?? firstString(childRecord["description"]) ?? "";
		const status = deriveStatus(childRecord, child.status);
		return [
			{
				key: rowKey(run.runId, child.index),
				runId: run.runId,
				childIndex: child.index,
				sessionId,
				name: child.agent || "agent",
				description: resolveDisplayDescription(
					persistedTask ? firstString(childRecord["description"]) : undefined,
					taskSource,
				),
				task: boundedTask(taskSource),
				status,
				error: terminalError(status, childRecord),
				startedAt: finiteNumber(childRecord["startedAt"]),
				endedAt: finiteNumber(child.updatedAt ?? run.updatedAt),
				contextUsage: projectedContextUsage(childRecord),
				cumulativeUsage: projectedCumulativeUsage(childRecord),
				terminalOutcome: projectedTerminalOutcome(childRecord),
				partialResult: partialResult(status, childRecord),
				nestedCount: countNestedRuns(nested),
				nestedAgents: projectNestedAgents(nested),
				sessionFile: firstLocator(child.sessionFile),
				transcriptPath: firstLocator(child.transcriptPath, asRecord(child.artifactPaths)["transcriptPath"]),
				savedOutputPath: firstLocator(child.savedOutputPath, asRecord(child.artifactPaths)["outputPath"]),
			} satisfies RowDraft,
		];
	});
}

function freezeRow(draft: RowDraft, now: number): AgentRow {
	const terminal = TERMINAL_STATUSES.has(draft.status);
	const end = terminal ? draft.endedAt : now;
	const elapsedMs = draft.startedAt === null || end === null ? null : Math.max(0, end - draft.startedAt);
	const partialResult =
		draft.partialResult &&
		!isTaskOnlyAgentText(draft.partialResult, draft.task) &&
		boundedTerminalLine(draft.partialResult) !== draft.error
			? draft.partialResult
			: null;
	return Object.freeze({
		...draft,
		elapsedMs,
		contextUsage: draft.contextUsage ? Object.freeze({ ...draft.contextUsage }) : null,
		cumulativeUsage: draft.cumulativeUsage ? Object.freeze({ ...draft.cumulativeUsage }) : null,
		terminalOutcome: draft.terminalOutcome
			? Object.freeze({
					...draft.terminalOutcome,
					continuation: Object.freeze({
						...draft.terminalOutcome.continuation,
						target: Object.freeze({ ...draft.terminalOutcome.continuation.target }),
					}),
				})
			: null,
		partialResult,
		nestedAgents: Object.freeze([...draft.nestedAgents]),
	});
}

export function semanticSnapshotKey(sessionId: string | null, rows: readonly AgentRow[]): string {
	return JSON.stringify({
		sessionId,
		rows: rows.map(({ elapsedMs: _elapsedMs, ...row }) => row),
	});
}

export function projectCurrentAgentRows(state: CurrentAgentsState, sessionId: string): RowDraft[] {
	const rows = new Map<string, RowDraft>();
	const remembered = rememberedForegroundChildren(state, sessionId);
	for (const control of state.foregroundControls.values()) {
		for (const row of projectForegroundControl(control, sessionId, remembered)) rows.set(row.key, row);
	}
	for (const job of state.asyncJobs.values()) {
		for (const row of projectAsyncJob(job, sessionId, false)) if (!rows.has(row.key)) rows.set(row.key, row);
	}
	for (const run of state.foregroundRuns?.values() ?? []) {
		for (const row of projectForegroundRun(run, sessionId)) if (!rows.has(row.key)) rows.set(row.key, row);
	}
	for (const job of state.recentAgentJobs?.values() ?? []) {
		for (const row of projectAsyncJob(job, sessionId, true)) if (!rows.has(row.key)) rows.set(row.key, row);
	}
	return [...rows.values()];
}

export function freezeCurrentAgentRows(drafts: readonly RowDraft[], now: number): readonly AgentRow[] {
	return Object.freeze(
		drafts
			.map((draft) => freezeRow(draft, now))
			.sort(
				(left, right) =>
					STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
					(left.startedAt ?? Number.MAX_SAFE_INTEGER) - (right.startedAt ?? Number.MAX_SAFE_INTEGER) ||
					left.key.localeCompare(right.key),
			),
	);
}

export function isTerminalAgentStatus(status: AgentStatus): boolean {
	return TERMINAL_STATUSES.has(status);
}

export function isResumableAgentStatus(status: AgentStatus): boolean {
	return RESUMABLE_STATUSES.has(status);
}
