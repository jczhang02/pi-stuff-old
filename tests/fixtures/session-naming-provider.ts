import { appendFileSync } from "node:fs";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonInputValue } from "../../packages/pi-stuff/src/shared/json-value.js";
import { registerFixtureProvider, ZERO_USAGE } from "./faux-provider.js";

const PROVIDER = "pi-stuff-session-naming";
const MODEL = "fixture-model";
let providerCalls = 0;
let namingCalls = 0;

function log(record: Record<string, JsonInputValue>): void {
	const path = process.env["PI_STUFF_SESSION_NAMING_LOG"];
	if (path) appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: PROVIDER,
		model: MODEL,
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function textStream(text: string) {
	const stream = createAssistantMessageEventStream();
	const pending = { ...assistant(""), stopReason: "pending" as const };
	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: pending });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
	stream.push({ type: "done", reason: "stop", message: assistant(text) });
	return stream;
}

function response(context: Context) {
	providerCalls += 1;
	const naming = context.systemPrompt?.includes("concise semantic labels for coding sessions") === true;
	if (naming) namingCalls += 1;
	log({ kind: naming ? "naming" : "agent", namingCalls, providerCalls });
	return textStream(
		naming
			? process.env["PI_STUFF_SESSION_NAMING_LABEL"] || "Semantic Session Naming"
			: "The automatic Session naming fixture completed the user request.",
	);
}

export default function sessionNamingProvider(pi: ExtensionAPI): void {
	registerFixtureProvider(
		pi,
		PROVIDER,
		MODEL,
		"Pi Stuff Session Naming fixture",
		(_model, context) => response(context),
		{ contextWindow: 100_000 },
	);

	pi.registerCommand("session-naming-wait", {
		description: "Wait for automatic Session naming acceptance",
		handler: async (_args, ctx) => {
			const deadline = Date.now() + 10_000;
			while (providerCalls === 0) {
				if (Date.now() >= deadline) throw new Error("The fixture Agent request did not start");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			await ctx.waitForIdle();
			while (!pi.getSessionName()) {
				if (Date.now() >= deadline) throw new Error("Automatic Session naming did not complete");
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			log({ kind: "observed_name", name: pi.getSessionName() ?? "" });
		},
	});

	pi.on("session_start", (event) => log({ kind: "session_start", reason: event.reason }));
	pi.on("session_info_changed", (event) => log({ kind: "session_info_changed", name: event.name ?? "" }));
}
