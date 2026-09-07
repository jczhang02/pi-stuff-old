import { homedir } from "node:os";
import { join } from "node:path";
import {
	type KeybindingsManager as AgentKeybindingsManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
	initTheme,
	ModelRegistry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { type KeybindingsConfig, KeybindingsManager, type TUI, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Check } from "typebox/value";
import piStuffCodex from "../../packages/pi-stuff/src/codex/index.js";
import piStuffUi, {
	type CommandDialogComponent,
	type CommandDialogPriority,
	type CommandDialogView,
	type CommandDialogViewContext,
	DiagnosticChannel,
	ensureUiSettingsCommand,
	getCodexStatusChannel,
	getCommandDialogCoordinator,
	getGoalStatusChannel,
	promoteActiveAgentWorkToUser,
	readCurrentAgentWorkOrigin,
	requestStatuslineGitRefreshAfterUserWork,
	UiSettingsStore,
	withAgentWorkOrigin,
} from "../../packages/pi-stuff/src/conversation-ui/index.js";
import { installUiSessionPresentation } from "../../packages/pi-stuff/src/conversation-ui/session-presentation.js";
import { createExtensionApi } from "../fixtures/extension-api.js";
import { createExtensionContext, testTheme } from "../fixtures/extension-context.js";
import { TestTui } from "../fixtures/test-tui.js";

const HANDLED_ACTION_SCHEMA = Type.Object({ action: Type.Literal("handled") }, { additionalProperties: true });
const INPUT_EVENT_SCHEMA = Type.Object(
	{ source: Type.Optional(Type.String()), text: Type.String() },
	{ additionalProperties: true },
);

type FooterFactory = Parameters<ExtensionUIContext["setFooter"]>[0];
type HeaderFactory = Parameters<ExtensionUIContext["setHeader"]>[0];
type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
interface HarnessMessage {
	readonly content?: string | readonly object[];
	readonly role: string;
}

interface HarnessEvent {
	readonly message?: HarnessMessage;
	readonly reason?: string;
	readonly source?: string;
	readonly streamingBehavior?: "followUp" | "steer";
	readonly text?: string;
	readonly timestamp?: number;
	readonly turnIndex?: number;
	readonly type: string;
}
type SessionHandler = (event: HarnessEvent, ctx: ExtensionContext) => object | undefined | Promise<object | undefined>;
type ExtensionEventListener = Parameters<ExtensionAPI["events"]["on"]>[1];
type ExtensionEventPayload = Parameters<ExtensionEventListener>[0];

interface HostCall {
	component: CommandDialogComponent | undefined;
	doneCalls: number;
	doneRequested: boolean;
	readonly options: { overlay?: boolean } | undefined;
	reject(cause: unknown): void;
	settleDone(): void;
}

class TestComponent implements CommandDialogComponent {
	disposeCalls = 0;
	input: string[] = [];
	invalidateCalls = 0;
	private readonly label: string;

	constructor(label: string) {
		this.label = label;
	}

	dispose(): void {
		this.disposeCalls += 1;
	}

	handleInput(data: string): void {
		this.input.push(data);
	}

	invalidate(): void {
		this.invalidateCalls += 1;
	}

	render(): string[] {
		return [this.label];
	}
}

class FocusableTestComponent extends TestComponent {
	focused = false;
}

interface EventBusLike {
	emit(event: string, data: ExtensionEventPayload): void;
	on(event: string, listener: ExtensionEventListener): () => void;
}

class EventBusHarness implements EventBusLike {
	private readonly listeners = new Map<string, Set<ExtensionEventListener>>();

	emit(event: string, data: ExtensionEventPayload): void {
		for (const listener of Array.from(this.listeners.get(event) ?? [])) listener(data);
	}

	on(event: string, listener: ExtensionEventListener): () => void {
		let listeners = this.listeners.get(event);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(event, listeners);
		}
		listeners.add(listener);
		return () => listeners?.delete(listener);
	}
}

function eventBusView(bus: EventBusHarness): EventBusLike {
	return {
		emit: (event, data) => bus.emit(event, data),
		on: (event, listener) => bus.on(event, listener),
	};
}

class UiHarnessKeybindings extends KeybindingsManager {
	constructor() {
		super(TUI_KEYBINDINGS);
	}

	getEffectiveConfig(): KeybindingsConfig {
		return this.getResolvedBindings();
	}

	reload(): void {}
}

class UiHarnessTui extends TestTui {
	private readonly requests: Array<boolean | undefined>;

	constructor(requests: Array<boolean | undefined>) {
		super();
		this.requests = requests;
	}

	override requestRender(force?: boolean): void {
		this.requests.push(force);
	}
}

class UiHarness {
	autoResolveOnDone = true;
	editorText = "saved draft";
	readonly editorWrites: string[] = [];
	readonly footerWrites: Array<FooterFactory | undefined> = [];
	readonly headerWrites: Array<HeaderFactory | undefined> = [];
	readonly hiddenThinkingLabels: Array<string | undefined> = [];
	readonly forbiddenCalls: string[] = [];
	readonly hostCalls: HostCall[] = [];
	readonly renderRequests: Array<boolean | undefined> = [];
	// SAFETY: the test manager implements the two Agent additions and otherwise uses the inherited TUI keybinding contract.
	readonly keybindings = new UiHarnessKeybindings() as AgentKeybindingsManager;
	readonly theme = testTheme;
	throwOnFooterRestore = false;
	readonly tui = new UiHarnessTui(this.renderRequests);
	readonly workingWrites: boolean[] = [];
	private editorFactory: EditorFactory | undefined;

	constructor() {
		initTheme("dark");
	}

	get currentHost(): CommandDialogComponent {
		const host = this.hostCalls.at(-1)?.component;
		if (!host) throw new Error("Expected a mounted Command Dialog host");
		return host;
	}

	custom<Result>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: AgentKeybindingsManager,
			done: (result: Result) => void,
		) => CommandDialogComponent | Promise<CommandDialogComponent>,
		options?: { overlay?: boolean },
	): Promise<Result> {
		const completion = createDeferred<Result>();
		let doneResult: Result | undefined;
		const call: HostCall = {
			component: undefined,
			doneCalls: 0,
			doneRequested: false,
			options,
			reject: completion.reject,
			settleDone: () => {
				if (!call.doneRequested) throw new Error("Host done was not requested");
				// SAFETY: this test controls the value and supplies every Result member exercised by this case.
				completion.resolve(doneResult as Result);
			},
		};
		this.hostCalls.push(call);
		const component = factory(this.tui, this.theme, this.keybindings, (result) => {
			call.doneCalls += 1;
			call.doneRequested = true;
			doneResult = result;
			if (this.autoResolveOnDone) completion.resolve(result);
		});
		if (component instanceof Promise) throw new Error("The test host expects a synchronous component factory");
		call.component = component;
		return completion.promise;
	}

	getEditorText(): string {
		return this.editorText;
	}

	getEditorComponent(): EditorFactory | undefined {
		return this.editorFactory;
	}

	setEditorText(text: string): void {
		this.editorText = text;
		this.editorWrites.push(text);
	}

	setEditorComponent(factory: EditorFactory | undefined): void {
		this.editorFactory = factory;
	}

	setFooter(factory: FooterFactory | undefined): void {
		this.footerWrites.push(factory);
		if (factory === undefined && this.throwOnFooterRestore) throw new Error("footer restore failed");
	}

	setHeader(factory: HeaderFactory | undefined): void {
		this.headerWrites.push(factory);
	}

	setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabels.push(label);
	}

	setStatus(): void {
		this.forbiddenCalls.push("status");
	}

	setWidget(): void {
		this.forbiddenCalls.push("widget");
	}

	setWorkingVisible(visible: boolean): void {
		this.workingWrites.push(visible);
	}

	rejectCurrent(cause: unknown): void {
		const call = this.hostCalls.at(-1);
		if (!call) throw new Error("Expected an active custom call");
		call.reject(cause);
	}

	settleCurrentDone(): void {
		const call = this.hostCalls.at(-1);
		if (!call) throw new Error("Expected an active custom call");
		call.settleDone();
	}
}

function createApiHarness(events: EventBusLike = new EventBusHarness(), execute?: ExtensionAPI["exec"]) {
	const execCalls: unknown[][] = [];
	const eventHandlers = new Map<string, SessionHandler[]>();
	const markdownTransformers: Parameters<ExtensionAPI["registerMarkdownTransformer"]>[0][] = [];
	const registeredCommands: string[] = [];
	const sessionHandlers: SessionHandler[] = [];
	const shutdownHandlers: SessionHandler[] = [];
	const exec: ExtensionAPI["exec"] = async (command, args, options) => {
		execCalls.push([command, args, options]);
		return execute ? execute(command, args, options) : { code: 1, killed: false, stderr: "", stdout: "" };
	};
	// SAFETY: this test adapter records every Host event callback without changing its arguments or result.
	const on = ((event: string, handler: SessionHandler) => {
		const handlers = eventHandlers.get(event) ?? [];
		handlers.push(handler);
		eventHandlers.set(event, handlers);
		if (event === "session_start") sessionHandlers.push(handler);
		if (event === "session_shutdown") shutdownHandlers.push(handler);
	}) as ExtensionAPI["on"];
	const api = createExtensionApi({
		events,
		exec,
		getAllTools: () => [],
		getActiveTools: () => [],
		getCommands: () => [],
		getThinkingLevel: () => "medium",
		on,
		registerCommand: (name: string) => registeredCommands.push(name),
		registerMarkdownTransformer: (transformer) => markdownTransformers.push(transformer),
		registerTool: () => {},
		setActiveTools: () => {},
	});

	return {
		api,
		execCalls,
		markdownTransformers,
		registeredCommands,
		sessionHandlers,
		shutdownHandlers,
		async emit(event: string, data: HarnessEvent, ctx: ExtensionContext): Promise<void> {
			// The certified Pi Host creates one context per input dispatch and shares it across
			// that dispatch's handlers. Other lifecycle events receive the supplied
			// session context directly.
			const handlerContext = event === "input" ? Object.create(ctx) : ctx;
			for (const handler of eventHandlers.get(event) ?? []) {
				const result = await handler(data, handlerContext);
				if (event === "input" && Check(HANDLED_ACTION_SCHEMA, result)) {
					return;
				}
			}
		},
		async start(ctx: ExtensionContext): Promise<void> {
			for (const handler of sessionHandlers) {
				await handler({ type: "session_start" }, ctx);
			}
		},
		async shutdown(ctx: ExtensionContext): Promise<void> {
			for (const handler of shutdownHandlers) {
				await handler({ reason: "quit", type: "session_shutdown" }, ctx);
			}
		},
	};
}

interface ContextOptions {
	readonly contextUsage?: {
		readonly contextWindow: number;
		readonly percent: number | null;
		readonly tokens: number | null;
	};
	readonly cwd?: string;
	readonly hasPendingMessages?: () => boolean;
	readonly isIdle?: () => boolean;
	readonly model?: ExtensionContext["model"];
	readonly modelId?: string;
	readonly modelRegistry?: Partial<ExtensionContext["modelRegistry"]>;
	readonly provider?: string;
	readonly signal?: AbortSignal;
}

function createTestModel(
	id: string,
	provider = "fixture",
	overrides: Partial<NonNullable<ExtensionContext["model"]>> = {},
): NonNullable<ExtensionContext["model"]> {
	return {
		api: "openai-responses",
		baseUrl: "https://example.test",
		contextWindow: 200_000,
		cost: { cacheRead: 0, cacheWrite: 0, input: 0, output: 0 },
		id,
		input: ["text"],
		maxTokens: 8_192,
		name: id,
		provider,
		reasoning: true,
		...overrides,
	};
}

function createContext(
	ui: UiHarness,
	mode: ExtensionContext["mode"] = "tui",
	options: ContextOptions = {},
): ExtensionContext {
	const cwd = options.cwd ?? "/workspace";
	const contextOptions: Parameters<typeof createExtensionContext>[0] = {
		cwd,
		getContextUsage: () => options.contextUsage,
		hasUI: mode !== "rpc",
		hasPendingMessages: options.hasPendingMessages ?? (() => false),
		isIdle: options.isIdle ?? (() => true),
		mode,
		model: options.model ?? (options.modelId ? createTestModel(options.modelId, options.provider) : undefined),
		sessionManager: { getBranch: () => [], getCwd: () => cwd },
		signal: options.signal,
		ui: {
			custom: (factory, dialogOptions) => ui.custom(factory, dialogOptions),
			getEditorComponent: () => ui.getEditorComponent(),
			getEditorText: () => ui.getEditorText(),
			setEditorComponent: (factory) => ui.setEditorComponent(factory),
			setEditorText: (text) => ui.setEditorText(text),
			setFooter: (factory) => ui.setFooter(factory),
			setHeader: (factory) => ui.setHeader(factory),
			setHiddenThinkingLabel: (label) => ui.setHiddenThinkingLabel(label),
			setStatus: () => ui.setStatus(),
			setWidget: () => ui.setWidget(),
			setWorkingVisible: (visible) => ui.setWorkingVisible(visible),
			theme: ui.theme,
		},
	};
	if (options.modelRegistry) {
		contextOptions.modelRegistry = Object.assign(Object.create(ModelRegistry.prototype), options.modelRegistry);
	}
	return createExtensionContext(contextOptions);
}

function commandDialogHarness() {
	const api = createApiHarness();
	const coordinator = getCommandDialogCoordinator(api.api);
	const ui = new UiHarness();
	return { api, coordinator, ctx: createContext(ui), ui };
}

async function installedCommandDialogHarness(options: ContextOptions = {}, api = createApiHarness()) {
	await piStuffUi(api.api);
	const coordinator = getCommandDialogCoordinator(api.api);
	const ui = new UiHarness();
	const ctx = createContext(ui, "tui", options);
	await api.start(ctx);
	return { api, coordinator, ctx, ui };
}

function createFooterData(branch: string | null = null) {
	const listeners = new Set<() => void>();
	return {
		getAvailableProviderCount: () => 1,
		getExtensionStatuses: () => new Map<string, string>(),
		getGitBranch: () => branch,
		onBranchChange: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

function createView<Result>(
	label: string,
	priority: CommandDialogPriority,
	components: Map<string, TestComponent>,
	contexts: Map<string, CommandDialogViewContext<Result>>,
): CommandDialogView<Result> {
	return {
		priority,
		create: (context) => {
			const component = new TestComponent(label);
			components.set(label, component);
			contexts.set(label, context);
			return component;
		},
	};
}

async function drainMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

async function waitUntil(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("Timed out waiting for test condition");
}

async function settleAgentRun(
	api: ReturnType<typeof createApiHarness>,
	ctx: ExtensionContext,
	source: "extension" | "interactive",
	text: string,
): Promise<void> {
	await api.emit("input", { type: "input", source, text }, ctx);
	await api.emit("agent_start", { type: "agent_start" }, ctx);
	await api.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 }, ctx);
	await api.emit(
		"message_start",
		{ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } },
		ctx,
	);
	await api.emit("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
	await api.emit("agent_settled", { type: "agent_settled" }, ctx);
}

async function emitAgentTurn<Message extends HarnessMessage>(
	api: ReturnType<typeof createApiHarness>,
	ctx: ExtensionContext,
	message: Message | string,
	turnIndex = 0,
	timestamp = turnIndex + 1,
): Promise<void> {
	await api.emit("turn_start", { type: "turn_start", turnIndex, timestamp }, ctx);
	await api.emit(
		"message_start",
		{
			type: "message_start",
			message: Check(Type.String(), message)
				? { role: "user", content: [{ type: "text", text: message }] }
				: message,
		},
		ctx,
	);
}

function createDeferred<Value>() {
	return Promise.withResolvers<Value>();
}

export type { CommandDialogComponent, CommandDialogView, CommandDialogViewContext, ExtensionContext, FooterFactory };
export {
	Check,
	commandDialogHarness,
	createApiHarness,
	createContext,
	createDeferred,
	createFooterData,
	createView,
	DiagnosticChannel,
	drainMicrotasks,
	EventBusHarness,
	emitAgentTurn,
	ensureUiSettingsCommand,
	eventBusView,
	FocusableTestComponent,
	getCodexStatusChannel,
	getCommandDialogCoordinator,
	getGoalStatusChannel,
	homedir,
	INPUT_EVENT_SCHEMA,
	installedCommandDialogHarness,
	installUiSessionPresentation,
	join,
	piStuffCodex,
	piStuffUi,
	promoteActiveAgentWorkToUser,
	readCurrentAgentWorkOrigin,
	requestStatuslineGitRefreshAfterUserWork,
	settleAgentRun,
	TestComponent,
	UiHarness,
	UiSettingsStore,
	waitUntil,
	withAgentWorkOrigin,
};
