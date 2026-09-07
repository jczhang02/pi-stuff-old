import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createExtensionApi } from "../../fixtures/extension-api.js";
import { createExtensionContext } from "../../fixtures/extension-context.js";

interface HarnessEvent {
	readonly reason?: string;
	readonly type?: string;
}
type Handler = (event: HarnessEvent, ctx: ExtensionContext) => object | undefined | Promise<object | undefined>;
type ContextModule = typeof import("../../../packages/pi-stuff/src/context-management/index.js");
type ExtensionEventListener = Parameters<ExtensionAPI["events"]["on"]>[1];
type ExtensionEventPayload = Parameters<ExtensionEventListener>[0];

class EventBusHarness {
	private readonly listeners = new Map<string, Set<ExtensionEventListener>>();

	emit(event: string, data: ExtensionEventPayload): void {
		for (const listener of Array.from(this.listeners.get(event) ?? [])) listener(data);
	}

	on(event: string, listener: ExtensionEventListener): () => void {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return () => listeners.delete(listener);
	}
}

test("physical Context Module copies share one Host runtime", async () => {
	const directory = mkdtempSync(join(process.cwd(), ".pi-stuff-context-duplicates-"));
	const firstDirectory = join(directory, "first", "src", "context-management");
	const secondDirectory = join(directory, "second", "src", "context-management");
	for (const copy of [firstDirectory, secondDirectory]) {
		mkdirSync(copy, { recursive: true });
		cpSync(join(process.cwd(), "packages/pi-stuff/src/context-management"), copy, { recursive: true });
		const sourceRoot = join(copy, "..");
		const packageRoot = join(sourceRoot, "..");
		symlinkSync(join(process.cwd(), "packages/pi-stuff/node_modules"), join(packageRoot, "node_modules"), "dir");
		symlinkSync(join(process.cwd(), "packages/pi-stuff/src/shared"), join(sourceRoot, "shared"), "dir");
		symlinkSync(join(process.cwd(), "packages/pi-stuff/src/tool-display"), join(sourceRoot, "tool-display"), "dir");
		symlinkSync(
			join(process.cwd(), "packages/pi-stuff/src/conversation-ui"),
			join(sourceRoot, "conversation-ui"),
			"dir",
		);
		symlinkSync(
			join(process.cwd(), "packages/pi-stuff/src/lifecycle-deadline.ts"),
			join(sourceRoot, "lifecycle-deadline.ts"),
			"file",
		);
	}

	let first: ContextModule | undefined;
	try {
		// SAFETY: this test controls the value and supplies every ContextModule member exercised by this case.
		first = (await import(pathToFileURL(join(firstDirectory, "index.ts")).href)) as ContextModule;
		// SAFETY: this test controls the value and supplies every ContextModule member exercised by this case.
		const second = (await import(pathToFileURL(join(secondDirectory, "index.ts")).href)) as ContextModule;
		const bus = new EventBusHarness();
		let activeTools: string[] = [];
		const createApi = () => {
			const handlers = new Map<string, Handler[]>();
			// SAFETY: this test adapter records every Host event callback without changing its arguments or result.
			const on = ((event: string, handler: Handler) => {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			}) as ExtensionAPI["on"];
			const api = createExtensionApi({
				events: {
					emit: (event, data) => bus.emit(event, data),
					on: (event, listener) => bus.on(event, listener),
				},
				registerCommand() {},
				registerEntryRenderer() {},
				on,
				registerTool(tool: { name: string }) {
					if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
				},
				getActiveTools: () => [...activeTools],
				setActiveTools(names: string[]) {
					activeTools = [...names];
				},
			});
			return { api, handlers };
		};
		const firstApi = createApi();
		const secondApi = createApi();
		let firstLoads = 0;
		let secondLoads = 0;
		await first.default(firstApi.api, {
			loadMagicContext: async () => {
				firstLoads++;
				return {
					default: async (magicApi: ExtensionAPI) => {
						magicApi.on("context", (event) => event);
					},
				};
			},
		});
		const ctx = createExtensionContext({
			cwd: "/workspace/duplicate",
			sessionManager: {
				buildContextEntries: () => [],
				getSessionFile: () => "/sessions/duplicate.jsonl",
				getSessionId: () => "duplicate",
			},
		});
		for (const handler of firstApi.handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "startup" }, ctx);
		}
		for (const handler of firstApi.handlers.get("before_agent_start") ?? []) await handler({}, ctx);

		await second.default(secondApi.api, {
			loadMagicContext: async () => {
				secondLoads++;
				return { default: async () => undefined };
			},
		});
		expect(firstLoads).toBe(1);
		expect(secondLoads).toBe(0);
		expect(firstApi.handlers.get("context")).toHaveLength(1);
		expect(secondApi.handlers.get("context") ?? []).toHaveLength(0);
		expect(second.getContextCapability(ctx).status().state).toBe("active");
	} finally {
		await first?.__test.clear();
		rmSync(directory, { recursive: true, force: true });
	}
});
