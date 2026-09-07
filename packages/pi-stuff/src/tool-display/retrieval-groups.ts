import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import {
	skillReadName,
	type ToolActivityCategory,
	type ToolActivityMetadata,
	type ToolArguments,
} from "./activity-model.ts";
import { TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT, TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT } from "./limits.ts";
import { isToolArguments } from "./tool-value.ts";

export interface PlannedToolActivityMember {
	readonly args: ToolArguments;
	readonly id: string;
	readonly name: string;
	readonly result?: AgentToolResult<unknown>;
	/** Display-only terminal state proved by the surrounding Host transcript. */
	readonly terminalState?: "cancelled" | "error";
}

export interface PlannedRetrievalGroup {
	readonly closed: boolean;
	/** This bounded segment continues a Retrieval Group that began earlier. */
	readonly continuedFromPrevious?: boolean;
	/** This bounded segment continues in a later Retrieval Group segment. */
	readonly continuesToNext?: boolean;
	readonly leaderId: string;
	readonly members: readonly PlannedToolActivityMember[];
	/** Standalone Tools remain visually independent while sharing detail reconstruction. */
	readonly standalone?: boolean;
}

export interface PlannedRetrievalPage {
	readonly groups: readonly PlannedRetrievalGroup[];
	/** No visible boundary separates an earlier page from this page's first group. */
	readonly headCanContinue: boolean;
	/** No visible boundary separates this page's last group from a later page. */
	readonly tailCanContinue: boolean;
}

export type RetrievalGroupDisposition = "boundary" | "retrieval" | "transparent";
export type RetrievalGroupClassifier = (name: string, args: ToolArguments) => RetrievalGroupDisposition;

const RETRIEVAL_ACTIVITY_CATEGORIES = new Set<ToolActivityCategory>(["read-file", "search-pattern", "list-directory"]);
const RETRIEVAL_ACTIVITY_TOOL_NAMES = new Set(["find", "grep", "ls", "read"]);
const TRANSPARENT_ACTIVITY_TOOL_NAMES = new Set(["ctx_reduce", "tool_search"]);
export const RETRIEVAL_GROUP_MEMBER_LIMIT = 64;
const TRANSCRIPT_TEXT_SCAN_LIMIT = 1_024;

/** One invocation-level policy shared by streaming, replay, and envelope projection. */
export function classifyRetrievalGroupInvocation(
	name: string,
	args: ToolArguments,
	metadata: ToolActivityMetadata<ToolArguments, unknown> | undefined,
): RetrievalGroupDisposition {
	if (TRANSPARENT_ACTIVITY_TOOL_NAMES.has(name)) return "transparent";
	if (name === "read" && skillReadName("/", args)) return "boundary";
	if (!metadata || !RETRIEVAL_ACTIVITY_TOOL_NAMES.has(name)) return "boundary";
	return metadata.categories.length > 0 &&
		metadata.categories.every((category) => RETRIEVAL_ACTIVITY_CATEGORIES.has(category))
		? "retrieval"
		: "boundary";
}

export interface ToolTranscriptRecord {
	readonly arguments?: unknown;
	readonly content?: unknown;
	readonly details?: unknown;
	readonly display?: unknown;
	readonly errorMessage?: unknown;
	readonly id?: unknown;
	readonly isError?: unknown;
	readonly name?: unknown;
	readonly role?: unknown;
	readonly stopReason?: unknown;
	readonly text?: unknown;
	readonly toolCallId?: unknown;
	readonly type?: unknown;
}

function isRecord<Value>(value: Value): value is Value & ToolTranscriptRecord {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function toolCall<Value>(value: Value): Omit<PlannedToolActivityMember, "result"> | undefined {
	if (!isRecord(value) || !("type" in value) || value.type !== "toolCall") return undefined;
	const id = "id" in value ? value.id : undefined;
	const name = "name" in value ? value.name : undefined;
	const args = "arguments" in value ? value.arguments : undefined;
	if (!isRuntimeString(id) || !id || !isRuntimeString(name) || !name || !isToolArguments(args)) return undefined;
	return { args, id, name };
}

function toolResult<Value>(
	value: Value,
): { readonly id: string; readonly result: AgentToolResult<unknown> & { readonly isError?: true } } | undefined {
	if (!isRecord(value) || !("role" in value) || value.role !== "toolResult") return undefined;
	const id = "toolCallId" in value ? value.toolCallId : undefined;
	const content = "content" in value ? value.content : undefined;
	if (!isRuntimeString(id) || !id || !Array.isArray(content)) return undefined;
	const baseResult = {
		// SAFETY: Pi tool-result messages own this content array; the transcript planner preserves blocks without interpreting them.
		content: content as AgentToolResult<unknown>["content"],
		details: "details" in value ? value.details : undefined,
	};
	const result = "isError" in value && value.isError === true ? { ...baseResult, isError: true as const } : baseResult;
	return {
		id,
		result,
	};
}

function hasVisibleText<Value>(block: Value): boolean {
	return (
		isRecord(block) &&
		"type" in block &&
		block.type === "text" &&
		"text" in block &&
		isRuntimeString(block.text) &&
		hasBoundedVisibleText(block.text)
	);
}

function hasVisibleThinking<Value>(block: Value): boolean {
	return (
		isRecord(block) &&
		"type" in block &&
		block.type === "thinking" &&
		"thinking" in block &&
		isRuntimeString(block.thinking) &&
		hasBoundedVisibleText(block.thinking)
	);
}

function hasBoundedVisibleText(value: string): boolean {
	const scanLength = Math.min(value.length, TRANSCRIPT_TEXT_SCAN_LIMIT);
	for (let index = 0; index < scanLength; index += 1) {
		if (!/\s/u.test(value[index] ?? "")) return true;
	}
	return scanLength < value.length;
}

export function boundedToolTranscript(messages: readonly unknown[]): readonly unknown[] {
	const selected: unknown[] = [];
	let remainingBlocks = TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT;
	const start = Math.max(0, messages.length - TOOL_DISPLAY_TRANSCRIPT_MESSAGE_LIMIT);
	for (let index = messages.length - 1; index >= start && remainingBlocks > 0; index -= 1) {
		const message = messages[index];
		if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
			selected.push(message);
			remainingBlocks -= 1;
			continue;
		}
		const contentStart = Math.max(0, message.content.length - remainingBlocks);
		const content = message.content.slice(contentStart);
		selected.push({ ...message, content });
		remainingBlocks -= Math.max(1, content.length);
	}
	return selected.reverse();
}

function isVisibleMessageBoundary(message: ToolTranscriptRecord): boolean {
	const role = message.role;
	if (role === "custom") return message.display === true;
	return role === "user" || role === "bashExecution";
}

function assistantTerminalState(message: ToolTranscriptRecord): "cancelled" | "error" | undefined {
	const stopReason = message.stopReason;
	return stopReason === "aborted" ? "cancelled" : stopReason === "error" ? "error" : undefined;
}

function isExplicitHostAbort(message: ToolTranscriptRecord): boolean {
	return (
		assistantTerminalState(message) === "cancelled" ||
		(message.stopReason === "error" && message.errorMessage === "The operation was aborted.")
	);
}

/** Pi records a direct Tool cancellation as a later explicit empty Host abort. */
export function directBashCancelledByHostAbort(
	messages: readonly unknown[],
	abortIndex = messages.length - 1,
): Omit<PlannedToolActivityMember, "result"> | undefined {
	const current = messages[abortIndex];
	if (
		!isRecord(current) ||
		current.role !== "assistant" ||
		!isExplicitHostAbort(current) ||
		!Array.isArray(current.content) ||
		current.content.length !== 0
	) {
		return undefined;
	}
	const adjacentResult = toolResult(messages[abortIndex - 1]);
	const previous = messages[abortIndex - (adjacentResult ? 2 : 1)];
	if (
		!isRecord(previous) ||
		previous.role !== "assistant" ||
		assistantTerminalState(previous) !== undefined ||
		!Array.isArray(previous.content)
	) {
		return undefined;
	}
	const contentStart = Math.max(0, previous.content.length - TOOL_DISPLAY_TRANSCRIPT_BLOCK_LIMIT);
	for (let index = previous.content.length - 1; index >= contentStart; index -= 1) {
		const call = toolCall(previous.content[index]);
		if (call) {
			if (call.name !== "bash") return undefined;
			return !adjacentResult || (adjacentResult.id === call.id && adjacentResult.result.isError === true)
				? call
				: undefined;
		}
		if (hasVisibleText(previous.content[index]) || hasVisibleThinking(previous.content[index])) return undefined;
	}
	return undefined;
}

/**
 * Derive display-only Retrieval Groups from the current model-visible message order.
 * Tool results are transparent; visible Thinking runs, prose, user-visible context,
 * and unsupported Tool calls close the current group.
 */
export function planRetrievalPage(
	messages: readonly unknown[],
	classifyInvocation: RetrievalGroupClassifier,
	closeTail: boolean,
): PlannedRetrievalPage {
	const visibleMessages = boundedToolTranscript(messages);
	const results = new Map<string, AgentToolResult<unknown> & { readonly isError?: true }>();
	for (const message of visibleMessages) {
		const parsed = toolResult(message);
		if (parsed) results.set(parsed.id, parsed.result);
	}
	const hostCancelledBash = new Set<string>();
	for (let index = 1; index < visibleMessages.length; index += 1) {
		const call = directBashCancelledByHostAbort(visibleMessages, index);
		if (call) hostCancelledBash.add(call.id);
	}

	const groups: PlannedRetrievalGroup[] = [];
	let members: PlannedToolActivityMember[] = [];
	let continuedFromPrevious = false;
	let headCanContinue = true;
	let tailCanContinue = true;
	const flush = (closed: boolean, continuesToNext = false) => {
		const leader = members[0];
		if (leader) {
			const group: PlannedRetrievalGroup = { closed, leaderId: leader.id, members };
			if (continuedFromPrevious) Object.assign(group, { continuedFromPrevious: true });
			if (continuesToNext) Object.assign(group, { continuesToNext: true });
			groups.push(group);
		}
		members = [];
		continuedFromPrevious = continuesToNext;
	};
	const append = (member: PlannedToolActivityMember) => {
		if (members.length >= RETRIEVAL_GROUP_MEMBER_LIMIT) flush(true, true);
		members.push(member);
		tailCanContinue = true;
	};
	const closePageContinuity = () => {
		if (groups.length === 0 && members.length === 0) headCanContinue = false;
		tailCanContinue = false;
	};
	const appendStandalone = (member: PlannedToolActivityMember) => {
		flush(true);
		continuedFromPrevious = false;
		closePageContinuity();
		groups.push({
			closed: true,
			leaderId: member.id,
			members: [member],
			standalone: true,
		});
	};
	const appendInfrastructureIssue = (member: PlannedToolActivityMember) => {
		flush(true);
		continuedFromPrevious = false;
		closePageContinuity();
		groups.push({ closed: true, leaderId: member.id, members: [member] });
	};

	for (const candidate of visibleMessages) {
		if (!isRecord(candidate)) continue;
		if (isVisibleMessageBoundary(candidate)) {
			flush(true);
			continuedFromPrevious = false;
			closePageContinuity();
			continue;
		}
		if (candidate["role"] !== "assistant" || !Array.isArray(candidate["content"])) continue;
		const terminalState = assistantTerminalState(candidate);
		for (const block of candidate["content"]) {
			if (hasVisibleText(block) || hasVisibleThinking(block)) {
				flush(true);
				continuedFromPrevious = false;
				closePageContinuity();
				continue;
			}
			const call = toolCall(block);
			if (!call) continue;
			const result = results.get(call.id);
			const settledState = hostCancelledBash.has(call.id) ? "cancelled" : result ? undefined : terminalState;
			const member: PlannedToolActivityMember = { ...call };
			if (result) Object.assign(member, { result });
			if (settledState) Object.assign(member, { terminalState: settledState });
			const disposition = classifyInvocation(call.name, call.args);
			if (disposition === "boundary") {
				appendStandalone(member);
				continue;
			}
			if (disposition === "transparent" && (result?.isError === true || terminalState !== undefined)) {
				appendInfrastructureIssue(member);
				continue;
			}
			append(member);
		}
	}
	flush(closeTail);
	return { groups, headCanContinue, tailCanContinue };
}

export function planRetrievalGroups(
	messages: readonly unknown[],
	classifyInvocation: RetrievalGroupClassifier,
	closeTail: boolean,
): readonly PlannedRetrievalGroup[] {
	return planRetrievalPage(messages, classifyInvocation, closeTail).groups;
}
