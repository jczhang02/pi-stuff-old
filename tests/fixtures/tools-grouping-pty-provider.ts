import type { Context, JsonValue } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { registerSuiteOwnedTool } from "../../packages/pi-stuff/src/tool-display/index.js";
import { createAssistantMessage, createTextStream, registerFixtureProvider } from "./faux-provider.js";

const PROVIDER = "pi-stuff-tools-grouping-pty";
const MODEL = "fixture-model";
const GENERIC_FIT_TARGET = "https://example.test/a-very-long-resource-identifier-without-boundaries-that-keeps-going";
interface FixtureCall {
	readonly arguments: Record<string, JsonValue>;
	readonly name: string;
}

const SUCCESS_CALLS: readonly FixtureCall[] = [
	{ name: "read", arguments: { path: "input-工具.txt" } },
	{ name: "find", arguments: { pattern: "*.txt", path: "." } },
	{ name: "ls", arguments: { path: "." } },
	{ name: "bash", arguments: { command: "pwd" } },
	{
		name: "TaskCreate",
		arguments: {
			subject: "Certify Retrieval Groups",
			description: "Exercise a Suite-owned non-builtin Tool as an independent activity.",
		},
	},
];
const FAILURE_CALLS: readonly FixtureCall[] = [
	{ name: "read", arguments: { path: "input-工具.txt" } },
	{
		name: "bash",
		arguments: { command: "printf FIXTURE_GROUP_ERROR >&2; exit 17" },
	},
	{ name: "read", arguments: { path: "input-工具.txt" } },
];
const MUTATION_CALLS: readonly FixtureCall[] = [
	{ name: "read", arguments: { path: "input-工具.txt" } },
	{
		name: "bash",
		arguments: { command: "printf mutation > bash-mutation-工具.txt" },
	},
	{ name: "read", arguments: { path: "input-工具.txt" } },
];
const BACKGROUND_CALLS: readonly FixtureCall[] = [
	{ name: "read", arguments: { path: "input-工具.txt" } },
	{ name: "bash", arguments: { command: "sleep 30" } },
	{ name: "read", arguments: { path: "input-工具.txt" } },
	{
		name: "bash",
		arguments: { command: "sleep 31", run_in_background: true },
	},
	{ name: "read", arguments: { path: "input-工具.txt" } },
];
const COMPLETION_CALLS: readonly FixtureCall[] = [
	{
		name: "bash",
		arguments: {
			command: "sleep 0.4; printf FIXTURE_BACKGROUND_COMPLETED",
			description: "completion fixture",
			run_in_background: true,
		},
	},
];
const MEDIA_CALLS: readonly FixtureCall[] = [{ name: "fixture_media", arguments: {} }];
const AGENT_CALLS: readonly FixtureCall[] = [{ name: "subagent", arguments: { action: "status" } }];
const RETRY_HISTORY_CALLS: readonly FixtureCall[] = [
	{ name: "fixture_retry", arguments: { value: "same exact retry" } },
	{ name: "fixture_retry", arguments: { value: "same exact retry" } },
];
const BASH_UI_CALLS: readonly FixtureCall[] = [
	{
		name: "bash",
		arguments: {
			command: "printf 'BASH_UI_ONE\\nBASH_UI_TWO\\nBASH_UI_THREE\\nBASH_UI_FOUR\\nBASH_UI_FIVE\\nBASH_UI_SIX\\n'",
		},
	},
	{
		name: "bash",
		arguments: { command: "printf BASH_UI_SECOND && printf '_DONE\\n'" },
	},
];
const PARTIAL_BASH_CALLS: readonly FixtureCall[] = [
	{
		name: "bash",
		arguments: { command: "printf PARTIAL_BASH_VISIBLE; sleep 30" },
	},
];
const EXIT_128_CALLS: readonly FixtureCall[] = [{ name: "bash", arguments: { command: "exit 128" } }];
const FIT_TARGET_CALLS: readonly FixtureCall[] = [{ name: "fixture_retry", arguments: { value: GENERIC_FIT_TARGET } }];
const SLOW_RETRIEVAL_CALLS: readonly FixtureCall[] = [{ name: "read", arguments: { path: "slow-target.txt" } }];
const RETRIEVAL_ISSUE_CALLS: readonly FixtureCall[] = [
	{ name: "read", arguments: { path: "input-工具.txt" } },
	{ name: "read", arguments: { path: "missing-retrieval.txt" } },
	{ name: "read", arguments: { path: "input-工具.txt" } },
];

const message = createAssistantMessage(PROVIDER, MODEL);
const textStream = createTextStream(message);

function toolCallsStream(prefix: string, fixtures: readonly FixtureCall[], thinking = "") {
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	const toolCalls = fixtures.map((fixture, index) => ({
		type: "toolCall" as const,
		id: `${prefix}-${String(index + 1)}`,
		name: fixture.name,
		arguments: fixture.arguments,
	}));
	stream.push({ type: "start", partial: pending });
	const contentOffset = thinking ? 1 : 0;
	if (thinking) {
		pending.content = [{ type: "thinking", thinking }];
		stream.push({
			type: "thinking_start",
			contentIndex: 0,
			partial: pending,
		});
		stream.push({
			type: "thinking_delta",
			contentIndex: 0,
			delta: thinking,
			partial: pending,
		});
		stream.push({
			type: "thinking_end",
			contentIndex: 0,
			content: thinking,
			partial: pending,
		});
	}
	for (const [index, toolCall] of toolCalls.entries()) {
		pending.content.push(toolCall);
		stream.push({
			type: "toolcall_start",
			contentIndex: index + contentOffset,
			partial: pending,
		});
		stream.push({
			type: "toolcall_end",
			contentIndex: index + contentOffset,
			toolCall,
			partial: pending,
		});
	}
	stream.push({
		type: "done",
		reason: "toolUse",
		message: message(thinking ? [{ type: "thinking", thinking }, ...toolCalls] : toolCalls, "toolUse"),
	});
	return stream;
}

function textContent(message: Context["messages"][number]): string {
	if (message.role !== "user") return "";
	if (isRuntimeString(message.content)) return message.content;
	return message.content
		.filter((content) => content.type === "text")
		.map((content) => content.text)
		.join("\n");
}

function fixtureStream(context: Context) {
	if ((context.tools?.length ?? 0) === 0) return textStream("GROUP_COMPACTION_SUMMARY");
	let lastUserIndex = -1;
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		if (context.messages[index]?.role === "user") {
			lastUserIndex = index;
			break;
		}
	}
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const request = lastUserIndex < 0 ? "" : textContent(context.messages[lastUserIndex] as Context["messages"][number]);
	const completed = context.messages.slice(lastUserIndex + 1).reduce((count, entry) => {
		if (entry.role !== "assistant") return count;
		return count + entry.content.filter((block) => block.type === "toolCall").length;
	}, 0);
	if (request.includes("failure")) {
		return completed === 0 ? toolCallsStream("group-failure", FAILURE_CALLS) : textStream("GROUP_FAILURE_DONE");
	}
	if (request.includes("mutation")) {
		return completed === 0 ? toolCallsStream("group-mutation", MUTATION_CALLS) : textStream("GROUP_MUTATION_DONE");
	}
	if (request.includes("permission")) {
		return completed === 0
			? toolCallsStream("group-permission", [{ name: "fixture_confirm", arguments: {} }])
			: textStream("GROUP_PERMISSION_DONE");
	}
	if (request.includes("rejection")) {
		return completed === 0
			? toolCallsStream("group-rejection", [{ name: "fixture_confirm", arguments: { reject: true } }])
			: textStream("GROUP_REJECTION_DONE");
	}
	if (request.includes("cancellation")) {
		return completed === 0
			? toolCallsStream("group-cancellation", [{ name: "fixture_cancel", arguments: {} }])
			: textStream("GROUP_CANCELLATION_DONE");
	}
	if (request.includes("completion")) {
		return completed === 0
			? toolCallsStream("group-completion", COMPLETION_CALLS)
			: textStream("GROUP_COMPLETION_DONE");
	}
	if (request.includes("media")) {
		return completed === 0 ? toolCallsStream("group-media", MEDIA_CALLS) : textStream("GROUP_MEDIA_DONE");
	}
	if (request.includes("agent")) {
		return completed === 0 ? toolCallsStream("group-agent", AGENT_CALLS) : textStream("GROUP_AGENT_DONE");
	}
	if (request.includes("retry-history")) {
		return completed === 0
			? toolCallsStream("group-retry-history", RETRY_HISTORY_CALLS)
			: textStream("GROUP_RETRY_HISTORY_DONE");
	}
	if (request.includes("bashui")) {
		return completed === 0 ? toolCallsStream("group-bash-ui", BASH_UI_CALLS) : textStream("GROUP_BASH_UI_DONE");
	}
	if (request.includes("partial-bash")) {
		return completed === 0
			? toolCallsStream("group-partial-bash", PARTIAL_BASH_CALLS)
			: textStream("GROUP_PARTIAL_BASH_DONE");
	}
	if (request.includes("exit-128")) {
		return completed === 0 ? toolCallsStream("group-exit-128", EXIT_128_CALLS) : textStream("GROUP_EXIT_128_DONE");
	}
	if (request.includes("fit-target")) {
		return completed === 0
			? toolCallsStream("group-fit-target", FIT_TARGET_CALLS)
			: textStream("GROUP_FIT_TARGET_DONE");
	}
	if (request.includes("slow-retrieval")) {
		return completed === 0
			? toolCallsStream("group-slow-retrieval", SLOW_RETRIEVAL_CALLS)
			: textStream("GROUP_SLOW_RETRIEVAL_DONE");
	}
	if (request.includes("retrieval-issue")) {
		return completed === 0
			? toolCallsStream("group-retrieval-issue", RETRIEVAL_ISSUE_CALLS)
			: textStream("GROUP_RETRIEVAL_ISSUE_DONE");
	}
	if (request.includes("structured")) {
		return textStream(
			[
				"## Structured result",
				"",
				"STRUCTURED_PARAGRAPH 中文",
				"",
				"- STRUCTURED_ITEM_ONE",
				"- STRUCTURED_ITEM_TWO",
				"",
				"```text",
				"STRUCTURED_CODE_LINE",
				"```",
			].join("\n"),
		);
	}
	if (request.includes("background")) {
		return completed === 0
			? toolCallsStream("group-background", BACKGROUND_CALLS)
			: textStream("GROUP_BACKGROUND_DONE");
	}
	if (request.includes("postcompact")) {
		return completed === 0
			? toolCallsStream("group-postcompact", SUCCESS_CALLS)
			: textStream("GROUP_POST_COMPACT_DONE");
	}
	if (request.includes("padding")) {
		return completed === 0
			? toolCallsStream("group-padding", [{ name: "padding_tool", arguments: {} }])
			: textStream("PADDING_DONE");
	}
	if (request.includes("plain")) return textStream("PLAIN_DONE");
	return completed < SUCCESS_CALLS.length
		? toolCallsStream(
				`group-success-${String(completed + 1)}`,
				// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
				[SUCCESS_CALLS[completed] as FixtureCall],
				`THINKING_STEP_${String(completed + 1)}`,
			)
		: textStream("GROUP_SUCCESS_DONE");
}

function registerOutcomeTools(pi: ExtensionAPI): void {
	pi.on("tool_result", async (event) => {
		if (event.toolCallId === "group-slow-retrieval-1") {
			await new Promise((resolve) => setTimeout(resolve, 3_200));
		}
	});
	registerSuiteOwnedTool(
		pi,
		{
			description: "Request deterministic interactive confirmation for Retrieval Group certification",
			execute: async (_toolCallId, args, _signal, _onUpdate, context) => {
				const confirmed = await context.ui.confirm(
					args.reject ? "Fixture rejection" : "Fixture permission",
					"Allow the certified fixture operation?",
				);
				return {
					content: [
						{
							type: "text",
							text: confirmed ? "FIXTURE_PERMISSION_ALLOWED" : "Tool execution was blocked by user",
						},
					],
					details: { confirmed },
				};
			},
			label: "Permission",
			name: "fixture_confirm",
			parameters: Type.Object({ reject: Type.Optional(Type.Boolean()) }),
		},
		{
			activity: {
				categories: ["run-command"],
				classify: () => [{ category: "run-command", count: 1, target: "Waiting for permission…" }],
			},
			summarize: (_args, result) =>
				// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
				(result.details as { readonly confirmed?: boolean } | undefined)?.confirmed
					? "permission allowed"
					: "permission rejected",
			target: () => "Waiting for permission…",
			resultIsError: (_args, result) =>
				// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
				(result.details as { readonly confirmed?: boolean } | undefined)?.confirmed !== true,
		},
	);
	registerSuiteOwnedTool(
		pi,
		{
			description: "Return one deterministic cancellation for Retrieval Group certification",
			execute: async () => ({
				content: [{ type: "text", text: "Operation aborted" }],
				details: { cancelled: true },
			}),
			label: "Cancel",
			name: "fixture_cancel",
			parameters: Type.Object({}),
		},
		{
			activity: {
				categories: ["run-command"],
				classify: () => [{ category: "run-command", count: 1 }],
			},
			resultIsError: () => true,
			summarize: () => "Operation aborted",
			target: () => "Cancelling operation",
		},
	);
	registerSuiteOwnedTool(
		pi,
		{
			description: "Return one deterministic error for Retrieval Group certification",
			execute: async () => ({
				content: [{ type: "text", text: "FIXTURE_GROUP_ERROR" }],
				details: { error: true },
			}),
			label: "State",
			name: "fixture_state",
			parameters: Type.Object({ state: Type.Literal("error") }),
		},
		{
			activity: {
				categories: ["run-command"],
				classify: () => [{ category: "run-command", count: 1 }],
			},
			resultIsError: () => true,
			summarize: () => "FIXTURE_GROUP_ERROR",
			target: () => "error",
		},
	);
}

function registerRecoveryAndMediaTools(pi: ExtensionAPI): void {
	registerSuiteOwnedTool(
		pi,
		{
			description: "Fail once, then complete the same exact operation for historical outcome certification",
			execute: async (toolCallId) => {
				const failed = toolCallId.endsWith("-1");
				return {
					content: [{ type: "text", text: failed ? "FIXTURE_RETRY_FAILED" : "FIXTURE_RETRY_SUCCEEDED" }],
					details: { failed },
				};
			},
			label: "Retry",
			name: "fixture_retry",
			parameters: Type.Object({ value: Type.String() }),
		},
		{
			activity: {
				categories: ["run-command"],
				classify: () => [{ category: "run-command", count: 1 }],
			},
			resultIsError: (_args, result) =>
				// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
				(result.details as { readonly failed?: boolean } | undefined)?.failed === true,
			summarize: (_args, _result, state) => (state === "success" ? "retry succeeded" : "retry failed"),
			target: (args) => args.value,
		},
	);
	registerSuiteOwnedTool(
		pi,
		{
			description: "Return one deterministic visible image for Retrieval Group certification",
			execute: async () => ({
				content: [
					{
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
						mimeType: "image/png" as const,
						type: "image" as const,
					},
				],
				details: { visible: true },
			}),
			label: "Media",
			name: "fixture_media",
			parameters: Type.Object({}),
		},
		{
			activity: {
				categories: ["view-image"],
				classify: () => [{ category: "view-image", countKeys: ["fixture-media"] }],
			},
			summarize: () => "media loaded",
			target: () => "Visible image",
		},
	);
	registerSuiteOwnedTool(
		pi,
		{
			description: "Return deterministic hidden context padding for compaction certification",
			execute: async () => ({
				content: Array.from({ length: 20 }, () => ({
					data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=",
					mimeType: "image/png" as const,
					type: "image" as const,
				})),
				details: undefined,
			}),
			label: "Padding",
			name: "padding_tool",
			parameters: Type.Object({}),
		},
		{
			activity: {
				categories: ["read-file"],
				classify: () => [{ category: "read-file", countKeys: ["padding"] }],
			},
			detailLines: () => ["deterministic compaction padding"],
			label: "Padding",
			summarize: () => "padded",
		},
	);
}

function registerToolsGroupingProvider(pi: ExtensionAPI): void {
	registerFixtureProvider(
		pi,
		PROVIDER,
		MODEL,
		"Pi Stuff Retrieval Group PTY fixture",
		(_model, context) => fixtureStream(context),
		{ reasoning: true },
	);
}

export default function toolsGroupingPtyProvider(pi: ExtensionAPI): void {
	registerOutcomeTools(pi);
	registerRecoveryAndMediaTools(pi);
	registerToolsGroupingProvider(pi);
}
