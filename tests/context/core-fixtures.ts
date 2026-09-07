import {
	type KeybindingsManager as AgentKeybindingsManager,
	createExtensionRuntime,
	createSyntheticSourceInfo,
	type Extension,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	ExtensionRunner,
	type SessionEntry,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import piStuffContext, {
	__test,
	getContextCapability,
	projectCurrentContext,
} from "../../packages/pi-stuff/src/context-management/index.js";
import { contextStatusWithContinuity } from "../../packages/pi-stuff/src/context-management/status.js";
import {
	hasDirectUserActivation,
	isSuiteNativeCompactionPreflight,
	sendSuiteAgentMessage,
	withAgentWorkOrigin,
	withDirectUserActivation,
} from "../../packages/pi-stuff/src/conversation-ui/index.js";
import { isJsonSourceValue, type JsonSourceValue } from "../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeObject } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { createExtensionApi } from "../fixtures/extension-api.js";
import { createExtensionCommandContext, testTheme } from "../fixtures/extension-context.js";
import { TestTui } from "../fixtures/test-tui.js";

interface HarnessEvent {
	readonly message?: { readonly role: string };
	readonly preparation?: { readonly firstKeptEntryId: string; readonly tokensBefore: number };
	readonly reason?: string;
	readonly type?: string;
}
type Handler = (event: HarnessEvent, ctx: ExtensionContext) => object | undefined | Promise<object | undefined>;
type Handlers = Map<string, Handler[]>;
type ExtensionEventListener = Parameters<ExtensionAPI["events"]["on"]>[1];
type ExtensionEventPayload = Parameters<ExtensionEventListener>[0];
const UI_RENDER_REQUEST_EVENT = "@jczhang02/pi-stuff-ui/render-request/v1";
const CONTEXT_ACTIVITY_DATA_SCHEMA = Type.Object(
	{
		detail: Type.Optional(Type.String()),
		kind: Type.Optional(Type.String()),
		state: Type.Optional(Type.String()),
		summary: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const HANDLED_ACTION_SCHEMA = Type.Object({ action: Type.Literal("handled") }, { additionalProperties: true });
const SYSTEM_PROMPT_EVENT_SCHEMA = Type.Object({ systemPrompt: Type.String() }, { additionalProperties: true });
type ContextActivityData = Static<typeof CONTEXT_ACTIVITY_DATA_SCHEMA>;
type CompactOptions = NonNullable<Parameters<ExtensionContext["compact"]>[0]>;

const COMPACTION_RESULT = {
	firstKeptEntryId: "fixture-entry",
	summary: "fixture compaction",
	tokensBefore: 1,
};

type TestCommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];

interface HostRegistrations {
	commands: string[];
	commandDefinitions?: Map<string, TestCommandDefinition>;
	entries?: Array<{ customType: string; data: JsonSourceValue }>;
	entryRenderers: string[];
}

function contextActivityData(value: JsonSourceValue | undefined): ContextActivityData {
	if (!Check(CONTEXT_ACTIVITY_DATA_SCHEMA, value)) throw new Error("Expected Context activity data");
	return value;
}

function apiFor(
	handlers: Handlers,
	tools: ToolDefinition[] = [],
	registrations: HostRegistrations = { commands: [], entryRenderers: [] },
): ExtensionAPI {
	let activeTools: string[] = [];
	const eventBus = new Map<string, ExtensionEventListener[]>();
	// SAFETY: this test adapter records every Host event callback without changing its arguments or result.
	const on = ((event: string, handler: Handler): void => {
		const current = handlers.get(event) ?? [];
		current.push(handler);
		handlers.set(event, current);
	}) as ExtensionAPI["on"];
	return createExtensionApi({
		appendEntry(customType, data): void {
			if (!isJsonSourceValue(data)) throw new Error("Expected a serializable Context entry");
			registrations.entries?.push({ customType, data });
		},
		events: {
			emit(name: string, value: ExtensionEventPayload): void {
				for (const listener of eventBus.get(name) ?? []) listener(value);
			},
			on(name: string, listener: ExtensionEventListener): () => void {
				const listeners = eventBus.get(name) ?? [];
				listeners.push(listener);
				eventBus.set(name, listeners);
				return () => {
					const current = eventBus.get(name);
					const index = current?.indexOf(listener) ?? -1;
					if (index >= 0) current?.splice(index, 1);
				};
			},
		},
		on,
		registerTool(tool): void {
			// SAFETY: this test registry erases only generic renderer state and retains the original Tool object.
			const stored = tool as ToolDefinition;
			const existing = tools.findIndex((candidate) => candidate.name === stored.name);
			if (existing < 0) {
				tools.push(stored);
				if (!activeTools.includes(stored.name)) activeTools.push(stored.name);
			} else tools[existing] = stored;
		},
		registerCommand(name: string, definition: TestCommandDefinition): void {
			if (!registrations.commands.includes(name)) registrations.commands.push(name);
			registrations.commandDefinitions?.set(name, definition);
		},
		registerEntryRenderer(name: string): void {
			if (!registrations.entryRenderers.includes(name)) registrations.entryRenderers.push(name);
		},
		getActiveTools: () => [...activeTools],
		setActiveTools(names: string[]): void {
			activeTools = [...names];
		},
	});
}

function maintenanceHarness() {
	const handlers: Handlers = new Map();
	const commandDefinitions = new Map<string, TestCommandDefinition>();
	const entries: NonNullable<HostRegistrations["entries"]> = [];
	const registrations: HostRegistrations = { commands: [], commandDefinitions, entries, entryRenderers: [] };
	return { api: apiFor(handlers, [], registrations), commandDefinitions, entries, handlers, registrations };
}

function context(
	entries: readonly SessionEntry[] = [],
	cwd = "/workspace/project-a",
	sessionId = "session-a",
): ExtensionCommandContext {
	return createExtensionCommandContext({
		cwd,
		sessionManager: {
			buildContextEntries: () => [...entries],
			getSessionId: () => sessionId,
			getSessionFile: () => `/sessions/${sessionId}.jsonl`,
		},
	});
}

async function emit<Event extends HarnessEvent>(
	handlers: Handlers,
	name: string,
	event: Event,
	ctx = context(),
): Promise<void> {
	for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
}

async function emitUntilHandled<Event extends HarnessEvent>(
	handlers: Handlers,
	name: string,
	event: Event,
	ctx = context(),
): Promise<void> {
	for (const handler of handlers.get(name) ?? []) {
		const result = await handler(event, ctx);
		if (Check(HANDLED_ACTION_SCHEMA, result)) return;
	}
}

async function emitResults<Event extends HarnessEvent>(
	handlers: Handlers,
	name: string,
	event: Event,
	ctx = context(),
): Promise<Array<object | undefined>> {
	const results: Array<object | undefined> = [];
	for (const handler of handlers.get(name) ?? []) results.push(await handler(event, ctx));
	return results;
}

function taggedMessage(text: string) {
	return {
		role: "user" as const,
		content: [{ type: "text" as const, text }],
		timestamp: 1,
	};
}

function magicModule(
	options: {
		onContext?: (ctx: ExtensionContext) => void;
		registerBeforeStart?: () => void;
		registerTool?: boolean;
	} = {},
) {
	return {
		default: async (pi: ExtensionAPI) => {
			// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
			const register = pi.on.bind(pi) as (event: string, handler: Handler) => void;
			register("context", (event, ctx) => {
				options.onContext?.(ctx);
				// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
				const contextEvent = event as { messages: unknown[] };
				return {
					messages: [
						taggedMessage(
							"<session-history><project-memory><PROJECT_RULES>#1: remember me</PROJECT_RULES></project-memory>older turn</session-history>",
						),
						taggedMessage(
							'<session-history-since><memory-updates><updated id="1">remember me, updated</updated></memory-updates><new-memories><PROJECT_RULES>#2: new memory</PROJECT_RULES></new-memories>newer turn</session-history-since>',
						),
						...contextEvent.messages,
					],
				};
			});
			if (options.registerBeforeStart) {
				register("before_agent_start", () => {
					options.registerBeforeStart?.();
					return undefined;
				});
			}
			if (options.registerTool) {
				pi.registerTool({
					name: "ctx_search",
					label: "ctx_search",
					description: "Search Context",
					parameters: Type.Object({ query: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "result" }], details: undefined }),
				});
			}
		},
	};
}

function commandMagicModule(name: string, handler: (pi: ExtensionAPI, args: string) => Promise<void> | void) {
	return {
		default: async (pi: ExtensionAPI) => {
			pi.on("context", (event) => event);
			pi.registerCommand(name, { handler: async (args) => handler(pi, args) });
		},
	};
}

export type {
	CompactOptions,
	Extension,
	ExtensionAPI,
	ExtensionCommandContext,
	Handler,
	Handlers,
	HostRegistrations,
	SessionEntry,
	TestCommandDefinition,
	ToolDefinition,
};
export {
	__test,
	type AgentKeybindingsManager,
	apiFor,
	Check,
	COMPACTION_RESULT,
	commandMagicModule,
	context,
	contextActivityData,
	contextStatusWithContinuity,
	createExtensionCommandContext,
	createExtensionRuntime,
	createSyntheticSourceInfo,
	ExtensionRunner,
	emit,
	emitResults,
	emitUntilHandled,
	getContextCapability,
	hasDirectUserActivation,
	isRuntimeObject,
	isSuiteNativeCompactionPreflight,
	KeybindingsManager,
	magicModule,
	maintenanceHarness,
	piStuffContext,
	projectCurrentContext,
	SYSTEM_PROMPT_EVENT_SCHEMA,
	sendSuiteAgentMessage,
	TestTui,
	TUI_KEYBINDINGS,
	Type,
	taggedMessage,
	testTheme,
	UI_RENDER_REQUEST_EVENT,
	withAgentWorkOrigin,
	withDirectUserActivation,
};

export function cleanupContextCoreFixtures(): Promise<void> {
	return __test.clear();
}
