import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
	bindSession,
	cancelRun,
	createRunHarness,
	errors,
	flush,
	lastPersistedGoal,
	observeRun,
	primeBlockerAudit,
	registerGoal,
	requireGoalTool,
	runEventChannel,
	SETTINGS_DIRECTORY,
	startRun,
	states,
} from "../../goal-upstream/goal-run-support.js";
import { createMockContext, createMockPi } from "../../goal-upstream/support.js";

test("run event listener failures do not interrupt persistence or sibling listeners", async () => {
	const [mock] = await createRunHarness();
	mock.eventBus.on(runEventChannel("listener-run"), () => {
		throw new Error("observer failed");
	});
	const events = observeRun(mock, "listener-run");

	startRun(mock, "listener-run");
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);
	assert.equal(lastPersistedGoal(mock)?.status, "active");
});

test("caller cancellation interrupts the owned Goal menu operation without starting a goal", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	registerGoal(mock);
	const caller = new AbortController();
	const opened = Promise.withResolvers<void>();
	const context = createMockContext({
		hasUI: true,
		mode: "tui",
		signal: caller.signal,
		select: async () => {
			opened.resolve();
			await new Promise<void>((resolve) => caller.signal.addEventListener("abort", () => resolve(), { once: true }));
			return "Start a goal…";
		},
	});
	await mock.callEvent("session_start", {}, context.ctx);

	const running = mock.commands.get("goal")?.handler("", context.ctx);
	await opened.promise;
	caller.abort(new DOMException("caller cancelled", "AbortError"));
	await running;

	assert.equal(lastPersistedGoal(mock), undefined);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.equal(
		context.notifications.some((notice) => /Goal dialog failed/.test(notice.message)),
		false,
	);
});

test("disabling RPC rejects new starts while the accepted run can drain", async () => {
	const settingsPath = join(SETTINGS_DIRECTORY, "draining.json");
	writeFileSync(settingsPath, '{"goal":{"toolVisibility":"always","rpc":{"enabled":true}}}\n');
	const [mock] = await createRunHarness(createMockContext(), settingsPath);
	const acceptedEvents = observeRun(mock, "draining-run");
	startRun(mock, "draining-run");
	await flush();
	assert.deepEqual(
		states(acceptedEvents).map((event) => event.status),
		["active"],
	);

	const selections = ["Settings…", "Managed run RPC", undefined, "Close"];
	const settingsContext = createMockContext({
		hasUI: true,
		mode: "tui",
		select: async () => selections.shift(),
	});
	await mock.commands.get("goal")?.handler("", settingsContext.ctx);

	const rejectedEvents = observeRun(mock, "rejected-after-disable");
	startRun(mock, "rejected-after-disable");
	cancelRun(mock, "draining-run", { reason: "drained after disable" });
	await flush();

	assert.deepEqual(
		errors(rejectedEvents).map((event) => event.error.code),
		["RPC_DISABLED"],
	);
	assert.deepEqual(
		states(acceptedEvents).map((event) => event.status),
		["active", "paused"],
	);
	assert.equal(states(acceptedEvents).at(-1)?.reason, "drained after disable");
});

test("shutdown cancels a queued terminal publication from the old session", async () => {
	const [mock, context] = await createRunHarness();
	const events = observeRun(mock, "shutdown-terminal");
	startRun(mock, "shutdown-terminal");
	await flush();

	cancelRun(mock, "shutdown-terminal");
	mock.emitHostEvent("session_shutdown", {}, context.ctx);
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);
	assert.equal(lastPersistedGoal(mock)?.status, "paused");
});

test("shutdown invalidates a start continuation still awaiting kickoff delivery", async () => {
	const mock = createMockPi({ activeTools: ["read", "bash"] });
	const kickoff = Promise.withResolvers<void>();
	mock.rawPi.sendUserMessage = () => kickoff.promise;
	registerGoal(mock);
	const firstContext = await bindSession(mock);
	const events = observeRun(mock, "shutdown-pending");
	startRun(mock, "shutdown-pending");
	await flush();
	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);

	mock.emitHostEvent("session_shutdown", {}, firstContext.ctx);
	kickoff.reject(new Error("late kickoff rejection"));
	await flush();

	assert.deepEqual(
		states(events).map((event) => event.status),
		["active"],
	);
	assert.equal(
		firstContext.notifications.some((notice) => /Goal (?:prompt failed|started)/.test(notice.message)),
		false,
	);
	assert.equal(lastPersistedGoal(mock)?.status, "active");
});

test("session replacement invalidates old run ownership and terminal details", async () => {
	const [mock, firstContext] = await createRunHarness();
	const firstEvents = observeRun(mock, "old-run");
	startRun(mock, "old-run");
	await flush();
	const oldGoalId = states(firstEvents)[0]?.goalId;
	assert.ok(oldGoalId);
	const oldGoal = lastPersistedGoal(mock);
	assert.ok(oldGoal);
	primeBlockerAudit(oldGoal, "Old session reason");
	await requireGoalTool(mock, "goal_blocked").execute(
		"blocked-old",
		{
			goal_id: oldGoalId,
			reason: "Old session reason",
			attempt: "Requested the old session dependency through its configured endpoint.",
			evidence: "The configured endpoint returned an unavailable dependency failure.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		firstContext.ctx,
	);
	const restoredGoal = {
		id: "restored-manual-goal",
		text: "restored task",
		status: "blocked",
		startedAt: 1,
		updatedAt: 2,
		iteration: 1,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		baselineTokens: 0,
	};
	const branch = [{ type: "custom", customType: "goal-state", data: { goal: restoredGoal } }];
	const secondContext = createMockContext({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await mock.callEvent("session_start", {}, secondContext.ctx);
	const staleEvents = observeRun(mock, "old-run");
	cancelRun(mock, "old-run");
	await flush();

	assert.deepEqual(
		errors(staleEvents).map((event) => event.error.code),
		["RUN_NOT_FOUND"],
	);
	assert.equal(lastPersistedGoal(mock)?.id, restoredGoal.id);
	assert.equal(lastPersistedGoal(mock)?.status, "blocked");
});

test("removed RPC, global state, and versioned channels are inert", async () => {
	const [mock, context] = await createRunHarness();
	const oldReplies: unknown[] = [];
	const oldStates: unknown[] = [];
	const versionedEvents: unknown[] = [];
	mock.eventBus.on("pi-goal:rpc:start:reply:legacy", (data) => oldReplies.push(data));
	mock.eventBus.on("pi-goal:state", (data) => oldStates.push(data));
	mock.eventBus.on("pi-goal:v1:event:unused-version", (data) => versionedEvents.push(data));

	mock.eventBus.emit("pi-goal:rpc:start", {
		requestId: "legacy",
		objective: "legacy objective",
	});
	mock.eventBus.emit("pi-goal:rpc:pause", { requestId: "legacy" });
	mock.eventBus.emit("pi-goal:v1:start", {
		runId: "unused-version",
		objective: "versioned objective",
	});
	mock.eventBus.emit("pi-goal:v1:cancel", { runId: "unused-version" });
	await mock.commands.get("goal")?.handler("manual objective", context.ctx);
	await flush();

	assert.deepEqual(oldReplies, []);
	assert.deepEqual(oldStates, []);
	assert.deepEqual(versionedEvents, []);
	assert.equal(lastPersistedGoal(mock)?.text, "manual objective");
});
