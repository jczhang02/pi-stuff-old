import { expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	TerminalInputHandler,
} from "@earendil-works/pi-coding-agent";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { listenForAgentWorkOriginQueries } from "../../../packages/pi-stuff/src/conversation-ui/agent-run-origin.js";
import { getUiSettingRegistry } from "../../../packages/pi-stuff/src/conversation-ui/index.js";
import {
	installNotificationCapability,
	type NotificationHost,
} from "../../../packages/pi-stuff/src/notification/index.js";
import type { NotificationClock } from "../../../packages/pi-stuff/src/notification/runtime.js";
import {
	DEFAULT_NOTIFICATION_SETTINGS,
	NotificationSettingsStore,
} from "../../../packages/pi-stuff/src/notification/settings.js";
import { createExtensionCommandContext, createExtensionContext } from "../../fixtures/extension-context.js";

type EventHandler = (
	event: ExtensionEvent,
	context: ExtensionContext,
) => object | undefined | Promise<object | undefined>;
type CommandSpec = Parameters<ExtensionAPI["registerCommand"]>[1];

interface NotificationHarness {
	readonly api: NotificationHost;
	readonly commands: Map<string, CommandSpec>;
	readonly handlers: Map<string, EventHandler[]>;
}

function harness(): NotificationHarness {
	const commands = new Map<string, CommandSpec>();
	const handlers = new Map<string, EventHandler[]>();
	// SAFETY: this test adapter records every Host event callback without changing its arguments or result.
	const on = ((type: string, handler: EventHandler) => {
		handlers.set(type, [...(handlers.get(type) ?? []), handler]);
	}) as ExtensionAPI["on"];
	return {
		api: {
			events: createEventBus(),
			on,
			registerCommand: (name, command) => {
				commands.set(name, command);
			},
		},
		commands,
		handlers,
	};
}

test("Notification owns a dedicated settings command and releases its terminal observer", async () => {
	const host = harness();
	const settings = NotificationSettingsStore.memory(DEFAULT_NOTIFICATION_SETTINGS);
	let cancelledTimers = 0;
	let scheduledTimers = 0;
	const clock: NotificationClock = {
		now: () => 0,
		schedule: () => {
			scheduledTimers += 1;
			let cancelled = false;
			return () => {
				if (cancelled) return;
				cancelled = true;
				cancelledTimers += 1;
			};
		},
	};
	const removeOrigin = listenForAgentWorkOriginQueries(host.api, () => "user");
	await installNotificationCapability(host.api, settings, clock);

	expect(getUiSettingRegistry(host.api).list()).toEqual([]);
	expect(host.commands.has("notifications")).toBeTrue();
	expect(host.commands.has("notify-test")).toBeFalse();
	expect(host.handlers.get("agent_settled")).toBeUndefined();
	expect(host.handlers.get("ui_prompt_start")).toHaveLength(1);
	expect(host.handlers.get("ui_prompt_end")).toHaveLength(1);
	const notices: string[] = [];
	await host.commands.get("notifications")?.handler(
		"",
		createExtensionCommandContext({
			hasUI: false,
			mode: "rpc",
			ui: { notify: (message: string) => notices.push(message) },
		}),
	);
	expect(notices).toEqual(["/notifications requires interactive TUI mode."]);

	let terminalInput: TerminalInputHandler | undefined;
	let terminalObserverRemovals = 0;
	const context = createExtensionContext({
		cwd: "/project",
		hasPendingMessages: () => false,
		hasUI: true,
		isIdle: () => true,
		mode: "tui",
		sessionManager: { getSessionName: () => "Notification test" },
		ui: {
			notify: () => {},
			onTerminalInput: (handler: TerminalInputHandler) => {
				terminalInput = handler;
				return () => {
					terminalObserverRemovals += 1;
					if (terminalInput === handler) terminalInput = undefined;
				};
			},
		},
	});
	for (const handler of host.handlers.get("session_start") ?? []) {
		await handler({ reason: "startup", type: "session_start" }, context);
	}
	expect(terminalInput).toBeFunction();
	expect(host.handlers.get("agent_settled")).toHaveLength(1);
	for (const handler of host.handlers.get("agent_start") ?? []) {
		await handler({ type: "agent_start" }, context);
	}
	for (const handler of host.handlers.get("message_start") ?? []) {
		await handler({ message: { content: "work", role: "user", timestamp: 0 }, type: "message_start" }, context);
	}
	for (const handler of host.handlers.get("agent_settled") ?? []) {
		await handler({ type: "agent_settled" }, context);
	}
	expect(scheduledTimers).toBe(1);
	for (const handler of host.handlers.get("session_start") ?? []) {
		await handler({ reason: "new", type: "session_start" }, context);
	}
	expect(cancelledTimers).toBe(1);
	expect(terminalObserverRemovals).toBe(1);
	expect(terminalInput).toBeFunction();
	expect(host.handlers.get("agent_settled")).toHaveLength(1);

	for (const handler of host.handlers.get("session_shutdown") ?? []) {
		await handler({ reason: "quit", type: "session_shutdown" }, context);
	}
	expect(terminalInput).toBeUndefined();
	expect(terminalObserverRemovals).toBe(2);
	removeOrigin();
});
