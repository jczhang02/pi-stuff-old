import assert from "node:assert/strict";
import test from "node:test";
import type { GoalStateEntryData } from "../../../packages/pi-stuff/src/goal/src/persistence.js";
import {
	assistantUsageEntry,
	blockedTool,
	completionReport,
	completionTool,
	createHarness,
	lastState,
	settled,
	stateGoals,
	storedGoal,
} from "../../goal-upstream/goal-queue-support.js";
import { goalStatusSnapshot } from "../../goal-upstream/support.js";

test("busy prioritize preserves intent and excludes old-run tokens from the urgent goal", async () => {
	const branch: unknown[] = [assistantUsageEntry(100)];
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	branch.push(assistantUsageEntry(40));
	await harness.command("prioritize urgent goal");
	branch.push(assistantUsageEntry(30));
	await harness.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, harness.ctx);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 70);

	idle = true;
	await settled(harness);
	const goals = stateGoals(harness.mock);
	assert.equal(goals[0]?.text, "urgent goal");
	assert.equal(goals[0]?.iteration, 0);
	assert.equal(goals[0]?.tokensUsed, 0);
	assert.equal(goals[1]?.text, "original goal");
	assert.equal(goals[1]?.tokensUsed, 70);
});

test("pending prioritize does not inject or account the old goal on unrelated turns", async () => {
	const branch: unknown[] = [assistantUsageEntry(100)];
	let aborts = 0;
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		abort: () => {
			aborts += 1;
		},
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	await harness.command("prioritize urgent goal");

	const beforeStart = harness.mock.events.get("before_agent_start")?.[0];
	const result = await beforeStart?.({ prompt: "unrelated user work", systemPrompt: "base" }, harness.ctx);
	assert.equal(result, undefined);
	assert.equal(aborts, 0);
	branch.push(assistantUsageEntry(25));

	await harness.mock.callEvent("tool_execution_end", {}, harness.ctx);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);
	await harness.mock.callEvent("session_before_compact", { reason: "threshold", willRetry: false }, harness.ctx);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);
	await harness.mock.callEvent("session_compact", { reason: "threshold", willRetry: false }, harness.ctx);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);
	await harness.command("");
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);

	await harness.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, harness.ctx);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status, tokensUsed }) => ({ text, status, tokensUsed })),
		[
			{ text: "urgent goal", status: "active", tokensUsed: 0 },
			{ text: "original goal", status: "queued", tokensUsed: 0 },
		],
	);
});

test("pending prioritize excludes unrelated usage during shutdown", async () => {
	const branch: unknown[] = [assistantUsageEntry(100)];
	const harness = await createHarness({
		isIdle: () => false,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	await harness.command("prioritize urgent goal");
	await harness.mock.callEvent(
		"before_agent_start",
		{ prompt: "unrelated user work", systemPrompt: "base" },
		harness.ctx,
	);
	branch.push(assistantUsageEntry(25));

	await harness.mock.emitHostEvent("session_shutdown", {}, harness.ctx);
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 0);
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");

	const persisted = lastState(harness.mock);
	const restoredBranch = [...branch, { type: "custom", customType: "goal-state", data: persisted }];
	let restoredIdle = false;
	const restored = await createHarness({
		isIdle: () => restoredIdle,
		sessionManager: {
			getBranch: () => restoredBranch,
			getEntries: () => restoredBranch,
		},
	});
	await restored.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, restored.ctx);
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status, tokensUsed, iteration }) => ({
			text,
			status,
			tokensUsed,
			iteration,
		})),
		[{ text: "original goal", status: "active", tokensUsed: 0, iteration: 0 }],
	);
	assert.equal(lastState(restored.mock)?.pendingAction?.kind, "prioritize");

	restoredIdle = true;
	await settled(restored);
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status, tokensUsed }) => ({ text, status, tokensUsed })),
		[
			{ text: "urgent goal", status: "active", tokensUsed: 0 },
			{ text: "original goal", status: "queued", tokensUsed: 0 },
		],
	);
});

test("pending prioritize preserves budget wrap-up completion ownership", async () => {
	const branch: unknown[] = [assistantUsageEntry(0)];
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("--tokens 10 budgeted goal");
	const budgeted = stateGoals(harness.mock)[0];
	assert.ok(budgeted);
	branch.push(assistantUsageEntry(12));
	await harness.mock.callEvent("tool_execution_end", {}, harness.ctx);
	assert.equal(stateGoals(harness.mock)[0]?.status, "budget_limited");
	await harness.command("prioritize urgent goal");
	await harness.mock.callEvent("before_agent_start", { prompt: "budget wrap-up", systemPrompt: "base" }, harness.ctx);

	const result = await completionTool(harness.mock).execute(
		"budget-wrap-completion",
		completionReport(budgeted.id, "Budgeted goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(result.content?.[0]?.text ?? "", /^Goal complete:/);
	assert.equal(result.terminate, true);

	await harness.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse" }] }, harness.ctx);
	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "urgent goal", status: "active" }],
	);
});

test("pending priority lets an unfinished budget wrap-up close at agent_end", async () => {
	const branch: unknown[] = [assistantUsageEntry(0)];
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("--tokens 10 budgeted goal");
	branch.push(assistantUsageEntry(12));
	await harness.mock.callEvent("tool_execution_end", {}, harness.ctx);
	await harness.command("prioritize urgent goal");
	await harness.mock.callEvent("before_agent_start", { prompt: "budget wrap-up", systemPrompt: "base" }, harness.ctx);

	await harness.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, harness.ctx);
	const toolGate = await harness.mock.callEvent(
		"tool_call",
		{ toolName: "bash", input: { command: "pwd" } },
		harness.ctx,
	);
	assert.equal(toolGate, undefined);

	idle = true;
	await settled(harness);
	assert.equal(stateGoals(harness.mock)[0]?.text, "urgent goal");
});

test("pending prioritize preserves Pi-owned retry turns", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("recovering goal");
	const recovering = stateGoals(harness.mock)[0];
	const ownedPrompt = harness.mock.sentUserMessages.at(-1)?.text;
	assert.ok(recovering);
	assert.ok(ownedPrompt);
	const beforeStart = harness.mock.events.get("before_agent_start")?.[0];
	await beforeStart?.({ prompt: ownedPrompt, systemPrompt: "base" }, harness.ctx);
	await harness.command("prioritize urgent goal");
	await harness.mock.callEvent(
		"agent_end",
		{
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "rate limit; please retry" }],
		},
		harness.ctx,
	);

	// Certified Pi Host provider retries continue the existing Agent directly:
	// they emit agent_start, not a new before_agent_start prompt boundary.
	await harness.mock.callEvent("agent_start", {}, harness.ctx);
	const completed = await completionTool(harness.mock).execute(
		"retry-completion",
		completionReport(recovering.id, "Recovering goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(completed.content?.[0]?.text ?? "", /^Goal complete:/);

	await harness.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse" }] }, harness.ctx);
	idle = true;
	await settled(harness);
	assert.equal(stateGoals(harness.mock)[0]?.text, "urgent goal");
});

test("exhausted retry stays resumable before pending priority dispatches at settlement", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("recovering goal");
	const ownedPrompt = harness.mock.sentUserMessages.at(-1)?.text;
	assert.ok(ownedPrompt);
	await harness.mock.callEvent("before_agent_start", { prompt: ownedPrompt, systemPrompt: "base" }, harness.ctx);
	await harness.command("prioritize urgent goal");
	await harness.mock.callEvent(
		"agent_end",
		{
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "HTTP 524 upstream timeout" }],
		},
		harness.ctx,
	);

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "recovering goal", status: "queued" },
		],
	);
});

test("extension input cannot claim a pending Pi retry under priority", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("recovering goal");
	const recovering = stateGoals(harness.mock)[0];
	const ownedPrompt = harness.mock.sentUserMessages.at(-1)?.text;
	assert.ok(recovering);
	assert.ok(ownedPrompt);
	const beforeStart = harness.mock.events.get("before_agent_start")?.[0];
	await beforeStart?.({ prompt: ownedPrompt, systemPrompt: "base" }, harness.ctx);
	await harness.command("prioritize urgent goal");
	await harness.mock.callEvent(
		"agent_end",
		{
			messages: [{ role: "assistant", stopReason: "error", errorMessage: "rate limit; please retry" }],
		},
		harness.ctx,
	);
	await harness.mock.callEvent("input", { source: "extension", text: "unrelated extension work" }, harness.ctx);

	const unrelatedStart = await beforeStart?.(
		{ prompt: "unrelated extension work", systemPrompt: "base" },
		harness.ctx,
	);
	assert.equal(unrelatedStart, undefined);
	const staleCompletion = await completionTool(harness.mock).execute(
		"extension-stale-completion",
		completionReport(recovering.id, "Recovering goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(staleCompletion.content?.[0]?.text ?? "", /does not own the active goal/i);

	await harness.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, harness.ctx);
	idle = true;
	await settled(harness);
	assert.equal(stateGoals(harness.mock)[0]?.text, "urgent goal");
});

test("pending prioritize rejects terminal reports from unrelated turns", async () => {
	const harness = await createHarness({ isIdle: () => false });
	await harness.command("original goal");
	const original = stateGoals(harness.mock)[0];
	assert.ok(original);
	await harness.command("prioritize urgent goal");
	await harness.mock.callEvent(
		"before_agent_start",
		{ prompt: "unrelated user work", systemPrompt: "base" },
		harness.ctx,
	);

	const result = await completionTool(harness.mock).execute(
		"unowned-completion",
		completionReport(original.id, "Original goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(result.content?.[0]?.text ?? "", /does not own the active goal/i);
	assert.equal(result.terminate, undefined);

	const blocked = await blockedTool(harness.mock).execute(
		"unowned-blocked",
		{
			goal_id: original.id,
			reason: "External access required",
			attempt: "Requested access through the queued goal's configured remote.",
			evidence: "Three verified attempts require external access.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.match(blocked.content?.[0]?.text ?? "", /does not own the active goal/i);
	assert.equal(blocked.terminate, undefined);
	assert.equal(stateGoals(harness.mock)[0]?.status, "active");
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");
});

test("failed finalized priority activation pauses without absorbing unrelated usage", async () => {
	const branch: unknown[] = [assistantUsageEntry(100)];
	let idle = false;
	const harness = await createHarness({
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	await harness.command("prioritize urgent goal");
	await harness.mock.callEvent(
		"before_agent_start",
		{ prompt: "unrelated user work", systemPrompt: "base" },
		harness.ctx,
	);
	branch.push(assistantUsageEntry(25));
	harness.mock.rawPi.setActiveTools(["goal_complete"]);

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status, tokensUsed }) => ({ text, status, tokensUsed })),
		[{ text: "original goal", status: "paused", tokensUsed: 0 }],
	);
	assert.equal(lastState(harness.mock)?.pendingAction, undefined);
});

test("pending prioritize consumes an accepted displaced-goal prompt before startup", async () => {
	let aborts = 0;
	const harness = await createHarness({
		isIdle: () => false,
		abort: () => {
			aborts += 1;
		},
	});
	await harness.command("original goal");
	const displacedPrompt = harness.mock.sentUserMessages.at(-1)?.text;
	assert.ok(displacedPrompt);
	await harness.command("prioritize urgent goal");

	const result = await harness.mock.callEvent("input", { source: "extension", text: displacedPrompt }, harness.ctx);
	assert.deepEqual(result, { action: "handled" });
	assert.equal(aborts, 0);
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");
});

test("a completed head is dropped when a busy prioritize intent wins", async () => {
	let idle = false;
	const harness = await createHarness({ isIdle: () => idle });
	await harness.command("finishing goal");
	await harness.command("add later goal");
	await harness.command("prioritize urgent goal");
	const finishing = stateGoals(harness.mock)[0];
	assert.ok(finishing);

	await completionTool(harness.mock).execute(
		"complete-before-priority",
		completionReport(finishing.id, "Finishing goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	assert.equal(lastState(harness.mock)?.pendingAction?.kind, "prioritize");

	idle = true;
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "later goal", status: "queued" },
		],
	);
});

test("restored exhausted queued heads remain budget-limited without a kickoff prompt", async () => {
	const exhausted = {
		...storedGoal("exhausted queued head", "queued"),
		tokenBudget: 10,
		tokensUsed: 10,
	};
	const state: GoalStateEntryData = { goal: exhausted };
	const branch = [{ type: "custom", customType: "goal-state", data: state }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});

	assert.equal(restored.mock.sentUserMessages.length, 0);
	assert.equal(stateGoals(restored.mock)[0]?.status, "budget_limited");
	assert.deepEqual(goalStatusSnapshot(restored.mock.pi), {
		status: "budget_limited",
		timeUsedSeconds: 0,
		tokenBudget: 10,
		tokensUsed: 10,
	});
});

test("pending priority survives reload after the displaced head completes", async () => {
	const interrupted = await createHarness({ isIdle: () => false });
	await interrupted.command("finishing goal");
	await interrupted.command("add later goal");
	await interrupted.command("prioritize urgent goal");
	const finishing = stateGoals(interrupted.mock)[0];
	assert.ok(finishing);
	await completionTool(interrupted.mock).execute(
		"complete-before-reload",
		completionReport(finishing.id, "Finishing goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		interrupted.ctx,
	);
	const persisted = lastState(interrupted.mock);
	assert.equal(persisted?.goal?.status, "complete");
	assert.equal(persisted?.pendingAction?.kind, "prioritize");

	const branch = [{ type: "custom", customType: "goal-state", data: persisted }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "later goal", status: "queued" },
		],
	);
});

test("completed head retains pending priority when terminal tools are temporarily unavailable", async () => {
	let idle = false;
	const interrupted = await createHarness({ isIdle: () => idle });
	await interrupted.command("finishing goal");
	await interrupted.command("add later goal");
	await interrupted.command("prioritize urgent goal");
	const finishing = stateGoals(interrupted.mock)[0];
	assert.ok(finishing);
	await completionTool(interrupted.mock).execute(
		"complete-before-tool-policy",
		completionReport(finishing.id, "Finishing goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		interrupted.ctx,
	);

	interrupted.mock.rawPi.setActiveTools(["goal_complete"]);
	idle = true;
	await settled(interrupted);
	const retained = lastState(interrupted.mock);
	assert.equal(retained?.goal?.status, "complete");
	assert.equal(retained?.pendingAction?.kind, "prioritize");

	const branch = [{ type: "custom", customType: "goal-state", data: retained }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text }) => text),
		["urgent goal", "later goal"],
	);
});

test("pending prioritize survives abrupt reload and starts before the displaced head", async () => {
	const interrupted = await createHarness({ isIdle: () => false });
	await interrupted.command("original goal");
	await interrupted.command("prioritize urgent goal");
	const persisted = lastState(interrupted.mock);
	assert.equal(persisted?.pendingAction?.kind, "prioritize");

	const branch = [{ type: "custom", customType: "goal-state", data: persisted }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "original goal", status: "queued" },
		],
	);
});

test("restored priority dispatches before the displaced head is budget-limited", async () => {
	const state: GoalStateEntryData = {
		goal: { ...storedGoal("budgeted head", "active"), tokenBudget: 10 },
		pendingAction: { kind: "prioritize", objective: "urgent goal" },
	};
	const branch = [assistantUsageEntry(12), { type: "custom", customType: "goal-state", data: state }];
	const restored = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});

	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "budgeted head", status: "queued" },
		],
	);
	assert.equal(lastState(restored.mock)?.pendingAction, undefined);
});

test("pending prioritize survives shutdown with independent accounting", async () => {
	const branch: unknown[] = [assistantUsageEntry(100)];
	const interrupted = await createHarness({
		isIdle: () => false,
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await interrupted.command("original goal");
	branch.push(assistantUsageEntry(25));
	await interrupted.command("prioritize urgent goal");
	await interrupted.mock.emitHostEvent("session_shutdown", {}, interrupted.ctx);
	const persisted = lastState(interrupted.mock);
	assert.equal(persisted?.pendingAction?.kind, "prioritize");
	assert.equal(persisted?.goal?.tokensUsed, 25);

	const restoredBranch = [
		assistantUsageEntry(100),
		assistantUsageEntry(25),
		{ type: "custom", customType: "goal-state", data: persisted },
	];
	const restored = await createHarness({
		sessionManager: { getBranch: () => restoredBranch, getEntries: () => restoredBranch },
	});
	assert.deepEqual(
		stateGoals(restored.mock).map(({ text, status }) => ({ text, status })),
		[
			{ text: "urgent goal", status: "active" },
			{ text: "original goal", status: "queued" },
		],
	);
	assert.equal(stateGoals(restored.mock)[1]?.tokensUsed, 25);
});

test("stopped displaced goals remain stopped after the priority goal completes", async () => {
	const harness = await createHarness();
	await harness.command("paused original");
	await harness.command("pause");
	await harness.command("prioritize urgent fix");
	const urgent = stateGoals(harness.mock)[0];
	assert.ok(urgent);
	const promptsBeforeCompletion = harness.mock.sentUserMessages.length;

	await completionTool(harness.mock).execute(
		"complete-urgent",
		completionReport(urgent.id, "Urgent fix completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	await settled(harness);
	assert.deepEqual(
		stateGoals(harness.mock).map(({ text, status }) => ({ text, status })),
		[{ text: "paused original", status: "paused" }],
	);
	assert.equal(harness.mock.sentUserMessages.length, promptsBeforeCompletion);
});

test("resumed displaced goals exclude tokens spent on the priority goal", async () => {
	const branch: unknown[] = [assistantUsageEntry(100)];
	const harness = await createHarness({
		sessionManager: { getBranch: () => branch, getEntries: () => branch },
	});
	await harness.command("original goal");
	branch.push(assistantUsageEntry(40));
	await harness.command("pause");
	await harness.command("prioritize urgent goal");
	const urgent = stateGoals(harness.mock)[0];
	assert.ok(urgent);
	branch.push(assistantUsageEntry(30));
	await completionTool(harness.mock).execute(
		"complete-priority-accounting",
		completionReport(urgent.id, "Priority goal completed and verified."),
		new AbortController().signal,
		() => undefined,
		harness.ctx,
	);
	await settled(harness);
	await harness.command("resume");
	branch.push(assistantUsageEntry(10));
	await harness.command("");
	assert.equal(stateGoals(harness.mock)[0]?.tokensUsed, 50);
});
