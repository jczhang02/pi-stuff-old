import { beforeEach, describe, expect, it } from "bun:test";
import { EMPTY_STATE, type TaskState } from "../../../packages/pi-stuff/src/todo/state/state.js";
import {
	__resetState,
	clearActiveRenderSession,
	commitState,
	evictSession,
	getActiveRenderSession,
	getRenderState,
	getState,
	replaceState,
	setActiveRenderSession,
	sid,
} from "../../../packages/pi-stuff/src/todo/state/store.js";
import type { Task } from "../../../packages/pi-stuff/src/todo/tool/types.js";

function task(id: string, subject = `Task ${id}`): Task {
	return { id, subject, description: `${subject} description`, status: "pending" };
}

beforeEach(() => {
	__resetState();
});

describe("session task store", () => {
	it("returns fresh empty state for an unknown session", () => {
		const state = getState("missing");
		expect(state).toEqual(EMPTY_STATE);
		expect(state).not.toBe(EMPTY_STATE);
		expect(state.tasks).not.toBe(EMPTY_STATE.tasks);
	});

	it("preserves a valid committed state by identity", () => {
		const next: TaskState = { tasks: [task("1")], nextId: 2 };
		commitState("s1", next);
		expect(getState("s1")).toBe(next);
		expect(getState("s1").tasks).toBe(next.tasks);
		expect(getState("s1").nextId).toBe(2);
	});

	it("raises nextId above numeric task ids", () => {
		commitState("s1", { tasks: [task("9")], nextId: 2 });
		expect(getState("s1").nextId).toBe(10);
	});

	it("never lowers a session high-water mark on commit or replay replacement", () => {
		commitState("s1", { tasks: [task("9")], nextId: 10 });
		commitState("s1", { tasks: [], nextId: 1 });
		expect(getState("s1")).toEqual({ tasks: [], nextId: 10 });

		replaceState("s1", { tasks: [task("2")], nextId: 3 });
		expect(getState("s1")).toEqual({ tasks: [task("2")], nextId: 10 });
	});

	it("isolates slots by session id", () => {
		commitState("s1", { tasks: [task("1", "First")], nextId: 2 });
		commitState("s2", { tasks: [task("1", "Second")], nextId: 2 });
		expect(getState("s1").tasks.map(({ subject }) => subject)).toEqual(["First"]);
		expect(getState("s2").tasks.map(({ subject }) => subject)).toEqual(["Second"]);
	});

	it("evicts only the selected session", () => {
		commitState("s1", { tasks: [task("1")], nextId: 2 });
		commitState("s2", { tasks: [task("1")], nextId: 2 });
		evictSession("s1");
		expect(getState("s1")).toEqual(EMPTY_STATE);
		expect(getState("s2").tasks).toHaveLength(1);
	});
});

describe("render session pointer", () => {
	it("reads the selected foreground slot and can be cleared", () => {
		commitState("foreground", { tasks: [task("3")], nextId: 4 });
		setActiveRenderSession("foreground");
		expect(getActiveRenderSession()).toBe("foreground");
		expect(getRenderState()).toBe(getState("foreground"));

		clearActiveRenderSession();
		expect(getActiveRenderSession()).toBe("");
		expect(getRenderState()).toEqual(EMPTY_STATE);
	});

	it("reset clears state and the foreground pointer", () => {
		commitState("foreground", { tasks: [task("1")], nextId: 2 });
		setActiveRenderSession("foreground");
		__resetState();
		expect(getState("foreground")).toEqual(EMPTY_STATE);
		expect(getActiveRenderSession()).toBe("");
	});
});

describe("sid", () => {
	it("normalizes an absent runtime session id to the empty key", () => {
		expect(sid({ sessionManager: { getSessionId: () => "abc" } })).toBe("abc");
		expect(sid({ sessionManager: { getSessionId: () => undefined } })).toBe("");
	});
});
