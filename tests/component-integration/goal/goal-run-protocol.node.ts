import assert from "node:assert/strict";
import test from "node:test";
import {
	assistantUsageEntry,
	bindSession,
	CANCEL_CHANNEL,
	cancelRun,
	completionReport,
	createRunHarness,
	DISABLED_SETTINGS_PATH,
	errors,
	flush,
	INVALID_SETTINGS_PATH,
	lastPersistedGoal,
	MISSING_SETTINGS_PATH,
	observeRun,
	primeBlockerAudit,
	type RunEvent,
	registerGoal,
	requireGoalTool,
	runEventChannel,
	START_CHANNEL,
	type StartRunOverrides,
	startRun,
	states,
} from "../../goal-upstream/goal-run-support.js";
import { createMockContext, createMockPi, goalStatusSnapshot } from "../../goal-upstream/support.js";

test("managed run RPC is disabled when settings are missing, invalid, or explicitly off", async () => {
	for (const [name, settingsPath] of [
		["missing", MISSING_SETTINGS_PATH],
		["invalid", INVALID_SETTINGS_PATH],
		["explicit", DISABLED_SETTINGS_PATH],
	] as const) {
		const [mock] = await createRunHarness(createMockContext(), settingsPath);
		const runId = `disabled-${name}`;
		const events = observeRun(mock, runId);

		startRun(mock, runId);
		await flush();

		assert.deepEqual(
			errors(events).map((event) => event.error.code),
			["RPC_DISABLED"],
		);
		assert.equal(states(events).length, 0);
		assert.equal(lastPersistedGoal(mock), undefined);
		assert.equal(mock.sentUserMessages.length, 0);
	}
});

test("start reports no active session before bind and after shutdown", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const beforeEvents = observeRun(mock, "before-session");
	startRun(mock, "before-session");
	await flush();
	assert.deepEqual(
		errors(beforeEvents).map((event) => event.error.code),
		["NO_ACTIVE_SESSION"],
	);

	const context = await bindSession(mock);
	mock.emitHostEvent("session_shutdown", {}, context.ctx);
	const afterEvents = observeRun(mock, "after-session");
	startRun(mock, "after-session");
	await flush();
	assert.deepEqual(
		errors(afterEvents).map((event) => event.error.code),
		["NO_ACTIVE_SESSION"],
	);
});

test("enabled start emits run-scoped active state and delivers kickoff", async () => {
	const [mock] = await createRunHarness();
	const events = observeRun(mock, "run-start");

	startRun(mock, "run-start", { objective: "  ship the feature  ", tokenBudget: 50_000 });
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);
	const active = states(events)[0];
	assert.ok(active?.goalId);
	assert.equal(active?.runId, "run-start");
	assert.equal(lastPersistedGoal(mock)?.text, "ship the feature");
	assert.equal(lastPersistedGoal(mock)?.tokenBudget, 50_000);
	assert.ok(mock.sentUserMessages.some((message) => /ship the feature/.test(message.text)));
});

test("unsafe or missing run ids are ignored without creating channel injection", async () => {
	const [mock] = await createRunHarness();
	for (const runId of ["", ":other-channel", "with space", "x".repeat(129)]) {
		startRun(mock, runId);
	}
	mock.eventBus.emit(START_CHANNEL, { objective: "missing run id" });
	await flush();

	assert.equal(lastPersistedGoal(mock), undefined);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("valid run ids receive structured request validation errors", async () => {
	const invalidPayloads: Array<{ runId: string; overrides: StartRunOverrides }> = [
		{ runId: "empty-objective", overrides: { objective: "" } },
		{ runId: "wrong-objective", overrides: { objective: 42 } },
		{ runId: "zero-budget", overrides: { tokenBudget: 0 } },
		{ runId: "fraction-budget", overrides: { tokenBudget: 1.5 } },
		{ runId: "string-budget", overrides: { tokenBudget: "100" } },
	];
	for (const { runId, overrides } of invalidPayloads) {
		const [mock] = await createRunHarness();
		const events = observeRun(mock, runId);
		startRun(mock, runId, overrides);
		await flush();
		assert.deepEqual(
			errors(events).map((event) => event.error.code),
			["INVALID_REQUEST"],
		);
		assert.equal(mock.sentUserMessages.length, 0);
	}
});

test("payload access failures are contained as invalid requests", async () => {
	const [mock] = await createRunHarness();
	const startEvents = observeRun(mock, "throwing-start");
	const throwingStart = {
		runId: "throwing-start",
		get objective(): string {
			throw new Error("objective accessor failed");
		},
	};

	mock.eventBus.emit(START_CHANNEL, throwingStart);
	await flush();

	assert.deepEqual(
		errors(startEvents).map((event) => event.error.code),
		["INVALID_REQUEST"],
	);
	assert.equal(lastPersistedGoal(mock), undefined);

	const revoked = Proxy.revocable({}, {});
	revoked.revoke();
	mock.eventBus.emit(START_CHANNEL, revoked.proxy);
	await flush();
	assert.equal(lastPersistedGoal(mock), undefined);

	const cancelEvents = observeRun(mock, "throwing-cancel");
	startRun(mock, "throwing-cancel");
	await flush();
	const throwingCancel = {
		runId: "throwing-cancel",
		get reason(): string {
			throw new Error("reason accessor failed");
		},
	};
	mock.eventBus.emit(CANCEL_CHANNEL, throwingCancel);
	await flush();

	assert.deepEqual(
		errors(cancelEvents).map((event) => event.error.code),
		["INVALID_REQUEST"],
	);
	assert.equal(lastPersistedGoal(mock)?.status, "active");
});

test("payload evaluation cannot revive a replaced session", async () => {
	const [mock, context] = await createRunHarness();
	const events = observeRun(mock, "session-changing-payload");
	const payload = {
		runId: "session-changing-payload",
		get objective() {
			mock.emitHostEvent("session_shutdown", {}, context.ctx);
			return "must not start after shutdown";
		},
	};

	mock.eventBus.emit(START_CHANNEL, payload);
	await flush();

	assert.deepEqual(
		errors(events).map((event) => event.error.code),
		["SUPERSEDED"],
	);
	assert.equal(lastPersistedGoal(mock), undefined);
	assert.equal(mock.sentUserMessages.length, 0);
});

test("start rejects a pre-existing manual goal without replacement confirmation", async () => {
	let confirmations = 0;
	const [mock, context] = await createRunHarness(
		createMockContext({
			confirm: async () => {
				confirmations++;
				return true;
			},
		}),
	);
	await mock.commands.get("goal")?.handler("manual goal", context.ctx);
	const manualGoal = lastPersistedGoal(mock);
	const events = observeRun(mock, "cannot-adopt");

	startRun(mock, "cannot-adopt");
	await flush();

	assert.deepEqual(
		errors(events).map((event) => event.error.code),
		["GOAL_ALREADY_EXISTS"],
	);
	assert.equal(lastPersistedGoal(mock)?.id, manualGoal?.id);
	assert.equal(confirmations, 0);
});

test("duplicate run ids are rejected without starting twice", async () => {
	const [mock] = await createRunHarness();
	const events = observeRun(mock, "duplicate-run");
	startRun(mock, "duplicate-run");
	await flush();

	startRun(mock, "duplicate-run", { objective: "second objective" });
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);
	assert.deepEqual(
		errors(events).map((event) => event.error.code),
		["RUN_ID_IN_USE"],
	);
	assert.equal(mock.sentUserMessages.length, 1);
});

test("cancel pauses only the matching managed run", async () => {
	let aborts = 0;
	const [mock] = await createRunHarness(createMockContext({ abort: () => aborts++ }));
	const events = observeRun(mock, "cancel-run");
	startRun(mock, "cancel-run");
	await flush();

	cancelRun(mock, "cancel-run", { reason: "parent cancelled" });
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "paused"],
	);
	assert.equal(states(events).at(-1)?.reason, "parent cancelled");
	assert.equal(lastPersistedGoal(mock)?.status, "paused");
	assert.equal(aborts, 1);
});

test("cancel during the first active event prevents kickoff delivery", async () => {
	const [mock] = await createRunHarness();
	const events = observeRun(mock, "cancel-before-kickoff");
	mock.eventBus.on(runEventChannel("cancel-before-kickoff"), (data) => {
		// SAFETY: this test controls the value and supplies every RunEvent member exercised by this case.
		const event = data as RunEvent;
		if (event.type === "state" && event.status === "active") {
			cancelRun(mock, "cancel-before-kickoff", { reason: "cancel before kickoff" });
		}
	});

	startRun(mock, "cancel-before-kickoff");
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "paused"],
	);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.equal(lastPersistedGoal(mock)?.status, "paused");
	assert.equal(goalStatusSnapshot(mock.pi)?.status, "paused");
});

test("unknown, stale, and manual runs cannot be cancelled", async () => {
	const [mock, context] = await createRunHarness();
	await mock.commands.get("goal")?.handler("manual goal", context.ctx);
	const events = observeRun(mock, "not-owned");

	cancelRun(mock, "not-owned");
	await flush();

	assert.deepEqual(
		errors(events).map((event) => event.error.code),
		["RUN_NOT_FOUND"],
	);
	assert.equal(lastPersistedGoal(mock)?.status, "active");
});

test("cancel rejects malformed reasons without mutating the run", async () => {
	for (const [reason, reasonType] of [
		[42, "number"],
		["x".repeat(1_001), "string"],
	] as const) {
		const [mock] = await createRunHarness();
		const runId = `bad-reason-${reasonType}`;
		const events = observeRun(mock, runId);
		startRun(mock, runId);
		await flush();

		cancelRun(mock, runId, { reason });
		await flush();

		assert.deepEqual(
			errors(events).map((event) => event.error.code),
			["INVALID_REQUEST"],
		);
		assert.equal(lastPersistedGoal(mock)?.status, "active");
	}
});

test("manual edits terminate the prior managed run as superseded", async () => {
	const [mock, context] = await createRunHarness();
	const events = observeRun(mock, "edited-run");
	startRun(mock, "edited-run", { objective: "managed objective" });
	await flush();
	const managedGoalId = states(events)[0]?.goalId;
	assert.ok(managedGoalId);

	await mock.commands.get("goal")?.handler("edit manually revised objective", context.ctx);
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "cleared"],
	);
	assert.match(states(events).at(-1)?.reason ?? "", /superseded/i);
	assert.notEqual(lastPersistedGoal(mock)?.id, managedGoalId);
	assert.equal(lastPersistedGoal(mock)?.text, "manually revised objective");
});

test("completion emits one terminal event with summary and suppresses clear duplication", async () => {
	const [mock, context] = await createRunHarness();
	const events = observeRun(mock, "complete-run");
	startRun(mock, "complete-run");
	await flush();
	const goalId = states(events)[0]?.goalId;
	assert.ok(goalId);

	await requireGoalTool(mock, "goal_complete").execute(
		"complete-1",
		completionReport(goalId, "All managed Goal requirements were verified."),
		new AbortController().signal,
		() => undefined,
		context.ctx,
	);
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "complete"],
	);
	assert.equal(states(events).at(-1)?.summary, "All managed Goal requirements were verified.");
	assert.equal(states(events).filter((event) => event.status !== "active").length, 1);

	startRun(mock, "complete-run", { objective: "must not reopen" });
	await flush();
	assert.deepEqual(
		errors(events).map((event) => event.error.code),
		["RUN_ID_IN_USE"],
	);
});

test("a completion listener can start the next managed run", async () => {
	const [mock, context] = await createRunHarness();
	const firstEvents = observeRun(mock, "chained-first");
	const secondEvents = observeRun(mock, "chained-second");
	mock.eventBus.on(runEventChannel("chained-first"), (data) => {
		// SAFETY: this test controls the value and supplies every RunEvent member exercised by this case.
		const event = data as RunEvent;
		if (event.type === "state" && event.status === "complete") {
			startRun(mock, "chained-second", { objective: "second managed objective" });
		}
	});
	startRun(mock, "chained-first", { objective: "first managed objective" });
	await flush();
	const goalId = states(firstEvents)[0]?.goalId;
	assert.ok(goalId);

	await requireGoalTool(mock, "goal_complete").execute(
		"complete-chained-first",
		completionReport(goalId, "The first managed run was completed and verified."),
		new AbortController().signal,
		() => undefined,
		context.ctx,
	);
	await flush();

	assert.deepEqual(
		states(firstEvents).map((event) => event.status),
		["active", "complete"],
	);
	assert.deepEqual(
		states(secondEvents).map((event) => event.status),
		["active"],
	);
	assert.deepEqual(errors(secondEvents), []);
	assert.equal(lastPersistedGoal(mock)?.text, "second managed objective");
	assert.equal(lastPersistedGoal(mock)?.status, "active");
});

test("terminal listeners cannot make stale pause work mutate a replacement", async () => {
	const [mock, context] = await createRunHarness();
	const firstEvents = observeRun(mock, "pause-first");
	const secondEvents = observeRun(mock, "pause-second");
	mock.eventBus.on(runEventChannel("pause-first"), (data) => {
		// SAFETY: this test controls the value and supplies every RunEvent member exercised by this case.
		const event = data as RunEvent;
		if (event.type === "state" && event.status === "paused") {
			void mock.commands.get("goal")?.handler("clear", context.ctx);
			startRun(mock, "pause-second", { objective: "replacement after pause" });
		}
	});
	startRun(mock, "pause-first", { objective: "cancelled managed objective" });
	await flush();

	cancelRun(mock, "pause-first", { reason: "advance to replacement" });
	await flush();

	assert.deepEqual(
		states(firstEvents).map((event) => event.status),
		["active", "paused"],
	);
	assert.deepEqual(
		states(secondEvents).map((event) => event.status),
		["active"],
	);
	assert.equal(lastPersistedGoal(mock)?.text, "replacement after pause");
	assert.equal(
		context.notifications.some((notification) => notification.message === "Goal paused: replacement after pause"),
		false,
	);
});

test("blocked and usage-limited transitions preserve terminal reasons", async () => {
	const [blockedMock, blockedContext] = await createRunHarness();
	const blockedEvents = observeRun(blockedMock, "blocked-run");
	startRun(blockedMock, "blocked-run");
	await flush();
	const blockedGoalId = states(blockedEvents)[0]?.goalId;
	assert.ok(blockedGoalId);
	const blockedGoal = lastPersistedGoal(blockedMock);
	assert.ok(blockedGoal);
	primeBlockerAudit(blockedGoal, "Production credentials are required.");
	await requireGoalTool(blockedMock, "goal_blocked").execute(
		"blocked-1",
		{
			goal_id: blockedGoalId,
			reason: "Production credentials are required.",
			attempt: "Requested the production signing endpoint with anonymous access.",
			evidence: "The signing endpoint returned that production credentials are unavailable.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		blockedContext.ctx,
	);
	await flush();
	assert.equal(states(blockedEvents).at(-1)?.status, "blocked");
	assert.match(states(blockedEvents).at(-1)?.reason ?? "", /credentials/i);

	const [usageMock, usageContext] = await createRunHarness();
	const usageEvents = observeRun(usageMock, "usage-run");
	startRun(usageMock, "usage-run");
	await flush();
	usageMock.callEvent(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "You have exceeded your usage limit for this period.",
				},
			],
		},
		usageContext.ctx,
	);
	await flush();
	assert.equal(states(usageEvents).at(-1)?.status, "usage_limited");
	assert.match(states(usageEvents).at(-1)?.reason ?? "", /usage limit/i);
});

test("budget exhaustion emits the budget-limited terminal state", async () => {
	const branch: Array<ReturnType<typeof assistantUsageEntry>> = [];
	const [mock, context] = await createRunHarness(
		createMockContext({
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
		}),
	);
	const events = observeRun(mock, "budget-run");
	startRun(mock, "budget-run", { tokenBudget: 10 });
	await flush();
	branch.push(assistantUsageEntry(12));

	await mock.callEvent(
		"tool_execution_end",
		{ toolCallId: "budget-tool", toolName: "bash", result: {}, isError: false },
		context.ctx,
	);
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "budget_limited"],
	);
	assert.match(states(events).at(-1)?.reason ?? "", /token budget/i);
});

test("manual clear emits one cleared terminal event for its managed run", async () => {
	const [mock, context] = await createRunHarness();
	const events = observeRun(mock, "clear-run");
	startRun(mock, "clear-run");
	await flush();

	await mock.commands.get("goal")?.handler("clear", context.ctx);
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "cleared"],
	);
	assert.equal(states(events).at(-1)?.reason, "goal cleared");
});

test("failed kickoff emits active then one cleared rollback event", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	mock.rawPi.sendUserMessage = () => {
		throw new Error("kickoff failed");
	};
	registerGoal(mock);
	await bindSession(mock);
	const events = observeRun(mock, "failed-kickoff");

	startRun(mock, "failed-kickoff");
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active", "cleared"],
	);
	assert.equal(errors(events).length, 0);
	assert.match(states(events).at(-1)?.reason ?? "", /activation|delivery|cleared/i);
});

test("a pending start cannot emit for a replacement run after supersession", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	const kickoff = Promise.withResolvers<void>();
	mock.rawPi.sendUserMessage = () => kickoff.promise;
	registerGoal(mock);
	const context = await bindSession(mock);
	const firstEvents = observeRun(mock, "first-run");
	startRun(mock, "first-run");
	await flush();
	await mock.commands.get("goal")?.handler("clear", context.ctx);

	mock.rawPi.sendUserMessage = () => undefined;
	const secondEvents = observeRun(mock, "second-run");
	startRun(mock, "second-run", { objective: "replacement run" });
	await flush();
	assert.deepEqual(
		states(secondEvents).map((event) => event.status),
		["active"],
	);

	kickoff.resolve();
	await flush();

	assert.deepEqual(
		states(firstEvents).map((event) => event.status),
		["active", "cleared"],
	);
	assert.equal(errors(firstEvents).length, 0);
	assert.equal(lastPersistedGoal(mock)?.id, states(secondEvents)[0]?.goalId);
});
