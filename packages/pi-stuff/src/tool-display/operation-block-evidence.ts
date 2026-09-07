import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { readHostProxyProperty } from "../shared/host-proxy.ts";
import { isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolArguments } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import type { OperationBlockRowModel, OperationEvidenceLine } from "./operation-block-renderer.ts";
import { oneLine } from "./tool-text.ts";

export const COMPACT_OPERATION_BYTE_LIMIT = 2 * 1024;
export const EXPANDED_OPERATION_BYTE_LIMIT = 24 * 1024;
export const EXPANDED_OPERATION_LINE_LIMIT = 240;
const OPERATION_CONTENT_BLOCK_LIMIT = 64;
const OPERATION_SOURCE_SCAN_FACTOR = 4;

export interface OperationTextPreview {
	readonly text: string;
	readonly truncated: boolean;
}

export function operationArgument(args: ToolArguments, key: string): string {
	const value = args[key];
	return isRuntimeString(value) ? value : "";
}

export function operationResultText(
	result: AgentToolResult<unknown> | undefined,
	maxCodeUnits = EXPANDED_OPERATION_BYTE_LIMIT * OPERATION_SOURCE_SCAN_FACTOR,
): OperationTextPreview {
	let text = "";
	let truncated = false;
	for (let index = 0; result && index < Math.min(result.content.length, OPERATION_CONTENT_BLOCK_LIMIT); index += 1) {
		const item = result.content[index];
		if (item?.type !== "text") continue;
		const separator = text ? "\n" : "";
		const remaining = maxCodeUnits - text.length - separator.length;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		const source = item.text.slice(0, remaining);
		text += `${separator}${source}`;
		if (source.length < item.text.length) {
			truncated = true;
			break;
		}
	}
	if (result && result.content.length > OPERATION_CONTENT_BLOCK_LIMIT) truncated = true;
	return { text, truncated };
}

export function operationLineCount(count: number): string {
	return `${String(count)} ${count === 1 ? "line" : "lines"}`;
}

export function normalizeOperationIssueReason(value: string): string {
	return value.replace(/^(?:Cancelled|Error|Rejected):\s*/iu, "").trim();
}

export function operationIssueLine(
	state: ToolActivityState,
	result: AgentToolResult<unknown> | undefined,
): OperationEvidenceLine {
	const raw = operationResultText(result)
		.text.split(/\r?\n/u)
		.find((line) => line.trim().length > 0);
	const reason = normalizeOperationIssueReason(oneLine(raw ?? state)) || state;
	if (state === "rejected") return { kind: "outcome", text: `Rejected: ${reason}`, tone: "warning" };
	if (state === "cancelled") return { kind: "outcome", text: `Cancelled: ${reason}`, tone: "warning" };
	return { kind: "outcome", text: `Error: ${reason}`, tone: "error" };
}

export function logicalOperationLines(value: string, expanded: boolean): OperationTextPreview & { lines: string[] } {
	if (!value) return { lines: [], text: "", truncated: false };
	const byteLimit = expanded ? EXPANDED_OPERATION_BYTE_LIMIT : COMPACT_OPERATION_BYTE_LIMIT;
	const source = value.slice(0, byteLimit * OPERATION_SOURCE_SCAN_FACTOR);
	const lines = source.replaceAll("\r", "").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return { lines, text: source, truncated: source.length < value.length };
}

export function boundedOperationLines(lines: readonly string[], expanded: boolean, compactLineLimit: number) {
	const lineLimit = expanded ? EXPANDED_OPERATION_LINE_LIMIT : compactLineLimit;
	const byteLimit = expanded ? EXPANDED_OPERATION_BYTE_LIMIT : COMPACT_OPERATION_BYTE_LIMIT;
	const visible: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		if (visible.length >= lineLimit) break;
		const nextBytes = Buffer.byteLength(line) + (visible.length > 0 ? 1 : 0);
		if (bytes + nextBytes > byteLimit) break;
		visible.push(line);
		bytes += nextBytes;
	}
	return { omitted: Math.max(0, lines.length - visible.length), visible };
}

function detailsRecord(result: AgentToolResult<unknown> | undefined): object | undefined {
	const details = result?.details;
	return isRuntimeObject(details) && details !== null && !Array.isArray(details) ? details : undefined;
}

export function operationDetailString(result: AgentToolResult<unknown> | undefined, key: string): string | undefined {
	const details = detailsRecord(result);
	if (!details) return undefined;
	const value: unknown = readHostProxyProperty(details, key);
	return isRuntimeString(value) ? value : undefined;
}

export function operationDetailStrings(result: AgentToolResult<unknown> | undefined, key: string): string[] {
	const details = detailsRecord(result);
	if (!details) return [];
	const value: unknown = readHostProxyProperty(details, key);
	if (!Array.isArray(value)) return [];
	const output: string[] = [];
	for (let index = 0; index < Math.min(value.length, OPERATION_CONTENT_BLOCK_LIMIT); index += 1) {
		const item = value[index];
		if (!isRuntimeString(item)) return [];
		output.push(item.slice(0, EXPANDED_OPERATION_BYTE_LIMIT * OPERATION_SOURCE_SCAN_FACTOR));
	}
	return output;
}

export function baseOperationBlockModel(
	label: string,
	identity: string,
	state: ToolActivityState,
	expanded: boolean,
	evidence: readonly OperationEvidenceLine[],
): OperationBlockRowModel {
	return {
		active: state === "running",
		evidence,
		expandable: false,
		expanded,
		identity: oneLine(identity),
		kind: "operation-block",
		label,
		state,
	};
}
