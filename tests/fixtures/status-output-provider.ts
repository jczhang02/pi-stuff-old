import { appendFileSync } from "node:fs";
import type { Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonValue } from "../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeObject, isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { createAssistantMessage, createTextStream, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-status-output";
const MODEL = "fixture-model";
const TAIL = "STATUS_OUTPUT_TAIL_MARKER";
const REPORT = `STATUS_OUTPUT_REPORT_START\n${"report-line-".repeat(120)}\n${TAIL}\nSTATUS_OUTPUT_REPORT_END`;
const message = createAssistantMessage(PROVIDER, MODEL);
const answer = createTextStream(message);

function textResult(context: Context, toolName: string): string | undefined {
	const entry = [...context.messages]
		.reverse()
		.find((item) => item.role === "toolResult" && item.toolName === toolName);
	if (!entry) return undefined;
	if (!Array.isArray(entry.content)) return entry.content;
	return entry.content
		.flatMap((part) => (isRuntimeObject(part) && part !== null && part.type === "text" ? [part.text] : []))
		.join("\n");
}

function launchRunId(context: Context): string | undefined {
	for (const item of [...context.messages].reverse()) {
		if (item.role !== "toolResult" || item.toolName !== "subagent") continue;
		if (!("details" in item)) continue;
		const details = item.details;
		if (!isRuntimeObject(details) || details === null || !("runId" in details)) continue;
		if (isRuntimeString(details.runId)) return details.runId;
	}
	return undefined;
}

function call(id: string, name: string, arguments_: Record<string, JsonValue>) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCall = { type: "toolCall" as const, id, name, arguments: arguments_ };
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: message([toolCall], "toolUse") });
	return stream;
}

function providerStream(context: Context) {
	if (process.env["PI_SUBAGENT_CHILD"] === "1") return answer(REPORT);
	const subagent = textResult(context, "subagent");
	if (!subagent) {
		const arguments_ =
			process.env["PI_STUFF_STATUS_OUTPUT_FOREGROUND"] === "1"
				? { agent: "status-worker", task: "Return the retained report.", foreground: true }
				: { agent: "status-worker", task: "Return the retained report." };
		return call("status-launch", "subagent", arguments_);
	}
	if (
		process.env["PI_STUFF_STATUS_OUTPUT_FOREGROUND"] !== "1" &&
		!context.messages.some(
			(entry) => entry.role === "user" && JSON.stringify(entry.content).includes("INSPECT_COMPLETED_REPORT"),
		)
	)
		return answer("BACKGROUND_LAUNCHED");
	if (!subagent.includes("Output:")) {
		if (context.messages.filter((entry) => entry.role === "toolResult" && entry.toolName === "subagent").length > 1)
			return answer("STATUS_OUTPUT_FAILED_NO_LOCATOR");
		const id = launchRunId(context);
		if (!id) return answer(`STATUS_OUTPUT_FAILED_NO_ID\n${subagent}`);
		return call("status-check", "subagent", { action: "status", id });
	}
	if (process.env["PI_STUFF_STATUS_OUTPUT_LOG"])
		appendFileSync(process.env["PI_STUFF_STATUS_OUTPUT_LOG"], `${subagent}\n`);
	if (subagent.includes(TAIL) || !subagent.includes("Progress (excerpt)"))
		return answer("STATUS_OUTPUT_FAILED_STATUS");
	const outputPath = /^Output: (.+)$/mu.exec(subagent)?.[1];
	if (!outputPath) return answer("STATUS_OUTPUT_FAILED_NO_LOCATOR");
	const read = textResult(context, "read");
	if (!read) return call("status-read", "read", { path: outputPath });
	return answer(read.length > 800 && read.includes(TAIL) ? "STATUS_OUTPUT_READ_OK" : "STATUS_OUTPUT_READ_FAILED");
}

export default function statusOutputProvider(pi: ExtensionAPI): void {
	registerFixtureProvider(pi, PROVIDER, MODEL, "Status output locator fixture", (_model, context) =>
		providerStream(context),
	);
}
