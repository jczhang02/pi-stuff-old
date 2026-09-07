import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	assistantUsageEntry,
	type BlockedToolParameters,
	type CompletionToolParameters,
	completionReport,
	createGoalHarness,
	createMockContext,
	createMockPi,
	GOAL_SETTINGS_DIRECTORY,
	goalStateData,
	hasDirectUserActivation,
	INVALID_SETTINGS_PATH,
	isRuntimeFunction,
	lastGoalStatus,
	MISSING_SETTINGS_PATH,
	readAgentWorkOrigin,
	registerGoal,
	registerGoalWithSettingsPath,
	requireGoalTool,
	requireLastGoal,
	restoreGoalForTest,
	runtimeByPi,
	type StoredGoal,
	startGoalForTest,
} from "../../goal-upstream/goal-test-support.js";

test("goal registers command, status tools, and lifecycle hooks", async () => {
	// Production leaves extension tools active until session_start; factory registration
	// itself does not call setActiveTools (actions may still be unbound).
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoal(mock.pi);

	assert.ok(mock.commands.has("goal"));
	assert.equal(isRuntimeFunction(mock.commands.get("goal")?.getArgumentCompletions), true);
	assert.deepEqual(
		mock.tools.map((tool) => tool.name),
		["goal_complete", "goal_blocked"],
	);
	for (const tool of mock.tools) {
		assert.equal(tool.renderShell, "self");
		assert.equal(isRuntimeFunction(tool.renderCall), true);
		assert.equal(isRuntimeFunction(tool.renderResult), true);
	}
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);
	const context = createMockContext();
	await mock.callEvent("session_start", {}, context.ctx);
	// Default settings keep goal tools active for a stable schema.
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);
	// SAFETY: Goal owns this registered schema, and the test reads only the completion fields declared by that Tool.
	const completionParameters = mock.tools.find((tool) => tool.name === "goal_complete")?.parameters as
		| CompletionToolParameters
		| undefined;
	assert.deepEqual(completionParameters?.required, ["goal_id", "summary", "evidence"]);
	assert.ok(completionParameters?.properties?.goal_id);
	assert.ok(completionParameters?.properties?.evidence);
	const blockerDefinition = mock.tools.find((tool) => tool.name === "goal_blocked");
	// SAFETY: Goal owns this registered schema, and the test reads only the blocker limits declared by that Tool.
	const blockedParameters = blockerDefinition?.parameters as BlockedToolParameters | undefined;
	assert.deepEqual(blockedParameters?.required, ["goal_id", "reason", "attempt", "evidence", "repeated_turns"]);
	assert.equal(blockedParameters?.properties?.reason?.minLength, 1);
	assert.equal(blockedParameters?.properties?.reason?.maxLength, 1_000);
	assert.equal(blockedParameters?.properties?.evidence?.minLength, 1);
	assert.equal(blockedParameters?.properties?.evidence?.maxLength, 4_000);
	assert.equal(blockedParameters?.properties?.repeated_turns?.minimum, 1);
	assert.match(String(blockerDefinition?.description), /three distinct failed actions.*same blocker/i);
	assert.match(
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		String((blockerDefinition?.promptGuidelines as string[] | undefined)?.join(" ")),
		/fresh three-turn blocker audit/i,
	);
	assert.deepEqual([...mock.events.keys()].sort(), [
		"agent_end",
		"agent_settled",
		"agent_start",
		"before_agent_start",
		"context",
		"input",
		"message_start",
		"session_before_compact",
		"session_compact",
		"session_compact_failed",
		"session_shutdown",
		"session_start",
		"tool_call",
		"tool_execution_end",
		"turn_end",
		"turn_start",
	]);
});

test("goal command attributes its hidden Agent prompt to the user", async () => {
	const [mock, context] = await createGoalHarness(["goal_complete", "goal_blocked"]);
	await mock.commands.get("goal")?.handler("finish the work", context.ctx);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	assert.equal(readAgentWorkOrigin(mock.sentHiddenGoalMessages.at(-1)?.message as { details?: unknown }), "user");
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	assert.equal(hasDirectUserActivation(mock.sentHiddenGoalMessages.at(-1)?.message as object), true);

	await mock.commands.get("goal")?.handler("status", context.ctx);
	assert.equal(mock.sentHiddenGoalMessages.length, 1);
});

test("TUI Goal lifecycle info uses the shared transcript row while RPC stays plain", async () => {
	const tui = await startGoalForTest({ hasUI: true, mode: "tui" }, "first objective");
	await tui.mock.commands.get("goal")?.handler("second objective", tui.ctx);
	await tui.mock.commands.get("goal")?.handler("pause", tui.ctx);
	await tui.mock.commands.get("goal")?.handler("resume", tui.ctx);
	await tui.mock.commands.get("goal")?.handler("edit final objective", tui.ctx);

	assert.deepEqual(
		tui.notifications
			.map(({ message }) => message)
			.filter((message) => /^• Goal (?:started|replaced|resumed|updated)/u.test(message)),
		[
			"• Goal started · first objective",
			"• Goal replaced · second objective",
			"• Goal resumed from paused · second objective",
			"• Goal updated · final objective",
		],
	);

	const rpc = await startGoalForTest({ hasUI: true, mode: "rpc" }, "RPC objective");
	assert.equal(rpc.notifications.at(-1)?.message, "Goal started: RPC objective");
});

test("bare goal is menu-first in TUI, observable in RPC, and rejects headless modes", async () => {
	const selections: Array<{ title: string; actions: string[] }> = [];
	const [mock, tui] = await createGoalHarness(["goal_complete", "goal_blocked"], "always", {
		mode: "tui",
		hasUI: true,
		select: async (title: string, actions: string[]) => {
			selections.push({ title, actions });
			return undefined;
		},
	});

	await mock.commands.get("goal")?.handler("", tui.ctx);
	assert.equal(selections.length, 1);
	assert.match(selections[0]?.title ?? "", /^━+\n {2}Goal\n {2}No goal is currently set/im);
	assert.ok(selections[0]?.actions.includes("Start a goal…"));
	assert.equal(tui.notifications.length, 0);

	await mock.commands.get("goal")?.handler("status", tui.ctx);
	assert.equal(selections.length, 1);
	assert.match(tui.notifications.at(-1)?.message ?? "", /No goal is currently set/i);

	const rpc = createMockContext({ mode: "rpc", hasUI: true });
	await mock.commands.get("goal")?.handler("status", rpc.ctx);
	assert.match(rpc.notifications.at(-1)?.message ?? "", /No goal is currently set/i);

	let printSelections = 0;
	const print = createMockContext({
		mode: "print",
		hasUI: false,
		select: async () => {
			printSelections++;
			return undefined;
		},
	});
	await assert.rejects(
		// SAFETY: this test controls the value and supplies every Promise member exercised by this case.
		mock.commands.get("goal")?.handler("", print.ctx) as Promise<unknown>,
		/\/goal status is unavailable in print mode/i,
	);
	assert.equal(printSelections, 0);
	assert.equal(print.notifications.length, 0);

	const json = createMockContext({ mode: "json", hasUI: false });
	await assert.rejects(
		// SAFETY: this test controls the value and supplies every Promise member exercised by this case.
		mock.commands.get("goal")?.handler("status", json.ctx) as Promise<unknown>,
		/\/goal status is unavailable in json mode/i,
	);
});

test("session start uses defaults without materializing missing settings", async () => {
	const parent = join(GOAL_SETTINGS_DIRECTORY, "session-missing");
	const settingsPath = join(parent, "pi-goal.json");
	const mock = createMockPi({
		activeTools: ["read", "bash", "goal_complete", "goal_blocked"],
	});
	registerGoalWithSettingsPath(mock.pi, settingsPath);
	const context = createMockContext();

	await mock.callEvent("session_start", {}, context.ctx);
	await mock.callEvent("session_start", {}, context.ctx);

	assert.equal(existsSync(parent), false);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);
	assert.equal(context.notifications.length, 0);
});

test("session restore stays read-only until the next agent turn begins", async () => {
	const restoredGoal: StoredGoal = {
		id: "read-only-session-restore",
		text: "resume without mutating the session during startup",
		status: "active",
		startedAt: 1,
		updatedAt: 2,
		iteration: 3,
		tokensUsed: 5,
		timeUsedSeconds: 4,
		baselineTokens: 0,
	};
	const branch = [
		{
			type: "custom",
			customType: "goal-state",
			data: { goal: restoredGoal },
		},
	];
	const mock = createMockPi();
	registerGoal(mock.pi);
	const context = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});

	await mock.callEvent("session_start", {}, context.ctx);

	assert.equal(mock.entries.length, 0, "opening a session must not append Goal state");
	assert.equal(runtimeByPi.get(mock.pi)?.activeGoal?.id, restoredGoal.id);

	await mock.callEvent("before_agent_start", { prompt: "Continue the task." }, context.ctx);

	assert.equal(mock.entries.length, 1, "the first real turn must flush the restored Goal snapshot");
	assert.equal(mock.entries[0]?.customType, "goal-state");
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	assert.equal(goalStateData(mock.entries[0]?.data).goal?.id, restoredGoal.id);
});

test("missing and invalid settings fall back to always-visible tools", async () => {
	for (const [settingsPath, expectsWarning] of [
		[MISSING_SETTINGS_PATH, false],
		[INVALID_SETTINGS_PATH, true],
	] as const) {
		const mock = createMockPi({
			activeTools: ["read", "bash", "goal_complete", "goal_blocked"],
		});
		registerGoalWithSettingsPath(mock.pi, settingsPath);
		const context = createMockContext();
		await mock.callEvent("session_start", {}, context.ctx);

		assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);
		assert.equal(
			context.notifications.some((notice) => /settings ignored/.test(notice.message)),
			expectsWarning,
		);
	}
});

test("invalid settings remain read-only in the Goal settings UI", async () => {
	const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked"] });
	registerGoalWithSettingsPath(mock.pi, INVALID_SETTINGS_PATH);
	const selections = ["Settings…", undefined, "Close"];
	let settingsRender = "";
	const context = createMockContext({
		mode: "tui",
		hasUI: true,
		select: async (title: string) => {
			if (/Read only/i.test(title)) settingsRender = title;
			return selections.shift();
		},
	});
	await mock.callEvent("session_start", {}, context.ctx);

	await mock.commands.get("goal")?.handler("", context.ctx);

	assert.match(settingsRender, /Read only/i);
	assert.match(settingsRender, /invalid settings file/i);
	assert.match(settingsRender, /using built-in defaults/i);
	assert.equal(readFileSync(INVALID_SETTINGS_PATH, "utf8"), '{"goal":{"toolVisibility":"sometimes"}}\n');
});

test("after-first-goal hides tools until activation, then keeps them visible", async () => {
	const [mock, context] = await createGoalHarness(
		["read", "bash", "goal_complete", "goal_blocked"],
		"after-first-goal",
	);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);

	await mock.commands.get("goal")?.handler("finish the work", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);

	// Permanent unlock: complete/clear must not re-hide (stable tool set within runtime).
	const started = requireLastGoal(mock);
	const complete = requireGoalTool(mock, "goal_complete");
	await complete.execute(
		"complete-1",
		completionReport(started.id, "Verified every requirement against current evidence."),
		new AbortController().signal,
		() => undefined,
		context.ctx,
	);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);

	await mock.commands.get("goal")?.handler("clear", context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);

	// Same-runtime empty session_start keeps the sticky unlock policy.
	await mock.callEvent("session_start", {}, context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);
});

test("switching from locked lazy visibility to always restores tools hidden by pi-goal", async () => {
	const settingsPath = join(GOAL_SETTINGS_DIRECTORY, "visibility-reload.json");
	writeFileSync(settingsPath, '{"goal":{"toolVisibility":"after-first-goal"}}\n');
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoalWithSettingsPath(mock.pi, settingsPath);
	const context = createMockContext();

	await mock.callEvent("session_start", {}, context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);

	writeFileSync(settingsPath, '{"goal":{"toolVisibility":"always"}}\n');
	await mock.callEvent("session_start", {}, context.ctx);

	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);
});

test("always mode restores only the exact goal tools hidden by lazy mode", async () => {
	const settingsPath = join(GOAL_SETTINGS_DIRECTORY, "visibility-partial-reload.json");
	writeFileSync(settingsPath, '{"goal":{"toolVisibility":"after-first-goal"}}\n');
	const mock = createMockPi({ activeTools: ["read", "goal_complete", "goal_blocked"] });
	registerGoalWithSettingsPath(mock.pi, settingsPath);
	mock.rawPi.setActiveTools(["read", "goal_complete"]);
	const context = createMockContext();

	await mock.callEvent("session_start", {}, context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read"]);
	writeFileSync(settingsPath, '{"goal":{"toolVisibility":"always"}}\n');
	await mock.callEvent("session_start", {}, context.ctx);

	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "goal_complete"]);
});

test("switching from always to lazy visibility locks a runtime without an unfinished goal", async () => {
	const settingsPath = join(GOAL_SETTINGS_DIRECTORY, "visibility-lock-reload.json");
	writeFileSync(settingsPath, '{"goal":{"toolVisibility":"always"}}\n');
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoalWithSettingsPath(mock.pi, settingsPath);
	const context = createMockContext();
	await mock.callEvent("session_start", {}, context.ctx);

	writeFileSync(settingsPath, '{"goal":{"toolVisibility":"after-first-goal"}}\n');
	await mock.callEvent("session_start", {}, context.ctx);

	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
});

test("failed always-mode restoration preserves the restrictive set and retries later", async () => {
	const settingsPath = join(GOAL_SETTINGS_DIRECTORY, "visibility-reload-retry.json");
	writeFileSync(settingsPath, '{"goal":{"toolVisibility":"after-first-goal"}}\n');
	const mock = createMockPi({ activeTools: ["read", "bash", "goal_complete", "goal_blocked"] });
	registerGoalWithSettingsPath(mock.pi, settingsPath);
	const context = createMockContext();
	await mock.callEvent("session_start", {}, context.ctx);
	writeFileSync(settingsPath, '{"goal":{"toolVisibility":"always"}}\n');

	const originalSetActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
	mock.rawPi.setActiveTools = (names: string[]) => {
		originalSetActiveTools(names.filter((name) => name !== "goal_blocked"));
	};
	await mock.callEvent("session_start", {}, context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
	assert.match(context.notifications.at(-1)?.message ?? "", /Could not restore.*goal tools/i);

	mock.rawPi.setActiveTools = originalSetActiveTools;
	await mock.callEvent("session_start", {}, context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);
});

test("restoring an unfinished goal unlocks goal tools on session_start", async () => {
	for (const status of ["active", "paused", "blocked", "usage_limited", "budget_limited"] as const) {
		const { mock } = await restoreGoalForTest(status, {}, "after-first-goal");
		assert.deepEqual(
			mock.rawPi.getActiveTools(),
			["goal_complete", "goal_blocked"],
			`expected unlock for restored ${status} goal`,
		);
	}
});

test("lazy restore does not widen an earlier restrictive session-start policy", async () => {
	const sessionGoal: StoredGoal = {
		id: "restored-under-restriction",
		text: "restore without widening",
		status: "active",
		startedAt: 1,
		updatedAt: 2,
		iteration: 3,
		tokensUsed: 5,
		timeUsedSeconds: 4,
		baselineTokens: 0,
	};
	const branch = [
		{ type: "custom", customType: "goal-state", data: { goal: sessionGoal } },
		assistantUsageEntry({ totalTokens: 5 }),
	];
	const mock = createMockPi();
	registerGoal(mock.pi, "after-first-goal");
	// Simulate an earlier session_start handler restoring Plan mode's saved tool set.
	mock.rawPi.setActiveTools(["read", "bash"]);
	let aborts = 0;
	const context = createMockContext({
		abort: () => aborts++,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});

	await mock.callEvent("session_start", {}, context.ctx);

	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
	assert.equal(lastGoalStatus(mock), "paused");
	assert.equal(aborts, 0);
	mock.callEvent(
		"input",
		{ source: "extension", text: "startup follow-up", streamingBehavior: undefined },
		context.ctx,
	);
	assert.equal(
		mock.callEvent("tool_call", { toolName: "read", toolCallId: "startup-extension-read", input: {} }, context.ctx),
		undefined,
	);
	assert.match(context.notifications.at(-1)?.message ?? "", /goal tools.*paused/i);
});
