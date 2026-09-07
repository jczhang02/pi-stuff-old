import { type JsonValue, parseJsonValue } from "../../../../shared/json-value.ts";
import { isFiniteRuntimeNumber, isRuntimeObject } from "../../../../shared/runtime-type.ts";
import type { NestedRouteInfo, NestedRunState, NestedRunSummary, NestedStepSummary } from "../../shared/types.ts";
import { isSafeNestedPathId } from "./nested-path.ts";
import { MAX_CHILDREN, MAX_DEPTH, MAX_STEPS, sanitizeSummary } from "./nested-summary.ts";

export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
export const MAX_PROCESSED_EVENTS = 1_000;

type NestedStatusEventType = "subagent.nested.started" | "subagent.nested.updated" | "subagent.nested.completed";

export type NestedRoute = NestedRouteInfo;

export interface NestedEventRecord {
	type: NestedStatusEventType;
	ts: number;
	rootRunId: string;
	parentRunId: string;
	parentStepIndex?: number;
	capabilityToken: string;
	child: NestedRunSummary;
}

export interface NestedRegistry {
	rootRunId: string;
	updatedAt: number;
	children: NestedRunSummary[];
	pendingChildren: NestedRunSummary[];
	processedEvents: string[];
}

type RawNestedEvent = { [Key in keyof NestedEventRecord]?: JsonValue };

function truncateUtf8(value: string | undefined, maxBytes: number): string | undefined {
	if (!value) return undefined;
	if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
	let end = Math.min(value.length, maxBytes);
	while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf-8") > maxBytes) end -= 1;
	return end > 0 ? value.slice(0, end) : undefined;
}

function exactBoundedLocator(value: string | undefined, maxBytes: number): string | undefined {
	return value && Buffer.byteLength(value, "utf-8") <= maxBytes ? value : undefined;
}

function externalWriterCrash(processTerminal: NestedStepSummary["processTerminal"]): boolean {
	if (processTerminal?.state !== "observed") return false;
	const writers = processTerminal.instances.filter(
		(instance): instance is Extract<(typeof processTerminal.instances)[number], { kind: "pi-writer" }> =>
			instance.kind === "pi-writer",
	);
	const finalAttempt = writers.reduce((latest, instance) => Math.max(latest, instance.attempt), -1);
	return writers.some((instance) => instance.attempt === finalAttempt && instance.terminationOrigin === "external");
}

/**
 * Nested event files are a bounded projection, not the durable transcript or
 * capability authority. Keep every child and its inspectable transcript
 * references while removing repeated capability/tool lists that remain in the
 * child's own status file.
 */
function compactStepForTransport(step: NestedStepSummary, includeChildren: boolean): NestedStepSummary {
	const {
		capabilityAudit: _capabilityAudit,
		capabilityCeiling: _capabilityCeiling,
		children: _children,
		currentPath: _currentPath,
		delegatedTask: _delegatedTask,
		description: _description,
		error: _error,
		processTerminal: _processTerminal,
		sessionFile: _sessionFile,
		task: _task,
		toolBudget: _toolBudget,
		transcriptError: _transcriptError,
		transcriptPath: _transcriptPath,
		...base
	} = step;
	const sessionFile = exactBoundedLocator(step.sessionFile, 768);
	const transcriptPath = exactBoundedLocator(step.transcriptPath, 768);
	const locatorOmitted = (step.sessionFile && !sessionFile) || (step.transcriptPath && !transcriptPath);
	const transcriptError = locatorOmitted
		? "Transcript locator omitted from the bounded nested projection; inspect the child status artifact."
		: truncateUtf8(step.transcriptError, 256);
	const compact: NestedStepSummary = { ...base };
	const delegatedTask = truncateUtf8(step.delegatedTask, 512);
	const task = truncateUtf8(step.task, 512);
	const description = truncateUtf8(step.description, 256);
	const currentPath = truncateUtf8(step.currentPath, 256);
	const error = truncateUtf8(step.error, 256);
	if (delegatedTask) compact.delegatedTask = delegatedTask;
	if (task) compact.task = task;
	if (description) compact.description = description;
	if (step.agentStatus === "crashed" || externalWriterCrash(step.processTerminal)) compact.agentStatus = "crashed";
	if (sessionFile) compact.sessionFile = sessionFile;
	if (transcriptPath) compact.transcriptPath = transcriptPath;
	if (transcriptError) compact.transcriptError = transcriptError;
	if (currentPath) compact.currentPath = currentPath;
	if (error) compact.error = error;
	if (includeChildren && step.children?.length) {
		compact.children = step.children.slice(-MAX_CHILDREN).map((child) => compactSummaryForTransport(child, true));
	}
	return compact;
}

export function compactSummaryForTransport(summary: NestedRunSummary, includeChildren: boolean): NestedRunSummary {
	const {
		asyncDir: _asyncDir,
		capabilityAudit: _capabilityAudit,
		capabilityCeiling: _capabilityCeiling,
		children: _children,
		controlInbox: _controlInbox,
		currentPath: _currentPath,
		error: _error,
		processTerminal: _processTerminal,
		sessionFile: _sessionFile,
		steps: _steps,
		toolBudget: _toolBudget,
		...base
	} = summary;
	const asyncDir = exactBoundedLocator(summary.asyncDir, 768);
	const sessionFile = exactBoundedLocator(summary.sessionFile, 768);
	const controlInbox = exactBoundedLocator(summary.controlInbox, 768);
	const compact: NestedRunSummary = { ...base };
	const currentPath = truncateUtf8(summary.currentPath, 256);
	const error = truncateUtf8(summary.error, 256);
	if (summary.agentStatus === "crashed" || externalWriterCrash(summary.processTerminal))
		compact.agentStatus = "crashed";
	if (asyncDir) compact.asyncDir = asyncDir;
	if (sessionFile) compact.sessionFile = sessionFile;
	if (controlInbox) compact.controlInbox = controlInbox;
	if (currentPath) compact.currentPath = currentPath;
	if (error) compact.error = error;
	if (summary.steps?.length) {
		compact.steps = summary.steps.slice(0, MAX_STEPS).map((step) => compactStepForTransport(step, includeChildren));
	}
	if (includeChildren && summary.children?.length) {
		compact.children = summary.children.slice(-MAX_CHILDREN).map((child) => compactSummaryForTransport(child, true));
	}
	return compact;
}

function compactSummaryForRegistry(summary: NestedRunSummary, remainingDepth: number): NestedRunSummary {
	const compact = compactSummaryForTransport(summary, false);
	if (summary.children?.length) {
		compact.children = summary.children
			.slice(-MAX_CHILDREN)
			.map((child) =>
				remainingDepth > 0 ? compactSummaryForRegistry(child, remainingDepth - 1) : skeletonSummary(child),
			);
	}
	if (remainingDepth > 0 && summary.steps?.length) {
		compact.steps = summary.steps.slice(0, MAX_STEPS).map((step) => {
			const compactStep = compactStepForTransport(step, false);
			if (step.children?.length) {
				compactStep.children = step.children
					.slice(-MAX_CHILDREN)
					.map((child) => compactSummaryForRegistry(child, remainingDepth - 1));
			}
			return compactStep;
		});
	}
	return compact;
}

function skeletonSummary(summary: NestedRunSummary): NestedRunSummary {
	const skeleton: Partial<NestedRunSummary> = { id: summary.id };
	if (summary.parentRunOrigin) skeleton.parentRunOrigin = summary.parentRunOrigin;
	skeleton.parentRunId = summary.parentRunId;
	if (summary.parentStepIndex !== undefined) skeleton.parentStepIndex = summary.parentStepIndex;
	if (summary.parentAgent) skeleton.parentAgent = summary.parentAgent;
	skeleton.depth = summary.depth;
	skeleton.path = summary.path;
	skeleton.state = summary.state;
	if (summary.ownerState) skeleton.ownerState = summary.ownerState;
	if (summary.agent) skeleton.agent = summary.agent;
	if (summary.agents?.length) skeleton.agents = summary.agents.slice(0, MAX_STEPS);
	if (summary.startedAt !== undefined) skeleton.startedAt = summary.startedAt;
	if (summary.endedAt !== undefined) skeleton.endedAt = summary.endedAt;
	if (summary.lastUpdate !== undefined) skeleton.lastUpdate = summary.lastUpdate;
	if (summary.agentStatus === "crashed") skeleton.agentStatus = "crashed";
	const asyncDir = exactBoundedLocator(summary.asyncDir, 768);
	const controlInbox = exactBoundedLocator(summary.controlInbox, 768);
	if (asyncDir) skeleton.asyncDir = asyncDir;
	if (controlInbox) skeleton.controlInbox = controlInbox;
	if (summary.capabilityToken) skeleton.capabilityToken = summary.capabilityToken;
	if (summary.children?.length) {
		skeleton.children = summary.children.slice(-MAX_CHILDREN).map(skeletonSummary);
	}
	// SAFETY: the required summary address and state fields are copied before every return.
	return skeleton as NestedRunSummary;
}

export function boundedRegistry(registry: NestedRegistry): NestedRegistry {
	for (let depth = MAX_DEPTH; depth >= 0; depth -= 1) {
		const bounded = {
			...registry,
			children: registry.children.slice(-MAX_CHILDREN).map((child) => compactSummaryForRegistry(child, depth)),
			pendingChildren: registry.pendingChildren
				.slice(-MAX_CHILDREN)
				.map((child) => compactSummaryForRegistry(child, depth)),
			processedEvents: registry.processedEvents.slice(-MAX_PROCESSED_EVENTS),
		};
		if (Buffer.byteLength(JSON.stringify(bounded, null, 2), "utf-8") <= MAX_REGISTRY_BYTES) return bounded;
	}
	// The legal forest cardinality must remain live even when every optional
	// projection field is maximally sized. Preserve every canonical node as a
	// small skeleton instead of retrying the same oversized event forever.
	return {
		...registry,
		children: registry.children.slice(-MAX_CHILDREN).map(skeletonSummary),
		pendingChildren: registry.pendingChildren.slice(-MAX_CHILDREN).map(skeletonSummary),
		processedEvents: registry.processedEvents.slice(-Math.min(MAX_PROCESSED_EVENTS, 200)),
	};
}

export function parseRecord(content: string, route: NestedRoute): NestedEventRecord | undefined {
	if (Buffer.byteLength(content, "utf-8") > MAX_EVENT_BYTES) return undefined;
	let parsed: JsonValue;
	try {
		parsed = parseJsonValue(content);
	} catch {
		return undefined;
	}
	if (!parsed || !isRuntimeObject(parsed)) return undefined;
	// SAFETY: the parsed non-null JSON object can be inspected through the event schema's optional raw fields.
	const raw = parsed as RawNestedEvent;
	if (
		raw.type !== "subagent.nested.started" &&
		raw.type !== "subagent.nested.updated" &&
		raw.type !== "subagent.nested.completed"
	)
		return undefined;
	if (raw.rootRunId !== route.rootRunId || raw.capabilityToken !== route.capabilityToken) return undefined;
	if (!isSafeNestedPathId(raw.parentRunId)) return undefined;
	const parentStepIndex = isFiniteRuntimeNumber(raw.parentStepIndex) ? raw.parentStepIndex : undefined;
	if (
		raw.parentStepIndex !== undefined &&
		(parentStepIndex === undefined || !Number.isSafeInteger(parentStepIndex) || parentStepIndex < 0)
	)
		return undefined;
	const ts = isFiniteRuntimeNumber(raw.ts) ? raw.ts : undefined;
	if (ts === undefined) return undefined;
	const child = sanitizeSummary(raw.child);
	if (!child || child.id === route.rootRunId) return undefined;
	if (child.parentRunId !== raw.parentRunId || child.parentStepIndex !== parentStepIndex) return undefined;
	const routedChild: NestedRunSummary = {
		...child,
		controlInbox: route.controlInbox,
		capabilityToken: route.capabilityToken,
		ownerState: child.ownerState ?? "unknown",
	};
	const record: NestedEventRecord = {
		type: raw.type,
		ts,
		rootRunId: route.rootRunId,
		parentRunId: raw.parentRunId,
		capabilityToken: route.capabilityToken,
		child: routedChild,
	};
	if (parentStepIndex !== undefined) record.parentStepIndex = parentStepIndex;
	return record;
}

export function parseNestedEventRecords(content: string, route: NestedRoute): NestedEventRecord[] {
	if (!content.includes("\n")) {
		const record = parseRecord(content.trim(), route);
		return record ? [record] : [];
	}
	return content
		.split("\n")
		.slice(0, content.endsWith("\n") ? undefined : -1)
		.map((line) => (line.trim() ? parseRecord(line, route) : undefined))
		.filter((event): event is NestedEventRecord => Boolean(event));
}

export function isTerminalNestedRunState(state: NestedRunState): boolean {
	return state === "complete" || state === "failed" || state === "paused" || state === "stopped";
}

function mergedParentRunOrigin(
	existing: NestedRunSummary["parentRunOrigin"],
	incoming: NestedRunSummary["parentRunOrigin"],
): NestedRunSummary["parentRunOrigin"] {
	if (existing === "user" || incoming === "user") return "user";
	return existing ?? incoming;
}

function withMergedParentRunOrigin(
	summary: NestedRunSummary,
	existing: NestedRunSummary["parentRunOrigin"],
	incoming: NestedRunSummary["parentRunOrigin"],
): NestedRunSummary {
	const parentRunOrigin = mergedParentRunOrigin(existing, incoming);
	return parentRunOrigin && summary.parentRunOrigin !== parentRunOrigin ? { ...summary, parentRunOrigin } : summary;
}

function mergeSummary(existing: NestedRunSummary | undefined, event: NestedEventRecord): NestedRunSummary {
	const incomingState =
		event.type === "subagent.nested.completed" && event.child.state === "running" ? "complete" : event.child.state;
	const incoming = { ...event.child, state: incomingState, lastUpdate: event.child.lastUpdate ?? event.ts };
	if (!existing) return incoming;
	const existingUpdate = existing.lastUpdate ?? 0;
	const incomingUpdate = incoming.lastUpdate ?? event.ts;
	if (incomingUpdate < existingUpdate)
		return withMergedParentRunOrigin(existing, existing.parentRunOrigin, incoming.parentRunOrigin);
	if (isTerminalNestedRunState(existing.state) && !isTerminalNestedRunState(incoming.state))
		return withMergedParentRunOrigin(existing, existing.parentRunOrigin, incoming.parentRunOrigin);
	if (
		isTerminalNestedRunState(existing.state) &&
		isTerminalNestedRunState(incoming.state) &&
		incomingUpdate === existingUpdate
	)
		return withMergedParentRunOrigin(existing, existing.parentRunOrigin, incoming.parentRunOrigin);
	return withMergedParentRunOrigin(
		{ ...existing, ...incoming, state: incoming.state, lastUpdate: Math.max(existingUpdate, incomingUpdate) },
		existing.parentRunOrigin,
		incoming.parentRunOrigin,
	);
}

function mergeStoredSummary(existing: NestedRunSummary | undefined, incoming: NestedRunSummary): NestedRunSummary {
	if (!existing) return incoming;
	const existingUpdate = existing.lastUpdate ?? 0;
	const incomingUpdate = incoming.lastUpdate ?? 0;
	if (incomingUpdate < existingUpdate)
		return withMergedParentRunOrigin(existing, existing.parentRunOrigin, incoming.parentRunOrigin);
	if (isTerminalNestedRunState(existing.state) && !isTerminalNestedRunState(incoming.state))
		return withMergedParentRunOrigin(existing, existing.parentRunOrigin, incoming.parentRunOrigin);
	return withMergedParentRunOrigin(
		{ ...existing, ...incoming, lastUpdate: Math.max(existingUpdate, incomingUpdate) },
		existing.parentRunOrigin,
		incoming.parentRunOrigin,
	);
}

function canonicalNestedForest(
	rootRunId: string,
	children: NestedRunSummary[],
	pendingChildren: NestedRunSummary[],
	incoming: NestedRunSummary,
): Pick<NestedRegistry, "children" | "pendingChildren"> {
	const summaries = new Map<string, NestedRunSummary>();
	const collect = (run: NestedRunSummary): void => {
		const nested = [...(run.children ?? []), ...(run.steps?.flatMap((step) => step.children ?? []) ?? [])];
		const stripped: NestedRunSummary = { ...run };
		delete stripped.children;
		if (run.steps)
			stripped.steps = run.steps.map((step) => {
				const strippedStep = { ...step };
				delete strippedStep.children;
				return strippedStep;
			});
		summaries.set(run.id, mergeStoredSummary(summaries.get(run.id), stripped));
		for (const child of nested) collect(child);
	};
	for (const run of [...children, ...pendingChildren, incoming]) collect(run);

	const retained = [...summaries.values()]
		.sort((left, right) => {
			const leftLive = isTerminalNestedRunState(left.state) ? 1 : 0;
			const rightLive = isTerminalNestedRunState(right.state) ? 1 : 0;
			return (
				leftLive - rightLive || (right.lastUpdate ?? 0) - (left.lastUpdate ?? 0) || left.id.localeCompare(right.id)
			);
		})
		.slice(0, MAX_CHILDREN);
	const nodes = new Map(
		retained.map((run) => {
			const children: NestedRunSummary[] = [];
			const entry: [string, NestedRunSummary] = [run.id, { ...run, children }];
			return entry;
		}),
	);
	const wouldCycle = (run: NestedRunSummary): boolean => {
		const seen = new Set([run.id]);
		let parentId = run.parentRunId;
		while (parentId !== rootRunId) {
			if (seen.has(parentId)) return true;
			seen.add(parentId);
			const parent = nodes.get(parentId);
			if (!parent) return false;
			parentId = parent.parentRunId;
		}
		return false;
	};
	const roots: NestedRunSummary[] = [];
	const pending: NestedRunSummary[] = [];
	for (const run of nodes.values()) {
		if (run.parentRunId === rootRunId) {
			roots.push(run);
			continue;
		}
		const parent = nodes.get(run.parentRunId);
		if (!parent || wouldCycle(run)) {
			pending.push(run);
			continue;
		}
		parent.children = [...(parent.children ?? []), run].slice(-MAX_CHILDREN);
	}
	const stable = (left: NestedRunSummary, right: NestedRunSummary) =>
		(left.startedAt ?? left.lastUpdate ?? 0) - (right.startedAt ?? right.lastUpdate ?? 0) ||
		left.id.localeCompare(right.id);
	const sortTree = (run: NestedRunSummary): NestedRunSummary => {
		const sorted = { ...run };
		if (run.children?.length) sorted.children = run.children.map(sortTree).sort(stable);
		else delete sorted.children;
		return sorted;
	};
	return {
		children: roots.map(sortTree).sort(stable),
		pendingChildren: pending.map(sortTree).sort(stable),
	};
}

export function applyNestedEvent(registry: NestedRegistry, event: NestedEventRecord): NestedRegistry {
	const existing = findNestedRun([...registry.children, ...registry.pendingChildren], event.child.id);
	const child = mergeSummary(existing, event);
	return {
		...registry,
		updatedAt: Math.max(registry.updatedAt, event.ts),
		...canonicalNestedForest(registry.rootRunId, registry.children, registry.pendingChildren, child),
	};
}

export function findNestedRun(children: NestedRunSummary[] | undefined, id: string): NestedRunSummary | undefined {
	if (!children?.length) return undefined;
	for (const child of children) {
		if (child.id === id) return child;
		const nested =
			findNestedRun(child.children, id) ??
			findNestedRun(
				child.steps?.flatMap((step) => step.children ?? []),
				id,
			);
		if (nested) return nested;
	}
	return undefined;
}

export function attachRootChildrenToSteps<Step extends { children?: NestedRunSummary[] | undefined; index?: number }>(
	rootRunId: string,
	steps: Step[] | undefined,
	children: NestedRunSummary[] | undefined,
): void {
	if (!steps?.length) return;
	for (const step of steps) delete step.children;
	if (!children?.length) return;
	for (const child of children) {
		if (child.parentRunId !== rootRunId || child.parentStepIndex === undefined) continue;
		const step = steps.find((candidate, index) => (candidate.index ?? index) === child.parentStepIndex);
		if (!step) continue;
		step.children ??= [];
		step.children = [...step.children.filter((existing) => existing.id !== child.id), child].slice(-MAX_CHILDREN);
	}
}

export function hasLiveNestedDescendants(children: NestedRunSummary[] | undefined): boolean {
	if (!children?.length) return false;
	for (const child of children) {
		if (!isTerminalNestedRunState(child.state)) return true;
		if (hasLiveNestedDescendants(child.children)) return true;
		if (hasLiveNestedDescendants(child.steps?.flatMap((step) => step.children ?? []))) return true;
	}
	return false;
}

interface NestedOriginProjection {
	readonly parentRunOrigin?: NestedRunSummary["parentRunOrigin"];
	readonly children?: readonly NestedOriginProjection[] | undefined;
	readonly steps?: readonly { readonly children?: readonly NestedOriginProjection[] | undefined }[] | undefined;
}

/** Whether any descendant was directly taken over by user-attributed work. */
export function nestedWorkIncludesUser(children: readonly NestedOriginProjection[] | undefined): boolean {
	for (const child of children ?? []) {
		if (child.parentRunOrigin === "user") return true;
		if (nestedWorkIncludesUser(child.children)) return true;
		if (nestedWorkIncludesUser(child.steps?.flatMap((step) => step.children ?? []))) return true;
	}
	return false;
}
