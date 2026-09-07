import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isRuntimeString } from "../shared/runtime-type.ts";
import type { PlannedToolActivityMember } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import { BASH_OUTPUT_COLLAPSED_SOURCE_LIMIT, BASH_OUTPUT_SOURCE_LIMIT } from "./limits.ts";
import type { BashOperationRowModel, CachedToolRow } from "./render.ts";

export interface BashOperationBinding {
	bashOutput?: string;
	bashOutputExpanded?: boolean;
	bashOutputResult?: AgentToolResult<unknown>;
	bashOutputTruncated?: boolean;
	readonly expanded: boolean;
	readonly row: CachedToolRow;
}

export function presentBashOperation(
	member: PlannedToolActivityMember,
	binding: BashOperationBinding,
	result: AgentToolResult<unknown> | undefined,
	state: ToolActivityState,
	onChange: () => void,
): void {
	const output = bashOutput(binding, result, binding.expanded);
	const model: BashOperationRowModel = {
		active: state === "running",
		command: isRuntimeString(member.args["command"]) ? member.args["command"] : String(member.args["value"] ?? ""),
		expandable: true,
		expanded: binding.expanded,
		kind: "bash-operation",
		output: output.text,
		outputTruncated: output.truncated,
		state,
	};
	const modelChanged = binding.row.setModel(model);
	const visibilityChanged = binding.row.setVisible(true);
	if (modelChanged || visibilityChanged) onChange();
}

function bashOutput(binding: BashOperationBinding, result: AgentToolResult<unknown> | undefined, expanded: boolean) {
	if (binding.bashOutputResult === result && binding.bashOutputExpanded === expanded) {
		return { text: binding.bashOutput ?? "", truncated: binding.bashOutputTruncated === true };
	}
	const limit = expanded ? BASH_OUTPUT_SOURCE_LIMIT : BASH_OUTPUT_COLLAPSED_SOURCE_LIMIT;
	let output = "";
	let truncated = false;
	for (const item of result?.content ?? []) {
		if (item.type !== "text") continue;
		const separator = output ? "\n" : "";
		const remaining = limit - output.length - separator.length;
		if (remaining <= 0) {
			truncated = true;
			break;
		}
		const text = item.text.slice(0, remaining);
		output += `${separator}${text}`;
		if (text.length < item.text.length) {
			truncated = true;
			break;
		}
	}
	if (result) {
		binding.bashOutputResult = result;
		binding.bashOutputExpanded = expanded;
	} else {
		delete binding.bashOutputResult;
		delete binding.bashOutputExpanded;
	}
	binding.bashOutput = output;
	binding.bashOutputTruncated = truncated;
	return { text: output, truncated };
}
