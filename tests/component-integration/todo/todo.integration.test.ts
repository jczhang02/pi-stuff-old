import { beforeEach, describe, expect, it } from "bun:test";
import type { JsonValue } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import piStuffTodo, { TODO_TOGGLE_KEY, type TodoHost } from "../../../packages/pi-stuff/src/todo/index.js";
import { isTaskDetails } from "../../../packages/pi-stuff/src/todo/state/replay.js";
import { __resetState } from "../../../packages/pi-stuff/src/todo/state/store.js";
import { registerTaskTools } from "../../../packages/pi-stuff/src/todo/todo.js";
import {
	TASK_CREATE_TOOL_NAME,
	TASK_GET_TOOL_NAME,
	TASK_LIST_TOOL_NAME,
	TASK_UPDATE_TOOL_NAME,
	type TaskDetails,
} from "../../../packages/pi-stuff/src/todo/tool/types.js";
import {
	getToolUiRuntime,
	type SuiteToolRegistrationHost,
} from "../../../packages/pi-stuff/src/tool-display/contract.js";
import { createExtensionContext } from "../../fixtures/extension-context.js";
import { toolRegistrationHarness } from "../../fixtures/tool-registration-host.js";

const TOOL_NAMES = [TASK_CREATE_TOOL_NAME, TASK_GET_TOOL_NAME, TASK_LIST_TOOL_NAME, TASK_UPDATE_TOOL_NAME];
type TaskMutationEvent = Parameters<NonNullable<Parameters<typeof registerTaskTools>[1]>>[0];

function createToolHarness(onMutation: (event: TaskMutationEvent) => void) {
	const definitions = new Map<string, ToolDefinition>();
	const { host: api, tools } = toolRegistrationHarness();
	registerTaskTools(api, onMutation);
	for (const [name, definition] of tools) definitions.set(name, definition);

	const context = createExtensionContext({ sessionManager: { getSessionId: () => "integration-session" } });

	function tool(name: string): ToolDefinition {
		const definition = definitions.get(name);
		if (!definition) throw new Error(`Tool ${name} was not registered`);
		return definition;
	}

	async function execute(name: string, params: Record<string, JsonValue>): Promise<AgentToolResult<unknown>> {
		return tool(name).execute(`call-${name}`, params, undefined, undefined, context);
	}

	return { api, definitions, execute, tool };
}

function details(result: AgentToolResult<unknown>): TaskDetails {
	if (!isTaskDetails(result.details)) throw new Error("Expected a versioned task snapshot");
	return result.details;
}

function text(result: AgentToolResult<unknown>): string {
	const content = result.content.find((item) => item.type === "text");
	if (content?.type !== "text") throw new Error("Expected text tool output");
	return content.text;
}

let renderedCallSequence = 0;

function renderedLines(
	api: SuiteToolRegistrationHost,
	tool: ToolDefinition,
	result: AgentToolResult<unknown>,
	isError: boolean,
	args: Record<string, JsonValue> = {},
): string[] {
	const callRenderer = tool.renderCall;
	const renderer = tool.renderResult;
	if (!callRenderer || !renderer) throw new Error(`Tool ${tool.name} has no complete renderer`);
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const theme = {
		bold: (value: string) => value,
		fg: (_color: string, value: string) => value,
	} as Theme;
	const state = {};
	renderedCallSequence += 1;
	const toolCallId = `render-${tool.name}-${String(renderedCallSequence)}`;
	getToolUiRuntime(api).indexMessages(
		[
			{ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: tool.name, arguments: args }] },
			Object.assign(
				{
					role: "toolResult",
					toolCallId,
					content: result.content,
					details: result.details,
				},
				isError ? { isError: true } : undefined,
			),
		],
		true,
	);
	// SAFETY: this test controls the value and supplies every Parameters member exercised by this case.
	const context = {
		args,
		argsComplete: true,
		cwd: "/project",
		executionStarted: true,
		expanded: false,
		invalidate: () => {},
		isError,
		isPartial: false,
		lastComponent: undefined,
		showImages: true,
		state,
		toolCallId,
	} as Parameters<typeof renderer>[3];
	const row = callRenderer(args, theme, context);
	renderer(result, { expanded: false, isPartial: false }, theme, context);
	return row.render(80);
}

beforeEach(() => {
	__resetState();
});

describe("registered Task tools", () => {
	it("executes the Claude-style task flow through the registration boundary", async () => {
		const mutations: TaskMutationEvent[] = [];
		const harness = createToolHarness((event) => mutations.push(event));
		expect([...harness.definitions.keys()]).toEqual(TOOL_NAMES);

		const first = await harness.execute(TASK_CREATE_TOOL_NAME, {
			subject: "Prepare implementation",
			description: "Define the implementation boundary",
		});
		const second = await harness.execute(TASK_CREATE_TOOL_NAME, {
			subject: "Implement feature",
			description: "Build and verify the feature",
		});
		const firstDetails = details(first);
		const secondDetails = details(second);
		expect(firstDetails.tasks[0]?.id).toBe("1");
		expect(secondDetails.tasks[1]?.id).toBe("2");
		expect(secondDetails.tasks[1]?.id).toBeTypeOf("string");
		expect(secondDetails.nextId).toBe(3);

		const listed = await harness.execute(TASK_LIST_TOOL_NAME, {});
		expect(text(listed)).toContain("#1 [pending] Prepare implementation");
		expect(text(listed)).toContain("#2 [pending] Implement feature");

		const updated = await harness.execute(TASK_UPDATE_TOOL_NAME, {
			taskId: "1",
			status: "in_progress",
			addBlocks: ["2", "2"],
		});
		const updatedDetails = details(updated);
		expect(updatedDetails.tasks.find((task) => task.id === "1")?.status).toBe("in_progress");
		expect(updatedDetails.tasks.find((task) => task.id === "2")?.blockedBy).toEqual(["1"]);

		const fetched = await harness.execute(TASK_GET_TOOL_NAME, {
			taskId: "2",
		});
		expect(text(fetched)).toContain("Task #2: Implement feature");
		expect(text(fetched)).toContain("Blocked by: #1");

		expect(mutations.map(({ action }) => action)).toEqual(["create", "create", "update"]);
		expect(mutations.every(({ sessionId }) => sessionId === "integration-session")).toBe(true);
		expect(renderedLines(harness.api, harness.tool(TASK_GET_TOOL_NAME), fetched, false, { taskId: "2" })).toEqual([]);

		const failed = await harness.execute(TASK_UPDATE_TOOL_NAME, {
			taskId: "missing",
			status: "completed",
		});
		expect(details(failed).error).toBe("#missing not found");
		expect(
			renderedLines(harness.api, harness.tool(TASK_UPDATE_TOOL_NAME), failed, false, { taskId: "missing" }).join(
				"\n",
			),
		).toContain("#missing not found");
		// SAFETY: this test controls the value and supplies every AgentToolResult member exercised by this case.
		const validationFailure = {
			content: [{ type: "text", text: "Invalid TaskUpdate input" }],
			details: undefined,
		} as AgentToolResult<unknown>;
		expect(
			renderedLines(harness.api, harness.tool(TASK_UPDATE_TOOL_NAME), validationFailure, true).join("\n").trim(),
		).toBe("• Task update · Invalid TaskUpdate input");
		expect(mutations.map(({ action }) => action)).toEqual(["create", "create", "update"]);
	});
});

describe("extension registration", () => {
	it("registers Ctrl+Shift+T as the task-list toggle", () => {
		type RegisterShortcutArguments = Parameters<ExtensionAPI["registerShortcut"]>;
		const shortcuts: Array<{ key: string; description: string }> = [];
		const lifecycleEvents: string[] = [];
		const { host } = toolRegistrationHarness();
		// SAFETY: this test adapter records lifecycle event names without invoking or changing their callbacks.
		const on = ((event: string) => {
			lifecycleEvents.push(event);
		}) as ExtensionAPI["on"];
		const api: TodoHost = {
			...host,
			registerShortcut: (key: RegisterShortcutArguments[0], options: RegisterShortcutArguments[1]) => {
				shortcuts.push({
					key: String(key),
					description: options.description ?? "",
				});
			},
			on,
		};

		piStuffTodo(api);

		expect(shortcuts).toEqual([
			{
				key: TODO_TOGGLE_KEY,
				description: "Collapse or expand the current task list",
			},
		]);
		expect(TODO_TOGGLE_KEY).toBe("ctrl+shift+t");
		expect(lifecycleEvents.sort()).toEqual([
			"session_compact",
			"session_shutdown",
			"session_shutdown",
			"session_shutdown",
			"session_shutdown",
			"session_start",
			"session_tree",
		]);
	});
});
