import { appendFileSync } from "node:fs";
import type { Context, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { JsonInputValue } from "../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { createAssistantMessage, createTextStream, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-agents-execution-matrix";
const MODEL = "fixture-model";
const AGENT = "matrix-agent";
const FANOUT_AGENT = "matrix-fanout-agent";
const CHILD_DELAY_MS = 5_000;
const LONG_TOOL_ROUNDS = 8;
const LONG_TOOL_RESULT = [
	"MATRIX_LONG_TOOL_RESULT_START",
	"alpha-0123456789/+=上下文稳定性𠮷".repeat(1_250),
	"MATRIX_LONG_TOOL_RESULT_END",
].join("\n");
const LONG_STEERING_AUTHORITY =
	"MATRIX_LONG_STEERING_AUTHORITY: continue through every remaining Tool round and finish with the exact round count.";

type ScenarioId =
	| "single-fresh-foreground"
	| "single-fresh-foreground-code-mode"
	| "single-fork-background"
	| "parallel-fresh-background"
	| "parallel-fork-foreground"
	| "aggregate-fanout-foreground"
	| "long-fresh-foreground"
	| "long-fork-foreground";

const message = createAssistantMessage(PROVIDER, MODEL);

function requiredEnvironment(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing ${name} for the Agents execution matrix fixture`);
	return value;
}

function scenarioId(): ScenarioId {
	const value = requiredEnvironment("PI_STUFF_AGENTS_EXECUTION_MATRIX_SCENARIO");
	if (
		value !== "single-fresh-foreground" &&
		value !== "single-fresh-foreground-code-mode" &&
		value !== "single-fork-background" &&
		value !== "parallel-fresh-background" &&
		value !== "parallel-fork-foreground" &&
		value !== "aggregate-fanout-foreground" &&
		value !== "long-fresh-foreground" &&
		value !== "long-fork-foreground"
	) {
		throw new Error(`Unknown Agents execution matrix scenario: ${value}`);
	}
	return value;
}

function record(value: Record<string, JsonInputValue>): void {
	const path = requiredEnvironment("PI_STUFF_AGENTS_EXECUTION_MATRIX_LOG");
	const ponytailMode = value["kind"] === "child-start" ? process.env["PI_STUFF_PONYTAIL_MODE"] : undefined;
	appendFileSync(path, `${JSON.stringify({ at: Date.now(), pid: process.pid, ponytailMode, ...value })}\n`);
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const entry = context.messages[index];
		if (entry?.role !== "user") continue;
		if (isRuntimeString(entry.content)) return entry.content;
		return entry.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function latestToolResult(context: Context, toolName: string): string | undefined {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const entry = context.messages[index];
		if (entry?.role !== "toolResult" || entry.toolName !== toolName) continue;
		return entry.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return undefined;
}

function latestSubagentResult(context: Context): string | undefined {
	return latestToolResult(context, "subagent");
}

function toolResultCount(context: Context, toolName: string): number {
	return context.messages.filter((entry) => entry.role === "toolResult" && entry.toolName === toolName).length;
}

const textStream = createTextStream(message);

function delayedTextStream(text: string, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	let settled = false;
	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });

	const finish = (): void => {
		if (settled) return;
		settled = true;
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: pending });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
		stream.push({ type: "done", reason: "stop", message: message([{ type: "text", text }], "stop") });
		record({ kind: "child-finish", scenario: scenarioId(), text });
	};
	const timer = setTimeout(finish, CHILD_DELAY_MS);
	options?.signal?.addEventListener(
		"abort",
		() => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			stream.push({
				type: "error",
				reason: "aborted",
				error: message([{ type: "text", text: "MATRIX_CHILD_ABORTED" }], "aborted"),
			});
			record({ kind: "child-abort", scenario: scenarioId() });
		},
		{ once: true },
	);
	return stream;
}

interface SingleAgentArguments {
	readonly agent: string;
	readonly context: "fork" | "fresh";
	readonly foreground: boolean;
	readonly task: string;
}

interface ParallelAgentArguments {
	readonly context: "fork" | "fresh";
	readonly foreground: boolean;
	readonly tasks: readonly { readonly agent: string; readonly task: string }[];
}

type AgentToolArguments = ParallelAgentArguments | SingleAgentArguments;

function toolArguments(scenario: ScenarioId): AgentToolArguments {
	const common = {
		context: scenario.includes("-fork-") ? "fork" : "fresh",
		foreground: scenario.endsWith("-foreground"),
	} as const;
	if (scenario.startsWith("single-") || scenario === "aggregate-fanout-foreground" || scenario.startsWith("long-")) {
		return {
			...common,
			agent: scenario === "aggregate-fanout-foreground" ? FANOUT_AGENT : AGENT,
			task: `MATRIX_TASK_${scenario.toUpperCase().replaceAll("-", "_")}`,
		};
	}
	return {
		...common,
		tasks: [
			{ agent: AGENT, task: `MATRIX_TASK_${scenario.toUpperCase().replaceAll("-", "_")}_A` },
			{ agent: AGENT, task: `MATRIX_TASK_${scenario.toUpperCase().replaceAll("-", "_")}_B` },
		],
	};
}

function nestedToolCallStream(scenario: ScenarioId) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCall = {
		type: "toolCall" as const,
		id: `agents-execution-matrix-nested-${scenario}`,
		name: "subagent",
		arguments: {
			agent: AGENT,
			task: "MATRIX_GRANDCHILD_TASK_AGGREGATE_FANOUT_FOREGROUND",
		},
	};
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: message([toolCall], "toolUse") });
	return stream;
}

function toolCallStream(scenario: ScenarioId) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCall = {
		type: "toolCall" as const,
		id: `agents-execution-matrix-${scenario}`,
		name: "subagent",
		arguments: toolArguments(scenario),
	};
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: message([toolCall], "toolUse") });
	return stream;
}

function codeModeMainLaunchStream(scenario: ScenarioId) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCall = {
		type: "toolCall" as const,
		id: `agents-execution-matrix-code-mode-${scenario}`,
		name: "codemode",
		arguments: {
			code: `const result = await tools.subagent({ agent: "${AGENT}", task: "MATRIX_TASK_${scenario.toUpperCase().replaceAll("-", "_")}", foreground: true }); text(String(result));`,
		},
	};
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: message([toolCall], "toolUse") });
	return stream;
}

function codeModeChildToolStream(scenario: ScenarioId) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCalls = [
		{
			type: "toolCall" as const,
			id: `agents-execution-matrix-child-code-mode-${scenario}`,
			name: "codemode",
			arguments: {
				code: 'const file = await tools.read({ path: "matrix.txt", limit: 1 }); const shell = await tools.bash({ command: "printf MATRIX_CHILD_BASH_OK", description: "Verify child Bash" }); text(file + "\\n" + shell);',
			},
		},
		{
			type: "toolCall" as const,
			id: `agents-execution-matrix-child-extension-${scenario}`,
			name: "matrix_blob",
			arguments: { round: 1 },
		},
	];
	stream.push({ type: "start", partial: pending });
	for (const [contentIndex, toolCall] of toolCalls.entries()) {
		pending.content.push(toolCall);
		stream.push({ type: "toolcall_start", contentIndex, partial: pending });
		stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: pending });
	}
	stream.push({ type: "done", reason: "toolUse", message: message(toolCalls, "toolUse") });
	return stream;
}

function longToolCallStream(round: number) {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCall = {
		type: "toolCall" as const,
		id: `agents-execution-matrix-long-${round}`,
		name: "matrix_blob",
		arguments: { round },
	};
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: message([toolCall], "toolUse") });
	return stream;
}

function childStream(pi: ExtensionAPI, context: Context, options?: SimpleStreamOptions) {
	const scenario = scenarioId();
	const marker = requiredEnvironment("PI_STUFF_AGENTS_EXECUTION_MATRIX_ROOT_MARKER");
	const serialized = JSON.stringify(context.messages);
	const lastUser = lastUserText(context);
	const task = lastUser.match(/MATRIX_(?:TASK|GRANDCHILD_TASK)_[A-Z_]+/)?.[0] ?? "MATRIX_TASK_UNKNOWN";
	const sawRootMarker = serialized.includes(marker);
	const expectedBaseExtension = requiredEnvironment("PI_STUFF_AGENTS_EXECUTION_MATRIX_EXPECTED_BASE_EXTENSION");
	const childBaseExtension = process.env["PI_STUFF_CHILD_BASE_EXTENSION_PATH"];
	const nestedResult = latestSubagentResult(context);
	if (scenario === "single-fresh-foreground-code-mode") {
		const codeModeResult = latestToolResult(context, "codemode");
		const extensionResult = latestToolResult(context, "matrix_blob");
		if (codeModeResult === undefined && extensionResult === undefined) {
			record({
				kind: "child-start",
				scenario,
				task,
				lastUser,
				messageCount: context.messages.length,
				sawRootMarker,
				sawSuiteSurface: pi.getCommands().some((command) => command.name === "ui"),
				baseExtensionMatches: childBaseExtension === expectedBaseExtension,
				childBaseExtension,
				codeModeFrozen: process.env["PI_STUFF_CODE_MODE_FROZEN"],
				activeTools: (context.tools ?? []).map((tool) => tool.name),
			});
			return codeModeChildToolStream(scenario);
		}
		const text =
			codeModeResult?.includes("MATRIX_CHILD_FILE_OK") &&
			codeModeResult.includes("MATRIX_CHILD_BASH_OK") &&
			extensionResult?.includes("MATRIX_CHILD_EXTENSION_OK")
				? "MATRIX_CODE_CHILD_TOOLS_OK"
				: `MATRIX_CODE_CHILD_TOOLS_MISSING:${String(codeModeResult)}:${String(extensionResult)}`;
		record({ kind: "child-finish", scenario, task, text });
		return textStream(text);
	}
	if (scenario.startsWith("long-")) {
		const round = toolResultCount(context, "matrix_blob");
		const sawEvidence = serialized.includes("MATRIX_COMPLETED_CHECK_1");
		const sawSteering = serialized.includes(LONG_STEERING_AUTHORITY);
		record({
			kind: "child-long-turn",
			scenario,
			round,
			messageCount: context.messages.length,
			payloadBytes: Buffer.byteLength(serialized, "utf8"),
			sawEvidence,
			sawSteering,
		});
		if (round === 0) {
			record({
				kind: "child-start",
				scenario,
				task,
				lastUser,
				messageCount: context.messages.length,
				sawRootMarker,
				sawSuiteSurface: pi.getCommands().some((command) => command.name === "ui"),
				baseExtensionMatches: childBaseExtension === expectedBaseExtension,
				childBaseExtension,
				activeTools: (context.tools ?? []).map((tool) => tool.name),
			});
		}
		if (round < LONG_TOOL_ROUNDS) return longToolCallStream(round + 1);
		const text = `MATRIX_LONG_CHILD_RESULT:rounds=${round}:evidence=${sawEvidence}:steering=${sawSteering}`;
		record({ kind: "child-finish", scenario, task, text });
		return textStream(text);
	}
	const isSuiteDirect =
		scenario === "aggregate-fanout-foreground" && task !== "MATRIX_GRANDCHILD_TASK_AGGREGATE_FANOUT_FOREGROUND";
	if (isSuiteDirect && nestedResult !== undefined) {
		record({ kind: "child-finish", scenario, task, text: nestedResult });
		return textStream(`MATRIX_DIRECT_FANOUT_RESULT:${nestedResult}`);
	}
	record({
		kind: "child-start",
		scenario,
		task,
		lastUser,
		messageCount: context.messages.length,
		sawRootMarker,
		sawSuiteSurface: pi.getCommands().some((command) => command.name === "ui"),
		baseExtensionMatches: childBaseExtension === expectedBaseExtension,
		childBaseExtension,
		activeTools: (context.tools ?? []).map((tool) => tool.name),
	});
	if (isSuiteDirect) return nestedToolCallStream(scenario);
	return delayedTextStream(
		`MATRIX_CHILD_RESULT:${scenario}:${task}:root-marker=${sawRootMarker ? "seen" : "absent"}`,
		options,
	);
}

function mainStream(context: Context) {
	const scenario = scenarioId();
	const result = latestToolResult(context, scenario === "single-fresh-foreground-code-mode" ? "codemode" : "subagent");
	if (result === undefined) {
		record({
			kind: "main-launch",
			scenario,
			tools: (context.tools ?? []).map((tool) => tool.name),
		});
		return scenario === "single-fresh-foreground-code-mode"
			? codeModeMainLaunchStream(scenario)
			: toolCallStream(scenario);
	}
	record({ kind: "main-result", scenario, result });
	return textStream(`MATRIX_MAIN_RESULT:${scenario}`);
}

function fixtureStream(pi: ExtensionAPI, context: Context, options?: SimpleStreamOptions) {
	return process.env["PI_SUBAGENT_CHILD"] === "1" ? childStream(pi, context, options) : mainStream(context);
}

export default function agentsExecutionMatrixProvider(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "matrix_blob",
		label: "Matrix Blob",
		description: "Return deterministic large Tool output for the certified child-continuation matrix.",
		parameters: Type.Object({ round: Type.Integer({ minimum: 1, maximum: LONG_TOOL_ROUNDS }) }),
		execute: async (_toolCallId, parameters) => {
			const round = parameters.round;
			if (scenarioId() === "single-fresh-foreground-code-mode") {
				return {
					content: [{ type: "text" as const, text: "MATRIX_CHILD_EXTENSION_OK" }],
					details: { round },
				};
			}
			if (process.env["PI_SUBAGENT_CHILD"] === "1" && scenarioId().startsWith("long-")) {
				record({
					kind: "child-long-tool",
					scenario: scenarioId(),
					round,
					bytes: Buffer.byteLength(LONG_TOOL_RESULT),
				});
				if (round === 4) {
					await pi.sendUserMessage(LONG_STEERING_AUTHORITY, { deliverAs: "steer" });
					record({ kind: "child-long-steer", scenario: scenarioId(), round });
				}
			}
			return {
				content: [
					{ type: "text" as const, text: `${LONG_TOOL_RESULT}\nMATRIX_COMPLETED_CHECK_${round}\nround=${round}` },
				],
				details: { round },
			};
		},
	});
	registerFixtureProvider(
		pi,
		PROVIDER,
		MODEL,
		"Pi Stuff Agents execution matrix fixture",
		(_model, context, options) => fixtureStream(pi, context, options),
	);
}
