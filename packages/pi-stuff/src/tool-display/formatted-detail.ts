import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { isRuntimeObject, isRuntimeString } from "../shared/runtime-type.ts";
import type { ToolArguments } from "./activity.ts";
import type { ToolActivityState } from "./activity-store.ts";
import type { ToolFormattedSection } from "./contract.ts";
import { operationDetailSections } from "./operation-block-formatted-detail.ts";
import { buildToolResultLines, oneLine } from "./tool-text.ts";

function argument(args: ToolArguments, ...keys: string[]): string {
	for (const key of keys) {
		const value = args[key];
		if (isRuntimeString(value) && value.trim()) return value;
	}
	return "";
}

function resultLines(result: AgentToolResult<unknown>, preferred: readonly string[] | undefined): string[] {
	return preferred && preferred.length > 0 ? [...preferred] : buildToolResultLines(result);
}

function issueTitle(state: Exclude<ToolActivityState, "running" | "success">): string {
	return state === "error" ? "Error" : state === "rejected" ? "Rejection" : "Cancellation";
}

function one(title: string, lines: readonly string[]): ToolFormattedSection[] {
	return [{ lines, title }];
}

function taskSections(
	args: ToolArguments,
	lines: readonly string[],
	state: Exclude<ToolActivityState, "running">,
): ToolFormattedSection[] {
	const tasks = Array.isArray(args["tasks"])
		? args["tasks"].flatMap((candidate) => {
				if (!isRuntimeObject(candidate) || candidate === null || Array.isArray(candidate)) return [];
				const agent = isRuntimeString(candidate["agent"]) ? oneLine(candidate["agent"]) : "Agent";
				const task = isRuntimeString(candidate["description"])
					? oneLine(candidate["description"])
					: isRuntimeString(candidate["task"])
						? oneLine(candidate["task"])
						: "";
				return task ? [`${agent} · ${task}`] : [];
			})
		: [];
	const singleTask = oneLine(argument(args, "task", "description", "prompt"));
	const action = oneLine(argument(args, "action"));
	const id = oneLine(argument(args, "id"));
	const taskLines =
		tasks.length > 0
			? tasks
			: singleTask
				? [singleTask]
				: action
					? [`${action}${id ? ` · ${id}` : ""}`]
					: ["Task recorded."];
	const sections: ToolFormattedSection[] = [{ lines: taskLines, title: "Task" }];
	if (state !== "success") sections.push({ lines, title: issueTitle(state) });
	else if (args["foreground"] === true && lines.length > 0) sections.push({ lines, title: "Result" });
	return sections;
}

function mcpSections(
	args: ToolArguments,
	lines: readonly string[],
	state: Exclude<ToolActivityState, "running">,
): ToolFormattedSection[] {
	const tool = oneLine(argument(args, "tool"));
	if (!tool) {
		const title = args["search"] !== undefined ? "Matches" : args["describe"] !== undefined ? "Tools" : "Tools";
		return one(title, lines);
	}
	const server = oneLine(argument(args, "server"));
	const sections: ToolFormattedSection[] = [{ lines: [server ? `${server}:${tool}` : tool], title: "Invocation" }];
	sections.push({ lines, title: state === "success" ? "Result" : issueTitle(state) });
	return sections;
}

function webSearchSections(lines: readonly string[]): ToolFormattedSection[] {
	const sources = lines.filter((line) => /https?:\/\//u.test(line));
	const answer = lines.filter((line) => !sources.includes(line));
	return [
		{ lines: answer.length > 0 ? answer : ["No synthesized answer."], title: "Answer" },
		{ lines: sources.length > 0 ? sources : ["No source list returned."], title: "Sources" },
	];
}

function semanticTitle(name: string): string {
	switch (name) {
		case "read":
			return "Content";
		case "grep":
			return "Matches";
		case "find":
			return "Files";
		case "ls":
			return "Entries";
		case "view_image":
			return "Image";
		case "fetch_content":
			return "Document";
		case "get_search_content":
			return "Matches";
		case "goal_blocked":
			return "Reason";
		case "monitor":
			return "Monitor";
		case "TaskCreate":
		case "TaskGet":
			return "Task";
		case "TaskList":
			return "Tasks";
		case "TaskUpdate":
			return "Change";
		case "ctx_expand":
			return "Result";
		case "ctx_search":
			return "Matches";
		case "ctx_memory":
			return "Memory";
		case "ctx_note":
			return "Note";
		case "ctx_reduce":
			return "Reduction";
		case "structured_output":
			return "Output";
		case "tool_search":
			return "Matches";
		default:
			return "Result";
	}
}

export function formattedToolSections(
	name: string,
	args: ToolArguments,
	result: AgentToolResult<unknown>,
	state: Exclude<ToolActivityState, "running">,
	preferredLines?: readonly string[],
): readonly ToolFormattedSection[] {
	const operation = operationDetailSections(name, args, result, state);
	if (operation) return operation;
	const lines = resultLines(result, preferredLines);
	if (name === "bash") {
		return [
			{
				lines: argument(args, "command") ? argument(args, "command").split(/\r?\n/u) : ["Command unavailable."],
				title: "Command",
			},
			{ lines, title: state === "success" ? "Output" : issueTitle(state) },
		];
	}
	if (name === "mcp") return mcpSections(args, lines, state);
	if (name === "subagent") return taskSections(args, buildToolResultLines(result), state);
	if (name === "codemode") {
		return [
			{ lines: argument(args, "code").split(/\r?\n/u), title: "Code" },
			{ lines: buildToolResultLines(result), title: state === "success" ? "Result" : issueTitle(state) },
		];
	}
	if (name === "web_search") return webSearchSections(lines);
	if (name === "imagegen") {
		return [
			{ lines: [oneLine(argument(args, "prompt")) || "Generation completed."], title: "Generation" },
			{ lines, title: "Images" },
		];
	}
	if (name === "goal_complete") {
		return [
			{ lines: [oneLine(argument(args, "summary", "message")) || "Goal completed."], title: "Summary" },
			{ lines, title: "Evidence" },
		];
	}
	if (name === "background") return one("Tasks", lines);
	if (name === "ctx_expand") {
		return [
			{ lines: [oneLine(argument(args, "range", "start", "tag")) || "Selected range"], title: "Range" },
			{ lines, title: "Result" },
		];
	}
	if (name === "ctx_search") {
		return [
			{ lines: [oneLine(argument(args, "query")) || "Query unavailable."], title: "Query" },
			{ lines, title: "Matches" },
		];
	}
	if (name === "subagent_supervisor") {
		return one(args["request"] === undefined ? "Status" : "Request / Reply", lines);
	}
	if (name === "intercom") return one(args["request"] === undefined ? "Message" : "Request / Reply", lines);
	if (name === "contact_supervisor") {
		return [
			{ lines: [oneLine(argument(args, "request", "message")) || "Request unavailable."], title: "Request" },
			{ lines, title: "Reply" },
		];
	}
	return one(state === "success" ? semanticTitle(name) : issueTitle(state), lines);
}
