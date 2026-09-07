import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isRuntimeString } from "../shared/runtime-type.ts";
import {
	type ActivitySummaryMember,
	type PlannedRetrievalGroup,
	type PlannedToolActivityMember,
	type RetrievalGroupDisposition,
	summarizeRetrievalGroup,
	type ToolActivityItem,
	type ToolActivityMetadata,
	type ToolActivitySummary,
	type ToolArguments,
	toolActivityOutcome,
} from "./activity.ts";
import type { ToolActivity, ToolActivityState, ToolActivityStore } from "./activity-store.ts";
import {
	canonicalCountKey,
	type GroupSummaryIndex,
	isIssueState,
	terminalStateFromResult,
	visibleActivityItems,
} from "./activity-summary.ts";
import type {
	OperationEvidenceLine,
	PresentedToolMetadata,
	ToolActivityDetailMode,
	ToolActivityDetailView,
	ToolActivityView,
	ToolDetailPresentation,
	ToolFormattedSection,
} from "./contract.ts";
import type { ToolEnvelopeProjection } from "./envelope-projection.ts";
import { formattedToolSections } from "./formatted-detail.ts";
import type { ToolGroupProjection } from "./group-projection.ts";
import { DETAIL_BYTE_LIMIT, DETAIL_LINE_LIMIT, TOOL_DISPLAY_ITEM_LIMIT, TOOL_DISPLAY_MEDIA_LIMIT } from "./limits.ts";
import { formattedResultLines } from "./registered-tool-renderer.ts";
import type { ToolRowModel } from "./render.ts";
import { sanitizeTerminalText } from "./terminal.ts";
import {
	boundedToolArguments,
	boundedToolResult,
	buildRawToolDetailLines,
	capDetailLines,
	oneLine,
	summarizeBuiltin,
} from "./tool-text.ts";

const GROUP_LIST_LIMIT = 768;

function capSections(sections: readonly ToolFormattedSection[]): readonly ToolFormattedSection[] {
	const flattened: string[] = [];
	let sourceCapped = false;
	for (let sectionIndex = 0; sectionIndex < Math.min(sections.length, DETAIL_LINE_LIMIT); sectionIndex += 1) {
		const section = sections[sectionIndex];
		if (!section) continue;
		flattened.push(`@@pi-stuff-section:${String(sectionIndex)}@@`);
		const remaining = DETAIL_LINE_LIMIT + 1 - flattened.length;
		if (remaining <= 0) {
			sourceCapped = true;
			break;
		}
		for (let lineIndex = 0; lineIndex < Math.min(section.lines.length, remaining); lineIndex += 1) {
			flattened.push(section.lines[lineIndex] ?? "");
		}
		if (section.lines.length > remaining) {
			sourceCapped = true;
			break;
		}
	}
	if (sections.length > DETAIL_LINE_LIMIT) sourceCapped = true;
	if (sourceCapped) flattened.push("… detail source omitted");
	const capped = capDetailLines(flattened, DETAIL_LINE_LIMIT, DETAIL_BYTE_LIMIT);
	const output: Array<{
		languagePath?: string;
		lines: string[];
		operationEvidence?: OperationEvidenceLine[];
		title: string;
	}> = [];
	let current: (typeof output)[number] | undefined;
	let source: ToolFormattedSection | undefined;
	let sourceLineIndex = 0;
	for (const line of capped) {
		const marker = line.match(/^@@pi-stuff-section:(\d+)@@$/u);
		if (marker) {
			source = sections[Number(marker[1])];
			if (!source) continue;
			current = { lines: [], title: source.title };
			if (source.languagePath) current.languagePath = source.languagePath;
			if (source.operationEvidence) current.operationEvidence = [];
			output.push(current);
			sourceLineIndex = 0;
		} else if (current && source) {
			current.lines.push(line);
			if (current.operationEvidence) {
				const sourceLine = sanitizeTerminalText(
					(source.lines[sourceLineIndex] ?? "").slice(0, DETAIL_BYTE_LIMIT * 4),
				);
				const evidence = source.operationEvidence?.[sourceLineIndex];
				if (sanitizeTerminalText(line) === sourceLine && evidence) current.operationEvidence.push(evidence);
			}
			sourceLineIndex += 1;
		}
	}
	return output;
}

export type ResultErrorPolicy = (args: ToolArguments, result: AgentToolResult<unknown>) => boolean;

export interface ToolActivityQueryBinding {
	readonly baseModel: ToolRowModel;
	readonly metadata: PresentedToolMetadata;
}

interface ToolActivityQuerySource {
	readonly activities: ToolActivityStore;
	readonly activityPolicies: ReadonlyMap<string, ToolActivityMetadata<ToolArguments, unknown>>;
	readonly bindingFor: (toolCallId: string) => ToolActivityQueryBinding | undefined;
	readonly detailPresentations: ReadonlyMap<string, ToolDetailPresentation>;
	readonly disposition: (name: string, args: ToolArguments) => RetrievalGroupDisposition;
	readonly envelopes: ToolEnvelopeProjection;
	readonly errorPolicies: ReadonlyMap<string, ResultErrorPolicy>;
	readonly groupSource: () => ToolGroupProjection;
	readonly groupSummary: (group: PlannedRetrievalGroup) => ToolActivitySummary;
	readonly liveResultFor: (toolCallId: string) => AgentToolResult<unknown> | undefined;
}

/** Projects current and historical Tool activity into stable read-side views. */
export class ToolActivityQueryProjection {
	private readonly source: ToolActivityQuerySource;

	constructor(source: ToolActivityQuerySource) {
		this.source = source;
	}

	listGroups(): readonly ToolActivityView[] {
		return this.allGroupViews()
			.sort((left, right) => right.order - left.order)
			.slice(0, GROUP_LIST_LIMIT)
			.map(({ order: _order, ...group }) => group);
	}

	viewsForGroups(groups: readonly PlannedRetrievalGroup[]): readonly ToolActivityView[] {
		const views: ToolActivityView[] = [];
		for (let index = groups.length - 1; index >= 0 && views.length < GROUP_LIST_LIMIT; index -= 1) {
			const group = groups[index];
			const view = group ? this.groupView(group) : undefined;
			if (view) views.push(view);
		}
		return views;
	}

	resolveGroup(query: string): ToolActivityView | "ambiguous" | undefined {
		const normalized = query.trim();
		if (!normalized) return undefined;
		const planned = this.source.groupSource().group(normalized) ?? this.source.groupSource().groupForTool(normalized);
		if (planned) return this.groupView(planned);
		const activity = this.source.activities.get(normalized);
		return activity ? this.standaloneView(activity) : undefined;
	}

	groupActivities(groupId: string): readonly ToolActivity[] {
		return this.groupActivityPage(groupId, 0, Number.POSITIVE_INFINITY);
	}

	groupActivityPage(groupId: string, offset: number, limit: number): readonly ToolActivity[] {
		const start = Math.max(0, Math.floor(offset));
		const requested = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : Number.MAX_SAFE_INTEGER;
		const group = this.source.groupSource().group(groupId);
		if (!group) {
			const standalone = this.source.activities.get(groupId);
			return standalone && start === 0 && requested > 0 ? [standalone] : [];
		}
		return group.members.slice(start, start + requested).map((member) => {
			return this.activityForMember(member);
		});
	}

	toolActivityDetail(toolCallId: string, mode: ToolActivityDetailMode): ToolActivityDetailView | undefined {
		const member = this.source.groupSource().member(toolCallId);
		const binding = this.source.bindingFor(toolCallId);
		const activity = member ? this.activityForMember(member) : this.source.activities.get(toolCallId);
		if (!activity) return undefined;
		const args = member?.args ?? binding?.metadata.args ?? {};
		const rawArgs = this.source.envelopes.rawArgumentsFor(toolCallId) ?? args;
		const name = member?.name ?? binding?.metadata.name ?? activity.name;
		const result = member?.result ?? binding?.metadata.result ?? this.source.liveResultFor(toolCallId);
		const presentation = this.source.detailPresentations.get(name);
		if (name === "codemode" && activity.state === "success") return undefined;
		if (mode === "raw") {
			return {
				activity,
				lines: buildRawToolDetailLines(toolCallId, name, rawArgs, result, presentation?.argumentKeys),
			};
		}
		const presentedArgs = boundedToolArguments(args, presentation?.argumentKeys);
		const presentedResult = result ? boundedToolResult(result) : undefined;
		let lines: readonly string[] | undefined;
		let sections: readonly ToolFormattedSection[] | undefined;
		if (presentedResult && activity.state !== "running" && presentation?.detailSections) {
			try {
				sections = presentation.detailSections(presentedArgs, presentedResult, activity.state);
			} catch {
				// Fall through to the shared semantic projection.
			}
		}
		if (presentedResult && activity.state !== "running" && presentation?.detailLines) {
			try {
				lines = presentation.detailLines(presentedArgs, presentedResult, activity.state);
			} catch {
				// Fall back to bounded result text when an optional formatter fails.
			}
		}
		const fallback =
			lines && lines.length > 0
				? lines
				: presentedResult
					? formattedResultLines(presentedResult, {
							fromResult: activity.summaryFromResult === true,
							text: activity.summary,
						})
					: activity.detailLines.length > 0
						? activity.detailLines
						: ["Details are available after completion."];
		const semantic = capSections(
			sections && sections.length > 0
				? sections
				: presentedResult && activity.state !== "running"
					? formattedToolSections(name, presentedArgs, presentedResult, activity.state, fallback)
					: [{ lines: fallback, title: "Status" }],
		);
		const images: Array<{ data: string; mimeType: string }> = [];
		for (let index = 0; result && index < Math.min(result.content.length, DETAIL_LINE_LIMIT); index += 1) {
			const item = result.content[index];
			if (item?.type === "image" && isRuntimeString(item.data) && isRuntimeString(item.mimeType)) {
				images.push({ data: item.data, mimeType: item.mimeType });
				if (images.length >= TOOL_DISPLAY_MEDIA_LIMIT) break;
			}
		}
		const detail: ToolActivityDetailView = {
			activity,
			lines: semantic.flatMap((section) => section.lines),
			sections: semantic,
		};
		return images && images.length > 0 ? { ...detail, images } : detail;
	}

	summaryMember(member: PlannedToolActivityMember): ActivitySummaryMember {
		const binding = this.source.bindingFor(member.id);
		const forcedTerminal = member.terminalState;
		const state =
			forcedTerminal ??
			(member.result
				? terminalStateFromResult(member, this.source.errorPolicies.get(member.name))
				: (binding?.baseModel.state ?? "running"));
		const metadata: PresentedToolMetadata = {
			...binding?.metadata,
			args: binding?.metadata.args ?? member.args,
			name: member.name,
		};
		if (member.result) Object.assign(metadata, { result: member.result });
		const transparent = this.source.disposition(member.name, metadata.args) === "transparent";
		const silentSuccess = state === "success" && this.isSilentSuccess(member.name);
		const classifiedItems = forcedTerminal || transparent || silentSuccess ? [] : this.classify(metadata, state);
		const items = visibleActivityItems(classifiedItems, state);
		const infrastructureIssue =
			isIssueState(state) && items.length === 0 && (transparent || this.isSilentSuccess(member.name));
		const issueLabel =
			state === "success" || state === "running" || infrastructureIssue
				? undefined
				: (binding?.baseModel.label ?? member.name);
		const issueDetail =
			state === "success" || state === "running"
				? undefined
				: metadata.result
					? this.issueDetail(member.name, metadata.args, metadata.result, state)
					: forcedTerminal
						? state === "cancelled"
							? "Tool call was cancelled before execution"
							: "Tool call failed before execution"
						: (binding?.baseModel.summary ?? issueLabel);
		const summary: ActivitySummaryMember = {
			items,
			state,
		};
		if (issueDetail) Object.assign(summary, { issueDetail });
		if (issueLabel) Object.assign(summary, { issueLabel });
		return summary;
	}

	isSilentSuccess(name: string): boolean {
		return this.source.activityPolicies.get(name)?.silentSuccess === true;
	}

	firstIssueDetail(index: GroupSummaryIndex): string {
		const issueSummary = index.issue();
		return !issueSummary.id || !issueSummary.detail ? "" : oneLine(issueSummary.detail);
	}

	activityFromPlan(member: PlannedToolActivityMember): ToolActivity {
		const state = terminalStateFromResult(member, this.source.errorPolicies.get(member.name));
		const transparent = this.source.disposition(member.name, member.args) === "transparent";
		const metadata: PresentedToolMetadata = { args: member.args, name: member.name };
		if (member.result) Object.assign(metadata, { result: member.result });
		const classifiedItems = transparent || member.terminalState ? [] : this.classify(metadata, state);
		const items = visibleActivityItems(classifiedItems, state);
		const summary = summarizeRetrievalGroup([{ items, state }], state !== "running");
		const presentation = this.source.detailPresentations.get(member.name);
		let label = member.name;
		let target =
			items
				.map((item) => item.target)
				.filter(Boolean)
				.at(-1) ?? "";
		let toolSummary = summary.summary;
		let summaryFromResult = false;
		if (presentation) {
			try {
				label = presentation.label(member.args);
				target = presentation.target(member.args);
				const value = presentation.summary(member.args, member.result, state);
				const projectedSummary = isRuntimeString(value) ? { fromResult: false, text: value } : value;
				toolSummary = projectedSummary.text;
				summaryFromResult = projectedSummary.fromResult;
			} catch {
				// Historical detail remains available with semantic fallbacks.
			}
		}
		return {
			detailLines: [],
			durationMs: undefined,
			id: member.id,
			label,
			name: member.name,
			sequence: 0,
			startedAt: undefined,
			state,
			summary: toolSummary,
			summaryFromResult,
			target,
		};
	}

	private activityForMember(member: PlannedToolActivityMember): ToolActivity {
		const stored = this.source.activities.get(member.id);
		if (!member.result && !member.terminalState) return stored ?? this.activityFromPlan(member);
		const settled = this.activityFromPlan(member);
		return stored
			? {
					...settled,
					detailLines: stored.detailLines,
					durationMs: stored.durationMs,
					sequence: stored.sequence,
					startedAt: stored.startedAt,
				}
			: settled;
	}

	private allGroupViews(): Array<ToolActivityView & { order: number }> {
		const groups = this.source.groupSource().groupsInOrder();
		const grouped = groups
			.map((group) => this.groupView(group))
			.filter((group): group is ToolActivityView => group !== undefined)
			.map((group, order) => ({ ...(group.summary ? group : { ...group, summary: "Internal activity" }), order }));
		const covered = new Set(grouped.flatMap((group) => group.memberIds));
		const standalone = this.source.activities
			.list()
			.filter((activity) => !covered.has(activity.id))
			.map((activity) => ({ ...this.standaloneView(activity), order: groups.length + activity.sequence }));
		return [...grouped, ...standalone];
	}

	private standaloneView(activity: ToolActivity): ToolActivityView {
		return {
			id: activity.id,
			label: activity.label,
			memberIds: [activity.id],
			operation: activity.target,
			outcome: activity.summary,
			state:
				activity.state === "rejected" || activity.state === "cancelled"
					? activity.state
					: toolActivityOutcome(activity.state),
			summary: activity.label,
		};
	}

	private groupView(group: PlannedRetrievalGroup): ToolActivityView | undefined {
		if (group.standalone) {
			const member = group.members[0];
			if (!member) return undefined;
			const activity = this.activityForMember(member);
			if (member.name === "codemode" && activity.state === "success") return undefined;
			return {
				id: group.leaderId,
				label: activity.label,
				memberIds: [member.id],
				operation: activity.target,
				outcome: activity.summary,
				state:
					activity.state === "rejected" || activity.state === "cancelled"
						? activity.state
						: toolActivityOutcome(activity.state),
				summary: activity.summary ? `${activity.label} · ${activity.summary}` : activity.label,
			};
		}
		const summary = this.source.groupSummary(group);
		const members = group.members.map((member) => this.activityForMember(member));
		const labels = new Set(members.map((activity) => activity.label));
		const states = group.members.map((member) => this.summaryMember(member).state);
		const state = states.every((candidate) => candidate === "rejected")
			? "rejected"
			: states.every((candidate) => candidate === "cancelled")
				? "cancelled"
				: summary.outcome;
		const continuedSummary = `${group.continuedFromPrevious ? "Continued · " : ""}${summary.summary}${
			group.continuesToNext ? " · continues" : ""
		}`;
		return {
			id: group.leaderId,
			label: labels.size === 1 ? (members[0]?.label ?? "Tools") : "Tools",
			memberIds: group.members.map((member) => member.id),
			operation: summary.target,
			outcome: continuedSummary,
			state,
			summary: continuedSummary,
		};
	}

	private issueDetail(
		name: string,
		args: ToolArguments,
		result: AgentToolResult<unknown>,
		state: Exclude<ToolActivityState, "running" | "success">,
	): string {
		const summarizeIssue = this.source.activityPolicies.get(name)?.summarizeIssue;
		const presentation = this.source.detailPresentations.get(name);
		const presentedArgs = boundedToolArguments(args, presentation?.argumentKeys);
		const presentedResult = boundedToolResult(result);
		if (summarizeIssue) {
			try {
				const summary = oneLine(summarizeIssue(presentedArgs, presentedResult, state));
				if (summary) return summary;
			} catch {
				// Keep the compact projection available when optional semantic extraction fails.
			}
		}
		for (const item of presentedResult.content) {
			if (item.type !== "text") continue;
			const summary = oneLine(item.text.split(/\r?\n/u)[0] ?? "");
			if (summary) return summary;
		}
		return summarizeBuiltin(name, presentedArgs, presentedResult, state, undefined);
	}

	private classify(metadata: PresentedToolMetadata, state: ToolActivityState): readonly ToolActivityItem[] {
		const policy = this.source.activityPolicies.get(metadata.name);
		if (!policy) return [];
		try {
			const presentation = this.source.detailPresentations.get(metadata.name);
			const input = { args: boundedToolArguments(metadata.args, presentation?.argumentKeys), state };
			if (metadata.cwd) Object.assign(input, { cwd: metadata.cwd });
			if (metadata.result) Object.assign(input, { result: boundedToolResult(metadata.result) });
			const classified = policy.classify(input);
			const items: ToolActivityItem[] = [];
			for (let index = 0; index < Math.min(classified.length, TOOL_DISPLAY_ITEM_LIMIT); index += 1) {
				const item = classified[index];
				if (!item) continue;
				const projected: ToolActivityItem = { category: item.category };
				if (item.count !== undefined) Object.assign(projected, { count: item.count });
				if (item.detail) Object.assign(projected, { detail: oneLine(item.detail) });
				if (item.target) Object.assign(projected, { target: oneLine(item.target) });
				if (item.countKeys) {
					Object.assign(projected, {
						countKeys: item.countKeys
							.slice(0, TOOL_DISPLAY_ITEM_LIMIT)
							.map((key) => canonicalCountKey(item.category, oneLine(key), metadata.cwd)),
					});
				}
				items.push(projected);
			}
			return items;
		} catch {
			return [];
		}
	}
}
