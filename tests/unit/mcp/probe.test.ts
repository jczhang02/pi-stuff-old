import { expect, test } from "bun:test";
import { runMcpEffect } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-effect-runner.js";
import { probeMcpEndpoint } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-probe.js";

interface ProbeRequestState {
	signal?: AbortSignal;
}

test("bounds and cancels MCP probe response bodies", async () => {
	let sseCancelled = false;
	const sseResponse = new Response(
		new ReadableStream({
			cancel: () => {
				sseCancelled = true;
			},
		}),
		{ headers: { "content-type": "text/event-stream" }, status: 200 },
	);

	let oversizedCancelled = false;
	let oversizedPulls = 0;
	const oversizedResponse = new Response(
		new ReadableStream({
			cancel: () => {
				oversizedCancelled = true;
			},
			pull: (controller) => {
				if (oversizedPulls === 128) {
					controller.close();
					return;
				}
				oversizedPulls += 1;
				controller.enqueue(new Uint8Array(16 * 1024).fill(0x61));
			},
		}),
		{ headers: { "content-type": "application/json" }, status: 200 },
	);
	const jsonRpcResponse = Response.json({ id: 1, jsonrpc: "2.0", result: { capabilities: {} } });

	const responses = [sseResponse, jsonRpcResponse, oversizedResponse];
	const requestInits: Array<RequestInit | undefined> = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			requestInits.push(init);
			const response = responses.shift();
			if (!response) throw new Error("Unexpected MCP probe request");
			return response;
		},
		{ preconnect: originalFetch.preconnect },
	);
	try {
		expect(await runMcpEffect(probeMcpEndpoint("https://mcp.example/sse"))).toEqual({
			classification: "endpoint responded with an MCP event stream",
			isMcp: true,
		});
		expect(sseCancelled).toBe(true);

		expect(await runMcpEffect(probeMcpEndpoint("https://mcp.example/json"))).toEqual({
			classification: "endpoint responded with a JSON-RPC 2.0 envelope",
			isMcp: true,
		});

		expect((await runMcpEffect(probeMcpEndpoint("https://mcp.example/large"))).isMcp).toBe(false);
		expect(oversizedPulls).toBeLessThan(128);
		expect(oversizedCancelled).toBe(true);
		expect(requestInits.every((init) => init?.redirect === "manual")).toBe(true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("interrupts an in-flight MCP probe through its fetch signal", async () => {
	const originalFetch = globalThis.fetch;
	const requestState: ProbeRequestState = {};
	let markStarted: (() => void) | undefined;
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal;
				if (signal) requestState.signal = signal;
				markStarted?.();
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
		{ preconnect: originalFetch.preconnect },
	);
	const controller = new AbortController();
	const reason = new Error("probe cancelled");
	try {
		const probing = runMcpEffect(probeMcpEndpoint("https://mcp.example/hang"), controller.signal);
		await started;
		controller.abort(reason);
		expect(await probing.catch((error) => error)).toBe(reason);
		expect(requestState.signal?.aborted).toBe(true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
