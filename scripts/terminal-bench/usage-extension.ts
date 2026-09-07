import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Api, AssistantMessage, AssistantMessageEventStream, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const LUNA_MODEL = "gpt-5.6-luna";
export const USAGE_LOG = "PI_STUFF_BENCHMARK_USAGE_LOG";

type AnyModel = Model<Api>;
const wrappedProviders = new WeakMap<Provider, Provider>();

function logPath(): string {
	const path = process.env[USAGE_LOG];
	if (!path) throw new Error(`${USAGE_LOG} is required for Terminal-Bench observation`);
	mkdirSync(dirname(path), { recursive: true });
	return path;
}

function record(
	kind: "call_started" | "call_finished",
	id: string,
	model: AnyModel,
	details: { usage?: AssistantMessage["usage"]; stopReason?: string; reasoning?: string },
): void {
	const entry = {
		type: kind,
		id,
		timestamp: new Date().toISOString(),
		provider: model.provider,
		model: model.id,
		pricing: model.cost,
		process: { pid: process.pid },
		agent:
			process.env["PI_STUFF_AGENT_PATH"] ??
			process.env["PI_SUBAGENT_CHILD_AGENT"] ??
			process.env["PI_SUBAGENT_RUN_ID"] ??
			"host",
		...details,
	};
	appendFileSync(logPath(), `${JSON.stringify(entry)}\n`, "utf8");
}

function isLuna(model: AnyModel): boolean {
	return model.id === LUNA_MODEL;
}

function observed(
	underlying: AssistantMessageEventStream,
	model: AnyModel,
	callId: string,
): AssistantMessageEventStream {
	const output = createAssistantMessageEventStream();
	void (async () => {
		let finished = false;
		try {
			for await (const event of underlying) {
				if (!finished && event.type === "done") {
					finished = true;
					record("call_finished", callId, model, {
						usage: event.message.usage,
						stopReason: event.message.stopReason,
					});
				}
				if (!finished && event.type === "error") {
					finished = true;
					record("call_finished", callId, model, { usage: event.error.usage, stopReason: event.error.stopReason });
				}
				output.push(event);
			}
			const message = await underlying.result();
			if (!finished)
				record("call_finished", callId, model, { usage: message.usage, stopReason: message.stopReason });
			output.end(message);
		} catch (error) {
			if (!finished) record("call_finished", callId, model, { stopReason: "error" });
			output.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					content: [],
					timestamp: Date.now(),
					stopReason: "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			});
		}
	})();
	return output;
}

function wrapProvider(provider: Provider): Provider {
	const existing = wrappedProviders.get(provider);
	if (existing) return existing;
	const wrapped: Provider = {
		...provider,
		getModels: () => provider.getModels().filter(isLuna),
		stream: (model, context, options) => {
			if (!isLuna(model)) throw new Error(`Terminal-Bench observer rejects model ${model.provider}/${model.id}`);
			const id = randomUUID();
			record("call_started", id, model, { reasoning: "provider-default" });
			return observed(provider.stream(model, context, options), model, id);
		},
		streamSimple: (model, context, options) => {
			if (!isLuna(model)) throw new Error(`Terminal-Bench observer rejects model ${model.provider}/${model.id}`);
			const id = randomUUID();
			record("call_started", id, model, { reasoning: "max" });
			return observed(provider.streamSimple(model, context, { ...options, reasoning: "max" }), model, id);
		},
	};
	wrappedProviders.set(provider, wrapped);
	wrappedProviders.set(wrapped, wrapped);
	return wrapped;
}

export default function terminalBenchUsageObserver(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx: ExtensionContext) => {
		const providerIds = new Set(ctx.modelRegistry.getAvailable().map((model) => model.provider));
		for (const providerId of providerIds) {
			const provider = ctx.modelRegistry.getProvider(providerId);
			if (provider) pi.registerProvider(wrapProvider(provider));
		}
	});
}
