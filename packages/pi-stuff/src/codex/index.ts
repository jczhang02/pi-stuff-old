import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
	getCodexStatusChannel,
	getCommandDialogCoordinator,
	listenForUserAgentRunSettled,
} from "../conversation-ui/index.ts";
import { type EffectFoundation, installEffectFoundation } from "../shared/effect-foundation.ts";
import { isRuntimeObject } from "../shared/runtime-type.ts";
import { isOpenAICodexResponsesModel } from "./account.ts";
import { type CodexControls, createCodexDialogView } from "./dialog.ts";
import { CodexSettingsStore } from "./settings.ts";
import { registerCodexTools } from "./tools.ts";
import { type CodexUsageSnapshot, fetchCodexUsage, formatCodexUsage, weeklyRemainingPercent } from "./usage.ts";

function requestPayloadWithFast<Payload>(payload: Payload) {
	if (!isRuntimeObject(payload) || payload === null || Array.isArray(payload)) return undefined;
	return { ...payload, service_tier: "priority" };
}

async function runCodexOperation<A>(
	foundation: EffectFoundation,
	program: Effect.Effect<A, Error>,
	unavailableMessage: string,
	cancelledMessage: string,
	signal?: AbortSignal | undefined,
): Promise<A> {
	const session = foundation.currentSession();
	if (!session) throw new Error(unavailableMessage);
	const operation = foundation.forkOperation(session);
	const exit = await foundation.run(operation, program, { signal });
	await foundation.close(operation, exit);
	if (signal?.aborted) throw signal.reason;
	if (Exit.isFailure(exit)) {
		if (Cause.hasInterrupts(exit.cause)) throw new Error(cancelledMessage);
		throw Cause.squash(exit.cause);
	}
	if (!foundation.isCurrent(session)) throw new Error(cancelledMessage);
	return exit.value;
}

export async function runCodexUsageOperation(
	foundation: EffectFoundation,
	program: Effect.Effect<CodexUsageSnapshot, Error>,
	commit: (snapshot: CodexUsageSnapshot) => void,
	signal?: AbortSignal | undefined,
): Promise<CodexUsageSnapshot> {
	const snapshot = await runCodexOperation(
		foundation,
		program,
		"Codex usage is unavailable before Session start.",
		"Codex usage request was cancelled.",
		signal,
	);
	commit(snapshot);
	return snapshot;
}

export default async function piStuffCodex(pi: ExtensionAPI): Promise<void> {
	const foundation = installEffectFoundation(pi);
	const settings = await Effect.runPromise(CodexSettingsStore.load());
	const status = getCodexStatusChannel(pi);
	const tools = registerCodexTools(pi);
	let active = true;
	let usage: CodexUsageSnapshot | undefined;

	const publishStatus = (): void => {
		if (!active) return;
		const weekly = weeklyRemainingPercent(usage);
		const snapshot: Parameters<typeof status.publish>[0] = { fastEnabled: settings.get().fast };
		if (weekly !== undefined) Object.assign(snapshot, { weeklyRemainingPercent: weekly });
		status.publish(snapshot);
	};
	const controls = (ctx: ExtensionContext): CodexControls => ({
		getFast: () => settings.get().fast,
		getUsage: () => usage,
		refreshUsage(signal) {
			return runCodexUsageOperation(
				foundation,
				fetchCodexUsage(ctx),
				(snapshot) => {
					if (!active) throw new Error("Codex usage request was cancelled.");
					usage = snapshot;
					publishStatus();
				},
				signal,
			);
		},
		async setFast(enabled) {
			await runCodexOperation(
				foundation,
				settings.setFast(enabled),
				"Codex settings are unavailable before Session start.",
				"Codex settings update was cancelled.",
			);
			publishStatus();
		},
	});
	let automaticRefreshContext: ExtensionContext | undefined;
	let automaticRefreshRunning = false;
	const refreshUsageAfterUserWork = (ctx: ExtensionContext): void => {
		if (!active || !ctx.hasUI || !isOpenAICodexResponsesModel(ctx.model)) return;
		automaticRefreshContext = ctx;
		if (automaticRefreshRunning) return;
		automaticRefreshRunning = true;
		void (async () => {
			try {
				while (active && automaticRefreshContext) {
					const refreshContext = automaticRefreshContext;
					automaticRefreshContext = undefined;
					try {
						await controls(refreshContext).refreshUsage(refreshContext.signal);
					} catch {
						// Manual /codex refresh remains the visible recovery path.
					}
				}
			} finally {
				automaticRefreshRunning = false;
				if (active && automaticRefreshContext) refreshUsageAfterUserWork(automaticRefreshContext);
			}
		})();
	};
	const stopListeningForUserAgentRunSettled = listenForUserAgentRunSettled(pi, refreshUsageAfterUserWork);

	publishStatus();
	pi.registerCommand("codex", {
		description: "Open Codex Fast and usage controls",
		getArgumentCompletions: (prefix) =>
			["fast", "usage"]
				.filter((value) => value.startsWith(prefix.trim().toLowerCase()))
				.map((value) => ({ label: value, value })),
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();
			const model = controls(ctx);
			if (argument === "fast") {
				try {
					await model.setFast(!model.getFast());
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (argument && argument !== "usage") {
				ctx.ui.notify("Usage: /codex [fast|usage]", "warning");
				return;
			}
			if (!ctx.hasUI) {
				try {
					ctx.ui.notify(formatCodexUsage(await model.refreshUsage(ctx.signal)), "info");
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			await getCommandDialogCoordinator(pi).show(ctx, createCodexDialogView(model));
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== "openai-codex" || !settings.get().fast) return undefined;
		return requestPayloadWithFast(event.payload);
	});
	pi.on("session_start", (_event, ctx) => {
		tools.sync(ctx.model);
		publishStatus();
	});
	pi.on("model_select", (_event, ctx) => tools.sync(ctx.model));
	pi.on("session_shutdown", async () => {
		active = false;
		automaticRefreshContext = undefined;
		stopListeningForUserAgentRunSettled();
		tools.deactivate();
		status.clear();
		await Effect.runPromise(settings.whenIdle());
	});
}
