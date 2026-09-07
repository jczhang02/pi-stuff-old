import { describe, expect, it } from "bun:test";
import { isTransitionValid } from "../../../packages/pi-stuff/src/todo/state/invariants.js";
import type { TaskState } from "../../../packages/pi-stuff/src/todo/state/state.js";
import { applyTaskMutation } from "../../../packages/pi-stuff/src/todo/state/state-reducer.js";
import type { Task } from "../../../packages/pi-stuff/src/todo/tool/types.js";

function emptyState(nextId = 1): TaskState {
	return { tasks: [], nextId };
}

function task(id: string, subject: string, overrides: Partial<Task> = {}): Task {
	return {
		id,
		subject,
		description: `${subject} description`,
		status: "pending",
		...overrides,
	};
}

function stateWith(...tasks: Task[]): TaskState {
	const maxNumericId = Math.max(0, ...tasks.map(({ id }) => Number(id)).filter(Number.isSafeInteger));
	return { tasks, nextId: maxNumericId + 1 };
}

describe("applyTaskMutation — create", () => {
	it("requires both subject and description without committing", () => {
		const state = emptyState();
		const noSubject = applyTaskMutation(state, "create", { subject: "", description: "details" });
		const noDescription = applyTaskMutation(state, "create", { subject: "Write tests" });

		expect(noSubject.op).toEqual({ kind: "error", message: "subject required for create" });
		expect(noDescription.op).toEqual({ kind: "error", message: "description required for create" });
		expect(noSubject.state).toBe(state);
		expect(noDescription.state).toBe(state);
	});

	it("publishes a string id from the internal numeric high-water mark", () => {
		const state = emptyState(42);
		const result = applyTaskMutation(state, "create", {
			subject: "Write tests",
			description: "Cover task state",
			activeForm: "Writing tests",
		});

		expect(result.state).not.toBe(state);
		expect(result.state.nextId).toBe(43);
		expect(result.state.tasks[0]).toEqual({
			id: "42",
			subject: "Write tests",
			description: "Cover task state",
			activeForm: "Writing tests",
			status: "pending",
		});
		expect(result.op).toEqual({
			kind: "create",
			task: {
				id: "42",
				subject: "Write tests",
				description: "Cover task state",
				activeForm: "Writing tests",
				status: "pending",
			},
		});
	});
});

describe("applyTaskMutation — update", () => {
	it("patches fields and merges metadata", () => {
		const state = stateWith(task("1", "Old", { metadata: { keep: true, remove: true } }));
		const result = applyTaskMutation(state, "update", {
			taskId: "1",
			subject: "New",
			status: "in_progress",
			metadata: { remove: null, added: 2 },
		});

		expect(result.state.tasks[0]).toMatchObject({
			id: "1",
			subject: "New",
			status: "in_progress",
			metadata: { keep: true, added: 2 },
		});
		expect(result.op).toEqual({
			kind: "update",
			taskId: "1",
			fromStatus: "pending",
			toStatus: "in_progress",
			updatedFields: ["subject", "status", "metadata"],
		});
	});

	it("rejects an empty patch and allows reopening a completed task", () => {
		const state = stateWith(task("1", "Done", { status: "completed" }));
		const empty = applyTaskMutation(state, "update", { taskId: "1" });
		const reopened = applyTaskMutation(state, "update", { taskId: "1", status: "in_progress" });

		expect(empty.op.kind).toBe("error");
		expect(reopened.op).toMatchObject({ kind: "update", fromStatus: "completed", toStatus: "in_progress" });
		expect(reopened.state.tasks[0]?.status).toBe("in_progress");
		expect(empty.state).toBe(state);
	});

	it("uses update(status=deleted) for deletion and makes the tombstone terminal", () => {
		const state = stateWith(task("1", "Done", { status: "completed" }));
		const removed = applyTaskMutation(state, "update", { taskId: "1", status: "deleted" });
		expect(removed.state.tasks[0]?.status).toBe("deleted");

		const retry = applyTaskMutation(removed.state, "update", { taskId: "1", subject: "Again" });
		expect(retry.op).toEqual({ kind: "error", message: "#1 is deleted" });
		expect(retry.state).toBe(removed.state);
	});

	it("returns the original state for a no-op patch", () => {
		const state = stateWith(task("1", "Same"));
		const result = applyTaskMutation(state, "update", { taskId: "1", subject: "Same" });
		expect(result.state).toBe(state);
		expect(result.op).toMatchObject({ kind: "update", updatedFields: [] });
	});
});

describe("applyTaskMutation — dependency patches", () => {
	it("applies addBlockedBy and inverse addBlocks together, with stable deduplication", () => {
		const state = stateWith(task("1", "Current"), task("2", "Blocker"), task("3", "Target"));
		const result = applyTaskMutation(state, "update", {
			taskId: "1",
			addBlockedBy: ["2", "2"],
			addBlocks: ["3", "3"],
		});

		expect(result.state.tasks.find(({ id }) => id === "1")?.blockedBy).toEqual(["2"]);
		expect(result.state.tasks.find(({ id }) => id === "3")?.blockedBy).toEqual(["1"]);
		expect(result.op).toMatchObject({ kind: "update", updatedFields: ["blockedBy", "blocks"] });
	});

	it("does not commit any edge when one requested id is missing", () => {
		const state = stateWith(task("1", "Current"), task("2", "Valid target"));
		const result = applyTaskMutation(state, "update", {
			taskId: "1",
			addBlocks: ["2", "missing"],
		});

		expect(result.op).toEqual({ kind: "error", message: "addBlocks: #missing not found" });
		expect(result.state).toBe(state);
		expect(state.tasks[1]?.blockedBy).toBeUndefined();
	});

	it("rejects deleted and self references atomically", () => {
		const state = stateWith(task("1", "Current"), task("2", "Deleted", { status: "deleted" }));
		const deleted = applyTaskMutation(state, "update", { taskId: "1", addBlockedBy: ["2"] });
		const self = applyTaskMutation(state, "update", { taskId: "1", addBlocks: ["1"] });

		expect(deleted.op).toEqual({ kind: "error", message: "addBlockedBy: #2 is deleted" });
		expect(self.op).toEqual({ kind: "error", message: "cannot make #1 block itself" });
		expect(deleted.state).toBe(state);
		expect(self.state).toBe(state);
	});

	it("rejects a cycle produced across addBlockedBy and addBlocks with no partial commit", () => {
		const state = stateWith(task("1", "One"), task("2", "Two"), task("3", "Three"));
		const result = applyTaskMutation(state, "update", {
			taskId: "1",
			addBlockedBy: ["2"],
			addBlocks: ["2", "3"],
		});

		expect(result.op).toEqual({ kind: "error", message: "dependency update would create a cycle" });
		expect(result.state).toBe(state);
		expect(state.tasks.every(({ blockedBy }) => blockedBy === undefined)).toBe(true);
	});

	it("treats already-present edges as a successful no-op", () => {
		const state = stateWith(task("1", "One"), task("2", "Two", { blockedBy: ["1"] }));
		const result = applyTaskMutation(state, "update", { taskId: "1", addBlocks: ["2", "2"] });
		expect(result.state).toBe(state);
		expect(result.op).toMatchObject({ kind: "update", updatedFields: [] });
	});
});

describe("applyTaskMutation — reads", () => {
	it("returns null for a missing TaskGet", () => {
		const state = stateWith(task("1", "One"));
		const result = applyTaskMutation(state, "get", { taskId: "missing" });
		expect(result).toEqual({ state, op: { kind: "get", task: null } });
	});

	it("returns null for a deleted TaskGet", () => {
		const state = stateWith(task("1", "Gone", { status: "deleted" }));
		const result = applyTaskMutation(state, "get", { taskId: "1" });
		expect(result).toEqual({ state, op: { kind: "get", task: null } });
	});

	it("lists all non-deleted tasks without mutating state", () => {
		const state = stateWith(task("1", "One"), task("2", "Gone", { status: "deleted" }));
		const result = applyTaskMutation(state, "list", {});
		expect(result.state).toBe(state);
		expect(result.op).toEqual({ kind: "list", tasks: [task("1", "One")] });
	});
});

describe("status transitions", () => {
	it("allows live-state rewinds while keeping deleted terminal", () => {
		expect(isTransitionValid("completed", "completed")).toBe(true);
		expect(isTransitionValid("completed", "deleted")).toBe(true);
		expect(isTransitionValid("completed", "in_progress")).toBe(true);
		expect(isTransitionValid("deleted", "pending")).toBe(false);
	});
});
