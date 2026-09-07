import { expect, test } from "bun:test";
import {
	type CommandDialogView,
	type CommandDialogViewContext,
	commandDialogHarness,
	createApiHarness,
	createContext,
	createView,
	drainMicrotasks,
	getCommandDialogCoordinator,
	installedCommandDialogHarness,
	TestComponent,
	UiHarness,
} from "../../ui/command-dialog-coordinator-fixtures.js";

test("does not mount a view twice when its factory synchronously queues a blocker", async () => {
	const { coordinator, ctx, ui } = commandDialogHarness();
	const normal = new TestComponent("normal");
	const blocker = new TestComponent("blocker");
	let normalContext: CommandDialogViewContext | undefined;
	let blockerContext: CommandDialogViewContext | undefined;
	let blockerPromise: Promise<unknown> | undefined;
	let normalCreateCalls = 0;
	let blockerCreateCalls = 0;

	const normalPromise = coordinator.show(ctx, {
		priority: "normal",
		create: (context) => {
			normalCreateCalls += 1;
			normalContext = context;
			blockerPromise = coordinator.show(ctx, {
				priority: "blocking",
				create: (blockingContext) => {
					blockerCreateCalls += 1;
					blockerContext = blockingContext;
					return blocker;
				},
			});
			return normal;
		},
	});

	expect(normalCreateCalls).toBe(1);
	expect(blockerCreateCalls).toBe(1);
	expect(ui.currentHost.render(80)).toEqual(["blocker"]);
	if (!blockerContext || !blockerPromise) throw new Error("Expected the synchronous blocker to mount");
	blockerContext.close();
	await blockerPromise;
	expect(ui.currentHost.render(80)).toEqual(["normal"]);
	if (!normalContext) throw new Error("Expected the normal view to mount");
	normalContext.close();
	await normalPromise;
	expect(normal.disposeCalls).toBe(1);
	expect(blocker.disposeCalls).toBe(1);
});

test("preempts a normal view with FIFO blockers, then resumes the same component", async () => {
	const { coordinator, ctx, ui } = await installedCommandDialogHarness();
	const normalFooter = ui.footerWrites.at(-1);
	if (!normalFooter) throw new Error("Expected the normal Suite footer");
	const components = new Map<string, TestComponent>();
	const contexts = new Map<string, CommandDialogViewContext<string>>();

	const normalPromise = coordinator.show(ctx, createView("normal", "normal", components, contexts));
	const firstBlockingPromise = coordinator.show(ctx, createView("blocking-1", "blocking", components, contexts));
	const secondBlockingPromise = coordinator.show(ctx, createView("blocking-2", "blocking", components, contexts));

	expect(ui.hostCalls).toHaveLength(1);
	expect(ui.footerWrites).toHaveLength(2);
	expect(ui.currentHost.render(80)).toEqual(["blocking-1"]);
	const normalContext = contexts.get("normal");
	const firstContext = contexts.get("blocking-1");
	const secondContext = contexts.get("blocking-2");
	if (!normalContext || !firstContext || !secondContext) throw new Error("Expected every queued view to mount");
	expect(new Set([normalContext.signal, firstContext.signal, secondContext.signal]).size).toBe(3);
	expect(normalContext.signal.aborted).toBe(false);
	expect(components.get("normal")?.disposeCalls).toBe(0);

	firstContext.close("first");
	expect(await firstBlockingPromise).toBe("first");
	expect(ui.currentHost.render(80)).toEqual(["blocking-2"]);
	firstContext.close("late first");
	expect(ui.currentHost.render(80)).toEqual(["blocking-2"]);
	expect(secondContext.signal.aborted).toBe(false);

	secondContext.close("second");
	expect(await secondBlockingPromise).toBe("second");
	expect(ui.currentHost.render(80)).toEqual(["normal"]);
	expect(normalContext.signal.aborted).toBe(false);
	expect(components.get("normal")?.disposeCalls).toBe(0);
	ui.currentHost.handleInput?.("n");
	expect(components.get("normal")?.input).toEqual(["n"]);
	expect(ui.renderRequests).not.toContain(true);

	normalContext.close("normal result");
	expect(await normalPromise).toBe("normal result");
	await drainMicrotasks();
	expect(ui.hostCalls).toHaveLength(1);
	expect(normalContext.signal.aborted).toBe(true);
	expect(components.get("normal")?.disposeCalls).toBe(1);
	expect(ui.footerWrites.at(-1)).toBe(normalFooter);
});

test("reports idle only after a preempted view closes and all shared chrome is restored", async () => {
	const api = createApiHarness();
	const coordinator = getCommandDialogCoordinator(api.api);
	const ui = new UiHarness();
	ui.autoResolveOnDone = false;
	ui.editorText = "draft before dialog";
	const ctx = createContext(ui);
	const components = new Map<string, TestComponent>();
	const contexts = new Map<string, CommandDialogViewContext<string>>();
	const todoWrites: boolean[] = [];
	const agentWrites: boolean[] = [];
	coordinator.registerChrome("todo", {
		setSuppressed: (suppressed) => todoWrites.push(suppressed),
	});
	coordinator.registerChrome("agents", {
		setSuppressed: (suppressed) => agentWrites.push(suppressed),
	});

	const normal = coordinator.show(ctx, createView("btw", "normal", components, contexts));
	const blocker = coordinator.show(ctx, createView("permission", "blocking", components, contexts));
	let idleSettled = false;
	const idle = coordinator.whenIdle().then(() => {
		idleSettled = true;
	});

	expect(ui.currentHost.render(80)).toEqual(["permission"]);
	expect(todoWrites).toEqual([true]);
	expect(agentWrites).toEqual([true]);
	expect(ui.editorText).toBe("");
	const normalComponent = components.get("btw");
	const blockingContext = contexts.get("permission");
	if (!normalComponent || !blockingContext) throw new Error("Expected both views to mount");

	blockingContext.close("denied");
	expect(await blocker).toBe("denied");
	expect(ui.currentHost.render(80)).toEqual(["btw"]);
	expect(components.get("btw")).toBe(normalComponent);
	await drainMicrotasks();
	expect(idleSettled).toBe(false);

	const normalContext = contexts.get("btw");
	if (!normalContext) throw new Error("Expected the normal view to resume");
	normalContext.close("dismissed");
	await drainMicrotasks();
	expect(idleSettled).toBe(false);
	expect(ui.editorText).toBe("");
	expect(todoWrites).toEqual([true]);
	expect(agentWrites).toEqual([true]);

	ui.settleCurrentDone();
	expect(await normal).toBe("dismissed");
	await idle;
	expect(idleSettled).toBe(true);
	expect(ui.editorText).toBe("draft before dialog");
	expect(todoWrites).toEqual([true, false]);
	expect(agentWrites).toEqual([true, false]);
});

test("session shutdown aborts and dismisses every view before restoring UI", async () => {
	const { api, coordinator, ctx, ui } = await installedCommandDialogHarness();
	const normalFooter = ui.footerWrites.at(-1);
	if (!normalFooter) throw new Error("Expected the normal Suite footer");
	const components = new Map<string, TestComponent>();
	const contexts = new Map<string, CommandDialogViewContext<string>>();
	const chromeWrites: boolean[] = [];
	coordinator.registerChrome("roster", {
		setSuppressed: (suppressed) => chromeWrites.push(suppressed),
	});

	const normalPromise = coordinator.show(ctx, createView("normal", "normal", components, contexts));
	const blockingPromise = coordinator.show(ctx, createView("blocking", "blocking", components, contexts));
	const queuedPromise = coordinator.show(ctx, createView("queued", "blocking", components, contexts));
	await api.shutdown(ctx);

	expect(await Promise.all([normalPromise, blockingPromise, queuedPromise])).toEqual([
		undefined,
		undefined,
		undefined,
	]);
	for (const context of contexts.values()) expect(context.signal.aborted).toBe(true);
	for (const component of components.values()) expect(component.disposeCalls).toBe(1);
	expect(ui.hostCalls[0]?.doneCalls).toBe(1);
	expect(ui.editorText).toBe("saved draft");
	expect(normalFooter).toBeTypeOf("function");
	expect(ui.footerWrites.at(-1)).toBeUndefined();
	expect(ui.workingWrites).toEqual([false, true]);
	expect(chromeWrites).toEqual([true, false]);

	contexts.get("blocking")?.close("late");
	expect(ui.hostCalls[0]?.doneCalls).toBe(1);
});

test("restores the exact Suite footer after a custom Host failure", async () => {
	const { coordinator, ctx, ui } = await installedCommandDialogHarness();
	const normalFooter = ui.footerWrites.at(-1);
	if (!normalFooter) throw new Error("Expected the normal Suite footer");

	const failed = coordinator.show(ctx, {
		priority: "normal",
		create: () => new TestComponent("failed host"),
	});
	ui.rejectCurrent(new Error("custom failed"));

	await expect(failed).rejects.toThrow("custom failed");
	expect(ui.footerWrites.at(-1)).toBe(normalFooter);
	expect(ui.workingWrites).toEqual([false, true]);
});

test("does not reopen a deferred or late view after shutdown begins", async () => {
	const api = createApiHarness();
	const coordinator = getCommandDialogCoordinator(api.api);
	const ui = new UiHarness();
	ui.autoResolveOnDone = false;
	const ctx = createContext(ui);
	const components = new Map<string, TestComponent>();
	const contexts = new Map<string, CommandDialogViewContext<void>>();
	const first = coordinator.show(ctx, createView("first", "normal", components, contexts));

	const shutdown = api.shutdown(ctx);
	await drainMicrotasks();
	const late = coordinator.show(ctx, createView("late", "normal", components, contexts));
	expect(await late).toBeUndefined();
	expect(components.has("late")).toBe(false);
	expect(ui.hostCalls).toHaveLength(1);

	ui.settleCurrentDone();
	await shutdown;
	expect(await first).toBeUndefined();
	await drainMicrotasks();
	expect(ui.hostCalls).toHaveLength(1);

	const reloaded = createApiHarness(api.api.events);
	const reloadedCoordinator = getCommandDialogCoordinator(reloaded.api);
	expect(reloadedCoordinator).not.toBe(coordinator);
	const reloadedUi = new UiHarness();
	let reloadedContext: CommandDialogViewContext | undefined;
	const reopened = reloadedCoordinator.show(createContext(reloadedUi), {
		priority: "normal",
		create: (context) => {
			reloadedContext = context;
			return new TestComponent("standalone reload");
		},
	});
	if (!reloadedContext) throw new Error("Expected a standalone reload view");
	reloadedContext.close();
	await reopened;
});

test("preserves show order across host cleanup and final-view continuations", async () => {
	const api = createApiHarness();
	const coordinator = getCommandDialogCoordinator(api.api);
	const ui = new UiHarness();
	ui.autoResolveOnDone = false;
	const ctx = createContext(ui);
	const createOrder: string[] = [];
	const contexts = new Map<string, CommandDialogViewContext>();
	const view = (label: string): CommandDialogView => ({
		priority: "normal",
		create: (context) => {
			createOrder.push(label);
			contexts.set(label, context);
			return new TestComponent(label);
		},
	});

	const first = coordinator.show(ctx, view("A"));
	let third: Promise<unknown> | undefined;
	const continued = first.then(() => {
		third = coordinator.show(ctx, view("C"));
		return third;
	});
	const firstContext = contexts.get("A");
	if (!firstContext) throw new Error("Expected A to mount");
	firstContext.close();
	const second = coordinator.show(ctx, view("B"));

	ui.settleCurrentDone();
	await drainMicrotasks();
	expect(createOrder).toEqual(["A", "B", "C"]);
	expect(ui.currentHost.render(80)).toEqual(["B"]);

	const secondContext = contexts.get("B");
	if (!secondContext) throw new Error("Expected B to mount");
	secondContext.close();
	await second;
	expect(ui.currentHost.render(80)).toEqual(["C"]);
	const thirdContext = contexts.get("C");
	if (!thirdContext || !third) throw new Error("Expected C to mount");
	ui.autoResolveOnDone = true;
	thirdContext.close();
	await continued;
});

test("runs every restoration after host failure and starts a new host only after prior cleanup", async () => {
	const { coordinator, ctx, ui } = commandDialogHarness();
	const chromeWrites: boolean[] = [];
	coordinator.registerChrome("throwing", {
		setSuppressed: (suppressed) => {
			chromeWrites.push(suppressed);
			if (!suppressed) throw new Error("chrome restore failed");
		},
	});
	ui.throwOnFooterRestore = true;
	const failed = coordinator.show(ctx, {
		priority: "normal",
		create: () => new TestComponent("failed host"),
	});
	ui.rejectCurrent(new Error("custom failed"));

	await expect(failed).rejects.toThrow("custom failed");
	await drainMicrotasks();
	expect(ui.workingWrites).toEqual([false, true]);
	expect(ui.editorWrites).toEqual(["", "saved draft"]);
	expect(chromeWrites).toEqual([true, false]);

	ui.throwOnFooterRestore = false;
	ui.autoResolveOnDone = false;
	let firstContext: CommandDialogViewContext | undefined;
	const first = coordinator.show(ctx, {
		priority: "normal",
		create: (context) => {
			firstContext = context;
			return new TestComponent("first");
		},
	});
	if (!firstContext) throw new Error("Expected first view context");
	firstContext.close();
	let secondContext: CommandDialogViewContext | undefined;
	const second = coordinator.show(ctx, {
		priority: "normal",
		create: (context) => {
			secondContext = context;
			return new TestComponent("second");
		},
	});
	expect(ui.hostCalls).toHaveLength(2);
	expect(secondContext).toBeUndefined();

	ui.settleCurrentDone();
	await first;
	await drainMicrotasks();
	expect(ui.hostCalls).toHaveLength(3);
	if (!secondContext) throw new Error("Expected second view context after cleanup");
	ui.autoResolveOnDone = true;
	secondContext.close();
	await second;
});
