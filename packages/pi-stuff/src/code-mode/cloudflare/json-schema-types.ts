import type { JSONSchema7, JSONSchema7Definition } from "json-schema";
import { isJsonInputObject, type JsonInputObject, type JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";
import { escapeJsDoc, escapeStringLiteral, quoteProp, sanitizeToolName, toPascalCase } from "./utils.ts";

export interface ConversionContext {
	root: JSONSchema7;
	depth: number;
	seen: Set<unknown>;
	maxDepth: number;
}

function isJsonSchemaObject<Value>(value: Value): value is Value & JSONSchema7 & JsonInputObject {
	return isJsonInputObject(value);
}

function isJsonSchemaDefinition<Value>(value: Value): value is Value & JSONSchema7Definition {
	return isRuntimeBoolean(value) || isJsonSchemaObject(value);
}

/**
 * Resolve an internal JSON Pointer $ref (e.g. #/definitions/Foo) against the root schema.
 * Returns null for external URLs or unresolvable paths.
 */
function resolveRef(ref: string, root: JSONSchema7): JSONSchema7Definition | null {
	// "#" is a valid self-reference to the root schema
	if (ref === "#") return root;

	if (!ref.startsWith("#/")) return null;

	const segments = ref
		.slice(2)
		.split("/")
		.map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));

	if (!isJsonSchemaObject(root)) return null;
	let current: JsonInputValue = root;
	for (const seg of segments) {
		if (!isJsonInputObject(current)) return null;
		current = current[seg];
		if (current === undefined) return null;
	}

	// Allow both object schemas and boolean schemas (true = any, false = never)
	return isJsonSchemaDefinition(current) ? current : null;
}

/**
 * Apply OpenAPI 3.0 `nullable: true` to a type result.
 */
function applyNullable(result: string, schema: JSONSchema7): string {
	if (result !== "unknown" && result !== "never" && isJsonInputObject(schema) && schema["nullable"] === true) {
		return `${result} | null`;
	}
	return result;
}

function convertSchemas(
	schemas: readonly JSONSchema7Definition[],
	separator: string,
	indent: string,
	ctx: ConversionContext,
): string {
	return schemas.map((schema) => jsonSchemaToTypeString(schema, indent, ctx)).join(separator);
}

function objectType(schema: JSONSchema7, indent: string, ctx: ConversionContext): string {
	const required = new Set(schema.required ?? []);
	const lines: string[] = [];
	const memberIndent = `${indent}    `;

	for (const [name, property] of Object.entries(schema.properties ?? {})) {
		const optional = required.has(name) ? "" : "?";
		if (isRuntimeBoolean(property)) {
			lines.push(`${memberIndent}${quoteProp(name)}${optional}: ${property ? "unknown" : "never"};`);
			continue;
		}

		const details = [
			...(property.description ? [escapeJsDoc(property.description.replace(/\r?\n/g, " "))] : []),
			...(property.format ? [`@format ${escapeJsDoc(property.format)}`] : []),
		];
		if (details.length > 1) {
			lines.push(
				`${memberIndent}/**`,
				...details.map((detail) => `${indent}     * ${detail}`),
				`${memberIndent} */`,
			);
		} else if (details[0]) {
			lines.push(`${memberIndent}/** ${details[0]} */`);
		}

		const type = jsonSchemaToTypeString(property, memberIndent, ctx);
		lines.push(`${memberIndent}${quoteProp(name)}${optional}: ${type};`);
	}

	if (schema.additionalProperties) {
		const type =
			schema.additionalProperties === true
				? "unknown"
				: jsonSchemaToTypeString(schema.additionalProperties, memberIndent, ctx);
		lines.push(`${memberIndent}[key: string]: ${type};`);
	}

	if (lines.length > 0) return applyNullable(`{\n${lines.join("\n")}\n${indent}}`, schema);
	return applyNullable(schema.additionalProperties === false ? "{}" : "Record<string, unknown>", schema);
}

/**
 * Convert a JSON Schema to a TypeScript type string.
 * This is a direct conversion without going through Zod.
 */
export function jsonSchemaToTypeString(schema: JSONSchema7Definition, indent: string, ctx: ConversionContext): string {
	// Handle boolean schemas
	if (isRuntimeBoolean(schema)) {
		return schema ? "unknown" : "never";
	}

	// Depth guard
	if (ctx.depth >= ctx.maxDepth) return "unknown";

	// Circular reference guard
	if (ctx.seen.has(schema)) return "unknown";

	ctx.seen.add(schema);
	const nextCtx: ConversionContext = {
		...ctx,
		depth: ctx.depth + 1,
	};

	try {
		// Handle $ref
		if (schema.$ref) {
			const resolved = resolveRef(schema.$ref, ctx.root);
			if (!resolved) return "unknown";
			return applyNullable(jsonSchemaToTypeString(resolved, indent, nextCtx), schema);
		}

		if (schema.anyOf) return applyNullable(convertSchemas(schema.anyOf, " | ", indent, nextCtx), schema);
		if (schema.oneOf) return applyNullable(convertSchemas(schema.oneOf, " | ", indent, nextCtx), schema);
		if (schema.allOf) return applyNullable(convertSchemas(schema.allOf, " & ", indent, nextCtx), schema);

		// Handle enum
		if (schema.enum) {
			if (schema.enum.length === 0) return "never";
			const result = schema.enum
				.map((v) => {
					if (v === null) return "null";
					if (isRuntimeString(v)) return `"${escapeStringLiteral(v)}"`;
					if (isRuntimeObject(v)) return JSON.stringify(v) ?? "unknown";
					return String(v);
				})
				.join(" | ");
			return applyNullable(result, schema);
		}

		// Handle const
		if (schema.const !== undefined) {
			const result =
				schema.const === null
					? "null"
					: isRuntimeString(schema.const)
						? `"${escapeStringLiteral(schema.const)}"`
						: isRuntimeObject(schema.const)
							? (JSON.stringify(schema.const) ?? "unknown")
							: String(schema.const);
			return applyNullable(result, schema);
		}

		// Handle type
		const type = schema.type;

		if (type === "string") return applyNullable("string", schema);
		if (type === "number" || type === "integer") return applyNullable("number", schema);
		if (type === "boolean") return applyNullable("boolean", schema);
		if (type === "null") return "null";

		if (type === "array") {
			const prefixItems = isJsonInputObject(schema) ? schema["prefixItems"] : undefined;
			if (Array.isArray(prefixItems) && prefixItems.every(isJsonSchemaDefinition)) {
				return applyNullable(`[${convertSchemas(prefixItems, ", ", indent, nextCtx)}]`, schema);
			}
			if (Array.isArray(schema.items)) {
				return applyNullable(`[${convertSchemas(schema.items, ", ", indent, nextCtx)}]`, schema);
			}

			if (schema.items) {
				const itemType = jsonSchemaToTypeString(schema.items, indent, nextCtx);
				return applyNullable(`${itemType}[]`, schema);
			}
			return applyNullable("unknown[]", schema);
		}

		if (type === "object" || schema.properties) return objectType(schema, indent, nextCtx);

		// Handle array of types (e.g., ["string", "null"])
		if (Array.isArray(type)) {
			const types = type.map((t) => {
				if (t === "string") return "string";
				if (t === "number" || t === "integer") return "number";
				if (t === "boolean") return "boolean";
				if (t === "null") return "null";
				if (t === "array") return "unknown[]";
				if (t === "object") return "Record<string, unknown>";
				return "unknown";
			});
			return applyNullable(types.join(" | "), schema);
		}

		return "unknown";
	} finally {
		ctx.seen.delete(schema);
	}
}

/**
 * Convert a JSON Schema to a TypeScript type declaration.
 */
export function jsonSchemaToType(schema: JSONSchema7, typeName: string): string {
	const ctx: ConversionContext = {
		root: schema,
		depth: 0,
		seen: new Set(),
		maxDepth: 20,
	};
	const typeBody = jsonSchemaToTypeString(schema, "", ctx);
	return `type ${typeName} = ${typeBody}`;
}

/**
 * Extract field descriptions from a JSON Schema's properties.
 */
interface JsonSchemaDescriptions {
	[fieldName: string]: string;
}

function extractJsonSchemaDescriptions(schema: JSONSchema7): JsonSchemaDescriptions {
	const descriptions: JsonSchemaDescriptions = {};
	if (schema.properties) {
		for (const [fieldName, propSchema] of Object.entries(schema.properties)) {
			if (propSchema && isRuntimeObject(propSchema) && propSchema.description) {
				descriptions[fieldName] = propSchema.description;
			}
		}
	}
	return descriptions;
}

/**
 * A tool descriptor using plain JSON Schema (no Zod or AI SDK dependency).
 */
export interface JsonSchemaToolDescriptor {
	description?: string;
	inputSchema: JSONSchema7;
	outputSchema?: JSONSchema7;
}

export type JsonSchemaToolDescriptors = Record<string, JsonSchemaToolDescriptor>;

/**
 * Generate TypeScript type definitions from tool descriptors with JSON Schema.
 * This function has NO dependency on the AI SDK or Zod — it works purely with
 * JSON Schema objects.
 *
 * Use this when you have raw JSON Schema (e.g. from OpenAPI specs, MCP tool
 * definitions, etc.) and don't need the AI SDK.
 */
export function generateTypesFromJsonSchema(tools: JsonSchemaToolDescriptors): string {
	let availableTools = "";
	let availableTypes = "";

	for (const [toolName, tool] of Object.entries(tools)) {
		const safeName = sanitizeToolName(toolName);
		const typeName = toPascalCase(safeName);

		try {
			const inputType = jsonSchemaToType(tool.inputSchema, `${typeName}Input`);

			const outputType = tool.outputSchema
				? jsonSchemaToType(tool.outputSchema, `${typeName}Output`)
				: `type ${typeName}Output = unknown`;

			availableTypes += `\n${inputType.trim()}`;
			availableTypes += `\n${outputType.trim()}`;

			const paramLines = (() => {
				try {
					const paramDescs = extractJsonSchemaDescriptions(tool.inputSchema);
					return Object.entries(paramDescs).map(([fieldName, desc]) => `@param input.${fieldName} - ${desc}`);
				} catch {
					return [];
				}
			})();
			const jsdocLines: string[] = [];
			if (tool.description?.trim()) {
				jsdocLines.push(escapeJsDoc(tool.description.trim().replace(/\r?\n/g, " ")));
			} else {
				jsdocLines.push(escapeJsDoc(toolName));
			}
			for (const pd of paramLines) {
				jsdocLines.push(escapeJsDoc(pd.replace(/\r?\n/g, " ")));
			}

			const jsdocBody = jsdocLines.map((l) => `\t * ${l}`).join("\n");
			availableTools += `\n\t/**\n${jsdocBody}\n\t */`;
			availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
			availableTools += "\n";
		} catch {
			availableTypes += `\ntype ${typeName}Input = unknown`;
			availableTypes += `\ntype ${typeName}Output = unknown`;

			availableTools += `\n\t/**\n\t * ${escapeJsDoc(toolName)}\n\t */`;
			availableTools += `\n\t${safeName}: (input: ${typeName}Input) => Promise<${typeName}Output>;`;
			availableTools += "\n";
		}
	}

	availableTools = `\ndeclare const codemode: {${availableTools}}`;

	return `
${availableTypes}
${availableTools}
  `.trim();
}
