import { expect, test } from "bun:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { type ToolActivityView, ToolUiRuntime } from "../../../packages/pi-stuff/src/tool-display/contract.js";
import { createToolDialogView } from "../../../packages/pi-stuff/src/tool-display/tool-dialog.js";
import { TestTui } from "../../fixtures/test-tui.js";

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	bold: (value: string) => value,
	fg: (_color: string, value: string) => value,
} as Theme;

interface ReadActivityArguments {
	readonly path?: unknown;
}

function contextHarness(rows = 28, activeTheme = theme, keybindings = new KeybindingsManager(TUI_KEYBINDINGS)) {
	let closed = 0;
	let renders = 0;
	const terminal = new TestTui(rows);
	return {
		closed: () => closed,
		context: {
			close: () => closed++,
			keybindings,
			requestRender: () => renders++,
			signal: new AbortController().signal,
			theme: activeTheme,
			tui: terminal,
		},
		renders: () => renders,
		terminal,
	};
}

function toolCall(id: string, path: string) {
	return { type: "toolCall", id, name: "read", arguments: { path } };
}

function toolResult(id: string, isError = false) {
	return Object.assign(
		{
			role: "toolResult",
			toolCallId: id,
			content: [{ type: "text", text: isError ? "missing" : "safe" }],
			details: {},
		},
		isError ? { isError: true } : undefined,
	);
}

function groupedRuntime(paths: readonly string[], errorIndex = -1, separate = false): ToolUiRuntime {
	const runtime = new ToolUiRuntime();
	runtime.registerActivity<ReadActivityArguments, unknown>("read", {
		categories: ["read-file"],
		classify: ({ args }) => [{ category: "read-file", countKeys: [String(args["path"])] }],
	});
	runtime.registerDetailPresentation("read", {
		detailLines: (args, result) => [
			`Path: ${String(args["path"] ?? "")}`,
			...result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])),
		],
		label: () => "Read",
		summary: (_args, _result, state) => (state === "success" ? "safe" : state),
		target: (args) => String(args["path"] ?? ""),
	});
	runtime.markRendererAttached("read");
	const calls = paths.map((path, index) => toolCall(`read-${String(index + 1)}`, path));
	const results = paths.map((_path, index) => toolResult(`read-${String(index + 1)}`, index === errorIndex));
	const content = separate
		? calls.flatMap((call, index) =>
				index === calls.length - 1 ? [call] : [call, { type: "text", text: `boundary ${String(index + 1)}` }],
			)
		: calls;
	runtime.indexMessages([{ role: "assistant", content }, ...results], true);
	for (const [index, path] of paths.entries()) {
		const id = `read-${String(index + 1)}`;
		runtime.activities.begin({ id, label: "Read", name: "read", target: path });
		runtime.activities.settle(id, {
			detailLines: [],
			durationMs: undefined,
			state: index === errorIndex ? "error" : "success",
			summary: index === errorIndex ? "missing" : "safe",
		});
	}
	return runtime;
}

test("/tools lists groups and formats only the selected member", () => {
	const runtime = groupedRuntime(["工具.txt", "src/config.ts"]);
	const harness = contextHarness();
	const component = createToolDialogView(runtime).create(harness.context);

	expect(component.render(60).join("\n")).toContain("2 calls");
	const list = component.render(42).join("\n");
	expect(list).toContain("Read · 2 files");
	expect(list).toContain("Enter details");
	component.handleInput?.("\r");
	let detail = component.render(42).join("\n");
	expect(detail).toContain("Tools / Read 2 files");
	expect(detail).toContain("Content");
	expect(detail).not.toContain("◆");
	expect(detail).not.toContain("formatted");
	expect(detail).not.toContain("Target:");
	expect(detail).not.toContain("Summary:");
	component.handleInput?.("\u001b[F");
	detail = component.render(42).join("\n");
	expect(detail).toContain("Path: 工具.txt");
	expect(detail).not.toContain("Path: src/config.ts");
	component.handleInput?.("\u001b[B");
	let second = component.render(42).join("\n");
	component.handleInput?.("\u001b[F");
	second = component.render(42).join("\n");
	expect(second).toContain("Path: src/config.ts");
	expect(second).not.toContain("Path: 工具.txt");
	component.handleInput?.("\u001b");
	expect(component.render(42).join("\n")).toContain("Tools");
	component.handleInput?.("\u001b");
	expect(harness.closed()).toBe(1);
	component.dispose?.();
});

test("/tools styles sanitized operation evidence and reuses its cached document", () => {
	initTheme("dark", false);
	const runtime = groupedRuntime(["src/demo.ts"]);
	runtime.registerDetailPresentation("read", {
		detailSections: () => [
			{
				languagePath: "src/demo.ts",
				lines: ["1  │ const same = true;", "2  │ - const oldValue = 1;", " 2 │ + const newValue = 2;"],
				operationEvidence: [
					{ diffKind: "context", kind: "diff", newLine: 1, oldLine: 1, text: "const same = true;" },
					{
						diffKind: "delete",
						kind: "diff",
						oldLine: 2,
						text: "\u001b]8;;https://evil.invalid\u0007const oldValue = 1;\u001b]8;;\u0007",
					},
					{ diffKind: "add", kind: "diff", newLine: 2, text: "const newValue = 2;" },
				],
				title: "Diff",
			},
		],
		label: () => "Read",
		summary: () => "safe",
		target: () => "src/demo.ts",
	});
	const taggedTheme = {
		bold: (value: string) => value,
		fg: (color: string, value: string) => `<${color}>${value}</${color}>`,
	};
	// SAFETY: this fixture implements the exact Theme methods exercised by the Dialog and evidence renderer.
	const detailTheme = taggedTheme as Theme;
	const component = createToolDialogView(runtime, "read-1").create(contextHarness(32, detailTheme).context);
	const output = component.render(160).join("\n");
	expect(output).toContain("<error>-</error>");
	expect(output).toContain("<success>+</success>");
	expect(output).toContain("\u001b[");
	expect(output).not.toContain("evil.invalid");

	const group = runtime.resolveGroup("read-1");
	if (!group || group === "ambiguous") throw new Error("missing detail group");
	// SAFETY: createToolDialogView constructs ToolDialogComponent, whose private method remains an ordinary runtime method.
	const cacheProbe = component as typeof component & {
		detailDocument(group: ToolActivityView, width: number): readonly string[];
	};
	const first = cacheProbe.detailDocument(group, 120);
	expect(cacheProbe.detailDocument(group, 120)).toBe(first);

	component.handleInput?.("r");
	expect(component.render(160).join("\n")).not.toContain("<success>+</success>");
	component.dispose?.();
});

test("the Tool dialog can focus a requested member within its complete group", () => {
	const runtime = groupedRuntime(["a.ts", "b.ts", "c.ts"]);
	const harness = contextHarness(36);
	const component = createToolDialogView(runtime, "read-2").create(harness.context);
	const detail = component.render(60).join("\n");
	expect(detail).toContain("3 calls");
	expect(detail).toContain("Calls");
	expect(detail).toContain("Content");
	expect(detail).not.toContain("◆");
	expect(detail).not.toContain("Path: a.ts");
	expect(detail).toContain("Path: b.ts");
	expect(detail).not.toContain("Path: c.ts");
	expect(detail).toContain("call 2/3");
	component.dispose?.();
});

test("/tools drops a pinned detail after its projection is removed", () => {
	const runtime = groupedRuntime(["stale.ts"]);
	const component = createToolDialogView(runtime, "read-1").create(contextHarness(32).context);
	expect(component.render(100).join("\n")).toContain("Path: stale.ts");

	runtime.resetProjection([]);
	const output = component.render(100).join("\n");
	expect(output).toContain("No tool activity in this session.");
	expect(output).not.toContain("stale.ts");
	component.dispose?.();
});

test("/tools keeps a valid member selected when a group shrinks", () => {
	const runtime = groupedRuntime(["a.ts", "b.ts", "c.ts"]);
	const component = createToolDialogView(runtime, "read-3").create(contextHarness(32).context);
	expect(component.render(64).join("\n")).toContain("Path: c.ts");

	runtime.resetProjection([{ role: "assistant", content: [toolCall("read-1", "a.ts")] }, toolResult("read-1")]);
	expect(component.render(64).join("\n")).toContain("Path: a.ts");
	component.dispose?.();
});

test("/tools keeps a five-member selection window while arrows traverse the whole group", () => {
	const runtime = groupedRuntime(Array.from({ length: 8 }, (_, index) => `${String(index + 1)}.ts`));
	const harness = contextHarness(28);
	const component = createToolDialogView(runtime, "read-1").create(harness.context);
	expect(component.render(64).filter((line) => line.includes("Read ·"))).toHaveLength(5);
	for (let index = 0; index < 7; index += 1) component.handleInput?.("\u001b[B");
	const last = component.render(64);
	expect(last.filter((line) => line.includes("Read ·"))).toHaveLength(5);
	expect(last.join("\n")).toContain("Path: 8.ts");
	component.dispose?.();
});

test("/tools pages the Activity list with Space", () => {
	const paths = Array.from({ length: 12 }, (_, index) => `${String(index + 1)}.ts`);
	const first = createToolDialogView(groupedRuntime(paths, -1, true)).create(contextHarness().context);
	first.render(64);
	first.handleInput?.("\r");
	const firstTarget = first
		.render(64)
		.join("\n")
		.match(/Path: (\S+)/u)?.[1];
	first.dispose?.();

	const paged = createToolDialogView(groupedRuntime(paths, -1, true)).create(contextHarness().context);
	const overflow = paged.render(64).join("\n");
	expect(overflow).toContain("b/Space page");
	expect(overflow).not.toContain("PgUp/PgDn page");
	paged.handleInput?.(" ");
	paged.handleInput?.("\r");
	const pagedTarget = paged
		.render(64)
		.join("\n")
		.match(/Path: (\S+)/u)?.[1];
	expect(pagedTarget).toBeDefined();
	expect(pagedTarget).not.toBe(firstTarget);
	paged.dispose?.();
});

test("/tools loads exactly one bounded older page only when its row is confirmed", () => {
	const runtime = groupedRuntime(["newest.ts"]);
	const pages = [
		{
			hasOlder: true,
			messages: [{ role: "assistant", content: [toolCall("read-older", "older.ts")] }, toolResult("read-older")],
		},
		{
			hasOlder: false,
			messages: [
				{ role: "assistant", content: [toolCall("read-earliest", "earliest.ts")] },
				toolResult("read-earliest"),
			],
		},
	];
	let loads = 0;
	runtime.configureHistoryLoader(() => pages[loads++], true);
	const component = createToolDialogView(runtime).create(contextHarness().context);

	expect(component.render(64).join("\n")).toContain("Load older activities…");
	component.handleInput?.("\u001b[B");
	expect(loads).toBe(0);
	expect(component.render(64).join("\n")).toContain("Read · 1 file");
	component.handleInput?.("\r");
	expect(loads).toBe(1);
	expect(component.render(64).join("\n")).toContain("Load older activities…");
	component.handleInput?.("\r");
	let output = component.render(64).join("\n");
	expect(output).toContain("older.ts");
	expect(output).not.toContain("newest.ts");

	component.handleInput?.("\u001b");
	component.handleInput?.("\u001b[B");
	component.handleInput?.("\r");
	expect(loads).toBe(2);
	expect(component.render(64).join("\n")).not.toContain("Load older activities…");
	component.handleInput?.("\r");
	output = component.render(64).join("\n");
	expect(output).toContain("earliest.ts");
	expect(output).not.toContain("older.ts");
	expect(output).not.toContain("Load older activities…");
	component.dispose?.();
});

test("the Tool dialog can open an infrastructure-only group hidden from the compact transcript", () => {
	const runtime = new ToolUiRuntime();
	runtime.registerActivity("ctx_reduce", { categories: [], classify: () => [], silentSuccess: true });
	runtime.registerDetailPresentation("ctx_reduce", {
		label: () => "Context reduction",
		summary: () => "done",
		target: () => "context",
	});
	runtime.markRendererAttached("ctx_reduce");
	runtime.indexMessages(
		[
			{ role: "assistant", content: [{ type: "toolCall", id: "internal-1", name: "ctx_reduce", arguments: {} }] },
			{ role: "toolResult", toolCallId: "internal-1", content: [{ type: "text", text: "done" }], details: {} },
		],
		true,
	);
	runtime.activities.begin({
		id: "internal-1",
		label: "Context reduction",
		name: "ctx_reduce",
		target: "context",
	});
	runtime.activities.settle("internal-1", {
		detailLines: ["Call", "internal", "", "Result", "done"],
		durationMs: undefined,
		state: "success",
		summary: "done",
	});
	const harness = contextHarness();
	const component = createToolDialogView(runtime, "internal-1").create(harness.context);
	const detail = component.render(60).join("\n");
	expect(detail).toContain("Tools / Internal activity");
	expect(detail).toContain("Reduction");
	expect(detail).not.toContain("Calls");
	expect(detail).not.toContain("formatted");
	expect(detail).not.toContain("Target:");
	expect(detail).not.toContain("Summary:");
	expect(detail).not.toContain("internal-1");
	expect(detail).not.toContain("Arguments");
	expect(detail).not.toContain("Result content");
	component.handleInput?.("r");
	let raw = component.render(60).join("\n");
	expect(raw).toContain("Raw");
	expect(raw).not.toContain("◆");
	expect(raw).toContain("Call ID: internal-1");
	expect(raw).toContain("Tool name: ctx_reduce");
	expect(raw).toContain("Arguments");
	component.handleInput?.("\u001b[6~");
	raw += `\n${component.render(60).join("\n")}`;
	component.handleInput?.("\u001b[F");
	raw += `\n${component.render(60).join("\n")}`;
	expect(raw).toContain("Result content");
	expect(raw).toContain("Details");
	component.handleInput?.("\u001b");
	expect(component.render(60).join("\n")).toContain("Reduction");
	component.handleInput?.("\u001b");
	expect(component.render(60).join("\n")).toContain("Tools");
	component.handleInput?.("\u001b");
	expect(harness.closed()).toBe(1);
	component.dispose?.();
});

test("/tools wraps and paginates long member details without exceeding terminal width", () => {
	const runtime = groupedRuntime(["long.txt"]);
	const longDetail = ["输出内容".repeat(200), "TAIL-END"].join(" ");
	runtime.registerDetailPresentation("read", {
		detailLines: () => [longDetail],
		label: () => "Read",
		summary: () => "safe",
		target: () => "long.txt",
	});
	const harness = contextHarness(28);
	const component = createToolDialogView(runtime, "read-1").create(harness.context);
	const first = component.render(28);
	expect(first.every((line) => visibleWidth(line) <= 28)).toBe(true);
	expect(first.join("\n")).not.toContain("TAIL-END");
	component.handleInput?.("\u001b[F");
	const last = component.render(28);
	expect(last.every((line) => visibleWidth(line) <= 28)).toBe(true);
	expect(last.join("\n")).toContain("TAIL-END");
	component.handleInput?.("\u001b[H");
	expect(component.render(28).join("\n")).not.toContain("TAIL-END");
	component.handleInput?.("\u001b[6~");
	component.handleInput?.("\u001b[5~");
	expect(component.render(28).join("\n")).not.toContain("TAIL-END");
	component.dispose?.();
});

test("/tools caps formatted and Raw protocol content per selected call", () => {
	const runtime = new ToolUiRuntime();
	runtime.registerActivity<ReadActivityArguments, unknown>("read", {
		categories: ["read-file"],
		classify: ({ args }) => [{ category: "read-file", countKeys: [String(args["path"])] }],
	});
	runtime.markRendererAttached("read");
	runtime.indexMessages(
		[
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "large",
						name: "read",
						arguments: { path: "large.txt", payload: "参".repeat(30_000) },
					},
				],
			},
			{
				role: "toolResult",
				toolCallId: "large",
				content: [
					{ type: "text", text: Array.from({ length: 400 }, (_, index) => `line ${String(index)}`).join("\n") },
				],
				details: { payload: "详".repeat(30_000) },
			},
		],
		true,
	);
	for (const mode of ["formatted", "raw"] as const) {
		const detail = runtime.toolActivityDetail("large", mode);
		expect(detail).toBeDefined();
		const lines = detail?.lines ?? [];
		expect(lines.length).toBeLessThanOrEqual(240);
		expect(Buffer.byteLength(lines.join("\n"))).toBeLessThanOrEqual(24 * 1_024);
		expect(lines.at(-1)).toContain("detail capped");
	}
});

test("/tools colors mixed groups amber and no-success failures red", () => {
	interface ColorCodes {
		readonly [color: string]: number;
	}
	const colorCodes: ColorCodes = { error: 31, muted: 90, success: 32, warning: 33 };
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const semanticTheme = {
		bold: (value: string) => value,
		fg: (color: string, value: string) => {
			const code = colorCodes[color];
			return code === undefined ? value : `\u001b[${String(code)}m${value}\u001b[0m`;
		},
	} as Theme;
	const mixed = createToolDialogView(groupedRuntime(["a.ts", "missing.ts"], 1)).create(
		contextHarness(28, semanticTheme).context,
	);
	const mixedOutput = mixed.render(100).join("\n");
	expect(Bun.stripANSI(mixedOutput)).toContain("Read 2 files · 1 failed");
	expect(mixedOutput).toContain("\u001b[33m!\u001b[0m");
	mixed.dispose?.();

	const failed = createToolDialogView(groupedRuntime(["missing.ts"], 0)).create(
		contextHarness(28, semanticTheme).context,
	);
	expect(failed.render(100).join("\n")).toContain("\u001b[31m×\u001b[0m");
	failed.dispose?.();
});

test("/tools respects narrow widths and terminal row budgets", () => {
	const runtime = groupedRuntime(["中文目标.txt"]);
	const harness = contextHarness(28);
	const component = createToolDialogView(runtime).create(harness.context);
	const narrow = component.render(12);
	expect(narrow.every((line) => visibleWidth(line) <= 12)).toBe(true);
	expect(narrow.join("\n")).toContain("Esc close");
	harness.terminal.rows = 5;
	expect(component.render(64).length).toBeLessThanOrEqual(5);
	component.handleInput?.("\r");
	expect(component.render(64).length).toBeLessThanOrEqual(5);
	harness.terminal.rows = 0;
	expect(component.render(64)).toEqual([]);
	component.dispose?.();
});

test("/tools retains bounded operation identity and removes state-equivalent evidence", () => {
	const runtime = new ToolUiRuntime();
	runtime.registerActivity("subagent", { categories: ["run-agent"], classify: () => [] });
	runtime.registerDetailPresentation("subagent", {
		label: () => "Agent",
		summary: () => "finished · 18s",
		target: () => "run · reviewer · inspect the complete implementation",
	});
	runtime.markRendererAttached("subagent");
	runtime.indexMessages(
		[
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "agent-run", name: "subagent", arguments: {} }],
			},
			{ role: "toolResult", toolCallId: "agent-run", content: [{ type: "text", text: "report" }], details: {} },
		],
		true,
	);
	const component = createToolDialogView(runtime).create(contextHarness().context);
	const wide = component.render(90).find((line) => line.includes("Agent")) ?? "";
	expect(wide).toContain("run");
	expect(wide).toContain("18s");
	expect(wide).not.toContain("finished");
	expect(wide.match(/\bsuccess\b/gu)).toHaveLength(1);
	const narrow = component.render(42).find((line) => line.includes("Agent")) ?? "";
	expect(narrow).toContain("run");
	expect(narrow).not.toContain("finished");
	expect(narrow).toContain("success");
	component.dispose?.();
});

test("/tools keeps list and detail visible on wide terminals", () => {
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const focusTheme = {
		bold: (value: string) => value,
		fg: (color: string, value: string) => (color === "accent" ? `\u001b[35m${value}\u001b[0m` : value),
	} as Theme;
	const harness = contextHarness(32, focusTheme);
	const component = createToolDialogView(groupedRuntime(["a.ts", "b.ts"], -1, true)).create(harness.context);
	let lines = component.render(100);
	let output = lines.join("\n");
	expect(lines.every((line) => visibleWidth(line) <= 100)).toBe(true);
	expect(lines).toHaveLength(18);
	expect(lines[0]).toBe("━".repeat(100));
	expect(lines.slice(1).every((line) => Bun.stripANSI(line)[52] === "┃")).toBe(true);
	expect(Bun.stripANSI(output)).not.toContain("│");
	expect(lines[1]?.split("┃")[0]).toContain("\u001b[35mTools\u001b[0m");
	expect(lines[1]?.split("┃")[1]).not.toContain("\u001b[35mTools /");
	expect(output).toContain("Path: b.ts");

	component.handleInput?.("\u001b[B");
	lines = component.render(100);
	output = lines.join("\n");
	expect(lines).toHaveLength(18);
	expect(output).toContain("Path: a.ts");
	expect(output).not.toContain("Path: b.ts");

	component.handleInput?.("\t");
	lines = component.render(100);
	expect(lines).toHaveLength(18);
	expect(lines[1]?.split("┃")[0]).not.toContain("\u001b[35mTools\u001b[0m");
	expect(lines[1]?.split("┃")[1]).toContain("\u001b[35mTools /");
	component.handleInput?.("\u001b[Z");
	lines = component.render(100);
	expect(lines[1]?.split("┃")[0]).toContain("\u001b[35mTools\u001b[0m");
	component.handleInput?.("?");
	expect(component.render(100).join("\n")).toContain("Tools / Keys");
	component.handleInput?.("\u001b");
	component.handleInput?.("\t");
	expect(component.render(64).join("\n")).toContain("Tools /");
	lines = component.render(100);
	expect(lines).toHaveLength(18);
	expect(lines[1]?.split("┃")[1]).toContain("\u001b[35mTools /");

	component.handleInput?.("\u001b");
	lines = component.render(100);
	expect(lines[1]?.split("┃")[0]).toContain("\u001b[35mTools\u001b[0m");
	expect(lines[1]?.split("┃")[1]).not.toContain("\u001b[35mTools /");
	component.handleInput?.("\u001b");
	expect(harness.closed()).toBe(1);
	component.dispose?.();
});

test("/tools keeps narrow terminals single-column", () => {
	const component = createToolDialogView(groupedRuntime(["a.ts"])).create(contextHarness().context);
	const output = component.render(64).join("\n");
	expect(output).toContain("Tools");
	expect(output.startsWith("━".repeat(64))).toBe(true);
	expect(output).not.toContain("Tool activity details");
	component.dispose?.();
});

test("/tools keeps its empty state single-column at wide widths", () => {
	const component = createToolDialogView(new ToolUiRuntime()).create(contextHarness(32).context);
	const output = component.render(100).join("\n");
	expect(output.match(/No tool activity in this session\./gu)).toHaveLength(1);
	expect(output).not.toContain("┃");
	expect(output).not.toContain("select");
	expect(output).not.toContain("details");
	expect(output).toContain("? keys");
	expect(output).toContain("Esc close");
	component.handleInput?.("?");
	const keyHelp = component.render(100).join("\n");
	expect(keyHelp).not.toContain("Previous/next");
	expect(keyHelp).not.toContain("Open details");
	expect(keyHelp).toContain("Return one level");
	component.dispose?.();
});
