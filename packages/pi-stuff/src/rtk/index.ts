import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { getCommandDialogCoordinator } from "../conversation-ui/index.ts";
import { HOST_SHUTDOWN_GRACE_MS } from "../lifecycle-deadline.ts";
import { type EffectFoundation, installEffectFoundation } from "../shared/effect-foundation.ts";
import { createRtkProjectionAdapter } from "./projection.ts";
import { createRtkDialogView } from "./rtk-dialog.ts";
import { RtkRuntime } from "./runtime.ts";
import { RtkSettingsStore } from "./settings.ts";

export {
	type ContextProjectionAdapter,
	createRtkProjectionAdapter,
	RtkProjectionAdapter,
	type RtkProjectionOptions,
	type RtkProjectionStatsSnapshot,
} from "./projection.ts";
export {
	CERTIFIED_RTK_VERSION,
	RtkRuntime,
	type RtkRuntimeOptions,
	type RtkRuntimeSnapshot,
	type RtkRuntimeState,
} from "./runtime.ts";
export { type RtkSettings, RtkSettingsStore } from "./settings.ts";

async function runRtkOperation<Value, ErrorType>(
	foundation: EffectFoundation,
	program: Effect.Effect<Value, ErrorType>,
	signal?: AbortSignal,
): Promise<Value | undefined> {
	const session = foundation.currentSession();
	if (!session) return undefined;
	const operation = foundation.forkOperation(session);
	const exit = await foundation.run(operation, program, { signal });
	await foundation.close(operation, exit);
	if (Exit.isFailure(exit)) {
		if (Cause.hasInterrupts(exit.cause)) return undefined;
		throw Cause.squash(exit.cause);
	}
	return foundation.isCurrent(session) ? exit.value : undefined;
}

export default async function piStuffRtk(pi: ExtensionAPI): Promise<void> {
	const foundation = installEffectFoundation(pi);
	const dialogs = getCommandDialogCoordinator(pi);
	const settings = await Effect.runPromise(RtkSettingsStore.load());
	const runtime = new RtkRuntime();
	const projection = createRtkProjectionAdapter({ enabled: () => settings.get().outputProjection });
	pi.on("tool_call", async (event, ctx) => {
		if (!settings.get().rewriteCommands || !isToolCallEventType("bash", event)) return;
		const rewritten = await runRtkOperation(foundation, runtime.rewrite(pi, event.input.command), ctx.signal);
		if (rewritten) event.input.command = rewritten;
	});

	pi.on("context", (event, ctx) => {
		const messages = projection.project(event.messages, ctx.signal);
		return messages === event.messages ? undefined : { messages };
	});

	pi.registerCommand("rtk", {
		description: "Inspect and configure RTK",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("/rtk requires interactive TUI mode.", "warning");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("/rtk takes no subcommands; run /rtk.", "warning");
				return;
			}
			await dialogs.show(
				ctx,
				createRtkDialogView({
					onPersistenceError: (message) => ctx.ui.notify(message, "error"),
					projection,
					runtime,
					setOutputProjection: async (enabled) => {
						await runRtkOperation(foundation, settings.setOutputProjection(enabled), ctx.signal);
					},
					setRewriteCommands: async (enabled) => {
						await runRtkOperation(foundation, settings.setRewriteCommands(enabled), ctx.signal);
					},
					settings,
					verify: async (signal) => {
						await runRtkOperation(foundation, runtime.verify(pi, { refresh: true }), signal);
					},
				}),
			);
		},
	});

	pi.on("session_start", () => {
		runtime.reset();
		projection.reset();
	});
	pi.on("session_tree", () => projection.reset());
	pi.on("session_shutdown", async () => {
		await Effect.runPromise(settings.whenIdle().pipe(Effect.timeoutOption(HOST_SHUTDOWN_GRACE_MS), Effect.asVoid));
	});
}
