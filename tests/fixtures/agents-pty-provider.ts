import { appendFileSync } from "node:fs";
import type { AssistantMessage, Context, JsonValue, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonInputValue } from "../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { createAssistantMessage, registerFixtureProvider, ZERO_USAGE } from "./faux-provider.js";

const PROVIDER = "pi-stuff-agents-pty";
const MODEL = "fixture-model";
const DESCRIPTION = "复核工具结果 🧪";
const TASK =
	"AGENT_PTY_TASK · 中文长任务：独立只读复核 /tmp/pi-max-tools-019fc372-d606-77ef-b3d5-59ba054c8d1a/sample.txt 并检查终端截断与状态保留；同时核对窄屏换行、长路径、Activity 滚动、最终结果去重与底部快捷键在完整详情中的可见性。";
const CHILD_RESULT_DELAY_MS = 15_000;
const SUBAGENT_CHILD_ENV = "PI_SUBAGENT_CHILD";
const SUBAGENT_PI_BINARY_ENV = "PI_SUBAGENT_PI_BINARY";

const CHILD_READ_USAGE = {
	...ZERO_USAGE,
	input: 73_000,
	output: 1_000,
	totalTokens: 74_000,
};
const CHILD_FINAL_USAGE = {
	...ZERO_USAGE,
	input: 78_000,
	output: 2_000,
	totalTokens: 80_000,
};

const message = createAssistantMessage(PROVIDER, MODEL);

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const entry = context.messages[index];
		if (entry?.role !== "user") continue;
		if (isRuntimeString(entry.content)) return entry.content;
		return entry.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function record(value: Record<string, JsonInputValue>): void {
	const path = process.env["PI_STUFF_AGENTS_PTY_LOG"];
	if (!path) return;
	appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...value })}\n`);
}

function textStream(
	first: string,
	second = "",
	delayMs = 0,
	onFinish?: () => void,
	usage: AssistantMessage["usage"] = ZERO_USAGE,
) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	let settled = false;
	const finish = (): void => {
		if (settled) return;
		settled = true;
		if (second) stream.push({ type: "text_delta", contentIndex: 0, delta: second, partial: pending });
		const text = `${first}${second}`;
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
		stream.push({ type: "done", reason: "stop", message: message([{ type: "text", text }], "stop", usage) });
		onFinish?.();
	};
	const abort = (): void => {
		if (settled) return;
		settled = true;
		stream.push({ type: "error", reason: "aborted", error: message([{ type: "text", text: first }], "aborted") });
	};

	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	stream.push({ type: "text_delta", contentIndex: 0, delta: first, partial: pending });
	if (delayMs > 0) setTimeout(finish, delayMs);
	else queueMicrotask(finish);
	return { stream, abort };
}

function launchStream() {
	return toolCallStream("agents-pty-launch", "subagent", {
		agent: "general-purpose",
		description: DESCRIPTION,
		task: TASK,
		foreground: false,
		context: "fresh",
	});
}

function childReadStream() {
	return toolCallStream("agents-pty-child-read", "read", { path: "agent-tool-target.txt" }, CHILD_READ_USAGE);
}

function toolCallStream(
	id: string,
	name: string,
	argumentsValue: Record<string, JsonValue>,
	usage: AssistantMessage["usage"] = ZERO_USAGE,
) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCall = {
		type: "toolCall" as const,
		id,
		name,
		arguments: argumentsValue,
	};
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: message([toolCall], "toolUse", usage) });
	return stream;
}

function fixtureStream(context: Context, options?: SimpleStreamOptions) {
	const child = process.env["PI_SUBAGENT_CHILD"] === "1";
	// Pi projects Suite custom messages into a model-visible user message before
	// invoking the Provider. Assert that projected payload rather than Host-only
	// custom-entry metadata.
	const serialized = JSON.stringify(context.messages);
	const completion = serialized.includes("Delegated Agent result (") && serialized.includes("CHILD_FINAL_SUMMARY");
	const toolResult = context.messages.some((entry) => entry.role === "toolResult" && entry.toolName === "subagent");
	const childReadResult = context.messages.some((entry) => entry.role === "toolResult" && entry.toolName === "read");
	const phase = child ? "child" : completion ? "completion" : toolResult ? "continued" : "launch";
	record({
		kind: "request",
		phase,
		role: child ? "child" : "main",
		lastUser: lastUserText(context),
		tools: (context.tools ?? []).map((tool) => tool.name),
		completion,
	});

	if (child) {
		if (!childReadResult) return childReadStream();
		const result = textStream(
			"CHILD_RUNNING",
			"\n## CHILD_FINAL_SUMMARY\n\n**CHILD_MARKDOWN_RENDERED**\n\nCHILD_NOTE_1\nCHILD_NOTE_2\nCHILD_NOTE_3\nCHILD_NOTE_4\nCHILD_NOTE_5\nCHILD_NOTE_6",
			CHILD_RESULT_DELAY_MS,
			() => {
				record({ kind: "child-finished", role: "child" });
			},
			CHILD_FINAL_USAGE,
		);
		options?.signal?.addEventListener("abort", result.abort, { once: true });
		return result.stream;
	}
	if (completion) return textStream("FINAL_DELIVERABLE_FROM_BACKGROUND_RESULT").stream;
	if (toolResult) return textStream("MAIN_NOT_BLOCKED").stream;
	return launchStream();
}

export default function agentsPtyProvider(pi: ExtensionAPI): void {
	// The parent Host must be inherited without the supported emergency override;
	// child processes keep the already-clean environment.
	if (process.env[SUBAGENT_CHILD_ENV] !== "1") delete process.env[SUBAGENT_PI_BINARY_ENV];
	registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Stuff Agents PTY fixture", (_model, context, options) =>
		fixtureStream(context, options),
	);
}
