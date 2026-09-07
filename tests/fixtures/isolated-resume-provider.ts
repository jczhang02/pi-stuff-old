import type { Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { JsonInputObject } from "../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { createAssistantMessage, createTextStream, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-isolated-resume";
const MODEL = "fixture-model";
const message = createAssistantMessage(PROVIDER, MODEL);

function text(context: Context): string {
	const item = [...context.messages].reverse().find((entry) => entry.role === "user");
	if (item?.role !== "user") return "";
	return isRuntimeString(item.content)
		? item.content
		: item.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

function toolStream(toolCall: { id: string; name: string; arguments: JsonInputObject }) {
	const call = { ...toolCall, type: "toolCall" as const };
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	stream.push({ type: "start", partial: pending });
	pending.content.push(call);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: message([call], "toolUse") });
	return stream;
}

function providerStream(context: Context) {
	const user = text(context);
	const last = context.messages.at(-1);
	if (process.env["PI_SUBAGENT_CHILD"] === "1") {
		if (last?.role === "toolResult" && last.toolCallId === "resume-bash") {
			const output = last.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			if (last.isError || !output.includes("RETAINED_FROM_LAUNCH")) throw new Error("Resumed child lost its file");
			return createTextStream(message)("CHILD_RESUMED: verified RETAINED_FROM_LAUNCH");
		}
		if (user.includes("RESUME_AFTER_PAUSE")) {
			return toolStream({
				id: "resume-bash",
				name: "bash",
				arguments: {
					command: "pwd > resume-cwd.txt; cat retained.txt",
				},
			});
		}
		return toolStream({
			id: "launch-bash",
			name: "bash",
			arguments: {
				command:
					'pwd > launch-cwd.txt; printf RETAINED_FROM_LAUNCH > retained.txt; cp launch-cwd.txt "$PI_STUFF_RESUME_EVIDENCE/launch-cwd.txt"; sleep 60',
			},
		});
	}
	if (last?.role === "toolResult") return createTextStream(message)("PARENT_IDLE");
	if (user.includes("CHILD_RESUMED")) return createTextStream(message)("PARENT_INTEGRATED_RETAINED_WORK");
	const resumeId = user.match(/\bRESUME ([a-f0-9]{12})\b/u)?.[1];
	if (resumeId) {
		return toolStream({
			id: "resume-agent",
			name: "subagent",
			arguments: { action: "resume", id: resumeId, message: "RESUME_AFTER_PAUSE" },
		});
	}
	if (!user.includes("START ")) return createTextStream(message)("PARENT_IDLE");
	return toolStream({
		id: "launch-agent",
		name: "subagent",
		arguments: {
			agent: "isolated-resume",
			task: "START",
			context: "fresh",
			isolation: "worktree",
			foreground: user.includes("START foreground"),
		},
	});
}

export default function isolatedResumeProvider(pi: ExtensionAPI): void {
	registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Stuff isolated resume fixture", (_model, context) =>
		providerStream(context),
	);
}
