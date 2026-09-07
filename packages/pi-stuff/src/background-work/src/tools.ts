import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import {
	activityKey,
	BASH_CODE_MODE_CONTRACT,
	bashResultMovedToBackground,
	boundTerminalLine,
	classifyBashActivity,
	registerSuiteOwnedTool,
	type SuiteToolPresentation,
	type SuiteToolRegistrationHost,
	singleActivity,
} from "../../tool-display/index.ts";
import { startMonitor } from "./monitor.ts";
import { DEFAULT_MODEL_OUTPUT_LIMIT } from "./output.ts";
import type { BackgroundWorkBashDetails, BackgroundWorkOutcome, BackgroundWorkRuntime } from "./runtime.ts";

const BASH_PARAMETERS = Type.Object({
	command: Type.String({ description: "Shell command to execute", maxLength: 1_000_000, minLength: 1 }),
	description: Type.Optional(
		Type.String({ description: "Short task-oriented label shown in /tasks", maxLength: 160, minLength: 1 }),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description: "Start an independent detached command without automatically starting a later Agent turn",
		}),
	),
	timeout: Type.Optional(
		Type.Number({
			description: "Maximum command runtime in seconds; omit for no runtime limit",
			minimum: 0.1,
		}),
	),
});

const BACKGROUND_PARAMETERS = Type.Object({
	action: Type.Union([Type.Literal("list"), Type.Literal("output"), Type.Literal("stop")]),
	max_bytes: Type.Optional(
		Type.Integer({ description: "Maximum recent output bytes", maximum: 51_200, minimum: 1_024 }),
	),
	task_id: Type.Optional(Type.String({ maxLength: 64, minLength: 1 })),
});

const MONITOR_PARAMETERS = Type.Object({
	description: Type.Optional(Type.String({ maxLength: 160, minLength: 1 })),
	failure_text: Type.Optional(
		Type.String({ description: "Exact substring that ends the Monitor as failed", maxLength: 4_096, minLength: 1 }),
	),
	interval_seconds: Type.Optional(
		Type.Number({ description: "Polling interval for file, log, and HTTP sources", maximum: 60, minimum: 0.1 }),
	),
	source: Type.Union([Type.Literal("command"), Type.Literal("file"), Type.Literal("http"), Type.Literal("log")]),
	start_at_end: Type.Optional(
		Type.Boolean({ description: "For log sources, ignore content that already exists when the Monitor starts" }),
	),
	success_text: Type.Optional(
		Type.String({ description: "Exact substring that satisfies the Monitor", maxLength: 4_096, minLength: 1 }),
	),
	target: Type.String({
		description: "Command, file path, log path, or HTTP(S) URL",
		maxLength: 1_000_000,
		minLength: 1,
	}),
	timeout_seconds: Type.Optional(
		Type.Number({
			description: "Deadline for observing the condition; defaults to 600 seconds",
			minimum: 0.1,
		}),
	),
});

interface WorkToolDetails {
	readonly action?: string;
	readonly error?: string;
	readonly outputPath?: string;
	readonly status?: string;
	readonly taskId?: string;
}

export interface WorkToolRuntimeRef {
	current(): BackgroundWorkRuntime | undefined;
}

function textResult<T>(text: string, details: T, isError = false): AgentToolResult<T> {
	const result = isError
		? { content: [{ type: "text" as const, text }], details, isError: true }
		: { content: [{ type: "text" as const, text }], details };
	return result;
}

function firstLine(value: string | undefined): string {
	return isRuntimeString(value) ? boundTerminalLine(value.split(/\r?\n/u)[0] ?? "", 180) : "";
}

function resultText<T>(result: AgentToolResult<T>): string {
	const item = result.content.find((content) => content.type === "text");
	return item?.type === "text" ? item.text : "";
}

export function isForegroundBashResult(result: AgentToolResult<unknown>): boolean {
	const details = result.details;
	return !(
		(isRuntimeObject(details) &&
			details !== null &&
			"backgroundTaskId" in details &&
			isRuntimeString(details.backgroundTaskId)) ||
		bashResultMovedToBackground(result)
	);
}

function backgroundBashDetailLines(result: AgentToolResult<BackgroundWorkBashDetails | undefined>): readonly string[] {
	const taskId = result.details?.backgroundTaskId;
	if (!taskId) return [];
	const outputPath = result.details?.fullOutputPath;
	const lines = [`Started in background · ${taskId}`];
	if (outputPath) lines.push("", "Output file", outputPath);
	lines.push("", "Result will be delivered automatically.");
	return lines;
}

function requireRuntime(ref: WorkToolRuntimeRef): BackgroundWorkRuntime {
	const runtime = ref.current();
	if (!runtime) throw new Error("Background Work is not available before session startup or during shutdown");
	return runtime;
}

function requireTaskId(value: string | undefined, action: string): string {
	const id = value?.trim();
	if (!id) throw new Error(`background ${action} requires task_id`);
	return id;
}

function outcomeText(outcome: BackgroundWorkOutcome): string {
	const output = outcome.recentOutput?.trim();
	return output ? `${outcome.summary}\n\n${output}` : outcome.summary;
}

function listText(runtime: BackgroundWorkRuntime): string {
	const snapshots = runtime.snapshot();
	if (snapshots.length === 0) return "No Background Shell or Monitor activity is running in this session.";
	return snapshots.map((task) => `${task.id}  ${task.kind}  ${task.status}  ${task.title}`).join("\n");
}

const backgroundPresentation: SuiteToolPresentation<Static<typeof BACKGROUND_PARAMETERS>, WorkToolDetails> = {
	activity: {
		categories: ["inspect-background", "read-background", "stop-background"],
		classify: ({ args }) => {
			const action = String(args["action"] ?? "list");
			const taskId = isRuntimeString(args["task_id"]) ? args["task_id"] : action;
			if (action === "output")
				return singleActivity("read-background", { key: activityKey(taskId), target: taskId });
			if (action === "stop") return singleActivity("stop-background", { key: activityKey(taskId), target: taskId });
			return singleActivity("inspect-background", { count: 1, target: "background tasks" });
		},
		summarizeIssue: (_args, result, state) => result.details.error ?? (firstLine(resultText(result)) || state),
	},
	label: "Background",
	resultIsError: (_args, result) => Boolean(result.details.error),
	runningSummary: "checking",
	summarize: (_args, result) =>
		result.details.error ?? result.details.status ?? (firstLine(resultText(result)) || "done"),
	target: (args) => (isRuntimeString(args["task_id"]) ? args["task_id"] : String(args["action"] ?? "")),
};

function registerBashTool(pi: SuiteToolRegistrationHost, runtimeRef: WorkToolRuntimeRef): void {
	registerSuiteOwnedTool<typeof BASH_PARAMETERS, BackgroundWorkBashDetails | undefined>(
		pi,
		{
			name: "bash",
			label: "bash",
			description:
				"Execute a shell command in the current working directory. Output is bounded. Set run_in_background for servers or other independent long work that should not start another Agent turn; a foreground command still running after two minutes moves to the background and resumes the Agent when it settles. timeout limits total runtime and stops the process tree.",
			promptSnippet: "Execute shell commands; use run_in_background for independent long-running work",
			promptGuidelines: [
				"Continue useful work after a foreground Bash moves to the background; its terminal result resumes you automatically, so do not create a Monitor merely to watch that Shell.",
				"After a handed-off foreground Bash settles, inspect its result, finish the original work, and provide a Completion Report only when no required work remains.",
				"Inspect PI_* environment variables for current model and session details.",
			],
			parameters: BASH_PARAMETERS,
			async execute(_toolCallId, params, signal, onUpdate, ctx) {
				const input = { command: params.command };
				if (params.description) Object.assign(input, { description: params.description });
				if (onUpdate) Object.assign(input, { onUpdate });
				if (params.run_in_background !== undefined)
					Object.assign(input, { runInBackground: params.run_in_background });
				if (signal) Object.assign(input, { signal });
				if (params.timeout !== undefined) Object.assign(input, { timeoutSeconds: params.timeout });
				return requireRuntime(runtimeRef).executeBash(input, ctx);
			},
		},
		{
			activity: {
				categories: ["commit", "push", "merge", "rebase", "create-pr", "launch-background", "run-command"],
				classify: (input) => {
					if (input.result && !isForegroundBashResult(input.result)) {
						const taskId = input.result.details?.backgroundTaskId;
						return singleActivity("launch-background", {
							key: activityKey(taskId ?? input.args.description ?? input.args.command),
							target: firstLine(input.args.description) || "background command",
						});
					}
					return classifyBashActivity(input);
				},
				summarizeIssue: (_args, result, state) => {
					const line = resultText(result).trim().split(/\r?\n/u).at(-1)?.trim();
					return line || state;
				},
			},
			detailLines: (_args, result) => backgroundBashDetailLines(result),
			label: "Bash",
			runningSummary: (_args, durationMs) =>
				`running ${String(Math.max(0, Math.floor((durationMs ?? 0) / 1_000)))}s`,
			summarize: (_args, result, state) => {
				const id = result.details?.backgroundTaskId;
				if (id) return `background · ${id}`;
				if (state === "success") return "done";
				const terminal = resultText(result).trim().split(/\r?\n/u).at(-1)?.trim();
				return terminal || state;
			},
			target: (args) => firstLine(args.description) || "command",
			tracksElapsed: true,
		},
		BASH_CODE_MODE_CONTRACT,
	);
}

export function registerWorkTools(
	pi: SuiteToolRegistrationHost,
	runtimeRef: WorkToolRuntimeRef,
	options: { readonly includeBash?: boolean } = {},
): void {
	const includeBash = options.includeBash !== false;
	const bashWasActive = includeBash ? pi.getActiveTools().includes("bash") : false;
	if (includeBash) registerBashTool(pi, runtimeRef);

	const background: ToolDefinition<typeof BACKGROUND_PARAMETERS, WorkToolDetails> = {
		name: "background",
		label: "Background",
		description:
			"Inspect or stop current-session Background Shell and Monitor activities. Completion is delivered automatically; use output only when current evidence is specifically needed.",
		parameters: BACKGROUND_PARAMETERS,
		executionMode: "parallel",
		async execute(_toolCallId, params) {
			try {
				const runtime = requireRuntime(runtimeRef);
				await runtime.prepare();
				if (params.action === "list") return textResult(listText(runtime), { action: "list", status: "listed" });
				const taskId = requireTaskId(params.task_id, params.action);
				if (params.action === "output") {
					const output = runtime.readOutput(taskId, params.max_bytes ?? DEFAULT_MODEL_OUTPUT_LIMIT);
					return textResult(output, { action: "output", status: "read", taskId });
				}
				const outcome = await runtime.stop(taskId);
				const details: WorkToolDetails = outcome.outputPath
					? { action: "stop", outputPath: outcome.outputPath, status: outcome.status, taskId }
					: { action: "stop", status: outcome.status, taskId };
				return textResult(outcomeText(outcome), details);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(`Error: ${message}`, { action: params.action, error: message }, true);
			}
		},
	};
	registerSuiteOwnedTool(pi, background, backgroundPresentation);

	const monitor: ToolDefinition<typeof MONITOR_PARAMETERS, WorkToolDetails> = {
		name: "monitor",
		label: "Monitor",
		description:
			"Wait asynchronously for one explicit command, file, new log text, or HTTP condition. The tool returns immediately, wakes the Agent once on success/failure/timeout, and must not be followed by conversational polling.",
		promptSnippet: "Wait asynchronously for one known command, file, log, or HTTP condition",
		promptGuidelines: [
			"Use Monitor only for a concrete observable condition with a deadline; after it starts, continue useful work and do not poll it from the conversation.",
			"Do not use Monitor merely to watch a foreground Bash that moved to Background Work; that Shell resumes the Agent when it settles.",
		],
		parameters: MONITOR_PARAMETERS,
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			try {
				const runtime = requireRuntime(runtimeRef);
				await runtime.prepare();
				const input = { source: params.source, target: params.target };
				if (params.description) Object.assign(input, { description: params.description });
				if (params.failure_text) Object.assign(input, { failureText: params.failure_text });
				if (params.interval_seconds !== undefined)
					Object.assign(input, { intervalSeconds: params.interval_seconds });
				if (params.start_at_end !== undefined) Object.assign(input, { startAtEnd: params.start_at_end });
				if (params.success_text) Object.assign(input, { successText: params.success_text });
				if (params.timeout_seconds !== undefined) Object.assign(input, { timeoutSeconds: params.timeout_seconds });
				const started = await startMonitor(runtime, input, ctx);
				const details: WorkToolDetails = started.outputPath
					? { outputPath: started.outputPath, status: "running", taskId: started.id }
					: { status: "running", taskId: started.id };
				return textResult(
					`Monitor ${started.id} is waiting for "${started.title}". Its terminal result will be delivered automatically; continue useful work instead of polling.`,
					details,
				);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return textResult(`Error: ${message}`, { error: message }, true);
			}
		},
	};
	registerSuiteOwnedTool(pi, monitor, {
		activity: {
			categories: ["start-monitor"],
			classify: ({ args, result }) =>
				singleActivity("start-monitor", {
					key: activityKey(result?.details.taskId ?? args.target),
					target: firstLine(args.description) || `${args.source} monitor`,
				}),
			summarizeIssue: (_args, result, state) => result.details.error ?? (firstLine(resultText(result)) || state),
		},
		label: "Monitor",
		resultIsError: (_args, result) => Boolean(result.details.error),
		runningSummary: "starting",
		summarize: (_args, result) => result.details.error ?? `waiting · ${result.details.taskId ?? "—"}`,
		target: (args) => firstLine(args.target),
	});
	if (includeBash && !bashWasActive) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "bash"));
}
