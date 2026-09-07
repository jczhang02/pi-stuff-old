import type { Api, AssistantMessage, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { NamingMessage } from "./prompt.ts";
import { assistantText, buildNamingPrompt, cleanModelName, fallbackName, isHighQualityName } from "./prompt.ts";
import type { SessionNamingSettings } from "./settings.ts";

const MAX_OUTPUT_TOKENS = 64;
const PER_ATTEMPT_TIMEOUT_MS = 12_000;
const TOTAL_TIMEOUT_MS = 30_000;

export interface GeneratedSessionName {
	readonly name: string;
	readonly source: "ai" | "fallback";
}

export interface SessionNamingModelContext {
	readonly model: Model<Api> | undefined;
	readonly modelRegistry: {
		complete(model: Model<Api>, context: Context, options?: ModelsApiStreamOptions<Api>): Promise<AssistantMessage>;
		find(provider: string, modelId: string): Model<Api> | undefined;
		hasConfiguredAuth(model: Model<Api>): boolean;
	};
}

function parseModelReference(reference: string): { modelId: string; provider: string } | undefined {
	const separator = reference.indexOf("/");
	if (separator <= 0 || separator >= reference.length - 1) return undefined;
	return { provider: reference.slice(0, separator), modelId: reference.slice(separator + 1) };
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

export function buildModelChain(ctx: SessionNamingModelContext, settings: SessionNamingSettings): Model<Api>[] {
	const result: Model<Api>[] = [];
	const seen = new Set<string>();
	const addReference = (reference: string | undefined): void => {
		if (!reference) return;
		const parsed = parseModelReference(reference);
		if (!parsed) return;
		const model = ctx.modelRegistry.find(parsed.provider, parsed.modelId);
		if (!model || seen.has(modelKey(model))) return;
		seen.add(modelKey(model));
		result.push(model);
	};
	addReference(settings.model);
	for (const reference of settings.fallbackModels) addReference(reference);
	if (ctx.model && !seen.has(modelKey(ctx.model))) result.push(ctx.model);
	return result;
}

function generateWithModel(
	ctx: SessionNamingModelContext,
	model: Model<Api>,
	prompt: ReturnType<typeof buildNamingPrompt>,
): Effect.Effect<GeneratedSessionName | undefined> {
	return Effect.tryPromise({
		try: (signal) =>
			ctx.modelRegistry.complete(
				model,
				{
					systemPrompt: prompt.systemPrompt,
					messages: [{ role: "user", content: prompt.userPrompt, timestamp: Date.now() }],
				},
				{ cacheRetention: "none", maxTokens: MAX_OUTPUT_TOKENS, signal },
			),
		catch: normalizeError,
	}).pipe(
		Effect.map((response) => {
			const text = assistantText(response);
			const candidate = text ? cleanModelName(text) : undefined;
			return candidate && isHighQualityName(candidate) ? ({ name: candidate, source: "ai" } as const) : undefined;
		}),
		Effect.timeoutOption(PER_ATTEMPT_TIMEOUT_MS),
		Effect.catch(() => Effect.succeed(Option.none())),
		Effect.map(Option.getOrUndefined),
	);
}

function generateWithModels(
	ctx: SessionNamingModelContext,
	settings: SessionNamingSettings,
	prompt: ReturnType<typeof buildNamingPrompt>,
): Effect.Effect<GeneratedSessionName | undefined, Error> {
	return Effect.gen(function* () {
		const models = yield* Effect.try({
			try: () => buildModelChain(ctx, settings),
			catch: normalizeError,
		});
		for (const model of models) {
			const configured = yield* Effect.try({
				try: () => ctx.modelRegistry.hasConfiguredAuth(model),
				catch: normalizeError,
			});
			if (!configured) continue;
			const generated = yield* generateWithModel(ctx, model, prompt);
			if (generated) return generated;
		}
		return undefined;
	});
}

export function generateSessionName(
	ctx: SessionNamingModelContext,
	settings: SessionNamingSettings,
	messages: readonly NamingMessage[],
	currentName: string | undefined,
): Effect.Effect<GeneratedSessionName | undefined, Error> {
	if (messages.length === 0) return Effect.succeed(undefined);
	return Effect.gen(function* () {
		const prompt = yield* Effect.try({
			try: () => buildNamingPrompt(messages, currentName),
			catch: normalizeError,
		});
		const timed = yield* generateWithModels(ctx, settings, prompt).pipe(Effect.timeoutOption(TOTAL_TIMEOUT_MS));
		const generated = Option.getOrUndefined(timed);
		if (generated) return generated;
		const fallback = fallbackName(messages);
		return fallback && isHighQualityName(fallback) ? { name: fallback, source: "fallback" } : undefined;
	});
}

function normalizeError(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}
