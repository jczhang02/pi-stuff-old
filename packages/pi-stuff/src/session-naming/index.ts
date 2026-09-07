import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
	type CommandDialogCoordinatorHost,
	getCommandDialogCoordinator,
	listenForUserAgentRunSettled,
} from "../conversation-ui/index.ts";
import { HOST_SHUTDOWN_GRACE_MS } from "../lifecycle-deadline.ts";
import { type EffectFoundation, type EffectScopeOwner, installEffectFoundation } from "../shared/effect-foundation.ts";
import { SessionNamingController } from "./controller.ts";
import { generateSessionName } from "./model.ts";
import { SessionNamingSettingsStore } from "./settings.ts";
import { createSessionNamingSettingsView, type SessionNamingModelChoice } from "./settings-dialog.ts";
import { type RenameMarker, SESSION_NAMING_STATE_ENTRY_TYPE } from "./state.ts";

const CHILD_AGENT_ENV = "PI_SUBAGENT_CHILD";

export type SessionNamingHost = CommandDialogCoordinatorHost &
	Pick<ExtensionAPI, "appendEntry" | "getSessionName" | "registerCommand" | "setSessionName">;

function isChildAgentSession(environment: NodeJS.ProcessEnv): boolean {
	return environment[CHILD_AGENT_ENV] === "1";
}

function createController(
	pi: SessionNamingHost,
	ctx: ExtensionContext,
	settings: SessionNamingSettingsStore,
): SessionNamingController {
	const current = settings.get();
	return new SessionNamingController(current, {
		appendMarker(marker: RenameMarker) {
			pi.appendEntry(SESSION_NAMING_STATE_ENTRY_TYPE, marker);
		},
		generate: (messages, currentName) => generateSessionName(ctx, current, messages, currentName),
		getBranch: () => ctx.sessionManager.getBranch(),
		getSessionName: () => pi.getSessionName(),
		now: Date.now,
		setSessionName: (name) => pi.setSessionName(name),
	});
}

async function runOperation<Value, ErrorType>(
	foundation: EffectFoundation,
	operation: EffectScopeOwner,
	program: Effect.Effect<Value, ErrorType>,
): Promise<Value | undefined> {
	const exit = await foundation.run(operation, program);
	await foundation.close(operation, exit);
	if (Exit.isSuccess(exit)) return exit.value;
	if (Cause.hasInterrupts(exit.cause)) return undefined;
	throw Cause.squash(exit.cause);
}

function availableNamingModelChoices(ctx: ExtensionContext): SessionNamingModelChoice[] {
	const models =
		ctx.scopedModels.length > 0 ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable();
	return models.map((model): SessionNamingModelChoice => {
		const value = `${model.provider}/${model.id}`;
		if (model.name === model.id) return { value };
		return { description: model.name, value };
	});
}

export function installSessionNamingCapability(
	pi: SessionNamingHost,
	settings: SessionNamingSettingsStore,
	environment: NodeJS.ProcessEnv = process.env,
): void {
	const foundation = installEffectFoundation(pi);
	const dialogs = getCommandDialogCoordinator(pi);
	let controller: SessionNamingController | undefined;
	let sessionContext: ExtensionContext | undefined;
	let activeOperation: EffectScopeOwner | undefined;
	const cancelOperation = async (): Promise<void> => {
		const operation = activeOperation;
		if (!operation) return;
		await foundation.close(operation, Exit.interrupt());
		if (activeOperation === operation) activeOperation = undefined;
	};
	const runNaming = async (
		target: SessionNamingController,
		ctx: ExtensionContext,
		program: Effect.Effect<string | undefined>,
	): Promise<string | undefined> => {
		const session = foundation.sessionFor(ctx.sessionManager);
		if (!session || !foundation.isCurrent(session) || target !== controller) return undefined;
		const operation = foundation.forkOperation(session);
		activeOperation = operation;
		try {
			return await runOperation(foundation, operation, program);
		} catch {
			return undefined;
		} finally {
			if (activeOperation === operation) activeOperation = undefined;
		}
	};
	const rebuildController = () => {
		if (!sessionContext) return;
		controller?.shutdown();
		void cancelOperation();
		controller = createController(pi, sessionContext, settings);
		controller.restore();
	};
	const stopListeningForSettings = settings.subscribe(rebuildController);
	const stopListeningForUserAgentRunSettled = listenForUserAgentRunSettled(pi, (ctx) => {
		if (isChildAgentSession(environment) || ctx !== sessionContext || !controller || activeOperation) return;
		void runNaming(controller, ctx, controller.handleSettled());
	});

	pi.registerCommand("autoname", {
		description: "Regenerate or configure the current Session name",
		getArgumentCompletions: (prefix) => {
			const normalized = prefix.trimStart().toLowerCase();
			// Pi requeries after applying a completion; returning the exact item would reopen the list and trap submit.
			if (normalized === "settings") return null;
			if (/\s/u.test(normalized) || !"settings".startsWith(normalized)) return null;
			return [{ label: "settings", value: "settings" }];
		},
		handler: async (args, ctx) => {
			const argument = args.trim().toLowerCase();
			if (argument === "settings") {
				if (ctx.mode !== "tui" || !ctx.hasUI) {
					ctx.ui.notify("/autoname settings requires interactive TUI mode.", "warning");
					return;
				}
				await dialogs.show(
					ctx,
					createSessionNamingSettingsView(
						settings,
						{
							update: async (patch) => {
								const session = foundation.sessionFor(ctx.sessionManager);
								if (!session || !foundation.isCurrent(session)) return;
								await runOperation(foundation, foundation.forkOperation(session), settings.update(patch));
							},
						},
						{
							modelChoices: availableNamingModelChoices(ctx),
							onPersistenceError: (message) => ctx.ui.notify(message, "error"),
						},
					),
				);
				return;
			}
			if (argument) {
				ctx.ui.notify("Usage: /autoname [settings]", "warning");
				return;
			}
			if (!controller) {
				ctx.ui.notify("Session Naming is not ready.", "warning");
				return;
			}
			const target = controller;
			await cancelOperation();
			const name = await runNaming(target, ctx, target.renameManually());
			ctx.ui.notify(
				name ? `Session named: ${name}` : "Could not generate a Session name.",
				name ? "info" : "warning",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		controller?.shutdown();
		void cancelOperation();
		sessionContext = ctx;
		controller = createController(pi, ctx, settings);
		controller.restore();
	});
	pi.on("session_info_changed", (event, ctx) => {
		if (ctx !== sessionContext || !controller) return;
		if (controller.observeSessionNameChange(event.name)) void cancelOperation();
	});
	pi.on("session_shutdown", async () => {
		stopListeningForSettings();
		stopListeningForUserAgentRunSettled();
		controller?.shutdown();
		await cancelOperation();
		controller = undefined;
		sessionContext = undefined;
		await Effect.runPromise(settings.whenIdle().pipe(Effect.timeoutOption(HOST_SHUTDOWN_GRACE_MS), Effect.asVoid));
	});
}

export default async function piStuffSessionNaming(pi: ExtensionAPI): Promise<void> {
	installSessionNamingCapability(pi, await Effect.runPromise(SessionNamingSettingsStore.load()));
}
