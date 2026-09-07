import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
	type CommandDialogCoordinatorHost,
	getCommandDialogCoordinator,
	readCurrentAgentWorkOrigin,
	reportDiagnostic,
} from "../conversation-ui/index.ts";
import { HOST_SHUTDOWN_GRACE_MS } from "../lifecycle-deadline.ts";
import { type EffectFoundation, type EffectScopeOwner, installEffectFoundation } from "../shared/effect-foundation.ts";
import { extractNotificationPreview, formatNotificationContent } from "./format.ts";
import { createNotificationSettingsView } from "./notification-settings-dialog.ts";
import { type NotificationClock, NotificationRuntime, type NotificationRuntimeEvent } from "./runtime.ts";
import { type NotificationSettings, NotificationSettingsStore } from "./settings.ts";
import { sendTerminalNotification, type TerminalNotificationResult } from "./transport.ts";

export type NotificationHost = CommandDialogCoordinatorHost & Pick<ExtensionAPI, "registerCommand">;

interface ActiveNotificationSession {
	readonly capability: EffectScopeOwner;
	readonly runtime: NotificationRuntime;
}

function createNotificationClock(foundation: EffectFoundation, capability: EffectScopeOwner): NotificationClock {
	return {
		now: Date.now,
		schedule: (callback, delayMs) => {
			const operation = foundation.forkOperation(capability);
			void foundation
				.run(operation, Effect.sleep(Math.max(0, delayMs)).pipe(Effect.andThen(Effect.sync(callback))))
				.then((exit) => foundation.close(operation, exit));
			return () => {
				void foundation.close(operation, Exit.interrupt());
			};
		},
	};
}

function acquireTerminalInput(ctx: ExtensionContext, runtime: NotificationRuntime) {
	return Effect.acquireRelease(
		Effect.sync(() =>
			ctx.mode === "tui" && ctx.hasUI
				? ctx.ui.onTerminalInput(() => {
						runtime.observe({ type: "terminal_input" });
						return undefined;
					})
				: undefined,
		),
		(remove) => Effect.sync(() => remove?.()),
	).pipe(Effect.asVoid);
}

async function runNotificationOperation(
	foundation: EffectFoundation,
	program: Effect.Effect<void, Error>,
): Promise<void> {
	const session = foundation.currentSession();
	if (!session) return;
	const operation = foundation.forkOperation(session);
	const exit = await foundation.run(operation, program);
	await foundation.close(operation, exit);
	if (Exit.isFailure(exit) && !Cause.hasInterrupts(exit.cause)) throw Cause.squash(exit.cause);
}

function sessionLabel(ctx: ExtensionContext): string {
	return ctx.sessionManager.getSessionName()?.trim() || basename(ctx.cwd) || "Pi session";
}

function notify(
	ctx: ExtensionContext,
	settings: NotificationSettings,
	title: string,
	body: string,
): TerminalNotificationResult {
	const result = sendTerminalNotification({
		body,
		delivery: settings.delivery,
		hasUI: ctx.hasUI,
		mode: ctx.mode,
		terminalBell: settings.terminalBell,
		title,
		tmuxNotification: settings.tmuxNotification,
	});
	if (result === "failed") {
		reportDiagnostic({
			capability: "Notification",
			key: "transport-write",
			severity: "warning",
			summary: "The terminal notification could not be written",
		});
	}
	return result;
}

function sendTestNotification(ctx: ExtensionContext, settings: NotificationSettings): void {
	const result = notify(ctx, settings, "Pi · Notification test", "Notifications are working.");
	if (result === "sent") return;
	ctx.ui.notify(
		result === "unsupported"
			? "No supported terminal notification protocol was detected. Choose a delivery mode in /notifications."
			: "The test notification could not be sent.",
		"warning",
	);
}

export async function installNotificationCapability(
	pi: NotificationHost,
	settings: NotificationSettingsStore,
	clock?: NotificationClock,
): Promise<void> {
	const foundation = installEffectFoundation(pi);
	const dialogs = getCommandDialogCoordinator(pi);
	let active: ActiveNotificationSession | undefined;
	let settledObserverRegistered = false;
	const disposeActive = async (): Promise<void> => {
		const current = active;
		active = undefined;
		if (!current) return;
		current.runtime.dispose();
		await foundation.close(current.capability, Exit.interrupt());
	};

	pi.registerCommand("notifications", {
		description: "Configure and test desktop notifications",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui" || !ctx.hasUI) {
				ctx.ui.notify("/notifications requires interactive TUI mode.", "warning");
				return;
			}
			await dialogs.show(
				ctx,
				createNotificationSettingsView(
					settings,
					{
						update: async (patch) => {
							await runNotificationOperation(foundation, settings.update(patch));
						},
					},
					{
						onPersistenceError: (message) => ctx.ui.notify(message, "error"),
						onTest: () => sendTestNotification(ctx, settings.get()),
					},
				),
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		await disposeActive();
		const session = foundation.sessionFor(ctx.sessionManager);
		if (!session) throw new Error("Notification Session Scope was not initialized.");
		if (!foundation.isCurrent(session)) return;
		const capability = foundation.forkCapability(session);
		const runtime = new NotificationRuntime({
			clock: clock ?? createNotificationClock(foundation, capability),
			getSettings: () => settings.get(),
			isQuiet: () => ctx.isIdle() && !ctx.hasPendingMessages(),
			notify: (alert) => {
				const current = settings.get();
				const notification: Parameters<typeof formatNotificationContent>[0] = {
					includeResponsePreview: current.responsePreview,
					outcome: alert.outcome,
					session: sessionLabel(ctx),
				};
				if (alert.preview) Object.assign(notification, { preview: alert.preview });
				const content = formatNotificationContent(notification);
				notify(ctx, current, content.title, content.body);
			},
		});
		const current = { capability, runtime };
		active = current;
		const exit = await foundation.run(capability, acquireTerminalInput(ctx, runtime));
		if (Exit.isFailure(exit)) {
			if (active === current) await disposeActive();
			if (!Cause.hasInterruptsOnly(exit.cause)) throw Cause.squash(exit.cause);
		}
		if (!settledObserverRegistered) {
			settledObserverRegistered = true;
			pi.on("agent_settled", () => active?.runtime.observe({ type: "agent_settled" }));
		}
	});
	pi.on("input", () => active?.runtime.observe({ type: "input" }));
	pi.on("agent_start", () => active?.runtime.observe({ type: "agent_start" }));
	pi.on("agent_end", () => active?.runtime.observe({ type: "agent_end" }));
	pi.on("ui_prompt_start", () => active?.runtime.observe({ type: "ui_prompt_start" }));
	pi.on("ui_prompt_end", () => active?.runtime.observe({ type: "ui_prompt_end" }));
	pi.on("message_start", () => {
		if (active && readCurrentAgentWorkOrigin(pi) === "user") active.runtime.observe({ type: "user_work" });
	});
	pi.on("message_end", (event) => {
		if (!active || event.message.role !== "assistant") return;
		const preview = extractNotificationPreview(event.message.content);
		const observation: NotificationRuntimeEvent = {
			stopReason: event.message.stopReason,
			type: "assistant_finalized",
		};
		if (event.message.errorMessage !== undefined) {
			Object.assign(observation, { errorMessage: event.message.errorMessage });
		}
		if (preview) Object.assign(observation, { preview });
		active.runtime.observe(observation);
	});
	pi.on("session_shutdown", async () => {
		await disposeActive();
		await Effect.runPromise(settings.whenIdle().pipe(Effect.timeoutOption(HOST_SHUTDOWN_GRACE_MS), Effect.asVoid));
	});
}

export default async function piStuffNotification(pi: NotificationHost): Promise<void> {
	await installNotificationCapability(pi, await Effect.runPromise(NotificationSettingsStore.load()));
}
