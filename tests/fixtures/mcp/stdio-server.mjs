import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const marker = process.env.PI_STUFF_MCP_MARKER;
const resourcesError = process.env.PI_STUFF_MCP_RESOURCES_ERROR === "1";
const hangCall = process.env.PI_STUFF_MCP_HANG_CALL === "1";
const metadataLoop = process.env.PI_STUFF_MCP_METADATA_LOOP;
const oversizedMetadata = process.env.PI_STUFF_MCP_OVERSIZED_METADATA === "1";
if (marker) writeFileSync(marker, `${String(process.pid)}\n`, "utf8");

let stopped = false;
function recordExit(reason) {
	if (stopped) return;
	stopped = true;
	if (marker) appendFileSync(marker, `exit:${reason}\n`, "utf8");
}

function reply(id, result) {
	process.stdout.write(`${JSON.stringify({ id, jsonrpc: "2.0", result })}\n`);
}

function handle(message) {
	if (message.id === undefined) return;
	switch (message.method) {
		case "initialize":
			reply(message.id, {
				capabilities: { prompts: {}, resources: {}, tools: {} },
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				serverInfo: { name: "pi-stuff-real-stdio", version: "1.0.0" },
			});
			break;
		case "tools/list":
			if (metadataLoop === "tools") {
				reply(message.id, {
					nextCursor: String(Number(message.params?.cursor ?? 0) + 1),
					tools: [],
				});
				break;
			}
			if (oversizedMetadata) {
				reply(message.id, {
					tools: Array.from({ length: 10_001 }, (_, index) => ({
						inputSchema: { type: "object" },
						name: `tool-${String(index)}`,
					})),
				});
				break;
			}
			reply(message.id, {
				tools: [
					{
						description: "Echo text through the real stdio transport",
						inputSchema: {
							additionalProperties: false,
							properties: { text: { type: "string" } },
							required: ["text"],
							type: "object",
						},
						name: "echo",
					},
				],
			});
			break;
		case "tools/call":
			if (marker) appendFileSync(marker, `call:${String(message.params?.arguments?.text ?? "")}\n`, "utf8");
			if (hangCall) break;
			reply(message.id, {
				content: [{ text: String(message.params?.arguments?.text ?? ""), type: "text" }],
				isError: false,
			});
			break;
		case "prompts/list":
			reply(message.id, { prompts: [] });
			break;
		case "resources/list":
			if (resourcesError) {
				process.stdout.write(
					`${JSON.stringify({ error: { code: -32000, message: "resource listing failed" }, id: message.id, jsonrpc: "2.0" })}\n`,
				);
			} else if (metadataLoop === "resources") {
				reply(message.id, {
					nextCursor: String(Number(message.params?.cursor ?? 0) + 1),
					resources: [],
				});
			} else {
				reply(message.id, { resources: [] });
			}
			break;
		case "resources/templates/list":
			reply(message.id, { resourceTemplates: [] });
			break;
		case "ping":
			reply(message.id, {});
			break;
		default:
			process.stdout.write(
				`${JSON.stringify({ error: { code: -32601, message: "Method not found" }, id: message.id, jsonrpc: "2.0" })}\n`,
			);
	}
}

const input = createInterface({ input: process.stdin, terminal: false });
input.on("line", (line) => {
	try {
		handle(JSON.parse(line));
	} catch (error) {
		process.stderr.write(`fixture parse failure: ${String(error)}\n`);
	}
});
input.on("close", () => {
	recordExit("stdin");
	process.exit(0);
});
process.on("SIGINT", () => {
	recordExit("sigint");
	process.exit(0);
});
process.on("SIGTERM", () => {
	recordExit("sigterm");
	process.exit(0);
});
