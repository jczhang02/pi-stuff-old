import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { isRuntimeString } from "../../shared/runtime-type.ts";
import { completeGoalArguments, parseCommand } from "./command.ts";
import type { GoalCommandController } from "./commands.ts";
import { showGoalManager } from "./menu.ts";
import type { GoalRuntime } from "./runtime.ts";
import type { GoalSettingsStore } from "./settings.ts";
import { showGoalSettings } from "./settings-ui.ts";

interface GoalCommandRegistrationOptions {
	readonly onProjectionNeeded: () => void;
	readonly run: (
		ctx: ExtensionCommandContext,
		program: Effect.Effect<void, unknown>,
		cancellable: boolean,
	) => Promise<void>;
	readonly settingsPath: string | undefined;
	readonly settingsStore: () => GoalSettingsStore | undefined;
}

export function registerGoalCommand(
	pi: ExtensionAPI,
	runtime: GoalRuntime,
	commands: GoalCommandController,
	options: GoalCommandRegistrationOptions,
): void {
	pi.registerCommand("goal", {
		description: "Run a goal to completion: /goal [--tokens 100k] <goal_to_complete>",
		getArgumentCompletions: (prefix) =>
			completeGoalArguments(prefix, { experimentalGoals: runtime.settings.experimental.goals }),
		handler: (args, ctx) =>
			options.run(
				ctx,
				dispatchGoalCommand(args, ctx, runtime, commands, options),
				ctx.mode === "tui" && args.trim() === "",
			),
	});
}

function dispatchGoalCommand(
	args: string,
	ctx: ExtensionCommandContext,
	runtime: GoalRuntime,
	commands: GoalCommandController,
	options: GoalCommandRegistrationOptions,
): Effect.Effect<void, unknown> {
	return Effect.suspend(() => {
		const result = parseCommand(args, { experimentalGoals: runtime.settings.experimental.goals });
		if (isRuntimeString(result)) {
			ctx.ui.notify(result, "warning");
			return Effect.void;
		}
		if (result.kind === "show" && args.trim() === "") {
			if (ctx.mode !== "tui") {
				commands.showGoal(ctx);
				return Effect.void;
			}
			return showGoalManager(runtime, commands, ctx, (menuCtx) =>
				showGoalSettings(runtime, menuCtx, {
					settingsPath: options.settingsPath,
					store: options.settingsStore(),
					onQueueUnfrozen: (settingsCtx) => commands.resumeQueueAfterUnfreeze(settingsCtx),
				}),
			);
		}
		if (runtime.queueFrozen) {
			if (result.kind === "show") commands.showGoal(ctx);
			else if (result.kind === "clear") return commands.clearGoal(ctx);
			else commands.notifyFrozenQueue(ctx);
			return Effect.void;
		}
		if (runtime.pendingQueueAction && result.kind !== "show" && result.kind !== "clear") {
			ctx.ui.notify("A queued goal change is waiting for Pi to settle. Retry after it finishes.", "warning");
			return Effect.void;
		}

		const command = Effect.gen(function* () {
			switch (result.kind) {
				case "show":
					commands.showGoal(ctx);
					return;
				case "pause":
					commands.pauseGoal(ctx);
					return;
				case "resume":
					yield* commands.resumeGoal(ctx);
					return;
				case "clear":
					yield* commands.clearGoal(ctx);
					return;
				case "edit":
					yield* commands.editGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "add":
					yield* commands.addGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "prioritize":
					yield* commands.prioritizeGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
				case "drop-last":
					yield* commands.dropLastGoal(ctx);
					return;
				case "skip":
					yield* commands.skipGoal(ctx);
					return;
				case "start":
					yield* commands.startGoal(result.objective ?? "", result.tokenBudget, ctx);
					return;
			}
		});
		return command.pipe(
			Effect.ensuring(
				Effect.sync(() => {
					if (runtime.activeGoal || runtime.queuedGoals.length > 0 || runtime.pendingQueueAction) {
						options.onProjectionNeeded();
					}
				}),
			),
		);
	});
}
