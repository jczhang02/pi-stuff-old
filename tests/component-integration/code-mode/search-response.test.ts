import { expect, test } from "bun:test";
import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
	DescribeOutput,
	SearchOutput,
	SearchResult,
} from "../../../packages/pi-stuff/src/code-mode/cloudflare/connector-types.js";
import { toolPath } from "../../../packages/pi-stuff/src/code-mode/cloudflare/utils.js";
import { SuiteCodeModeConnector } from "../../../packages/pi-stuff/src/code-mode/connector.js";
import {
	type CodeModeSearchDetails,
	createCodeModeSearchDefinition,
} from "../../../packages/pi-stuff/src/code-mode/extension.js";
import { SubagentParams } from "../../../packages/pi-stuff/src/subagents/src/extension/schemas.js";
import { buildSubagentToolDescription } from "../../../packages/pi-stuff/src/subagents/src/extension/tool-description.js";
import type { SuiteToolDefinitionRegistry } from "../../../packages/pi-stuff/src/tool-display/contract.js";

type DiscoveryConnector = Parameters<typeof createCodeModeSearchDefinition>[0];

function discoveryConnectorFixture(
	entries: readonly {
		readonly connector?: string;
		readonly descriptionSize?: number;
		readonly name?: string;
		readonly types?: string;
		readonly typesSize?: number;
	}[],
): DiscoveryConnector {
	const results: SearchResult[] = entries.map((entry, index) => {
		const connector = entry.connector ?? "tools";
		const method = entry.name ?? `fixture_${String(index)}`;
		return {
			connector,
			description: "d".repeat(entry.descriptionSize ?? 0),
			kind: "method",
			method,
			path: toolPath(method, connector),
			score: 100 - index,
		};
	});
	const definitions = new Map<string, DescribeOutput>(
		results.map((result, index) => [
			result.path,
			{
				description: result.description,
				kind: "method",
				path: result.path,
				types: entries[index]?.types ?? "T".repeat(entries[index]?.typesSize ?? 0),
			},
		]),
	);
	return {
		describe(path: string) {
			const definition = definitions.get(path);
			if (!definition) throw new Error(`Missing discovery fixture ${path}`);
			return definition;
		},
		search: () => ({ results, total: results.length, truncated: false }) satisfies SearchOutput,
	};
}

interface DiscoveryPayload {
	readonly definitions: readonly { readonly description?: string; readonly path: string; readonly types?: string }[];
	readonly instruction?: string;
	readonly representation: "definitions" | "typed-top" | "describe-required";
	readonly results: readonly { readonly kind?: string; readonly path: string; readonly signature?: string }[];
	readonly truncated: boolean;
}

async function executeDiscovery(
	connector: DiscoveryConnector,
	query = "fixture",
): Promise<{
	readonly details: CodeModeSearchDetails;
	readonly payload: DiscoveryPayload;
	readonly text: string;
}> {
	// SAFETY: this fixture supplies the only ExtensionContext field read by Tool Discovery.
	const result = await createCodeModeSearchDefinition(connector).execute(
		"search-fixture",
		{ query },
		undefined,
		undefined,
		{ cwd: "/project" } as ExtensionContext,
	);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	// SAFETY: Tool Discovery produced this JSON from the asserted projection contract.
	return { details: result.details, payload: JSON.parse(text) as DiscoveryPayload, text };
}

test("top-level Tool Discovery keeps the callable subagent contract within its character budget", async () => {
	const roster = Array.from({ length: 8 }, (_, index) => ({
		description: `Read-only Agent ${String(index + 1)} for focused repository investigation and exact source evidence`,
		name: `agent-${String(index + 1)}`,
		tools: ["read", "find", "bash"],
	}));
	const definition: ToolDefinition = {
		description: buildSubagentToolDescription(roster),
		execute: async () => ({ content: [], details: {} }),
		label: "Subagent",
		name: "subagent",
		parameters: SubagentParams,
	};
	const registry: SuiteToolDefinitionRegistry = {
		catalog: () => [{ definition }],
		compensate: async () => false,
		get: (name) => (name === definition.name ? definition : undefined),
		invoke: async () => ({ isError: false, result: { content: [], details: {} } }),
		isActive: (name) => name === definition.name,
		list: () => [definition],
	};
	const projection = await executeDiscovery(new SuiteCodeModeConnector(registry), "delegate agent");

	expect(projection.text.length).toBeLessThanOrEqual(4_000);
	expect(projection.payload.representation).toBe("typed-top");
	expect(projection.payload.definitions[0]?.description).toContain("single uses agent + task");
	expect(projection.payload.definitions[0]?.description).toContain("agent-8");
	expect(projection.payload.definitions[0]?.description).toContain("id identifies an Agent Target");
	expect(projection.payload.definitions[0]?.description).toContain("taskId");
	expect(projection.payload.definitions[0]?.types).toContain("agent?: string");
	expect(projection.payload.definitions[0]?.types).toContain("id?: string");
	expect(projection.payload.definitions[0]?.types).not.toContain("/**");
});

test("top-level Tool Discovery emits a saved snippet description once", async () => {
	const description = "Reuse the verified formatter";
	const result: SearchResult = {
		connector: "snippets",
		description,
		kind: "snippet",
		method: "format-result",
		path: "format-result",
		score: 100,
	};
	const projection = await executeDiscovery({
		describe: () => ({
			description,
			kind: "snippet",
			path: result.path,
			types: [description, "```ts\nreturn input;\n```"].join("\n\n"),
		}),
		search: () => ({ results: [result], total: 1, truncated: false }),
	});

	expect(projection.payload.representation).toBe("definitions");
	expect(projection.payload.definitions[0]?.description).toBe(description);
	expect(projection.payload.definitions[0]?.types).toBe("```ts\nreturn input;\n```");
	expect(projection.text.split(description)).toHaveLength(2);
});

test("typed-top discovery preserves saved snippet source verbatim", async () => {
	const description = "Reuse the verified formatter";
	const snippet: SearchResult = {
		connector: "snippets",
		description,
		kind: "snippet",
		method: "format-result",
		path: "format-result",
		score: 100,
	};
	const method: SearchResult = {
		connector: "tools",
		kind: "method",
		method: "oversized",
		path: "tools.oversized",
		score: 90,
	};
	const source = "```ts\n/** keep this comment */\n* keep this line\n```";
	const projection = await executeDiscovery({
		describe: (path) =>
			path === snippet.path
				? { description, kind: "snippet", path, types: [description, source].join("\n\n") }
				: { kind: "method", path, types: "T".repeat(5_000) },
		search: () => ({ results: [snippet, method], total: 2, truncated: false }),
	});

	expect(projection.payload.representation).toBe("typed-top");
	expect(projection.payload.definitions[0]?.types).toBe(source);
});

test("top-level Tool Discovery deterministically degrades every response within its character budget", async () => {
	const definitions = await executeDiscovery(discoveryConnectorFixture([{ typesSize: 100 }, { typesSize: 100 }]));
	expect(definitions.payload.representation).toBe("definitions");
	expect(definitions.payload.definitions).toHaveLength(2);
	expect(definitions.payload.results[0]).not.toHaveProperty("description");

	const partialDefinitions = await executeDiscovery(
		discoveryConnectorFixture([{ typesSize: 1_800 }, { typesSize: 1_800 }, { typesSize: 1_800 }]),
	);
	expect(partialDefinitions.payload.representation).toBe("typed-top");
	expect(partialDefinitions.payload.definitions).toHaveLength(1);
	expect(partialDefinitions.payload.results).toHaveLength(3);

	const documentedType = `/** ${"field details ".repeat(150)}*/\ntype FixtureInput = string;`;
	const typedTop = await executeDiscovery(
		discoveryConnectorFixture(Array.from({ length: 5 }, () => ({ descriptionSize: 2_500, types: documentedType }))),
	);
	expect(typedTop.payload.representation).toBe("typed-top");
	expect(typedTop.payload.definitions[0]?.description).toHaveLength(2_500);
	expect(typedTop.payload.definitions[0]?.types).toBe("type FixtureInput = string;");
	expect(typedTop.payload.results[1]?.signature).toContain("(input: unknown): Promise<unknown>");

	const typedPaths = await executeDiscovery(
		discoveryConnectorFixture([
			{ descriptionSize: 2_500, types: documentedType },
			{ name: "n".repeat(5_000) },
			{ name: "typed-usable" },
		]),
	);
	expect(typedPaths.payload.representation).toBe("typed-top");
	expect(typedPaths.payload.results.map((result) => result.path)).toEqual([
		"tools.fixture_0",
		'tools["typed-usable"]',
	]);

	const describeRequired = await executeDiscovery(
		discoveryConnectorFixture([{ typesSize: 5_000 }, { typesSize: 5_000 }]),
	);
	expect(describeRequired.payload.representation).toBe("describe-required");
	expect(describeRequired.payload.definitions).toEqual([]);
	expect(describeRequired.payload.instruction).toContain("codemode.describe");
	expect(describeRequired.payload.results[0]?.signature).toBeUndefined();

	const bracketPath = await executeDiscovery(discoveryConnectorFixture([{ name: "task-create", typesSize: 5_000 }]));
	expect(bracketPath.payload.representation).toBe("describe-required");
	expect(bracketPath.payload.results[0]?.path).toBe('tools["task-create"]');

	const bracketDefinition = await executeDiscovery(discoveryConnectorFixture([{ name: "task-create", typesSize: 5 }]));
	expect(bracketDefinition.payload.representation).toBe("definitions");
	expect(bracketDefinition.payload.definitions[0]?.path).toBe('tools["task-create"]');
	expect(bracketDefinition.payload.results[0]).toMatchObject({
		path: 'tools["task-create"]',
		signature: 'tools["task-create"](input: TaskCreateInput): Promise<TaskCreateOutput>',
	});

	const customOwner = await executeDiscovery(
		discoveryConnectorFixture([{ connector: "my-tools", name: "task-create", typesSize: 5 }]),
	);
	expect(customOwner.payload.results[0]?.path).toBe('globalThis["my-tools"]["task-create"]');

	const longNames = Array.from({ length: 5 }, (_, index) => ({
		name: `${String(index)}_${"n".repeat(2_100)}`,
		typesSize: 5_000,
	}));
	const paths = await executeDiscovery(discoveryConnectorFixture(longNames));
	expect(paths.payload.representation).toBe("describe-required");
	expect(paths.payload.results[0]).toMatchObject({ path: `tools[${JSON.stringify(longNames[0]?.name)}]` });

	const mixedPaths = await executeDiscovery(
		discoveryConnectorFixture([
			{ name: "n".repeat(5_000), typesSize: 5_000 },
			{ name: "usable", typesSize: 5_000 },
		]),
	);
	expect(mixedPaths.payload.representation).toBe("describe-required");
	expect(mixedPaths.payload.results).toEqual([{ kind: "method", path: "tools.usable" }]);

	const oversizedPath = await executeDiscovery(
		discoveryConnectorFixture([{ name: "n".repeat(5_000), typesSize: 5_000 }]),
	);
	expect(oversizedPath.payload.representation).toBe("describe-required");
	expect(oversizedPath.payload.results).toEqual([]);
	expect(oversizedPath.payload.instruction).toContain("refine the search");

	for (const projection of [
		definitions,
		partialDefinitions,
		typedTop,
		typedPaths,
		describeRequired,
		bracketPath,
		bracketDefinition,
		paths,
		mixedPaths,
		oversizedPath,
	]) {
		expect(projection.text.length).toBeLessThanOrEqual(4_000);
		expect(projection.details.paths).toEqual(projection.payload.results.map((result) => result.path));
		expect(projection.details.truncated).toBe(projection.payload.truncated);
	}
});
