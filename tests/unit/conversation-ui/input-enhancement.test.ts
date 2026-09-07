import { describe, expect, test } from "bun:test";
import type {
	KeybindingsManager as AgentKeybindingsManager,
	ExtensionContext,
	SlashCommandInfo,
	Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type EditorComponent,
	type EditorTheme,
	type KeybindingsConfig,
	KeybindingsManager,
	type TUI,
	TUI_KEYBINDINGS,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	createInputEnhancementEditorFactory,
	type InputEnhancementSettings,
	installInputEnhancementEditor,
} from "../../../packages/pi-stuff/src/conversation-ui/input-enhancement.js";
import { TestTui } from "../../fixtures/test-tui.js";

const ACCENT_OPEN = "\u001b[35m";
const ACCENT_CLOSE = "\u001b[39m";

const editorTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: {
		description: (text) => text,
		noMatch: (text) => text,
		scrollInfo: (text) => text,
		selectedPrefix: (text) => text,
		selectedText: (text) => text,
	},
};

// SAFETY: this test fixture implements the exact Host surface exercised by this case.
const theme = {
	fg: (color: string, text: string) => (color === "accent" ? `${ACCENT_OPEN}${text}${ACCENT_CLOSE}` : text),
} as Theme;

class TestAppKeybindings extends KeybindingsManager {
	constructor() {
		super(TUI_KEYBINDINGS);
	}

	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}

	reload(): void {}
}

function isAgentKeybindings(value: KeybindingsManager): value is AgentKeybindingsManager {
	return value instanceof TestAppKeybindings;
}

class CommandProvider implements AutocompleteProvider {
	private readonly items: readonly AutocompleteItem[];
	readonly requests: string[] = [];

	constructor(items: readonly AutocompleteItem[]) {
		this.items = items;
	}

	async getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		_options: { readonly force?: boolean; readonly signal: AbortSignal },
	): Promise<{ readonly items: AutocompleteItem[]; readonly prefix: string } | null> {
		const prefix = (lines[cursorLine] ?? "").slice(0, cursorCol);
		this.requests.push(prefix);
		if (!prefix.startsWith("/")) return null;
		return { items: [...this.items], prefix };
	}

	applyCompletion(lines: string[], cursorLine: number, cursorCol: number, item: AutocompleteItem, prefix: string) {
		const next = [...lines];
		const line = next[cursorLine] ?? "";
		next[cursorLine] = `${line.slice(0, cursorCol - prefix.length)}/${item.value} ${line.slice(cursorCol)}`;
		return {
			lines: next,
			cursorLine,
			cursorCol: cursorCol - prefix.length + item.value.length + 2,
		};
	}
}

interface ObservableEditor extends EditorComponent {
	isShowingAutocomplete(): boolean;
}

function commands(...names: string[]): SlashCommandInfo[] {
	return names.map((name) => command(name, name.startsWith("skill:") ? "skill" : "extension"));
}

function command(name: string, source: SlashCommandInfo["source"]): SlashCommandInfo {
	// SAFETY: this test controls the value and supplies every SlashCommandInfo member exercised by this case.
	return { name, source } as SlashCommandInfo;
}

function createEditor(
	settings: InputEnhancementSettings,
	providerItems: readonly AutocompleteItem[],
	registeredCommands: readonly SlashCommandInfo[] = commands("review", "skill:inspect"),
) {
	const tui = new TestTui();
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const mutableSettings = settings as {
		inlineSlashAutocomplete: boolean;
		inputHighlighting: boolean;
	};
	const factory = createInputEnhancementEditorFactory(undefined, {
		getCommands: () => registeredCommands,
		getSettings: () => mutableSettings,
		getTheme: () => theme,
	});
	const keybindings = new TestAppKeybindings();
	if (!isAgentKeybindings(keybindings)) throw new Error("Test keybindings are incomplete");
	// SAFETY: this test controls the value and supplies every ObservableEditor member exercised by this case.
	const editor = factory(tui, editorTheme, keybindings) as ObservableEditor;
	const provider = new CommandProvider(providerItems);
	editor.setAutocompleteProvider?.(provider);
	return { editor, provider, settings: mutableSettings, tui };
}

async function settleAutocomplete(): Promise<void> {
	await Promise.resolve();
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe("Pi Stuff input highlighting", () => {
	test("styles only recognized current commands and skills without changing width or CJK", async () => {
		const { editor } = createEditor({ inlineSlashAutocomplete: false, inputHighlighting: true }, [
			{ value: "review", label: "review" },
			{ value: "skill:inspect", label: "skill:inspect" },
		]);
		editor.setText("中文/review 与 /skill:inspect；/missing https://x/review /review/file");
		await settleAutocomplete();

		const lines = editor.render(80);
		const output = lines.join("\n");
		expect(output).toContain(`${ACCENT_OPEN}/review${ACCENT_CLOSE}`);
		expect(output).toContain(`${ACCENT_OPEN}/skill:inspect${ACCENT_CLOSE}`);
		expect(output).not.toContain(`${ACCENT_OPEN}/missing${ACCENT_CLOSE}`);
		expect(output).not.toContain(`${ACCENT_OPEN}/review${ACCENT_CLOSE}/file`);
		expect(editor.getText()).toBe("中文/review 与 /skill:inspect；/missing https://x/review /review/file");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(80);
	});

	test("returns the native editor rendering with zero added rows when both settings are disabled", () => {
		const { editor } = createEditor({ inlineSlashAutocomplete: false, inputHighlighting: false }, [
			{ value: "review", label: "review" },
		]);
		editor.setText("plain /review");

		const lines = editor.render(64);
		expect(lines).toHaveLength(3);
		expect(lines.join("\n")).not.toContain(ACCENT_OPEN);
		expect(editor.isShowingAutocomplete()).toBeFalse();
	});

	test("keeps a recognized command highlighted when the native cursor splits its ANSI text", async () => {
		const { editor } = createEditor({ inlineSlashAutocomplete: false, inputHighlighting: true }, [
			{ value: "review", label: "review" },
		]);
		editor.setText("/review");
		editor.handleInput("\u001b[D");
		editor.handleInput("\u001b[D");
		await settleAutocomplete();

		const output = editor.render(64).join("\n");
		expect(output).toContain("\u001b[7m");
		expect(output.split(ACCENT_OPEN).length - 1).toBeGreaterThan(1);
		expect(editor.getText()).toBe("/review");
	});
});

describe("Pi Stuff inline slash autocomplete", () => {
	test("keeps Host fuzzy Skill results while excluding other inline commands", async () => {
		const { editor, provider } = createEditor(
			{ inlineSlashAutocomplete: true, inputHighlighting: false },
			[
				{ value: "hzh-command", label: "hzh-command", description: "Extension command" },
				{ value: "hzh-prompt", label: "hzh-prompt", description: "Prompt command" },
				{ value: "skill:humanizer-zh", label: "skill:humanizer-zh", description: "Humanize Chinese text" },
			],
			[command("hzh-command", "extension"), command("hzh-prompt", "prompt"), command("skill:humanizer-zh", "skill")],
		);
		editor.setText("请使用 /hzh尾");
		editor.handleInput("\u001b[D");
		await settleAutocomplete();

		expect(provider.requests).toContain("/hzh");
		const suggestions = editor.render(64).join("\n");
		expect(suggestions).toContain("/skill:humanizer-zh");
		expect(suggestions).not.toContain("/hzh-command");
		expect(suggestions).not.toContain("/hzh-prompt");

		editor.handleInput("\t");
		expect(editor.getText()).toBe("请使用 /skill:humanizer-zh 尾");
		editor.handleInput("新");
		expect(editor.getText()).toBe("请使用 /skill:humanizer-zh 新尾");
	});

	test("uses the Host provider inside a CJK sentence and preserves text after the cursor", async () => {
		const { editor, provider } = createEditor(
			{ inlineSlashAutocomplete: true, inputHighlighting: true },
			[
				{ value: "skill:review", label: "skill:review", description: "Review changes" },
				{ value: "skill:reload", label: "skill:reload", description: "Reload resources" },
			],
			commands("skill:review", "skill:reload"),
		);
		let submitted = false;
		editor.onSubmit = () => {
			submitted = true;
		};
		editor.setText("请执行 /skill:re尾");
		editor.handleInput("\u001b[D");
		await settleAutocomplete();

		expect(provider.requests).toContain("/skill:re");
		expect(editor.isShowingAutocomplete()).toBeTrue();
		const suggestions = editor.render(64).join("\n");
		expect(suggestions).toContain("/skill:review");
		expect(suggestions).toContain("/skill:reload");

		editor.handleInput("\u001b[B");
		editor.handleInput("\t");
		expect(editor.getText()).toBe("请执行 /skill:reload 尾");
		expect(submitted).toBeFalse();
		expect(editor.isShowingAutocomplete()).toBeFalse();
		expect(editor.render(64).join("\n")).toContain(`${ACCENT_OPEN}/skill:reload${ACCENT_CLOSE}`);
	});

	test("works at the start of later lines while leaving first-line native completion to Pi", async () => {
		const { editor, provider } = createEditor(
			{ inlineSlashAutocomplete: true, inputHighlighting: false },
			[{ value: "skill:review", label: "skill:review" }],
			commands("skill:review"),
		);
		editor.setText("first line\n/rev");
		await settleAutocomplete();

		expect(provider.requests).toContain("/rev");
		expect(editor.isShowingAutocomplete()).toBeTrue();
		editor.handleInput("\t");
		expect(editor.getText()).toBe("first line\n/skill:review ");
	});

	test("removes the list immediately when `/ui` disables it and emits no blank row", async () => {
		const created = createEditor(
			{ inlineSlashAutocomplete: true, inputHighlighting: false },
			[{ value: "skill:review", label: "skill:review" }],
			commands("skill:review"),
		);
		created.editor.setText("ask /re");
		await settleAutocomplete();
		expect(created.editor.render(64).length).toBeGreaterThan(3);

		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		(created.settings as { inlineSlashAutocomplete: boolean }).inlineSlashAutocomplete = false;
		const disabled = created.editor.render(64);
		expect(disabled).toHaveLength(3);
		expect(created.editor.isShowingAutocomplete()).toBeFalse();
	});

	test("filters unsafe registry data before it reaches the terminal", async () => {
		const { editor } = createEditor(
			{ inlineSlashAutocomplete: true, inputHighlighting: false },
			[
				{
					value: "skill:review",
					label: "skill:review",
					description: "安全\u001b]0;OWNED\u0007说明\u009dC1_TITLE\u009c结束",
				},
				{ value: "skill:bad\u001b[31m", label: "skill:bad" },
			],
			[command("skill:review", "skill"), command("skill:bad\u001b[31m", "skill")],
		);
		editor.setText("请 /r");
		await settleAutocomplete();

		const output = editor.render(64).join("\n");
		expect(output).toContain("/skill:review");
		expect(output).not.toContain("OWNED");
		expect(output).not.toContain("C1_TITLE");
		expect(output).not.toContain("bad");
	});
});

test("exposes native and inline autocomplete visibility through a cleanup-compatible controller", async () => {
	type Factory = (tui: TUI, theme: EditorTheme, keybindings: AgentKeybindingsManager) => EditorComponent;
	let installedFactory: Factory | undefined;
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const context = {
		ui: {
			getEditorComponent: () => installedFactory,
			setEditorComponent: (factory: Factory | undefined) => {
				installedFactory = factory;
			},
		},
	} as ExtensionContext;
	const settings = { inlineSlashAutocomplete: true, inputHighlighting: false };
	const controller = installInputEnhancementEditor(context, {
		getCommands: () => commands("skill:review"),
		getSettings: () => settings,
		getTheme: () => theme,
	});
	const visibility: boolean[] = [];
	const unsubscribe = controller.subscribe((visible) => visibility.push(visible));
	const tui = new TestTui();
	const keybindings = new TestAppKeybindings();
	if (!isAgentKeybindings(keybindings)) throw new Error("Test keybindings are incomplete");
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const editor = installedFactory?.(tui, editorTheme, keybindings) as ObservableEditor;
	editor.setAutocompleteProvider?.(new CommandProvider([{ value: "skill:review", label: "skill:review" }]));
	editor.setText("ask /re");
	await settleAutocomplete();

	expect(controller.isShowingAutocomplete()).toBeTrue();
	expect(visibility).toEqual([true]);
	settings.inlineSlashAutocomplete = false;
	editor.render(64);
	expect(controller.isShowingAutocomplete()).toBeFalse();
	expect(visibility).toEqual([true, false]);

	settings.inlineSlashAutocomplete = true;
	editor.setText("");
	editor.handleInput("/");
	await settleAutocomplete();
	editor.render(64);
	expect(controller.isShowingAutocomplete()).toBeTrue();
	expect(visibility).toEqual([true, false, true]);
	editor.handleInput("\u001b");
	expect(controller.isShowingAutocomplete()).toBeFalse();
	expect(visibility).toEqual([true, false, true, false]);

	unsubscribe();
	const firstFactory = installedFactory;
	const replacement = installInputEnhancementEditor(context, {
		getCommands: () => commands("review"),
		getSettings: () => settings,
		getTheme: () => theme,
	});
	expect(installedFactory).not.toBe(firstFactory);
	controller();
	expect(installedFactory).not.toBeUndefined();
	replacement.dispose();
	expect(installedFactory).toBeUndefined();
	expect(controller.isShowingAutocomplete()).toBeFalse();
	controller.dispose();
});

test("preserves an existing opaque editor instead of replacing unsupported behavior", () => {
	class OpaqueEditor implements EditorComponent {
		text = "";
		onSubmit?: (text: string) => void;
		onChange?: (text: string) => void;

		getText(): string {
			return this.text;
		}

		handleInput(data: string): void {
			this.text += data;
		}

		invalidate(): void {}

		render(): string[] {
			return [this.text];
		}

		setText(text: string): void {
			this.text = text;
		}
	}

	const opaque = new OpaqueEditor();
	const previous = () => opaque;
	const factory = createInputEnhancementEditorFactory(previous, {
		getCommands: () => commands("review"),
		getSettings: () => ({ inlineSlashAutocomplete: true, inputHighlighting: true }),
		getTheme: () => theme,
	});
	const keybindings = new TestAppKeybindings();
	if (!isAgentKeybindings(keybindings)) throw new Error("Test keybindings are incomplete");
	const result = factory(new TestTui(), editorTheme, keybindings);

	expect(result).toBe(opaque);
	result.handleInput("保留");
	expect(result.getText()).toBe("保留");
});

test("restores tail-following only when the native editor submits", () => {
	const { editor, tui } = createEditor({ inlineSlashAutocomplete: true, inputHighlighting: true }, [
		{ value: "review", label: "review" },
	]);
	const submissions: string[] = [];
	editor.onSubmit = (text) => submissions.push(text);
	editor.setText("普通输入");
	editor.handleInput("\u001b[D");
	expect(tui.followingEnd).toBeFalse();
	expect(tui.scrollToBottomCalls).toBe(0);
	editor.handleInput("\r");
	expect(tui.followingEnd).toBeTrue();
	expect(tui.scrollToBottomCalls).toBe(1);
	editor.setText("/ui");
	editor.handleInput("\r");
	expect(submissions).toEqual(["普通输入", "/ui"]);
	expect(tui.scrollToBottomCalls).toBe(2);
	expect(tui.renderRequests).toBe(2);
});
