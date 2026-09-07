import { describe, expect, test } from "bun:test";
import { mcpNativePromise, runMcpEffect } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-effect-runner.js";
import { connectClient } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-http-transport.js";
import { createMcpRuntimeOwner } from "../../../packages/pi-stuff/src/mcp/runtime/runtime-owner.js";
import type { Transport } from "../../../packages/pi-stuff/src/mcp/runtime/types.js";

describe("MCP runtime ownership", () => {
	test("aborts immediately and bounds cleanup that ignores cancellation", async () => {
		const owner = createMcpRuntimeOwner(10);
		await runMcpEffect(owner.addCleanup(() => new Promise(() => undefined)));

		const startedAt = performance.now();
		await runMcpEffect(owner.stop("test shutdown"));

		expect(owner.signal.aborted).toBeTrue();
		expect(performance.now() - startedAt).toBeLessThan(100);
	});

	test("interrupts a native Promise that ignores its supplied signal", async () => {
		const controller = new AbortController();
		const pending = runMcpEffect(mcpNativePromise(() => new Promise(() => undefined), controller.signal));
		const reason = new Error("external abort");

		controller.abort(reason);

		await expect(pending).rejects.toBe(reason);
	});

	test("closes an in-progress client transport when its owner aborts", async () => {
		let closeCount = 0;
		const transport: Transport = {
			close: async () => {
				closeCount++;
				transport.onclose?.();
			},
			send: async () => undefined,
			start: async () => undefined,
		};
		const client = {
			close: async () => undefined,
			connect: async () => new Promise<void>(() => undefined),
		};
		const controller = new AbortController();
		const connecting = runMcpEffect(connectClient(client, transport), controller.signal);

		await Promise.resolve();
		controller.abort(new Error("test abort"));

		await expect(connecting).rejects.toThrow("test abort");
		expect(closeCount).toBe(1);
	});

	test("reports an abort cleanup failure without closing twice", async () => {
		let closeCount = 0;
		const cleanupError = new Error("close failed");
		const transport: Transport = {
			close: async () => {
				closeCount++;
				throw cleanupError;
			},
			send: async () => undefined,
			start: async () => undefined,
		};
		const client = {
			close: async () => undefined,
			connect: async () => new Promise<void>(() => undefined),
		};
		const controller = new AbortController();
		const connecting = runMcpEffect(connectClient(client, transport), controller.signal);

		await Promise.resolve();
		controller.abort(new Error("test abort"));
		const error = await connecting.catch((cause) => cause);

		expect(error).toBeInstanceOf(AggregateError);
		expect(error.message).toBe("MCP connection abort cleanup failed");
		expect(error.errors).toContain(cleanupError);
		expect(closeCount).toBe(1);
	});
});
