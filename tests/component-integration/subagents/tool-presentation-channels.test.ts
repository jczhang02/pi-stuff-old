import { afterEach, expect, test } from "bun:test";
import {
	apiHarness,
	cleanupToolPresentationFixtures,
	createExtensionApi,
	existsSync,
	expectCompactPresentation,
	fsWatch,
	join,
	type LifecycleEvent,
	type LifecycleResult,
	lifecycleHandler,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	registerNativeSupervisorClient,
	registerSteeringInbox,
	registerSubagentPromptRuntime,
	resolveSupervisorChannelDir,
	rmSync,
	STRUCTURED_OUTPUT_CAPTURE_ENV,
	STRUCTURED_OUTPUT_SCHEMA_ENV,
	SUBAGENT_CHILD_AGENT_ENV,
	SUBAGENT_CHILD_INDEX_ENV,
	SUBAGENT_ORCHESTRATOR_PHYSICAL_SESSION_ID_ENV,
	SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV,
	SUBAGENT_RUN_ID_ENV,
	SUBAGENT_STEER_ACK_DIR_ENV,
	SUBAGENT_STEER_INBOX_ENV,
	SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV,
	setEnvironment,
	steerAckPathFromDir,
	temporaryDirectories,
	tmpdir,
	writeFileSync,
	writeSteerAckAt,
	writeSteerRequestToDir,
} from "../../agents/tool-presentation-fixtures.js";

afterEach(cleanupToolPresentationFixtures);

test("native supervisor channels are created lazily on the first child request", async () => {
	const runId = `lazy-channel-${Date.now().toString(36)}`;
	const physicalSessionId = `lazy-physical-${Date.now().toString(36)}`;
	const channelDir = resolveSupervisorChannelDir(runId, "worker", 0, physicalSessionId);
	temporaryDirectories.push(channelDir);
	setEnvironment(SUBAGENT_SUPERVISOR_CHANNEL_DIR_ENV, channelDir);
	setEnvironment(SUBAGENT_RUN_ID_ENV, runId);
	setEnvironment(SUBAGENT_CHILD_AGENT_ENV, "worker");
	setEnvironment(SUBAGENT_CHILD_INDEX_ENV, "0");
	setEnvironment(SUBAGENT_ORCHESTRATOR_SESSION_ID_ENV, "parent-session");
	setEnvironment(SUBAGENT_ORCHESTRATOR_PHYSICAL_SESSION_ID_ENV, physicalSessionId);
	const child = apiHarness();
	registerNativeSupervisorClient(child.api);

	expect(existsSync(channelDir)).toBeFalse();
	const tool = child.tools.get("contact_supervisor");
	if (!tool) throw new Error("Expected contact_supervisor to be registered.");
	await tool.execute(
		"progress-call",
		{ reason: "progress_update", message: "Still working." },
		new AbortController().signal,
		undefined,
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		undefined as never,
	);

	expect(existsSync(join(channelDir, "channel.json"))).toBeTrue();
	expect(readdirSync(join(channelDir, "requests")).filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
});

test("structured_output uses the shared Tool row without changing its terminating result", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-structured-presentation-"));
	temporaryDirectories.push(directory);
	const schemaPath = join(directory, "schema.json");
	const capturePath = join(directory, "capture.json");
	writeFileSync(
		schemaPath,
		JSON.stringify({
			additionalProperties: false,
			properties: { answer: { type: "string" } },
			required: ["answer"],
			type: "object",
		}),
	);
	setEnvironment(STRUCTURED_OUTPUT_SCHEMA_ENV, schemaPath);
	setEnvironment(STRUCTURED_OUTPUT_CAPTURE_ENV, capturePath);
	const harness = apiHarness();
	registerSubagentPromptRuntime(harness.api);
	const tool = harness.tools.get("structured_output");
	expectCompactPresentation(tool);
	const result = await tool?.execute(
		"structured-1",
		{ value: { answer: "ok" } },
		new AbortController().signal,
		undefined,
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		{} as never,
	);
	expect(result).toMatchObject({
		content: [{ text: "Structured output captured.", type: "text" }],
		terminate: true,
	});
});

test("retries a failed steering acknowledgement without delivering the steer twice", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-steering-ack-"));
	temporaryDirectories.push(directory);
	const inbox = join(directory, "inbox");
	const ackDir = join(directory, "ack");
	writeFileSync(ackDir, "temporarily-not-a-directory");
	setEnvironment(SUBAGENT_STEER_INBOX_ENV, inbox);
	setEnvironment(SUBAGENT_STEER_ACK_DIR_ENV, ackDir);
	setEnvironment(SUBAGENT_CHILD_INDEX_ENV, "0");

	const handlers = new Map<string, (event: LifecycleEvent) => LifecycleResult>();
	const delivered: string[] = [];
	const pi = createExtensionApi({
		on: lifecycleHandler(handlers),
		sendUserMessage: (content: string) => delivered.push(content),
	});
	registerSteeringInbox(pi);
	try {
		handlers.get("session_start")?.({});
		writeSteerRequestToDir(inbox, {
			type: "steer",
			id: "retry-ack",
			ts: Date.now(),
			message: "Continue with the lifecycle audit.",
		});
		handlers.get("agent_start")?.({});
		expect(delivered).toHaveLength(1);
		const formatted = delivered[0];
		expect(formatted).toContain("Continue with the lifecycle audit.");

		handlers.get("input")?.({
			content: `ambient-prefix\n${formatted}\nambient-suffix`,
			source: "extension",
			streamingBehavior: "steer",
		});
		expect(existsSync(steerAckPathFromDir(ackDir, "retry-ack"))).toBe(false);

		rmSync(ackDir, { force: true });
		mkdirSync(ackDir, { recursive: true });
		handlers.get("turn_end")?.({});
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		const ack = JSON.parse(readFileSync(steerAckPathFromDir(ackDir, "retry-ack"), "utf-8")) as {
			requestId: string;
			state: string;
		};
		expect(ack).toMatchObject({ requestId: "retry-ack", state: "delivered" });
		expect(delivered).toHaveLength(1);
	} finally {
		handlers.get("session_shutdown")?.({});
	}
});

test("retries a correlated steering acknowledgement once during immediate shutdown", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-steering-shutdown-ack-"));
	temporaryDirectories.push(directory);
	const inbox = join(directory, "inbox");
	const ackDir = join(directory, "ack");
	writeFileSync(ackDir, "temporarily-not-a-directory");
	setEnvironment(SUBAGENT_STEER_INBOX_ENV, inbox);
	setEnvironment(SUBAGENT_STEER_ACK_DIR_ENV, ackDir);
	setEnvironment(SUBAGENT_CHILD_INDEX_ENV, "0");

	const handlers = new Map<string, (event: LifecycleEvent) => LifecycleResult>();
	const delivered: string[] = [];
	const pi = createExtensionApi({
		on: lifecycleHandler(handlers),
		sendUserMessage: (content: string) => delivered.push(content),
	});
	registerSteeringInbox(pi);
	handlers.get("session_start")?.({});
	writeSteerRequestToDir(inbox, {
		type: "steer",
		id: "shutdown-retry-ack",
		ts: Date.now(),
		message: "Finish the accepted work.",
	});
	handlers.get("agent_start")?.({});
	const formatted = delivered[0];
	if (formatted === undefined) throw new Error("Expected steering delivery");
	expect(formatted).toContain("Finish the accepted work.");
	handlers.get("input")?.({ content: formatted, source: "extension", streamingBehavior: "steer" });
	expect(existsSync(steerAckPathFromDir(ackDir, "shutdown-retry-ack"))).toBe(false);

	rmSync(ackDir, { force: true });
	mkdirSync(ackDir, { recursive: true });
	handlers.get("session_shutdown")?.({});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const ack = JSON.parse(readFileSync(steerAckPathFromDir(ackDir, "shutdown-retry-ack"), "utf-8")) as {
		requestId: string;
		state: string;
	};
	expect(ack).toMatchObject({ requestId: "shutdown-retry-ack", state: "delivered" });
	expect(delivered).toHaveLength(1);
});

test("holds startup steering until the child's initial Agent turn has started", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-steering-startup-"));
	temporaryDirectories.push(directory);
	const inbox = join(directory, "inbox");
	setEnvironment(SUBAGENT_STEER_INBOX_ENV, inbox);

	const handlers = new Map<string, (event: LifecycleEvent) => LifecycleResult>();
	const delivered: string[] = [];
	registerSteeringInbox(
		createExtensionApi({
			on: lifecycleHandler(handlers),
			sendUserMessage: (content: string) => delivered.push(content),
		}),
	);
	handlers.get("session_start")?.({});
	writeSteerRequestToDir(inbox, {
		type: "steer",
		id: "startup-race",
		ts: Date.now(),
		message: "Wait for the initial task to start.",
	});
	handlers.get("message_start")?.({});
	expect(delivered).toEqual([]);

	handlers.get("agent_start")?.({});
	expect(delivered).toHaveLength(1);
	expect(delivered[0]).toContain("Wait for the initial task to start.");
	handlers.get("session_shutdown")?.({});
});

test("replays a steering request after dispatch crashes before Pi accepts the input", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-steering-dispatch-crash-"));
	temporaryDirectories.push(directory);
	const inbox = join(directory, "inbox");
	const ackDir = join(directory, "ack");
	mkdirSync(ackDir, { recursive: true });
	setEnvironment(SUBAGENT_STEER_INBOX_ENV, inbox);
	setEnvironment(SUBAGENT_STEER_ACK_DIR_ENV, ackDir);
	setEnvironment(SUBAGENT_CHILD_INDEX_ENV, "0");

	const request = {
		type: "steer" as const,
		id: "dispatch-crash",
		ts: Date.now(),
		message: "Continue after the child restart.",
	};
	const firstHandlers = new Map<string, (event: LifecycleEvent) => LifecycleResult>();
	const firstDeliveries: string[] = [];
	registerSteeringInbox(
		createExtensionApi({
			on: lifecycleHandler(firstHandlers),
			sendUserMessage: (content: string) => firstDeliveries.push(content),
		}),
	);
	firstHandlers.get("session_start")?.({});
	writeSteerRequestToDir(inbox, request);
	firstHandlers.get("agent_start")?.({});
	expect(firstDeliveries).toHaveLength(1);
	expect(readdirSync(inbox).some((entry) => entry.includes(".pi-stuff-inflight."))).toBeTrue();
	firstHandlers.get("session_shutdown")?.({});

	const replacementHandlers = new Map<string, (event: LifecycleEvent) => LifecycleResult>();
	const replacementDeliveries: string[] = [];
	registerSteeringInbox(
		createExtensionApi({
			on: lifecycleHandler(replacementHandlers),
			sendUserMessage: (content: string) => replacementDeliveries.push(content),
		}),
	);
	replacementHandlers.get("session_start")?.({});
	replacementHandlers.get("agent_start")?.({});
	expect(replacementDeliveries).toHaveLength(1);
	const replacementDelivery = replacementDeliveries[0];
	if (replacementDelivery === undefined) throw new Error("Expected replacement steering delivery");
	replacementHandlers.get("input")?.({
		content: replacementDelivery,
		source: "extension",
	});
	expect(readFileSync(steerAckPathFromDir(ackDir, request.id), "utf-8")).toContain('"state": "delivered"');
	expect(
		readdirSync(inbox).filter((entry) => entry.endsWith(".json") || entry.includes(".pi-stuff-inflight.")),
	).toEqual([]);
	replacementHandlers.get("session_shutdown")?.({});
});

test("uses an existing steering acknowledgement to retire a crash-left request without redelivery", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-steering-existing-ack-"));
	temporaryDirectories.push(directory);
	const inbox = join(directory, "inbox");
	const ackDir = join(directory, "ack");
	setEnvironment(SUBAGENT_STEER_INBOX_ENV, inbox);
	setEnvironment(SUBAGENT_STEER_ACK_DIR_ENV, ackDir);
	setEnvironment(SUBAGENT_CHILD_INDEX_ENV, "0");
	const request = {
		type: "steer" as const,
		id: "accepted-before-crash",
		ts: Date.now(),
		message: "Do not deliver this twice.",
	};
	writeSteerRequestToDir(inbox, request);
	writeSteerAckAt(steerAckPathFromDir(ackDir, request.id), {
		requestId: request.id,
		index: 0,
		ts: Date.now(),
		state: "delivered",
		message: "Pi accepted the correlated steering input.",
	});

	const handlers = new Map<string, (event: LifecycleEvent) => LifecycleResult>();
	const delivered: string[] = [];
	registerSteeringInbox(
		createExtensionApi({
			on: lifecycleHandler(handlers),
			sendUserMessage: (content: string) => delivered.push(content),
		}),
	);
	handlers.get("session_start")?.({});
	handlers.get("agent_start")?.({});
	expect(delivered).toEqual([]);
	expect(
		readdirSync(inbox).filter((entry) => entry.endsWith(".json") || entry.includes(".pi-stuff-inflight.")),
	).toEqual([]);
	handlers.get("session_shutdown")?.({});
});

test("polling delivers and acknowledges steering exactly once when fs.watch stays silent", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-stuff-steering-poll-"));
	temporaryDirectories.push(directory);
	const inbox = join(directory, "inbox");
	const ackDir = join(directory, "ack");
	const silentDirectory = join(directory, "silent-watch");
	mkdirSync(silentDirectory, { recursive: true });
	setEnvironment(SUBAGENT_STEER_INBOX_ENV, inbox);
	setEnvironment(SUBAGENT_STEER_ACK_DIR_ENV, ackDir);
	setEnvironment(SUBAGENT_CHILD_INDEX_ENV, "0");

	let poll = (): void => {};
	const intervalToken = setInterval(() => {}, 60_000);
	clearInterval(intervalToken);
	const setPollInterval = new Proxy(setInterval, {
		apply: (_target, _thisArg, argumentsList) => {
			// SAFETY: registerSteeringInbox always schedules its local zero-argument flush callback.
			poll = argumentsList[0] as () => void;
			return intervalToken;
		},
	});
	const handlers = new Map<string, (event: LifecycleEvent) => LifecycleResult>();
	const delivered: string[] = [];
	registerSteeringInbox(
		createExtensionApi({
			on: lifecycleHandler(handlers),
			sendUserMessage: (content: string) => delivered.push(content),
		}),
		{
			watch: new Proxy(fsWatch, {
				apply: () => fsWatch(silentDirectory, () => {}),
			}),
			timers: {
				setInterval: setPollInterval,
				clearInterval,
			},
		},
	);
	try {
		handlers.get("session_start")?.({});
		handlers.get("agent_start")?.({});
		writeSteerRequestToDir(inbox, {
			type: "steer",
			id: "poll-fallback",
			ts: Date.now(),
			message: "Continue through the polling fallback.",
		});

		expect(delivered).toEqual([]);
		poll();
		expect(delivered).toHaveLength(1);
		const delivery = delivered[0];
		if (delivery === undefined) throw new Error("Expected polled steering delivery");
		handlers.get("input")?.({ content: delivery, source: "extension", streamingBehavior: "steer" });
		expect(readFileSync(steerAckPathFromDir(ackDir, "poll-fallback"), "utf-8")).toContain('"state": "delivered"');
		poll();
		expect(delivered).toHaveLength(1);
	} finally {
		handlers.get("session_shutdown")?.({});
	}
});
