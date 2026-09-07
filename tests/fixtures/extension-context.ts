import {
	type ExtensionCommandContext,
	type ExtensionContext,
	type ExtensionUIContext,
	ModelRegistry,
	SessionManager,
	Theme,
} from "@earendil-works/pi-coding-agent";

export const testTheme: Theme = Object.assign(Object.create(Theme.prototype), {
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
	getBashModeBorderColor: () => (text: string) => text,
	getBgAnsi: () => "",
	getColorMode: () => "truecolor" as const,
	getFgAnsi: () => "",
	getThinkingBorderColor: () => (text: string) => text,
	inverse: (text: string) => text,
	italic: (text: string) => text,
	strikethrough: (text: string) => text,
	underline: (text: string) => text,
});

export function createExtensionUi(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	return {
		addAutocompleteProvider: () => undefined,
		confirm: async () => false,
		custom: async () => {
			throw new Error("No custom UI response was configured for this test");
		},
		editor: async () => undefined,
		getAllThemes: () => [],
		getEditorComponent: () => undefined,
		getEditorText: () => "",
		getTheme: () => undefined,
		getToolsExpanded: () => false,
		input: async () => undefined,
		notify: () => undefined,
		onTerminalInput: () => () => undefined,
		pasteToEditor: () => undefined,
		select: async () => undefined,
		setEditorComponent: () => undefined,
		setEditorText: () => undefined,
		setFooter: () => undefined,
		setHeader: () => undefined,
		setHiddenThinkingLabel: () => undefined,
		setStatus: () => undefined,
		setTheme: () => ({ success: true }),
		setTitle: () => undefined,
		setToolsExpanded: () => undefined,
		setWidget: () => undefined,
		setWorkingIndicator: () => undefined,
		setWorkingMessage: () => undefined,
		setWorkingVisible: () => undefined,
		theme: testTheme,
		...overrides,
	};
}

export interface ExtensionContextOverrides extends Partial<Omit<ExtensionContext, "sessionManager" | "ui">> {
	readonly sessionManager?: Partial<ExtensionContext["sessionManager"]>;
	readonly ui?: Partial<ExtensionUIContext>;
}

export function createExtensionContext(overrides: ExtensionContextOverrides = {}): ExtensionContext {
	const cwd = overrides.cwd ?? process.cwd();
	const sessionManager = Object.assign(SessionManager.inMemory(cwd), overrides.sessionManager);
	const controller = new AbortController();
	const context: ExtensionContext = {
		abort: () => controller.abort(),
		compact: () => undefined,
		cwd,
		getContextUsage: () => undefined,
		getSystemPrompt: () => "",
		hasPendingMessages: () => false,
		hasUI: true,
		isIdle: () => true,
		isProjectTrusted: () => true,
		mode: "tui" as const,
		model: undefined,
		modelRegistry: Object.create(ModelRegistry.prototype),
		scopedModels: [],
		shutdown: () => undefined,
		signal: controller.signal,
		...overrides,
		sessionManager,
		ui: createExtensionUi(overrides.ui),
	};
	return context;
}

export function createExtensionCommandContext(overrides: ExtensionContextOverrides = {}): ExtensionCommandContext {
	const context = createExtensionContext(overrides);
	return Object.assign(context, {
		fork: async () => ({ cancelled: false }),
		getSystemPromptOptions: () => ({ cwd: context.cwd }),
		navigateTree: async () => ({ cancelled: false }),
		newSession: async () => ({ cancelled: false }),
		reload: async () => undefined,
		switchSession: async () => ({ cancelled: false }),
		waitForIdle: async () => undefined,
	});
}
