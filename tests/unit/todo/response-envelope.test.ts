import { describe, expect, test } from "bun:test";
import type { TaskState } from "../../../packages/pi-stuff/src/todo/state/state.js";
import type { Op } from "../../../packages/pi-stuff/src/todo/state/state-reducer.js";
import { summarizeTaskList } from "../../../packages/pi-stuff/src/todo/todo.js";
import { buildToolResult, formatContent } from "../../../packages/pi-stuff/src/todo/tool/response-envelope.js";
import type { Task } from "../../../packages/pi-stuff/src/todo/tool/types.js";

function task(id: string, subject: string, overrides: Partial<Task> = {}): Task {
	return { id, subject, description: `${subject} details`, status: "pending", ...overrides };
}

function state(...tasks: Task[]): TaskState {
	return { tasks, nextId: tasks.length + 1 };
}

describe("Task tool response envelope", () => {
	test("uses Claude-style create and update messages", () => {
		const created = task("1", "Write tests");
		expect(formatContent({ kind: "create", task: created }, state(created))).toBe(
			"Task #1 created successfully: Write tests",
		);

		const update: Op = {
			kind: "update",
			taskId: "1",
			fromStatus: "pending",
			toStatus: "in_progress",
			updatedFields: ["status", "owner"],
		};
		expect(formatContent(update, state(created))).toBe("Updated task #1 status, owner");
	});

	test("TaskList omits resolved blockers and preserves open blockers", () => {
		const tasks = [
			task("1", "Done", { status: "completed" }),
			task("2", "Open"),
			task("3", "Blocked", { blockedBy: ["1", "2"] }),
		];
		expect(formatContent({ kind: "list", tasks }, state(...tasks))).toBe(
			"#1 [completed] Done\n#2 [pending] Open\n#3 [pending] Blocked [blocked by #2]",
		);
	});

	test("TaskList uses a semantic /tools summary instead of clipping its first task", () => {
		const tasks = [
			task("1", "Done", { status: "completed" }),
			task("2", "Open"),
			task("3", "Deleted", { status: "deleted" }),
		];
		expect(
			summarizeTaskList({
				content: [{ type: "text", text: "#1 [completed] Done\n#2 [pending] Open" }],
				details: {
					action: "list",
					capability: "pi-stuff-todo",
					nextId: 4,
					params: {},
					schemaVersion: 1,
					tasks,
				},
			}),
		).toBe("2 tasks (1 done, 1 open)");
	});

	test("TaskGet reports reverse dependencies and null as not found", () => {
		const blocker = task("1", "Build");
		const blocked = task("2", "Ship", { blockedBy: ["1"] });
		expect(formatContent({ kind: "get", task: blocker }, state(blocker, blocked))).toContain("Blocks: #2");
		expect(formatContent({ kind: "get", task: null }, state())).toBe("Task not found");
	});

	test("persists a defensive, versioned snapshot in every result", () => {
		const created = task("1", "Write tests", { metadata: { source: "model" } });
		const current = state(created);
		const result = buildToolResult(
			"create",
			{ subject: created.subject, description: created.description },
			current,
			{ kind: "create", task: created },
		);

		expect(result.details.capability).toBe("pi-stuff-todo");
		expect(result.details.schemaVersion).toBe(1);
		expect(result.details.nextId).toBe(2);
		expect(result.details.tasks).not.toBe(current.tasks);
		expect(result.details.tasks[0]?.metadata).not.toBe(created.metadata);
	});

	test("keeps reducer errors model-visible and replayable", () => {
		const result = buildToolResult("update", { taskId: "missing" }, state(), {
			kind: "error",
			message: "Task not found",
		});
		expect(result.content).toEqual([{ type: "text", text: "Task not found" }]);
		expect(result.details.error).toBe("Task not found");
	});
});
