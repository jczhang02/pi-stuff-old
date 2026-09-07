import { appendFileSync } from "node:fs";
import type { AssistantMessage, Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { getCommandDialogCoordinator } from "../../packages/pi-stuff/src/conversation-ui/index.js";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { registerFixtureProvider, ZERO_USAGE } from "./faux-provider.js";

const PROVIDER = "pi-stuff-pty";
const MODEL = "fixture-model";
const LARGE_CONTEXT_CHARS = 2_000_000;

function message(text: string, stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content: text.length === 0 ? [] : [{ type: "text", text }],
		api: "openai-completions",
		provider: PROVIDER,
		model: MODEL,
		usage: ZERO_USAGE,
		stopReason,
		timestamp: Date.now(),
	};
}

function contextMessageText(message: Context["messages"][number]): string {
	if (isRuntimeString(message.content)) return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const message = context.messages[index];
		if (message?.role === "user") return contextMessageText(message);
	}
	return "";
}

function recordRequest(context: Context): void {
	const { PI_STUFF_PTY_LOG: path } = process.env;
	if (!path) return;
	appendFileSync(
		path,
		`${JSON.stringify({
			lastUser: lastUserText(context),
			messageChars: context.messages.reduce((total, message) => total + contextMessageText(message).length, 0),
			messageCount: context.messages.length,
			tools: (context.tools ?? []).map((tool) => tool.name),
		})}\n`,
	);
}

function fixtureStream(context: Context, options?: SimpleStreamOptions) {
	recordRequest(context);
	const stream = createAssistantMessageEventStream();
	const pending = message("", "pending");
	const sideQuestion = (context.tools ?? []).length === 0;
	const first = sideQuestion ? "BTW_STREAM" : "MAIN_START";
	const second = sideQuestion
		? `\nBTW_SCROLL_TOP\n${Array.from({ length: 48 }, (_, index) => `scroll line ${index + 1}`).join("\n")}\nBTW_DONE`
		: " MAIN_DONE";
	let settled = false;
	const finish = (): void => {
		if (settled) return;
		settled = true;
		stream.push({ type: "text_delta", contentIndex: 0, delta: second, partial: pending });
		stream.push({ type: "text_end", contentIndex: 0, content: `${first}${second}`, partial: pending });
		stream.push({ type: "done", reason: "stop", message: message(`${first}${second}`, "stop") });
	};
	const abort = (): void => {
		if (settled) return;
		settled = true;
		stream.push({ type: "error", reason: "aborted", error: message(first, "aborted") });
	};

	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	stream.push({ type: "text_delta", contentIndex: 0, delta: first, partial: pending });
	setTimeout(finish, sideQuestion ? 100 : 2_000);
	options?.signal?.addEventListener("abort", abort, { once: true });
	return stream;
}

export default function btwPtyProvider(pi: ExtensionAPI): void {
	pi.registerCommand("fixture-btw-large", {
		description: "Seed an oversized branch for the BTW PTY acceptance fixture",
		handler: async (_args, ctx) => {
			// SAFETY: this test controls the value and supplies every SessionManager member exercised by this case.
			const sessionManager = ctx.sessionManager as SessionManager;
			sessionManager.appendMessage({
				role: "user",
				content: "BTW_LARGE_CONTEXT_USER",
				timestamp: Date.now(),
			});
			sessionManager.appendMessage(
				message(`BTW_LARGE_HEAD\n${"x".repeat(LARGE_CONTEXT_CHARS)}\nBTW_LARGE_TAIL`, "stop"),
			);
			ctx.ui.notify("BTW_LARGE_CONTEXT_READY", "info");
		},
	});

	registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Stuff PTY fixture", (_model, context, options) =>
		fixtureStream(context, options),
	);

	pi.registerShortcut(Key.f12, {
		description: "Open the PTY draft-restoration fixture",
		handler: async (ctx) => {
			const coordinator = getCommandDialogCoordinator(pi);
			await coordinator.show(ctx, {
				priority: "normal",
				create: ({ close }) => ({
					handleInput: (data: string) => {
						if (matchesKey(data, Key.escape)) close();
					},
					invalidate: () => {},
					render: () => ["DRAFT_SURFACE"],
				}),
			});
		},
	});
}
