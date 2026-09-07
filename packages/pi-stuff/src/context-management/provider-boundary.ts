import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { reportDiagnostic } from "../conversation-ui/index.ts";
import type { ContextStatusChannel } from "../conversation-ui/statusline-channels.ts";
import { estimateProviderPayloadTokens } from "../shared/provider-payload.ts";
import { applyContextPromptContributionsToProvider } from "./prompt-contributions.ts";
import type { ContextCapabilityRuntime } from "./runtime.ts";

export function registerContextProviderBoundary(
	pi: ExtensionAPI,
	runtime: ContextCapabilityRuntime,
	status: ContextStatusChannel,
): void {
	let providerPromptDiagnosticReported = false;
	pi.on("before_provider_request", async (event, ctx) => {
		const candidateToken = runtime.currentProviderProjectionToken();
		const projection = await applyContextPromptContributionsToProvider(pi, event.payload, ctx);
		if (projection.active && !projection.found && !providerPromptDiagnosticReported) {
			providerPromptDiagnosticReported = true;
			reportDiagnostic({
				capability: "Context",
				error: new Error("Provider payload has no supported system-prompt field."),
				key: "provider-prompt-contribution",
				severity: "warning",
				summary: "A Context prompt contribution could not be projected into this Provider request",
				visibility: "silent",
			});
		}
		const payload = projection.payload;
		if (candidateToken !== runtime.currentProviderProjectionToken())
			return payload === event.payload ? undefined : payload;
		if (runtime.status().engine !== "magic-context") return payload === event.payload ? undefined : payload;
		if (candidateToken === undefined) {
			status.publish({ state: "unknown" });
			if (!ctx.signal?.aborted) {
				ctx.abort();
				ctx.ui.notify(
					`Magic Context projection is unavailable: ${runtime.status().error ?? "no current projection"}. The Session and current input are preserved.`,
					"error",
				);
			}
			return undefined;
		}
		const contextWindow = ctx.model?.contextWindow;
		let estimatedTokens: number | undefined;
		try {
			const serialized = JSON.stringify(payload);
			if (serialized !== undefined) estimatedTokens = estimateProviderPayloadTokens(serialized, ctx.model);
		} catch {
			// Missing estimates are display uncertainty, not evidence of Provider rejection.
		}
		if (
			contextWindow === undefined ||
			estimatedTokens === undefined ||
			!Number.isFinite(estimatedTokens) ||
			!Number.isFinite(contextWindow) ||
			contextWindow <= 0
		) {
			status.publish({ state: "unknown" });
			return payload === event.payload ? undefined : payload;
		}
		status.publish({
			state: "validated",
			tokens: estimatedTokens,
			contextWindow,
		});
		return payload === event.payload ? undefined : payload;
	});
	pi.on("message_end", (event: { message: { role: string; stopReason?: string } }) => {
		if (event.message.role !== "assistant") return;
		if (event.message.stopReason === "error" || event.message.stopReason === "aborted") {
			status.publish({ state: "unknown" });
			return;
		}
		status.clear();
	});
}
