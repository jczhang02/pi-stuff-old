import { expect, test } from "bun:test";
import { wrapTransportWithMcpTrace } from "../../../packages/pi-stuff/src/mcp/runtime/mcp-trace.js";

type Transport = Parameters<typeof wrapTransportWithMcpTrace>[0];

test("MCP trace transport keeps method identity and delegates callback setters", async () => {
	let closeHandler: Transport["onclose"];
	const transport: Transport = {
		close: async () => undefined,
		send: async () => undefined,
		start: async () => undefined,
	};
	Object.defineProperty(transport, "onclose", {
		get: () => closeHandler,
		set: (handler: Transport["onclose"]) => {
			closeHandler = handler;
		},
	});
	const traced = wrapTransportWithMcpTrace(transport, "fixture", "stdio", { record: () => undefined });
	const handler = () => undefined;

	expect(traced.start).toBe(traced.start);
	traced.onclose = handler;
	expect(closeHandler).toBe(handler);
	await traced.send({ jsonrpc: "2.0", method: "fixture" });
});
