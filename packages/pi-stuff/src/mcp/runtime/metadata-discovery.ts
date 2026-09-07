import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { Resource, Tool } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import { isJsonInputObject, type JsonInputObject, requireJsonInputValue } from "../../shared/json-value.ts";
import { mcpNativePromise } from "./mcp-effect-runner.ts";
import type { McpResource, McpTool } from "./types.ts";

const MAX_METADATA_ENTRIES = 10_000;
const MAX_METADATA_PAGES = 100;

export function metadataLimitMessage(kind: "tool" | "resource", pages: number, entries: number): string | undefined {
	if (pages > MAX_METADATA_PAGES) return `MCP ${kind} metadata exceeded ${MAX_METADATA_PAGES} pages`;
	if (entries > MAX_METADATA_ENTRIES) return `MCP ${kind} metadata exceeded ${MAX_METADATA_ENTRIES} entries`;
	return undefined;
}

function optionalJsonObject<Value>(value: Value, description: string): JsonInputObject | undefined {
	if (value === undefined) return undefined;
	if (!isJsonInputObject(value)) throw new TypeError(`${description} must contain only JSON values`);
	return value;
}

export function normalizeMcpTool(tool: Tool): McpTool {
	const normalized: McpTool = {
		name: tool.name,
		inputSchema: requireJsonInputValue(tool.inputSchema, `MCP tool "${tool.name}" input schema`),
	};
	if (tool.title !== undefined) normalized.title = tool.title;
	if (tool.description !== undefined) normalized.description = tool.description;
	const metadata = optionalJsonObject(tool._meta, `MCP tool "${tool.name}" metadata`);
	if (metadata !== undefined) normalized._meta = metadata;
	return normalized;
}

export function normalizeMcpResource(resource: Resource): McpResource {
	const normalized: McpResource = {
		uri: resource.uri,
		name: resource.name,
	};
	if (resource.description !== undefined) normalized.description = resource.description;
	if (resource.mimeType !== undefined) normalized.mimeType = resource.mimeType;
	const metadata = optionalJsonObject(resource._meta, `MCP resource "${resource.name}" metadata`);
	if (metadata !== undefined) normalized._meta = metadata;
	return normalized;
}

function fetchTools(client: Client, requestOptions?: RequestOptions): Effect.Effect<McpTool[], Error> {
	return Effect.gen(function* () {
		const tools: McpTool[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const params = cursor ? { cursor } : undefined;
			const result = yield* mcpNativePromise(
				(effectSignal) => client.listTools(params, { ...requestOptions, signal: effectSignal }),
				requestOptions?.signal,
			);
			const page = result.tools ?? [];
			pages += 1;
			const limit = metadataLimitMessage("tool", pages, tools.length + page.length);
			if (limit) return yield* Effect.fail(new Error(limit));
			const normalized = yield* Effect.try({
				try: () => page.map(normalizeMcpTool),
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			});
			tools.push(...normalized);
			cursor = result.nextCursor;
		} while (cursor);
		return tools;
	});
}

function fetchResources(client: Client, requestOptions?: RequestOptions): Effect.Effect<McpResource[], Error> {
	if (!client.getServerCapabilities?.()?.resources) return Effect.succeed([]);
	return Effect.gen(function* () {
		const resources: McpResource[] = [];
		let cursor: string | undefined;
		let pages = 0;
		do {
			const params = cursor ? { cursor } : undefined;
			const result = yield* mcpNativePromise(
				(effectSignal) => client.listResources(params, { ...requestOptions, signal: effectSignal }),
				requestOptions?.signal,
			);
			const page = result.resources ?? [];
			pages += 1;
			const limit = metadataLimitMessage("resource", pages, resources.length + page.length);
			if (limit) return yield* Effect.fail(new Error(limit));
			const normalized = yield* Effect.try({
				try: () => page.map(normalizeMcpResource),
				catch: (error) => (error instanceof Error ? error : new Error(String(error))),
			});
			resources.push(...normalized);
			cursor = result.nextCursor;
		} while (cursor);
		return resources;
	});
}

export function discoverMcpMetadata(
	client: Client,
	requestOptions?: RequestOptions,
): Effect.Effect<{ tools: McpTool[]; resources: McpResource[] }, Error> {
	return Effect.all(
		{
			tools: fetchTools(client, requestOptions),
			resources: fetchResources(client, requestOptions),
		},
		{ concurrency: "unbounded" },
	);
}
