import { expect, test } from "bun:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import {
	getCapabilities,
	Markdown,
	setCapabilities,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { transformConversationMarkdown } from "../../../packages/pi-stuff/src/conversation-ui/conversation-markdown.js";
import {
	HIDDEN_THINKING_LABEL,
	installThinkingLineDisplay,
} from "../../../packages/pi-stuff/src/conversation-ui/thinking-line.js";

const ZERO_USAGE = {
	cacheRead: 0,
	cacheWrite: 0,
	cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0, total: 0 },
	input: 0,
	output: 0,
	totalTokens: 0,
};

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		api: "openai-completions",
		content,
		model: "thinking-line-fixture",
		provider: "fixture",
		role: "assistant",
		stopReason,
		timestamp: 0,
		usage: ZERO_USAGE,
	};
}

function component(message: AssistantMessage, hidden = false): AssistantMessageComponent {
	return new AssistantMessageComponent(message, hidden, getMarkdownTheme(), HIDDEN_THINKING_LABEL, 1, [
		transformConversationMarkdown,
	]);
}

function renderedContent(componentUnderTest: AssistantMessageComponent, width = 80): string[] {
	return componentUnderTest
		.render(width)
		.map((line) => stripTerminalSequences(line).trim())
		.filter(Boolean);
}

test("replaces a visible Thinking run with its latest native Markdown row", () => {
	initTheme("dark");
	const uninstall = installThinkingLineDisplay();
	try {
		const streaming = assistantMessage(
			[
				{ type: "thinking", thinking: "**Planning comprehensive backpressure design**" },
				{ type: "thinking", thinking: "**Formulating backpressure assumptions and schemes**" },
			],
			"pending",
		);
		const sourceBeforeRender = structuredClone(streaming);
		const rendered = component(streaming);

		expect(renderedContent(rendered)).toEqual(["• thoughts: Formulating backpressure assumptions and schemes"]);
		expect(streaming).toEqual(sourceBeforeRender);

		const settled = assistantMessage([
			...streaming.content,
			{ type: "thinking", thinking: "**Defining combined state machine and event priorities**" },
			{ type: "thinking", thinking: "**Designing event loop state machine**\n\n" },
		]);
		rendered.updateContent(settled, false);
		expect(renderedContent(rendered)).toEqual(["• thoughts: Designing event loop state machine"]);
	} finally {
		uninstall();
	}
});

test("reuses the projected row during ordinary Host redraws", () => {
	initTheme("dark");
	const uninstall = installThinkingLineDisplay();
	const original = Markdown.prototype.render;
	let renderCalls = 0;
	Markdown.prototype.render = function (width): string[] {
		renderCalls += 1;
		return original.call(this, width);
	};
	try {
		const rendered = component(assistantMessage([{ type: "thinking", thinking: "first\n\nlatest" }]));
		rendered.render(80);
		rendered.render(80);
		expect(renderCalls).toBe(1);
		rendered.invalidate();
		rendered.render(80);
		expect(renderCalls).toBe(2);
	} finally {
		Markdown.prototype.render = original;
		uninstall();
	}
});

test("restores the prior Host renderer after the final adapter owner releases it", () => {
	const initialUpdateContent = AssistantMessageComponent.prototype.updateContent;
	const releaseFirst = installThinkingLineDisplay();
	const patchedUpdateContent = AssistantMessageComponent.prototype.updateContent;
	const releaseSecond = installThinkingLineDisplay();
	releaseFirst();
	try {
		expect(AssistantMessageComponent.prototype.updateContent).toBe(patchedUpdateContent);
	} finally {
		releaseSecond();
	}
	expect(AssistantMessageComponent.prototype.updateContent).toBe(initialUpdateContent);
});

test("keeps Host Thinking visibility semantics", () => {
	initTheme("dark");
	const uninstall = installThinkingLineDisplay();
	try {
		const rendered = component(
			assistantMessage([
				{ type: "text", text: "Visible answer" },
				{ type: "thinking", thinking: "First\n\nLatest" },
			]),
		);
		rendered.setHideThinkingBlock(true);
		expect(rendered.render(80).map((line) => stripTerminalSequences(line).trim())).toEqual([
			"",
			"• Visible answer",
			"",
			"• thoughts",
		]);

		rendered.setHideThinkingBlock(false);
		expect(rendered.render(80).map((line) => stripTerminalSequences(line).trim())).toEqual([
			"",
			"• Visible answer",
			"",
			"• thoughts: Latest",
		]);
	} finally {
		uninstall();
	}
});

test("separates interleaved Assistant prose and Thinking runs", () => {
	initTheme("dark");
	const uninstall = installThinkingLineDisplay();
	try {
		const rendered = component(
			assistantMessage([
				{ type: "thinking", thinking: "First run" },
				{ type: "text", text: "Visible answer" },
				{ type: "thinking", thinking: "Second run" },
				{ type: "text", text: "Final answer" },
			]),
		);
		expect(rendered.render(80).map((line) => stripTerminalSequences(line).trim())).toEqual([
			"",
			"• thoughts: First run",
			"",
			"• Visible answer",
			"",
			"• thoughts: Second run",
			"",
			"• Final answer",
		]);
	} finally {
		uninstall();
	}
});

test("preserves native mouse toggling on the projected Thinking row", () => {
	initTheme("dark");
	const uninstall = installThinkingLineDisplay();
	try {
		const rendered = component(
			assistantMessage([
				{ type: "text", text: "Visible answer" },
				{ type: "thinking", thinking: "First\n\nLatest" },
			]),
		);
		const rows = rendered.render(80);
		expect(renderedContent(rendered)).toEqual(["• Visible answer", "• thoughts: Latest"]);
		const event = {
			alt: false,
			ctrl: false,
			height: rows.length,
			screenX: 1,
			screenY: 3,
			shift: false,
			width: 80,
			x: 1,
			y: 3,
		};
		expect(rendered.handleMouse({ ...event, button: "right", type: "click" })).toBeUndefined();
		expect(rendered.handleMouse({ ...event, button: "left", type: "press" })).toBeUndefined();
		expect(rendered.handleMouse({ ...event, button: "left", type: "click" })?.handled).toBe(true);
		expect(renderedContent(rendered)).toEqual(["• Visible answer", "• thoughts"]);
		expect(rendered.handleMouse({ ...event, button: "left", type: "click" })?.handled).toBe(true);
		expect(renderedContent(rendered)).toEqual(["• Visible answer", "• thoughts: Latest"]);
	} finally {
		uninstall();
	}
});

test("matches Host whitespace filtering without scanning ordinary cumulative content", () => {
	initTheme("dark");
	const uninstall = installThinkingLineDisplay();
	try {
		const rendered = component(
			assistantMessage([
				{ type: "text", text: "   " },
				{ type: "thinking", thinking: "\n" },
				{ type: "thinking", thinking: "Latest" },
			]),
		);
		expect(renderedContent(rendered)).toEqual(["• thoughts: Latest"]);
	} finally {
		uninstall();
	}
});

test("keeps the tail of a wrapped latest line within the viewport", () => {
	initTheme("dark");
	const capabilities = getCapabilities();
	setCapabilities({ ...capabilities, hyperlinks: true });
	const uninstall = installThinkingLineDisplay();
	try {
		const rendered = component(
			assistantMessage([
				{
					type: "thinking",
					thinking: "[abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ](https://example.com)",
				},
			]),
		);
		rendered.render(80);
		const raw = rendered.render(28).find((line) => stripTerminalSequences(line).includes("thoughts"));
		if (!raw) throw new Error("Thinking row was not rendered");
		const visible = stripTerminalSequences(raw).trim();
		expect(visible).toEndWith("MNOPQRSTUVWXYZ");
		expect(visible).not.toContain("abc");
		expect(raw).toContain("\u001b]8;;\u001b\\");
		expect(raw).toEndWith("\u001b[0m");
		expect(visibleWidth(raw)).toBeLessThanOrEqual(28);
	} finally {
		uninstall();
		setCapabilities(capabilities);
	}
});
