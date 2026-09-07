import { reportDiagnostic, sanitizeDiagnosticLine } from "../../../conversation-ui/diagnostics.ts";
import { isRuntimeString } from "../../../shared/runtime-type.ts";
import { writeDetachedRunnerDiagnostic } from "./detached-runner-diagnostics.ts";

const AGENT_PREFIX = /^\[(?:pi-stuff-agents(?::[^\]]+)?|pi-subagents)\]\s*/i;

function formatValue<Value>(value: Value): string {
	if (value instanceof Error) return value.stack || value.message || value.name;
	if (isRuntimeString(value)) return value;
	if (value === undefined) return "undefined";
	if (value === null) return "null";
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function normalize(values: readonly unknown[]) {
	const error = values.find((value): value is Error => value instanceof Error);
	const firstValue = values[0];
	const first = sanitizeDiagnosticLine(firstValue instanceof Error ? firstValue.message : formatValue(firstValue))
		.replace(AGENT_PREFIX, "")
		.trim();
	return {
		details: values
			.slice(1)
			.filter((value) => !(value instanceof Error))
			.map(formatValue)
			.map(sanitizeDiagnosticLine)
			.filter(Boolean),
		error,
		summary: first || "Agent runtime diagnostic",
	};
}

function detachedRunnerLine(severity: "error" | "warning", summary: string, details: readonly string[]): string {
	const line = `[pi-stuff-agents] ${severity}: ${[summary, ...details].filter(Boolean).join(" · ")}`;
	return line;
}

function emitAgentDiagnostic(severity: "error" | "warning", values: readonly unknown[]): void {
	const { details, error, summary } = normalize(values);
	if (process.env["PI_STUFF_BACKGROUND_RUNNER"] === "1") {
		writeDetachedRunnerDiagnostic(
			detachedRunnerLine(severity, summary, [
				...details,
				...(error ? [sanitizeDiagnosticLine(formatValue(error))] : []),
			]),
		);
		return;
	}

	reportDiagnostic({
		capability: "Agents",
		details,
		error,
		key: summary,
		severity,
		summary,
		visibility: "silent",
	});
}

export function reportAgentDiagnostic(...values: unknown[]): void {
	emitAgentDiagnostic("error", values);
}

export function reportAgentWarning(...values: unknown[]): void {
	emitAgentDiagnostic("warning", values);
}
