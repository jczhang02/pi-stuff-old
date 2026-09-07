import { appendFileSync } from "node:fs";
import type { Context, JsonValue } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessage, createTextStream, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-work-pty";
const MODEL = "fixture-model";
let requestNumber = 0;

const message = createAssistantMessage(PROVIDER, MODEL);
const textStream = createTextStream(message);

function toolStream(name: string, id: string, arguments_: Record<string, JsonValue>) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCall = { arguments: arguments_, id, name, type: "toolCall" as const };
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: message([toolCall], "toolUse") });
	return stream;
}

function fixtureStream(context: Context) {
	const current = requestNumber;
	requestNumber += 1;
	const tools = (context.tools ?? []).map((tool) => tool.name);
	const transcript = JSON.stringify(context.messages ?? []);
	const monitorCompletedNotification =
		transcript.includes('kind=\\"monitor\\"') && transcript.includes('status=\\"completed\\"');
	const shellCompletedNotification =
		transcript.includes('kind=\\"shell\\"') && transcript.includes('status=\\"completed\\"');
	const logPath = process.env["PI_STUFF_WORK_PTY_LOG"];
	if (logPath) {
		appendFileSync(
			logPath,
			`${JSON.stringify({
				monitorCompletedNotification,
				monitorTimedOutNotification:
					transcript.includes('kind=\\"monitor\\"') && transcript.includes('status=\\"timed_out\\"'),
				request: current,
				shellCompletedNotification,
				tools,
			})}\n`,
		);
	}
	switch (current) {
		case 0:
			return toolStream("bash", "work-foreground", {
				command: "echo $$ > foreground.pid; sleep 3; printf FOREGROUND_SHELL_DONE",
				description: "Foreground handoff fixture",
			});
		case 1:
			return textStream("CTRL_B_CONTINUED");
		case 2:
			return textStream(
				shellCompletedNotification
					? "FOREGROUND_HANDOFF_COMPLETION_REPORT"
					: "MISSING_FOREGROUND_HANDOFF_NOTIFICATION",
			);
		case 3:
			return toolStream("bash", "work-stop", {
				command: "echo $$ > stop.pid; sleep 30",
				description: "Stop control fixture",
				run_in_background: true,
			});
		case 4:
			return textStream("STOP_FIXTURE_CONTINUES");
		case 5:
			return toolStream("bash", "work-background", {
				command:
					"echo $$ > background.pid; while [ ! -f release.flag ]; do sleep 0.1; done; printf READY > ready.flag; printf BG_DONE",
				description: "Prepare monitored service",
				run_in_background: true,
			});
		case 6:
			return toolStream("monitor", "work-monitor", {
				description: "Wait for service readiness",
				interval_seconds: 0.1,
				source: "file",
				success_text: "READY",
				target: "ready.flag",
				timeout_seconds: 22,
			});
		case 7:
			return textStream("MAIN_CONTINUES");
		default:
			if (current >= 8) {
				return textStream(monitorCompletedNotification ? "MONITOR_RESUMED" : "DRAINING_PENDING_NOTIFICATION");
			}
			return textStream(`UNEXPECTED_REQUEST_${String(current)}`);
	}
}

export default function workPtyProvider(pi: ExtensionAPI): void {
	pi.registerCommand("work-wait-idle", {
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();
			ctx.ui.notify("WORK_PTY_IDLE", "info");
		},
	});
	registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Stuff Work PTY fixture", (_model, context) =>
		fixtureStream(context),
	);
}
