import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	type PlannedRetrievalGroup,
	type PlannedToolActivityMember,
	type RetrievalGroupDisposition,
	summarizeToolActivityAggregate,
	type ToolActivityMetadata,
	type ToolArguments,
} from "./activity.ts";
import { type ActivityClockWakes, ToolActivityClock } from "./activity-clock.ts";
import {
	type ResultErrorPolicy,
	type ToolActivityQueryBinding,
	ToolActivityQueryProjection,
} from "./activity-query-projection.ts";
import { type ToolActivity, ToolActivityStore } from "./activity-store.ts";
import { GroupSummaryIndex } from "./activity-summary.ts";
import { presentBashOperation } from "./bash-operation-presentation.ts";
import type {
	PresentedToolMetadata,
	ToolActivityDetailMode,
	ToolActivityDetailView,
	ToolActivityView,
	ToolDetailPresentation,
} from "./contract.ts";
import type { ToolEnvelopeProjection } from "./envelope-projection.ts";
import type { ToolGroupProjection } from "./group-projection.ts";
import { isOperationBlockMember, operationBlockModel } from "./operation-block-presentation.ts";
import type { CachedToolRow, RetrievalGroupRowModel, ToolRowModel } from "./render.ts";
import type { ToolUiSettingsStore } from "./settings.ts";
import { formatElapsed } from "./tool-text.ts";

const ACTIVITY_HINT_HOLD_MS = 700;
const BINDING_LIMIT = 768;

export interface ToolHistoryPage {
	readonly hasOlder: boolean;
	readonly messages: readonly unknown[];
}

interface GroupedRowBinding extends ToolActivityQueryBinding {
	bashOutput?: string;
	bashOutputExpanded?: boolean;
	bashOutputResult?: AgentToolResult<unknown>;
	bashOutputTruncated?: boolean;
	baseModel: ToolRowModel;
	baseVisible: boolean;
	expanded: boolean;
	invalidate: () => void;
	metadata: PresentedToolMetadata;
	row: CachedToolRow;
	startedAt: number | undefined;
}

interface HintState {
	candidate: string;
	shownAt: number;
	value: string;
}

export class ToolActivityPresentation {
	readonly activities = new ToolActivityStore();
	private readonly bindings = new Map<string, GroupedRowBinding>();
	private readonly clock: ToolActivityClock;
	private readonly groupSource: () => ToolGroupProjection;
	private readonly groupHints = new Map<string, HintState>();
	private readonly groupSummaries = new Map<string, GroupSummaryIndex>();
	private invalidationGeneration = 0;
	private invalidationScheduled = false;
	private readonly isRendered: (name: string) => boolean;
	private readonly liveResults = new Map<string, AgentToolResult<unknown>>();
	private hasOlderHistoryPage = false;
	private historyLoader: (() => ToolHistoryPage | undefined) | undefined;
	private readonly now: () => number;
	private readonly pendingInvalidations = new Set<() => void>();
	private readonly query: ToolActivityQueryProjection;
	private settings: ToolUiSettingsStore;

	constructor(
		groupSource: () => ToolGroupProjection,
		envelopes: ToolEnvelopeProjection,
		activityPolicies: ReadonlyMap<string, ToolActivityMetadata<ToolArguments, unknown>>,
		detailPresentations: ReadonlyMap<string, ToolDetailPresentation>,
		errorPolicies: ReadonlyMap<string, ResultErrorPolicy>,
		disposition: (name: string, args: ToolArguments) => RetrievalGroupDisposition,
		isRendered: (name: string) => boolean,
		settings: ToolUiSettingsStore,
		now: () => number,
	) {
		this.groupSource = groupSource;
		this.isRendered = isRendered;
		this.settings = settings;
		this.now = now;
		this.query = new ToolActivityQueryProjection({
			activities: this.activities,
			activityPolicies,
			bindingFor: (toolCallId) => this.bindings.get(toolCallId),
			detailPresentations,
			disposition,
			envelopes,
			errorPolicies,
			groupSource,
			groupSummary: (group) => summarizeToolActivityAggregate(this.summaryIndex(group).aggregate(), group.closed),
			liveResultFor: (toolCallId) => this.liveResults.get(toolCallId),
		});
		this.clock = new ToolActivityClock({
			leaderIdFor: (toolCallId) => this.groups().leaderIdFor(toolCallId),
			reconcileLeader: (leaderId) => this.reconcileGroup(this.groups().group(leaderId)),
			reconcileTool: (toolCallId) => this.reconcileGroupForTool(toolCallId),
			runningMemberId: (leaderId) => this.runningMemberId(leaderId),
			setLeaderMarker: (leaderId, visible, invalidate) => this.setLeaderMarker(leaderId, visible, invalidate),
		});
	}

	configure(settings: ToolUiSettingsStore): void {
		this.suspend();
		this.settings = settings;
	}

	showLiveElapsed(): boolean {
		return this.settings.get().liveElapsed;
	}

	protected discardBindings(): void {
		this.bindings.clear();
	}

	protected shouldQueueResult(toolCallId: string): boolean {
		const binding = this.bindings.get(toolCallId);
		return Boolean(binding && this.isRendered(binding.metadata.name));
	}

	observeToolExecutionStart(toolCallId: string): void {
		this.liveResults.delete(toolCallId);
		this.groups().discardPendingResult(toolCallId);
		const binding = this.bindings.get(toolCallId);
		if (!binding?.metadata.result) return;
		const { result: _result, ...metadata } = binding.metadata;
		binding.metadata = metadata;
		delete binding.bashOutput;
		delete binding.bashOutputResult;
	}

	observeToolExecutionUpdate(toolCallId: string, result: AgentToolResult<unknown>): void {
		if (this.liveResults.get(toolCallId) === result) return;
		this.liveResults.set(toolCallId, result);
		const binding = this.bindings.get(toolCallId);
		if (!binding) return;
		binding.metadata = { ...binding.metadata, result };
		this.reconcileGroupForTool(toolCallId);
	}

	observeToolExecutionEnd(toolCallId: string, result: AgentToolResult<unknown>): void {
		this.liveResults.delete(toolCallId);
		const binding = this.bindings.get(toolCallId);
		if (binding) binding.metadata = { ...binding.metadata, result };
		this.groups().updateToolResult(toolCallId, result);
	}

	protected resetActivityProjection(): void {
		this.suspend();
		this.groupHints.clear();
		this.activities.clear();
	}

	protected groupsRebuilt(): void {
		this.groupSummaries.clear();
		const groups = this.groups().groupsInOrder();
		for (const group of groups) this.reconcileGroup(group);
		for (const [toolCallId, binding] of this.bindings) {
			if (!this.groups().leaderIdFor(toolCallId)) this.applyBinding(binding, binding.baseModel, binding.baseVisible);
		}
		const leaderIds = new Set(groups.map((group) => group.leaderId));
		for (const leaderId of Array.from(this.groupHints.keys())) {
			if (!leaderIds.has(leaderId)) this.groupHints.delete(leaderId);
		}
		this.clock.pruneGroups(leaderIds);
	}

	protected retainBindings(toolCallIds: ReadonlySet<string>): void {
		for (const toolCallId of this.bindings.keys()) {
			if (!toolCallIds.has(toolCallId)) this.bindings.delete(toolCallId);
		}
	}

	clear(): void {
		this.suspend();
		this.historyLoader = undefined;
		this.hasOlderHistoryPage = false;
		for (const binding of this.bindings.values()) this.applyBinding(binding, binding.baseModel, binding.baseVisible);
		this.bindings.clear();
		this.groupSummaries.clear();
		this.groupHints.clear();
		this.activities.clear();
	}

	suspend(): void {
		this.clock.suspend();
		this.invalidationGeneration += 1;
		this.invalidationScheduled = false;
		this.pendingInvalidations.clear();
		this.liveResults.clear();
	}

	presentRow(
		toolCallId: string,
		row: CachedToolRow,
		model: ToolRowModel,
		visible: boolean,
		invalidate: () => void,
		expanded: boolean,
		metadata: PresentedToolMetadata,
	): void {
		let binding = this.bindings.get(toolCallId);
		const projectedResult = metadata.result ?? this.liveResults.get(toolCallId) ?? binding?.metadata.result;
		const projectedMetadata = projectedResult === undefined ? metadata : { ...metadata, result: projectedResult };
		if (!binding) {
			binding = {
				baseModel: model,
				baseVisible: visible,
				expanded,
				invalidate,
				metadata: projectedMetadata,
				row,
				startedAt: model.state === "running" ? this.now() : undefined,
			};
		} else {
			binding.row = row;
			binding.baseModel = model;
			binding.baseVisible = visible;
			binding.expanded = expanded;
			binding.invalidate = invalidate;
			binding.metadata = projectedMetadata;
			if (binding.startedAt === undefined && model.state === "running") binding.startedAt = this.now();
		}
		this.bindings.delete(toolCallId);
		this.bindings.set(toolCallId, binding);
		this.reconcileGroupForTool(toolCallId, projectedMetadata.result !== this.groups().projectedResult(toolCallId));
		this.trimBindings(toolCallId);
	}

	updateProjectedRow(
		toolCallId: string,
		row: CachedToolRow,
		model: ToolRowModel,
		visible: boolean,
		invalidate: () => void,
		expanded: boolean,
		metadata: PresentedToolMetadata,
	): boolean {
		const binding = this.bindings.get(toolCallId);
		if (!binding) return false;
		Object.assign(binding, { baseModel: model, baseVisible: visible, expanded, invalidate, metadata, row });
		if (binding.startedAt === undefined && model.state === "running") binding.startedAt = this.now();
		this.bindings.delete(toolCallId);
		this.bindings.set(toolCallId, binding);
		const group = this.groups().groupForTool(toolCallId);
		if (expanded || group?.standalone) this.reconcileGroupForTool(toolCallId, false);
		return true;
	}

	setRowExpanded(toolCallId: string, expanded: boolean): void {
		const binding = this.bindings.get(toolCallId);
		if (!binding || binding.expanded === expanded) return;
		binding.expanded = expanded;
		this.reconcileGroupForTool(toolCallId);
	}

	startTimer(
		toolCallId: string,
		invalidate: () => void,
		setMarkerVisible: (visible: boolean) => void = () => {},
	): void {
		this.clock.start(toolCallId, invalidate, setMarkerVisible);
	}

	stopTimer(toolCallId: string): void {
		this.clock.stop(toolCallId);
	}

	syncTimers(): void {
		this.clock.sync();
	}

	bindTimerWakes(wakes: ActivityClockWakes): () => void {
		return this.clock.bindWakes(wakes);
	}

	hasGroupPulseTimers(): boolean {
		return this.clock.hasGroupPulses();
	}

	hasToolTimers(): boolean {
		return this.clock.hasToolTimers();
	}

	tickGroupPulseTimers(): void {
		this.clock.tickGroupPulses();
	}

	tickToolTimers(): void {
		this.clock.tickToolTimers();
	}

	listGroups(): readonly ToolActivityView[] {
		return this.query.listGroups();
	}

	configureHistoryLoader(loader: (() => ToolHistoryPage | undefined) | undefined, hasOlder: boolean): void {
		this.historyLoader = loader;
		this.hasOlderHistoryPage = hasOlder;
	}

	hasOlderHistory(): boolean {
		return this.hasOlderHistoryPage;
	}

	loadOlderActivities(): readonly ToolActivityView[] {
		const page = this.historyLoader?.();
		if (!page) {
			this.hasOlderHistoryPage = false;
			return [];
		}
		this.hasOlderHistoryPage = page.hasOlder;
		return this.query.viewsForGroups(this.groups().prependHistoryPage(page.messages));
	}

	resolveGroup(query: string): ToolActivityView | "ambiguous" | undefined {
		return this.query.resolveGroup(query);
	}

	groupActivities(groupId: string): readonly ToolActivity[] {
		return this.query.groupActivities(groupId);
	}

	groupActivityPage(groupId: string, offset: number, limit: number): readonly ToolActivity[] {
		return this.query.groupActivityPage(groupId, offset, limit);
	}

	toolActivityDetail(toolCallId: string, mode: ToolActivityDetailMode): ToolActivityDetailView | undefined {
		return this.query.toolActivityDetail(toolCallId, mode);
	}

	protected dropGroup(leaderId: string): void {
		this.clock.dropGroup(leaderId);
		this.groupSummaries.delete(leaderId);
		this.groupHints.delete(leaderId);
	}

	reconcileGroupForTool(toolCallId: string, semanticChange = true): void {
		const group = this.groups().groupForTool(toolCallId);
		if (!group) {
			const binding = this.bindings.get(toolCallId);
			if (binding) this.applyBinding(binding, binding.baseModel, binding.baseVisible);
			return;
		}
		this.reconcileGroup(group, semanticChange ? toolCallId : undefined);
	}

	protected reconcileGroup(group: PlannedRetrievalGroup | undefined, changedMemberId?: string): void {
		if (!group) return;
		const leader = this.bindings.get(group.leaderId);
		if (group.standalone) {
			if (!leader) return;
			this.clock.dropGroup(group.leaderId);
			const member = group.members[0];
			if (member?.name === "bash") this.applyBashOperation(member, leader);
			else if (member && isOperationBlockMember(member.name, member.args)) this.applyOperationBlock(member, leader);
			else {
				const silentSuccess =
					member !== undefined &&
					this.query.summaryMember(member).state === "success" &&
					this.query.isSilentSuccess(member.name);
				this.applyBinding(leader, leader.baseModel, leader.baseVisible && (!silentSuccess || leader.expanded));
			}
			return;
		}
		const index = this.summaryIndex(group, changedMemberId);
		if (!leader) {
			for (const member of group.members.slice(1)) {
				const binding = this.bindings.get(member.id);
				if (!binding) continue;
				if (binding.expanded) this.applyBinding(binding, binding.baseModel, true);
				else if (binding.row.setVisible(false)) this.scheduleInvalidation(binding.invalidate);
			}
			return;
		}
		if (leader.expanded) {
			this.clock.dropGroup(group.leaderId);
			for (const member of group.members) {
				const binding = this.bindings.get(member.id);
				if (!binding) continue;
				if (member.name === "bash") this.applyBashOperation(member, binding);
				else if (isOperationBlockMember(member.name, member.args)) this.applyOperationBlock(member, binding);
				else this.applyBinding(binding, binding.baseModel, true);
			}
			return;
		}
		const summary = summarizeToolActivityAggregate(index.aggregate(), group.closed);
		this.clock.reconcileGroup(group, summary.active);
		const model: RetrievalGroupRowModel = {
			active: summary.active,
			elapsed: this.groupElapsed(group),
			expandable: true,
			issueDetail: this.query.firstIssueDetail(index),
			issueText: summary.semanticSummary ? summary.issueText : summary.summary,
			kind: "activity",
			outcome: summary.outcome,
			semanticSummary: summary.semanticSummary,
			summary: summary.summary,
			target: this.stableTarget(group.leaderId, summary.target, summary.active),
		};
		const modelChanged = leader.row.setModel(model);
		const visibilityChanged = leader.row.setVisible(Boolean(summary.summary));
		if (modelChanged || visibilityChanged) this.scheduleInvalidation(leader.invalidate);
		for (const member of group.members.slice(1)) {
			const binding = this.bindings.get(member.id);
			if (!binding) continue;
			if (binding.expanded) this.applyBinding(binding, binding.baseModel, true);
			else if (binding.row.setVisible(false)) this.scheduleInvalidation(binding.invalidate);
		}
	}

	private groups(): ToolGroupProjection {
		return this.groupSource();
	}

	private applyBashOperation(member: PlannedToolActivityMember, binding: GroupedRowBinding): void {
		presentBashOperation(
			member,
			binding,
			member.result ?? binding.metadata.result,
			this.query.summaryMember(member).state,
			() => this.scheduleInvalidation(binding.invalidate),
		);
	}

	private applyOperationBlock(member: PlannedToolActivityMember, binding: GroupedRowBinding): void {
		const model = operationBlockModel(
			member,
			member.result ?? binding.metadata.result,
			this.query.summaryMember(member).state,
			binding.expanded,
		);
		if (!model) return;
		const modelChanged = binding.row.setModel(model);
		const visibilityChanged = binding.row.setVisible(true);
		if (modelChanged || visibilityChanged) this.scheduleInvalidation(binding.invalidate);
	}

	private summaryIndex(group: PlannedRetrievalGroup, changedMemberId?: string): GroupSummaryIndex {
		let index = this.groupSummaries.get(group.leaderId);
		if (!index) {
			index = new GroupSummaryIndex();
			this.groupSummaries.set(group.leaderId, index);
		}
		for (let memberIndex = index.size; memberIndex < group.members.length; memberIndex += 1) {
			const member = group.members[memberIndex];
			if (member) index.upsert(member.id, memberIndex, this.query.summaryMember(member));
		}
		if (changedMemberId) {
			const memberIndex = this.groups().memberIndex(changedMemberId);
			const member = memberIndex === undefined ? undefined : group.members[memberIndex];
			if (member && memberIndex !== undefined)
				index.upsert(member.id, memberIndex, this.query.summaryMember(member));
		}
		return index;
	}

	private groupElapsed(group: PlannedRetrievalGroup): string {
		if (!this.showLiveElapsed()) return "";
		for (let index = group.members.length - 1; index >= 0; index -= 1) {
			const binding = this.bindings.get(group.members[index]?.id ?? "");
			if (binding?.baseModel.state !== "running") continue;
			const elapsed = Math.max(
				binding.baseModel.durationMs ?? 0,
				binding.startedAt === undefined ? 0 : this.now() - binding.startedAt,
			);
			return elapsed < 2_000 ? "" : formatElapsed(elapsed);
		}
		return "";
	}

	private stableTarget(leaderId: string, candidate: string, active: boolean): string {
		if (!active || !candidate) {
			if (!active) this.groupHints.delete(leaderId);
			return "";
		}
		const now = this.now();
		let state = this.groupHints.get(leaderId);
		if (!state) {
			state = { candidate, shownAt: now, value: "" };
			this.groupHints.set(leaderId, state);
			return state.value;
		}
		if (candidate !== state.candidate) {
			state.candidate = candidate;
			state.shownAt = now;
			return state.value;
		}
		if (candidate !== state.value && now - state.shownAt >= ACTIVITY_HINT_HOLD_MS) state.value = candidate;
		return state.value;
	}

	private trimBindings(currentToolCallId: string): void {
		const protectedIds = new Set([currentToolCallId]);
		const leaderId = this.groups().leaderIdFor(currentToolCallId);
		if (leaderId) protectedIds.add(leaderId);
		while (this.bindings.size > BINDING_LIMIT) {
			let oldest: string | undefined;
			for (const id of this.bindings.keys()) {
				if (!protectedIds.has(id)) {
					oldest = id;
					break;
				}
			}
			if (!oldest) return;
			this.bindings.delete(oldest);
		}
	}

	private applyBinding(binding: GroupedRowBinding, model: ToolRowModel, visible: boolean): void {
		const modelChanged = binding.row.setModel(model);
		const visibilityChanged = binding.row.setVisible(visible);
		if (modelChanged || visibilityChanged) this.scheduleInvalidation(binding.invalidate);
	}

	private scheduleInvalidation(invalidate: () => void): void {
		this.pendingInvalidations.add(invalidate);
		if (this.invalidationScheduled) return;
		this.invalidationScheduled = true;
		const generation = this.invalidationGeneration;
		queueMicrotask(() => {
			if (generation !== this.invalidationGeneration) return;
			this.invalidationScheduled = false;
			const invalidations = [...this.pendingInvalidations];
			this.pendingInvalidations.clear();
			for (const pending of invalidations) pending();
		});
	}

	private runningMemberId(leaderId: string): string | undefined {
		return this.groups()
			.group(leaderId)
			?.members.find((member) => this.bindings.get(member.id)?.baseModel.state === "running")?.id;
	}

	private setLeaderMarker(leaderId: string, visible: boolean, invalidate: boolean): void {
		const leader = this.bindings.get(leaderId);
		if (leader?.row.setMarkerVisible(visible) && invalidate) this.scheduleInvalidation(leader.invalidate);
	}
}
