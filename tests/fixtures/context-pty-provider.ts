import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import type { AssistantMessage, Context, JsonValue } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type JsonInputValue, parseJsonObject } from "../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { registerSuiteOwnedTool } from "../../packages/pi-stuff/src/tool-display/registration.js";
import { registerFixtureProvider, ZERO_USAGE } from "./faux-provider.js";

const PROVIDER = "pi-stuff-context-pty";
const MODEL = "fixture-model";
const BULK_CONTEXT = "Historical Context evidence segment for real Magic Context compaction.\n".repeat(12_000);

const HIGH_USAGE = {
	...ZERO_USAGE,
	input: 190_000,
	totalTokens: 190_000,
};
const LOW_USAGE = {
	...ZERO_USAGE,
	input: 1_000,
	totalTokens: 1_000,
};

function record(value: Readonly<Record<string, JsonInputValue>>): void {
	const path = process.env["PI_STUFF_CONTEXT_PTY_LOG"];
	if (path) appendFileSync(path, `${JSON.stringify(value)}\n`);
}

function contentText(content: Context["messages"][number]["content"]): string {
	if (isRuntimeString(content)) return content;
	return content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n");
}

function stripPonytailPrompt(systemPrompt: string): string {
	let stripped = systemPrompt.replace(
		/\n*<!-- pi-stuff:prompt-contribution:ponytail:start -->[\s\S]*?<!-- pi-stuff:prompt-contribution:ponytail:end -->\n*/gu,
		"\n",
	);
	stripped = stripped.replace(/<available_skills>([\s\S]*?)<\/available_skills>/gu, (catalog, body: string) => {
		const skills = [...body.matchAll(/\s*<skill>[\s\S]*?<\/skill>/gu)].map((match) => match[0] ?? "");
		if (skills.length === 0) return catalog;
		const retained = skills.filter((skill) => !/<name>ponytail(?:-[^<]+)?<\/name>/u.test(skill));
		return retained.length > 0 ? `<available_skills>${retained.join("")}\n</available_skills>` : "";
	});
	if (!stripped.includes("<available_skills>")) {
		stripped = stripped.replace(
			/\n*The following skills provide specialized instructions for specific tasks\.[\s\S]*?use that absolute path in tool commands\.\n*/u,
			"\n",
		);
	}
	return stripped.trimEnd();
}

function allText(context: Context): string {
	return context.messages
		.map((entry) => contentText(entry.content))
		.filter(Boolean)
		.join("\n");
}

function projectedHistoryText(text: string) {
	const contents = (pattern: RegExp): string => [...text.matchAll(pattern)].map((match) => match[1] ?? "").join("\n");
	return {
		history: contents(/<session-history(?:\s[^>]*)?>([\s\S]*?)<\/session-history>/gu),
		since: contents(/<session-history-since(?:\s[^>]*)?>([\s\S]*?)<\/session-history-since>/gu),
	};
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index--) {
		const entry = context.messages[index];
		if (entry?.role === "user") return contentText(entry.content);
	}
	return "";
}

function historianPayload(prompt: string): string {
	const range = /Messages\s+(\d+)-(\d+):/.exec(prompt);
	const start = Number(range?.[1] ?? "1");
	const end = Number(range?.[2] ?? String(start));
	record({ type: "historian", model: MODEL, start, end });
	if (process.env["PI_STUFF_CONTEXT_RECOVERY_MODE"] === "no-progress")
		return `<output><compartments></compartments><facts></facts><events></events><unprocessed_from>${start}</unprocessed_from></output>`;
	return [
		"<output>",
		"<compartments>",
		`<compartment start="${String(start)}" end="${String(end)}" title="Pi Stuff Context verification" importance="50" episode_type="feature">`,
		"<p1>Preserved the verified Context session and its project-scoped decisions.</p1>",
		"<p2>Preserved the verified project Context session.</p2>",
		"<p3>Verified Context history was compacted.</p3>",
		"<p4/>",
		"</compartment>",
		"</compartments>",
		"<facts>",
		"<PROJECT_RULES>",
		"* Magic Context completed a real historian pass.",
		"</PROJECT_RULES>",
		"</facts>",
		"<events></events>",
		`<unprocessed_from>${String(end + 1)}</unprocessed_from>`,
		"</output>",
	].join("\n");
}

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	usage = ZERO_USAGE,
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

function textStream(text: string, usage = ZERO_USAGE, delayMs = 0, signal?: AbortSignal) {
	const stream = createAssistantMessageEventStream();
	const pending = assistantMessage([], "pending", usage);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	const settle = (): boolean => {
		if (settled) return false;
		settled = true;
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		return true;
	};
	const finish = (): void => {
		if (!settle()) return;
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: pending });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
		stream.push({
			type: "done",
			reason: "stop",
			message: assistantMessage([{ type: "text", text }], "stop", usage),
		});
	};
	const abort = (): void => {
		if (!settle()) return;
		stream.push({
			type: "error",
			reason: "aborted",
			error: assistantMessage([], "aborted", usage),
		});
	};
	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	if (signal?.aborted) queueMicrotask(abort);
	else if (delayMs > 0) {
		signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(finish, delayMs);
	} else finish();
	return stream;
}

function toolCallStream(id: string, name: string, argumentsValue: Record<string, JsonValue>) {
	const stream = createAssistantMessageEventStream();
	const pending = assistantMessage([], "pending");
	const toolCall = {
		type: "toolCall" as const,
		id,
		name,
		arguments: argumentsValue,
	};
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({ type: "done", reason: "toolUse", message: assistantMessage([toolCall], "toolUse") });
	return stream;
}

let recoveryRequests = 0;

function recoveryStream(context: Context, signal?: AbortSignal) {
	if (process.env["MAGIC_CONTEXT_PI_SUBAGENT"] === "1") {
		const transientMarker = `${process.env["PI_STUFF_CONTEXT_PTY_LOG"]}.transient`;
		if (process.env["PI_STUFF_CONTEXT_RECOVERY_MODE"] === "transient" && !existsSync(transientMarker)) {
			writeFileSync(transientMarker, "failed once");
			record({ type: "historian-transient-failure" });
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "error",
				reason: "error",
				error: { ...assistantMessage([], "error"), errorMessage: "503 overloaded" },
			});
			stream.end();
			return stream;
		}
		const marker = process.env["PI_STUFF_CONTEXT_PTY_HISTORIAN_MARKER"];
		if (marker) writeFileSync(marker, "ready\n");
		return textStream(
			historianPayload(lastUserText(context)),
			ZERO_USAGE,
			Number(process.env["PI_STUFF_CONTEXT_RECOVERY_DELAY"] ?? 0),
			signal,
		);
	}
	const text = allText(context);
	const lastUser = lastUserText(context);
	if (lastUser.includes("QUEUED_RECOVERY_INPUT")) return textStream("QUEUED_RECOVERY_DONE", LOW_USAGE);
	if (lastUser.includes("MAGIC_RECOVERY_ACCEPTED_INPUT")) {
		if (
			process.env["PI_STUFF_CONTEXT_RECOVERY_MODE"] === "tools" &&
			!context.messages.some(
				(message) => message.role === "toolResult" && contentText(message.content).includes("RECOVERY_TOOL_RESULT"),
			)
		) {
			return toolCallStream("recovery-side-effect", "bash", {
				command: "printf 'effect\\n' >> recovery-effect.txt; printf 'RECOVERY_TOOL_RESULT\\n'",
			});
		}
		recoveryRequests++;
		record({ type: "recovery-request", text, attempt: recoveryRequests });
		if (recoveryRequests === 1 || process.env["PI_STUFF_CONTEXT_RECOVERY_MODE"] === "exhaust") {
			const stream = createAssistantMessageEventStream();
			const error = {
				...assistantMessage([], "error"),
				errorMessage: "Your input exceeds the context window of this model",
			};
			stream.push({ type: "error", reason: "error", error });
			stream.end();
			return stream;
		}
		return textStream("MAGIC_RECOVERY_CONTINUED", LOW_USAGE);
	}
}

function fixtureStream(context: Context, signal?: AbortSignal) {
	const recovery = recoveryStream(context, signal);
	if (recovery) return recovery;
	const text = allText(context);
	const lastUser = lastUserText(context);
	const memoryResult = context.messages.find(
		(entry) => entry.role === "toolResult" && entry.toolName === "ctx_memory",
	);
	const searchResult = context.messages.find(
		(entry) => entry.role === "toolResult" && entry.toolName === "ctx_search",
	);
	const repeatSearchResult = context.messages.find(
		(entry) =>
			entry.role === "toolResult" && entry.toolName === "ctx_search" && entry.toolCallId === "context-search-2",
	);
	const interruptSearchResult = context.messages.find(
		(entry) =>
			entry.role === "toolResult" &&
			entry.toolName === "ctx_search" &&
			entry.toolCallId === "context-interrupt-search-1",
	);
	const bulkResult = context.messages.find(
		(entry) => entry.role === "toolResult" && entry.toolName === "context_bulk",
	);
	const systemPrompt = context.systemPrompt ?? "";
	const contextPrompt = stripPonytailPrompt(systemPrompt);
	const projectedHistory = projectedHistoryText(text);
	const projectedText = `${projectedHistory.history}\n${projectedHistory.since}`;
	const magicProjectionMarkers = ["CONTEXT_INPUT_HISTORY_499", "CONTEXT_SEARCH_AGAIN"].filter(
		(marker) =>
			projectedText.includes(marker) ||
			context.messages.some(
				(message) =>
					/^\s*§\d+§\s/u.test(contentText(message.content)) && contentText(message.content).includes(marker),
			),
	);
	record({
		type: "request",
		lastUser,
		projectedHistoryTail: projectedText.slice(-1_000),
		magicProjectionMarkers,
		hasContextActivityText: text.includes("Context flush") || text.includes("nothing queued"),
		hasHistory: projectedHistory.history.length > 0,
		hasSince: projectedHistory.since.length > 0,
		hasNativeSummary: text.includes("NATIVE_COMPACTION_SUMMARY_MARKER"),
		systemPromptChars: systemPrompt.length,
		contextPromptChars: contextPrompt.length,
		ponytailPromptChars: systemPrompt.length - contextPrompt.length,
		ponytailMarkerCount: systemPrompt.match(/pi-stuff:prompt-contribution:ponytail:start/gu)?.length ?? 0,
		hasPonytailPrompt: systemPrompt.includes("PONYTAIL MODE ACTIVE — level: full"),
		hasCompactMagicContextPrompt: systemPrompt.includes("## Magic Context"),
		providerPayload: parseJsonObject(JSON.stringify(context)),
		hasVerboseMagicContextPrompt: systemPrompt.includes("Most AI sessions are disposable"),
		tools: (context.tools ?? []).map((tool) => tool.name),
		searchResult: searchResult ? contentText(searchResult.content) : undefined,
	});

	if (lastUser.includes("CONTEXT_MEMORY") && !memoryResult) {
		return toolCallStream("context-memory-1", "ctx_memory", {
			action: "write",
			category: "PROJECT_RULES",
			content: "中文检索标记：真实 Context 检索证据",
		});
	}
	if (lastUser.includes("CONTEXT_MEMORY")) return textStream("CONTEXT_MEMORY_DONE");
	if (lastUser.includes("CONTEXT_ISOLATION") && !searchResult) {
		return toolCallStream("context-isolation-1", "ctx_search", { query: "中文检索标记" });
	}
	if (lastUser.includes("CONTEXT_ISOLATION")) return textStream("CONTEXT_ISOLATION_DONE");
	if (lastUser.includes("CONTEXT_SEARCH_AGAIN") && !repeatSearchResult) {
		return toolCallStream("context-search-2", "ctx_search", { query: "中文检索标记" });
	}
	if (lastUser.includes("CONTEXT_SEARCH_AGAIN")) return textStream("CONTEXT_SEARCH_AGAIN_DONE");
	if (lastUser.includes("CONTEXT_SEARCH") && !searchResult) {
		return toolCallStream("context-search-1", "ctx_search", { query: "中文检索标记" });
	}
	if (lastUser.includes("CONTEXT_SEARCH")) return textStream("CONTEXT_SEARCH_DONE");
	if (lastUser.includes("CONTEXT_BULK") && !bulkResult) {
		return toolCallStream("context-bulk-1", "context_bulk", {});
	}
	if (lastUser.includes("CONTEXT_BULK")) return textStream("CONTEXT_BULK_DONE");
	if (lastUser.includes("CONTEXT_AFTER_COMPACT")) return textStream("CONTEXT_AFTER_COMPACT_DONE", HIGH_USAGE);
	if (lastUser.includes("CONTEXT_SETTLE")) return textStream("CONTEXT_SETTLE_DONE", LOW_USAGE);
	if (lastUser.includes("CONTEXT_INTERRUPT_A") && !interruptSearchResult) {
		return toolCallStream("context-interrupt-search-1", "ctx_search", { query: "CONTEXT_INPUT_HISTORY_499" });
	}
	if (lastUser.includes("CONTEXT_INTERRUPT_A")) {
		return textStream("CONTEXT_INTERRUPT_A_UNEXPECTED", ZERO_USAGE, 60_000, signal);
	}
	if (lastUser.includes("CONTEXT_INTERRUPT_B")) return textStream("CONTEXT_INTERRUPT_B_DONE");
	if (lastUser.includes("CONTEXT_RESUME_REQUEST")) {
		return textStream("CONTEXT_RESUME_DONE", ZERO_USAGE, 2_500, signal);
	}
	if (lastUser.includes("CONTEXT_RESUME")) return textStream("CONTEXT_RESUME_DONE");
	if (lastUser.includes("CONTEXT_DRAIN")) return textStream("CONTEXT_DRAIN_DONE");
	if (lastUser.includes("CONTEXT_NATIVE_RESUME")) return textStream("CONTEXT_NATIVE_RESUME_DONE");
	if (lastUser.includes("CONTEXT_UNAVAILABLE")) return textStream("CONTEXT_UNAVAILABLE_DONE");
	if (lastUser.includes("CONTEXT_SECOND")) return textStream("CONTEXT_SECOND_DONE");
	return textStream("CONTEXT_FIRST_DONE");
}

export default function contextPtyProvider(pi: ExtensionAPI): void {
	pi.registerCommand("context-startup-ready", {
		handler: async (_args, ctx) => {
			ctx.ui.setEditorText("CONTEXT_STARTUP_READY");
		},
	});

	if (process.env["PI_STUFF_CONTEXT_PTY_AUTOMATIC_ONLY"] === "1") {
		pi.on("session_start", () => {
			pi.sendMessage(
				{
					customType: "context-automatic-fixture",
					content: "CONTEXT_AUTOMATIC",
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		});
	}

	registerSuiteOwnedTool(
		pi,
		{
			name: "context_bulk",
			label: "Context fixture",
			description: "Create a large read-only history result for Context compaction verification.",
			parameters: Type.Object({}),
			execute: async () => ({
				content: [{ type: "text" as const, text: BULK_CONTEXT }],
				details: undefined,
			}),
		},
		{
			activity: {
				categories: ["read-file"],
				classify: () => [{ category: "read-file", countKeys: ["context-fixture"] }],
			},
			label: "Context fixture",
			runningSummary: "preparing",
			summarize: () => "ready",
		},
	);

	if (process.env["PI_STUFF_CONTEXT_PTY_BUILTIN_OPENAI"] === "1") {
		const baseUrl = process.env["PI_STUFF_CONTEXT_PTY_BASE_URL"];
		if (!baseUrl) {
			throw new Error(
				"Context PTY fixture configuration error: PI_STUFF_CONTEXT_PTY_BASE_URL is required for built-in OpenAI mode",
			);
		}
		pi.registerProvider(PROVIDER, {
			name: "Pi Stuff Context PTY fixture",
			baseUrl,
			apiKey: "fixture",
			api: "openai-completions",
			models: [
				{
					api: "openai-completions",
					id: process.env["PI_STUFF_CONTEXT_PTY_MODEL"] ?? MODEL,
					name: "Pi Stuff Context PTY fixture",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: Number(process.env["PI_STUFF_CONTEXT_PTY_CONTEXT_WINDOW"] ?? "8000000"),
					maxTokens: 4_096,
				},
			],
		});
	} else {
		registerFixtureProvider(pi, PROVIDER, MODEL, "Pi Stuff Context PTY fixture", (_model, context, options) =>
			fixtureStream(context, options?.signal),
		);
	}

	pi.on("session_start", (_event, ctx) => {
		record({
			type: "session",
			cwd: ctx.cwd,
			sessionId: ctx.sessionManager.getSessionId(),
		});
	});
	pi.on("before_agent_start", () => {
		record({
			type: "inventory",
			subagent: process.env["MAGIC_CONTEXT_PI_SUBAGENT"] === "1",
			commands: pi.getCommands().map((command) => command.name),
			tools: pi.getAllTools().map((tool) => tool.name),
		});
	});
}
