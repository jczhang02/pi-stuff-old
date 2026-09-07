import { expect, test } from "bun:test";
import {
	apiHarness,
	assistant,
	call,
	createSuiteToolRegistrationTracker,
	getToolUiRuntime,
	initTheme,
	Params,
	presentation,
	registerSuiteOwnedTool,
	registerSuiteToolEnvelope,
	renderContext,
	resetCapabilitiesCache,
	result,
	type SuiteToolEnvelopeOperation,
	setCapabilities,
	settle,
	type ToolDefinition,
	ToolExecutionComponent,
	Type,
	theme,
	toolFromHarness,
} from "../../tools/contract-fixtures.js";

test("formatted deduplication leaves custom Tool detail and generic success output untouched", () => {
	for (const scenario of [
		{
			detailLines: undefined,
			expectedDetail: ["same summary"],
			id: "custom-summary",
			isError: true,
			name: "custom_summary",
			summarize: () => "same summary",
			text: "same summary",
		},
		{
			detailLines: () => ["owned detail"],
			expectedDetail: ["owned detail"],
			id: "custom-detail",
			isError: true,
			name: "custom_detail",
			summarize: undefined,
			text: "failure line",
		},
		{
			detailLines: undefined,
			expectedDetail: ["successful output"],
			id: "generic-success",
			isError: false,
			name: "generic_success",
			summarize: undefined,
			text: "successful output",
		},
	] as const) {
		const harness = apiHarness();
		const fixturePresentation = {
			activity: presentation("change-file").activity,
			label: scenario.name,
			target: (args: Readonly<Params>) => args.value,
		};
		if (scenario.detailLines) Object.assign(fixturePresentation, { detailLines: scenario.detailLines });
		if (scenario.summarize) Object.assign(fixturePresentation, { summarize: scenario.summarize });
		registerSuiteOwnedTool(
			harness.api,
			{
				description: scenario.name,
				execute: async () => ({ content: [{ type: "text", text: scenario.text }], details: { source: "test" } }),
				label: scenario.name,
				name: scenario.name,
				parameters: Params,
			},
			fixturePresentation,
		);
		const tool = harness.tools.get(scenario.name);
		if (!tool) throw new Error(`missing ${scenario.name}`);
		const runtime = getToolUiRuntime(harness.api);
		runtime.indexMessages(
			[assistant(call(scenario.id, scenario.name, "fixture")), result(scenario.id, scenario.text, scenario.isError)],
			true,
		);
		// SAFETY: the test controls this fixture's Params schema and source detail result.
		const rendered = settle(
			tool as ToolDefinition<typeof Params, { source: string }>,
			scenario.id,
			"fixture",
			scenario.isError,
			true,
			scenario.text,
		);
		expect(rendered.resultLines.join("\n"), scenario.id).toContain(scenario.expectedDetail[0] ?? "");
		expect(runtime.toolActivityDetail(scenario.id, "formatted")?.lines, scenario.id).toEqual([
			...scenario.expectedDetail,
		]);
	}
});

test("Code Mode and direct Tools stay pixel-equivalent when expanded, failed, and reconstructed", () => {
	for (const scenario of [
		{ expanded: true, isError: false, label: "expanded success", resultText: "MODEL_VISIBLE", state: "success" },
		{ expanded: false, isError: true, label: "compact failure", resultText: "FAILED", state: "error" },
		{ expanded: true, isError: true, label: "expanded failure", resultText: "FAILED", state: "error" },
		{
			expanded: false,
			isError: true,
			label: "compact cancellation",
			resultText: "Operation aborted",
			state: "cancelled",
		},
		{
			expanded: false,
			isError: true,
			label: "compact rejection",
			resultText: "Tool execution was blocked: fixture",
			state: "rejected",
		},
	] as const) {
		const directHarness = apiHarness();
		const directRead = toolFromHarness(directHarness, "read", "read-file");
		const directRuntime = getToolUiRuntime(directHarness.api);
		directRuntime.indexMessages(
			[assistant(call("direct-read", "read", "a.ts")), result("direct-read", scenario.resultText, scenario.isError)],
			true,
		);
		const direct = settle(
			directRead,
			"direct-read",
			"a.ts",
			scenario.isError,
			scenario.expanded,
			scenario.resultText,
		);
		const directLines = [...direct.callLines, ...direct.resultLines];

		const envelopeHarness = apiHarness();
		const registrations = createSuiteToolRegistrationTracker(envelopeHarness.api);
		toolFromHarness({ ...envelopeHarness, api: registrations.api }, "read", "read-file");
		const operation: SuiteToolEnvelopeOperation = {
			args: { value: "a.ts" },
			id: "nested-read",
			name: "read",
			result: {
				content: [{ type: "text", text: scenario.resultText }],
				details: { source: "a.ts" },
			},
			state: scenario.state,
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
			{
				decode: () => [operation],
				registry: registrations.registry,
			},
		);
		const envelope = envelopeHarness.tools.get("codemode");
		if (!envelope) throw new Error("missing Code Mode envelope");
		getToolUiRuntime(envelopeHarness.api).indexMessages(
			[
				assistant({ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "read" } }),
				Object.assign(
					{
						role: "toolResult",
						toolCallId: "outer",
						content: [],
						details: { operations: [operation] },
					},
					scenario.isError ? { isError: true } : undefined,
				),
			],
			true,
		);
		const state = {};
		const context = renderContext(
			state,
			{ value: "unused" },
			{
				executionStarted: false,
				expanded: scenario.expanded,
				isError: scenario.isError,
				toolCallId: "outer",
			},
		);
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		const callComponent = envelope.renderCall?.({ code: "read" }, theme, context as never);
		const rendered = envelope.renderResult?.(
			{ content: [], details: { operations: [operation] } },
			{ expanded: scenario.expanded, isPartial: false },
			theme,
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			{ ...context, lastComponent: callComponent } as never,
		);
		if (!rendered) throw new Error(`missing ${scenario.label} envelope result`);
		expect(rendered.render(120), scenario.label).toEqual(directLines);
	}
});

test("Code Mode preserves the original Tool media projection without envelope chrome", () => {
	const image = {
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
		mimeType: "image/png",
		type: "image" as const,
	};
	const directHarness = apiHarness();
	const directView = toolFromHarness(directHarness, "view_image", "view-image");
	getToolUiRuntime(directHarness.api).indexMessages(
		[assistant(call("direct-media", "view_image", "pixel.png"))],
		true,
	);
	const directState = {};
	const directContext = renderContext(
		directState,
		{ value: "pixel.png" },
		{
			showImages: false,
			toolCallId: "direct-media",
		},
	);
	const directCall = directView.renderCall?.({ value: "pixel.png" }, theme, directContext);
	const directBody = directView.renderResult?.(
		{ content: [image], details: { source: "pixel.png" } },
		{ expanded: false, isPartial: false },
		theme,
		{ ...directContext, lastComponent: directCall },
	);
	if (!directCall || !directBody) throw new Error("missing direct media renderer");
	const direct = [...directCall.render(80), ...directBody.render(80)];
	expect(direct.join("\n")).toContain("Image preview hidden · PNG · 1×1");

	const envelopeHarness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(envelopeHarness.api);
	toolFromHarness({ ...envelopeHarness, api: registrations.api }, "view_image", "view-image");
	const operation: SuiteToolEnvelopeOperation = {
		args: { value: "pixel.png" },
		id: "nested-media",
		mediaPlacements: [{ afterContentIndex: 0, mediaIndex: 0 }],
		name: "view_image",
		result: { content: [], details: { source: "pixel.png" } },
		state: "success",
	};
	registerSuiteToolEnvelope(
		registrations.api,
		{
			description: "Code Mode",
			execute: async () => ({ content: [image], details: { operations: [operation] } }),
			label: "Code Mode",
			name: "codemode",
			parameters: Type.Object({ code: Type.String() }),
		},
		{ decode: () => [operation], registry: registrations.registry },
	);
	const envelope = envelopeHarness.tools.get("codemode");
	if (!envelope) throw new Error("missing media envelope");
	expect(getToolUiRuntime(registrations.api).isStandaloneInvocation("view_image", { value: "pixel.png" })).toBe(true);
	getToolUiRuntime(envelopeHarness.api).indexMessages(
		[
			assistant({ type: "toolCall", id: "outer-media", name: "codemode", arguments: { code: "view" } }),
			{
				role: "toolResult",
				toolCallId: "outer-media",
				content: [image],
				details: { operations: [operation] },
			},
		],
		true,
	);
	const envelopeContext = renderContext(
		{},
		{ value: "unused" },
		{
			showImages: false,
			toolCallId: "outer-media",
		},
	);
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const envelopeCall = envelope.renderCall?.({ code: "view" }, theme, envelopeContext as never);
	const envelopeBody = envelope.renderResult?.(
		{ content: [image], details: { operations: [operation] } },
		{ expanded: false, isPartial: false },
		theme,
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		{ ...envelopeContext, lastComponent: envelopeCall } as never,
	);
	if (!envelopeBody) throw new Error("missing envelope media renderer");
	expect(envelopeBody.render(80)).toEqual(direct);
});

test("Code Mode keeps multiple Kitty images inside their original expanded Tool rows", () => {
	const firstImage = {
		data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
		mimeType: "image/png",
		type: "image" as const,
	};
	const secondImage = { ...firstImage, data: `${firstImage.data.slice(0, -2)}I=` };
	setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
	try {
		const harness = apiHarness();
		const registrations = createSuiteToolRegistrationTracker(harness.api);
		toolFromHarness({ ...harness, api: registrations.api }, "view_image", "view-image");
		const operations: readonly SuiteToolEnvelopeOperation[] = [
			{
				args: { value: "first.png" },
				id: "nested-first",
				mediaPlacements: [{ afterContentIndex: 0, mediaIndex: 0 }],
				name: "view_image",
				result: { content: [], details: { source: "first.png" } },
				state: "success",
			},
			{
				args: { value: "second.png" },
				id: "nested-second",
				mediaPlacements: [{ afterContentIndex: 0, mediaIndex: 1 }],
				name: "view_image",
				result: { content: [], details: { source: "second.png" } },
				state: "success",
			},
		];
		registerSuiteToolEnvelope(
			registrations.api,
			{
				description: "Code Mode",
				execute: async () => ({ content: [], details: { operations } }),
				label: "Code Mode",
				name: "codemode",
				parameters: Type.Object({ code: Type.String() }),
			},
			{ decode: () => operations, media: () => [[firstImage], [secondImage]], registry: registrations.registry },
		);
		const envelope = harness.tools.get("codemode");
		if (!envelope) throw new Error("missing Kitty media envelope");
		getToolUiRuntime(harness.api).indexMessages(
			[
				assistant({ type: "toolCall", id: "outer-kitty", name: "codemode", arguments: { code: "view" } }),
				{
					role: "toolResult",
					toolCallId: "outer-kitty",
					content: [],
					details: { operations },
				},
			],
			true,
		);
		const context = renderContext(
			{},
			{ value: "unused" },
			{ expanded: true, showImages: true, toolCallId: "outer-kitty" },
		);
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		const callComponent = envelope.renderCall?.({ code: "view" }, theme, context as never);
		const body = envelope.renderResult?.(
			{ content: [], details: { operations } },
			{ expanded: true, isPartial: false },
			theme,
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			{ ...context, lastComponent: callComponent } as never,
		);
		if (!body) throw new Error("missing Kitty media body");
		const lines = body.render(100);
		const firstRow = lines.findIndex((line) => line.includes("first.png"));
		const secondRow = lines.findIndex((line) => line.includes("second.png"));
		const imageRows = lines.flatMap((line, index) => (line.includes("\u001b_G") ? [index] : []));
		expect(firstRow).toBeGreaterThanOrEqual(0);
		expect(secondRow).toBeGreaterThan(firstRow);
		expect(imageRows).toHaveLength(2);
		expect(firstRow).toBeLessThan(imageRows[0] ?? -1);
		expect(imageRows[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(secondRow);
		expect(secondRow).toBeLessThan(imageRows[1] ?? -1);
	} finally {
		resetCapabilitiesCache();
	}
});

const IMAGE_FIXTURE = {
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
	mimeType: "image/png",
	type: "image" as const,
};
const HOST_UI = { requestRender: () => {} };

function normalizeImageIds(lines: readonly string[]): string[] {
	return lines.map((line) => line.replaceAll(/([,;]i=)\d+/gu, "$1<image-id>"));
}

function directImageComponents(): ToolExecutionComponent[] {
	const harness = apiHarness();
	const view = toolFromHarness(harness, "view_image", "view-image");
	getToolUiRuntime(harness.api).indexMessages(
		[
			assistant(call("direct-first", "view_image", "first.png"), call("direct-second", "view_image", "second.png")),
			result("direct-first"),
			result("direct-second"),
		],
		true,
	);
	const components = [
		new ToolExecutionComponent(
			"view_image",
			"direct-first",
			{ value: "first.png" },
			{ showImages: true },
			view,
			// SAFETY: this test double implements the exact Pi members exercised by this case.
			HOST_UI as never,
			"/project",
		),
		new ToolExecutionComponent(
			"view_image",
			"direct-second",
			{ value: "second.png" },
			{ showImages: true },
			view,
			// SAFETY: this test double implements the exact Pi members exercised by this case.
			HOST_UI as never,
			"/project",
		),
	];
	for (const [index, component] of components.entries()) {
		component.setExpanded(true);
		component.setArgsComplete();
		component.markExecutionStarted();
		component.updateResult({
			content: [IMAGE_FIXTURE],
			details: { source: index === 0 ? "first.png" : "second.png" },
			isError: false,
		});
	}
	return components;
}

function codeModeImageComponent(): ToolExecutionComponent {
	const harness = apiHarness();
	const registrations = createSuiteToolRegistrationTracker(harness.api);
	toolFromHarness({ ...harness, api: registrations.api }, "view_image", "view-image");
	const operations: readonly SuiteToolEnvelopeOperation[] = [
		{
			args: { value: "first.png" },
			id: "nested-first",
			mediaPlacements: [{ afterContentIndex: 0, mediaIndex: 0 }],
			name: "view_image",
			result: { content: [], details: { source: "first.png" } },
			state: "success",
		},
		{
			args: { value: "second.png" },
			id: "nested-second",
			mediaPlacements: [{ afterContentIndex: 0, mediaIndex: 1 }],
			name: "view_image",
			result: { content: [], details: { source: "second.png" } },
			state: "success",
		},
	];
	const details = {
		kind: "pi-stuff-code-mode",
		mediaContentIndexes: [[0], [1]],
		modelContent: [IMAGE_FIXTURE, IMAGE_FIXTURE],
		operations,
		status: "success",
	};
	registerSuiteToolEnvelope(
		registrations.api,
		{
			description: "Code Mode",
			execute: async () => ({ content: [], details }),
			label: "Code Mode",
			name: "codemode",
			parameters: Type.Object({ code: Type.String() }),
		},
		{
			decode: () => operations,
			media: () => [[IMAGE_FIXTURE], [IMAGE_FIXTURE]],
			registry: registrations.registry,
		},
	);
	getToolUiRuntime(harness.api).indexMessages(
		[
			assistant({ type: "toolCall", id: "outer", name: "codemode", arguments: { code: "view" } }),
			{ content: [], details, role: "toolResult", toolCallId: "outer" },
		],
		true,
	);
	const envelope = harness.tools.get("codemode");
	if (!envelope) throw new Error("missing Code Mode envelope");
	const component = new ToolExecutionComponent(
		"codemode",
		"outer",
		{ code: "view" },
		{ showImages: true },
		envelope,
		// SAFETY: this test double implements the exact Pi members exercised by this case.
		HOST_UI as never,
		"/project",
	);
	component.setExpanded(true);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult({ content: [], details, isError: false });
	return component;
}

test("certified Pi Host renders expanded multi-image Tools identically through Code Mode", () => {
	initTheme("dark");
	setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
	try {
		const directLines = directImageComponents().flatMap((component) => component.render(100));
		expect(normalizeImageIds(codeModeImageComponent().render(100))).toEqual(normalizeImageIds(directLines));
	} finally {
		resetCapabilitiesCache();
	}
});
