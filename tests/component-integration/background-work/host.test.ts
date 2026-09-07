import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	MessageRenderOptions,
	TerminalInputHandler,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import piStuffWork, {
	type BackgroundWorkOutcome,
	type CompletionDetails,
} from "../../../packages/pi-stuff/src/background-work/index.js";
import type { BackgroundWorkRuntime } from "../../../packages/pi-stuff/src/background-work/src/runtime.js";
import type {
	SuiteAgentMessage,
	SuiteAgentMessageOptions,
} from "../../../packages/pi-stuff/src/conversation-ui/suite-agent-message.js";
import { SELF_RENDERED_TRANSCRIPT_PADDING } from "../../../packages/pi-stuff/src/conversation-ui/transcript.js";
import { createExtensionApi } from "../../fixtures/extension-api.js";
import { createExtensionCommandContext } from "../../fixtures/extension-context.js";

interface HostEvent {
	readonly type: string;
}
type Handler = (event: HostEvent, context: ExtensionContext) => object | undefined | Promise<object | undefined>;
type CompletionRenderer = (
	message: { readonly details?: CompletionDetails },
	options: MessageRenderOptions,
	theme: Theme,
) => Component | undefined;

function outcome(status: BackgroundWorkOutcome["status"], summary: string): BackgroundWorkOutcome {
	return {
		endedAt: 2,
		id: status,
		kind: "shell",
		startedAt: 1,
		status,
		summary,
		title: summary,
	};
}

class HostHarness {
	readonly activeTools = new Set<string>(["bash"]);
	readonly commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
	readonly handlers = new Map<string, Handler[]>();
	readonly messages: Array<{ readonly message: SuiteAgentMessage; readonly options: SuiteAgentMessageOptions }> = [];
	readonly renderers = new Map<string, CompletionRenderer>();
	readonly tools = new Map<string, ToolDefinition<TSchema, unknown>>();
	terminalInput: TerminalInputHandler | undefined;

	readonly api: ExtensionAPI;

	constructor() {
		// SAFETY: this test adapter records every Host event callback without changing its arguments or result.
		const on = ((event: string, handler: Handler) => {
			const handlers = this.handlers.get(event) ?? [];
			handlers.push(handler);
			this.handlers.set(event, handlers);
		}) as ExtensionAPI["on"];
		this.api = createExtensionApi({
			getActiveTools: () => [...this.activeTools],
			on,
			registerCommand: (name, command) => {
				this.commands.set(name, command);
			},
			registerMessageRenderer: (name, renderer) => {
				// SAFETY: Pi Stuff Work registers this renderer with CompletionDetails and reads no other message fields.
				this.renderers.set(name, renderer as CompletionRenderer);
			},
			registerTool: (tool) => {
				// SAFETY: this test registry erases only generic renderer state and retains the original Tool object.
				const stored = tool as ToolDefinition<TSchema, unknown>;
				this.tools.set(stored.name, stored);
				this.activeTools.add(stored.name);
			},
			setActiveTools: (names) => {
				this.activeTools.clear();
				for (const name of names) this.activeTools.add(name);
			},
			sendMessage: (message, options) => this.messages.push({ message, options }),
		});
	}

	context(cwd: string): ExtensionCommandContext {
		return createExtensionCommandContext({
			cwd,
			hasUI: true,
			isProjectTrusted: () => true,
			mode: "tui",
			model: undefined,
			sessionManager: {
				getSessionFile: () => join(cwd, "session.jsonl"),
				getSessionId: () => "host-test",
			},
			thinkingLevel: "off",
			ui: {
				onTerminalInput: (handler: TerminalInputHandler) => {
					this.terminalInput = handler;
					return () => {
						if (this.terminalInput === handler) this.terminalInput = undefined;
					};
				},
			},
		});
	}

	async emit(event: string, context: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) await handler({ type: event }, context);
	}
}

const roots: string[] = [];

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(25);
	}
	throw new Error("timed out waiting for condition");
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

test("registers historical renderers, reclaims live Bash, and consumes Ctrl+B only during foreground Bash", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-work-host-"));
	roots.push(root);
	const host = new HostHarness();
	await piStuffWork(host.api);
	expect([...host.tools.keys()].sort()).toEqual(["background", "monitor"]);
	expect(host.commands.has("tasks")).toBe(true);
	expect(host.renderers.has("pi-stuff-background-work-result")).toBe(true);
	const renderer = host.renderers.get("pi-stuff-background-work-result");
	const markerColors: string[] = [];
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const component = renderer?.(
		{
			details: {
				outcomes: [
					outcome("completed", "Background Shell finished"),
					outcome("failed", "Monitor failed"),
					outcome("stopped", "Monitor stopped"),
				],
			},
		},
		{ expanded: false, outputPad: 0 },
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		{
			fg: (color: string, value: string) => {
				if (value === "•") markerColors.push(color);
				return value;
			},
		} as Theme,
	) as { render(width: number): string[] } | undefined;
	expect(component?.render(80).map((line) => line.trimEnd())).toEqual([
		" • Background Shell finished",
		" • Monitor failed",
		" • Monitor stopped",
	]);
	expect(markerColors).toEqual(["success", "error", "dim"]);
	const narrow = component?.render(24).map((line) => line.trimEnd()) ?? [];
	expect(
		narrow
			.filter((line) => line.includes("•"))
			.every((line) => line.indexOf("•") === SELF_RENDERED_TRANSCRIPT_PADDING),
	).toBe(true);
	expect(narrow.filter((line) => !line.includes("•")).every((line) => line.startsWith("   "))).toBe(true);

	const ctx = host.context(root);
	await host.emit("session_start", ctx);
	expect([...host.tools.keys()].sort()).toEqual(["background", "bash", "monitor"]);
	expect(host.terminalInput?.("\u0002")).toBeUndefined();
	const bash = host.tools.get("bash");
	if (!bash) throw new Error("Bash was not registered");
	const execution = bash.execute("host-bash", { command: "sleep 30" }, undefined, undefined, ctx);
	await Bun.sleep(100);
	expect(host.terminalInput?.("\u0002")).toEqual({ consume: true });
	const result = await execution;
	const content = result.content.find((item) => item.type === "text");
	expect(content?.type === "text" ? content.text : "").toContain("manually moved to background task");
	expect(host.terminalInput?.("\u0002")).toBeUndefined();
	await host.emit("session_shutdown", ctx);
	expect(host.terminalInput).toBeUndefined();
});

test("queries a completed Background Shell by its task ID", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-work-host-"));
	roots.push(root);
	const host = new HostHarness();
	await piStuffWork(host.api);
	const ctx = host.context(root);
	await host.emit("session_start", ctx);

	const bash = host.tools.get("bash");
	const background = host.tools.get("background");
	if (!bash || !background) throw new Error("Background Work tools were not registered");
	const launched = await bash.execute(
		"host-background-terminal",
		{ command: "sleep 0.1; printf 'TERMINAL-OUTPUT\\n'", run_in_background: true },
		undefined,
		undefined,
		ctx,
	);
	const launchText = launched.content.find((item) => item.type === "text");
	const taskId = (launchText?.type === "text" ? launchText.text : "").match(/background task ([a-z0-9]+)/u)?.[1];
	expect(taskId).toBeString();
	await waitUntil(() => host.messages.length === 1);

	const output = await background.execute(
		"host-background-output",
		{ action: "output", task_id: taskId },
		undefined,
		undefined,
		ctx,
	);
	expect(output.details).toMatchObject({ action: "output", status: "read", taskId });
	const outputText = output.content.find((item) => item.type === "text");
	expect(outputText?.type === "text" ? outputText.text : "").toContain("completed");
	expect(outputText?.type === "text" ? outputText.text : "").toContain("TERMINAL-OUTPUT");

	const stopped = await background.execute(
		"host-background-stop-terminal",
		{ action: "stop", task_id: taskId },
		undefined,
		undefined,
		ctx,
	);
	expect(stopped.details).toMatchObject({ action: "stop", status: "completed", taskId });
	const stoppedText = stopped.content.find((item) => item.type === "text");
	expect(stoppedText?.type === "text" ? stoppedText.text : "").toContain("completed");

	await host.emit("session_shutdown", ctx);
});

test("does not make a replacement Session wait for the previous runtime shutdown", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-work-host-race-"));
	roots.push(root);
	const host = new HostHarness();
	let releaseShutdown: (() => void) | undefined;
	const created: Array<{ shutdownCalls: number }> = [];
	await piStuffWork(host.api, {
		createRuntime: () => {
			const record = { shutdownCalls: 0 };
			created.push(record);
			// SAFETY: this test controls the value and supplies every BackgroundWorkRuntime member exercised by this case.
			return {
				detachActiveForeground: () => false,
				prepare: async () => {},
				shutdown: async () => {
					record.shutdownCalls += 1;
					if (record === created[0]) await new Promise<void>((resolve) => (releaseShutdown = resolve));
				},
			} as BackgroundWorkRuntime;
		},
	});
	const ctx = host.context(root);
	await host.emit("session_start", ctx);
	const restarting = host.emit("session_start", ctx);
	while (!releaseShutdown) await Bun.sleep(1);
	const shuttingDown = host.emit("session_shutdown", ctx);
	releaseShutdown();
	await Promise.all([restarting, shuttingDown]);

	expect(created).toHaveLength(2);
	expect(created[0]?.shutdownCalls).toBe(1);
	expect(created[1]?.shutdownCalls).toBe(1);
	expect(host.terminalInput).toBeUndefined();
});

test("lets only the newest overlapping session_start create a replacement runtime", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-work-host-overlap-"));
	roots.push(root);
	const host = new HostHarness();
	let releaseShutdown: (() => void) | undefined;
	const created: Array<{ shutdownCalls: number }> = [];
	await piStuffWork(host.api, {
		createRuntime: () => {
			const record = { shutdownCalls: 0 };
			created.push(record);
			// SAFETY: this test controls the value and supplies every BackgroundWorkRuntime member exercised by this case.
			return {
				detachActiveForeground: () => false,
				prepare: async () => {},
				shutdown: async () => {
					record.shutdownCalls += 1;
					if (record === created[0]) await new Promise<void>((resolve) => (releaseShutdown = resolve));
				},
			} as BackgroundWorkRuntime;
		},
	});
	const ctx = host.context(root);
	await host.emit("session_start", ctx);
	const first = host.emit("session_start", ctx);
	while (!releaseShutdown) await Bun.sleep(1);
	const second = host.emit("session_start", ctx);
	releaseShutdown();
	await Promise.all([first, second]);

	expect(created).toHaveLength(3);
	expect(created[0]?.shutdownCalls).toBe(1);
	expect(created[1]?.shutdownCalls).toBe(1);
	expect(created[2]?.shutdownCalls).toBe(0);
	await host.emit("session_shutdown", ctx);
	expect(created[2]?.shutdownCalls).toBe(1);
});
