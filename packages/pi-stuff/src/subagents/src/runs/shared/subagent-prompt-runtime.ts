import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ContextEvent, ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type JsonInputValue, parseJsonValue } from "../../../../shared/json-value.js";
import { isRuntimeFunction, isRuntimeNumber, isRuntimeString } from "../../../../shared/runtime-type.js";
import { activityKey, registerSuiteOwnedTool, singleActivity } from "../../../../tool-display/index.js";
import { registerNativeSupervisorClient } from "../../intercom/native-supervisor-channel.ts";
import type { ResolvedToolBudget } from "../../shared/types.ts";
import {
	CHILD_MODEL_CONTEXT_ENTRY_TYPE,
	CHILD_TOOL_BUDGET_ENTRY_TYPE,
	type ChildModelContext,
} from "./child-protocol.ts";
import { SUBAGENT_CHILD_AGENT_ENV, SUBAGENT_FANOUT_CHILD_ENV } from "./pi-args.ts";
import { formatSteerMessage, registerSteeringInbox } from "./steering-inbox.ts";
import {
	assertJsonSchemaObject,
	createStructuredOutputToolParameters,
	STRUCTURED_OUTPUT_CAPTURE_ENV,
	STRUCTURED_OUTPUT_SCHEMA_ENV,
	validateStructuredOutputValue,
} from "./structured-output.ts";
import {
	CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
	type ChildToolDiagnostic,
	MCP_DIRECT_CHILD_TOOLS_ENV,
	REQUIRED_CHILD_TOOLS_ENV,
	writeChildToolDiagnostic,
} from "./tool-availability.ts";
import {
	decodeToolBudgetEnv,
	shouldBlockToolForBudget,
	TOOL_BUDGET_ENV,
	TOOL_BUDGET_ZERO_AUTH_ENV,
	toolBudgetBlockedMessage,
	toolBudgetSoftNudge,
} from "./tool-budget.ts";

export { formatSteerMessage, registerSteeringInbox };

const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = "PI_SUBAGENT_INHERIT_PROJECT_CONTEXT";
const SUBAGENT_INHERIT_SKILLS_ENV = "PI_SUBAGENT_INHERIT_SKILLS";
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = "PI_SUBAGENT_INTERCOM_SESSION_NAME";

const STRUCTURED_OUTPUT_INSTRUCTIONS = [
	"This subagent step has a strict structured output contract.",
	"Your final action must be to call the `structured_output` tool with JSON matching the provided schema.",
	"Do not rely on prose-only completion; if you do not call `structured_output`, the parent will fail this step.",
].join("\n");

export const CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent, not the parent orchestrator.",
	"The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.",
	"Ignore prior parent-only orchestration instructions in inherited conversation history.",
	"Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.",
	"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

export const CHILD_FANOUT_BOUNDARY_INSTRUCTIONS = [
	"You are a child subagent with explicit fanout responsibility for this assigned task.",
	"The parent session owns final orchestration, acceptance, and follow-up implementation launches.",
	"You may use the `subagent` tool only for the fanout work explicitly requested in this task.",
	"Do not broaden yourself into general parent orchestration. Do not launch follow-up workers unless the task explicitly asks for that.",
	"The maxSubagentDepth cap still applies and may block further fanout.",
	"If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.",
].join("\n");

const PARENT_ONLY_CUSTOM_MESSAGE_TYPES = new Set([
	"subagent-orchestration-instructions",
	"subagent-slash-result",
	"subagent-slash-text-result",
	"subagent-notify",
	"subagent_control_notice",
	"subagent-control",
	"subagent-control-notice",
]);

type SubagentContextMessage = ContextEvent["messages"][number];

function readBooleanEnv(name: string): boolean | undefined {
	const value = process.env[name];
	if (value === undefined) return undefined;
	return value !== "0";
}

function readRequiredChildTools(): string[] | undefined {
	const encoded = process.env[REQUIRED_CHILD_TOOLS_ENV]?.trim();
	if (!encoded) return undefined;
	const required = parseJsonValue(encoded);
	if (!Array.isArray(required) || required.some((name) => !isRuntimeString(name) || !name)) {
		throw new Error(`Invalid ${REQUIRED_CHILD_TOOLS_ENV} payload.`);
	}
	return required.filter(isRuntimeString);
}

function readMcpDirectChildTools(): string[] | undefined {
	const encoded = process.env[MCP_DIRECT_CHILD_TOOLS_ENV]?.trim();
	if (!encoded) return undefined;
	try {
		const tools = parseJsonValue(encoded);
		if (!Array.isArray(tools) || tools.some((name) => !isRuntimeString(name) || !name)) return undefined;
		return tools.filter(isRuntimeString);
	} catch {
		return undefined;
	}
}

function refreshChildToolDiagnostic(pi: ExtensionAPI): ChildToolDiagnostic | undefined {
	const filePath = process.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV]?.trim();
	const required = readRequiredChildTools();
	if (!filePath || !required) return undefined;
	const available = pi.getAllTools().map((tool) => tool.name);
	return writeChildToolDiagnostic(
		filePath,
		required,
		available,
		process.env[SUBAGENT_CHILD_AGENT_ENV]?.trim(),
		readMcpDirectChildTools(),
	);
}

export function rewriteSubagentPrompt(prompt: string, options: { fanoutChild?: boolean }): string {
	const boundary = options.fanoutChild ? CHILD_FANOUT_BOUNDARY_INSTRUCTIONS : CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS;
	const structured = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV] ? `\n\n${STRUCTURED_OUTPUT_INSTRUCTIONS}` : "";
	// Pi concatenates custom prompts and Runtime Resources without an escaped
	// structural boundary. Treat the resulting prompt as opaque: child capability
	// ceilings and resolved Skill selection enforce orchestration policy without
	// deleting user-authored text that happens to resemble a Host resource block.
	return `${boundary}${structured}\n\n${prompt}`;
}

function isParentOnlySubagentMessage(message: SubagentContextMessage): boolean {
	if (message.role !== "custom" || !isRuntimeString(message.customType)) return false;
	return PARENT_ONLY_CUSTOM_MESSAGE_TYPES.has(message.customType);
}

function isSubagentToolResultMessage(message: SubagentContextMessage): boolean {
	return message.role === "toolResult" && message.toolName === "subagent";
}

function stripAssistantSubagentToolCallBlocks(message: SubagentContextMessage): SubagentContextMessage | undefined {
	if (message.role !== "assistant") return message;
	const filteredContent = message.content.filter((block) => block.type !== "toolCall" || block.name !== "subagent");
	if (filteredContent.length === message.content.length) return message;
	if (filteredContent.length === 0) return undefined;
	return { ...message, content: filteredContent };
}

const PORTABLE_TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_PORTABLE_TOOL_ID_LENGTH = 64;
const COMPOSITE_TOOL_ID_APIS = new Set([
	"azure-openai-responses",
	"cursor-native",
	"openai-completions",
	"openai-responses",
]);

function portableToolId(id: string): string {
	if (PORTABLE_TOOL_ID_PATTERN.test(id) && id.length <= MAX_PORTABLE_TOOL_ID_LENGTH) return id;
	const encoded = `tool_${Buffer.from(id).toString("base64url") || "empty"}`;
	if (encoded.length <= MAX_PORTABLE_TOOL_ID_LENGTH) return encoded;
	return `tool_${createHash("sha256").update(id).digest("base64url")}`;
}

function sanitizeToolHistoryMessage(message: SubagentContextMessage): SubagentContextMessage {
	if (message.role === "toolResult") {
		const toolCallId = portableToolId(message.toolCallId);
		return toolCallId === message.toolCallId ? message : { ...message, toolCallId };
	}
	if (message.role !== "assistant") return message;
	let changed = false;
	const content = message.content.map((block) => {
		if (block.type !== "toolCall") return block;
		const id = portableToolId(block.id);
		if (id === block.id) return block;
		changed = true;
		return { ...block, id };
	});
	return changed ? { ...message, content } : message;
}

export function stripParentOnlySubagentMessages(
	messages: SubagentContextMessage[],
	options: { sanitizeToolIds?: boolean } = {},
): SubagentContextMessage[] {
	const preserveCurrentFanoutToolHistory = process.env[SUBAGENT_FANOUT_CHILD_ENV] === "1";
	const sanitizeToolIds = options.sanitizeToolIds ?? true;
	let changed = false;
	const filtered: SubagentContextMessage[] = [];
	for (const message of messages) {
		if (
			isParentOnlySubagentMessage(message) ||
			(!preserveCurrentFanoutToolHistory && isSubagentToolResultMessage(message))
		) {
			changed = true;
			continue;
		}
		const stripped = preserveCurrentFanoutToolHistory ? message : stripAssistantSubagentToolCallBlocks(message);
		if (stripped === undefined) {
			changed = true;
			continue;
		}
		const sanitized = sanitizeToolIds ? sanitizeToolHistoryMessage(stripped) : stripped;
		if (stripped !== message || sanitized !== stripped) changed = true;
		filtered.push(sanitized);
	}
	return changed ? filtered : messages;
}

export function registerToolBudget(pi: ExtensionAPI, budget: ResolvedToolBudget | undefined): void {
	if (!budget) return;
	let toolCount = 0;
	let softNudged = false;
	// SAFETY: Pi exposes sendUserMessage at runtime; the optional function check below gates every call.
	const sendUserMessage = (
		pi as {
			sendUserMessage?: (content: string, options: { deliverAs: "steer" }) => PromiseLike<void> | void;
		}
	).sendUserMessage;
	type ToolBudgetEventResult = { readonly block: true; readonly reason: string } | undefined;
	// SAFETY: this adapter registers Pi's documented tool_call event and preserves its block-result contract.
	const onRuntimeEvent = pi.on as (
		event: string,
		handler: (event: { toolName?: string }) => ToolBudgetEventResult,
	) => void;
	const recordBudgetEvent = (outcome: "soft-reached" | "hard-blocked", toolName: string): void => {
		try {
			pi.appendEntry(CHILD_TOOL_BUDGET_ENTRY_TYPE, { version: 1, outcome, toolCount, toolName });
		} catch {
			// Budget enforcement remains authoritative when optional telemetry cannot be appended.
		}
	};
	onRuntimeEvent("tool_call", (event) => {
		const toolName = isRuntimeString(event.toolName) ? event.toolName : "tool";
		toolCount++;
		if (budget.soft !== undefined && toolCount >= budget.soft && !softNudged) {
			softNudged = true;
			recordBudgetEvent("soft-reached", toolName);
			try {
				const dispatched = sendUserMessage?.(toolBudgetSoftNudge(budget, toolCount), { deliverAs: "steer" });
				if (dispatched) {
					void Promise.resolve(dispatched).catch(() => {
						// Budget nudges are advisory; blocking below remains authoritative.
					});
				}
			} catch {
				// Budget nudges are advisory; blocking below remains authoritative.
			}
		}
		if (!shouldBlockToolForBudget(budget, toolName, toolCount)) return undefined;
		recordBudgetEvent("hard-blocked", toolName);
		return { block: true, reason: toolBudgetBlockedMessage(budget, toolName, toolCount) };
	});
}

function registerStructuredOutputTool(pi: ExtensionAPI): void {
	const outputPath = process.env[STRUCTURED_OUTPUT_CAPTURE_ENV];
	const schemaPath = process.env[STRUCTURED_OUTPUT_SCHEMA_ENV];
	if (!outputPath || !schemaPath) return;
	const schema = parseJsonValue(fs.readFileSync(schemaPath, "utf-8"));
	assertJsonSchemaObject(schema, "structured output schema");
	const parameters = Type.Unsafe<{ value: JsonInputValue }>(createStructuredOutputToolParameters(schema));
	const tool: ToolDefinition<typeof parameters, { readonly path: string }> = {
		name: "structured_output",
		label: "Structured Output",
		description: "Submit the required final structured output for this subagent step. This terminates the step.",
		parameters,
		async execute(_id, params) {
			const validation = await validateStructuredOutputValue(schema, params.value);
			if (validation.status === "invalid") {
				throw new Error(`Structured output validation failed: ${validation.message}`);
			}
			fs.mkdirSync(path.dirname(outputPath), { recursive: true });
			fs.writeFileSync(outputPath, JSON.stringify(params.value), { mode: 0o600 });
			return {
				content: [{ type: "text", text: "Structured output captured." }],
				details: { path: outputPath },
				terminate: true,
			};
		},
	};
	registerSuiteOwnedTool(pi, tool, {
		activity: {
			categories: ["record-result"],
			classify: ({ result }) =>
				singleActivity("record-result", {
					key: activityKey(result?.details.path ?? outputPath),
					target: "final output",
				}),
		},
		runningSummary: "validating",
		summarize: () => "captured",
		target: () => "final output",
	});
}

export default function registerSubagentPromptRuntime(pi: ExtensionAPI): void {
	registerSteeringInbox(pi);
	registerToolBudget(
		pi,
		decodeToolBudgetEnv(process.env[TOOL_BUDGET_ENV], { allowZero: process.env[TOOL_BUDGET_ZERO_AUTH_ENV] === "1" }),
	);
	let nativeSupervisorClientRegistered = false;
	let nativeSupervisorFallbackRegistered = false;
	let reportedModelContextKey: string | undefined;
	const registerNativeSupervisorClientOnce = (): void => {
		if (nativeSupervisorClientRegistered) return;
		nativeSupervisorClientRegistered = true;
		registerNativeSupervisorClient(pi, { includeIntercomFallback: false });
	};
	const registerNativeSupervisorFallbackOnce = (): void => {
		registerNativeSupervisorClientOnce();
		if (nativeSupervisorFallbackRegistered) return;
		nativeSupervisorFallbackRegistered = true;
		registerNativeSupervisorClient(pi);
	};
	pi.on("session_start", () => {
		registerNativeSupervisorClientOnce();
	});
	pi.on("agent_start", () => {
		refreshChildToolDiagnostic(pi);
	});
	pi.on("before_provider_request", (_event, ctx) => {
		if (refreshChildToolDiagnostic(pi)) {
			ctx.abort();
			return;
		}
		// Context Management/Magic owns projection and actual Provider overflow recovery.
		// A local serialization estimate cannot establish that this valid request must stop.
	});
	registerStructuredOutputTool(pi);
	pi.on("context", (event, ctx) => {
		const messages = stripParentOnlySubagentMessages(event.messages, {
			sanitizeToolIds: !COMPOSITE_TOOL_ID_APIS.has(ctx.model?.api ?? ""),
		});
		if (messages === event.messages) return undefined;
		return { messages };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const model = ctx?.model;
		if (
			model &&
			isRuntimeString(model.provider) &&
			model.provider.trim() &&
			isRuntimeString(model.id) &&
			model.id.trim() &&
			isRuntimeNumber(model.contextWindow) &&
			Number.isSafeInteger(model.contextWindow) &&
			model.contextWindow > 0
		) {
			const context: ChildModelContext = {
				provider: model.provider,
				model: model.id,
				contextWindow: model.contextWindow,
			};
			const key = [context.provider, context.model, String(context.contextWindow)].join("\u0000");
			if (key !== reportedModelContextKey) {
				pi.appendEntry(CHILD_MODEL_CONTEXT_ENTRY_TYPE, { version: 1, ...context });
				reportedModelContextKey = key;
			}
		}
		if (readRequiredChildTools()?.includes("intercom")) registerNativeSupervisorFallbackOnce();
		const intercomSessionName = process.env[SUBAGENT_INTERCOM_SESSION_NAME_ENV]?.trim();
		if (intercomSessionName && isRuntimeFunction(pi.setSessionName)) {
			pi.setSessionName(intercomSessionName);
		}

		const inheritProjectContext = readBooleanEnv(SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV);
		const inheritSkills = readBooleanEnv(SUBAGENT_INHERIT_SKILLS_ENV);
		const fanoutChild = readBooleanEnv(SUBAGENT_FANOUT_CHILD_ENV);
		let rewritten = event.systemPrompt;
		if (inheritProjectContext !== undefined || inheritSkills !== undefined || fanoutChild !== undefined) {
			rewritten = rewriteSubagentPrompt(event.systemPrompt, {
				fanoutChild: fanoutChild === true,
			});
		}
		if (rewritten === event.systemPrompt) return;
		return { systemPrompt: rewritten };
	});
}
