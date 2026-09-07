import { test } from "bun:test";
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { Guard } from "typebox/guard";
import {
	budgetAgentEndFallbackScenario,
	budgetBoundaryScenario,
	budgetViolationScenario,
} from "../../goal-upstream/goal-runtime-budget.mjs";
import {
	agentDirectoryIsolationScenario,
	createHarness,
	persistedGoalHistory,
	persistedGoalState,
	persistedGoalStatus,
	waitFor,
} from "../../goal-upstream/goal-runtime-support.mjs";

const finalResponse = () => fauxAssistantMessage("Runtime smoke final Assistant response.");

function completionResponse(context) {
	const goalId = latestGoalId(context);
	assert.ok(goalId, "expected goal id in continuation system prompt");
	return fauxAssistantMessage(
		fauxToolCall("goal_complete", {
			goal_id: goalId,
			summary: "Runtime smoke completed and verified.",
			evidence: [
				{
					requirement: "Complete and verify the active Goal lifecycle",
					proof: "The real Pi lifecycle test observed the required state transition and persisted output.",
				},
			],
		}),
	);
}

function blockerResponse(repeatedTurns) {
	return (context) => {
		const goalId = latestGoalId(context);
		assert.ok(goalId, "expected goal id in blocker audit system prompt");
		return fauxAssistantMessage(
			fauxToolCall("goal_blocked", {
				goal_id: goalId,
				reason: "Production signing credential requires the user",
				attempt: [
					"Checked the local credential store for the production signing key.",
					"Queried the process environment for an alternate production signing key.",
					"Requested signing through the configured hardware agent socket.",
				][repeatedTurns - 1],
				evidence: `The attempted signing path returned an unavailable credential result on audit turn ${repeatedTurns}.`,
				repeated_turns: repeatedTurns,
			}),
		);
	};
}

function userMessageText(message) {
	if (message.role !== "user") return "";
	if (Guard.IsString(message.content)) return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part?.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function storedPromptText(message) {
	const userText = userMessageText(message);
	if (userText || message.role !== "custom") return userText;
	if (Guard.IsString(message.content)) return message.content;
	if (!Array.isArray(message.content)) return "";
	return message.content
		.filter((part) => part?.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function contextText(context) {
	return [context.systemPrompt ?? "", ...context.messages.map(storedPromptText)].filter(Boolean).join("\n");
}

function latestGoalId(context) {
	return [...contextText(context).matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/g)].at(-1)?.[1];
}

async function normalContinuationScenario() {
	const harness = await createHarness([
		fauxAssistantMessage("First pass stopped without completion."),
		completionResponse,
		finalResponse,
	]);
	const events = [];
	const unsubscribe = harness.session.subscribe((event) => events.push(event.type));
	try {
		await harness.session.prompt("/goal runtime continuation smoke");
		await waitFor(
			() => events.filter((type) => type === "agent_settled").length === 2,
			"two settled continuation runs",
		);
		await harness.session.agent.waitForIdle();
		assert.equal(events.filter((type) => type === "agent_settled").length, 2);
		assert.equal(persistedGoalStatus(harness.session), null);
		assert.ok(harness.session.messages.map(storedPromptText).some((text) => text.includes("pi-goal-continuation:")));
	} finally {
		unsubscribe();
		await harness.cleanup();
	}
}

async function strictBlockerAuditScenario() {
	const harness = await createHarness([
		blockerResponse(1),
		fauxAssistantMessage("The first blocker report was recorded; reasonable alternatives remain."),
		blockerResponse(2),
		fauxAssistantMessage("The second blocker report was recorded; one final independent attempt remains."),
		blockerResponse(3),
		finalResponse,
	]);
	try {
		await harness.session.prompt("/goal prove the strict blocker audit");
		await waitFor(() => harness.faux.state.callCount === 6, "three-turn blocker audit and final response");
		await harness.session.agent.waitForIdle();
		assert.equal(persistedGoalStatus(harness.session), "blocked");
		assert.equal(persistedGoalState(harness.session)?.goal?.blockerAudit?.consecutiveTurns, 3);
		assert.equal(
			harness.session.messages.map(storedPromptText).filter((text) => text.includes("pi-goal-continuation:")).length,
			2,
		);
	} finally {
		await harness.cleanup();
	}
}

async function runawayNoProgressScenario() {
	const harness = await createHarness(
		[
			fauxAssistantMessage("Required phrase"),
			fauxAssistantMessage(""),
			fauxAssistantMessage("   ...   "),
			fauxAssistantMessage(""),
		],
		{},
		undefined,
		{ continuationLimits: { automaticTurns: null, noProgressTurns: 3 } },
	);
	try {
		await harness.session.prompt('/goal Reply with exactly: "Required phrase"');
		await waitFor(() => harness.faux.state.callCount === 4, "no-progress safety pause");
		await harness.session.agent.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(harness.faux.state.callCount, 4);
		assert.equal(persistedGoalStatus(harness.session), "paused");
		assert.equal(persistedGoalState(harness.session)?.goal?.safetyPauseCause, "no_progress");
		assert.equal(persistedGoalState(harness.session)?.goal?.toolFreeRepeatCount, 3);
		assert.equal(
			harness.session.messages.map(storedPromptText).filter((text) => text.includes("pi-goal-continuation:")).length,
			3,
		);
	} finally {
		await harness.cleanup();
	}
}

async function automaticToolLoopLimitScenario() {
	const observedSignals = [];
	const toolResponse = (_context, options) => {
		observedSignals.push(options?.signal?.aborted === true);
		return fauxAssistantMessage(fauxToolCall("budget_probe", {}));
	};
	const harness = await createHarness(
		[
			fauxAssistantMessage("Start automatic work."),
			toolResponse,
			toolResponse,
			toolResponse,
			(_context, options) => {
				observedSignals.push(options?.signal?.aborted === true);
				assert.equal(options?.signal?.aborted, true);
				return fauxAssistantMessage("Synthetic aborted cleanup.");
			},
		],
		{},
		undefined,
		{ continuationLimits: { automaticTurns: 3, noProgressTurns: null } },
	);
	try {
		await harness.session.prompt("/goal bounded automatic tool loop");
		await harness.session.agent.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(persistedGoalStatus(harness.session), "paused");
		assert.equal(persistedGoalState(harness.session)?.goal?.safetyPauseCause, "continuation_limit");
		assert.equal(persistedGoalState(harness.session)?.goal?.automaticModelTurns, 3);
		assert.equal(harness.lifecycleEvents.filter((event) => event === "budget_probe_execute").length, 3);
		assert.deepEqual(observedSignals.slice(0, 3), [false, false, false]);
		assert.ok(observedSignals.length <= 4);
		if (observedSignals.length === 4) assert.equal(observedSignals[3], true);
		assert.ok(harness.faux.state.callCount <= 5);
	} finally {
		await harness.cleanup();
	}
}

async function retryAtHardLimitScenario() {
	const observedSignals = [];
	const harness = await createHarness(
		[
			fauxAssistantMessage("Initial unfinished result."),
			(_context, options) => {
				observedSignals.push(options?.signal?.aborted === true);
				return fauxAssistantMessage("", {
					stopReason: "error",
					errorMessage: "HTTP 524: transient upstream timeout",
				});
			},
			(_context, options) => {
				observedSignals.push(options?.signal?.aborted === true);
				assert.equal(options?.signal?.aborted, true);
				return fauxAssistantMessage("Guard-owned aborted retry cleanup.");
			},
		],
		{},
		undefined,
		{ continuationLimits: { automaticTurns: 1, noProgressTurns: null } },
		{
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		},
	);
	try {
		await harness.session.prompt("/goal retry cannot cross hard limit");
		await harness.session.agent.waitForIdle();
		await new Promise((resolve) => setTimeout(resolve, 100));
		assert.equal(persistedGoalStatus(harness.session), "paused");
		assert.equal(persistedGoalState(harness.session)?.goal?.safetyPauseCause, "continuation_limit");
		assert.equal(persistedGoalState(harness.session)?.goal?.automaticModelTurns, 1);
		assert.equal(observedSignals[0], false);
		assert.ok(observedSignals.length <= 2);
		if (observedSignals.length === 2) assert.equal(observedSignals[1], true);
		assert.ok(
			harness.faux.state.callCount === 2 || harness.faux.state.callCount === 3,
			"Pi must either suppress the cancelled retry before provider dispatch or expose only an aborted cleanup call",
		);
	} finally {
		await harness.cleanup();
	}
}

async function automaticRetryOwnershipScenario() {
	const harness = await createHarness(
		[
			fauxAssistantMessage("Initial unfinished result."),
			fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: "HTTP 524: transient upstream timeout",
			}),
			fauxAssistantMessage("Recovered provider response."),
			completionResponse,
			finalResponse,
		],
		{},
		undefined,
		{ continuationLimits: { automaticTurns: 3, noProgressTurns: null } },
		{
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		},
	);
	try {
		await harness.session.prompt("/goal runtime retry ownership smoke");
		await waitFor(() => harness.faux.state.callCount === 5, "provider retry, continuation, and final response");
		await harness.session.agent.waitForIdle();
		assert.equal(persistedGoalStatus(harness.session), null);
		assert.ok(
			persistedGoalHistory(harness.session).some(
				(goal) => goal.automaticModelTurns === 2 && goal.status === "active",
			),
			"retry response must retain automatic ownership",
		);
		assert.ok(
			harness.lifecycleEvents.filter((event) => event === "agent_start").length >= 3,
			"expected retry to emit agent_start",
		);
	} finally {
		await harness.cleanup();
	}
}

async function exhaustedRetryContinuesScenario() {
	const providerError = fauxAssistantMessage("", {
		stopReason: "error",
		errorMessage: "HTTP 524: transient upstream timeout",
	});
	const harness = await createHarness(
		[
			fauxAssistantMessage("Initial unfinished result."),
			providerError,
			providerError,
			completionResponse,
			finalResponse,
		],
		{},
		undefined,
		undefined,
		{
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
		},
	);
	try {
		await harness.session.prompt("/goal continue after Pi exhausts one provider retry");
		await waitFor(() => harness.faux.state.callCount === 5, "continuation and final response after exhausted retry");
		await harness.session.agent.waitForIdle();
		assert.equal(persistedGoalStatus(harness.session), null);
		assert.ok(harness.session.messages.map(storedPromptText).some((text) => text.includes("pi-goal-continuation:")));
	} finally {
		await harness.cleanup();
	}
}

async function orderedQueueScenario() {
	const now = Date.now();
	const harness = await createHarness(
		[completionResponse, finalResponse, completionResponse, finalResponse],
		{},
		(sessionManager) => {
			sessionManager.appendCustomEntry("goal-state", {
				goal: {
					id: crypto.randomUUID(),
					text: "runtime queue head",
					status: "active",
					startedAt: now,
					updatedAt: now,
					iteration: 0,
					tokensUsed: 0,
					timeUsedSeconds: 0,
					baselineTokens: 0,
				},
				queue: [
					{
						id: crypto.randomUUID(),
						text: "runtime queue tail",
						status: "queued",
						startedAt: now,
						updatedAt: now,
						iteration: 0,
						tokensUsed: 0,
						timeUsedSeconds: 0,
						baselineTokens: 0,
					},
				],
			});
		},
		{ experimental: { goals: true } },
	);
	try {
		const toolNames = harness.session.getAllTools().map(({ name }) => name);
		assert.ok(toolNames.includes("goal_complete"));
		assert.ok(toolNames.includes("goal_blocked"));
		assert.equal(toolNames.includes("goals_complete"), false);
		assert.equal(toolNames.includes("goals_blocked"), false);
		await harness.session.prompt("continue the restored ordered queue");
		await waitFor(() => harness.faux.state.callCount === 4, "ordered queue final responses and advancement");
		await harness.session.agent.waitForIdle();
		assert.equal(persistedGoalStatus(harness.session), null);
		assert.equal(persistedGoalState(harness.session)?.queue, undefined);
	} finally {
		await harness.cleanup();
	}
}

async function queuedInputScenario() {
	const observedPrompts = [];
	const harness = await createHarness(
		[
			(context) => {
				observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
				return fauxAssistantMessage("x".repeat(120));
			},
			(context) => {
				observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
				return fauxAssistantMessage("Queued request handled.");
			},
			(context) => {
				observedPrompts.push(context.messages.map(userMessageText).filter(Boolean).at(-1) ?? "");
				return completionResponse(context);
			},
			finalResponse,
		],
		{ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
	);
	try {
		await harness.session.prompt("/goal queued work smoke");
		await waitFor(() => harness.session.isStreaming, "initial turn streaming");
		await harness.session.prompt("queued user work", { streamingBehavior: "followUp" });
		await waitFor(() => harness.faux.state.callCount === 4, "continuation and final response after queued input");
		await harness.session.agent.waitForIdle();
		const queuedIndex = observedPrompts.findIndex((text) => text.includes("queued user work"));
		const continuationIndex = observedPrompts.findIndex((text) => text.includes("pi-goal-continuation:"));
		assert.ok(queuedIndex >= 0, "expected queued work to reach the model");
		assert.ok(continuationIndex > queuedIndex, "continuation must yield to queued work");
	} finally {
		await harness.cleanup();
	}
}

async function busyEditOwnershipScenario() {
	const harness = await createHarness(
		[
			fauxAssistantMessage("x".repeat(120)),
			fauxAssistantMessage("Edited objective handled in the current run."),
			completionResponse,
			finalResponse,
		],
		{ tokensPerSecond: 200, tokenSize: { min: 1, max: 1 } },
	);
	try {
		await harness.session.prompt("/goal original busy objective");
		await waitFor(() => harness.session.isStreaming, "busy goal turn");
		await harness.session.prompt("/goal edit revised busy objective");
		await waitFor(() => harness.faux.state.callCount === 4, "edited-goal continuation and final response");
		await harness.session.agent.waitForIdle();
		assert.equal(persistedGoalStatus(harness.session), null);
		assert.ok(
			harness.session.messages.map(storedPromptText).some((text) => text.includes("updated objective supersedes")),
		);
	} finally {
		await harness.cleanup();
	}
}

async function pauseScenario() {
	const harness = await createHarness([fauxAssistantMessage("x".repeat(200))], {
		tokensPerSecond: 100,
		tokenSize: { min: 1, max: 1 },
	});
	try {
		await harness.session.prompt("/goal interrupt runtime smoke");
		await waitFor(() => harness.session.isStreaming, "goal turn streaming");
		await harness.session.prompt("/goal pause");
		await waitFor(() => !harness.session.isStreaming, "goal turn abort");
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.ok(harness.faux.state.callCount <= 1, "pause must prevent any second provider call");
		assert.equal(persistedGoalStatus(harness.session), "paused");
		assert.equal(
			harness.session.messages.map(storedPromptText).filter((text) => text.includes("pi-goal-continuation:")).length,
			0,
		);
	} finally {
		await harness.cleanup();
	}
}

async function reloadResumeScenario() {
	const now = Date.now();
	const harness = await createHarness([completionResponse, finalResponse], {}, (sessionManager) => {
		sessionManager.appendCustomEntry("goal-state", {
			goal: {
				id: crypto.randomUUID(),
				text: "survive a real Pi reload",
				status: "active",
				startedAt: now - 1_000,
				updatedAt: now - 1_000,
				iteration: 1,
				tokensUsed: 0,
				timeUsedSeconds: 1,
				baselineTokens: 0,
			},
		});
	});
	try {
		assert.equal(persistedGoalStatus(harness.session), "active");
		assert.equal(harness.faux.state.callCount, 0);
		await harness.session.reload();
		assert.ok(harness.session.getAllTools().some(({ name }) => name === "goal_complete"));
		try {
			await waitFor(() => harness.faux.state.callCount === 2, "automatic post-reload Goal completion response");
		} catch (error) {
			throw new Error(
				`Post-reload Goal did not complete: ${JSON.stringify({
					callCount: harness.faux.state.callCount,
					status: persistedGoalStatus(harness.session),
					messages: harness.session.messages.map(storedPromptText).filter(Boolean),
				})}`,
				{ cause: error },
			);
		}
		await harness.session.agent.waitForIdle();
		assert.equal(persistedGoalStatus(harness.session), null);
		assert.ok(harness.session.messages.map(storedPromptText).some((text) => text.includes("pi-goal-continuation:")));
	} finally {
		await harness.cleanup();
	}
}

async function frozenQueueBlockedToolAbortScenario() {
	const observedSignals = [];
	const now = Date.now();
	const goalId = crypto.randomUUID();
	const harness = await createHarness(
		[
			fauxAssistantMessage(
				fauxToolCall("goal_complete", {
					goal_id: goalId,
					summary: "This frozen queue must not complete.",
					evidence: [
						{
							requirement: "Preserve the frozen queue",
							proof: "The runtime test observed that frozen state must reject this tool call.",
						},
					],
				}),
			),
			(_context, options) => {
				observedSignals.push(options?.signal?.aborted === true);
				return fauxAssistantMessage("Synthetic frozen-queue cleanup.");
			},
		],
		{},
		(sessionManager) => {
			sessionManager.appendCustomEntry("goal-state", {
				goal: {
					id: goalId,
					text: "frozen queue head",
					status: "active",
					startedAt: now,
					updatedAt: now,
					iteration: 0,
					tokensUsed: 0,
					timeUsedSeconds: 0,
					baselineTokens: 0,
				},
				queue: [
					{
						id: crypto.randomUUID(),
						text: "frozen queue tail",
						status: "queued",
						startedAt: now,
						updatedAt: now,
						iteration: 0,
						tokensUsed: 0,
						timeUsedSeconds: 0,
						baselineTokens: 0,
					},
				],
			});
		},
	);
	try {
		await harness.session.prompt("Simulate a stale frozen-queue tool call.");
		await harness.session.agent.waitForIdle();
		assert.ok(harness.faux.state.callCount <= 2, "frozen guard must allow at most one cleanup call");
		assert.equal(observedSignals.includes(false), false, "any cleanup call must inherit abort");
		assert.equal(persistedGoalStatus(harness.session), "active");
	} finally {
		await harness.cleanup();
	}
}

async function stalePausedToolAbortScenario() {
	const observedSignals = [];
	const harness = await createHarness([
		fauxAssistantMessage("", {
			stopReason: "error",
			errorMessage: "Unauthorized: invalid API key",
		}),
		fauxAssistantMessage(fauxToolCall("budget_probe", {})),
		(_context, options) => {
			observedSignals.push(options?.signal?.aborted === true);
			return fauxAssistantMessage("Synthetic stale-turn cleanup.");
		},
	]);
	try {
		await harness.session.prompt("/goal stale paused-tool runtime smoke");
		await harness.session.agent.waitForIdle();
		assert.equal(persistedGoalStatus(harness.session), "paused");

		// Bypass the normal input boundary to model provider-owned stale work that
		// arrives after the interrupted goal has already installed its tool guard.
		await harness.session.agent.prompt("Simulate a stale provider-owned turn.");
		await harness.session.agent.waitForIdle();
		assert.ok(harness.faux.state.callCount <= 3, "stale guard must allow at most one cleanup call");
		assert.equal(observedSignals.includes(false), false, "any cleanup call must inherit abort");
		assert.equal(harness.lifecycleEvents.filter((event) => event === "budget_probe_execute").length, 0);
	} finally {
		await harness.cleanup();
	}
}

async function terminalBudgetMixedBatchScenario() {
	const harness = await createHarness([
		(context) => {
			const response = completionResponse(context);
			response.content.push(fauxToolCall("budget_probe", {}));
			return response;
		},
		finalResponse,
	]);
	try {
		await harness.session.prompt("/goal --tokens 10 complete at budget boundary");
		await harness.session.agent.waitForIdle();
		assert.equal(harness.faux.state.callCount, 1, "terminal budget must stop a mixed Tool batch");
		assert.ok(persistedGoalHistory(harness.session).some((goal) => goal.status === "complete"));
	} finally {
		await harness.cleanup();
	}
}

async function managedRunRpcScenario() {
	const runId = crypto.randomUUID();
	const harness = await createHarness(
		[completionResponse, finalResponse],
		{},
		undefined,
		{ rpc: { enabled: true } },
		{},
		{ runId, objective: "complete a managed runtime run" },
	);
	try {
		await waitFor(
			() => harness.managedRunEvents.some((event) => event.status === "complete"),
			"managed run completion",
		);
		await harness.session.agent.waitForIdle();
		assert.deepEqual(
			harness.managedRunEvents.filter((event) => event.type === "state").map((event) => event.status),
			["active", "complete"],
		);
		assert.equal(
			harness.managedRunEvents.filter((event) => event.type === "state" && event.status !== "active").length,
			1,
		);
	} finally {
		await harness.cleanup();
	}
}

async function managedRunDisabledScenario() {
	const runId = crypto.randomUUID();
	const harness = await createHarness([], {}, undefined, undefined, {}, { runId, objective: "must stay disabled" });
	try {
		await waitFor(() => harness.managedRunEvents.length > 0, "managed run disabled rejection");
		assert.deepEqual(harness.managedRunEvents, [
			{
				type: "error",
				runId,
				operation: "start",
				error: { code: "RPC_DISABLED", message: "Managed run RPC is disabled." },
			},
		]);
		assert.equal(harness.faux.state.callCount, 0);
	} finally {
		await harness.cleanup();
	}
}

async function manualCompactionScenario() {
	const now = Date.now();
	const harness = await createHarness(
		[fauxAssistantMessage("Compacted prior work."), completionResponse, finalResponse],
		{},
		(sessionManager) => {
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: `Old request ${"x".repeat(100_000)}` }],
				timestamp: now - 4_000,
			});
			sessionManager.appendMessage(fauxAssistantMessage(`Old result ${"y".repeat(100_000)}`));
			sessionManager.appendMessage({
				role: "user",
				content: [{ type: "text", text: "Recent request" }],
				timestamp: now - 2_000,
			});
			sessionManager.appendMessage(fauxAssistantMessage("Recent result"));
			sessionManager.appendCustomEntry("goal-state", {
				goal: {
					id: crypto.randomUUID(),
					text: "finish after manual compaction",
					status: "active",
					startedAt: now - 1_000,
					updatedAt: now - 1_000,
					iteration: 1,
					tokensUsed: 0,
					timeUsedSeconds: 1,
					baselineTokens: 0,
				},
			});
		},
	);
	const events = [];
	const unsubscribe = harness.session.subscribe((event) => events.push(event));
	try {
		await harness.session.compact("Summarize for the runtime smoke test.");
		await waitFor(
			() => harness.faux.state.callCount === 3,
			`manual-compaction continuation (${JSON.stringify({
				callCount: harness.faux.state.callCount,
				goalStatus: persistedGoalStatus(harness.session),
				isIdle: harness.session.isIdle,
				events: events.map((event) => event.type),
				extensions: harness.extensions,
				lifecycleEvents: harness.lifecycleEvents,
			})})`,
		);
		await harness.session.agent.waitForIdle();
		assert.equal(persistedGoalStatus(harness.session), null);
		assert.ok(harness.session.messages.map(storedPromptText).some((text) => text.includes("pi-goal-continuation:")));
	} finally {
		unsubscribe();
		await harness.cleanup();
	}
}

function runScenarios(scenarios) {
	for (const [name, scenario] of scenarios) {
		test(`goal runtime smoke: ${name}`, scenario, { timeout: 120_000 });
	}
}

runScenarios([
	["agent directory isolation", agentDirectoryIsolationScenario],
	["normal continuation", normalContinuationScenario],
	["strict blocker audit", strictBlockerAuditScenario],
	["runaway no-progress", runawayNoProgressScenario],
	["automatic tool-loop limit", automaticToolLoopLimitScenario],
	["retry at hard limit", retryAtHardLimitScenario],
	["automatic retry ownership", automaticRetryOwnershipScenario],
	["exhausted retry continuation", exhaustedRetryContinuesScenario],
	["ordered queue", orderedQueueScenario],
	["queued input", queuedInputScenario],
	["busy edit ownership", busyEditOwnershipScenario],
	["pause", pauseScenario],
	["reload resume", reloadResumeScenario],
	["frozen queue guard", frozenQueueBlockedToolAbortScenario],
	["stale paused-tool guard", stalePausedToolAbortScenario],
	["budget boundary", budgetBoundaryScenario],
	["terminal budget mixed batch", terminalBudgetMixedBatchScenario],
	["budget violation", budgetViolationScenario],
	["budget agent-end fallback", budgetAgentEndFallbackScenario],
	["managed run RPC", managedRunRpcScenario],
	["managed run disabled", managedRunDisabledScenario],
	["manual compaction", manualCompactionScenario],
]);
