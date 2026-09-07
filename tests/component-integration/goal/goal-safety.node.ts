import assert from "node:assert/strict";
import test from "node:test";
import * as Effect from "effect/Effect";
import {
	type ActiveGoal,
	createGoal,
	createMockContext,
	createMockPi,
	fingerprintVisibleAssistantOutput,
	hasAssistantToolCall,
	isRuntimeString,
	LOW_LIMITS_SETTINGS_PATH,
	lastGoalStatus,
	nextToolFreeRepeatState,
	normalizeVisibleAssistantOutput,
	ONE_TURN_LIMIT_SETTINGS_PATH,
	recordGoalBlockerAttempt,
	registerGoal,
	requireLastGoal,
	runtimeByPi,
	startGoalForTest,
} from "../../goal-upstream/goal-test-support.js";

test("no-progress classifier normalizes visible output conservatively", () => {
	const blank = [{ role: "assistant", content: [{ type: "text", text: "  ...\u0000 " }] }];
	const thinkingOnly = [
		{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }, null] },
		{ malformed: true },
	];
	assert.equal(normalizeVisibleAssistantOutput(blank), "");
	assert.equal(normalizeVisibleAssistantOutput(thinkingOnly), "");
	assert.equal(
		normalizeVisibleAssistantOutput([{ role: "assistant", content: [{ type: "text", text: "foo\n\tbar" }] }]),
		"foo bar",
	);
	assert.equal(
		fingerprintVisibleAssistantOutput([{ role: "assistant", content: [{ type: "text", text: "foo\nbar" }] }]),
		fingerprintVisibleAssistantOutput([{ role: "assistant", content: [{ type: "text", text: "foo bar" }] }]),
	);
	assert.equal(fingerprintVisibleAssistantOutput(blank), fingerprintVisibleAssistantOutput(thinkingOnly));
	assert.equal(
		hasAssistantToolCall([{ role: "assistant", content: [{ type: "toolCall", name: "unknown", arguments: {} }] }]),
		true,
	);

	let state = { toolFreeRepeatCount: 0 };
	state = nextToolFreeRepeatState(
		state,
		[{ role: "assistant", content: [{ type: "text", text: "  STILL   Working " }] }],
		false,
	);
	assert.equal(state.toolFreeRepeatCount, 1);
	state = nextToolFreeRepeatState(
		state,
		[{ role: "assistant", content: [{ type: "text", text: "still working" }] }],
		false,
	);
	assert.equal(state.toolFreeRepeatCount, 2);
	state = nextToolFreeRepeatState(
		state,
		[{ role: "assistant", content: [{ type: "text", text: "different short output" }] }],
		false,
	);
	assert.equal(state.toolFreeRepeatCount, 1);
	state = nextToolFreeRepeatState(state, blank, true);
	assert.deepEqual(state, { toolFreeRepeatCount: 0 });
});

test("blocker audit counts at most once per turn and resets for gaps or a different reason", async () => {
	const harness = await startGoalForTest();
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const activeGoal = requireLastGoal(harness.mock) as ActiveGoal;
	activeGoal.iteration = 4;
	activeGoal.blockerAudit = recordGoalBlockerAttempt(
		activeGoal,
		"Missing API key.",
		"Checked the local credential store for the required API key.",
		"The credential store returned that the required API key is missing.",
	);
	assert.equal(activeGoal.blockerAudit.consecutiveTurns, 1);

	activeGoal.blockerAudit = recordGoalBlockerAttempt(
		activeGoal,
		"missing   api-key",
		"Checked the local credential store for the required API key.",
		"The credential store returned that the required API key is missing.",
	);
	assert.equal(activeGoal.blockerAudit.consecutiveTurns, 1);
	activeGoal.iteration = 5;
	activeGoal.blockerAudit = recordGoalBlockerAttempt(
		activeGoal,
		"MISSING API KEY",
		"Queried the process environment for an alternate API key.",
		"The environment query returned no configured alternate API key.",
	);
	assert.equal(activeGoal.blockerAudit.consecutiveTurns, 2);

	activeGoal.iteration = 7;
	activeGoal.blockerAudit = recordGoalBlockerAttempt(
		activeGoal,
		"Missing API key",
		"Requested provider access through the anonymous authentication path.",
		"The provider request returned a credential-required error response.",
	);
	assert.equal(activeGoal.blockerAudit.consecutiveTurns, 1);
	activeGoal.iteration = 8;
	activeGoal.blockerAudit = recordGoalBlockerAttempt(
		activeGoal,
		"Missing repository access",
		"Queried the repository through the configured remote origin.",
		"The repository query returned an explicit permission-denied response.",
	);
	assert.equal(activeGoal.blockerAudit.consecutiveTurns, 1);
});

test("assistant toolCall blocks reset no-progress even when tool_call hook never fires", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.callEvent("agent_settled", {}, active.ctx);
	for (let run = 1; run <= 2; run++) {
		const prompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
		active.mock.callEvent("before_agent_start", { prompt, systemPrompt: "base" }, active.ctx);
		await active.mock.callEvent(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
			active.ctx,
		);
		await active.mock.callEvent("agent_settled", {}, active.ctx);
	}
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 2);

	const prompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.callEvent("before_agent_start", { prompt, systemPrompt: "base" }, active.ctx);
	await active.mock.callEvent(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					stopReason: "toolUse",
					content: [{ type: "toolCall", name: "unknown", arguments: {} }],
				},
			],
		},
		active.ctx,
	);
	assert.equal(lastGoalStatus(active.mock), "active");
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
});

test("automatic turn_end hard cap pauses a tool loop before another normal response", async () => {
	let aborts = 0;
	const capped = await startGoalForTest({ abort: () => aborts++ }, "finish", LOW_LIMITS_SETTINGS_PATH);
	const kickoffPrompt = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.callEvent("before_agent_start", { prompt: kickoffPrompt, systemPrompt: "base" }, capped.ctx);
	capped.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(requireLastGoal(capped.mock).automaticModelTurns, 0);
	await capped.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.callEvent("agent_settled", {}, capped.ctx);
	const continuationPrompt = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.callEvent("before_agent_start", { prompt: continuationPrompt, systemPrompt: "base" }, capped.ctx);

	for (let turn = 1; turn <= 3; turn++) {
		capped.mock.callEvent("tool_call", { toolName: "read", toolCallId: `tool-${turn}`, input: {} }, capped.ctx);
		capped.mock.callEvent(
			"turn_end",
			{
				message: { role: "assistant", stopReason: "toolUse", content: [] },
				toolResults: [],
			},
			capped.ctx,
		);
	}

	const stopped = requireLastGoal(capped.mock);
	assert.equal(stopped.status, "paused");
	assert.equal(stopped.automaticModelTurns, 3);
	assert.equal(stopped.safetyPauseCause, "continuation_limit");
	assert.equal(aborts, 1);
	assert.equal(
		capped.notifications.filter((notice) => /Goal paused: 3 automatic model responses/i.test(notice.message)).length,
		1,
	);
	await capped.mock.commands.get("goal")?.handler("", capped.ctx);
	assert.match(capped.notifications.at(-1)?.message ?? "", /Automatic model responses: 3/i);
	assert.match(capped.notifications.at(-1)?.message ?? "", /Safety pause: automatic response limit/i);
	capped.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "aborted", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(requireLastGoal(capped.mock).automaticModelTurns, 3);
	await capped.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "aborted", content: [] }] },
		capped.ctx,
	);
	await capped.mock.callEvent("agent_settled", {}, capped.ctx);
	assert.equal(capped.mock.sentUserMessages.length, 2);
});

test("hard cap aborts Pi recovery started after a retryable boundary error", async () => {
	let aborts = 0;
	const capped = await startGoalForTest({ abort: () => aborts++ }, "finish", ONE_TURN_LIMIT_SETTINGS_PATH);
	await capped.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.callEvent("agent_settled", {}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, capped.ctx);
	const retryableError = {
		role: "assistant",
		stopReason: "error",
		errorMessage: "HTTP 524: upstream timeout",
		content: [],
	};
	capped.mock.callEvent("turn_end", { message: retryableError, toolResults: [] }, capped.ctx);
	await capped.mock.callEvent("agent_end", { messages: [retryableError] }, capped.ctx);
	assert.equal(lastGoalStatus(capped.mock), "paused");
	assert.equal(aborts, 1);

	capped.mock.callEvent("agent_start", {}, capped.ctx);
	assert.equal(aborts, 1);
	capped.mock.callEvent("context", { messages: [] }, capped.ctx);
	assert.equal(aborts, 2);
	capped.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "aborted", content: [] }, toolResults: [] },
		capped.ctx,
	);
	await capped.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "aborted", content: [] }] },
		capped.ctx,
	);
	await capped.mock.callEvent("agent_settled", {}, capped.ctx);
	assert.equal(requireLastGoal(capped.mock).automaticModelTurns, 1);
	assert.equal(capped.mock.sentUserMessages.length, 2);
});

test("an aborted automatic response does not consume the final hard-cap turn", async () => {
	const interrupted = await startGoalForTest({}, "finish", ONE_TURN_LIMIT_SETTINGS_PATH);
	await interrupted.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		interrupted.ctx,
	);
	await interrupted.mock.callEvent("agent_settled", {}, interrupted.ctx);
	const continuation = interrupted.mock.sentUserMessages.at(-1)?.text ?? "";
	interrupted.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, interrupted.ctx);
	const aborted = { role: "assistant", stopReason: "aborted", content: [] };
	interrupted.mock.callEvent("turn_end", { message: aborted, toolResults: [] }, interrupted.ctx);
	assert.equal(lastGoalStatus(interrupted.mock), "active");
	assert.equal(requireLastGoal(interrupted.mock).automaticModelTurns, 0);
	await interrupted.mock.callEvent("agent_end", { messages: [aborted] }, interrupted.ctx);
	assert.equal(lastGoalStatus(interrupted.mock), "paused");
	assert.equal(requireLastGoal(interrupted.mock).safetyPauseCause, undefined);
});

test("terminal errors take precedence when an automatic response reaches the hard cap", async () => {
	for (const [errorMessage, expectedStatus] of [
		["usage limit reached for this account", "usage_limited"],
		["invalid request payload", "paused"],
	] as const) {
		const capped = await startGoalForTest({}, "finish", ONE_TURN_LIMIT_SETTINGS_PATH);
		await capped.mock.callEvent(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
			capped.ctx,
		);
		await capped.mock.callEvent("agent_settled", {}, capped.ctx);
		const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
		capped.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, capped.ctx);
		const error = { role: "assistant", stopReason: "error", errorMessage, content: [] };
		capped.mock.callEvent("turn_end", { message: error, toolResults: [] }, capped.ctx);
		assert.equal(lastGoalStatus(capped.mock), "active");
		await capped.mock.callEvent("agent_end", { messages: [error] }, capped.ctx);
		assert.equal(lastGoalStatus(capped.mock), expectedStatus);
		assert.equal(requireLastGoal(capped.mock).automaticModelTurns, 1);
	}
});

test("hard-cap cleanup guard does not abort an unrelated queued follow-up", async () => {
	let aborts = 0;
	const capped = await startGoalForTest({ abort: () => aborts++ }, "finish", ONE_TURN_LIMIT_SETTINGS_PATH);
	await capped.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.callEvent("agent_settled", {}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, capped.ctx);
	capped.mock.callEvent(
		"input",
		{
			source: "extension",
			text: "unrelated extension follow-up",
			streamingBehavior: "followUp",
		},
		capped.ctx,
	);
	capped.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(lastGoalStatus(capped.mock), "paused");
	assert.equal(aborts, 1);

	capped.mock.callEvent("agent_start", {}, capped.ctx);
	assert.equal(aborts, 1);
	capped.mock.callEvent("turn_start", {}, capped.ctx);
	capped.mock.callEvent(
		"message_start",
		{ message: { role: "user", content: [{ type: "text", text: "unrelated extension follow-up" }] } },
		capped.ctx,
	);
	assert.equal(
		capped.mock.callEvent(
			"tool_call",
			{ toolName: "read", toolCallId: "unrelated-follow-up-read", input: {} },
			capped.ctx,
		),
		undefined,
	);
});

test("queued custom follow-up starts without cleanup abort or stale tool blocking", async () => {
	let aborts = 0;
	const capped = await startGoalForTest({ abort: () => aborts++ }, "finish", ONE_TURN_LIMIT_SETTINGS_PATH);
	await capped.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.callEvent("agent_settled", {}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, capped.ctx);
	capped.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(lastGoalStatus(capped.mock), "paused");
	assert.equal(aborts, 1);

	capped.mock.callEvent("agent_start", {}, capped.ctx);
	assert.equal(aborts, 1);
	capped.mock.callEvent("turn_start", {}, capped.ctx);
	const customFollowUp = {
		role: "custom",
		customType: "other-extension-follow-up",
		content: "unrelated custom work",
	};
	capped.mock.callEvent("message_start", { message: customFollowUp }, capped.ctx);
	capped.mock.callEvent("context", { messages: [customFollowUp] }, capped.ctx);
	assert.equal(aborts, 1);
	assert.equal(
		capped.mock.callEvent(
			"tool_call",
			{ toolName: "read", toolCallId: "custom-follow-up-read", input: {} },
			capped.ctx,
		),
		undefined,
	);
});

test("a queued follow-up marker is not consumed by an earlier matching steer", async () => {
	let aborts = 0;
	const capped = await startGoalForTest({ abort: () => aborts++ }, "finish", ONE_TURN_LIMIT_SETTINGS_PATH);
	await capped.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.callEvent("agent_settled", {}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, capped.ctx);
	capped.mock.callEvent(
		"input",
		{ source: "extension", text: "same prompt", streamingBehavior: "followUp" },
		capped.ctx,
	);
	capped.mock.callEvent("input", { source: "extension", text: "same prompt", streamingBehavior: "steer" }, capped.ctx);
	capped.mock.callEvent(
		"message_start",
		{ message: { role: "user", content: [{ type: "text", text: "same prompt" }] } },
		capped.ctx,
	);
	capped.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(lastGoalStatus(capped.mock), "paused");
	assert.equal(requireLastGoal(capped.mock).automaticModelTurns, 1);
	assert.equal(aborts, 1);

	capped.mock.callEvent("agent_start", {}, capped.ctx);
	assert.equal(aborts, 1);
	capped.mock.callEvent("turn_start", {}, capped.ctx);
	capped.mock.callEvent(
		"message_start",
		{ message: { role: "user", content: [{ type: "text", text: "same prompt" }] } },
		capped.ctx,
	);
	assert.equal(
		capped.mock.callEvent(
			"tool_call",
			{ toolName: "read", toolCallId: "matching-follow-up-read", input: {} },
			capped.ctx,
		),
		undefined,
	);
});

test("a transformed mixed-origin collision fails closed without resetting safety", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.callEvent("agent_settled", {}, active.ctx);
	const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, active.ctx);
	const safety = requireLastGoal(active.mock);
	safety.automaticModelTurns = 2;
	safety.toolFreeRepeatCount = 2;
	safety.lastToolFreeOutputFingerprint = "5".repeat(64);
	active.mock.callEvent(
		"input",
		{ source: "extension", text: "/skill:automatic", streamingBehavior: "steer" },
		active.ctx,
	);
	active.mock.callEvent(
		"input",
		{ source: "interactive", text: "Expanded automatic work", streamingBehavior: "followUp" },
		active.ctx,
	);

	active.mock.callEvent(
		"message_start",
		{ message: { role: "user", content: [{ type: "text", text: "Expanded automatic work" }] } },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 2);
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 2);

	active.mock.callEvent(
		"message_start",
		{ message: { role: "user", content: [{ type: "text", text: "Expanded automatic work" }] } },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 2);
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 2);
});

test("queued input attribution remains lossless beyond the former mirror limit", () => {
	const mock = createMockPi();
	registerGoal(mock.pi);
	const runtime = runtimeByPi.get(mock.pi);
	assert.ok(runtime);
	runtime.prompts.noteQueuedNonGoalInput("oldest user follow-up", "followUp", "manual", true);
	for (let index = 0; index < 64; index += 1) {
		runtime.prompts.noteQueuedNonGoalInput(`user follow-up ${index}`, "followUp", "manual", true);
	}

	const delivered = runtime.prompts.consumeQueuedNonGoalInput("oldest user follow-up");
	assert.equal(delivered?.behavior, "followUp");
	assert.equal(delivered?.resetSafetyEpoch, true);
});

test("owned Goal prompt attribution remains lossless beyond the former marker limit", async () => {
	const mock = createMockPi();
	registerGoal(mock.pi);
	const runtime = runtimeByPi.get(mock.pi);
	assert.ok(runtime);
	const context = createMockContext();
	for (let index = 0; index < 32; index += 1) {
		runtime.activeGoal = { ...createGoal(`goal ${index}`, undefined, 0), id: `goal-${index}` };
		assert.equal(
			await Effect.runPromise(runtime.sendOwnedGoalPrompt(context.ctx, `goal-${index}`, `owned prompt ${index}`)),
			true,
		);
	}

	const oldestPrompt = mock.sentUserMessages[0]?.text;
	assert.equal(isRuntimeString(oldestPrompt), true);
	assert.deepEqual(runtime.prompts.consumeOwnedGoalPrompt(oldestPrompt ?? ""), {
		goalId: "goal-0",
		origin: "automatic",
		resetSafetyEpoch: true,
	});
});

test("mid-stream steer does not suppress hard-cap cleanup abort", async () => {
	let aborts = 0;
	const capped = await startGoalForTest({ abort: () => aborts++ }, "finish", ONE_TURN_LIMIT_SETTINGS_PATH);
	await capped.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		capped.ctx,
	);
	await capped.mock.callEvent("agent_settled", {}, capped.ctx);
	const continuation = capped.mock.sentUserMessages.at(-1)?.text ?? "";
	capped.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, capped.ctx);
	capped.mock.callEvent(
		"input",
		{ source: "extension", text: "unrelated steer", streamingBehavior: "steer" },
		capped.ctx,
	);
	capped.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		capped.ctx,
	);
	assert.equal(aborts, 1);
	capped.mock.callEvent("agent_start", {}, capped.ctx);
	assert.equal(aborts, 1);
	capped.mock.callEvent("context", { messages: [] }, capped.ctx);
	assert.equal(aborts, 2);
});

test("queued user follow-up resets safety only when its message starts", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.callEvent("agent_settled", {}, active.ctx);
	const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, active.ctx);
	const safety = requireLastGoal(active.mock);
	safety.automaticModelTurns = 2;
	safety.toolFreeRepeatCount = 2;
	safety.lastToolFreeOutputFingerprint = "f".repeat(64);
	active.mock.callEvent(
		"input",
		{ source: "interactive", text: "user follow-up", streamingBehavior: "followUp" },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 2);
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 2);

	active.mock.callEvent(
		"message_start",
		{ message: { role: "user", content: [{ type: "text", text: "user follow-up" }] } },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
	active.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		active.ctx,
	);
	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
	assert.match(continuation, /pi-goal-continuation:/);
});

test("expanded queued follow-up claims manual ownership at its delivery boundary", async () => {
	const active = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await active.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		active.ctx,
	);
	await active.mock.callEvent("agent_settled", {}, active.ctx);
	const continuation = active.mock.sentUserMessages.at(-1)?.text ?? "";
	active.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, active.ctx);
	const safety = requireLastGoal(active.mock);
	safety.automaticModelTurns = 2;
	safety.toolFreeRepeatCount = 2;
	safety.lastToolFreeOutputFingerprint = "9".repeat(64);
	active.mock.callEvent(
		"input",
		{ source: "interactive", text: "/skill:review", streamingBehavior: "followUp" },
		active.ctx,
	);

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
	active.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		active.ctx,
	);

	assert.equal(requireLastGoal(active.mock).automaticModelTurns, 0);
	assert.equal(requireLastGoal(active.mock).toolFreeRepeatCount, 0);
});
