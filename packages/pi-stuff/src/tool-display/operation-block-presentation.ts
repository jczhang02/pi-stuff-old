import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { PlannedToolActivityMember, ToolArguments } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import { backgroundOperationBlockModel } from "./background-operation-presentation.ts";
import { fileOperationBlockModel, isFileOperationBlock } from "./file-operation-presentation.ts";
import { operationArgument } from "./operation-block-evidence.ts";
import type { OperationBlockRowModel } from "./operation-block-renderer.ts";

function isBackgroundOutput(name: string, args: ToolArguments): boolean {
	return name === "background" && operationArgument(args, "action") === "output";
}

export function isOperationBlockMember(name: string, args: ToolArguments): boolean {
	return isFileOperationBlock(name) || isBackgroundOutput(name, args);
}

export function operationBlockModel(
	member: PlannedToolActivityMember,
	result: AgentToolResult<unknown> | undefined,
	state: ToolActivityState,
	expanded: boolean,
): OperationBlockRowModel | undefined {
	if (isFileOperationBlock(member.name)) return fileOperationBlockModel(member, result, state, expanded);
	if (isBackgroundOutput(member.name, member.args)) {
		return backgroundOperationBlockModel(member, result, state, expanded);
	}
	return undefined;
}
