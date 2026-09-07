import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { createFauxCore } from "@earendil-works/pi-ai/providers/faux";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const { AuthStorage } = await import(
	new URL("./core/auth-storage.js", import.meta.resolve("@earendil-works/pi-coding-agent"))
);
const extensionPath = process.env.PI_STUFF_GOAL_RUNTIME_EXTENSION
	? resolve(process.env.PI_STUFF_GOAL_RUNTIME_EXTENSION)
	: resolve(import.meta.dirname, "../../packages/pi-stuff/src/goal/src/goal.ts");

async function createFauxRuntime(agentDir, responses, fauxOptions) {
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	const modelRegistry = new ModelRegistry(modelRuntime);
	const faux = createFauxCore({
		api: `pi-goal-faux-${crypto.randomUUID()}`,
		provider: `pi-goal-faux-${crypto.randomUUID()}`,
		...fauxOptions,
	});
	const provider = faux.getModel().provider;
	const providerConfiguration = {
		name: "Pi Goal runtime smoke faux provider",
		api: faux.api,
		apiKey: "runtime-smoke",
		baseUrl: "http://localhost",
		streamSimple: faux.streamSimple,
		models: faux.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: model.api,
			baseUrl: model.baseUrl,
			reasoning: model.reasoning,
			input: model.input,
			cost: model.cost,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
		})),
	};
	modelRegistry.registerProvider(provider, providerConfiguration);
	const model = modelRegistry.find(provider, faux.getModel().id);
	assert.ok(model, "expected registered faux model");
	faux.setResponses(responses);
	return { faux, model, modelRuntime, provider, providerConfiguration };
}

function createObserverExtension(provider, providerConfiguration, lifecycleEvents, managedRunEvents, managedRun) {
	return {
		name: "runtime-smoke-observer",
		factory: (pi) => {
			pi.registerProvider(provider, providerConfiguration);
			if (managedRun) {
				pi.events.on(`pi-goal:event:${managedRun.runId}`, (event) => {
					managedRunEvents.push(event);
				});
				pi.on("session_start", () => {
					pi.events.emit("pi-goal:start", managedRun);
				});
			}
			pi.registerTool({
				name: "budget_probe",
				label: "Budget Probe",
				description: "No-op tool for lifecycle smoke coverage",
				parameters: Type.Object({}),
				async execute() {
					lifecycleEvents.push("budget_probe_execute");
					return { content: [{ type: "text", text: "probe complete" }] };
				},
			});
			pi.on("session_start", () => lifecycleEvents.push("session_start"));
			pi.on("agent_start", () => lifecycleEvents.push("agent_start"));
			pi.on("message_end", (event) => {
				if (event.message.role === "assistant") lifecycleEvents.push("assistant_message_end");
			});
			pi.on("tool_execution_end", () => lifecycleEvents.push("tool_execution_end"));
			pi.on("session_before_compact", () => lifecycleEvents.push("session_before_compact"));
			pi.on("session_compact", (_event, ctx) =>
				lifecycleEvents.push(`session_compact:idle=${ctx.isIdle()}:pending=${ctx.hasPendingMessages()}`),
			);
			pi.on("agent_settled", () => lifecycleEvents.push("agent_settled"));
		},
	};
}

export async function createHarness(
	responses,
	fauxOptions = {},
	prepareSession,
	goalSettings,
	piSettings = {},
	managedRun,
) {
	const root = await mkdtemp(join(tmpdir(), "pi-goal-runtime-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	await mkdir(cwd, { recursive: true });
	if (goalSettings) {
		await mkdir(agentDir, { recursive: true });
		await writeFile(join(agentDir, "pi-goal.json"), `${JSON.stringify(goalSettings)}\n`, "utf8");
	}

	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	let createdSession;
	let agentDirRestored = false;
	const restoreAgentDir = () => {
		if (agentDirRestored) return;
		agentDirRestored = true;
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	};
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const cleanupResources = async () => {
		try {
			createdSession?.dispose();
		} finally {
			try {
				await rm(root, { recursive: true, force: true });
			} finally {
				restoreAgentDir();
			}
		}
	};

	try {
		const { faux, model, modelRuntime, provider, providerConfiguration } = await createFauxRuntime(
			agentDir,
			responses,
			fauxOptions,
		);
		const managedRunEvents = [];

		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: false },
			retry: { enabled: false },
			...piSettings,
		});
		const lifecycleEvents = [];
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalExtensionPaths: [extensionPath],
			extensionFactories: [
				createObserverExtension(provider, providerConfiguration, lifecycleEvents, managedRunEvents, managedRun),
			],
		});
		await resourceLoader.reload();
		const sessionManager = SessionManager.inMemory(cwd);
		prepareSession?.(sessionManager);
		const result = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			model,
			resourceLoader,
			sessionManager,
			settingsManager,
			noTools: "builtin",
		});
		assert.deepEqual(result.extensionsResult.errors, []);
		createdSession = result.session;
		await result.session.bindExtensions({ shutdownHandler: async () => {} });
		return {
			agentDir,
			extensions: result.extensionsResult.extensions.map((extension) => ({
				path: extension.path,
				handlers: [...extension.handlers.keys()],
			})),
			faux,
			lifecycleEvents,
			managedRunEvents,
			session: result.session,
			cleanup: cleanupResources,
		};
	} catch (error) {
		await cleanupResources();
		throw error;
	}
}

export async function agentDirectoryIsolationScenario() {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const harness = await createHarness([]);
	try {
		assert.equal(process.env.PI_CODING_AGENT_DIR, harness.agentDir);
	} finally {
		await harness.cleanup();
	}
	assert.equal(process.env.PI_CODING_AGENT_DIR, previousAgentDir);
}

export function persistedGoalState(session) {
	return session.sessionManager
		.getBranch()
		.filter((candidate) => candidate.type === "custom" && candidate.customType === "goal-state")
		.at(-1)?.data;
}

export function persistedGoalStatus(session) {
	return persistedGoalState(session)?.goal?.status ?? null;
}

export function persistedGoalHistory(session) {
	return session.sessionManager
		.getBranch()
		.filter((candidate) => candidate.type === "custom" && candidate.customType === "goal-state")
		.map((candidate) => candidate.data?.goal)
		.filter(Boolean);
}

export async function waitFor(predicate, description, timeoutMs = 10_000) {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
