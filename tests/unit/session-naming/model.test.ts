import { describe, expect, test } from "bun:test";
import type { Api, AssistantMessage, Context, Model, ModelsApiStreamOptions } from "@earendil-works/pi-ai";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
	buildModelChain,
	generateSessionName,
	type SessionNamingModelContext,
} from "../../../packages/pi-stuff/src/session-naming/model.js";
import type { SessionNamingSettings } from "../../../packages/pi-stuff/src/session-naming/settings.js";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function model(provider: string, id: string): Model<Api> {
	return {
		id,
		name: `${provider}/${id}`,
		api: "openai-completions",
		provider,
		baseUrl: "https://fixture.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 4_096,
	};
}

function response(provider: string, id: string, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-completions",
		provider,
		model: id,
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 1,
	};
}

function settings(overrides: Partial<SessionNamingSettings> = {}): SessionNamingSettings {
	return {
		schemaVersion: 1,
		enabled: true,
		cooldownMinutes: 10,
		respectManualName: false,
		fallbackModels: [],
		...overrides,
	};
}

function run<Value, ErrorType>(program: Effect.Effect<Value, ErrorType>): Promise<Value> {
	return Effect.runPromise(program);
}

describe("Session Naming model selection", () => {
	test("skips a non-English result for the next configured model", async () => {
		const primary = model("fixture", "primary");
		const backup = model("fixture", "backup");
		const registry = new Map([
			["fixture/primary", primary],
			["fixture/backup", backup],
		]);
		const ctx = {
			model: undefined,
			modelRegistry: {
				find: (provider: string, id: string) => registry.get(`${provider}/${id}`),
				hasConfiguredAuth: () => true,
				complete: async (candidate: Model<Api>) =>
					candidate.id === "primary"
						? response("fixture", candidate.id, "修复会话命名")
						: response("fixture", candidate.id, "Session Naming Fix"),
			},
		} satisfies SessionNamingModelContext;

		expect(
			await run(
				generateSessionName(
					ctx,
					settings({ model: "fixture/primary", fallbackModels: ["fixture/backup"] }),
					[{ role: "user", content: "修复会话命名" }],
					"旧会话名称",
				),
			),
		).toEqual({ name: "Session Naming Fix", source: "ai" });
	});

	test("orders configured models before the active model and removes duplicates", () => {
		const primary = model("fixture", "primary");
		const backup = model("fixture", "backup");
		const registry = new Map([
			["fixture/primary", primary],
			["fixture/backup", backup],
		]);
		const ctx = {
			model: backup,
			modelRegistry: {
				complete: async () => response("fixture", "backup", "Unused"),
				find: (provider: string, id: string) => registry.get(`${provider}/${id}`),
				hasConfiguredAuth: () => true,
			},
		} satisfies SessionNamingModelContext;

		expect(
			buildModelChain(
				ctx,
				settings({ model: "fixture/primary", fallbackModels: ["fixture/backup", "fixture/primary"] }),
			).map((candidate) => `${candidate.provider}/${candidate.id}`),
		).toEqual(["fixture/primary", "fixture/backup"]);
	});
});

describe("Session Naming generation", () => {
	test("uses the public registry with a bounded, redacted English prompt", async () => {
		const selected = model("fixture", "primary");
		const calls: { context: Context; options: ModelsApiStreamOptions<Api> | undefined }[] = [];
		const ctx = {
			model: selected,
			modelRegistry: {
				find: () => undefined,
				hasConfiguredAuth: () => true,
				async complete(_model: Model<Api>, context: Context, options?: ModelsApiStreamOptions<Api>) {
					calls.push({ context, options });
					return response("fixture", "primary", '"Session Naming Safety"');
				},
			},
		} satisfies SessionNamingModelContext;

		expect(
			await run(
				generateSessionName(
					ctx,
					settings(),
					[{ role: "user", content: "修复 api_key=do-not-send-this 会话命名" }],
					"Existing Session Name",
				),
			),
		).toEqual({ name: "Session Naming Safety", source: "ai" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.context.messages[0]?.content).not.toContain("do-not-send-this");
		expect(calls[0]?.context.messages[0]?.content).toContain("Existing Session Name");
		expect(calls[0]?.context.messages[0]?.content).toContain("Return it exactly when it still fits");
		expect(calls[0]?.context.messages[0]?.content).toContain("in English");
		expect(calls[0]?.context.messages[0]?.content).toContain("Use 2-4 words");
		expect(calls[0]?.context.messages[0]?.content).toContain("Do not transliterate");
		expect(calls[0]?.context.messages[0]?.content).not.toContain("5-15 characters");
		expect(calls[0]?.options).toMatchObject({ cacheRetention: "none", maxTokens: 64 });
		expect(calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
	});

	test("uses only a compliant local fallback when no authenticated model is available", async () => {
		const selected = model("fixture", "primary");
		const ctx = {
			model: selected,
			modelRegistry: {
				complete: async () => response("fixture", "primary", "Unused"),
				find: () => undefined,
				hasConfiguredAuth: () => false,
			},
		} satisfies SessionNamingModelContext;

		expect(
			await run(
				generateSessionName(
					ctx,
					settings(),
					[{ role: "user", content: "Please repair automatic Session naming" }],
					undefined,
				),
			),
		).toEqual({ name: "repair automatic Session", source: "fallback" });
		expect(
			await run(generateSessionName(ctx, settings(), [{ role: "user", content: "修复 OAuth 会话命名" }], undefined)),
		).toBeUndefined();
	});

	test("interrupts a provider operation when its lifecycle ends", async () => {
		const selected = model("fixture", "primary");
		const started = Promise.withResolvers<void>();
		let providerSignal: AbortSignal | undefined;
		const ctx = {
			model: selected,
			modelRegistry: {
				find: () => undefined,
				hasConfiguredAuth: () => true,
				complete: (_model: Model<Api>, _context: Context, options?: ModelsApiStreamOptions<Api>) => {
					providerSignal = options?.signal;
					started.resolve();
					return new Promise<AssistantMessage>(() => undefined);
				},
			},
		} satisfies SessionNamingModelContext;
		const abort = new AbortController();
		const naming = Effect.runPromiseExit(
			generateSessionName(
				ctx,
				settings(),
				[{ role: "user", content: "Repair a hanging naming provider" }],
				undefined,
			),
			{ signal: abort.signal },
		);

		await started.promise;
		abort.abort(new Error("Session ended"));
		const exit = await naming;
		expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
		expect(providerSignal?.aborted).toBe(true);
	});
});
