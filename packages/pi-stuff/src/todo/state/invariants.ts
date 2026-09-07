import type { TaskStatus } from "../tool/types.ts";

/** Claude-compatible live-state transitions. Only the deleted tombstone is terminal. */
interface TaskTransitionTable {
	readonly completed: ReadonlySet<TaskStatus>;
	readonly deleted: ReadonlySet<TaskStatus>;
	readonly in_progress: ReadonlySet<TaskStatus>;
	readonly pending: ReadonlySet<TaskStatus>;
}

const VALID_TRANSITIONS: TaskTransitionTable = {
	pending: new Set(["in_progress", "completed", "deleted"]),
	in_progress: new Set(["pending", "completed", "deleted"]),
	completed: new Set(["pending", "in_progress", "deleted"]),
	deleted: new Set(),
};

export function isTransitionValid(from: TaskStatus, to: TaskStatus): boolean {
	if (from === to) return true;
	return VALID_TRANSITIONS[from].has(to);
}
