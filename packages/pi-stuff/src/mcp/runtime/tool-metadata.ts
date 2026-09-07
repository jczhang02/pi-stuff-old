import { isJsonInputObject, type JsonInputObject, type JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import { resourceNameToToolName } from "./resource-tools.ts";
import type { McpExtensionState } from "./state.ts";
import type { McpResource, McpTool, ServerEntry, ToolMetadata, ToolPrefix } from "./types.ts";
import { formatToolName, isToolAllowed, resolveToolPrefix } from "./types.ts";

export interface ToolMetadataBuildResult {
	failedTools: string[];
	metadata: ToolMetadata[];
}

export function buildToolMetadata(
	tools: McpTool[],
	resources: McpResource[],
	definition: ServerEntry,
	serverName: string,
	prefix: ToolPrefix,
): ToolMetadataBuildResult {
	const metadata: ToolMetadata[] = [];
	const failedTools: string[] = [];
	const seenNames = new Set<string>();
	const effectivePrefix = resolveToolPrefix(definition, prefix);

	for (const tool of tools) {
		if (!tool?.name) {
			failedTools.push("(unnamed)");
			continue;
		}
		if (!isToolAllowed(tool.name, serverName, effectivePrefix, definition.includeTools, definition.excludeTools)) {
			continue;
		}

		const name = formatToolName(tool.name, serverName, effectivePrefix);
		if (seenNames.has(name)) {
			continue;
		}

		seenNames.add(name);
		metadata.push({
			name,
			originalName: tool.name,
			description: tool.description ?? "",
			inputSchema: tool.inputSchema,
		});
	}

	if (definition.exposeResources !== false) {
		for (const resource of resources) {
			const baseName = `read_${resourceNameToToolName(resource.name)}`;
			if (!isToolAllowed(baseName, serverName, effectivePrefix, definition.includeTools, definition.excludeTools)) {
				continue;
			}

			const name = formatToolName(baseName, serverName, effectivePrefix);
			if (seenNames.has(name)) {
				continue;
			}
			seenNames.add(name);

			metadata.push({
				name,
				originalName: baseName,
				description: resource.description ?? `Read resource: ${resource.uri}`,
				resourceUri: resource.uri,
			});
		}
	}

	return { metadata, failedTools };
}

export function getToolNames(state: McpExtensionState, serverName: string): string[] {
	return state.toolMetadata.get(serverName)?.map((m) => m.name) ?? [];
}

export function totalToolCount(state: McpExtensionState): number {
	let count = 0;
	for (const metadata of state.toolMetadata.values()) {
		count += metadata.length;
	}
	return count;
}

export function findToolByName(metadata: ToolMetadata[] | undefined, toolName: string): ToolMetadata | undefined {
	if (!metadata) return undefined;
	const exact = metadata.find((m) => m.name === toolName);
	if (exact) return exact;
	const normalized = toolName.replace(/-/g, "_");
	return metadata.find((m) => m.name.replace(/-/g, "_") === normalized);
}

export function formatSchema(schema: JsonInputValue, indent = "  "): string {
	if (!isJsonInputObject(schema)) {
		return `${indent}(no schema)`;
	}

	if (schema["type"] === "object" && isJsonInputObject(schema["properties"])) {
		const props = schema["properties"];
		const required = Array.isArray(schema["required"])
			? schema["required"].filter((name): name is string => isRuntimeString(name))
			: [];

		if (Object.keys(props).length === 0) {
			return `${indent}(no parameters)`;
		}

		const lines: string[] = [];
		for (const [name, propSchema] of Object.entries(props)) {
			lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
		}
		return lines.join("\n");
	}

	const lines = formatNestedSchema(schema, indent);
	if (lines.length > 0) {
		return lines.join("\n");
	}

	const typeStr = formatType(schema);
	if (typeStr) {
		return `${indent}(${typeStr})`;
	}

	return `${indent}(complex schema)`;
}

function formatProperty(name: string, schema: JsonInputValue, required: boolean, indent: string): string[] {
	if (!isJsonInputObject(schema)) {
		return [`${indent}${name}${required ? " *required*" : ""}`];
	}

	const parts = [`${indent}${name}`];
	const typeStr = formatType(schema);
	if (typeStr) parts.push(`(${typeStr})`);
	if (required) parts.push("*required*");
	appendSchemaAnnotations(parts, schema);

	return [parts.join(" "), ...formatNestedSchema(schema, `${indent}  `)];
}

function formatNestedSchema(schema: JsonInputObject, indent: string): string[] {
	const lines: string[] = [];

	if (Array.isArray(schema["anyOf"])) {
		lines.push(...formatVariants("anyOf", schema["anyOf"], indent));
	}
	if (Array.isArray(schema["oneOf"])) {
		lines.push(...formatVariants("oneOf", schema["oneOf"], indent));
	}
	if (schema["items"] !== undefined) {
		lines.push(...formatProperty("items", schema["items"], false, indent));
	}
	if (isJsonInputObject(schema["properties"])) {
		const required = Array.isArray(schema["required"])
			? schema["required"].filter((name): name is string => isRuntimeString(name))
			: [];
		for (const [name, propSchema] of Object.entries(schema["properties"])) {
			lines.push(...formatProperty(name, propSchema, required.includes(name), indent));
		}
	}

	return lines;
}

function formatVariants(keyword: "anyOf" | "oneOf", variants: JsonInputValue[], indent: string): string[] {
	const lines = [`${indent}${keyword}:`];

	for (const variant of variants) {
		if (!isJsonInputObject(variant)) {
			lines.push(`${indent}  - ${JSON.stringify(variant)}`);
			continue;
		}

		const typeStr = formatType(variant) || "schema";
		const parts = [`${indent}  - ${typeStr}`];
		appendSchemaAnnotations(parts, variant);
		lines.push(parts.join(" "));
		lines.push(...formatNestedSchema(variant, `${indent}    `));
	}

	return lines;
}

function formatType(schema: JsonInputObject): string {
	if (Object.hasOwn(schema, "const")) {
		return `const ${JSON.stringify(schema["const"])}`;
	}

	if (Array.isArray(schema["enum"])) {
		return `enum: ${schema["enum"].map((v) => JSON.stringify(v)).join(", ")}`;
	}

	if (Array.isArray(schema["type"])) {
		return schema["type"].map((type) => String(type)).join(" | ");
	}

	if (schema["type"]) {
		return String(schema["type"]);
	}

	if (schema["properties"] && isRuntimeObject(schema["properties"]) && !Array.isArray(schema["properties"])) {
		return "object";
	}

	if (schema["items"] !== undefined) {
		return "array";
	}

	return "";
}

function appendSchemaAnnotations(parts: string[], schema: JsonInputObject): void {
	if (schema["description"] && isRuntimeString(schema["description"])) {
		parts.push(`- ${schema["description"]}`);
	}

	for (const key of [
		"minLength",
		"maxLength",
		"minimum",
		"maximum",
		"minItems",
		"maxItems",
		"format",
		"pattern",
	] as const) {
		if (schema[key] !== undefined) {
			parts.push(`[${key}: ${JSON.stringify(schema[key])}]`);
		}
	}

	if (schema["default"] !== undefined) {
		parts.push(`[default: ${JSON.stringify(schema["default"])}]`);
	}
}
