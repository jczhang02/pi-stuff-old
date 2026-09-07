import { appendFileSync } from "node:fs";
import type { Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { createAssistantMessage, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-work-monitor-matrix";
const MODEL = "fixture-model";
const MARKER = "WORK_MONITOR_SCENARIO:";
const MONITOR_RESULT_SCHEMA = Type.Object(
	{
		details: Type.Object(
			{ status: Type.Optional(Type.String()), taskId: Type.Optional(Type.String()) },
			{ additionalProperties: true },
		),
	},
	{ additionalProperties: true },
);

const SCENARIO_SCHEMA = Type.Union([
	Type.Literal("cancel"),
	Type.Literal("command_failure"),
	Type.Literal("file_error"),
	Type.Literal("http_success"),
	Type.Literal("log_success"),
	Type.Literal("timeout"),
]);
type Scenario = Static<typeof SCENARIO_SCHEMA>;

const TITLES = {
	cancel: "Matrix cancellation",
	command_failure: "Matrix command failure",
	file_error: "Matrix source failure",
	http_success: "Matrix HTTP success",
	log_success: "Matrix log success",
	timeout: "Matrix timeout",
} satisfies Readonly<Record<Scenario, string>>;

const message = createAssistantMessage(PROVIDER, MODEL);

function textStream(text: string) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	stream.push({ type: "start", partial: pending });
	pending.content.push({ type: "text", text });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: pending });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
	stream.push({ type: "done", reason: "stop", message: message([{ type: "text", text }], "stop") });
	return stream;
}

function toolStream<Arguments extends object>(name: string, id: string, arguments_: Arguments) {
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

function userTexts(context: Context): string[] {
	return context.messages.flatMap((entry) => {
		if (entry.role !== "user") return [];
		if (isRuntimeString(entry.content)) return [entry.content];
		return entry.content
			.filter((part): part is { readonly text: string; readonly type: "text" } => part.type === "text")
			.map((part) => part.text);
	});
}

function currentScenario(context: Context): Scenario | undefined {
	for (const text of userTexts(context).reverse()) {
		if (!text.includes(MARKER)) continue;
		const candidate = text
			.slice(text.indexOf(MARKER) + MARKER.length)
			.trim()
			.split(/\s/u)[0];
		if (Check(SCENARIO_SCHEMA, candidate)) return candidate;
	}
	return undefined;
}

function terminalStatus(context: Context, scenario: Scenario): string | undefined {
	if (scenario === "cancel") {
		const stopped = toolResult(context, `matrix-stop-${scenario}`);
		if (Check(MONITOR_RESULT_SCHEMA, stopped)) return stopped.details.status;
	}
	for (const text of userTexts(context).reverse()) {
		if (!text.includes("<background-work-notification>") || !text.includes(TITLES[scenario])) continue;
		return /kind="monitor" status="([^"]+)"/u.exec(text)?.[1];
	}
	return undefined;
}

function toolResult(context: Context, id: string): Context["messages"][number] | undefined {
	return context.messages.find((entry) => entry.role === "toolResult" && entry.toolCallId === id);
}

function taskId<Result>(result: Result): string | undefined {
	return Check(MONITOR_RESULT_SCHEMA, result) ? result.details.taskId : undefined;
}

function record<Value extends object>(value: Value): void {
	const path = process.env["PI_STUFF_WORK_MONITOR_MATRIX_LOG"];
	if (path) appendFileSync(path, `${JSON.stringify({ at: Date.now(), ...value })}\n`);
}

interface MonitorArguments {
	readonly description: string;
	readonly failure_text?: string;
	readonly interval_seconds: number;
	readonly source: "command" | "file" | "http" | "log";
	readonly start_at_end?: boolean;
	readonly success_text?: string;
	readonly target: string;
	readonly timeout_seconds: number;
}

function monitorArguments(scenario: Scenario): MonitorArguments {
	const common = { description: TITLES[scenario], interval_seconds: 0.1 };
	switch (scenario) {
		case "command_failure":
			return { ...common, failure_text: "ERROR", source: "command", target: "printf ERROR", timeout_seconds: 2 };
		case "file_error":
			return { ...common, source: "file", success_text: "READY", target: ".", timeout_seconds: 2 };
		case "timeout":
			return {
				...common,
				source: "file",
				success_text: "READY",
				target: "matrix-never-created",
				timeout_seconds: 0.3,
			};
		case "http_success": {
			const target = process.env["PI_STUFF_WORK_MONITOR_HTTP_URL"];
			if (!target) throw new Error("Monitor matrix HTTP URL is missing");
			return { ...common, source: "http", success_text: "READY", target, timeout_seconds: 2 };
		}
		case "log_success": {
			const target = process.env["PI_STUFF_WORK_MONITOR_LOG_PATH"];
			if (!target) throw new Error("Monitor matrix log path is missing");
			return {
				...common,
				source: "log",
				start_at_end: true,
				success_text: "READY",
				target,
				timeout_seconds: 2,
			};
		}
		case "cancel":
			return {
				...common,
				source: "file",
				success_text: "READY",
				target: "matrix-cancel-never-created",
				timeout_seconds: 10,
			};
	}
}

function fixtureStream(context: Context) {
	const scenario = currentScenario(context);
	if (!scenario) return textStream("MATRIX_READY");
	const monitorId = `matrix-monitor-${scenario}`;
	const monitorResult = toolResult(context, monitorId);
	const status = terminalStatus(context, scenario);
	if (status) {
		if (monitorResult) record({ phase: "continued", scenario });
		record({ phase: "terminal", scenario, status });
		return textStream(`MATRIX_${scenario.toUpperCase()}_${status.toUpperCase()}`);
	}
	if (!monitorResult) return toolStream("monitor", monitorId, monitorArguments(scenario));
	record({ phase: "continued", scenario });
	if (scenario === "cancel") {
		const stopId = `matrix-stop-${scenario}`;
		if (!toolResult(context, stopId)) {
			const id = taskId(monitorResult);
			if (!id) throw new Error("Cancellation scenario has no Monitor task id");
			return toolStream("background", stopId, { action: "stop", task_id: id });
		}
	}
	return textStream(`MATRIX_${scenario.toUpperCase()}_CONTINUES`);
}

export default function workMonitorMatrixProvider(pi: ExtensionAPI): void {
	registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Stuff Work Monitor matrix", (_model, context) =>
		fixtureStream(context),
	);
}
