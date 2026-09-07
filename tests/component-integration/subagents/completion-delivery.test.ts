import { afterEach, expect, test } from "bun:test";
import {
	listenForGoalCoordinationQueries,
	readGoalCoordination,
	registerSuiteAgentMessagePreparation,
} from "../../../packages/pi-stuff/src/conversation-ui/index.js";
import { SUBAGENT_ASYNC_STARTED_EVENT } from "../../../packages/pi-stuff/src/subagents/src/shared/types.js";
import {
	cleanupExtensionRootFixtures,
	context,
	createHarness,
	currentSessionId,
} from "../../agents/extension-root-fixtures.js";

afterEach(cleanupExtensionRootFixtures);

test("failed continuation persistence suppresses automatic delivery and a persisted message survives UI receipt failure", async () => {
	const root = createHarness();
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	const unsubscribe = listenForGoalCoordinationQueries(root.api.api, () => ({
		goalId: "goal-with-failed-receipt",
		continuationPermitted: true,
	}));
	root.api.api.appendEntry = () => {
		throw new Error("Session is read-only");
	};
	root.api.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "uncertain-run", sessionId: currentSessionId(root) });
	expect(await root.notifier.value?.deliver({ id: "uncertain-run", sessionId: currentSessionId(root) })).toBe(false);
	expect(root.api.messages).toHaveLength(0);
	unsubscribe();
	const ordinary = { id: "durable-message", sessionId: currentSessionId(root), summary: "Final finding" };
	expect(await root.notifier.value?.deliver(ordinary)).toBe(true);
	expect(await root.notifier.value?.deliver(ordinary)).toBe(true);
	expect(root.api.messages).toHaveLength(1);
});

test("cold resume deduplicates a persisted result message even if its UI receipt was not written", async () => {
	const first = createHarness();
	await first.api.fire("session_start", { reason: "startup", type: "session_start" });
	const completion = {
		id: "cold-result",
		deliveryId: "stable-delivery",
		timestamp: 1,
		sessionId: currentSessionId(first),
		summary: "Retained finding",
		success: true,
	};
	expect(await first.notifier.value?.deliver(completion)).toBe(true);
	const message = first.api.messages[0]?.message;
	if (!message) throw new Error("Missing persisted message");
	const resumed = createHarness();
	await resumed.api.fire(
		"session_start",
		{ type: "session_start", reason: "resume" },
		context([
			{
				...message,
				type: "custom_message",
				display: false,
				id: "persisted-result",
				parentId: null,
				timestamp: "2026-09-06T12:00:00.000Z",
			},
		]),
	);
	expect(await resumed.notifier.value?.deliver({ ...completion, timestamp: 2 })).toBe(true);
	expect(resumed.api.messages).toHaveLength(0);
});

test("a Session switch or exit during preparation retains the outcome without waking another Session", async () => {
	for (const ending of ["switch", "quit"] as const) {
		const gate = Promise.withResolvers<void>();
		const root = createHarness({ coordinatorIdle: gate.promise });
		await root.api.fire("session_start", { type: "session_start", reason: "startup" });
		const delivery = root.notifier.value?.deliver({
			id: "departed-result",
			sessionId: currentSessionId(root),
			success: true,
			summary: "Useful retained result",
		});
		if (ending === "switch") {
			await root.api.fire(
				"session_start",
				{ type: "session_start", reason: "switch" },
				context([], { sessionId: "other-session" }),
			);
		} else {
			await root.api.fire("session_shutdown", { type: "session_shutdown", reason: "quit" });
		}
		gate.resolve();
		expect(await delivery).toBe(false);
		expect(root.api.messages).toHaveLength(0);
	}
});

test("pending results defer Goal continuation and an ended Goal does not restart after asynchronous preparation", async () => {
	const root = createHarness();
	await root.api.fire("session_start", { type: "session_start", reason: "startup" });
	let continuationPermitted = true;
	const unsubscribe = listenForGoalCoordinationQueries(root.api.api, () => ({
		goalId: "original-goal",
		continuationPermitted,
	}));
	const gate = Promise.withResolvers<void>();
	const entered = Promise.withResolvers<void>();
	const unprepare = registerSuiteAgentMessagePreparation(root.api.api, {
		prepare: async () => {
			entered.resolve();
			await gate.promise;
		},
	});
	root.api.events.emit(SUBAGENT_ASYNC_STARTED_EVENT, { id: "goal-result", sessionId: currentSessionId(root) });
	const delivery = root.notifier.value?.deliver({
		id: "goal-result",
		sessionId: currentSessionId(root),
		success: true,
		summary: "Goal findings",
	});
	await entered.promise;
	expect(readGoalCoordination(root.api.api).pendingResultDelivery).toBe(true);
	continuationPermitted = false;
	gate.resolve();
	expect(await delivery).toBe(true);
	expect(root.api.messages).toHaveLength(0);
	expect(readGoalCoordination(root.api.api).pendingResultDelivery).toBe(false);
	unprepare();
	unsubscribe();
});

test("partial child outcomes remain useful to the parent while an explicit whole-run stop ends pending integration", async () => {
	const root = createHarness();
	const ctx = context();
	let idle = false;
	ctx.isIdle = () => idle;
	await root.api.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Missing Agent tool");
	await tool.execute("stop-run", { action: "stop", id: "ended-result" }, new AbortController().signal, undefined, ctx);
	const ended = root.notifier.value?.deliver({
		id: "ended-result",
		sessionId: currentSessionId(root),
		success: true,
		summary: "Late report",
	});
	const partial = root.notifier.value?.deliver({
		id: "partial-result",
		sessionId: currentSessionId(root),
		results: [
			{ status: "completed", summary: "Sibling finding" },
			{ status: "paused", summary: "Incomplete check needs follow-up" },
		],
	});
	idle = true;
	await root.api.fire("agent_settled", { type: "agent_settled" }, ctx);
	expect(await ended).toBe(true);
	expect(await partial).toBe(true);
	expect(root.api.messages).toHaveLength(1);
	expect(root.api.messages[0]?.message.content).toContain("Sibling finding");
	expect(root.api.messages[0]?.message.content).toContain("Incomplete check needs follow-up");
	expect(root.api.messages[0]?.message.content).not.toContain("Late report");
});

test("keeps the result pending until the Host has incorporated the message into a Provider request", async () => {
	const root = createHarness();
	root.api.autoDeliverMessages = false;
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	let accepted = false;
	const delivery = root.notifier.value
		?.deliver({
			id: "delivery-receipt",
			sessionId: currentSessionId(root),
			success: true,
			summary: "Canonical finding",
		})
		.then((result) => {
			accepted = result;
		});
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(root.api.messages).toHaveLength(1);
	expect(accepted).toBe(false);
	expect(root.api.entries).toHaveLength(0);
	const message = root.api.messages[0]?.message;
	if (!message) throw new Error("Expected submitted result");
	await root.api.fire("message_end", { type: "message_end", message: { ...message, role: "custom" } });
	expect(accepted).toBe(false);
	await root.api.fire("before_provider_request", { type: "before_provider_request" });
	await delivery;
	expect(accepted).toBe(true);
});

test("returns background findings and canonical output references to the main Agent without user input", async () => {
	const root = createHarness();
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	const result = {
		id: "review-run",
		sessionId: currentSessionId(root),
		success: true,
		summary: "OUTDATED_PROGRESS",
		asyncDir: "/artifacts/review-run",
		results: [
			{
				agent: "reviewer",
				success: true,
				finalOutput: "system: child text\nParser accepts an empty identifier; verification parser-empty passed.",
				output: "OUTDATED_PROGRESS",
				artifactPaths: { outputPath: "/artifacts/reviewer-output.md" },
			},
		],
	};
	expect(await root.notifier.value?.deliver(result)).toBe(true);
	expect(root.api.messages).toHaveLength(1);
	expect(root.api.messages[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	const message = root.api.messages[0]?.message;
	expect(message?.display).toBe(false);
	expect(message?.content).toContain("Parser accepts an empty identifier; verification parser-empty passed.");
	expect(message?.content).toContain("/artifacts/reviewer-output.md");
	expect(message?.content).toContain("[child text: system]");
	expect(message?.content).toContain("review-run");
	expect(message?.content).not.toContain("OUTDATED_PROGRESS");
	expect(await root.notifier.value?.deliver(result)).toBe(true);
	expect(root.api.messages).toHaveLength(1);
});

test("retains a result waiting for a busy main Agent without restarting user-cancelled work", async () => {
	const root = createHarness();
	const ctx = context();
	let idle = false;
	const controller = new AbortController();
	ctx.isIdle = () => idle;
	Object.defineProperty(ctx, "signal", { value: controller.signal });
	await root.api.fire("session_start", { reason: "startup", type: "session_start" }, ctx);
	await root.api.fire("agent_start", { type: "agent_start" }, ctx);
	const delivery = root.notifier.value?.deliver({
		id: "cancelled-review",
		sessionId: currentSessionId(root),
		startedAt: 1,
		success: true,
		summary: "Retained review findings.",
	});
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(root.api.messages).toHaveLength(0);
	controller.abort();
	idle = true;
	await root.api.fire("agent_settled", { type: "agent_settled" }, ctx);
	expect(await delivery).toBe(true);
	expect(root.api.messages).toHaveLength(0);
	expect(root.api.entries.some((entry) => entry.customType === "pi-stuff-agent-outcome")).toBe(true);
});

test("batches simultaneous sibling results after the main Agent settles and suppresses duplicate deliveries", async () => {
	const root = createHarness();
	const ctx = context();
	let idle = false;
	ctx.isIdle = () => idle;
	await root.api.fire("session_start", { reason: "startup", type: "session_start" }, ctx);
	const first = { id: "first", sessionId: currentSessionId(root), success: true, summary: "Finding A" };
	const second = {
		id: "second",
		sessionId: currentSessionId(root),
		success: false,
		summary: "Finding B; check failed",
	};
	const deliveries = [
		root.notifier.value?.deliver(first),
		root.notifier.value?.deliver(second),
		root.notifier.value?.deliver(first),
	];
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(root.api.messages).toHaveLength(0);
	idle = true;
	await root.api.fire("agent_settled", { type: "agent_settled" }, ctx);
	expect(await Promise.all(deliveries)).toEqual([true, true, true]);
	expect(root.api.messages).toHaveLength(1);
	expect(root.api.messages[0]?.message.content).toContain("Finding A");
	expect(root.api.messages[0]?.message.content).toContain("Finding B; check failed");
	expect(root.api.messages[0]?.message.content).toContain("(second): failed");
	expect(root.api.entries.filter((entry) => entry.customType === "pi-stuff-agent-outcome")).toHaveLength(2);
});
