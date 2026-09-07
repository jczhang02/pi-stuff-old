import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import {
	COMPACT_OPERATION_BYTE_LIMIT,
	EXPANDED_OPERATION_BYTE_LIMIT,
	EXPANDED_OPERATION_LINE_LIMIT,
	operationDetailString,
} from "./operation-block-evidence.ts";
import type { OperationEvidenceLine } from "./operation-block-renderer.ts";
import { oneLine } from "./tool-text.ts";

const COMPACT_CHANGED_LINE_LIMIT = 10;
const COMPACT_PATCH_FILE_CHANGED_LIMIT = 4;
const DIFF_ROW_LIMIT = EXPANDED_OPERATION_LINE_LIMIT * 2;
const DIFF_SOURCE_SCAN_FACTOR = 4;

interface DiffLine {
	readonly file: string;
	readonly kind: "add" | "context" | "delete";
	readonly newLine?: number | undefined;
	readonly newPath?: string | undefined;
	readonly oldLine?: number | undefined;
	readonly status: FileChange["status"];
	readonly text: string;
}

export interface FileChange {
	additions: number;
	deletions: number;
	newPath?: string;
	path: string;
	status: "A" | "D" | "M" | "R";
}

export interface DiffProjection {
	readonly additions: number;
	readonly deletions: number;
	readonly expandable: boolean;
	readonly files: readonly FileChange[];
	readonly lines: readonly OperationEvidenceLine[];
	readonly truncated: boolean;
}

interface ParsedDiff {
	readonly rows: DiffLine[];
	readonly truncated: boolean;
}

interface BoundedDiffSource {
	readonly text: string;
	readonly truncated: boolean;
}

function boundedDiffSource(value: string, expanded: boolean): BoundedDiffSource {
	const byteLimit = expanded ? EXPANDED_OPERATION_BYTE_LIMIT : COMPACT_OPERATION_BYTE_LIMIT;
	const text = value.slice(0, byteLimit * DIFF_SOURCE_SCAN_FACTOR);
	return { text, truncated: text.length < value.length };
}

function cleanDiffPath(value: string): string {
	const path = value.trim().split(/\s/u)[0] ?? "";
	return path.replace(/^[ab]\//u, "");
}

function parseUnifiedDiff(value: string, fallbackPath: string, expanded: boolean): ParsedDiff {
	const source = boundedDiffSource(value, expanded);
	const rows: DiffLine[] = [];
	let truncated = source.truncated;
	let oldPath = fallbackPath;
	let newPath = fallbackPath;
	let file = fallbackPath;
	let oldLine = 0;
	let newLine = 0;
	let status: DiffLine["status"] = "M";
	let inHunk = false;
	for (const raw of source.text.replaceAll("\r", "").split("\n")) {
		if (raw.startsWith("--- ")) {
			oldPath = cleanDiffPath(raw.slice(4));
			inHunk = false;
			continue;
		}
		if (raw.startsWith("+++ ")) {
			newPath = cleanDiffPath(raw.slice(4));
			file = newPath === "/dev/null" ? oldPath : newPath || oldPath || fallbackPath;
			status = oldPath === "/dev/null" ? "A" : newPath === "/dev/null" ? "D" : oldPath !== newPath ? "R" : "M";
			continue;
		}
		const hunk = raw.match(/^@@ -(?<old>\d+)(?:,\d+)? \+(?<next>\d+)(?:,\d+)? @@/u);
		if (hunk?.groups) {
			oldLine = Number(hunk.groups["old"]);
			newLine = Number(hunk.groups["next"]);
			inHunk = true;
			continue;
		}
		if (!inHunk || raw.startsWith("\\ No newline")) continue;
		if (rows.length >= DIFF_ROW_LIMIT) {
			truncated = true;
			break;
		}
		if (raw.startsWith("+")) {
			rows.push({ file, kind: "add", newLine, status, text: raw.slice(1) });
			newLine += 1;
		} else if (raw.startsWith("-")) {
			rows.push({ file, kind: "delete", oldLine, status, text: raw.slice(1) });
			oldLine += 1;
		} else {
			rows.push({
				file,
				kind: "context",
				newLine,
				oldLine,
				status,
				text: raw.startsWith(" ") ? raw.slice(1) : raw,
			});
			oldLine += 1;
			newLine += 1;
		}
	}
	return { rows, truncated };
}

function parseDisplayDiff(value: string, path: string, expanded: boolean): ParsedDiff {
	const source = boundedDiffSource(value, expanded);
	const rows: DiffLine[] = [];
	let truncated = source.truncated;
	for (const raw of source.text.replaceAll("\r", "").split("\n")) {
		if (rows.length >= DIFF_ROW_LIMIT) {
			truncated = true;
			break;
		}
		const match = raw.match(/^(?<kind>[ +-])(?<line>\s*\d+) (?<text>.*)$/u);
		if (!match?.groups) continue;
		const line = Number(match.groups["line"]);
		const text = match.groups["text"] ?? "";
		if (match.groups["kind"] === "+") rows.push({ file: path, kind: "add", newLine: line, status: "M", text });
		else if (match.groups["kind"] === "-")
			rows.push({ file: path, kind: "delete", oldLine: line, status: "M", text });
		else rows.push({ file: path, kind: "context", newLine: line, oldLine: line, status: "M", text });
	}
	return { rows, truncated };
}

export function parseApplyPatchDiff(value: string, expanded: boolean): ParsedDiff {
	const source = boundedDiffSource(value, expanded);
	const rows: DiffLine[] = [];
	let truncated = source.truncated;
	let file = "";
	let inHunk = false;
	let newLine: number | undefined;
	let newPath: string | undefined;
	let oldLine: number | undefined;
	let status: DiffLine["status"] = "M";
	for (const raw of source.text.replaceAll("\r", "").split("\n")) {
		const section = raw.match(/^\*\*\* (?<kind>Add|Delete|Update) File: (?<path>.+)$/u);
		if (section?.groups) {
			file = oneLine(section.groups["path"] ?? "");
			status = section.groups["kind"] === "Add" ? "A" : section.groups["kind"] === "Delete" ? "D" : "M";
			newPath = undefined;
			oldLine = status === "D" ? 1 : status === "A" ? 0 : undefined;
			newLine = status === "A" ? 1 : status === "D" ? 0 : undefined;
			inHunk = status !== "M";
			continue;
		}
		const move = raw.match(/^\*\*\* Move to: (?<path>.+)$/u);
		if (move?.groups && file) {
			newPath = oneLine(move.groups["path"] ?? "");
			status = "R";
			continue;
		}
		const hunk = raw.match(/^@@ -(?<old>\d+)(?:,\d+)? \+(?<next>\d+)(?:,\d+)? @@/u);
		if (raw === "@@" || hunk) {
			oldLine = hunk?.groups?.["old"] === undefined ? undefined : Number(hunk.groups["old"]);
			newLine = hunk?.groups?.["next"] === undefined ? undefined : Number(hunk.groups["next"]);
			inHunk = true;
			continue;
		}
		if (!file || !inHunk || raw === "*** End Patch" || raw === "*** Begin Patch") continue;
		if (rows.length >= DIFF_ROW_LIMIT) {
			truncated = true;
			break;
		}
		const common = { file, newPath, status };
		if (raw.startsWith("+")) {
			rows.push({ ...common, kind: "add", newLine, text: raw.slice(1) });
			if (newLine !== undefined) newLine += 1;
		} else if (raw.startsWith("-")) {
			rows.push({ ...common, kind: "delete", oldLine, text: raw.slice(1) });
			if (oldLine !== undefined) oldLine += 1;
		} else {
			rows.push({ ...common, kind: "context", newLine, oldLine, text: raw.startsWith(" ") ? raw.slice(1) : raw });
			if (oldLine !== undefined) oldLine += 1;
			if (newLine !== undefined) newLine += 1;
		}
	}
	return { rows, truncated };
}

export function diffRowsFromResult(
	result: AgentToolResult<unknown> | undefined,
	path: string,
	expanded: boolean,
): ParsedDiff {
	const patch = operationDetailString(result, "patch");
	if (patch) {
		const parsed = parseUnifiedDiff(patch, path, expanded);
		if (parsed.rows.length > 0) return parsed;
	}
	const diff = operationDetailString(result, "diff");
	if (!diff) return { rows: [], truncated: false };
	const unified = parseUnifiedDiff(diff, path, expanded);
	return unified.rows.length > 0 ? unified : parseDisplayDiff(diff, path, expanded);
}

function isChanged(line: DiffLine): boolean {
	return line.kind !== "context";
}

function compactDiffIndices(rows: readonly DiffLine[], patch: boolean): Set<number> {
	const changedIndices: number[] = [];
	const perFile = new Map<string, number>();
	for (const [index, row] of rows.entries()) {
		if (!isChanged(row) || changedIndices.length >= COMPACT_CHANGED_LINE_LIMIT) continue;
		const count = perFile.get(row.file) ?? 0;
		if (patch && count >= COMPACT_PATCH_FILE_CHANGED_LIMIT) continue;
		changedIndices.push(index);
		perFile.set(row.file, count + 1);
	}
	const selected = new Set(changedIndices);
	for (const index of changedIndices) {
		const before = rows[index - 1];
		const after = rows[index + 1];
		if (before?.kind === "context" && before.file === rows[index]?.file) selected.add(index - 1);
		if (after?.kind === "context" && after.file === rows[index]?.file) selected.add(index + 1);
	}
	return selected;
}

function boundedDiffRows(rows: readonly DiffLine[], expanded: boolean, patch: boolean): DiffLine[] {
	const allowed = expanded ? new Set(rows.map((_row, index) => index)) : compactDiffIndices(rows, patch);
	const lineLimit = expanded ? EXPANDED_OPERATION_LINE_LIMIT : Number.POSITIVE_INFINITY;
	const byteLimit = expanded ? EXPANDED_OPERATION_BYTE_LIMIT : COMPACT_OPERATION_BYTE_LIMIT;
	const visible: DiffLine[] = [];
	let bytes = 0;
	for (const [index, row] of rows.entries()) {
		if (!allowed.has(index) || visible.length >= lineLimit) continue;
		const next = Buffer.byteLength(row.text) + 32;
		if (bytes + next > byteLimit) break;
		visible.push(row);
		bytes += next;
	}
	return visible;
}

function fileChanges(rows: readonly DiffLine[]): FileChange[] {
	const changes = new Map<string, FileChange>();
	for (const row of rows) {
		const current = changes.get(row.file) ?? {
			additions: 0,
			deletions: 0,
			path: row.file,
			status: row.status,
		};
		if (row.newPath) current.newPath = row.newPath;
		if (row.kind === "add") current.additions += 1;
		if (row.kind === "delete") current.deletions += 1;
		changes.set(row.file, current);
	}
	return [...changes.values()];
}

export function projectDiff(
	rows: readonly DiffLine[],
	expanded: boolean,
	patch: boolean,
	sourceTruncated = false,
): DiffProjection {
	const visible = boundedDiffRows(rows, expanded, patch);
	const additions = rows.filter((row) => row.kind === "add").length;
	const deletions = rows.filter((row) => row.kind === "delete").length;
	const visibleChanged = visible.filter(isChanged).length;
	const omitted = additions + deletions - visibleChanged;
	const lines: OperationEvidenceLine[] = visible.map((row) => {
		const line: OperationEvidenceLine = { diffKind: row.kind, kind: "diff", text: row.text };
		if (row.file) Object.assign(line, { languagePath: row.file });
		if (row.newLine !== undefined) Object.assign(line, { newLine: row.newLine });
		if (row.oldLine !== undefined) Object.assign(line, { oldLine: row.oldLine });
		return line;
	});
	if (sourceTruncated || omitted > 0 || (expanded && visible.length < rows.length)) {
		lines.push({
			kind: "meta",
			text: sourceTruncated
				? expanded
					? "… more diff omitted · diff capped at 240 lines / 24 KiB"
					: "… more diff (ctrl+o to expand)"
				: expanded
					? `… ${String(Math.max(0, omitted))} changed lines omitted · diff capped at 240 lines / 24 KiB`
					: `… ${String(omitted)} changed lines omitted (ctrl+o to expand)`,
		});
	}
	return {
		additions,
		deletions,
		expandable: sourceTruncated || boundedDiffRows(rows, false, patch).length < rows.length,
		files: fileChanges(rows),
		lines,
		truncated: sourceTruncated,
	};
}
