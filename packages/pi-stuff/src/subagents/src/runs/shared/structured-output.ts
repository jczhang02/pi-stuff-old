import { createRequire } from "node:module";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { isJsonInputObject, type JsonInputObject, type JsonInputValue } from "../../../../shared/json-value.ts";
import {
	isRuntimeBoolean,
	isRuntimeFunction,
	isRuntimeObject,
	isRuntimeString,
} from "../../../../shared/runtime-type.ts";
import type { JsonSchemaObject } from "../../shared/types.ts";
import { PI_CODING_AGENT_PACKAGE_ROOT_ENV } from "../../shared/utils.ts";

export const STRUCTURED_OUTPUT_SCHEMA_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_SCHEMA";
export const STRUCTURED_OUTPUT_CAPTURE_ENV = "PI_SUBAGENT_STRUCTURED_OUTPUT_CAPTURE";
const SCHEMA_MAP_KEYWORDS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"] as const;
const SCHEMA_SINGLE_KEYWORDS = [
	"additionalItems",
	"additionalProperties",
	"contains",
	"not",
	"propertyNames",
	"if",
	"then",
	"else",
	"unevaluatedItems",
	"unevaluatedProperties",
	"contentSchema",
] as const;
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

function rewriteLocalJsonPointerRefs(
	schema: JsonInputValue,
	pointerPrefix: string,
	inheritsWrapperResource = true,
): JsonInputValue {
	if (isRuntimeBoolean(schema) || !isJsonInputObject(schema)) return schema;
	const source: JsonInputObject = schema;
	const rewritten: JsonInputObject = { ...source };
	const sharesWrapperResource = inheritsWrapperResource && !isRuntimeString(source["$id"]);
	if (sharesWrapperResource) {
		for (const keyword of ["$ref", "$dynamicRef", "$recursiveRef"] as const) {
			const ref = source[keyword];
			if (ref === "#") rewritten[keyword] = pointerPrefix;
			else if (isRuntimeString(ref) && ref.startsWith("#/")) rewritten[keyword] = `${pointerPrefix}${ref.slice(1)}`;
		}
	}
	for (const keyword of SCHEMA_MAP_KEYWORDS) {
		const entries = source[keyword];
		if (!entries || !isRuntimeObject(entries) || Array.isArray(entries)) continue;
		rewritten[keyword] = Object.fromEntries(
			Object.entries(entries).map(([name, nested]) => [
				name,
				rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
			]),
		);
	}
	const items = source["items"];
	if (Array.isArray(items))
		rewritten["items"] = items.map((nested) =>
			rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
		);
	else if (items !== undefined)
		rewritten["items"] = rewriteLocalJsonPointerRefs(items, pointerPrefix, sharesWrapperResource);
	for (const keyword of SCHEMA_SINGLE_KEYWORDS) {
		if (source[keyword] !== undefined)
			rewritten[keyword] = rewriteLocalJsonPointerRefs(source[keyword], pointerPrefix, sharesWrapperResource);
	}
	for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
		if (Array.isArray(source[keyword]))
			rewritten[keyword] = source[keyword].map((nested) =>
				rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
			);
	}
	const dependencies = source["dependencies"];
	if (dependencies && isRuntimeObject(dependencies) && !Array.isArray(dependencies)) {
		rewritten["dependencies"] = Object.fromEntries(
			Object.entries(dependencies).map(([name, nested]) => [
				name,
				Array.isArray(nested) ? nested : rewriteLocalJsonPointerRefs(nested, pointerPrefix, sharesWrapperResource),
			]),
		);
	}
	return rewritten;
}

export function createStructuredOutputToolParameters(schema: JsonSchemaObject): JsonSchemaObject {
	return {
		type: "object",
		properties: { value: rewriteLocalJsonPointerRefs(schema, "#/properties/value") },
		required: ["value"],
		additionalProperties: false,
	};
}

interface CompiledJsonSchema {
	Check(value: JsonInputValue): boolean;
	Errors(value: JsonInputValue): Iterable<{ instancePath?: string; message?: string }>;
}

type CompileJsonSchema = (schema: JsonSchemaObject) => CompiledJsonSchema;

let cachedCompile: Promise<CompileJsonSchema> | undefined;

export async function resolveCompileFromPackageRoot(packageRoot: string): Promise<CompileJsonSchema | undefined> {
	const requireFromRoot = createRequire(path.join(packageRoot, "package.json"));
	const resolved = requireFromRoot.resolve("typebox/compile");
	// SAFETY: an ECMAScript module namespace is object-shaped; the export is checked before use.
	const mod = (await import(pathToFileURL(resolved).href)) as { Compile?: unknown };
	if (!isRuntimeFunction(mod.Compile)) return undefined;
	// SAFETY: the resolved TypeBox entry point defines Compile with this schema-to-validator contract.
	return mod.Compile as CompileJsonSchema;
}

async function importCompile(): Promise<CompileJsonSchema> {
	const failures: string[] = [];
	try {
		// SAFETY: an ECMAScript module namespace is object-shaped; the export is checked before use.
		const mod = (await import("typebox/compile")) as { Compile?: unknown };
		if (isRuntimeFunction(mod.Compile)) {
			// SAFETY: the installed TypeBox entry point defines Compile with this schema-to-validator contract.
			return mod.Compile as CompileJsonSchema;
		}
		failures.push("typebox/compile did not export a Compile function");
	} catch (error) {
		failures.push(`direct import failed: ${error instanceof Error ? error.message : String(error)}`);
	}
	const packageRoot = process.env[PI_CODING_AGENT_PACKAGE_ROOT_ENV];
	if (packageRoot) {
		try {
			const compile = await resolveCompileFromPackageRoot(packageRoot);
			if (compile) return compile;
			failures.push("Pi package root typebox/compile did not export a Compile function");
		} catch (error) {
			failures.push(`Pi package root import failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	} else {
		failures.push(`${PI_CODING_AGENT_PACKAGE_ROOT_ENV} is not set`);
	}
	throw new Error(`Cannot load typebox/compile for structured output validation (${failures.join("; ")})`);
}

function loadCompile(): Promise<CompileJsonSchema> {
	if (!cachedCompile) {
		cachedCompile = importCompile().catch((error) => {
			cachedCompile = undefined;
			throw error;
		});
	}
	return cachedCompile;
}

export function assertJsonSchemaObject(
	schema: JsonInputValue,
	label = "outputSchema",
): asserts schema is JsonSchemaObject {
	if (!isJsonInputObject(schema)) {
		throw new Error(`${label} must be a JSON Schema object.`);
	}
}

export async function validateStructuredOutputValue(
	schema: JsonSchemaObject,
	value: JsonInputValue,
): Promise<{ status: "valid" } | { status: "invalid"; message: string }> {
	const compile = await loadCompile();
	let validator: CompiledJsonSchema;
	try {
		validator = compile(schema);
	} catch (error) {
		return {
			status: "invalid",
			message: `invalid outputSchema: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
	if (validator.Check(value)) return { status: "valid" };
	const errors = [...validator.Errors(value)].slice(0, 8).map((error) => {
		const pathText = error.instancePath ? error.instancePath.replace(/^\//, "").replace(/\//g, ".") : "root";
		return `${pathText}: ${error.message}`;
	});
	return { status: "invalid", message: errors.join("; ") || "schema validation failed" };
}
