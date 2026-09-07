import { expect } from "bun:test";
import { createHash } from "node:crypto";
import {
	existsSync,
	watch as fsWatch,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentToolResult,
	createSyntheticSourceInfo,
	type ExtensionAPI,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import {
	isRuntimeFunction,
	isRuntimeObject,
	isRuntimeString,
} from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { createAgentToolPresentation } from "../../packages/pi-stuff/src/subagents/src/extension/agent-tool-presentation.js";
import {
	createNativeSupervisorChannel as createNativeSupervisorChannelNative,
	registerNativeSupervisorClient,
	resolveSupervisorChannelDir,
} from "../../packages/pi-stuff/src/subagents/src/intercom/native-supervisor-channel.js";
import {
	steerAckPathFromDir,
	writeSteerAckAt,
	writeSteerRequestToDir,
} from "../../packages/pi-stuff/src/subagents/src/runs/background/control-channel.js";
import { CHILD_MODEL_CONTEXT_ENTRY_TYPE } from "../../packages/pi-stuff/src/subagents/src/runs/shared/child-protocol.js";
import {
	buildPiArgs,
	PI_STUFF_CHILD_BASE_EXTENSION_PATH_ENV,
	PI_STUFF_CODE_MODE_FROZEN_ENV,
	resolvePiLaunchToolPlan,
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_DELEGATED_TASK_FINGERPRINT_ENV,
	SUBAGENT_ORCHESTRATOR_PHYSICAL_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_STEER_ACK_DIR_ENV,
	SUBAGENT_STEER_INBOX_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../../packages/pi-stuff/src/subagents/src/runs/shared/pi-args.js";
import {
	STRUCTURED_OUTPUT_CAPTURE_ENV,
	STRUCTURED_OUTPUT_SCHEMA_ENV,
} from "../../packages/pi-stuff/src/subagents/src/runs/shared/structured-output.js";
import registerSubagentPromptRuntime, {
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	registerSteeringInbox,
	registerToolBudget,
	rewriteSubagentPrompt,
	stripParentOnlySubagentMessages,
} from "../../packages/pi-stuff/src/subagents/src/runs/shared/subagent-prompt-runtime.js";
import {
	CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
	REQUIRED_CHILD_TOOLS_ENV,
	readChildToolDiagnosticError,
} from "../../packages/pi-stuff/src/subagents/src/runs/shared/tool-availability.js";
import type { SubagentState } from "../../packages/pi-stuff/src/subagents/src/shared/types.js";
import {
	boundStreamedRecentOutput,
	extractToolArgsPreview,
} from "../../packages/pi-stuff/src/subagents/src/shared/utils.js";
import type { ToolArguments } from "../../packages/pi-stuff/src/tool-display/activity.js";
import { getToolUiRuntime } from "../../packages/pi-stuff/src/tool-display/contract.js";
import { createExtensionApi } from "../fixtures/extension-api.js";
import { testTheme } from "../fixtures/extension-context.js";
import { isWellFormed } from "../fixtures/terminal.js";
import { createTestAgentEffectOwner } from "./agent-effect-owner-fixture.js";

const environment = new Map<string, string | undefined>();
const temporaryDirectories: string[] = [];
const theme = testTheme;
const createNativeSupervisorChannel = (
	pi: Parameters<typeof createNativeSupervisorChannelNative>[0],
	state: Parameters<typeof createNativeSupervisorChannelNative>[1],
) => createNativeSupervisorChannelNative(pi, state, createTestAgentEffectOwner());

type ToolInfo = ReturnType<ExtensionAPI["getAllTools"]>[number];
type LifecycleResult = object | undefined | Promise<object | undefined>;
const FIXTURE_MESSAGE_SCHEMA = Type.Object(
	{
		content: Type.Unknown(),
		isError: Type.Optional(Type.Boolean()),
		role: Type.String(),
		stopReason: Type.Optional(Type.String()),
		timestamp: Type.Optional(Type.Number()),
		toolCallId: Type.Optional(Type.String()),
		toolName: Type.Optional(Type.String()),
	},
	{ additionalProperties: true },
);
const CONTEXT_RESULT_SCHEMA = Type.Object(
	{ messages: Type.Optional(Type.Array(FIXTURE_MESSAGE_SCHEMA)) },
	{ additionalProperties: true },
);
type FixtureMessage = Static<typeof FIXTURE_MESSAGE_SCHEMA>;

interface LifecycleEvent {
	readonly content?: string;
	readonly messages?: FixtureMessage[];
	readonly payload?: object;
	readonly reason?: string;
	readonly source?: string;
	readonly streamingBehavior?: string;
	readonly systemPrompt?: string;
	readonly toolName?: string;
}

interface LifecycleContext {
	abort?(): void;
	getSystemPrompt?(): string;
	readonly model?: {
		readonly contextWindow: number;
		readonly id?: string;
		readonly maxTokens: number;
		readonly provider?: string;
	};
}

type LifecycleHandler = (event: LifecycleEvent, context?: LifecycleContext) => LifecycleResult;

function projectedMessages(result: Awaited<LifecycleResult>, fallback: FixtureMessage[]): FixtureMessage[] {
	return Check(CONTEXT_RESULT_SCHEMA, result) && result.messages ? result.messages : fallback;
}

function toolInfo(tool: Pick<ToolDefinition, "description" | "name" | "parameters">): ToolInfo {
	return {
		description: tool.description,
		name: tool.name,
		parameters: tool.parameters,
		sourceInfo: createSyntheticSourceInfo(`/test/${tool.name}`, { source: "extension" }),
	};
}

function lifecycleHandlers<Handler>(handlers: Map<string, Handler[]>): ExtensionAPI["on"] {
	return new Proxy(createExtensionApi().on, {
		apply(_target, _thisArg, [event, handler]) {
			if (!isRuntimeString(event) || !isRuntimeFunction(handler)) return undefined;
			// SAFETY: Tests invoke each captured callback only with the matching lifecycle payload used at registration.
			const captured = handler as Handler;
			handlers.set(event, [...(handlers.get(event) ?? []), captured]);
			return undefined;
		},
	});
}

function lifecycleHandler<Event>(handlers: Map<string, (event: Event) => LifecycleResult>): ExtensionAPI["on"] {
	return new Proxy(createExtensionApi().on, {
		apply(_target, _thisArg, [event, handler]) {
			if (!isRuntimeString(event) || !isRuntimeFunction(handler)) return undefined;
			// SAFETY: Tests invoke each captured callback only with the matching lifecycle payload used at registration.
			handlers.set(event, handler as (event: Event) => LifecycleResult);
			return undefined;
		},
	});
}

function setEnvironment(name: string, value: string): void {
	if (!environment.has(name)) environment.set(name, process.env[name]);
	process.env[name] = value;
}

function apiHarness() {
	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, LifecycleHandler[]>();
	const api = createExtensionApi({
		getAllTools: () => [...tools.values()].map(toolInfo),
		on: lifecycleHandlers(handlers),
		registerTool: (tool) => {
			// SAFETY: this test registry erases only generic renderer state and returns the original Tool unchanged.
			tools.set(tool.name, tool as ToolDefinition);
		},
		sendMessage: () => {},
	});
	return {
		api,
		tools,
		run: async (event: string) => {
			for (const handler of handlers.get(event) ?? []) await handler({});
		},
	};
}

function expectCompactPresentation(tool: ToolDefinition | undefined): void {
	expect(tool).toBeDefined();
	expect(tool?.renderShell).toBe("self");
	expect(tool?.renderCall).toBeFunction();
	expect(tool?.renderResult).toBeFunction();
}

function renderedSummary(
	api: ExtensionAPI,
	tool: ToolDefinition | undefined,
	args: ToolArguments,
	result: AgentToolResult<unknown>,
	toolCallId: string,
	isError = false,
): string {
	expect(tool).toBeDefined();
	getToolUiRuntime(api).indexMessages(
		[
			{ role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: tool?.name, arguments: args }] },
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
	const state = {};
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
	};
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const row = tool?.renderCall?.(args, theme, context as never);
	expect(row).toBeDefined();
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	tool?.renderResult?.(result, { expanded: false, isPartial: false }, theme, {
		...context,
		lastComponent: row,
	} as never);
	return row?.render(100).join("\n") ?? "";
}

export type { FixtureMessage, LifecycleEvent, LifecycleHandler, LifecycleResult, SubagentState, ToolDefinition };
export {
	apiHarness,
	boundStreamedRecentOutput,
	buildPiArgs,
	CHILD_MODEL_CONTEXT_ENTRY_TYPE,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
	createAgentToolPresentation,
	createExtensionApi,
	createHash,
	createNativeSupervisorChannel,
	existsSync,
	expectCompactPresentation,
	extractToolArgsPreview,
	fsWatch,
	isRuntimeFunction,
	isRuntimeObject,
	isRuntimeString,
	isWellFormed,
	join,
	lifecycleHandler,
	lifecycleHandlers,
	mkdirSync,
	mkdtempSync,
	PI_STUFF_CHILD_BASE_EXTENSION_PATH_ENV,
	PI_STUFF_CODE_MODE_FROZEN_ENV,
	projectedMessages,
	REQUIRED_CHILD_TOOLS_ENV,
	readChildToolDiagnosticError,
	readdirSync,
	readFileSync,
	registerNativeSupervisorClient,
	registerSteeringInbox,
	registerSubagentPromptRuntime,
	registerToolBudget,
	renderedSummary,
	resolvePiLaunchToolPlan,
	resolveSupervisorChannelDir,
	rewriteSubagentPrompt,
	rmSync,
	STRUCTURED_OUTPUT_CAPTURE_ENV,
	STRUCTURED_OUTPUT_SCHEMA_ENV,
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_DELEGATED_TASK_FINGERPRINT_ENV,
	SUBAGENT_ORCHESTRATOR_PHYSICAL_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_STEER_ACK_DIR_ENV,
	SUBAGENT_STEER_INBOX_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
	setEnvironment,
	steerAckPathFromDir,
	stripParentOnlySubagentMessages,
	temporaryDirectories,
	tmpdir,
	toolInfo,
	visibleWidth,
	writeFileSync,
	writeSteerAckAt,
	writeSteerRequestToDir,
};

export function cleanupToolPresentationFixtures(): void {
	for (const [name, value] of environment) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	environment.clear();
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { force: true, recursive: true });
}
