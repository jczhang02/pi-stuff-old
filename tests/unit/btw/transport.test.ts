import { describe, expect, test } from "bun:test";
import type { Api, Context, Model, Provider, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import { type BtwTransportContext, openBtwStream } from "../../../packages/pi-stuff/src/btw/pi-compat.js";

const model: Model<Api> = {
	id: "custom-model",
	name: "Custom model",
	api: "openai-completions",
	provider: "custom-provider",
	baseUrl: "https://configured.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4_096,
};

const context: Context = { systemPrompt: "system", messages: [], tools: [] };

function setup(
	getProviderAuth: () => Promise<
		| {
				auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string };
				env?: Record<string, string>;
		  }
		| undefined
	>,
	getRequestAuth: () => Promise<
		| { ok: true; apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }
		| { ok: false; error: string }
	> = async () => ({ ok: true, headers: { "x-fallback": "yes" } }),
) {
	let captured: { model: Model<Api>; context: Context; options: SimpleStreamOptions | undefined } | undefined;
	const provider = {
		id: model.provider,
		name: "Custom provider",
		auth: {},
		getModels: () => [model],
		stream: () => createAssistantMessageEventStream(),
		streamSimple: (requestModel: Model<Api>, requestContext: Context, options?: SimpleStreamOptions) => {
			captured = { model: requestModel, context: requestContext, options };
			return createAssistantMessageEventStream();
		},
	} satisfies Provider<Api>;
	const ctx: BtwTransportContext = {
		thinkingLevel: "high",
		modelRegistry: {
			getProvider: () => provider,
			getProviderAuth,
			getApiKeyAndHeaders: getRequestAuth,
		},
	};
	return {
		ctx,
		get captured() {
			return captured;
		},
	};
}

describe("BTW Host-composed provider transport", () => {
	test("uses the registry provider and forwards auth base URL, headers, env, reasoning, and signal", async () => {
		const fixture = setup(
			async () => ({
				auth: {
					apiKey: "provider-only-token",
					headers: { "x-provider-only": "omitted" },
					baseUrl: "https://auth-derived.invalid",
				},
			}),
			async () => ({
				ok: true,
				apiKey: "token",
				headers: { authorization: "Bearer token", "x-model-override": "applied" },
				env: { PROVIDER_REGION: "local" },
			}),
		);
		const controller = new AbortController();

		await Effect.runPromise(openBtwStream({ ctx: fixture.ctx, model, context, signal: controller.signal }));

		expect(fixture.captured?.model.baseUrl).toBe("https://auth-derived.invalid");
		expect(fixture.captured?.context).toBe(context);
		expect(fixture.captured?.options).toMatchObject({
			apiKey: "token",
			headers: { authorization: "Bearer token", "x-model-override": "applied" },
			env: { PROVIDER_REGION: "local" },
			reasoning: "high",
			signal: controller.signal,
		});
		expect(fixture.captured?.options?.signal).toBe(controller.signal);
	});

	test("permits a keyless provider through the public compatibility fallback", async () => {
		const fixture = setup(async () => undefined);
		await Effect.runPromise(
			openBtwStream({ ctx: fixture.ctx, model, context, signal: new AbortController().signal }),
		);

		expect(fixture.captured?.options?.apiKey).toBeUndefined();
		expect(fixture.captured?.options?.headers).toEqual({ "x-fallback": "yes" });
	});

	test("does not open a provider stream after cancellation during auth", async () => {
		let releaseAuth: (() => void) | undefined;
		const auth = new Promise<undefined>((resolve) => {
			releaseAuth = () => resolve(undefined);
		});
		const fixture = setup(() => auth);
		const controller = new AbortController();
		const pending = Effect.runPromise(openBtwStream({ ctx: fixture.ctx, model, context, signal: controller.signal }));

		controller.abort();
		releaseAuth?.();

		await expect(pending).rejects.toThrow();
		expect(fixture.captured).toBeUndefined();
	});
});
