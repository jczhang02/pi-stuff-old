import { type SessionEntry, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { isJsonInputValue, type JsonInputObject, type JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import {
	TASK_SNAPSHOT_CAPABILITY,
	TASK_SNAPSHOT_SCHEMA_VERSION,
	TASK_TOOL_NAMES,
	type Task,
	type TaskDetails,
	type TaskStatus,
} from "../tool/types.ts";
import { EMPTY_STATE, type TaskState } from "./state.ts";
import { hasCycle } from "./task-graph.ts";

const VERSIONED_TOOL_NAMES = new Set<string>(Object.values(TASK_TOOL_NAMES));
const LEGACY_TOOL_NAME = "todo";

interface RawTask {
	id?: JsonInputValue;
	subject?: JsonInputValue;
	description?: JsonInputValue;
	activeForm?: JsonInputValue;
	status?: JsonInputValue;
	blockedBy?: JsonInputValue;
	owner?: JsonInputValue;
	metadata?: JsonInputValue;
}

interface RawSnapshot {
	capability?: JsonInputValue;
	schemaVersion?: JsonInputValue;
	tasks?: JsonInputValue;
	nextId?: JsonInputValue;
}

interface RawToolResult {
	role?: JsonInputValue;
	toolName?: JsonInputValue;
	details?: JsonInputValue;
}

function isRecord(value: JsonInputValue): value is JsonInputObject {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function isTaskStatus(value: JsonInputValue): value is TaskStatus {
	return value === "pending" || value === "in_progress" || value === "completed" || value === "deleted";
}

function cloneMetadata(value: JsonInputValue): JsonInputObject | undefined | null {
	if (!isRecord(value)) return value === undefined ? undefined : null;
	return { ...value };
}

function normalizeVersionedTask(value: JsonInputValue): Task | null {
	if (!isRecord(value)) return null;
	const raw: RawTask = value;
	if (!isRuntimeString(raw.id) || raw.id.length === 0) return null;
	if (!isRuntimeString(raw.subject) || !isRuntimeString(raw.description)) return null;
	if (!isTaskStatus(raw.status)) return null;

	const task: Task = {
		id: raw.id,
		subject: raw.subject,
		description: raw.description,
		status: raw.status,
	};
	if (raw.activeForm !== undefined) {
		if (!isRuntimeString(raw.activeForm)) return null;
		task.activeForm = raw.activeForm;
	}
	if (raw.owner !== undefined) {
		if (!isRuntimeString(raw.owner)) return null;
		task.owner = raw.owner;
	}
	if (raw.blockedBy !== undefined) {
		if (!Array.isArray(raw.blockedBy)) return null;
		const blockedBy: string[] = [];
		for (const id of raw.blockedBy) {
			if (!isRuntimeString(id) || id.length === 0) return null;
			blockedBy.push(id);
		}
		const uniqueBlockedBy = [...new Set(blockedBy)];
		if (uniqueBlockedBy.length > 0) task.blockedBy = uniqueBlockedBy;
	}
	const metadata = cloneMetadata(raw.metadata);
	if (metadata === null) return null;
	if (metadata !== undefined) task.metadata = metadata;
	return task;
}

function normalizeLegacyTask(value: JsonInputValue): Task | null {
	if (!isRecord(value)) return null;
	const raw: RawTask = value;
	if (!isRuntimeNumber(raw.id) || !Number.isSafeInteger(raw.id) || raw.id < 1) return null;
	if (!isRuntimeString(raw.subject) || !isTaskStatus(raw.status)) return null;
	if (raw.description !== undefined && !isRuntimeString(raw.description)) return null;

	const task: Task = {
		id: String(raw.id),
		subject: raw.subject,
		description: raw.description ?? "",
		status: raw.status,
	};
	if (raw.activeForm !== undefined) {
		if (!isRuntimeString(raw.activeForm)) return null;
		task.activeForm = raw.activeForm;
	}
	if (raw.owner !== undefined) {
		if (!isRuntimeString(raw.owner)) return null;
		task.owner = raw.owner;
	}
	if (raw.blockedBy !== undefined) {
		if (!Array.isArray(raw.blockedBy)) return null;
		const numericBlockedBy: number[] = [];
		for (const id of raw.blockedBy) {
			if (!isRuntimeNumber(id) || !Number.isSafeInteger(id) || id < 1) return null;
			numericBlockedBy.push(id);
		}
		const blockedBy = [...new Set(numericBlockedBy.map(String))];
		if (blockedBy.length > 0) task.blockedBy = blockedBy;
	}
	const metadata = cloneMetadata(raw.metadata);
	if (metadata === null) return null;
	if (metadata !== undefined) task.metadata = metadata;
	return task;
}

function numericIdFloor(tasks: readonly Task[]): number {
	let nextId = 1;
	for (const task of tasks) {
		if (!/^[1-9]\d*$/.test(task.id)) continue;
		const id = Number(task.id);
		if (Number.isSafeInteger(id)) nextId = Math.max(nextId, id + 1);
	}
	return nextId;
}

function validateTasks(tasks: readonly Task[]): boolean {
	const ids = new Set(tasks.map((task) => task.id));
	if (ids.size !== tasks.length) return false;
	for (const task of tasks) {
		for (const blockerId of task.blockedBy ?? []) {
			if (blockerId === task.id || !ids.has(blockerId)) return false;
		}
	}
	return !hasCycle(tasks);
}

function decodeTasks(values: JsonInputValue, normalize: (value: JsonInputValue) => Task | null): Task[] | null {
	if (!Array.isArray(values)) return null;
	const tasks: Task[] = [];
	for (const value of values) {
		const task = normalize(value);
		if (!task) return null;
		tasks.push(task);
	}
	return validateTasks(tasks) ? tasks : null;
}

function normalizeNextId(value: JsonInputValue, tasks: readonly Task[]): number | null {
	if (!isRuntimeNumber(value) || !Number.isSafeInteger(value) || value < 1) return null;
	return Math.max(value, numericIdFloor(tasks));
}

function decodeVersionedSnapshot(value: JsonInputValue): TaskState | null {
	if (!isRecord(value)) return null;
	const raw: RawSnapshot = value;
	if (raw.capability !== TASK_SNAPSHOT_CAPABILITY || raw.schemaVersion !== TASK_SNAPSHOT_SCHEMA_VERSION) return null;
	const tasks = decodeTasks(raw.tasks, normalizeVersionedTask);
	if (!tasks) return null;
	const nextId = normalizeNextId(raw.nextId, tasks);
	return nextId === null ? null : { tasks, nextId };
}

function decodeLegacySnapshot(value: JsonInputValue): TaskState | null {
	if (!isRecord(value)) return null;
	const raw: RawSnapshot = value;
	const tasks = decodeTasks(raw.tasks, normalizeLegacyTask);
	if (!tasks) return null;
	const nextId = normalizeNextId(raw.nextId, tasks);
	return nextId === null ? null : { tasks, nextId };
}

/** Strict discriminator for the new, versioned task snapshot envelope. */
export function isTaskDetails<Value>(value: Value): value is Value & TaskDetails {
	return isJsonInputValue(value) && decodeVersionedSnapshot(value) !== null;
}

/**
 * Rebuild task state from the latest valid task tool result on the current
 * branch. New snapshots are accepted only from the four Task* tools; the old
 * numeric snapshot is accepted only from the historical `todo` tool.
 */
export function replayFromBranch(
	ctx: { sessionManager: { getBranch(): Iterable<SessionEntry> } },
	projectMessages: (messages: readonly unknown[]) => readonly unknown[] = (messages) => messages,
): TaskState {
	let result: TaskState = { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
	let highWaterNextId = result.nextId;
	const branchMessages = [...ctx.sessionManager.getBranch()].flatMap(sessionEntryToContextMessages);
	for (const candidate of projectMessages(branchMessages)) {
		if (!isJsonInputValue(candidate) || !isRecord(candidate)) continue;
		const message: RawToolResult = candidate;
		if (message.role !== "toolResult" || !isRuntimeString(message.toolName)) continue;

		const snapshot =
			message.toolName === LEGACY_TOOL_NAME
				? decodeLegacySnapshot(message.details)
				: VERSIONED_TOOL_NAMES.has(message.toolName)
					? decodeVersionedSnapshot(message.details)
					: null;
		if (snapshot) {
			result = snapshot;
			highWaterNextId = Math.max(highWaterNextId, snapshot.nextId);
		}
	}
	return result.nextId === highWaterNextId ? result : { tasks: result.tasks, nextId: highWaterNextId };
}
