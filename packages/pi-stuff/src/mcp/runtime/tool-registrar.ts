// tool-registrar.ts - MCP content transformation
// NOTE: Tools are NOT registered with Pi - only the unified `mcp` proxy tool is registered.
// This keeps the LLM context small (1 tool instead of 100s).

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isJsonInputValue, type JsonInputValue } from "../../shared/json-value.ts";
import type { ContentBlock } from "./types.ts";

export type McpCallToolResponse = Awaited<ReturnType<Client["callTool"]>>;
export type ImmediateCallToolResult = Exclude<McpCallToolResponse, { toolResult: unknown }>;

export function isImmediateCallToolResult(result: McpCallToolResponse): result is ImmediateCallToolResult {
	return "content" in result;
}

/**
 * Transform MCP content types to Pi content blocks.
 */
export function transformMcpContent(content: CallToolResult["content"]): ContentBlock[] {
	return content.map((c) => {
		if (c.type === "text") {
			return { type: "text" as const, text: c.text ?? "" };
		}
		if (c.type === "image") {
			return {
				type: "image" as const,
				data: c.data ?? "",
				mimeType: c.mimeType ?? "image/png",
			};
		}
		if (c.type === "resource") {
			const resourceUri = c.resource?.uri ?? "(no URI)";
			const resourceContent = "text" in c.resource ? c.resource.text : JSON.stringify(c.resource);
			return {
				type: "text" as const,
				text: `[Resource: ${resourceUri}]\n${resourceContent}`,
			};
		}
		if (c.type === "resource_link") {
			const linkName = c.name ?? c.uri ?? "unknown";
			const linkUri = c.uri ?? "(no URI)";
			return {
				type: "text" as const,
				text: `[Resource Link: ${linkName}]\nURI: ${linkUri}`,
			};
		}
		if (c.type === "audio") {
			return {
				type: "text" as const,
				text: `[Audio content: ${c.mimeType ?? "audio/*"}]`,
			};
		}
		return { type: "text" as const, text: JSON.stringify(c) };
	});
}

/**
 * Resolve a tool result's content blocks, falling back to structuredContent
 * when content is empty.
 */
export function resolveMcpResultContent(result: CallToolResult): ContentBlock[] {
	const blocks = transformMcpContent(result.content);
	if (blocks.length > 0) return blocks;

	if (result.structuredContent !== undefined && result.structuredContent !== null) {
		if (!isJsonInputValue(result.structuredContent)) throw new Error("MCP returned invalid structured content");
		return [{ type: "text" as const, text: stringifyStructuredContent(result.structuredContent) }];
	}

	return [];
}

function stringifyStructuredContent(value: JsonInputValue): string {
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}
