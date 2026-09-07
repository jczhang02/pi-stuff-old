import { expect, test } from "bun:test";
import type { Message } from "@earendil-works/pi-ai";
import { ChildResultReducer } from "../../../packages/pi-stuff/src/subagents/src/runs/background/child-result-reducer.js";
import type { ChildProtocolMessage } from "../../../packages/pi-stuff/src/subagents/src/runs/shared/child-protocol.js";
import { detectSubagentError, getFinalOutput } from "../../../packages/pi-stuff/src/subagents/src/shared/utils.js";

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistant(
	text: string,
	options: { errorMessage?: string; stopReason?: "stop" | "toolUse" | "error" } = {},
): Extract<ChildProtocolMessage, { role: "assistant" }> {
	const message: ChildProtocolMessage = {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: ZERO_COST },
		stopReason: options.stopReason ?? "toolUse",
		timestamp: Date.now(),
	};
	return options.errorMessage ? { ...message, errorMessage: options.errorMessage } : message;
}

function providerMessages(messages: ChildProtocolMessage[]): Message[] {
	return messages.filter((message): message is Message => message.role !== "custom");
}

test("preserves the canonical acceptance report when ordinary output follows it", () => {
	const reducer = new ChildResultReducer();
	const messages = [assistant("starting"), assistant("ACCEPTANCE_REPORT: decisive evidence"), assistant("done")];
	for (const message of messages) reducer.record(message);
	expect(getFinalOutput(reducer.messages())).toBe(getFinalOutput(messages));
});

test("reduces an unbounded child message stream to bounded final and error evidence", () => {
	const reducer = new ChildResultReducer();
	for (let index = 0; index < 10_000; index += 1) {
		reducer.record(assistant(`draft-${String(index)}`));
	}
	reducer.record(assistant("FINAL", { stopReason: "stop" }));
	for (let index = 0; index < 10_000; index += 1) {
		reducer.record({
			role: "toolResult",
			toolCallId: `success-${String(index)}`,
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.now(),
		});
	}

	const reduced = reducer.messages();
	expect(reduced.length).toBeLessThanOrEqual(6);
	expect(getFinalOutput(reduced)).toBe("FINAL");

	reducer.record({
		role: "toolResult",
		toolCallId: "failed-call",
		toolName: "read",
		content: [{ type: "text", text: "LATEST_TOOL_FAILURE" }],
		isError: true,
		timestamp: Date.now(),
	});
	const failed = reducer.messages();
	expect(failed.length).toBeLessThanOrEqual(6);
	expect(detectSubagentError(providerMessages(failed))?.details).toContain("LATEST_TOOL_FAILURE");
});

test("retains the last successful output beside bounded provider-error evidence", () => {
	const reducer = new ChildResultReducer();
	reducer.record({ role: "user", content: [{ type: "text", text: "task" }], timestamp: Date.now() });
	reducer.record(assistant("LAST_GOOD", { stopReason: "stop" }));
	reducer.record(assistant("provider failed", { errorMessage: "rate limit", stopReason: "error" }));

	const reduced = reducer.messages();
	expect(reduced.length).toBeLessThanOrEqual(6);
	expect(getFinalOutput(reduced)).toBe("LAST_GOOD");
	expect(reduced.some((message) => message.role === "assistant" && message.errorMessage === "rate limit")).toBe(true);
});

test("retains a Tool failure after the final Assistant when later non-Assistant evidence arrives", () => {
	const reducer = new ChildResultReducer();
	reducer.record(assistant("tool call", { stopReason: "toolUse" }));
	reducer.record({
		role: "toolResult",
		toolCallId: "failed-call",
		toolName: "read",
		content: [{ type: "text", text: "TOOL_FAILURE" }],
		isError: true,
		timestamp: Date.now(),
	});
	reducer.record({
		role: "custom",
		customType: "fixture",
		content: "later diagnostic",
		display: false,
		timestamp: Date.now(),
	});

	const reduced = reducer.messages();
	expect(detectSubagentError(providerMessages(reduced))?.details).toContain("TOOL_FAILURE");
});

test("preserves source order so a later assistant success supersedes a Tool failure", () => {
	const reducer = new ChildResultReducer();
	reducer.record({
		role: "toolResult",
		toolCallId: "recovered-call",
		toolName: "read",
		content: [{ type: "text", text: "transient failure" }],
		isError: true,
		timestamp: Date.now(),
	});
	reducer.record(assistant("RECOVERED", { stopReason: "stop" }));

	const reduced = reducer.messages();
	expect(reduced.map((message) => message.role)).toEqual(["toolResult", "assistant"]);
	expect(getFinalOutput(reduced)).toBe("RECOVERED");
	expect(detectSubagentError(providerMessages(reduced)).hasError).toBe(false);
});

test("preserves recovery evidence beside an earlier report and later thinking", () => {
	const messages: ChildProtocolMessage[] = [
		assistant("ACCEPTANCE_REPORT: passed"),
		{
			role: "toolResult",
			toolCallId: "recovered",
			toolName: "read",
			content: [{ type: "text", text: "failure" }],
			isError: true,
			timestamp: Date.now(),
		},
		assistant("recovered"),
		{ ...assistant(""), content: [{ type: "thinking", thinking: "considering next step" }] },
	];
	const reducer = new ChildResultReducer();
	for (const message of messages) reducer.record(message);
	expect(getFinalOutput(reducer.messages())).toBe(getFinalOutput(messages));
	expect(detectSubagentError(providerMessages(reducer.messages()))).toEqual(
		detectSubagentError(providerMessages(messages)),
	);
	expect(detectSubagentError(providerMessages(reducer.messages())).hasError).toBeFalse();
});
