import { expect, test } from "bun:test";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import { compensateCodeModeExecution } from "../../../packages/pi-stuff/src/code-mode/extension.js";
import {
	CODE_MODE_LEDGER_ENTRY_TYPE,
	CodeModeIncompleteExecutionError,
	CodeModeSessionLedger,
} from "../../../packages/pi-stuff/src/code-mode/ledger.js";
import { durableInputValue } from "../../../packages/pi-stuff/src/code-mode/ledger-state.js";
import type { JsonInputObject } from "../../../packages/pi-stuff/src/shared/json-value.js";

type ReplayPolicies = Readonly<Record<string, "never" | "record" | "reexecute">>;
type CompensationRegistry = Parameters<typeof compensateCodeModeExecution>[0];

function compensationRegistry(compensate: CompensationRegistry["compensate"]): CompensationRegistry {
	return {
		catalog: () => [],
		compensate,
		get: () => undefined,
		invoke: async () => {
			throw new Error("unexpected invoke");
		},
		isActive: () => false,
		list: () => [],
	};
}

function fixture() {
	const branch: Array<{ customType: string; data: unknown; id: string; type: "custom" }> = [];
	// SAFETY: undefined initializes optional Error slots that tests later assign only Error values to.
	const state = {
		branchReads: 0,
		leafError: undefined as Error | undefined,
		leafRevision: 0,
		readError: undefined as Error | undefined,
		sessionId: "session-code-mode",
	};
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const context = {
		cwd: "/project",
		sessionManager: {
			getBranch: () => {
				state.branchReads++;
				if (state.readError) throw state.readError;
				return branch;
			},
			getEntries: () => branch,
			getLeafId: () => {
				if (state.leafError) throw state.leafError;
				return `${String(branch.length)}:${String(state.leafRevision)}`;
			},
			getSessionId: () => state.sessionId,
		},
	} as ExtensionContext;
	const ledger = new CodeModeSessionLedger({
		appendEntry(customType, data) {
			state.leafRevision++;
			branch.push({ customType, data, id: `entry-${String(state.leafRevision)}`, type: "custom" });
		},
	});
	const start = (
		outerToolCallId: string,
		policies: ReplayPolicies = {},
		requiresApproval: readonly string[] = [],
		code = "text('fixture')",
	) => {
		const activePolicies = new Map(Object.entries(policies));
		const controller = ledger.begin(context, outerToolCallId, code, activePolicies, new Set(requiresApproval));
		controller.beginPass(0);
		return controller;
	};
	const resume = (executionId: string, policies: ReplayPolicies = {}, requiresApproval: readonly string[] = []) =>
		ledger.resume(context, executionId, new Map(Object.entries(policies)), new Set(requiresApproval));
	return {
		branch,
		context,
		ledger,
		resume,
		state,
		start,
	};
}

test("Session ledger reads fail closed when the active branch is unavailable", () => {
	const { context, ledger, state } = fixture();
	const unavailable = new Error("Session branch unavailable");
	state.readError = unavailable;

	expect(() => ledger.history(context)).toThrow(unavailable);
});

test("post-effect persistence failure remains incomplete after storage recovers", () => {
	const { branch, context } = fixture();
	let failAppend = false;
	const ledger = new CodeModeSessionLedger({
		appendEntry(customType, data) {
			if (failAppend) {
				failAppend = false;
				throw new Error("injected storage failure");
			}
			branch.push({ customType, data, id: `fault-${String(branch.length)}`, type: "custom" });
		},
	});
	const controller = ledger.begin(context, "outer-storage-failure", "", new Map([["write", "never"]]));
	const call = controller.beginToolCall("write", {});
	failAppend = true;
	expect(() => controller.completeToolCall(call, { status: "success", value: "effect applied" })).toThrow(
		CodeModeIncompleteExecutionError,
	);
	expect(() => controller.completeToolCall(call, { status: "error", message: "caught" })).toThrow(
		CodeModeIncompleteExecutionError,
	);
	expect(() => controller.beginToolCall("write", {})).toThrow(CodeModeIncompleteExecutionError);
	controller.beginPass(1);
	expect(() => controller.beginToolCall("write", {})).toThrow(CodeModeIncompleteExecutionError);
	controller.finish("success");
	expect(ledger.history(context)[0]?.status).toBe("incomplete");
	expect(branch.at(-2)?.data).toMatchObject({ kind: "call-started" });
});

test("Session leaf probe failures disable caching without hiding durable branch state", () => {
	const { context, ledger, state } = fixture();
	state.leafError = new Error("leaf unavailable");

	expect(ledger.history(context)).toEqual([]);
	expect(ledger.history(context)).toEqual([]);
	expect(state.branchReads).toBe(2);
});

test("Session ledger reuses one branch fold until the Session leaf changes", () => {
	const { context, ledger, state } = fixture();
	const controller = ledger.begin(context, "outer-cache", "text('ok')", new Map());
	controller.finish("success");

	expect(ledger.history(context)).toHaveLength(1);
	expect(ledger.history(context)).toHaveLength(1);
	expect(ledger.snippets(context)).toEqual([]);
	expect(state.branchReads).toBe(1);
});

test("Session ledger invalidates its fold for branch and Session changes", () => {
	const { branch, context, ledger, state } = fixture();
	const controller = ledger.begin(context, "outer-original", "text('original')", new Map());
	controller.finish("success");
	expect(ledger.history(context)[0]?.outerToolCallId).toBe("outer-original");
	expect(state.branchReads).toBe(1);

	branch.length = 0;
	state.leafRevision++;
	expect(ledger.history(context)).toEqual([]);
	expect(state.branchReads).toBe(2);

	state.sessionId = "session-code-mode-next";
	expect(ledger.history(context)).toEqual([]);
	expect(state.branchReads).toBe(3);
});

test("the Session ledger replays completed values and preserves binary, bigint, history, and snippets", () => {
	const { branch, context, ledger, start } = fixture();
	const controller = start("outer-read", { read: "record" });
	const first = controller.beginToolCall("read", { path: "a.bin" });
	controller.completeToolCall(first, {
		status: "success",
		value: { bytes: new Uint8Array([1, 2, 3]), count: 4n },
	});

	controller.beginPass(1);
	const replay = controller.beginToolCall("read", { path: "a.bin" });
	expect(replay.replay).toMatchObject({ kind: "result", value: { count: 4n } });
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const bytes = replay.replay?.kind === "result" ? (replay.replay.value as { bytes: Uint8Array }).bytes : undefined;
	if (!bytes) throw new Error("replayed binary result is missing");
	expect([...bytes]).toEqual([1, 2, 3]);
	controller.finish("success");

	const history = ledger.history(context);
	expect(history).toMatchObject([
		{ executionId: controller.executionId, outerToolCallId: "outer-read", status: "success", toolCalls: 1 },
	]);
	expect(history[0]?.tools).toEqual(["read"]);
	const snippet = ledger.saveSnippet(context, controller.executionId, " read-binary ", "Read one binary file");
	expect(snippet.name).toBe("read-binary");
	expect(ledger.snippets(context)).toEqual([snippet]);
	expect(branch.every((entry) => entry.customType === CODE_MODE_LEDGER_ENTRY_TYPE)).toBe(true);
});

test("historical explicit Tool errors override a stale success classification in memory", () => {
	const { branch, resume, start } = fixture();
	const policies = { read: "record", write: "never" } as const;
	const controller = start("outer-historical-error", policies, ["write"]);
	const read = controller.beginToolCall("read", {});
	controller.completeToolCall(read, {
		result: Object.assign(
			{ content: [{ type: "text" as const, text: "nested failure" }], details: {} },
			{ isError: true },
		),
		status: "success",
		value: "stale success value",
	});
	const latest = branch.at(-1);
	if (!latest) throw new Error("historical settlement was not persisted");
	const persistedSettlement = structuredClone(latest);
	controller.beginToolCall("write", {});

	const resumed = resume(controller.executionId, policies, ["write"]);
	if (!resumed) throw new Error("historical execution did not resume");
	resumed.beginPass(1);
	const replay = resumed.beginToolCall("read", {});
	expect(replay.replay).toMatchObject({
		kind: "error",
		message: "nested failure",
		result: { content: [{ text: "nested failure", type: "text" }], isError: true },
	});
	expect(branch).toContainEqual(persistedSettlement);
});

test("historical replay does not infer Tool errors from prose or malformed results", () => {
	for (const result of [
		{ content: [{ type: "text", text: "error: ordinary business text" }], details: {} },
		{ content: "malformed", details: {}, isError: true },
		{ content: [null], details: {}, isError: true },
		{ content: [{ type: "text", text: 42 }], details: {}, isError: true },
		{ content: [{ type: "image" }], details: {}, isError: true },
		{ content: [{ type: "unknown" }], details: {}, isError: true },
	]) {
		const { resume, start } = fixture();
		const policies = { read: "record", write: "never" } as const;
		const controller = start("outer-control", policies, ["write"]);
		const read = controller.beginToolCall("read", {});
		// SAFETY: this test deliberately supplies malformed historical presentation data to exercise fail-open replay.
		controller.completeToolCall(read, { result: result as never, status: "success", value: "success" });
		controller.beginToolCall("write", {});
		const resumed = resume(controller.executionId, policies, ["write"]);
		if (!resumed) throw new Error("historical execution did not resume");
		resumed.beginPass(1);
		expect(resumed.beginToolCall("read", {}).replay?.kind).toBe("result");
	}
});

test("completion stores one reconstructable Tool result instead of duplicate value and presentation payloads", () => {
	const { branch, start } = fixture();
	const controller = start("outer-single-result", { read: "record" });
	const plan = controller.beginToolCall("read", {});
	controller.completeToolCall(plan, {
		result: { content: [{ text: '{"observed":true}', type: "text" }], details: {} },
		status: "success",
		value: { observed: true },
	});
	const settlement = branch.at(-1);
	expect(settlement?.data).toHaveProperty("result");
	expect(settlement?.data).not.toHaveProperty("value");

	controller.beginPass(1);
	expect(controller.beginToolCall("read", {}).replay).toMatchObject({ kind: "result", value: { observed: true } });
});

test("approval pauses before the effect and resumes it only after an explicit user decision", () => {
	const { context, ledger, resume, start } = fixture();
	const policies = { write: "never" } as const;
	const controller = start("outer-write", policies, ["write"]);
	const paused = controller.beginToolCall("write", { path: "a.txt", content: "ok" });
	expect(paused.pause).toBeDefined();
	expect(ledger.history(context)[0]?.status).toBe("paused");
	expect(ledger.pending(context)).toEqual([
		{
			args: { path: "a.txt", content: "ok" },
			connector: "tools",
			executionId: controller.executionId,
			method: "write",
			seq: 0,
		},
	]);
	const swallowedPauseFollowUp = controller.beginToolCall("read", { path: "should-not-run" });
	expect(swallowedPauseFollowUp.pause).toBeDefined();
	expect(ledger.history(context)[0]?.toolCalls).toBe(1);

	const resumed = resume(controller.executionId, policies, ["write"]);
	if (!resumed) throw new Error("paused execution did not resume");
	resumed.beginPass(1);
	const approved = resumed.beginToolCall("write", { path: "a.txt", content: "ok" });
	expect(approved.pause).toBeUndefined();
	resumed.completeToolCall(approved, { status: "success", value: { written: true } });
	resumed.finish("success");
	expect(ledger.pending(context)).toEqual([]);
	expect(resume(controller.executionId, policies, ["write"])).toBeUndefined();
});

test("approval stays paused when the working directory changed", () => {
	const { context, ledger, start } = fixture();
	const policies = { write: "never" } as const;
	const approvals = new Set(["write"]);
	const controller = start("outer-cwd", policies, ["write"]);
	controller.beginToolCall("write", { path: "a.txt" });
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const movedContext = { ...context, cwd: "/another-project" } as ExtensionContext;

	expect(() =>
		ledger.resume(movedContext, controller.executionId, new Map(Object.entries(policies)), approvals),
	).toThrow('Code Mode execution started in "/project"; current working directory is "/another-project"');
	expect(ledger.history(context)[0]?.status).toBe("paused");
});

test("approval stays paused when its Tool is no longer active", () => {
	const { context, ledger, start } = fixture();
	const controller = start("outer-missing", { write: "never" }, ["write"]);
	controller.beginToolCall("write", { path: "a.txt" });

	expect(() => ledger.resume(context, controller.executionId, new Map(), new Set(["write"]))).toThrow(
		'Code Mode pending Tool "write" is no longer active',
	);
	expect(ledger.history(context)[0]?.status).toBe("paused");
});

test("reject ends only the matching pending action and leaves earlier applied work available for rollback", () => {
	const { context, ledger, start } = fixture();
	const controller = start("outer-reject", { read: "record", write: "never" }, ["write"]);
	const read = controller.beginToolCall("read", {});
	controller.completeToolCall(read, { status: "success", value: { observed: true } });
	controller.beginToolCall("write", { value: 1 });

	expect(ledger.reject(context, controller.executionId, 9)).toBe(false);
	expect(ledger.reject(context, controller.executionId, 1)).toBe(true);
	expect(ledger.reject(context, controller.executionId, 1)).toBe(false);
	expect(ledger.history(context)[0]?.status).toBe("rejected");
	expect(ledger.pending(context)).toEqual([]);
	expect(ledger.compensationTargets(context, controller.executionId)).toMatchObject([{ name: "read", sequence: 0 }]);
});

test("expiring a stale approval rejects it without executing the pending Tool", () => {
	const { context, ledger, start } = fixture();
	const controller = start("outer-expire", { write: "never" }, ["write"]);
	controller.beginToolCall("write", { value: 1 });

	expect(ledger.expire(context, 0)).toEqual([controller.executionId]);
	expect(ledger.history(context)[0]).toMatchObject({
		error: "Code Mode approval expired after the configured age limit",
		status: "rejected",
	});
	expect(ledger.pending(context)).toEqual([]);
});

test("an unrecorded non-replayable effect stops recovery as incomplete until the user abandons it", () => {
	const { context, ledger, start } = fixture();
	const controller = start("outer-effect", { bash: "never" });
	controller.beginToolCall("bash", { command: "deploy" });

	controller.beginPass(1);
	expect(() => controller.beginToolCall("bash", { command: "deploy" })).toThrow(CodeModeIncompleteExecutionError);
	expect(ledger.history(context)[0]).toMatchObject({ status: "incomplete", toolCalls: 1 });
	expect(ledger.abandon(context, controller.executionId)).toBe(true);
	expect(ledger.history(context)[0]?.status).toBe("abandoned");
	expect(ledger.abandon(context, controller.executionId)).toBe(false);
});

test("an unsettled recorded call is not repeated automatically after Runtime loss", () => {
	const { context, ledger, start } = fixture();
	const controller = start("outer-record", { read: "record" });
	controller.beginToolCall("read", { path: "possibly-applied" });

	controller.beginPass(1);
	expect(() => controller.beginToolCall("read", { path: "possibly-applied" })).toThrow(
		CodeModeIncompleteExecutionError,
	);
	expect(ledger.history(context)[0]).toMatchObject({ status: "incomplete", toolCalls: 1 });
});

test("only an explicit reexecute policy repeats an unsettled call after Runtime loss", () => {
	const { context, ledger, start } = fixture();
	const controller = start("outer-reexecute", { retryable: "reexecute" });
	controller.beginToolCall("retryable", {});

	controller.beginPass(1);
	const retried = controller.beginToolCall("retryable", {});
	expect(retried.replay).toBeUndefined();
	controller.completeToolCall(retried, { status: "success", value: "done" });
	controller.finish("success");
	expect(ledger.history(context)[0]).toMatchObject({ status: "success", toolCalls: 1 });
});

test("a delayed obsolete result cannot settle the active reexecution attempt", () => {
	const { start } = fixture();
	const controller = start("outer-stale-attempt", { retryable: "reexecute" });
	const stale = controller.beginToolCall("retryable", {});
	controller.beginPass(1);
	const active = controller.beginToolCall("retryable", {});

	expect(() => controller.completeToolCall(stale, { status: "success", value: "obsolete" })).toThrow(
		"no matching running ledger call",
	);
	controller.completeToolCall(active, { status: "success", value: "current" });
});

test("checks durable input size without a second serialization pass", () => {
	let reads = 0;
	const stored = durableInputValue("input", {
		get content() {
			reads++;
			return "value";
		},
	});
	expect(stored).toEqual({ kind: "json", json: { content: "value" } });
	// One trust-boundary validation and one JSON serialization.
	expect(reads).toBe(2);
});

test("rejects oversized Tool arguments before the external effect starts", () => {
	const { start } = fixture();
	const controller = start("outer-large-input", { write: "never" });

	expect(() => controller.beginToolCall("write", { content: "x".repeat(1_000_001) })).toThrow(
		/too large to record durably before execution.*small reference/s,
	);
});

test("large durable results remain exact across replay", () => {
	const { start } = fixture();
	const value = "x".repeat(1_000_001);
	const controller = start("outer-large", { read: "record" });
	const call = controller.beginToolCall("read", { path: "large" });
	controller.completeToolCall(call, { status: "success", value });
	controller.beginPass(1);
	expect(controller.beginToolCall("read", { path: "large" }).replay).toEqual({ kind: "result", value });
});

test("explicit compensation attempts applied calls in reverse order and records what was undone", async () => {
	const { context, ledger, start } = fixture();
	const controller = start("outer-write", { first: "never", second: "never" });
	for (const name of ["first", "second"]) {
		const plan = controller.beginToolCall(name, { name });
		controller.completeToolCall(plan, { status: "success", value: { created: name } });
	}
	controller.finish("success");
	const order: string[] = [];
	const outcome = await compensateCodeModeExecution(
		compensationRegistry(async (invocation) => {
			order.push(invocation.name);
			return true;
		}),
		ledger,
		context,
		controller.executionId,
	);
	expect(order).toEqual(["second", "first"]);
	expect(outcome).toEqual({ complete: true, compensated: 2, failures: [] });
	expect(ledger.compensationTargets(context, controller.executionId)).toEqual([]);
});

test("mixed compensation stays partial and retryable until every target succeeds", async () => {
	const { context, ledger, start } = fixture();
	const controller = start("outer-partial-rollback", { first: "never", second: "never" });
	for (const name of ["first", "second"]) {
		const plan = controller.beginToolCall(name, {});
		controller.completeToolCall(plan, { status: "success", value: { created: name } });
	}
	controller.finish("success");
	const registry = compensationRegistry(async ({ name }) => name !== "first");
	const partial = await compensateCodeModeExecution(registry, ledger, context, controller.executionId);
	expect(partial).toMatchObject({ complete: false, compensated: 1 });
	expect(partial.failures).toEqual(["first: no compensating operation accepted the call"]);
	expect(ledger.history(context)[0]?.status).toBe("compensated");
	expect(ledger.compensationTargets(context, controller.executionId)).toMatchObject([{ name: "first" }]);

	const complete = await compensateCodeModeExecution(
		{ ...registry, compensate: async () => true },
		ledger,
		context,
		controller.executionId,
	);
	expect(complete).toEqual({ complete: true, compensated: 1, failures: [] });
	expect(ledger.history(context)[0]?.status).toBe("rolled_back");
});

test("ledger maintenance expires stale work and retains only the newest fifty terminal executions", () => {
	const { branch, context, ledger } = fixture();
	const now = Date.now();
	const append = (data: JsonInputObject): void => {
		branch.push({
			customType: CODE_MODE_LEDGER_ENTRY_TYPE,
			data,
			id: `legacy-${String(branch.length)}`,
			type: "custom",
		});
	};
	append({
		at: now - 25 * 60 * 60 * 1_000,
		code: "await tools.read({ path: 'stale' })",
		executionId: "stale-running",
		kind: "execution-started",
		outerToolCallId: "outer-stale",
		schemaVersion: 1,
	});
	for (let index = 0; index < 51; index += 1) {
		const executionId = `terminal-${String(index)}`;
		append({
			at: now - 1_000 + index,
			code: "text('done')",
			executionId,
			kind: "execution-started",
			outerToolCallId: `outer-${String(index)}`,
			schemaVersion: 1,
		});
		append({
			at: now - 500 + index,
			attempt: 0,
			executionId,
			kind: "execution-settled",
			schemaVersion: 1,
			status: "success",
		});
	}
	ledger.begin(context, "outer-new", "text('new')", new Map());
	const history = ledger.history(context, 100);
	expect(history.find((item) => item.executionId === "stale-running")?.status).toBe("expired");
	expect(history.filter((item) => item.status !== "running" && item.status !== "incomplete")).toHaveLength(50);
	const page = ledger.historyPage(context);
	expect([page.displayedCount, page.retainedCount, page.totalCount, page.truncated]).toEqual([20, 51, 53, true]);
	expect(branch).toHaveLength(105);
});

test("Session ledger growth does not become an execution quota", () => {
	const { branch, start } = fixture();
	const large = "x".repeat(800_000);
	for (let index = 0; index < 22; index += 1) {
		const controller = start(`outer-${String(index)}`, { read: "record" });
		const plan = controller.beginToolCall("read", { index });
		controller.completeToolCall(plan, { status: "success", value: large });
		controller.finish("success");
	}
	const physicalBytes = branch.reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry)) + 1, 0);
	expect(physicalBytes).toBeGreaterThan(16 * 1024 * 1024);
	expect(branch.at(-1)?.data).toMatchObject({ kind: "execution-settled", status: "success" });
});

test("folds only appended Session entries and rebuilds on branch divergence", () => {
	const manager = SessionManager.inMemory();
	// SAFETY: the ledger only reads cwd and the public SessionManager methods supplied here.
	const context = { ...fixture().context, sessionManager: manager };
	const ledger = new CodeModeSessionLedger({
		appendEntry: (type, data) => {
			manager.appendCustomEntry(type, data);
		},
	});
	const original = manager.getBranch.bind(manager);
	let branchReads = 0;
	manager.getBranch = (...args) => {
		branchReads++;
		return original(...args);
	};
	const first = ledger.begin(context, "first", "text(1)", new Map());
	first.finish("success");
	const fork = manager.getLeafId();
	if (!fork) throw new Error("missing Session leaf");
	for (let index = 0; index < 10; index++) {
		manager.appendCustomEntry("ordinary-progress", { index });
		expect(ledger.history(context)).toHaveLength(1);
	}
	expect(branchReads).toBe(1);
	const second = ledger.begin(context, "second", "text(2)", new Map());
	second.finish("success");
	expect(ledger.history(context)).toHaveLength(2);
	manager.branch(fork);
	expect(ledger.history(context)).toHaveLength(1);
	expect(branchReads).toBe(2);
	manager.appendCustomEntry(CODE_MODE_LEDGER_ENTRY_TYPE, { kind: "malformed" });
	expect(ledger.history(context)).toHaveLength(1);
	expect(branchReads).toBe(2);
});
