import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { GoalCommandController } from "../../../packages/pi-stuff/src/goal/src/commands.js";
import { createGoal, GoalRuntime } from "../../../packages/pi-stuff/src/goal/src/runtime.js";
import { DEFAULT_GOAL_SETTINGS, type GoalSettings } from "../../../packages/pi-stuff/src/goal/src/settings.js";
import {
	applyGoalSettings,
	formatGoalLimit,
	parseGoalLimit,
	showGoalSettings as showGoalSettingsEffect,
} from "../../../packages/pi-stuff/src/goal/src/settings-ui.js";
import { isRuntimeNumber } from "../../../packages/pi-stuff/src/shared/runtime-type.js";
import { createMockContext, createMockPi } from "../../goal-upstream/support.js";

initTheme("dark", false);

function showGoalSettings(...args: Parameters<typeof showGoalSettingsEffect>): Promise<void> {
	return Effect.runPromise(showGoalSettingsEffect(...args));
}

function applySettings(...args: Parameters<typeof applyGoalSettings>): Promise<void> {
	return Effect.runPromise(applyGoalSettings(...args));
}

function runtime() {
	const mock = createMockPi({ activeTools: ["read"] });
	// SAFETY: this test controls the value and supplies every GoalRuntime member exercised by this case.
	const state = new GoalRuntime(mock.pi) as GoalRuntime & {
		readonly visibility: ReturnType<GoalRuntime["snapshotGoalToolVisibility"]>;
	};
	state.settings = structuredClone(DEFAULT_GOAL_SETTINGS);
	state.goalToolsHiddenByPolicy.add("goal_complete");
	state.goalToolsHiddenByPolicy.add("goal_blocked");
	Object.defineProperty(state, "visibility", {
		get: () => state.snapshotGoalToolVisibility(),
	});
	return state;
}

test("goal setting custom limits accept only safe whole numbers greater than zero", () => {
	assert.equal(parseGoalLimit("40"), 40);
	assert.equal(parseGoalLimit(" 25 "), 25);
	for (const invalid of ["", "0", "-1", "1.5", "Unlimited", "off", "many", String(Number.MAX_SAFE_INTEGER + 1)]) {
		assert.equal(parseGoalLimit(invalid), undefined);
	}
	assert.equal(formatGoalLimit(25), "25");
	assert.equal(formatGoalLimit(null), "Unlimited");
});

test("applyGoalSettings saves before committing runtime settings and enforces lower limits", async () => {
	const state = runtime();
	let saved: GoalSettings | undefined;
	let enforced = 0;
	state.enforceAutomaticTurnLimit = () => {
		enforced++;
		return false;
	};
	const next: GoalSettings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		continuationLimits: { automaticTurns: 10, noProgressTurns: 2 },
	};
	const context = createMockContext();

	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	await applySettings(state as never, next, context.ctx, {
		save(settings: GoalSettings) {
			saved = structuredClone(settings);
			return Effect.void;
		},
	});

	assert.deepEqual(saved, next);
	assert.deepEqual(state.settings, next);
	assert.equal(enforced, 1);
});

test("applyGoalSettings restores effective tool policy when persistence fails", async () => {
	const state = runtime();
	const before = structuredClone(state.visibility);
	const next: GoalSettings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		toolVisibility: "always",
	};
	const context = createMockContext();

	await assert.rejects(
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		applySettings(state as never, next, context.ctx, {
			save() {
				return Effect.fail(new Error("disk full"));
			},
		}),
		/disk full/,
	);
	assert.deepEqual(state.settings, DEFAULT_GOAL_SETTINGS);
	assert.deepEqual(state.visibility, before);
});

test("applyGoalSettings rolls back file and effective state after runtime application fails", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	const previous = structuredClone(state.settings);
	const next = { ...structuredClone(previous), experimental: { goals: false } };
	const saved: GoalSettings[] = [];
	let persistCalls = 0;
	state.persistGoal = () => {
		persistCalls++;
		if (persistCalls === 1) throw new Error("stale context");
	};
	const context = createMockContext({ mode: "tui", hasUI: true });

	await assert.rejects(
		applySettings(state, next, context.ctx, {
			save(settings) {
				saved.push(structuredClone(settings));
				return Effect.void;
			},
		}),
		/stale context/,
	);
	assert.deepEqual(saved, [next, previous]);
	assert.deepEqual(state.settings, previous);
	assert.equal(state.queueFrozen, false);
	assert.equal(state.activeGoal?.status, "active");
});

test("disabling a retained queue pauses and aborts in-flight Goal work", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.prompts.requestContinuation(state.activeGoal);
	state.beginAgentRun(state.activeGoal.id, "automatic");
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = { ...structuredClone(state.settings), experimental: { goals: false } };

	await applySettings(state, next, context.ctx, { save: () => Effect.void });

	assert.equal(aborts, 1);
	assert.equal(state.queueFrozen, true);
	assert.equal(state.activeGoal?.status, "active");
	assert.equal(state.activeGoal?.activeStartedAt, undefined);
	assert.equal(state.snapshotSettingsApplicationState().promptOwnership.continuationIntent, undefined);
	assert.equal(state.staleGoalToolCallsBlocked, true);
});

test("freezing a queue preserves an unrelated in-flight run", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.beginAgentRun(null, undefined);
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = { ...structuredClone(state.settings), experimental: { goals: false } };

	await applySettings(state, next, context.ctx, { save: () => Effect.void });

	assert.equal(aborts, 0);
	assert.equal(state.queueFrozen, true);
	assert.equal(state.agentRunGoalId, null);
	assert.equal(state.activeGoal?.activeStartedAt, undefined);
	assert.equal(state.guardAbortGoalId, undefined);
	assert.equal(state.queueFreezeAwaitingSettle, false);
	assert.equal(state.staleGoalToolCallsBlocked, false);
});

test("revealing lazy Goal tools rejects a busy unrelated run", async () => {
	const state = runtime();
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		toolVisibility: "after-first-goal",
	};
	const before = structuredClone(state.visibility);
	const next = { ...structuredClone(state.settings), toolVisibility: "always" as const };
	let saves = 0;
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => false });

	await assert.rejects(
		applySettings(state, next, context.ctx, {
			save() {
				saves++;
				return Effect.void;
			},
		}),
		/wait for Pi to become idle/i,
	);
	assert.equal(saves, 0);
	assert.equal(state.settings.toolVisibility, "after-first-goal");
	assert.deepEqual(state.visibility, before);
});

test("hiding always-visible Goal tools rejects a busy unrelated run", async () => {
	const mock = createMockPi({ activeTools: ["read", "goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = structuredClone(DEFAULT_GOAL_SETTINGS);
	const before = state.snapshotGoalToolVisibility();
	const next = {
		...structuredClone(state.settings),
		toolVisibility: "after-first-goal" as const,
	};
	let saves = 0;
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => false });

	await assert.rejects(
		applySettings(state, next, context.ctx, {
			save() {
				saves++;
				return Effect.void;
			},
		}),
		/wait for Pi to become idle/i,
	);
	assert.equal(saves, 0);
	assert.equal(state.settings.toolVisibility, "always");
	assert.deepEqual(state.snapshotGoalToolVisibility(), before);
});

test("lowering the no-progress limit pauses and aborts in-flight Goal work", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 5 },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.activeGoal.toolFreeRepeatCount = 3;
	state.beginAgentRun(state.activeGoal.id, "automatic");
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = {
		...structuredClone(state.settings),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 3 },
	};

	await applySettings(state, next, context.ctx, { save: () => Effect.void });

	assert.equal(aborts, 1);
	assert.equal(state.activeGoal?.status, "paused");
	assert.equal(state.activeGoal?.safetyPauseCause, "no_progress");
});

test("lowering a reached limit preserves an unrelated in-flight run", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 5 },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.activeGoal.toolFreeRepeatCount = 3;
	state.beginAgentRun(null, undefined);
	let aborts = 0;
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		abort: () => aborts++,
	});
	const next = {
		...structuredClone(state.settings),
		continuationLimits: { automaticTurns: 25, noProgressTurns: 3 },
	};

	await applySettings(state, next, context.ctx, { save: () => Effect.void });

	assert.equal(aborts, 0);
	assert.equal(state.agentRunGoalId, null);
	assert.equal(state.activeGoal?.status, "paused");
	assert.equal(state.activeGoal?.safetyPauseCause, "no_progress");
});

test("replacement confirmation does not replace a goal that changed while open", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.activeGoal = createGoal("previewed objective", undefined, 0);
	const replacement = createGoal("replacement objective", undefined, 0);
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		confirm: async () => {
			state.activeGoal = replacement;
			return true;
		},
	});
	const controller = new GoalCommandController(state);

	await Effect.runPromise(controller.startGoal("new objective", undefined, context.ctx));

	assert.equal(state.activeGoal?.id, replacement.id);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /goal queue changed.*try again/i);
});

test("replacement confirmation sanitizes terminal controls without changing goal data", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.activeGoal = createGoal("current\u001b]8;;bad\u0007 objective", undefined, 0);
	state.queuedGoals = [createGoal("queued\u001b objective", undefined, 0)];
	let preview = "";
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		confirm: async (_title: string, message: string) => {
			preview = message;
			return false;
		},
	});
	const controller = new GoalCommandController(state);

	await Effect.runPromise(controller.startGoal("new\u009b31m objective", undefined, context.ctx));

	for (const control of ["\u0007", "\u001b", "\u009b"]) {
		assert.equal(preview.includes(control), false);
	}
	assert.match(preview, /Current goal: current ]8;;bad objective/);
	assert.match(preview, /Queued goals also removed:\n1\. queued objective/);
	assert.match(preview, /New goal: new 31m objective/);
	assert.equal(state.activeGoal?.text, "current\u001b]8;;bad\u0007 objective");
});

test("unfreezing waits for an aborted frozen run to settle before dispatching", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: false },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.beginAgentRun(state.activeGoal.id, "manual");
	state.queueFrozen = true;
	state.guardAbortGoalId = state.activeGoal.id;
	state.queueFreezeAwaitingSettle = true;
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => true });
	const enabled = { ...structuredClone(state.settings), experimental: { goals: true } };
	const controller = new GoalCommandController(state);

	await applySettings(state, enabled, context.ctx, { save: () => Effect.void });
	const dispatchedEarly = await Effect.runPromise(controller.resumeQueueAfterUnfreeze(context.ctx));

	assert.equal(dispatchedEarly, false);
	assert.equal(state.queueFrozen, true);
	assert.equal(state.guardAbortGoalId, state.activeGoal.id);
	assert.equal(mock.sentUserMessages.length, 0);

	state.clearSettledSafetyTracking();
	state.queueFreezeAwaitingSettle = false;
	const dispatchedAfterSettle = await Effect.runPromise(controller.resumeQueueAfterUnfreeze(context.ctx));

	assert.equal(dispatchedAfterSettle, true);
	assert.equal(state.queueFrozen, false);
	assert.equal(isRuntimeNumber(state.activeGoal?.activeStartedAt), true);
	assert.equal(mock.sentUserMessages.length, 1);
});

test("unfreezing an active retained queue dispatches Goal work immediately", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.queuedGoals = [createGoal("queued objective", undefined, 0)];
	state.queueFrozen = false;
	const controller = new GoalCommandController(state);
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => true });

	const dispatched = await Effect.runPromise(controller.resumeQueueAfterUnfreeze(context.ctx));

	assert.equal(dispatched, true);
	assert.equal(mock.sentUserMessages.length, 1);
	assert.match(mock.sentUserMessages[0]?.text ?? "", /Continue the active \/goal/i);
});

test("unfreezing a pending priority dispatches it at the idle boundary", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	const state = new GoalRuntime(mock.pi);
	state.settings = {
		...structuredClone(DEFAULT_GOAL_SETTINGS),
		experimental: { goals: true },
	};
	state.activeGoal = createGoal("current objective", undefined, 0);
	state.pendingQueueAction = { kind: "prioritize", objective: "urgent objective" };
	const controller = new GoalCommandController(state);
	const context = createMockContext({ mode: "tui", hasUI: true, isIdle: () => true });

	const dispatched = await Effect.runPromise(controller.resumeQueueAfterUnfreeze(context.ctx));

	assert.equal(dispatched, true);
	assert.equal(state.pendingQueueAction, undefined);
	assert.equal(state.activeGoal?.text, "urgent objective");
	assert.equal(mock.sentUserMessages.length, 1);
});

test("standard settings keep all five controls on one level", async () => {
	const state = runtime();
	let title = "";
	let options: string[] = [];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async (receivedTitle: string, receivedOptions: string[]) => {
			title = receivedTitle;
			options = receivedOptions;
			return undefined;
		},
	});
	await showGoalSettings(state, context.ctx, { settingsPath: "/tmp/pi-goal.json" });
	assert.match(title, /Pi Goal Settings/);
	assert.deepEqual(options, [
		"Automatic work",
		"No-progress guard",
		"Goal tools",
		"Ordered goal queue",
		"Managed run RPC",
	]);
});

test("Managed run RPC setting defaults off and saves immediately", async () => {
	const state = runtime();
	let saved: GoalSettings | undefined;
	const selections = ["Managed run RPC", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
	});

	assert.equal(state.settings.rpc.enabled, false);
	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save(settings) {
			saved = structuredClone(settings);
			return Effect.void;
		},
	});

	assert.equal(saved?.rpc.enabled, true);
	assert.equal(state.settings.rpc.enabled, true);
	assert.match(context.notifications.at(-1)?.message ?? "", /Managed run RPC: On/i);
});

test("Managed run RPC setting disables immediately", async () => {
	const state = runtime();
	state.settings = {
		...structuredClone(state.settings),
		rpc: { enabled: true },
	};
	let saved: GoalSettings | undefined;
	const selections = ["Managed run RPC", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save(settings) {
			saved = structuredClone(settings);
			return Effect.void;
		},
	});

	assert.equal(saved?.rpc.enabled, false);
	assert.equal(state.settings.rpc.enabled, false);
	assert.match(context.notifications.at(-1)?.message ?? "", /Managed run RPC: Off/i);
});

test("Managed run RPC setting rolls back when save fails", async () => {
	const state = runtime();
	const selections = ["Managed run RPC", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
	});

	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save() {
			return Effect.fail(new Error("disk full"));
		},
	});

	assert.equal(state.settings.rpc.enabled, false);
	assert.match(context.notifications.at(-1)?.message ?? "", /previous value remains/i);
});

test("standard Goal tools setting saves and applies immediately", async () => {
	const state = runtime();
	let saved: GoalSettings | undefined;
	const selections = ["Goal tools", undefined];
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
	});
	await showGoalSettings(state, context.ctx, {
		settingsPath: "/tmp/pi-goal.json",
		save(settings) {
			saved = structuredClone(settings);
			return Effect.void;
		},
	});
	assert.equal(saved?.toolVisibility, "after-first-goal");
	assert.equal(state.settings.toolVisibility, "after-first-goal");
});

test("invalid settings use a standard read-only detail screen", async () => {
	const state = runtime();
	state.settingsLoadIssue = { kind: "invalid", reason: "invalid settings shape" };
	let title = "";
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async (receivedTitle: string) => {
			title = receivedTitle;
			return undefined;
		},
	});
	await showGoalSettings(state, context.ctx, { settingsPath: "/tmp/pi-goal.json" });
	assert.match(title, /Read only/i);
	assert.match(title, /Invalid settings file/i);
	assert.match(title, /Automatic work: Unlimited/i);
	assert.match(title, /Managed run RPC: Off/i);
});

test("showGoalSettings uses an observable manual fallback outside TUI", async () => {
	const state = runtime();
	const context = createMockContext({ hasUI: true, mode: "rpc" });
	await showGoalSettings(state, context.ctx, { settingsPath: "/tmp/pi-goal.json" });
	assert.match(context.notifications.at(-1)?.message ?? "", /Edit pi-goal settings manually/);
});
