import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import { isRuntimeBoolean, isRuntimeFunction, isRuntimeNumber, isRuntimeObject } from "../../../shared/runtime-type.ts";
import { scanAgentReport } from "../runtime/final-report-scanner.ts";
import {
	type IntercomEventBus,
	type NestedRunSummary,
	type PublicNestedRunSummary,
	type PublicNestedStepSummary,
	SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT,
	SUBAGENT_RESULT_INTERCOM_EVENT,
	type SubagentResultIntercomChild,
	type SubagentResultIntercomPayload,
	type SubagentResultStatus,
	type SubagentRunMode,
} from "../shared/types.ts";

export function resolveSubagentResultStatus(input: {
	exitCode?: number;
	success?: boolean;
	state?: string;
	interrupted?: boolean;
	detached?: boolean;
}): SubagentResultStatus {
	if (input.detached) return "detached";
	if (input.state === "stopped") return "stopped";
	if (input.interrupted || input.state === "paused") return "paused";
	if (isRuntimeBoolean(input.success)) return input.success ? "completed" : "failed";
	if (input.state === "complete") return "completed";
	if (input.state === "failed") return "failed";
	if (isRuntimeNumber(input.exitCode)) return input.exitCode === 0 ? "completed" : "failed";
	return "failed";
}

interface StatusCounts {
	completed: number;
	detached: number;
	failed: number;
	paused: number;
	stopped: number;
}

function countStatuses(children: SubagentResultIntercomChild[]): StatusCounts {
	const counts = {
		completed: 0,
		failed: 0,
		paused: 0,
		stopped: 0,
		detached: 0,
	} satisfies Record<SubagentResultStatus, number>;
	for (const child of children) {
		counts[child.status] += 1;
	}
	return counts;
}

function formatStatusCounts(counts: StatusCounts): string {
	const parts = [
		counts.completed ? `${counts.completed} completed` : undefined,
		counts.failed ? `${counts.failed} failed` : undefined,
		counts.stopped ? `${counts.stopped} stopped` : undefined,
		counts.paused ? `${counts.paused} paused` : undefined,
		counts.detached ? `${counts.detached} detached` : undefined,
	].filter((part): part is string => Boolean(part));
	return parts.length ? parts.join(", ") : "0 results";
}

function resolveGroupedStatus(children: SubagentResultIntercomChild[]): SubagentResultStatus {
	const counts = countStatuses(children);
	if (counts.failed > 0) return "failed";
	if (counts.stopped > 0) return "stopped";
	if (counts.paused > 0) return "paused";
	if (counts.completed > 0) return "completed";
	if (counts.detached > 0) return "detached";
	return "failed";
}

const MAX_PUBLIC_NESTED_DEPTH = 3;
const MAX_PUBLIC_NESTED_RUNS = 200;
const MAX_PUBLIC_NESTED_STEPS = 200;
const MAX_PUBLIC_STEPS_PER_RUN = 20;

interface NestedProjectionBudget {
	runs: number;
	steps: number;
	seenRunIds: Set<string>;
}

function compactNestedRun(
	run: NestedRunSummary | PublicNestedRunSummary,
	depth: number,
	budget: NestedProjectionBudget,
): PublicNestedRunSummary | undefined {
	if (depth > MAX_PUBLIC_NESTED_DEPTH || budget.runs <= 0 || budget.seenRunIds.has(run.id)) return undefined;
	budget.seenRunIds.add(run.id);
	budget.runs -= 1;
	const steps = (run.steps ?? []).slice(0, Math.min(MAX_PUBLIC_STEPS_PER_RUN, budget.steps));
	budget.steps -= steps.length;
	const path = run.path.slice(0, 4).map((part) => {
		const projected: PublicNestedRunSummary["path"][number] = { runId: part.runId };
		if (part.stepIndex !== undefined) projected.stepIndex = part.stepIndex;
		if (part.agent) projected.agent = part.agent;
		return projected;
	});
	const projected: PublicNestedRunSummary = {
		id: run.id,
		parentRunId: run.parentRunId,
		depth: run.depth,
		path,
		state: run.state,
	};
	if (run.agentStatus) projected.agentStatus = run.agentStatus;
	if (run.parentStepIndex !== undefined) projected.parentStepIndex = run.parentStepIndex;
	if (run.parentAgent) projected.parentAgent = run.parentAgent;
	if (run.asyncDir) projected.asyncDir = run.asyncDir;
	if (run.sessionId) projected.sessionId = run.sessionId;
	if (run.sessionFile) projected.sessionFile = run.sessionFile;
	if (run.intercomTarget) projected.intercomTarget = run.intercomTarget;
	if (run.ownerIntercomTarget) projected.ownerIntercomTarget = run.ownerIntercomTarget;
	if (run.leafIntercomTarget) projected.leafIntercomTarget = run.leafIntercomTarget;
	if (run.parentRunOrigin) projected.parentRunOrigin = run.parentRunOrigin;
	if (run.ownerState) projected.ownerState = run.ownerState;
	if (run.mode) projected.mode = run.mode;
	if (run.agent) projected.agent = run.agent;
	if (run.agents?.length) projected.agents = run.agents.slice(0, MAX_PUBLIC_STEPS_PER_RUN);
	if (run.currentStep !== undefined) projected.currentStep = run.currentStep;
	if (run.parallelGroups?.length) {
		projected.parallelGroups = run.parallelGroups.slice(0, MAX_PUBLIC_STEPS_PER_RUN);
	}
	if (run.activityState) projected.activityState = run.activityState;
	if (run.lastActivityAt !== undefined) projected.lastActivityAt = run.lastActivityAt;
	if (run.currentTool) projected.currentTool = run.currentTool;
	if (run.currentToolStartedAt !== undefined) projected.currentToolStartedAt = run.currentToolStartedAt;
	if (run.currentPath) projected.currentPath = run.currentPath;
	if (run.turnCount !== undefined) projected.turnCount = run.turnCount;
	if (run.toolCount !== undefined) projected.toolCount = run.toolCount;
	if (run.totalTokens) projected.totalTokens = run.totalTokens;
	if (run.startedAt !== undefined) projected.startedAt = run.startedAt;
	if (run.endedAt !== undefined) projected.endedAt = run.endedAt;
	if (run.lastUpdate !== undefined) projected.lastUpdate = run.lastUpdate;
	if (run.error) projected.error = run.error;
	if (steps.length) {
		projected.steps = steps.map((step) => {
			const projectedStep: PublicNestedStepSummary = { agent: step.agent, status: step.status };
			if (step.agentStatus) projectedStep.agentStatus = step.agentStatus;
			if (step.task) projectedStep.task = step.task;
			if (step.description) projectedStep.description = step.description;
			if (step.sessionFile) projectedStep.sessionFile = step.sessionFile;
			if (step.transcriptPath) projectedStep.transcriptPath = step.transcriptPath;
			if (step.transcriptError) projectedStep.transcriptError = step.transcriptError;
			if (step.activityState) projectedStep.activityState = step.activityState;
			if (step.lastActivityAt !== undefined) projectedStep.lastActivityAt = step.lastActivityAt;
			if (step.currentTool) projectedStep.currentTool = step.currentTool;
			if (step.currentToolStartedAt !== undefined) projectedStep.currentToolStartedAt = step.currentToolStartedAt;
			if (step.currentPath) projectedStep.currentPath = step.currentPath;
			if (step.turnCount !== undefined) projectedStep.turnCount = step.turnCount;
			if (step.toolCount !== undefined) projectedStep.toolCount = step.toolCount;
			if (step.toolBudget) projectedStep.toolBudget = step.toolBudget;
			if (step.toolBudgetBlocked) projectedStep.toolBudgetBlocked = true;
			if (step.startedAt !== undefined) projectedStep.startedAt = step.startedAt;
			if (step.endedAt !== undefined) projectedStep.endedAt = step.endedAt;
			if (step.error) projectedStep.error = step.error;
			if (depth < MAX_PUBLIC_NESTED_DEPTH && step.children?.length) {
				projectedStep.children = step.children
					.map((child) => compactNestedRun(child, depth + 1, budget))
					.filter((child): child is PublicNestedRunSummary => Boolean(child));
			}
			return projectedStep;
		});
	}
	if (depth < MAX_PUBLIC_NESTED_DEPTH && run.children?.length) {
		projected.children = run.children
			.map((child) => compactNestedRun(child, depth + 1, budget))
			.filter((child): child is PublicNestedRunSummary => Boolean(child));
	}
	return projected;
}

export function compactNestedResultChildren(
	children: Array<NestedRunSummary | PublicNestedRunSummary> | undefined,
): PublicNestedRunSummary[] | undefined {
	if (!children?.length) return undefined;
	const budget = { runs: MAX_PUBLIC_NESTED_RUNS, steps: MAX_PUBLIC_NESTED_STEPS, seenRunIds: new Set<string>() };
	const compact = children
		.map((child) => compactNestedRun(child, 0, budget))
		.filter((child): child is PublicNestedRunSummary => Boolean(child));
	return compact.length ? compact : undefined;
}

function compactResultChild(child: SubagentResultIntercomChild): SubagentResultIntercomChild {
	const compact = compactNestedResultChildren(child.children);
	const projected = { ...child };
	delete projected.children;
	if (compact) projected.children = compact;
	return projected;
}

export function attachNestedChildrenToResultChildren(
	runId: string,
	children: SubagentResultIntercomChild[],
	nestedChildren: NestedRunSummary[] | undefined,
): SubagentResultIntercomChild[] {
	const compact = compactNestedResultChildren(nestedChildren);
	if (!compact?.length) return children.map(compactResultChild);
	return children.map((child, index) => {
		const childIndex = child.index ?? index;
		const alreadyAttachedIds = new Set(child.children?.map((nested) => nested.id) ?? []);
		const attached = compact.filter(
			(nested) =>
				nested.parentRunId === runId && nested.parentStepIndex === childIndex && !alreadyAttachedIds.has(nested.id),
		);
		const fallbackAttached =
			children.length === 1
				? compact.filter(
						(nested) =>
							nested.parentRunId === runId &&
							nested.parentStepIndex === undefined &&
							!alreadyAttachedIds.has(nested.id),
					)
				: [];
		const merged = compactNestedResultChildren([...(child.children ?? []), ...attached, ...fallbackAttached]);
		const projected = { ...child };
		delete projected.children;
		if (merged?.length) projected.children = merged;
		return projected;
	});
}

interface GroupedResultIntercomMessageInput {
	to: string;
	runId: string;
	mode: SubagentRunMode;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
	asyncDir?: string;
}

function formatSubagentResultIntercomMessage(input: {
	runId: string;
	mode: SubagentRunMode;
	status: SubagentResultStatus;
	source: "foreground" | "async";
	children: SubagentResultIntercomChild[];
	asyncId?: string;
	asyncDir?: string;
}): string {
	const counts = countStatuses(input.children);
	const lines: string[] = [`Agent results · ${formatStatusCounts(counts)}`];

	for (const [index, child] of input.children.entries()) {
		lines.push("");
		lines.push(`${index + 1}. ${child.agent} — ${child.status}`);
		if (child.terminalOutcome) {
			const { continuation } = child.terminalOutcome;
			lines.push(
				`Outcome: ${child.terminalOutcome.class}/${child.terminalOutcome.state} — ${child.terminalOutcome.reason}`,
				`Recovery: ${continuation.target.id} index ${String(continuation.target.index)} — ${continuation.resumeSupported ? "resumable" : "not resumable"}${continuation.acknowledgementRequired ? "; acknowledgement required" : ""}`,
			);
		}
		if (child.cumulativeUsage) {
			const usage = child.cumulativeUsage;
			const cost = usage.reportedCostUsd === undefined ? "unreported" : `$${usage.reportedCostUsd.toFixed(6)}`;
			lines.push(
				`Usage: ${usage.turns} turns, ${usage.toolCalls} Tools, ${usage.inputTokens} input + ${usage.outputTokens} output tokens, reported cost ${cost}, ${usage.modelAttempts} attempts, ${usage.resumes} resumes`,
			);
		}
		lines.push(child.summary);
	}

	return lines.join("\n");
}

export function buildSubagentResultIntercomPayload(
	input: GroupedResultIntercomMessageInput,
): SubagentResultIntercomPayload {
	const children = input.children.map((child) => ({
		...compactResultChild(child),
		summary: scanAgentReport(child.summary.trim() || "(no output)").text.slice(0, 4_000),
	}));
	const status = resolveGroupedStatus(children);
	const summary = formatStatusCounts(countStatuses(children));
	const firstChild = children[0];
	const payload: SubagentResultIntercomPayload = {
		to: input.to,
		runId: input.runId,
		mode: input.mode,
		status,
		summary,
		source: input.source,
		children,
		message: "",
	};
	if (input.asyncId) payload.asyncId = input.asyncId;
	if (input.asyncDir) payload.asyncDir = input.asyncDir;
	if (firstChild?.agent) payload.agent = firstChild.agent;
	if (firstChild?.index !== undefined) payload.index = firstChild.index;
	if (firstChild?.artifactPath) payload.artifactPath = firstChild.artifactPath;
	if (firstChild?.sessionPath) payload.sessionPath = firstChild.sessionPath;
	payload.message = formatSubagentResultIntercomMessage(payload);
	return payload;
}

export function deliverSubagentResultIntercomEvent(
	events: IntercomEventBus,
	payload: SubagentResultIntercomPayload,
	timeoutMs = 500,
): Effect.Effect<boolean> {
	return deliverSubagentIntercomMessageEvent(events, payload.to, payload.message, timeoutMs, payload);
}

interface SubagentIntercomExtra {
	readonly requestId?: string;
}

export function deliverSubagentIntercomMessageEvent(
	events: IntercomEventBus,
	to: string,
	message: string,
	timeoutMs = 500,
	extra: SubagentIntercomExtra = {},
): Effect.Effect<boolean> {
	if (!isRuntimeFunction(events.on) || !isRuntimeFunction(events.emit)) return Effect.succeed(false);
	const requestId = extra.requestId ?? randomUUID();
	const delivered = Effect.callback<boolean>((resume) => {
		const unsubscribe = events.on?.(SUBAGENT_RESULT_INTERCOM_DELIVERY_EVENT, (data) => {
			if (!data || !isRuntimeObject(data)) return;
			const deliveredRequestId = "requestId" in data ? data.requestId : undefined;
			if (deliveredRequestId !== requestId) return;
			resume(Effect.succeed("delivered" in data && data.delivered === true));
		});
		try {
			events.emit?.(SUBAGENT_RESULT_INTERCOM_EVENT, { ...extra, to, message, requestId });
		} catch {
			resume(Effect.succeed(false));
		}
		return Effect.sync(() => unsubscribe?.());
	});
	return Effect.raceFirst(delivered, Effect.sleep(timeoutMs).pipe(Effect.as(false)));
}
