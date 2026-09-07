import {
	type AgentToolResult,
	createEventBus,
	type EventBus,
	type Theme,
	type ToolDefinition,
	type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { classifyBashActivity } from "../../packages/pi-stuff/src/tool-display/activity.js";
import type {
	SuiteToolCodeModeContract,
	SuiteToolTrackerHost,
} from "../../packages/pi-stuff/src/tool-display/contract.js";
import { registerSuiteOwnedTool } from "../../packages/pi-stuff/src/tool-display/registration.js";

export * from "@earendil-works/pi-coding-agent";
export { resetCapabilitiesCache, setCapabilities } from "@earendil-works/pi-tui";
export { Type } from "typebox";
export { Check } from "typebox/value";
export { ToolExecutionComponent } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js";
export { initTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
export { SuiteCodeModeConnector } from "../../packages/pi-stuff/src/code-mode/connector.js";
export { decodeCodeModeOperations } from "../../packages/pi-stuff/src/code-mode/extension.js";
export { registerCodexTools } from "../../packages/pi-stuff/src/codex/tools.js";
export * from "../../packages/pi-stuff/src/shared/runtime-type.js";
export * from "../../packages/pi-stuff/src/tool-display/activity.js";
export * from "../../packages/pi-stuff/src/tool-display/contract.js";
export * from "../../packages/pi-stuff/src/tool-display/registration.js";
export { CachedToolRow } from "../../packages/pi-stuff/src/tool-display/render.js";
export { ToolUiSettingsStore } from "../../packages/pi-stuff/src/tool-display/settings.js";
export const Params = Type.Object({ value: Type.String() });
export const BashParams = Type.Object({ command: Type.String() });
export type Params = { value: string };
export type RenderContext = Parameters<NonNullable<ToolDefinition<typeof Params>["renderCall"]>>[2];

function fixtureTheme(): Theme {
	const value = { bold: (text: string) => text, fg: (_color: string, text: string) => text };
	// SAFETY: this test fixture implements the exact Host surface exercised by these cases.
	return value as Theme;
}

export const theme = fixtureTheme();

export function eventBusView(bus: EventBus = createEventBus()): EventBus {
	return {
		emit: (event, data) => bus.emit(event, data),
		on: (event, listener) => bus.on(event, listener),
	};
}

export function apiHarness(events: EventBus = createEventBus()) {
	let activeTools: string[] = [];
	const tools = new Map<string, ToolDefinition>();
	const api: SuiteToolTrackerHost = {
		events,
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
		on: () => {},
		registerTool: (tool) => {
			// SAFETY: the test registry erases only generic renderer state and retains the original Tool object.
			tools.set(tool.name, tool as ToolDefinition);
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
		},
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
	};
	return { api, tools };
}

export function renderContext(
	state: RenderContext["state"],
	args: Params,
	overrides: Partial<RenderContext> = {},
): RenderContext {
	return {
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
		state,
		toolCallId: "call-1",
		...overrides,
	};
}

export function assistant(...content: unknown[]) {
	return { role: "assistant", content };
}

export function call(id: string, name: string, value: string) {
	return { type: "toolCall", id, name, arguments: { value } };
}

export function result(id: string, text = "ok", isError = false) {
	return Object.assign(
		{
			role: "toolResult",
			toolCallId: id,
			content: [{ type: "text", text }],
			details: {},
		},
		isError ? { isError: true } : undefined,
	);
}

export function bashCall(id: string, command: string) {
	return { type: "toolCall", id, name: "bash", arguments: { command, value: command } };
}

export type FixtureCategory =
	| "change-file"
	| "fetch-page"
	| "list-directory"
	| "read-file"
	| "run-command"
	| "search-pattern"
	| "view-image";

export function presentation(category: FixtureCategory) {
	return {
		activity: {
			categories: [category],
			classify: ({ args }: { args: Readonly<Params> }) => [
				category === "run-command" || category === "search-pattern" || category === "list-directory"
					? { category, count: 1, target: args.value }
					: { category, countKeys: [args.value], target: args.value },
			],
		},
		label: category,
		runningSummary: "working",
		summarize: (_args: Readonly<Params>, _result: AgentToolResult<unknown>, state: string) =>
			state === "success" ? "done" : state,
		target: (args: Readonly<Params>) => args.value,
	};
}

export function toolFromHarness(
	harness: Pick<ReturnType<typeof apiHarness>, "api" | "tools">,
	name: string,
	category: FixtureCategory,
	codeMode?: SuiteToolCodeModeContract,
): ToolDefinition<typeof Params, { source: string }> {
	const original: ToolDefinition<typeof Params, { source: string }> = {
		description: `${name} fixture`,
		execute: async () => ({
			content: [{ type: "text", text: "MODEL_VISIBLE" }],
			details: { source: name },
		}),
		label: name,
		name,
		parameters: Params,
	};
	const fixturePresentation = presentation(category);
	registerSuiteOwnedTool(
		harness.api,
		original,
		name === "bash"
			? {
					...fixturePresentation,
					activity: {
						categories: ["run-command", "read-file", "search-pattern", "list-directory"],
						classify: (input) =>
							classifyBashActivity({
								...input,
								args: { ...input.args, command: input.args["command"] ?? input.args["value"] },
							}),
					},
				}
			: fixturePresentation,
		codeMode,
	);
	const decorated = harness.tools.get(name);
	if (!decorated) throw new Error(`missing ${name}`);
	// SAFETY: this test controls the value and supplies every ToolDefinition member exercised by this case.
	return decorated as ToolDefinition<typeof Params, { source: string }>;
}

export function renderLines(component: { render(width: number): string[] }, width = 120): string[] {
	return component.render(width);
}

export function settle(
	tool: ToolDefinition<typeof Params, { source: string }>,
	id: string,
	value: string,
	isError = false,
	expanded = false,
	resultText = isError ? "FAILED" : "MODEL_VISIBLE",
) {
	const state = {};
	const args = { value };
	const context = renderContext(state, args, {
		expanded,
		isError,
		toolCallId: id,
	});
	const component = tool.renderCall?.(args, theme, context);
	if (!component) throw new Error("missing call component");
	const body = tool.renderResult?.(
		{
			content: [{ type: "text", text: resultText }],
			details: { source: value },
		},
		{ expanded, isPartial: false },
		theme,
		{ ...context, lastComponent: component },
	);
	return {
		callComponent: component,
		callLines: renderLines(component),
		resultLines: body ? renderLines(body) : [],
	};
}
