import { createEventBus, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRuntimeFunction, isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";

export function createExtensionApi(overrides: Partial<ExtensionAPI> = {}): ExtensionAPI {
	const api: ExtensionAPI = {
		appendEntry: () => undefined,
		events: createEventBus(),
		exec: async () => ({ code: 0, killed: false, stderr: "", stdout: "" }),
		getActiveTools: () => [],
		getAllTools: () => [],
		getCommands: () => [],
		getFlag: () => undefined,
		getSessionName: () => undefined,
		getThinkingLevel: () => "off",
		on: () => undefined,
		registerCommand: () => undefined,
		registerEntryRenderer: () => undefined,
		registerFlag: () => undefined,
		registerMarkdownTransformer: () => undefined,
		registerMessageRenderer: () => undefined,
		registerProvider: () => undefined,
		registerShortcut: () => undefined,
		registerTool: () => undefined,
		sendMessage: () => undefined,
		sendUserMessage: () => undefined,
		setActiveTools: () => undefined,
		setLabel: () => undefined,
		setModel: async () => false,
		setSessionName: () => undefined,
		setThinkingLevel: () => undefined,
		unregisterProvider: () => undefined,
		...overrides,
	};
	return api;
}

export function captureExtensionHandlers<Handler>(handlers: Map<string, Handler[]>): ExtensionAPI["on"] {
	return new Proxy(createExtensionApi().on, {
		apply(_target, _thisArg, [event, handler]) {
			if (!isRuntimeString(event) || !isRuntimeFunction(handler)) return undefined;
			// SAFETY: Test harnesses invoke captured callbacks only with the matching registered lifecycle payload.
			const captured = handler as Handler;
			handlers.set(event, [...(handlers.get(event) ?? []), captured]);
			return undefined;
		},
	});
}
