import { expect, test } from "bun:test";
import {
	type AgentToolResult,
	apiHarness,
	assistant,
	createEditToolDefinition,
	createSuiteToolRegistrationTracker,
	decodeCodeModeOperations,
	getToolUiRuntime,
	initTheme,
	isRuntimeObject,
	isRuntimeString,
	registerCodexTools,
	registerSuiteOwnedTool,
	registerSuiteToolEnvelope,
	renderContext,
	SuiteCodeModeConnector,
	type SuiteToolEnvelopeOperation,
	Type,
	theme,
	toolFromHarness,
} from "../../tools/contract-fixtures.js";

test("certified Pi Edit compatibility inputs stay canonical through Code Mode execution and replay", async () => {
	initTheme("dark");
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	let fileContent = "before\n";
	const executedArguments: unknown[] = [];
	const presentedArguments: unknown[] = [];
	const upstream = createEditToolDefinition("/project", {
		operations: {
			access: async () => {},
			readFile: async () => Buffer.from(fileContent),
			writeFile: async (_path, content) => {
				fileContent = content;
			},
		},
	});
	const execute = upstream.execute.bind(upstream);
	const edit = {
		...upstream,
		execute: async (...args: Parameters<typeof upstream.execute>) => {
			executedArguments.push(structuredClone(args[1]));
			return execute(...args);
		},
	};
	registerSuiteOwnedTool(registrations.api, edit, {
		activity: {
			categories: ["change-file"],
			classify: ({ args }) => [
				{ category: "change-file", countKeys: [String(args.path)], target: String(args.path) },
			],
		},
		label: "Edit",
		runningSummary: "editing",
		summarize: () => "edited",
		target: (args) => {
			presentedArguments.push(structuredClone(args));
			return String(args.path);
		},
	});
	const nestedEdit = new SuiteCodeModeConnector(registrations.registry).tools().find((tool) => tool.name === "edit");
	if (!nestedEdit) throw new Error("missing upstream Edit Tool");
	let latestResult: AgentToolResult<unknown> | undefined;
	const compatibilityInputs = [
		{ newText: "after", oldText: "before", path: "fixture.txt" },
		{ edits: { newText: "after", oldText: "before" }, path: "fixture.txt" },
	];
	for (const [index, input] of compatibilityInputs.entries()) {
		fileContent = "before\n";
		await nestedEdit.invoke(
			input,
			{
				captureResult: (result) => {
					latestResult = result;
				},
				cwd: "/project",
				// SAFETY: this test fixture implements the exact Host context used by nested Tool execution.
				extensionContext: { cwd: "/project" } as never,
				toolCallId: `nested-edit-${String(index)}`,
			},
			new AbortController().signal,
		);
		expect(fileContent).toBe("after\n");
	}
	const canonical = { edits: [{ newText: "after", oldText: "before" }], path: "fixture.txt" };
	expect(executedArguments).toEqual([canonical, canonical]);

	const operation: SuiteToolEnvelopeOperation = {
		args: compatibilityInputs[1] ?? {},
		id: "nested-edit-replay",
		name: "edit",
		result: latestResult ?? { content: [], details: {} },
		state: "success",
	};
	registerSuiteToolEnvelope(
		registrations.api,
		{
			description: "Code Mode",
			execute: async () => ({ content: [], details: { operations: [operation] } }),
			label: "Code Mode",
			name: "codemode",
			parameters: Type.Object({ code: Type.String() }),
		},
		{ decode: () => [operation], registry: registrations.registry },
	);
	const envelope = harness.tools.get("codemode");
	if (!envelope) throw new Error("missing Code Mode envelope");
	const context = renderContext({}, { value: "unused" }, { toolCallId: "outer-edit-replay" });
	// SAFETY: this test controls the envelope arguments and the Host renderer context.
	const callComponent = envelope.renderCall?.({ code: "edit" }, theme, context as never);
	const resultComponent = envelope.renderResult?.(
		{ content: [], details: { operations: [operation] } },
		{ expanded: false, isPartial: false },
		theme,
		// SAFETY: the controlled result and context satisfy the registered envelope renderer contract.
		{ ...context, lastComponent: callComponent } as never,
	);
	if (!resultComponent) throw new Error("missing Code Mode Edit replay result");
	expect(resultComponent.render(120).join("\n")).toContain("fixture.txt");
	expect(presentedArguments).toContainEqual(canonical);
});

test("a Code Mode envelope prepares Codex Tool aliases before rendering", () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	registerCodexTools(registrations.api);
	const patch = [
		"*** Begin Patch",
		"*** Update File: .apply-patch-demo.txt",
		"@@",
		"-before",
		"+after",
		"*** End Patch",
	].join("\n");
	const patchOperation: SuiteToolEnvelopeOperation = {
		args: { patch },
		id: "nested-patch",
		name: "apply_patch",
		result: {
			content: [{ type: "text", text: "Applied patch successfully. changed 1 file." }],
			details: {
				changedFiles: [".apply-patch-demo.txt"],
				createdFiles: [],
				deletedFiles: [],
				fuzz: 0,
				movedFiles: [],
			},
		},
		state: "success",
	};
	const viewOperation: SuiteToolEnvelopeOperation = {
		args: { file_path: "@preview.png" },
		id: "nested-view",
		name: "view_image",
		result: {
			content: [],
			details: { mimeType: "image/png", path: "preview.png" },
		},
		state: "success",
	};
	const operations = [patchOperation, viewOperation];
	const details = { kind: "pi-stuff-code-mode", operations };
	registerSuiteToolEnvelope(
		registrations.api,
		{
			description: "Code Mode",
			execute: async () => ({ content: [], details }),
			label: "Code Mode",
			name: "codemode",
			parameters: Type.Object({ code: Type.String() }),
		},
		{ decode: decodeCodeModeOperations, registry: registrations.registry },
	);
	const envelope = harness.tools.get("codemode");
	if (!envelope) throw new Error("missing Code Mode envelope");
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages(
		[
			assistant({ type: "toolCall", id: "outer-patch", name: "codemode", arguments: { code: "patch" } }),
			{
				content: [],
				details,
				role: "toolResult",
				toolCallId: "outer-patch",
			},
		],
		true,
	);
	const context = renderContext({}, { value: "unused" }, { toolCallId: "outer-patch" });
	// SAFETY: the test harness intentionally erases the registered envelope Tool's schema.
	const callComponent = envelope.renderCall?.({ code: "patch" }, theme, context as never);
	// SAFETY: the same harness context and result satisfy the registered envelope Tool contract.
	const resultComponent = envelope.renderResult?.(
		{ content: [], details },
		{ expanded: false, isPartial: false },
		theme,
		{ ...context, lastComponent: callComponent } as never,
	);
	if (!resultComponent) throw new Error("missing Code Mode patch result");

	const rendered = resultComponent.render(120).join("\n");
	expect(rendered).toContain("Patch(.apply-patch-demo.txt)");
	expect(rendered).toContain("+1/-1");
	expect(rendered).toContain("- before");
	expect(rendered).toContain("+ after");
	expect(rendered).toContain("View preview.png · loaded");
	expect(rendered).not.toContain("Applied patch successfully");
	const projected = runtime.projectMessages([
		assistant({ type: "toolCall", id: "outer-patch", name: "codemode", arguments: { code: "patch" } }),
		{ content: [], details, role: "toolResult", toolCallId: "outer-patch" },
	]);
	expect(JSON.stringify(projected)).toContain(`"arguments":{"input":${JSON.stringify(patch)}}`);
	const rawDetail = runtime.toolActivityDetail("nested-patch", "raw");
	if (!rawDetail) throw new Error("missing nested Patch raw detail");
	const rawLines = rawDetail.lines.join("\n");
	expect(rawLines).toContain('"patch":');
	expect(rawLines).not.toContain('"input":');
});

test("Code Mode cold resume keeps every nested operation behind Tool UI fallbacks", () => {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	toolFromHarness({ ...harness, api: registrations.api }, "bash", "run-command");
	registerCodexTools(registrations.api);
	toolFromHarness({ ...harness, api: registrations.api }, "fragile", "run-command");
	const fragile = registrations.registry.get("fragile");
	if (!fragile) throw new Error("missing fragile Tool");
	Object.assign(fragile, {
		renderCall: () => {
			throw new Error("renderer failed");
		},
	});
	const patch = [
		"*** Begin Patch",
		"*** Update File: .apply-patch-demo.txt",
		"@@",
		"-missing",
		"+replacement",
		"*** End Patch",
	].join("\n");
	const details = {
		kind: "pi-stuff-code-mode",
		operations: [
			{
				args: { command: "printf ok", value: "printf ok" },
				id: "nested-bash",
				name: "bash",
				result: { content: [{ type: "text", text: "ok" }] },
				state: "success",
			},
			{
				args: { patch },
				id: "nested-patch-error",
				name: "apply_patch",
				result: { content: [{ type: "text", text: "Failed to find expected lines" }], details: {} },
				state: "error",
			},
			{
				args: { value: "legacy" },
				id: "nested-legacy",
				name: "legacy_tool",
				result: { content: [{ type: "text", text: "legacy failure" }] },
				state: "error",
			},
			{
				args: { value: "fragile" },
				id: "nested-fragile",
				name: "fragile",
				result: { content: [{ type: "text", text: "renderer failure result" }] },
				state: "error",
			},
		],
	};
	expect(decodeCodeModeOperations(details)[0]?.result?.details).toBeUndefined();
	registerSuiteToolEnvelope(
		registrations.api,
		{
			description: "Code Mode",
			execute: async () => ({ content: [], details }),
			label: "Code Mode",
			name: "codemode",
			parameters: Type.Object({ code: Type.String() }),
		},
		{ decode: decodeCodeModeOperations, registry: registrations.registry },
	);
	const envelope = harness.tools.get("codemode");
	if (!envelope) throw new Error("missing Code Mode envelope");
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages(
		[
			assistant({ type: "toolCall", id: "outer-cold", name: "codemode", arguments: { code: "fixture" } }),
			{ content: [], details, isError: true, role: "toolResult", toolCallId: "outer-cold" },
		],
		true,
	);
	const context = renderContext({}, { value: "unused" }, { isError: true, toolCallId: "outer-cold" });
	// SAFETY: this test controls the envelope arguments and supplies the exact Pi renderer context used below.
	const callComponent = envelope.renderCall?.({ code: "fixture" }, theme, context as never);
	const resultComponent = envelope.renderResult?.(
		{ content: [], details },
		{ expanded: false, isPartial: false },
		theme,
		// SAFETY: this is the same controlled renderer context with only the prior component attached.
		{ ...context, lastComponent: callComponent } as never,
	);
	if (!resultComponent) throw new Error("missing cold-resume result");
	const rendered = resultComponent.render(120).join("\n");
	expect(rendered).toContain("Bash(printf ok)");
	expect(rendered).toContain("Patch(.apply-patch-demo.txt)");
	expect(rendered).toContain("Error: Failed to find expected lines");
	expect(rendered).toContain("legacy_tool · legacy failure");
	expect(rendered).toContain("fragile · renderer failure result");
	expect(rendered).not.toContain("Code Mode");
});

test("Code Mode owns a fallback Tool row when no nested issue represents its result", () => {
	for (const operations of [
		[],
		[
			{
				args: { value: "a.ts" },
				id: "nested-success",
				name: "read",
				result: { content: [{ type: "text", text: "ok" }] },
				state: "success",
			},
		],
	] as const) {
		const harness = apiHarness();
		const registrations = createSuiteToolRegistrationTracker(harness.api);
		toolFromHarness({ ...harness, api: registrations.api }, "read", "read-file");
		const details = { kind: "pi-stuff-code-mode", operations };
		registerSuiteToolEnvelope(
			registrations.api,
			{
				description: "Code Mode",
				execute: async () => ({ content: [], details }),
				label: "Code Mode",
				name: "codemode",
				parameters: Type.Object({ code: Type.String() }),
			},
			{ decode: decodeCodeModeOperations, registry: registrations.registry },
		);
		const envelope = harness.tools.get("codemode");
		if (!envelope) throw new Error("missing Code Mode envelope");
		const outerResult = {
			content: [{ type: "text" as const, text: "Validation failed: invalid arguments" }],
			details,
		};
		const runtime = getToolUiRuntime(harness.api);
		const sessionMessages = [
			assistant({ type: "toolCall", id: "outer-error", name: "codemode", arguments: { code: "fixture" } }),
			{ ...outerResult, isError: true, role: "toolResult", toolCallId: "outer-error" },
		];
		runtime.indexMessages(sessionMessages, true);
		const projected = runtime.projectMessages(sessionMessages);
		const projectedCalls = projected.flatMap((message) =>
			isRuntimeObject(message) && message !== null && "content" in message && Array.isArray(message.content)
				? message.content.filter(
						(block): block is { name: string } =>
							isRuntimeObject(block) && block !== null && "name" in block && isRuntimeString(block.name),
					)
				: [],
		);
		expect(projectedCalls.at(-1)?.name).toBe("codemode");
		// SAFETY: this test supplies the Code Mode argument shape consumed by the envelope renderer.
		const context = renderContext({}, { code: "fixture", value: "unused" } as never, {
			isError: true,
			toolCallId: "outer-error",
		});
		// SAFETY: this test controls the envelope arguments and supplies the exact Pi renderer context used below.
		const callComponent = envelope.renderCall?.({ code: "fixture" }, theme, context as never);
		// SAFETY: the controlled result and context satisfy the registered envelope renderer contract.
		const resultComponent = envelope.renderResult?.(outerResult, { expanded: false, isPartial: false }, theme, {
			...context,
			lastComponent: callComponent,
		} as never);
		if (!resultComponent) throw new Error("missing outer error result");
		const rendered = resultComponent.render(120).join("\n");
		expect(rendered).toContain("Code Mode(fixture)");
		expect(rendered).toContain("Error: Validation failed: invalid arguments");
		if (operations.length > 0) expect(rendered).toContain("Read 1 file");
	}
});

const CODE_MODE_FALLBACK_SCENARIOS = [
	{
		additional: [],
		content: [{ type: "text" as const, text: "computed 42" }],
		id: "outer-one-line",
		isError: false,
		rawExpected: "computed 42",
		summary: "computed 42",
	},
	{
		additional: ["units: items"],
		content: [{ type: "text" as const, text: "computed 42\nunits: items" }],
		id: "outer-multiline",
		isError: false,
		rawExpected: "computed 42",
		summary: "computed 42",
	},
	{
		additional: ["stack"],
		content: [{ type: "text" as const, text: "validation failed\nstack" }],
		id: "outer-error",
		isError: true,
		rawExpected: "validation failed",
		summary: "validation failed",
	},
	{
		additional: ["request 7"],
		content: [{ type: "text" as const, text: "Tool execution was blocked by policy\nrequest 7" }],
		id: "outer-rejected",
		isError: true,
		rawExpected: "Tool execution was blocked",
		summary: "Tool execution was blocked by policy",
	},
	{
		additional: ["cleanup complete"],
		content: [{ type: "text" as const, text: "Operation was cancelled\ncleanup complete" }],
		id: "outer-cancelled",
		isError: true,
		rawExpected: "Operation was cancelled",
		summary: "Operation was cancelled",
	},
	{
		additional: ["stack"],
		content: [{ type: "text" as const, text: "\u001B[31mError: colored failure\u001B[0m\nstack" }],
		id: "outer-sanitized",
		isError: true,
		rawExpected: "stack",
		summary: "colored failure",
	},
	{
		additional: [],
		content: [],
		id: "outer-empty",
		isError: false,
		rawExpected: "(no result content)",
		summary: "(no result content)",
	},
	{
		additional: [],
		content: [{ data: "AA==", mimeType: "image/png", type: "image" as const }],
		id: "outer-media",
		isError: false,
		rawExpected: "[image image/png]",
		summary: "[image image/png]",
	},
] as const;

test("Code Mode materializes only unmatched outer issues and keeps successful envelopes silent", () => {
	for (const scenario of CODE_MODE_FALLBACK_SCENARIOS) {
		const harness = apiHarness();
		const registrations = createSuiteToolRegistrationTracker(harness.api);
		const details = { kind: "pi-stuff-code-mode", operations: [] };
		registerSuiteToolEnvelope(
			registrations.api,
			{
				description: "Code Mode",
				execute: async () => ({ content: [], details }),
				label: "Code Mode",
				name: "codemode",
				parameters: Type.Object({ code: Type.String() }),
			},
			{ decode: decodeCodeModeOperations, registry: registrations.registry },
		);
		const envelope = harness.tools.get("codemode");
		if (!envelope) throw new Error("missing Code Mode envelope");
		const outerResult = { content: [...scenario.content], details };
		const messages = [
			assistant({
				type: "toolCall",
				id: scenario.id,
				name: "codemode",
				arguments: { code: 'text("computed")' },
			}),
			Object.assign(
				{ ...outerResult, role: "toolResult", toolCallId: scenario.id },
				scenario.isError ? { isError: true } : undefined,
			),
		];
		const runtime = getToolUiRuntime(harness.api);
		runtime.indexMessages(messages, true);
		// SAFETY: this fixture supplies the Code Mode argument shape consumed by the envelope renderer.
		const context = renderContext({}, { code: 'text("computed")', value: "unused" } as never, {
			expanded: true,
			isError: scenario.isError,
			toolCallId: scenario.id,
		});
		// SAFETY: this fixture controls the envelope arguments and complete Host renderer context.
		const callComponent = envelope.renderCall?.({ code: 'text("computed")' }, theme, context as never);
		// SAFETY: the controlled result and context satisfy the same registered envelope renderer contract.
		const resultComponent = envelope.renderResult?.(outerResult, { expanded: true, isPartial: false }, theme, {
			...context,
			lastComponent: callComponent,
		} as never);
		if (!resultComponent) throw new Error("missing Code Mode fallback result");
		const rendered = resultComponent.render(120).join("\n");
		if (scenario.isError) {
			expect(rendered, scenario.id).toContain('Code Mode(text("computed"))');
			const prefix =
				scenario.id === "outer-rejected" ? "Rejected" : scenario.id === "outer-cancelled" ? "Cancelled" : "Error";
			expect(rendered, scenario.id).toContain(`${prefix}: ${scenario.summary}`);
		} else {
			expect(rendered, scenario.id).toBe("");
		}
		if (scenario.isError) {
			expect(runtime.toolActivityDetail(scenario.id, "formatted")?.sections?.[0]?.title, scenario.id).toBe("Code");
			expect(runtime.toolActivityDetail(scenario.id, "formatted")?.lines.join("\n"), scenario.id).toContain(
				scenario.summary,
			);
			expect(runtime.toolActivityDetail(scenario.id, "raw")?.lines.join("\n"), scenario.id).toContain(
				scenario.rawExpected,
			);
		} else {
			expect(runtime.toolActivityDetail(scenario.id, "formatted"), scenario.id).toBeUndefined();
			expect(runtime.toolActivityDetail(scenario.id, "raw"), scenario.id).toBeUndefined();
		}
	}
});
