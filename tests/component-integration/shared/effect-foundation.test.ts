import { expect, test } from "bun:test";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionEntry,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import {
	ensureUiSettingsCommand,
	getCommandDialogCoordinator,
} from "../../../packages/pi-stuff/src/conversation-ui/index.js";
import {
	completeEffectFoundationInstallation,
	EffectFoundation,
	installEffectFoundation,
} from "../../../packages/pi-stuff/src/shared/effect-foundation.js";
import piStuffTools, { getToolUiRuntime } from "../../../packages/pi-stuff/src/tool-display/index.js";
import { isRecordValue } from "../../../packages/pi-stuff/src/tool-display/tool-value.js";
import { captureExtensionHandlers, createExtensionApi } from "../../fixtures/extension-api.js";
import { createExtensionCommandContext, createExtensionContext } from "../../fixtures/extension-context.js";
import { createAssistantMessage } from "../../fixtures/faux-provider.js";

type ExtensionEventListener = Parameters<ExtensionAPI["events"]["on"]>[1];
type LifecycleEvent = SessionShutdownEvent | SessionStartEvent;
type LifecycleHandler = (event: LifecycleEvent, context: ExtensionContext) => Promise<void> | void;
type RegisteredCommand = Parameters<ExtensionAPI["registerCommand"]>[1];

class HostEventBus {
	private readonly commands = new Map<string, RegisteredCommand>();
	private readonly discovery = new Map<string, Set<ExtensionEventListener>>();
	private readonly lifecycle = new Map<string, LifecycleHandler[]>();

	facade(): ExtensionAPI {
		const discovery = this.discovery;
		const events: ExtensionAPI["events"] = {
			emit(name, value): void {
				for (const handler of discovery.get(name) ?? []) handler(value);
			},
			on(name, handler): () => void {
				const handlers = discovery.get(name) ?? new Set();
				handlers.add(handler);
				discovery.set(name, handlers);
				return () => handlers.delete(handler);
			},
		};
		return createExtensionApi({
			events,
			on: captureExtensionHandlers(this.lifecycle),
			registerCommand: (name, command) => this.commands.set(name, command),
		});
	}

	async fire(event: LifecycleEvent, context = createExtensionContext()): Promise<void> {
		for (const handler of this.lifecycle.get(event.type) ?? []) await handler(event, context);
	}

	handlerCount(type: LifecycleEvent["type"]): number {
		return this.lifecycle.get(type)?.length ?? 0;
	}

	command(name: string): RegisteredCommand | undefined {
		return this.commands.get(name);
	}
}

function contextWithPrompt(prompt: string): ExtensionContext {
	const entry: SessionEntry = {
		id: prompt,
		message: { content: prompt, role: "user", timestamp: 1 },
		parentId: null,
		timestamp: "2026-08-30T00:00:00.000Z",
		type: "message",
	};
	return createExtensionContext({ sessionManager: { getBranch: () => [entry] } });
}

test("one Host event bus shares a foundation and invalidates replaced Session work", async () => {
	const host = new HostEventBus();
	const first = installEffectFoundation(host.facade());
	const second = installEffectFoundation(host.facade());
	expect(second).toBe(first);

	await host.fire({ reason: "startup", type: "session_start" });
	const session = first.currentSession();
	expect(session).toBeDefined();
	if (!session) throw new Error("missing Session Scope");
	const capability = first.forkCapability();
	const operation = first.forkOperation(capability);

	const success = await first.run(operation, Effect.succeed("ok"));
	const failure = await first.run(operation, Effect.fail("expected"));
	const defect = await first.run(operation, Effect.die("defect"));
	expect(Exit.isSuccess(success) && success.value).toBe("ok");
	expect(Exit.hasFails(failure)).toBeTrue();
	expect(Exit.hasDies(defect)).toBeTrue();

	const running = first.run(operation, Effect.never);
	await Promise.resolve();
	await host.fire({ reason: "resume", type: "session_start" });
	expect(first.isCurrent(session)).toBeFalse();
	expect(first.currentSession()?.generation).toBe(session.generation + 1);
	expect(Exit.hasInterrupts(await running)).toBeTrue();

	await host.fire({ reason: "quit", type: "session_shutdown" });
});

test("one Host event bus shares and hands off Session-owned Tool UI resources", async () => {
	const host = new HostEventBus();
	const owner = host.facade();
	const duplicate = host.facade();
	const foundation = installEffectFoundation(owner);
	await piStuffTools(owner);
	const startHandlers = host.handlerCount("session_start");
	await piStuffTools(duplicate);

	expect(installEffectFoundation(duplicate)).toBe(foundation);
	const runtime = getToolUiRuntime(owner);
	expect(getToolUiRuntime(duplicate)).toBe(runtime);
	expect(host.handlerCount("session_start")).toBe(startHandlers);
	const settings = ensureUiSettingsCommand(owner);
	expect(settings.list().map(({ id }) => id)).toEqual([]);

	await host.fire({ reason: "startup", type: "session_start" });
	const first = settings.list()[0];
	expect(first?.id).toBe("toolRunningTimer");
	const projections: (readonly unknown[])[] = [];
	const resetProjection = runtime.resetProjection.bind(runtime);
	runtime.resetProjection = (messages) => {
		projections.push(messages);
		resetProjection(messages);
	};
	const release = Promise.withResolvers<void>();
	await foundation.run(
		foundation.forkOperation(),
		Effect.addFinalizer(() => Effect.promise(() => release.promise)),
	);
	const supersededContext = contextWithPrompt("superseded");
	const currentContext = contextWithPrompt("current");
	const supersededStart = host.fire({ reason: "resume", type: "session_start" }, supersededContext);
	await host.fire({ reason: "resume", type: "session_start" }, currentContext);
	release.resolve();
	await supersededStart;
	const replacement = settings.list()[0];
	expect(replacement?.id).toBe("toolRunningTimer");
	expect(replacement).not.toBe(first);
	const superseded = foundation.sessionFor(supersededContext.sessionManager);
	const current = foundation.sessionFor(currentContext.sessionManager);
	expect(superseded && foundation.isCurrent(superseded)).toBeFalse();
	expect(current && foundation.isCurrent(current)).toBeTrue();
	expect(projections.at(-1)?.[0]).toMatchObject({ content: "current", role: "user" });

	await host.fire({ reason: "quit", type: "session_shutdown" });
	expect(settings.list()).toEqual([]);
	await host.fire({ reason: "quit", type: "session_shutdown" });
	expect(settings.list()).toEqual([]);
});

test("/tools rejects public IDs and refreshes one newest bounded history page before opening", async () => {
	const host = new HostEventBus();
	const pi = host.facade();
	await piStuffTools(pi);
	const command = host.command("tools");
	if (!command) throw new Error("missing /tools command");
	const entries = Array.from(
		{ length: 65 },
		(_, index): SessionEntry => ({
			id: `history-${String(index)}`,
			message: { content: `history-${String(index)}`, role: "user", timestamp: index },
			parentId: index > 0 ? `history-${String(index - 1)}` : null,
			timestamp: "2026-09-03T00:00:00.000Z",
			type: "message",
		}),
	);
	const notifications: string[] = [];
	const context = createExtensionCommandContext({
		sessionManager: { getBranch: () => entries },
		ui: { notify: (message) => notifications.push(message) },
	});
	const runtime = getToolUiRuntime(pi);
	const originalReset = runtime.resetProjection.bind(runtime);
	const projections: (readonly unknown[])[] = [];
	const order: string[] = [];
	runtime.resetProjection = (messages) => {
		order.push("reset");
		projections.push(messages);
		originalReset(messages);
	};
	const coordinator = getCommandDialogCoordinator(pi);
	Reflect.defineProperty(coordinator, "show", {
		configurable: true,
		value: async () => {
			order.push(runtime.hasOlderHistory() ? "show-with-older" : "show");
		},
	});
	try {
		await command.handler("history-64", context);
		expect(notifications).toEqual(["/tools does not accept arguments."]);
		expect(order).toEqual([]);

		await command.handler("", context);
		expect(order).toEqual(["reset", "show-with-older"]);
		const projected = JSON.stringify(projections[0]);
		expect(projected).not.toContain("history-0");
		expect(projected).toContain("history-1");
		expect(projected).toContain("history-64");
	} finally {
		runtime.resetProjection = originalReset;
		Reflect.deleteProperty(coordinator, "show");
	}
});

test("/tools pages an oversized assistant message without losing its oldest Tool calls", async () => {
	const host = new HostEventBus();
	const pi = host.facade();
	await piStuffTools(pi);
	const command = host.command("tools");
	if (!command) throw new Error("missing /tools command");
	const content = Array.from({ length: 300 }, (_, index) => ({
		arguments: { path: `${String(index)}.ts` },
		id: `read-${String(index)}`,
		name: "read",
		type: "toolCall" as const,
	}));
	const entry: SessionEntry = {
		id: "oversized-assistant",
		message: createAssistantMessage("fixture", "fixture-model")(content, "toolUse"),
		parentId: null,
		timestamp: "2026-09-03T00:00:00.000Z",
		type: "message",
	};
	const context = createExtensionCommandContext({ sessionManager: { getBranch: () => [entry] } });
	const runtime = getToolUiRuntime(pi);
	const projections: (readonly unknown[])[] = [];
	const originalReset = runtime.resetProjection;
	runtime.resetProjection = (messages) => {
		projections.push(messages);
		originalReset.call(runtime, messages);
	};
	const coordinator = getCommandDialogCoordinator(pi);
	Reflect.defineProperty(coordinator, "show", { configurable: true, value: async () => undefined });
	try {
		await command.handler("", context);
		const newest = projections[0]?.[0];
		expect(newest).toMatchObject({ role: "assistant" });
		if (!isRecordValue(newest) || !Array.isArray(newest.content)) {
			throw new Error("missing newest Tool history page");
		}
		expect(newest.content).toHaveLength(256);
		expect(newest.content[0]).toMatchObject({ id: "read-44" });
		expect(newest.content.at(-1)).toMatchObject({ id: "read-299" });
		expect(runtime.hasOlderHistory()).toBeTrue();

		const olderIds = runtime.loadOlderActivities().flatMap((group) => group.memberIds);
		expect(olderIds).toContain("read-0");
		expect(olderIds).toContain("read-43");
		expect(runtime.hasOlderHistory()).toBeFalse();
	} finally {
		runtime.resetProjection = originalReset;
		Reflect.deleteProperty(coordinator, "show");
	}
});

test("the newest concurrent Session start remains current", async () => {
	const foundation = new EffectFoundation();
	await foundation.startSession();
	const release = Promise.withResolvers<void>();
	await foundation.run(
		foundation.forkOperation(),
		Effect.addFinalizer(() => Effect.promise(() => release.promise)),
	);

	const supersededStart = foundation.startSession();
	const newest = await foundation.startSession();
	expect(foundation.currentSession()).toBe(newest);
	expect(foundation.isCurrent(newest)).toBeTrue();

	release.resolve();
	const superseded = await supersededStart;
	expect(foundation.isCurrent(superseded)).toBeFalse();
	await foundation.shutdown();
});

test("owned Scope finalizers run once and Host shutdown stays bounded", async () => {
	const foundation = new EffectFoundation(5);
	await foundation.startSession();
	const capability = foundation.forkCapability();
	let releases = 0;
	const acquired = await foundation.run(
		capability,
		Effect.acquireRelease(Effect.succeed("resource"), () => Effect.sync(() => releases++)),
	);
	expect(Exit.isSuccess(acquired) && acquired.value).toBe("resource");
	expect(releases).toBe(0);
	expect(await foundation.close(capability)).toBeTrue();
	expect(await foundation.close(capability)).toBeTrue();
	expect(releases).toBe(1);

	const operation = foundation.forkOperation();
	await foundation.run(
		operation,
		Effect.addFinalizer(() => Effect.never),
	);
	const shutdown = await Promise.race([foundation.shutdown(), Bun.sleep(250).then(() => "hung" as const)]);
	expect(shutdown).toBeFalse();
});

test("Suite shutdown lets Capability protocols finish before Scope finalizers", async () => {
	const host = new HostEventBus();
	const pi = host.facade();
	const foundation = installEffectFoundation(pi, { deferShutdown: true });
	const context = createExtensionContext();
	await host.fire({ reason: "startup", type: "session_start" }, context);
	const order: string[] = [];
	await foundation.run(
		foundation.forkCapability(),
		Effect.addFinalizer(() => Effect.sync(() => order.push("scope-finalizer"))),
	);
	pi.on("session_shutdown", () => {
		order.push("capability-protocol");
	});
	completeEffectFoundationInstallation(pi);

	await host.fire({ reason: "quit", type: "session_shutdown" }, context);
	expect(order).toEqual(["capability-protocol", "scope-finalizer"]);
});

test("one hung operation cannot block a sibling Capability release", async () => {
	const foundation = new EffectFoundation(5);
	await foundation.startSession();
	let releases = 0;
	await foundation.run(
		foundation.forkCapability(),
		Effect.acquireRelease(Effect.void, () => Effect.sync(() => releases++)),
	);
	await foundation.run(
		foundation.forkOperation(),
		Effect.addFinalizer(() => Effect.never),
	);

	await foundation.startSession();
	expect(releases).toBe(1);
	await foundation.shutdown();
});
