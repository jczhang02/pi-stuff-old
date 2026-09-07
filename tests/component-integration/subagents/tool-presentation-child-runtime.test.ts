import { afterEach, expect, test } from "bun:test";
import {
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	CHILD_TOOL_DIAGNOSTIC_PATH_ENV,
	cleanupToolPresentationFixtures,
	createExtensionApi,
	createHash,
	type FixtureMessage,
	isRuntimeObject,
	isRuntimeString,
	join,
	type LifecycleHandler,
	type LifecycleResult,
	lifecycleHandler,
	lifecycleHandlers,
	mkdtempSync,
	projectedMessages,
	REQUIRED_CHILD_TOOLS_ENV,
	readChildToolDiagnosticError,
	registerSubagentPromptRuntime,
	registerToolBudget,
	resolvePiLaunchToolPlan,
	rewriteSubagentPrompt,
	SUBAGENT_DELEGATED_TASK_FINGERPRINT_ENV,
	setEnvironment,
	stripParentOnlySubagentMessages,
	temporaryDirectories,
	tmpdir,
	toolInfo,
} from "../../agents/tool-presentation-fixtures.js";

afterEach(cleanupToolPresentationFixtures);

test("sanitizes non-portable Tool ids in forked child history", () => {
	const assistant = {
		role: "assistant",
		content: [
			{ type: "toolCall", id: "call_read|fc_123", name: "read", arguments: { path: "README.md" } },
			{ type: "toolCall", id: "call_bash-ok", name: "bash", arguments: { command: "pwd" } },
		],
		stopReason: "toolUse",
		timestamp: 1,
	};
	const readResult = {
		role: "toolResult",
		toolName: "read",
		toolCallId: "call_read|fc_123",
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 2,
	};
	const bashResult = {
		role: "toolResult",
		toolName: "bash",
		toolCallId: "call_bash-ok",
		content: [{ type: "text", text: "cwd" }],
		isError: false,
		timestamp: 3,
	};

	// SAFETY: The fixture messages match Pi's assistant and Tool-result context shapes under test.
	expect(stripParentOnlySubagentMessages([assistant, readResult, bashResult] as never)).toEqual([
		{
			...assistant,
			content: [
				{
					type: "toolCall",
					id: "tool_Y2FsbF9yZWFkfGZjXzEyMw",
					name: "read",
					arguments: { path: "README.md" },
				},
				assistant.content[1],
			],
		},
		{ ...readResult, toolCallId: "tool_Y2FsbF9yZWFkfGZjXzEyMw" },
		bashResult,
	] as never);
});

test("bounds portable Tool ids while preserving provider-native composite ids", () => {
	const toolCallId = `call_${"x".repeat(80)}|fc_${"y".repeat(80)}`;
	const messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id: toolCallId, name: "read", arguments: { path: "README.md" } }],
		},
		{ role: "toolResult", toolName: "read", toolCallId, content: [{ type: "text", text: "file" }] },
	];
	const expectedId = `tool_${createHash("sha256").update(toolCallId).digest("base64url")}`;

	// SAFETY: The fixture values match Pi's assistant and Tool-result context shapes under test.
	expect(stripParentOnlySubagentMessages(messages as never)).toEqual([
		{ ...messages[0], content: [{ ...messages[0]?.content?.[0], id: expectedId }] },
		{ ...messages[1], toolCallId: expectedId },
	] as never);
	expect(expectedId.length).toBeLessThanOrEqual(64);
	// SAFETY: The fixture values match Pi's assistant and Tool-result context shapes under test.
	expect(stripParentOnlySubagentMessages(messages as never, { sanitizeToolIds: false })).toBe(messages as never);
});

test("forces and verifies read for every skill-enabled explicit Tool shape", () => {
	for (const tools of [[], ["/tmp/child-tool.ts"], ["edit"]]) {
		const plan = resolvePiLaunchToolPlan(
			Object.assign(
				{ tools, requireReadTool: true },
				tools.includes("edit")
					? {
							capabilityCeiling: {
								version: 1 as const,
								allowedTools: ["edit", "read"],
								denyExtensions: false,
								sources: ["test"],
							},
						}
					: undefined,
			),
		);
		expect(plan.effectiveToolAllowlist).toContain("read");
		expect(plan.requiredChildTools).toContain("read");
	}
	const implicit = resolvePiLaunchToolPlan({ requireReadTool: true });
	expect(implicit.requiredChildTools).toContain("read");
});

test("keeps the certified Host grep hang outside explicit child Tool allowlists", () => {
	const plan = resolvePiLaunchToolPlan({ tools: ["read", "grep", "find", "ls", "bash"] });
	expect(plan.effectiveToolAllowlist).toEqual(["read", "find", "ls", "bash"]);
	expect(plan.requiredChildTools).toEqual(["read", "find", "ls", "bash"]);
});

test("subtracts per-Agent Tool exclusions from explicit and injected child capabilities", () => {
	const plan = resolvePiLaunchToolPlan({
		tools: ["read", "write", "subagent"],
		excludeTools: [" write ", "subagent", "structured_output"],
		structuredOutput: true,
	});
	expect(plan.declaredBuiltinTools).toEqual(["read", "write", "subagent"]);
	expect(plan.excludeTools).toEqual(["write", "subagent", "structured_output"]);
	expect(plan.effectiveToolAllowlist).toEqual(["read"]);
	expect(plan.requiredChildTools).toEqual(["read"]);
	expect(plan.internalTools).toEqual([]);
	expect(plan.fanoutAuthorized).toBeFalse();
	expect(() => resolvePiLaunchToolPlan({ requireReadTool: true, excludeTools: ["read"] })).toThrow(
		"removes required tool 'read'",
	);
});

test("leaves Host-like delimiter examples intact because resource isolation belongs to Pi CLI flags", () => {
	const prompt = [
		"Replacement instructions.",
		"",
		"<project_context>",
		"",
		"Project-specific instructions and guidelines:",
		"",
		'<project_instructions path="/workspace/AGENTS.md">project rules</project_instructions>',
		"",
		"</project_context>",
		"",
		"The following skills provide specialized instructions for specific tasks.",
		"Use the read tool to load a skill's file when the task matches its description.",
		"",
		"<available_skills>",
		"  <skill><name>review</name></skill>",
		"</available_skills>",
		'<skill name="pi-subagents" location="/literal/SKILL.md">DO_NOT_DELETE_LITERAL_SKILL</skill>',
		CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
		"Current working directory: /workspace",
	].join("\n");

	const rewritten = rewriteSubagentPrompt(prompt, {});
	expect(rewritten).toContain("Replacement instructions.");
	expect(rewritten).toContain("project rules");
	expect(rewritten).toContain("available_skills");
	expect(rewritten).toContain("DO_NOT_DELETE_LITERAL_SKILL");
	expect(rewritten.indexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS)).not.toBe(
		rewritten.lastIndexOf(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS),
	);
	expect(rewritten).toContain("Current working directory: /workspace");
});

test("a rejected advisory tool-budget nudge cannot escape the child runtime", async () => {
	const handlers = new Map<string, (event: { toolName?: string }) => LifecycleResult>();
	const pi = createExtensionApi({
		on: lifecycleHandler(handlers),
		sendUserMessage: () => Promise.reject(new Error("injected advisory transport failure")),
	});
	registerToolBudget(pi, { soft: 1, hard: 1, block: "*" });

	expect(handlers.get("tool_call")?.({ toolName: "read" })).toBeUndefined();
	await Bun.sleep(0);
	expect(handlers.get("tool_call")?.({ toolName: "write" })).toEqual({
		block: true,
		reason: expect.stringContaining("Tool budget"),
	});
});

test("does not abort an oversized child payload from a local estimate", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-child-payload-guard-"));
	temporaryDirectories.push(root);
	const diagnosticPath = join(root, "child-diagnostic.json");
	setEnvironment(CHILD_TOOL_DIAGNOSTIC_PATH_ENV, diagnosticPath);
	const handlers = new Map<string, LifecycleHandler[]>();
	const pi = createExtensionApi({
		events: { emit: () => {}, on: () => () => {} },
		getAllTools: () => [],
		on: lifecycleHandlers(handlers),
		registerTool: () => {},
		sendMessage: () => {},
	});
	registerSubagentPromptRuntime(pi);
	let aborts = 0;
	for (const handler of handlers.get("before_provider_request") ?? []) {
		await handler(
			{ payload: { input: "𠮷".repeat(2_000), tools: [{ description: "x".repeat(10_000) }] } },
			{
				model: { contextWindow: 8_000, maxTokens: 2_000 },
				abort: () => {
					aborts += 1;
				},
			},
		);
	}

	expect(aborts).toBe(0);
	expect(readChildToolDiagnosticError(diagnosticPath)).toBeUndefined();
});

test("aborts before the first provider request when a required child Tool is unavailable", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-child-tool-preflight-"));
	temporaryDirectories.push(root);
	const diagnosticPath = join(root, "child-diagnostic.json");
	setEnvironment(CHILD_TOOL_DIAGNOSTIC_PATH_ENV, diagnosticPath);
	setEnvironment(REQUIRED_CHILD_TOOLS_ENV, JSON.stringify(["project_search"]));
	const handlers = new Map<string, LifecycleHandler[]>();
	const pi = createExtensionApi({
		events: { emit: () => {}, on: () => () => {} },
		getAllTools: () => [],
		on: lifecycleHandlers(handlers),
		registerTool: () => {},
		sendMessage: () => {},
	});
	registerSubagentPromptRuntime(pi);
	let aborts = 0;
	for (const handler of handlers.get("before_provider_request") ?? []) {
		await handler(
			{ payload: { input: "Inspect the project." } },
			{
				model: { contextWindow: 8_000, maxTokens: 2_000 },
				abort: () => {
					aborts += 1;
				},
			},
		);
	}

	expect(aborts).toBe(1);
	expect(readChildToolDiagnosticError(diagnosticPath)).toContain("project_search");
});

test("preserves child history and Tool pairing for Context Management pressure handling", async () => {
	const handlers = new Map<string, LifecycleHandler[]>();
	const activeTool = {
		name: "read",
		description: "Read bounded project files.",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	};
	const pi = createExtensionApi({
		events: { emit: () => {}, on: () => () => {} },
		getActiveTools: () => ["read"],
		getAllTools: () => [toolInfo(activeTool)],
		on: lifecycleHandlers(handlers),
		registerTool: () => {},
		sendMessage: () => {},
	});
	registerSubagentPromptRuntime(pi);

	const delegatedTask = "DELEGATED_TASK_AUTHORITY: inspect every fixture and finish the requested audit.";
	setEnvironment(SUBAGENT_DELEGATED_TASK_FINGERPRINT_ENV, createHash("sha256").update(delegatedTask).digest("hex"));
	const latestSteering = [
		'<pi-stuff-steer request="c3RlZXItYXV0aG9yaXR5">',
		"LATEST_STEERING_AUTHORITY: keep the regression test and report the exact final count.",
		"</pi-stuff-steer>",
	].join("\n");
	const messages: FixtureMessage[] = [
		{ role: "user", content: [{ type: "text", text: `§1§ Task: ${delegatedTask}` }], timestamp: 1 },
	];
	for (const [index, output] of [
		`ASCII_RESULT_START\n${"alpha-0123456789/+= ".repeat(2_500)}\nASCII_RESULT_END`,
		`CJK_RESULT_START\n${"上下文稳定性验证𠮷".repeat(3_000)}\nCJK_RESULT_END`,
		`ENTROPY_RESULT_START\n${"AP6Zz9+/0f3cD7aQ".repeat(3_000)}\nENTROPY_RESULT_END`,
	].entries()) {
		messages.push({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `Inspecting fixture ${index}. `.repeat(800) },
				{
					type: "toolCall",
					id: `call-${index}`,
					name: "read",
					arguments: { path: `/fixture/${index}.txt`, note: "argument-data-".repeat(800) },
				},
			],
			stopReason: "toolUse",
			timestamp: index * 2 + 2,
		});
		messages.push({
			role: "toolResult",
			toolCallId: `call-${index}`,
			toolName: "read",
			content: [{ type: "text", text: output }],
			isError: false,
			timestamp: index * 2 + 3,
		});
	}
	messages.push({ role: "user", content: [{ type: "text", text: latestSteering }], timestamp: 20 });
	const original = structuredClone(messages);
	const model = {
		provider: "openai-codex",
		id: "fixture-model",
		contextWindow: 120_000,
		maxTokens: 48_000,
	};
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const ctx = {
		model,
		getSystemPrompt: () => "Child system prompt. ".repeat(300),
	} as never;
	let projected = messages;
	for (const handler of handlers.get("context") ?? []) {
		projected = projectedMessages(await handler({ messages: projected }, ctx), projected);
	}

	expect(messages).toEqual(original);
	const projectedTexts = projected.flatMap((message) => {
		const content = message.content;
		return Array.isArray(content)
			? content.flatMap((part) =>
					part && isRuntimeObject(part) && "text" in part && isRuntimeString(part.text) ? [part.text] : [],
				)
			: isRuntimeString(content)
				? [content]
				: [];
	});
	expect(projectedTexts.some((text) => text.includes(delegatedTask))).toBeTrue();
	expect(projectedTexts).toContain(latestSteering);
	expect(projected).toEqual(messages);
	expect(JSON.stringify(projected)).toContain('"id":"call-2"');
	expect(JSON.stringify(projected)).toContain('"toolCallId":"call-2"');
	expect(JSON.stringify(projected)).toContain('"id":"call-0"');
	const recentAssistantIndex = projected.findIndex(
		(message) =>
			Array.isArray(message.content) &&
			message.content.some((part) => part && isRuntimeObject(part) && "id" in part && part.id === "call-2"),
	);
	const recentResultIndex = projected.findIndex((message) => message.toolCallId === "call-2");
	expect(recentResultIndex).toBe(recentAssistantIndex + 1);
	const providerPayload = {
		instructions: "Child system prompt. ".repeat(300),
		tools: [activeTool],
		input: projected,
	};
	let aborts = 0;
	for (const handler of handlers.get("before_provider_request") ?? []) {
		await handler({ payload: providerPayload }, { model, abort: () => (aborts += 1) });
	}
	expect(aborts).toBe(0);
});

test("preserves findings and completed-check identity in forked child history", async () => {
	const handlers = new Map<string, LifecycleHandler[]>();
	const activeTool = {
		name: "bash",
		description: "Execute a bounded command.",
		parameters: { type: "object", properties: { command: { type: "string" } } },
	};
	const pi = createExtensionApi({
		events: { emit: () => {}, on: () => () => {} },
		getActiveTools: () => ["bash"],
		getAllTools: () => [toolInfo(activeTool)],
		on: lifecycleHandlers(handlers),
		registerTool: () => {},
		sendMessage: () => {},
	});
	registerSubagentPromptRuntime(pi);
	const task = "EXTREME_TASK_AUTHORITY: complete the long audit.";
	const steering = "EXTREME_STEERING_AUTHORITY: finish with a verification count.";
	setEnvironment(SUBAGENT_DELEGATED_TASK_FINGERPRINT_ENV, createHash("sha256").update(task).digest("hex"));
	const messages: FixtureMessage[] = [
		{
			role: "user",
			content: [{ type: "text", text: "PARENT_FORK_HISTORY: unrelated earlier user authority." }],
			timestamp: 0,
		},
		{
			role: "assistant",
			content: [{ type: "text", text: "COMPLETED_CHECK_IDENTITY: context-check-42 passed." }],
			stopReason: "stop",
			timestamp: 0,
		},
		{ role: "user", content: [{ type: "text", text: `§3§ Task: ${task}` }], timestamp: 1 },
	];
	for (let index = 0; index < 12; index += 1) {
		messages.push({
			role: "assistant",
			content: [
				{
					type: "thinking",
					thinking: "reasoning ".repeat(1_000),
					thinkingSignature: `SIGNED_REASONING_${index}`,
				},
				{ type: "toolCall", id: `extreme-${index}`, name: "bash", arguments: { command: `step-${index}` } },
			],
			stopReason: "toolUse",
			timestamp: index * 2 + 2,
		});
		messages.push({
			role: "toolResult",
			toolCallId: `extreme-${index}`,
			toolName: "bash",
			content: [{ type: "text", text: `RESULT_${index}\n${"AP6Zz9+/0f3cD7aQ".repeat(7_000)}` }],
			isError: false,
			timestamp: index * 2 + 3,
		});
	}
	messages.push({ role: "user", content: [{ type: "text", text: steering }], timestamp: 50 });
	const original = structuredClone(messages);
	const latestAssistant = original.find(
		(message) =>
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some((part) => part && isRuntimeObject(part) && "id" in part && part.id === "extreme-11"),
	);
	const model = { provider: "openai-codex", contextWindow: 100_000, maxTokens: 40_000 };
	let projected = messages;
	for (const handler of handlers.get("context") ?? []) {
		projected = projectedMessages(
			await handler({ messages: projected }, { model, getSystemPrompt: () => "Child prompt. ".repeat(200) }),
			projected,
		);
	}
	const serialized = JSON.stringify(projected);
	expect(messages).toEqual(original);
	expect(serialized).toContain(task);
	expect(serialized).toContain(steering);
	expect(serialized).toContain("COMPLETED_CHECK_IDENTITY: context-check-42 passed.");
	expect(serialized).toContain("PARENT_FORK_HISTORY");
	expect(serialized).toContain('"id":"extreme-11"');
	expect(serialized).toContain('"toolCallId":"extreme-11"');
	const projectedLatestAssistant = projected.find(
		(message) =>
			message.role === "assistant" &&
			Array.isArray(message.content) &&
			message.content.some((part) => part && isRuntimeObject(part) && "id" in part && part.id === "extreme-11"),
	);
	expect(projectedLatestAssistant).toEqual(latestAssistant);
	const latestAssistantIndex = projectedLatestAssistant ? projected.indexOf(projectedLatestAssistant) : -1;
	const latestResultIndex = projected.findIndex((message) => message.toolCallId === "extreme-11");
	expect(latestAssistantIndex).toBeGreaterThanOrEqual(0);
	expect(latestResultIndex).toBe(latestAssistantIndex + 1);
	expect(projected).toBe(messages);
});

test("preserves signed non-text Tool evidence for Context Management projection", async () => {
	const handlers = new Map<string, LifecycleHandler[]>();
	const activeTool = {
		name: "screenshot",
		description: "Capture the current screen.",
		parameters: { type: "object", properties: {} },
	};
	const pi = createExtensionApi({
		events: { emit: () => {}, on: () => () => {} },
		getActiveTools: () => ["screenshot"],
		getAllTools: () => [toolInfo(activeTool)],
		on: lifecycleHandlers(handlers),
		registerTool: () => {},
		sendMessage: () => {},
	});
	registerSubagentPromptRuntime(pi);
	const task = "Inspect the captured screen and continue.";
	setEnvironment(SUBAGENT_DELEGATED_TASK_FINGERPRINT_ENV, createHash("sha256").update(task).digest("hex"));
	const signedAssistant = {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: "Inspect visually.", thinkingSignature: "SIGNED_SCREEN_REASONING" },
			{ type: "toolCall", id: "screenshot-call", name: "screenshot", arguments: {} },
		],
		stopReason: "toolUse",
		timestamp: 2,
	};
	const messages: FixtureMessage[] = [
		{ role: "user", content: [{ type: "text", text: `§1§ Task: ${task}` }], timestamp: 1 },
		signedAssistant,
		{
			role: "toolResult",
			toolCallId: "screenshot-call",
			toolName: "screenshot",
			content: [{ type: "image", mimeType: "image/png", data: "AP6Zz9+/0f3cD7aQ".repeat(4_000) }],
			isError: false,
			timestamp: 3,
		},
	];
	const model = { provider: "openai", id: "unknown-azure-deployment", contextWindow: 100_000, maxTokens: 40_000 };
	let projected = messages;
	for (const handler of handlers.get("context") ?? []) {
		projected = projectedMessages(
			await handler({ messages: projected }, { model, getSystemPrompt: () => "Child prompt." }),
			projected,
		);
	}

	expect(projected).toBe(messages);
	expect(projected[1]).toEqual(signedAssistant);
	expect(JSON.stringify(projected[2])).toContain('"type":"image"');
	expect(projected[2]?.toolCallId).toBe("screenshot-call");
	expect(projected[2]?.content).toEqual(messages[2]?.content);
});

test("does not abort an oversized resumed child request from a local estimate", async () => {
	const root = mkdtempSync(join(tmpdir(), "pi-stuff-child-continuation-guard-"));
	temporaryDirectories.push(root);
	const diagnosticPath = join(root, "child-diagnostic.json");
	setEnvironment(CHILD_TOOL_DIAGNOSTIC_PATH_ENV, diagnosticPath);
	const handlers = new Map<string, LifecycleHandler[]>();
	const pi = createExtensionApi({
		events: { emit: () => {}, on: () => () => {} },
		getActiveTools: () => [],
		getAllTools: () => [],
		on: lifecycleHandlers(handlers),
		registerTool: () => {},
		sendMessage: () => {},
	});
	registerSubagentPromptRuntime(pi);
	for (const handler of handlers.get("session_start") ?? []) {
		await handler({ reason: "resume" }, {});
	}
	let aborts = 0;
	for (const handler of handlers.get("before_provider_request") ?? []) {
		await handler(
			{ payload: { input: "AP6Zz9+/0f3cD7aQ".repeat(4_000) } },
			{
				model: { provider: "openai-codex", contextWindow: 80_000, maxTokens: 32_000 },
				abort: () => (aborts += 1),
			},
		);
	}

	expect(aborts).toBe(0);
	expect(readChildToolDiagnosticError(diagnosticPath)).toBeUndefined();
});
