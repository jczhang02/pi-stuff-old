import { existsSync } from "node:fs";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import type { BackgroundWorkOutcome, BackgroundWorkTerminalStatus } from "./runtime.ts";

export interface NotificationBatch {
	readonly content: string;
	readonly outcomes: BackgroundWorkOutcome[];
}

const MAX_NOTIFICATION_CONTENT_BYTES = 64 * 1024;
const MAX_NOTIFICATION_INLINE_BYTES = 40 * 1024;
const MAX_NOTIFICATION_SUMMARY_BYTES = 1_024;
const MAX_NOTIFICATION_PATH_BYTES = 2_048;
const NOTIFICATION_TRUNCATION_MARKER = "[earlier output omitted]\n";

function escapeXml(value: string): string {
	return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function escapedBytes(value: string): number {
	return Buffer.byteLength(escapeXml(value), "utf-8");
}

function fitEscapedHead(value: string, maxBytes: number) {
	const escaped = escapeXml(value);
	if (Buffer.byteLength(escaped, "utf-8") <= maxBytes) return { escaped, raw: value };
	const points = Array.from(value);
	const suffix = "…";
	let low = 0;
	let high = points.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = `${points.slice(0, middle).join("")}${suffix}`;
		if (escapedBytes(candidate) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	const raw = `${points.slice(0, low).join("")}${suffix}`;
	return escapedBytes(raw) <= maxBytes ? { escaped: escapeXml(raw), raw } : { escaped: "", raw: "" };
}

function fitEscapedTail(value: string, maxBytes: number) {
	const escaped = escapeXml(value);
	if (Buffer.byteLength(escaped, "utf-8") <= maxBytes) return { escaped, raw: value };
	const markerBytes = escapedBytes(NOTIFICATION_TRUNCATION_MARKER);
	if (maxBytes <= markerBytes) return { escaped: "", raw: "" };
	const points = Array.from(value);
	let low = 0;
	let high = points.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		const candidate = `${NOTIFICATION_TRUNCATION_MARKER}${points.slice(points.length - middle).join("")}`;
		if (escapedBytes(candidate) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	const raw = `${NOTIFICATION_TRUNCATION_MARKER}${points.slice(points.length - low).join("")}`;
	return { escaped: escapeXml(raw), raw };
}

function fairInlineBudgets(values: string[], totalBytes: number): number[] {
	const budgets = Array.from({ length: values.length }, () => 0);
	let remaining = Math.max(0, totalBytes);
	let unresolved = values.map((_, index) => index);
	while (unresolved.length > 0 && remaining > 0) {
		const share = Math.floor(remaining / unresolved.length);
		if (share <= 0) {
			for (const index of unresolved.slice(0, remaining)) budgets[index] = 1;
			break;
		}
		const fitting = unresolved.filter((index) => escapedBytes(values[index] ?? "") <= share);
		if (fitting.length === 0) {
			for (const [position, index] of unresolved.entries()) {
				budgets[index] = share + (position < remaining % unresolved.length ? 1 : 0);
			}
			break;
		}
		const fittingSet = new Set(fitting);
		for (const index of fitting) {
			const bytes = escapedBytes(values[index] ?? "");
			budgets[index] = bytes;
			remaining -= bytes;
		}
		unresolved = unresolved.filter((index) => !fittingSet.has(index));
	}
	return budgets;
}

export function projectNotificationBatch(outcomes: readonly BackgroundWorkOutcome[]): NotificationBatch {
	const rows = outcomes.map((outcome) => {
		const id = fitEscapedHead(outcome.id, 256);
		const summary = fitEscapedHead(outcome.summary, MAX_NOTIFICATION_SUMMARY_BYTES);
		const readableOutputPath = outcome.outputPath && existsSync(outcome.outputPath) ? outcome.outputPath : undefined;
		const fittedOutputPath = readableOutputPath
			? fitEscapedHead(readableOutputPath, MAX_NOTIFICATION_PATH_BYTES)
			: undefined;
		const outputPath = fittedOutputPath?.raw === readableOutputPath ? fittedOutputPath : undefined;
		const inline = !outputPath ? outcome.recentOutput : undefined;
		const outputPrefix = outputPath
			? `\n<output_file>${outputPath.escaped}</output_file>`
			: inline
				? "\n<recent_output>"
				: "";
		const outputSuffix = inline ? "</recent_output>" : "";
		return {
			outcome,
			id,
			summary,
			outputPath,
			inline,
			prefix: `<task id="${id.escaped}" kind="${outcome.kind}" status="${outcome.status}">\n<summary>${summary.escaped}</summary>${outputPrefix}`,
			suffix: `${outputSuffix}\n</task>`,
		};
	});
	const header = "<background-work-notification>\n";
	const footer = "\n</background-work-notification>";
	const baseContent = `${header}${rows.map((row) => `${row.prefix}${row.suffix}`).join("\n")}${footer}`;
	const inlineRows = rows.filter((row) => isRuntimeString(row.inline));
	const remainingBytes = Math.max(
		0,
		Math.min(MAX_NOTIFICATION_INLINE_BYTES, MAX_NOTIFICATION_CONTENT_BYTES - Buffer.byteLength(baseContent, "utf-8")),
	);
	const budgets = fairInlineBudgets(
		inlineRows.map((row) => row.inline ?? ""),
		remainingBytes,
	);
	const fittedInline = new Map<(typeof rows)[number], { readonly escaped: string; readonly raw: string }>();
	for (const [index, row] of inlineRows.entries()) {
		fittedInline.set(row, fitEscapedTail(row.inline ?? "", budgets[index] ?? 0));
	}
	const content = `${header}${rows
		.map((row) => `${row.prefix}${fittedInline.get(row)?.escaped ?? ""}${row.suffix}`)
		.join("\n")}${footer}`;
	const projectedOutcomes = rows.map((row) => {
		const {
			outputPath: _outputPath,
			parentRunOrigin: _parentRunOrigin,
			recentOutput: _recentOutput,
			...base
		} = row.outcome;
		const title = fitEscapedHead(row.outcome.title, 256).raw;
		const detailsSummary = fitEscapedHead(row.outcome.summary, 512).raw;
		const recentOutput = fittedInline.get(row)?.raw;
		const projected: BackgroundWorkOutcome = {
			...base,
			id: row.id.raw,
			summary: detailsSummary,
			title,
		};
		if (row.outputPath) Object.assign(projected, { outputPath: row.outputPath.raw });
		if (recentOutput) Object.assign(projected, { recentOutput });
		return projected;
	});
	if (Buffer.byteLength(content, "utf-8") <= MAX_NOTIFICATION_CONTENT_BYTES) {
		return { content, outcomes: projectedOutcomes };
	}
	const minimalRows = outcomes.map((outcome) => {
		const id = fitEscapedHead(outcome.id, 64);
		const summary = fitEscapedHead(outcome.summary, 256);
		return `<task id="${id.escaped}" kind="${outcome.kind}" status="${outcome.status}">\n<summary>${summary.escaped}</summary>\n</task>`;
	});
	const minimalContent = `${header}${minimalRows.join("\n")}${footer}`;
	const minimalOutcomes = outcomes.map((outcome) => {
		const {
			outputPath: _outputPath,
			parentRunOrigin: _parentRunOrigin,
			recentOutput: _recentOutput,
			...base
		} = outcome;
		return {
			...base,
			id: fitEscapedHead(outcome.id, 64).raw,
			summary: fitEscapedHead(outcome.summary, 256).raw,
			title: fitEscapedHead(outcome.title, 128).raw,
		};
	});
	if (Buffer.byteLength(minimalContent, "utf-8") <= MAX_NOTIFICATION_CONTENT_BYTES) {
		return { content: minimalContent, outcomes: minimalOutcomes };
	}
	const counts = new Map<BackgroundWorkTerminalStatus, number>();
	for (const outcome of outcomes) counts.set(outcome.status, (counts.get(outcome.status) ?? 0) + 1);
	const summary = [...counts.entries()].map(([status, count]) => `${status}=${String(count)}`).join(" ");
	const hardContent = `<background-work-notification count="${String(outcomes.length)}">\n<summary>${escapeXml(summary)}</summary>\n<notice>Per-task results are available in message details.</notice>\n</background-work-notification>`;
	return { content: hardContent, outcomes: minimalOutcomes };
}
