import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionEvent,
	Skill,
	Theme,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import piStuffCodeMode, {
	type CodeModeHost,
	decodeCodeModeOperations,
} from "../../../packages/pi-stuff/src/code-mode/extension.js";
import { INVALID_CODE_MODE_IMAGE_MESSAGE } from "../../../packages/pi-stuff/src/code-mode/image-content.js";
import {
	readCodeModeProjectEnabled,
	writeCodeModeProjectEnabled,
} from "../../../packages/pi-stuff/src/code-mode/settings.js";
import {
	applyContextPromptContributions,
	__test as promptContributionsTest,
} from "../../../packages/pi-stuff/src/context-management/prompt-contributions.js";
import { EffectFoundation } from "../../../packages/pi-stuff/src/shared/effect-foundation.js";
import { readHostProxyProperty } from "../../../packages/pi-stuff/src/shared/host-proxy.js";
import { isRuntimeObject, isRuntimeString } from "../../../packages/pi-stuff/src/shared/runtime-type.js";
import type {
	SuiteToolDefinitionRegistry,
	SuiteToolSurfaceController,
} from "../../../packages/pi-stuff/src/tool-display/contract.js";
import { getToolUiRuntime } from "../../../packages/pi-stuff/src/tool-display/contract.js";
import { createSuiteToolRegistrationTracker } from "../../../packages/pi-stuff/src/tool-display/registration.js";
import { createExtensionCommandContext } from "../../fixtures/extension-context.js";
import { toolRegistrationHarness } from "../../fixtures/tool-registration-host.js";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

type EventHandler = (event: ExtensionEvent, context: ExtensionContext) => object | undefined;

const roots: string[] = [];

const registry: SuiteToolDefinitionRegistry = {
	catalog: () => [],
	compensate: async () => false,
	get: () => undefined,
	invoke: async () => ({ isError: false, result: { content: [], details: {} } }),
	isActive: () => false,
	list: () => [],
};

test("Code Mode display reads only the newest bounded nested operations", () => {
	let operationReads = 0;
	const operations = new Proxy([], {
		get: (target, property) => {
			if (property === "length") return 100_000;
			if (/^\d+$/u.test(String(property))) {
				operationReads += 1;
				const index = Number(property);
				return { args: { value: index }, id: `nested-${String(index)}`, name: "read", state: "success" };
			}
			return readHostProxyProperty(target, property);
		},
	});

	const projected = decodeCodeModeOperations({ kind: "pi-stuff-code-mode", operations });
	expect(projected).toHaveLength(64);
	expect(projected[0]?.displayOnly).toBe("overflow");
	expect(projected[1]?.id).toBe("nested-99937");
	expect(projected.at(-1)?.id).toBe("nested-99999");
	expect(operationReads).toBe(63);
});

afterEach(async () => {
	promptContributionsTest.clear();
	await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function project(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-code-mode-extension-"));
	roots.push(root);
	return root;
}

function loadExtension(surface: SuiteToolSurfaceController, definitionRegistry = registry) {
	const commands = new Map<string, Command>();
	const events = new Map<string, EventHandler[]>();
	const { host, tools } = toolRegistrationHarness();
	// SAFETY: this test adapter records every Host event callback without changing its arguments or result.
	const on = ((name: string, handler: EventHandler) => {
		events.set(name, [...(events.get(name) ?? []), handler]);
	}) as ExtensionAPI["on"];
	const registerCommand: ExtensionAPI["registerCommand"] = (name, command) => {
		commands.set(name, command);
	};
	const hostApi: CodeModeHost = {
		...host,
		appendEntry: () => undefined,
		on,
		registerCommand,
		sendMessage: () => undefined,
	};
	const { api } = createSuiteToolRegistrationTracker({ ...hostApi, getAllTools: () => [] });
	const effects = new EffectFoundation();
	piStuffCodeMode(api, { effects, registry: definitionRegistry, surface });
	return { api, commands, effects, events, tools };
}

function context(cwd: string, trusted = true): ExtensionCommandContext & { notifications: string[] } {
	const notifications: string[] = [];
	const base = createExtensionCommandContext({
		cwd,
		hasUI: false,
		isProjectTrusted: () => trusted,
		ui: { notify: (message: string) => notifications.push(message) },
	});
	return Object.assign(base, { notifications });
}

async function sessionStart(loaded: ReturnType<typeof loadExtension>, ctx: ExtensionContext): Promise<void> {
	await loaded.effects.startSession(ctx.sessionManager);
	for (const handler of loaded.events.get("session_start") ?? []) {
		await handler({ reason: "startup", type: "session_start" }, ctx);
	}
}

test("model guidance discovers image Tools with a short query and returns their results directly", () => {
	const { tools } = loadExtension({
		disableEnvelope: () => {},
		enableEnvelope: () => {},
		isEnvelopeEnabled: () => false,
	});
	const codeMode = tools.get("codemode");
	const search = tools.get("tool_search");
	if (!codeMode || !search) throw new Error("missing Code Mode provider Tools");

	expect(codeMode.description).toContain('codemode.search("view image")');
	expect(codeMode.description).toContain("never call image(result)");
	expect(codeMode.description.length).toBeLessThanOrEqual(1_473);
	expect(search.parameters).toMatchObject({
		properties: { query: { description: 'Short intent phrase, e.g. "view image"' } },
	});
});

test("the installed Code Mode extension contributes Host Skill Discovery", async () => {
	const loaded = loadExtension(
		{
			disableEnvelope: () => {},
			enableEnvelope: () => {},
			isEnvelopeEnabled: (name) => name === "codemode",
		},
		{ ...registry, isActive: (name) => name === "read" },
	);
	// SAFETY: this fixture supplies every Skill field read by Pi's public formatter.
	const target = {
		baseDir: "/agent/skills",
		description: "target description",
		disableModelInvocation: false,
		filePath: "/agent/skills/target/SKILL.md",
		name: "target",
		sourceInfo: { path: "/agent/skills/target/SKILL.md", source: "user" },
	} as Skill;
	// SAFETY: this fixture supplies every event field read by the public contribution seam.
	const event = {
		prompt: "task",
		systemPrompt: "Host",
		systemPromptOptions: {
			cwd: "/workspace",
			selectedTools: ["codemode", "tool_search"],
			skills: [target],
		},
		type: "before_agent_start",
	} as BeforeAgentStartEvent;
	const projected = await applyContextPromptContributions(loaded.api, event, context("/workspace"));
	expect(projected?.systemPrompt).toContain("<name>target</name>");
});

test("bare /codemode owns the interactive dialog path and status is no longer a command", async () => {
	const surface: SuiteToolSurfaceController = {
		disableEnvelope: () => {},
		enableEnvelope: () => {},
		isEnvelopeEnabled: () => false,
	};
	const { commands } = loadExtension(surface);
	const command = commands.get("codemode");
	if (!command) throw new Error("missing /codemode command");
	const completions = (await command.getArgumentCompletions?.("")) ?? [];
	expect(completions.map(({ value }) => value)).not.toContain("status");

	const notifications: string[] = [];
	const context = createExtensionCommandContext({
		hasUI: false,
		ui: { notify: (message: string) => notifications.push(message) },
	});
	await command.handler("", context);
	expect(notifications.at(-1)).toBe("/codemode requires interactive TUI mode; use /codemode on or /codemode off.");
	await command.handler("status", context);
	expect(notifications.at(-1)).toStartWith("Usage: /codemode [on|off|global on|global off|history|");
	expect(notifications.at(-1)).not.toContain("status");
});

test("the outer Tool result boundary replaces malformed images before Session persistence", () => {
	const surface: SuiteToolSurfaceController = {
		disableEnvelope: () => {},
		enableEnvelope: () => {},
		isEnvelopeEnabled: () => false,
	};
	const { events } = loadExtension(surface);
	const handler = events.get("tool_result")?.[0];
	if (!handler) throw new Error("missing tool_result handler");
	// SAFETY: this fixture supplies the complete custom Tool-result event consumed by the registered handler.
	const patch = handler(
		{
			content: [{ type: "image", data: Buffer.alloc(96, 1).toString("base64"), mimeType: "image/jpeg" }],
			details: { kind: "pi-stuff-code-mode", operations: [], status: "success" },
			input: { code: "image(value)" },
			isError: false,
			toolCallId: "outer-bad-image",
			toolName: "codemode",
			type: "tool_result",
		} as ExtensionEvent,
		context("/project"),
	);

	expect(patch).toMatchObject({
		content: [{ type: "text", text: INVALID_CODE_MODE_IMAGE_MESSAGE }],
		details: { error: INVALID_CODE_MODE_IMAGE_MESSAGE, status: "error" },
		isError: true,
	});
});

const noOutput = "Code completed with no output; use text(...) to return a value";
const operation = {
	args: { path: "a.ts" },
	id: "nested-read",
	name: "read",
	result: { content: [{ type: "text" as const, text: "file contents" }], details: {} },
	state: "success" as const,
};
const nestedError = {
	...operation,
	id: "nested-error",
	result: { content: [{ type: "text" as const, text: "read failed" }], details: {}, isError: true },
	state: "error" as const,
};
const cases = [
	{
		code: "await yield_control()",
		content: [{ type: "text" as const, text: "continued" }],
		expected: [],
		id: "bare-control",
		operations: [],
	},
	{
		code: 'await yield_control(); text("继续等待。")',
		content: [{ type: "text" as const, text: "继续等待。" }],
		expected: [],
		id: "literal-control",
		operations: [],
	},
	{
		code: 'async () => { await yield_control(); text("waiting"); }',
		content: [{ type: "text" as const, text: "waiting" }],
		expected: [],
		id: "wrapped-control",
		operations: [],
	},
	{
		code: "async () => await yield_control()",
		content: [{ type: "text" as const, text: "waiting" }],
		expected: [],
		id: "expression-control",
		operations: [],
	},
	{
		code: "const total = 1 + 1",
		content: [{ type: "text" as const, text: noOutput }],
		expected: [],
		id: "no-output",
		operations: [],
	},
	{
		code: 'await yield_control(); await tools.read({ path: "a.ts" })',
		content: [{ type: "text" as const, text: noOutput }],
		expected: ["read"],
		id: "mixed-work",
		operations: [operation],
	},
	{
		code: 'text("2")',
		content: [{ type: "text" as const, text: "2" }],
		expected: [],
		id: "meaningful-output",
		operations: [],
	},
	{
		code: "image(value)",
		content: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }],
		expected: [],
		id: "media-output",
		operations: [],
	},
	{
		code: "image(value)",
		content: [{ type: "image" as const, data: "AA==", mimeType: "image/png" }],
		expected: [],
		id: "media-error",
		isError: true,
		operations: [],
	},
	{
		code: 'text("yield_control() is only text")',
		content: [{ type: "text" as const, text: "yield_control() is only text" }],
		expected: [],
		id: "yield-literal",
		operations: [],
	},
	{
		code: "await yield_control(1)",
		content: [{ type: "text" as const, text: "argument result" }],
		expected: [],
		id: "control-argument",
		operations: [],
	},
	{
		code: 'const message = "waiting"; await yield_control(); text(message)',
		content: [{ type: "text" as const, text: "waiting" }],
		expected: [],
		id: "dynamic-output",
		operations: [],
	},
	{
		code: "await yield_control(); await yield_control()",
		content: [{ type: "text" as const, text: "two yields" }],
		expected: [],
		id: "repeated-control",
		operations: [],
	},
	{
		code: "if (",
		content: [{ type: "text" as const, text: "parse failure evidence" }],
		expected: ["codemode"],
		id: "parse-failure",
		isError: true,
		operations: [],
	},
	{
		code: "await yield_control()",
		content: [{ type: "text" as const, text: "outer failure" }],
		expected: ["codemode"],
		id: "outer-error",
		isError: true,
		operations: [],
	},
	{
		code: 'await yield_control(); await tools.read({ path: "a.ts" })',
		content: [{ type: "text" as const, text: "outer failure" }],
		expected: ["read"],
		id: "nested-error",
		isError: true,
		operations: [nestedError],
	},
] as const;

test("successful pure-JavaScript Code Mode executions stay out of live and replay Tool UI", () => {
	const loaded = loadExtension({
		disableEnvelope: () => {},
		enableEnvelope: () => {},
		isEnvelopeEnabled: () => true,
	});
	const runtime = getToolUiRuntime(loaded.api);
	for (const scenario of cases) {
		const details = { kind: "pi-stuff-code-mode", operations: scenario.operations, status: "success" };
		const messages = [
			{
				content: [
					{
						arguments: { code: scenario.code },
						id: scenario.id,
						name: "codemode",
						type: "toolCall",
					},
				],
				role: "assistant",
			},
			Object.assign(
				{
					content: scenario.content,
					details,
					role: "toolResult",
					toolCallId: scenario.id,
				},
				"isError" in scenario && scenario.isError ? { isError: true } : undefined,
			),
		];
		const unchanged = structuredClone(messages);
		const projected = runtime.projectMessages(messages);
		const names = projected.flatMap((message) =>
			isRuntimeObject(message) && message !== null && "content" in message && Array.isArray(message.content)
				? message.content.flatMap((block) =>
						isRuntimeObject(block) &&
						block !== null &&
						"type" in block &&
						block.type === "toolCall" &&
						"name" in block &&
						isRuntimeString(block.name)
							? [block.name]
							: [],
					)
				: [],
		);
		expect(names, scenario.id).toEqual([...scenario.expected]);
		expect(messages, `${scenario.id} source messages`).toEqual(unchanged);
	}

	const envelope = loaded.tools.get("codemode");
	if (!envelope) throw new Error("missing Code Mode Tool");
	// SAFETY: this test theme implements the exact color and emphasis members exercised by the renderer.
	const theme = { bold: (value: string) => value, fg: (_color: string, value: string) => value } as Theme;
	for (const [id, code, text] of [
		["live-control", 'await yield_control(); text("waiting")', "waiting"],
		["live-no-output", "const total = 1 + 1", noOutput],
		["live-output", 'text("2")', "2"],
	] as const) {
		const args = { code };
		const context = {
			args,
			argsComplete: true,
			cwd: "/project",
			executionStarted: true,
			expanded: false,
			invalidate: () => {},
			isError: false,
			isPartial: false,
			lastComponent: undefined,
			showImages: true,
			state: {},
			toolCallId: id,
		};
		// SAFETY: the controlled arguments and context implement the registered Code Mode renderer contract.
		const call = envelope.renderCall?.(args, theme, context as never);
		const result = envelope.renderResult?.(
			{
				content: [{ type: "text", text }],
				details: { kind: "pi-stuff-code-mode", operations: [], status: "success" },
			},
			{ expanded: false, isPartial: false },
			theme,
			// SAFETY: this is the same controlled renderer context with the preceding call component attached.
			{ ...context, lastComponent: call } as never,
		);
		expect(result?.render(120), id).toEqual([]);
	}
	expect(runtime.listGroups().flatMap((group) => group.memberIds)).not.toContain("live-output");
	expect(runtime.toolActivityDetail("live-output", "formatted")).toBeUndefined();
});

test("Code Mode preserves failed reloads and rolls back failed setting writes", async () => {
	const previousAgentDir = process.env["PI_CODING_AGENT_DIR"];
	const previousDefault = process.env["PI_STUFF_CODE_MODE_DEFAULT"];
	const previousFrozen = process.env["PI_STUFF_CODE_MODE_FROZEN"];
	const previousAgentDirectory = process.env["PI_CODING_AGENT_DIR"];
	delete process.env["PI_STUFF_CODE_MODE_DEFAULT"];
	delete process.env["PI_STUFF_CODE_MODE_FROZEN"];
	try {
		process.env["PI_CODING_AGENT_DIR"] = await project();
		const first = await project();
		const second = await project();
		process.env["PI_CODING_AGENT_DIR"] = await project();
		await Effect.runPromise(writeCodeModeProjectEnabled(first, true));
		let enabled = false;
		const surface: SuiteToolSurfaceController = {
			disableEnvelope: () => {
				enabled = false;
			},
			enableEnvelope: () => {
				enabled = true;
			},
			isEnvelopeEnabled: () => enabled,
		};
		const loaded = loadExtension(surface);
		await sessionStart(loaded, context(first));
		expect(enabled).toBe(true);
		const command = loaded.commands.get("codemode");
		if (!command) throw new Error("missing /codemode command");
		const agentDir = process.env["PI_CODING_AGENT_DIR"];
		if (!agentDir) throw new Error("missing Agent directory");
		await Effect.runPromise(writeCodeModeProjectEnabled(first, false));
		await writeFile(join(agentDir, "pi-stuff.json"), '{"codeMode":{"enabled":"invalid"}}\n');
		await expect(sessionStart(loaded, context(first))).rejects.toThrow('"enabled" must be a boolean');
		await writeFile(join(agentDir, "pi-stuff.json"), "{}\n");
		await command.handler("global on", context(first));
		expect(enabled).toBe(true);
		await Promise.all([
			Effect.runPromise(writeCodeModeProjectEnabled(first, true)),
			writeFile(join(agentDir, "pi-stuff.json"), "{}\n"),
		]);
		await sessionStart(loaded, context(second));
		expect(enabled).toBe(false);

		const secondContext = context(second);
		await command.handler("on", secondContext);
		expect(enabled).toBe(true);
		expect(await Effect.runPromise(readCodeModeProjectEnabled(second))).toBe(true);

		let reloaded = false;
		const next = loadExtension({
			disableEnvelope: () => {
				reloaded = false;
			},
			enableEnvelope: () => {
				reloaded = true;
			},
			isEnvelopeEnabled: () => reloaded,
		});
		await sessionStart(next, context(second));
		expect(reloaded).toBe(true);

		process.env["PI_STUFF_CODE_MODE_FROZEN"] = "off";
		let childEnabled = true;
		const child = loadExtension({
			disableEnvelope: () => {
				childEnabled = false;
			},
			enableEnvelope: () => {
				childEnabled = true;
			},
			isEnvelopeEnabled: () => childEnabled,
		});
		await sessionStart(child, context(second));
		expect(childEnabled).toBe(false);
		delete process.env["PI_STUFF_CODE_MODE_FROZEN"];

		await rm(join(second, ".pi"), { force: true, recursive: true });
		await writeFile(join(second, ".pi"), "not a directory");
		await command.handler("off", secondContext);
		expect(enabled).toBe(true);
		expect(secondContext.notifications.at(-1)).toContain("Unable to save Code Mode project settings");

		await sessionStart(loaded, context(first, false));
		expect(enabled).toBe(false);
	} finally {
		if (previousAgentDir === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir;
		if (previousDefault === undefined) delete process.env["PI_STUFF_CODE_MODE_DEFAULT"];
		else process.env["PI_STUFF_CODE_MODE_DEFAULT"] = previousDefault;
		if (previousFrozen === undefined) delete process.env["PI_STUFF_CODE_MODE_FROZEN"];
		else process.env["PI_STUFF_CODE_MODE_FROZEN"] = previousFrozen;
		if (previousAgentDirectory === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = previousAgentDirectory;
	}
});
