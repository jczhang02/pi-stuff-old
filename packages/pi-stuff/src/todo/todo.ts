import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { reportDiagnostic } from "../conversation-ui/diagnostics.ts";
import { isRuntimeString } from "../shared/runtime-type.ts";
import {
	activityKey,
	registerSuiteOwnedTool,
	type SuiteToolPresentation,
	type SuiteToolRegistrationHost,
	type ToolActivityCategory,
	type ToolActivityItem,
	type ToolArguments,
} from "../tool-display/index.ts";
import { applyTaskMutation, type Op } from "./state/state-reducer.ts";
import { commitState, getState, sid } from "./state/store.ts";
import { buildToolResult } from "./tool/response-envelope.ts";
import {
	TASK_CREATE_TOOL_NAME,
	TASK_GET_TOOL_NAME,
	TASK_LIST_TOOL_NAME,
	TASK_UPDATE_TOOL_NAME,
	type TaskAction,
	TaskCreateParamsSchema,
	type TaskDetails,
	TaskGetParamsSchema,
	TaskListParamsSchema,
	type TaskMutationParams,
	TaskUpdateParamsSchema,
} from "./tool/types.ts";

interface TaskMutationEvent {
	readonly action: "create" | "update";
	readonly sessionId: string;
	readonly op: Extract<Op, { kind: "create" | "update" }>;
}

type TaskMutationListener = (event: TaskMutationEvent) => void;

interface TaskIdPresentationParams extends ToolArguments {
	readonly taskId?: unknown;
}

const SHARED_GUIDELINES = [
	"Use the Task tools for multi-step work that benefits from visible progress; skip them for a single trivial action.",
	"Set a task to in_progress before working on it and completed only after its result has been verified.",
	"Use TaskUpdate to add dependencies. A pending task with unresolved blockers should not be started.",
];

function resultText(result: AgentToolResult<TaskDetails>): string {
	const content = result.content.find((item) => item.type === "text");
	return content?.type === "text" ? content.text : "Task operation failed";
}

function taskIdTarget(params: Readonly<TaskIdPresentationParams>): string {
	const taskId = params.taskId;
	return isRuntimeString(taskId) && taskId ? `#${taskId}` : "";
}

function taskPresentation<TParams extends ToolArguments>(
	label: string,
	category: Extract<ToolActivityCategory, "check-task" | "update-task">,
	target: (params: Readonly<TParams>) => string,
	summarize: (result: AgentToolResult<TaskDetails>) => string = resultText,
	resultIdentities: (params: Readonly<TParams>, result: AgentToolResult<TaskDetails>) => readonly string[] = (
		params,
	) => {
		const value = target(params);
		return value ? [value] : [];
	},
): SuiteToolPresentation<TParams, TaskDetails> {
	return {
		activity: {
			categories: category === "update-task" ? ["check-task", "update-task"] : [category],
			silentSuccess: true,
			classify: ({ args, result }) => {
				const value = target(args);
				const returnedIds = result?.details
					? resultIdentities(args, result).map((identity) => activityKey(identity))
					: undefined;
				const effectiveCategory =
					category === "update-task" &&
					result &&
					/already matches the requested values\s*$/u.test(resultText(result))
						? "check-task"
						: category;
				const activity: ToolActivityItem = { category: effectiveCategory };
				if (returnedIds) {
					if (returnedIds.length > 0) Object.assign(activity, { countKeys: returnedIds });
					else Object.assign(activity, { count: 0 });
				} else {
					Object.assign(activity, { countKeys: [activityKey(value || label)] });
				}
				if (value) Object.assign(activity, { target: value });
				return [activity];
			},
		},
		label,
		resultIsError: (_params, result) => Boolean(result.details?.error),
		runningSummary: "updating",
		summarize: (_params, result) => result.details?.error ?? summarize(result),
		target,
	};
}

/** Keep TaskList useful in /tools without retaining a clipped model-facing row. */
export function summarizeTaskList(result: AgentToolResult<TaskDetails>): string {
	const tasks = (result.details?.tasks ?? []).filter((task) => task.status !== "deleted");
	const done = tasks.filter((task) => task.status === "completed").length;
	return `${String(tasks.length)} tasks (${String(done)} done, ${String(tasks.length - done)} open)`;
}

export function registerTaskTools(pi: SuiteToolRegistrationHost, onMutation?: TaskMutationListener): void {
	function execute(action: TaskAction, params: TaskMutationParams, ctx: Parameters<typeof sid>[0]) {
		const sessionId = sid(ctx);
		const previous = getState(sessionId);
		const result = applyTaskMutation(previous, action, params);
		commitState(sessionId, result.state);

		if (onMutation && result.op.kind !== "error" && (result.op.kind === "create" || result.op.kind === "update")) {
			try {
				onMutation({ action: result.op.kind, sessionId, op: result.op });
			} catch (error) {
				reportDiagnostic({
					action: "/reload",
					capability: "Todo",
					error,
					key: "widget-refresh",
					summary: "The task changed, but the Todo display could not refresh",
					visibility: "notice",
				});
			}
		}

		return buildToolResult(action, params, result.state, result.op);
	}

	const createTool: ToolDefinition<typeof TaskCreateParamsSchema, TaskDetails> = {
		name: TASK_CREATE_TOOL_NAME,
		label: TASK_CREATE_TOOL_NAME,
		description: "Create one task with a short subject and enough detail to know when it is done.",
		promptSnippet: "Create a task in the current session task list",
		promptGuidelines: SHARED_GUIDELINES,
		parameters: TaskCreateParamsSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return execute("create", params, ctx);
		},
	};
	registerSuiteOwnedTool(
		pi,
		createTool,
		taskPresentation(
			"Task create",
			"update-task",
			(params) => params.subject,
			resultText,
			(_params, result) => {
				const id = resultText(result).match(/^Task #([^\s]+) created successfully:/u)?.[1];
				return id ? [id] : [];
			},
		),
	);

	const getTool: ToolDefinition<typeof TaskGetParamsSchema, TaskDetails> = {
		name: TASK_GET_TOOL_NAME,
		label: TASK_GET_TOOL_NAME,
		description: "Return the full current record for one task, or not found when the ID is absent.",
		promptSnippet: "Retrieve one task by ID",
		parameters: TaskGetParamsSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return execute("get", params, ctx);
		},
	};
	registerSuiteOwnedTool(
		pi,
		getTool,
		taskPresentation("Task get", "check-task", taskIdTarget, resultText, (params, result) => {
			const taskId = isRuntimeString(params.taskId) ? params.taskId : "";
			return taskId && resultText(result) !== "Task not found" ? [taskId] : [];
		}),
	);

	const listTool: ToolDefinition<typeof TaskListParamsSchema, TaskDetails> = {
		name: TASK_LIST_TOOL_NAME,
		label: TASK_LIST_TOOL_NAME,
		description: "Return the authoritative list of current, non-deleted tasks and unresolved blockers.",
		promptSnippet: "List all current tasks",
		parameters: TaskListParamsSchema,
		executionMode: "parallel",
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			return execute("list", {}, ctx);
		},
	};
	registerSuiteOwnedTool(
		pi,
		listTool,
		taskPresentation(
			"Task list",
			"check-task",
			() => "",
			summarizeTaskList,
			(_params, result) =>
				(result.details?.tasks ?? []).filter((task) => task.status !== "deleted").map((task) => task.id),
		),
	);

	const updateTool: ToolDefinition<typeof TaskUpdateParamsSchema, TaskDetails> = {
		name: TASK_UPDATE_TOOL_NAME,
		label: TASK_UPDATE_TOOL_NAME,
		description:
			"Incrementally update one task's fields, status, owner, or dependencies. Set status to deleted to remove it.",
		promptSnippet: "Update a task or its dependencies",
		parameters: TaskUpdateParamsSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return execute("update", params, ctx);
		},
	};
	registerSuiteOwnedTool(pi, updateTool, taskPresentation("Task update", "update-task", taskIdTarget));
}
