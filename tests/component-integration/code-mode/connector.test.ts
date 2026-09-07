import { expect, test } from "bun:test";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describeTarget } from "../../../packages/pi-stuff/src/code-mode/cloudflare/describe.js";
import {
	buildSuiteSandboxSource,
	SuiteCodeModeConnector,
	unwrapSuiteToolResult,
} from "../../../packages/pi-stuff/src/code-mode/connector.js";
import {
	CODE_MODE_SEARCH_PRESENTATION,
	createCodeModeDefinition,
	createCodeModeSearchDefinition,
} from "../../../packages/pi-stuff/src/code-mode/extension.js";
import { INVALID_CODE_MODE_IMAGE_MESSAGE } from "../../../packages/pi-stuff/src/code-mode/image-content.js";
import type { CodeModeRuntime } from "../../../packages/pi-stuff/src/code-mode/runtime.js";
import type { SuiteToolDefinitionRegistry } from "../../../packages/pi-stuff/src/tool-display/contract.js";
import { registryFixture } from "../../code-mode/fixtures.js";

test("the compact Tool contract describes canonical unwrapped Read results", () => {
	// SAFETY: this test controls the value and supplies every CodeModeRuntime member exercised by this case.
	const definition = createCodeModeDefinition({} as CodeModeRuntime);
	expect(definition.description).toContain("top-level await");
	expect(definition.description).toContain("await every tools.* call");
	expect(definition.description).toContain("Call only listed/searched methods");
	expect(definition.description).toContain("After context compaction");
	expect(definition.description).toContain("never guess");
	expect(definition.description).toContain(
		'const pkg = await tools.read({ path: "package.json" }); text(pkg.packageManager);',
	);
	expect(definition.description).toContain("do not pass them to JSON.parse");
	expect(definition.description).not.toContain("tools.bash");
	expect(definition.description).toContain("console is unavailable");
	expect(definition.description).toContain("Do not pass image Base64");
	expect(definition.description).toContain("async arrow functions with return");
	expect(definition.description).toContain("tools.monitor");
	expect(definition.description).toContain("command, file, log, or HTTP");
	expect(definition.description).toContain("do not poll");
	expect(definition.description).not.toContain("yield_control");
	expect(definition.description).not.toContain("codemode.resultText");
	expect(definition.description).not.toContain("codemode.emitText");
});

test("the Connector exposes every active Suite Tool without a per-Tool caller contract", async () => {
	const registry = registryFixture();
	const connector = new SuiteCodeModeConnector(registry);
	const tools = connector.tools();
	expect(tools.map((tool) => tool.name)).toEqual(["read", "write"]);
	expect(connector.search("inactive fixture").results).toEqual([]);
	expect(connector.describe("tools.hidden").types).toBe('"tools.hidden" not found.');
	expect(tools[0]?.inputSchema).toEqual(registry.get("read")?.parameters);

	let captured: AgentToolResult<unknown> | undefined;
	const value = await tools[0]?.invoke(
		{ path: "README.md", limit: 1 },
		{
			captureResult: (result) => {
				captured = result;
			},
			cwd: "/project",
			// SAFETY: this test fixture implements the exact Host surface exercised by this case.
			extensionContext: { cwd: "/project" } as ExtensionContext,
			onUpdate: () => {},
			toolCallId: "nested-read",
		},
		new AbortController().signal,
	);
	expect(value).toBe("first line");
	expect(captured?.content).toEqual([{ type: "text", text: "first line" }]);
	expect(registry.invocations[0]).toMatchObject({
		input: { path: "README.md", limit: 1 },
		name: "read",
		toolCallId: "nested-read",
	});
});

test("the Connector rejects explicit nested Tool errors", async () => {
	const base = registryFixture();
	const registry: SuiteToolDefinitionRegistry = {
		...base,
		invoke: async () => ({
			isError: true,
			result: {
				content: [{ type: "text", text: "nested failure" }],
				details: {},
				isError: true,
			},
		}),
	};
	const tool = new SuiteCodeModeConnector(registry).tools().find(({ name }) => name === "read");
	if (!tool) throw new Error("missing read Tool");
	await expect(
		tool.invoke(
			{ path: "missing.txt" },
			{
				cwd: "/project",
				// SAFETY: this test fixture implements the exact Host surface exercised by this case.
				extensionContext: { cwd: "/project" } as ExtensionContext,
				toolCallId: "nested-failure",
			},
			new AbortController().signal,
		),
	).rejects.toThrow("nested failure");
});

test("Tool Discovery keeps deterministic lexical matches without unrelated fallbacks", () => {
	const connector = new SuiteCodeModeConnector(registryFixture());
	const query = "please inspect the repository and read the requested file after checking all relevant context";

	expect(connector.search(query).results[0]?.path).toBe("tools.read");
	expect(connector.search("reader").results[0]?.path).toBe("tools.read");
	expect(connector.search("unrelated vocabulary only").results).toEqual([]);
	expect(connector.search(query)).toEqual(connector.search(query));
});

test.each([
	["tools", "tools.task-create", 'tools["task-create"]', "tools"],
	["my-tools", "my-tools.task-create", 'globalThis["my-tools"]["task-create"]', 'globalThis["my-tools"]'],
])("Tool descriptions round-trip executable paths for connector %s", (name, target, path, ownerPath) => {
	const descriptions = [
		{
			descriptors: {
				"task-create": {
					description: "Create a task",
					inputSchema: Type.Object({ description: Type.String() }),
				},
			},
			name,
		},
	];
	const canonical = describeTarget(target, descriptions);
	expect(canonical.path).toBe(path);
	expect(describeTarget(path, descriptions)).toEqual(canonical);
	expect(describeTarget(name, descriptions).path).toBe(ownerPath);
});

test("the Connector quarantines every invalid nested image before capture", async () => {
	type CompatibilityResult = AgentToolResult<unknown> & {
		structuredContent?: unknown;
		toolResult?: unknown;
	};
	const malformed = Buffer.alloc(96, 1).toString("base64");
	const complete = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQAAAAA3bvkkAAAACklEQVQI12NoAAAAggCB3UNq9AAAAABJRU5ErkJggg==";
	const corruptBytes = Buffer.from(complete, "base64");
	corruptBytes[45] = (corruptBytes[45] ?? 0) ^ 0xff;
	const corrupt = corruptBytes.toString("base64");
	const unsupported = Buffer.from("<svg/>").toString("base64");
	const sparse = Array<AgentToolResult<unknown>["content"][number]>(2);
	sparse[1] = { type: "image", data: complete, mimeType: "image/png" };
	const fixtures: { rejectedData: string; result: CompatibilityResult }[] = [
		{
			rejectedData: malformed,
			result: { content: [{ type: "image", data: malformed, mimeType: "image/jpeg" }], details: {} },
		},
		{
			rejectedData: corrupt,
			result: { content: [{ type: "image", data: corrupt, mimeType: "image/png" }], details: {} },
		},
		{
			rejectedData: unsupported,
			result: { content: [{ type: "image", data: unsupported, mimeType: "image/svg+xml" }], details: {} },
		},
		{
			rejectedData: malformed,
			result: {
				content: [],
				details: {},
				structuredContent: { content: [{ type: "image", data: malformed, mimeType: "image/jpeg" }] },
			},
		},
		{
			rejectedData: malformed,
			result: {
				content: [],
				details: {},
				toolResult: { content: [{ type: "image", data: malformed, mimeType: "image/jpeg" }] },
			},
		},
		{
			rejectedData: malformed,
			result: {
				content: [],
				details: {},
				structuredContent: { content: [{ type: "image", data: malformed, mimeType: "image/jpeg" }] },
				toolResult: { ok: true },
			},
		},
		{
			rejectedData: complete,
			result: { content: sparse, details: {}, toolResult: { ok: true } },
		},
	];
	for (const [index, fixture] of fixtures.entries()) {
		const base = registryFixture();
		const registry: SuiteToolDefinitionRegistry = {
			...base,
			invoke: async () => ({ isError: false, result: fixture.result }),
		};
		const tool = new SuiteCodeModeConnector(registry).tools().find(({ name }) => name === "read");
		if (!tool) throw new Error("missing read Tool");
		let captured: AgentToolResult<unknown> | undefined;
		await expect(
			tool.invoke(
				{ path: "bad.jpg" },
				{
					captureResult: (result) => {
						captured = result;
					},
					cwd: "/project",
					// SAFETY: this test fixture implements the exact Host surface exercised by this case.
					extensionContext: { cwd: "/project" } as ExtensionContext,
					toolCallId: `nested-bad-image-${String(index)}`,
				},
				new AbortController().signal,
			),
		).rejects.toThrow(INVALID_CODE_MODE_IMAGE_MESSAGE);
		expect(captured?.content).toEqual([{ type: "text", text: INVALID_CODE_MODE_IMAGE_MESSAGE }]);
		const persisted = JSON.stringify(captured);
		expect(persisted).not.toContain(fixture.rejectedData);
		expect(persisted).not.toContain("structuredContent");
		expect(persisted).not.toContain("toolResult");
	}
});

test("the Connector reads the current Tool description instead of caching its initial contract", () => {
	const registry = registryFixture();
	const definition = registry.get("read");
	if (!definition) throw new Error("missing read fixture");
	let description = "Initial Agent roster";
	Object.defineProperty(definition, "description", { get: () => description });
	const connector = new SuiteCodeModeConnector(registry);

	expect(connector.catalog().find((entry) => entry.name === "read")?.description).toBe("Initial Agent roster");
	description = "Current Agent roster";
	expect(connector.catalog().find((entry) => entry.name === "read")?.description).toBe("Current Agent roster");
});

test("top-level and in-program discovery share Cloudflare-ranked catalog data and typed describe output", async () => {
	const connector = new SuiteCodeModeConnector(registryFixture());
	const search = connector.search("read file");
	expect(search.results[0]).toMatchObject({ connector: "tools", method: "read", path: "tools.read" });
	expect(connector.describe("tools.read").types).toContain("type ReadInput");

	const definition = createCodeModeSearchDefinition(connector);
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const result = await definition.execute("search-1", { query: "read file" }, undefined, undefined, {
		cwd: "/project",
	} as ExtensionContext);
	const text = result.content[0]?.type === "text" ? result.content[0].text : "";
	// SAFETY: Tool Discovery produced this JSON from the asserted projection contract.
	const payload = JSON.parse(text) as {
		readonly definitions: readonly { readonly kind: string; readonly path: string }[];
		readonly results: readonly { readonly path: string; readonly signature: string }[];
	};
	expect(payload.definitions[0]).toMatchObject({ kind: "method", path: "tools.read" });
	expect(payload.results[0]).toMatchObject({
		path: "tools.read",
		signature: "tools.read(input: ReadInput): Promise<ReadOutput>",
	});
	expect(result.details).toEqual({
		paths: ["tools.read", "tools.write"],
		query: "read file",
		total: 2,
		truncated: false,
	});
	expect(CODE_MODE_SEARCH_PRESENTATION.summarize?.({ query: "read file" }, result, "success", undefined)).toBe(
		"2 matches",
	);
	expect(CODE_MODE_SEARCH_PRESENTATION.detailLines?.({ query: "read file" }, result, "success")).toEqual([
		"2 matches",
		"tools.read",
		"tools.write",
	]);
});

test("approval-required Tools cannot opt into reexecute replay", () => {
	const base = registryFixture();
	const registry: SuiteToolDefinitionRegistry = {
		...base,
		catalog: () =>
			base
				.catalog()
				.map((entry) =>
					entry.definition.name === "write"
						? { ...entry, codeMode: { replay: "reexecute" as const, requiresApproval: true } }
						: entry,
				),
	};
	expect(() => new SuiteCodeModeConnector(registry).catalog()).toThrow(
		'Code Mode Tool "write" cannot combine requiresApproval with replay: reexecute',
	);
});

test("result adaptation unwraps structured/text JSON and reports an actionable failing path", () => {
	expect(
		unwrapSuiteToolResult("fixture", {
			content: [{ type: "text", text: '{"ok":true}' }],
			details: {},
		}),
	).toEqual({ ok: true });
	expect(
		// SAFETY: this test controls the value and supplies every AgentToolResult member exercised by this case.
		unwrapSuiteToolResult("fixture", {
			content: [],
			details: {},
			structuredContent: { value: 3 },
		} as AgentToolResult<unknown>),
	).toEqual({ value: 3 });
	expect(() =>
		unwrapSuiteToolResult("fixture", {
			content: [{ type: "text", text: 7 }],
			details: {},
		}),
	).toThrow(
		'Code Mode Tool "fixture" returned an invalid result at result.content[0].text: expected a string; received number; retry safe: false',
	);
	interface CyclicResultFixture {
		self?: CyclicResultFixture;
	}
	const cyclic: CyclicResultFixture = {};
	cyclic.self = cyclic;
	expect(() => unwrapSuiteToolResult("fixture", { content: [], details: {}, structuredContent: cyclic })).toThrow(
		"result.structuredContent",
	);
	expect(() => unwrapSuiteToolResult("fixture", { content: [], details: {}, toolResult: new Date() })).toThrow(
		"result.toolResult",
	);
});

test("the local prelude provides canonical tools plus compatible suite/search/describe without entering model history", () => {
	const program = 'const pkg = await tools.read({ path: "package.json" }); text(pkg.packageManager);';
	const source = buildSuiteSandboxSource(program, [
		{
			description: "Read a file",
			inputSchema: Type.Object({ path: Type.String() }),
			name: "read",
			replay: "record",
		},
	]);
	expect(source).toContain("globalThis.suite=globalThis.tools");
	expect(source).toContain("globalThis.codemode=");
	expect(source).toContain("codemode.search");
	expect(source).toContain('const pkg = await tools.read({ path: "package.json" });');
	expect(source).toContain("return (text(pkg.packageManager))");
	expect(source).toContain("__piStuffOutputCount===0");
	expect(source).toContain("keys.length===1&&Object.hasOwn(value,__piStuffBigintTag)");
	expect(source).toContain("keys.length===2&&Object.hasOwn(value,__piStuffBinaryTag)");
	expect(source).toContain("Invalid Code Mode binary envelope");
});

test("the local catalog emits executable paths for non-identifier Tool names", () => {
	const source = buildSuiteSandboxSource("text((await codemode.describe('tools[\"task-create\"]')).types)", [
		{
			description: "Create a task",
			inputSchema: Type.Object({ description: Type.String() }),
			name: "task-create",
			replay: "record",
		},
	]);
	expect(source).toContain('"path":"tools[\\"task-create\\"]"');
	expect(source).toContain("globalThis.tools.__pi_stuff_codemode_describe_v1");
	expect(source).toContain("text((await codemode.describe('tools[\"task-create\"]')).types)");
});

test("the Cloudflare compatibility adapter invokes async-arrow input and emits a return only without explicit output", () => {
	const returned = buildSuiteSandboxSource("async () => { return { ok: true }; }", []);
	expect(returned).toContain("const __piStuffProgram=(async () => { return { ok: true }; });");
	expect(returned).toContain("const __piStuffResult=await __piStuffProgram();");
	expect(returned).toContain("if(__piStuffOutputCount===0&&__piStuffResult!==undefined)");

	const explicit = buildSuiteSandboxSource("text('done')", []);
	expect(explicit).toContain("return (text('done'))");
	expect(explicit).not.toContain("codemode.emitText");
});

test("the prelude exposes durable steps and saved snippets without a second model-facing dialect", () => {
	const source = buildSuiteSandboxSource(
		"text(await codemode.run('read-one', { path: 'README.md' }))",
		[],
		[
			{
				code: "async (input) => input.path",
				description: "Return one path",
				name: "read-one",
				savedAt: 1,
			},
		],
	);
	expect(source).toContain("codemode.run=async");
	expect(source).toContain("codemode.step=async");
	expect(source).toContain('["read-one",(async (input) => input.path)]');
});
