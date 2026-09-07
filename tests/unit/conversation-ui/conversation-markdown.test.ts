import { expect, test } from "bun:test";
import { AssistantMessageComponent, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Markdown, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import {
	getMarkdownTheme,
	initTheme,
} from "../../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import {
	type ConversationMarkdownTransformContext,
	registerConversationMarkdown,
	transformConversationMarkdown,
} from "../../../packages/pi-stuff/src/conversation-ui/conversation-markdown.js";
import { SELF_RENDERED_TRANSCRIPT_PADDING } from "../../../packages/pi-stuff/src/conversation-ui/transcript.js";
import { CachedToolRow } from "../../../packages/pi-stuff/src/tool-display/render.js";
import { createApiHarness, createContext, piStuffUi, UiHarness } from "../../ui/command-dialog-coordinator-fixtures.js";

const CONTEXT: ConversationMarkdownTransformContext = {
	availableWidth: 80,
	isStreaming: true,
	messageType: "assistant-thinking",
};
function transform(markdown: string, overrides: Partial<ConversationMarkdownTransformContext> = {}): string {
	return transformConversationMarkdown(markdown, { ...CONTEXT, ...overrides });
}

async function render(
	markdown: string,
	messageType: ConversationMarkdownTransformContext["messageType"],
): Promise<string[]> {
	initTheme("dark");
	const transformer = transformConversationMarkdown;
	const lines = new Markdown(markdown, 0, 0, getMarkdownTheme(), undefined, {
		transform: (value, availableWidth) => transformer(value, { availableWidth, isStreaming: false, messageType }),
	})
		.render(44)
		.map((line) => stripTerminalSequences(line).trimEnd());
	await Promise.resolve();
	return lines;
}

test("leaves Thinking Markdown unchanged for component-level projection", () => {
	const source = "Planning the change.\n\n- Inspect the repository\n- Run focused tests";

	expect(transform(source)).toBe(source);
	expect(transform(source, { availableWidth: 1 })).toBe(source);
	expect(transform(source, { isStreaming: false })).toBe(source);
});

test("leaves user Markdown unchanged and gives every Assistant message one outer marker", async () => {
	const source = "# Keep **all** model content\n\nincluding CJK 内容";

	expect(transform(source, { messageType: "user" })).toBe(source);
	const assistant = transform(source, { messageType: "assistant" });
	expect(assistant).toStartWith("- # Keep **all** model content");
	expect(assistant).toContain("\n  including CJK 内容");
	expect(assistant.match(/^- /gmu)).toHaveLength(1);

	const rendered = await render(source, "assistant");
	expect(rendered[0]).toStartWith("• ");
	expect(rendered.filter((line) => line.startsWith("• "))).toHaveLength(1);
	expect(rendered.every((line) => visibleWidth(line) <= 44)).toBe(true);
});

test("aligns Assistant and Tool Activity markers", async () => {
	initTheme("dark");
	const transformer = transformConversationMarkdown;
	const markdown = (source: string, messageType: ConversationMarkdownTransformContext["messageType"]) =>
		new Markdown(source, SELF_RENDERED_TRANSCRIPT_PADDING, 0, getMarkdownTheme(), undefined, {
			transform: (value, availableWidth) => transformer(value, { availableWidth, isStreaming: true, messageType }),
		});
	const assistantLine = stripTerminalSequences(markdown("DONE", "assistant").render(80)[0] ?? "");
	await Promise.resolve();
	// SAFETY: CachedToolRow uses only bold() and fg() in this marker-alignment fixture.
	const toolTheme = {
		bold: (value: string) => value,
		fg: (_color: string, value: string) => value,
	} as Theme;
	const activityLine =
		new CachedToolRow(toolTheme, {
			active: false,
			expandable: true,
			hint: "",
			kind: "activity",
			outcome: "error",
			summary: "Ran 1 command · 1 failed",
		}).render(80)[0] ?? "";

	expect([activityLine.indexOf("•"), assistantLine.indexOf("•")]).toEqual([
		SELF_RENDERED_TRANSCRIPT_PADDING,
		SELF_RENDERED_TRANSCRIPT_PADDING,
	]);
});

test("maps only the next synthetic outer Assistant list marker and restores the Theme", async () => {
	const calls: Array<readonly [string, string]> = [];
	const themeFixture = {
		fg: (color: string, value: string) => {
			calls.push([color, value]);
			return value;
		},
		getColorMode: () => "truecolor",
	};
	// SAFETY: Conversation Markdown calls only fg() and getColorMode() on this Theme fixture.
	const theme = themeFixture as Theme;
	const original = theme.fg;
	const key = Symbol.for("@earendil-works/pi-coding-agent:theme");
	const previous = Object.getOwnPropertyDescriptor(globalThis, key);
	Object.defineProperty(globalThis, key, { configurable: true, value: theme, writable: true });
	transform("Outer\n\n- nested", { messageType: "assistant" });
	expect(theme.fg("mdListBullet", "- ")).toBe("• ");
	expect(theme.fg).toBe(original);
	expect(theme.fg("mdListBullet", "- ")).toBe("- ");
	expect(theme.fg("text", "- ")).toBe("- ");
	expect(calls).toEqual([
		["mdListBullet", "• "],
		["mdListBullet", "- "],
		["text", "- "],
	]);
	await Promise.resolve();
	expect(theme.fg).toBe(original);
	if (previous === undefined) Reflect.deleteProperty(globalThis, key);
	else Object.defineProperty(globalThis, key, previous);
});

test("registers the Conversation Markdown transformer through the public Host seam", () => {
	const api = createApiHarness();
	registerConversationMarkdown(api.api);
	expect(api.markdownTransformers).toHaveLength(1);
	expect(api.markdownTransformers[0]?.("Checking. Ready", CONTEXT)).toBe("Checking. Ready");
});

test("sets the hidden Thinking label only for interactive sessions", async () => {
	const interactiveApi = createApiHarness();
	await piStuffUi(interactiveApi.api);
	const interactiveUi = new UiHarness();
	const interactive = createContext(interactiveUi);
	await interactiveApi.start(interactive);
	expect(interactiveUi.hiddenThinkingLabels).toEqual(["• thoughts"]);
	await interactiveApi.shutdown(interactive);

	const rpcApi = createApiHarness();
	await piStuffUi(rpcApi.api);
	const rpcUi = new UiHarness();
	const rpc = createContext(rpcUi, "rpc");
	await rpcApi.start(rpc);
	expect(rpcUi.hiddenThinkingLabels).toEqual([]);
	await rpcApi.shutdown(rpc);
});

test("releases the Thinking adapter when UI presentation setup fails", async () => {
	const initialUpdateContent = AssistantMessageComponent.prototype.updateContent;
	const api = createApiHarness();
	await piStuffUi(api.api);
	const ui = new UiHarness();
	ui.setHiddenThinkingLabel = () => {
		throw new Error("hidden label unavailable");
	};
	const ctx = createContext(ui);
	await expect(api.start(ctx)).rejects.toThrow("hidden label unavailable");
	expect(AssistantMessageComponent.prototype.updateContent).toBe(initialUpdateContent);
	await api.shutdown(ctx);
});

test("fails clearly when the Host cannot provide the accepted Markdown seam", () => {
	// SAFETY: an intentionally incomplete Host API is the failure condition under test.
	const api = {} as ExtensionAPI;
	expect(() => registerConversationMarkdown(api)).toThrow("registerMarkdownTransformer() support");
});
