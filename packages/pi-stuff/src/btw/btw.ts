/**
 * One-shot BTW model call.
 *
 * This module knows nothing about commands or TUI state. It snapshots Pi's
 * effective context once, performs one independently-cancellable no-tool
 * stream, and returns a value. Display history never crosses this boundary.
 */

import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Message,
	Model,
	StopReason,
	UserMessage,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai";
import {
	convertToLlm,
	type ExtensionContext,
	type SessionEntry,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { projectCurrentContext } from "../context-management/index.ts";
import { fitBranch } from "./btw-budget.ts";
import { assistantMessageText } from "./btw-messages.ts";
import { openBtwStream } from "./pi-compat.ts";
import btwSystemPrompt from "./prompts/btw-system.txt" with { type: "text" };

export const BTW_COMMAND_NAME = "btw";

const ERR_EMPTY_RESPONSE = "/btw returned no text content.";
const ERR_PROVIDER_ABORT = "/btw was aborted by the model provider.";
const ERR_TOOL_ATTEMPT = "/btw attempted to call a tool even though tools are disabled.";
const ERR_NO_MODEL = "/btw requires an active model.";
const BTW_ABORT = Symbol("BtwAbort");

const BTW_SYSTEM_PROMPT = btwSystemPrompt.trimEnd();

interface BtwBuiltContext {
	readonly messages: Message[];
	readonly systemPrompt: string;
	readonly branchWasTrimmed: boolean;
	readonly stubbed: boolean;
	readonly keepBudget: number;
}

export interface BtwStreamObserver {
	onTextDelta?(delta: string): void;
	onRetry?(): void;
	onFinalText?(text: string): void;
}

export type BtwExecResult =
	| {
			readonly kind: "success";
			readonly answer: string;
			readonly userMessage: UserMessage;
			readonly assistantMessage: AssistantMessage;
			readonly stopReason: StopReason;
			readonly contextTrimmed: boolean;
	  }
	| {
			readonly kind: "error";
			readonly error: string;
			readonly partial: string;
			readonly stopReason?: StopReason;
	  }
	| { readonly kind: "aborted"; readonly partial: string; readonly stopReason: "aborted" };

export type OpenBtwStream = typeof openBtwStream;

function isPendingAssistant(entry: SessionEntry | undefined): boolean {
	return entry?.type === "message" && entry.message.role === "assistant" && entry.message.stopReason === "pending";
}

/** Pi's effective active context, with compaction/branch summaries applied. */
export function readEffectiveContext(ctx: Pick<ExtensionContext, "sessionManager">) {
	const entries = ctx.sessionManager.buildContextEntries().filter((entry) => !isPendingAssistant(entry));
	const contextMessages = entries.flatMap((entry) => sessionEntryToContextMessages(entry));
	const messages = convertToLlm(contextMessages);
	return { contextMessages, entries, messages };
}

function buildBtwMessages(
	ctx: ExtensionContext,
	model: Model<Api>,
	userMessage: UserMessage,
	contextProjection: string,
	keepBudget?: number,
	effectiveContext: ReturnType<typeof readEffectiveContext> = readEffectiveContext(ctx),
): BtwBuiltContext {
	const { entries, messages } = effectiveContext;
	const systemPrompt = contextProjection ? `${BTW_SYSTEM_PROMPT}\n\n${contextProjection}` : BTW_SYSTEM_PROMPT;
	const fitOptions = {
		entries,
		messages,
		model,
		systemPrompt,
		question: userMessage,
	};
	if (keepBudget !== undefined) Object.assign(fitOptions, { keepBudget });
	const fit = fitBranch(fitOptions);
	return {
		messages: [...fit.messages, userMessage],
		systemPrompt,
		branchWasTrimmed: fit.branchWasTrimmed,
		stubbed: fit.stubbed,
		keepBudget: fit.keepBudget,
	};
}

interface AttemptState {
	partial: string;
	sawToolAttempt: boolean;
}

interface BtwExecutionState {
	attempt: AttemptState;
}

function consumeAttempt(
	stream: AssistantMessageEventStream,
	state: AttemptState,
	observer: BtwStreamObserver,
): Effect.Effect<AssistantMessage, Error> {
	return Effect.gen(function* () {
		const iterator = stream[Symbol.asyncIterator]();
		while (true) {
			const next = yield* Effect.tryPromise({
				try: () => iterator.next(),
				catch: normalizeError,
			});
			if (next.done) break;
			yield* Effect.try({
				try: () => {
					const event = next.value;
					if (event.type === "text_delta") {
						state.partial += event.delta;
						observer.onTextDelta?.(event.delta);
					} else if (
						event.type === "toolcall_start" ||
						event.type === "toolcall_delta" ||
						event.type === "toolcall_end"
					) {
						state.sawToolAttempt = true;
					}
				},
				catch: normalizeError,
			});
		}
		return yield* Effect.tryPromise({
			try: () => stream.result(),
			catch: normalizeError,
		});
	});
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function callError(error: Error | string): string {
	return `/btw call failed: ${error instanceof Error ? error.message : error}`;
}

function errorResult(error: string, partial: string, stopReason?: StopReason): BtwExecResult {
	const result: Extract<BtwExecResult, { kind: "error" }> = {
		kind: "error",
		error,
		partial,
	};
	if (stopReason !== undefined) Object.assign(result, { stopReason });
	return result;
}

function executeWithModel(
	question: string,
	ctx: ExtensionContext,
	model: Model<Api>,
	signal: AbortSignal,
	observer: BtwStreamObserver,
	openStream: OpenBtwStream,
	state: BtwExecutionState,
): Effect.Effect<BtwExecResult, Error> {
	return Effect.gen(function* () {
		const userMessage: UserMessage = {
			role: "user",
			content: [{ type: "text", text: question }],
			timestamp: Date.now(),
		};
		const effectiveContext = yield* Effect.try({
			try: () => readEffectiveContext(ctx),
			catch: normalizeError,
		});
		const contextProjection = (yield* Effect.tryPromise({
			try: () => projectCurrentContext("btw", ctx, { sourceMessages: effectiveContext.contextMessages }),
			catch: normalizeError,
		})).text;
		let built = yield* Effect.try({
			try: () => buildBtwMessages(ctx, model, userMessage, contextProjection, undefined, effectiveContext),
			catch: normalizeError,
		});
		let retried = false;

		while (true) {
			if (signal.aborted) return { kind: "aborted", partial: "", stopReason: "aborted" } as const;
			const stream = yield* openStream({
				ctx,
				model,
				context: { systemPrompt: built.systemPrompt, messages: built.messages, tools: [] },
				signal,
			});
			state.attempt = { partial: "", sawToolAttempt: false };
			const response = yield* consumeAttempt(stream, state.attempt, observer);
			const { partial } = state.attempt;

			if (signal.aborted) return { kind: "aborted", partial, stopReason: "aborted" } as const;
			if (response.stopReason === "aborted") return errorResult(ERR_PROVIDER_ABORT, partial, "aborted");
			const overflow = yield* Effect.try({
				try: () => !retried && isContextOverflow(response, model.contextWindow),
				catch: normalizeError,
			});
			if (overflow) {
				retried = true;
				state.attempt = { partial: "", sawToolAttempt: false };
				built = yield* Effect.try({
					try: () => {
						observer.onRetry?.();
						return buildBtwMessages(
							ctx,
							model,
							userMessage,
							contextProjection,
							Math.max(0, Math.floor(built.keepBudget / 2)),
							effectiveContext,
						);
					},
					catch: normalizeError,
				});
				continue;
			}
			if (state.attempt.sawToolAttempt || response.stopReason === "toolUse") {
				return errorResult(ERR_TOOL_ATTEMPT, partial, response.stopReason);
			}
			if (response.stopReason === "error") {
				return errorResult(callError(response.errorMessage ?? "unknown error"), partial, response.stopReason);
			}

			const answer = yield* Effect.try({
				try: () => assistantMessageText(response).trim(),
				catch: normalizeError,
			});
			if (!answer) return errorResult(ERR_EMPTY_RESPONSE, partial, response.stopReason);
			yield* Effect.try({
				try: () => observer.onFinalText?.(answer),
				catch: normalizeError,
			});
			return {
				kind: "success",
				answer,
				userMessage,
				assistantMessage: response,
				stopReason: response.stopReason,
				contextTrimmed: built.branchWasTrimmed || built.stubbed,
			} as const;
		}
	});
}

/**
 * Execute a side call. `signal` belongs to the Suite Command Dialog frame and
 * must not be ctx.signal; closing BTW therefore cannot cancel the main Agent.
 */
export function executeBtw(
	question: string,
	ctx: ExtensionContext,
	signal: AbortSignal,
	observer: BtwStreamObserver = {},
	openStream: OpenBtwStream = openBtwStream,
): Effect.Effect<BtwExecResult> {
	return Effect.suspend(() => {
		const model = ctx.model;
		if (!model) return Effect.succeed(errorResult(ERR_NO_MODEL, ""));
		const state: BtwExecutionState = { attempt: { partial: "", sawToolAttempt: false } };
		const operation = Effect.flatMap(Effect.abortSignal, (scopeSignal) =>
			executeWithModel(question, ctx, model, AbortSignal.any([signal, scopeSignal]), observer, openStream, state),
		);

		const aborted = Effect.callback<never, typeof BTW_ABORT>((resume) => {
			const abort = () => resume(Effect.fail(BTW_ABORT));
			if (signal.aborted) {
				abort();
				return;
			}
			signal.addEventListener("abort", abort, { once: true });
			return Effect.sync(() => signal.removeEventListener("abort", abort));
		});
		return Effect.scoped(
			Effect.raceFirst(operation, aborted).pipe(
				Effect.catch((error) => {
					if (error === BTW_ABORT || signal.aborted) {
						return Effect.succeed({
							kind: "aborted",
							partial: state.attempt.partial,
							stopReason: "aborted",
						} as const);
					}
					return Effect.succeed(errorResult(callError(error), state.attempt.partial));
				}),
			),
		);
	});
}
