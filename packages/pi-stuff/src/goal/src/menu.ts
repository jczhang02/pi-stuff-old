import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { formatDuration } from "./accounting.ts";
import { parseTokenBudget } from "./command.ts";
import type { GoalCommandController } from "./commands.ts";
import type { ActiveGoal, PendingQueueAction } from "./persistence.ts";
import { goalQueueIdentity } from "./queue.ts";
import { EMERGENCY_AUTOMATIC_TURN_LIMIT, type GoalRuntime, goalSummary } from "./runtime.ts";
import { type ActionMenuItem, defineMenu, type MenuDefinition, menuWait, runMenu } from "./suite-menu.ts";

export const GOAL_MENU_ACTIONS = {
	start: "Start a goal…",
	startBudget: "Start with token budget…",
	pause: "Pause goal",
	resume: "Resume goal",
	increaseBudget: "Increase budget and resume…",
	edit: "Edit goal…",
	replace: "Replace goal…",
	status: "View full status",
	queue: "Queue…",
	settings: "Settings…",
	help: "Help",
	clear: "Clear goal…",
	close: "Close",
} as const;

const QUEUE_ACTIONS = {
	add: "Add goal…",
	prioritize: "Prioritize goal…",
	skip: "Skip current goal…",
	dropLast: "Drop last goal…",
	back: "Back",
} as const;

interface GoalMenuRuntimeView {
	activeGoal?: ActiveGoal | undefined;
	queuedGoals: ActiveGoal[];
	pendingQueueAction?: PendingQueueAction | undefined;
	queueFrozen: boolean;
	settings: GoalRuntime["settings"];
	menuGeneration?: GoalRuntime["menuGeneration"];
	pi?: GoalRuntime["pi"];
	recordGoalUsage?: GoalRuntime["recordGoalUsage"];
	persistGoal?: GoalRuntime["persistGoal"];
}

export interface GoalMenuState {
	title: string;
	actions: string[];
}

type ShowSettings = (ctx: ExtensionCommandContext) => Effect.Effect<void, unknown>;
type GoalMenuScreen = "main" | "queue" | "status" | "help";
type GoalMenuAction =
	| "start"
	| "start-budget"
	| "pause"
	| "resume"
	| "increase-budget"
	| "edit"
	| "replace"
	| "settings"
	| "clear"
	| "queue-add"
	| "queue-prioritize"
	| "queue-skip"
	| "queue-drop"
	| "back";
type GoalMenuDefinition = MenuDefinition<undefined, GoalMenuScreen, GoalMenuAction>;

interface GoalMenuSelection {
	goal: ActiveGoal | undefined;
	queueFirst: ActiveGoal | undefined;
	queueHead: ActiveGoal | undefined;
	queueLast: ActiveGoal | undefined;
}

export function buildGoalMenuState(runtime: GoalMenuRuntimeView): GoalMenuState {
	const goal = runtime.activeGoal;
	const queueCount = runtime.queuedGoals.length;
	const state = runtime.queueFrozen
		? "Queue frozen"
		: runtime.pendingQueueAction
			? "Waiting for Pi to settle"
			: displayStatus(goal?.status);
	const automaticTurnLimit = runtime.settings.continuationLimits.automaticTurns;
	const automaticResponses =
		automaticTurnLimit === null
			? `${goal?.automaticModelTurns ?? 0} automatic responses · Unlimited (<${EMERGENCY_AUTOMATIC_TURN_LIMIT.toLocaleString()} emergency)`
			: `${goal?.automaticModelTurns ?? 0}/${automaticTurnLimit} automatic responses`;
	const details = goal
		? [
				goal.tokenBudget === undefined
					? formatDuration(goal.timeUsedSeconds)
					: `${formatTokenCount(goal.tokensUsed)}/${formatTokenCount(goal.tokenBudget)}`,
				automaticResponses,
				...(queueCount > 0 ? [`${queueCount} queued`] : []),
			].join(" · ")
		: "No goal is currently set";
	const title = goal ? `Goal · ${state}\n${safeGoalMenuText(goal.text)}\n${details}` : `Goal · ${state}\n${details}`;

	if (runtime.queueFrozen || runtime.pendingQueueAction) {
		return {
			title,
			actions: [
				GOAL_MENU_ACTIONS.status,
				GOAL_MENU_ACTIONS.settings,
				GOAL_MENU_ACTIONS.help,
				GOAL_MENU_ACTIONS.clear,
				GOAL_MENU_ACTIONS.close,
			],
		};
	}

	const actions: string[] = [];
	if (!goal || goal.status === "complete") {
		actions.push(GOAL_MENU_ACTIONS.start, GOAL_MENU_ACTIONS.startBudget);
	} else if (goal.status === "active") {
		actions.push(GOAL_MENU_ACTIONS.pause);
	} else if (goal.status === "budget_limited") {
		actions.push(GOAL_MENU_ACTIONS.increaseBudget);
	} else {
		actions.push(GOAL_MENU_ACTIONS.resume);
	}
	if (goal && goal.status !== "complete") {
		actions.push(GOAL_MENU_ACTIONS.edit, GOAL_MENU_ACTIONS.replace);
	}
	if (goal) actions.push(GOAL_MENU_ACTIONS.status);
	if (goal && (runtime.settings.experimental.goals || queueCount > 0)) {
		actions.push(GOAL_MENU_ACTIONS.queue);
	}
	actions.push(GOAL_MENU_ACTIONS.settings, GOAL_MENU_ACTIONS.help);
	if (goal) actions.push(GOAL_MENU_ACTIONS.clear);
	actions.push(GOAL_MENU_ACTIONS.close);
	return { title, actions };
}

function goalMenuScreens(
	runtime: GoalMenuRuntimeView,
	ctx: ExtensionCommandContext,
	selection: GoalMenuSelection,
): GoalMenuDefinition["screens"] {
	return {
		main: () => {
			refreshGoalMenuState(runtime, ctx);
			const state = buildGoalMenuState(runtime);
			selection.goal = runtime.activeGoal;
			return {
				kind: "actions",
				title: "Goal",
				lines: state.title.split("\n").slice(1),
				items: state.actions.map(goalMainMenuItem),
				hint: "close",
			};
		},
		queue: () => {
			selection.queueHead = runtime.activeGoal;
			selection.queueFirst = runtime.queuedGoals[0];
			selection.queueLast = runtime.queuedGoals.at(-1) ?? runtime.activeGoal;
			return {
				kind: "actions",
				title: "Goal queue",
				lines: [
					`${runtime.queuedGoals.length + (runtime.activeGoal ? 1 : 0)} total`,
					...(runtime.activeGoal ? [`Current: ${safeGoalMenuText(runtime.activeGoal.text)}`] : []),
				],
				items: [
					{ id: "add", label: QUEUE_ACTIONS.add, action: "queue-add" },
					{ id: "prioritize", label: QUEUE_ACTIONS.prioritize, action: "queue-prioritize" },
					...(runtime.queuedGoals.length > 0
						? [
								{ id: "skip", label: QUEUE_ACTIONS.skip, action: "queue-skip" as const },
								{ id: "drop-last", label: QUEUE_ACTIONS.dropLast, action: "queue-drop" as const },
							]
						: []),
					{ id: "back", label: QUEUE_ACTIONS.back, action: "back" },
				],
				hint: "back",
			};
		},
		status: () => ({
			kind: "detail",
			title: "Goal status",
			lines: runtime.activeGoal
				? goalSummary(
						runtime.activeGoal,
						runtime.queuedGoals,
						runtime.settings.experimental.goals,
						runtime.queueFrozen,
						runtime.pendingQueueAction,
					).split("\n")
				: ["No goal is currently set."],
			hint: "back",
		}),
		help: () => ({
			kind: "detail",
			title: "Goal help",
			lines: goalHelp().split("\n").slice(1),
			hint: "back",
		}),
	};
}

function clearFromMenu(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
) {
	return Effect.gen(function* () {
		const previewedQueue = goalQueueIdentity(runtime.activeGoal, runtime.queuedGoals, runtime.pendingQueueAction);
		if (!(yield* confirmClear(runtime, ctx, signal))) return { kind: "stay" as const };
		if (goalQueueIdentity(runtime.activeGoal, runtime.queuedGoals, runtime.pendingQueueAction) !== previewedQueue) {
			ctx.ui.notify("The goal queue changed while the dialog was open. Reopen /goal and try again.", "warning");
			return { kind: "stay" as const };
		}
		yield* commands.clearGoal(ctx);
		return { kind: "close" as const };
	});
}

function goalMenuActions(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	showSettings: ShowSettings,
	selection: GoalMenuSelection,
): GoalMenuDefinition["actions"] {
	return {
		start: ({ signal }) => startFromMenu(commands, ctx, signal).pipe(Effect.as({ kind: "close" as const })),
		"start-budget": ({ signal }) =>
			startFromMenu(commands, ctx, signal, true).pipe(Effect.as({ kind: "close" as const })),
		pause: () => {
			if (!selection.goal || !requireCurrentMenuGoal(runtime, selection.goal, ctx)) return { kind: "stay" };
			commands.pauseGoal(ctx);
			return { kind: "close" };
		},
		resume: () => {
			if (!selection.goal || !requireCurrentMenuGoal(runtime, selection.goal, ctx)) return { kind: "stay" };
			return commands.resumeGoal(ctx).pipe(Effect.as({ kind: "close" as const }));
		},
		"increase-budget": ({ signal }) => {
			if (!selection.goal || !requireCurrentMenuGoal(runtime, selection.goal, ctx)) return { kind: "stay" };
			return increaseBudget(runtime, commands, ctx, signal).pipe(Effect.as({ kind: "close" as const }));
		},
		edit: ({ signal }) => {
			if (!selection.goal || !requireCurrentMenuGoal(runtime, selection.goal, ctx)) return { kind: "stay" };
			return editFromMenu(runtime, commands, ctx, signal).pipe(Effect.as({ kind: "close" as const }));
		},
		replace: ({ signal }) => startFromMenu(commands, ctx, signal).pipe(Effect.as({ kind: "close" as const })),
		settings: () => showSettings(ctx).pipe(Effect.as({ kind: "stay" as const })),
		clear: ({ signal }) => clearFromMenu(runtime, commands, ctx, signal),
		"queue-add": () =>
			Effect.gen(function* () {
				const objective = (yield* menuWait(() => ctx.ui.editor("Add goal to queue", "")))?.trim();
				if (objective) yield* commands.addGoal(objective, undefined, ctx);
				return { kind: "close" as const };
			}),
		"queue-prioritize": ({ signal }) =>
			Effect.gen(function* () {
				const goal = selection.queueHead;
				if (!goal) return { kind: "stay" };
				const objective = (yield* menuWait(() => ctx.ui.editor("Prioritize goal", "")))?.trim();
				if (!objective || !requireCurrentQueueHead(runtime, goal, ctx)) return { kind: "stay" };
				const confirmed = yield* menuWait(() =>
					ctx.ui.confirm(
						"Prioritize goal?",
						`New priority goal:\n${safeGoalMenuText(objective, 4_000)}\n\nCurrent goal moved to the queue:\n${safeGoalMenuText(goal.text, 4_000)}`,
						{ signal },
					),
				);
				if (confirmed && requireCurrentQueueHead(runtime, goal, ctx)) {
					yield* commands.prioritizeGoal(objective, undefined, ctx);
				}
				return { kind: "close" as const };
			}),
		"queue-skip": ({ signal }) =>
			Effect.gen(function* () {
				const goal = selection.queueHead;
				if (!goal) return { kind: "stay" };
				const next = selection.queueFirst;
				const nextEffect = !next
					? "No goal remains"
					: next.status === "queued"
						? `Start next goal:\n${safeGoalMenuText(next.text, 4_000)}`
						: `Next goal remains ${displayStatus(next.status).toLowerCase()}:\n${safeGoalMenuText(next.text, 4_000)}`;
				const confirmed = yield* menuWait(() =>
					ctx.ui.confirm(
						"Skip current goal?",
						`Remove current goal:\n${safeGoalMenuText(goal.text, 4_000)}\n\n${nextEffect}`,
						{ signal },
					),
				);
				if (confirmed && requireCurrentQueueSelection(runtime, goal, next, "first", ctx)) {
					yield* commands.skipGoal(ctx);
				}
				return { kind: "close" as const };
			}),
		"queue-drop": ({ signal }) =>
			Effect.gen(function* () {
				const goal = selection.queueHead;
				const last = selection.queueLast;
				if (!goal || !last) return { kind: "stay" };
				const confirmed = yield* menuWait(() =>
					ctx.ui.confirm("Drop last goal?", `Remove from queue:\n${safeGoalMenuText(last.text, 4_000)}`, {
						signal,
					}),
				);
				if (confirmed && requireCurrentQueueSelection(runtime, goal, last, "last", ctx)) {
					yield* commands.dropLastGoal(ctx);
				}
				return { kind: "close" as const };
			}),
		back: () => ({ kind: "back" }),
	};
}

export function showGoalManager(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	showSettings: ShowSettings,
): Effect.Effect<void> {
	if (ctx.mode !== "tui") {
		return Effect.sync(() => commands.showGoal(ctx));
	}
	const owner = runtime;
	const generation = owner.menuGeneration;
	const selection: GoalMenuSelection = {
		goal: undefined,
		queueFirst: undefined,
		queueHead: undefined,
		queueLast: undefined,
	};
	const menu = defineMenu<undefined, GoalMenuScreen, GoalMenuAction, ExtensionCommandContext>({
		start: "main",
		screens: goalMenuScreens(runtime, ctx, selection),
		actions: goalMenuActions(runtime, commands, ctx, showSettings, selection),
	});
	return runMenu(ctx, menu, {
		getState: () => undefined,
		pi: owner.pi,
		isCurrent: () => generation === owner.menuGeneration,
	}).pipe(Effect.asVoid);
}

function goalMainMenuItem(label: string): ActionMenuItem<GoalMenuScreen, GoalMenuAction> {
	if (label === GOAL_MENU_ACTIONS.status) return { id: "status", label, to: "status" as const };
	if (label === GOAL_MENU_ACTIONS.queue) return { id: "queue", label, to: "queue" as const };
	if (label === GOAL_MENU_ACTIONS.help) return { id: "help", label, to: "help" as const };
	if (label === GOAL_MENU_ACTIONS.close) return { id: "close", label, close: true as const };
	const actions = new Map<string, GoalMenuAction>([
		[GOAL_MENU_ACTIONS.start, "start"],
		[GOAL_MENU_ACTIONS.startBudget, "start-budget"],
		[GOAL_MENU_ACTIONS.pause, "pause"],
		[GOAL_MENU_ACTIONS.resume, "resume"],
		[GOAL_MENU_ACTIONS.increaseBudget, "increase-budget"],
		[GOAL_MENU_ACTIONS.edit, "edit"],
		[GOAL_MENU_ACTIONS.replace, "replace"],
		[GOAL_MENU_ACTIONS.settings, "settings"],
		[GOAL_MENU_ACTIONS.clear, "clear"],
	]);
	return { id: actions.get(label) ?? label, label, action: actions.get(label) ?? "settings" };
}

function refreshGoalMenuState(runtime: GoalMenuRuntimeView, ctx: ExtensionCommandContext) {
	const goal = runtime.activeGoal;
	if (!goal || runtime.queueFrozen) return;
	runtime.recordGoalUsage?.(goal, ctx);
	runtime.persistGoal?.(goal);
}

export function safeGoalMenuText(value: string, maxCharacters = 120) {
	const sanitized = [...value]
		.map((character) => (isTerminalControl(character) ? " " : character))
		.join("")
		.replace(/\s+/gu, " ")
		.trim();
	const characters = [...sanitized];
	return characters.length <= maxCharacters ? sanitized : `${characters.slice(0, maxCharacters).join("")}…`;
}

function startFromMenu(
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
	withBudget = false,
) {
	return Effect.gen(function* () {
		const objective = (yield* menuWait(() => ctx.ui.editor("Goal objective", "")))?.trim();
		if (!objective) return;
		const tokenBudget = withBudget ? yield* askTokenBudget(ctx, signal) : undefined;
		if (withBudget && tokenBudget === undefined) return;
		yield* commands.startGoal(objective, tokenBudget, ctx);
	});
}

function editFromMenu(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
) {
	return Effect.gen(function* () {
		const goal = runtime.activeGoal;
		if (!goal) return;
		const objective = (yield* menuWait(() => ctx.ui.editor("Edit goal objective", goal.text)))?.trim();
		if (!objective || objective === goal.text || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
		if (goal.status === "active") {
			const confirmed = yield* menuWait(() =>
				ctx.ui.confirm(
					"Apply goal edit?",
					`Current goal:\n${safeGoalMenuText(goal.text, 4_000)}\n\nUpdated goal:\n${safeGoalMenuText(objective, 4_000)}\n\nApplying this edit starts a new guarded goal instance.`,
					{ signal },
				),
			);
			if (!confirmed || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
		}
		yield* commands.editGoal(objective, undefined, ctx);
	});
}

function increaseBudget(
	runtime: GoalMenuRuntimeView,
	commands: GoalCommandController,
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
) {
	return Effect.gen(function* () {
		const goal = runtime.activeGoal;
		if (!goal) return;
		const budget = yield* askTokenBudget(ctx, signal, goal.tokenBudget);
		if (budget === undefined || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
		if (budget <= goal.tokensUsed) {
			ctx.ui.notify(
				`Token budget must be greater than current usage (${formatTokenCount(goal.tokensUsed)}).`,
				"warning",
			);
			return;
		}
		const confirmed = yield* menuWait(() =>
			ctx.ui.confirm(
				"Increase goal budget?",
				`Goal: ${safeGoalMenuText(goal.text, 4_000)}\n\nBudget: ${formatTokenCount(goal.tokenBudget ?? 0)} → ${formatTokenCount(budget)}\nCurrent usage: ${formatTokenCount(goal.tokensUsed)}\n\nThe goal will resume immediately.`,
				{ signal },
			),
		);
		if (!confirmed || !requireCurrentMenuGoal(runtime, goal, ctx)) return;
		yield* commands.editGoal(goal.text, budget, ctx);
	});
}

function askTokenBudget(ctx: ExtensionCommandContext, signal: AbortSignal, current?: number) {
	return Effect.map(
		menuWait(() =>
			ctx.ui.input("Token budget", current === undefined ? "100k" : formatTokenCount(current), { signal }),
		),
		(raw) => {
			if (raw === undefined) return undefined;
			const budget = parseTokenBudget(raw);
			if (budget === undefined) ctx.ui.notify(`Invalid token budget: ${safeGoalMenuText(raw)}`, "warning");
			return budget;
		},
	);
}

function confirmClear(runtime: GoalMenuRuntimeView, ctx: ExtensionCommandContext, signal: AbortSignal) {
	const goals = [runtime.activeGoal, ...runtime.queuedGoals].filter((goal): goal is ActiveGoal => goal !== undefined);
	const pendingPriority =
		runtime.pendingQueueAction?.kind === "prioritize" ? runtime.pendingQueueAction.objective : undefined;
	const summaries = [
		...goals.map((goal) => safeGoalMenuText(goal.text, 4_000)),
		...(pendingPriority ? [`Pending priority: ${safeGoalMenuText(pendingPriority, 4_000)}`] : []),
	];
	if (summaries.length === 0) return Effect.succeed(false);
	return menuWait(() =>
		ctx.ui.confirm(
			summaries.length > 1 ? "Clear goal queue?" : "Clear goal?",
			`Remove ${summaries.length === 1 ? "this goal" : `all ${summaries.length} goals`}:\n\n${summaries
				.map((summary, index) => `${index + 1}. ${summary}`)
				.join("\n")}\n\nThis cannot be undone.`,
			{ signal },
		),
	);
}

function requireCurrentQueueHead(runtime: GoalMenuRuntimeView, expectedGoal: ActiveGoal, ctx: ExtensionCommandContext) {
	if (runtime.activeGoal?.id === expectedGoal.id) return true;
	ctx.ui.notify("The goal queue changed while the dialog was open. Reopen /goal and try again.", "warning");
	return false;
}

function requireCurrentQueueSelection(
	runtime: GoalMenuRuntimeView,
	expectedGoal: ActiveGoal,
	expectedQueuedGoal: ActiveGoal | undefined,
	position: "first" | "last",
	ctx: ExtensionCommandContext,
) {
	const currentQueuedGoal =
		position === "first" ? runtime.queuedGoals[0] : (runtime.queuedGoals.at(-1) ?? runtime.activeGoal);
	if (runtime.activeGoal?.id === expectedGoal.id && currentQueuedGoal?.id === expectedQueuedGoal?.id) {
		return true;
	}
	ctx.ui.notify("The goal queue changed while the dialog was open. Reopen /goal and try again.", "warning");
	return false;
}

function requireCurrentMenuGoal(runtime: GoalMenuRuntimeView, expected: ActiveGoal, ctx: ExtensionCommandContext) {
	if (runtime.activeGoal?.id === expected.id) return true;
	ctx.ui.notify("The active goal changed while the dialog was open. Reopen /goal and try again.", "warning");
	return false;
}

function displayStatus(status?: ActiveGoal["status"]) {
	if (!status) return "No goal";
	if (status === "usage_limited") return "Usage limited";
	if (status === "budget_limited") return "Budget limited";
	return status[0]?.toUpperCase() + status.slice(1);
}

function formatTokenCount(tokens: number) {
	return String(tokens);
}

function isTerminalControl(character: string) {
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function goalHelp() {
	return [
		"Goal menu",
		"Use the menu for guided status, edits, queue management, settings, and confirmations.",
		"Direct routes remain available for deterministic workflows:",
		"/goal <objective>",
		"/goal status | pause | resume | edit | clear",
		"/goal --tokens 100k <objective>",
		"Escape cancels the current menu or input without changing goal state.",
	].join("\n");
}
