import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentToolResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionEvent,
	SessionEntry,
	ToolDefinition,
	ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import piStuffTools, {
	assertSuiteToolActivityCoverage,
	configureSuiteToolReplay,
	createSuiteToolRegistrationTracker,
	registerSuiteOwnedTool,
	type ToolArguments,
} from "../../../packages/pi-stuff/src/tool-display/index.js";
import { createExtensionApi } from "../../fixtures/extension-api.js";
import { createExtensionContext } from "../../fixtures/extension-context.js";

type EventHandler = (event: ExtensionEvent, ctx: ExtensionContext) => object | undefined | Promise<object | undefined>;
const HOST_BUILTINS = new Set(["bash", "edit", "find", "grep", "ls", "powershell", "read", "write"]);

class EventBusHarness {
	private readonly listeners = new Map<string, Set<Parameters<ExtensionAPI["events"]["on"]>[1]>>();

	view(): ExtensionAPI["events"] {
		return {
			emit: (event, data) => {
				for (const listener of Array.from(this.listeners.get(event) ?? [])) listener(data);
			},
			on: (event, listener) => {
				const listeners = this.listeners.get(event) ?? new Set();
				listeners.add(listener);
				this.listeners.set(event, listeners);
				return () => listeners.delete(listener);
			},
		};
	}
}

interface ApiHarness {
	readonly api: ExtensionAPI;
	readonly tools: Map<string, ToolDefinition>;
	emit(type: ExtensionEvent["type"], event: ExtensionEvent, ctx: ExtensionContext): Promise<void>;
	getActiveTools(): readonly string[];
	handlerCount(type: ExtensionEvent["type"]): number;
	setActiveTools(names: readonly string[]): void;
}

function apiHarness(initialActiveTools: readonly string[], eventBus = new EventBusHarness()): ApiHarness {
	const handlers = new Map<string, EventHandler[]>();
	const tools = new Map<string, ToolDefinition>();
	let activeTools = [...initialActiveTools];
	// SAFETY: this test adapter records every Host event callback without changing its arguments or result.
	const on = ((type: string, handler: EventHandler) => {
		handlers.set(type, [...(handlers.get(type) ?? []), handler]);
	}) as ExtensionAPI["on"];
	const api = createExtensionApi({
		events: eventBus.view(),
		getActiveTools: () => [...activeTools],
		getAllTools: () =>
			[...tools.values()].map((tool): ToolInfo => {
				const info: ToolInfo = {
					description: tool.description,
					name: tool.name,
					parameters: tool.parameters,
					sourceInfo: { origin: "top-level", path: "<test>", scope: "temporary", source: "test" },
				};
				if (tool.promptGuidelines !== undefined) info.promptGuidelines = tool.promptGuidelines;
				return info;
			}),
		on,
		registerCommand: () => {},
		registerTool: (tool) => {
			// SAFETY: this test registry erases only generic renderer state and retains the original Tool object.
			const stored = tool as ToolDefinition;
			tools.set(stored.name, stored);
			if (!HOST_BUILTINS.has(stored.name) && !activeTools.includes(stored.name)) activeTools.push(stored.name);
		},
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
	});
	return {
		api,
		tools,
		emit: async (type, event, ctx) => {
			for (const handler of handlers.get(type) ?? []) await handler(event, ctx);
		},
		getActiveTools: () => [...activeTools],
		handlerCount: (type) => handlers.get(type)?.length ?? 0,
		setActiveTools: (names) => {
			activeTools = [...names];
		},
	};
}

function context(cwd: string, branch: readonly SessionEntry[] = []): ExtensionContext {
	return createExtensionContext({
		cwd,
		isProjectTrusted: () => true,
		sessionManager: { getBranch: () => [...branch] },
	});
}

function historicalToolBranch(name: string, args: ToolArguments, resultText: string): readonly SessionEntry[] {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	// SAFETY: this test controls the value and supplies every SessionEntry member exercised by this case.
	return [
		{
			id: "historical-tool-call",
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: "historical-call", name, arguments: args }],
				api: "openai-completions",
				provider: "fixture",
				model: "fixture",
				usage,
				stopReason: "toolUse",
				timestamp: 1,
			},
			parentId: null,
			timestamp: "2026-08-21T00:00:00.000Z",
			type: "message",
		},
		{
			id: "historical-tool-result",
			message: {
				role: "toolResult",
				toolCallId: "historical-call",
				toolName: name,
				content: [{ type: "text", text: resultText }],
				isError: false,
				timestamp: 2,
			},
			parentId: "historical-tool-call",
			timestamp: "2026-08-21T00:00:01.000Z",
			type: "message",
		},
	] as SessionEntry[];
}

async function installTrackedTools(host: ReturnType<typeof apiHarness>) {
	const registrations = createSuiteToolRegistrationTracker(host.api);
	await piStuffTools(registrations.api);
	return registrations;
}

test("Tool lifecycle installation deduplicates per-extension facades on one Host event bus", async () => {
	const eventBus = new EventBusHarness();
	const owner = apiHarness(["read"], eventBus);
	const duplicate = apiHarness(["read"], eventBus);
	await piStuffTools(owner.api);
	await piStuffTools(duplicate.api);

	expect(owner.handlerCount("session_start")).toBeGreaterThan(0);
	expect(owner.handlerCount("session_shutdown")).toBeGreaterThan(0);
	expect(owner.handlerCount("tool_execution_start")).toBe(1);
	expect(owner.handlerCount("tool_execution_update")).toBe(1);
	expect(owner.handlerCount("tool_execution_end")).toBe(1);
	expect(duplicate.handlerCount("session_start")).toBe(0);
	expect(duplicate.handlerCount("session_shutdown")).toBe(0);
	await owner.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/project"));
});

test("normal installation does not add replay-only Tool definitions", async () => {
	const host = apiHarness(["read", "fixture_state"]);
	const registrations = await installTrackedTools(host);
	configureSuiteToolReplay(registrations.api, registrations.toolNames, ["subagent_supervisor"]);
	expect(host.tools.size).toBe(0);
	await host.emit("session_start", { reason: "startup", type: "session_start" }, context("/project"));
	expect(host.tools.has("subagent_supervisor")).toBe(false);
	expect(host.getActiveTools()).toEqual(["read", "fixture_state"]);
	await host.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/project"));
});

test("cold Session binds only declared Suite renderers present in history", async () => {
	const host = apiHarness(["read", "fixture_state"]);
	const registrations = await installTrackedTools(host);
	configureSuiteToolReplay(registrations.api, registrations.toolNames, ["subagent_supervisor", "intercom"]);
	expect(host.tools.has("subagent_supervisor")).toBe(false);
	const branch = historicalToolBranch("subagent_supervisor", { action: "pending" }, "No pending supervisor requests.");
	let branchReads = 0;
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const targetContext = {
		...context("/target"),
		sessionManager: {
			getBranch: () => {
				branchReads += 1;
				return branch;
			},
		},
	} as ExtensionContext;

	await host.emit("session_start", { reason: "startup", type: "session_start" }, targetContext);

	const replay = host.tools.get("subagent_supervisor");
	expect(replay?.renderShell).toBe("self");
	expect(replay?.renderCall).toBeFunction();
	expect(replay?.renderResult).toBeFunction();
	expect(host.tools.has("intercom")).toBe(false);
	expect(host.getActiveTools()).toEqual(["read", "fixture_state"]);
	expect(branchReads).toBe(1);
	await host.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/target"));
});

test("production replay catalog covers conditional child Tools", async () => {
	// SAFETY: this test controls the serialized JSON fixture and exercises only the asserted fields.
	const suite = JSON.parse(
		await readFile(new URL("../../../packages/pi-stuff/suite.json", import.meta.url), "utf8"),
	) as {
		readonly deferredTools?: readonly string[];
		readonly optionalTools?: readonly string[];
		readonly tools?: readonly string[];
	};
	const replayNames = [...(suite.tools ?? []), ...(suite.deferredTools ?? []), ...(suite.optionalTools ?? [])];

	for (const name of ["contact_supervisor", "structured_output"]) {
		expect(replayNames).toContain(name);
		const host = apiHarness(["read", "fixture_state"]);
		const registrations = await installTrackedTools(host);
		configureSuiteToolReplay(registrations.api, registrations.toolNames, replayNames);

		await host.emit(
			"session_start",
			{ reason: "startup", type: "session_start" },
			context("/target", historicalToolBranch(name, {}, "done")),
		);

		expect(host.tools.get(name)?.renderShell).toBe("self");
		expect(host.getActiveTools()).toEqual(["read", "fixture_state"]);
		await host.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/target"));
	}
});

test("cold Session does not replace a live same-name Tool", async () => {
	const host = apiHarness(["read", "fixture_state"]);
	// SAFETY: this test controls the value and supplies every ToolDefinition member exercised by this case.
	const external = {
		name: "subagent_supervisor",
		label: "External Supervisor",
		description: "same-name live Tool",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text" as const, text: "external" }], details: {} }),
	} as ToolDefinition;
	host.api.registerTool(external);
	const registrations = await installTrackedTools(host);
	configureSuiteToolReplay(registrations.api, registrations.toolNames, ["subagent_supervisor"]);

	await host.emit(
		"session_start",
		{ reason: "startup", type: "session_start" },
		context("/target", historicalToolBranch("subagent_supervisor", { action: "pending" }, "external")),
	);

	expect(host.tools.get("subagent_supervisor")).toBe(external);
	expect(host.getActiveTools()).toContain("subagent_supervisor");
	await host.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/target"));
});

test("tree and compaction reconstruction bind newly visible historical Suite renderers", async () => {
	for (const type of ["session_tree", "session_compact"] as const) {
		const host = apiHarness(["read", "fixture_state"]);
		const registrations = await installTrackedTools(host);
		configureSuiteToolReplay(registrations.api, registrations.toolNames, ["subagent_supervisor"]);
		await host.emit("session_start", { reason: "startup", type: "session_start" }, context("/target"));
		const activeTools = host.getActiveTools();

		await host.emit(
			type,
			// SAFETY: this test controls the value and supplies every ExtensionEvent member exercised by this case.
			{ type } as ExtensionEvent,
			context("/target", historicalToolBranch("subagent_supervisor", { action: "pending" }, "No pending requests.")),
		);

		expect(host.tools.get("subagent_supervisor")?.renderShell).toBe("self");
		expect(host.getActiveTools()).toEqual(activeTools);
		await host.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/target"));
	}
});

test("resume fallback retains only Tools registered through the Suite composition root", async () => {
	const outgoing = apiHarness(["read", "fixture_state"]);
	await installTrackedTools(outgoing);
	await outgoing.emit("session_start", { reason: "startup", type: "session_start" }, context("/outgoing"));
	registerSuiteOwnedTool(
		outgoing.api,
		{
			name: "external_fixture",
			label: "External Fixture",
			description: "owned-looking Tool outside the Suite composition root",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		},
		{
			activity: { categories: ["check-agent"], classify: () => [{ category: "check-agent", count: 1 }] },
			summarize: () => "checked",
		},
	);
	await outgoing.emit(
		"session_shutdown",
		{ reason: "resume", targetSessionFile: "/sessions/target.jsonl", type: "session_shutdown" },
		context("/outgoing"),
	);

	const incoming = apiHarness(["read", "fixture_state"]);
	const registrations = await installTrackedTools(incoming);
	configureSuiteToolReplay(registrations.api, registrations.toolNames);
	expect(incoming.tools.has("external_fixture")).toBe(false);
	await incoming.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/target"));
});

test("resume binds every known built-in renderer before historical rows are reconstructed", async () => {
	const outgoing = apiHarness(["read", "grep", "fixture_state"]);
	await installTrackedTools(outgoing);
	await outgoing.emit("session_start", { reason: "startup", type: "session_start" }, context("/outgoing"));
	await outgoing.emit(
		"session_shutdown",
		{ reason: "resume", targetSessionFile: "/sessions/target.jsonl", type: "session_shutdown" },
		context("/outgoing"),
	);

	const incoming = apiHarness(["read", "bash", "edit", "write", "fixture_state"]);
	const incomingRegistrations = await installTrackedTools(incoming);
	configureSuiteToolReplay(incomingRegistrations.api, incomingRegistrations.toolNames);

	await incoming.emit("session_start", { reason: "resume", type: "session_start" }, context("/target"));
	expect([...incoming.tools.keys()].sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
	expect(incoming.getActiveTools()).toEqual(["read", "grep", "fixture_state"]);

	await incoming.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/target"));
});

test("resume binds every historical missing Suite Tool renderer without changing the active Tool set", async () => {
	const outgoing = apiHarness(["read", "subagent_supervisor", "fixture_state"]);
	const outgoingRegistrations = await installTrackedTools(outgoing);
	await outgoing.emit("session_start", { reason: "startup", type: "session_start" }, context("/outgoing"));
	registerSuiteOwnedTool(
		outgoingRegistrations.api,
		{
			name: "subagent_supervisor",
			label: "Subagent Supervisor",
			description: "fixture conditional Suite Tool",
			parameters: Type.Object({ action: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "No pending requests." }], details: {} }),
		},
		{
			activity: { categories: ["check-agent"], classify: () => [{ category: "check-agent", count: 1 }] },
			runningSummary: "checking",
			summarize: () => "checked",
		},
	);
	await outgoing.emit(
		"session_shutdown",
		{ reason: "resume", targetSessionFile: "/sessions/target.jsonl", type: "session_shutdown" },
		context("/outgoing"),
	);

	const incoming = apiHarness(["read", "bash", "fixture_state"]);
	const incomingRegistrations = await installTrackedTools(incoming);
	configureSuiteToolReplay(incomingRegistrations.api, incomingRegistrations.toolNames);

	await incoming.emit(
		"session_start",
		{ reason: "resume", type: "session_start" },
		context("/target", historicalToolBranch("subagent_supervisor", { action: "pending" }, "No pending requests.")),
	);
	const replay = incoming.tools.get("subagent_supervisor");
	expect(replay?.renderShell).toBe("self");
	expect(replay?.renderCall).toBeFunction();
	expect(replay?.renderResult).toBeFunction();
	expect(incoming.getActiveTools()).toEqual(["read", "fixture_state"]);
	await incoming.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/target"));
});

test("resume binds a historical optional renderer before its runtime has ever activated", async () => {
	const outgoing = apiHarness(["read", "fixture_state"]);
	await installTrackedTools(outgoing);
	await outgoing.emit("session_start", { reason: "startup", type: "session_start" }, context("/outgoing"));
	await outgoing.emit(
		"session_shutdown",
		{ reason: "resume", targetSessionFile: "/sessions/target.jsonl", type: "session_shutdown" },
		context("/outgoing"),
	);

	const incoming = apiHarness(["read", "fixture_state"]);
	const registrations = await installTrackedTools(incoming);
	configureSuiteToolReplay(registrations.api, registrations.toolNames, ["subagent_supervisor"]);

	await incoming.emit(
		"session_start",
		{ reason: "resume", type: "session_start" },
		context("/target", historicalToolBranch("subagent_supervisor", { action: "pending" }, "No pending requests.")),
	);
	const replay = incoming.tools.get("subagent_supervisor");
	expect(replay?.renderShell).toBe("self");
	expect(replay?.renderCall).toBeFunction();
	expect(replay?.renderResult).toBeFunction();
	expect(incoming.getActiveTools()).toEqual(["read", "fixture_state"]);
	expect(() =>
		assertSuiteToolActivityCoverage(
			incoming.api,
			[...HOST_BUILTINS].filter((name) => name !== "powershell"),
			registrations.toolNames,
			["subagent_supervisor"],
		),
	).not.toThrow();
	await incoming.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/target"));
});

test("reload uses the same missing-only renderer fallback", async () => {
	const outgoing = apiHarness(["read", "powershell", "fixture_state"]);
	const outgoingRegistrations = await installTrackedTools(outgoing);
	await outgoing.emit("session_start", { reason: "startup", type: "session_start" }, context("/project"));
	registerSuiteOwnedTool(
		outgoingRegistrations.api,
		{
			name: "conditional_tool",
			label: "Conditional Tool",
			description: "fixture conditional Suite Tool",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
		},
		{
			activity: { categories: ["check-agent"], classify: () => [{ category: "check-agent", count: 1 }] },
			summarize: () => "checked",
		},
	);
	await outgoing.emit("session_shutdown", { reason: "reload", type: "session_shutdown" }, context("/project"));

	const incoming = apiHarness(["read", "powershell", "fixture_state"]);
	const incomingRegistrations = await installTrackedTools(incoming);
	configureSuiteToolReplay(incomingRegistrations.api, incomingRegistrations.toolNames);
	await incoming.emit(
		"session_start",
		{ reason: "reload", type: "session_start" },
		context("/project", historicalToolBranch("conditional_tool", {}, "done")),
	);
	expect(incoming.tools.get("conditional_tool")?.renderShell).toBe("self");
	expect(incoming.getActiveTools()).toEqual(["fixture_state", "read", "powershell"]);
	await incoming.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/project"));
});

test("resume preserves default, disabled, and allowlisted built-in membership exactly", async () => {
	for (const expected of [["bash", "edit", "read", "write"], [], ["find", "grep", "ls"], ["powershell"]] as const) {
		const outgoing = apiHarness([...expected, "fixture_state"]);
		await installTrackedTools(outgoing);
		await outgoing.emit("session_start", { reason: "startup", type: "session_start" }, context("/outgoing"));
		await outgoing.emit(
			"session_shutdown",
			{ reason: "resume", targetSessionFile: "/sessions/target.jsonl", type: "session_shutdown" },
			context("/outgoing"),
		);

		const incoming = apiHarness(["read", "bash", "edit", "write", "powershell", "fixture_state"]);
		const incomingRegistrations = await installTrackedTools(incoming);
		configureSuiteToolReplay(incomingRegistrations.api, incomingRegistrations.toolNames);

		await incoming.emit("session_start", { reason: "resume", type: "session_start" }, context("/target"));
		expect([...incoming.tools.keys()].sort()).toEqual(["bash", "edit", "find", "grep", "ls", "read", "write"]);
		expect(incoming.getActiveTools()).toEqual([...expected, "fixture_state"]);
		await incoming.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context("/target"));
	}
});

test("resumed built-ins execute against the target cwd and trusted project settings", async () => {
	const directory = await mkdtemp(join(tmpdir(), "pi-stuff-tools-resume-cwd-"));
	const outgoingDirectory = join(directory, "outgoing");
	const targetDirectory = join(directory, "target");
	await Promise.all([mkdir(outgoingDirectory), mkdir(join(targetDirectory, ".pi"), { recursive: true })]);
	await Promise.all([
		writeFile(join(targetDirectory, "target.txt"), "TARGET_CWD_CONTENT\n"),
		writeFile(
			join(targetDirectory, ".pi", "settings.json"),
			`${JSON.stringify({ shellCommandPrefix: "printf 'TARGET_PROJECT_PREFIX\\n';" })}\n`,
		),
	]);

	try {
		const outgoing = apiHarness(["read", "bash"]);
		await installTrackedTools(outgoing);
		await outgoing.emit("session_start", { reason: "startup", type: "session_start" }, context(outgoingDirectory));
		await outgoing.emit(
			"session_shutdown",
			{ reason: "resume", targetSessionFile: "/sessions/target.jsonl", type: "session_shutdown" },
			context(outgoingDirectory),
		);

		const incoming = apiHarness(["read", "bash"]);
		const incomingRegistrations = await installTrackedTools(incoming);
		configureSuiteToolReplay(incomingRegistrations.api, incomingRegistrations.toolNames);
		await incoming.emit("session_start", { reason: "resume", type: "session_start" }, context(targetDirectory));

		const read = incoming.tools.get("read");
		const bash = incoming.tools.get("bash");
		if (!read || !bash) throw new Error("Expected resumed Read and Bash definitions");
		const readResult = await read.execute(
			"read-target",
			{ path: "target.txt" },
			new AbortController().signal,
			undefined,
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			{} as never,
		);
		const bashResult = await bash.execute(
			"bash-target",
			{ command: "printf 'TARGET_BODY\\n'" },
			new AbortController().signal,
			undefined,
			// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
			undefined as never,
		);
		const text = (result: AgentToolResult<unknown>): string =>
			result.content
				.filter((part): part is { text: string; type: "text" } => part.type === "text")
				.map((part) => part.text)
				.join("\n");

		expect(text(readResult)).toContain("TARGET_CWD_CONTENT");
		expect(text(bashResult)).toContain("TARGET_PROJECT_PREFIX\nTARGET_BODY");
		await incoming.emit("session_shutdown", { reason: "quit", type: "session_shutdown" }, context(targetDirectory));
	} finally {
		await rm(directory, { force: true, recursive: true });
	}
});
