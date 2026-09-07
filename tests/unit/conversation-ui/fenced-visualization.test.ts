import { describe, expect, test } from "bun:test";
import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	getMarkdownTheme,
	initTheme,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
	type ConversationMarkdownTransformContext,
	transformConversationMarkdown,
} from "../../../packages/pi-stuff/src/conversation-ui/conversation-markdown.js";
import { projectFencedVisualizations as projectFencedVisualizationsWithWidth } from "../../../packages/pi-stuff/src/conversation-ui/fenced-visualization.js";
import { renderTreeSource as renderTreeSourceWithWidth } from "../../../packages/pi-stuff/src/conversation-ui/indentation-tree.js";
import { renderChartSource as renderChartSourceWithWidth } from "../../../packages/pi-stuff/src/conversation-ui/unicode-chart.js";

const projectFencedVisualizations = (markdown: string, availableWidth: number): string =>
	projectFencedVisualizationsWithWidth(markdown, availableWidth, visibleWidth);
const renderChartSource = (source: string, availableWidth: number): string[] =>
	renderChartSourceWithWidth(source, availableWidth, visibleWidth);
const renderTreeSource = (source: string, availableWidth: number): string[] =>
	renderTreeSourceWithWidth(source, availableWidth, visibleWidth);

const BACKTICK = String.fromCharCode(0x60);
const FENCE = BACKTICK.repeat(3);
const LONG_FENCE = BACKTICK.repeat(4);
const ASSISTANT_CONTEXT: ConversationMarkdownTransformContext = {
	availableWidth: 80,
	isStreaming: false,
	messageType: "assistant",
};

function fenced(language: string, lines: readonly string[], marker = FENCE): string {
	return [marker + language, ...lines, marker].join("\n");
}

async function renderProjected(source: string, width: number, messageType: "assistant" | "user"): Promise<string[]> {
	initTheme("dark");
	const transformer = transformConversationMarkdown;
	const markdown = new Markdown(source, 0, 0, getMarkdownTheme(), undefined, {
		transform: (value, availableWidth) => transformer(value, { availableWidth, isStreaming: false, messageType }),
	});
	const lines = markdown.render(width).map((line) => stripTerminalSequences(line).trimEnd());
	await Promise.resolve();
	return lines;
}

function chart(type: string, rows: readonly string[]): string {
	return fenced("chart", [`type: ${type}`, `title: ${type} sample`, "data:", ...rows]);
}

test("leaves ordinary Markdown, candidate words, unknown fences, and incomplete targets byte-equivalent", () => {
	const inputs = [
		"ordinary chart and tree prose",
		fenced("typescript", ["const chart = 'tree';"]),
		[`${FENCE}chart`, "type: bar", "data:", "Jan 1"].join("\n"),
		"no visualization here\r\n",
	];
	for (const source of inputs) expect(projectFencedVisualizations(source, 80)).toBe(source);
});

test("projects every supported chart type and the histogram alias", async () => {
	const cases: ReadonlyArray<readonly [string, readonly string[]]> = [
		["bar", ["Jan -8", "Feb 5", "Mar 12"]],
		["histogram", ["A 1", "B 3", "C 2"]],
		["line", ["Mon 1", "Tue 4", "Wed 2", "Thu 6"]],
		["scatter", ["Mon 1", "Tue 4", "Wed 2", "Thu 6"]],
		["sparkline", ["1 3 2 7 4 8"]],
		["heatmap", ["Mon 1 2 3 4", "Tue 4 3 2 1"]],
	];
	for (const [type, rows] of cases) {
		const source = chart(type, rows);
		const projected = projectFencedVisualizations(source, 64);
		expect(projected).not.toBe(source);
		expect(projected).not.toContain(`${FENCE}chart`);
		const rendered = await renderProjected(source, 64, "user");
		expect(rendered.length).toBeGreaterThan(0);
		expect(rendered.every((line) => visibleWidth(line) <= 64)).toBe(true);
	}
});

test("accepts tilde fences and retains CRLF around a successful projection", () => {
	const tilde = fenced("chart", ["sparkline", "data:", "1 2 3 4"], "~~~");
	expect(projectFencedVisualizations(tilde, 40)).not.toBe(tilde);

	const crlf = chart("sparkline", ["1 2 3 4"]).replaceAll("\n", "\r\n");
	const projected = projectFencedVisualizations(crlf, 40);
	expect(projected).not.toBe(crlf);
	expect(projected).toContain("\r\n");
});

test("does not inspect a target fence nested inside an ordinary longer fence", () => {
	const nested = [`${LONG_FENCE}text`, `${FENCE}chart`, "type: sparkline", "1 2 3", FENCE, LONG_FENCE].join("\n");
	expect(projectFencedVisualizations(nested, 80)).toBe(nested);
});

test("preserves malformed, unsafe, over-limit, and too-narrow charts", () => {
	const invalid = [
		chart("unknown", ["A 1"]),
		fenced("chart", ["type: bar", "type: line", "A 1"]),
		fenced("chart", ["type: bar", "width: 10", "A 1"]),
		fenced("chart", ["type: line", "A 1", "broken row"]),
		fenced("chart", ["type: bar", "title: unsafe\u001b[31m", "A 1"]),
		fenced("chart", [
			"type: line",
			...Array.from({ length: 65 }, (_value, index) => `P${String(index)} ${String(index)}`),
		]),
		fenced("chart", ["type: sparkline", "1 ".repeat(6_100)]),
	];
	for (const source of invalid) expect(projectFencedVisualizations(source, 80)).toBe(source);
	const narrow = chart("bar", ["A 1", "B 2"]);
	expect(projectFencedVisualizations(narrow, 23)).toBe(narrow);
});

test("uses Host column width and grapheme-safe truncation", () => {
	const source = [
		"type: bar",
		"title: 中文🧪 family 👨‍👩‍👧‍👦 title that is deliberately long",
		"data:",
		"一月 1",
		"二月 2",
	].join("\n");
	const lines = renderChartSource(source, 24);
	expect(lines.length).toBeGreaterThan(0);
	expect(lines.every((line) => visibleWidth(line) <= 24)).toBe(true);
	expect(lines.join("\n")).not.toContain("�");
});

test("renders multiple outputs as inert borderless code blocks", async () => {
	const tree = fenced("tree", ["root", "  child `code` <tag>"]);
	const sparkline = chart("sparkline", ["1 3 2 4"]);
	const source = `${tree}\n\n${sparkline}`;
	const projected = projectFencedVisualizations(source, 80);
	expect(projected).not.toContain(`${FENCE}tree`);
	expect(projected).not.toContain(`${FENCE}chart`);
	expect(projected.includes("\u001b") || projected.includes("\u009b")).toBe(false);
	const rendered = (await renderProjected(source, 80, "user")).join("\n");
	expect(rendered).toContain("child `code` <tag>");
	expect(rendered).not.toContain(FENCE);
});

test("preserves ordinary code-block borders around a projected visualization", async () => {
	const source = [
		fenced("pi-stuff-visualization", ["reserved"]),
		fenced("tree", ["root", "  child"]),
		fenced("text", ["literal"]),
	].join("\n\n");
	const rendered = (await renderProjected(source, 80, "user")).join("\n");
	expect(rendered).toContain("└── child");
	expect(rendered).toContain(`${FENCE}pi-stuff-visualization`);
	expect(rendered).toContain(`${FENCE}text`);
});

test("bounds projected blocks and internal border-language selection", () => {
	const blocks = Array.from({ length: 17 }, (_value, index) => fenced("tree", [`root-${String(index)}`]));
	const capped = projectFencedVisualizations(blocks.join("\n\n"), 80);
	expect(capped.split(`${FENCE}tree`)).toHaveLength(2);

	const occupied = Array.from({ length: 33 }, (_value, index) =>
		fenced(index === 0 ? "pi-stuff-visualization" : `pi-stuff-visualization-${String(index)}`, ["literal"]),
	);
	const exhausted = [...occupied, fenced("tree", ["root"])].join("\n\n");
	expect(projectFencedVisualizations(exhausted, 80)).toBe(exhausted);
});

test("rejects partial chart rows instead of silently dropping them", () => {
	expect(renderChartSource("type: line\nA 1\ninvalid", 80)).toEqual([]);
	expect(renderChartSource("type: heatmap\nA 1 nope", 80)).toEqual([]);
	expect(
		renderChartSource(
			`type: heatmap\nA ${Array.from({ length: 65 }, (_value, index) => String(index)).join(" ")}`,
			80,
		),
	).toEqual([]);
});

describe("indentation tree renderer", () => {
	test("renders strict two-space input with Unix tree connectors", () => {
		const source = ["Pi Stuff", "  conversation-ui", "    chart", "    tree", "  tools"].join("\n");
		expect(renderTreeSource(source, 80)).toEqual([
			"Pi Stuff",
			"├── conversation-ui",
			"│   ├── chart",
			"│   └── tree",
			"└── tools",
		]);
		const fencedSource = fenced("tree", source.split("\n"));
		expect(projectFencedVisualizations(fencedSource, 80)).not.toBe(fencedSource);
	});

	test("rejects tabs, odd indentation, depth jumps, multiple roots, blanks, limits, and narrow output", () => {
		const invalid = [
			"root\n\tchild",
			"root\n child",
			"root\n    grandchild",
			"root\nsecond-root",
			"root\n\n  child",
			["root", ...Array.from({ length: 256 }, (_value, index) => `  child-${String(index)}`)].join("\n"),
			[
				"root",
				...Array.from({ length: 33 }, (_value, index) => `${"  ".repeat(index + 1)}depth-${String(index + 1)}`),
			].join("\n"),
			`root\n  ${"x".repeat(12_000)}`,
		];
		for (const source of invalid) expect(renderTreeSource(source, 80)).toEqual([]);
		expect(renderTreeSource("root\n  child", 5)).toEqual([]);
	});

	test("fits CJK and emoji by visible terminal columns without truncating labels", () => {
		const source = "根🧪\n  子节点\n  family👨‍👩‍👧‍👦";
		const wide = renderTreeSource(source, 40);
		expect(wide).toHaveLength(3);
		expect(wide.every((line) => visibleWidth(line) <= 40)).toBe(true);
		expect(renderTreeSource(source, 10)).toEqual([]);
	});
});

describe("Conversation UI composition", () => {
	test("projects User and Assistant fences without interpreting Thinking content", async () => {
		const source = chart("sparkline", ["1 3 2 5 4"]);
		const transformer = transformConversationMarkdown;
		const user = transformer(source, { ...ASSISTANT_CONTEXT, messageType: "user" });
		const assistant = transformer(source, ASSISTANT_CONTEXT);
		const thinking = transformer(source, { ...ASSISTANT_CONTEXT, messageType: "assistant-thinking" });

		expect(user).not.toBe(source);
		expect(assistant).toStartWith("- ");
		expect(assistant).not.toContain(`${FENCE}chart`);
		expect(thinking).toBe(source);
		expect(thinking).not.toContain("▁▂▃▄▅▆▇█");

		const rendered = await renderProjected(source, 40, "assistant");
		expect(rendered[0]).toStartWith("• ");
		expect(rendered.filter((line) => line.startsWith("• "))).toHaveLength(1);
		expect(rendered.every((line) => visibleWidth(line) <= 40)).toBe(true);

		const unsafe = fenced("chart", ["type: bar", "title: unsafe\u001b[31m", "A 1"]);
		const unsafeAssistant = transformer(unsafe, ASSISTANT_CONTEXT);
		expect(unsafeAssistant).toContain(`${FENCE}chart`);
		expect(unsafeAssistant).toContain("type: bar");
		expect(unsafeAssistant).not.toContain("████");
	});

	test("detects Assistant target fences during the existing sanitizer pass", async () => {
		const source = ["prefix", "~~~ TREE", "root", "  child", "~~~"].join("\r\n");
		const rendered = (await renderProjected(source, 80, "assistant")).join("\n");
		expect(rendered).toContain("prefix");
		expect(rendered).toContain("root");
		expect(rendered).toContain("└── child");
		expect(rendered).not.toContain("~~~");
	});

	test("reserves the Host code indent and Assistant marker budgets before chart rendering", () => {
		const source = chart("bar", ["A 1", "B 2"]);
		const transformer = transformConversationMarkdown;
		const narrowUser = transformer(source, { ...ASSISTANT_CONTEXT, availableWidth: 25, messageType: "user" });
		const fittingUser = transformer(source, { ...ASSISTANT_CONTEXT, availableWidth: 26, messageType: "user" });
		const narrowAssistant = transformer(source, { ...ASSISTANT_CONTEXT, availableWidth: 27 });
		const fittingAssistant = transformer(source, { ...ASSISTANT_CONTEXT, availableWidth: 28 });
		expect(narrowUser).toContain(`${FENCE}chart`);
		expect(fittingUser).not.toContain(`${FENCE}chart`);
		expect(narrowAssistant).toContain(`${FENCE}chart`);
		expect(fittingAssistant).not.toContain(`${FENCE}chart`);
	});
});
