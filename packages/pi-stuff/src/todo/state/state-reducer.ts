import type { JsonInputObject } from "../../shared/json-value.ts";
import type { Task, TaskAction, TaskMutationParams, TaskStatus } from "../tool/types.ts";
import { isTransitionValid } from "./invariants.ts";
import type { TaskState } from "./state.ts";
import { hasCycle } from "./task-graph.ts";

export type Op =
	| { kind: "create"; task: Task }
	| {
			kind: "update";
			taskId: string;
			fromStatus: TaskStatus;
			toStatus: TaskStatus;
			updatedFields: string[];
	  }
	| { kind: "list"; tasks: readonly Task[] }
	| { kind: "get"; task: Task | null }
	| { kind: "error"; message: string };

export interface ApplyResult {
	state: TaskState;
	op: Op;
}

function errorResult(state: TaskState, message: string): ApplyResult {
	return { state, op: { kind: "error", message } };
}

function sameRecord(a: JsonInputObject | undefined, b: JsonInputObject | undefined): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function mergeMetadata(current: JsonInputObject | undefined, patch: JsonInputObject): JsonInputObject | undefined {
	const merged = { ...current };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) delete merged[key];
		else merged[key] = value;
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

function setBlockedBy(task: Task, blockedBy: readonly string[]): Task {
	const updated = { ...task };
	if (blockedBy.length > 0) updated.blockedBy = [...blockedBy];
	else delete updated.blockedBy;
	return updated;
}

function hasUpdatePatch(params: TaskMutationParams): boolean {
	return (
		params.subject !== undefined ||
		params.description !== undefined ||
		params.activeForm !== undefined ||
		params.status !== undefined ||
		params.owner !== undefined ||
		params.metadata !== undefined ||
		(params.addBlockedBy?.length ?? 0) > 0 ||
		(params.addBlocks?.length ?? 0) > 0
	);
}

function updateTask(state: TaskState, params: TaskMutationParams): ApplyResult {
	if (!params.taskId) return errorResult(state, "taskId required for update");
	const current = state.tasks.find((task) => task.id === params.taskId);
	if (!current) return errorResult(state, `#${params.taskId} not found`);
	if (current.status === "deleted") return errorResult(state, `#${current.id} is deleted`);
	if (!hasUpdatePatch(params)) return errorResult(state, "update requires at least one mutable field");
	if (params.subject !== undefined && !params.subject.trim()) {
		return errorResult(state, "subject cannot be empty");
	}
	if (params.description !== undefined && !params.description.trim()) {
		return errorResult(state, "description cannot be empty");
	}
	if (params.status !== undefined && !isTransitionValid(current.status, params.status)) {
		return errorResult(state, `illegal transition ${current.status} -> ${params.status}`);
	}

	const addBlockedBy = [...new Set(params.addBlockedBy ?? [])];
	const addBlocks = [...new Set(params.addBlocks ?? [])];
	if (params.status === "deleted" && (addBlockedBy.length > 0 || addBlocks.length > 0)) {
		return errorResult(state, "cannot add dependencies while deleting a task");
	}

	const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
	for (const blockerId of addBlockedBy) {
		if (blockerId === current.id) return errorResult(state, `cannot block #${current.id} on itself`);
		const blocker = tasksById.get(blockerId);
		if (!blocker) return errorResult(state, `addBlockedBy: #${blockerId} not found`);
		if (blocker.status === "deleted") return errorResult(state, `addBlockedBy: #${blockerId} is deleted`);
	}
	for (const blockedTaskId of addBlocks) {
		if (blockedTaskId === current.id) return errorResult(state, `cannot make #${current.id} block itself`);
		const blockedTask = tasksById.get(blockedTaskId);
		if (!blockedTask) return errorResult(state, `addBlocks: #${blockedTaskId} not found`);
		if (blockedTask.status === "deleted") return errorResult(state, `addBlocks: #${blockedTaskId} is deleted`);
	}

	const updatedFields: string[] = [];
	let updatedCurrent: Task = { ...current };
	if (params.subject !== undefined && params.subject !== current.subject) {
		updatedCurrent.subject = params.subject;
		updatedFields.push("subject");
	}
	if (params.description !== undefined && params.description !== current.description) {
		updatedCurrent.description = params.description;
		updatedFields.push("description");
	}
	if (params.activeForm !== undefined && params.activeForm !== current.activeForm) {
		updatedCurrent.activeForm = params.activeForm;
		updatedFields.push("activeForm");
	}
	if (params.status !== undefined && params.status !== current.status) {
		updatedCurrent.status = params.status;
		updatedFields.push("status");
	}
	if (params.owner !== undefined && params.owner !== current.owner) {
		updatedCurrent.owner = params.owner;
		updatedFields.push("owner");
	}
	if (params.metadata !== undefined) {
		const metadata = mergeMetadata(current.metadata, params.metadata);
		if (!sameRecord(metadata, current.metadata)) {
			if (metadata === undefined) delete updatedCurrent.metadata;
			else updatedCurrent.metadata = metadata;
			updatedFields.push("metadata");
		}
	}

	const currentBlockedBy = [...new Set(current.blockedBy ?? [])];
	const mergedBlockedBy = [...new Set([...currentBlockedBy, ...addBlockedBy])];
	if (mergedBlockedBy.length !== currentBlockedBy.length) {
		updatedCurrent = setBlockedBy(updatedCurrent, mergedBlockedBy);
		updatedFields.push("blockedBy");
	}

	const changedTasks = new Map<string, Task>([[current.id, updatedCurrent]]);
	let blocksChanged = false;
	for (const blockedTaskId of addBlocks) {
		const target = changedTasks.get(blockedTaskId) ?? tasksById.get(blockedTaskId);
		if (!target) continue;
		const blockedBy = [...new Set(target.blockedBy ?? [])];
		if (blockedBy.includes(current.id)) continue;
		blockedBy.push(current.id);
		changedTasks.set(blockedTaskId, setBlockedBy(target, blockedBy));
		blocksChanged = true;
	}
	if (blocksChanged) updatedFields.push("blocks");

	if (updatedFields.length === 0) {
		return {
			state,
			op: {
				kind: "update",
				taskId: current.id,
				fromStatus: current.status,
				toStatus: current.status,
				updatedFields,
			},
		};
	}

	const tasks = state.tasks.map((task) => changedTasks.get(task.id) ?? task);
	if (hasCycle(tasks)) return errorResult(state, "dependency update would create a cycle");

	return {
		state: { tasks, nextId: state.nextId },
		op: {
			kind: "update",
			taskId: current.id,
			fromStatus: current.status,
			toStatus: updatedCurrent.status,
			updatedFields,
		},
	};
}

/** Pure task-state reducer. Failed mutations always return the original state by identity. */
export function applyTaskMutation(state: TaskState, action: TaskAction, params: TaskMutationParams): ApplyResult {
	switch (action) {
		case "create": {
			if (!params.subject?.trim()) return errorResult(state, "subject required for create");
			if (!params.description?.trim()) return errorResult(state, "description required for create");

			const task: Task = {
				id: String(state.nextId),
				subject: params.subject,
				description: params.description,
				status: "pending",
			};
			if (params.activeForm !== undefined) task.activeForm = params.activeForm;
			if (params.metadata !== undefined) {
				const metadata = mergeMetadata(undefined, params.metadata);
				if (metadata !== undefined) task.metadata = metadata;
			}

			return {
				state: { tasks: [...state.tasks, task], nextId: state.nextId + 1 },
				op: { kind: "create", task },
			};
		}

		case "get": {
			if (!params.taskId) return errorResult(state, "taskId required for get");
			const task = state.tasks.find((task) => task.id === params.taskId && task.status !== "deleted") ?? null;
			return { state, op: { kind: "get", task } };
		}

		case "list":
			return { state, op: { kind: "list", tasks: state.tasks.filter((task) => task.status !== "deleted") } };

		case "update":
			return updateTask(state, params);
	}
}
