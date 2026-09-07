import { appendFileSync } from "node:fs";
import type { Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readCurrentAgentWorkOrigin } from "../../packages/pi-stuff/src/conversation-ui/index.js";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { createAssistantMessage, createTextStream, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-host-seams";
const MODEL = "fixture-model";
const CLEAR_REQUEST = "CLEAR_QUEUE_ORIGIN";
const AUTOMATIC_FOLLOW_UP = "AUTOMATIC_AFTER_CLEAR";
const ORDERING_REQUEST = "ORDERING_DURING_TOOL";
const message = createAssistantMessage(PROVIDER, MODEL);
const textStream = createTextStream(message);

interface SeamLogRecord {
	readonly origin?: "automatic" | "user";
	readonly phase: "automatic-enqueued" | "clear-origin";
}

function record(value: SeamLogRecord): void {
	const path = process.env["PI_STUFF_HOST_SEAMS_LOG"];
	if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...value })}\n`);
}

function messageText(entry: Context["messages"][number]): string {
	if (isRuntimeString(entry.content)) return entry.content;
	return entry.content
		.filter((part): part is { readonly text: string; readonly type: "text" } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const entry = context.messages[index];
		if (entry?.role === "user") return messageText(entry);
	}
	return "";
}

function delayedText(text: string, delayMs: number) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	stream.push({ partial: pending, type: "start" });
	stream.push({ contentIndex: 0, partial: pending, type: "text_start" });
	setTimeout(() => {
		stream.push({ contentIndex: 0, delta: text, partial: pending, type: "text_delta" });
		stream.push({ content: text, contentIndex: 0, partial: pending, type: "text_end" });
		stream.push({ message: message([{ text, type: "text" }], "stop"), reason: "stop", type: "done" });
	}, delayMs);
	return stream;
}

function orderingToolStream() {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCalls = [
		{
			arguments: {
				command: "sleep 0.2; printf ORDERING_BACKGROUND_DONE",
				description: "ordering completion",
				run_in_background: true,
			},
			id: "ordering-background",
			name: "bash",
			type: "toolCall" as const,
		},
		{ arguments: {}, id: "ordering-gate", name: "ordering_gate", type: "toolCall" as const },
	];
	stream.push({ partial: pending, type: "start" });
	for (const [contentIndex, toolCall] of toolCalls.entries()) {
		pending.content.push(toolCall);
		stream.push({ contentIndex, partial: pending, type: "toolcall_start" });
		stream.push({ contentIndex, partial: pending, toolCall, type: "toolcall_end" });
	}
	stream.push({ message: message(toolCalls, "toolUse"), reason: "toolUse", type: "done" });
	return stream;
}

function orderingResult(context: Context) {
	const backgroundResult = context.messages.findIndex(
		(entry) => entry.role === "toolResult" && entry.toolCallId === "ordering-background",
	);
	const gateResult = context.messages.findIndex(
		(entry) => entry.role === "toolResult" && entry.toolCallId === "ordering-gate",
	);
	if (backgroundResult < 0 || gateResult < 0) return orderingToolStream();
	return textStream("ORDERING_TOOL_RESULTS_DONE");
}

export default function piHostSeamsProvider(pi: ExtensionAPI): void {
	let clearArmed = false;
	let automaticSent = false;
	pi.registerTool({
		description: "Hold one Tool phase open while a non-triggering follow-up arrives",
		execute: async () => {
			await Bun.sleep(1_500);
			return { content: [{ text: "ORDERING_GATE_DONE", type: "text" }], details: {} };
		},
		label: "Ordering gate",
		name: "ordering_gate",
		parameters: Type.Object({}),
	});
	pi.on("session_start", () => {
		setTimeout(() => {
			clearArmed = true;
			pi.sendUserMessage(CLEAR_REQUEST);
		}, 50);
	});
	pi.on("agent_start", () => {
		if (!clearArmed || automaticSent) return;
		automaticSent = true;
		setTimeout(() => {
			pi.sendUserMessage(AUTOMATIC_FOLLOW_UP, { deliverAs: "followUp" });
			record({ phase: "automatic-enqueued" });
		}, 900);
	});
	pi.on("message_start", (event) => {
		if (event.message.role === "user" && messageText(event.message).includes(AUTOMATIC_FOLLOW_UP)) {
			record({ origin: readCurrentAgentWorkOrigin(pi), phase: "clear-origin" });
		}
	});
	registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Host seams", (_model, context) => {
		const prompt = lastUserText(context);
		if (prompt.includes(AUTOMATIC_FOLLOW_UP)) return textStream("CLEAR_QUEUE_DONE");
		if (prompt.includes(CLEAR_REQUEST)) return delayedText("CLEAR_QUEUE_INITIAL_DONE", 2_500);
		if (prompt.includes(ORDERING_REQUEST)) return orderingResult(context);
		return textStream("PI_HOST_SEAMS_READY");
	});
}
