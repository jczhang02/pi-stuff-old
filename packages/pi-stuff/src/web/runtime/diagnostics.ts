import { reportDiagnostic } from "../../conversation-ui/diagnostics.ts";
import type { JsonInputValue } from "../../shared/json-value.ts";

interface WebDiagnosticOptions {
	readonly action?: string;
	readonly key?: string;
	readonly notice?: boolean;
	readonly severity?: "error" | "info" | "warning";
}

export function reportWebDiagnostic(summary: string, error?: JsonInputValue, options: WebDiagnosticOptions = {}): void {
	const report = {
		capability: "Web",
		severity: options.severity ?? "error",
		summary,
		visibility: options.notice ? "notice" : "silent",
	} as const;
	if (options.action) Object.assign(report, { action: options.action });
	if (error !== undefined) Object.assign(report, { error });
	if (options.key) Object.assign(report, { key: options.key });
	reportDiagnostic(report);
}
