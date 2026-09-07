import { afterEach, expect, test } from "bun:test";
import {
	ApiHarness,
	ASYNC_DIR,
	cleanupExtensionRootFixtures,
	config,
	context,
	createHarness,
	currentSessionId,
	deriveLaunchRunId,
	fs,
	os,
	path,
	RESULTS_DIR,
	registerAgents,
	temporaryDirectories,
	validateToolArguments,
} from "../../agents/extension-root-fixtures.js";

afterEach(cleanupExtensionRootFixtures);

test("throttles runtime maintenance after success and retries failures after a bounded delay", async () => {
	let maintenanceCalls = 0;
	let now = 1_000;
	const root = createHarness({
		maintenance: () => {
			maintenanceCalls += 1;
			if (maintenanceCalls === 1) throw new Error("injected maintenance failure");
		},
		monotonicNow: () => now,
	});
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");
	const execute = (id: string) =>
		tool.execute(
			id,
			{ agent: "researcher", task: `Maintenance probe ${id}` },
			new AbortController().signal,
			undefined,
			context(),
		);
	const waitForCalls = async (expected: number): Promise<void> => {
		for (let attempt = 0; attempt < 100 && maintenanceCalls < expected; attempt++) await Bun.sleep(1);
		expect(maintenanceCalls).toBe(expected);
	};

	await execute("maintenance-first");
	await waitForCalls(1);
	await execute("maintenance-before-retry");
	await Bun.sleep(10);
	expect(maintenanceCalls).toBe(1);

	now += 60_001;
	await execute("maintenance-retry");
	await waitForCalls(2);
	await execute("maintenance-before-success-window");
	await Bun.sleep(10);
	expect(maintenanceCalls).toBe(2);

	now += 60 * 60 * 1_000 + 1;
	await execute("maintenance-after-success-window");
	await waitForCalls(3);
});

test("returns quietly in child processes", () => {
	const api = new ApiHarness();
	let loaded = 0;
	registerAgents(api.api, {
		isChildProcess: () => true,
		loadConfiguration: () => {
			loaded += 1;
			return config();
		},
	});

	expect(loaded).toBe(0);
	expect(api.tools.size).toBe(0);
	expect(api.commands.size).toBe(0);
	expect(api.handlers.size).toBe(0);
});

test("registers only the public Agent tool and /agents command", async () => {
	const root = createHarness();

	expect([...root.api.tools.keys()]).toEqual(["subagent"]);
	expect(root.api.tools.get("subagent")?.label).toBe("Agent");
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const presentation = root.api.tools.get("subagent") as {
		renderCall?: unknown;
		renderResult?: unknown;
		renderShell?: unknown;
	};
	expect(presentation.renderShell).toBe("self");
	expect(presentation.renderCall).toBeFunction();
	expect(presentation.renderResult).toBeFunction();
	expect([...root.api.commands.keys()]).toEqual(["agents"]);
	expect(root.api.renderers).toEqual(["pi-stuff-agent-complete"]);
	expect([...root.api.entryRenderers.keys()]).toEqual(["pi-stuff-agent-outcome"]);
	expect(root.chrome.registered).toBe(1);

	await root.api.commands.get("agents")?.handler("", context());
	expect(root.dialogs).toEqual([{ hasReader: true }]);
});

test("publishes one discoverable Agent call contract and rejects repair-prone legacy shapes", () => {
	const root = createHarness();
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");

	expect(tool.description).toContain("Choose exactly one shape per call");
	expect(tool.description).toContain("independent single calls in one assistant response");
	expect(tool.description).toContain("Do not invent or pass a background field");
	expect(tool.description).toContain("Background results return automatically for integration into the original task");
	expect(tool.description).toContain('action="status", "steer", "stop", or "resume"');
	expect(tool.description).toContain(
		"Omit timeoutMs and toolBudget for ordinary tasks; set them only when the task explicitly needs a tighter bound",
	);
	expect(tool.description).toContain("Pi Stuff does not provide built-in Agent definitions");
	expect(tool.description).toContain("Package, user, or project Agent");

	for (const args of [
		{ agent: "general-purpose", task: "Inspect the parser" },
		{
			tasks: [
				{ agent: "general-purpose", task: "Implement the parser" },
				{ agent: "general-purpose", task: "Review the parser" },
			],
		},
		{ action: "status" },
	]) {
		expect(() =>
			validateToolArguments(tool, { type: "toolCall", id: "call-1", name: "subagent", arguments: args }),
		).not.toThrow();
	}

	for (const args of [
		{ agent: "general-purpose", background: true, task: "Inspect the parser" },
		{ action: "list" },
	]) {
		expect(() =>
			validateToolArguments(tool, { type: "toolCall", id: "call-2", name: "subagent", arguments: args }),
		).toThrow('Validation failed for tool "subagent"');
	}
	const task = { agent: "general-purpose", task: "Review the parser" };
	expect(() =>
		validateToolArguments(tool, {
			type: "toolCall",
			id: "call-20",
			name: "subagent",
			arguments: { tasks: Array.from({ length: 20 }, () => task) },
		}),
	).not.toThrow();
	expect(() =>
		validateToolArguments(tool, {
			type: "toolCall",
			id: "call-21",
			name: "subagent",
			arguments: { tasks: Array.from({ length: 21 }, () => task) },
		}),
	).toThrow('Validation failed for tool "subagent"');

	expect(() =>
		validateToolArguments(tool, {
			type: "toolCall",
			id: "call-3",
			name: "subagent",
			arguments: {
				agent: "general-purpose",
				task: "Inspect the parser",
				tasks: [{ agent: "general-purpose", task: "Review the parser" }],
			},
		}),
	).not.toThrow();
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	expect(Object.hasOwn(tool.parameters as object, "oneOf")).toBeFalse();
});

test("projects the current effective Agent roster into the public Tool contract", async () => {
	const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-agent-roster-"));
	temporaryDirectories.add(projectRoot);
	const agentsDir = path.join(projectRoot, ".pi", "agents");
	fs.mkdirSync(agentsDir, { recursive: true });
	fs.writeFileSync(
		path.join(agentsDir, "explore.md"),
		[
			"---",
			"name: explore",
			"description: Fast read-only code search Agent",
			"tools: read, grep, find, ls, bash",
			"---",
			"Inspect local code and return concise evidence.",
		].join("\n"),
	);
	const root = createHarness();
	const tool = root.api.tools.get("subagent");
	if (!tool) throw new Error("Expected public Agent tool");
	const projectContext = { ...context(), cwd: projectRoot };

	await root.api.fire("before_agent_start", { type: "before_agent_start" }, projectContext);

	expect(tool.description).toContain("explore — Fast read-only code search Agent (tools: read, find, ls, bash)");
	expect(root.api.providerToolDescriptions.get("subagent")).toContain(
		"explore — Fast read-only code search Agent (tools: read, find, ls, bash)",
	);
});

test("keeps session and Agent submission free of full artifact discovery", async () => {
	const root = createHarness();
	await root.api.fire("session_start", { reason: "startup", type: "session_start" });

	expect(root.tracker.restored).toBe(0);
	expect(root.directories).toEqual([]);
	expect(root.watcher.starts).toBe(0);
	expect(root.watcher.primes).toBe(0);
	expect(root.supervisor.started).toBe(0);
	expect(root.governor.reconcileChecks).toBe(0);
	expect(root.governor.reconciles).toBe(0);

	const result = await root.api.tools
		.get("subagent")
		?.execute(
			"call-1",
			{ agent: "researcher", task: "Find the cause" },
			new AbortController().signal,
			undefined,
			context(),
		);
	const launchRunId = deriveLaunchRunId("call-1", {
		sessionId: `${currentSessionId(root)}\0header:root-id`,
		ownerAgentPath: [],
	});
	expect(root.engineParams[0]).toEqual({
		agent: "researcher",
		async: true,
		context: "fresh",
		description: "Find the cause",
		launchRunId,
		task: "Find the cause",
	});
	expect(root.engineOrigins).toEqual(["automatic"]);
	expect(root.governor.prepares).toEqual([
		{
			launchRunId,
			params: { agent: "researcher", task: "Find the cause" },
		},
	]);
	expect(root.governor.settlements).toBe(1);
	expect(root.directories).toEqual([RESULTS_DIR, ASYNC_DIR]);
	expect(root.watcher.starts).toBe(1);
	expect(root.watcher.primes).toBe(2);
	expect(root.tracker.restored).toBe(0);
	expect(root.supervisor.started).toBe(1);
	expect(root.governor.reconcileChecks).toBe(1);
	expect(result?.content).toEqual([
		{
			type: "text",
			text: "Agent researcher started in the background (run-1). Continue independent work; results return automatically so you can finish the original task. Inspect progress with /agents.",
		},
	]);
	expect(JSON.stringify(result?.content)).not.toContain("/private");
});
