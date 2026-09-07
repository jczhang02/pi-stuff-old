import { afterEach, expect, test } from "bun:test";
import {
	baseRequest,
	cleanupNativeSupervisorFixtures,
	createNativeSupervisorChannel,
	fs,
	legacyChannel,
	path,
	randomUUID,
	resolveSupervisorChannelDir,
	type SupervisorRequestFixture,
	sessionHarness,
	writeRequest,
} from "../../agents/native-supervisor-channel-fixtures.js";

afterEach(cleanupNativeSupervisorFixtures);

test("releases every delivery claim when one claim close fails", async () => {
	const now = Date.now();
	const runId = `release-failure-${now}-${randomUUID()}`;
	for (const suffix of ["first", "second"]) {
		writeRequest(legacyChannel(runId), {
			...baseRequest(`${suffix}-${now}`, runId, now),
			reason: "need_decision",
			expectsReply: true,
			expiresAt: now + 60_000,
		});
	}
	const test = sessionHarness({
		primary: "ps2-release-failure",
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	});
	let acquired = 0;
	let released = 0;
	const channel = createNativeSupervisorChannel(test.api, test.state, {
		acquireDeliveryClaim: (directory) => {
			acquired += 1;
			const claimIndex = acquired;
			return {
				directory: path.join(directory, `fake-${String(claimIndex)}.lock`),
				token: `fake-${String(claimIndex)}`,
				release: () => {
					released += 1;
					if (claimIndex === 1) throw Object.assign(new Error("injected close EIO"), { code: "EIO" });
				},
			};
		},
	});

	await channel.start();
	await Bun.sleep(0);
	expect(channel.pending.size).toBe(2);
	expect(() => channel.pause()).not.toThrow();
	expect(released).toBe(2);
	expect(channel.pending.size).toBe(0);
	channel.dispose();
});

test("does not rescan the session for an already accepted request awaiting a reply", async () => {
	const now = Date.now();
	const runId = `accepted-ask-${now}`;
	const request: SupervisorRequestFixture = {
		...baseRequest(`accepted-ask-request-${now}`, runId, now),
		reason: "need_decision",
		message: "Keep waiting for the supervisor",
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
	const test = sessionHarness({
		primary: "ps2-accepted-ask",
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	});
	const channel = createNativeSupervisorChannel(test.api, test.state);

	await channel.start();

	expect(channel.pending.has(request.id)).toBeTrue();
	expect(test.sessionCalls).toEqual({ getEntries: 0, getSessionFile: 0 });
	channel.dispose();
});

test("does not rescan the session on repeated polls during an unaccepted delivery grace period", async () => {
	const now = Date.now();
	const runId = `delivery-grace-${now}`;
	const request: SupervisorRequestFixture = {
		...baseRequest(`delivery-grace-request-${now}`, runId, now),
		reason: "need_decision",
		message: "Wait for canonical session persistence",
		expectsReply: true,
		expiresAt: now + 60_000,
	};
	const requestFile = writeRequest(legacyChannel(runId), request);
	fs.writeFileSync(
		path.join(path.dirname(requestFile), `.${path.basename(requestFile)}.delivery-state`),
		JSON.stringify({ version: 2, requestId: request.id, lastAttemptAt: now }),
		{ mode: 0o600 },
	);
	const test = sessionHarness({
		primary: "ps2-delivery-grace",
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	});
	const channel = createNativeSupervisorChannel(test.api, test.state);

	await channel.start();
	await Bun.sleep(1_100);

	expect(test.messages).toHaveLength(0);
	expect(test.sessionCalls).toEqual({ getEntries: 0, getSessionFile: 0 });
	channel.dispose();
});

test("indexes the session once and records accepted delivery without another history scan", async () => {
	const now = Date.now();
	const runId = `accepted-index-${now}`;
	const request: SupervisorRequestFixture = {
		...baseRequest(`accepted-index-request-${now}`, runId, now),
		reason: "need_decision",
		expectsReply: true,
		expiresAt: now + 60_000,
	};
	writeRequest(legacyChannel(runId), request);
	const test = sessionHarness({
		primary: "ps2-accepted-index",
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	});
	const channel = createNativeSupervisorChannel(test.api, test.state);

	await channel.start();
	expect(test.sessionCalls).toEqual({ getEntries: 1, getSessionFile: 1 });
	await Bun.sleep(600);
	expect(test.sessionCalls).toEqual({ getEntries: 1, getSessionFile: 1 });
	expect(channel.pending.has(request.id)).toBeTrue();
	channel.dispose();
});

test("treats a reply consumed immediately after publication as delivered", async () => {
	const now = Date.now();
	const runId = `reply-race-${now}`;
	const request: SupervisorRequestFixture = {
		...baseRequest(`reply-race-request-${now}`, runId, now),
		reason: "need_decision",
		message: "Choose one safe path",
		expectsReply: true,
		expiresAt: now + 60_000,
	};
	const channelDir = legacyChannel(runId);
	const requestFile = writeRequest(channelDir, request);
	const test = sessionHarness({
		primary: "ps2-reply-race",
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	});
	let consumed: unknown;
	const channel = createNativeSupervisorChannel(test.api, test.state, {
		afterReplyPublish(replyFile) {
			consumed = JSON.parse(fs.readFileSync(replyFile, "utf8"));
			fs.unlinkSync(replyFile);
			fs.unlinkSync(requestFile);
		},
	});
	await channel.start();
	const replyTool = test.tools.get("subagent_supervisor");
	if (!replyTool) throw new Error("Expected the native supervisor reply tool.");

	const result = await replyTool.execute(
		"reply-race-call",
		{ action: "reply", replyTo: request.id, message: "Use the verified path." },
		new AbortController().signal,
		undefined,
		test.ctx,
	);

	expect(consumed).toMatchObject({ requestId: request.id, message: "Use the verified path." });
	expect(result).toMatchObject({ details: { replyTo: request.id } });
	expect(channel.pending.has(request.id)).toBeFalse();
	channel.dispose();
});

test("delivers a branch-proven v1 progress update without expiresAt exactly once across two hosts", async () => {
	const now = Date.now();
	const runId = `legacy-${now}`;
	const request = baseRequest(`v1-${now}`, runId, now);
	writeRequest(legacyChannel(runId), request);
	const test = sessionHarness({
		primary: "ps2-current",
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	});
	const first = createNativeSupervisorChannel(test.api, test.state);
	const second = createNativeSupervisorChannel(test.api, test.state);

	await first.start();
	await second.start();

	expect(test.messages).toHaveLength(1);
	expect(test.messages[0]).toMatchObject({
		customType: "subagent_supervisor_request",
		details: { id: request.id, runId },
	});
	first.dispose();
	second.dispose();
});

test("indexes one bounded session tail once for a full page of persisted requests", async () => {
	const now = Date.now();
	const runId = `indexed-page-${now}`;
	const channelDir = legacyChannel(runId);
	const records: string[] = [];
	for (let index = 0; index < 256; index += 1) {
		const request = baseRequest(`indexed-${index}-${now}`, runId, now);
		writeRequest(channelDir, request);
		records.push(
			JSON.stringify({
				type: "custom_message",
				customType: "subagent_supervisor_request",
				details: { id: request.id },
			}),
		);
	}
	const test = sessionHarness({
		primary: "ps2-indexed-page",
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	});
	const persisted = `${records.join("\n")}\n`;
	const padding = Buffer.alloc(32 * 1024 * 1024 - Buffer.byteLength(persisted), 0x20);
	fs.writeFileSync(test.sessionFile, padding);
	fs.appendFileSync(test.sessionFile, persisted);
	const channel = createNativeSupervisorChannel(test.api, test.state);

	await channel.start();

	expect(test.messages).toHaveLength(0);
	let requestEntries = fs.readdirSync(path.join(channelDir, "requests"));
	const deadline = Date.now() + 2_000;
	while (requestEntries.some((entry) => entry.endsWith(".json")) && Date.now() < deadline) {
		await Bun.sleep(25);
		requestEntries = fs.readdirSync(path.join(channelDir, "requests"));
	}
	expect(test.sessionCalls).toEqual({ getEntries: 1, getSessionFile: 1 });
	expect(requestEntries.filter((entry) => entry.endsWith(".json"))).toHaveLength(0);
	expect(requestEntries.filter((entry) => entry.endsWith(".delivery-state"))).toHaveLength(0);
	expect(requestEntries.filter((entry) => entry.endsWith(".lock")).length).toBeLessThanOrEqual(256);
	channel.dispose();
});

test("removes a full malformed-message page before delivering the next valid request", async () => {
	const now = Date.now();
	const runId = `malformed-page-${now}`;
	const channelDir = legacyChannel(runId);
	for (let index = 0; index < 256; index += 1) {
		writeRequest(channelDir, {
			...baseRequest(`${String(index).padStart(3, "0")}-${now}`, runId, now),
			message: "",
		});
	}
	const valid = baseRequest(`zzz-valid-${now}`, runId, now);
	writeRequest(channelDir, valid);
	const test = sessionHarness({
		primary: "ps2-current",
		legacyRunIds: new Set([runId]),
		startedAtMs: now - 1_000,
	});
	const channel = createNativeSupervisorChannel(test.api, test.state);

	await channel.start();
	const deadline = Date.now() + 2_000;
	while (test.messages.length === 0 && Date.now() < deadline) await Bun.sleep(25);

	expect(test.messages).toHaveLength(1);
	expect(test.messages[0]).toMatchObject({ details: { id: valid.id } });
	expect(fs.readdirSync(path.join(channelDir, "requests")).filter((file) => file.endsWith(".json"))).toEqual([
		`${valid.id}.json`,
	]);
	channel.dispose();
});

test("retains but never delivers a v1 request that the active branch cannot prove", async () => {
	const now = Date.now();
	const runId = `foreign-${now}`;
	const request = baseRequest(`foreign-request-${now}`, runId, now);
	const file = writeRequest(legacyChannel(runId), request);
	const test = sessionHarness({
		primary: "ps2-current",
		legacyRunIds: new Set(),
		startedAtMs: now - 1_000,
	});
	const channel = createNativeSupervisorChannel(test.api, test.state);

	await channel.start();

	expect(test.messages).toHaveLength(0);
	expect(fs.existsSync(file)).toBeTrue();
	channel.dispose();
});

test("continues to deliver a v2 request addressed to the primary physical session", async () => {
	const now = Date.now();
	const primary = "ps2-current";
	const runId = `v2-run-${now}`;
	const request = {
		...baseRequest(`v2-${now}`, runId, now),
		physicalSessionId: primary,
		expiresAt: now + 60_000,
	};
	writeRequest(resolveSupervisorChannelDir(runId, "worker", 0, primary), request);
	const test = sessionHarness({
		primary,
		legacyRunIds: new Set(),
		startedAtMs: now - 1_000,
	});
	const channel = createNativeSupervisorChannel(test.api, test.state);

	await channel.start();

	expect(test.messages).toHaveLength(1);
	expect(test.messages[0]).toMatchObject({ details: { id: request.id, runId } });
	channel.dispose();
});
