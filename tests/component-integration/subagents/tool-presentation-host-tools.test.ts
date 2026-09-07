import { afterEach, expect, test } from "bun:test";
import {
	apiHarness,
	buildPiArgs,
	CHILD_MODEL_CONTEXT_ENTRY_TYPE,
	CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
	cleanupToolPresentationFixtures,
	createExtensionApi,
	createHash,
	createNativeSupervisorChannel,
	existsSync,
	expectCompactPresentation,
	join,
	type LifecycleHandler,
	lifecycleHandlers,
	mkdirSync,
	mkdtempSync,
	PI_STUFF_CHILD_BASE_EXTENSION_PATH_ENV,
	PI_STUFF_CODE_MODE_FROZEN_ENV,
	REQUIRED_CHILD_TOOLS_ENV,
	readFileSync,
	registerNativeSupervisorClient,
	registerSubagentPromptRuntime,
	renderedSummary,
	resolvePiLaunchToolPlan,
	resolveSupervisorChannelDir,
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_DELEGATED_TASK_FINGERPRINT_ENV,
	SUBAGENT_ORCHESTRATOR_PHYSICAL_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
	type SubagentState,
	setEnvironment,
	type ToolDefinition,
	temporaryDirectories,
	tmpdir,
	toolInfo,
	writeFileSync,
} from "../../agents/tool-presentation-fixtures.js";

afterEach(cleanupToolPresentationFixtures);

test("native parent and child communication tools use the shared Tool row", async () => {
	const parent = apiHarness();
	const state: SubagentState = {
		asyncJobs: new Map(),
		baseCwd: "",
		completionSeen: new Map(),
		currentSessionId: null,
		foregroundControls: new Map(),
		foregroundRuns: new Map(),
		lastForegroundControlId: null,
		lastUiContext: null,
		recentAgentJobs: new Map(),
	};
	const channel = createNativeSupervisorChannel(parent.api, state);
	channel.start();
	expectCompactPresentation(parent.tools.get("subagent_supervisor"));
	await parent.run("before_agent_start");
	expectCompactPresentation(parent.tools.get("intercom"));
	for (const action of ["status", "list", "send", "reply", "ask"] as const) {
		const summary = renderedSummary(
			parent.api,
			parent.tools.get("subagent_supervisor"),
			{ action, to: "worker" },
			{ content: [{ type: "text", text: "done" }], details: {} },
			`parent-${action}`,
		);
		expect(summary).toContain(`Subagent Supervisor ${action} · worker · done`);
	}
	const failedMessage = renderedSummary(
		parent.api,
		parent.tools.get("subagent_supervisor"),
		{ action: "send", to: "worker" },
		{ content: [{ type: "text", text: "delivery failed" }], details: {} },
		"parent-send-failed",
		true,
	);
	expect(failedMessage).toContain("failed");
	expect(failedMessage).not.toContain("Messaged");
	channel.dispose();

	const directory = resolveSupervisorChannelDir("run-1", "worker", 0);
	mkdirSync(join(directory, "requests"), { recursive: true });
	mkdirSync(join(directory, "replies"), { recursive: true });
	temporaryDirectories.push(directory);
	setEnvironment(SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV, directory);
	setEnvironment(SUBAGENT_RUN_ID_ENV, "run-1");
	setEnvironment(SUBAGENT_CHILD_AGENT_ENV, "worker");
	setEnvironment(SUBAGENT_CHILD_INDEX_ENV, "0");
	setEnvironment(SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV, "parent-session");
	setEnvironment(SUBAGENT_ORCHESTRATOR_PHYSICAL_SESSION_ID_ENV, "legacy-test-session");
	const child = apiHarness();
	registerNativeSupervisorClient(child.api);
	expectCompactPresentation(child.tools.get("contact_supervisor"));
	expectCompactPresentation(child.tools.get("intercom"));
});

test("reports the actual child Host model context once per selected model", async () => {
	const handlers = new Map<string, LifecycleHandler[]>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	const api = createExtensionApi({
		appendEntry: (customType, data) => {
			entries.push({ customType, data });
		},
		getAllTools: () => [],
		on: lifecycleHandlers(handlers),
		registerTool: () => {},
		sendMessage: () => {},
	});
	registerSubagentPromptRuntime(api);
	const runBeforeAgentStart = async (contextWindow: number): Promise<void> => {
		for (const handler of handlers.get("before_agent_start") ?? []) {
			await handler(
				{ systemPrompt: "child" },
				{
					model: {
						provider: "child-only-provider",
						id: "child-model",
						contextWindow,
						maxTokens: 4_000,
					},
				},
			);
		}
	};

	await runBeforeAgentStart(200_000);
	await runBeforeAgentStart(200_000);
	await runBeforeAgentStart(300_000);

	expect(entries).toEqual([
		{
			customType: CHILD_MODEL_CONTEXT_ENTRY_TYPE,
			data: {
				version: 1,
				provider: "child-only-provider",
				model: "child-model",
				contextWindow: 200_000,
			},
		},
		{
			customType: CHILD_MODEL_CONTEXT_ENTRY_TYPE,
			data: {
				version: 1,
				provider: "child-only-provider",
				model: "child-model",
				contextWindow: 300_000,
			},
		},
	]);
});

test("waits until before_agent_start before installing intercom fallback so a later extension can register it", async () => {
	const runId = `dynamic-intercom-${Date.now()}`;
	const physicalSessionId = "dynamic-intercom-physical";
	const directory = resolveSupervisorChannelDir(runId, "worker", 0, physicalSessionId);
	mkdirSync(join(directory, "requests"), { recursive: true });
	mkdirSync(join(directory, "replies"), { recursive: true });
	temporaryDirectories.push(directory);
	setEnvironment(SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV, directory);
	setEnvironment(SUBAGENT_RUN_ID_ENV, runId);
	setEnvironment(SUBAGENT_CHILD_AGENT_ENV, "worker");
	setEnvironment(SUBAGENT_CHILD_INDEX_ENV, "0");
	setEnvironment(SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV, "parent-session");
	setEnvironment(SUBAGENT_ORCHESTRATOR_PHYSICAL_SESSION_ID_ENV, physicalSessionId);
	setEnvironment(REQUIRED_CHILD_TOOLS_ENV, JSON.stringify(["intercom"]));

	const tools = new Map<string, ToolDefinition>();
	const handlers = new Map<string, LifecycleHandler[]>();
	const api = createExtensionApi({
		getAllTools: () => [...tools.values()].map(toolInfo),
		on: lifecycleHandlers(handlers),
		// Pi's extension registry is first-wins for duplicate tool names.
		registerTool: (tool) => {
			// SAFETY: this test registry erases only generic renderer state and returns the original Tool unchanged.
			const stored = tool as ToolDefinition;
			if (!tools.has(stored.name)) tools.set(stored.name, stored);
		},
		sendMessage: () => {},
	});
	registerSubagentPromptRuntime(api);
	api.on("session_start", () => {
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		api.registerTool({
			name: "intercom",
			label: "External Intercom",
			description: "Dynamically registered external intercom.",
			// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
			parameters: {} as never,
			execute: async () => ({ content: [{ type: "text", text: "external" }], details: {} }),
		} as ToolDefinition);
	});

	for (const handler of handlers.get("session_start") ?? []) await handler({});
	expect(tools.get("intercom")?.label).toBe("External Intercom");
	for (const handler of handlers.get("before_agent_start") ?? []) {
		await handler({ systemPrompt: "child" });
	}
	expect(tools.get("intercom")?.label).toBe("External Intercom");
	expect(tools.get("contact_supervisor")?.label).toBe("Contact Supervisor");
});

test("detached root Agents keep native supervisor coordination with an explicit tool allowlist", () => {
	const runId = `tool-plan-${Date.now().toString(36)}`;
	const channelDir = resolveSupervisorChannelDir(runId, "worker", 0, "parent-physical-session");
	temporaryDirectories.push(channelDir);
	const built = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task: "Inspect the project.",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
		tools: ["read"],
		parentSessionId: "parent-session",
		governorSessionId: "parent-physical-session",
		runId,
		childAgentName: "worker",
		childIndex: 0,
		enableNativeSupervisor: true,
	});
	const toolsIndex = built.args.indexOf("--tools");
	expect(toolsIndex).toBeGreaterThanOrEqual(0);
	expect(built.args[toolsIndex + 1]?.split(",")).toEqual(expect.arrayContaining(["read", "contact_supervisor"]));
	expect(built.args).toContain("--no-context-files");
	expect(built.args).toContain("--no-skills");
	expect(built.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV]).toBe(channelDir);
	expect(existsSync(channelDir)).toBeFalse();

	const foreground = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task: "Inspect in foreground.",
		sessionEnabled: false,
		inheritProjectContext: false,
		inheritSkills: false,
		parentSessionId: "parent-session",
		runId: `${runId}-foreground`,
		childAgentName: "worker",
		enableNativeSupervisor: false,
	});
	expect(foreground.env[SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV]).toBeUndefined();
});

test("forwards ambient Tool exclusions without inventing an allowlist", () => {
	const ambient = buildPiArgs({
		baseArgs: [],
		task: "Inspect the project.",
		sessionEnabled: false,
		inheritProjectContext: true,
		inheritSkills: false,
		excludeTools: ["write", "unknown_tool"],
	});
	const excludeIndex = ambient.args.indexOf("--exclude-tools");
	expect(ambient.args[excludeIndex + 1]).toBe("write,unknown_tool");
	expect(ambient.args).not.toContain("--tools");

	const explicit = buildPiArgs({
		baseArgs: [],
		task: "Inspect the project.",
		sessionEnabled: false,
		inheritProjectContext: true,
		inheritSkills: false,
		tools: ["read", "write"],
		excludeTools: ["write"],
	});
	const toolsIndex = explicit.args.indexOf("--tools");
	expect(explicit.args[toolsIndex + 1]).toBe("read");
	expect(explicit.args).not.toContain("--exclude-tools");
});

test("replaces ambient child discovery with a controlled Suite surface and a terminal payload gate", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-child-base-extension-"));
	temporaryDirectories.push(root);
	const baseExtension = join(root, "suite.ts");
	writeFileSync(baseExtension, "export default () => {};\n");
	setEnvironment(PI_STUFF_CHILD_BASE_EXTENSION_PATH_ENV, baseExtension);
	const ambientSafe = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task: "Inspect the project.",
		sessionEnabled: false,
		inheritProjectContext: true,
		inheritSkills: true,
	});
	if (ambientSafe.tempDir) temporaryDirectories.push(ambientSafe.tempDir);
	const ambientSafePaths = ambientSafe.args.flatMap((argument, index) =>
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		argument === "--extension" && ambientSafe.args[index + 1] ? [ambientSafe.args[index + 1] as string] : [],
	);
	expect(ambientSafe.args).toContain("--no-extensions");
	expect(ambientSafePaths[0]).toBe(baseExtension);
	expect(ambientSafePaths.at(-1)?.endsWith("subagent-prompt-runtime.ts")).toBeTrue();

	const configuredExtension = "/tmp/pi-stuff-explicit-child-extension.ts";
	const built = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task: "Inspect the project.",
		sessionEnabled: false,
		inheritProjectContext: true,
		inheritSkills: true,
		extensions: [configuredExtension],
	});
	if (built.tempDir) temporaryDirectories.push(built.tempDir);
	const extensionPaths = built.args.flatMap((argument, index) =>
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		argument === "--extension" && built.args[index + 1] ? [built.args[index + 1] as string] : [],
	);

	expect(extensionPaths[0]).toBe(baseExtension);
	expect(extensionPaths[1]).toBe(configuredExtension);
	expect(extensionPaths.at(-1)?.endsWith("subagent-prompt-runtime.ts")).toBeTrue();
	expect(built.args).toContain("--no-extensions");
	expect(built.toolDiagnosticPath).toBeTruthy();
	expect(built.env[CHILD_TOOL_DIAGNOSTIC_PATH_ENV]).toBe(built.toolDiagnosticPath);

	const explicitlyEmpty = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task: "Inspect the project.",
		sessionEnabled: false,
		inheritProjectContext: true,
		inheritSkills: true,
		extensions: [],
	});
	if (explicitlyEmpty.tempDir) temporaryDirectories.push(explicitlyEmpty.tempDir);
	expect(explicitlyEmpty.args).toContain(baseExtension);

	const denied = resolvePiLaunchToolPlan({
		extensions: [configuredExtension],
		childBaseExtensionPath: baseExtension,
		capabilityCeiling: {
			version: 1,
			denyExtensions: true,
			sources: ["test"],
		},
	});
	expect(denied.configuredExtensions).toEqual([]);
	expect(denied.extensionArgs).not.toContain(baseExtension);
	expect(denied.extensionArgs).not.toContain(configuredExtension);
	expect(denied.extensionArgs.at(-1)?.endsWith("subagent-prompt-runtime.ts")).toBeTrue();
});

test("passes the Suite child surface through the child environment without mutating the parent", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-explicit-child-base-"));
	temporaryDirectories.push(root);
	const baseExtension = join(root, "suite.ts");
	writeFileSync(baseExtension, "export default () => {};\n");
	const parentValue = process.env[PI_STUFF_CHILD_BASE_EXTENSION_PATH_ENV];

	const built = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task: "Inspect the project.",
		sessionEnabled: false,
		inheritProjectContext: true,
		inheritSkills: true,
		childBaseExtensionPath: baseExtension,
	});
	if (built.tempDir) temporaryDirectories.push(built.tempDir);

	expect(process.env[PI_STUFF_CHILD_BASE_EXTENSION_PATH_ENV]).toBe(parentValue);
	expect(built.env[PI_STUFF_CHILD_BASE_EXTENSION_PATH_ENV]).toBe(baseExtension);
	expect(built.env[SUBAGENT_DELEGATED_TASK_FINGERPRINT_ENV]).toBe(
		createHash("sha256").update("Inspect the project.").digest("hex"),
	);
	expect(built.args).toContain(baseExtension);
});

test("passes the frozen Code Mode state through a distinct child environment override", () => {
	const parentValue = process.env[PI_STUFF_CODE_MODE_FROZEN_ENV];
	for (const [codeModeEnabled, expected] of [
		[true, "on"],
		[false, "off"],
	] as const) {
		const built = buildPiArgs({
			baseArgs: ["--mode", "json", "-p"],
			task: "Inspect the project.",
			sessionEnabled: false,
			inheritProjectContext: true,
			inheritSkills: true,
			codeModeEnabled,
		});
		if (built.tempDir) temporaryDirectories.push(built.tempDir);
		expect(built.env[PI_STUFF_CODE_MODE_FROZEN_ENV]).toBe(expected);
	}
	expect(process.env[PI_STUFF_CODE_MODE_FROZEN_ENV]).toBe(parentValue);
});

test("keeps Code Mode carrier Tools available under a strict Agent allowlist and capability ceiling", () => {
	const built = buildPiArgs({
		baseArgs: ["--mode", "json", "-p"],
		task: "Inspect the project.",
		systemPrompt: "Research using the available tools.",
		sessionEnabled: false,
		inheritProjectContext: true,
		inheritSkills: true,
		codeModeEnabled: true,
		codeModeProviderTools: ["codemode", "tool_search"],
		tools: ["read", "web_search", "fetch_content", "get_search_content", "bash"],
		capabilityCeiling: {
			version: 1,
			allowedTools: ["read", "web_search", "fetch_content", "get_search_content"],
			denyExtensions: false,
			sources: ["test"],
		},
	});
	if (built.tempDir) temporaryDirectories.push(built.tempDir);

	expect(built.args).toContain("read,web_search,fetch_content,get_search_content,codemode,tool_search");
	expect(JSON.parse(built.env[REQUIRED_CHILD_TOOLS_ENV] ?? "[]")).toEqual([
		"read",
		"web_search",
		"fetch_content",
		"get_search_content",
		"codemode",
		"tool_search",
	]);
	const promptFlag = built.args.indexOf("--append-system-prompt");
	expect(promptFlag).toBeGreaterThanOrEqual(0);
	const promptPath = built.args[promptFlag + 1];
	expect(promptPath).toBeDefined();
	const prompt = readFileSync(promptPath ?? "", "utf8");
	expect(prompt).toContain("Available tools for this Agent: read, web_search, fetch_content, get_search_content.");
	expect(prompt).not.toContain("Available tools for this Agent: bash");
});
