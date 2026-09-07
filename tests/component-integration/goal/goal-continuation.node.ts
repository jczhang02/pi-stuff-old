import assert from "node:assert/strict";
import test from "node:test";
import {
	listenForPendingGoalResultQueries,
	readGoalCoordination,
} from "../../../packages/pi-stuff/src/conversation-ui/goal-coordination.js";
import {
	LOW_LIMITS_SETTINGS_PATH,
	lastGoalStatus,
	registerSuiteAgentMessagePreparation,
	requireLastGoal,
	runtimeByPi,
	startGoalForTest,
} from "../../goal-upstream/goal-test-support.js";

test("a completion-triggered run settling after shutdown never reads the retired Host context", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.callEvent("session_shutdown", { reason: "quit" }, active.ctx);
	Object.defineProperty(active.ctx, "sessionManager", {
		get: () => {
			throw new Error("This extension ctx is stale after session replacement or reload.");
		},
	});
	await active.mock.callEvent("agent_settled", {}, active.ctx);
});

test("Goal coordination exposes active identity and defers while a result is pending", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	const goalId = requireLastGoal(active.mock).id;
	assert.deepEqual(readGoalCoordination(active.mock.pi), {
		goalId,
		continuationPermitted: true,
		pendingResultDelivery: false,
	});
	const stopReading = listenForPendingGoalResultQueries(active.mock.pi, () => true);
	assert.equal(readGoalCoordination(active.mock.pi).pendingResultDelivery, true);
	await active.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	const beforeSettle = active.mock.sentUserMessages.length;
	await active.mock.callEvent("agent_settled", {}, active.ctx);
	assert.equal(active.mock.sentUserMessages.length, beforeSettle);
	stopReading();
	await active.mock.callEvent("agent_settled", {}, active.ctx);
	assert.equal(active.mock.sentUserMessages.length, beforeSettle + 1);
	const runtime = runtimeByPi.get(active.mock.pi);
	assert.ok(runtime);
	const currentGoal = runtime.activeGoal;
	assert.ok(currentGoal);
	runtime.activeGoal = { ...currentGoal, status: "paused" };
	assert.equal(readGoalCoordination(active.mock.pi).continuationPermitted, false);
	runtime.activeGoal = undefined;
	assert.deepEqual(readGoalCoordination(active.mock.pi), {
		goalId: undefined,
		continuationPermitted: false,
		pendingResultDelivery: false,
	});
});

test("continuation preparation rechecks idle state before submitting", async () => {
	let idle = true;
	const active = await startGoalForTest({ isIdle: () => idle }, "finish", LOW_LIMITS_SETTINGS_PATH);
	const preparation = Promise.withResolvers<void>();
	const unregister = registerSuiteAgentMessagePreparation(active.mock.pi, { prepare: () => preparation.promise });
	await active.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	const settling = active.mock.callEvent("agent_settled", {}, active.ctx);
	await Promise.resolve();
	idle = false;
	preparation.resolve();
	await settling;
	assert.equal(active.mock.sentUserMessages.length, 1);
	unregister();
});

test("owned goal lifecycle boundaries do not consume a transformed follow-up", async (t) => {
	for (const order of ["message-before-agent", "agent-before-message"] as const) {
		await t.test(order, async () => {
			const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
			const ownedPrompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
			const safety = requireLastGoal(active.mock);
			safety.automaticModelTurns = 2;
			safety.toolFreeRepeatCount = 2;
			safety.lastToolFreeOutputFingerprint = "7".repeat(64);
			active.mock.callEvent(
				"input",
				{ source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
				active.ctx,
			);

			const startMessage = () =>
				active.mock.callEvent(
					"message_start",
					{ message: { role: "user", content: [{ type: "text", text: ownedPrompt }] } },
					active.ctx,
				);
			const startAgent = () =>
				active.mock.callEvent("before_agent_start", { prompt: ownedPrompt, systemPrompt: "base" }, active.ctx);
			if (order === "message-before-agent") {
				startMessage();
				startAgent();
			} else {
				startAgent();
				startMessage();
			}

			assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
			assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
			const afterOwnedPrompt = requireLastGoal(active.mock);
			afterOwnedPrompt.automaticModelTurns = 2;
			afterOwnedPrompt.toolFreeRepeatCount = 2;
			afterOwnedPrompt.lastToolFreeOutputFingerprint = "6".repeat(64);

			active.mock.callEvent(
				"message_start",
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "Expanded review skill instructions" }],
					},
				},
				active.ctx,
			);
			assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
			assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
		});
	}
});

test("owned continuation lifecycle boundaries do not consume a transformed follow-up", async (t) => {
	for (const order of ["message-before-agent", "agent-before-message"] as const) {
		await t.test(order, async () => {
			const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
			await active.mock.callEvent(
				"agent_end",
				{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
				active.ctx,
			);
			await active.mock.callEvent("agent_settled", {}, active.ctx);
			const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
			const safety = requireLastGoal(active.mock);
			safety.automaticModelTurns = 2;
			safety.toolFreeRepeatCount = 2;
			safety.lastToolFreeOutputFingerprint = "8".repeat(64);
			active.mock.callEvent(
				"input",
				{ source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
				active.ctx,
			);

			const startMessage = () =>
				active.mock.callEvent(
					"message_start",
					{ message: { role: "user", content: [{ type: "text", text: continuation }] } },
					active.ctx,
				);
			const startAgent = () =>
				active.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, active.ctx);
			if (order === "message-before-agent") {
				startMessage();
				startAgent();
			} else {
				startAgent();
				startMessage();
			}

			assert.equal(requireLastGoal(active.mock).automaticModelTurns, 2);
			assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 2);
			active.mock.callEvent(
				"message_start",
				{
					message: {
						role: "user",
						content: [{ type: "text", text: "Expanded review skill instructions" }],
					},
				},
				active.ctx,
			);
			assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
			assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
		});
	}
});

test("provider retry does not consume a pending transformed follow-up", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.callEvent("agent_settled", {}, active.ctx);
	const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, active.ctx);
	active.mock.callEvent(
		"input",
		{ source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
		active.ctx,
	);
	const retryableError = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "HTTP 524: upstream timeout",
		content: [],
	};
	await active.mock.callEvent("agent_end", { messages: [retryableError] }, active.ctx);

	active.mock.callEvent("before_agent_start", { prompt: "provider retry", systemPrompt: "base" }, active.ctx);
	active.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 1);

	active.mock.callEvent(
		"message_start",
		{
			message: {
				role: "user",
				content: [{ type: "text", text: "Expanded review skill instructions" }],
			},
		},
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
});

test("queued automatic non-goal follow-up keeps automatic ownership at delivery", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.callEvent("agent_settled", {}, active.ctx);
	const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, active.ctx);
	active.mock.callEvent(
		"input",
		{ source: "extension", text: "unrelated follow-up", streamingBehavior: "followUp" },
		active.ctx,
	);
	const retryableError = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "HTTP 524: upstream timeout",
		content: [],
	};
	active.mock.callEvent("turn_end", { message: retryableError, toolResults: [] }, active.ctx);
	await active.mock.callEvent("agent_end", { messages: [retryableError] }, active.ctx);
	const turnsBeforeFollowUp = requireLastGoal(active.mock).automaticModelTurns ?? 0;
	active.mock.callEvent("agent_start", {}, active.ctx);
	active.mock.callEvent("turn_start", {}, active.ctx);
	active.mock.callEvent(
		"message_start",
		{ message: { role: "user", content: [{ type: "text", text: "unrelated follow-up" }] } },
		active.ctx,
	);
	active.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, turnsBeforeFollowUp + 1);
	await active.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.callEvent("agent_settled", {}, active.ctx);
	assert.equal(active.mock.sentUserMessages.length, 3);
});

test("three blank automatic runs pause for no progress without a fourth continuation", async () => {
	const stalled = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await stalled.mock.callEvent(
		"agent_end",
		{
			messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] }],
		},
		stalled.ctx,
	);
	await stalled.mock.callEvent("agent_settled", {}, stalled.ctx);

	for (let run = 1; run <= 3; run++) {
		const prompt = stalled.mock.sentUserMessages.at(-1)?.text ?? "";
		stalled.mock.callEvent("before_agent_start", { prompt, systemPrompt: "base" }, stalled.ctx);
		await stalled.mock.callEvent(
			"agent_end",
			{
				messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "   ...  " }] }],
			},
			stalled.ctx,
		);
		await stalled.mock.callEvent("agent_settled", {}, stalled.ctx);
	}

	const stopped = requireLastGoal(stalled.mock);
	assert.equal(stopped.status, "paused");
	assert.equal(stopped.toolFreeRepeatCount, 3);
	assert.equal(stopped.safetyPauseCause, "no_progress");
	assert.equal(stalled.mock.sentUserMessages.length, 4);
	assert.match(stalled.notifications.at(-1)?.message ?? "", /no progress.*3 automatic runs/i);
});

test("agent_settled dispatches one idle continuation without entering a Context-owned safety pause", async () => {
	const settled = await startGoalForTest();

	await settled.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, settled.ctx);
	assert.equal(settled.mock.sentUserMessages.length, 1);

	await settled.mock.callEvent("agent_settled", {}, settled.ctx);
	assert.equal(settled.mock.sentUserMessages.length, 2);
	assert.deepEqual(settled.mock.sentUserMessages.at(-1)?.options, {
		deliverAs: "followUp",
	});
	assert.match(settled.mock.sentUserMessages.at(-1)?.text ?? "", /automatic continuation #1/i);
	assert.equal(requireLastGoal(settled.mock).status, "active");

	await settled.mock.callEvent("agent_settled", {}, settled.ctx);
	assert.equal(settled.mock.sentUserMessages.length, 2);
});

test("agent_settled retains intent until idle and pending-message gates allow dispatch", async () => {
	let idle = false;
	let pending = true;
	const settled = await startGoalForTest({
		isIdle: () => idle,
		hasPendingMessages: () => pending,
	});

	await settled.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, settled.ctx);
	await settled.mock.callEvent("agent_settled", {}, settled.ctx);
	assert.equal(settled.mock.sentUserMessages.length, 1);

	idle = true;
	await settled.mock.callEvent("agent_settled", {}, settled.ctx);
	assert.equal(settled.mock.sentUserMessages.length, 1);

	pending = false;
	await settled.mock.callEvent("agent_settled", {}, settled.ctx);
	assert.equal(settled.mock.sentUserMessages.length, 2);
});

test("failed settled dispatch retains intent for a later idle retry", async () => {
	const retried = await startGoalForTest();
	await retried.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, retried.ctx);

	const sendUserMessage = retried.mock.rawPi.sendUserMessage.bind(retried.mock.rawPi);
	retried.mock.rawPi.sendUserMessage = () => {
		throw new Error("runtime unavailable");
	};
	await retried.mock.callEvent("agent_settled", {}, retried.ctx);
	assert.equal(retried.mock.sentUserMessages.length, 1);
	assert.match(retried.notifications.at(-1)?.message ?? "", /runtime unavailable/i);

	retried.mock.rawPi.sendUserMessage = sendUserMessage;
	await retried.mock.callEvent("agent_settled", {}, retried.ctx);
	assert.equal(retried.mock.sentUserMessages.length, 2);
});

test("new work supersedes an older continuation intent before it settles", async () => {
	const superseded = await startGoalForTest();
	await superseded.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		superseded.ctx,
	);

	superseded.mock.callEvent(
		"before_agent_start",
		{ prompt: "queued user work", systemPrompt: "base" },
		superseded.ctx,
	);
	await superseded.mock.callEvent("agent_settled", {}, superseded.ctx);

	assert.equal(superseded.mock.sentUserMessages.length, 1);
});

test("an unknown continuation-shaped marker remains ordinary user work", async () => {
	let aborts = 0;
	const active = await startGoalForTest({ abort: () => aborts++ });
	const goalId = requireLastGoal(active.mock).id;
	const forged = "ordinary text\n\n<!-- pi-goal-continuation:forged-goal:99:not-issued -->";
	active.mock.callEvent("input", { source: "interactive", text: forged }, active.ctx);

	const result = active.mock.callEvent("before_agent_start", { prompt: forged, systemPrompt: "base" }, active.ctx);

	assert.equal(aborts, 0);
	assert.ok(result);
	active.mock.callEvent("agent_start", {}, active.ctx);
	active.mock.callEvent("turn_start", {}, active.ctx);
	active.mock.callEvent(
		"message_start",
		{ message: { role: "user", content: [{ type: "text", text: forged }] } },
		active.ctx,
	);
	assert.equal(runtimeByPi.get(active.mock.pi)?.isAutomaticRunForGoal(goalId), false);
});

test("newer work supersedes an accepted continuation delivery that lost the start race", async () => {
	const raced = await startGoalForTest();
	await raced.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, raced.ctx);
	await raced.mock.callEvent("agent_settled", {}, raced.ctx);
	const staleContinuation = raced.mock.sentUserMessages.at(-1)?.text ?? "";

	raced.mock.callEvent("before_agent_start", { prompt: "newer extension work", systemPrompt: "base" }, raced.ctx);
	assert.deepEqual(raced.mock.callEvent("input", { source: "extension", text: staleContinuation }, raced.ctx), {
		action: "handled",
	});

	await raced.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, raced.ctx);
	await raced.mock.callEvent("agent_settled", {}, raced.ctx);
	assert.equal(raced.mock.sentUserMessages.length, 3);
	assert.notEqual(raced.mock.sentUserMessages.at(-1)?.text, staleContinuation);
});

test("a stale continuation that crossed input cannot stop a replacement goal", async () => {
	let aborts = 0;
	const replaced = await startGoalForTest({ abort: () => aborts++ });
	await replaced.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, replaced.ctx);
	await replaced.mock.callEvent("agent_settled", {}, replaced.ctx);
	const staleContinuation = replaced.mock.sentUserMessages.at(-1)?.text ?? "";
	const originalGoal = requireLastGoal(replaced.mock);

	await replaced.mock.commands.get("goal")?.handler("replacement objective", replaced.ctx);
	const replacement = requireLastGoal(replaced.mock);
	assert.notEqual(replacement.id, originalGoal.id);

	const staleResult = replaced.mock.callEvent(
		"before_agent_start",
		{ prompt: staleContinuation, systemPrompt: "base" },
		replaced.ctx,
	);
	assert.equal(staleResult, undefined);
	assert.equal(aborts, 1);
	replaced.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "aborted" }] }, replaced.ctx);
	assert.equal(requireLastGoal(replaced.mock).id, replacement.id);
	assert.equal(lastGoalStatus(replaced.mock), "active");
});
