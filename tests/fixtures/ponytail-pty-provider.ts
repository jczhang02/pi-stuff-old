import { appendFileSync } from "node:fs";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import type { JsonInputValue } from "../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { registerFixtureProvider, ZERO_USAGE } from "./faux-provider.js";

const PROVIDER = "pi-stuff-ponytail-pty";
const MODEL = "ponytail-pty-model";
const CONTRIBUTION_START = "<!-- pi-stuff:prompt-contribution:ponytail:start -->";
const CONTRIBUTION_END = "<!-- pi-stuff:prompt-contribution:ponytail:end -->";
const CATALOG_MARKER = "<name>ponytail</name>";

function appendRecord(record: Readonly<Record<string, JsonInputValue>>): void {
	const path = process.env["PI_STUFF_PONYTAIL_PTY_LOG"];
	if (path) appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		if (isRuntimeString(message.content)) return message.content;
		return message.content
			.filter((part): part is { readonly type: "text"; readonly text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function contribution(systemPrompt: string): string {
	const start = systemPrompt.indexOf(CONTRIBUTION_START);
	const end = systemPrompt.indexOf(CONTRIBUTION_END, start + CONTRIBUTION_START.length);
	if (start < 0 || end < 0) return "";
	return systemPrompt.slice(start, end + CONTRIBUTION_END.length);
}

function textStream(model: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	const pending: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: model.provider,
		model: model.id,
		usage: ZERO_USAGE,
		stopReason: "pending",
		timestamp: Date.now(),
	};
	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: pending });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
	stream.push({
		type: "done",
		reason: "stop",
		message: { ...pending, content: [{ type: "text", text }], stopReason: "stop" },
	});
	return stream;
}

export default function ponytailPtyProvider(pi: ExtensionAPI): void {
	registerFixtureProvider(
		pi,
		PROVIDER,
		MODEL,
		"Pi Stuff Ponytail PTY fixture",
		(model, context) => {
			const systemPrompt = isRuntimeString(context.systemPrompt) ? context.systemPrompt : "";
			const ponytail = contribution(systemPrompt);
			const lastUser = lastUserText(context);
			appendRecord({
				type: "request",
				lastUser,
				ponytailChars: ponytail.length,
				ponytailMarkerCount: systemPrompt.split(CONTRIBUTION_START).length - 1,
				hasCatalog: systemPrompt.includes(CATALOG_MARKER),
				hasCompactPolicy: systemPrompt.includes("PONYTAIL MODE ACTIVE"),
				hasUpstreamLongForm: systemPrompt.includes("HARD RULE: branch or loop only when each leaf has a test"),
				skillNames: [...systemPrompt.matchAll(/<name>(ponytail[^<]*)<\/name>/gu)].map((match) => match[1]),
			});
			return textStream(model, `${lastUser}_DONE`);
		},
		{ modelName: MODEL },
	);

	pi.registerShortcut(Key.f12, {
		description: "Open the production Ponytail control dialog",
		handler: () => {
			pi.sendUserMessage("/ponytail", { expandPromptTemplates: true });
		},
	});

	pi.on("session_start", () => {
		appendRecord({
			type: "inventory",
			commands: pi
				.getCommands()
				.map((command) => command.name)
				.filter((name) => name.includes("ponytail")),
		});
	});
}
