import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { type Context, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	isJsonInputObject,
	type JsonInputObject,
	parseJsonValue,
} from "../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { createAssistantMessage, createTextStream, registerFixtureProvider } from "./faux-provider.js";

const usageUrl = process.env["PSYON_USAGE_URL"];
const child = process.env["PI_SUBAGENT_CHILD"] === "1";
const agentMode = process.env["PSYON_AGENT_MODE"];
const contextWork = process.env["PSYON_CONTEXT"] === "1";
const goalWork = process.env["PSYON_GOAL"] === "1";
let goalFinalResponseSent = false;
let deliveredBackgroundResults = 0;
const baseMessage = createAssistantMessage(usageUrl ? "openai-codex" : "psyon-cadence", "cadence-model");
const message: typeof baseMessage = (content, reason, usage) => ({
	...baseMessage(content, reason, usage),
	api: usageUrl ? "openai-responses" : "openai-completions",
});

function log(record: JsonInputObject): void {
	const path = process.env["PSYON_PROVIDER_LOG"];
	if (path)
		appendFileSync(
			path,
			`${JSON.stringify({ ...record, pid: process.pid, atMs: performance.timeOrigin + performance.now(), role: child ? "child" : "parent" })}\n`,
		);
}

function block(phase: string): void {
	if (child) return;
	if ((process.env["PSYON_NEGATIVE_BLOCK_PHASE"] ?? "pre-tool") !== phase) return;
	const until = performance.now() + Number(process.env["PSYON_NEGATIVE_BLOCK_MS"] ?? 0);
	// Explicit negative control; never enabled in ordinary responsiveness samples.
	while (performance.now() < until) {}
}

function nextToolCall(index: number) {
	const name = agentMode && !child ? "subagent" : "bash";
	const args: JsonInputObject =
		name === "subagent"
			? {
					agent: "cadence-agent",
					task: "PSYON_CHILD_TASK",
					context: "fresh",
					foreground: agentMode === "foreground",
				}
			: { command: "sleep 2; printf PSYON_TOOL_RESULT" };
	const codeMode = process.env["PSYON_TOOL_MODE"] === "codemode";
	return {
		type: "toolCall" as const,
		id: `cadence-${name}-${String(index)}`,
		name: codeMode ? "codemode" : name,
		arguments: codeMode ? { code: `text(await tools.${name}(${JSON.stringify(args)}));` } : args,
	};
}

// The observer owns this server, outside the measured Host process tree. Pi uses its native Responses transport.
export async function respondToContextRequest(
	request: Request,
	codeMode: boolean,
	requests: { body: string; naming: boolean }[],
): Promise<Response> {
	assert.equal(new URL(request.url).pathname, "/backend-api/responses");
	const body = await request.text();
	const payload = parseJsonValue(body);
	assert(isJsonInputObject(payload) && payload["model"] === "cadence-model" && payload["stream"] === true);
	const naming = body.includes("concise semantic labels for coding sessions");
	requests.push({ body, naming });
	const index = requests.filter((entry) => !entry.naming).length - 1;
	if (!naming) {
		assert(index >= 0 && index <= 2, "Unexpected Context request");
		const input = payload["input"];
		assert(Array.isArray(input), "Native Responses input is missing");
		const text = input
			.flatMap((entry) => {
				if (!isJsonInputObject(entry)) return [];
				const content = entry["content"];
				return isRuntimeString(content)
					? [content]
					: Array.isArray(content)
						? content.flatMap((part) =>
								isJsonInputObject(part) && isRuntimeString(part["text"]) ? [part["text"]] : [],
							)
						: [];
			})
			.join("\n");
		assert(text.includes("## Magic Context"), "Context instructions are absent from the wire payload");
		assert(
			/<session-history-since(?:\s[^>]*)?>[\s\S]*?<\/session-history-since>/u.test(text) &&
				/^§\d+§ PSYON_MEASURE$/mu.test(text),
			"User input is absent from active Context projection",
		);
		if (index === 2)
			assert(
				input.some(
					(entry) =>
						isJsonInputObject(entry) &&
						entry["type"] === "function_call_output" &&
						isRuntimeString(entry["output"]) &&
						entry["output"].includes("PSYON_CONTEXT_EVIDENCE"),
				),
				"Retrieved Context evidence is absent from the wire payload",
			);
		await Bun.sleep(4_000);
	}
	const done = naming || index === 2;
	const name = index === 0 ? "ctx_memory" : "ctx_search";
	const args =
		index === 0
			? { action: "write", category: "PROJECT_RULES", content: "PSYON_CONTEXT_KEY: PSYON_CONTEXT_EVIDENCE" }
			: { query: "PSYON_CONTEXT_KEY" };
	const item: JsonInputObject = done
		? {
				id: "msg_cadence",
				type: "message",
				role: "assistant",
				status: "completed",
				content: [
					{
						type: "output_text",
						text: naming ? "Cadence Resource Fixture" : "PSYON_CADENCE_DONE",
						annotations: [],
					},
				],
			}
		: {
				id: `fc_cadence_${String(index)}`,
				type: "function_call",
				call_id: `cadence_${String(index)}`,
				name: codeMode ? "codemode" : name,
				arguments: JSON.stringify(
					codeMode ? { code: `text(await tools.${name}(${JSON.stringify(args)}));` } : args,
				),
				status: "completed",
			};
	const response = { id: `resp_cadence_${String(index)}`, status: "completed", output: [item] };
	return new Response(
		[
			{ type: "response.created", response: { id: response.id, status: "in_progress" } },
			{ type: "response.output_item.done", output_index: 0, item },
			{ type: "response.completed", response },
		]
			.map((event) => `data: ${JSON.stringify(event)}\n\n`)
			.join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

async function seedLedger(pi: ExtensionAPI, context: ExtensionContext): Promise<void> {
	// Native-only calibration must not import the Suite. Only the preparatory seed process loads this Module.
	const { CodeModeSessionLedger, CODE_MODE_LEDGER_ENTRY_TYPE } = await import(
		"../../packages/pi-stuff/src/code-mode/ledger.js"
	);
	const ledger = new CodeModeSessionLedger(pi);
	const value = "x".repeat(800_000);
	for (let index = 0; index < 24; index += 1) {
		const execution = ledger.begin(
			context,
			`seed-${String(index)}`,
			"text('fixture')",
			new Map([["read", "record"]]),
		);
		execution.beginPass(0);
		const plan = execution.beginToolCall("read", { path: `synthetic-${String(index)}` });
		execution.completeToolCall(plan, { status: "success", value });
		execution.finish("success");
		if (index === 23 && process.env["PSYON_LEDGER_SNIPPET"] === "1") {
			ledger.saveSnippet(context, execution.executionId, "resource-seed");
		}
	}
	const entries = context.sessionManager
		.getBranch()
		.filter((entry) => entry.type === "custom" && entry.customType === CODE_MODE_LEDGER_ENTRY_TYPE);
	assert.equal(entries.length, process.env["PSYON_LEDGER_SNIPPET"] === "1" ? 97 : 96);
	log({
		type: "seed-ready",
		entries: entries.length,
		bytes: entries.reduce((sum, entry) => sum + Buffer.byteLength(JSON.stringify(entry)), 0),
	});
}

function goalResponse(context: Context) {
	const projected = [
		context.systemPrompt ?? "",
		...context.messages.flatMap((entry) =>
			isRuntimeString(entry.content)
				? [entry.content]
				: entry.content.flatMap((part) => (part.type === "text" ? [part.text] : [])),
		),
	].join("\n");
	if (projected.includes("The Goal is complete. Send the user a concise final response now")) {
		const result = context.messages.find(
			(entry) => entry.role === "toolResult" && entry.toolName === "goal_complete",
		);
		assert(result?.role === "toolResult" && !result.isError, "Goal completion Tool failed");
		log({ type: "goal-final-request" });
		return { type: "text" as const, text: "PSYON_CADENCE_DONE" };
	}
	const goalId = [...projected.matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/gu)].at(-1)?.[1];
	assert(goalId, "Goal prompt did not contain its identity");
	if (!projected.includes("PSYON_GOAL_PROGRESS"))
		return { type: "text" as const, text: "PSYON_GOAL_PROGRESS: first pass is incomplete." };
	assert(projected.includes("pi-goal-continuation:"), "Goal did not request automatic continuation");
	log({ type: "goal-continuation" });
	return {
		type: "toolCall" as const,
		id: "cadence-goal-complete",
		name: "goal_complete",
		arguments: {
			goal_id: goalId,
			summary: "Synthetic Goal continuation completed and verified.",
			evidence: [
				{
					requirement: "Verify automatic Goal continuation after an incomplete first pass.",
					proof: "The second Provider request contains PSYON_GOAL_PROGRESS and the native Goal continuation prompt.",
				},
			],
		},
	};
}

const streamSimple: NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["streamSimple"]> = (
	_model,
	context,
) => {
	if (process.env["PSYON_SEED_LEDGER"] === "1") return createTextStream(message)("PSYON_SEEDED");
	if (context.systemPrompt?.includes("concise semantic labels for coding sessions")) {
		log({ type: "naming-request" });
		return createTextStream(message)("Cadence Resource Fixture");
	}
	const results = context.messages.filter((entry) => entry.role === "toolResult");
	const backgroundResults = context.messages.filter((entry) => {
		if (entry.role !== "user") return false;
		const text = JSON.stringify(entry.content);
		return (
			text.includes("Delegated Agent result (") &&
			text.includes("PSYON_CHILD_DONE") &&
			text.includes("Canonical output:")
		);
	}).length;
	const integrating = !child && agentMode === "background" && backgroundResults > deliveredBackgroundResults;
	if (integrating) deliveredBackgroundResults = backgroundResults;
	log({ type: integrating ? "background-integration-request" : "agent-request", completedTools: results.length });
	const result = results.at(-1);
	const completed = results.length >= (!child && process.env["PSYON_REPEAT_TOOL"] === "1" ? 2 : 1);
	const requiredResult =
		agentMode && !child ? (agentMode === "background" ? "cadence-agent" : "PSYON_CHILD_DONE") : "PSYON_TOOL_RESULT";
	if (
		result &&
		(result.isError ||
			(!goalWork && !result.content.some((part) => part.type === "text" && part.text.includes(requiredResult))))
	) {
		throw new Error("Cadence Tool failed or omitted its required result");
	}
	const stream = createAssistantMessageEventStream();
	const pending = message([], "pending");
	stream.push({ type: "start", partial: pending });
	// Keep both parent-active and parent-idle/child-active observation windows in the background scenario.
	const responseDelayMs = completed && agentMode === "background" ? 6_000 : 4_000;
	const response = integrating
		? { type: "text" as const, text: "PSYON_BACKGROUND_INTEGRATED" }
		: goalWork
			? goalResponse(context)
			: completed
				? { type: "text" as const, text: child ? "PSYON_CHILD_DONE" : "PSYON_CADENCE_DONE" }
				: nextToolCall(results.length);
	setTimeout(() => {
		if (response.type === "text") {
			const { text } = response;
			if (goalWork && text === "PSYON_CADENCE_DONE") goalFinalResponseSent = true;
			if (text === "PSYON_CHILD_DONE" || text === "PSYON_CADENCE_DONE") log({ type: "response-complete" });
			if (text === "PSYON_BACKGROUND_INTEGRATED") log({ type: "background-integration-complete" });
			pending.content.push({ type: "text", text });
			stream.push({ type: "text_start", contentIndex: 0, partial: pending });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: pending });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
			stream.push({ type: "done", reason: "stop", message: message(pending.content, "stop") });
			return;
		}
		block("pre-tool");
		const toolCall = response;
		pending.content.push(toolCall);
		stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
		stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
		stream.push({ type: "done", reason: "toolUse", message: message([toolCall], "toolUse") });
	}, responseDelayMs);
	return stream;
};

export default async function responsivenessProvider(pi: ExtensionAPI): Promise<void> {
	let processStartIdentity: string | undefined;
	if (child) {
		const { readProcessStartIdentity } = await import(
			"../../packages/pi-stuff/src/subagents/src/shared/process-identity.js"
		);
		processStartIdentity = readProcessStartIdentity(process.pid);
		assert(processStartIdentity, "Child process birth identity is required");
	}
	log({ type: "fixture-ready", pid: process.pid, processStartIdentity });
	if (contextWork && process.env["PSYON_SEED_LEDGER"] !== "1") {
		let completedTools = 0;
		pi.on("before_provider_request", () => log({ type: "agent-request", completedTools }));
		pi.on("tool_result", (event) => {
			assert.equal(
				event.toolName,
				process.env["PSYON_TOOL_MODE"] === "codemode"
					? "codemode"
					: completedTools === 0
						? "ctx_memory"
						: "ctx_search",
			);
			assert(!event.isError, "Context Tool failed");
			if (completedTools === 1) {
				assert(
					event.content.some((part) => part.type === "text" && part.text.includes("PSYON_CONTEXT_EVIDENCE")),
					"Context search omitted stored evidence",
				);
				log({ type: "context-retrieval" });
			}
			completedTools++;
		});
		pi.on("message_end", ({ message }) => {
			if (
				message.role === "assistant" &&
				message.stopReason === "stop" &&
				message.content.some((part) => part.type === "text" && part.text === "PSYON_CADENCE_DONE")
			)
				log({ type: "response-complete" });
		});
	}
	pi.on("session_start", async (_event, ctx) => {
		if (process.env["PSYON_SEED_LEDGER"] === "1") return seedLedger(pi, ctx);
		if (process.env["PSYON_NEGATIVE_BLOCK_PHASE"] === "startup")
			await new Promise((resolve) => setTimeout(resolve, 100));
		block("startup");
		ctx.ui.notify("PSYON_READY", "info");
	});
	pi.on("agent_end", (_event, ctx) => {
		if (!goalWork || goalFinalResponseSent) ctx.ui.notify("PSYON_AGENT_END", "info");
	});
	pi.on("agent_settled", async (_event, ctx) => {
		// The initial incomplete Goal turn must not end observation of its automatic continuation.
		if (goalWork && !goalFinalResponseSent) return;
		if (process.env["PSYON_NEGATIVE_BLOCK_PHASE"] === "settlement") {
			await new Promise((resolve) => setTimeout(resolve, 100));
			block("settlement");
		}
		// Adjacent notifications may be coalesced before the terminal paints.
		ctx.ui.notify("PSYON_AGENT_END PSYON_SETTLED", "info");
	});
	for (const name of ["psyon-one", "psyon-two"]) pi.registerCommand(name, { handler: async () => {} });
	if (usageUrl) {
		const url = new URL(usageUrl);
		assert(url.hostname === "127.0.0.1" && url.protocol === "http:", "Usage fixture must stay on loopback");
		const config: Parameters<ExtensionAPI["registerProvider"]>[1] = {
			name: "Synthetic Codex account",
			baseUrl: usageUrl,
			apiKey: "synthetic-fixture-token",
			headers: { "chatgpt-account-id": "synthetic-fixture-account" },
			api: "openai-responses",
			models: [
				{
					id: "cadence-model",
					name: "Cadence model",
					api: "openai-responses",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200_000,
					maxTokens: 4_096,
				},
			],
		};
		if (!contextWork) config.streamSimple = streamSimple;
		pi.registerProvider("openai-codex", config);
	} else registerFixtureProvider(pi, "psyon-cadence", "cadence-model", "Native cadence", streamSimple);
	pi.on("session_info_changed", (event) => log({ type: "name-persisted", name: event.name }));
}
