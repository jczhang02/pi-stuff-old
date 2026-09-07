import { expect, test } from "bun:test";
import {
	apiHarness,
	assistant,
	bashCall,
	call,
	getToolUiRuntime,
	Params,
	registerSuiteOwnedTool,
	renderContext,
	renderLines,
	resetCapabilitiesCache,
	result,
	setCapabilities,
	settle,
	type ToolDefinition,
	ToolUiRuntime,
	theme,
	toolFromHarness,
} from "../../tools/contract-fixtures.js";

test("Bash stays a standalone Operation Block beside a Retrieval Group", () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const bash = toolFromHarness(harness, "bash", "run-command");
	const runtime = getToolUiRuntime(harness.api);
	const command = "cat a.ts";
	runtime.indexMessages(
		[assistant(call("r1", "read", "a.ts"), bashCall("b1", command)), result("r1"), result("b1", "contents")],
		true,
	);

	const compactRead = settle(read, "r1", "a.ts");
	const compactBash = settle(bash, "b1", command, false, false, "contents");
	expect(compactRead.callLines.join("\n")).toContain("Read 1 file");
	expect(compactBash.callLines).toEqual([" • Bash(cat a.ts)", "  ⎿  contents"]);

	const expandedRead = settle(read, "r1", "a.ts", false, true);
	const expandedBash = settle(bash, "b1", command, false, true, "contents");
	expect(expandedRead.callLines.join("\n")).toContain("read-file");
	expect(expandedBash.callLines).toEqual([" • Bash(cat a.ts)", "  ⎿  contents"]);
});

test("native Read deduplicates paths while Search and List count invocations", () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const grep = toolFromHarness(harness, "grep", "search-pattern");
	const list = toolFromHarness(harness, "ls", "list-directory");
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages(
		[
			assistant(
				call("r1", "read", "./a.ts"),
				call("r2", "read", "/project/a.ts"),
				call("g1", "grep", "needle"),
				call("g2", "grep", "needle"),
				call("l1", "ls", "."),
				call("l2", "ls", "."),
			),
			...["r1", "r2", "g1", "g2", "l1", "l2"].map((id) => result(id)),
		],
		true,
	);
	const leader = settle(read, "r1", "./a.ts");
	settle(read, "r2", "/project/a.ts");
	settle(grep, "g1", "needle");
	settle(grep, "g2", "needle");
	settle(list, "l1", ".");
	settle(list, "l2", ".");
	expect(renderLines(leader.callComponent).join("\n")).toContain(
		"Searched 2 patterns, read 1 file, listed 2 directories",
	);
});

test("compact projection hides text bodies and explains unavailable image previews", () => {
	setCapabilities({ hyperlinks: false, images: null, trueColor: false });
	try {
		const harness = apiHarness();
		const tool = toolFromHarness(harness, "view", "read-file");
		const runtime = getToolUiRuntime(harness.api);
		runtime.indexMessages([assistant(call("v1", "view", "pixel.png"))], true);
		const state = {};
		const args = { value: "pixel.png" };
		const context = renderContext(state, args, { toolCallId: "v1" });
		const component = tool.renderCall?.(args, theme, context);
		if (!component) throw new Error("missing media call component");
		const body = tool.renderResult?.(
			{
				content: [
					{ type: "text", text: "hidden text" },
					{
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
						mimeType: "image/png",
					},
				],
				details: { source: "pixel.png" },
			},
			{ expanded: false, isPartial: false },
			theme,
			{ ...context, lastComponent: component },
		);
		const wide = body?.render(80) ?? [];
		const narrow = body?.render(24) ?? [];
		expect(wide).toHaveLength(1);
		expect(wide[0]?.trimEnd()).toBe("   Image preview unavailable · PNG · 1×1");
		expect(wide.join("\n")).not.toContain("[Image:");
		expect(wide.join("\n")).not.toContain("hidden text");
		expect(narrow.length).toBeGreaterThan(1);
		expect(narrow.every((line) => line.startsWith("   "))).toBe(true);
	} finally {
		resetCapabilitiesCache();
	}
});

test("compact projection distinguishes user-hidden image previews", () => {
	setCapabilities({ hyperlinks: false, images: null, trueColor: false });
	try {
		const harness = apiHarness();
		const tool = toolFromHarness(harness, "view", "view-image");
		getToolUiRuntime(harness.api).indexMessages([assistant(call("v1", "view", "pixel.png"))], true);
		const state = {};
		const args = { value: "pixel.png" };
		const context = renderContext(state, args, { showImages: false, toolCallId: "v1" });
		const component = tool.renderCall?.(args, theme, context);
		if (!component) throw new Error("missing hidden media call component");
		const body = tool.renderResult?.(
			{
				content: [
					{
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
						mimeType: "image/png",
					},
				],
				details: { source: "pixel.png" },
			},
			{ expanded: false, isPartial: false },
			theme,
			{ ...context, lastComponent: component },
		);
		expect(body?.render(80)[0]?.trimEnd()).toBe("   Image preview hidden · PNG · 1×1");
	} finally {
		resetCapabilitiesCache();
	}
});

test("unavailable image fallbacks retain media order", () => {
	setCapabilities({ hyperlinks: false, images: null, trueColor: false });
	try {
		const harness = apiHarness();
		const tool = toolFromHarness(harness, "view", "view-image");
		getToolUiRuntime(harness.api).indexMessages([assistant(call("v1", "view", "media"))], true);
		const state = {};
		const args = { value: "media" };
		const context = renderContext(state, args, { toolCallId: "v1" });
		const component = tool.renderCall?.(args, theme, context);
		if (!component) throw new Error("missing multi-media call component");
		const body = tool.renderResult?.(
			{
				content: [
					{
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
						mimeType: "image/png",
					},
					{
						type: "image",
						data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
						mimeType: "image/gif",
					},
				],
				details: { source: "media" },
			},
			{ expanded: false, isPartial: false },
			theme,
			{ ...context, lastComponent: component },
		);
		const visible = (body?.render(80) ?? []).map((line) => line.trimEnd()).filter(Boolean);
		expect(visible).toEqual(["   Image preview unavailable · PNG · 1×1", "   Image preview unavailable · GIF · 1×1"]);
	} finally {
		resetCapabilitiesCache();
	}
});

test("standalone Bash failures retain their own command and root cause", () => {
	const harness = apiHarness();
	const command = toolFromHarness(harness, "bash", "run-command");
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages(
		[
			assistant(call("b1", "bash", "typecheck"), call("b2", "bash", "tests")),
			result("b1", "FIRST FAILED", true),
			result("b2", "SECOND FAILED", true),
		],
		true,
	);
	const first = settle(command, "b1", "typecheck", true);
	const second = settle(command, "b2", "tests", true);
	const output = renderLines(first.callComponent).join("\n");
	expect(output).toContain("Bash(typecheck)");
	expect(output).toContain("FIRST FAILED");
	expect(second.callLines.join("\n")).toContain("Bash(tests)");
	expect(second.callLines.join("\n")).toContain("SECOND FAILED");
});

test("standalone Bash issue rows preserve chronological order across issue kinds", () => {
	const harness = apiHarness();
	const command = toolFromHarness(harness, "bash", "run-command");
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages(
		[
			assistant(call("b1", "bash", "cancelled"), call("b2", "bash", "failed")),
			result("b1", "command was cancelled", true),
			result("b2", "LATER FAILED", true),
		],
		true,
	);
	const first = settle(command, "b1", "cancelled", true, false, "command was cancelled");
	const second = settle(command, "b2", "failed", true, false, "LATER FAILED");
	const output = renderLines(first.callComponent).join("\n");
	expect(output).toContain("Bash(cancelled)");
	expect(output).toContain("command was cancelled");
	expect(second.callLines.join("\n")).toContain("Bash(failed)");
	expect(second.callLines.join("\n")).toContain("LATER FAILED");
});

test("failed mutations never produce successful change clauses", () => {
	const harness = apiHarness();
	const mutation = toolFromHarness(harness, "edit", "change-file");
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages([assistant(call("e1", "edit", "broken.ts")), result("e1", "EDIT FAILED", true)], true);
	const output = settle(mutation, "e1", "broken.ts", true).callLines.join("\n");
	expect(output).toContain("Error: EDIT FAILED");
	expect(output).not.toContain("Changed");
});

test("retrieval group failures remain historical after later successes", () => {
	const project = (category: "read-file", firstValue: string, secondValue: string, secondError = false) => {
		const harness = apiHarness();
		const tool = toolFromHarness(harness, "read", category);
		const runtime = getToolUiRuntime(harness.api);
		const messages = [
			assistant(call("first", tool.name, firstValue), call("second", tool.name, secondValue)),
			result("first", "FIRST FAILED", true),
			result("second", secondError ? "SECOND FAILED" : "MODEL_VISIBLE", secondError),
		];
		runtime.indexMessages(messages, true);
		settle(tool, "first", firstValue, true, false, "FIRST FAILED");
		settle(tool, "second", secondValue, secondError, false, secondError ? "SECOND FAILED" : "MODEL_VISIBLE");
		return { messages, runtime, tool };
	};

	const retry = project("read-file", "same.ts", "same.ts");
	expect(retry.runtime.resolveGroup("first")).toMatchObject({
		state: "warning",
		summary: expect.stringContaining("1 failed"),
	});

	const effect = project("read-file", "./a.ts", "/project/a.ts");
	expect(effect.runtime.resolveGroup("first")).toMatchObject({
		state: "warning",
		summary: expect.stringContaining("1 failed"),
	});

	const unknown = project("read-file", "a.ts", "b.ts");
	expect(unknown.runtime.resolveGroup("first")).toMatchObject({
		state: "warning",
		summary: expect.stringContaining("1 failed"),
	});

	const failed = project("read-file", "a.ts", "b.ts", true);
	expect(failed.runtime.resolveGroup("first")).toMatchObject({
		state: "error",
		summary: expect.stringContaining("2 failed"),
	});
});

test("folded retrieval exposes failed, rejected, and cancelled calls plus the first reason", () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages(
		[
			assistant(
				call("ok", "read", "ok.ts"),
				call("failed", "read", "failed.ts"),
				call("rejected", "read", "blocked.ts"),
				call("cancelled", "read", "cancelled.ts"),
			),
			result("ok"),
			result("failed", "FIRST REASON\nstack", true),
			result("rejected", "Tool execution was blocked by policy", true),
			result("cancelled", "Operation was cancelled", true),
		],
		true,
	);
	const leader = settle(read, "ok", "ok.ts");
	settle(read, "failed", "failed.ts", true, false, "FIRST REASON\nstack");
	settle(read, "rejected", "blocked.ts", true, false, "Tool execution was blocked by policy");
	settle(read, "cancelled", "cancelled.ts", true, false, "Operation was cancelled");
	const compact = renderLines(leader.callComponent).join("\n");
	expect(compact).toContain("1 failed, 1 rejected, 1 cancelled");
	expect(compact).toContain("FIRST REASON");
	const narrow = renderLines(leader.callComponent, 32);
	expect(narrow).toHaveLength(2);
	expect(narrow[0]).toContain("failed");
	expect(narrow[1]).toContain("FIRST REASON");
	expect(runtime.resolveGroup("ok")).toMatchObject({ state: "warning" });
});

test("successful infrastructure-only groups disappear but expand normally", () => {
	const harness = apiHarness();
	const original: ToolDefinition<typeof Params, { source: string }> = {
		description: "internal",
		execute: async () => ({
			content: [{ type: "text", text: "done" }],
			details: { source: "internal" },
		}),
		label: "ctx_reduce",
		name: "ctx_reduce",
		parameters: Params,
	};
	registerSuiteOwnedTool(harness.api, original, {
		activity: { categories: [], classify: () => [], silentSuccess: true },
		label: "ctx_reduce",
		summarize: () => "done",
	});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const tool = harness.tools.get("ctx_reduce") as ToolDefinition<typeof Params, { source: string }>;
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages([assistant(call("i1", "ctx_reduce", "context")), result("i1")], true);
	expect(settle(tool, "i1", "context").callLines).toEqual([]);
	expect(settle(tool, "i1", "context", false, true).callLines.join("\n")).toContain("ctx_reduce");
	const [details] = runtime.listGroups();
	expect(details?.summary).toBe("Internal activity");
	expect(details ? runtime.groupActivities(details.id) : []).toHaveLength(1);
});

test("failed infrastructure-only groups use the protocol fallback label", () => {
	const harness = apiHarness();
	const original: ToolDefinition<typeof Params, { source: string }> = {
		description: "internal",
		execute: async () => ({
			content: [{ type: "text", text: "done" }],
			details: { source: "internal" },
		}),
		label: "ctx_reduce",
		name: "ctx_reduce",
		parameters: Params,
	};
	registerSuiteOwnedTool(harness.api, original, {
		activity: { categories: [], classify: () => [], silentSuccess: true },
		label: "ctx_reduce",
		summarize: () => "failed",
	});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const tool = harness.tools.get("ctx_reduce") as ToolDefinition<typeof Params, { source: string }>;
	const runtime = getToolUiRuntime(harness.api);
	runtime.indexMessages(
		[assistant(call("i1", "ctx_reduce", "context")), result("i1", "reduction failed", true)],
		true,
	);
	const output = settle(tool, "i1", "context", true, false, "reduction failed").callLines.join("\n");
	expect(output).toContain("Internal operation failed");
	expect(output).not.toContain("ctx_reduce failed");
	expect(runtime.resolveGroup("i1")).toMatchObject({ state: "error", summary: "Internal operation failed" });
});

test("a live infrastructure issue splits retrieval on both sides", () => {
	const harness = apiHarness();
	const read = toolFromHarness(harness, "read", "read-file");
	const infrastructure = toolFromHarness(harness, "ctx_reduce", "search-pattern");
	const runtime = getToolUiRuntime(harness.api);
	runtime.startTurn([
		assistant(call("r1", "read", "a.ts"), call("i1", "ctx_reduce", "context"), call("r2", "read", "b.ts")),
	]);
	read.renderCall?.({ value: "a.ts" }, theme, renderContext({}, { value: "a.ts" }, { toolCallId: "r1" }));
	infrastructure.renderCall?.(
		{ value: "context" },
		theme,
		renderContext({}, { value: "context" }, { toolCallId: "i1" }),
	);
	read.renderCall?.({ value: "b.ts" }, theme, renderContext({}, { value: "b.ts" }, { toolCallId: "r2" }));
	settle(infrastructure, "i1", "context", true, false, "reduction failed");
	runtime.indexMessage(result("i1", "reduction failed", true));

	expect(runtime.resolveGroup("r1")).toMatchObject({ memberIds: ["r1"] });
	expect(runtime.resolveGroup("i1")).toMatchObject({ memberIds: ["i1"], state: "error" });
	expect(runtime.resolveGroup("r2")).toMatchObject({ memberIds: ["r2"] });
});

test("oversized retrieval history stays ordered across bounded continued pages", () => {
	const runtime = new ToolUiRuntime();
	runtime.registerActivity<Params, unknown>("read", {
		categories: ["read-file"],
		classify: ({ args }) => [{ category: "read-file", countKeys: [String(args["value"])] }],
	});
	runtime.markRendererAttached("read");
	const content = Array.from({ length: 130 }, (_, index) =>
		call(`read-${String(index)}`, "read", `${String(index)}.ts`),
	);
	const results = Array.from({ length: 130 }, (_, index) => result(`read-${String(index)}`));
	runtime.resetProjection([assistant(...content.slice(4)), ...results]);
	runtime.configureHistoryLoader(() => ({ hasOlder: false, messages: [assistant(...content.slice(0, 4))] }), true);

	const current = [...runtime.listGroups()].reverse();
	expect(current.map((group) => group.memberIds.length)).toEqual([64, 62]);
	expect(current[0]?.summary).toContain("continues");
	expect(current[1]?.summary).toContain("Continued");
	const older = runtime.loadOlderActivities();
	expect(older).toHaveLength(1);
	expect(older[0]?.memberIds).toEqual(["read-0", "read-1", "read-2", "read-3"]);
	expect(older[0]?.state).toBe("success");
	expect(older[0]?.summary).toContain("continues");
	expect([...older, ...current].flatMap((group) => group.memberIds)).toEqual(
		Array.from({ length: 130 }, (_, index) => `read-${String(index)}`),
	);
});

test("history pages do not claim continuation across a visible boundary", () => {
	for (const [currentMessages, olderMessages] of [
		[
			[{ content: "next", role: "user" }, assistant(call("read-2", "read", "2.ts"))],
			[assistant(call("read-1", "read", "1.ts"))],
		],
		[
			[assistant(call("read-2", "read", "2.ts"))],
			[assistant(call("read-1", "read", "1.ts")), { content: "done", role: "user" }],
		],
	] as const) {
		const runtime = new ToolUiRuntime();
		runtime.registerActivity<Params, unknown>("read", {
			categories: ["read-file"],
			classify: ({ args }) => [{ category: "read-file", countKeys: [String(args["value"])] }],
		});
		runtime.markRendererAttached("read");
		runtime.resetProjection(currentMessages);
		runtime.configureHistoryLoader(() => ({ hasOlder: false, messages: olderMessages }), true);

		const current = runtime.listGroups().at(-1);
		const older = runtime.loadOlderActivities().at(-1);
		expect(current?.summary).not.toContain("Continued");
		expect(older?.summary).not.toContain("continues");
	}
});
