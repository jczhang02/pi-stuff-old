import {
	type AppKeybinding,
	CustomEditor,
	type ExtensionContext,
	type KeybindingsManager,
	type SlashCommandInfo,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type EditorComponent,
	type EditorTheme,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	type TUI,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { isRuntimeFunction, isRuntimeObject } from "../shared/runtime-type.ts";
import { sanitizeTerminalText, styleKnownInvocations } from "./input-highlighting.ts";

const COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u;
const BACKSPACE_INPUT = "\u007f";
const MAX_COMMANDS = 256;

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

interface InstalledFactoryRecord {
	readonly previous: EditorFactory | undefined;
	supersede(): void;
}

const installedFactories = new WeakMap<EditorFactory, InstalledFactoryRecord>();
const INSTALLED_FACTORY_RECORD = Symbol.for("@jczhang02/pi-stuff-ui/input-enhancement-factory");

function installedFactoryRecord(factory: EditorFactory): InstalledFactoryRecord | undefined {
	const local = installedFactories.get(factory);
	if (local) return local;
	const shared = Object.getOwnPropertyDescriptor(factory, INSTALLED_FACTORY_RECORD)?.value;
	if (!isRuntimeObject(shared) || shared === null || !("supersede" in shared)) return undefined;
	if (!isRuntimeFunction(shared.supersede)) return undefined;
	if ("previous" in shared && shared.previous !== undefined && !isRuntimeFunction(shared.previous)) return undefined;
	return shared;
}

function registerInstalledFactory(factory: EditorFactory, record: InstalledFactoryRecord): void {
	installedFactories.set(factory, record);
	Object.defineProperty(factory, INSTALLED_FACTORY_RECORD, {
		configurable: true,
		value: record,
	});
}

function unregisterInstalledFactory(factory: EditorFactory, record: InstalledFactoryRecord): void {
	installedFactories.delete(factory);
	if (installedFactoryRecord(factory) === record) Reflect.deleteProperty(factory, INSTALLED_FACTORY_RECORD);
}

export interface InputEnhancementSettings {
	readonly inlineSlashAutocomplete: boolean;
	readonly inputHighlighting: boolean;
}

export interface InputEnhancementOptions {
	/** Read on every render/input so `/ui` changes apply without recreating the editor. */
	getSettings(): InputEnhancementSettings;
	/** Pi's live registry for Extension, Prompt Template, and Skill commands. */
	getCommands(): readonly SlashCommandInfo[];
	/** Read lazily so a Host theme change is reflected immediately. */
	getTheme(): Theme;
}

export interface InputEnhancementController {
	/** Backward-compatible cleanup call. */
	(): void;
	dispose(): void;
	isShowingAutocomplete(): boolean;
	requestRender(force?: boolean): void;
	subscribe(listener: (visible: boolean) => void): () => void;
}

interface CursorAwareEditor extends EditorComponent {
	readonly embedWorkingStatus?: boolean;
	readonly actionHandlers?: Map<AppKeybinding, () => void>;
	dispose?(): void;
	focused?: boolean;
	getAutocompleteMaxVisible?(): number;
	getCursor(): { readonly col: number; readonly line: number };
	getLines(): string[];
	getPaddingX?(): number;
	isShowingAutocomplete(): boolean;
	onCtrlD?: () => void;
	onEscape?: () => void;
	onExtensionShortcut?: (data: string) => boolean;
	onPasteImage?: () => void;
	requestRender?(force?: boolean): void;
	setWorkingStatusIndicator?: CustomEditor["setWorkingStatusIndicator"];
}

interface InlineSlashContext {
	readonly query: string;
	readonly signature: string;
}

interface InlineAutocompleteState {
	readonly context: InlineSlashContext;
	readonly items: SelectItem[];
	readonly list: SelectList;
	selectedIndex: number;
}

function isCursorAwareEditor(editor: EditorComponent): editor is CursorAwareEditor {
	return (
		"getCursor" in editor &&
		isRuntimeFunction(editor.getCursor) &&
		"getLines" in editor &&
		isRuntimeFunction(editor.getLines) &&
		"isShowingAutocomplete" in editor &&
		isRuntimeFunction(editor.isShowingAutocomplete)
	);
}

function safeSettings(options: InputEnhancementOptions): InputEnhancementSettings {
	try {
		const settings = options.getSettings();
		return {
			inlineSlashAutocomplete: settings.inlineSlashAutocomplete === true,
			inputHighlighting: settings.inputHighlighting === true,
		};
	} catch {
		return { inlineSlashAutocomplete: false, inputHighlighting: false };
	}
}

function safeCommandName(value: string): string | undefined {
	return COMMAND_NAME_PATTERN.test(value) ? value : undefined;
}

function commandNames(options: InputEnhancementOptions, providerNames: ReadonlySet<string>): Set<string> {
	const names = new Set(providerNames);
	try {
		for (const command of options.getCommands()) {
			const name = safeCommandName(command.name);
			if (name) names.add(name);
			if (names.size >= MAX_COMMANDS) break;
		}
	} catch {
		// A transient registry failure must not make the editor unusable.
	}
	return names;
}

function skillCommandNames(options: InputEnhancementOptions): Set<string> {
	const names = new Set<string>();
	try {
		for (const command of options.getCommands()) {
			if (command.source !== "skill") continue;
			const name = safeCommandName(command.name);
			if (name) names.add(name);
			if (names.size >= MAX_COMMANDS) break;
		}
	} catch {
		// A transient registry failure must not expose non-Skill inline candidates.
	}
	return names;
}

function safeAutocompleteItems(items: readonly AutocompleteItem[], allowedNames: ReadonlySet<string>): SelectItem[] {
	const result: SelectItem[] = [];
	const seen = new Set<string>();
	for (const item of items) {
		const name = safeCommandName(item.value);
		if (!name || !allowedNames.has(name) || seen.has(name)) continue;
		seen.add(name);
		const description = item.description ? sanitizeTerminalText(item.description) : "";
		const safeItem: SelectItem = {
			value: name,
			label: `/${name}`,
		};
		if (description) Object.assign(safeItem, { description });
		result.push(safeItem);
		if (result.length >= MAX_COMMANDS) break;
	}
	return result;
}

function isInlineBoundary(value: string | undefined): boolean {
	if (value === undefined) return true;
	return !/[A-Za-z0-9_./:@-]/u.test(value);
}

function findInlineSlashContext(editor: CursorAwareEditor): InlineSlashContext | undefined {
	const lines = editor.getLines();
	const cursor = editor.getCursor();
	const currentLine = lines[cursor.line] ?? "";
	const beforeCursor = currentLine.slice(0, cursor.col);
	const slashIndex = beforeCursor.lastIndexOf("/");
	if (slashIndex < 0) return undefined;
	if (cursor.line === 0 && slashIndex === 0) return undefined;
	if (!isInlineBoundary(slashIndex === 0 ? undefined : beforeCursor[slashIndex - 1])) return undefined;

	const query = beforeCursor.slice(slashIndex + 1);
	if (query.length > 128 || !/^[A-Za-z0-9:._-]*$/u.test(query)) return undefined;
	return {
		query,
		signature: `${editor.getText()}\u0000${String(cursor.line)}:${String(cursor.col)}`,
	};
}

class InputEnhancementEditor implements EditorComponent {
	private autocompleteProvider: AutocompleteProvider | undefined;
	private readonly editor: CursorAwareEditor;
	private inline: InlineAutocompleteState | undefined;
	private inlineAbort: AbortController | undefined;
	private lastInlineSignature: string | undefined;
	private readonly onAutocompleteVisibilityChange: (() => void) | undefined;
	private readonly options: InputEnhancementOptions;
	private readonly providerCommandNames = new Set<string>();
	private seedAbort: AbortController | undefined;
	private readonly keybindings: KeybindingsManager;
	private readonly selectListTheme: SelectListTheme;
	private readonly tui: TUI;

	constructor(
		editor: CursorAwareEditor,
		tui: TUI,
		keybindings: KeybindingsManager,
		selectListTheme: SelectListTheme,
		options: InputEnhancementOptions,
		onAutocompleteVisibilityChange?: () => void,
	) {
		this.editor = editor;
		this.tui = tui;
		this.keybindings = keybindings;
		this.selectListTheme = selectListTheme;
		this.options = options;
		this.onAutocompleteVisibilityChange = onAutocompleteVisibilityChange;
	}

	get actionHandlers(): Map<AppKeybinding, () => void> | undefined {
		return this.editor.actionHandlers;
	}

	get borderColor(): (text: string) => string {
		return this.editor.borderColor ?? ((text) => text);
	}

	get embedWorkingStatus(): boolean {
		return this.editor.embedWorkingStatus === true && isRuntimeFunction(this.editor.setWorkingStatusIndicator);
	}

	setWorkingStatusIndicator(indicator: Parameters<CustomEditor["setWorkingStatusIndicator"]>[0]): void {
		this.editor.setWorkingStatusIndicator?.(indicator);
	}

	set borderColor(value: (text: string) => string) {
		this.editor.borderColor = value;
	}

	get focused(): boolean {
		return this.editor.focused === true;
	}

	set focused(value: boolean) {
		this.editor.focused = value;
	}

	get onChange(): (text: string) => void {
		return this.editor.onChange ?? (() => {});
	}

	set onChange(value: (text: string) => void) {
		this.editor.onChange = value;
	}

	get onCtrlD(): (() => void) | undefined {
		return this.editor.onCtrlD;
	}

	set onCtrlD(value: () => void) {
		this.editor.onCtrlD = value;
	}

	get onEscape(): (() => void) | undefined {
		return this.editor.onEscape;
	}

	set onEscape(value: () => void) {
		this.editor.onEscape = value;
	}

	get onExtensionShortcut(): ((data: string) => boolean) | undefined {
		return this.editor.onExtensionShortcut;
	}

	set onExtensionShortcut(value: (data: string) => boolean) {
		this.editor.onExtensionShortcut = value;
	}

	get onPasteImage(): (() => void) | undefined {
		return this.editor.onPasteImage;
	}

	set onPasteImage(value: () => void) {
		this.editor.onPasteImage = value;
	}

	get onSubmit(): (text: string) => void {
		return this.editor.onSubmit ?? (() => {});
	}

	set onSubmit(value: (text: string) => void) {
		this.editor.onSubmit = (text) => {
			if ("scrollToBottom" in this.tui && isRuntimeFunction(this.tui.scrollToBottom)) {
				this.tui.scrollToBottom();
			}
			value(text);
		};
	}

	get wantsKeyRelease(): boolean {
		return this.editor.wantsKeyRelease === true;
	}

	addToHistory(text: string): void {
		this.editor.addToHistory?.(text);
	}

	dispose(): void {
		this.shutdown();
		this.editor.dispose?.();
	}

	getExpandedText(): string {
		return this.editor.getExpandedText?.() ?? this.editor.getText();
	}

	getText(): string {
		return this.editor.getText();
	}

	handleInput(data: string): void {
		this.syncSettings();
		if (this.inline && this.handleInlineSelectionInput(data)) return;
		this.editor.handleInput(data);
		this.refreshInlineAutocomplete();
		this.reportAutocompleteVisibility();
	}

	insertTextAtCursor(text: string): void {
		if (this.editor.insertTextAtCursor) {
			this.editor.insertTextAtCursor(text);
		} else {
			this.editor.handleInput(text);
		}
		this.refreshInlineAutocomplete();
	}

	invalidate(): void {
		this.editor.invalidate();
		this.inline?.list.invalidate();
	}

	isShowingAutocomplete(): boolean {
		this.syncSettings();
		return this.nativeAutocompleteVisible() || this.inline !== undefined;
	}

	render(width: number): string[] {
		const settings = this.syncSettings();
		this.refreshInlineAutocomplete();
		const rendered = this.editor.render(width);
		this.reportAutocompleteVisibility();
		const names =
			settings.inputHighlighting && rendered.some((line) => line.includes("/"))
				? commandNames(this.options, this.providerCommandNames)
				: undefined;
		const currentTheme = names ? this.options.getTheme() : undefined;
		const lines =
			names && currentTheme ? rendered.map((line) => styleKnownInvocations(line, names, currentTheme)) : rendered;
		if (!this.inline || !settings.inlineSlashAutocomplete || this.nativeAutocompleteVisible()) return lines;
		return [...lines, ...this.renderInlineList(width)];
	}

	requestRender(force?: boolean): void {
		this.editor.requestRender?.(force);
		this.tui.requestRender(force);
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.editor.setAutocompleteMaxVisible?.(maxVisible);
	}

	setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.autocompleteProvider = provider;
		this.editor.setAutocompleteProvider?.(provider);
		this.seedCommandNames(provider);
		this.refreshInlineAutocomplete();
		this.reportAutocompleteVisibility();
	}

	setPaddingX(padding: number): void {
		this.editor.setPaddingX?.(padding);
	}

	setText(text: string): void {
		this.editor.setText(text);
		this.refreshInlineAutocomplete();
	}

	shutdown(): void {
		this.inlineAbort?.abort();
		this.inlineAbort = undefined;
		this.seedAbort?.abort();
		this.seedAbort = undefined;
		this.inline = undefined;
		this.reportAutocompleteVisibility();
	}

	private acceptInlineSelection(): void {
		const inline = this.inline;
		if (!inline) return;
		const current = findInlineSlashContext(this.editor);
		const selected = inline.items[inline.selectedIndex];
		if (!current || current.signature !== inline.context.signature || !selected) {
			this.clearInlineAutocomplete();
			return;
		}
		if (current.query.length > 0 && !this.keybindings.matches(BACKSPACE_INPUT, "tui.editor.deleteCharBackward")) {
			this.clearInlineAutocomplete();
			return;
		}
		this.clearInlineAutocomplete();
		for (let index = 0; index < current.query.length; index += 1) this.editor.handleInput(BACKSPACE_INPUT);
		const insertion = `${selected.value} `;
		if (this.editor.insertTextAtCursor) {
			this.editor.insertTextAtCursor(insertion);
		} else {
			this.editor.handleInput(insertion);
		}
		this.reportAutocompleteVisibility();
		this.tui.requestRender();
	}

	private clearInlineAutocomplete(requestRender = true): void {
		this.inlineAbort?.abort();
		this.inlineAbort = undefined;
		const changed = this.inline !== undefined;
		this.inline = undefined;
		if (changed) this.reportAutocompleteVisibility();
		if (changed && requestRender) this.tui.requestRender();
	}

	private handleInlineSelectionInput(data: string): boolean {
		const inline = this.inline;
		if (!inline) return false;
		if (this.keybindings.matches(data, "tui.select.cancel")) {
			this.clearInlineAutocomplete();
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.confirm") || this.keybindings.matches(data, "tui.input.tab")) {
			this.acceptInlineSelection();
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			inline.selectedIndex = inline.selectedIndex === 0 ? inline.items.length - 1 : inline.selectedIndex - 1;
			inline.list.setSelectedIndex(inline.selectedIndex);
			this.tui.requestRender();
			return true;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			inline.selectedIndex = (inline.selectedIndex + 1) % inline.items.length;
			inline.list.setSelectedIndex(inline.selectedIndex);
			this.tui.requestRender();
			return true;
		}
		return false;
	}

	private nativeAutocompleteVisible(): boolean {
		return this.editor.isShowingAutocomplete();
	}

	private reportAutocompleteVisibility(): void {
		this.onAutocompleteVisibilityChange?.();
	}

	private refreshInlineAutocomplete(): void {
		const settings = safeSettings(this.options);
		const provider = this.autocompleteProvider;
		const context = findInlineSlashContext(this.editor);
		if (!settings.inlineSlashAutocomplete || !provider || !context || this.nativeAutocompleteVisible()) {
			this.lastInlineSignature = undefined;
			this.clearInlineAutocomplete(false);
			return;
		}
		if (context.signature === this.lastInlineSignature) return;
		this.lastInlineSignature = context.signature;
		this.clearInlineAutocomplete(false);
		const controller = new AbortController();
		this.inlineAbort = controller;
		void provider
			.getSuggestions([`/${context.query}`], 0, context.query.length + 1, {
				force: false,
				signal: controller.signal,
			})
			.then((suggestions) => {
				if (controller.signal.aborted || this.inlineAbort !== controller) return;
				this.inlineAbort = undefined;
				const current = findInlineSlashContext(this.editor);
				if (!current || current.signature !== context.signature || !suggestions) return;
				const items = safeAutocompleteItems(suggestions.items, skillCommandNames(this.options));
				for (const item of suggestions.items) {
					const name = safeCommandName(item.value);
					if (name && this.providerCommandNames.size < MAX_COMMANDS) this.providerCommandNames.add(name);
				}
				if (items.length === 0) {
					this.tui.requestRender();
					return;
				}
				const list = new SelectList(items, this.editor.getAutocompleteMaxVisible?.() ?? 5, this.selectListTheme);
				this.inline = { context, items, list, selectedIndex: 0 };
				this.reportAutocompleteVisibility();
				this.tui.requestRender();
			})
			.catch(() => {
				if (this.inlineAbort === controller) this.inlineAbort = undefined;
			});
	}

	private renderInlineList(width: number): string[] {
		const inline = this.inline;
		if (!inline) return [];
		const maxPadding = Math.max(0, Math.floor((width - 1) / 2));
		const paddingX = Math.min(this.editor.getPaddingX?.() ?? 0, maxPadding);
		const contentWidth = Math.max(1, width - paddingX * 2);
		const leftPadding = " ".repeat(paddingX);
		const rightPadding = leftPadding;
		return inline.list.render(contentWidth).map((line) => {
			const fitted = truncateToWidth(line, contentWidth, "");
			const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)));
			return `${leftPadding}${fitted}${padding}${rightPadding}`;
		});
	}

	private seedCommandNames(provider: AutocompleteProvider): void {
		this.seedAbort?.abort();
		const controller = new AbortController();
		this.seedAbort = controller;
		void provider
			.getSuggestions(["/"], 0, 1, { force: false, signal: controller.signal })
			.then((suggestions) => {
				if (controller.signal.aborted || this.seedAbort !== controller) return;
				this.seedAbort = undefined;
				for (const item of suggestions?.items ?? []) {
					const name = safeCommandName(item.value);
					if (name && this.providerCommandNames.size < MAX_COMMANDS) this.providerCommandNames.add(name);
				}
				this.tui.requestRender();
			})
			.catch(() => {
				if (this.seedAbort === controller) this.seedAbort = undefined;
			});
	}

	private syncSettings(): InputEnhancementSettings {
		const settings = safeSettings(this.options);
		if (!settings.inlineSlashAutocomplete) {
			this.lastInlineSignature = undefined;
			this.clearInlineAutocomplete(false);
		}
		return settings;
	}
}

function createFactory(
	previous: EditorFactory | undefined,
	options: InputEnhancementOptions,
	onEditor?: (editor: InputEnhancementEditor) => void,
	onAutocompleteVisibilityChange?: () => void,
): EditorFactory {
	return (tui: TUI, editorTheme: EditorTheme, keybindings: KeybindingsManager): EditorComponent => {
		const editor = previous
			? previous(tui, editorTheme, keybindings)
			: new CustomEditor(tui, editorTheme, keybindings, { embedWorkingStatus: true });
		if (!isCursorAwareEditor(editor)) return editor;
		const enhanced = new InputEnhancementEditor(
			editor,
			tui,
			keybindings,
			editorTheme.selectList,
			options,
			onAutocompleteVisibilityChange,
		);
		onEditor?.(enhanced);
		return enhanced;
	};
}

/** Decorate the current Host editor factory without replacing its editing behavior. */
export function createInputEnhancementEditorFactory(
	previous: EditorFactory | undefined,
	options: InputEnhancementOptions,
): EditorFactory {
	return createFactory(previous, options);
}

/**
 * Install the editor decorator for one TUI session. The returned cleanup restores
 * the prior factory only when this installation still owns the editor slot.
 */
export function installInputEnhancementEditor(
	ctx: ExtensionContext,
	options: InputEnhancementOptions,
): InputEnhancementController {
	const occupied = ctx.ui.getEditorComponent();
	const priorInstallation = occupied ? installedFactoryRecord(occupied) : undefined;
	priorInstallation?.supersede();
	const previous = priorInstallation ? priorInstallation.previous : occupied;
	const editors = new Set<InputEnhancementEditor>();
	const listeners = new Set<(visible: boolean) => void>();
	let currentEditor: InputEnhancementEditor | undefined;
	let lastVisibility = false;
	const publishVisibility = (): void => {
		const visible = currentEditor?.isShowingAutocomplete() === true;
		if (visible === lastVisibility) return;
		lastVisibility = visible;
		for (const listener of listeners) {
			try {
				listener(visible);
			} catch {
				// Statusline repaint failures must not break input handling.
			}
		}
	};
	const factory = createFactory(
		previous,
		options,
		(editor) => {
			editors.add(editor);
			currentEditor = editor;
			publishVisibility();
		},
		publishVisibility,
	);
	let disposed = false;
	let record: InstalledFactoryRecord;
	const settle = (): boolean => {
		if (disposed) return false;
		disposed = true;
		for (const editor of editors) editor.shutdown();
		editors.clear();
		currentEditor = undefined;
		publishVisibility();
		listeners.clear();
		unregisterInstalledFactory(factory, record);
		return true;
	};
	const supersede = (): void => {
		settle();
	};
	const dispose = (): void => {
		if (!settle()) return;
		if (ctx.ui.getEditorComponent() === factory) ctx.ui.setEditorComponent(previous);
	};
	record = { previous, supersede };
	registerInstalledFactory(factory, record);
	try {
		ctx.ui.setEditorComponent(factory);
	} catch (error) {
		supersede();
		throw error;
	}
	return Object.assign(dispose, {
		dispose,
		isShowingAutocomplete: () => currentEditor?.isShowingAutocomplete() === true,
		requestRender: (force?: boolean) => currentEditor?.requestRender(force),
		subscribe: (listener: (visible: boolean) => void) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	});
}
