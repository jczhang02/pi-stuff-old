import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { PlannedToolActivityMember } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import {
	baseOperationBlockModel,
	boundedOperationLines,
	logicalOperationLines,
	operationArgument,
	operationIssueLine,
	operationLineCount,
	operationResultText,
} from "./operation-block-evidence.ts";
import type { OperationBlockRowModel, OperationEvidenceLine } from "./operation-block-renderer.ts";

export function backgroundOperationBlockModel(
	member: PlannedToolActivityMember,
	result: AgentToolResult<unknown> | undefined,
	state: ToolActivityState,
	expanded: boolean,
): OperationBlockRowModel {
	const id = operationArgument(member.args, "task_id") || operationArgument(member.args, "taskId") || member.id;
	if (state === "running") {
		return baseOperationBlockModel("Background", id, state, expanded, [{ kind: "outcome", text: "Reading output…" }]);
	}
	if (state !== "success") {
		return baseOperationBlockModel("Background", id, state, expanded, [operationIssueLine(state, result)]);
	}
	const rawPreview = operationResultText(result);
	const raw = rawPreview.text.trim();
	const lifecycle = raw.match(
		/^(?:Background command|Monitor) ".+" (?:completed|exceeded the output limit and was stopped|failed(?: \(exit -?\d+\))?|stopped|timed out)(?:(?:\r?\n){2}([\s\S]*))?$/u,
	);
	const text = (lifecycle?.[1] ?? (lifecycle ? "" : raw)).trim();
	if (!text || /^\(no output yet\)$/iu.test(text)) {
		return baseOperationBlockModel("Background", id, state, expanded, [
			{ kind: "outcome", text: "No output yet.", tone: "muted" },
		]);
	}
	const source = logicalOperationLines(text, expanded);
	const preview = boundedOperationLines(source.lines, expanded, 3);
	const evidence: OperationEvidenceLine[] = [
		{
			kind: "outcome",
			text:
				rawPreview.truncated || source.truncated
					? "Output preview read · more omitted"
					: `${operationLineCount(source.lines.length)} read`,
		},
		...preview.visible.map((line) => ({ kind: "meta" as const, text: line, tone: "muted" as const })),
	];
	if (preview.omitted > 0 || rawPreview.truncated || source.truncated) {
		evidence.push({
			kind: "meta",
			text:
				rawPreview.truncated || source.truncated
					? expanded
						? "… more output omitted · output capped at 240 lines / 24 KiB"
						: "… more output (ctrl+o to expand)"
					: expanded
						? `… ${String(preview.omitted)} lines omitted · output capped at 240 lines / 24 KiB`
						: `… +${String(preview.omitted)} lines (ctrl+o to expand)`,
		});
	}
	return {
		...baseOperationBlockModel("Background", id, state, expanded, evidence),
		expandable: preview.omitted > 0 || rawPreview.truncated || source.truncated,
	};
}
