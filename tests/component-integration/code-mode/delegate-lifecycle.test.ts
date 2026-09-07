import { expect, test } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { Type } from "typebox";
import { CodeModeDelegateRuntime } from "../../../packages/pi-stuff/src/code-mode/host/delegate-runtime.js";
import { CodeModeEffectOwner } from "../../../packages/pi-stuff/src/code-mode/host/effect-owner.js";
import type {
	DelegateRequestMessage,
	DelegateResponseMessage,
} from "../../../packages/pi-stuff/src/code-mode/host/host-protocol.js";
import type { RuntimeResponse, SuiteSandboxTool } from "../../../packages/pi-stuff/src/code-mode/protocol.js";
import { EffectFoundation } from "../../../packages/pi-stuff/src/shared/effect-foundation.js";

async function createRuntime(responses: DelegateResponseMessage[]): Promise<CodeModeDelegateRuntime> {
	const foundation = new EffectFoundation();
	const session = await foundation.startSession();
	return new CodeModeDelegateRuntime(
		(message) => responses.push(message),
		new CodeModeEffectOwner(foundation, foundation.forkCapability(session)),
	);
}

function toolRequest(id: number, name: string, runtimeId = `nested-${String(id)}`): DelegateRequestMessage {
	return {
		id,
		request: {
			invocation: {
				cell_id: "cell",
				input: {},
				runtime_tool_call_id: runtimeId,
				tool_name: { name },
			},
			type: "tool/invoke",
		},
	};
}

function notification(id: number, cellId: string, text: string): DelegateRequestMessage {
	return { id, request: { cellId, text, type: "notification/send" } };
}

function response(cellId: string): RuntimeResponse {
	return { cellId, contentItems: [], kind: "result" };
}

async function waitForResponses(responses: readonly DelegateResponseMessage[], count: number): Promise<void> {
	for (let attempt = 0; attempt < 100 && responses.length < count; attempt += 1) await Bun.sleep(2);
}

test("delegate request IDs reject only while the owning Scope is active", async () => {
	const responses: DelegateResponseMessage[] = [];
	const first = Promise.withResolvers<void>();
	let invocations = 0;
	const runtime = await createRuntime(responses);
	const tool: SuiteSandboxTool = {
		description: "request identity fixture",
		inputSchema: Type.Object({}),
		async invoke() {
			invocations += 1;
			if (invocations === 1) await first.promise;
			return true;
		},
		name: "fixture",
		usage: "tools.fixture({})",
	};
	runtime.bindCell("cell", { cwd: "/project" }, new Map([[tool.name, tool]]));

	runtime.handleRequest(toolRequest(40, tool.name, "first"));
	expect(() => runtime.handleRequest(toolRequest(40, tool.name, "duplicate"))).toThrow(
		"Duplicate Code Mode delegate request: 40",
	);
	first.resolve();
	await waitForResponses(responses, 1);
	runtime.handleRequest(toolRequest(40, tool.name, "reused"));
	await waitForResponses(responses, 2);

	expect(invocations).toBe(2);
	expect(responses.map(({ id }) => id)).toEqual([40, 40]);
	runtime.clear();
});

test("targeted cancellation interrupts one request Scope without cancelling its sibling", async () => {
	const responses: DelegateResponseMessage[] = [];
	const updates: unknown[] = [];
	const runtime = await createRuntime(responses);
	const blocked: SuiteSandboxTool = {
		description: "cancellable fixture",
		inputSchema: Type.Object({}),
		async invoke(_input, _context, signal) {
			await delay(10_000, undefined, { signal });
			return "late";
		},
		name: "blocked",
		usage: "tools.blocked({})",
	};
	const fast: SuiteSandboxTool = {
		description: "sibling fixture",
		inputSchema: Type.Object({}),
		invoke: async () => "fast",
		name: "fast",
		usage: "tools.fast({})",
	};
	runtime.bindCell(
		"cell",
		{ cwd: "/project", onTraceUpdate: (update) => updates.push(update) },
		new Map([
			[blocked.name, blocked],
			[fast.name, fast],
		]),
	);

	runtime.handleRequest(toolRequest(41, blocked.name));
	runtime.handleRequest(toolRequest(42, fast.name));
	runtime.cancel(41);
	await waitForResponses(responses, 2);

	expect(responses.find(({ id }) => id === 41)?.result.status).toBe("error");
	expect(responses.find(({ id }) => id === 42)?.result).toMatchObject({ status: "ok" });
	expect(updates).toContainEqual(
		expect.objectContaining({ trace: expect.objectContaining({ id: "nested-41", status: "cancelled" }) }),
	);
	runtime.clear();
});

test("reentrant cancellation settles before the request Effect can start", async () => {
	const responses: DelegateResponseMessage[] = [];
	const updates: unknown[] = [];
	let invocations = 0;
	const runtime = await createRuntime(responses);
	const tool: SuiteSandboxTool = {
		description: "pre-start cancellation fixture",
		inputSchema: Type.Object({}),
		invoke: async () => {
			invocations += 1;
			return "late";
		},
		name: "fixture",
		usage: "tools.fixture({})",
	};
	runtime.bindCell(
		"cell",
		{
			cwd: "/project",
			onTraceUpdate: (update) => {
				updates.push(update);
				runtime.cancel(43);
			},
		},
		new Map([[tool.name, tool]]),
	);

	runtime.handleRequest(toolRequest(43, tool.name));
	await waitForResponses(responses, 1);

	expect(invocations).toBe(0);
	expect(responses[0]?.result.status).toBe("error");
	expect(updates.at(-1)).toEqual(
		expect.objectContaining({ trace: expect.objectContaining({ id: "nested-43", status: "cancelled" }) }),
	);
	runtime.clear();
});

test("cell close keeps active requests independent and bounds delayed projection cleanup", async () => {
	const responses: DelegateResponseMessage[] = [];
	const released = Promise.withResolvers<void>();
	const runtime = await createRuntime(responses);
	const tool: SuiteSandboxTool = {
		description: "cell lifetime fixture",
		inputSchema: Type.Object({}),
		async invoke() {
			await released.promise;
			return "done";
		},
		name: "fixture",
		usage: "tools.fixture({})",
	};
	runtime.bindCell("cell", { cwd: "/project" }, new Map([[tool.name, tool]]));
	runtime.handleRequest(notification(50, "cell", "kept"));
	runtime.handleRequest(toolRequest(51, tool.name));
	runtime.closeCell("cell");
	const attached = runtime.attach(response("cell"));
	released.resolve();
	await waitForResponses(responses, 2);

	expect(attached.contentItems).toEqual([{ text: "kept", type: "input_text" }]);
	expect(responses.find(({ id }) => id === 51)?.result).toMatchObject({ status: "ok" });

	runtime.bindCell("expired", { cwd: "/project" });
	runtime.handleRequest(notification(52, "expired", "expired"));
	runtime.closeCell("expired");
	await Bun.sleep(1_050);
	expect(runtime.attach(response("expired")).contentItems).toEqual([]);
	runtime.clear();
});

test("clear interrupts every Scope and removes retained cell state", async () => {
	const responses: DelegateResponseMessage[] = [];
	const runtime = await createRuntime(responses);
	const blocked: SuiteSandboxTool = {
		description: "clear fixture",
		inputSchema: Type.Object({}),
		async invoke(_input, _context, signal) {
			await delay(10_000, undefined, { signal });
			return "late";
		},
		name: "blocked",
		usage: "tools.blocked({})",
	};
	runtime.bindCell("cell", { cwd: "/project" }, new Map([[blocked.name, blocked]]));
	runtime.handleRequest(notification(60, "cell", "discarded"));
	runtime.handleRequest(toolRequest(61, blocked.name));
	runtime.closeCell("cell");
	runtime.clear();
	await waitForResponses(responses, 2);

	expect(runtime.attach(response("cell"))).toEqual(response("cell"));
	expect(() => runtime.handleRequest(notification(61, "cell", "missing"))).not.toThrow();
	expect(responses.at(-1)?.result).toMatchObject({
		message: "Code Mode notification cell is unavailable",
		status: "error",
	});
	runtime.clear();
});
