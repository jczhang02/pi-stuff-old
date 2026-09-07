import type {
	AgentEndEvent,
	ContextEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { hasDirectUserActivation } from "../../conversation-ui/agent-run-origin.js";
import { listenForGoalCoordinationQueries } from "../../conversation-ui/goal-coordination.js";
import {
	type EffectFoundation,
	type EffectScopeOwner,
	installEffectFoundation,
} from "../../shared/effect-foundation.js";
import { isRuntimeString } from "../../shared/runtime-type.js";
import { currentTokenTotal } from "./accounting.js";
import { registerGoalCommand } from "./command-registration.js";
import { GoalCommandController } from "./commands.js";
import { GoalCompactionCoordinator } from "./compaction.js";
import type { ActiveGoal } from "./persistence.js";
import { buildGoalSystemPrompt } from "./prompts.js";
import { GoalRunController } from "./run-protocol.js";
import {
	type AssistantMessageLike,
	abortCurrentTurn,
	blocksStaleGoalToolCalls,
	findFinalAssistantMessage,
	formatError,
	GOAL_CONTEXT_MESSAGE_TYPE,
	GOAL_PROMPT_MESSAGE_TYPE,
	type GoalRunOrigin,
	GoalRuntime,
	incrementGoal,
	isExternallyBlockedGoalInterruption,
	isGoalContextOverflow,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
	resetGoalSafetyEpoch,
	type StatusContext,
	transitionGoal,
	truncateNotification,
} from "./runtime.js";
import { hasAssistantToolCall } from "./safety.js";
import { type GoalSessionLifecycle, shutdownGoalSession, startGoalSession } from "./session.js";
import type { GoalSettingsStore } from "./settings.js";
import { registerGoalTerminalTools } from "./terminal-tools.js";

// goal.ts remains the Pi-facing composition root because lifecycle-event registration is
// order-sensitive. Terminal Tool execution, per-session mechanisms, and command transitions
// live behind their owning seams; each factory stays isolated.

interface GoalOptions {
	settingsPath?: string;
}

interface GoalLifecycle extends GoalSessionLifecycle {
	readonly commands: GoalCommandController;
	readonly compaction: GoalCompactionCoordinator;
	readonly effects: EffectFoundation;
	goalProjectionNeeded: boolean;
	readonly options: GoalOptions;
	readonly pi: ExtensionAPI;
	readonly runController: GoalRunController;
	readonly runtime: GoalRuntime;
	coordinationCleanup: () => void;
	settingsStore: GoalSettingsStore | undefined;
	readonly tasks: Partial<Record<GoalTask, EffectScopeOwner>>;
	turnActive: boolean;
}

const GOAL_TASKS = ["compaction-recovery", "completion-status", "startup"] as const;
type GoalTask = (typeof GOAL_TASKS)[number];
const MESSAGE_ENVELOPE_SCHEMA = Type.Object(
	{
		content: Type.Optional(Type.Unknown()),
		customType: Type.Optional(Type.String()),
		role: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
type MessageEnvelope = Static<typeof MESSAGE_ENVELOPE_SCHEMA>;
type GoalMessage = ContextEvent["messages"][number];
const TEXT_MESSAGE_PART_SCHEMA = Type.Object(
	{ text: Type.Optional(Type.String()), type: Type.Literal("text") },
	{ additionalProperties: true },
);

function goalSessionScope(lifecycle: GoalLifecycle, ctx: Pick<ExtensionContext, "sessionManager">) {
	return lifecycle.effects.sessionFor(ctx.sessionManager) ?? lifecycle.effects.currentSession();
}

async function runGoalOperation<A, E>(
	lifecycle: GoalLifecycle,
	ctx: Pick<ExtensionContext, "sessionManager">,
	program: Effect.Effect<A, E>,
	signal?: AbortSignal,
): Promise<Exit.Exit<A, E>> {
	const session = goalSessionScope(lifecycle, ctx);
	if (!session || !lifecycle.effects.isCurrent(session)) {
		throw new Error("Goal is unavailable before Session start.");
	}
	const operation = lifecycle.effects.forkOperation(session);
	const exit = await lifecycle.effects.run(operation, program, signal ? { signal } : undefined);
	await lifecycle.effects.close(operation, exit);
	return exit;
}

async function runGoalEffect<A, E>(
	lifecycle: GoalLifecycle,
	ctx: Pick<ExtensionContext, "sessionManager">,
	program: Effect.Effect<A, E>,
): Promise<A> {
	const exit = await runGoalOperation(lifecycle, ctx, program);
	if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
	return exit.value;
}

async function runGoalCommandEffect(
	lifecycle: GoalLifecycle,
	ctx: ExtensionCommandContext,
	program: Effect.Effect<void, unknown>,
	cancellable: boolean,
): Promise<void> {
	const exit = await runGoalOperation(lifecycle, ctx, program, cancellable ? ctx.signal : undefined);
	if (cancellable && (ctx.signal?.aborted || (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)))) return;
	if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
}

function cancelGoalTask(lifecycle: GoalLifecycle, task: GoalTask): void {
	const owner = lifecycle.tasks[task];
	if (!owner) return;
	delete lifecycle.tasks[task];
	void lifecycle.effects.close(owner, Exit.interrupt()).catch(() => undefined);
}

function cancelGoalTasks(lifecycle: GoalLifecycle): void {
	for (const task of GOAL_TASKS) cancelGoalTask(lifecycle, task);
}

function startGoalTask(
	lifecycle: GoalLifecycle,
	task: GoalTask,
	ctx: ExtensionContext,
	program: Effect.Effect<void, unknown>,
	onFailure?: (message: string) => void,
): void {
	cancelGoalTask(lifecycle, task);
	const session = goalSessionScope(lifecycle, ctx);
	if (!session || !lifecycle.effects.isCurrent(session)) return;
	const operation = lifecycle.effects.forkOperation(session);
	lifecycle.tasks[task] = operation;
	void lifecycle.effects
		.run(operation, program)
		.then(async (exit) => {
			const current = lifecycle.tasks[task] === operation;
			if (current) delete lifecycle.tasks[task];
			await lifecycle.effects.close(operation, exit);
			if (current && Exit.isFailure(exit) && !Cause.hasInterrupts(exit.cause)) {
				onFailure?.(formatError(Cause.squash(exit.cause)));
			}
		})
		.catch((error) => onFailure?.(formatError(error)));
}

function scheduleGoalEffect(
	lifecycle: GoalLifecycle,
	ctx: ExtensionContext,
	program: Effect.Effect<void, unknown>,
): void {
	void runGoalEffect(lifecycle, ctx, program).catch(() => undefined);
}

function registerGoalSessionHandlers(lifecycle: GoalLifecycle): void {
	const { compaction, pi } = lifecycle;
	pi.on("session_start", async (event, ctx) => {
		lifecycle.coordinationCleanup();
		lifecycle.coordinationCleanup = listenForGoalCoordinationQueries(pi, () => lifecycle.runtime.coordinationState());
		cancelGoalTasks(lifecycle);
		compaction.clear();
		const startup = await runGoalEffect(lifecycle, ctx, startGoalSession(lifecycle, event, ctx));
		if (startup) {
			startGoalTask(lifecycle, "startup", ctx, startup, (message) => {
				ctx.ui.notify(`Goal startup continuation failed: ${message}`, "error");
			});
		}
	});
	pi.on("session_shutdown", (_event, ctx) => {
		lifecycle.coordinationCleanup();
		lifecycle.coordinationCleanup = () => undefined;
		cancelGoalTasks(lifecycle);
		compaction.clear();
		shutdownGoalSession(lifecycle, ctx);
	});
	pi.on("session_before_compact", (event, ctx) => {
		cancelGoalTask(lifecycle, "compaction-recovery");
		return compaction.before(event, ctx);
	});
	pi.on("session_compact_failed", (event, ctx) => {
		const recovery = compaction.failed(event, ctx);
		if (recovery) startGoalTask(lifecycle, "compaction-recovery", ctx, recovery);
	});
	pi.on("session_compact", async (event, ctx) => {
		cancelGoalTask(lifecycle, "compaction-recovery");
		await runGoalEffect(lifecycle, ctx, compaction.complete(event, ctx));
		if (event.reason !== "manual") return;
		const recovery = compaction.afterManualComplete(ctx);
		if (recovery) startGoalTask(lifecycle, "compaction-recovery", ctx, recovery);
	});
}

function prepareNonGoalDelivery(lifecycle: GoalLifecycle, resetSafetyEpoch: boolean, origin?: GoalRunOrigin): void {
	const { runtime } = lifecycle;
	runtime.goalRecovery = undefined;
	runtime.guardAbortGoalId = undefined;
	runtime.clearStaleGoalToolCallBlock();
	if (resetSafetyEpoch) runtime.clearBudgetWrapUp();
	const activeGoalId = runtime.activeGoal?.status === "active" ? runtime.activeGoal.id : undefined;
	if (origin) runtime.beginAgentRun(activeGoalId ?? null, activeGoalId ? origin : undefined);
	if (resetSafetyEpoch) runtime.resetActiveSafetyEpoch();
}

function beginPromptRun(lifecycle: GoalLifecycle, prompt: string, ctx: StatusContext): ActiveGoal | undefined {
	const { runtime } = lifecycle;
	runtime.clearAgentRun();
	if (runtime.prompts.consumeCancelledContinuationPrompt(prompt) || runtime.consumeStaleOwnedGoalPrompt(prompt)) {
		runtime.beginAgentRun(null, undefined);
		abortCurrentTurn(ctx);
		return;
	}
	if (runtime.queueFrozen) return;
	// A normal prompt boundary supersedes stale retry and hard-cap cleanup ownership.
	runtime.goalRecovery = undefined;
	if (runtime.guardAbortGoalId) runtime.guardAbortGoalId = undefined;
	const goalPrompt = runtime.prompts.consumeOwnedGoalPrompt(prompt);
	const goalPromptGoalId = goalPrompt?.goalId;
	const continuationGoalId = goalPromptGoalId ? undefined : runtime.prompts.markContinuationStarted(prompt);
	const ownedPromptGoalId = goalPromptGoalId ?? continuationGoalId;
	const activeBudgetWrapUp = runtime.hasActiveBudgetWrapUp();
	const runOrigin = continuationGoalId ? "automatic" : (goalPrompt?.origin ?? "automatic");
	if (runtime.pendingQueueAction?.kind === "prioritize" && !activeBudgetWrapUp) {
		if (!runtime.pendingQueueAction.displacedUsageFinalized) {
			if (runtime.activeGoal?.status === "active") runtime.recordGoalUsage(runtime.activeGoal, ctx, false);
			runtime.pendingQueueAction.displacedUsageFinalized = true;
			if (runtime.activeGoal) {
				runtime.persistGoal(runtime.activeGoal);
			}
		}
		runtime.beginAgentRun(null, undefined);
		if (ownedPromptGoalId) abortCurrentTurn(ctx);
		return;
	}
	if (activeBudgetWrapUp && runtime.activeGoal) {
		runtime.beginAgentRun(runtime.activeGoal.id, "manual");
		return;
	}
	if (runtime.pendingQueueAction?.kind === "advance" && runtime.pendingQueueAction.goalId === runtime.activeGoal?.id) {
		runtime.beginAgentRun(ownedPromptGoalId ?? runtime.activeGoal.id, runOrigin);
		if (ownedPromptGoalId) abortCurrentTurn(ctx);
		return;
	}
	if (ownedPromptGoalId && ownedPromptGoalId !== runtime.activeGoal?.id) {
		runtime.beginAgentRun(ownedPromptGoalId, runOrigin);
		if (runtime.activeGoal?.status === "active" && !runtime.goalToolsAvailable()) {
			runtime.pauseGoalForUnavailableTools(ctx, false);
		}
		abortCurrentTurn(ctx);
		return;
	}
	if (runtime.activeGoal?.status !== "active") return;
	runtime.beginAgentRun(runtime.activeGoal.id, runOrigin);
	if (!runtime.goalToolsAvailable()) {
		runtime.pauseGoalForUnavailableTools(ctx, ownedPromptGoalId !== undefined);
		return;
	}
	if (goalPrompt?.resetSafetyEpoch && goalPromptGoalId === runtime.activeGoal.id) {
		runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
		runtime.persistGoal(runtime.activeGoal);
	}
	return runtime.activeGoal;
}

function registerGoalInputHandlers(lifecycle: GoalLifecycle): void {
	const { pi, runtime } = lifecycle;
	pi.on("input", (event) => {
		if (event.source === "extension") {
			if (
				runtime.prompts.consumeCancelledContinuationPrompt(event.text) ||
				runtime.consumeStaleOwnedGoalPrompt(event.text)
			) {
				return { action: "handled" as const };
			}
			if (runtime.queueFrozen) return;
			if (runtime.prompts.hasPendingOwnedGoalPrompt(event.text)) return;
			runtime.prompts.noteQueuedNonGoalInput(event.text, event.streamingBehavior ?? "idle", "automatic", false);
			return;
		}
		if (runtime.queueFrozen || /^\/goal(?:\s|$)/u.test(event.text.trimStart())) return;
		runtime.prompts.noteQueuedNonGoalInput(event.text, event.streamingBehavior ?? "idle", "manual", true);
	});
	pi.on("turn_start", () => {
		lifecycle.turnActive = true;
	});
}

function handleGoalMessageStart(lifecycle: GoalLifecycle, messageValue: GoalMessage, ctx: ExtensionContext): void {
	const { runtime } = lifecycle;
	const message: MessageEnvelope = Check(MESSAGE_ENVELOPE_SCHEMA, messageValue) ? messageValue : {};
	if (
		message.role === "assistant" &&
		runtime.activeGoal?.status === "paused" &&
		runtime.guardAbortGoalId === runtime.activeGoal.id
	) {
		abortCurrentTurn(ctx);
		return;
	}
	if (message.role === "custom") {
		if (lifecycle.turnActive) runtime.prompts.discardQueuedNonGoalInputs(["idle"]);
		if (message.customType === GOAL_PROMPT_MESSAGE_TYPE && isRuntimeString(message.content)) {
			beginPromptRun(lifecycle, message.content, ctx);
			return;
		}
		if (message.customType === GOAL_CONTEXT_MESSAGE_TYPE || runtime.isActiveBudgetWrapUpMessage(message)) return;
		if (!lifecycle.turnActive) return;
		const origin = hasDirectUserActivation(message) ? "manual" : "automatic";
		prepareNonGoalDelivery(lifecycle, origin === "manual", origin);
		return;
	}
	if (message.role !== "user") return;
	const prompt = Array.isArray(message.content)
		? message.content
				.filter((part) => Check(TEXT_MESSAGE_PART_SCHEMA, part))
				.flatMap((part) => (part.text === undefined ? [] : [part.text]))
				.join("\n")
		: Check(Type.String(), message.content)
			? message.content
			: "";
	const ownedPrompt = runtime.prompts.consumeOwnedGoalPrompt(prompt);
	const ownedPromptBoundary = runtime.prompts.hasOwnedPromptBoundary(prompt);
	const queued = runtime.prompts.consumeQueuedNonGoalInput(prompt, !ownedPromptBoundary, [
		"steer",
		"followUp",
		"idle",
	]);
	if (!ownedPrompt) {
		if (queued?.behavior === "followUp") {
			prepareNonGoalDelivery(lifecycle, queued.resetSafetyEpoch, queued.origin);
		} else if (queued) prepareNonGoalDelivery(lifecycle, queued.resetSafetyEpoch);
		return;
	}
	if (runtime.activeGoal?.id !== ownedPrompt.goalId || runtime.activeGoal.status !== "active") return;
	if (runtime.agentRunGoalId !== undefined && runtime.agentRunGoalId !== ownedPrompt.goalId) {
		runtime.activeGoal.baselineTokens = Math.max(0, currentTokenTotal(ctx) - runtime.activeGoal.tokensUsed);
	}
	runtime.beginAgentRun(ownedPrompt.goalId, ownedPrompt.origin);
	if (ownedPrompt.resetSafetyEpoch) runtime.activeGoal = resetGoalSafetyEpoch(runtime.activeGoal);
	runtime.persistGoal(runtime.activeGoal);
}

function projectGoalContext(lifecycle: GoalLifecycle, event: ContextEvent, ctx: ExtensionContext) {
	const { runtime } = lifecycle;
	if (!lifecycle.goalProjectionNeeded) return;
	const latestGoalContextIndex = findLatestGoalContextIndex(event.messages);
	const messages = event.messages.filter(
		(message, index) =>
			runtime.keepBudgetWrapUpMessage(message) &&
			(!isGoalContextMessage(message) || index === latestGoalContextIndex),
	);
	if (runtime.activeGoal?.status === "paused" && runtime.guardAbortGoalId === runtime.activeGoal.id) {
		abortCurrentTurn(ctx);
	}
	if (messages.length !== event.messages.length) return { messages };
}

function registerGoalMessageHandlers(lifecycle: GoalLifecycle): void {
	const { pi } = lifecycle;
	pi.on("message_start", (event, ctx) => handleGoalMessageStart(lifecycle, event.message, ctx));
	pi.on("context", (event, ctx) => projectGoalContext(lifecycle, event, ctx));
}

function registerGoalToolHandlers(lifecycle: GoalLifecycle): void {
	const { pi, runtime } = lifecycle;
	pi.on("tool_call", (event, ctx) => {
		runtime.markAgentToolAttempted();
		if (runtime.queueFrozen) {
			if (!runtime.isGoalToolName(event.toolName)) return;
			abortCurrentTurn(ctx);
			return {
				block: true,
				reason:
					"The experimental goal queue is frozen. Re-enable experimental.goals and run /reload, or use /goal clear.",
			};
		}
		if (
			runtime.activeGoal?.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
			event.toolName !== "goal_complete"
		) {
			abortCurrentTurn(ctx);
			return {
				block: true,
				reason: "Goal token budget is exhausted; only goal_complete is allowed during wrap-up.",
			};
		}
		if (!runtime.staleGoalToolCallsBlocked) return;
		if (!runtime.activeGoal || !blocksStaleGoalToolCalls(runtime.activeGoal.status)) {
			runtime.clearStaleGoalToolCallBlock();
			return;
		}
		abortCurrentTurn(ctx);
		return {
			block: true,
			reason: "Blocked stale /goal tool call after the goal stopped or was interrupted.",
		};
	});

	pi.on("tool_execution_end", (_event, ctx) => {
		if (runtime.queueFrozen) return;
		if (
			runtime.activeGoal?.status === "budget_limited" &&
			runtime.budgetWrapUp?.goalId === runtime.activeGoal.id &&
			!runtime.budgetWrapUp.delivered
		) {
			scheduleGoalEffect(lifecycle, ctx, runtime.queueBudgetWrapUp(ctx, runtime.activeGoal));
			return;
		}
		if (runtime.activeGoal?.status !== "active") return;
		if (!runtime.recordGoalUsage(runtime.activeGoal, ctx)) return;
		runtime.persistGoal(runtime.activeGoal);
		if (runtime.limitActiveGoalForBudget(ctx)) {
			scheduleGoalEffect(lifecycle, ctx, runtime.queueBudgetWrapUp(ctx, runtime.activeGoal));
			return;
		}
		if (!runtime.goalToolsAvailable()) runtime.pauseGoalForUnavailableTools(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		runtime.flushDeferredSessionStartState();
		const activeGoal = beginPromptRun(lifecycle, event.prompt, ctx);
		if (!activeGoal) return;
		lifecycle.goalProjectionNeeded = true;
		return {
			message: {
				customType: GOAL_CONTEXT_MESSAGE_TYPE,
				content: buildGoalSystemPrompt(activeGoal),
				display: false,
			},
		};
	});
}

function stopGoalAfterAgentEnd(
	lifecycle: GoalLifecycle,
	ctx: StatusContext,
	goal: ActiveGoal,
	assistant: AssistantMessageLike,
	status: "paused" | "usage_limited",
): void {
	const { runtime } = lifecycle;
	runtime.prompts.cancelContinuationWork();
	runtime.clearBudgetWrapUp();
	runtime.blockStaleGoalToolCalls();
	abortCurrentTurn(ctx);
	runtime.activeGoal = transitionGoal(goal, status);
	runtime.setTerminalReason(
		runtime.activeGoal.id,
		assistant.errorMessage ?? `goal ${status} after agent interruption`,
	);
	runtime.persistGoal(runtime.activeGoal);

	const details = assistant.errorMessage ? ` (${truncateNotification(assistant.errorMessage)})` : "";
	if (status === "paused") {
		ctx.ui.notify(`Goal paused after interruption${details}. Run /goal resume to continue.`, "warning");
		return;
	}
	ctx.ui.notify(
		`Goal stopped after provider usage limit${details}. Run /goal resume when usage is available.`,
		"warning",
	);
}

function handleGoalAgentEnd(lifecycle: GoalLifecycle, event: AgentEndEvent, ctx: ExtensionContext): void {
	const { runtime } = lifecycle;
	const run = runtime.finishAgentRun();
	if (runtime.queueFrozen || run.goalId === null) return;
	if (!runtime.canRecordGoalUsage() && !runtime.hasActiveBudgetWrapUp()) return;
	if (run.goalId && run.goalId !== runtime.activeGoal?.id) return;
	if (!runtime.activeGoal) return;
	if (runtime.activeGoal.status === "budget_limited" && runtime.budgetWrapUp?.goalId === runtime.activeGoal.id) {
		runtime.recordGoalUsage(runtime.activeGoal, ctx);
		runtime.persistGoal(runtime.activeGoal);
		runtime.clearBudgetWrapUp();
		return;
	}
	if (runtime.activeGoal.status !== "active") return;
	if (runtime.pendingQueueAction?.kind === "advance" && runtime.pendingQueueAction.goalId === runtime.activeGoal.id) {
		runtime.recordGoalUsage(runtime.activeGoal, ctx);
		runtime.persistGoal(runtime.activeGoal);
		return;
	}

	const goalId = runtime.activeGoal.id;
	const alreadyAwaitingContinuation = runtime.prompts.hasContinuationWorkForGoal(goalId);
	const finalAssistant = findFinalAssistantMessage(event.messages);
	if (!alreadyAwaitingContinuation) runtime.activeGoal = incrementGoal(runtime.activeGoal);
	runtime.recordGoalUsage(runtime.activeGoal, ctx);

	if (finalAssistant?.stopReason === "aborted") {
		runtime.clearGoalRecoveryForGoal(goalId);
		stopGoalAfterAgentEnd(lifecycle, ctx, runtime.activeGoal, finalAssistant, "paused");
		return;
	}
	if (finalAssistant?.stopReason === "error") {
		if (isRetryableGoalInterruption(finalAssistant)) {
			if (run.origin === "automatic" && runtime.enforceAutomaticTurnLimit(ctx, true)) return;
			if (runtime.limitActiveGoalForBudget(ctx)) return;
			if (!runtime.goalToolsAvailable()) {
				runtime.pauseGoalForUnavailableTools(ctx);
				return;
			}
			runtime.goalRecovery = {
				goalId,
				kind: isGoalContextOverflow(finalAssistant) ? "compaction_retry" : "provider_retry",
				automaticOwner: run.origin === "automatic",
				errorMessage: finalAssistant.errorMessage,
			};
			runtime.prompts.cancelContinuationWork();
			runtime.persistGoal(runtime.activeGoal);
			return;
		}
		runtime.clearGoalRecoveryForGoal(goalId);
		if (isUsageLimitedGoalInterruption(finalAssistant) || isExternallyBlockedGoalInterruption(finalAssistant)) {
			const status = isUsageLimitedGoalInterruption(finalAssistant) ? "usage_limited" : "paused";
			stopGoalAfterAgentEnd(lifecycle, ctx, runtime.activeGoal, finalAssistant, status);
			return;
		}
		runtime.goalRecovery = {
			goalId,
			kind: "provider_retry",
			automaticOwner: run.origin === "automatic",
			errorMessage: finalAssistant.errorMessage,
		};
		runtime.prompts.cancelContinuationWork();
		runtime.persistGoal(runtime.activeGoal);
		return;
	}

	runtime.clearGoalRecoveryForGoal(goalId);
	if (runtime.limitActiveGoalForBudget(ctx)) return;
	if (!runtime.goalToolsAvailable()) {
		runtime.pauseGoalForUnavailableTools(ctx);
		return;
	}
	if (
		run.origin === "automatic" &&
		runtime.recordAutomaticRunProgress(
			ctx,
			goalId,
			event.messages,
			run.toolAttempted || hasAssistantToolCall(event.messages),
		)
	)
		return;
	runtime.persistGoal(runtime.activeGoal);
	const currentGoal = runtime.activeGoal;
	if (!currentGoal || currentGoal.id !== goalId || currentGoal.status !== "active") return;
	if (runtime.pendingQueueAction?.kind === "prioritize") return;
	runtime.prompts.requestContinuation(currentGoal);
}

function registerGoalAgentHandlers(lifecycle: GoalLifecycle): void {
	const { commands, pi, runtime } = lifecycle;
	pi.on("agent_start", () => {
		if (runtime.queueFrozen) return;
		const activeGoal = runtime.activeGoal;
		if (activeGoal && runtime.guardAbortGoalId === activeGoal.id && activeGoal.status === "paused") return;
		runtime.beginRecoveryRunIfNeeded();
	});
	pi.on("turn_end", (event, ctx) => {
		lifecycle.turnActive = false;
		if (!runtime.queueFrozen) runtime.recordAutomaticTurn(ctx, event.message);
	});
	pi.on("agent_end", (event, ctx) => handleGoalAgentEnd(lifecycle, event, ctx));
	pi.on("agent_settled", (_event, ctx) => {
		lifecycle.turnActive = false;
		// A custom-message turn may settle after the Host has already shut down its Session.
		if (!lifecycle.effects.currentSession()) return;
		return runGoalEffect(
			lifecycle,
			ctx,
			Effect.gen(function* () {
				if (runtime.queueFrozen) {
					runtime.clearSettledSafetyTracking();
					runtime.queueFreezeAwaitingSettle = false;
					if (runtime.settings.experimental.goals) yield* commands.resumeQueueAfterUnfreeze(ctx);
					return;
				}
				runtime.finalizeSettledRecovery(ctx);
				const dispatched = runtime.pendingQueueAction
					? yield* commands.dispatchPendingQueueActionIfSettled(ctx)
					: false;
				if (!dispatched) yield* runtime.dispatchContinuationIfSettled(ctx);
				runtime.clearSettledSafetyTracking();
			}),
		);
	});
}

// Cohesion justification: command, tool, continuation, and lifecycle handlers coordinate one
// guarded Goal state machine whose ordering and stale-turn invariants share the same closures.
function registerGoalRuntime(pi: ExtensionAPI, options: GoalOptions = {}) {
	const effects = installEffectFoundation(pi);
	const runtime = new GoalRuntime(pi);
	const commands = new GoalCommandController(runtime);
	const compaction = new GoalCompactionCoordinator(runtime, commands);
	const runController = new GoalRunController(runtime, commands);
	const lifecycle: GoalLifecycle = {
		commands,
		compaction,
		effects,
		goalProjectionNeeded: false,
		options,
		pi,
		runController,
		runtime,
		coordinationCleanup: listenForGoalCoordinationQueries(pi, () => runtime.coordinationState()),
		settingsStore: undefined,
		tasks: {},
		turnActive: false,
	};
	runtime.setCompletionStatusCancellation(() => cancelGoalTask(lifecycle, "completion-status"));
	runController.register(pi, (ctx, program) => scheduleGoalEffect(lifecycle, ctx, program));

	registerGoalTerminalTools(pi, runtime, {
		run: (ctx, program) => runGoalEffect(lifecycle, ctx, program),
		showCompletionStatus: (ctx, timeUsedSeconds) => {
			runtime.showCompletionStatus(timeUsedSeconds);
			startGoalTask(
				lifecycle,
				"completion-status",
				ctx,
				Effect.sleep(8_000).pipe(Effect.andThen(Effect.sync(() => runtime.clearPresentationStatus()))),
			);
		},
	});
	// Do not touch the active tool set during factory registration: ExtensionAPI
	// actions are unbound until the session binds the runtime. session_start applies
	// baseline visibility once actions work; later hooks only enforce goal safety.

	registerGoalCommand(pi, runtime, commands, {
		onProjectionNeeded: () => {
			lifecycle.goalProjectionNeeded = true;
		},
		run: (ctx, program, cancellable) => runGoalCommandEffect(lifecycle, ctx, program, cancellable),
		settingsPath: options.settingsPath,
		settingsStore: () => lifecycle.settingsStore,
	});
	registerGoalSessionHandlers(lifecycle);
	registerGoalInputHandlers(lifecycle);
	registerGoalMessageHandlers(lifecycle);
	registerGoalToolHandlers(lifecycle);
	registerGoalAgentHandlers(lifecycle);
	return runtime;
}

export default function goal(pi: ExtensionAPI, options: GoalOptions = {}) {
	return registerGoalRuntime(pi, options);
}

export {
	assistantUsageTokens,
	cumulativeAssistantTokens,
	formatDuration,
	formatTokenCount,
} from "./accounting.js";

export {
	completeGoalArguments,
	parseCommand,
	parseTokenBudget,
	validateObjective,
} from "./command.js";

export { buildGoalSystemPrompt } from "./prompts.js";

export {
	EMERGENCY_AUTOMATIC_TURN_LIMIT,
	findFinalAssistantMessage,
	formatStatus,
	GOAL_CONTEXT_MESSAGE_TYPE,
	GOAL_PROMPT_MESSAGE_TYPE,
	isContradictoryCompletionSummary,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
} from "./runtime.js";

function isGoalContextMessage(message: GoalMessage) {
	return (
		message.role === "custom" &&
		(message.customType === GOAL_PROMPT_MESSAGE_TYPE || message.customType === GOAL_CONTEXT_MESSAGE_TYPE)
	);
}

function findLatestGoalContextIndex(messages: readonly GoalMessage[]) {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message && isGoalContextMessage(message)) return index;
	}
	return -1;
}
