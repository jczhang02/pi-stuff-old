import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import {
	createEventBus,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionEvent,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import {
	installSessionNamingCapability,
	type SessionNamingHost,
} from "../../../packages/pi-stuff/src/session-naming/index.js";
import {
	type SessionNamingSettings,
	SessionNamingSettingsStore,
} from "../../../packages/pi-stuff/src/session-naming/settings.js";
import { createExtensionCommandContext } from "../../fixtures/extension-context.js";

const SETTINGS: SessionNamingSettings = {
	schemaVersion: 1,
	enabled: true,
	cooldownMinutes: 10,
	respectManualName: false,
	fallbackModels: [],
};

type Listener = (event: ExtensionEvent, ctx: ExtensionContext) => Promise<void> | undefined;

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const FIXTURE_MODEL: Model<Api> = {
	api: "openai-completions",
	baseUrl: "https://fixture.invalid",
	contextWindow: 100_000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	id: "naming",
	input: ["text"],
	maxTokens: 4_096,
	name: "Naming fixture",
	provider: "fixture",
	reasoning: false,
};

function message(role: "assistant" | "user", content: string, id: string): SessionEntry {
	const base = { id, parentId: null, timestamp: "2026-08-24T00:00:00.000Z" };
	if (role === "user") return { ...base, type: "message", message: { role, content, timestamp: 1 } };
	const assistant: AssistantMessage = {
		role,
		content: [{ type: "text", text: content }],
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 2,
	};
	return { ...base, type: "message", message: assistant };
}

function response(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider: "fixture",
		model: "naming",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 3,
	};
}

function hostHarness(
	complete?: (model: Model<Api>, context: Context, options?: ModelsApiStreamOptions<Api>) => Promise<AssistantMessage>,
) {
	const lifecycle = new Map<string, Listener[]>();
	const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	const eventBus = createEventBus();
	const subscribedChannels: string[] = [];
	const events = {
		emit: eventBus.emit.bind(eventBus),
		on(channel: string, handler: Parameters<ExtensionAPI["events"]["on"]>[1]) {
			subscribedChannels.push(channel);
			return eventBus.on(channel, handler);
		},
	} satisfies ExtensionAPI["events"];
	const entries: SessionEntry[] = [
		message("user", "Implement automatic Session naming", "entry-1"),
		message("assistant", "Done", "entry-2"),
	];
	const notices: string[] = [];
	let name: string | undefined;
	const extensionContext = createExtensionCommandContext({
		model: complete ? FIXTURE_MODEL : undefined,
		sessionManager: { getBranch: () => entries },
		ui: { notify: (message) => notices.push(message) },
	});
	Object.assign(extensionContext.modelRegistry, {
		complete:
			complete ??
			(async () => {
				throw new Error("The local fallback does not call the fixture registry");
			}),
		find: () => undefined,
		hasConfiguredAuth: () => complete !== undefined,
	});
	// SAFETY: this event adapter records Host callbacks without changing their arguments or results.
	const on = ((event: string, listener: Listener) => {
		const listeners = lifecycle.get(event) ?? [];
		listeners.push(listener);
		lifecycle.set(event, listeners);
	}) as ExtensionAPI["on"];
	const appendEntry: ExtensionAPI["appendEntry"] = <T = unknown>(customType: string, data?: T) => {
		entries.push({
			type: "custom",
			id: `entry-${String(entries.length + 1)}`,
			parentId: null,
			timestamp: "2026-08-24T00:00:00.000Z",
			customType,
			data,
		});
	};
	const pi = {
		events,
		on,
		registerCommand(name: string, options: Parameters<ExtensionAPI["registerCommand"]>[1]) {
			commands.set(name, options);
		},
		appendEntry,
		getSessionName: () => name,
		setSessionName(next: string) {
			name = next;
		},
	} satisfies SessionNamingHost;
	const emitLifecycle = async (event: string, ctx: ExtensionContext = extensionContext): Promise<void> => {
		// SAFETY: these handlers do not inspect the event payload in the exercised lifecycle cases.
		const fixtureEvent = { type: event } as ExtensionEvent;
		for (const listener of lifecycle.get(event) ?? []) await listener(fixtureEvent, ctx);
	};
	const emitSessionInfoChanged = async (name: string, ctx: ExtensionContext = extensionContext): Promise<void> => {
		// SAFETY: The fixture supplies the exact Host event fields read by Session Naming.
		const event = { type: "session_info_changed", name } as ExtensionEvent;
		for (const listener of lifecycle.get("session_info_changed") ?? []) await listener(event, ctx);
	};
	const emitSettled = (): void => {
		const settledEvent = subscribedChannels.find((event) => event.includes("user-agent-run-settled"));
		if (!settledEvent) throw new Error("Session Naming did not subscribe to the shared settled event");
		pi.events.emit(settledEvent, { ctx: extensionContext });
	};
	const getAutonameCompletions = (prefix: string) => {
		const command = commands.get("autoname");
		if (!command) throw new Error("Session Naming did not register /autoname");
		return command.getArgumentCompletions?.(prefix) ?? null;
	};
	const runAutoname = async (args = ""): Promise<void> => {
		const command = commands.get("autoname");
		if (!command) throw new Error("Session Naming did not register /autoname");
		await command.handler(args, extensionContext);
	};
	return {
		context: extensionContext,
		emitLifecycle,
		emitSessionInfoChanged,
		emitSettled,
		entries,
		getAutonameCompletions,
		name: () => name,
		notices,
		pi,
		runAutoname,
	};
}

async function waitForName(read: () => string | undefined): Promise<string | undefined> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const value = read();
		if (value) return value;
		await Bun.sleep(1);
	}
	return read();
}

describe("Session Naming Extension lifecycle", () => {
	test("names a parent Session only at the shared direct-user settled boundary", async () => {
		const host = hostHarness();
		installSessionNamingCapability(host.pi, SessionNamingSettingsStore.memory(SETTINGS), {});
		await host.emitLifecycle("session_start");
		await host.emitLifecycle("agent_settled");
		await Promise.resolve();
		expect(host.name()).toBeUndefined();

		host.emitSettled();
		expect(await waitForName(host.name)).toBe("automatic Session naming");
	});

	test("offers only the settings argument completion", () => {
		const host = hostHarness();
		installSessionNamingCapability(host.pi, SessionNamingSettingsStore.memory(SETTINGS), {});

		for (const prefix of ["", "s", "SET"]) {
			expect(host.getAutonameCompletions(prefix)).toEqual([{ label: "settings", value: "settings" }]);
		}
		expect(host.getAutonameCompletions("settings")).toBeNull();
		expect(host.getAutonameCompletions("unknown")).toBeNull();
		expect(host.getAutonameCompletions("settings ")).toBeNull();
		expect(host.getAutonameCompletions("settings extra")).toBeNull();
	});

	test("applies automatic naming changes immediately while keeping explicit /autoname available", async () => {
		const host = hostHarness();
		const settings = SessionNamingSettingsStore.memory(SETTINGS);
		installSessionNamingCapability(host.pi, settings, {});
		await host.emitLifecycle("session_start");

		await Effect.runPromise(settings.update({ enabled: false }));
		host.emitSettled();
		await Promise.resolve();
		expect(host.name()).toBeUndefined();

		await host.runAutoname("setings");
		expect(host.name()).toBeUndefined();
		expect(host.notices.at(-1)).toBe("Usage: /autoname [settings]");

		await host.runAutoname();
		expect(host.name()).toBe("automatic Session naming");
	});

	test("does not automatically rename a Child Agent Session", async () => {
		const host = hostHarness();
		installSessionNamingCapability(host.pi, SessionNamingSettingsStore.memory(SETTINGS), { PI_SUBAGENT_CHILD: "1" });
		await host.emitLifecycle("session_start");
		host.emitSettled();

		await Promise.resolve();
		expect(host.name()).toBeUndefined();
	});

	test("ignores name events from a replaced Session context", async () => {
		const host = hostHarness();
		installSessionNamingCapability(host.pi, SessionNamingSettingsStore.memory(SETTINGS), {});
		await host.emitLifecycle("session_start");
		const replacementContext: ExtensionContext = { ...host.context };
		await host.emitLifecycle("session_start", replacementContext);

		const entryCount = host.entries.length;
		await host.emitSessionInfoChanged("stale Session name", host.context);
		expect(host.entries).toHaveLength(entryCount);
	});

	for (const ending of ["Session replacement", "settings rebuild"] as const) {
		test(`interrupts a pending generation on ${ending} and rejects its late result`, async () => {
			const pending = Promise.withResolvers<AssistantMessage>();
			const started = Promise.withResolvers<void>();
			let providerSignal: AbortSignal | undefined;
			const host = hostHarness((_model, _context, options) => {
				providerSignal = options?.signal;
				started.resolve();
				return pending.promise;
			});
			const settings = SessionNamingSettingsStore.memory(SETTINGS);
			installSessionNamingCapability(host.pi, settings, {});
			await host.emitLifecycle("session_start");
			host.emitSettled();
			await started.promise;

			if (ending === "Session replacement") {
				await host.emitLifecycle("session_start", { ...host.context });
			} else {
				await Effect.runPromise(settings.update({ enabled: false }));
			}
			for (let attempt = 0; attempt < 20 && !providerSignal?.aborted; attempt += 1) await Promise.resolve();
			expect(providerSignal?.aborted).toBe(true);

			pending.resolve(response("Stale Session Name"));
			await Promise.resolve();
			expect(host.name()).toBeUndefined();
			expect(host.entries).toHaveLength(2);
		});
	}
});
