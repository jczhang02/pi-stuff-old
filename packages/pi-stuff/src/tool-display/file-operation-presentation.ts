import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { PlannedToolActivityMember } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import { diffRowsFromResult, type FileChange, parseApplyPatchDiff, projectDiff } from "./operation-block-diff.ts";
import {
	baseOperationBlockModel,
	boundedOperationLines,
	logicalOperationLines,
	operationArgument,
	operationDetailString,
	operationDetailStrings,
	operationIssueLine,
	operationLineCount,
} from "./operation-block-evidence.ts";
import type { OperationBlockRowModel, OperationEvidenceLine } from "./operation-block-renderer.ts";
import { oneLine } from "./tool-text.ts";

type FileOperationName = "apply_patch" | "edit" | "write";
const PATCH_METADATA_LIMIT = 64;
const PATCH_SOURCE_LIMIT = 24 * 1_024 * 4;

export function isFileOperationBlock(name: string): name is FileOperationName {
	return name === "write" || name === "edit" || name === "apply_patch";
}

function filePath(member: PlannedToolActivityMember): string {
	return (
		operationArgument(member.args, "path") ||
		operationArgument(member.args, "file_path") ||
		operationArgument(member.args, "value") ||
		member.id
	);
}

function verifiedWriteContent(result: AgentToolResult<unknown> | undefined): string | undefined {
	return operationDetailString(result, "finalContent") ?? operationDetailString(result, "content");
}

function writeModel(
	member: PlannedToolActivityMember,
	result: AgentToolResult<unknown> | undefined,
	state: ToolActivityState,
	expanded: boolean,
): OperationBlockRowModel {
	const path = filePath(member);
	if (state === "running") {
		return baseOperationBlockModel("Write", path, state, expanded, [{ kind: "outcome", text: "Writing…" }]);
	}
	const verified =
		state === "success"
			? (verifiedWriteContent(result) ?? operationArgument(member.args, "content"))
			: verifiedWriteContent(result);
	if (verified === undefined) {
		const evidence =
			state === "success"
				? [{ kind: "outcome", text: "0 lines written · content evidence unavailable", tone: "muted" } as const]
				: [operationIssueLine(state, result)];
		return baseOperationBlockModel("Write", path, state, expanded, evidence);
	}
	const source = logicalOperationLines(verified, expanded);
	const preview = boundedOperationLines(source.lines, expanded, 10);
	const partial =
		state === "success"
			? source.truncated
				? "Content written · preview truncated"
				: `${operationLineCount(source.lines.length)} written`
			: source.truncated
				? "Partial write · verified preview truncated"
				: `Partial write · ${operationLineCount(source.lines.length)} verified`;
	const evidence: OperationEvidenceLine[] = [{ kind: "outcome", text: partial }];
	evidence.push(...preview.visible.map((text, index) => ({ kind: "source" as const, newLine: index + 1, text })));
	if (preview.omitted > 0 || source.truncated) {
		evidence.push({
			kind: "meta",
			text: source.truncated
				? expanded
					? "… more content omitted · content capped at 240 lines / 24 KiB"
					: "… more content (ctrl+o to expand)"
				: expanded
					? `… ${String(preview.omitted)} lines omitted · content capped at 240 lines / 24 KiB`
					: `… +${String(preview.omitted)} lines (ctrl+o to expand)`,
		});
	}
	if (state !== "success") evidence.push(operationIssueLine(state, result));
	return {
		...baseOperationBlockModel("Write", path, state, expanded, evidence),
		expandable:
			source.truncated || source.lines.length > boundedOperationLines(source.lines, false, 10).visible.length,
		languagePath: path,
	};
}

function editModel(
	member: PlannedToolActivityMember,
	result: AgentToolResult<unknown> | undefined,
	state: ToolActivityState,
	expanded: boolean,
): OperationBlockRowModel {
	const path = filePath(member);
	if (state === "running") {
		return baseOperationBlockModel("Edit", path, state, expanded, [{ kind: "outcome", text: "Editing…" }]);
	}
	const parsed = diffRowsFromResult(result, path, expanded);
	if (parsed.rows.length === 0) {
		return baseOperationBlockModel(
			"Edit",
			path,
			state,
			expanded,
			state === "success"
				? [{ kind: "outcome", text: "Change applied · diff evidence unavailable", tone: "muted" }]
				: [operationIssueLine(state, result)],
		);
	}
	const diff = projectDiff(parsed.rows, expanded, false, parsed.truncated);
	const prefix = state === "success" ? "" : "Partial change · ";
	const evidence: OperationEvidenceLine[] = [
		{
			kind: "outcome",
			text: `${prefix}${diff.truncated ? "Preview · " : ""}+${String(diff.additions)}/-${String(diff.deletions)}`,
		},
		...diff.lines,
	];
	if (state !== "success") evidence.push(operationIssueLine(state, result));
	return {
		...baseOperationBlockModel("Edit", path, state, expanded, evidence),
		expandable: diff.expandable,
		languagePath: path,
	};
}

function patchTargets(input: string): string[] {
	return [...input.slice(0, PATCH_SOURCE_LIMIT).matchAll(/^\*\*\* (?:Add|Delete|Update) File: (.+)$/gmu)]
		.slice(0, PATCH_METADATA_LIMIT)
		.map((match) => oneLine(match[1] ?? ""))
		.filter(Boolean);
}

function pureRenameFiles(input: string): FileChange[] {
	const files: FileChange[] = [];
	for (const block of input.slice(0, PATCH_SOURCE_LIMIT).split(/^\*\*\* (?=Add|Delete|Update)/gmu)) {
		if (files.length >= PATCH_METADATA_LIMIT) break;
		const source = block.match(/^Update File: (?<path>.+)$/mu)?.groups?.["path"];
		const target = block.match(/^\*\*\* Move to: (?<path>.+)$/mu)?.groups?.["path"];
		if (!source || !target || /^[-+](?![-+])/mu.test(block)) continue;
		files.push({
			additions: 0,
			deletions: 0,
			newPath: oneLine(target),
			path: oneLine(source),
			status: "R",
		});
	}
	return files;
}

function structuredPatchFiles(result: AgentToolResult<unknown> | undefined): FileChange[] {
	const changed = operationDetailStrings(result, "changedFiles");
	if (changed.length === 0) return [];
	const created = new Set(operationDetailStrings(result, "createdFiles"));
	const deleted = new Set(operationDetailStrings(result, "deletedFiles"));
	const moved = new Set(operationDetailStrings(result, "movedFiles"));
	return changed.map((path) => ({
		additions: 0,
		deletions: 0,
		path,
		status: moved.has(path) ? "R" : created.has(path) ? "A" : deleted.has(path) ? "D" : "M",
	}));
}

function patchInput(member: PlannedToolActivityMember): string {
	return (
		operationArgument(member.args, "input") ||
		operationArgument(member.args, "patch") ||
		operationArgument(member.args, "patchText")
	);
}

function patchIdentity(input: string, result: AgentToolResult<unknown> | undefined): string {
	const rename = pureRenameFiles(input);
	if (rename.length === 1) return rename[0]?.newPath ?? rename[0]?.path ?? "";
	const targets = structuredPatchFiles(result).map((file) => file.path);
	const paths = targets.length > 0 ? targets : patchTargets(input);
	return paths.length === 0 ? "" : paths.length === 1 ? (paths[0] ?? "") : `${String(paths.length)} files`;
}

function patchModel(
	member: PlannedToolActivityMember,
	result: AgentToolResult<unknown> | undefined,
	state: ToolActivityState,
	expanded: boolean,
): OperationBlockRowModel {
	const input = patchInput(member);
	const identity = patchIdentity(input, result) || member.id;
	if (state === "running") {
		return baseOperationBlockModel("Patch", identity, state, expanded, [{ kind: "outcome", text: "Applying…" }]);
	}
	const resultDiff = diffRowsFromResult(result, "", expanded);
	const parsed =
		resultDiff.rows.length > 0
			? resultDiff
			: state === "success"
				? parseApplyPatchDiff(input, expanded)
				: { rows: [], truncated: false };
	const verifiedFiles = structuredPatchFiles(result);
	if (parsed.rows.length === 0) {
		const evidence: OperationEvidenceLine[] = [];
		if (state === "success") {
			const renames = pureRenameFiles(input);
			if (renames.length > 0) {
				evidence.push({ kind: "outcome", text: "+0/-0" });
				for (const file of renames) {
					evidence.push({
						kind: "meta",
						text: `R ${file.path} → ${file.newPath ?? file.path} · +0/-0 · renamed without content changes`,
					});
				}
			} else {
				evidence.push({ kind: "outcome", text: "Patch applied · diff evidence unavailable", tone: "muted" });
				for (const file of verifiedFiles) evidence.push({ kind: "meta", text: `${file.status} ${file.path}` });
			}
		} else evidence.push(operationIssueLine(state, result));
		return baseOperationBlockModel("Patch", identity, state, expanded, evidence);
	}
	const diff = projectDiff(parsed.rows, expanded, true, parsed.truncated);
	const files = diff.files.length > 0 ? diff.files : verifiedFiles;
	const totalTargets = Math.max(files.length, patchTargets(input).length);
	const prefix = state === "success" ? "" : `Partial patch · ${String(files.length)}/${String(totalTargets)} files · `;
	const evidence: OperationEvidenceLine[] = [
		{
			kind: "outcome",
			text: `${prefix}${diff.truncated ? "Preview · " : ""}+${String(diff.additions)}/-${String(diff.deletions)}`,
		},
	];
	for (const file of files) {
		const rename = file.status === "R" && file.additions === 0 && file.deletions === 0;
		const path = file.newPath ? `${file.path} → ${file.newPath}` : file.path;
		evidence.push({
			kind: "meta",
			text: `${file.status} ${path} · +${String(file.additions)}/-${String(file.deletions)}${rename ? " · renamed without content changes" : ""}`,
		});
	}
	evidence.push(...diff.lines);
	if (state !== "success") evidence.push(operationIssueLine(state, result));
	const model: OperationBlockRowModel = {
		...baseOperationBlockModel("Patch", identity, state, expanded, evidence),
		expandable: diff.expandable,
	};
	if (files.length === 1 && files[0]?.path) Object.assign(model, { languagePath: files[0].path });
	return model;
}

export function fileOperationBlockModel(
	member: PlannedToolActivityMember,
	result: AgentToolResult<unknown> | undefined,
	state: ToolActivityState,
	expanded: boolean,
): OperationBlockRowModel | undefined {
	if (member.name === "write") return writeModel(member, result, state, expanded);
	if (member.name === "edit") return editModel(member, result, state, expanded);
	if (member.name === "apply_patch") return patchModel(member, result, state, expanded);
	return undefined;
}
