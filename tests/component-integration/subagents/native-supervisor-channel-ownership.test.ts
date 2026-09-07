import { afterEach, expect, test } from "bun:test";
import {
	baseRequest,
	cleanupNativeSupervisorFixtures,
	createNativeSupervisorChannel,
	directories,
	type ExtensionAPI,
	fs,
	garbageCollectSupervisorChannel,
	getToolUiRuntime,
	harness,
	legacyChannel,
	path,
	resolveSupervisorChannelDir,
	type SupervisorRequestFixture,
	sessionHarness,
	shardedDurableClaimName,
	TEMP_ROOT_DIR,
	type ToolDefinition,
	writeRequest,
} from "../../agents/native-supervisor-channel-fixtures.js";

afterEach(cleanupNativeSupervisorFixtures);

test("reclaims an old metadata-less channel left by a crash during first initialization", async () => {
	const now = Date.now();
	const channelDir = resolveSupervisorChannelDir(`partial-${now}`, "worker", 0, `partial-session-${now}`);
	directories.push(channelDir);
	fs.mkdirSync(path.join(channelDir, "requests"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(channelDir, "replies"), { recursive: true, mode: 0o700 });
	const old = new Date(now - 120_000);
	fs.utimesSync(path.join(channelDir, "requests"), old, old);
	fs.utimesSync(path.join(channelDir, "replies"), old, old);
	fs.utimesSync(channelDir, old, old);
	const test = harness({
		primary: `partial-session-${now}`,
		legacyFile: path.join(channelDir, "parent.jsonl"),
		legacyRunIds: new Set(),
		startedAtMs: now,
	});

	expect(await garbageCollectSupervisorChannel(channelDir, test.state, now)).toBe(true);
	expect(fs.existsSync(channelDir)).toBe(false);
});

test("retains a fresh or non-empty metadata-less channel", async () => {
	const now = Date.now();
	for (const [suffix, old, nonEmpty] of [
		["fresh", false, false],
		["non-empty", true, true],
	] as const) {
		const channelDir = resolveSupervisorChannelDir(`${suffix}-${now}`, "worker", 0, `${suffix}-session-${now}`);
		directories.push(channelDir);
		fs.mkdirSync(path.join(channelDir, "requests"), { recursive: true, mode: 0o700 });
		fs.mkdirSync(path.join(channelDir, "replies"), { recursive: true, mode: 0o700 });
		if (nonEmpty) fs.writeFileSync(path.join(channelDir, "requests", "retained.json"), "{}", { mode: 0o600 });
		if (old) {
			const timestamp = new Date(now - 120_000);
			fs.utimesSync(path.join(channelDir, "requests"), timestamp, timestamp);
			fs.utimesSync(path.join(channelDir, "replies"), timestamp, timestamp);
			fs.utimesSync(channelDir, timestamp, timestamp);
		}
		const test = harness({
			primary: `${suffix}-session-${now}`,
			legacyFile: path.join(channelDir, "parent.jsonl"),
			legacyRunIds: new Set(),
			startedAtMs: now,
		});

		expect(await garbageCollectSupervisorChannel(channelDir, test.state, now)).toBe(false);
		expect(fs.existsSync(channelDir)).toBe(true);
	}
});

test("garbage-collects a dead child channel including orphan replies and durable claim files", async () => {
	const now = Date.now();
	const runId = `gc-${now}`;
	const physicalSessionId = `gc-physical-${now}`;
	const channelDir = resolveSupervisorChannelDir(runId, "worker", 0, physicalSessionId);
	directories.push(channelDir);
	fs.mkdirSync(path.join(channelDir, "requests"), { recursive: true, mode: 0o700 });
	fs.mkdirSync(path.join(channelDir, "replies"), { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(channelDir, "channel.json"),
		JSON.stringify({
			version: 1,
			physicalSessionId,
			runId,
			agent: "worker",
			childIndex: 0,
			ownerPid: 2_147_483_647,
			ownerProcessStartIdentity: "dead-owner",
			updatedAt: now,
		}),
		{ mode: 0o600 },
	);
	fs.writeFileSync(path.join(channelDir, "replies", "orphan.json"), "{}", { mode: 0o600 });
	fs.writeFileSync(path.join(channelDir, "requests", "old.delivery-claim.lock"), "stale lock inode", {
		mode: 0o600,
	});
	const test = harness({
		primary: physicalSessionId,
		legacyFile: path.join(channelDir, "parent.jsonl"),
		legacyRunIds: new Set(),
		startedAtMs: now,
	});

	expect(await garbageCollectSupervisorChannel(channelDir, test.state)).toBe(true);
	expect(fs.existsSync(channelDir)).toBe(false);
});

test("does not let the root native fallback pre-empt a later session_start intercom tool", async () => {
	const now = Date.now();
	const test = sessionHarness({
		primary: "ps2-dynamic-intercom",
		legacyRunIds: new Set(),
		startedAtMs: now,
	});
	const channel = createNativeSupervisorChannel(test.api, test.state);

	await channel.start();
	expect(test.tools.has("subagent_supervisor")).toBe(true);
	expect(test.tools.has("intercom")).toBe(false);
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const external = {
		name: "intercom",
		label: "External Intercom",
		description: "Dynamically registered external intercom.",
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		parameters: {} as never,
		async execute() {
			return { content: [{ type: "text" as const, text: "external" }], details: {} };
		},
	} as ToolDefinition;
	test.api.registerTool(external);

	await test.run("before_agent_start");

	expect(test.tools.get("intercom")).toBe(external);
	channel.dispose();
});

test("replaces a replay-only supervisor definition when the live channel starts", async () => {
	const now = Date.now();
	const fixture = sessionHarness({
		primary: "ps2-replay-supervisor",
		legacyRunIds: new Set(),
		startedAtMs: now,
	});
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const replay = {
		name: "subagent_supervisor",
		label: "Historical Subagent Supervisor",
		description: "Historical replay definition",
		// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
		parameters: {} as never,
		async execute() {
			return { content: [{ type: "text" as const, text: "replay-only" }], details: {} };
		},
	} as ToolDefinition;
	fixture.api.registerTool(replay);
	fixture.api.setActiveTools([]);
	getToolUiRuntime(fixture.api).markReplayOnlyTool("subagent_supervisor");

	const channel = createNativeSupervisorChannel(fixture.api, fixture.state);
	await channel.start();

	expect(fixture.tools.get("subagent_supervisor")).not.toBe(replay);
	expect(getToolUiRuntime(fixture.api).isReplayOnlyTool("subagent_supervisor")).toBe(false);
	expect(fixture.api.getActiveTools()).toContain("subagent_supervisor");
	channel.dispose();
});

test("keeps one durable reply owner after an ask is accepted across two Pi hosts", async () => {
	const now = Date.now();
	const runId = `ask-${now}`;
	const request: SupervisorRequestFixture = {
		...baseRequest(`ask-request-${now}`, runId, now),
		reason: "need_decision",
		message: "Choose one safe path",
		expectsReply: true,
		expiresAt: now + 60_000,
	};
	const channelDir = legacyChannel(runId);
	writeRequest(channelDir, request);
	const root = fs.mkdtempSync(path.join(TEMP_ROOT_DIR, "supervisor-session-"));
	directories.push(root);
	const sessionFile = path.join(root, "parent.jsonl");
	fs.writeFileSync(sessionFile, "");
	const input = {
		primary: "ps2-current",
		legacyFile: sessionFile,
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	};
	const firstHost = harness(input);
	const secondHost = harness(input);
	const first = createNativeSupervisorChannel(firstHost.api, firstHost.state);
	const second = createNativeSupervisorChannel(secondHost.api, secondHost.state);

	await first.start();
	expect(first.pending.has(request.id)).toBeTrue();
	fs.appendFileSync(
		sessionFile,
		`${JSON.stringify({
			type: "custom_message",
			customType: "subagent_supervisor_request",
			details: { id: request.id },
		})}\n`,
	);
	await Bun.sleep(600);
	await second.start();

	expect(firstHost.messages).toHaveLength(1);
	expect(secondHost.messages).toHaveLength(0);
	expect(first.pending.has(request.id)).toBeTrue();
	expect(second.pending.has(request.id)).toBeFalse();

	const replyTool = firstHost.tools.get("subagent_supervisor");
	if (!replyTool) throw new Error("Expected the owning supervisor reply tool.");
	await replyTool.execute(
		"reply-call",
		{ action: "reply", replyTo: request.id, message: "Use the verified path." },
		new AbortController().signal,
		undefined,
		firstHost.ctx,
	);
	expect(JSON.parse(fs.readFileSync(path.join(channelDir, "replies", `${request.id}.json`), "utf8"))).toMatchObject({
		requestId: request.id,
		message: "Use the verified path.",
	});
	expect(first.pending.has(request.id)).toBeFalse();
	expect(second.pending.has(request.id)).toBeFalse();
	first.dispose();
	second.dispose();
});

test("accepts simultaneous same-channel asks even when their legacy delivery shards collide", async () => {
	const now = Date.now();
	const runId = `same-channel-collision-${now}`;
	const idsByShard = new Map<string, string>();
	let ids: [string, string] | undefined;
	for (let index = 0; index < 10_000 && !ids; index += 1) {
		const candidate = `ask-${now}-${index}`;
		const shard = shardedDurableClaimName("request-delivery", candidate);
		const prior = idsByShard.get(shard);
		if (prior) ids = [prior, candidate];
		else idsByShard.set(shard, candidate);
	}
	if (!ids) throw new Error("Expected a deterministic legacy shard collision");
	const channelDir = legacyChannel(runId);
	for (const id of ids) {
		writeRequest(channelDir, {
			...baseRequest(id, runId, now),
			reason: "need_decision",
			message: `decision requested by ${id}`,
			expectsReply: true,
			expiresAt: now + 60_000,
		});
	}
	const test = sessionHarness({
		primary: "ps2-current",
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	});
	const channel = createNativeSupervisorChannel(test.api, test.state);

	await channel.start();

	expect([...channel.pending.keys()].sort()).toEqual([...ids].sort());
	expect(test.messages).toHaveLength(2);
	channel.dispose();
});

test("releases a durable reply owner on pause so the next session Host can take over", async () => {
	const now = Date.now();
	const runId = `paused-ask-${now}`;
	const request: SupervisorRequestFixture = {
		...baseRequest(`paused-ask-request-${now}`, runId, now),
		reason: "need_decision",
		message: "Keep the request recoverable across a session switch",
		expectsReply: true,
		expiresAt: now + 60_000,
	};
	const requestFile = writeRequest(legacyChannel(runId), request);
	fs.writeFileSync(
		path.join(path.dirname(requestFile), `.${path.basename(requestFile)}.delivery-state`),
		JSON.stringify({
			version: 2,
			requestId: request.id,
			lastAttemptAt: now - 1_000,
			acceptedAt: now - 500,
		}),
		{ mode: 0o600 },
	);
	const root = fs.mkdtempSync(path.join(TEMP_ROOT_DIR, "supervisor-session-"));
	directories.push(root);
	const sessionFile = path.join(root, "parent.jsonl");
	fs.writeFileSync(sessionFile, "");
	const input = {
		primary: "ps2-paused-owner",
		legacyFile: sessionFile,
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	};
	const firstHost = harness(input);
	const secondHost = harness(input);
	const first = createNativeSupervisorChannel(firstHost.api, firstHost.state);
	const second = createNativeSupervisorChannel(secondHost.api, secondHost.state);

	await first.start();
	expect(first.pending.has(request.id)).toBeTrue();
	first.pause();
	expect(first.pending.has(request.id)).toBeFalse();

	await second.start();
	expect(second.pending.has(request.id)).toBeTrue();
	expect(secondHost.messages).toHaveLength(0);

	first.dispose();
	second.dispose();
});

test("keeps an in-flight delivery claimed until the replaced session becomes stale", async () => {
	const now = Date.now();
	const runId = `in-flight-pause-${now}`;
	const request: SupervisorRequestFixture = {
		...baseRequest(`in-flight-pause-request-${now}`, runId, now),
		reason: "need_decision",
		message: "Do not deliver this request concurrently across a session switch",
		expectsReply: true,
		expiresAt: now + 60_000,
	};
	const requestFile = writeRequest(legacyChannel(runId), request);
	const root = fs.mkdtempSync(path.join(TEMP_ROOT_DIR, "supervisor-session-"));
	directories.push(root);
	const sessionFile = path.join(root, "parent.jsonl");
	fs.writeFileSync(sessionFile, "");
	const firstDelivery = Promise.withResolvers<void>();
	let firstDeliveries = 0;
	const common = {
		primary: "ps2-in-flight-pause",
		legacyFile: sessionFile,
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	};
	const firstHost = harness({
		...common,
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		sendMessage: (() => {
			firstDeliveries += 1;
			return firstDelivery.promise;
		}) as ExtensionAPI["sendMessage"],
	});
	const secondHost = harness(common);
	const first = createNativeSupervisorChannel(firstHost.api, firstHost.state);
	const second = createNativeSupervisorChannel(secondHost.api, secondHost.state);

	await first.start();
	expect(firstDeliveries).toBe(1);
	first.pause();
	fs.writeFileSync(
		path.join(path.dirname(requestFile), `.${path.basename(requestFile)}.delivery-state`),
		JSON.stringify({ version: 2, requestId: request.id, lastAttemptAt: now - 60_000 }),
		{ mode: 0o600 },
	);
	await second.start();
	expect(secondHost.messages).toHaveLength(0);

	firstDelivery.resolve();
	await Bun.sleep(0);
	expect(first.pending.has(request.id)).toBeFalse();

	second.pause();
	await second.start();
	expect(secondHost.messages).toHaveLength(1);
	expect(second.pending.has(request.id)).toBeTrue();

	first.dispose();
	second.dispose();
});
