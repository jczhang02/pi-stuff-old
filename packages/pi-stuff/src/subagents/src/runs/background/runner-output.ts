/** Bound runner output and project child usage into durable status data. */

import * as fs from "node:fs";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { isRuntimeNumber, isRuntimeObject, runtimeErrorCode } from "../../../../shared/runtime-type.ts";
import { appendJsonl, withArtifactGroupWriteClaim } from "../../shared/artifacts.ts";
import { writePrivateAtomicText } from "../../shared/atomic-json.ts";
import type { CostSummary, ModelAttempt, TokenUsage, Usage } from "../../shared/types.ts";
import type { ChildProtocolMessage } from "../shared/child-protocol.ts";
import type { BackgroundTaskResult, RunnerAgentTask } from "../shared/parallel-utils.ts";
import type { BackgroundRunnerStatusStep as RunnerStatusStep } from "./initial-status.ts";

type ChildMessage = ChildProtocolMessage;

const DEFAULT_MAX_ASYNC_EVENTS_BYTES = 4 * 1024 * 1024;
const ASYNC_EVENTS_MAX_BYTES_ENV = "PI_SUBAGENT_ASYNC_EVENTS_MAX_BYTES";
const MAX_RECENT_OUTPUT_BYTES = 64 * 1024;
const MAX_RECENT_OUTPUT_LINES = 50;
export const DEFAULT_MAX_TASK_RESULT_BYTES = 256 * 1024;
export const TASK_RESULT_MAX_BYTES_ENV = "PI_SUBAGENT_TASK_RESULT_MAX_BYTES";
const DEFAULT_MAX_RUN_RESULT_BYTES = 1024 * 1024;
const RUN_RESULT_MAX_BYTES_ENV = "PI_SUBAGENT_RUN_RESULT_MAX_BYTES";
export const MAX_RESULT_ERROR_BYTES = 32 * 1024;
export const MAX_MODEL_ATTEMPT_ERROR_BYTES = 8 * 1024;
const RESULT_TRUNCATION_MARKER = "\n[output truncated; full text remains in the Agent transcript/output artifact]\n";
function maxAsyncEventsBytes(): number {
	const parsed = Number(process.env[ASYNC_EVENTS_MAX_BYTES_ENV]);
	return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_MAX_ASYNC_EVENTS_BYTES;
}

export function positiveByteLimit(name: string, fallback: number): number {
	const parsed = Number(process.env[name]);
	return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : fallback;
}

function utf8Tail(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf-8");
	if (bytes.length <= maxBytes) return value;
	let start = bytes.length - maxBytes;
	while (start < bytes.length && (bytes[start] ?? 0) >> 6 === 2) start++;
	return bytes.subarray(start).toString("utf-8");
}

function utf8Head(value: string, maxBytes: number): string {
	const bytes = Buffer.from(value, "utf-8");
	if (bytes.length <= maxBytes) return value;
	let end = maxBytes;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	return bytes.subarray(0, end).toString("utf-8");
}

export function boundResultText(value: string, maxBytes: number): string {
	if (Buffer.byteLength(value, "utf-8") <= maxBytes) return value;
	const markerBytes = Buffer.byteLength(RESULT_TRUNCATION_MARKER, "utf-8");
	if (maxBytes <= markerBytes) return utf8Tail(value, maxBytes);
	const payloadBytes = maxBytes - markerBytes;
	const headBytes = Math.floor(payloadBytes / 2);
	const tailBytes = payloadBytes - headBytes;
	return `${utf8Head(value, headBytes)}${RESULT_TRUNCATION_MARKER}${utf8Tail(value, tailBytes)}`;
}

function fairResultBudgets(values: readonly string[], maxBytes: number): number[] {
	const budgets = Array.from({ length: values.length }, () => 0);
	let remaining = maxBytes;
	let unresolved = values.map((_, index) => index);
	while (unresolved.length > 0 && remaining > 0) {
		const share = Math.floor(remaining / unresolved.length);
		if (share <= 0) {
			for (const index of unresolved.slice(0, remaining)) budgets[index] = 1;
			break;
		}
		const fitting = unresolved.filter((index) => Buffer.byteLength(values[index] ?? "", "utf-8") <= share);
		if (fitting.length === 0) {
			for (const [position, index] of unresolved.entries()) {
				budgets[index] = share + (position < remaining % unresolved.length ? 1 : 0);
			}
			break;
		}
		const fittingSet = new Set(fitting);
		for (const index of fitting) {
			const bytes = Buffer.byteLength(values[index] ?? "", "utf-8");
			budgets[index] = bytes;
			remaining -= bytes;
		}
		unresolved = unresolved.filter((index) => !fittingSet.has(index));
	}
	return budgets;
}

export function boundRunResultOutputs(results: BackgroundTaskResult[]): BackgroundTaskResult[] {
	const budgets = fairResultBudgets(
		results.map((result) => result.output),
		positiveByteLimit(RUN_RESULT_MAX_BYTES_ENV, DEFAULT_MAX_RUN_RESULT_BYTES),
	);
	return results.map((result, index) => ({
		...result,
		output: boundResultText(result.output, budgets[index] ?? 0),
	}));
}

export const DIAGNOSTIC_EVENT_HEADER_BYTES = 512;

/** Map a physical retained-log position back to its original stream position. */
export function diagnosticEventOffset(header: Buffer): number | undefined {
	const end = header.indexOf(0x0a);
	if (end < 0) return undefined;
	try {
		const record: unknown = JSON.parse(header.subarray(0, end).toString("utf-8"));
		if (
			!isRuntimeObject(record) ||
			record === null ||
			!("type" in record) ||
			!("sourceOffset" in record) ||
			record.type !== "subagent.events.truncated" ||
			!isRuntimeNumber(record.sourceOffset) ||
			!Number.isSafeInteger(record.sourceOffset) ||
			record.sourceOffset < 0
		)
			return undefined;
		return record.sourceOffset - end - 1;
	} catch {
		return undefined;
	}
}

export function appendDiagnosticEvent<Event extends object>(eventsPath: string, event: Event): void {
	try {
		withArtifactGroupWriteClaim(eventsPath, () => {
			const limit = maxAsyncEventsBytes();
			const line = `${JSON.stringify(event)}\n`;
			const lineBytes = Buffer.byteLength(line, "utf-8");
			let size = 0;
			try {
				const stat = fs.lstatSync(eventsPath);
				if (stat.isSymbolicLink() || !stat.isFile()) return;
				size = stat.size;
			} catch (error) {
				if (runtimeErrorCode(error) !== "ENOENT") return;
			}
			if (lineBytes > limit || limit === 0) {
				if (limit === 0 || size > limit) fs.rmSync(eventsPath, { force: true });
				return;
			}
			if (size + lineBytes <= limit) {
				appendJsonl(eventsPath, line.trimEnd());
				return;
			}
			const markerReserve = 160;
			const retainedBudget = Math.max(0, Math.floor(limit / 2) - lineBytes - markerReserve);
			let retained: Buffer = Buffer.alloc(0);
			let previousOffset = 0;
			if (size > 0) {
				const descriptor = fs.openSync(eventsPath, fs.constants.O_RDONLY);
				try {
					const header = Buffer.alloc(Math.min(size, DIAGNOSTIC_EVENT_HEADER_BYTES));
					fs.readSync(descriptor, header, 0, header.length, 0);
					previousOffset = diagnosticEventOffset(header) ?? 0;
					const buffer = Buffer.allocUnsafe(Math.min(size, retainedBudget));
					const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
					let retainedBuffer = buffer.subarray(0, bytesRead);
					if (size > bytesRead) {
						const firstNewline = retainedBuffer.indexOf(0x0a);
						retainedBuffer = firstNewline >= 0 ? retainedBuffer.subarray(firstNewline + 1) : Buffer.alloc(0);
					}
					retained = retainedBuffer;
				} finally {
					fs.closeSync(descriptor);
				}
			}
			const discardedBytesThisRoll = Math.max(0, size - retained.length);
			const observedAt = Date.now();
			const marker = (discardedBytes: number) =>
				`${JSON.stringify({
					discardedBytesThisRoll: discardedBytes,
					sourceOffset: previousOffset + discardedBytes,
					observedAt,
					type: "subagent.events.truncated",
				})}\n`;
			const rolled = Buffer.concat([Buffer.from(marker(discardedBytesThisRoll)), retained, Buffer.from(line)]);
			const payload = rolled.length <= limit ? rolled : Buffer.from(marker(size + lineBytes));
			if (Buffer.byteLength(payload, "utf-8") > limit) {
				if (size > limit) fs.rmSync(eventsPath, { force: true });
				return;
			}
			writePrivateAtomicText(eventsPath, payload);
		});
	} catch {
		// Diagnostics never determine run success.
	}
}

export function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function finiteUsageNumber<Value>(value: Value): number {
	return isRuntimeNumber(value) && Number.isFinite(value) ? value : 0;
}

export function addUsage(target: Usage, message: ChildMessage): boolean {
	const usage = message.usage;
	target.turns += 1;
	if (!usage || !isRuntimeObject(usage)) return false;
	target.input += finiteUsageNumber(usage.input ?? usage.inputTokens);
	target.output += finiteUsageNumber(usage.output ?? usage.outputTokens);
	target.cacheRead += finiteUsageNumber(usage.cacheRead);
	target.cacheWrite += finiteUsageNumber(usage.cacheWrite);
	const cost = usage.cost;
	const reportedCostTotal =
		isRuntimeObject(cost) && isRuntimeNumber(cost.total) && Number.isFinite(cost.total) ? cost.total : undefined;
	if (reportedCostTotal === undefined) return false;
	target.cost += reportedCostTotal;
	return true;
}

export function providerContextTokens(message: ChildMessage): number | undefined {
	const usage = message.usage;
	if (!usage || !isRuntimeObject(usage)) return undefined;
	const nativeTotal = finiteUsageNumber(usage.totalTokens);
	if (nativeTotal > 0) return nativeTotal;
	const calculated =
		finiteUsageNumber(usage.input ?? usage.inputTokens) +
		finiteUsageNumber(usage.output ?? usage.outputTokens) +
		finiteUsageNumber(usage.cacheRead) +
		finiteUsageNumber(usage.cacheWrite);
	return calculated > 0 ? calculated : undefined;
}

export function estimatedChildMessageTokens(message: ChildMessage): number {
	try {
		const estimated = estimateTokens(message);
		return Number.isFinite(estimated) ? Math.max(0, estimated) : 0;
	} catch {
		return 0;
	}
}

export function resolveTaskContextWindow(task: RunnerAgentTask, model: string | undefined): number | undefined {
	if (!model || !Array.isArray(task.modelContextWindows)) return undefined;
	for (const candidate of task.modelContextWindows) {
		if (!isRuntimeObject(candidate) || candidate === null || candidate.model !== model) continue;
		if (
			isRuntimeNumber(candidate.contextWindow) &&
			Number.isSafeInteger(candidate.contextWindow) &&
			candidate.contextWindow > 0
		) {
			return candidate.contextWindow;
		}
	}
	return undefined;
}

export function tokenUsage(usage: Usage): TokenUsage | undefined {
	const total = usage.input + usage.output;
	return total > 0 ? { input: usage.input, output: usage.output, total } : undefined;
}

export function costSummary(attempts: ModelAttempt[]): CostSummary | undefined {
	const inputTokens = attempts.reduce((sum, attempt) => sum + (attempt.usage?.input ?? 0), 0);
	const outputTokens = attempts.reduce((sum, attempt) => sum + (attempt.usage?.output ?? 0), 0);
	const costUsd = attempts.reduce((sum, attempt) => sum + (attempt.usage?.cost ?? 0), 0);
	return inputTokens || outputTokens || costUsd ? { inputTokens, outputTokens, costUsd } : undefined;
}

export function assistantStartsToolCall(message: AssistantMessage): boolean {
	return message.content.some((part) => part.type === "toolCall");
}

export function terminalAssistantStop(message: AssistantMessage): boolean {
	return message.stopReason === "stop" && !assistantStartsToolCall(message);
}
export function appendRecentOutput(step: RunnerStatusStep, text: string): void {
	const lines = utf8Tail(text, MAX_RECENT_OUTPUT_BYTES)
		.split(/\r?\n/)
		.filter((line) => line.trim())
		.slice(-MAX_RECENT_OUTPUT_LINES);
	if (lines.length === 0) return;
	const candidates = [...(step.recentOutput ?? []), ...lines].slice(-MAX_RECENT_OUTPUT_LINES);
	const retained: string[] = [];
	let remaining = MAX_RECENT_OUTPUT_BYTES;
	for (let index = candidates.length - 1; index >= 0 && remaining > 0; index--) {
		const separatorBytes = retained.length > 0 ? 1 : 0;
		if (remaining <= separatorBytes) break;
		const candidate = candidates[index] ?? "";
		const bounded = utf8Tail(candidate, remaining - separatorBytes);
		if (!bounded) break;
		retained.unshift(bounded);
		remaining -= Buffer.byteLength(bounded, "utf-8") + separatorBytes;
	}
	step.recentOutput = retained;
}
