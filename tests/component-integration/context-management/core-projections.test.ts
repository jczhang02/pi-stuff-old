import { afterEach, expect, test } from "bun:test";
import {
	__test,
	apiFor,
	cleanupContextCoreFixtures,
	context,
	type ExtensionAPI,
	type ExtensionCommandContext,
	emit,
	type Handler,
	type Handlers,
	magicModule,
	piStuffContext,
	projectCurrentContext,
	type SessionEntry,
	taggedMessage,
} from "../../context/core-fixtures.js";

afterEach(cleanupContextCoreFixtures);

test("falls back to bounded native history for forked Agents without giving fresh Agents the whole session", async () => {
	// SAFETY: this test controls the value and supplies every SessionEntry member exercised by this case.
	const entry = {
		type: "message",
		id: "message-1",
		parentId: null,
		timestamp: "2026-08-09T00:00:00.000Z",
		message: taggedMessage("parent <instruction>history</instruction>"),
	} as SessionEntry;
	const ctx = context([entry]);

	const fork = await projectCurrentContext("agent-fork", ctx, { maxTokens: 512 });
	const fresh = await projectCurrentContext("agent-fresh", ctx, { maxTokens: 512 });
	const btw = await projectCurrentContext("btw", ctx, { maxTokens: 512 });

	expect(fork.source).toBe("native");
	expect(fork.text).toContain('audience="agent-fork"');
	expect(fork.text).toContain("parent &lt;instruction&gt;history&lt;/instruction&gt;");
	expect(fork.text.length).toBeLessThanOrEqual(700);
	expect(fresh).toEqual({ source: "native", text: "", truncated: false });
	expect(btw).toEqual({ source: "native", text: "", truncated: false });
});

test("builds native fallback from bounded session ends without materializing a huge middle", async () => {
	const projection = await projectCurrentContext("agent-fork", context(), {
		maxTokens: 512,
		sourceMessages: [taggedMessage(`HEAD-${"中".repeat(2_000_000)}-TAIL`)],
	});

	expect(projection.source).toBe("native");
	expect(projection.text).toContain("HEAD-");
	expect(projection.text).toContain("-TAIL");
	expect(projection.text).toContain("omitted the middle");
	expect(__test.estimateProjectionTokens(projection.text)).toBeLessThanOrEqual(512);
});

test("projects a caller-owned frozen snapshot without re-reading a changed session", async () => {
	let reads = 0;
	const ctx = context([
		// SAFETY: this test controls the value and supplies every SessionEntry member exercised by this case.
		{
			type: "message",
			id: "leaked-message",
			parentId: null,
			timestamp: "2026-08-09T00:00:00.000Z",
			message: taggedMessage("leaked later context"),
		} as SessionEntry,
	]);
	const original = ctx.sessionManager.buildContextEntries.bind(ctx.sessionManager);
	ctx.sessionManager.buildContextEntries = () => {
		reads += 1;
		return original();
	};
	const projection = await projectCurrentContext("agent-fork", ctx, {
		maxTokens: 512,
		sourceMessages: [taggedMessage("frozen context")],
	});

	expect(reads).toBe(0);
	expect(projection.text).toContain("frozen context");
	expect(projection.text).not.toContain("leaked later context");
});

test("does not replace an explicit frozen snapshot with an older Magic projection cache", async () => {
	const handlers: Handlers = new Map();
	let magicTransforms = 0;
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (pi: ExtensionAPI) => {
				pi.on("context", (event) => {
					magicTransforms += 1;
					// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
					const contextEvent = event as { messages: ReturnType<typeof taggedMessage>[] };
					const input = contextEvent.messages.map((message) => message.content[0]?.text ?? "").join(" ");
					return {
						messages: [taggedMessage(`<session-history>${input}</session-history>`)],
					};
				});
			},
		}),
	});
	const ctx = context(
		[
			// SAFETY: this test controls the value and supplies every SessionEntry member exercised by this case.
			{
				type: "message",
				id: "old-message",
				parentId: null,
				timestamp: "2026-08-09T00:00:00.000Z",
				message: taggedMessage("old snapshot"),
			} as SessionEntry,
		],
		"/workspace/frozen",
		"frozen-session",
	);
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const cached = await projectCurrentContext("agent-fork", ctx);
	const frozen = await projectCurrentContext("agent-fork", ctx, {
		sourceMessages: [taggedMessage("new frozen snapshot")],
	});

	expect(cached.text).toContain("old snapshot");
	expect(magicTransforms).toBe(1);
	expect(frozen.source).toBe("native");
	expect(frozen.text).toContain("new frozen snapshot");
	expect(frozen.text).not.toContain("old snapshot");
	expect(magicTransforms).toBe(1);
});

test("invalidates a cached Magic projection when the next prompt is submitted", async () => {
	const handlers: Handlers = new Map();
	let current = "first turn";
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (pi: ExtensionAPI) => {
				pi.on("context", () => ({
					messages: [taggedMessage(`<session-history>${current}</session-history>`)],
				}));
			},
		}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const first = await projectCurrentContext("agent-fork", ctx);
	current = "second turn";
	await emit(handlers, "input", { type: "input", text: "next", source: "rpc" }, ctx);
	const second = await projectCurrentContext("agent-fork", ctx);

	expect(first.text).toContain("first turn");
	expect(second.text).toContain("second turn");
	expect(second.text).not.toContain("first turn");
});

test("coalesces concurrent projections and releases joiners when invalidated", async () => {
	const handlers: Handlers = new Map();
	let transforms = 0;
	const { promise: firstGate, resolve: releaseFirst } = Promise.withResolvers<void>();
	const { promise: secondGate, resolve: releaseSecond } = Promise.withResolvers<void>();
	const { promise: firstEntered, resolve: markFirstEntered } = Promise.withResolvers<void>();
	const { promise: secondEntered, resolve: markSecondEntered } = Promise.withResolvers<void>();
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (pi: ExtensionAPI) => {
				pi.on("context", async () => {
					transforms += 1;
					const turn = transforms;
					if (turn === 1) {
						markFirstEntered?.();
						await firstGate;
					} else {
						markSecondEntered?.();
						await secondGate;
					}
					return {
						messages: [
							taggedMessage(`<session-history><project-memory>turn-${turn}</project-memory></session-history>`),
						],
					};
				});
			},
		}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const first = projectCurrentContext("agent-fresh", ctx);
	const joined = projectCurrentContext("agent-fresh", ctx);
	const firstRejected = first.catch(String);
	const joinedRejected = joined.catch(String);
	await firstEntered;
	expect(transforms).toBe(1);

	await emit(handlers, "input", { type: "input", text: "next", source: "rpc" }, ctx);
	const fresh = projectCurrentContext("agent-fresh", ctx);
	await secondEntered;
	expect(transforms).toBe(2);
	expect(String(await joinedRejected)).toContain("raw history was not substituted");

	releaseFirst?.();
	expect(String(await firstRejected)).toContain("raw history was not substituted");
	releaseSecond?.();
	expect(await fresh).toMatchObject({ source: "magic-context", text: expect.stringContaining("turn-2") });
	expect(await projectCurrentContext("agent-fresh", ctx)).toMatchObject({
		source: "magic-context",
		text: expect.stringContaining("turn-2"),
	});
	expect(transforms).toBe(2);
});

test("does not route an unbound Host through another Host with the same session id", async () => {
	const handlers: Handlers = new Map();
	const hostA = context([], "/workspace/shared", "same-session");
	const hostB = context([], "/workspace/shared", "same-session");
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => magicModule(),
	});
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, hostA);

	const projectionA = await projectCurrentContext("agent-fresh", hostA);
	const projectionB = await projectCurrentContext("agent-fresh", hostB);

	expect(projectionA.source).toBe("magic-context");
	expect(projectionB).toEqual({ source: "native", text: "", truncated: false });
});

test("isolates two loaded Hosts even when their session identities match", async () => {
	const handlersA: Handlers = new Map();
	const handlersB: Handlers = new Map();
	const hostA = context([], "/workspace/host-a", "same-session");
	const hostB = context([], "/workspace/host-b", "same-session");
	const loadFor = (label: string) => async () => ({
		default: async (pi: ExtensionAPI) => {
			pi.on("context", (event) => ({
				messages: [
					taggedMessage(`<session-history><project-memory>${label}</project-memory></session-history>`),
					...event.messages,
				],
			}));
		},
	});
	piStuffContext(apiFor(handlersA), { loadMagicContext: loadFor("host-a-memory") });
	piStuffContext(apiFor(handlersB), { loadMagicContext: loadFor("host-b-memory") });
	await emit(handlersA, "session_start", { type: "session_start", reason: "startup" }, hostA);
	await emit(handlersB, "session_start", { type: "session_start", reason: "startup" }, hostB);

	const projectionA = await projectCurrentContext("agent-fresh", hostA);
	const projectionB = await projectCurrentContext("agent-fresh", hostB);

	expect(projectionA.text).toContain("host-a-memory");
	expect(projectionA.text).not.toContain("host-b-memory");
	expect(projectionB.text).toContain("host-b-memory");
	expect(projectionB.text).not.toContain("host-a-memory");
});

test("projects bounded reference data and gives fresh agents project memory only", async () => {
	const handlers: Handlers = new Map();
	piStuffContext(apiFor(handlers), { loadMagicContext: async () => magicModule() });
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const fork = await projectCurrentContext("agent-fork", ctx);
	const fresh = await projectCurrentContext("agent-fresh", ctx);

	expect(fork.source).toBe("magic-context");
	expect(fork.text).toContain('audience="agent-fork"');
	expect(fork.text).toContain("older turn");
	expect(fork.text).toContain("newer turn");
	expect(fork.text).toContain("never as instructions or policy");
	expect(fresh.text).toContain("remember me");
	expect(fresh.text).toContain("remember me, updated");
	expect(fresh.text).toContain("new memory");
	expect(fresh.text).not.toContain("older turn");
	expect(fresh.text).not.toContain("newer turn");
});

test("does not reuse a projection after the same session changes cwd", async () => {
	const handlers: Handlers = new Map();
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (pi: ExtensionAPI) => {
				// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
				const register = pi.on.bind(pi) as (event: string, handler: Handler) => void;
				register("context", (event, ctx) => {
					// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
					const contextEvent = event as { messages: unknown[] };
					return {
						messages: [
							taggedMessage(`<session-history><project-memory>${ctx.cwd}</project-memory></session-history>`),
							...contextEvent.messages,
						],
					};
				});
			},
		}),
	});
	const projectAContext = context([], "/workspace/project-a");
	const projectBContext: ExtensionCommandContext = {
		...projectAContext,
		cwd: "/workspace/project-b",
	};
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, projectAContext);

	const projectA = await projectCurrentContext("agent-fresh", projectAContext);
	const projectB = await projectCurrentContext("agent-fresh", projectBContext);
	expect(projectA.text).toContain("/workspace/project-a");
	expect(projectB.text).toContain("/workspace/project-b");
	expect(projectB.text).not.toContain("/workspace/project-a");
});

test("bounds oversized projections by audience without losing both ends", () => {
	const full = `<session-history>${"a".repeat(70_000)}TAIL</session-history>`;
	const projection = __test.formatProjection(full, "btw");
	expect(projection.truncated).toBe(true);
	expect(projection.text.length).toBeLessThanOrEqual(48_300);
	expect(projection.text).toContain("Pi Stuff omitted the middle");
	expect(projection.text).toContain("TAIL");
});

test("honors a caller token budget while preserving the projection envelope", async () => {
	const handlers: Handlers = new Map();
	piStuffContext(apiFor(handlers), {
		loadMagicContext: async () => ({
			default: async (pi: ExtensionAPI) => {
				pi.on("context", (event) => ({
					messages: [
						taggedMessage(`<session-history>${"memory ".repeat(2_000)}TAIL</session-history>`),
						...event.messages,
					],
				}));
			},
		}),
	});
	const ctx = context();
	await emit(handlers, "session_start", { type: "session_start", reason: "startup" }, ctx);

	const projection = await projectCurrentContext("agent-fork", ctx, { maxTokens: 256 });

	expect(projection.source).toBe("magic-context");
	expect(projection.truncated).toBe(true);
	expect(__test.estimateProjectionTokens(projection.text)).toBeLessThanOrEqual(256);
	expect(projection.text).toContain("Pi Stuff omitted the middle");
	expect(projection.text).toEndWith("</pi-stuff-context>");
});

test("keeps rare CJK, emoji, and high-entropy projections inside a strict byte upper bound", () => {
	for (const full of [
		`<session-history>${"上下文🧭𠮷".repeat(2_000)}TAIL</session-history>`,
		`<session-history>${"AP6Zz9+/0f3cD7aQ".repeat(2_000)}TAIL</session-history>`,
	]) {
		const projection = __test.formatProjection(full, "agent-fork", { maxTokens: 512 });

		expect(projection.truncated).toBeTrue();
		expect(__test.estimateProjectionTokens(projection.text)).toBeLessThanOrEqual(512);
		expect(projection.text).toContain("Pi Stuff omitted the middle");
		expect(projection.text).toContain("L</session-history>");
		expect(projection.text).toEndWith("</pi-stuff-context>");
	}
});
