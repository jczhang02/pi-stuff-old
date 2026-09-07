import { expect, test } from "bun:test";
import {
	getMarkdownTheme,
	initTheme,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { highlightSkillCommands } from "../../../packages/pi-stuff/src/conversation-ui/skill-command-style.js";
import { UserMessageCard } from "../../../packages/pi-stuff/src/conversation-ui/user-message-card.js";

function card(
	prompt: string,
	skillName = "implement",
	failures?: Error[],
	instructions = "Details stay below the prompt.",
): UserMessageCard {
	initTheme("dark");
	const skill = parseSkillBlock(
		`<skill name="${skillName}" location="fixture/SKILL.md">\n${instructions}\n</skill>${prompt ? `\n\n${prompt}` : ""}`,
	);
	const fallback = new Container();
	if (skill) fallback.addChild(new SkillInvocationMessageComponent(skill));
	if (prompt) {
		fallback.addChild(new Spacer(1));
		fallback.addChild(new UserMessageComponent(prompt));
	}
	return new UserMessageCard(prompt, {
		markdownTheme: getMarkdownTheme(),
		outputPad: 1,
		transformers: [],
		skill,
		fallback,
		fail: (error) => {
			if (failures) {
				failures.push(error);
				return;
			}
			throw error;
		},
	});
}

function content(message: UserMessageCard, width = 80): string[] {
	return message
		.render(width)
		.map((row) => stripTerminalSequences(row).trimEnd())
		.filter((row) => row.trim());
}

test.each([
	"# Heading",
	"***",
	"---",
	"- First item",
	"> Quotation",
	"```ts\nconst answer = 42;\n```",
	"Heading\n=======",
	"Name | Value\n--- | ---\nA | B",
])("keeps block Markdown below the inline Skill identity: %s", (prompt) => {
	const message = card(prompt);
	expect(content(message)[0]).toBe("  /skill:implement");
	expect(content(message).length).toBeGreaterThan(1);
});

test("retains native messages and expansion after a projection rendering failure", () => {
	const failures: Error[] = [];
	const message = card("Original prompt", "implement", failures);
	const nativeRender = Markdown.prototype.render;
	Markdown.prototype.render = function (width): string[] {
		if (width === 76) throw new Error("injected projection-width failure");
		return nativeRender.call(this, width);
	};
	try {
		expect(content(message)).toContain(" Original prompt");
		expect(failures).toHaveLength(1);
		message.setExpanded(true);
		expect(content(message).some((row) => row.includes("Details stay below the prompt."))).toBe(true);
		expect(failures).toHaveLength(1);
		message.setOutputPad(3);
		expect(content(message)).toContain("   Original prompt");
	} finally {
		Markdown.prototype.render = nativeRender;
	}
});

test("retains prompt rows across redraw, expansion, and padding changes", () => {
	const message = card("First line\nSecond line");
	const initial = content(message);
	expect(initial).toEqual(["  /skill:implement First line", "   Second line"]);
	expect(content(message)).toEqual(initial);
	message.setOutputPad(3);
	message.setExpanded(true);
	expect(content(message)[0]).toBe("    /skill:implement First line");
	message.setExpanded(false);
	expect(content(message)).toEqual(["    /skill:implement First line", "     Second line"]);
});

test("preserves long Unicode prompts and repaints semantic colors after a theme change", () => {
	const prompt = "Readable 中文🧪 prompt ".repeat(25).trimEnd();
	const message = card(prompt);
	for (const width of [24, 32, 48, 100]) {
		const rows = content(message, width);
		expect(rows.join("").replace(/\s/gu, "")).toBe(`/skill:implement${prompt.replace(/\s/gu, "")}`);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
	}
	const dark = message.render(100);
	initTheme("light");
	message.invalidate();
	expect(message.render(100)).not.toEqual(dark);
	expect(content(message, 100).join("").replace(/\s/gu, "")).toContain(prompt.replace(/\s/gu, ""));
});

test.each([
	"Ordinary **bold** 中文🧪",
	"    indented code",
	"Literal /skill:implement",
	'<skill name="incomplete">text</skill>',
])("keeps ordinary and unrecognized Skill text on the native Markdown path: %s", (prompt) => {
	initTheme("dark");
	const fallback = new Container();
	fallback.addChild(new UserMessageComponent(prompt));
	const message = new UserMessageCard(prompt, {
		markdownTheme: getMarkdownTheme(),
		outputPad: 1,
		transformers: [],
		skill: null,
		fallback,
		fail: (error) => {
			throw error;
		},
	});
	const native = new UserMessageComponent(prompt, getMarkdownTheme(), 3)
		.render(80)
		.map((row) => stripTerminalSequences(row).trimEnd())
		.filter((row) => row.trim());
	expect(content(message).map((row) => row.replace(/^  /, "   "))).toEqual(native);
});

test("uses native paragraph classification for leading inline emphasis", () => {
	expect(content(card("_important_ prompt"))[0]).toBe("  /skill:implement important prompt");
});

test("keeps native vertical spacing when a Skill prefix precedes a padded Markdown row", () => {
	for (const prompt of ["hi", "**hi**", "中文🧪"]) {
		const message = card(prompt, "grill-me");
		for (const width of [32, 48, 100]) {
			const rows = message.render(width).map((row) => stripTerminalSequences(row).trimEnd());
			expect(rows).toEqual(["", `  /skill:grill-me ${prompt.replaceAll("**", "")}`, ""]);
		}
		message.setExpanded(true);
		message.setExpanded(false);
		expect(message.render(100)).toHaveLength(3);
	}
});

test("colors every inline Skill command with the workflow palette before native wrapping", () => {
	const prompt = "hi /skill:ponytail-help then **/skill:to-spec**";
	const message = card(prompt, "ponytail-help");
	for (const width of [24, 32, 100]) {
		const rendered = message.render(width).join("\n");
		expect(rendered.split("\u001b[38;5;93m/")).toHaveLength(4);
		expect(stripTerminalSequences(rendered).replace(/\s/gu, "")).toBe(
			"/skill:ponytail-helphi/skill:ponytail-helpthen/skill:to-spec",
		);
	}
});

test("preserves native Markdown links while coloring visible Skill labels", () => {
	const message = card("[/skill:to-spec](https://example.com/skill:untouched) tail");
	const rendered = message.render(100).join("\n");
	expect(stripTerminalSequences(rendered)).toContain("/skill:to-spec");
	expect(rendered).toContain("https://example.com/skill:untouched");
	expect(rendered).toContain("\u001b[38;5;93m/");
});

test("restores compound SGR foregrounds without confusing background RGB values for colors", () => {
	for (const [control, expected] of [
		["1;31", "31"],
		["1;38;2;10;20;30", "38;2;10;20;30"],
		["38;5;123;1", "38;5;123"],
		["31;48;2;0;32;39;1", "31"],
		["31;0;1", "39"],
	]) {
		const rendered = highlightSkillCommands(`\u001b[${control}m/skill:one tail`);
		expect(rendered.endsWith(`\u001b[${expected}m tail`)).toBe(true);
	}
});

test("matches visible commands across formatting without inventing token boundaries", () => {
	for (const prompt of ["/skill:**implement**", "**/skill:im**plement", "/skill:im**ple**ment"]) {
		const rendered = card(prompt).render(100).join("\n");
		expect(rendered.split("\u001b[38;5;93m/")).toHaveLength(3);
	}
	const rendered = card("**path**/skill:implement").render(100).join("\n");
	expect(rendered.split("\u001b[38;5;93m/")).toHaveLength(2);
});

test("wraps the complete prefixed paragraph exactly as native Markdown, retaining hard breaks", () => {
	for (const prompt of [
		"one two three four five six seven eight nine ten eleven twelve",
		"one two three  \nfour five six",
		"one two\nthree four",
	]) {
		const message = card(prompt);
		for (const width of [24, 40, 80]) {
			const expected = new Markdown(`/skill:implement ${prompt}`, 0, 0, getMarkdownTheme())
				.render(width - 4)
				.map((row, index) => `${index === 0 ? "  " : "   "}${stripTerminalSequences(row).trimEnd()}`);
			expect(content(message, width)).toEqual(expected);
		}
	}
});

test("colors inline commands in expanded instructions while retaining native fenced code", () => {
	const message = card("hi", "implement", undefined, "Use /skill:to-spec\n\n```text\n/skill:literal\n```");
	message.setExpanded(true);
	const rendered = message.render(100).join("\n");
	expect(rendered.split("\u001b[38;5;93m/")).toHaveLength(3);
	expect(stripTerminalSequences(rendered)).toContain("/skill:literal");
});
