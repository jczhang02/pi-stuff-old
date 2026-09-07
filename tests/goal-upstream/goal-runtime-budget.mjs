import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createHarness, persistedGoalStatus, waitFor } from "./goal-runtime-support.mjs";

export async function budgetBoundaryScenario() {
	const harness = await createHarness([
		fauxAssistantMessage(fauxToolCall("budget_probe", {})),
		(context) => {
			const wrapUp = context.messages.find(
				(message) => message.role === "custom" && message.customType === "goal-budget-wrap-up",
			);
			assert.match(String(wrapUp?.content), /stop substantive work/i);
			return fauxAssistantMessage("Budget-limited progress summary.");
		},
	]);
	try {
		await harness.session.prompt("/goal --tokens 1 budget boundary runtime smoke");
		await waitFor(() => harness.faux.state.callCount === 2, "budget wrap-up response");
		await harness.session.agent.waitForIdle();
		assert.equal(persistedGoalStatus(harness.session), "budget_limited");
		assert.equal(harness.lifecycleEvents.filter((event) => event === "tool_execution_end").length, 1);
		assert.ok(
			harness.lifecycleEvents.indexOf("assistant_message_end") <
				harness.lifecycleEvents.indexOf("tool_execution_end"),
			"assistant message must finalize before tool_execution_end",
		);
	} finally {
		await harness.cleanup();
	}
}

export async function budgetViolationScenario() {
	const harness = await createHarness([
		fauxAssistantMessage(fauxToolCall("budget_probe", {})),
		fauxAssistantMessage(fauxToolCall("budget_probe", {})),
		(_context, options) => {
			assert.equal(options?.signal?.aborted, true);
			return fauxAssistantMessage("This aborted response must not start more work.");
		},
	]);
	try {
		await harness.session.prompt("/goal --tokens 1 reject wrap-up tools at runtime");
		await harness.session.agent.waitForIdle();
		assert.ok(
			harness.faux.state.callCount === 2 || harness.faux.state.callCount === 3,
			"Pi must stop after the rejected wrap-up tool, with at most one aborted cleanup call",
		);
		assert.equal(harness.lifecycleEvents.filter((event) => event === "budget_probe_execute").length, 1);
		assert.equal(persistedGoalStatus(harness.session), "budget_limited");
	} finally {
		await harness.cleanup();
	}
}

export async function budgetAgentEndFallbackScenario() {
	const harness = await createHarness([fauxAssistantMessage("No-tool budget response.")]);
	try {
		await harness.session.prompt("/goal --tokens 1 no-tool budget runtime smoke");
		await harness.session.agent.waitForIdle();
		assert.equal(harness.faux.state.callCount, 1);
		assert.equal(persistedGoalStatus(harness.session), "budget_limited");
	} finally {
		await harness.cleanup();
	}
}
