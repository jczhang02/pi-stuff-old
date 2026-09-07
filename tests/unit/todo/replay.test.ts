import { describe, expect, it } from "bun:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { decodeCodeModeOperations } from "../../../packages/pi-stuff/src/code-mode/extension.js";
import { isTaskDetails, replayFromBranch } from "../../../packages/pi-stuff/src/todo/state/replay.js";
import {
	TASK_CREATE_TOOL_NAME,
	TASK_SNAPSHOT_CAPABILITY,
	TASK_SNAPSHOT_SCHEMA_VERSION,
	TASK_UPDATE_TOOL_NAME,
	type Task,
	type TaskDetails,
} from "../../../packages/pi-stuff/src/todo/tool/types.js";
import { ToolUiRuntime } from "../../../packages/pi-stuff/src/tool-display/contract.js";

type SessionMessageEntry = Extract<SessionEntry, { type: "message" }>;
const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
let entrySequence = 0;

function sessionMessage(message: SessionMessageEntry["message"]): SessionMessageEntry {
	entrySequence += 1;
	return {
		id: `todo-replay-${String(entrySequence)}`,
		message,
		parentId: null,
		timestamp: "2026-08-22T00:00:00.000Z",
		type: "message",
	};
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

function snapshot(tasks: Task[], nextId: number): TaskDetails {
	return {
		capability: TASK_SNAPSHOT_CAPABILITY,
		schemaVersion: TASK_SNAPSHOT_SCHEMA_VERSION,
		tasks,
		nextId,
	};
}

function toolResult<Details extends object>(toolName: string, details: Details): SessionMessageEntry {
	return sessionMessage({
		role: "toolResult",
		toolCallId: `call-${String(entrySequence + 1)}`,
		toolName,
		content: [],
		details,
		isError: false,
		timestamp: 0,
	});
}

function replay(branch: SessionEntry[], projectMessages?: (messages: readonly unknown[]) => readonly unknown[]) {
	return replayFromBranch({ sessionManager: { getBranch: () => branch } }, projectMessages);
}

describe("isTaskDetails", () => {
	it("accepts only a valid versioned snapshot", () => {
		expect(isTaskDetails(snapshot([], 1))).toBe(true);
		expect(isTaskDetails({ tasks: [], nextId: 1 })).toBe(false);
		expect(
			isTaskDetails({
				capability: TASK_SNAPSHOT_CAPABILITY,
				schemaVersion: 2,
				tasks: [],
				nextId: 1,
			}),
		).toBe(false);
	});

	it("rejects corrupt tasks and dependency graphs", () => {
		expect(isTaskDetails(snapshot([task("1", "Self", { blockedBy: ["1"] })], 2))).toBe(false);
		expect(isTaskDetails(snapshot([task("1", "Dangling", { blockedBy: ["2"] })], 2))).toBe(false);
		expect(
			isTaskDetails(snapshot([task("1", "One", { blockedBy: ["2"] }), task("2", "Two", { blockedBy: ["1"] })], 3)),
		).toBe(false);
	});
});

it("returns a fresh empty state when no task snapshot exists", () => {
	const first = replay([]);
	const second = replay([sessionMessage({ role: "user", content: "hello", timestamp: 0 })]);
	expect(first).toEqual({ tasks: [], nextId: 1 });
	expect(second).toEqual({ tasks: [], nextId: 1 });
	expect(first.tasks).not.toBe(second.tasks);
});

it("uses the last valid versioned Task* snapshot", () => {
	const oldSnapshot = snapshot([task("1", "Old")], 2);
	const latestSnapshot = snapshot([task("1", "Old"), task("2", "Latest")], 3);
	const state = replay([
		toolResult(TASK_CREATE_TOOL_NAME, oldSnapshot),
		toolResult("unrelated", snapshot([task("9", "Ignored")], 10)),
		toolResult(TASK_CREATE_TOOL_NAME, latestSnapshot),
	]);

	expect(state.tasks.map(({ subject }) => subject)).toEqual(["Old", "Latest"]);
	expect(state.nextId).toBe(3);
});

it("uses Task snapshots nested in a registered Tool envelope", () => {
	const runtime = new ToolUiRuntime();
	runtime.registerEnvelope("codemode", decodeCodeModeOperations);
	const latestSnapshot = snapshot([task("1", "Nested")], 2);
	const state = replay(
		[
			sessionMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "..." } }],
				api: "openai-completions",
				provider: "fixture",
				model: "fixture",
				usage: ZERO_USAGE,
				stopReason: "toolUse",
				timestamp: 0,
			}),
			sessionMessage({
				role: "toolResult",
				toolCallId: "outer",
				toolName: "codemode",
				content: [],
				details: {
					kind: "pi-stuff-code-mode",
					operations: [
						{
							args: { taskId: "1", status: "completed" },
							id: "nested-task",
							name: TASK_UPDATE_TOOL_NAME,
							result: { content: [], details: latestSnapshot },
							state: "success",
						},
					],
					status: "success",
				},
				isError: false,
				timestamp: 0,
			}),
		],
		(messages) => runtime.projectMessages(messages),
	);

	expect(state).toEqual({ tasks: [task("1", "Nested")], nextId: 2 });
});

it("skips a corrupt later snapshot instead of replacing the last valid state", () => {
	const valid = snapshot([task("1", "Kept")], 2);
	const corrupt = { ...snapshot([], 1), tasks: "not an array" };
	const state = replay([toolResult(TASK_CREATE_TOOL_NAME, valid), toolResult(TASK_CREATE_TOOL_NAME, corrupt)]);
	expect(state.tasks.map(({ subject }) => subject)).toEqual(["Kept"]);
	expect(state.nextId).toBe(2);
});

it("migrates the legacy todo numeric snapshot to string ids", () => {
	const legacy = {
		tasks: [
			{ id: 5, subject: "Blocker", status: "completed", metadata: { source: "legacy" } },
			{ id: 7, subject: "Blocked", description: "Existing", status: "pending", blockedBy: [5, 5] },
		],
		nextId: 2,
	};
	const state = replay([toolResult("todo", legacy)]);

	expect(state).toEqual({
		tasks: [
			{
				id: "5",
				subject: "Blocker",
				description: "",
				status: "completed",
				metadata: { source: "legacy" },
			},
			{ id: "7", subject: "Blocked", description: "Existing", status: "pending", blockedBy: ["5"] },
		],
		nextId: 8,
	});
});

it("retains the branch ID high-water mark across a legacy clear snapshot", () => {
	const beforeClear = {
		tasks: [{ id: 1, subject: "Old", status: "pending" }],
		nextId: 2,
	};
	const afterClear = { tasks: [], nextId: 1 };
	const state = replay([toolResult("todo", beforeClear), toolResult("todo", afterClear)]);

	expect(state).toEqual({ tasks: [], nextId: 2 });
});

it("keeps legacy and versioned decoding bound to their own tool names", () => {
	const newUnderLegacyName = replay([toolResult("todo", snapshot([task("1", "New")], 2))]);
	const legacyUnderNewName = replay([
		toolResult(TASK_CREATE_TOOL_NAME, { tasks: [{ id: 1, subject: "Old", status: "pending" }], nextId: 2 }),
	]);
	expect(newUnderLegacyName.tasks).toEqual([]);
	expect(legacyUnderNewName.tasks).toEqual([]);
});

it("clones task-owned arrays and metadata", () => {
	const fixture = task("2", "Original", { blockedBy: ["1"], metadata: { stable: true } });
	const state = replay([toolResult(TASK_CREATE_TOOL_NAME, snapshot([task("1", "Blocker"), fixture], 3))]);
	fixture.blockedBy?.push("other");
	if (fixture.metadata) Object.assign(fixture.metadata, { stable: false });

	expect(state.tasks[1]?.blockedBy).toEqual(["1"]);
	expect(state.tasks[1]?.metadata).toEqual({ stable: true });
});

it("raises nextId to avoid reusing a numeric public id", () => {
	const state = replay([toolResult(TASK_CREATE_TOOL_NAME, snapshot([task("12", "High")], 2))]);
	expect(state.nextId).toBe(13);
});
