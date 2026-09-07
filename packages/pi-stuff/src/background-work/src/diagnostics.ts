import { reportDiagnostic } from "../../conversation-ui/diagnostics.ts";

interface WorkDiagnosticOptions {
	readonly action?: string;
	readonly key?: string;
	readonly notice?: boolean;
	readonly severity?: "error" | "info" | "warning";
}

export function reportWorkDiagnostic(summary: string, cause?: unknown, options: WorkDiagnosticOptions = {}): void {
	const diagnostic: Parameters<typeof reportDiagnostic>[0] = {
		capability: "Background Work",
		severity: options.severity ?? "error",
		summary,
		visibility: options.notice ? "notice" : "silent",
	};
	if (options.action) Object.assign(diagnostic, { action: options.action });
	if (cause !== undefined) Object.assign(diagnostic, { error: cause });
	if (options.key) Object.assign(diagnostic, { key: options.key });
	reportDiagnostic(diagnostic);
}
