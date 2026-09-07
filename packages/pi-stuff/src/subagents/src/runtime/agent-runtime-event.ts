import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../shared/runtime-type.ts";
import type { AgentRuntimeCompletionEvent } from "./agent-execution-governor.ts";

interface AgentRuntimeEventRecord {
	readonly abortStart?: unknown;
	readonly acknowledgeStart?: unknown;
	readonly asyncDir?: unknown;
	readonly code?: unknown;
	readonly detached?: unknown;
	readonly id?: unknown;
	readonly index?: unknown;
	readonly pid?: unknown;
	readonly processStartIdentity?: unknown;
	readonly results?: unknown;
	readonly runId?: unknown;
	readonly taskIndex?: unknown;
}

export function runtimeCompletionAddresses<Event>(event: Event): AgentRuntimeCompletionEvent[] {
	const value = record(event);
	const runtimeRunId = optionalText(value.runId) ?? optionalText(value.id);
	if (!runtimeRunId) return [];
	const results = Array.isArray(value.results) ? value.results : undefined;
	const indexes = results?.length
		? results.map((child, fallbackIndex) => completionChildIndex(record(child), fallbackIndex))
		: [completionChildIndex(value, 0)];
	const unique = new Set<number>();
	const addresses: AgentRuntimeCompletionEvent[] = [];
	for (const childIndex of indexes) {
		if (unique.has(childIndex)) continue;
		unique.add(childIndex);
		addresses.push({ runtimeRunId, childIndex });
	}
	return addresses;
}

export function parseAgentOwnerPath(value: string | undefined): string[] {
	if (!value?.trim()) return [];
	return value
		.split("›")
		.map((component) => component.trim())
		.filter((component) => component.length > 0);
}

/** Returns false only for an OS-confirmed missing process; permission and unknown failures remain undecided. */
export function explicitProcessPidState(pid: number): boolean | undefined {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		const code = record(error).code;
		if (code === "ESRCH") return false;
		return undefined;
	}
}

function completionChildIndex(value: AgentRuntimeEventRecord, fallback: number): number {
	const candidate = value.taskIndex ?? value.index;
	return optionalNonNegativeSafeInteger(candidate) ?? fallback;
}

export function record<Value>(value: Value): AgentRuntimeEventRecord {
	if (!isRuntimeObject(value) || value === null || Array.isArray(value)) return {};
	// SAFETY: lifecycle consumers read only the declared raw fields and validate them before use.
	return value as Value & AgentRuntimeEventRecord;
}

export function optionalText<Value>(value: Value): string | undefined {
	return isRuntimeString(value) && value.trim().length > 0 ? value.trim() : undefined;
}

export function requiredText(name: string, value: string): string {
	const resolved = optionalText(value);
	if (!resolved) throw new TypeError(`${name} must be a non-empty string.`);
	return resolved;
}

export function optionalPositiveSafeInteger<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function optionalNonNegativeSafeInteger<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function nonNegativeSafeInteger(name: string, value: number): number {
	const resolved = optionalNonNegativeSafeInteger(value);
	if (resolved === undefined) throw new TypeError(`${name} must be a non-negative safe integer.`);
	return resolved;
}
