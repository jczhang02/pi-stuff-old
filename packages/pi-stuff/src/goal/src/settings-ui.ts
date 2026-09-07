import { join } from "node:path";
import { type ExtensionCommandContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { checkpointGoalActiveTime } from "./accounting.ts";
import { abortCurrentTurn, EMERGENCY_AUTOMATIC_TURN_LIMIT, type GoalRuntime } from "./runtime.ts";
import { GOAL_SETTINGS_FILE, type GoalSettings, type GoalSettingsStore } from "./settings.ts";
import { defineMenu, type MenuDefinition, menuWait, runMenu } from "./suite-menu.ts";

interface GoalSettingsUiOptions {
	settingsPath?: string | undefined;
	save?: (settings: GoalSettings, settingsPath: string) => Effect.Effect<void, unknown>;
	onQueueUnfrozen?: (ctx: ExtensionCommandContext) => Effect.Effect<boolean, unknown>;
	store?: GoalSettingsStore | undefined;
}

interface GoalSettingsApplyOptions {
	save?: (settings: GoalSettings) => Effect.Effect<void, unknown>;
}

type LimitField = "automaticTurns" | "noProgressTurns";
type LimitSelection = "unlimited" | "custom" | "off";
type GoalSettingsScreen = "settings" | "automatic" | "no-progress" | "invalid";
type GoalSettingsAction =
	| "open-automatic"
	| "open-no-progress"
	| "choose-automatic"
	| "choose-no-progress"
	| "set-visibility"
	| "set-queue"
	| "set-rpc";
type GoalSettingsMenuDefinition = MenuDefinition<undefined, GoalSettingsScreen, GoalSettingsAction>;

function goalSettingsScreens(runtime: GoalRuntime, settingsPath: string): GoalSettingsMenuDefinition["screens"] {
	return {
		settings: () => ({
			kind: "settings",
			title: "Pi Goal Settings",
			lines: [`User settings · ${safeTerminalText(settingsPath)}`],
			items: [
				{
					id: "automaticTurns",
					label: "Automatic work",
					description: "Choose whether Goal can continue without a response-count cap.",
					currentValue: formatAutomaticSettingValue(runtime.settings.continuationLimits.automaticTurns),
					action: "open-automatic",
				},
				{
					id: "noProgressTurns",
					label: "No-progress guard",
					description: "Pause after repeated or empty tool-free automatic runs.",
					currentValue: formatNoProgressSettingValue(runtime.settings.continuationLimits.noProgressTurns),
					action: "open-no-progress",
				},
				{
					id: "toolVisibility",
					label: "Goal tools",
					description: "Keep terminal Goal tools visible, or reveal them after the first goal.",
					currentValue: visibilityLabel(runtime.settings.toolVisibility),
					values: ["Always", "After first goal"],
					action: "set-visibility",
				},
				{
					id: "experimentalGoals",
					label: "Ordered goal queue",
					description: "Enable experimental add, prioritize, skip, and drop-last workflows.",
					currentValue: runtime.settings.experimental.goals ? "Experimental" : "Off",
					values: ["Off", "Experimental"],
					action: "set-queue",
				},
				{
					id: "rpcEnabled",
					label: "Managed run RPC",
					description:
						"Allow trusted installed extensions to start and cancel Goal runs; this is not an extension sandbox.",
					currentValue: runtime.settings.rpc.enabled ? "On" : "Off",
					values: ["Off", "On"],
					action: "set-rpc",
				},
			],
		}),
		automatic: () => limitChoiceScreen(runtime, "automaticTurns", "choose-automatic"),
		"no-progress": () => limitChoiceScreen(runtime, "noProgressTurns", "choose-no-progress"),
		invalid: () => ({
			kind: "detail",
			title: "Pi Goal Settings · Read only",
			lines: [
				`Invalid settings file. Pi-goal is using built-in defaults. Fix ${safeTerminalText(settingsPath)} and run /reload. The file will not be overwritten.`,
				`Automatic work: ${formatAutomaticWork(runtime.settings.continuationLimits.automaticTurns)}`,
				`No-progress guard: ${formatNoProgressProtection(runtime.settings.continuationLimits.noProgressTurns)}`,
				`Goal tools: ${visibilityLabel(runtime.settings.toolVisibility)}`,
				`Ordered goal queue: ${runtime.settings.experimental.goals ? "Experimental" : "Off"}`,
				`Managed run RPC: ${runtime.settings.rpc.enabled ? "On" : "Off"}`,
			],
			hint: "back",
		}),
	};
}

function goalSettingsActions(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	options: GoalSettingsUiOptions,
	settingsPath: string,
	previewGoalIds: Map<LimitField, string | null>,
): GoalSettingsMenuDefinition["actions"] {
	return {
		"open-automatic": () => {
			previewGoalIds.set("automaticTurns", runtime.activeGoal?.id ?? null);
			return { kind: "to", screen: "automatic" };
		},
		"open-no-progress": () => {
			previewGoalIds.set("noProgressTurns", runtime.activeGoal?.id ?? null);
			return { kind: "to", screen: "no-progress" };
		},
		"choose-automatic": ({ itemId, signal }) =>
			applyLimitChoice(
				runtime,
				ctx,
				options,
				settingsPath,
				"automaticTurns",
				itemId,
				previewGoalIds.get("automaticTurns") ?? null,
				signal,
			),
		"choose-no-progress": ({ itemId, signal }) =>
			applyLimitChoice(
				runtime,
				ctx,
				options,
				settingsPath,
				"noProgressTurns",
				itemId,
				previewGoalIds.get("noProgressTurns") ?? null,
				signal,
			),
		"set-visibility": ({ value }) => {
			const nextVisibility = value === "Always" ? "always" : "after-first-goal";
			if (nextVisibility === runtime.settings.toolVisibility) return { kind: "stay" };
			return Effect.gen(function* () {
				const next = {
					...structuredClone(runtime.settings),
					toolVisibility: nextVisibility,
				} satisfies GoalSettings;
				yield* applySavedGoalSettings(runtime, next, ctx, options, settingsPath);
				ctx.ui.notify(`Goal tools: ${value}.`, "info");
				return { kind: "stay" as const };
			}).pipe(Effect.catch((error) => rejectedSettings(ctx, settingsPath, error)));
		},
		"set-queue": ({ signal, value }) => {
			const enabled = value === "Experimental";
			if (enabled === runtime.settings.experimental.goals) return { kind: "stay" };
			return Effect.gen(function* () {
				const next = yield* nextQueueSettings(runtime, ctx, enabled, signal);
				if (!next) return { kind: "rejected" as const };
				const wasFrozen = runtime.queueFrozen;
				yield* applySavedGoalSettings(runtime, next, ctx, options, settingsPath);
				if (wasFrozen && !runtime.queueFrozen) {
					const resume = options.onQueueUnfrozen?.(ctx);
					if (resume) {
						yield* Effect.catch(Effect.asVoid(resume), (error) =>
							Effect.sync(() => {
								ctx.ui.notify(
									`Goal queue enabled, but automatic resume failed: ${safeTerminalText(formatError(error))}. Reopen /goal to retry.`,
									"warning",
								);
							}),
						);
					}
				}
				ctx.ui.notify(`Ordered goal queue: ${enabled ? "Experimental" : "Off"}.`, "info");
				return { kind: "stay" as const };
			}).pipe(Effect.catch((error) => rejectedSettings(ctx, settingsPath, error)));
		},
		"set-rpc": ({ value }) => {
			const enabled = value === "On";
			if (enabled === runtime.settings.rpc.enabled) return { kind: "stay" };
			return Effect.gen(function* () {
				const next = { ...structuredClone(runtime.settings), rpc: { enabled } } satisfies GoalSettings;
				yield* applySavedGoalSettings(runtime, next, ctx, options, settingsPath);
				ctx.ui.notify(`Managed run RPC: ${enabled ? "On" : "Off"}.`, "info");
				return { kind: "stay" as const };
			}).pipe(Effect.catch((error) => rejectedSettings(ctx, settingsPath, error)));
		},
	};
}
export function showGoalSettings(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	options: GoalSettingsUiOptions = {},
): Effect.Effect<void> {
	const settingsPath = options.settingsPath ?? join(getAgentDir(), GOAL_SETTINGS_FILE);
	if (ctx.mode !== "tui") {
		return Effect.sync(() =>
			ctx.ui.notify(`Edit pi-goal settings manually: ${safeTerminalText(settingsPath)}`, "info"),
		);
	}
	const generation = runtime.menuGeneration;
	const invalid = runtime.settingsLoadIssue?.kind === "invalid";
	const previewGoalIds = new Map<LimitField, string | null>();
	const menu = defineMenu<undefined, GoalSettingsScreen, GoalSettingsAction, ExtensionCommandContext>({
		start: invalid ? "invalid" : "settings",
		screens: goalSettingsScreens(runtime, settingsPath),
		actions: goalSettingsActions(runtime, ctx, options, settingsPath, previewGoalIds),
	});
	return runMenu(ctx, menu, {
		getState: () => undefined,
		pi: runtime.pi,
		isCurrent: () => generation === runtime.menuGeneration,
	}).pipe(Effect.asVoid);
}

function limitChoiceScreen(runtime: GoalRuntime, field: LimitField, action: "choose-automatic" | "choose-no-progress") {
	const value = runtime.settings.continuationLimits[field];
	const goal = runtime.activeGoal;
	return {
		kind: "actions" as const,
		title: field === "automaticTurns" ? "Automatic work" : "No-progress guard",
		lines: [
			field === "automaticTurns"
				? `Current: ${formatAutomaticWork(value)}`
				: `Current: ${formatNoProgressProtection(value)}`,
			...(goal
				? [
						field === "automaticTurns"
							? `Active goal: ${goal.automaticModelTurns} automatic responses used`
							: `Active goal: ${goal.toolFreeRepeatCount} repeated or empty runs detected`,
					]
				: []),
		],
		items: limitChoices(field, value, goal?.automaticModelTurns).map((item) => ({
			id: item.value,
			label: item.label,
			description: item.description,
			action,
		})),
		hint: "back" as const,
	};
}

function limitChoices(
	field: LimitField,
	value: number | null,
	automaticTurnsUsed: number | undefined,
): Array<{ value: LimitSelection; label: string; description: string }> {
	if (field === "automaticTurns") {
		const unlimitedDescription =
			value === null
				? `No configurable cap; the non-disableable ${EMERGENCY_AUTOMATIC_TURN_LIMIT.toLocaleString()}-response emergency backstop still applies.`
				: automaticTurnsUsed === undefined
					? `Remove the current ${value}-response cap; the ${EMERGENCY_AUTOMATIC_TURN_LIMIT.toLocaleString()}-response emergency backstop remains.`
					: `Remove the current ${value}-response cap. The active goal has used ${automaticTurnsUsed} responses; the emergency backstop remains.`;
		return [
			{ value: "unlimited", label: "Unlimited (default)", description: unlimitedDescription },
			{
				value: "custom",
				label: "Set a maximum…",
				description: "Pause after a whole number of Goal-owned automatic responses.",
			},
		];
	}
	return [
		{
			value: "off",
			label: "Off (default)",
			description: "Do not stop a Goal because output is short, empty, or repeated.",
		},
		{
			value: "custom",
			label: "Set threshold…",
			description: "Choose a whole number of repeated or empty runs before pausing.",
		},
	];
}

function applyLimitChoice(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	options: GoalSettingsUiOptions,
	settingsPath: string,
	field: LimitField,
	itemId: string,
	activeGoalId: string | null,
	signal: AbortSignal,
) {
	return Effect.gen(function* () {
		if (!isLimitSelection(itemId)) return { kind: "rejected" as const };
		if ((runtime.activeGoal?.id ?? null) !== activeGoalId) {
			ctx.ui.notify(
				"The active goal changed while the safety setting was open. No settings were changed.",
				"warning",
			);
			return { kind: "rejected" as const };
		}
		const previous = runtime.settings.continuationLimits[field];
		const limit = yield* resolveLimitSelection(field, itemId, previous, ctx, signal);
		if (limit === undefined || limit === previous) return { kind: "back" as const };
		if ((runtime.activeGoal?.id ?? null) !== activeGoalId) {
			ctx.ui.notify(
				"The active goal changed while editing the safety setting. No settings were changed.",
				"warning",
			);
			return { kind: "rejected" as const };
		}
		const confirmation = yield* confirmLowerActiveLimit(runtime, ctx, field, limit, signal);
		if (!confirmation.apply) return { kind: "rejected" as const };
		if ("goalId" in confirmation && runtime.activeGoal?.id !== confirmation.goalId) {
			ctx.ui.notify("The active goal changed while confirming the limit. No settings were changed.", "warning");
			return { kind: "rejected" as const };
		}
		yield* applySavedGoalSettings(runtime, withLimit(runtime.settings, field, limit), ctx, options, settingsPath);
		ctx.ui.notify(formatLimitSuccess(field, limit), "info");
		return { kind: "back" as const };
	}).pipe(Effect.catch((error) => rejectedSettings(ctx, settingsPath, error)));
}

function applySavedGoalSettings(
	runtime: GoalRuntime,
	next: GoalSettings,
	ctx: ExtensionCommandContext,
	options: GoalSettingsUiOptions,
	settingsPath: string,
) {
	const save = options.save
		? (settings: GoalSettings) => options.save?.(settings, settingsPath) ?? Effect.void
		: options.store
			? (settings: GoalSettings) => options.store?.replace(settings) ?? Effect.void
			: () => Effect.fail(new Error(`Goal settings are unavailable before Session start: ${settingsPath}`));
	return applyGoalSettings(runtime, next, ctx, { save });
}

export function applyGoalSettings(
	runtime: GoalRuntime,
	next: GoalSettings,
	ctx: ExtensionCommandContext,
	options: GoalSettingsApplyOptions = {},
): Effect.Effect<void, unknown> {
	return Effect.suspend(() => {
		const snapshot = runtime.snapshotSettingsApplicationState();
		let fileSaved = false;
		const apply = Effect.gen(function* () {
			yield* settingsTry(() => {
				runtime.settings = structuredClone(next);
				applyToolVisibility(runtime, snapshot.settings, next, ctx);
			});
			if (options.save) {
				yield* options.save(next);
				fileSaved = true;
			}
			yield* settingsTry(() => {
				applyQueueSetting(runtime, ctx);
				const activeGoalId = runtime.activeGoal?.id;
				const abortOwnedRun = activeGoalId !== undefined && runtime.agentRunGoalId === activeGoalId;
				const pausedByAutomaticLimit = runtime.enforceAutomaticTurnLimit(ctx, abortOwnedRun);
				if (!pausedByAutomaticLimit) runtime.enforceNoProgressLimit(ctx, abortOwnedRun);
			});
		});
		return apply.pipe(
			Effect.catch((error) =>
				Effect.gen(function* () {
					const rollbackErrors: unknown[] = [];
					const record = (program: Effect.Effect<void, unknown>) =>
						Effect.catch(program, (rollbackError) =>
							Effect.sync(() => {
								rollbackErrors.push(rollbackError);
							}),
						);
					yield* record(settingsTry(() => runtime.restoreSettingsApplicationState(snapshot)));
					if (fileSaved && options.save) {
						yield* record(options.save(snapshot.settings));
						yield* record(settingsTry(() => restorePersistedRuntime(runtime)));
					}
					return yield* Effect.fail(
						rollbackErrors.length > 0
							? new AggregateError(
									[error, ...rollbackErrors],
									`pi-goal settings application failed and rollback was incomplete: ${formatError(error)}`,
								)
							: error,
					);
				}),
			),
		);
	});
}

export function parseGoalLimit(value: string): number | undefined {
	const normalized = value.trim();
	if (!/^\d+$/u.test(normalized)) return undefined;
	const parsed = Number(normalized);
	return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function formatGoalLimit(value: number | null) {
	return value === null ? "Unlimited" : String(value);
}

function resolveLimitSelection(
	field: LimitField,
	selection: LimitSelection,
	previous: number | null,
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
) {
	if (selection === "unlimited" || selection === "off") return Effect.succeed(null);
	return Effect.gen(function* () {
		while (true) {
			const raw = yield* menuWait(() =>
				ctx.ui.input(
					field === "automaticTurns"
						? "Maximum automatic responses (whole number greater than 0)"
						: "Repeated-run threshold (whole number greater than 0)",
					previous === null ? "Positive whole number" : String(previous),
					{ signal },
				),
			);
			if (raw === undefined) return undefined;
			const parsed = parseGoalLimit(raw);
			if (parsed !== undefined) return parsed;
			ctx.ui.notify(
				`Enter a whole number greater than 0. Choose ${field === "automaticTurns" ? "Unlimited" : "Off"} from the previous screen if you do not want a limit.`,
				"warning",
			);
		}
	});
}

function nextQueueSettings(runtime: GoalRuntime, ctx: ExtensionCommandContext, enabled: boolean, signal: AbortSignal) {
	return Effect.gen(function* () {
		if (runtime.settings.experimental.goals === enabled) return undefined;
		if (enabled && !runtime.settings.experimental.goals) {
			const confirmed = yield* menuWait(() =>
				ctx.ui.confirm(
					"Enable experimental goal queue?",
					"Queue behavior and persisted state may change between releases. Existing single-goal behavior remains available.",
					{ signal },
				),
			);
			if (!confirmed) return undefined;
		}
		if (
			!enabled &&
			(runtime.queuedGoals.length > 0 || runtime.pendingQueueAction !== undefined) &&
			!(yield* menuWait(() =>
				ctx.ui.confirm(
					"Freeze ordered goal queue?",
					`Disabling the experiment preserves ${retainedGoalCount(runtime)} goal(s) but freezes automatic work until the setting is re-enabled. No goal data will be deleted.`,
					{ signal },
				),
			))
		) {
			return undefined;
		}
		return {
			...structuredClone(runtime.settings),
			experimental: { goals: enabled },
		} satisfies GoalSettings;
	});
}

function applyToolVisibility(
	runtime: GoalRuntime,
	previous: GoalSettings,
	next: GoalSettings,
	ctx: ExtensionCommandContext,
) {
	if (previous.toolVisibility === next.toolVisibility) return;
	if (next.toolVisibility === "always") {
		if (runtime.goalToolsHiddenByPolicy.size > 0 && ctx.isIdle() !== true) {
			throw new Error("Wait for Pi to become idle before revealing Goal tools.");
		}
		runtime.restoreGoalToolsHiddenByPolicy();
		runtime.goalToolsUnlocked = true;
		return;
	}
	if (runtime.activeGoal) {
		runtime.goalToolsUnlocked = true;
		runtime.goalToolsHiddenByPolicy.clear();
		return;
	}
	if (ctx.isIdle() !== true) {
		throw new Error("Wait for Pi to become idle before hiding Goal tools.");
	}
	runtime.goalToolsUnlocked = false;
	runtime.hideGoalToolsIfLocked();
}

function applyQueueSetting(runtime: GoalRuntime, ctx: ExtensionCommandContext) {
	const hasQueueState = runtime.queuedGoals.length > 0 || runtime.pendingQueueAction !== undefined;
	const shouldFreeze = !runtime.settings.experimental.goals && hasQueueState;
	// Keep the freeze guard until the aborted Goal-owned run reaches agent_settled.
	// Releasing it earlier lets the old agent_end pause newly resumed work.
	if (runtime.queueFrozen && !shouldFreeze && runtime.queueFreezeAwaitingSettle) return;
	if (runtime.queueFrozen === shouldFreeze) return;
	const activeGoal = runtime.activeGoal?.status === "active" ? runtime.activeGoal : undefined;
	const goalOwnedRun = activeGoal && runtime.agentRunGoalId === activeGoal.id;
	if (shouldFreeze && activeGoal) {
		if (goalOwnedRun) runtime.recordGoalUsage(activeGoal, ctx, false);
		else {
			const now = Date.now();
			checkpointGoalActiveTime(activeGoal, now, false);
			activeGoal.updatedAt = now;
		}
	}
	runtime.queueFrozen = shouldFreeze;
	if (runtime.activeGoal) runtime.persistGoal(runtime.activeGoal);
	else runtime.clearPresentationStatus();
	if (!shouldFreeze) return;

	runtime.prompts.cancelContinuationWork();
	runtime.goalRecovery = undefined;
	runtime.clearBudgetWrapUp();
	if (goalOwnedRun) {
		runtime.blockStaleGoalToolCalls();
		runtime.guardAbortGoalId = activeGoal.id;
		runtime.queueFreezeAwaitingSettle = true;
		runtime.clearAgentRun();
		abortCurrentTurn(ctx);
	}
}

function restorePersistedRuntime(runtime: GoalRuntime) {
	if (runtime.activeGoal) {
		runtime.persistGoal(runtime.activeGoal);
		return;
	}
	runtime.clearPresentationStatus();
}

function confirmLowerActiveLimit(
	runtime: GoalRuntime,
	ctx: ExtensionCommandContext,
	field: LimitField,
	limit: number | null,
	signal: AbortSignal,
) {
	const goal = runtime.activeGoal;
	if (goal?.status !== "active" || limit === null) return Effect.succeed({ apply: true });
	const used = field === "automaticTurns" ? goal.automaticModelTurns : goal.toolFreeRepeatCount;
	if (used < limit) return Effect.succeed({ apply: true });
	return Effect.map(
		menuWait(() =>
			ctx.ui.confirm(
				"Apply limit and pause now?",
				`The active goal has already used ${used}. Setting this limit to ${limit} will pause it immediately without deleting progress.`,
				{ signal },
			),
		),
		(apply) => ({ apply, goalId: goal.id }),
	);
}

function withLimit(settings: GoalSettings, field: LimitField, value: number | null): GoalSettings {
	return {
		...structuredClone(settings),
		continuationLimits: { ...settings.continuationLimits, [field]: value },
	};
}

function formatAutomaticSettingValue(value: number | null) {
	return value === null ? "Unlimited" : `≤${value}`;
}

function formatNoProgressSettingValue(value: number | null) {
	if (value === null) return "Off";
	return `${value} ${value === 1 ? "run" : "runs"}`;
}

function formatAutomaticWork(value: number | null) {
	return value === null ? "Unlimited" : `Up to ${value} responses`;
}

function formatNoProgressProtection(value: number | null) {
	if (value === null) return "Off";
	return `After ${value} repeated ${value === 1 ? "run" : "runs"}`;
}

function formatLimitSuccess(field: LimitField, value: number | null) {
	return field === "automaticTurns"
		? `Automatic work: ${formatAutomaticWork(value)}.`
		: `No-progress guard: ${formatNoProgressProtection(value)}.`;
}

function isLimitSelection(value: string): value is LimitSelection {
	return value === "unlimited" || value === "custom" || value === "off";
}

function visibilityLabel(value: GoalSettings["toolVisibility"]) {
	return value === "always" ? "Always" : "After first goal";
}

function retainedGoalCount(runtime: GoalRuntime) {
	return (
		(runtime.activeGoal ? 1 : 0) +
		runtime.queuedGoals.length +
		(runtime.pendingQueueAction?.kind === "prioritize" ? 1 : 0)
	);
}

function notifySettingsFailure<Failure>(ctx: ExtensionCommandContext, settingsPath: string, error: Failure) {
	const path = safeTerminalText(settingsPath);
	const detail = safeTerminalText(formatError(error));
	ctx.ui.notify(
		error instanceof AggregateError
			? `Could not apply Goal settings, and rollback was incomplete. Check ${path}, run /reload, and verify the effective settings before retrying: ${detail}`
			: `Could not save Goal settings; the previous value remains. Check ${path} and retry: ${detail}`,
		"error",
	);
}

function rejectedSettings<Failure>(ctx: ExtensionCommandContext, settingsPath: string, error: Failure) {
	return Effect.sync(() => {
		notifySettingsFailure(ctx, settingsPath, error);
		return { kind: "rejected" as const };
	});
}

function settingsTry(operation: () => void): Effect.Effect<void, unknown> {
	return Effect.try({ try: operation, catch: (error) => error });
}

function safeTerminalText(value: string) {
	return [...value]
		.map((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f) ? " " : character;
		})
		.join("")
		.trim();
}

function formatError<Failure>(error: Failure) {
	return error instanceof Error ? error.message : String(error);
}
