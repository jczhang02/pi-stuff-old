import { appendFileSync } from "node:fs";
import type { Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessage, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-tools-resume-pty";
const MODEL = "fixture-model";

const message = createAssistantMessage(PROVIDER, MODEL);

function fixtureStream(context: Context) {
	const logPath = process.env["PI_STUFF_TOOLS_RESUME_PTY_LOG"];
	if (logPath)
		appendFileSync(logPath, `${JSON.stringify({ tools: context.tools?.map((tool) => tool.name) ?? [] })}\n`);
	const text = "RESUME_PROBE_DONE";
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: pending });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
	stream.push({ type: "done", reason: "stop", message: message([{ type: "text", text }], "stop") });
	return stream;
}

export default function toolsResumePtyProvider(pi: ExtensionAPI): void {
	registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Stuff Tools Resume PTY fixture", (_model, context) =>
		fixtureStream(context),
	);
	pi.registerCommand("fixture-resume", {
		description: "Resume the isolated Tool UI fixture session",
		handler: async (_args, ctx) => {
			const target = process.env["PI_STUFF_TOOLS_RESUME_PTY_TARGET"];
			if (!target) throw new Error("PI_STUFF_TOOLS_RESUME_PTY_TARGET is required");
			await ctx.switchSession(target);
		},
	});
}
