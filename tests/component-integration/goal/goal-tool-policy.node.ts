import assert from "node:assert/strict";
import test from "node:test";
import {
	assistantUsageEntry,
	createGoalHarness,
	createMockContext,
	createMockPi,
	lastGoalStatus,
	registerGoal,
	registerSuiteAgentMessagePreparation,
	requireLastGoal,
	restoreGoalForTest,
	type StoredGoal,
	startGoalForTest,
} from "../../goal-upstream/goal-test-support.js";

test("an active goal pauses without aborting an unrelated restrictive turn", async () => {
	let aborts = 0;
	const [mock, context] = await createGoalHarness(
		["read", "bash", "scrape", "goal_complete", "goal_blocked"],
		"after-first-goal",
		{ abort: () => aborts++ },
	);
	await mock.commands.get("goal")?.handler("finish the work", context.ctx);

	// Plan-mode style whole-set replacement drops goal tools and keeps unrelated ones.
	mock.rawPi.setActiveTools(["read", "bash", "scrape"]);
	const result = mock.callEvent("before_agent_start", { prompt: "continue work", systemPrompt: "base" }, context.ctx);
	assert.equal(result, undefined);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "scrape"]);
	assert.equal(lastGoalStatus(mock), "paused");
	assert.equal(aborts, 0);
	assert.equal(
		mock.callEvent("tool_call", { toolName: "read", toolCallId: "plan-read", input: {} }, context.ctx),
		undefined,
	);
	assert.match(context.notifications.at(-1)?.message ?? "", /goal tools.*paused/i);
});

test("missing goal tools abort an automatic continuation turn", async () => {
	let aborts = 0;
	const active = await startGoalForTest({ abort: () => aborts++ });
	await active.mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, active.ctx);
	await active.mock.callEvent("agent_settled", {}, active.ctx);
	const continuationPrompt = active.mock.sentUserMessages.at(-1)?.text ?? "";
	assert.match(continuationPrompt, /pi-goal-continuation:/);
	active.mock.rawPi.setActiveTools(["read", "bash"]);

	active.mock.callEvent("before_agent_start", { prompt: continuationPrompt, systemPrompt: "base" }, active.ctx);

	assert.equal(lastGoalStatus(active.mock), "paused");
	assert.equal(aborts, 1);
});

test("missing goal tools abort kickoff, resume, and active-edit prompts", async (t) => {
	await t.test("kickoff", async () => {
		let aborts = 0;
		const started = await startGoalForTest({ abort: () => aborts++ });
		const kickoffPrompt = started.mock.sentUserMessages.at(-1)?.text ?? "";
		started.mock.rawPi.setActiveTools(["read", "bash"]);

		started.mock.callEvent(
			"before_agent_start",
			{ prompt: `transformed by an earlier extension\n\n${kickoffPrompt}`, systemPrompt: "base" },
			started.ctx,
		);

		assert.equal(lastGoalStatus(started.mock), "paused");
		assert.equal(aborts, 1);
	});

	await t.test("resume", async () => {
		let aborts = 0;
		const resumed = await restoreGoalForTest("paused", {}, "always", { abort: () => aborts++ });
		await resumed.mock.commands.get("goal")?.handler("resume", resumed.ctx);
		const resumePrompt = resumed.mock.sentUserMessages.at(-1)?.text ?? "";
		resumed.mock.rawPi.setActiveTools(["read", "bash"]);

		resumed.mock.callEvent("before_agent_start", { prompt: resumePrompt, systemPrompt: "base" }, resumed.ctx);

		assert.equal(lastGoalStatus(resumed.mock), "paused");
		assert.equal(aborts, 1);
	});

	await t.test("active edit", async () => {
		let aborts = 0;
		const edited = await startGoalForTest({ abort: () => aborts++ });
		await edited.mock.commands.get("goal")?.handler("edit revised objective", edited.ctx);
		const editPrompt = edited.mock.sentUserMessages.at(-1)?.text ?? "";
		edited.mock.rawPi.setActiveTools(["read", "bash"]);

		edited.mock.callEvent("before_agent_start", { prompt: editPrompt, systemPrompt: "base" }, edited.ctx);

		assert.equal(lastGoalStatus(edited.mock), "paused");
		assert.equal(aborts, 1);
	});
});

test("a later restrictive tool policy pauses the goal at agent_end without continuation", async () => {
	const [mock, context] = await createGoalHarness(
		["read", "bash", "goal_complete", "goal_blocked"],
		"after-first-goal",
	);
	await mock.commands.get("goal")?.handler("finish the work", context.ctx);

	const promptResult = mock.callEvent(
		"before_agent_start",
		{ prompt: "continue work", systemPrompt: "base" },
		context.ctx,
	);
	assert.match(
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		String((promptResult as { message?: { content?: string } } | undefined)?.message?.content),
		/Active \/goal/,
	);
	mock.rawPi.setActiveTools(["read", "bash"]);
	mock.callEvent("agent_end", { messages: [{ role: "assistant", stopReason: "stop" }] }, context.ctx);
	mock.callEvent("agent_settled", {}, context.ctx);

	assert.equal(lastGoalStatus(mock), "paused");
	assert.equal(mock.sentUserMessages.length, 1);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
});

test("after-first-goal does not fight another extension that exposes locked tools", async () => {
	const [mock, context] = await createGoalHarness(
		["read", "bash", "goal_complete", "goal_blocked"],
		"after-first-goal",
	);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);

	mock.rawPi.setActiveTools(["read", "bash", "goal_complete", "goal_blocked", "scrape"]);
	mock.callEvent("before_agent_start", { prompt: "normal chat", systemPrompt: "base" }, context.ctx);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked", "scrape"]);
});

test("restored active goal applies budget limits before unavailable-tool pauses", async () => {
	for (const [tokensUsed, expectedStatus, expectedNotice] of [
		[5, "paused", /goal tools.*paused/i],
		[100, "budget_limited", /token budget reached/i],
	] as const) {
		const sessionGoal: StoredGoal = {
			id: `restored-without-tools-${tokensUsed}`,
			text: "restore safely",
			status: "active",
			startedAt: 1,
			updatedAt: 2,
			iteration: 3,
			tokenBudget: 100,
			tokensUsed,
			timeUsedSeconds: 4,
			baselineTokens: 0,
		};
		const branch = [
			{ type: "custom", customType: "goal-state", data: { goal: sessionGoal } },
			assistantUsageEntry({ totalTokens: tokensUsed }),
		];
		const mock = createMockPi();
		registerGoal(mock.pi, "after-first-goal");
		mock.rawPi.setActiveTools([]);
		const originalSetActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
		mock.rawPi.setActiveTools = (names: string[]) => {
			originalSetActiveTools(names.filter((name) => !name.startsWith("goal_")));
		};
		const context = createMockContext({
			sessionManager: { getBranch: () => branch, getEntries: () => branch },
		});

		await mock.callEvent("session_start", {}, context.ctx);

		assert.equal(lastGoalStatus(mock), expectedStatus);
		assert.equal(mock.sentUserMessages.length, 0);
		assert.match(context.notifications.at(-1)?.message ?? "", expectedNotice);
	}
});

test("always visibility respects a restrictive policy when starting a goal", async () => {
	const [mock, context] = await createGoalHarness();
	mock.rawPi.setActiveTools(["read", "bash"]);

	await mock.commands.get("goal")?.handler("finish the work", context.ctx);

	assert.equal(lastGoalStatus(mock), null);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
	assert.match(context.notifications.at(-1)?.message ?? "", /Cannot start \/goal/i);
});

test("after-first-goal does not widen a restrictive active turn", async () => {
	const [mock, context] = await createGoalHarness([], "after-first-goal", { isIdle: () => false });

	await mock.commands.get("goal")?.handler("finish the work", context.ctx);

	assert.equal(lastGoalStatus(mock), null);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.deepEqual(mock.rawPi.getActiveTools(), []);
	assert.match(context.notifications.at(-1)?.message ?? "", /wait until Pi is idle/i);
});

test("failed replacement activation pauses an existing active goal without terminal tools", async () => {
	const existing = await startGoalForTest();
	existing.mock.rawPi.setActiveTools(["read", "bash"]);

	await existing.mock.commands.get("goal")?.handler("replacement objective", existing.ctx);

	const restored = requireLastGoal(existing.mock);
	assert.equal(restored.status, "paused");
	assert.equal(restored.text, "finish");
	assert.equal(existing.mock.sentUserMessages.length, 1);
	assert.match(existing.notifications.at(-1)?.message ?? "", /goal tools.*paused/i);
});

test("start fails without committing a goal when goal tools cannot become active", async () => {
	const [mock, context] = await createGoalHarness(["read", "bash"], "after-first-goal");

	const originalSetActiveTools = mock.rawPi.setActiveTools.bind(mock.rawPi);
	mock.rawPi.setActiveTools = (names: string[]) => {
		// Simulate Pi accepting only one of the two required names.
		originalSetActiveTools(names.filter((name) => name !== "goal_blocked"));
	};

	await mock.commands.get("goal")?.handler("finish the work", context.ctx);
	assert.equal(lastGoalStatus(mock), null);
	assert.equal(mock.sentUserMessages.length, 0);
	assert.match(context.notifications.at(-1)?.message ?? "", /Cannot start \/goal/i);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);
});

test("failed first prompt delivery restores the locked tool set", async () => {
	const [mock, context] = await createGoalHarness(["read", "bash"], "after-first-goal");

	const sendUserMessage = mock.rawPi.sendUserMessage.bind(mock.rawPi);
	mock.rawPi.sendUserMessage = () => {
		throw new Error("delivery failed");
	};
	await mock.commands.get("goal")?.handler("finish the work", context.ctx);
	assert.equal(lastGoalStatus(mock), null);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash"]);

	mock.rawPi.sendUserMessage = sendUserMessage;
	await mock.commands.get("goal")?.handler("finish the work again", context.ctx);
	assert.equal(lastGoalStatus(mock), "active");
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);
});

test("failed first prompt delivery preserves a preexisting external goal-tool set", async () => {
	const [mock, context] = await createGoalHarness(
		["read", "bash", "goal_complete", "goal_blocked"],
		"after-first-goal",
	);
	// Another extension exposes both terminal tools while pi-goal remains locked.
	mock.rawPi.setActiveTools(["read", "goal_complete", "goal_blocked", "scrape"]);
	mock.rawPi.sendUserMessage = () => {
		throw new Error("delivery failed");
	};

	await mock.commands.get("goal")?.handler("finish the work", context.ctx);

	assert.equal(lastGoalStatus(mock), null);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "goal_complete", "goal_blocked", "scrape"]);
});

test("failed lazy reactivation deliveries restore the restrictive tool set", async (t) => {
	await t.test("stopped-goal replacement", async () => {
		const replaced = await restoreGoalForTest("paused", {}, "after-first-goal");
		const original = requireLastGoal(replaced.mock);
		replaced.mock.rawPi.setActiveTools(["read", "bash"]);
		replaced.mock.rawPi.sendUserMessage = () => {
			throw new Error("replacement delivery failed");
		};

		await replaced.mock.commands.get("goal")?.handler("replacement objective", replaced.ctx);

		assert.equal(requireLastGoal(replaced.mock).id, original.id);
		assert.equal(lastGoalStatus(replaced.mock), "paused");
		assert.deepEqual(replaced.mock.rawPi.getActiveTools(), ["read", "bash"]);
	});

	await t.test("resume", async () => {
		const resumed = await restoreGoalForTest("paused", {}, "after-first-goal");
		const original = requireLastGoal(resumed.mock);
		resumed.mock.rawPi.setActiveTools(["read", "bash"]);
		resumed.mock.rawPi.sendUserMessage = () => {
			throw new Error("resume delivery failed");
		};

		await resumed.mock.commands.get("goal")?.handler("resume", resumed.ctx);

		assert.equal(requireLastGoal(resumed.mock).id, original.id);
		assert.equal(lastGoalStatus(resumed.mock), "paused");
		assert.deepEqual(resumed.mock.rawPi.getActiveTools(), ["read", "bash"]);
	});

	await t.test("budget-increase edit", async () => {
		const edited = await restoreGoalForTest("budget_limited", {}, "after-first-goal");
		const original = requireLastGoal(edited.mock);
		edited.mock.rawPi.setActiveTools(["read", "bash"]);
		edited.mock.rawPi.sendUserMessage = () => {
			throw new Error("edit delivery failed");
		};

		await edited.mock.commands.get("goal")?.handler("edit --tokens 20 revised objective", edited.ctx);

		assert.equal(requireLastGoal(edited.mock).id, original.id);
		assert.equal(lastGoalStatus(edited.mock), "budget_limited");
		assert.deepEqual(edited.mock.rawPi.getActiveTools(), ["read", "bash"]);
	});
});

test("a stale first kickoff cannot run or roll back a newer replacement", async () => {
	let aborts = 0;
	const [mock, context] = await createGoalHarness(["read", "bash"], "after-first-goal", {
		abort: () => aborts++,
	});
	const sentPrompts: string[] = [];
	const firstSend = Promise.withResolvers<void>();
	mock.rawPi.sendUserMessage = (prompt: string) => {
		sentPrompts.push(prompt);
		if (sentPrompts.length === 1) return firstSend.promise;
	};

	const firstStart = mock.commands.get("goal")?.handler("first objective", context.ctx);
	await Promise.resolve();
	await mock.commands.get("goal")?.handler("replacement objective", context.ctx);
	const replacement = requireLastGoal(mock);
	assert.equal(replacement.text, "replacement objective");
	assert.equal(replacement.status, "active");

	assert.deepEqual(mock.callEvent("input", { source: "extension", text: sentPrompts[0] }, context.ctx), {
		action: "handled",
	});
	assert.equal(mock.callEvent("input", { source: "extension", text: sentPrompts[1] }, context.ctx), undefined);
	assert.equal(aborts, 0);
	assert.equal(requireLastGoal(mock).id, replacement.id);
	assert.equal(requireLastGoal(mock).status, "active");

	firstSend.reject(new Error("late first delivery failure"));
	await firstStart;
	assert.equal(requireLastGoal(mock).id, replacement.id);
	assert.deepEqual(mock.rawPi.getActiveTools(), ["read", "bash", "goal_complete", "goal_blocked"]);
});

test("a cleared Goal cannot deliver a kickoff still awaiting Suite preparation", async () => {
	const [mock, context] = await createGoalHarness(["goal_complete", "goal_blocked"]);
	const preparation = Promise.withResolvers<void>();
	const unregister = registerSuiteAgentMessagePreparation(mock.pi, { prepare: () => preparation.promise });

	const starting = mock.commands.get("goal")?.handler("stale objective", context.ctx);
	await Promise.resolve();
	await mock.commands.get("goal")?.handler("clear", context.ctx);
	preparation.resolve();
	await starting;

	assert.equal(lastGoalStatus(mock), null);
	assert.equal(mock.sentHiddenGoalMessages.length, 0);
	unregister();
});
