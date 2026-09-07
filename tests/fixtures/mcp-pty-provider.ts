import type { Context, ToolResultMessage } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { createAssistantMessage, createTextStream, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-mcp-pty";
const MODEL = "fixture-model";
const CALL_MARKER = "MCP_STDIO_ECHO_OK";

const message = createAssistantMessage(PROVIDER, MODEL);
const textStream = createTextStream(message);

function toolCallStream() {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCall = {
		type: "toolCall" as const,
		id: "mcp-pty-call-1",
		name: "mcp",
		arguments: { args: { text: CALL_MARKER }, server: "local", tool: "local_echo" },
	};
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: message([toolCall], "toolUse") });
	return stream;
}

function latestUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const entry = context.messages[index];
		if (entry?.role !== "user") continue;
		if (isRuntimeString(entry.content)) return entry.content;
		return entry.content
			.filter((part): part is Extract<(typeof entry.content)[number], { type: "text" }> => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function resultText(result: ToolResultMessage): string {
	return result.content
		.filter((part): part is Extract<(typeof result.content)[number], { type: "text" }> => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function fixtureStream(context: Context) {
	const userText = latestUserText(context);
	if (userText.includes("probe after resume")) return textStream("MCP_RESUME_PROBE_DONE");
	const result = [...context.messages]
		.reverse()
		.find((entry): entry is ToolResultMessage => entry.role === "toolResult" && entry.toolName === "mcp");
	if (!result) return toolCallStream();
	const text = resultText(result);
	return textStream(
		text.includes(CALL_MARKER)
			? "MCP_TOOL_CALL_DONE"
			: `MCP_TOOL_CALL_BAD_RESULT ${text.replace(/\s+/gu, " ").slice(0, 240)}`,
	);
}

export default function mcpPtyProvider(pi: ExtensionAPI): void {
	registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Stuff MCP PTY fixture", (_model, context) =>
		fixtureStream(context),
	);
	pi.registerCommand("fixture-resume", {
		description: "Resume the isolated MCP Tool UI fixture session",
		handler: async (_args, ctx) => {
			const target = process.env["PI_STUFF_MCP_PTY_RESUME_TARGET"];
			if (!target) throw new Error("PI_STUFF_MCP_PTY_RESUME_TARGET is required");
			await ctx.switchSession(target);
		},
	});
}
