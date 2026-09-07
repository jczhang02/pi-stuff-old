import { expect, test } from "bun:test";
import { Type } from "typebox";
import { isCodemodeObject, requireCodemodeValue } from "../../../packages/pi-stuff/src/code-mode/cloudflare/codec.js";
import { CodeModeDelegateRuntime } from "../../../packages/pi-stuff/src/code-mode/host/delegate-runtime.js";
import { CodeModeEffectOwner } from "../../../packages/pi-stuff/src/code-mode/host/effect-owner.js";
import { MAX_CONCURRENT_CODE_MODE_TOOL_CALLS } from "../../../packages/pi-stuff/src/code-mode/protocol.js";
import { EffectFoundation } from "../../../packages/pi-stuff/src/shared/effect-foundation.js";

async function delegateRuntime(
	send: ConstructorParameters<typeof CodeModeDelegateRuntime>[0],
): Promise<CodeModeDelegateRuntime> {
	const foundation = new EffectFoundation();
	const session = await foundation.startSession();
	return new CodeModeDelegateRuntime(send, new CodeModeEffectOwner(foundation, foundation.forkCapability(session)));
}

test("delegate transport preserves binary and bigint values across the JSON host boundary", async () => {
	const responses: unknown[] = [];
	const updates: unknown[] = [];
	let received: unknown;
	const runtime = await delegateRuntime((message) => {
		JSON.stringify(message);
		responses.push(message);
	});
	runtime.bindCell(
		"cell-codec",
		{
			cwd: "/project",
			onTraceUpdate: (update) => updates.push(update),
		},
		new Map([
			[
				"fixture",
				{
					description: "serialization fixture",
					inputSchema: Type.Object({ payload: Type.Unknown() }),
					async invoke(input) {
						received = input;
						if (!isCodemodeObject(input)) throw new TypeError("fixture input must be an object");
						const payload = input["payload"];
						return requireCodemodeValue({ count: 1n, payload }, "delegate test result");
					},
					name: "fixture",
					usage: "suite.fixture({})",
				},
			],
		]),
	);

	runtime.handleRequest({
		id: 7,
		request: {
			invocation: {
				cell_id: "cell-codec",
				input: {
					payload: { __codemode_binary_v1__: "Uint8Array", data: "AQID" },
				},
				runtime_tool_call_id: "nested-codec",
				tool_name: { name: "fixture" },
			},
			type: "tool/invoke",
		},
	});
	for (let attempt = 0; attempt < 20 && responses.length === 0; attempt += 1) await Bun.sleep(1);

	expect(responses).toHaveLength(1);
	expect(received).toMatchObject({ payload: new Uint8Array([1, 2, 3]) });
	expect(responses[0]).toMatchObject({
		id: 7,
		result: {
			status: "ok",
			value: {
				result: {
					count: { __codemode_bigint_v1__: "1" },
					payload: { __codemode_binary_v1__: "Uint8Array", data: "AQID" },
				},
				type: "tool/result",
			},
		},
		type: "delegate/response",
	});
	expect(updates.at(-1)).toMatchObject({
		trace: {
			status: "done",
		},
	});
	runtime.clear();
});

test("non-Error thrown values still settle the trace and V8 request", async () => {
	const responses: unknown[] = [];
	const updates: unknown[] = [];
	const runtime = await delegateRuntime((message) => {
		JSON.stringify(message);
		responses.push(message);
	});
	runtime.bindCell(
		"cell-thrown-value",
		{ cwd: "/project", onTraceUpdate: (update) => updates.push(update) },
		new Map([
			[
				"fixture",
				{
					description: "throw a non-Error value",
					inputSchema: Type.Object({}),
					async invoke() {
						throw 1n;
					},
					name: "fixture",
					usage: "suite.fixture({})",
				},
			],
		]),
	);
	runtime.handleRequest({
		id: 8,
		request: {
			invocation: {
				cell_id: "cell-thrown-value",
				input: {},
				runtime_tool_call_id: "nested-thrown-value",
				tool_name: { name: "fixture" },
			},
			type: "tool/invoke",
		},
	});
	for (let attempt = 0; attempt < 20 && responses.length === 0; attempt += 1) await Bun.sleep(1);

	expect(responses).toEqual([{ id: 8, result: { message: "1", status: "error" }, type: "delegate/response" }]);
	expect(updates.at(-1)).toMatchObject({
		trace: { error: "1", result: { content: [{ text: "1", type: "text" }] }, status: "error" },
	});
	runtime.clear();
});

test("malformed transport input returns an error response", async () => {
	const responses: unknown[] = [];
	const runtime = await delegateRuntime((message) => responses.push(message));
	runtime.bindCell(
		"cell-malformed-input",
		{ cwd: "/project" },
		new Map([
			[
				"fixture",
				{
					description: "input fixture",
					inputSchema: Type.Object({}),
					invoke: async () => true,
					name: "fixture",
					usage: "tools.fixture({})",
				},
			],
		]),
	);
	runtime.handleRequest({
		id: 11,
		request: {
			invocation: {
				cell_id: "cell-malformed-input",
				input: { __codemode_bigint_v1__: "not-an-integer" },
				runtime_tool_call_id: "nested-malformed-input",
				tool_name: { name: "fixture" },
			},
			type: "tool/invoke",
		},
	});
	for (let attempt = 0; attempt < 20 && responses.length === 0; attempt += 1) await Bun.sleep(1);

	expect(responses).toEqual([
		{
			id: 11,
			result: { message: "Code Mode bigint envelope is invalid", status: "error" },
			type: "delegate/response",
		},
	]);
	runtime.clear();
});

test("a durable approval decision pauses before the nested Tool can execute", async () => {
	const responses: unknown[] = [];
	const updates: unknown[] = [];
	let effects = 0;
	const runtime = await delegateRuntime((message) => responses.push(message));
	runtime.bindCell(
		"cell-approval",
		{
			beginToolCall: () => ({
				attempt: 0,
				executionId: "cm-approval",
				id: "cm-approval:0",
				pause: { message: "approval required" },
				sequence: 0,
			}),
			cwd: "/project",
			onTraceUpdate: (update) => updates.push(update),
		},
		new Map([
			[
				"write",
				{
					description: "write fixture",
					inputSchema: Type.Object({}),
					async invoke() {
						effects += 1;
						return true;
					},
					name: "write",
					usage: "tools.write({})",
				},
			],
		]),
	);
	runtime.handleRequest({
		id: 9,
		request: {
			invocation: {
				cell_id: "cell-approval",
				input: {},
				runtime_tool_call_id: "nested-write",
				tool_name: { name: "write" },
			},
			type: "tool/invoke",
		},
	});
	for (let attempt = 0; attempt < 20 && responses.length === 0; attempt += 1) await Bun.sleep(1);

	expect(effects).toBe(0);
	expect(responses).toEqual([
		{ id: 9, result: { message: "approval required", status: "error" }, type: "delegate/response" },
	]);
	expect(updates.at(-1)).toMatchObject({ trace: { id: "cm-approval:0", status: "pending" } });
	runtime.clear();
});

test("a failed durable success record is never rewritten as an ordinary Tool error", async () => {
	const responses: unknown[] = [];
	const settlements: string[] = [];
	const runtime = await delegateRuntime((message) => responses.push(message));
	runtime.bindCell(
		"cell-ledger-failure",
		{
			beginToolCall: () => ({
				attempt: 0,
				executionId: "cm-ledger-failure",
				id: "cm-ledger-failure:0",
				sequence: 0,
			}),
			completeToolCall: (_plan, settlement) => {
				settlements.push(settlement.status);
				if (settlement.status === "success") throw new Error("ledger full");
			},
			cwd: "/project",
		},
		new Map([
			[
				"fixture",
				{
					description: "ledger failure fixture",
					inputSchema: Type.Object({}),
					invoke: async () => true,
					name: "fixture",
					usage: "tools.fixture({})",
				},
			],
		]),
	);
	runtime.handleRequest({
		id: 10,
		request: {
			invocation: {
				cell_id: "cell-ledger-failure",
				input: {},
				runtime_tool_call_id: "nested-ledger-failure",
				tool_name: { name: "fixture" },
			},
			type: "tool/invoke",
		},
	});
	for (let attempt = 0; attempt < 20 && responses.length === 0; attempt += 1) await Bun.sleep(1);

	expect(settlements).toEqual(["success"]);
	expect(responses).toEqual([
		{ id: 10, result: { message: "ledger full", status: "error" }, type: "delegate/response" },
	]);
	runtime.clear();
});

test("an unserializable post-effect Tool result reports an incomplete settlement", async () => {
	const responses: unknown[] = [];
	const settlements: string[] = [];
	const cyclic: unknown[] = [];
	cyclic.push(cyclic);
	const runtime = await delegateRuntime((message) => responses.push(message));
	runtime.bindCell(
		"cell-unserializable-result",
		{
			beginToolCall: () => ({
				attempt: 0,
				executionId: "cm-unserializable-result",
				id: "cm-unserializable-result:0",
				sequence: 0,
			}),
			completeToolCall: (_plan, settlement) => settlements.push(settlement.status),
			cwd: "/project",
		},
		new Map([
			[
				"fixture",
				{
					description: "unserializable result fixture",
					inputSchema: Type.Object({}),
					// SAFETY: the malformed return intentionally exercises the runtime Tool-result boundary.
					invoke: async () => cyclic as never,
					name: "fixture",
					usage: "tools.fixture({})",
				},
			],
		]),
	);
	runtime.handleRequest({
		id: 12,
		request: {
			invocation: {
				cell_id: "cell-unserializable-result",
				input: {},
				runtime_tool_call_id: "nested-unserializable-result",
				tool_name: { name: "fixture" },
			},
			type: "tool/invoke",
		},
	});
	for (let attempt = 0; attempt < 20 && responses.length === 0; attempt += 1) await Bun.sleep(1);

	expect(settlements).toEqual(["incomplete"]);
	expect(responses).toEqual([
		{
			id: 12,
			result: {
				message: "Failed to serialize nested Tool result: Code Mode storage value is not serializable",
				status: "error",
			},
			type: "delegate/response",
		},
	]);
	runtime.clear();
});

test("a trace setup failure settles the durable Tool plan before responding", async () => {
	const responses: Array<{ id: number; result: { message?: string; status: string }; type?: string }> = [];
	const settlements: string[] = [];
	let invocations = 0;
	const runtime = await delegateRuntime((message) => responses.push(message));
	runtime.bindCell(
		"cell-duplicate-trace",
		{
			beginToolCall: () => ({
				attempt: 0,
				executionId: "cm-duplicate-trace",
				id: "cm-duplicate-trace:0",
				sequence: 0,
			}),
			completeToolCall: (_plan, settlement) => settlements.push(settlement.status),
			cwd: "/project",
		},
		new Map([
			[
				"fixture",
				{
					description: "duplicate trace fixture",
					inputSchema: Type.Object({}),
					invoke: async () => {
						invocations += 1;
						return true;
					},
					name: "fixture",
					usage: "tools.fixture({})",
				},
			],
		]),
	);
	for (const id of [13, 14]) {
		runtime.handleRequest({
			id,
			request: {
				invocation: {
					cell_id: "cell-duplicate-trace",
					input: {},
					runtime_tool_call_id: `nested-${String(id)}`,
					tool_name: { name: "fixture" },
				},
				type: "tool/invoke",
			},
		});
	}
	for (let attempt = 0; attempt < 20 && responses.length < 2; attempt += 1) await Bun.sleep(1);

	expect(invocations).toBe(1);
	expect(settlements.filter((status) => status === "error")).toHaveLength(1);
	expect(settlements.filter((status) => status === "success")).toHaveLength(1);
	expect(responses.find((response) => response.id === 14)?.result).toEqual({
		message: "Duplicate Code Mode nested Tool call ID: cm-duplicate-trace:0",
		status: "error",
	});
	runtime.clear();
});

test("hidden nested Tools continue beyond the trace retention bound", async () => {
	const responses: Array<{ id: number; result: { message?: string; status: string }; type?: string }> = [];
	let invocations = 0;
	let sequence = 0;
	const settlements: string[] = [];
	const runtime = await delegateRuntime((message) => responses.push(message));
	runtime.bindCell(
		"cell-hidden-limit",
		{
			beginToolCall: () => {
				const current = sequence;
				sequence += 1;
				return {
					attempt: 0,
					executionId: "cm-hidden-limit",
					id: `cm-hidden-limit:${String(current)}`,
					sequence: current,
				};
			},
			completeToolCall: (_plan, settlement) => settlements.push(settlement.status),
			cwd: "/project",
		},
		new Map([
			[
				"hidden",
				{
					description: "hidden fixture",
					inputSchema: Type.Object({}),
					invoke: async () => {
						invocations += 1;
						return true;
					},
					name: "hidden",
					presentation: "hidden",
					usage: "tools.hidden({})",
				},
			],
		]),
	);
	for (let index = 1; index <= 769; index += 1) {
		runtime.handleRequest({
			id: index,
			request: {
				invocation: {
					cell_id: "cell-hidden-limit",
					input: {},
					runtime_tool_call_id: `hidden-${String(index)}`,
					tool_name: { name: "hidden" },
				},
				type: "tool/invoke",
			},
		});
		if (index % 64 === 0) {
			for (let attempt = 0; attempt < 20 && responses.length < index; attempt += 1) await Bun.sleep(1);
		}
	}
	for (let attempt = 0; attempt < 20 && responses.length < 769; attempt += 1) await Bun.sleep(1);

	expect(invocations).toBe(769);
	expect(responses).toHaveLength(769);
	expect(settlements.filter((status) => status === "success")).toHaveLength(769);
	expect(settlements.filter((status) => status === "error")).toHaveLength(0);
	expect(responses.find((response) => response.id === 769)?.result.status).toBe("ok");
	runtime.clear();
});

test("rejects only excess concurrent nested Tool work", async () => {
	const responses: Array<{ id: number; result: { message?: string; status: string }; type?: string }> = [];
	const runtime = await delegateRuntime((message) => responses.push(message));
	runtime.bindCell(
		"cell-concurrent-limit",
		{ cwd: "/project" },
		new Map([
			[
				"pending",
				{
					description: "pending fixture",
					inputSchema: Type.Object({}),
					invoke: async (_input, _context, signal) =>
						new Promise<boolean>((resolve) =>
							signal.addEventListener("abort", () => resolve(true), { once: true }),
						),
					ledger: "bypass",
					name: "pending",
					presentation: "hidden",
					usage: "tools.pending({})",
				},
			],
		]),
	);
	for (let index = 0; index < MAX_CONCURRENT_CODE_MODE_TOOL_CALLS; index += 1) {
		runtime.handleRequest({
			id: index,
			request: {
				invocation: {
					cell_id: "cell-concurrent-limit",
					input: {},
					runtime_tool_call_id: `pending-${String(index)}`,
					tool_name: { name: "pending" },
				},
				type: "tool/invoke",
			},
		});
	}
	const excessId = MAX_CONCURRENT_CODE_MODE_TOOL_CALLS;
	runtime.handleRequest({
		id: excessId,
		request: {
			invocation: {
				cell_id: "cell-concurrent-limit",
				input: {},
				runtime_tool_call_id: "excess",
				tool_name: { name: "pending" },
			},
			type: "tool/invoke",
		},
	});

	expect(responses).toContainEqual({
		id: excessId,
		result: {
			message: `Code Mode has ${String(MAX_CONCURRENT_CODE_MODE_TOOL_CALLS)} concurrent Tool calls; settle one before starting another.`,
			status: "error",
		},
		type: "delegate/response",
	});
	runtime.clear();
});
