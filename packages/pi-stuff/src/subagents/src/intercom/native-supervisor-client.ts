import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { isRuntimeString } from "../../../shared/runtime-type.ts";
import type { ToolArguments } from "../../../tool-display/activity.ts";
import { activityKey, getToolUiRuntime, registerSuiteOwnedTool, singleActivity } from "../../../tool-display/index.ts";
import {
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_PHYSICAL_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_TARGET_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
} from "../runs/shared/pi-args.ts";
import {
	askTimeoutMs,
	discardSupervisorRequest,
	publishSupervisorRequest,
	resolveSupervisorChannelDir,
	type SupervisorReason,
	type SupervisorRequest,
	waitForSupervisorReply,
} from "./native-supervisor-storage.ts";

interface ContactSupervisorParams {
	reason: SupervisorReason;
	message?: string;
	interview?: unknown;
}

export interface IntercomParams {
	action: "list" | "send" | "ask" | "reply" | "pending" | "status";
	to?: string;
	message?: string;
	replyTo?: string;
}

const ContactSupervisorParamsSchema = Type.Object(
	{
		reason: Type.String({ enum: ["need_decision", "interview_request", "progress_update"] }),
		message: Type.Optional(Type.String()),
		interview: Type.Optional(Type.Unsafe({ type: "object", additionalProperties: true })),
	},
	{ additionalProperties: false },
);

export const IntercomParamsSchema = Type.Object(
	{
		action: Type.String({ enum: ["list", "send", "ask", "reply", "pending", "status"] }),
		to: Type.Optional(Type.String()),
		message: Type.Optional(Type.String()),
		replyTo: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

function readTextEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function readChildMetadata():
	| {
			channelDir: string;
			runId: string;
			agent: string;
			childIndex: number;
			orchestratorTarget?: string | undefined;
			orchestratorSessionId?: string;
			physicalSessionId: string;
			childTarget?: string | undefined;
	  }
	| undefined {
	const channelDir = readTextEnv(SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV);
	const runId = readTextEnv(SUBAGENT_RUN_ID_ENV);
	const agent = readTextEnv(SUBAGENT_CHILD_AGENT_ENV);
	const rawIndex = readTextEnv(SUBAGENT_CHILD_INDEX_ENV);
	const orchestratorSessionId = readTextEnv(SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV);
	const physicalSessionId = readTextEnv(SUBAGENT_ORCHESTRATOR_PHYSICAL_SESSION_ID_ENV);
	if (
		!channelDir ||
		!runId ||
		!agent ||
		!orchestratorSessionId ||
		!physicalSessionId ||
		rawIndex === undefined ||
		!/^\d+$/.test(rawIndex)
	)
		return undefined;
	const childIndex = Number(rawIndex);
	if (!Number.isSafeInteger(childIndex)) return undefined;
	if (
		path.resolve(channelDir) !==
		path.resolve(resolveSupervisorChannelDir(runId, agent, childIndex, physicalSessionId))
	) {
		return undefined;
	}
	return {
		channelDir,
		runId,
		agent,
		childIndex,
		orchestratorTarget: readTextEnv(SUBAGENT_ORCHESTRATOR_TARGET_ENV),
		orchestratorSessionId,
		physicalSessionId,
		childTarget: readTextEnv("PI_SUBAGENT_INTERCOM_SESSION_NAME"),
	};
}

function reasonHeading(reason: SupervisorReason): string {
	if (reason === "interview_request") return "Subagent requests a structured supervisor interview.";
	if (reason === "progress_update") return "Subagent progress update.";
	return "Subagent needs a supervisor decision.";
}

function formatChildMessage(input: {
	reason: SupervisorReason;
	message?: string | undefined;
	interview?: unknown;
	runId: string;
	agent: string;
	childIndex: number;
	childTarget?: string | undefined;
}): string {
	const lines = [
		reasonHeading(input.reason),
		`Run: ${input.runId}`,
		`Agent: ${input.agent}`,
		`Child index: ${input.childIndex}`,
	];
	if (input.childTarget) lines.push(`Child intercom target: ${input.childTarget}`);
	lines.push("");
	if (input.message?.trim()) lines.push(input.message.trim());
	if (input.reason === "interview_request") {
		lines.push(
			"",
			"Structured response requested. Reply with JSON, optionally fenced in ```json, matching the requested interview shape.",
		);
		if (input.interview !== undefined) lines.push(JSON.stringify(input.interview, null, "\t"));
	}
	return lines.join("\n").trimEnd();
}

function parseStructuredReply(message: string) {
	const trimmed = message.trim();
	const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1]?.trim();
	try {
		return { value: JSON.parse(fenced ?? trimmed) };
	} catch (error) {
		return { error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
	}
}

interface SupervisorRequestDetails {
	delivered?: true;
	readonly reason: SupervisorReason;
	readonly requestId: string;
	structuredReply?: unknown;
	structuredReplyParseError?: string;
}

type NativeCommunicationDetails =
	| SupervisorRequestDetails
	| { readonly active: true }
	| { readonly sessions: readonly never[] };

async function sendSupervisorRequest(
	params: ContactSupervisorParams,
	signal?: AbortSignal,
): Promise<AgentToolResult<SupervisorRequestDetails>> {
	const metadata = readChildMetadata();
	if (!metadata) throw new Error("Native supervisor channel is not available for this subagent.");
	if (params.reason !== "progress_update" && !params.message?.trim() && params.reason !== "interview_request") {
		throw new Error("message is required for supervisor decisions.");
	}
	const requestId = randomUUID();
	const expectsReply = params.reason !== "progress_update";
	const createdAt = Date.now();
	const replyDeadline = createdAt + askTimeoutMs();
	const expiresAt = replyDeadline;
	const message = formatChildMessage({
		...metadata,
		reason: params.reason,
		message: params.message,
		interview: params.interview,
	});
	const request: SupervisorRequest = {
		type: "subagent.supervisor.request",
		id: requestId,
		createdAt,
		expiresAt,
		reason: params.reason,
		message,
		expectsReply,
		physicalSessionId: metadata.physicalSessionId,
		runId: metadata.runId,
		agent: metadata.agent,
		childIndex: metadata.childIndex,
	};
	if (metadata.orchestratorTarget) request.orchestratorTarget = metadata.orchestratorTarget;
	if (metadata.orchestratorSessionId) request.orchestratorSessionId = metadata.orchestratorSessionId;
	if (metadata.childTarget) request.childTarget = metadata.childTarget;
	if (params.interview !== undefined) request.interview = params.interview;
	await publishSupervisorRequest(metadata.channelDir, metadata, request, signal);

	if (!expectsReply) {
		return {
			content: [{ type: "text", text: "Supervisor progress update queued." }],
			details: { delivered: true, requestId, reason: params.reason },
		};
	}

	try {
		const reply = await waitForSupervisorReply(metadata.channelDir, requestId, replyDeadline, signal);
		const details: SupervisorRequestDetails = { requestId, reason: params.reason };
		if (params.reason === "interview_request") {
			const structured = parseStructuredReply(reply.message);
			if (structured.error) details.structuredReplyParseError = structured.error;
			else details.structuredReply = structured.value;
		}
		return {
			content: [{ type: "text", text: `**Reply from supervisor:**\n${reply.message}` }],
			details,
		};
	} catch (error) {
		discardSupervisorRequest(metadata.channelDir, requestId);
		throw error;
	}
}

export function hasLiveTool(pi: ExtensionAPI, name: string): boolean {
	if (getToolUiRuntime(pi).isReplayOnlyTool(name)) return false;
	try {
		return pi.getAllTools?.().some((tool: { name?: unknown }) => tool.name === name) === true;
	} catch {
		return false;
	}
}

function toolResultText<Details>(result: AgentToolResult<Details>): string {
	for (const entry of result.content) {
		if (entry.type !== "text") continue;
		const preview = entry.text.slice(0, 8 * 1024).trim();
		if (preview) return preview;
	}
	return "";
}

function communicationTarget(args: ToolArguments): string {
	const action = isRuntimeString(args["action"])
		? args["action"]
		: isRuntimeString(args["reason"])
			? args["reason"]
			: "";
	const destination = isRuntimeString(args["replyTo"])
		? args["replyTo"]
		: isRuntimeString(args["to"])
			? args["to"]
			: "";
	return [action, destination].filter(Boolean).join(" · ");
}

function communicationCategory(args: ToolArguments) {
	const action = isRuntimeString(args["action"]) ? args["action"] : "";
	return action === "status" || action === "list" || action === "pending" ? "check-agent" : "message-agent";
}

export function registerCommunicationTool<TParams extends TSchema, Details>(
	pi: ExtensionAPI,
	tool: ToolDefinition<TParams, Details>,
	runningSummary: string,
): void {
	registerSuiteOwnedTool(pi, tool, {
		activity: {
			categories: ["check-agent", "message-agent"],
			classify: ({ args }) =>
				singleActivity(communicationCategory(args), {
					key: activityKey(args["action"], args["to"], args["replyTo"]),
					target: communicationTarget(args),
				}),
		},
		runningSummary,
		summarize: (_args, result, state) => toolResultText(result) || (state === "success" ? "done" : "failed"),
		target: communicationTarget,
	});
}

export function registerNativeSupervisorClient(
	pi: ExtensionAPI,
	options: { includeIntercomFallback?: boolean } = {},
): void {
	if (!readChildMetadata()) return;
	const includeIntercomFallback = options.includeIntercomFallback !== false;
	if (!hasLiveTool(pi, "contact_supervisor")) {
		const tool: ToolDefinition<typeof ContactSupervisorParamsSchema, SupervisorRequestDetails> = {
			name: "contact_supervisor",
			label: "Contact Supervisor",
			description:
				"Contact the parent/supervisor session for a blocking decision, structured interview, or progress update.",
			parameters: ContactSupervisorParamsSchema,
			execute(_id, params, signal) {
				// SAFETY: Pi validates Tool arguments against ContactSupervisorParamsSchema before execute.
				return sendSupervisorRequest(params as ContactSupervisorParams, signal);
			},
		};
		registerCommunicationTool(pi, tool, "contacting");
	}
	if (includeIntercomFallback && !hasLiveTool(pi, "intercom")) {
		const tool: ToolDefinition<typeof IntercomParamsSchema, NativeCommunicationDetails> = {
			name: "intercom",
			label: "Intercom",
			description:
				"Native supervisor-channel intercom fallback for subagents. Prefer contact_supervisor when available.",
			parameters: IntercomParamsSchema,
			async execute(_id, params, signal) {
				// SAFETY: Pi validates Tool arguments against IntercomParamsSchema before execute.
				const input = params as IntercomParams;
				const action = input.action;
				if (action === "status")
					return {
						content: [{ type: "text", text: "Native supervisor channel is active." }],
						details: { active: true },
					};
				if (action === "list")
					return {
						content: [{ type: "text", text: "Supervisor session available through contact_supervisor." }],
						details: { sessions: [] },
					};
				if (action === "send")
					return sendSupervisorRequest({ reason: "progress_update", message: input.message ?? "" }, signal);
				if (action === "ask")
					return sendSupervisorRequest({ reason: "need_decision", message: input.message ?? "" }, signal);
				throw new Error(
					"Native child intercom supports status, list, send, and ask. Use parent intercom reply from the supervisor session.",
				);
			},
		};
		registerCommunicationTool(pi, tool, "sending");
	}
}
