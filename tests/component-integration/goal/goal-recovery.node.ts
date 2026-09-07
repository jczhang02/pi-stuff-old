import assert from "node:assert/strict";
import test from "node:test";
import {
	assistantUsageEntry,
	findFinalAssistantMessage,
	isRetryableGoalInterruption,
	isUsageLimitedGoalInterruption,
	LOW_LIMITS_SETTINGS_PATH,
	lastGoalStatus,
	requireLastGoal,
	STALE_GOAL_TOOL_REASON,
	startGoalForTest,
	validateObjective,
} from "../../goal-upstream/goal-test-support.js";

test("usage-limit classification recognizes quota failures without swallowing unrelated errors", () => {
	for (const errorMessage of [
		"You have hit your ChatGPT usage limit.",
		"GoUsageLimitError",
		"Monthly usage limit reached; enable available balance",
		"Provider account is out of budget",
		"Your organization quota has been exceeded",
		"RESOURCE_EXHAUSTED: quota exhausted",
		"insufficient_quota",
		"Billing hard limit reached",
		"Please check your plan and billing details",
		"Your credit balance is too low to access the API",
		"Payment Required: insufficient credits",
	]) {
		assert.equal(
			isUsageLimitedGoalInterruption({ role: "assistant", stopReason: "error", errorMessage }),
			true,
			errorMessage,
		);
	}
	for (const errorMessage of [
		"WebSocket closed 1000",
		"rate_limit_exceeded",
		"HTTP 429 Too Many Requests",
		"Unauthorized: invalid API key",
		"multi-auth rotation failed: 2 credentials tried",
	]) {
		assert.equal(
			isUsageLimitedGoalInterruption({ role: "assistant", stopReason: "error", errorMessage }),
			false,
			errorMessage,
		);
	}
	assert.equal(
		isUsageLimitedGoalInterruption({
			role: "assistant",
			stopReason: "aborted",
			errorMessage: "usage limit",
		}),
		false,
	);
	for (const errorMessage of ["rate_limit_exceeded", "HTTP 429 Too Many Requests", "Internal server error 503"]) {
		assert.equal(
			isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage }),
			true,
			errorMessage,
		);
	}
});

test("agent_end maps abort, quota failure, and terminal error to distinct stopped states", async () => {
	for (const [assistant, status, notification] of [
		[{ role: "assistant", stopReason: "aborted" }, "paused", /paused after interruption/i],
		[
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "You have hit your ChatGPT usage limit.",
			},
			"usage_limited",
			/usage limit/i,
		],
		[
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "Permission denied by remote service",
			},
			"paused",
			/paused after interruption/i,
		],
	] as const) {
		let aborts = 0;
		const stopped = await startGoalForTest({ abort: () => aborts++ });
		await stopped.mock.callEvent("agent_end", { messages: [assistant] }, stopped.ctx);

		assert.equal(lastGoalStatus(stopped.mock), status);
		assert.equal(aborts, 1);
		assert.match(stopped.notifications.at(-1)?.message ?? "", notification);
		await stopped.mock.callEvent("agent_settled", {}, stopped.ctx);
		assert.equal(stopped.mock.sentUserMessages.length, 1);
		const staleToolCall = stopped.mock.events.get("tool_call")?.[0];
		assert.deepEqual(staleToolCall?.({ toolName: "bash", toolCallId: `stale-${status}`, input: {} }, stopped.ctx), {
			block: true,
			reason: STALE_GOAL_TOOL_REASON,
		});
		stopped.mock.callEvent("input", { source: "extension", text: "unrelated extension work" }, stopped.ctx);
		assert.deepEqual(
			staleToolCall?.({ toolName: "bash", toolCallId: `still-stale-${status}`, input: {} }, stopped.ctx),
			{ block: true, reason: STALE_GOAL_TOOL_REASON },
		);
		await stopped.mock.commands.get("goal")?.handler("resume", stopped.ctx);
		assert.equal(lastGoalStatus(stopped.mock), "active");
		assert.equal(
			staleToolCall?.({ toolName: "bash", toolCallId: `resumed-${status}`, input: {} }, stopped.ctx),
			undefined,
		);
	}
});

test("terminal agent errors take precedence over missing goal tools", async () => {
	for (const [errorMessage, expectedStatus] of [
		["You have hit your ChatGPT usage limit.", "usage_limited"],
		["Permission denied by remote service", "paused"],
	] as const) {
		const stopped = await startGoalForTest();
		stopped.mock.rawPi.setActiveTools(["read", "bash"]);

		await stopped.mock.callEvent(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage }] },
			stopped.ctx,
		);

		assert.equal(lastGoalStatus(stopped.mock), expectedStatus);
		assert.equal(stopped.mock.sentUserMessages.length, 1);
	}
});

test("retryable interruption classification covers opaque, transport, context, and capacity failures", () => {
	for (const errorMessage of [
		"Opaque provider failure code ZETA without a classifier hint",
		"WebSocket closed 1000",
		"prompt is too long: 213462 tokens > 200000 maximum",
		"This endpoint's maximum context length is 128000 tokens. However, you requested about 140000 tokens.",
		"context_length_exceeded",
		"HTTP 524: upstream timeout",
		"ResourceExhausted: transient backend capacity",
	]) {
		assert.equal(isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage }), true);
	}
	assert.equal(
		isRetryableGoalInterruption({
			role: "assistant",
			stopReason: "error",
			errorMessage: "You have hit your ChatGPT usage limit.",
		}),
		false,
	);
});

test("agent_end keeps retryable interruptions active after Pi exhausts its own retry", async () => {
	for (const [name, errorMessage] of [
		["transport", "WebSocket closed 1000"],
		["opaque", "Opaque provider failure code ZETA without a classifier hint"],
	] as const) {
		const retryable = await startGoalForTest();
		await retryable.mock.callEvent(
			"agent_end",
			{ messages: [{ role: "assistant", stopReason: "error", errorMessage }] },
			retryable.ctx,
		);
		assert.equal(lastGoalStatus(retryable.mock), "active");
		assert.equal(
			retryable.mock.callEvent(
				"tool_call",
				{ toolName: "bash", toolCallId: `${name}-retry-tool`, input: {} },
				retryable.ctx,
			),
			undefined,
		);
		await retryable.mock.callEvent("agent_settled", {}, retryable.ctx);
		assert.equal(retryable.mock.sentUserMessages.length, 2);
		assert.equal(lastGoalStatus(retryable.mock), "active");
	}
});

test("agent_end stops usage-limited interruptions and blocks stale tools", async () => {
	let aborts = 0;
	const nonRetryable = await startGoalForTest({ abort: () => aborts++ });
	await nonRetryable.mock.callEvent(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "You have hit your ChatGPT usage limit.",
				},
			],
		},
		nonRetryable.ctx,
	);

	assert.equal(aborts, 1);
	assert.equal(lastGoalStatus(nonRetryable.mock), "usage_limited");
	await nonRetryable.mock.callEvent("agent_settled", {}, nonRetryable.ctx);
	assert.equal(nonRetryable.mock.sentUserMessages.length, 1);
	assert.deepEqual(
		nonRetryable.mock.callEvent("tool_call", { toolName: "bash", toolCallId: "t1", input: {} }, nonRetryable.ctx),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);
});

test("automatic ownership survives agent_start retry without before_agent_start", async () => {
	const retried = await startGoalForTest({}, "finish", LOW_LIMITS_SETTINGS_PATH);
	await retried.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		retried.ctx,
	);
	await retried.mock.callEvent("agent_settled", {}, retried.ctx);
	const continuation = retried.mock.sentUserMessages.at(-1)?.text ?? "";
	retried.mock.callEvent("before_agent_start", { prompt: continuation, systemPrompt: "base" }, retried.ctx);
	retried.mock.callEvent(
		"turn_end",
		{
			message: {
				role: "assistant",
				stopReason: "error",
				errorMessage: "HTTP 524: upstream timeout",
				content: [],
			},
			toolResults: [],
		},
		retried.ctx,
	);
	await retried.mock.callEvent(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "HTTP 524: upstream timeout",
					content: [],
				},
			],
		},
		retried.ctx,
	);
	assert.equal(requireLastGoal(retried.mock).automaticModelTurns, 1);

	retried.mock.callEvent("agent_start", {}, retried.ctx);
	retried.mock.callEvent(
		"turn_end",
		{ message: { role: "assistant", stopReason: "stop", content: [] }, toolResults: [] },
		retried.ctx,
	);
	await retried.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		retried.ctx,
	);
	await retried.mock.callEvent("agent_settled", {}, retried.ctx);

	assert.equal(lastGoalStatus(retried.mock), "active");
	assert.equal(requireLastGoal(retried.mock).automaticModelTurns, 2);
});

test("stale exhausted recovery cannot block a replacement goal", async () => {
	const replaced = await startGoalForTest();
	await replaced.mock.callEvent(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "HTTP 524 upstream timeout",
				},
			],
		},
		replaced.ctx,
	);
	const oldGoal = requireLastGoal(replaced.mock);
	await replaced.mock.commands.get("goal")?.handler("replacement objective", replaced.ctx);
	const replacement = requireLastGoal(replaced.mock);
	assert.notEqual(replacement.id, oldGoal.id);

	await replaced.mock.callEvent("agent_settled", {}, replaced.ctx);
	assert.equal(requireLastGoal(replaced.mock).id, replacement.id);
	assert.equal(lastGoalStatus(replaced.mock), "active");
});

test("an exhausted goal does not remain active for a retryable provider error", async () => {
	const branch: unknown[] = [];
	const budgeted = await startGoalForTest(
		{ sessionManager: { getBranch: () => branch, getEntries: () => branch } },
		"--tokens 10 finish",
	);
	branch.push(assistantUsageEntry({ totalTokens: 12 }));
	await budgeted.mock.callEvent(
		"agent_end",
		{
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "WebSocket closed 1000" }],
		},
		budgeted.ctx,
	);

	assert.equal(lastGoalStatus(budgeted.mock), "budget_limited");
	assert.equal(budgeted.mock.sentMessages.length, 0);
	assert.deepEqual(
		await budgeted.mock.callEvent("session_before_compact", { reason: "overflow", willRetry: true }, budgeted.ctx),
		{ cancel: true },
	);
	await budgeted.mock.callEvent("agent_settled", {}, budgeted.ctx);
	assert.equal(budgeted.mock.sentUserMessages.length, 1);
});

test("agent_end keeps Codex retry-hinted errors active without stale tool blocking", async () => {
	let aborts = 0;
	const retryable = await startGoalForTest({ abort: () => aborts++ });
	const errorMessage =
		"Codex error: An error occurred while processing your request. You can retry your request.\n\n[codex-generic-retry] provider returned error; treating Codex retryable backend failure as retryable.";

	assert.equal(isRetryableGoalInterruption({ role: "assistant", stopReason: "error", errorMessage }), true);
	await retryable.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "error", errorMessage }] },
		retryable.ctx,
	);

	assert.equal(aborts, 0);
	assert.equal(lastGoalStatus(retryable.mock), "active");
	assert.equal(
		retryable.mock.callEvent(
			"tool_call",
			{ toolName: "bash", toolCallId: "codex-retry-tool", input: {} },
			retryable.ctx,
		),
		undefined,
	);
});

test("overflow compaction retry keeps the goal active and does not block retry tools", async () => {
	let aborts = 0;
	const overflow = await startGoalForTest({ abort: () => aborts++ });

	await overflow.mock.callEvent(
		"agent_end",
		{
			messages: [
				{
					role: "assistant",
					stopReason: "error",
					errorMessage: "prompt is too long: 213462 tokens > 200000 maximum",
				},
			],
		},
		overflow.ctx,
	);

	assert.equal(aborts, 0);
	assert.equal(lastGoalStatus(overflow.mock), "active");
	assert.equal(overflow.mock.sentUserMessages.length, 1);
	assert.equal(
		overflow.mock.callEvent("tool_call", { toolName: "read", toolCallId: "retry-tool", input: {} }, overflow.ctx),
		undefined,
	);

	overflow.mock.callEvent("session_before_compact", {}, overflow.ctx);
	await overflow.mock.callEvent("session_compact", {}, overflow.ctx);
	assert.equal(lastGoalStatus(overflow.mock), "active");

	// Pi retries through agent.continue(), which emits agent_start but not before_agent_start.
	overflow.mock.callEvent("agent_start", {}, overflow.ctx);
	await overflow.mock.callEvent(
		"agent_end",
		{
			messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "recovered" }] }],
		},
		overflow.ctx,
	);
	await overflow.mock.callEvent("agent_settled", {}, overflow.ctx);

	assert.equal(lastGoalStatus(overflow.mock), "active");
	assert.equal(overflow.mock.sentUserMessages.length, 2);
	assert.equal(
		overflow.mock.callEvent(
			"tool_call",
			{ toolName: "bash", toolCallId: "post-compact-retry-tool", input: {} },
			overflow.ctx,
		),
		undefined,
	);
});

test("compaction with willRetry true does not enqueue a goal continuation", async () => {
	const retrying = await startGoalForTest();

	retrying.mock.callEvent("session_before_compact", { reason: "overflow", willRetry: true }, retrying.ctx);
	await retrying.mock.callEvent("session_compact", { reason: "overflow", willRetry: true }, retrying.ctx);
	await retrying.mock.callEvent("agent_settled", {}, retrying.ctx);

	assert.equal(lastGoalStatus(retrying.mock), "active");
	assert.equal(retrying.mock.sentUserMessages.length, 1);
});

test("manual compaction cancels stale continuation and sends one fresh continuation", async () => {
	let idle = true;
	const compacted = await startGoalForTest({ isIdle: () => idle });
	await compacted.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		compacted.ctx,
	);
	await compacted.mock.callEvent("agent_settled", {}, compacted.ctx);
	const staleContinuation = compacted.mock.sentUserMessages.at(-1)?.text ?? "";
	assert.match(staleContinuation, /pi-goal-continuation/);

	compacted.mock.callEvent("session_before_compact", { reason: "threshold", willRetry: false }, compacted.ctx);
	assert.deepEqual(
		compacted.mock.callEvent("input", { source: "extension", text: staleContinuation }, compacted.ctx),
		{ action: "handled" },
	);

	idle = false;
	await compacted.mock.callEvent("session_compact", { reason: "threshold", willRetry: false }, compacted.ctx);
	assert.equal(compacted.mock.sentUserMessages.length, 2);

	idle = true;
	await compacted.mock.callEvent("agent_settled", {}, compacted.ctx);
	const freshContinuation = compacted.mock.sentUserMessages.at(-1)?.text ?? "";
	assert.equal(compacted.mock.sentUserMessages.length, 3);
	assert.match(freshContinuation, /pi-goal-continuation/);
	assert.notEqual(freshContinuation, staleContinuation);
	assert.equal(
		compacted.mock.callEvent("input", { source: "extension", text: freshContinuation }, compacted.ctx),
		undefined,
	);

	await compacted.mock.callEvent("session_compact", { reason: "threshold", willRetry: false }, compacted.ctx);
	assert.equal(compacted.mock.sentUserMessages.length, 3);
});

test("manual compaction waits for actual idle without requiring agent_settled", async () => {
	let idle = false;
	const compacted = await startGoalForTest({ isIdle: () => idle });
	try {
		await compacted.mock.callEvent("session_before_compact", { reason: "manual", willRetry: false }, compacted.ctx);
		await compacted.mock.callEvent("session_compact", { reason: "manual", willRetry: false }, compacted.ctx);
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(compacted.mock.sentUserMessages.length, 1, "must not start work inside the compaction hook");
		idle = true;
		const deadline = Date.now() + 1_000;
		while (compacted.mock.sentUserMessages.length < 2 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.equal(compacted.mock.sentUserMessages.length, 2);
		assert.match(compacted.mock.sentUserMessages.at(-1)?.text ?? "", /pi-goal-continuation/);
		await compacted.mock.callEvent("agent_settled", {}, compacted.ctx);
		assert.equal(compacted.mock.sentUserMessages.length, 2, "later settlement must not duplicate delivery");
	} finally {
		await compacted.mock.callEvent("session_shutdown", {}, compacted.ctx);
	}
});

test("pause and shutdown cancel delayed manual-compaction continuation", async () => {
	for (const action of ["pause", "shutdown"]) {
		let idle = false;
		let idleChecks = 0;
		const compacted = await startGoalForTest({
			isIdle: () => {
				idleChecks++;
				return idle;
			},
		});
		await compacted.mock.callEvent("session_before_compact", { reason: "manual", willRetry: false }, compacted.ctx);
		await compacted.mock.callEvent("session_compact", { reason: "manual", willRetry: false }, compacted.ctx);
		if (action === "pause") await compacted.mock.commands.get("goal")?.handler("pause", compacted.ctx);
		else await compacted.mock.callEvent("session_shutdown", {}, compacted.ctx);
		const checksAfterCancellation = idleChecks;
		idle = true;
		await new Promise((resolve) => setTimeout(resolve, 30));
		assert.equal(compacted.mock.sentUserMessages.length, 1, action);
		assert.equal(idleChecks, checksAfterCancellation, "cancelled work must stop checking idle");
		if (action === "pause") await compacted.mock.callEvent("session_shutdown", {}, compacted.ctx);
	}
});

test("native compaction failure replaces a stale Goal continuation exactly once", async () => {
	let idleWaits = 0;
	const sessionManager = {
		getBranch: () => [],
		getEntries: () => [],
		getSessionId: () => "failed-compaction-session",
		getSessionName: () => undefined,
	};
	const compacted = await startGoalForTest({
		sessionManager,
		waitForIdle: async () => {
			idleWaits++;
		},
	});
	const compactFailed = compacted.mock.events.get("session_compact_failed")?.[0];
	const failure = {
		aborted: true,
		fromExtension: false,
		reason: "threshold",
		willRetry: false,
	};

	compactFailed?.(failure, compacted.ctx);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(compacted.mock.sentUserMessages.length, 1);

	await compacted.mock.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop" }] },
		compacted.ctx,
	);
	await compacted.mock.callEvent("agent_settled", {}, compacted.ctx);
	const staleContinuation = compacted.mock.sentUserMessages.at(-1)?.text ?? "";
	assert.match(staleContinuation, /pi-goal-continuation/);

	compacted.mock.callEvent("session_before_compact", { reason: "threshold", willRetry: true }, compacted.ctx);
	assert.deepEqual(
		compacted.mock.callEvent("input", { source: "extension", text: staleContinuation }, compacted.ctx),
		{ action: "handled" },
	);

	// SAFETY: this mismatched Host context fixture exercises only session identity matching.
	compactFailed?.(failure, { sessionManager: {} } as never);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(compacted.mock.sentUserMessages.length, 2);

	compactFailed?.(failure, compacted.ctx);
	await new Promise((resolve) => setTimeout(resolve, 5));
	const freshContinuation = compacted.mock.sentUserMessages.at(-1)?.text ?? "";
	assert.equal(idleWaits, 1);
	assert.equal(compacted.mock.sentUserMessages.length, 3);
	assert.match(freshContinuation, /pi-goal-continuation/);
	assert.notEqual(freshContinuation, staleContinuation);

	compactFailed?.(failure, compacted.ctx);
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(compacted.mock.sentUserMessages.length, 3);
});

test("stale goal tool calls are blocked after pause until a fresh non-goal prompt arrives", async () => {
	const paused = await startGoalForTest();
	await paused.mock.commands.get("goal")?.handler("pause", paused.ctx);

	const pauseToolCall = paused.mock.events.get("tool_call")?.[0];
	assert.deepEqual(pauseToolCall?.({ toolName: "bash", toolCallId: "t1", input: {} }, paused.ctx), {
		block: true,
		reason: STALE_GOAL_TOOL_REASON,
	});

	paused.mock.callEvent("input", { source: "extension", text: "unrelated extension message" }, paused.ctx);
	assert.deepEqual(pauseToolCall?.({ toolName: "bash", toolCallId: "t2", input: {} }, paused.ctx), {
		block: true,
		reason: STALE_GOAL_TOOL_REASON,
	});

	paused.mock.callEvent("input", { source: "interactive", text: "/goal edit revised paused objective" }, paused.ctx);
	assert.deepEqual(pauseToolCall?.({ toolName: "bash", toolCallId: "t3", input: {} }, paused.ctx), {
		block: true,
		reason: STALE_GOAL_TOOL_REASON,
	});

	paused.mock.callEvent("input", { source: "interactive", text: "what happened?" }, paused.ctx);
	paused.mock.callEvent("before_agent_start", { prompt: "what happened?", systemPrompt: "base" }, paused.ctx);
	paused.mock.callEvent("agent_start", {}, paused.ctx);
	paused.mock.callEvent("turn_start", {}, paused.ctx);
	paused.mock.callEvent(
		"message_start",
		{ message: { role: "user", content: [{ type: "text", text: "what happened?" }] } },
		paused.ctx,
	);
	assert.equal(pauseToolCall?.({ toolName: "bash", toolCallId: "t4", input: {} }, paused.ctx), undefined);
});

test("findFinalAssistantMessage returns the last assistant with a known stop reason", () => {
	assert.deepEqual(
		findFinalAssistantMessage([
			{ role: "assistant", stopReason: "stop" },
			{ role: "assistant", stopReason: "error", errorMessage: "bad" },
		]),
		{ role: "assistant", stopReason: "error", errorMessage: "bad" },
	);
	assert.deepEqual(
		findFinalAssistantMessage([
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: "context_length_exceeded",
				provider: "openai",
				model: "gpt-test",
				usage: { input: 10, output: 2 },
				timestamp: 123,
			},
		]),
		{
			role: "assistant",
			stopReason: "error",
			errorMessage: "context_length_exceeded",
			provider: "openai",
			model: "gpt-test",
			usage: {
				input: 10,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: 123,
		},
	);
	assert.deepEqual(
		findFinalAssistantMessage([
			{
				role: "assistant",
				stopReason: "error",
				content: [
					{ type: "text", text: "retry", textSignature: "text-signature" },
					{ type: "thinking", thinking: "checking", redacted: false },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
				],
			},
		]),
		{
			role: "assistant",
			stopReason: "error",
			errorMessage: undefined,
			content: [
				{ type: "text", text: "retry", textSignature: "text-signature" },
				{ type: "thinking", thinking: "checking", redacted: false },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "README.md" } },
			],
		},
	);
	assert.deepEqual(
		findFinalAssistantMessage([
			{
				role: "assistant",
				stopReason: "error",
				content: [{ type: "text", text: 42 }],
				usage: { input: 1, output: 2, cost: { input: "invalid", output: -1, total: 4 } },
			},
		]),
		{
			role: "assistant",
			stopReason: "error",
			errorMessage: undefined,
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 4 },
			},
		},
	);
	assert.equal(validateObjective(""), "Usage: /goal <goal_to_complete>");
});
