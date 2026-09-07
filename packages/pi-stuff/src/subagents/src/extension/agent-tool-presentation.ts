import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Static } from "typebox";
import { isRuntimeString } from "../../../shared/runtime-type.ts";
import type { ToolArguments } from "../../../tool-display/activity.ts";
import type { ToolActivityState } from "../../../tool-display/activity-store.ts";
import {
	activityKey,
	boundTerminalLine,
	formatElapsed,
	type SuiteToolPresentation,
	singleActivity,
} from "../../../tool-display/index.ts";
import { boundedTerminalLine, resolveDisplayDescription } from "../shared/display-description.ts";
import type { Details } from "../shared/types.ts";
import type { FanoutChildSubagentParams, SubagentParams } from "./schemas.ts";

type AgentPresentationParams =
	| (Static<typeof FanoutChildSubagentParams> & ToolArguments)
	| (Static<typeof SubagentParams> & ToolArguments);

const PRESENTATION_PREVIEW_WIDTH = 160;
const AGENT_ACTION_PRESENTATION = {
	resume: { category: "resume-agent", summary: "resumed" },
	status: { category: "check-agent", summary: "checked" },
	steer: { category: "steer-agent", summary: "sent" },
	stop: { category: "stop-agent", summary: "stopped" },
} as const;

function firstText(result: AgentToolResult<Details>): string {
	for (const entry of result.content) {
		if (entry.type !== "text") continue;
		const preview = boundTerminalLine(entry.text, PRESENTATION_PREVIEW_WIDTH);
		if (preview) return preview;
	}
	return "";
}

function action(params: AgentPresentationParams): keyof typeof AGENT_ACTION_PRESENTATION | undefined {
	switch (params.action) {
		case "resume":
		case "status":
		case "steer":
		case "stop":
			return params.action;
		default:
			return undefined;
	}
}

function launchTarget(agent: string | undefined, description: string | undefined, task: string | undefined): string {
	const safeAgent = boundedTerminalLine(agent);
	const safeTask = boundedTerminalLine(description) || boundedTerminalLine(task);
	return [safeAgent, safeTask ? resolveDisplayDescription(description, task) : ""].filter(Boolean).join(" · ");
}

function requestedLaunchCount(params: AgentPresentationParams): number {
	if (Array.isArray(params.tasks)) {
		return params.tasks.filter((task) => boundedTerminalLine(task?.agent) && boundedTerminalLine(task?.task)).length;
	}
	return boundedTerminalLine(params.agent) && boundedTerminalLine(params.task) ? 1 : 0;
}

function launchedCount(params: AgentPresentationParams, result?: AgentToolResult<Details>): number {
	if (!result) return 0;
	if (params.foreground === true) return Array.isArray(result.details?.results) ? result.details.results.length : 0;
	return isRuntimeString(result.details?.asyncId) && result.details.asyncId.trim() ? requestedLaunchCount(params) : 0;
}

function label(params: AgentPresentationParams): string {
	const operation = action(params);
	if (operation) return `Agent ${operation}`;
	return Array.isArray(params.tasks) ? "Agents" : "Agent";
}

function target(params: AgentPresentationParams): string {
	if (action(params)) return boundedTerminalLine(params.id);
	const operation = params.foreground === true ? "run" : "launch";
	const identity =
		Array.isArray(params.tasks) && params.tasks.length > 0
			? params.tasks
					.slice(0, 32)
					.map((task) => launchTarget(task?.agent, task?.description, task?.task))
					.filter(Boolean)
					.join(", ")
			: launchTarget(params.agent, params.description, params.task);
	return identity ? `${operation} · ${identity}` : "";
}

function usefulDuration(params: AgentPresentationParams, durationMs: number | undefined): string {
	return params.foreground === true && durationMs !== undefined && durationMs >= 1_000
		? ` · ${formatElapsed(durationMs)}`
		: "";
}

function successSummary(
	params: AgentPresentationParams,
	result: AgentToolResult<Details>,
	durationMs: number | undefined,
): string {
	const operation = action(params);
	if (operation) return AGENT_ACTION_PRESENTATION[operation].summary;
	if (params.foreground === true) return `finished${usefulDuration(params, durationMs)}`;
	const count = launchedCount(params, result);
	return count > 1 ? `${String(count)} launched` : "launched";
}

function taskRows(params: AgentPresentationParams, result: AgentToolResult<Details>, state: string): string[] {
	const tasks = Array.isArray(params.tasks)
		? params.tasks.map((task) => ({ agent: boundedTerminalLine(task?.agent), task: boundedTerminalLine(task?.task) }))
		: [{ agent: boundedTerminalLine(params.agent), task: boundedTerminalLine(params.task) }];
	return tasks.flatMap((task, index) => {
		if (!task.agent && !task.task) return [];
		const settled = result.details?.results?.[index];
		const memberState =
			params.foreground !== true || state !== "success"
				? state
				: settled?.stopped || settled?.interrupted || settled?.detached
					? "stopped"
					: settled?.error || (settled && settled.exitCode !== 0)
						? "failed"
						: "finished";
		return [`${task.agent || "Agent"} · ${task.task || "Task unavailable"} · ${memberState}`];
	});
}

function resultLines(result: AgentToolResult<Details>): string[] {
	return result.content.flatMap((entry) => (entry.type === "text" ? entry.text.split(/\r?\n/u) : []));
}

function foregroundEvidence(result: AgentToolResult<Details>): string[] {
	const lines = resultLines(result).filter(
		(line) =>
			!/^Agent .+ (?:completed|failed|status unknown|stopped)\.$/u.test(line) &&
			!/^\d+\. .+ — (?:completed|failed|status unknown|stopped)$/u.test(line),
	);
	while (lines[0]?.trim() === "") lines.shift();
	while (lines.at(-1)?.trim() === "") lines.pop();
	return lines.filter((line, index) => line.trim() || lines[index - 1]?.trim());
}

function detailLines(
	params: AgentPresentationParams,
	result: AgentToolResult<Details>,
	state: Exclude<ToolActivityState, "running">,
): string[] {
	if (action(params)) return resultLines(result);
	const tasks = taskRows(
		params,
		result,
		params.foreground === true && state === "success" ? "finished" : state === "success" ? "launched" : state,
	);
	if (params.foreground !== true && state === "success") return tasks;
	const output = params.foreground === true ? foregroundEvidence(result) : resultLines(result);
	return output.length > 0 ? [...tasks, "", ...output] : tasks;
}

/** One shared row grammar for root and nested public Agent tools. */
export function createAgentToolPresentation(): SuiteToolPresentation<AgentPresentationParams, Details> {
	return {
		activity: {
			categories: ["check-agent", "launch-agent", "resume-agent", "run-agent", "steer-agent", "stop-agent"],
			classify: ({ args, result }) => {
				const operation = action(args);
				if (operation) {
					return singleActivity(AGENT_ACTION_PRESENTATION[operation].category, {
						key: activityKey(args.id, operation),
						target: target(args),
					});
				}
				const count = launchedCount(args, result);
				if (count === 0) return [];
				const category = args.foreground === true ? "run-agent" : "launch-agent";
				return singleActivity(category, { count, target: target(args) });
			},
			summarizeIssue: (_args, result, state) => firstText(result) || state,
		},
		detailLines,
		detailSections: (params, result, state) => {
			const operation = action(params);
			const tasks = operation
				? [`${operation}${boundedTerminalLine(params.id) ? ` · ${boundedTerminalLine(params.id)}` : ""}`]
				: taskRows(
						params,
						result,
						state === "success" ? (params.foreground === true ? "finished" : "launched") : state,
					);
			const output = params.foreground === true ? foregroundEvidence(result) : resultLines(result);
			const sections = [{ lines: tasks, title: "Task" }];
			if (output.length > 0 && (params.foreground === true || state !== "success")) {
				sections.push({
					lines: output,
					title:
						state === "success"
							? "Result"
							: state === "error"
								? "Error"
								: state === "rejected"
									? "Rejection"
									: "Cancellation",
				});
			}
			return sections;
		},
		label,
		resultIsError: (params, result) => {
			if (Object.getOwnPropertyDescriptor(result, "isError")?.value === true) return true;
			return action(params) ? false : launchedCount(params, result) === 0;
		},
		runningSummary: (params, durationMs) => `working${usefulDuration(params, durationMs)}`,
		summarize: (params, result, state, durationMs) => {
			if (state === "success") return successSummary(params, result, durationMs);
			const summary =
				state === "cancelled" ? "cancelled" : state === "rejected" ? "rejected" : firstText(result) || "failed";
			return `${summary}${usefulDuration(params, durationMs)}`;
		},
		target,
		tracksElapsed: true,
	};
}
