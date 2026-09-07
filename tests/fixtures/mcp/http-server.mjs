import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Guard } from "typebox/guard";

const endpointFile = process.env.PI_STUFF_MCP_HTTP_ENDPOINT;
const requestLog = process.env.PI_STUFF_MCP_HTTP_LOG;
if (!endpointFile || !requestLog) throw new Error("HTTP fixture paths are required");

function log(value) {
	appendFileSync(requestLog, `${JSON.stringify(value)}\n`, "utf8");
}

function result(message) {
	switch (message.method) {
		case "initialize":
			return {
				capabilities: { prompts: {}, resources: {}, tools: {} },
				protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
				serverInfo: { name: "pi-stuff-real-http", version: "1.0.0" },
			};
		case "tools/list":
			return {
				tools: [
					{
						description: "Echo text through the real Streamable HTTP transport",
						inputSchema: {
							additionalProperties: false,
							properties: { text: { type: "string" } },
							required: ["text"],
							type: "object",
						},
						name: "echo_http",
					},
				],
			};
		case "tools/call":
			return {
				content: [{ text: String(message.params?.arguments?.text ?? ""), type: "text" }],
				isError: false,
			};
		case "prompts/list":
			return { prompts: [] };
		case "resources/list":
			return { resources: [] };
		case "resources/templates/list":
			return { resourceTemplates: [] };
		case "ping":
			return {};
		default:
			return undefined;
	}
}

const server = createServer((request, response) => {
	if (request.method === "DELETE") {
		log({ method: "HTTP DELETE" });
		response.writeHead(204).end();
		return;
	}
	if (request.method !== "POST") {
		response.writeHead(405, { Allow: "POST, DELETE" }).end();
		return;
	}
	const chunks = [];
	request.on("data", (chunk) => chunks.push(chunk));
	request.on("end", () => {
		try {
			const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			log({ method: message.method });
			if (message.id === undefined) {
				response.writeHead(202).end();
				return;
			}
			const payload = result(message);
			const body =
				payload === undefined
					? { error: { code: -32601, message: "Method not found" }, id: message.id, jsonrpc: "2.0" }
					: { id: message.id, jsonrpc: "2.0", result: payload };
			response
				.writeHead(
					200,
					Object.assign(
						{ "Content-Type": "application/json" },
						message.method === "initialize" ? { "Mcp-Session-Id": "pi-stuff-http-fixture" } : undefined,
					),
				)
				.end(JSON.stringify(body));
		} catch (error) {
			response.writeHead(400, { "Content-Type": "text/plain" }).end(String(error));
		}
	});
});

server.listen(0, "127.0.0.1", () => {
	const address = server.address();
	if (!address || Guard.IsString(address)) throw new Error("HTTP fixture did not bind a TCP port");
	writeFileSync(endpointFile, `http://127.0.0.1:${String(address.port)}/mcp\n`, "utf8");
});

function shutdown() {
	server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
