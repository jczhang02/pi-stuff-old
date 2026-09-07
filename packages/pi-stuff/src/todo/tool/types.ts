import { Type } from "typebox";
import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";

export const TASK_CREATE_TOOL_NAME = "TaskCreate";
export const TASK_GET_TOOL_NAME = "TaskGet";
export const TASK_LIST_TOOL_NAME = "TaskList";
export const TASK_UPDATE_TOOL_NAME = "TaskUpdate";

export const TASK_TOOL_NAMES = {
	create: TASK_CREATE_TOOL_NAME,
	get: TASK_GET_TOOL_NAME,
	list: TASK_LIST_TOOL_NAME,
	update: TASK_UPDATE_TOOL_NAME,
} as const;

export type TaskAction = keyof typeof TASK_TOOL_NAMES;
export type TaskStatus = "pending" | "in_progress" | "completed" | "deleted";

export const TASK_SNAPSHOT_CAPABILITY = "pi-stuff-todo";
export const TASK_SNAPSHOT_SCHEMA_VERSION = 1;

export interface Task {
	id: string;
	subject: string;
	description: string;
	activeForm?: string;
	status: TaskStatus;
	blockedBy?: string[];
	owner?: string;
	metadata?: JsonInputObject;
}

/** Schema-validated Task Tool input shared by the Tool and pure reducer. */
export interface TaskMutationParams {
	taskId?: string;
	subject?: string;
	description?: string;
	activeForm?: string;
	status?: TaskStatus;
	addBlockedBy?: string[];
	addBlocks?: string[];
	owner?: string;
	metadata?: JsonInputObject;
}

/** Tool-result details may carry operation metadata, but replay only trusts the versioned snapshot fields. */
export interface TaskDetails {
	capability: typeof TASK_SNAPSHOT_CAPABILITY;
	schemaVersion: typeof TASK_SNAPSHOT_SCHEMA_VERSION;
	tasks: Task[];
	nextId: number;
	action?: TaskAction;
	params?: TaskMutationParams;
	error?: string;
}

const TaskStatusSchema = Type.Union(
	[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("deleted")],
	{ description: "Current task lifecycle state" },
);

const MetadataSchema = Type.Record(Type.String(), Type.Unsafe<JsonInputValue>({}), {
	description: "Metadata keys to merge; a null value removes an existing key",
});

export const TaskCreateParamsSchema = Type.Object(
	{
		subject: Type.String({ description: "Brief task title" }),
		description: Type.String({ description: "Detailed task description and completion context" }),
		activeForm: Type.Optional(Type.String({ description: "Present-continuous label shown while work is active" })),
		metadata: Type.Optional(MetadataSchema),
	},
	{ additionalProperties: false },
);

export const TaskGetParamsSchema = Type.Object(
	{
		taskId: Type.String({ description: "Task ID" }),
	},
	{ additionalProperties: false },
);

export const TaskListParamsSchema = Type.Object({}, { additionalProperties: false });

export const TaskUpdateParamsSchema = Type.Object(
	{
		taskId: Type.String({ description: "Task ID" }),
		subject: Type.Optional(Type.String({ description: "Replacement task title" })),
		description: Type.Optional(Type.String({ description: "Replacement task description" })),
		activeForm: Type.Optional(Type.String({ description: "Replacement active-work label" })),
		status: Type.Optional(TaskStatusSchema),
		addBlockedBy: Type.Optional(
			Type.Array(Type.String(), { description: "Task IDs that must finish before this task" }),
		),
		addBlocks: Type.Optional(Type.Array(Type.String(), { description: "Task IDs that this task blocks" })),
		owner: Type.Optional(Type.String({ description: "Agent or owner assigned to the task" })),
		metadata: Type.Optional(MetadataSchema),
	},
	{ additionalProperties: false },
);
