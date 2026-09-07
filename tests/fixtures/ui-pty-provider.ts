import { appendFileSync } from "node:fs";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { getCommandDialogCoordinator, reportDiagnostic } from "../../packages/pi-stuff/src/conversation-ui/index.js";
import type { JsonInputValue } from "../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../../packages/pi-stuff/src/shared/runtime-type.js";
import { registerFixtureProvider, ZERO_USAGE } from "./faux-provider.js";

const PROVIDER = "pi-stuff-ui-pty";
const MODEL = "ui-pty-model";
export const GOAL_FINAL_RESPONSE = "Goal verification finished successfully with no remaining risks.";
export const GOAL_FINAL_RESPONSE_MARKER = "Goal verification finished successfully";
const SUBSCRIPTION_PROVIDER = "kimi-coding";
const SUBSCRIPTION_MODEL = "ui-pty-subscription";
const CATPPUCCIN_THEMES = [
	"catppuccin-latte",
	"catppuccin-frappe",
	"catppuccin-macchiato",
	"catppuccin-mocha",
] as const;
export const THOUGHT_PHASES = [
	"Creating diagnostic script for false failure",
	"Drafting failure detection logic in script",
	"Listing and ranking failure hypotheses",
	"Adding failure hypotheses commentary",
] as const;
export const THOUGHT_SPACING_PTY = {
	finalText: "THOUGHT_SPACING_FINAL_TEXT",
	firstText: "THOUGHT_SPACING_FIRST_TEXT",
	firstThought: "THOUGHT_SPACING_FIRST_THOUGHT",
	prompt: "THOUGHT_SPACING_PTY",
	secondThought: "THOUGHT_SPACING_SECOND_THOUGHT",
} as const;
const THOUGHT_DELTAS = THOUGHT_PHASES.map((phase, index) => `${index === 0 ? "" : "\n\n"}**${phase}**`);
export const FIXTURE_THINKING = THOUGHT_DELTAS.join("");
export const VIBE_LINE_LIVENESS_PTY_PROMPT = "VIBE_LINE_LIVENESS_PTY";
export const VIBE_LINE_LIVENESS_PTY_DONE = "VIBE_LINE_LIVENESS_DONE";
const VIBE_LINE_LIVENESS_DELTAS = [
	"Preparing the Vibe Line liveness probe: ",
	...Array.from({ length: 100 }, () => "推".repeat(25)),
] as const;
const VIBE_LINE_LIVENESS_THOUGHT = VIBE_LINE_LIVENESS_DELTAS.join("");
const VIBE_LINE_LIVENESS_DELTA_MS = 12;
const VIBE_LINE_LIVENESS_FINISH_MS = VIBE_LINE_LIVENESS_DELTAS.length * VIBE_LINE_LIVENESS_DELTA_MS;
const RESPONSE = [
	"UI_PTY_DONE 中文结果🧪",
	...Array.from({ length: 20 }, (_, index) => `真实输出 ${String(index + 1).padStart(2, "0")} · 对话保持优先`),
].join("\n");
export const VISUALIZATION_PTY_PROMPT = "FENCED_VISUALIZATION_PTY";
export const VISUALIZATION_PTY_RESPONSE = [
	"FENCED_VISUALIZATION_START",
	"",
	"```chart",
	"type: sparkline",
	"title: FENCED_CHART_TITLE",
	"data:",
	"1 3 2 5 4 8",
	"```",
	"",
	"```tree",
	"FENCED_TREE_ROOT",
	"  conversation-ui-with-a-long-label",
	"    chart",
	"    tree",
	"  tools",
	"```",
	"",
	"VISUAL-DONE",
].join("\n");
export const USER_VISUALIZATION_SOURCE = ["```tree", "USER_TREE_ROOT", "  user-child", "```"].join("\n");
export const TODO_PTY_PROMPT = "请建立四项执行清单";
export const TODO_PTY_READY = "任务清单已建立。";
export const TODO_PTY_SUBJECTS = ["梳理需求", "设计实现方案", "完成核心实现", "测试与验收"] as const;
export const DIAGNOSTIC_PTY_SUMMARY = "Recovery metadata needs review 中文";

const deferredGoalCompletions = new Set<string>();

const FINAL_USAGE = {
	input: 64_000,
	output: 2_000,
	cacheRead: 18_000,
	cacheWrite: 0,
	totalTokens: 84_000,
	cost: { input: 0.3, output: 0.12, cacheRead: 0, cacheWrite: 0, total: 0.42 },
};

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
	usage = ZERO_USAGE,
	provider = PROVIDER,
	model = MODEL,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider,
		model,
		usage,
		stopReason,
		timestamp: Date.now(),
	};
}

function lastUserText(context: Context): string {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role !== "user") continue;
		if (isRuntimeString(message.content)) return message.content;
		return message.content
			.filter((part): part is { readonly type: "text"; readonly text: string } => part.type === "text")
			.map((part) => part.text)
			.join("\n");
	}
	return "";
}

function lastOwnedGoalPrompt(context: Context): string | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		const message = context.messages[index] as {
			role?: unknown;
			customType?: unknown;
			content?: unknown;
		};
		if (
			message.role === "custom" &&
			(message.customType === "pi-stuff-goal-prompt" || message.customType === "pi-stuff-goal-context") &&
			isRuntimeString(message.content)
		) {
			return message.content;
		}
	}
	if (
		isRuntimeString(context.systemPrompt) &&
		context.systemPrompt.includes("<goal_id>") &&
		context.systemPrompt.includes("<goal_objective>")
	) {
		return context.systemPrompt;
	}
	return undefined;
}

function appendRecord(record: Readonly<Record<string, JsonInputValue>>): void {
	const { PI_STUFF_UI_PTY_LOG: path } = process.env;
	if (path) appendFileSync(path, `${JSON.stringify(record)}\n`);
}

function preservesFixtureThinking(context: Context): boolean {
	return context.messages.some(
		(message) =>
			message.role === "assistant" &&
			message.content.some((content) => content.type === "thinking" && content.thinking === FIXTURE_THINKING),
	);
}

function preservesVisualizationSource(context: Context): boolean {
	return context.messages.some(
		(message) =>
			message.role === "assistant" &&
			message.content.some((content) => content.type === "text" && content.text === VISUALIZATION_PTY_RESPONSE),
	);
}

function textOnlyStream(model: Model<Api>, text: string) {
	const stream = createAssistantMessageEventStream();
	const pending = assistantMessage([], "pending", ZERO_USAGE, model.provider, model.id);
	stream.push({ type: "start", partial: pending });
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: pending });
	stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
	stream.push({
		type: "done",
		reason: "stop",
		message: assistantMessage([{ type: "text", text }], "stop", ZERO_USAGE, model.provider, model.id),
	});
	return stream;
}

function interleavedThinkingStream(model: Model<Api>) {
	const stream = createAssistantMessageEventStream();
	const pending = assistantMessage([], "pending", ZERO_USAGE, model.provider, model.id);
	const pushThinking = (thinking: string): void => {
		const contentIndex = pending.content.length;
		pending.content.push({ type: "thinking", thinking: "" });
		stream.push({ type: "thinking_start", contentIndex, partial: pending });
		pending.content[contentIndex] = { type: "thinking", thinking };
		stream.push({ type: "thinking_delta", contentIndex, delta: thinking, partial: pending });
		stream.push({ type: "thinking_end", contentIndex, content: thinking, partial: pending });
	};
	const pushText = (text: string): void => {
		const contentIndex = pending.content.length;
		pending.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex, partial: pending });
		pending.content[contentIndex] = { type: "text", text };
		stream.push({ type: "text_delta", contentIndex, delta: text, partial: pending });
		stream.push({ type: "text_end", contentIndex, content: text, partial: pending });
	};

	stream.push({ type: "start", partial: pending });
	pushThinking(THOUGHT_SPACING_PTY.firstThought);
	pushText(THOUGHT_SPACING_PTY.firstText);
	pushThinking(THOUGHT_SPACING_PTY.secondThought);
	pushText(THOUGHT_SPACING_PTY.finalText);
	stream.push({
		type: "done",
		reason: "stop",
		message: assistantMessage([...pending.content], "stop", ZERO_USAGE, model.provider, model.id),
	});
	return stream;
}

function visualizationStream(model: Model<Api>, options?: SimpleStreamOptions) {
	const stream = createAssistantMessageEventStream();
	const pending = assistantMessage([], "pending", ZERO_USAGE, model.provider, model.id);
	const closeIndex = VISUALIZATION_PTY_RESPONSE.indexOf("\n```\n");
	if (closeIndex < 0) throw new Error("visualization fixture has no chart closing fence");
	const firstChunk = VISUALIZATION_PTY_RESPONSE.slice(0, closeIndex);
	const secondChunk = VISUALIZATION_PTY_RESPONSE.slice(closeIndex);
	let text = firstChunk;
	let settled = false;

	stream.push({ type: "start", partial: pending });
	pending.content = [{ type: "text", text }];
	stream.push({ type: "text_start", contentIndex: 0, partial: pending });
	stream.push({ type: "text_delta", contentIndex: 0, delta: firstChunk, partial: pending });

	const finish = (): void => {
		if (settled) return;
		settled = true;
		text += secondChunk;
		pending.content = [{ type: "text", text }];
		stream.push({ type: "text_delta", contentIndex: 0, delta: secondChunk, partial: pending });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
		stream.push({
			type: "done",
			reason: "stop",
			message: assistantMessage([{ type: "text", text }], "stop", ZERO_USAGE, model.provider, model.id),
		});
	};
	const abort = (): void => {
		if (settled) return;
		settled = true;
		stream.push({
			type: "error",
			reason: "aborted",
			error: assistantMessage([], "aborted", ZERO_USAGE, model.provider, model.id),
		});
	};
	setTimeout(finish, 1_500);
	options?.signal?.addEventListener("abort", abort, { once: true });
	return stream;
}
function taskCreateStream(model: Model<Api>, index: number) {
	const subject = TODO_PTY_SUBJECTS[index];
	if (!subject) return textOnlyStream(model, TODO_PTY_READY);
	const stream = createAssistantMessageEventStream();
	const pending = assistantMessage([], "pending", ZERO_USAGE, model.provider, model.id);
	const toolCall = {
		type: "toolCall" as const,
		id: `ui-pty-task-create-${String(index + 1)}`,
		name: "TaskCreate",
		arguments: {
			subject,
			description: `Real Pi TUI fixture task ${String(index + 1)}`,
		},
	};
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({
		type: "done",
		reason: "toolUse",
		message: assistantMessage([toolCall], "toolUse", ZERO_USAGE, model.provider, model.id),
	});
	return stream;
}

function taskCreatesSinceLatestUser(context: Context): number {
	let count = 0;
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "user") break;
		if (message?.role === "toolResult" && message.toolName === "TaskCreate") count += 1;
	}
	return count;
}

function goalCompletionStream(model: Model<Api>, prompt: string) {
	const goalId = /<goal_id>\s*([^<\s]+)\s*<\/goal_id>/u.exec(prompt)?.[1];
	if (!goalId) throw new Error("UI PTY fixture did not receive a Goal id");
	const stream = createAssistantMessageEventStream();
	const pending = assistantMessage([], "pending", ZERO_USAGE, model.provider, model.id);
	const toolCall = {
		type: "toolCall" as const,
		id: `ui-pty-goal-complete-${goalId}`,
		name: "goal_complete",
		arguments: {
			goal_id: goalId,
			summary: "Hidden Goal prompt delivery completed and verified.",
			evidence: [
				{
					requirement: "Deliver the Goal protocol to the model without rendering it",
					proof: "The real Pi provider request log confirmed the hidden protocol and this guarded completion call passed.",
				},
			],
		},
	};
	stream.push({ type: "start", partial: pending });
	pending.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex: 0, partial: pending });
	stream.push({ type: "toolcall_end", contentIndex: 0, toolCall, partial: pending });
	stream.push({
		type: "done",
		reason: "toolUse",
		message: assistantMessage([toolCall], "toolUse", ZERO_USAGE, model.provider, model.id),
	});
	return stream;
}

function hasGoalCompletionResult(context: Context): boolean {
	return context.messages.some((message) => message.role === "toolResult" && message.toolName === "goal_complete");
}

function fixtureStream(model: Model<Api>, context: Context, options?: SimpleStreamOptions) {
	const lastUser = lastUserText(context);
	const ownedGoalPrompt =
		lastOwnedGoalPrompt(context) ??
		(lastUser.includes("<!-- pi-goal-prompt:") || lastUser.includes("<!-- pi-goal-continuation:")
			? lastUser
			: undefined);
	const priorThinkingPreserved = preservesFixtureThinking(context);
	const visualizationSourcePreserved = preservesVisualizationSource(context);
	appendRecord({
		type: "request",
		lastUser,
		ownedGoalPrompt,
		priorThinkingPreserved,
		visualizationSourcePreserved,
		tools: (context.tools ?? []).map((tool) => tool.name),
	});
	if (ownedGoalPrompt) {
		const goalId = /<goal_id>\s*([^<\s]+)\s*<\/goal_id>/u.exec(ownedGoalPrompt)?.[1];
		if (
			goalId &&
			ownedGoalPrompt.includes("<goal_objective>\nverify hidden Goal protocol\n</goal_objective>") &&
			!deferredGoalCompletions.has(goalId)
		) {
			deferredGoalCompletions.add(goalId);
			return textOnlyStream(model, "Initial Goal pass is incomplete; continue automatically.");
		}
		return hasGoalCompletionResult(context)
			? textOnlyStream(model, GOAL_FINAL_RESPONSE)
			: goalCompletionStream(model, ownedGoalPrompt);
	}
	if (lastUser === "VERIFY_CONTEXT_REUSE") {
		return textOnlyStream(model, priorThinkingPreserved ? "CONTEXT_PRESERVED" : "CONTEXT_LOST");
	}
	if (lastUser === "VERIFY_VISUALIZATION_CONTEXT") {
		return textOnlyStream(
			model,
			visualizationSourcePreserved ? "VISUALIZATION_CONTEXT_PRESERVED" : "VISUALIZATION_CONTEXT_LOST",
		);
	}
	if (lastUser === THOUGHT_SPACING_PTY.prompt) return interleavedThinkingStream(model);
	if (lastUser === VISUALIZATION_PTY_PROMPT) return visualizationStream(model, options);
	if (lastUser === USER_VISUALIZATION_SOURCE) return textOnlyStream(model, "USER-VISUALIZATION-ACK");
	if (lastUser === TODO_PTY_PROMPT) return taskCreateStream(model, taskCreatesSinceLatestUser(context));
	if (lastUser.includes("USER_MESSAGE_PTY")) return textOnlyStream(model, "USER_MESSAGE_PTY_ACK");
	const isVibeLineLivenessProbe = lastUser === VIBE_LINE_LIVENESS_PTY_PROMPT;
	const isThoughtProbe = lastUser.startsWith("THOUGHT_PROBE_");
	const response = isVibeLineLivenessProbe
		? VIBE_LINE_LIVENESS_PTY_DONE
		: isThoughtProbe
			? `THOUGHT_DONE_${lastUser.slice("THOUGHT_PROBE_".length)}`
			: RESPONSE;
	const finalUsage = isVibeLineLivenessProbe || isThoughtProbe ? ZERO_USAGE : FINAL_USAGE;
	const thoughtDeltas = isVibeLineLivenessProbe ? VIBE_LINE_LIVENESS_DELTAS : THOUGHT_DELTAS;
	const finalThinking = isVibeLineLivenessProbe ? VIBE_LINE_LIVENESS_THOUGHT : FIXTURE_THINKING;
	const thoughtDeltaMs = isVibeLineLivenessProbe ? VIBE_LINE_LIVENESS_DELTA_MS : 900;
	const thoughtFinishMs = isVibeLineLivenessProbe
		? VIBE_LINE_LIVENESS_FINISH_MS
		: thoughtDeltas.length * thoughtDeltaMs;
	const stream = createAssistantMessageEventStream();
	const pending = assistantMessage([], "pending", ZERO_USAGE, model.provider, model.id);
	let thinking = "";
	let settled = false;

	const finish = (): void => {
		if (settled) return;
		settled = true;
		pending.content = [{ type: "thinking", thinking }];
		stream.push({ type: "thinking_end", contentIndex: 0, content: finalThinking, partial: pending });
		pending.content = [
			{ type: "thinking", thinking },
			{ type: "text", text: "" },
		];
		stream.push({ type: "text_start", contentIndex: 1, partial: pending });
		pending.content = [
			{ type: "thinking", thinking },
			{ type: "text", text: response },
		];
		stream.push({ type: "text_delta", contentIndex: 1, delta: response, partial: pending });
		stream.push({ type: "text_end", contentIndex: 1, content: response, partial: pending });
		stream.push({
			type: "done",
			reason: "stop",
			message: assistantMessage(
				[
					{ type: "thinking", thinking: finalThinking },
					{ type: "text", text: response },
				],
				"stop",
				finalUsage,
				model.provider,
				model.id,
			),
		});
	};
	const abort = (): void => {
		if (settled) return;
		settled = true;
		stream.push({
			type: "error",
			reason: "aborted",
			error: assistantMessage([], "aborted", ZERO_USAGE, model.provider, model.id),
		});
	};

	stream.push({ type: "start", partial: pending });
	pending.content = [{ type: "thinking", thinking }];
	stream.push({ type: "thinking_start", contentIndex: 0, partial: pending });
	for (const [index, delta] of thoughtDeltas.entries()) {
		setTimeout(() => {
			if (settled) return;
			thinking += delta;
			pending.content = [{ type: "thinking", thinking }];
			stream.push({ type: "thinking_delta", contentIndex: 0, delta, partial: pending });
		}, index * thoughtDeltaMs);
	}
	setTimeout(finish, thoughtFinishMs);
	options?.signal?.addEventListener("abort", abort, { once: true });
	return stream;
}

function registerUiPtyProviders(pi: ExtensionAPI): void {
	const uiModel = {
		cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
		modelName: MODEL,
		reasoning: true,
	};
	registerFixtureProvider(
		pi,
		PROVIDER,
		MODEL,
		"Pi Stuff UI PTY fixture",
		(model, context, options) => fixtureStream(model, context, options),
		uiModel,
	);
	registerFixtureProvider(
		pi,
		SUBSCRIPTION_PROVIDER,
		SUBSCRIPTION_MODEL,
		"Pi Stuff API-key subscription fixture",
		(model, context, options) => fixtureStream(model, context, options),
		{ ...uiModel, modelName: SUBSCRIPTION_MODEL },
	);
}

function registerUiPtyShortcuts(pi: ExtensionAPI): void {
	pi.registerShortcut(Key.f8, {
		description: "Submit the UI PTY User visualization fixture",
		handler: async () => {
			await pi.sendUserMessage(USER_VISUALIZATION_SOURCE);
		},
	});

	pi.registerShortcut(Key.f11, {
		description: "Switch to the API-key subscription fixture",
		handler: async (ctx) => {
			const model = ctx.modelRegistry.find(SUBSCRIPTION_PROVIDER, SUBSCRIPTION_MODEL);
			const usingOAuth = model ? ctx.modelRegistry.isUsingOAuth(model) : undefined;
			const selected = model ? await pi.setModel(model) : false;
			appendRecord({
				type: "subscription-switch",
				model: model?.id,
				provider: model?.provider,
				selected,
				usingOAuth,
			});
			ctx.ui.notify(
				selected ? "SUBSCRIPTION_MODEL_READY" : "SUBSCRIPTION_MODEL_FAILED",
				selected ? "info" : "error",
			);
		},
	});

	pi.registerShortcut(Key.f10, {
		description: "Raise the UI PTY diagnostic fixture",
		handler: async () => {
			for (const detail of [
				"Initial recovery check failed",
				"Latest retry failed with Bearer fixture-secret-token-value",
			]) {
				reportDiagnostic({
					action: "/tasks",
					capability: "Background Work",
					details: detail,
					key: "ui-pty-recovery-metadata",
					severity: "warning",
					summary: DIAGNOSTIC_PTY_SUMMARY,
					visibility: "notice",
				});
			}
		},
	});

	pi.registerShortcut(Key.f12, {
		description: "Open the UI PTY draft-restoration fixture",
		handler: async (ctx) => {
			await getCommandDialogCoordinator(pi).show(ctx, {
				priority: "normal",
				create: ({ close }) => ({
					handleInput: (data: string) => {
						if (matchesKey(data, Key.escape)) close();
					},
					invalidate: () => {},
					render: () => ["DRAFT_SURFACE 中文"],
				}),
			});
		},
	});

	pi.registerShortcut(Key.f9, {
		description: "Switch to the next Catppuccin theme fixture",
		handler: async (ctx) => {
			// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
			const current = CATPPUCCIN_THEMES.indexOf(ctx.ui.theme.name as (typeof CATPPUCCIN_THEMES)[number]);
			const theme = CATPPUCCIN_THEMES[(current + 1) % CATPPUCCIN_THEMES.length] ?? CATPPUCCIN_THEMES[0];
			const result = ctx.ui.setTheme(theme);
			appendRecord({
				type: "theme-switch",
				success: result.success,
				theme: ctx.ui.theme.name,
				themeAccent: ctx.ui.theme.getFgAnsi("accent"),
				themeMode: ctx.ui.theme.getColorMode(),
				themes: ctx.ui.getAllThemes().map((available) => available.name),
			});
		},
	});
}

function registerUiPtySession(pi: ExtensionAPI): void {
	let queueUserMessage = false;
	pi.registerCommand("ui-pty-new", {
		description: "Start a fresh User Message acceptance Session",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
	pi.registerCommand("ui-pty-resume", {
		description: "Restore the User Message acceptance Session",
		handler: async (path, ctx) => {
			await ctx.switchSession(path);
		},
	});
	pi.registerCommand("ui-pty-user-queue", {
		description: "Submit automatic and queued User Messages",
		handler: async () => {
			queueUserMessage = true;
			pi.sendUserMessage("USER_MESSAGE_PTY_AUTO");
		},
	});
	pi.on("agent_start", () => {
		if (!queueUserMessage) return;
		queueUserMessage = false;
		pi.sendUserMessage("USER_MESSAGE_PTY_QUEUED", { deliverAs: "followUp" });
	});
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setStatus("goal", "goal:UI");
		ctx.ui.setStatus("mcp", "mcp:2");
		ctx.ui.setStatus("loadout", "load:full");
		appendRecord({
			type: "inventory",
			commands: pi.getCommands().map((command) => command.name),
			markdownTransformer: pi.registerMarkdownTransformer instanceof Function,
			theme: ctx.ui.theme.name,
			themeAccent: ctx.ui.theme.getFgAnsi("accent"),
			themeMode: ctx.ui.theme.getColorMode(),
			themes: ctx.ui.getAllThemes().map((theme) => theme.name),
		});
	});
}

export default function uiPtyProvider(pi: ExtensionAPI): void {
	registerUiPtyProviders(pi);
	registerUiPtyShortcuts(pi);
	registerUiPtySession(pi);
}
