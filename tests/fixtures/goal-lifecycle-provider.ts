import { appendFileSync } from "node:fs";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Guard } from "typebox/guard";
import type { JsonInputValue } from "../../packages/pi-stuff/src/shared/json-value.js";
import { registerFixtureProvider, ZERO_USAGE } from "./faux-provider.js";

const PROVIDER = "pi-stuff-goal-lifecycle";
const MODEL = "fixture-model";
const PROJECTED_USAGE = { ...ZERO_USAGE, input: 12_000, totalTokens: 12_000 };
const NORMAL_USAGE = { ...ZERO_USAGE, input: 2_500, totalTokens: 2_500 };
const COMPLETE_FINAL_PROMPT = "The Goal is complete. Send the user a concise final response now";
const BLOCKED_FINAL_PROMPT = "The Goal is blocked. Send the user a concise final response now";

export const GOAL_FINAL_RESPONSE = "Goal finished and verified. No remaining risks were found.";
export const BUDGETED_GOAL_FINAL_RESPONSE =
	"Goal finished and verified using 2.5k of the 20k token budget. No remaining risks were found.";
export const BLOCKED_GOAL_FINAL_RESPONSE =
	"The Goal is blocked because production signing needs an unavailable hardware credential. Provide that credential to continue.";
export const CODE_MODE_GOAL_FINAL_RESPONSE =
	"The Code Mode Goal finished and was verified. No remaining risks were found.";

type Scenario = "blocker" | "code-mode" | "compaction" | "manual-compaction" | "normal" | "reload" | "retry";

let providerCalls = 0;
let goalCalls = 0;

function scenario(): Scenario {
	const value = process.env["PI_STUFF_GOAL_LIFECYCLE_SCENARIO"];
	if (
		value === "blocker" ||
		value === "code-mode" ||
		value === "compaction" ||
		value === "manual-compaction" ||
		value === "normal" ||
		value === "reload" ||
		value === "retry"
	)
		return value;
	throw new Error(`Unknown Goal lifecycle scenario: ${value ?? "missing"}`);
}

function log(record: Record<string, JsonInputValue>): void {
	const path = process.env["PI_STUFF_GOAL_LIFECYCLE_LOG"];
	if (path) appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function message(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	usage: AssistantMessage["usage"] = ZERO_USAGE,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: PROVIDER,
		model: MODEL,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function stream(
	content: AssistantMessage["content"],
	stopReason: "length" | "stop" | "toolUse",
	usage: AssistantMessage["usage"] = ZERO_USAGE,
) {
	const result = createAssistantMessageEventStream();
	const pending = message([], "pending", usage);
	result.push({ type: "start", partial: pending });
	for (const [contentIndex, item] of content.entries()) {
		pending.content.push(item);
		if (item.type === "text") {
			result.push({ type: "text_start", contentIndex, partial: pending });
			result.push({ type: "text_delta", contentIndex, delta: item.text, partial: pending });
			result.push({ type: "text_end", contentIndex, content: item.text, partial: pending });
		} else if (item.type === "toolCall") {
			result.push({ type: "toolcall_start", contentIndex, partial: pending });
			result.push({ type: "toolcall_end", contentIndex, toolCall: item, partial: pending });
		}
	}
	result.push({ type: "done", reason: stopReason, message: message(content, stopReason, usage) });
	return result;
}

function textStream(text: string, usage: AssistantMessage["usage"] = ZERO_USAGE) {
	return stream([{ type: "text", text }], "stop", usage);
}

function toolStream<Arguments extends object>(name: string, arguments_: Arguments) {
	return stream(
		[
			{
				type: "toolCall",
				id: `goal-lifecycle-${String(providerCalls)}`,
				name,
				arguments: arguments_,
			},
		],
		"toolUse",
	);
}

function contextText(context: Context): string {
	const text = [context.systemPrompt ?? ""];
	for (const entry of context.messages) {
		const content = entry.content;
		if (Guard.IsString(content)) {
			text.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const item of content) {
			if (item.type === "text") text.push(item.text);
		}
	}
	return text.join("\n");
}

function goalId(context: Context): string {
	const id = [...contextText(context).matchAll(/<goal_id>\s*([^<\s]+)\s*<\/goal_id>/gu)].at(-1)?.[1];
	if (!id) throw new Error("Goal lifecycle fixture did not receive a goal_id");
	return id;
}

function completion(context: Context) {
	return toolStream("goal_complete", {
		goal_id: goalId(context),
		summary: "Packed lifecycle objective completed and verified.",
		evidence: [
			{
				requirement: "Exercise the requested packed Goal lifecycle",
				proof: "The certified Pi host persisted and observed the required lifecycle transition.",
			},
		],
	});
}

function codeModeCompletion(context: Context) {
	const arguments_ = {
		goal_id: goalId(context),
		summary: "Packed Code Mode lifecycle objective completed and verified.",
		evidence: [
			{
				requirement: "Complete the requested Goal through Code Mode",
				proof: "The certified Pi host executed goal_complete inside the Code Mode envelope and observed the terminal transition.",
			},
		],
	};
	return toolStream("codemode", {
		code: `const result = await tools.goal_complete(${JSON.stringify(arguments_)}); text(result);`,
	});
}

function blocker(context: Context, attempt: number) {
	const attemptedActions = [
		"Checked the local credential store for the production signing key.",
		"Queried the process environment for an alternate production signing key.",
		"Requested signing through the configured hardware agent socket.",
	];
	return toolStream("goal_blocked", {
		goal_id: goalId(context),
		reason: "Production signing requires an unavailable hardware credential",
		attempt: attemptedActions[attempt - 1],
		evidence: `The attempted signing path returned an unavailable hardware signer result on audit turn ${String(attempt)}.`,
		repeated_turns: attempt,
	});
}

function response(context: Context) {
	providerCalls += 1;
	const selected = scenario();
	const projected = contextText(context);
	const finalKind =
		selected === "retry" && goalCalls !== 5
			? undefined
			: projected.includes(BLOCKED_FINAL_PROMPT)
				? "blocked"
				: projected.includes(COMPLETE_FINAL_PROMPT)
					? "complete"
					: undefined;
	if (!/<goal_id>/u.test(projected) && !finalKind) {
		log({ type: "provider_call", scenario: selected, providerCalls, historical: true });
		return textStream(`Historical packed context ${"x".repeat(20_000)}`);
	}
	goalCalls += 1;
	log({
		type: "provider_call",
		scenario: selected,
		providerCalls,
		goalCalls,
		phase: selected === "retry" && goalCalls >= 2 && goalCalls <= 4 ? "retry" : (finalKind ?? "goal"),
		tools: (context.tools ?? []).map((tool) => tool.name),
	});
	if (selected === "retry" && goalCalls >= 2 && goalCalls <= 4) {
		const failure = {
			...message([], "error"),
			errorMessage: "503 service unavailable: final response fixture failure",
		};
		const result = createAssistantMessageEventStream();
		result.push({ type: "error", reason: "error", error: failure });
		return result;
	}
	if (selected === "retry" && goalCalls > 6) throw new Error("Retry fixture exceeded its bounded Provider sequence");
	if (selected === "code-mode" && !finalKind && goalCalls > 2) {
		throw new Error("Code Mode lifecycle fixture exceeded its bounded Provider sequence");
	}
	if (finalKind === "blocked") return textStream(BLOCKED_GOAL_FINAL_RESPONSE);
	if (finalKind === "complete") {
		if (selected === "normal") {
			if (!projected.includes("Token budget used: 2.5k/20k.")) {
				throw new Error("Goal lifecycle fixture did not receive final token budget usage");
			}
			const elapsed = /Elapsed time: ([^\n]+)\./u.exec(projected)?.[1];
			if (!elapsed) {
				throw new Error("Goal lifecycle fixture did not receive final elapsed time");
			}
			return textStream(`${BUDGETED_GOAL_FINAL_RESPONSE} Elapsed time: ${elapsed}.`);
		}
		return textStream(selected === "code-mode" ? CODE_MODE_GOAL_FINAL_RESPONSE : GOAL_FINAL_RESPONSE);
	}
	if (selected === "normal") {
		return goalCalls === 1 ? textStream("Initial packed pass is incomplete.", NORMAL_USAGE) : completion(context);
	}
	if (selected === "code-mode") return codeModeCompletion(context);
	if (selected === "reload" || selected === "retry" || selected === "manual-compaction") return completion(context);
	if (selected === "compaction") {
		if (goalCalls === 1) return toolStream("goal_large_result", {});
		return goalCalls === 2
			? textStream("Post-Tool compaction preserved the active Goal.", PROJECTED_USAGE)
			: completion(context);
	}
	const blockerAttempt = Math.floor((goalCalls + 1) / 2);
	return goalCalls % 2 === 1
		? blocker(context, blockerAttempt)
		: textStream(`Blocker attempt ${String(blockerAttempt)} recorded; continue the audit.`);
}

export function activeGoal(objective: string) {
	const now = Date.now();
	return {
		id: crypto.randomUUID(),
		text: objective,
		status: "active",
		startedAt: now - 1_000,
		updatedAt: now - 1_000,
		iteration: 1,
		tokensUsed: 0,
		timeUsedSeconds: 1,
		baselineTokens: 0,
	};
}

export default function goalLifecycleProvider(pi: ExtensionAPI): void {
	pi.on("session_compact_failed", (event) => {
		log({
			type: "session_compact_failed",
			aborted: event.aborted,
			fromExtension: event.fromExtension,
			reason: event.reason,
			willRetry: event.willRetry,
		});
	});
	registerFixtureProvider(
		pi,
		PROVIDER,
		MODEL,
		"Pi Stuff Goal lifecycle fixture",
		(_model, context) => response(context),
		{ contextWindow: 24_000 },
	);
	pi.registerTool({
		description: "Return one large Tool result that crosses the post-Tool compaction threshold",
		execute: async () => ({
			content: [{ text: `GOAL_POST_TOOL_CANARY\n${"x".repeat(48_000)}`, type: "text" }],
			details: { certified: true },
		}),
		label: "Large result",
		name: "goal_large_result",
		parameters: Type.Object({}),
	});

	pi.registerCommand("goal-lifecycle-wait", {
		description: "Wait for packed Goal lifecycle work to settle",
		handler: async (_args, ctx) => {
			// RPC accepts a prompt before its agent run is scheduled. Yield once so
			// waitForIdle observes that scheduled work instead of the preceding idle edge.
			await new Promise((resolve) => setTimeout(resolve, 50));
			await ctx.waitForIdle();
		},
	});

	pi.registerCommand("goal-lifecycle-seed", {
		description: "Seed an active packed Goal and reload its extension runtime",
		handler: async (_args, ctx) => {
			const selected = scenario();
			if (selected !== "reload" && selected !== "retry") {
				throw new Error(`Cannot seed scenario ${selected}`);
			}
			pi.appendEntry("goal-state", {
				goal: activeGoal("Certify active Goal continuation across reload"),
				queue:
					selected === "retry"
						? [{ ...activeGoal("Certify queued Goal after final-response retries"), status: "queued" }]
						: [],
			});
			await ctx.reload();
			return;
		},
	});

	pi.on("agent_start", () => log({ type: "agent_start", duringGoal: goalCalls > 0 }));
	pi.on("tool_call", (event) => log({ type: "tool_call", toolCallId: event.toolCallId, toolName: event.toolName }));
	pi.on("tool_execution_start", (event) =>
		log({ type: "tool_execution_start", toolCallId: event.toolCallId, toolName: event.toolName }),
	);
	pi.on("tool_execution_end", (event) =>
		log({
			type: "tool_execution_end",
			isError: event.isError,
			toolCallId: event.toolCallId,
			toolName: event.toolName,
		}),
	);

	pi.on("session_before_compact", (event) => {
		if (scenario() !== "compaction") return;
		log({ type: "session_before_compact", reason: event.reason });
		return {
			compaction: {
				summary: "Packed Goal compaction lifecycle summary.",
				firstKeptEntryId: event.preparation.firstKeptEntryId,
				tokensBefore: event.preparation.tokensBefore,
				details: { certified: true },
			},
		};
	});
	pi.on("session_compact", async (event, ctx) => {
		log({ type: "session_compact", reason: event.reason, idle: ctx.isIdle() });
		if (scenario() === "manual-compaction") {
			// A later asynchronous handler must not be mistaken for an idle Host.
			await new Promise((resolve) => setTimeout(resolve, 35));
			log({ type: "manual_compaction_handler_complete" });
		}
	});
	pi.on("session_start", (event) => log({ type: "session_start", reason: event.reason }));
}
