import { stripVTControlCharacters } from "node:util";
import { Key, type KeyId, matchesKey } from "@earendil-works/pi-tui";
import { getGoalStatusChannel } from "../../packages/pi-stuff/src/conversation-ui/statusline.js";
import {
	isRuntimeFunction,
	isRuntimeObject,
	isRuntimeString,
} from "../../packages/pi-stuff/src/shared/runtime-type.js";

type MockValue = bigint | boolean | null | number | object | string | undefined;
type MockHandler = (...args: unknown[]) => MockValue | Promise<MockValue>;

interface StringLookup<Value> {
	readonly [key: string]: Value;
}

type MockCommand = {
	description?: string;
	handler: MockHandler;
	getArgumentCompletions?: (prefix: string) => MockValue;
};

type MockTool = {
	description?: string;
	name?: string;
	execute?: MockHandler;
	parameters?: MockValue;
	promptGuidelines?: string[];
	renderCall?: MockValue;
	renderResult?: MockValue;
	renderShell?: MockValue;
};

type MockFlag = {
	value?: MockValue;
};

interface MockRecord {
	readonly content?: MockValue;
	readonly customType?: MockValue;
	readonly deliverAs?: MockValue;
	readonly kind?: MockValue;
	readonly triggerTurn?: MockValue;
	readonly value?: MockValue;
}

interface MockSelectorComponent {
	readonly __piTuiKitScreen?: true;
	dispose?(): void;
	focused?: boolean;
	handleInput(data: string): void;
	invalidate?(): void;
	render(width: number): string[];
	waitForPending?(): Promise<void>;
}

interface MockSelectorKeybindings {
	getKeys(key: string): readonly string[];
	matches(data: string, key: string): boolean;
}

type MockSelectorFactory = (
	tui: { readonly terminal: { rows: number }; requestRender(): void },
	theme: { bold(text: string): string; fg(color: string, text: string): string },
	keybindings: MockSelectorKeybindings,
	close: <Value>(value: Value) => void,
) => MockSelectorComponent;

export interface MockContextOverrides {
	abort?: () => void;
	confirm?: (
		title: string,
		message: string,
		dialogOptions?: { readonly signal?: AbortSignal | undefined },
	) => Promise<boolean>;
	custom?: <Factory, Options>(factory: Factory, options?: Options) => Promise<MockValue>;
	cwd?: string;
	editor?: (title: string, initial: string) => Promise<string | undefined>;
	editorText?: string;
	getContextUsage?: () => MockValue;
	hasPendingMessages?: () => boolean;
	hasUI?: boolean;
	input?: (
		title: string,
		placeholder: string,
		dialogOptions?: { readonly signal?: AbortSignal | undefined },
	) => Promise<MockValue>;
	isIdle?: () => boolean;
	isProjectTrusted?: () => boolean;
	mode?: string;
	model?: MockValue;
	modelRegistry?: object;
	reload?: () => Promise<void>;
	select?: (
		title: string,
		options: string[],
		dialogOptions?: { readonly signal?: AbortSignal | undefined },
	) => Promise<string | undefined>;
	sessionManager?: object;
	signal?: AbortSignal | undefined;
	terminalRows?: number;
	waitForIdle?: () => Promise<void>;
}

type MockPiApi = {
	registerCommand(name: string, command: MockCommand): void;
	registerFlag(name: string, flag: MockFlag): void;
	registerTool(tool: MockTool): void;
	registerEntryRenderer(customType: string, renderer: MockHandler): void;
	registerProvider<Config>(name: string, config: Config): void;
	unregisterProvider(name: string): void;
	on(name: string, handler: MockHandler): void;
	events: {
		emit<Data>(channel: string, data: Data): void;
		on<Data>(channel: string, handler: (data: Data) => void): () => void;
		clear: () => void;
	};
	getFlag(name: string): MockValue;
	getActiveTools(): string[];
	setActiveTools(names: string[]): void;
	getAllTools(): MockTool[];
	getThinkingLevel(): string;
	setThinkingLevel(level: string): void;
	appendEntry<Data>(customType: string, data: Data): void;
	sendUserMessage<Options>(text: string, messageOptions?: Options): void;
	sendMessage<Message, Options>(message: Message, messageOptions?: Options): void;
	setModel<Model>(model: Model): Promise<boolean>;
};

interface MockPiOptions {
	activeTools?: string[];
	allTools?: MockTool[];
	thinkingLevel?: string;
	clampThinkingLevel?: (level: string) => string;
}

function createMockEventBus() {
	const subscriptions = new Map<string, MockHandler[]>();
	return {
		emit<Data>(channel: string, data: Data) {
			for (const handler of subscriptions.get(channel) ?? []) {
				try {
					const result = handler(data);
					void Promise.resolve(result).catch(() => undefined);
				} catch {
					// Match Pi's event bus: one observer cannot interrupt sibling handlers.
				}
			}
		},
		on<Data>(channel: string, handler: (data: Data) => void) {
			const list = subscriptions.get(channel) ?? [];
			const subscription: MockHandler = (data) => {
				// SAFETY: this test bus delivers values emitted on the same channel whose registration owns Data.
				handler(data as Data);
				return undefined;
			};
			list.push(subscription);
			subscriptions.set(channel, list);
			return () => {
				const current = subscriptions.get(channel);
				if (!current) return;
				const index = current.indexOf(subscription);
				if (index >= 0) current.splice(index, 1);
			};
		},
		clear() {
			subscriptions.clear();
		},
	};
}

function registerMockProvider<Config>(
	providers: Map<string, unknown>,
	registrations: Array<{ name: string; config: unknown }>,
	name: string,
	config: Config,
): void {
	const previous = providers.get(name);
	const effective =
		previous &&
		isRuntimeObject(previous) &&
		!Array.isArray(previous) &&
		config &&
		isRuntimeObject(config) &&
		!Array.isArray(config)
			? { ...previous, ...config }
			: config;
	providers.set(name, effective);
	registrations.push({ name, config });
}

export function createMockPi(options: MockPiOptions = {}) {
	const commands = new Map<string, MockCommand>();
	const entryRenderers = new Map<string, MockHandler>();
	const flags = new Map<string, MockFlag>();
	const events = new Map<string, MockHandler[]>();
	const tools: MockTool[] = [];
	const providers = new Map<string, unknown>();
	const providerRegistrations: Array<{ name: string; config: unknown }> = [];
	const providerUnregistrations: string[] = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	const sentUserMessages: Array<{ text: string; options?: unknown }> = [];
	const sentMessages: Array<{ message: unknown; options?: unknown }> = [];
	const sentHiddenGoalMessages: Array<{ message: unknown; options?: unknown }> = [];
	const setModels: unknown[] = [];
	const thinkingLevels: string[] = [];
	const eventBus = createMockEventBus();
	let thinkingLevel = options.thinkingLevel ?? "off";
	let activeTools = [...(options.activeTools ?? [])];
	const allTools = options.allTools ?? activeTools.map((name) => builtinTool(name));

	const rawPi: MockPiApi = {
		registerCommand(name: string, command: MockCommand) {
			commands.set(name, command);
		},
		registerFlag(name: string, flag: MockFlag) {
			flags.set(name, flag);
		},
		registerTool(tool: MockTool) {
			tools.push(tool);
		},
		registerEntryRenderer(customType: string, renderer: MockHandler) {
			entryRenderers.set(customType, renderer);
		},
		registerProvider<Config>(name: string, config: Config) {
			registerMockProvider(providers, providerRegistrations, name, config);
		},
		unregisterProvider(name: string) {
			providers.delete(name);
			providerUnregistrations.push(name);
		},
		on(name: string, handler: MockHandler) {
			events.set(name, [...(events.get(name) ?? []), handler]);
		},
		getFlag(name: string) {
			return flags.get(name)?.value;
		},
		getActiveTools() {
			return [...activeTools];
		},
		setActiveTools(names: string[]) {
			activeTools = [...names];
		},
		getAllTools() {
			return allTools;
		},
		getThinkingLevel() {
			return thinkingLevel;
		},
		setThinkingLevel(level: string) {
			thinkingLevel = options.clampThinkingLevel?.(level) ?? level;
			thinkingLevels.push(thinkingLevel);
		},
		appendEntry<Data>(customType: string, data: Data) {
			entries.push({ customType, data });
		},
		sendUserMessage<Options>(text: string, messageOptions?: Options) {
			sentUserMessages.push({ text, options: messageOptions });
		},
		sendMessage<Message, Options>(message: Message, messageOptions?: Options) {
			if (isRecord(message) && message.customType === "pi-stuff-goal-prompt" && isRuntimeString(message.content)) {
				sentHiddenGoalMessages.push({ message, options: messageOptions });
				if (isRecord(messageOptions) && messageOptions.triggerTurn === false) return;
				const deliverAs = isRecord(messageOptions) ? messageOptions.deliverAs : undefined;
				return rawPi.sendUserMessage(
					message.content,
					deliverAs === "steer" || deliverAs === "followUp" ? { deliverAs } : undefined,
				);
			}
			sentMessages.push({ message, options: messageOptions });
		},
		async setModel<Model>(model: Model) {
			setModels.push(model);
			return true;
		},
		events: eventBus,
	};
	const emitHostEvent = (name: string, ...args: unknown[]): void => {
		for (const handler of Array.from(events.get(name) ?? [])) handler(...args);
	};

	return {
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		pi: rawPi as never,
		rawPi,
		commands,
		entryRenderers,
		flags,
		events,
		emitHostEvent,
		callEvent(name: string, ...args: unknown[]) {
			const handlers = events.get(name) ?? [];
			if (name !== "session_start") return handlers[0]?.(...args);
			return Promise.all(handlers.map((handler) => handler(...args))).then((results) => results[0]);
		},
		eventBus,
		tools,
		providers,
		providerRegistrations,
		providerUnregistrations,
		entries,
		sentUserMessages,
		sentMessages,
		sentHiddenGoalMessages,
		setModels,
		thinkingLevels,
		get thinkingLevel() {
			return thinkingLevel;
		},
	};
}

function createDefaultCustom(
	overrides: MockContextOverrides,
	selectOverride: MockContextOverrides["select"],
	inputOverride: MockContextOverrides["input"],
) {
	return async <Factory>(factory: Factory) => {
		if (!selectOverride) return undefined;
		const harness = createCustomSelectorHarness(factory, 100, undefined, Number(overrides.terminalRows ?? 24));
		const options: string[] = [];
		for (let index = 0; index < 200; index += 1) {
			const selected = selectedKitRow(harness.render());
			if (!selected || options.includes(selected)) break;
			options.push(selected);
			harness.handleInput("tui.select.down");
		}
		for (let index = 0; index < options.length; index += 1) {
			harness.handleInput("tui.select.up");
		}
		if (options.length === 0 && harness.isFocusable && inputOverride) {
			for (let attempt = 0; attempt < 20; attempt += 1) {
				const response = await inputOverride(harness.render().join("\n"), "");
				if (isRecord(response) && response.kind === "closed") {
					harness.handleInput("\u0003");
					return harness.result;
				}
				if (response === undefined || (isRecord(response) && response.kind === "cancelled")) {
					harness.handleInput("tui.select.cancel");
					return harness.result;
				}
				const value = isRecord(response) && response.kind === "submitted" ? response.value : response;
				if (!isRuntimeString(value)) throw new Error("Mock input must return a string or exit");
				harness.setFocused(true);
				if (attempt > 0) harness.handleInput("\u0015");
				harness.handleInput(value);
				harness.handleInput("tui.input.submit");
				await harness.waitForPending();
				if (harness.result !== undefined) return harness.result;
			}
			throw new Error("Mock input exceeded its retry limit");
		}
		const selected = await selectOverride(harness.render().join("\n"), options);
		if (selected === "\u0003") {
			harness.handleInput("\u0003");
			return harness.result;
		}
		if (selected === undefined) {
			harness.handleInput("tui.select.cancel");
			return harness.result;
		}
		const selectedIndex = Math.max(
			0,
			options.findIndex(
				(option) => option === selected || option.startsWith(selected) || selected.startsWith(option),
			),
		);
		for (let index = 0; index < selectedIndex; index += 1) {
			harness.handleInput("tui.select.down");
		}
		harness.handleInput("tui.select.confirm");
		if (harness.result !== undefined) return harness.result;
		await harness.waitForPending();
		await Promise.resolve();
		if (harness.result !== undefined) return harness.result;
		harness.handleInput("tui.select.cancel");
		return harness.result;
	};
}

export function createMockContext(overrides: MockContextOverrides = {}) {
	const notifications: Array<{ message: string; level?: string | undefined }> = [];
	const statuses = new Map<string, string | undefined>();
	const widgets = new Map<string, unknown>();
	let footer: unknown;
	let workingVisible = true;
	let editorText = String(overrides.editorText ?? "");
	const selectOverride = overrides.select;
	const inputOverride = overrides.input;
	const defaultCustom = createDefaultCustom(overrides, selectOverride, inputOverride);
	const customOverride = overrides.custom;
	const custom =
		customOverride && selectOverride
			? async <Factory, Options>(factory: Factory, options?: Options) => {
					const probe = createCustomSelectorHarness(factory, 100, undefined, Number(overrides.terminalRows ?? 24));
					const standard = probe.isPiTuiKitScreen;
					probe.dispose();
					return standard ? defaultCustom(factory) : customOverride(factory, options);
				}
			: (customOverride ?? defaultCustom);

	const ctx = {
		cwd: overrides.cwd ?? process.cwd(),
		mode: overrides.mode ?? (overrides.hasUI ? "tui" : undefined),
		hasUI: overrides.hasUI ?? (overrides.mode === "tui" || overrides.mode === "rpc"),
		model: overrides.model,
		ui: {
			theme: {
				fg(_color: string, text: string) {
					return text;
				},
				bold(text: string) {
					return text;
				},
			},
			notify(message: string, level?: string) {
				notifications.push({ message, level });
			},
			setStatus(key: string, value: string | undefined) {
				statuses.set(key, value);
			},
			setWidget<Value>(key: string, value: Value) {
				widgets.set(key, value);
			},
			setFooter<Value>(value: Value) {
				footer = value;
			},
			setWorkingVisible(value: boolean) {
				workingVisible = value;
			},
			setEditorText(value: string) {
				editorText = value;
			},
			getEditorText() {
				return editorText;
			},
			confirm: overrides.confirm ?? (async () => true),
			input: overrides.input ?? (async () => undefined),
			select: overrides.select ?? (async () => undefined),
			editor: overrides.editor ?? (async () => undefined),
			custom,
		},
		isIdle: overrides.isIdle ?? (() => true),
		hasPendingMessages: overrides.hasPendingMessages ?? (() => false),
		isProjectTrusted: overrides.isProjectTrusted ?? (() => false),
		abort: overrides.abort ?? (() => undefined),
		waitForIdle: overrides.waitForIdle ?? (async () => undefined),
		reload: overrides.reload ?? (async () => undefined),
		getContextUsage: overrides.getContextUsage ?? (() => undefined),
		sessionManager: overrides.sessionManager ?? {
			getSessionId: () => "test-session",
			getSessionName: () => undefined,
			getBranch: () => [],
			getEntries: () => [],
		},
		modelRegistry: overrides.modelRegistry ?? {
			getApiKeyAndHeaders: async () => ({ ok: false, error: "missing" }),
			getAvailable: () => [],
			getAll: () => [],
			isUsingOAuth: () => false,
		},
		...overrides,
	};

	return {
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		ctx: ctx as never,
		notifications,
		statuses,
		widgets,
		get footer() {
			return footer;
		},
		get workingVisible() {
			return workingVisible;
		},
		get editorText() {
			return editorText;
		},
	};
}

function isRecord<Value>(value: Value): value is Value & MockRecord {
	return isRuntimeObject(value) && value !== null && !Array.isArray(value);
}

function selectedKitRow(lines: readonly string[]): string | undefined {
	const line = lines
		.map(stripVTControlCharacters)
		.find((candidate) => candidate.startsWith("→ ") || candidate.startsWith("› "));
	if (!line) return undefined;
	return line
		.slice(2)
		.replace(/^\[(?:x| |-)\]\s+/u, "")
		.split(/\s{2,}/u)[0]
		?.trim();
}

function createCustomSelectorHarness<Factory>(
	factory: Factory,
	width = 100,
	keybindingsOverride?: MockSelectorKeybindings,
	terminalRows = 24,
) {
	if (!isRuntimeFunction(factory)) throw new Error("Expected a custom component factory");
	let result: unknown;
	const { promise: resultPromise, resolve: resolveResult } = Promise.withResolvers<unknown>();
	const close = <Value>(value: Value): void => {
		result = value;
		resolveResult(value);
	};
	const terminal = { rows: terminalRows };
	// SAFETY: Pi supplies custom factories with this four-argument TUI contract, and the harness validates callability above.
	const createComponent = factory as Factory & MockSelectorFactory;
	const component = createComponent(
		{ terminal, requestRender() {} },
		{
			fg(_color: string, text: string) {
				return text;
			},
			bold(text: string) {
				return text;
			},
		},
		keybindingsOverride ?? {
			matches(data: string, key: string) {
				const bindings: StringLookup<KeyId> = {
					"tui.select.up": Key.up,
					"tui.select.down": Key.down,
					"tui.select.pageUp": Key.pageUp,
					"tui.select.pageDown": Key.pageDown,
					"tui.select.confirm": Key.enter,
					"tui.select.cancel": Key.escape,
					"tui.input.submit": Key.enter,
				};
				const binding = bindings[key];
				return (
					(binding !== undefined && matchesKey(data, binding)) ||
					(key === "tui.select.cancel" && matchesKey(data, Key.ctrl("c")))
				);
			},
			getKeys(key: string): readonly string[] {
				if (key === "tui.select.up") return ["up"];
				if (key === "tui.select.down") return ["down"];
				if (key === "tui.select.confirm" || key === "tui.input.submit") return ["enter"];
				if (key === "tui.select.cancel") return ["escape", "ctrl+c"];
				return [];
			},
		},
		close,
	);
	return {
		handleInput(data: string) {
			const inputData: StringLookup<string> = {
				"tui.select.up": "\u001b[A",
				"tui.select.down": "\u001b[B",
				"tui.select.pageUp": "\u001b[5~",
				"tui.select.pageDown": "\u001b[6~",
				"tui.select.confirm": "\r",
				"tui.select.cancel": "\u001b",
				"tui.input.submit": "\r",
			};
			component.handleInput(inputData[data] ?? data);
			return component.render(width);
		},
		render(renderWidth = width) {
			return component.render(renderWidth);
		},
		setTerminalRows(rows: number) {
			terminal.rows = rows;
		},
		invalidate() {
			component.invalidate?.();
		},
		setFocused(focused: boolean) {
			if ("focused" in component) component.focused = focused;
		},
		async waitForPending() {
			await component.waitForPending?.();
		},
		dispose() {
			component.dispose?.();
		},
		resultPromise,
		get isPiTuiKitScreen() {
			return component.__piTuiKitScreen === true;
		},
		get isFocusable() {
			return "focused" in component;
		},
		get result() {
			return result;
		},
	};
}

function builtinTool(name: string) {
	return {
		name,
		sourceInfo: { source: "builtin", scope: "builtin" },
	};
}

export function goalStatusSnapshot(pi: Parameters<typeof getGoalStatusChannel>[0]) {
	return getGoalStatusChannel(pi).source.getSnapshot();
}
