import { appendFileSync } from "node:fs";
import type { Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { type ExtensionAPI, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Guard } from "typebox/guard";
import { createAssistantMessage, createTextStream, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-rtk-pty";
const MODEL = "fixture-model";
const RG_FILES_COMMAND = "rg --files -g '*.txt' .";
const RG_SEARCH_COMMAND = "rg -n RTK untracked.txt";
const LONG_OUTPUT_COMMAND =
	"printf '\\033[31mRAW_RTK_RESULT_MARKER\\033[0m\\n'; i=0; while [ \"$i\" -lt 1600 ]; do printf 'RAW_RTK_LONG_LINE_%04d\\n' \"$i\"; i=$((i + 1)); done";
const executedCommands: string[] = [];

const message = createAssistantMessage(PROVIDER, MODEL);
const textStream = createTextStream(message);

function toolCallStream(id: string, command: string) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCall = { type: "toolCall" as const, id, name: "bash", arguments: { command } };
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: message([toolCall], "toolUse") });
	return stream;
}

function contextRecord(context: Context, phase: string) {
	const bashCommands: string[] = [];
	const toolResults: Array<{ id: string; text: string }> = [];
	for (const entry of context.messages) {
		if (entry.role === "assistant") {
			for (const part of entry.content) {
				if (part.type !== "toolCall" || part.name !== "bash") continue;
				const command = part.arguments["command"];
				if (Guard.IsString(command)) bashCommands.push(command);
			}
		}
		if (entry.role !== "toolResult" || entry.toolName !== "bash") continue;
		toolResults.push({
			id: entry.toolCallId,
			text: entry.content
				.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n"),
		});
	}
	return { bashCommands, executedCommands: [...executedCommands], phase, toolResults };
}

function fixtureStream(context: Context) {
	const phase = process.env["PI_STUFF_RTK_PTY_PHASE"] ?? "fresh";
	const logPath = process.env["PI_STUFF_RTK_PTY_LOG"];
	if (logPath) appendFileSync(logPath, `${JSON.stringify(contextRecord(context, phase))}\n`);
	if (phase === "resume") return textStream("RTK_RESUME_DONE");
	const completed = context.messages.filter(
		(entry) => entry.role === "toolResult" && entry.toolName === "bash",
	).length;
	if (completed === 0) return toolCallStream("rtk-pty-git-status", "git status");
	if (completed === 1) return toolCallStream("rtk-pty-rg-files", RG_FILES_COMMAND);
	if (completed === 2) return toolCallStream("rtk-pty-rg-search", RG_SEARCH_COMMAND);
	if (completed === 3) return toolCallStream("rtk-pty-long-output", LONG_OUTPUT_COMMAND);
	return textStream("RTK_FRESH_DONE");
}

export default function rtkPtyProvider(pi: ExtensionAPI): void {
	pi.on("tool_call", (event) => {
		if (isToolCallEventType("bash", event)) executedCommands.push(event.input.command);
	});
	registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Stuff RTK PTY fixture", (_model, context) =>
		fixtureStream(context),
	);
}
