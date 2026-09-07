import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model, Provider } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import {
	type ExtensionHandler,
	ModelRegistry,
	ModelRuntime,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { isRuntimeString } from "../../../packages/pi-stuff/src/shared/runtime-type.js";
import observer, { LUNA_MODEL, USAGE_LOG } from "../../../scripts/terminal-bench/usage-extension.js";
import { captureExtensionHandlers, createExtensionApi } from "../../fixtures/extension-api.js";
import { createExtensionContext } from "../../fixtures/extension-context.js";

const luna: Model<Api> = {
	api: "openai-completions",
	provider: "fixture",
	id: LUNA_MODEL,
	name: LUNA_MODEL,
	baseUrl: "https://fixture.invalid",
	reasoning: true,
	input: ["text"],
	cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};
const message: AssistantMessage = {
	role: "assistant",
	content: [],
	api: luna.api,
	provider: luna.provider,
	model: luna.id,
	usage: {
		input: 2,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 5,
		cost: { input: 0.000002, output: 0.000006, cacheRead: 0, cacheWrite: 0, total: 0.000008 },
	},
	stopReason: "stop",
	timestamp: 1,
};

// Exercise both public Provider paths, including ModelRegistry.complete used by Session Naming.
test("audits public simple and auxiliary calls once, before forwarding their completion", async () => {
	const home = await mkdtemp(join(tmpdir(), "pi-usage-"));
	const previous = process.env[USAGE_LOG];
	process.env[USAGE_LOG] = join(home, "usage.jsonl");
	try {
		await Bun.write(join(home, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture" } }));
		const runtime = await ModelRuntime.create({
			authPath: join(home, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(home, "models.json"),
			refreshOnCreate: false,
		});
		const provider: Provider = {
			id: luna.provider,
			name: "fixture",
			auth: { apiKey: { name: "fixture", resolve: async () => ({ auth: { apiKey: "fixture" } }) } },
			getModels: () => [luna, { ...luna, id: "other" }],
			stream: () => stream(),
			streamSimple: () => stream(),
		};
		function stream() {
			const output = createAssistantMessageEventStream();
			output.push({ type: "start", partial: message });
			output.push({ type: "done", reason: "stop", message });
			return output;
		}
		runtime.registerNativeProvider(provider);
		const registry = new ModelRegistry(runtime);
		const handlers = new Map<string, ExtensionHandler<SessionStartEvent>[]>();
		observer(
			createExtensionApi({
				on: captureExtensionHandlers(handlers),
				registerProvider: (value) => {
					if (isRuntimeString(value)) throw new Error("Expected native Provider");
					registry.registerProvider(value);
				},
			}),
		);
		const ctx = createExtensionContext({ modelRegistry: Object.assign(registry, { getAvailable: () => [luna] }) });
		const start = handlers.get("session_start")?.[0];
		if (!start) throw new Error("Missing observer session handler");
		await start({ type: "session_start", reason: "startup" }, ctx);
		await start({ type: "session_start", reason: "reload" }, ctx);
		const wrapped = registry.getProvider(luna.provider);
		if (!wrapped) throw new Error("Missing observed Provider");
		expect(wrapped.getModels()).toEqual([luna]);
		let events = 0;
		for await (const event of wrapped.streamSimple(luna, { messages: [] })) {
			events++;
			if (event.type === "done")
				expect(await readFile(join(home, "usage.jsonl"), "utf8")).toContain("call_finished");
		}
		expect(events).toBe(2);
		expect(await registry.complete(luna, { messages: [] })).toEqual(message);
		expect(() => wrapped.streamSimple({ ...luna, id: "other" }, { messages: [] })).toThrow("rejects model");
		const lines = (await readFile(join(home, "usage.jsonl"), "utf8")).trim().split("\n");
		expect(lines).toHaveLength(4);
		expect(lines.filter((line) => line.includes('"call_finished"'))).toHaveLength(2);
		expect(lines.filter((line) => line.includes('"totalTokens":5'))).toHaveLength(2);
	} finally {
		if (previous === undefined) delete process.env[USAGE_LOG];
		else process.env[USAGE_LOG] = previous;
		await rm(home, { recursive: true, force: true });
	}
});
