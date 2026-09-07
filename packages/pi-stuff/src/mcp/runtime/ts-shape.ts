import type { JsonInputObject, JsonInputValue } from "../../shared/json-value.ts";
import { isRuntimeBoolean, isRuntimeNumber, isRuntimeObject, isRuntimeString } from "../../shared/runtime-type.ts";

type Schema = JsonInputObject;

const UNSUPPORTED_KEYWORDS = ["if", "then", "else", "allOf", "not", "patternProperties", "additionalProperties"];

/** Renders the useful JSON Schema subset as TypeScript, or null for unsupported schemas. */
export function renderTsType(inputSchema: JsonInputValue): string | null {
	try {
		if (!isSchema(inputSchema)) return null;

		const definitions = new Map<string, Schema>();
		for (const key of ["$defs", "definitions"]) {
			const rawDefinitions = inputSchema[key];
			if (rawDefinitions === undefined) continue;
			if (!isSchema(rawDefinitions)) return null;
			for (const [name, definition] of Object.entries(rawDefinitions)) {
				if (!isSchema(definition)) return null;
				definitions.set(`${key}/${decodePointerToken(name)}`, definition);
			}
		}

		const aliases = new Map<string, string>();
		const usedAliases = new Set<string>();
		let aliasIndex = 0;
		const aliasFor = (definitionKey: string) => {
			let alias = aliases.get(definitionKey);
			if (alias) return alias;
			const name = definitionKey.slice(definitionKey.indexOf("/") + 1);
			alias = /^[A-Za-z_$][\w$]*$/.test(name) && !usedAliases.has(name) ? name : `Definition${++aliasIndex}`;
			while (usedAliases.has(alias)) alias = `Definition${++aliasIndex}`;
			aliases.set(definitionKey, alias);
			usedAliases.add(alias);
			return alias;
		};

		const render = (schema: JsonInputValue): string | null => {
			if (!isSchema(schema) || hasUnsupportedKeyword(schema)) return null;

			if ("$ref" in schema) {
				if (!isRuntimeString(schema["$ref"])) return null;
				const match = schema["$ref"].match(/^#\/(\$defs|definitions)\/([^/]+)$/);
				if (!match) return null;
				const [, section, name] = match;
				if (!section || !name) return null;
				const definitionKey = `${section}/${decodePointerToken(name)}`;
				if (!definitions.has(definitionKey)) return null;
				return aliasFor(definitionKey);
			}

			if (Array.isArray(schema["enum"])) {
				const values = schema["enum"].map(renderLiteral);
				return values.every((value): value is string => value !== null) ? values.join(" | ") : null;
			}
			if (Object.hasOwn(schema, "const")) return renderLiteral(schema["const"]);

			let variants: readonly JsonInputValue[] | undefined;
			if (Array.isArray(schema["anyOf"])) variants = schema["anyOf"];
			else if (Array.isArray(schema["oneOf"])) variants = schema["oneOf"];
			if (variants) {
				if (variants.length === 0) return null;
				const rendered = variants.map(render);
				return rendered.every((value): value is string => value !== null) ? rendered.join(" | ") : null;
			}

			if (schema["type"] === "object" || schema["properties"] !== undefined) {
				if (schema["properties"] === undefined) return "{}";
				if (!isSchema(schema["properties"])) return null;
				const required = new Set(
					Array.isArray(schema["required"])
						? schema["required"].filter((name): name is string => isRuntimeString(name))
						: [],
				);
				const properties: string[] = [];
				for (const [name, property] of Object.entries(schema["properties"])) {
					const rendered = render(property);
					if (rendered === null) return null;
					properties.push(`${formatPropertyName(name)}${required.has(name) ? "" : "?"}: ${rendered};`);
				}
				return properties.length === 0 ? "{}" : `{ ${properties.join(" ")} }`;
			}

			if (schema["type"] === "array") {
				if (schema["items"] === undefined) return "unknown[]";
				const item = render(schema["items"]);
				return item === null ? null : `${needsParentheses(item) ? `(${item})` : item}[]`;
			}

			if (Array.isArray(schema["type"])) {
				const types = schema["type"].map(renderType);
				return types.every((type): type is string => type !== null) ? types.join(" | ") : null;
			}
			if (isRuntimeString(schema["type"])) return renderType(schema["type"]);
			return "unknown";
		};

		const root = render(inputSchema);
		if (root === null) return null;

		const definitionsText: string[] = [];
		for (const [key, alias] of aliases) {
			const definition = definitions.get(key);
			if (!definition) return null;
			const rendered = render(definition);
			if (rendered === null) return null;
			definitionsText.push(`type ${alias} = ${rendered};`);
		}
		return definitionsText.length > 0 ? `${definitionsText.join("\n")}\n\n${root}` : root;
	} catch {
		return null;
	}
}

function isSchema(value: JsonInputValue): value is Schema {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function hasUnsupportedKeyword(schema: Schema): boolean {
	return UNSUPPORTED_KEYWORDS.some((keyword) => Object.hasOwn(schema, keyword));
}

function decodePointerToken(token: string): string {
	return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

function renderType(type: JsonInputValue): string | null {
	switch (type) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "object":
			return "{}";
		case "array":
			return "unknown[]";
		default:
			return null;
	}
}

function renderLiteral(value: JsonInputValue): string | null {
	if (value === null || isRuntimeString(value) || isRuntimeBoolean(value)) return JSON.stringify(value);
	return isRuntimeNumber(value) && Number.isFinite(value) ? String(value) : null;
}

function formatPropertyName(name: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
}

function needsParentheses(type: string): boolean {
	return type.includes(" | ");
}
