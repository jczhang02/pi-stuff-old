import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
	buildGoalMenuState,
	GOAL_MENU_ACTIONS,
	safeGoalMenuText,
	showGoalManager as showGoalManagerEffect,
} from "../../../packages/pi-stuff/src/goal/src/menu.js";
import type { ActiveGoal, PendingQueueAction } from "../../../packages/pi-stuff/src/goal/src/persistence.js";
import { createGoal, transitionGoal } from "../../../packages/pi-stuff/src/goal/src/runtime.js";
import { DEFAULT_GOAL_SETTINGS } from "../../../packages/pi-stuff/src/goal/src/settings.js";
import { createMockContext, createMockPi } from "../../goal-upstream/support.js";

async function showGoalManager(
	runtime: Parameters<typeof showGoalManagerEffect>[0],
	commands: Parameters<typeof showGoalManagerEffect>[1],
	ctx: Parameters<typeof showGoalManagerEffect>[2],
	showSettings: (ctx: ExtensionCommandContext) => Promise<void>,
): Promise<void> {
	await Effect.runPromise(
		showGoalManagerEffect(runtime, commands, ctx, (settingsCtx) =>
			Effect.tryPromise({ try: () => showSettings(settingsCtx), catch: (error) => error }),
		),
	);
}

function runtime(goal?: ActiveGoal) {
	return {
		activeGoal: goal,
		// SAFETY: this test controls the value and supplies every ActiveGoal member exercised by this case.
		queuedGoals: [] as ActiveGoal[],
		// SAFETY: this test controls the value and supplies every PendingQueueAction member exercised by this case.
		pendingQueueAction: undefined as PendingQueueAction | undefined,
		queueFrozen: false,
		settings: structuredClone(DEFAULT_GOAL_SETTINGS),
	};
}

function commands() {
	const calls: Array<{ name: string; args: unknown[] }> = [];
	const record =
		(name: string) =>
		(...args: unknown[]) =>
			calls.push({ name, args });
	const recordEffect =
		(name: string) =>
		(...args: unknown[]) =>
			Effect.sync(() => {
				calls.push({ name, args });
			});
	return {
		calls,
		controller: {
			startGoal: recordEffect("startGoal"),
			pauseGoal: record("pauseGoal"),
			resumeGoal: recordEffect("resumeGoal"),
			clearGoal: recordEffect("clearGoal"),
			editGoal: recordEffect("editGoal"),
			showGoal: record("showGoal"),
			addGoal: recordEffect("addGoal"),
			prioritizeGoal: recordEffect("prioritizeGoal"),
			dropLastGoal: recordEffect("dropLastGoal"),
			skipGoal: recordEffect("skipGoal"),
		},
	};
}

test("buildGoalMenuState prioritizes actions for empty, active, stopped, budget, and frozen states", () => {
	const empty = runtime();
	empty.settings.experimental.goals = true;
	assert.deepEqual(buildGoalMenuState(empty).actions.slice(0, 2), [
		GOAL_MENU_ACTIONS.start,
		GOAL_MENU_ACTIONS.startBudget,
	]);
	assert.equal(buildGoalMenuState(empty).actions.includes(GOAL_MENU_ACTIONS.queue), false);

	const active = createGoal("ship the release", 100, 0);
	active.tokensUsed = 20;
	active.automaticModelTurns = 12;
	const unlimited = runtime(active);
	assert.equal(buildGoalMenuState(unlimited).actions[0], GOAL_MENU_ACTIONS.pause);
	assert.match(buildGoalMenuState(unlimited).title, /Active.*20\/100/is);
	assert.match(buildGoalMenuState(unlimited).title, /12 automatic responses.*Unlimited/is);

	const capped = runtime(active);
	capped.settings.continuationLimits.automaticTurns = 25;
	assert.match(buildGoalMenuState(capped).title, /12\/25 automatic responses/is);

	for (const status of ["paused", "blocked", "usage_limited"] as const) {
		const stopped = runtime(transitionGoal(active, status));
		assert.equal(buildGoalMenuState(stopped).actions[0], GOAL_MENU_ACTIONS.resume);
	}

	const limited = runtime(transitionGoal({ ...active, tokensUsed: 100 }, "budget_limited"));
	assert.equal(buildGoalMenuState(limited).actions[0], GOAL_MENU_ACTIONS.increaseBudget);

	const frozen = runtime(active);
	frozen.queueFrozen = true;
	frozen.queuedGoals.push(createGoal("later", undefined, 0));
	assert.deepEqual(buildGoalMenuState(frozen).actions, [
		GOAL_MENU_ACTIONS.status,
		GOAL_MENU_ACTIONS.settings,
		GOAL_MENU_ACTIONS.help,
		GOAL_MENU_ACTIONS.clear,
		GOAL_MENU_ACTIONS.close,
	]);
});

test("safeGoalMenuText strips terminal controls and bounds untrusted previews", () => {
	const safe = safeGoalMenuText(`hello\u001b[31m\u009bworld\n${"界".repeat(200)}`);
	assert.equal(
		[...safe].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
		}),
		false,
	);
	assert.match(safe, /…$/u);
	assert.ok([...safe].length <= 121);
});

test("showGoalManager preserves non-TUI status behavior", async () => {
	const tracked = commands();
	const context = createMockContext({ mode: "print", hasUI: false });
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	await showGoalManager(runtime(), tracked.controller as never, context.ctx, async () => undefined);
	assert.deepEqual(
		tracked.calls.map((call) => call.name),
		["showGoal"],
	);
});

test("Goal Command Dialog keeps title, selection, and Escape reachable at very low height", async () => {
	const mock = createMockPi();
	const state = { ...runtime(), pi: mock.pi };
	state.settings.experimental.goals = true;
	let rendered = "";
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		terminalRows: 6,
		select: async (title: string) => {
			rendered = title;
			return undefined;
		},
	});

	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	await showGoalManager(state, commands().controller as never, context.ctx, async () => undefined);
	const lines = rendered.split("\n");
	assert.equal(lines.length, 3);
	assert.match(rendered, /Goal/);
	assert.match(rendered, /Start a goal/);
	assert.match(lines.at(-1) ?? "", /Esc close/);
});

test("menu cancellation has no side effects and clear requires an exact preview", async () => {
	const goal = createGoal("clear this objective", undefined, 0);
	const state = runtime(goal);
	state.queuedGoals.push(createGoal("queued objective", undefined, 0));
	const tracked = commands();
	let selects = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => (++selects === 1 ? GOAL_MENU_ACTIONS.clear : undefined),
		confirm: async (title: string, message: string) => {
			assert.equal(title, "Clear goal queue?");
			assert.match(message, /clear this objective/);
			assert.match(message, /queued objective/);
			return false;
		},
	});

	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);
	assert.equal(tracked.calls.length, 0);
});

test("caller interruption closes a nested interactive wait without invoking a Goal action", async () => {
	const state = runtime(createGoal("keep this objective", undefined, 0));
	const tracked = commands();
	const caller = new AbortController();
	const opened = Promise.withResolvers<AbortSignal>();
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => GOAL_MENU_ACTIONS.clear,
		confirm: async (_title, _message, dialogOptions) => {
			const signal = dialogOptions?.signal;
			assert.ok(signal);
			opened.resolve(signal);
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
			return true;
		},
	});

	// SAFETY: this test double supplies every GoalCommandController member exercised by the menu.
	const running = Effect.runPromiseExit(
		showGoalManagerEffect(state, tracked.controller as never, context.ctx, () => Effect.void),
		{ signal: caller.signal },
	);
	const menuSignal = await opened.promise;
	caller.abort(new DOMException("caller cancelled", "AbortError"));
	const exit = await running;

	assert.equal(menuSignal.aborted, true);
	assert.equal(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause), true);
	assert.equal(tracked.calls.length, 0);
});

test("a stale menu generation cannot invoke the selected Goal action", async () => {
	const state = { ...runtime(), menuGeneration: 0 };
	const tracked = commands();
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => {
			state.menuGeneration += 1;
			return GOAL_MENU_ACTIONS.start;
		},
	});

	// SAFETY: this test double supplies every GoalCommandController member exercised by the menu.
	await Effect.runPromise(showGoalManagerEffect(state, tracked.controller as never, context.ctx, () => Effect.void));

	assert.equal(tracked.calls.length, 0);
});

test("clear confirmation does not erase a queue that changed while open", async () => {
	const state = runtime(createGoal("previewed objective", undefined, 0));
	const tracked = commands();
	const selections = [GOAL_MENU_ACTIONS.clear, undefined];
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => selections.shift(),
		confirm: async () => {
			state.activeGoal = createGoal("replacement objective", undefined, 0);
			return true;
		},
	});

	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

	assert.equal(
		tracked.calls.some((call) => call.name === "clearGoal"),
		false,
	);
	assert.match(context.notifications.at(-1)?.message ?? "", /goal queue changed.*reopen/i);
});

test("clear preview includes a pending priority objective", async () => {
	const state = runtime(createGoal("current objective", undefined, 0));
	state.queuedGoals.push(createGoal("queued objective", undefined, 0));
	state.pendingQueueAction = { kind: "prioritize", objective: "pending urgent objective" };
	const tracked = commands();
	const selections = [GOAL_MENU_ACTIONS.clear, undefined];
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => selections.shift(),
		confirm: async (title: string, message: string) => {
			assert.equal(title, "Clear goal queue?");
			assert.match(message, /all 3 goals/i);
			assert.match(message, /current objective/);
			assert.match(message, /queued objective/);
			assert.match(message, /pending urgent objective/);
			return false;
		},
	});

	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);
	assert.equal(tracked.calls.length, 0);
});

test("menu preserves exact token values in status and budget input", async () => {
	const goal = transitionGoal(createGoal("precise budget", 10_500, 0), "budget_limited");
	goal.tokensUsed = 10_499;
	const state = runtime(goal);
	assert.match(buildGoalMenuState(state).title, /10499\/10500/);
	let placeholder = "";
	const tracked = commands();
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => GOAL_MENU_ACTIONS.increaseBudget,
		input: async (_title: string, value: string) => {
			placeholder = value;
			return undefined;
		},
	});
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);
	assert.equal(placeholder, "10500");
	assert.equal(tracked.calls.length, 0);
});

test("Queue Back returns to the refreshed main menu", async () => {
	const state = runtime(createGoal("current objective", undefined, 0));
	state.settings.experimental.goals = true;
	const tracked = commands();
	const selections = [GOAL_MENU_ACTIONS.queue, "Back", GOAL_MENU_ACTIONS.close];
	let selectionCount = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => {
			selectionCount++;
			return selections.shift();
		},
	});

	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);
	assert.equal(selectionCount, 3);
	assert.equal(tracked.calls.length, 0);
});

test("queue menu previews prioritize, skip, and drop-last before delegation", async () => {
	for (const scenario of [
		{
			action: "Prioritize goal…",
			method: "prioritizeGoal",
			editor: "urgent objective",
			preview: /urgent objective.*current objective/is,
		},
		{
			action: "Skip current goal…",
			method: "skipGoal",
			preview: /current objective.*queued objective/is,
		},
		{
			action: "Drop last goal…",
			method: "dropLastGoal",
			preview: /queued objective/is,
		},
	] as const) {
		const state = runtime(createGoal("current objective", undefined, 0));
		state.settings.experimental.goals = true;
		state.queuedGoals.push(createGoal("queued objective", undefined, 0));
		const tracked = commands();
		const selections = [GOAL_MENU_ACTIONS.queue, scenario.action];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			select: async () => selections.shift(),
			editor: async () => scenario.editor,
			confirm: async (_title: string, message: string) => {
				assert.match(message, scenario.preview);
				return true;
			},
		});

		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);
		assert.equal(tracked.calls[0]?.name, scenario.method);
	}
});

test("Skip preview reflects a stopped next goal without promising activation", async () => {
	const state = runtime(createGoal("current objective", undefined, 0));
	state.settings.experimental.goals = true;
	state.queuedGoals.push(transitionGoal(createGoal("blocked objective", undefined, 0), "blocked"));
	const tracked = commands();
	const selections = [GOAL_MENU_ACTIONS.queue, "Skip current goal…"];
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => selections.shift(),
		confirm: async (_title: string, message: string) => {
			assert.match(message, /Next goal remains blocked/i);
			assert.doesNotMatch(message, /Start next goal/i);
			return false;
		},
	});

	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);
	assert.equal(tracked.calls.length, 0);
});

test("queue confirmations do not mutate a changed active head or queue selection", async () => {
	for (const scenario of [
		{
			action: "Prioritize goal…",
			expectedMethod: "prioritizeGoal",
			editor: "urgent objective",
			mutate(state: ReturnType<typeof runtime>) {
				state.activeGoal = createGoal("replacement head", undefined, 0);
			},
		},
		{
			action: "Skip current goal…",
			expectedMethod: "skipGoal",
			mutate(state: ReturnType<typeof runtime>) {
				state.activeGoal = createGoal("replacement head", undefined, 0);
			},
		},
		{
			action: "Skip current goal…",
			expectedMethod: "skipGoal",
			mutate(state: ReturnType<typeof runtime>) {
				state.queuedGoals = [createGoal("replacement successor", undefined, 0)];
			},
		},
		{
			action: "Drop last goal…",
			expectedMethod: "dropLastGoal",
			mutate(state: ReturnType<typeof runtime>) {
				state.queuedGoals = [createGoal("replacement tail", undefined, 0)];
			},
		},
	] as const) {
		const state = runtime(createGoal("current objective", undefined, 0));
		state.settings.experimental.goals = true;
		state.queuedGoals = [createGoal("queued objective", undefined, 0)];
		const tracked = commands();
		const selections = [GOAL_MENU_ACTIONS.queue, scenario.action];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			select: async () => selections.shift(),
			editor: async () => ("editor" in scenario ? scenario.editor : undefined),
			confirm: async () => {
				scenario.mutate(state);
				return true;
			},
		});

		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

		assert.equal(
			tracked.calls.some((call) => call.name === scenario.expectedMethod),
			false,
		);
		assert.match(context.notifications.at(-1)?.message ?? "", /goal queue changed.*reopen/i);
	}
});

test("main-menu pause and resume do not mutate a replacement goal", async () => {
	for (const scenario of [
		{ action: GOAL_MENU_ACTIONS.pause, status: "active" as const, method: "pauseGoal" },
		{ action: GOAL_MENU_ACTIONS.resume, status: "paused" as const, method: "resumeGoal" },
	]) {
		const displayed = transitionGoal(createGoal("displayed objective", undefined, 0), scenario.status);
		const state = runtime(displayed);
		const tracked = commands();
		const selections = [scenario.action, GOAL_MENU_ACTIONS.close];
		const context = createMockContext({
			mode: "tui",
			hasUI: true,
			select: async () => {
				const selected = selections.shift();
				if (selected === scenario.action) {
					state.activeGoal = transitionGoal(createGoal("replacement objective", undefined, 0), scenario.status);
				}
				return selected;
			},
		});

		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

		assert.equal(
			tracked.calls.some((call) => call.name === scenario.method),
			false,
		);
		assert.match(context.notifications.at(-1)?.message ?? "", /active goal changed.*reopen/i);
	}
});

test("edit dialogs do not mutate a replacement active goal", async () => {
	const original = createGoal("old objective", undefined, 0);
	const replacement = createGoal("replacement objective", undefined, 0);
	const state = runtime(original);
	const tracked = commands();
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => GOAL_MENU_ACTIONS.edit,
		editor: async () => {
			state.activeGoal = replacement;
			return "edited old objective";
		},
		confirm: async () => true,
	});

	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

	assert.equal(tracked.calls.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /goal changed.*reopen/i);
});

test("budget dialogs do not mutate a replacement active goal", async () => {
	const original = transitionGoal(createGoal("old objective", 100, 0), "budget_limited");
	original.tokensUsed = 100;
	const replacement = createGoal("replacement objective", undefined, 0);
	const state = runtime(original);
	const tracked = commands();
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => GOAL_MENU_ACTIONS.increaseBudget,
		input: async () => {
			state.activeGoal = replacement;
			return "200";
		},
		confirm: async () => true,
	});

	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	await showGoalManager(state, tracked.controller as never, context.ctx, async () => undefined);

	assert.equal(tracked.calls.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /goal changed.*reopen/i);
});

test("menu start and edit delegate raw objective data only after explicit input", async () => {
	const empty = runtime();
	const started = commands();
	const startContext = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => GOAL_MENU_ACTIONS.start,
		editor: async () => "  implement menu  ",
	});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	await showGoalManager(empty, started.controller as never, startContext.ctx, async () => undefined);
	assert.equal(started.calls[0]?.name, "startGoal");
	assert.deepEqual(started.calls[0]?.args.slice(0, 2), ["implement menu", undefined]);

	const active = runtime(createGoal("old objective", undefined, 0));
	const edited = commands();
	const editContext = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async () => GOAL_MENU_ACTIONS.edit,
		editor: async () => "new objective",
		confirm: async (title: string, message: string) => {
			assert.equal(title, "Apply goal edit?");
			assert.match(message, /old objective/);
			assert.match(message, /new objective/);
			return true;
		},
	});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	await showGoalManager(active, edited.controller as never, editContext.ctx, async () => undefined);
	assert.equal(edited.calls[0]?.name, "editGoal");
	assert.deepEqual(edited.calls[0]?.args.slice(0, 2), ["new objective", undefined]);
});
