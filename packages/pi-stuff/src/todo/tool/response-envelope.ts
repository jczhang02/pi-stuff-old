import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { TaskState } from "../state/state.ts";
import type { Op } from "../state/state-reducer.ts";
import { deriveBlocks } from "../state/task-graph.ts";
import {
	TASK_SNAPSHOT_CAPABILITY,
	TASK_SNAPSHOT_SCHEMA_VERSION,
	type Task,
	type TaskAction,
	type TaskDetails,
	type TaskMutationParams,
} from "./types.ts";

function cloneTask(task: Task): Task {
	const clone: Task = { ...task };
	if (task.blockedBy) clone.blockedBy = [...task.blockedBy];
	if (task.metadata) clone.metadata = { ...task.metadata };
	return clone;
}

function formatTask(task: Task, state: TaskState): string {
	const lines = [`Task #${task.id}: ${task.subject}`, `Status: ${task.status}`, `Description: ${task.description}`];
	if (task.blockedBy?.length) {
		lines.push(`Blocked by: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	const blocks = (deriveBlocks(state.tasks).get(task.id) ?? []).filter((id) => {
		const blocked = state.tasks.find((candidate) => candidate.id === id);
		return blocked?.status !== "deleted";
	});
	if (blocks.length > 0) lines.push(`Blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	return lines.join("\n");
}

function formatTaskList(tasks: readonly Task[], state: TaskState): string {
	if (tasks.length === 0) return "No tasks found";
	const resolvedIds = new Set(
		state.tasks.filter((task) => task.status === "completed" || task.status === "deleted").map((task) => task.id),
	);
	return tasks
		.map((task) => {
			const owner = task.owner ? ` (${task.owner})` : "";
			const openBlockers = (task.blockedBy ?? []).filter((id) => !resolvedIds.has(id));
			const blocked =
				openBlockers.length > 0 ? ` [blocked by ${openBlockers.map((id) => `#${id}`).join(", ")}]` : "";
			return `#${task.id} [${task.status}] ${task.subject}${owner}${blocked}`;
		})
		.join("\n");
}

/** The model-facing text follows Claude Code's four Task tool vocabulary. */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create":
			return `Task #${op.task.id} created successfully: ${op.task.subject}`;
		case "get":
			return op.task ? formatTask(op.task, state) : "Task not found";
		case "list":
			return formatTaskList(op.tasks, state);
		case "update":
			return op.updatedFields.length > 0
				? `Updated task #${op.taskId} ${op.updatedFields.join(", ")}`
				: `Task #${op.taskId} already matches the requested values`;
		case "error":
			return op.message;
	}
}

export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): AgentToolResult<TaskDetails> {
	const details: TaskDetails = {
		capability: TASK_SNAPSHOT_CAPABILITY,
		schemaVersion: TASK_SNAPSHOT_SCHEMA_VERSION,
		action,
		params: { ...params },
		tasks: state.tasks.map(cloneTask),
		nextId: state.nextId,
	};
	if (op.kind === "error") details.error = op.message;
	return {
		content: [{ type: "text", text: formatContent(op, state) }],
		details,
	};
}
