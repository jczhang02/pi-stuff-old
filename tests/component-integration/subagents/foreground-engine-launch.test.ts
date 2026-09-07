import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	agent,
	type BackgroundRunnerConfig,
	cleanupForegroundEngineFixtures,
	clearEnvironment,
	context,
	createEventBus,
	createInitialStatus,
	createNestedRoute,
	executeForegroundConfig,
	executor,
	extensionApiWithoutToolIntrospection,
	fs,
	os,
	path,
	projectForegroundCompletion,
	projectNestedEvents,
	resolveCurrentSessionId,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CHILD_INDEX_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_DEPTH_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_PHYSICAL_SESSION_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
	SUBAGENT_PARENT_RUN_ID_ENV,
	SUBAGENT_PARENT_SESSION_ENV,
	setEnvironment,
	setupForegroundEngineFixtures,
	state,
	steerRequestsDir,
	temporaryDirectories,
	writeNestedEvent,
} from "../../agents/foreground-engine-fixtures.js";

beforeEach(setupForegroundEngineFixtures);
afterEach(cleanupForegroundEngineFixtures);

test("persists parent run attribution in a background launch", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-background-origin-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let observedOrigin: "automatic" | "user" | undefined;
	await executor(cwd, state(), (launch) => {
		observedOrigin = launch.parentRunOrigin;
	}).execute(
		"background-origin",
		{ agent: "general-purpose", task: "Inspect the parser", context: "fresh" },
		new AbortController().signal,
		undefined,
		context(cwd),
		{ parentRunOrigin: "user" },
	);
	expect(observedOrigin).toBe("user");
});

test("freezes the parent session's effective Code Mode state into child launches", async () => {
	const cases = [
		{ defaultValue: "off", expected: true },
		{ defaultValue: "on", expected: false },
	] as const;
	for (const [index, testCase] of cases.entries()) {
		setEnvironment("PI_STUFF_CODE_MODE_DEFAULT", testCase.defaultValue);
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-stuff-code-mode-child-${index}-`));
		temporaryDirectories.push(cwd);
		fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
		let observed: boolean | undefined;
		const pi = extensionApiWithoutToolIntrospection(
			{
				// Suite capabilities see the unwrapped virtual Tool set even when the
				// outer Host surface contains the Code Mode envelope.
				getActiveTools: () => ["read"],
			},
			new Set(["getAllTools"]),
		);
		await executor(
			cwd,
			state(),
			(launch) => {
				observed = launch.codeModeEnabled;
			},
			{ codeModeEnabled: testCase.expected, pi },
		).execute(
			`code-mode-child-${index}`,
			{ agent: "general-purpose", task: "Inspect the parser", context: "fresh" },
			new AbortController().signal,
			undefined,
			context(cwd),
		);

		expect(observed).toBe(testCase.expected);
	}
});

test("carries the frozen Code Mode state through foreground and parallel runner configs", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-code-mode-foreground-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const observed: Array<boolean | undefined> = [];
	const delegate = executor(cwd, state(), undefined, {
		codeModeEnabled: true,
		onForegroundConfig: (config) => observed.push(config.codeModeEnabled),
	});
	await delegate.execute(
		"code-mode-foreground",
		{ agent: "general-purpose", task: "Inspect", async: false, context: "fresh" },
		new AbortController().signal,
		undefined,
		context(cwd),
	);
	await delegate.execute(
		"code-mode-parallel",
		{
			async: false,
			context: "fresh",
			tasks: [
				{ agent: "general-purpose", task: "Inspect" },
				{ agent: "general-purpose", task: "Verify" },
			],
		},
		new AbortController().signal,
		undefined,
		context(cwd),
	);
	expect(observed).toEqual([true, true]);
});

test("carries direct user takeover attribution into the durable steer request", async () => {
	clearEnvironment(SUBAGENT_PARENT_SESSION_ENV);
	clearEnvironment(SUBAGENT_PARENT_PHYSICAL_SESSION_ENV);
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-background-user-steer-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const runId = "user-steer";
	const asyncDir = path.join(cwd, runId);
	const ctx = context(cwd);
	const parentSessionId = resolveCurrentSessionId(ctx.sessionManager, cwd);
	fs.mkdirSync(asyncDir, { mode: 0o700 });
	const config: BackgroundRunnerConfig = {
		version: 2,
		id: runId,
		parentRunOrigin: "automatic",
		cwd,
		asyncDir,
		resultPath: path.join(cwd, "result.json"),
		sessionId: parentSessionId,
		work: {
			mode: "single",
			task: {
				agent: "general-purpose",
				task: "Wait for steering",
				cwd,
				inheritProjectContext: true,
				inheritSkills: false,
			},
		},
	};
	const status = createInitialStatus(config, Date.now());
	const [step] = status.steps;
	if (!step) throw new Error("Expected one background status step");
	step.status = "running";
	const statusPath = path.join(asyncDir, "status.json");
	fs.writeFileSync(statusPath, JSON.stringify(status), { mode: 0o600 });
	const runState = state();
	runState.asyncJobs.set(runId, { asyncId: runId, asyncDir, sessionId: parentSessionId, status: "running" });

	const observeRequest = (async () => {
		const deadline = Date.now() + 2_000;
		let requestPath: string | undefined;
		while (!requestPath) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the durable steer request");
			const directory = steerRequestsDir(asyncDir);
			const entry = fs.existsSync(directory)
				? fs.readdirSync(directory).find((candidate) => candidate.endsWith(".json"))
				: undefined;
			if (entry) requestPath = path.join(directory, entry);
			else await Bun.sleep(10);
		}
		// SAFETY: this test controls the serialized JSON fixture and exercises only the asserted fields.
		const request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as {
			id: string;
			message: string;
			parentRunOrigin?: string;
			ts: number;
		};
		const deliveredAt = Date.now();
		status.steering = {
			requested: 1,
			scheduled: 0,
			pending: 0,
			delivered: 1,
			failed: 0,
			recovered: 0,
			lastRequestedAt: request.ts,
			lastDeliveredAt: deliveredAt,
			recent: [
				{
					id: request.id,
					requestedAt: request.ts,
					messagePreview: request.message,
					targets: [{ index: 0, state: "delivered", deliveredAt }],
				},
			],
		};
		fs.writeFileSync(statusPath, JSON.stringify(status), { mode: 0o600 });
		return request;
	})();
	const controlled = executor(cwd, runState).execute(
		"control-call",
		{ action: "steer", id: runId, message: "Apply the user's correction." },
		new AbortController().signal,
		undefined,
		ctx,
		{ parentRunOrigin: "user" },
	);

	const [result, request] = await Promise.all([controlled, observeRequest]);
	expect(result.isError).not.toBe(true);
	expect(request.parentRunOrigin).toBe("user");
});

test("single foreground execution completes through the shared v2 runner shape", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-single-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const runState = state();
	const result = await executor(cwd, runState).execute(
		"single-call",
		{ agent: "general-purpose", task: "Inspect the parser", async: false, context: "fresh" },
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	expect(result.isError).not.toBe(true);
	expect(result.details.mode).toBe("single");
	expect(result.details.results.map((child) => child.finalOutput)).toEqual(["result-1"]);
	expect(runState.foregroundControls.size).toBe(0);
	expect(runState.foregroundRuns?.size).toBe(1);
});

test("stops foreground activity polling when the engine settles", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-activity-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let observations = 0;
	const delegate = executor(cwd, state(), undefined, {
		foregroundDelayMs: 650,
		onForegroundStatus: () => observations++,
	});

	await delegate.execute(
		"activity-settlement",
		{ agent: "general-purpose", task: "Wait for activity", async: false, context: "fresh" },
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	expect(observations).toBeGreaterThanOrEqual(2);
	const settledObservations = observations;
	await Bun.sleep(550);
	expect(observations).toBe(settledObservations);
});

test("runs Host-native concurrent foreground Agent calls without dropping siblings", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-concurrent-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const runState = state();
	const delegate = executor(cwd, runState, undefined, { foregroundDelayMs: 25 });

	const results = await Promise.all(
		["trace architecture", "review changes", "run checks"].map((task, index) =>
			delegate.execute(
				`concurrent-${index}`,
				{ agent: "general-purpose", task, async: false, context: "fresh" },
				new AbortController().signal,
				undefined,
				context(cwd),
			),
		),
	);

	expect(results.every((result) => result.isError !== true)).toBeTrue();
	expect(results.map((result) => result.details.results[0]?.finalOutput)).toEqual([
		"result-1",
		"result-1",
		"result-1",
	]);
	expect(runState.foregroundRuns?.size).toBe(3);
});

test("resolves the advertised Agent from the parent project while executing in the requested cwd", async () => {
	const parentCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-agent-parent-roster-"));
	const childCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-agent-child-cwd-"));
	temporaryDirectories.push(parentCwd, childCwd);
	fs.writeFileSync(path.join(parentCwd, "parent.jsonl"), "");
	const discoveredFrom: string[] = [];
	let executedFrom: string | undefined;
	const result = await executor(parentCwd, state(), undefined, {
		discoverAgents: (cwd) => {
			discoveredFrom.push(cwd);
			return { agents: cwd === parentCwd ? [agent()] : [] };
		},
		onForegroundConfig: (config) => {
			executedFrom = config.cwd;
		},
	}).execute(
		"parent-roster-child-cwd",
		{ agent: "general-purpose", async: false, cwd: childCwd, task: "Inspect the child package" },
		new AbortController().signal,
		undefined,
		context(parentCwd),
	);

	expect(result.isError).not.toBeTrue();
	expect(discoveredFrom).toEqual([parentCwd]);
	expect(executedFrom).toBe(childCwd);
});

test("leaves ordinary foreground and background launches without a default deadline", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-agent-backstops-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	let backgroundTimeoutMs: number | undefined;
	let foregroundConfig: BackgroundRunnerConfig | undefined;
	const delegate = executor(
		cwd,
		state(),
		(launch) => {
			backgroundTimeoutMs = launch.timeoutMs;
		},
		{ onForegroundConfig: (config) => (foregroundConfig = config) },
	);

	await delegate.execute(
		"bounded-background",
		{ agent: "general-purpose", task: "Inspect", context: "fresh" },
		new AbortController().signal,
		undefined,
		context(cwd),
	);
	await delegate.execute(
		"bounded-foreground",
		{ agent: "general-purpose", task: "Inspect", async: false, context: "fresh" },
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	expect(backgroundTimeoutMs).toBeUndefined();
	expect(foregroundConfig).toMatchObject({ work: { mode: "single" } });
	expect(foregroundConfig).not.toHaveProperty("timeoutMs");
	expect(foregroundConfig).not.toHaveProperty("deadlineAt");
	if (foregroundConfig?.work.mode !== "single") throw new Error("Expected one foreground task");
	expect(foregroundConfig.work.task).not.toHaveProperty("turnBudget");
	expect(foregroundConfig.work.task).not.toHaveProperty("toolBudget");

	await delegate.execute(
		"explicit-background-deadline",
		{ agent: "general-purpose", task: "Inspect", context: "fresh", timeoutMs: 120_000 },
		new AbortController().signal,
		undefined,
		context(cwd),
	);
	await delegate.execute(
		"explicit-foreground-deadline",
		{ agent: "general-purpose", task: "Inspect", async: false, context: "fresh", timeoutMs: 120_000 },
		new AbortController().signal,
		undefined,
		context(cwd),
	);
	expect(backgroundTimeoutMs).toBe(120_000);
	expect(foregroundConfig).toMatchObject({ timeoutMs: 120_000 });
});

test("does not let a failing completion observer replace a valid Agent result", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-observer-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const runState = state();
	const observerEvents = createEventBus();
	const result = await executor(cwd, runState, undefined, {
		pi: extensionApiWithoutToolIntrospection({
			events: {
				emit: () => {
					throw new Error("completion observer failed");
				},
				on: observerEvents.on,
			},
		}),
	}).execute(
		"observer-call",
		{ agent: "general-purpose", task: "Inspect the parser", async: false, context: "fresh" },
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	expect(result.details.results[0]?.finalOutput).toBe("result-1");
	expect(result.isError).not.toBe(true);
});

test("preserves explicit external-crash proof through foreground projection and session memory", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-crash-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const runState = state();
	const result = await executor(cwd, runState, undefined, { foregroundCrash: true }).execute(
		"foreground-crash-call",
		{ agent: "general-purpose", task: "Inspect the crash", async: false, context: "fresh" },
		new AbortController().signal,
		undefined,
		context(cwd),
	);

	expect(result.isError).toBe(true);
	expect(result.content[0]).toMatchObject({ text: expect.stringContaining("crashed") });
	expect(result.details.results[0]?.crashed).toBe(true);
	expect(runState.foregroundRuns?.get(result.details.runId ?? "")?.children[0]?.crashed).toBe(true);
});

test("does not call an expected foreground termination a crash", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-expected-stop-"));
	temporaryDirectories.push(cwd);
	const config = {
		version: 2 as const,
		id: "expected-stop",
		cwd,
		asyncDir: path.join(cwd, "async"),
		resultPath: path.join(cwd, "result.json"),
		work: {
			mode: "single" as const,
			task: {
				agent: "general-purpose",
				task: "Wait",
				cwd,
				inheritProjectContext: true,
				inheritSkills: false,
			},
		},
	};
	const result = projectForegroundCompletion(config, {
		id: config.id,
		runId: config.id,
		mode: "single",
		state: "failed",
		success: false,
		timedOut: true,
		results: [
			{
				agent: "general-purpose",
				output: "Timed out",
				success: false,
				exitCode: 1,
				timedOut: true,
				cumulativeUsage: {
					turns: 4,
					toolCalls: 6,
					inputTokens: 800,
					outputTokens: 90,
					modelAttempts: 1,
					resumes: 0,
				},
				terminalOutcome: {
					state: "incomplete",
					class: "timeout",
					reason: "Agent timed out after retained work.",
					continuation: {
						target: { id: config.id, index: 0 },
						resumeSupported: true,
					},
				},
				writerProcesses: [
					{
						attempt: 0,
						closeObservedAt: Date.now(),
						exitCode: null,
						kind: "pi-writer",
						processInstanceId: "manager-stop",
						signal: "SIGTERM",
						terminationOrigin: "external",
					},
				],
			},
		],
	});
	expect(result.details.results[0]?.crashed).toBeUndefined();
	expect(result.details.results[0]).toMatchObject({
		cumulativeUsage: { turns: 4, toolCalls: 6, inputTokens: 800, outputTokens: 90 },
		terminalOutcome: {
			state: "incomplete",
			class: "timeout",
			continuation: { target: { id: config.id, index: 0 }, resumeSupported: true },
		},
	});
});

test("contains a synchronous cancellation transport failure and still settles foreground execution", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-cancel-transport-"));
	temporaryDirectories.push(cwd);
	let release: (() => void) | undefined;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const config = {
		version: 2 as const,
		id: "cancel-transport",
		cwd,
		asyncDir: path.join(cwd, "async"),
		resultPath: path.join(cwd, "result.json"),
		work: {
			mode: "single" as const,
			task: {
				agent: "general-purpose",
				task: "Wait for cancellation",
				cwd,
				inheritProjectContext: true,
				inheritSkills: false,
			},
		},
	};
	const controller = new AbortController();
	const running = executeForegroundConfig(config, controller.signal, {
		runConfigured: async () => blocked,
		requestStop: () => {
			throw Object.assign(new Error("injected control EIO"), { code: "EIO" });
		},
		readCompletion: () => ({
			id: config.id,
			runId: config.id,
			mode: "single",
			state: "complete",
			success: true,
			results: [{ agent: "general-purpose", output: "settled", success: true, exitCode: 0 }],
		}),
	});
	await Promise.resolve();
	controller.abort();
	release?.();

	const result = await running;
	expect(result.isError).toBeUndefined();
	expect(result.details).toMatchObject({ cwd, results: [{ finalOutput: "settled" }] });
	expect(result.details.stopped).toBeUndefined();
	expect(result.content.some((part) => "text" in part && part.text.includes("injected control EIO"))).toBeTrue();
});

test("returns a terminal failure when foreground status persistence or claim release fails", async () => {
	for (const fault of ["status-write", "claim-release"] as const) {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-stuff-foreground-${fault}-`));
		temporaryDirectories.push(cwd);
		const id = `foreground-${fault}`;
		const config: BackgroundRunnerConfig = {
			version: 2,
			id,
			cwd,
			asyncDir: path.join(cwd, id),
			resultPath: path.join(cwd, "result.json"),
			work: {
				mode: "single",
				task: {
					agent: "general-purpose",
					task: "Fail after starting",
					cwd,
					inheritProjectContext: true,
					inheritSkills: false,
				},
			},
		};
		fs.mkdirSync(config.asyncDir, { recursive: true, mode: 0o700 });
		const status = createInitialStatus(config, Date.now());
		const firstStep = status.steps.at(0);
		if (!firstStep) throw new Error("Expected an initial foreground step");
		firstStep.status = "running";
		fs.writeFileSync(path.join(config.asyncDir, "status.json"), JSON.stringify(status), { mode: 0o600 });
		let releaseCalls = 0;

		const result = await executeForegroundConfig(config, undefined, {
			acquireStatusClaim: () => ({
				release: () => {
					releaseCalls += 1;
					if (fault === "claim-release") {
						throw Object.assign(new Error("injected claim release EIO"), { code: "EIO" });
					}
				},
			}),
			reapWriters: async () => ({ remaining: 0, terminated: 1 }),
			runConfigured: async () => {
				throw new Error("injected foreground engine failure");
			},
			writeStatus: (filePath, value) => {
				if (fault === "status-write") {
					throw Object.assign(new Error("injected status write EIO"), { code: "EIO" });
				}
				fs.writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 });
			},
		});

		expect(result.isError).toBe(true);
		expect(result.details.results[0]?.error).toContain("injected foreground engine failure");
		expect(releaseCalls).toBe(1);
		expect(fs.existsSync(path.join(config.asyncDir, ".foreground-owner-ended.json"))).toBeTrue();
		if (fault === "claim-release") {
			expect(JSON.parse(fs.readFileSync(path.join(config.asyncDir, "status.json"), "utf8")).state).toBe("failed");
		}
	}
});

for (const statusFault of ["missing", "corrupt"] as const) {
	test(`records owner exit and reaps writers when foreground status is ${statusFault}`, async () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), `pi-stuff-foreground-${statusFault}-status-`));
		temporaryDirectories.push(cwd);
		const id = `foreground-${statusFault}`;
		const config: BackgroundRunnerConfig = {
			version: 2,
			id,
			cwd,
			asyncDir: path.join(cwd, id),
			resultPath: path.join(cwd, "result.json"),
			work: {
				mode: "single",
				task: {
					agent: "general-purpose",
					task: "Fail after status loss",
					cwd,
					inheritProjectContext: true,
					inheritSkills: false,
				},
			},
		};
		fs.mkdirSync(config.asyncDir, { recursive: true, mode: 0o700 });
		if (statusFault === "corrupt") {
			fs.writeFileSync(path.join(config.asyncDir, "status.json"), "{not-json", { mode: 0o600 });
		}
		let reapCalls = 0;

		const result = await executeForegroundConfig(config, undefined, {
			reapWriters: async () => {
				reapCalls += 1;
				return { remaining: 1, terminated: 1 };
			},
			runConfigured: async () => {
				throw new Error("injected foreground engine failure after status loss");
			},
		});

		expect(result.isError).toBe(true);
		expect(result.details.results).toEqual([]);
		expect(reapCalls).toBe(1);
		expect(fs.existsSync(path.join(config.asyncDir, ".foreground-owner-ended.json"))).toBeTrue();
	});
}

test("projects live status without letting a failing progress observer change the run", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-update-observer-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const runState = state();
	let updateCalls = 0;
	let observedTool: string | undefined;
	let statusNotifications = 0;
	const result = await executor(cwd, runState, undefined, {
		onForegroundStatus: () => statusNotifications++,
		onForegroundConfig(config) {
			observedTool = runState.foregroundControls.get(config.id)?.activeChildren?.get(0)?.currentTool;
		},
	}).execute(
		"update-observer-call",
		{ agent: "general-purpose", task: "Inspect the parser", async: false, context: "fresh" },
		new AbortController().signal,
		() => {
			updateCalls += 1;
			throw new Error("progress observer failed");
		},
		context(cwd),
	);

	expect(updateCalls).toBe(2);
	expect(observedTool).toBe("read");
	expect(statusNotifications).toBe(1);
	expect(result.details.results[0]?.finalOutput).toBe("result-1");
	expect(result.isError).not.toBe(true);
	expect(runState.foregroundControls.size).toBe(0);
	expect(runState.lastForegroundControlId).toBeNull();
});

test("preserves the real foreground start time in completed nested lifecycle projection", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-foreground-nested-timing-"));
	temporaryDirectories.push(cwd);
	fs.writeFileSync(path.join(cwd, "parent.jsonl"), "");
	const route = createNestedRoute("nested-timing-root");
	temporaryDirectories.push(path.dirname(route.eventSink));
	writeNestedEvent(route, {
		type: "subagent.nested.started",
		ts: Date.now(),
		parentRunId: route.rootRunId,
		parentStepIndex: 0,
		child: {
			id: "nested-timing-parent",
			parentRunId: route.rootRunId,
			parentStepIndex: 0,
			depth: 1,
			path: [{ runId: route.rootRunId, stepIndex: 0 }],
			state: "running",
			ownerState: "live",
		},
	});
	const environment = {
		[SUBAGENT_PARENT_ROOT_RUN_ID_ENV]: route.rootRunId,
		[SUBAGENT_PARENT_EVENT_SINK_ENV]: route.eventSink,
		[SUBAGENT_PARENT_CONTROL_INBOX_ENV]: route.controlInbox,
		[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV]: route.capabilityToken,
		[SUBAGENT_PARENT_RUN_ID_ENV]: "nested-timing-parent",
		[SUBAGENT_PARENT_CHILD_INDEX_ENV]: "0",
		[SUBAGENT_PARENT_DEPTH_ENV]: "1",
	};
	const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]] as const));
	Object.assign(process.env, environment);
	try {
		await executor(cwd, state(), undefined, { foregroundDelayMs: 75 }).execute(
			"nested-timing-call",
			{ agent: "general-purpose", task: "Inspect the parser", async: false, context: "fresh" },
			new AbortController().signal,
			undefined,
			context(cwd),
		);
		const child = projectNestedEvents(route).children[0]?.children?.[0];
		expect(child).toMatchObject({ state: "complete", ownerState: "gone" });
		expect(child?.endedAt).toBeNumber();
		expect((child?.endedAt ?? 0) - (child?.startedAt ?? 0)).toBeGreaterThanOrEqual(50);
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
});
