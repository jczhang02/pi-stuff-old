import { expect, test } from "bun:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SuiteCodeModeConnector } from "../../../packages/pi-stuff/src/code-mode/connector.js";
import { CodeModeHostLostError } from "../../../packages/pi-stuff/src/code-mode/host/host-client.js";
import { INVALID_CODE_MODE_IMAGE_MESSAGE } from "../../../packages/pi-stuff/src/code-mode/image-content.js";
import type { RuntimeResponse, RuntimeToolTrace } from "../../../packages/pi-stuff/src/code-mode/protocol.js";
import { type CodeModeExecutor, CodeModeRuntime } from "../../../packages/pi-stuff/src/code-mode/runtime.js";
import { registryFixture, sessionLedgerFixture } from "../../code-mode/fixtures.js";

test("runtime loss replays a recorded nested result once instead of repeating the Tool", async () => {
	const { context, ledger } = sessionLedgerFixture();
	let effects = 0;
	let passes = 0;
	const lifecycle: string[] = [];
	const executor: CodeModeExecutor = {
		async execute(options) {
			const plan = options.context.beginToolCall?.("read", { path: "README.md" });
			if (!plan) throw new Error("missing recovery plan");
			if (!plan.replay) {
				effects += 1;
				options.context.completeToolCall?.(plan, { status: "success", value: "recorded" });
			}
			options.context.onTraceUpdate?.({
				cellId: `cell-${String(passes)}`,
				trace: {
					attempt: plan.attempt,
					executionId: plan.executionId,
					id: plan.id,
					input: { path: "README.md" },
					name: "read",
					replayed: plan.replay !== undefined,
					sequence: plan.sequence,
					status: "done",
				},
			});
			passes += 1;
			if (passes === 1) throw new CodeModeHostLostError("fixture host loss");
			return { cellId: "cell-recovered", contentItems: [{ type: "input_text", text: "done" }], kind: "result" };
		},
		async shutdown() {},
		async wait() {
			throw new Error("unexpected wait");
		},
	};
	const result = await new CodeModeRuntime(
		new SuiteCodeModeConnector(
			registryFixture({
				disposeExecution: (_executionId, status) => {
					lifecycle.push(`dispose:${status}`);
				},
				onPassEnd: (_executionId, status) => {
					lifecycle.push(`pass:${status}`);
				},
			}),
		),
		executor,
		ledger,
	).execute("outer-recovery", "text(await tools.read({ path: 'README.md' }))", context);
	expect(effects).toBe(1);
	expect(passes).toBe(2);
	expect(result.details).toMatchObject({ attempt: 1, status: "success" });
	expect(result.details.operations).toMatchObject([{ attempt: 1, replayed: true, sequence: 0 }]);
	expect(ledger.history(context)[0]).toMatchObject({ status: "success", toolCalls: 1 });
	expect(lifecycle).toEqual(["pass:error", "pass:completed", "dispose:completed"]);
});

test("runtime returns a durable pause and executes an approved Tool exactly once", async () => {
	const { context, ledger } = sessionLedgerFixture();
	let effects = 0;
	const lifecycle: string[] = [];
	const executor: CodeModeExecutor = {
		async execute(options) {
			const plan = options.context.beginToolCall?.("write", { path: "a.txt", content: "ok" });
			if (!plan) throw new Error("missing approval plan");
			if (plan.pause) {
				return { cellId: "cell-paused", contentItems: [], errorText: plan.pause.message, kind: "result" };
			}
			effects += 1;
			options.context.completeToolCall?.(plan, { status: "success", value: { written: true } });
			return { cellId: "cell-approved", contentItems: [{ type: "input_text", text: "written" }], kind: "result" };
		},
		async shutdown() {},
		async wait() {
			throw new Error("unexpected wait");
		},
	};
	const runtime = new CodeModeRuntime(
		new SuiteCodeModeConnector(
			registryFixture({
				disposeExecution: (_executionId, status) => {
					lifecycle.push(`dispose:${status}`);
				},
				onPassEnd: (_executionId, status) => {
					lifecycle.push(`pass:${status}`);
				},
			}),
		),
		executor,
		ledger,
	);
	const paused = await runtime.execute(
		"outer-approval",
		"text(await tools.write({ path: 'a.txt', content: 'ok' }))",
		context,
	);
	expect(effects).toBe(0);
	expect(paused.details).toMatchObject({
		pending: [{ args: { path: "a.txt", content: "ok" }, method: "write", seq: 0 }],
		status: "paused",
	});
	expect(lifecycle).toEqual(["pass:paused"]);
	const executionId = paused.details.executionId;
	if (!executionId) throw new Error("paused result is missing its execution ID");

	const completed = await runtime.approve(executionId, context);
	expect(effects).toBe(1);
	expect(completed.content).toEqual([{ type: "text", text: "written" }]);
	expect(completed.details.status).toBe("success");
	expect(lifecycle).toEqual(["pass:paused", "pass:completed", "dispose:completed"]);
	const stale = await runtime.approve(executionId, context);
	expect(effects).toBe(1);
	expect(stale.details.status).toBe("error");
});

test("runtime rejection terminates a pending approval without running its Tool", async () => {
	const { context, ledger } = sessionLedgerFixture();
	let effects = 0;
	const lifecycle: string[] = [];
	const executor: CodeModeExecutor = {
		async execute(options) {
			const plan = options.context.beginToolCall?.("write", { path: "a.txt", content: "no" });
			if (!plan) throw new Error("missing rejection plan");
			if (!plan.pause) effects += 1;
			const result: RuntimeResponse = {
				cellId: "cell-rejected",
				contentItems: [],
				kind: "result",
			};
			return plan.pause ? { ...result, errorText: plan.pause.message } : result;
		},
		async shutdown() {},
		async wait() {
			throw new Error("unexpected wait");
		},
	};
	const runtime = new CodeModeRuntime(
		new SuiteCodeModeConnector(
			registryFixture({
				disposeExecution: (_executionId, status) => {
					lifecycle.push(`dispose:${status}`);
				},
				onPassEnd: (_executionId, status) => {
					lifecycle.push(`pass:${status}`);
				},
			}),
		),
		executor,
		ledger,
	);
	const paused = await runtime.execute("outer-reject", "await tools.write({})", context);
	const executionId = paused.details.executionId;
	if (!executionId) throw new Error("paused result is missing its execution ID");
	expect(await runtime.reject(executionId, 0, context)).toBe(true);
	expect(await runtime.reject(executionId, 0, context)).toBe(false);
	expect(effects).toBe(0);
	expect(lifecycle).toEqual(["pass:paused", "dispose:rejected"]);
});

test("connector lifecycle failures never replace the Code Mode result", async () => {
	const { context, ledger } = sessionLedgerFixture();
	let lifecycleCalls = 0;
	const runtime = new CodeModeRuntime(
		new SuiteCodeModeConnector(
			registryFixture({
				disposeExecution: () => {
					lifecycleCalls += 1;
					throw new Error("dispose fixture");
				},
				onPassEnd: () => {
					lifecycleCalls += 1;
					throw new Error("pass fixture");
				},
			}),
		),
		{
			async execute() {
				return { cellId: "cell-lifecycle", contentItems: [{ type: "input_text", text: "kept" }], kind: "result" };
			},
			async shutdown() {},
			async wait() {
				throw new Error("unexpected wait");
			},
		},
		ledger,
	);

	const result = await runtime.execute("outer-lifecycle", "text('kept')", context);
	expect(result.content).toEqual([{ type: "text", text: "kept" }]);
	expect(result.details.status).toBe("success");
	expect(lifecycleCalls).toBe(2);
});

test("runtime auto-waits yielded V8 cells and persists the final nested trace", async () => {
	const calls: string[] = [];
	const executor: CodeModeExecutor = {
		async execute(options) {
			calls.push("execute");
			expect(options.source).toContain("globalThis.suite=globalThis.tools");
			expect(options.context.toolCallId).toBe("outer-1");
			return { cellId: "cell-1", contentItems: [], kind: "yielded", traces: [] };
		},
		async shutdown() {},
		async wait() {
			calls.push("wait");
			return {
				cellId: "cell-1",
				contentItems: [{ type: "input_text", text: "first line" }],
				kind: "result",
				traces: [
					{
						id: "nested-read",
						input: { path: "README.md" },
						name: "read",
						result: { content: [{ type: "text", text: "first line" }], details: {} },
						status: "done",
					},
				],
			};
		},
	};
	const runtime = new CodeModeRuntime(new SuiteCodeModeConnector(registryFixture()), executor);
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const result = await runtime.execute("outer-1", "text((await suite.read({ path: 'README.md' })).content[0].text)", {
		cwd: "/project",
	} as ExtensionContext);
	expect(calls).toEqual(["execute", "wait"]);
	expect(result.content).toEqual([{ type: "text", text: "first line" }]);
	expect(result.details).toMatchObject({
		kind: "pi-stuff-code-mode",
		operations: [{ id: "nested-read", name: "read", state: "success" }],
		status: "success",
	});
});

test("runtime preserves nested termination, deferred Tools, and Tool usage", async () => {
	const usage = {
		cacheRead: 3,
		cacheWrite: 5,
		cost: { cacheRead: 0.03, cacheWrite: 0.05, input: 0.02, output: 0.07, total: 0.17 },
		input: 2,
		output: 7,
		totalTokens: 17,
	};
	const executor: CodeModeExecutor = {
		async execute() {
			return {
				cellId: "cell-control",
				contentItems: [{ type: "input_text", text: "complete" }],
				kind: "result",
				traces: [
					{
						id: "nested-complete",
						input: {},
						name: "goal_complete",
						result: {
							addedToolNames: ["ctx_search"],
							content: [{ type: "text", text: "complete" }],
							details: {},
							terminate: true,
							usage,
						},
						status: "done",
					},
				],
			};
		},
		async shutdown() {},
		async wait() {
			throw new Error("unexpected wait");
		},
	};
	const result = await new CodeModeRuntime(new SuiteCodeModeConnector(registryFixture()), executor).execute(
		"outer-control",
		"text('complete')",
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		{ cwd: "/project" } as ExtensionContext,
	);

	expect(result.terminate).toBe(true);
	expect(result.addedToolNames).toEqual(["ctx_search"]);
	expect(result.usage).toEqual(usage);
});

test("runtime rejects malformed image output before settling the execution as successful", async () => {
	const { context, ledger } = sessionLedgerFixture();
	const truncatedTail = Buffer.alloc(38_400, 1).toString("base64");
	const executor: CodeModeExecutor = {
		async execute() {
			return {
				cellId: "cell-invalid-image",
				contentItems: [{ type: "input_image", image_url: `data:image/jpeg;base64,${truncatedTail}` }],
				kind: "result",
			};
		},
		async shutdown() {},
		async wait() {
			throw new Error("unexpected wait");
		},
	};
	const result = await new CodeModeRuntime(new SuiteCodeModeConnector(registryFixture()), executor, ledger).execute(
		"outer-invalid-image",
		"image(value)",
		context,
	);

	expect(result.content).toEqual([{ type: "text", text: INVALID_CODE_MODE_IMAGE_MESSAGE }]);
	expect(result.details).toMatchObject({ error: INVALID_CODE_MODE_IMAGE_MESSAGE, status: "error" });
	expect(result.content.some((item) => item.type === "image")).toBe(false);
	expect(ledger.history(context)[0]).toMatchObject({ status: "error" });
});

test("runtime removes undecodable nested media from the failed result and its operation details", async () => {
	const valid = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVQI12NoAAAAggCB3UNq9AAAAABJRU5ErkJggg==",
		"base64",
	);
	valid[45] = (valid[45] ?? 0) ^ 0xff;
	const corrupt = { type: "image" as const, data: valid.toString("base64"), mimeType: "image/png" };
	const { context, ledger } = sessionLedgerFixture();
	const executor: CodeModeExecutor = {
		async execute() {
			return {
				cellId: "cell-undecodable-trace",
				contentItems: [],
				kind: "result",
				traces: [
					{
						id: "nested-undecodable-image",
						input: { path: "corrupt.png" },
						name: "view_image",
						result: { content: [{ type: "text", text: "before" }, corrupt], details: {} },
						status: "done",
					},
				],
			};
		},
		async shutdown() {},
		async wait() {
			throw new Error("unexpected wait");
		},
	};
	const result = await new CodeModeRuntime(new SuiteCodeModeConnector(registryFixture()), executor, ledger).execute(
		"outer-undecodable-trace",
		"await tools.read({ path: 'corrupt.png' })",
		context,
	);

	expect(result.content).toEqual([{ type: "text", text: INVALID_CODE_MODE_IMAGE_MESSAGE }]);
	expect(result.details.operations).toMatchObject([
		{ result: { content: [{ type: "text", text: "before" }] }, state: "success" },
	]);
	expect(result.details.operations[0]).not.toHaveProperty("mediaPlacements");
	expect(ledger.history(context)[0]).toMatchObject({ status: "error" });
});

test("invalid media fails a paused execution before its approved effect can run", async () => {
	const valid = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVQI12NoAAAAggCB3UNq9AAAAABJRU5ErkJggg==",
		"base64",
	);
	valid[45] = (valid[45] ?? 0) ^ 0xff;
	const { context, ledger } = sessionLedgerFixture();
	let effects = 0;
	const executor: CodeModeExecutor = {
		async execute(options) {
			const plan = options.context.beginToolCall?.("write", { path: "approved.txt", content: "no" });
			if (!plan) throw new Error("missing approval plan");
			if (!plan.pause) {
				effects += 1;
				throw new Error("invalid image approval unexpectedly resumed");
			}
			return {
				cellId: "cell-invalid-image-pause",
				contentItems: [],
				errorText: plan.pause.message,
				kind: "result",
				traces: [
					{
						id: "nested-invalid-image-before-approval",
						input: { path: "corrupt.png" },
						name: "view_image",
						result: {
							content: [{ type: "image", data: valid.toString("base64"), mimeType: "image/png" }],
							details: {},
						},
						status: "done",
					},
				],
			};
		},
		async shutdown() {},
		async wait() {
			throw new Error("unexpected wait");
		},
	};
	const result = await new CodeModeRuntime(new SuiteCodeModeConnector(registryFixture()), executor, ledger).execute(
		"outer-invalid-image-pause",
		"await tools.write({ path: 'approved.txt', content: 'no' })",
		context,
	);

	expect(effects).toBe(0);
	expect(result.content).toEqual([{ type: "text", text: INVALID_CODE_MODE_IMAGE_MESSAGE }]);
	expect(result.details).toMatchObject({ error: INVALID_CODE_MODE_IMAGE_MESSAGE, status: "error" });
	expect(ledger.history(context)[0]).toMatchObject({ status: "error" });
});

test("runtime hoists nested media while preserving each image's position inside its Tool result", async () => {
	const image = {
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVQI12NoAAAAggCB3UNq9AAAAABJRU5ErkJggg==",
		mimeType: "image/png",
		type: "image" as const,
	};
	const executor: CodeModeExecutor = {
		async execute() {
			return {
				cellId: "cell-media",
				contentItems: [],
				kind: "result" as const,
				traces: [
					{
						id: "nested-media",
						input: { path: "pixel.png" },
						name: "view_image",
						result: {
							content: [
								{ type: "text", text: "before" },
								image,
								{ type: "text", text: "between" },
								image,
								{ type: "text", text: "after" },
							],
							details: { path: "pixel.png" },
						},
						status: "done" as const,
					},
				],
			};
		},
		async shutdown() {},
		async wait() {
			throw new Error("unexpected wait");
		},
	};
	const result = await new CodeModeRuntime(new SuiteCodeModeConnector(registryFixture()), executor).execute(
		"outer-media",
		"await suite.view_image({ path: 'pixel.png' })",
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		{ cwd: "/project" } as ExtensionContext,
	);
	expect(result.content).toEqual([
		{ type: "text", text: "Code completed with no output; use text(...) to return a value" },
		image,
		image,
	]);
	expect(result.details.operations).toMatchObject([
		{
			mediaPlacements: [
				{ afterContentIndex: 1, mediaIndex: 0 },
				{ afterContentIndex: 2, mediaIndex: 1 },
			],
			result: {
				content: [
					{ type: "text", text: "before" },
					{ type: "text", text: "between" },
					{ type: "text", text: "after" },
				],
			},
			state: "success",
		},
	]);
});

test("runtime persists an explicitly emitted nested image only once", async () => {
	const image = {
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVQI12NoAAAAggCB3UNq9AAAAABJRU5ErkJggg==",
		mimeType: "image/png",
		type: "image" as const,
	};
	const executor: CodeModeExecutor = {
		async execute() {
			return {
				cellId: "cell-emitted-media",
				contentItems: [{ image_url: `data:${image.mimeType};base64,${image.data}`, type: "input_image" as const }],
				kind: "result" as const,
				traces: [
					{
						id: "nested-emitted-media",
						input: { path: "pixel.png" },
						name: "view_image",
						result: { content: [image], details: { path: "pixel.png" } },
						status: "done" as const,
					},
				],
			};
		},
		async shutdown() {},
		async wait() {
			throw new Error("unexpected wait");
		},
	};
	const result = await new CodeModeRuntime(new SuiteCodeModeConnector(registryFixture()), executor).execute(
		"outer-emitted-media",
		"const result = await tools.view_image({ path: 'pixel.png' }); image(result);",
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		{ cwd: "/project" } as ExtensionContext,
	);

	expect(result.content).toEqual([image]);
	expect(result.details.operations).toMatchObject([
		{
			mediaPlacements: [{ afterContentIndex: 0, mediaIndex: 0 }],
			name: "view_image",
			result: { content: [], details: { path: "pixel.png" } },
			state: "success",
		},
	]);
});

test("runtime settles every still-running nested row when the outer execution is cancelled", async () => {
	const controller = new AbortController();
	const executor: CodeModeExecutor = {
		async execute(options) {
			options.context.onTraceUpdate?.({
				cellId: "cell-cancelled",
				trace: { id: "nested-bash", input: { command: "sleep 30" }, name: "bash", status: "running" },
			});
			controller.abort();
			throw Object.assign(new Error("Code Mode operation aborted"), { name: "AbortError" });
		},
		async shutdown() {},
		async wait() {
			throw new Error("unexpected wait");
		},
	};
	const result = await new CodeModeRuntime(new SuiteCodeModeConnector(registryFixture()), executor).execute(
		"outer-cancelled",
		"await suite.bash({ command: 'sleep 30' })",
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		{ cwd: "/project" } as ExtensionContext,
		controller.signal,
	);
	expect(result.details).toMatchObject({
		operations: [
			{
				id: "nested-bash",
				result: { content: [{ text: "Operation aborted", type: "text" }] },
				state: "cancelled",
			},
		],
		status: "cancelled",
	});
});

test("runtime recognizes an executor AbortError even without an outer AbortSignal", async () => {
	const executor: CodeModeExecutor = {
		async execute(options) {
			options.context.onTraceUpdate?.({
				cellId: "cell-abort-error",
				trace: { id: "nested-bash", input: { command: "sleep 30" }, name: "bash", status: "running" },
			});
			throw Object.assign(new Error("The V8 operation was aborted"), { name: "AbortError" });
		},
		async shutdown() {},
		async wait() {
			throw new Error("unexpected wait");
		},
	};
	const result = await new CodeModeRuntime(new SuiteCodeModeConnector(registryFixture()), executor).execute(
		"outer-abort-error",
		"await suite.bash({ command: 'sleep 30' })",
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		{ cwd: "/project" } as ExtensionContext,
	);
	expect(result.details.status).toBe("cancelled");
	expect(result.details.operations).toMatchObject([{ id: "nested-bash", state: "cancelled" }]);
});

test("runtime bounds retained trace evidence without losing controls from omitted rows", async () => {
	const usage = {
		cacheRead: 1,
		cacheWrite: 2,
		cost: { cacheRead: 0.01, cacheWrite: 0.02, input: 0.03, output: 0.04, total: 0.1 },
		input: 3,
		output: 4,
		totalTokens: 10,
	};
	let pass = 0;
	const executor: CodeModeExecutor = {
		async execute(options) {
			pass += 1;
			for (let index = 0; index < 800; index += 1) {
				const trace: RuntimeToolTrace = {
					id: `nested-${String(index)}`,
					input: { index },
					name: "read",
					status: pass === 2 && index === 0 ? "running" : "done",
				};
				if (pass === 1 && index === 0) {
					trace.result = {
						addedToolNames: ["ctx_search"],
						content: [{ text: "complete", type: "text" }],
						details: {},
						terminate: true,
						usage,
					};
				}
				options.context.onTraceUpdate?.({
					cellId: "cell-many",
					droppedTraceCount: Math.max(0, index - 767),
					trace,
				});
			}
			if (pass === 1) throw new CodeModeHostLostError("fixture loss after trace rollover");
			return { cellId: "cell-many", contentItems: [], kind: "yielded" };
		},
		async shutdown() {},
		async wait(_cellId, options) {
			options.context.onTraceUpdate?.({
				cellId: "cell-many",
				droppedTraceCount: 32,
				trace: {
					id: "nested-0",
					input: { index: 0 },
					name: "read",
					result: {
						addedToolNames: ["ctx_search"],
						content: [{ text: "complete", type: "text" }],
						details: {},
						terminate: true,
						usage,
					},
					status: "done",
				},
			});
			return { cellId: "cell-many", contentItems: [{ type: "input_text", text: "done" }], kind: "result" };
		},
	};
	const result = await new CodeModeRuntime(new SuiteCodeModeConnector(registryFixture()), executor).execute(
		"outer-many",
		"text('done')",
		// SAFETY: this fixture supplies the only Extension context field exercised by a ledger-free runtime.
		{ cwd: "/project" } as ExtensionContext,
	);

	expect(pass).toBe(2);
	expect(result.details).toMatchObject({ attempt: 1, droppedOperationCount: 32 });
	expect(result.details.operations).toHaveLength(768);
	expect(result.details.operations[0]?.id).toBe("nested-32");
	expect(result.terminate).toBe(true);
	expect(result.addedToolNames).toEqual(["ctx_search"]);
	expect(result.usage).toEqual(usage);
});
