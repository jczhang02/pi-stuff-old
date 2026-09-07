import {
	isContextOverflow,
	isRetryableAssistantError,
	type AssistantMessage as PiAssistantMessage,
	type Usage,
} from "@earendil-works/pi-ai";
import { isJsonInputObject, isJsonInputValue, type JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import { assistantUsageTokens, nonNegativeFiniteNumber } from "./accounting.ts";

type AgentStopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface AssistantMessageLike {
	role: "assistant";
	stopReason?: AgentStopReason | undefined;
	errorMessage?: string | undefined;
	content?: PiAssistantMessage["content"];
	api?: PiAssistantMessage["api"];
	provider?: PiAssistantMessage["provider"];
	model?: string;
	usage?: Usage;
	timestamp?: number;
}

const USAGE_LIMIT_GOAL_ERROR_PATTERNS = [
	/usage[_\s-]*(?:limit|cap)|chatgpt.{0,32}usage/i,
	/quota.{0,32}(?:reached|exceeded|exhausted|depleted)|(?:reached|exceeded|exhausted|depleted).{0,32}quota/i,
	/insufficient[_\s-]*(?:quota|credits?)|out of credits|out of budget|available balance|payment required/i,
	/(?:credit|balance).{0,32}(?:low|exhausted|depleted)|billing/i,
] as const;
const EXTERNAL_GOAL_ERROR_RE =
	/multi-auth rotation failed|credentials tried|unauthori[sz]ed|invalid api key|authentication failed|forbidden|permission denied|access denied/i;
const RETRYABLE_GOAL_ERROR_PATTERNS = [
	/overloaded|rate.?limit|too many requests|\b(?:429|500|502|503|504)\b|service.?unavailable|server.?error|internal.?error/i,
	/provider.?returned.?error|you can retry your request|try your request again|please retry your request/i,
	/network.?error|connection.?(?:error|refused|lost)|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up/i,
	/timed? out|timeout|terminated|websocket.?(?:closed|error)|ended without|stream ended before message_stop|http2 request did not get a response|retry delay/i,
	/context[_\s-]*length[_\s-]*exceeded|input exceeds the context window/i,
] as const;

export function formatError(cause: unknown) {
	return truncateNotification(cause instanceof Error ? cause.message : String(cause));
}

export function truncateNotification(value: string) {
	return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}

export function isUsageLimitedGoalInterruption(assistant: AssistantMessageLike) {
	const errorMessage = assistant.errorMessage;
	return (
		assistant.stopReason === "error" &&
		isRuntimeString(errorMessage) &&
		USAGE_LIMIT_GOAL_ERROR_PATTERNS.some((pattern) => pattern.test(errorMessage))
	);
}

export function isRetryableGoalInterruption(assistant: AssistantMessageLike) {
	if (assistant.stopReason !== "error" || !assistant.errorMessage) return false;
	if (isUsageLimitedGoalInterruption(assistant) || isExternallyBlockedGoalInterruption(assistant)) {
		return false;
	}
	return Boolean(
		isGoalContextOverflow(assistant) ||
			isRetryableAssistantError(toPiAssistantMessage(assistant)) ||
			RETRYABLE_GOAL_ERROR_PATTERNS.some((pattern) => pattern.test(assistant.errorMessage ?? "")) ||
			assistant.errorMessage.trim(),
	);
}

export function isExternallyBlockedGoalInterruption(assistant: AssistantMessageLike) {
	return (
		assistant.stopReason === "error" &&
		isRuntimeString(assistant.errorMessage) &&
		EXTERNAL_GOAL_ERROR_RE.test(assistant.errorMessage)
	);
}

export function isGoalContextOverflow(assistant: AssistantMessageLike) {
	return isContextOverflow(toPiAssistantMessage(assistant));
}

export function findFinalAssistantMessage(messages: unknown[]): AssistantMessageLike | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || !isRuntimeObject(message) || Array.isArray(message) || !("role" in message)) continue;
		if (message.role !== "assistant") continue;
		const stopReason = "stopReason" in message ? message.stopReason : undefined;
		const errorMessage = "errorMessage" in message ? message.errorMessage : undefined;
		const assistant: AssistantMessageLike = {
			role: "assistant",
			stopReason: isAgentStopReason(stopReason) ? stopReason : undefined,
			errorMessage: isRuntimeString(errorMessage) ? errorMessage : undefined,
		};
		const contentValue = "content" in message && isJsonInputValue(message.content) ? message.content : undefined;
		const content = contentValue === undefined ? undefined : normalizeAssistantContent(contentValue);
		if (content) assistant.content = content;
		const api = "api" in message ? message.api : undefined;
		const provider = "provider" in message ? message.provider : undefined;
		const model = "model" in message ? message.model : undefined;
		const timestamp = "timestamp" in message ? message.timestamp : undefined;
		if (isRuntimeString(api)) assistant.api = api;
		if (isRuntimeString(provider)) assistant.provider = provider;
		if (isRuntimeString(model)) assistant.model = model;
		if (isRuntimeNumber(timestamp)) assistant.timestamp = timestamp;
		const usage = normalizeUsage("usage" in message ? message.usage : undefined);
		if (usage) assistant.usage = usage;
		return assistant;
	}
	return undefined;
}

function toPiAssistantMessage(assistant: AssistantMessageLike): PiAssistantMessage {
	const message: PiAssistantMessage = {
		role: "assistant",
		content: assistant.content ?? [],
		api: assistant.api ?? "openai-responses",
		provider: assistant.provider ?? "unknown",
		model: assistant.model ?? "unknown",
		usage: assistant.usage ?? zeroUsage(),
		stopReason: assistant.stopReason ?? "error",
		timestamp: assistant.timestamp ?? Date.now(),
	};
	return assistant.errorMessage === undefined ? message : { ...message, errorMessage: assistant.errorMessage };
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function isAgentStopReason<Value>(value: Value): value is Value & AgentStopReason {
	return value === "stop" || value === "length" || value === "toolUse" || value === "error" || value === "aborted";
}

function normalizeAssistantContent(value: JsonInputValue): PiAssistantMessage["content"] | undefined {
	if (!Array.isArray(value)) return undefined;
	const content: PiAssistantMessage["content"] = [];
	for (const item of value) {
		if (!isJsonInputObject(item)) return undefined;
		if (item["type"] === "text" && isRuntimeString(item["text"])) {
			const block: Extract<PiAssistantMessage["content"][number], { type: "text" }> = {
				type: "text",
				text: item["text"],
			};
			if (isRuntimeString(item["textSignature"])) block.textSignature = item["textSignature"];
			content.push(block);
			continue;
		}
		if (item["type"] === "thinking" && isRuntimeString(item["thinking"])) {
			const block: Extract<PiAssistantMessage["content"][number], { type: "thinking" }> = {
				type: "thinking",
				thinking: item["thinking"],
			};
			if (isRuntimeString(item["thinkingSignature"])) block.thinkingSignature = item["thinkingSignature"];
			if (isRuntimeBoolean(item["redacted"])) block.redacted = item["redacted"];
			content.push(block);
			continue;
		}
		if (
			item["type"] === "toolCall" &&
			isRuntimeString(item["id"]) &&
			isRuntimeString(item["name"]) &&
			isJsonInputObject(item["arguments"])
		) {
			const block: Extract<PiAssistantMessage["content"][number], { type: "toolCall" }> = {
				type: "toolCall",
				id: item["id"],
				name: item["name"],
				arguments: item["arguments"],
			};
			if (isRuntimeString(item["thoughtSignature"])) block.thoughtSignature = item["thoughtSignature"];
			if (isRuntimeString(item["namespace"])) block.namespace = item["namespace"];
			content.push(block);
			continue;
		}
		return undefined;
	}
	return content;
}

function normalizeUsage<Value>(value: Value): Usage | undefined {
	if (!value || !isRuntimeObject(value) || Array.isArray(value)) return undefined;
	const input = "input" in value ? value.input : undefined;
	const output = "output" in value ? value.output : undefined;
	if (!isRuntimeNumber(input) || !isRuntimeNumber(output)) return undefined;
	const cacheRead = "cacheRead" in value ? value.cacheRead : undefined;
	const cacheWrite = "cacheWrite" in value ? value.cacheWrite : undefined;
	const costValue = "cost" in value ? value.cost : undefined;
	const cost = costValue && isRuntimeObject(costValue) && !Array.isArray(costValue) ? costValue : undefined;
	return {
		input: nonNegativeFiniteNumber(input),
		output: nonNegativeFiniteNumber(output),
		cacheRead: nonNegativeFiniteNumber(cacheRead),
		cacheWrite: nonNegativeFiniteNumber(cacheWrite),
		totalTokens: assistantUsageTokens(value),
		cost: {
			input: nonNegativeFiniteNumber(cost && "input" in cost ? cost.input : undefined),
			output: nonNegativeFiniteNumber(cost && "output" in cost ? cost.output : undefined),
			cacheRead: nonNegativeFiniteNumber(cost && "cacheRead" in cost ? cost.cacheRead : undefined),
			cacheWrite: nonNegativeFiniteNumber(cost && "cacheWrite" in cost ? cost.cacheWrite : undefined),
			total: nonNegativeFiniteNumber(cost && "total" in cost ? cost.total : undefined),
		},
	};
}
