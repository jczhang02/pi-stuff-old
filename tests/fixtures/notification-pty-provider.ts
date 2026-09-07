import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { registerFixtureProvider, ZERO_USAGE } from "./faux-provider.js";

const PROVIDER = "pi-stuff-notification-pty";
const MODEL = "notification-pty-model";
function message(stopReason: AssistantMessage["stopReason"], text = "", errorMessage?: string): AssistantMessage {
	const result: AssistantMessage = {
		api: "openai-completions",
		content: text ? [{ text, type: "text" }] : [],
		model: MODEL,
		provider: PROVIDER,
		role: "assistant",
		stopReason,
		timestamp: Date.now(),
		usage: ZERO_USAGE,
	};
	if (errorMessage !== undefined) result.errorMessage = errorMessage;
	return result;
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const candidate = context.messages[index];
		if (candidate?.role !== "user") continue;
		if (isRuntimeString(candidate.content)) return candidate.content;
		return candidate.content
			.filter((part): part is { readonly text: string; readonly type: "text" } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function delayedText(text: string, options?: SimpleStreamOptions, delayMs = 450) {
	const stream = createAssistantMessageEventStream();
	const pending = message("pending");
	let settled = false;
	stream.push({ partial: pending, type: "start" });
	stream.push({ contentIndex: 0, partial: pending, type: "text_start" });
	const finish = (): void => {
		if (settled) return;
		settled = true;
		stream.push({ contentIndex: 0, delta: text, partial: pending, type: "text_delta" });
		stream.push({ content: text, contentIndex: 0, partial: pending, type: "text_end" });
		stream.push({ message: message("stop", text), reason: "stop", type: "done" });
	};
	const abort = (): void => {
		if (settled) return;
		settled = true;
		stream.push({ error: message("aborted"), reason: "aborted", type: "error" });
	};
	setTimeout(finish, delayMs);
	options?.signal?.addEventListener("abort", abort, { once: true });
	return stream;
}

function delayedFailure(errorMessage: string) {
	const stream = createAssistantMessageEventStream();
	stream.push({ partial: message("pending"), type: "start" });
	setTimeout(() => {
		stream.push({ error: message("error", "", errorMessage), reason: "error", type: "error" });
	}, 450);
	return stream;
}

function promptToolStream() {
	const stream = createAssistantMessageEventStream();
	const pending = message("pending");
	const toolCall = {
		arguments: {},
		id: "notification-prompt",
		name: "notification_prompt",
		type: "toolCall" as const,
	};
	stream.push({ partial: pending, type: "start" });
	stream.push({ contentIndex: 0, partial: pending, type: "toolcall_start" });
	stream.push({ contentIndex: 0, partial: pending, toolCall, type: "toolcall_end" });
	stream.push({ message: { ...message("toolUse"), content: [toolCall] }, reason: "toolUse", type: "done" });
	return stream;
}

export default function notificationPtyProvider(pi: ExtensionAPI): void {
	pi.registerTool({
		description: "Hold a real Pi UI prompt open for Notification timing certification",
		execute: async (_toolCallId, _args, _signal, _onUpdate, context) => {
			const confirmed = await context.ui.confirm("Fixture prompt", "Continue after the prompt wait?");
			return {
				content: [{ text: confirmed ? "PROMPT_CONFIRMED" : "PROMPT_REJECTED", type: "text" }],
				details: { confirmed },
			};
		},
		label: "Prompt",
		name: "notification_prompt",
		parameters: Type.Object({}),
	});
	registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Stuff Notification PTY fixture", (_model, context, options) => {
		const prompt = lastUserText(context).trim();
		if (prompt.includes("NOTIFY_PROMPT_WAIT")) {
			return context.messages.some(
				(entry) => entry.role === "toolResult" && entry.toolCallId === "notification-prompt",
			)
				? delayedText("NOTIFICATION_PROMPT_DONE", options)
				: promptToolStream();
		}
		if (prompt.includes("NOTIFY_FAILURE")) return delayedFailure("NOTIFICATION_FAILURE_DONE");
		if (prompt.includes("NOTIFY_ABORT")) {
			return delayedText("UNEXPECTED_ABORT_FINISH", options, 5_000);
		}
		interface NotificationResponses {
			readonly [scenario: string]: string;
		}
		const responses: NotificationResponses = {
			NOTIFY_CHAOS_CANCEL: "NOTIFICATION_CHAOS_DONE",
			NOTIFY_RELOAD_CANCEL: "NOTIFICATION_RELOAD_DONE",
			NOTIFY_SHUTDOWN_CANCEL: "NOTIFICATION_SHUTDOWN_DONE",
			NOTIFY_SUCCESS: "NOTIFICATION_SUCCESS_DONE",
			NOTIFY_SUCCESS_NARROW: "NOTIFICATION_NARROW_DONE",
		};
		const scenario = Object.keys(responses)
			.sort((left, right) => right.length - left.length)
			.find((candidate) => prompt.includes(candidate));
		return delayedText((scenario && responses[scenario]) || `UNEXPECTED_NOTIFICATION_PROMPT:${prompt}`, options);
	});
}
