import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isRuntimeString } from "../shared/runtime-type.ts";
import type {
	PlannedRetrievalGroup,
	PlannedToolActivityMember,
	RetrievalGroupDisposition,
	ToolArguments,
} from "./activity.ts";
import { assistantTerminalState, isIssueState, terminalStateFromResult } from "./activity-summary.ts";
import type { SuiteToolEnvelopeDetails } from "./contract.ts";
import type { ToolEnvelopeProjection } from "./envelope-projection.ts";
import { envelopeOperationResult } from "./envelope-renderer.ts";
import { TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT, TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT } from "./limits.ts";
import {
	boundedToolTranscript,
	directBashCancelledByHostAbort,
	planRetrievalPage,
	RETRIEVAL_GROUP_MEMBER_LIMIT,
} from "./retrieval-groups.ts";
import { isRecordValue, isToolArguments } from "./tool-value.ts";

const PENDING_RESULT_LIMIT = 768;
const GROUP_PROJECTION_LIMIT = 768;
const STREAM_BOUNDARY_SCAN_LIMIT = 1_024;

function hasBoundedStreamText(value: string): boolean {
	const source = value.slice(0, STREAM_BOUNDARY_SCAN_LIMIT);
	return source.trim().length > 0 || source.length < value.length;
}

type ResultErrorPolicy = (args: ToolArguments, result: AgentToolResult<unknown>) => boolean;
type GroupProjectionHooks = {
	groupChanged: (group: PlannedRetrievalGroup | undefined, changedMemberId?: string) => void;
	groupRemoved: (leaderId: string) => void;
	groupsRebuilt: () => void;
	liveResult: (toolCallId: string, result: AgentToolResult<unknown>) => void;
	shouldQueueResult: (toolCallId: string) => boolean;
	stopTimer: (toolCallId: string) => void;
};

export class ToolGroupProjection {
	private agentActive = false;
	private readonly groupOrder: string[] = [];
	private readonly groups = new Map<string, PlannedRetrievalGroup>();
	private readonly historicalGroupIds: string[] = [];
	private readonly historicalGroups = new Map<string, PlannedRetrievalGroup>();
	private readonly historicalMemberIndexes = new Map<string, number>();
	private readonly historicalMembership = new Map<string, string>();
	private readonly historicalResultMessages = new Map<string, unknown>();
	private historyHeadCanContinue = false;
	private indexedMessages: unknown[] = [];
	private readonly membership = new Map<string, string>();
	private readonly memberIndexes = new Map<string, number>();
	private openGroupLeaderId: string | undefined;
	private readonly pendingResults = new Map<string, AgentToolResult<unknown>>();
	private readonly disposition: (name: string, args: ToolArguments) => RetrievalGroupDisposition;
	private readonly envelopes: ToolEnvelopeProjection;
	private readonly hooks: GroupProjectionHooks;
	private readonly resultIsError: (name: string) => ResultErrorPolicy | undefined;
	private streamActive = false;
	private readonly streamedProseIndexes = new Set<number>();
	private readonly streamedThinkingIndexes = new Set<number>();
	private tailForcedClosed = false;

	constructor(
		envelopes: ToolEnvelopeProjection,
		disposition: (name: string, args: ToolArguments) => RetrievalGroupDisposition,
		resultIsError: (name: string) => ResultErrorPolicy | undefined,
		hooks: GroupProjectionHooks,
	) {
		this.envelopes = envelopes;
		this.disposition = disposition;
		this.resultIsError = resultIsError;
		this.hooks = hooks;
	}

	hasMessages(): boolean {
		return this.indexedMessages.length > 0;
	}

	group(leaderId: string): PlannedRetrievalGroup | undefined {
		return this.groups.get(leaderId) ?? this.historicalGroups.get(leaderId);
	}

	groupForTool(toolCallId: string): PlannedRetrievalGroup | undefined {
		const leaderId = this.membership.get(toolCallId) ?? this.historicalMembership.get(toolCallId);
		return leaderId ? this.group(leaderId) : undefined;
	}

	groupsInOrder(): readonly PlannedRetrievalGroup[] {
		return this.groupOrder
			.map((leaderId) => this.groups.get(leaderId))
			.filter((group): group is PlannedRetrievalGroup => group !== undefined);
	}

	leaderIdFor(toolCallId: string): string | undefined {
		return this.membership.get(toolCallId) ?? this.historicalMembership.get(toolCallId);
	}

	member(toolCallId: string): PlannedToolActivityMember | undefined {
		const group = this.groupForTool(toolCallId);
		const memberIndex = this.memberIndexes.get(toolCallId) ?? this.historicalMemberIndexes.get(toolCallId);
		return memberIndex === undefined ? undefined : group?.members[memberIndex];
	}

	memberIndex(toolCallId: string): number | undefined {
		return this.memberIndexes.get(toolCallId) ?? this.historicalMemberIndexes.get(toolCallId);
	}

	memberIds(): ReadonlySet<string> {
		const ids = new Set<string>();
		for (const leaderId of this.groupOrder) {
			for (const member of this.groups.get(leaderId)?.members ?? []) ids.add(member.id);
		}
		return ids;
	}

	projectedResult(toolCallId: string): AgentToolResult<unknown> | undefined {
		return this.member(toolCallId)?.result;
	}

	discardPendingResult(toolCallId: string): void {
		this.pendingResults.delete(toolCallId);
	}

	startTurn(messages?: readonly unknown[]): void {
		this.agentActive = true;
		this.tailForcedClosed = false;
		if (messages) {
			this.indexedMessages = messages.slice(-TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT);
			this.rebuild();
		}
	}

	observeUserBoundary(): void {
		this.indexedMessages.push({ role: "user", content: [] });
		if (this.indexedMessages.length > TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT) this.indexedMessages.shift();
		this.tailForcedClosed = true;
		this.closeOpenGroup();
	}

	endTurn(): void {
		this.agentActive = false;
		this.tailForcedClosed = true;
		this.closeOpenGroup();
	}

	private observeAssistantProse(): void {
		this.tailForcedClosed = true;
		this.closeOpenGroup();
	}

	observeAssistantEvent(event: AssistantMessageEvent): void {
		this.beginStream();
		if (event.type === "text_delta" || event.type === "text_end") {
			const text = event.type === "text_delta" ? event.delta : event.content;
			if (!hasBoundedStreamText(text) || this.streamedProseIndexes.has(event.contentIndex)) return;
			this.streamedProseIndexes.add(event.contentIndex);
			this.observeAssistantProse();
			return;
		}
		if (event.type === "thinking_delta" || event.type === "thinking_end") {
			const thinking = event.type === "thinking_delta" ? event.delta : event.content;
			if (!hasBoundedStreamText(thinking) || this.streamedThinkingIndexes.has(event.contentIndex)) return;
			this.streamedThinkingIndexes.add(event.contentIndex);
			this.observeAssistantProse();
			return;
		}
		if (event.type !== "toolcall_end") return;
		const { id, name, arguments: args } = event.toolCall;
		if (!id || !name || !isToolArguments(args)) return;
		this.appendToolCall({ args, id, name });
	}

	indexMessages(messages: readonly unknown[], closeTail = !this.agentActive): void {
		this.pendingResults.clear();
		this.indexedMessages = messages.slice(-TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT);
		this.tailForcedClosed = closeTail;
		this.rebuild();
	}

	indexMessage<Message>(message: Message): void {
		this.indexedMessages.push(message);
		if (this.indexedMessages.length > TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT) this.indexedMessages.shift();
		this.applyMessage(message);
		if (isRecordValue(message) && message.role === "assistant") this.endStream();
	}

	observeEnvelopeResult(envelopeName: string, envelopeId: string, details: SuiteToolEnvelopeDetails): void {
		for (const operation of this.envelopes.claimOperations(envelopeName, envelopeId, details)) {
			if (operation.state === "running" && operation.result) this.hooks.liveResult(operation.id, operation.result);
			const result = envelopeOperationResult(operation);
			const member: PlannedToolActivityMember = {
				args: operation.args,
				id: operation.id,
				name: operation.name,
			};
			if (result) Object.assign(member, { result });
			this.appendToolCall(member);
		}
	}

	updateToolResult(id: string, result: AgentToolResult<unknown>): void {
		const group = this.groupForTool(id);
		const memberIndex = this.memberIndexes.get(id);
		if (!group || memberIndex === undefined) {
			if (this.hooks.shouldQueueResult(id)) {
				this.pendingResults.set(id, result);
				while (this.pendingResults.size > PENDING_RESULT_LIMIT) {
					const oldest = this.pendingResults.keys().next().value;
					if (oldest === undefined) break;
					this.pendingResults.delete(oldest);
				}
			}
			return;
		}
		const previous = group.members[memberIndex];
		if (!previous) return;
		const updated: PlannedToolActivityMember = {
			args: previous.args,
			id: previous.id,
			name: previous.name,
			result,
		};
		this.mutableMembers(group)[memberIndex] = updated;
		if (this.isTransparentIssue(updated)) {
			this.splitGroupAtIssue(group, memberIndex);
			return;
		}
		this.hooks.groupChanged(group, id);
	}

	rebuild(): boolean {
		this.groups.clear();
		this.groupOrder.splice(0);
		this.membership.clear();
		this.memberIndexes.clear();
		this.openGroupLeaderId = undefined;
		const page = planRetrievalPage(
			this.envelopes.projectMessages(boundedToolTranscript(this.indexedMessages)),
			this.disposition,
			!this.agentActive || this.tailForcedClosed,
		);
		for (const group of page.groups) {
			this.groups.set(group.leaderId, group);
			this.groupOrder.push(group.leaderId);
			group.members.forEach((member, index) => {
				this.membership.set(member.id, group.leaderId);
				this.memberIndexes.set(member.id, index);
			});
			if (!group.closed) this.openGroupLeaderId = group.leaderId;
		}
		this.hooks.groupsRebuilt();
		return page.headCanContinue;
	}

	prependHistoryPage(messages: readonly unknown[]): readonly PlannedRetrievalGroup[] {
		const boundedMessages = messages.slice(-TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT);
		const existingOldestId = this.historicalGroupIds.at(-1) ?? this.groupOrder[0];
		const existingOldest = existingOldestId ? this.group(existingOldestId) : undefined;
		const resultIds = this.rememberHistoricalResults(boundedMessages);
		const supplementalResults: unknown[] = [];
		let remainingBlocks = TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT;
		for (let messageIndex = 0; messageIndex < boundedMessages.length && remainingBlocks > 0; messageIndex += 1) {
			const message = boundedMessages[messageIndex];
			if (!isRecordValue(message) || message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (let blockIndex = 0; blockIndex < message.content.length && remainingBlocks > 0; blockIndex += 1) {
				remainingBlocks -= 1;
				const block = message.content[blockIndex];
				if (!isRecordValue(block) || block.type !== "toolCall" || !isRuntimeString(block.id)) continue;
				const result = this.historicalResultMessages.get(block.id);
				if (result && !resultIds.has(block.id)) supplementalResults.push(result);
				if (result) {
					resultIds.add(block.id);
					this.historicalResultMessages.delete(block.id);
				}
			}
		}
		const plannedPage = planRetrievalPage(
			this.envelopes.projectMessages(boundedToolTranscript([...boundedMessages, ...supplementalResults])),
			this.disposition,
			true,
		);
		const page = [...plannedPage.groups];
		const pageNewest = page.at(-1);
		if (
			existingOldest &&
			pageNewest &&
			this.historyHeadCanContinue &&
			plannedPage.tailCanContinue &&
			!existingOldest.standalone &&
			!pageNewest.standalone
		) {
			const continuedExisting = { ...existingOldest, continuedFromPrevious: true };
			if (this.historicalGroups.has(existingOldest.leaderId)) {
				this.historicalGroups.set(existingOldest.leaderId, continuedExisting);
			} else this.groups.set(existingOldest.leaderId, continuedExisting);
			page[page.length - 1] = { ...pageNewest, continuesToNext: true };
		}
		this.historyHeadCanContinue =
			page.length > 0
				? plannedPage.headCanContinue
				: this.historyHeadCanContinue && plannedPage.headCanContinue && plannedPage.tailCanContinue;
		this.historicalGroupIds.splice(0);
		this.historicalGroups.clear();
		this.historicalMemberIndexes.clear();
		this.historicalMembership.clear();
		for (let index = page.length - 1; index >= 0; index -= 1) {
			const group = page[index];
			if (!group || this.groups.has(group.leaderId) || this.historicalGroups.has(group.leaderId)) continue;
			this.historicalGroups.set(group.leaderId, group);
			this.historicalGroupIds.push(group.leaderId);
			group.members.forEach((member, memberIndex) => {
				if (this.membership.has(member.id) || this.historicalMembership.has(member.id)) return;
				this.historicalMembership.set(member.id, group.leaderId);
				this.historicalMemberIndexes.set(member.id, memberIndex);
			});
		}
		return page;
	}

	resetProjection(messages: readonly unknown[]): void {
		this.pendingResults.clear();
		this.historicalGroupIds.splice(0);
		this.historicalGroups.clear();
		this.historicalMemberIndexes.clear();
		this.historicalMembership.clear();
		this.historicalResultMessages.clear();
		this.rememberHistoricalResults(messages);
		this.indexedMessages = messages.slice(-TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT);
		this.endStream();
		this.historyHeadCanContinue = this.rebuild();
	}

	clear(): void {
		this.groups.clear();
		this.groupOrder.splice(0);
		this.membership.clear();
		this.memberIndexes.clear();
		this.pendingResults.clear();
		this.historicalGroupIds.splice(0);
		this.historicalGroups.clear();
		this.historicalMemberIndexes.clear();
		this.historicalMembership.clear();
		this.historicalResultMessages.clear();
		this.historyHeadCanContinue = false;
		this.indexedMessages = [];
		this.openGroupLeaderId = undefined;
		this.endStream();
		this.agentActive = false;
		this.tailForcedClosed = false;
	}

	private rememberHistoricalResults(messages: readonly unknown[]): Set<string> {
		const resultIds = new Set<string>();
		for (let index = 0; index < Math.min(messages.length, TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT); index += 1) {
			const message = messages[index];
			if (!isRecordValue(message) || message.role !== "toolResult" || !isRuntimeString(message.toolCallId)) continue;
			resultIds.add(message.toolCallId);
			this.historicalResultMessages.set(message.toolCallId, message);
		}
		while (this.historicalResultMessages.size > PENDING_RESULT_LIMIT) {
			const oldest = this.historicalResultMessages.keys().next().value;
			if (!oldest) break;
			this.historicalResultMessages.delete(oldest);
		}
		return resultIds;
	}

	private trimGroups(): void {
		while (this.groupOrder.length > GROUP_PROJECTION_LIMIT) {
			const leaderId = this.groupOrder.shift();
			if (!leaderId) return;
			const group = this.groups.get(leaderId);
			this.groups.delete(leaderId);
			if (!group) continue;
			for (const member of group.members) {
				this.membership.delete(member.id);
				this.memberIndexes.delete(member.id);
			}
			this.hooks.groupRemoved(leaderId);
		}
	}

	private beginStream(): void {
		if (this.streamActive) return;
		this.streamActive = true;
		this.streamedProseIndexes.clear();
		this.streamedThinkingIndexes.clear();
	}

	private endStream(): void {
		this.streamActive = false;
		this.streamedProseIndexes.clear();
		this.streamedThinkingIndexes.clear();
	}

	private applyMessage<Message>(message: Message): void {
		if (!isRecordValue(message)) return;
		const role = message.role;
		if (role === "assistant" && Array.isArray(message.content)) {
			const cancellation = directBashCancelledByHostAbort(this.indexedMessages);
			if (cancellation) this.settleHostCancelledBash(cancellation.id);
			this.applyAssistantContent(message.content, assistantTerminalState(message.stopReason));
			return;
		}
		if (role === "toolResult") {
			const id = message.toolCallId;
			const content = message.content;
			if (!isRuntimeString(id) || !Array.isArray(content)) return;
			const name = "toolName" in message ? message.toolName : undefined;
			if (isRuntimeString(name) && this.envelopes.has(name)) {
				this.rebuild();
				return;
			}
			const baseResult: AgentToolResult<unknown> & { isError?: true } = {
				// SAFETY: Pi tool-result messages own this content array; projection preserves blocks without interpreting them.
				content: content as AgentToolResult<unknown>["content"],
				details: message.details,
			};
			if (message.isError === true) Object.assign(baseResult, { isError: true as const });
			this.updateToolResult(id, baseResult);
			return;
		}
		if (role === "user" || role === "bashExecution" || (role === "custom" && message.display === true)) {
			this.tailForcedClosed = true;
			this.closeOpenGroup();
		}
	}

	private settleHostCancelledBash(toolCallId: string): void {
		const group = this.groupForTool(toolCallId);
		const memberIndex = this.memberIndexes.get(toolCallId);
		const member = memberIndex === undefined ? undefined : group?.members[memberIndex];
		if (!group || memberIndex === undefined || !member || member.name !== "bash" || member.terminalState) {
			return;
		}
		this.mutableMembers(group)[memberIndex] = { ...member, terminalState: "cancelled" };
		this.hooks.stopTimer(toolCallId);
		this.hooks.groupChanged(group, toolCallId);
	}

	private applyAssistantContent(content: readonly unknown[], terminalState?: "cancelled" | "error"): void {
		const start = Math.max(0, content.length - TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT);
		for (let index = start; index < content.length; index += 1) {
			const block = content[index];
			if (!isRecordValue(block)) continue;
			if (
				block.type === "thinking" &&
				"thinking" in block &&
				isRuntimeString(block.thinking) &&
				block.thinking.trim()
			) {
				if (this.streamActive && this.streamedThinkingIndexes.has(index)) continue;
				this.tailForcedClosed = true;
				this.closeOpenGroup();
				continue;
			}
			if (block.type === "text" && "text" in block && isRuntimeString(block.text) && block.text.trim()) {
				if (this.streamActive && this.streamedProseIndexes.has(index)) continue;
				this.tailForcedClosed = true;
				this.closeOpenGroup();
				continue;
			}
			if (block.type !== "toolCall") continue;
			const id = block.id;
			const name = block.name;
			const args = block.arguments;
			if (!isRuntimeString(id) || !id || !isRuntimeString(name) || !name || !isToolArguments(args)) continue;
			const member: PlannedToolActivityMember = { args, id, name };
			if (terminalState) Object.assign(member, { terminalState });
			this.appendToolCall(member);
		}
	}

	private appendToolCall(member: PlannedToolActivityMember, preferMemberResult = false): void {
		const existingGroup = this.groupForTool(member.id);
		if (existingGroup) {
			const memberIndex = this.memberIndexes.get(member.id);
			if (memberIndex === undefined) return;
			const previous = existingGroup.members[memberIndex];
			const result = preferMemberResult
				? (member.result ?? previous?.result ?? this.pendingResults.get(member.id))
				: (previous?.result ?? member.result ?? this.pendingResults.get(member.id));
			const terminalState = result ? undefined : (member.terminalState ?? previous?.terminalState);
			const completeMember: PlannedToolActivityMember = { args: member.args, id: member.id, name: member.name };
			if (result) Object.assign(completeMember, { result });
			if (terminalState) Object.assign(completeMember, { terminalState });
			this.mutableMembers(existingGroup)[memberIndex] = completeMember;
			this.pendingResults.delete(member.id);
			if (this.isTransparentIssue(completeMember)) {
				this.splitGroupAtIssue(existingGroup, memberIndex);
				return;
			}
			this.hooks.groupChanged(existingGroup, member.id);
			if (terminalState) this.hooks.stopTimer(member.id);
			return;
		}
		const disposition = this.disposition(member.name, member.args);
		const result = member.result ?? this.pendingResults.get(member.id);
		const terminalState = result ? undefined : member.terminalState;
		const completeMember: PlannedToolActivityMember = { args: member.args, id: member.id, name: member.name };
		if (result) Object.assign(completeMember, { result });
		if (terminalState) Object.assign(completeMember, { terminalState });
		this.pendingResults.delete(member.id);
		const independent = disposition === "boundary" || this.isTransparentIssue(completeMember);
		if (independent) {
			this.closeOpenGroup();
			this.tailForcedClosed = true;
		}
		let group = this.openGroupLeaderId ? this.groups.get(this.openGroupLeaderId) : undefined;
		let continuedFromPrevious = false;
		if (group && !group.closed && group.members.length >= RETRIEVAL_GROUP_MEMBER_LIMIT) {
			const closed = { ...group, closed: true, continuesToNext: true };
			this.groups.set(group.leaderId, closed);
			this.hooks.groupChanged(closed);
			this.openGroupLeaderId = undefined;
			group = undefined;
			continuedFromPrevious = true;
		}
		if (!group || group.closed) {
			const nextGroup: PlannedRetrievalGroup = {
				closed: independent || !this.agentActive,
				leaderId: member.id,
				members: [completeMember],
			};
			if (continuedFromPrevious) Object.assign(nextGroup, { continuedFromPrevious: true });
			if (disposition === "boundary") Object.assign(nextGroup, { standalone: true });
			group = nextGroup;
			this.groups.set(group.leaderId, group);
			this.groupOrder.push(group.leaderId);
			this.trimGroups();
			if (!group.closed) this.openGroupLeaderId = group.leaderId;
		} else {
			this.mutableMembers(group).push(completeMember);
		}
		const index = group.members.length - 1;
		this.membership.set(member.id, group.leaderId);
		this.memberIndexes.set(member.id, index);
		this.tailForcedClosed = group.closed;
		this.hooks.groupChanged(group, member.id);
		if (terminalState) this.hooks.stopTimer(member.id);
	}

	private isTransparentIssue(member: PlannedToolActivityMember): boolean {
		if (this.disposition(member.name, member.args) !== "transparent") return false;
		if (member.terminalState !== undefined) return true;
		return Boolean(member.result && isIssueState(terminalStateFromResult(member, this.resultIsError(member.name))));
	}

	private splitGroupAtIssue(group: PlannedRetrievalGroup, issueIndex: number): void {
		const issue = group.members[issueIndex];
		if (!issue) return;
		const before = group.members.slice(0, issueIndex);
		const after = group.members.slice(issueIndex + 1);
		const replacements: PlannedRetrievalGroup[] = [];
		if (before[0]) replacements.push({ closed: true, leaderId: before[0].id, members: before });
		replacements.push({ closed: true, leaderId: issue.id, members: [issue] });
		if (after[0]) replacements.push({ closed: group.closed, leaderId: after[0].id, members: after });
		const orderIndex = this.groupOrder.indexOf(group.leaderId);
		if (orderIndex < 0) return;
		const wasOpen = this.openGroupLeaderId === group.leaderId;
		this.hooks.groupRemoved(group.leaderId);
		this.groups.delete(group.leaderId);
		for (const member of group.members) {
			this.membership.delete(member.id);
			this.memberIndexes.delete(member.id);
		}
		this.groupOrder.splice(orderIndex, 1, ...replacements.map((replacement) => replacement.leaderId));
		for (const replacement of replacements) {
			this.groups.set(replacement.leaderId, replacement);
			replacement.members.forEach((member, index) => {
				this.membership.set(member.id, replacement.leaderId);
				this.memberIndexes.set(member.id, index);
			});
		}
		if (wasOpen) {
			const tail = replacements.at(-1);
			this.openGroupLeaderId = tail && !tail.closed ? tail.leaderId : undefined;
			this.tailForcedClosed = this.openGroupLeaderId === undefined;
		}
		for (const replacement of replacements) this.hooks.groupChanged(replacement);
	}

	private closeOpenGroup(): void {
		const leaderId = this.openGroupLeaderId;
		if (!leaderId) return;
		const group = this.groups.get(leaderId);
		this.openGroupLeaderId = undefined;
		if (!group || group.closed) return;
		const closed = { ...group, closed: true };
		this.groups.set(leaderId, closed);
		this.hooks.groupChanged(closed);
	}

	private mutableMembers(group: PlannedRetrievalGroup): PlannedToolActivityMember[] {
		// SAFETY: this owner creates every group; mutation is confined to indexed reconciliation methods.
		return group.members as PlannedToolActivityMember[];
	}
}
