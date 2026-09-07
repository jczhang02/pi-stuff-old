import assert from "node:assert/strict";
import test from "node:test";
import {
	assistantUsageEntry,
	completionReport,
	createGoalHarness,
	findPersistedGoal,
	goalStateData,
	goalStatusSnapshot,
	goalToolText,
	lastGoal,
	lastGoalStatus,
	primeBlockerAudit,
	requireGoalTool,
	requireLastGoal,
	STALE_GOAL_TOOL_REASON,
} from "../../goal-upstream/goal-test-support.js";

test("parent and child goal tool unlock policies stay isolated", async () => {
	const [root, rootContext] = await createGoalHarness(["read", "bash"], "after-first-goal");
	await root.commands.get("goal")?.handler("parent objective", rootContext.ctx);
	assert.deepEqual(root.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);

	const [child, childContext] = await createGoalHarness(
		["read", "bash", "goal_complete", "goal_blocked"],
		"after-first-goal",
	);
	assert.deepEqual(child.rawPi.getActiveTools(), ["read", "bash"]);
	assert.deepEqual(root.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);

	await child.commands.get("goal")?.handler("child objective", childContext.ctx);
	assert.deepEqual(child.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);
	await child.commands.get("goal")?.handler("clear", childContext.ctx);
	assert.deepEqual(root.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);
});

test("child session initialization does not erase or reroute the parent goal", async () => {
	const rootBranch: unknown[] = [];
	const [root, rootContext] = await createGoalHarness([], "always", {
		sessionManager: { getBranch: () => rootBranch, getEntries: () => rootBranch },
	});
	await root.commands.get("goal")?.handler("parent objective", rootContext.ctx);

	const rootGoal = requireLastGoal(root);
	rootBranch.push({
		type: "custom",
		customType: "goal-state",
		data: { goal: rootGoal },
	});
	const rootCompletion = requireGoalTool(root, "goal_complete");
	const rootEntriesBeforeChild = root.entries.length;

	const [child, _childContext] = await createGoalHarness([], "always", {
		sessionManager: { getBranch: () => [], getEntries: () => [] },
	});

	// Empty-child startup must not claim the parent goal or append any snapshot of it.
	assert.equal(lastGoalStatus(child), null);
	assert.equal(child.entries.filter((entry) => entry.customType === "goal-state").length, 0);
	assert.equal(requireLastGoal(root).id, rootGoal.id);
	assert.equal(lastGoalStatus(root), "active");

	const result = await rootCompletion.execute(
		"root-completion",
		completionReport(rootGoal.id, "Verified the parent Goal completion against current state."),
		new AbortController().signal,
		() => undefined,
		rootContext.ctx,
	);

	assert.match(
		goalToolText(result),
		/^Goal complete: Verified the parent Goal completion against current state\.[\s\S]*Send the user a concise final response now/u,
	);
	assert.equal(result.terminate, undefined);
	assert.equal(result.details?.goal, rootGoal.text);
	assert.equal(result.details?.goal_id, rootGoal.id);

	const rootGoalStates = root.entries
		.slice(rootEntriesBeforeChild)
		.filter((entry) => entry.customType === "goal-state")
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		.map((entry) => goalStateData(entry.data));
	assert.equal(rootGoalStates.length, 2);
	assert.equal(rootGoalStates[0]?.goal?.status, "complete");
	assert.equal(rootGoalStates[0]?.goal?.id, rootGoal.id);
	assert.equal(rootGoalStates[0]?.goal?.text, rootGoal.text);
	assert.deepEqual(rootGoalStates[1], { goal: null });
	assert.equal(lastGoalStatus(root), null);

	const childGoalStates = child.entries.filter((entry) => entry.customType === "goal-state");
	assert.equal(childGoalStates.length, 0);
	assert.equal(
		childGoalStates.some(
			// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
			(entry) => goalStateData(entry.data).goal?.id === rootGoal.id,
		),
		false,
	);
});

test("independent goal instances keep distinct concurrent active goals", async () => {
	const [root, rootContext] = await createGoalHarness();
	await root.commands.get("goal")?.handler("root objective", rootContext.ctx);

	const [child, childContext] = await createGoalHarness();
	await child.commands.get("goal")?.handler("child objective", childContext.ctx);

	const rootGoal = requireLastGoal(root);
	const childGoal = requireLastGoal(child);
	assert.notEqual(rootGoal.id, childGoal.id);
	assert.equal(rootGoal.text, "root objective");
	assert.equal(childGoal.text, "child objective");
	assert.equal(lastGoalStatus(root), "active");
	assert.equal(lastGoalStatus(child), "active");
	assert.equal(goalStatusSnapshot(root.pi)?.status, "active");
	assert.equal(goalStatusSnapshot(child.pi)?.status, "active");

	root.emitHostEvent("session_shutdown", {}, rootContext.ctx);
	child.emitHostEvent("session_shutdown", {}, childContext.ctx);
});

test("independent goal instances keep completion local", async () => {
	const [root, rootContext] = await createGoalHarness();
	await root.commands.get("goal")?.handler("root objective", rootContext.ctx);

	const [child, childContext] = await createGoalHarness();
	await child.commands.get("goal")?.handler("child objective", childContext.ctx);

	const rootGoal = requireLastGoal(root);
	const childGoal = requireLastGoal(child);
	const rootEntriesBefore = root.entries.length;
	const childEntriesBefore = child.entries.length;

	const result = await requireGoalTool(root, "goal_complete").execute(
		"root-completion",
		completionReport(rootGoal.id, "The root Goal work was completed and verified."),
		new AbortController().signal,
		() => undefined,
		rootContext.ctx,
	);

	assert.equal(result.terminate, undefined);
	assert.equal(result.details?.goal, rootGoal.text);
	assert.equal(result.details?.goal_id, rootGoal.id);

	const rootCompletion = findPersistedGoal(root, "complete");
	assert.ok(rootCompletion);
	assert.equal(rootCompletion.id, rootGoal.id);
	assert.equal(rootCompletion.text, rootGoal.text);
	assert.deepEqual(lastGoal(root), null);
	assert.equal(lastGoalStatus(root), null);

	const rootGoalStates = root.entries
		.slice(rootEntriesBefore)
		.filter((entry) => entry.customType === "goal-state")
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		.map((entry) => goalStateData(entry.data));
	assert.equal(rootGoalStates.length, 2);
	assert.equal(rootGoalStates[0]?.goal?.status, "complete");
	assert.deepEqual(rootGoalStates[1], { goal: null });

	assert.equal(child.entries.length, childEntriesBefore);
	assert.equal(lastGoalStatus(child), "active");
	assert.equal(requireLastGoal(child).id, childGoal.id);
	assert.equal(requireLastGoal(child).text, childGoal.text);
	root.emitHostEvent("session_shutdown", {}, rootContext.ctx);
	child.emitHostEvent("session_shutdown", {}, childContext.ctx);
});

test("tool lifecycle persistence stays on the owning goal instance", async () => {
	const rootBranch: unknown[] = [assistantUsageEntry({ totalTokens: 1 })];
	const [root, rootContext] = await createGoalHarness([], "always", {
		sessionManager: { getBranch: () => rootBranch, getEntries: () => rootBranch },
	});
	await root.commands.get("goal")?.handler("root objective", rootContext.ctx);

	const childBranch: unknown[] = [assistantUsageEntry({ totalTokens: 2 })];
	const [child, childContext] = await createGoalHarness([], "always", {
		sessionManager: { getBranch: () => childBranch, getEntries: () => childBranch },
	});
	await child.commands.get("goal")?.handler("child objective", childContext.ctx);

	const rootGoal = requireLastGoal(root);
	const childGoal = requireLastGoal(child);
	const rootEntriesBefore = root.entries.length;
	const childEntriesBefore = child.entries.length;

	root.callEvent("tool_execution_end", {}, rootContext.ctx);
	assert.equal(root.entries.length, rootEntriesBefore + 1);
	assert.equal(child.entries.length, childEntriesBefore);
	const rootUpdated = requireLastGoal(root);
	assert.equal(rootUpdated.id, rootGoal.id);
	assert.equal(rootUpdated.text, "root objective");
	assert.equal(rootUpdated.status, "active");
	assert.equal(requireLastGoal(child).id, childGoal.id);
	assert.equal(requireLastGoal(child).text, "child objective");

	child.callEvent("tool_execution_end", {}, childContext.ctx);
	assert.equal(root.entries.length, rootEntriesBefore + 1);
	assert.equal(child.entries.length, childEntriesBefore + 1);
	const childUpdated = requireLastGoal(child);
	assert.equal(childUpdated.id, childGoal.id);
	assert.equal(childUpdated.text, "child objective");
	assert.equal(childUpdated.status, "active");
	assert.equal(requireLastGoal(root).id, rootGoal.id);
	assert.equal(requireLastGoal(root).text, "root objective");
	root.emitHostEvent("session_shutdown", {}, rootContext.ctx);
	child.emitHostEvent("session_shutdown", {}, childContext.ctx);
});

test("goal_blocked ownership stays on the root instance after child start", async () => {
	const [root, rootContext] = await createGoalHarness();
	await root.commands.get("goal")?.handler("root objective", rootContext.ctx);
	const rootGoal = requireLastGoal(root);
	const rootBlocker = requireGoalTool(root, "goal_blocked");
	primeBlockerAudit(rootGoal, "Need offline hardware access that remains unavailable");
	const rootEntriesBeforeChild = root.entries.length;

	const [child, childContext] = await createGoalHarness();
	assert.equal(lastGoalStatus(child), null);

	const result = await rootBlocker.execute(
		"root-block",
		{
			goal_id: rootGoal.id,
			reason: "Need offline hardware access that remains unavailable",
			attempt: "Tested the offline hardware signer through the recovery USB path.",
			evidence: "The recovery USB path returned the same unavailable hardware signer error.",
			repeated_turns: 3,
		},
		new AbortController().signal,
		() => undefined,
		rootContext.ctx,
	);

	assert.equal(result.terminate, undefined);
	assert.equal(result.details?.goal, rootGoal.text);
	assert.equal(result.details?.goal_id, rootGoal.id);
	assert.match(goalToolText(result), /Goal blocked:[\s\S]*Send the user a concise final response now/iu);

	const rootBlocked = findPersistedGoal(root, "blocked");
	assert.ok(rootBlocked);
	assert.equal(rootBlocked.id, rootGoal.id);
	assert.equal(rootBlocked.text, rootGoal.text);
	assert.equal(lastGoalStatus(root), "blocked");
	assert.ok(root.entries.length > rootEntriesBeforeChild);
	assert.equal(child.entries.filter((entry) => entry.customType === "goal-state").length, 0);
	assert.equal(lastGoalStatus(child), null);
	root.emitHostEvent("session_shutdown", {}, rootContext.ctx);
	child.emitHostEvent("session_shutdown", {}, childContext.ctx);
});

test("pending continuation and budget state survive later child startup", async () => {
	const rootBranch: unknown[] = [assistantUsageEntry({ totalTokens: 0 })];
	const [root, rootContext] = await createGoalHarness([], "always", {
		sessionManager: { getBranch: () => rootBranch, getEntries: () => rootBranch },
	});
	await root.commands.get("goal")?.handler("--tokens 1 root objective", rootContext.ctx);
	const rootGoal = requireLastGoal(root);
	const rootUserMessagesBefore = root.sentUserMessages.length;

	// Record the parent continuation before the child starts. Child session_start must not
	// clear an already-pending continuation or reroute its eventual delivery.
	await root.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, rootContext.ctx);
	const [child, childContext] = await createGoalHarness();
	await root.callEvent("agent_settled", {}, rootContext.ctx);
	assert.equal(root.sentUserMessages.length, rootUserMessagesBefore + 1);
	const staleContinuation = root.sentUserMessages.at(-1)?.text ?? "";
	assert.match(staleContinuation, new RegExp(`<!-- pi-goal-continuation:${rootGoal.id}:`));
	assert.equal(child.sentUserMessages.length, 0);

	// Establish the parent budget wrap-up before another child starts. Its context marker
	// must remain authorized by the parent runtime after that later child session_start.
	rootBranch.push(assistantUsageEntry({ totalTokens: 5 }));
	await root.callEvent("tool_execution_end", {}, rootContext.ctx);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(lastGoalStatus(root), "budget_limited");
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const wrapUp = root.sentMessages.at(-1)?.message as {
		customType?: string;
		details?: { goalId?: string };
	};
	assert.equal(wrapUp?.customType, "goal-budget-wrap-up");
	assert.equal(wrapUp?.details?.goalId, rootGoal.id);

	const [laterChild, laterChildContext] = await createGoalHarness();
	const contextMessages = [
		{ role: "custom", customType: wrapUp.customType, details: wrapUp.details },
		{ role: "user", content: "continue" },
	];
	assert.equal(root.callEvent("context", { messages: contextMessages }, rootContext.ctx), undefined);
	assert.equal(child.sentMessages.length, 0);
	assert.equal(laterChild.sentMessages.length, 0);
	assert.equal(lastGoalStatus(child), null);
	assert.equal(lastGoalStatus(laterChild), null);
	assert.deepEqual(root.callEvent("input", { source: "extension", text: staleContinuation }, rootContext.ctx), {
		action: "handled",
	});
	assert.equal(
		laterChild.callEvent("input", { source: "extension", text: staleContinuation }, laterChildContext.ctx),
		undefined,
	);

	root.emitHostEvent("session_shutdown", {}, rootContext.ctx);
	child.emitHostEvent("session_shutdown", {}, childContext.ctx);
	laterChild.emitHostEvent("session_shutdown", {}, laterChildContext.ctx);
});

test("stale tool guard survives later child startup", async () => {
	const [root, rootContext] = await createGoalHarness();
	await root.commands.get("goal")?.handler("root objective", rootContext.ctx);
	await root.commands.get("goal")?.handler("pause", rootContext.ctx);

	const [child, childContext] = await createGoalHarness();
	const rootToolCall = root.events.get("tool_call")?.[0];
	assert.deepEqual(rootToolCall?.({ toolName: "bash", toolCallId: "root-stale", input: {} }, rootContext.ctx), {
		block: true,
		reason: STALE_GOAL_TOOL_REASON,
	});
	assert.equal(
		child.callEvent("tool_call", { toolName: "bash", toolCallId: "child-fresh", input: {} }, childContext.ctx),
		undefined,
	);

	child.emitHostEvent("session_shutdown", {}, childContext.ctx);
	assert.deepEqual(
		rootToolCall?.({ toolName: "bash", toolCallId: "root-stale-after-shutdown", input: {} }, rootContext.ctx),
		{ block: true, reason: STALE_GOAL_TOOL_REASON },
	);
	assert.equal(lastGoalStatus(root), "paused");
	assert.equal(lastGoalStatus(child), null);
	root.emitHostEvent("session_shutdown", {}, rootContext.ctx);
});

test("pending compaction recovery survives later child startup", async () => {
	const [root, rootContext] = await createGoalHarness();
	await root.commands.get("goal")?.handler("root objective", rootContext.ctx);
	requireLastGoal(root);
	const rootUserMessagesBefore = root.sentUserMessages.length;

	await root.callEvent(
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
		rootContext.ctx,
	);

	const [child, childContext] = await createGoalHarness();
	root.callEvent("session_before_compact", {}, rootContext.ctx);
	await root.callEvent("session_compact", {}, rootContext.ctx);
	root.callEvent("agent_start", {}, rootContext.ctx);
	await root.callEvent(
		"agent_end",
		{ messages: [{ role: "assistant", stopReason: "stop", content: [] }] },
		rootContext.ctx,
	);
	await root.callEvent("agent_settled", {}, rootContext.ctx);
	assert.equal(root.sentUserMessages.length, rootUserMessagesBefore + 1);
	assert.equal(child.sentUserMessages.length, 0);
	assert.equal(lastGoalStatus(root), "active");
	assert.equal(lastGoalStatus(child), null);

	root.emitHostEvent("session_shutdown", {}, rootContext.ctx);
	child.emitHostEvent("session_shutdown", {}, childContext.ctx);
});

test("completion status timer survives later child startup", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const [root, rootContext] = await createGoalHarness();
	await root.commands.get("goal")?.handler("root objective", rootContext.ctx);
	const rootGoal = requireLastGoal(root);
	await requireGoalTool(root, "goal_complete").execute(
		"root-completion",
		completionReport(rootGoal.id, "The root Goal work was completed and verified."),
		new AbortController().signal,
		() => undefined,
		rootContext.ctx,
	);
	assert.equal(goalStatusSnapshot(root.pi)?.status, "complete");

	const [child, childContext] = await createGoalHarness();
	t.mock.timers.tick(8_000);
	assert.equal(goalStatusSnapshot(root.pi), undefined);
	assert.equal(goalStatusSnapshot(child.pi), undefined);

	root.emitHostEvent("session_shutdown", {}, rootContext.ctx);
	child.emitHostEvent("session_shutdown", {}, childContext.ctx);
});

test("a new goal cancels the prior completion status timer", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const [mock, context] = await createGoalHarness();
	await mock.commands.get("goal")?.handler("first objective", context.ctx);
	const firstGoal = requireLastGoal(mock);
	await requireGoalTool(mock, "goal_complete").execute(
		"first-completion",
		completionReport(firstGoal.id, "The first Goal work was completed and verified."),
		new AbortController().signal,
		() => undefined,
		context.ctx,
	);

	await mock.commands.get("goal")?.handler("second objective", context.ctx);
	assert.equal(goalStatusSnapshot(mock.pi)?.status, "active");
	t.mock.timers.tick(8_000);
	assert.equal(goalStatusSnapshot(mock.pi)?.status, "active");

	mock.emitHostEvent("session_shutdown", {}, context.ctx);
});

test("child shutdown does not clear the parent goal", async () => {
	const [root, rootContext] = await createGoalHarness();
	await root.commands.get("goal")?.handler("root objective", rootContext.ctx);
	const rootGoal = requireLastGoal(root);
	const rootEntriesBeforeChild = root.entries.length;

	const [child, childContext] = await createGoalHarness();
	child.emitHostEvent("session_shutdown", {}, childContext.ctx);

	assert.equal(requireLastGoal(root).id, rootGoal.id);
	assert.equal(lastGoalStatus(root), "active");
	assert.equal(lastGoalStatus(child), null);
	assert.equal(child.entries.filter((entry) => entry.customType === "goal-state").length, 0);

	const result = await requireGoalTool(root, "goal_complete").execute(
		"root-completion-after-child-shutdown",
		completionReport(rootGoal.id, "Root work verified after child shutdown."),
		new AbortController().signal,
		() => undefined,
		rootContext.ctx,
	);

	assert.equal(result.terminate, undefined);
	assert.equal(result.details?.goal, rootGoal.text);
	assert.equal(result.details?.goal_id, rootGoal.id);

	const rootGoalStates = root.entries
		.slice(rootEntriesBeforeChild)
		.filter((entry) => entry.customType === "goal-state")
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		.map((entry) => goalStateData(entry.data));
	assert.equal(rootGoalStates.length, 2);
	assert.equal(rootGoalStates[0]?.goal?.status, "complete");
	assert.equal(rootGoalStates[0]?.goal?.id, rootGoal.id);
	assert.deepEqual(rootGoalStates[1], { goal: null });
	assert.equal(lastGoalStatus(root), null);
	assert.equal(child.entries.length, 0);
	root.emitHostEvent("session_shutdown", {}, rootContext.ctx);
});
