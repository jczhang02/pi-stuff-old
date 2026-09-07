import type { ExtensionAPI, ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { whenSuiteSessionReady } from "../../conversation-ui/index.ts";
import { currentTokenTotal } from "./accounting.ts";
import type { GoalCommandController } from "./commands.ts";
import { loadGoalStateFromSession } from "./persistence.ts";
import { buildGoalPrompt } from "./prompts.ts";
import { activateQueuedGoal } from "./queue.ts";
import type { GoalRunController } from "./run-protocol.ts";
import { formatError, type GoalRuntime, resetGoalSafetyEpoch, transitionGoal } from "./runtime.ts";
import { GoalSettingsStore } from "./settings.ts";

export interface GoalSessionLifecycle {
	readonly commands: GoalCommandController;
	goalProjectionNeeded: boolean;
	readonly options: { readonly settingsPath?: string | undefined };
	readonly pi: ExtensionAPI;
	readonly runController: GoalRunController;
	readonly runtime: GoalRuntime;
	settingsStore: GoalSettingsStore | undefined;
	turnActive: boolean;
}

export type GoalStartupDispatch = Effect.Effect<void, unknown>;

const EXPERIMENTAL_GOALS_WARNING =
	"Experimental ordered goals are enabled for pi-goal. Queue behavior and persisted state may change.";

function clearGoalSessionWork(runtime: GoalRuntime): void {
	runtime.prompts.clearContinuationTracking();
	runtime.prompts.clearPendingGoalPrompts();
	runtime.clearAgentRun();
	runtime.guardAbortGoalId = undefined;
	runtime.goalRecovery = undefined;
	runtime.clearBudgetWrapUp();
	runtime.clearStaleGoalToolCallBlock();
	runtime.queuedGoals = [];
	runtime.pendingQueueAction = undefined;
	runtime.queueFrozen = false;
	runtime.queueFreezeAwaitingSettle = false;
}

function resetGoalSession(lifecycle: GoalSessionLifecycle): void {
	const { runtime } = lifecycle;
	runtime.invalidateMenuSession();
	clearGoalSessionWork(runtime);
	runtime.clearTerminalDetails();
	lifecycle.settingsStore = undefined;
}

function loadGoalSessionSettings(
	lifecycle: GoalSessionLifecycle,
	ctx: ExtensionContext,
	previousToolVisibility: GoalRuntime["settings"]["toolVisibility"],
): Effect.Effect<void, Error> {
	return Effect.gen(function* () {
		const { options, runtime } = lifecycle;
		const store = yield* GoalSettingsStore.load(options.settingsPath);
		lifecycle.settingsStore = store;
		runtime.settings = store.get();
		runtime.settingsLoadIssue = store.loadIssue;
		if (store.loadIssue) {
			ctx.ui.notify(`pi-goal settings ignored: ${store.loadIssue.reason}. Using default settings.`, "warning");
		}
		if (runtime.settings.experimental.goals) ctx.ui.notify(EXPERIMENTAL_GOALS_WARNING, "warning");
		if (runtime.settings.toolVisibility === "after-first-goal" && previousToolVisibility === "always") {
			runtime.goalToolsUnlocked = false;
		}
		if (runtime.settings.toolVisibility !== "always") return;
		if (runtime.goalToolsHiddenByPolicy.size > 0) {
			try {
				runtime.restoreGoalToolsHiddenByPolicy();
			} catch (error) {
				ctx.ui.notify(`Could not restore always-visible goal tools: ${formatError(error)}`, "error");
			}
		}
		runtime.goalToolsUnlocked = true;
	});
}

function restoreActiveGoalSession(
	lifecycle: GoalSessionLifecycle,
	ctx: ExtensionContext,
	startRestoredQueuedGoal: boolean,
	reloaded: boolean,
): GoalStartupDispatch | undefined {
	const { pi, runtime } = lifecycle;
	if (runtime.activeGoal?.status === "active" && runtime.activeGoal.safetyResetPending) {
		runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
	}
	if (runtime.activeGoal?.status === "active") {
		runtime.recordGoalUsage(runtime.activeGoal, ctx);
		if (runtime.limitActiveGoalForBudget(ctx)) return;
		if (runtime.enforceAutomaticTurnLimit(ctx, false) || runtime.enforceNoProgressLimit(ctx)) return;
	}
	if (runtime.settings.toolVisibility === "after-first-goal") {
		// A restrictive earlier session_start policy wins; lazy visibility does not widen it.
		runtime.goalToolsUnlocked = true;
		runtime.goalToolsHiddenByPolicy.clear();
	}
	if (runtime.activeGoal?.status === "active" && !runtime.goalToolsAvailable()) {
		runtime.pauseGoalForUnavailableTools(ctx, false);
		return;
	}
	if (!runtime.activeGoal) return;
	runtime.persistGoal(runtime.activeGoal);
	if (startRestoredQueuedGoal) {
		const restoredGoal = runtime.activeGoal;
		return Effect.gen(function* () {
			if (!(yield* suiteReady(pi, ctx))) return;
			if (runtime.activeGoal?.id !== restoredGoal.id || runtime.activeGoal.status !== "active") return;
			const sent = yield* runtime.sendOwnedGoalPrompt(ctx, restoredGoal.id, buildGoalPrompt(restoredGoal), {
				resetSafetyEpoch: false,
			});
			if (!sent && runtime.activeGoal?.id === restoredGoal.id) {
				runtime.activeGoal = transitionGoal(restoredGoal, "paused");
				runtime.blockStaleGoalToolCalls();
				runtime.persistGoal(runtime.activeGoal);
			}
		});
	}
	if (runtime.activeGoal.status !== "active" || !reloaded) return;
	runtime.prompts.requestContinuation(runtime.activeGoal);
	return Effect.gen(function* () {
		if (yield* suiteReady(pi, ctx)) yield* runtime.dispatchContinuationIfSettled(ctx);
	});
}

function restoreGoalSession(
	lifecycle: GoalSessionLifecycle,
	ctx: ExtensionContext,
	reloaded: boolean,
): GoalStartupDispatch | undefined {
	const { commands, pi, runController, runtime } = lifecycle;
	const loaded = loadGoalStateFromSession(ctx);
	lifecycle.goalProjectionNeeded = loaded.source !== "none";
	runtime.activeGoal = loaded.goal;
	runtime.queuedGoals = loaded.queue;
	runtime.pendingQueueAction = loaded.pendingAction;
	runtime.queueFrozen = loaded.hasExperimentalQueueState && !runtime.settings.experimental.goals;
	runController.bindSession(ctx);
	if (runtime.queueFrozen) {
		if (runtime.activeGoal) runtime.persistGoal(runtime.activeGoal);
		runtime.publishPresentationStatus(runtime.activeGoal);
		ctx.ui.notify(
			"An experimental goal queue is frozen because experimental.goals is disabled. Re-enable it and run /reload to continue, or use /goal clear.",
			"warning",
		);
		return;
	}

	let startRestoredQueuedGoal = false;
	if (runtime.activeGoal?.status === "queued" && !runtime.pendingQueueAction) {
		runtime.activeGoal = activateQueuedGoal(runtime.activeGoal, currentTokenTotal(ctx));
		startRestoredQueuedGoal = runtime.activeGoal.status === "active";
	}
	if (runtime.pendingQueueAction) {
		if (runtime.activeGoal) runtime.persistGoal(runtime.activeGoal);
		else runtime.clearPresentationStatus();
		return Effect.gen(function* () {
			if (yield* suiteReady(pi, ctx)) yield* commands.dispatchPendingQueueActionIfSettled(ctx);
		});
	}
	if (runtime.activeGoal) return restoreActiveGoalSession(lifecycle, ctx, startRestoredQueuedGoal, reloaded);
	if (runtime.settings.toolVisibility === "after-first-goal" && !runtime.goalToolsUnlocked) {
		runtime.hideGoalToolsIfLocked();
	}
	runtime.clearPresentationStatus();
}

export function startGoalSession(
	lifecycle: GoalSessionLifecycle,
	event: SessionStartEvent,
	ctx: ExtensionContext,
): Effect.Effect<GoalStartupDispatch | undefined, Error> {
	return Effect.gen(function* () {
		const { runtime } = lifecycle;
		lifecycle.goalProjectionNeeded = false;
		lifecycle.turnActive = false;
		runtime.beginReadOnlySessionStart();
		const previousToolVisibility = runtime.settings.toolVisibility;
		resetGoalSession(lifecycle);
		yield* loadGoalSessionSettings(lifecycle, ctx, previousToolVisibility);
		return restoreGoalSession(lifecycle, ctx, event.reason === "reload");
	}).pipe(Effect.ensuring(Effect.sync(() => lifecycle.runtime.endReadOnlySessionStart())));
}

export function shutdownGoalSession(lifecycle: GoalSessionLifecycle, ctx: ExtensionContext): void {
	const { runController, runtime } = lifecycle;
	lifecycle.goalProjectionNeeded = false;
	lifecycle.turnActive = false;
	runController.unbindSession();
	runtime.invalidateMenuSession();
	if (runtime.activeGoal) {
		if (!runtime.queueFrozen && runtime.activeGoal.status === "active") {
			runtime.recordGoalUsage(runtime.activeGoal, ctx, false);
		}
		runtime.persistGoal(runtime.activeGoal);
	}
	clearGoalSessionWork(runtime);
	runtime.activeGoal = undefined;
	runtime.clearPresentationStatus();
	runtime.clearTerminalDetails();
	lifecycle.settingsStore = undefined;
}

function suiteReady(pi: ExtensionAPI, ctx: ExtensionContext): Effect.Effect<boolean, unknown> {
	return whenSuiteSessionReady(pi, ctx);
}
