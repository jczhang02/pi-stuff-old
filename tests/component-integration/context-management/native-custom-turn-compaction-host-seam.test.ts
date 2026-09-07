import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Context, UserMessage } from "@earendil-works/pi-ai";
import { createFauxCore, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Guard } from "typebox/guard";
import piStuffContext, {
	type ContextStatusSnapshot,
	getContextCapability,
} from "../../../packages/pi-stuff/src/context-management/index.js";
import { sendSuiteAgentMessage } from "../../../packages/pi-stuff/src/conversation-ui/index.js";

const sessions: AgentSession[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
	for (const session of sessions.splice(0)) session.dispose();
	await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function assistantMessage(provider: string, model: string, text: string, inputTokens: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider,
		model,
		usage: {
			input: inputTokens,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: inputTokens + 10,
			cost: ZERO_COST,
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function contextText(context: Context): string {
	return context.messages
		.map((message) => {
			const content = message.content;
			if (Guard.IsString(content)) return content;
			if (!Array.isArray(content)) return "";
			return content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		})
		.join("\n");
}

async function createColdCompactionFixture() {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-native-custom-compaction-"));
	temporaryRoots.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	const sessionDir = join(root, "sessions");
	await mkdir(agentDir, { recursive: true });
	await mkdir(cwd, { recursive: true });

	const faux = createFauxCore({
		api: `pi-stuff-native-compaction-${crypto.randomUUID()}`,
		provider: `pi-stuff-native-compaction-${crypto.randomUUID()}`,
		models: [{ id: "cold-reload", contextWindow: 4096, maxTokens: 512 }],
	});
	const provider = faux.getModel().provider;
	const modelId = faux.getModel().id;
	const providerConfiguration = {
		api: faux.api,
		apiKey: "host-seam",
		baseUrl: "http://localhost",
		models: faux.models.map((model) => ({
			api: model.api,
			baseUrl: model.baseUrl,
			contextWindow: model.contextWindow,
			cost: model.cost,
			id: model.id,
			input: model.input,
			maxTokens: model.maxTokens,
			name: model.name,
			reasoning: model.reasoning,
		})),
		name: "Pi Stuff native custom-turn compaction seam",
		streamSimple: faux.streamSimple,
	};
	const modelRuntime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider(provider, providerConfiguration);
	const model = modelRuntime.getModel(provider, modelId);
	if (!model) throw new Error("Expected the faux model to be registered");

	const seeded = SessionManager.create(cwd, sessionDir, { id: "cold-near-limit" });
	seeded.appendModelChange(provider, modelId);
	seeded.appendMessage({
		role: "user",
		content: `RAW_COLD_HISTORY\n${"historical context ".repeat(400)}`,
		timestamp: Date.now(),
	} satisfies UserMessage);
	seeded.appendMessage(assistantMessage(provider, modelId, "Historical work completed.", 2400));
	seeded.appendMessage({
		role: "user",
		content: "Keep this recent tail.",
		timestamp: Date.now(),
	} satisfies UserMessage);
	seeded.appendMessage(assistantMessage(provider, modelId, "Recent tail completed.", 3500));
	const sessionFile = seeded.getSessionFile();
	if (!sessionFile) throw new Error("Expected the cold-session fixture to persist");
	return {
		agentDir,
		cwd,
		faux,
		model,
		modelRuntime,
		reopened: SessionManager.open(sessionFile, sessionDir),
	};
}

async function createNativeCompactionSession(fixture: Awaited<ReturnType<typeof createColdCompactionFixture>>) {
	const { agentDir, cwd, model, modelRuntime, reopened } = fixture;
	let extensionApi: ExtensionAPI | undefined;
	let extensionContextState: ContextStatusSnapshot | undefined;
	let magicFactories = 0;
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1000 },
		retry: { enabled: false },
	});
	const loader = new DefaultResourceLoader({
		agentDir,
		cwd,
		extensionFactories: [
			{
				name: "native-custom-turn-host-seam",
				factory: async (pi) => {
					extensionApi = pi;
					await piStuffContext(pi, {
						loadMagicContext: async () => ({
							default: async () => {
								magicFactories += 1;
							},
						}),
						prepareMagicContext: async () => "deferred",
						readNativeCompactionSettings: () => ({ enabled: true, reserveTokens: 1000 }),
					});
					pi.on("message_start", (_event, ctx) => {
						extensionContextState = getContextCapability(ctx).status();
					});
				},
			},
		],
		noContextFiles: true,
		noExtensions: true,
		noPromptTemplates: true,
		noSkills: true,
		noThemes: true,
		settingsManager,
	});
	await loader.reload();
	const created = await createAgentSession({
		agentDir,
		cwd,
		model,
		modelRuntime,
		noTools: "all",
		resourceLoader: loader,
		sessionManager: reopened,
		sessionStartEvent: { type: "session_start", reason: "resume" },
		settingsManager,
	});
	return {
		created,
		extensionApi,
		extensionContextState: () => extensionContextState,
		magicFactories: () => magicFactories,
	};
}

test("native Pi compacts a cold near-limit session before a Suite custom trigger turn", async () => {
	const fixture = await createColdCompactionFixture();
	const { created, extensionApi, extensionContextState, magicFactories } =
		await createNativeCompactionSession(fixture);
	sessions.push(created.session);
	expect(created.extensionsResult.errors).toEqual([]);
	await created.session.bindExtensions({ shutdownHandler: async () => {} });
	if (!extensionApi) throw new Error("Expected the real ExtensionAPI");

	const requests: Array<"oversized-agent" | "summary" | "retry"> = [];
	const respond = (context: Context) => {
		if (context.systemPrompt?.includes("context summarization assistant") === true) {
			requests.push("summary");
			return fauxAssistantMessage("COLD_RELOAD_NATIVE_SUMMARY");
		}
		if (contextText(context).includes("RAW_COLD_HISTORY")) {
			requests.push("oversized-agent");
			return fauxAssistantMessage([], {
				stopReason: "error",
				errorMessage: "Your input exceeds the context window of this model",
			});
		}
		requests.push("retry");
		expect(contextText(context)).toContain("COLD_RELOAD_NATIVE_SUMMARY");
		return fauxAssistantMessage("Recovered after native compaction");
	};
	fixture.faux.setResponses([respond, respond, respond, respond]);
	const compactionReasons: string[] = [];
	created.session.subscribe((event) => {
		if (event.type === "compaction_start") compactionReasons.push(event.reason);
	});

	await sendSuiteAgentMessage(
		extensionApi,
		{
			customType: "suite-cold-reload-trigger",
			content: "Continue Suite work after a cold reload.",
			display: false,
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	await created.session.waitForIdle();

	expect(magicFactories()).toBe(0);
	expect(extensionContextState()).toEqual({ state: "dormant", engine: "native" });
	expect(requests).toEqual(["summary", "summary", "retry"]);
	// Pi's public ExtensionContext exposes only manual compact(), so Pi Stuff
	// performs the threshold-equivalent preflight through that callback API.
	expect(compactionReasons).toEqual(["manual"]);
}, 10_000);
