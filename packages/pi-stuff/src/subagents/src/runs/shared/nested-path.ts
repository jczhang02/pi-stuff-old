import * as path from "node:path";
import { isJsonInputObject, parseJsonValue } from "../../../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.ts";

const MAX_NESTED_ID_LENGTH = 128;
export const MAX_NESTED_PATH_ENTRIES = 4;

export type NestedPathEntry = { runId: string; stepIndex?: number; agent?: string };

export function isSafeNestedPathId<Value>(value: Value): value is Value & string {
	return (
		isRuntimeString(value) &&
		value.length > 0 &&
		value.length <= MAX_NESTED_ID_LENGTH &&
		!path.isAbsolute(value) &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("..")
	);
}

function finiteNumber<Value>(value: Value): number | undefined {
	return isRuntimeNumber(value) && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString<Value>(value: Value, max: number): string | undefined {
	return isRuntimeString(value) && value.length > 0 ? value.slice(0, max) : undefined;
}

export function sanitizeNestedPath<Value>(value: Value): NestedPathEntry[] {
	if (!Array.isArray(value)) return [];
	return value
		.map((part) => {
			if (!part || !isRuntimeObject(part) || !isJsonInputObject(part)) return undefined;
			if (!isSafeNestedPathId(part["runId"])) return undefined;
			const entry: NestedPathEntry = { runId: part["runId"] };
			const stepIndex = finiteNumber(part["stepIndex"]);
			const agent = nonEmptyString(part["agent"], 128);
			if (stepIndex !== undefined) entry.stepIndex = stepIndex;
			if (agent) entry.agent = agent;
			return entry;
		})
		.filter((part): part is NestedPathEntry => Boolean(part))
		.slice(0, MAX_NESTED_PATH_ENTRIES);
}

export function parseNestedPathEnv(value: string | undefined): NestedPathEntry[] {
	if (!value) return [];
	try {
		return sanitizeNestedPath(parseJsonValue(value));
	} catch {
		return [];
	}
}

export function encodeNestedPathEnv(value: NestedPathEntry[]): string {
	const sanitized = sanitizeNestedPath(value);
	return sanitized.length ? JSON.stringify(sanitized) : "";
}
