import { expect, test } from "bun:test";
import {
	Check,
	createApiHarness,
	createContext,
	createDeferred,
	drainMicrotasks,
	EventBusHarness,
	emitAgentTurn,
	INPUT_EVENT_SCHEMA,
	installedCommandDialogHarness,
	piStuffUi,
	promoteActiveAgentWorkToUser,
	readCurrentAgentWorkOrigin,
	requestStatuslineGitRefreshAfterUserWork,
	UiHarness,
	withAgentWorkOrigin,
} from "../../ui/command-dialog-coordinator-fixtures.js";

test("refreshes Git once after a direct-user Agent run, not after automatic Extension runs", async () => {
	const { api, ctx } = await installedCommandDialogHarness();

	await api.emit("input", { type: "input", text: "automatic", source: "extension" }, ctx);
	expect(readCurrentAgentWorkOrigin(api.api)).toBe("automatic");
	await emitAgentTurn(api, ctx, "automatic");
	await api.emit("agent_settled", { type: "agent_settled" }, ctx);
	expect(api.execCalls).toHaveLength(0);

	await api.emit("input", { type: "input", text: "direct", source: "interactive" }, ctx);
	expect(readCurrentAgentWorkOrigin(api.api)).toBe("automatic");
	await emitAgentTurn(api, ctx, "direct", 0, 2);
	await api.emit(
		"input",
		{ type: "input", text: "queued automatic", source: "extension", streamingBehavior: "followUp" },
		ctx,
	);
	expect(readCurrentAgentWorkOrigin(api.api)).toBe("user");
	await emitAgentTurn(api, ctx, "queued automatic", 1, 3);
	expect(readCurrentAgentWorkOrigin(api.api)).toBe("automatic");
	await api.emit("agent_settled", { type: "agent_settled" }, ctx);
	expect(api.execCalls).toHaveLength(1);
	expect(readCurrentAgentWorkOrigin(api.api)).toBe("automatic");

	await api.emit("agent_settled", { type: "agent_settled" }, ctx);
	expect(api.execCalls).toHaveLength(1);

	await api.emit("input", { type: "input", text: "automatic", source: "extension" }, ctx);
	await emitAgentTurn(api, ctx, "automatic", 0, 4);
	await api.emit(
		"input",
		{ type: "input", text: "user follow-up", source: "rpc", streamingBehavior: "followUp" },
		ctx,
	);
	// Merely accepting a follow-up must not change the work currently executing.
	expect(readCurrentAgentWorkOrigin(api.api)).toBe("automatic");
	await emitAgentTurn(api, ctx, "user follow-up", 1, 5);
	expect(readCurrentAgentWorkOrigin(api.api)).toBe("user");
	await api.emit("agent_settled", { type: "agent_settled" }, ctx);
	expect(api.execCalls).toHaveLength(2);
});

test("waits for a Goal continuation started by an earlier settlement handler before refreshing Git", async () => {
	const api = createApiHarness();
	await piStuffUi(api.api);
	let idle = true;
	let pendingMessages = false;
	let settlements = 0;
	api.api.on("agent_settled", () => {
		settlements += 1;
		if (settlements !== 1) return;
		// Goal is initialized after Conversation UI, but its listener exists before
		// session_start. It schedules an automatic continuation at this boundary.
		idle = false;
		pendingMessages = true;
	});
	const ctx = createContext(new UiHarness(), "tui", {
		hasPendingMessages: () => pendingMessages,
		isIdle: () => idle,
	});
	await api.start(ctx);

	await api.emit("input", { type: "input", text: "direct", source: "interactive" }, ctx);
	await emitAgentTurn(api, ctx, "direct");
	await api.emit("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
	await api.emit("agent_settled", { type: "agent_settled" }, ctx);
	expect(api.execCalls).toHaveLength(0);

	pendingMessages = false;
	await emitAgentTurn(
		api,
		ctx,
		withAgentWorkOrigin({ role: "custom", customType: "goal-continuation", content: "continue" }, "automatic"),
		1,
		2,
	);
	await api.emit("turn_end", { type: "turn_end", turnIndex: 1 }, ctx);
	idle = true;
	await api.emit("agent_settled", { type: "agent_settled" }, ctx);
	expect(api.execCalls).toHaveLength(1);
});

test("holds background refresh requests while earlier settlement handlers are still running", async () => {
	const api = createApiHarness();
	await piStuffUi(api.api);
	const settlementEntered = createDeferred<void>();
	const releaseSettlement = createDeferred<void>();
	api.api.on("agent_settled", async () => {
		settlementEntered.resolve();
		await releaseSettlement.promise;
	});
	// Pi marks itself idle before it awaits Extension settlement handlers.
	const ctx = createContext(new UiHarness(), "tui", {
		hasPendingMessages: () => false,
		isIdle: () => true,
	});
	await api.start(ctx);

	await api.emit("agent_start", { type: "agent_start" }, ctx);
	const settlement = api.emit("agent_settled", { type: "agent_settled" }, ctx);
	await settlementEntered.promise;
	requestStatuslineGitRefreshAfterUserWork(api.api);
	expect(api.execCalls).toHaveLength(0);

	releaseSettlement.resolve();
	await settlement;
	expect(api.execCalls).toHaveLength(1);
});

test("finishes Git observation before a later settlement handler can start Agent work", async () => {
	const gitEntered = createDeferred<void>();
	const releaseGit = createDeferred<void>();
	const order: string[] = [];
	let gitRunning = false;
	let overlap = false;
	const api = createApiHarness(new EventBusHarness(), async () => {
		gitRunning = true;
		order.push("git-start");
		gitEntered.resolve();
		await releaseGit.promise;
		order.push("git-complete");
		gitRunning = false;
		return { code: 1, killed: false, stderr: "", stdout: "" };
	});
	const { ctx } = await installedCommandDialogHarness({}, api);
	// A separately loaded Extension can register after Pi Stuff's dynamic
	// observer. The certified Pi Host awaits these handlers in registration order.
	api.api.on("agent_settled", () => {
		overlap = gitRunning;
		order.push("later-extension");
	});

	await api.emit("input", { type: "input", text: "direct", source: "interactive" }, ctx);
	await api.emit("agent_start", { type: "agent_start" }, ctx);
	await emitAgentTurn(api, ctx, "direct");
	await api.emit("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
	const settlement = api.emit("agent_settled", { type: "agent_settled" }, ctx);
	await gitEntered.promise;
	expect(order).toEqual(["git-start"]);

	releaseGit.resolve();
	await settlement;
	expect(overlap).toBe(false);
	expect(order).toEqual(["git-start", "git-complete", "later-extension"]);
});

test("does not refresh Git for a direct input handled before Pi starts a turn", async () => {
	const { api, ctx } = await installedCommandDialogHarness();

	await api.emit("input", { type: "input", text: "/handled", source: "interactive" }, ctx);
	await emitAgentTurn(
		api,
		ctx,
		withAgentWorkOrigin({ role: "custom", customType: "automatic-work", content: "continue" }, "automatic"),
	);
	await api.emit("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
	await api.emit("agent_settled", { type: "agent_settled" }, ctx);
	expect(api.execCalls).toHaveLength(0);
});

test("does not refresh Git for a steer handled before Pi delivers it", async () => {
	const api = createApiHarness();
	await piStuffUi(api.api);
	api.api.on("input", (event) =>
		Check(INPUT_EVENT_SCHEMA, event) && event.text === "handled correction" && event.source === "interactive"
			? { action: "handled" as const }
			: undefined,
	);
	const ctx = createContext(new UiHarness());
	await api.start(ctx);

	await api.emit("input", { type: "input", text: "automatic", source: "extension" }, ctx);
	await emitAgentTurn(
		api,
		ctx,
		withAgentWorkOrigin({ role: "custom", customType: "automatic-work", content: "continue" }, "automatic"),
	);
	await api.emit(
		"input",
		{ type: "input", text: "handled correction", source: "interactive", streamingBehavior: "steer" },
		ctx,
	);
	await api.emit(
		"input",
		{ type: "input", text: "handled correction", source: "extension", streamingBehavior: "steer" },
		ctx,
	);
	await api.emit(
		"message_start",
		{ type: "message_start", message: { role: "user", content: "handled correction" } },
		ctx,
	);
	await api.emit("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
	await api.emit("agent_settled", { type: "agent_settled" }, ctx);
	expect(api.execCalls).toHaveLength(0);
});

test("fails closed when a later Extension makes steer attribution ambiguous", async () => {
	const { api, ctx } = await installedCommandDialogHarness();
	// Registered after session_start, this simulates a separately loaded
	// Extension that Pi visits after Pi Stuff's Package-local late observer.
	api.api.on("input", (event) => {
		const text = Check(INPUT_EVENT_SCHEMA, event) ? event.text : undefined;
		if (text === "handled user correction") return { action: "handled" as const };
		if (text === "raw automatic correction") {
			return { action: "transform" as const, text: "transformed automatic correction" };
		}
		return undefined;
	});

	await api.emit("input", { type: "input", text: "automatic run", source: "extension" }, ctx);
	await emitAgentTurn(
		api,
		ctx,
		withAgentWorkOrigin({ role: "custom", customType: "automatic-work", content: "continue" }, "automatic"),
	);
	await api.emit(
		"input",
		{ type: "input", text: "handled user correction", source: "interactive", streamingBehavior: "steer" },
		ctx,
	);
	await api.emit(
		"input",
		{ type: "input", text: "raw automatic correction", source: "extension", streamingBehavior: "steer" },
		ctx,
	);
	await api.emit(
		"message_start",
		{ type: "message_start", message: { role: "user", content: "transformed automatic correction" } },
		ctx,
	);
	await api.emit("turn_end", { type: "turn_end", turnIndex: 0 }, ctx);
	await api.emit("agent_settled", { type: "agent_settled" }, ctx);

	expect(api.execCalls).toHaveLength(0);
});

test("attributes marked custom work at delivery and accepted Suite steers immediately", async () => {
	const { api, ctx } = await installedCommandDialogHarness();

	const queued = withAgentWorkOrigin(
		{ role: "custom", customType: "explicit-user-action", content: "continue" },
		"user",
	);
	expect(readCurrentAgentWorkOrigin(api.api)).toBe("automatic");
	await emitAgentTurn(api, ctx, queued);
	expect(readCurrentAgentWorkOrigin(api.api)).toBe("user");
	await api.emit("agent_settled", { type: "agent_settled" }, ctx);
	expect(api.execCalls).toHaveLength(1);

	await api.emit("input", { type: "input", text: "automatic", source: "extension" }, ctx);
	promoteActiveAgentWorkToUser(api.api);
	expect(readCurrentAgentWorkOrigin(api.api)).toBe("user");
	await api.emit("agent_settled", { type: "agent_settled" }, ctx);
	expect(api.execCalls).toHaveLength(2);
});

test("refreshes Git for completed user work only at an idle boundary in the active generation", async () => {
	const events = new EventBusHarness();
	const first = createApiHarness(events);
	await piStuffUi(first.api);
	requestStatuslineGitRefreshAfterUserWork(first.api);
	expect(first.execCalls).toEqual([]);

	let idle = false;
	let pendingMessages = false;
	const firstContext = createContext(new UiHarness(), "tui", {
		hasPendingMessages: () => pendingMessages,
		isIdle: () => idle,
	});
	await first.start(firstContext);
	requestStatuslineGitRefreshAfterUserWork(first.api);
	idle = true;
	pendingMessages = true;
	requestStatuslineGitRefreshAfterUserWork(first.api);
	expect(first.execCalls).toHaveLength(0);
	pendingMessages = false;
	await first.emit("agent_settled", { type: "agent_settled" }, firstContext);
	expect(first.execCalls).toHaveLength(1);
	await drainMicrotasks();
	requestStatuslineGitRefreshAfterUserWork(first.api);
	await drainMicrotasks();
	expect(first.execCalls).toHaveLength(2);

	await first.shutdown(firstContext);
	requestStatuslineGitRefreshAfterUserWork(first.api);
	expect(first.execCalls).toHaveLength(2);

	const reloaded = createApiHarness(events);
	await piStuffUi(reloaded.api);
	await reloaded.start(createContext(new UiHarness()));
	requestStatuslineGitRefreshAfterUserWork(reloaded.api);
	await drainMicrotasks();
	expect(first.execCalls).toHaveLength(2);
	expect(reloaded.execCalls).toHaveLength(1);

	await reloaded.shutdown(createContext(new UiHarness()));
	requestStatuslineGitRefreshAfterUserWork(reloaded.api);
	expect(reloaded.execCalls).toHaveLength(1);
});
