/**
 * Connector and snippet docs rendering — derives TypeScript documentation from
 * connector descriptors on demand. Also renders snippet source.
 */

import { isRuntimeString } from "../../shared/runtime-type.ts";
import type { ConnectorDescription, DescribeOutput } from "./connector-types.ts";
import { generateTypesFromJsonSchema, type JsonSchemaToolDescriptors } from "./json-schema-types.ts";
import type { Snippet } from "./snippet.ts";
import { sanitizeToolName, toolOwnerPath, toolPath } from "./utils.ts";

function parseStringLiteral(literal: string | undefined): string | undefined {
	if (!literal) return undefined;
	try {
		const value: unknown = JSON.parse(literal);
		return isRuntimeString(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

function splitTarget(target: string): readonly [string, string | undefined] {
	const global = target.match(
		/^globalThis\[("(?:\\.|[^"\\])*")\](?:\.([A-Za-z_$][A-Za-z0-9_$]*)|\[("(?:\\.|[^"\\])*")\])?$/u,
	);
	if (global) {
		const owner = parseStringLiteral(global[1]);
		if (owner !== undefined) {
			if (global[2] !== undefined) return [owner, global[2]];
			if (global[3] === undefined) return [owner, undefined];
			const method = parseStringLiteral(global[3]);
			if (method !== undefined) return [owner, method];
		}
	}
	const bracket = target.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\[("(?:\\.|[^"\\])*")\]$/u);
	const owner = bracket?.[1];
	const method = parseStringLiteral(bracket?.[2]);
	if (owner && method !== undefined) return [owner, method];
	const separator = target.indexOf(".");
	return separator < 0 ? [target, undefined] : [target.slice(0, separator), target.slice(separator + 1)];
}

function renderConnectorTypes(
	connectorName: string,
	instructions: string | undefined,
	descriptors: JsonSchemaToolDescriptors,
): string {
	const types = generateTypesFromJsonSchema(descriptors).replace(
		"declare const codemode",
		`declare const ${sanitizeToolName(connectorName)}`,
	);
	return [instructions, types].filter(Boolean).join("\n\n");
}

function renderMethodTypes(methodName: string, descriptors: JsonSchemaToolDescriptors): string {
	const descriptor = descriptors[methodName];
	if (!descriptor) return "";
	const generated = generateTypesFromJsonSchema({ [methodName]: descriptor });
	return generated.slice(0, generated.indexOf("declare const codemode")).trim();
}

export function describeTarget(
	target: string,
	descriptions: ConnectorDescription[],
	snippets?: Snippet[],
): DescribeOutput {
	// Check snippets first
	if (snippets) {
		const snippet = snippets.find((s) => s.name === target);
		if (snippet) {
			const parts = [snippet.description];
			parts.push(`\`\`\`ts\n${snippet.code}\n\`\`\``);
			return {
				path: snippet.name,
				description: snippet.description,
				types: parts.join("\n\n"),
				kind: "snippet",
			};
		}
	}

	const [maybeConnector, maybeMethod] = splitTarget(target);

	const connector = descriptions.find((d) => d.name === maybeConnector);

	// Connector-level describe
	if (connector && !maybeMethod) {
		return {
			path: toolOwnerPath(connector.name),
			description: connector.instructions,
			types: renderConnectorTypes(connector.name, connector.instructions, connector.descriptors),
			kind: "connector",
		};
	}

	// Method-level describe
	const candidates = connector ? [connector] : descriptions;
	const methodName = maybeMethod ?? target;

	for (const candidate of candidates) {
		if (candidate.descriptors[methodName]) {
			const result: DescribeOutput = {
				path: toolPath(methodName, candidate.name),
				description: candidate.descriptors[methodName]?.description,
				types: renderMethodTypes(methodName, candidate.descriptors),
				kind: "method",
			};
			if (candidate.annotations?.[methodName]?.requiresApproval) {
				Object.assign(result, { requiresApproval: true });
			}
			return result;
		}
	}

	return {
		path: target,
		description: undefined,
		types: `"${target}" not found.`,
		kind: "method",
	};
}
