import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface FixtureProviderOverrides {
	readonly apiKey?: string;
	readonly contextWindow?: number;
	readonly cost?: Model<Api>["cost"];
	readonly input?: Model<Api>["input"];
	readonly modelName?: string;
	readonly reasoning?: boolean;
}

type FixtureStream = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]["streamSimple"]>;

export function registerFixtureProvider(
	pi: ExtensionAPI,
	provider: string,
	model: string,
	name: string,
	streamSimple: FixtureStream,
	overrides: FixtureProviderOverrides = {},
): void {
	pi.registerProvider(provider, {
		name,
		baseUrl: "https://fixture.invalid",
		apiKey: overrides.apiKey ?? "fixture",
		api: "openai-completions",
		models: [
			{
				api: "openai-completions",
				id: model,
				name: overrides.modelName ?? name,
				reasoning: overrides.reasoning ?? false,
				input: overrides.input ?? ["text"],
				cost: overrides.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: overrides.contextWindow ?? 200_000,
				maxTokens: 4_096,
			},
		],
		streamSimple,
	});
}

export function createAssistantMessage(provider: string, model: string) {
	return (
		content: AssistantMessage["content"],
		stopReason: AssistantMessage["stopReason"],
		usage: AssistantMessage["usage"] = ZERO_USAGE,
	): AssistantMessage => ({
		role: "assistant",
		content,
		api: "openai-completions",
		provider,
		model,
		usage,
		stopReason,
		timestamp: Date.now(),
	});
}

export function createTextStream(message: ReturnType<typeof createAssistantMessage>) {
	return (text: string) => {
		const stream = createAssistantMessageEventStream();
		const pending = message([], "pending");
		stream.push({ type: "start", partial: pending });
		stream.push({ type: "text_start", contentIndex: 0, partial: pending });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: pending });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: pending });
		stream.push({ type: "done", reason: "stop", message: message([{ type: "text", text }], "stop") });
		return stream;
	};
}
