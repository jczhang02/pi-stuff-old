import { expect, test } from "bun:test";
import {
	type CommandDialogComponent,
	type CommandDialogViewContext,
	commandDialogHarness,
	createApiHarness,
	createContext,
	drainMicrotasks,
	EventBusHarness,
	type ExtensionContext,
	ensureUiSettingsCommand,
	eventBusView,
	FocusableTestComponent,
	type FooterFactory,
	getCommandDialogCoordinator,
	installedCommandDialogHarness,
	piStuffUi,
	TestComponent,
	UiHarness,
} from "../../ui/command-dialog-coordinator-fixtures.js";

test("shares and restores the Suite footer across real per-extension event API wrappers", async () => {
	const bus = new EventBusHarness();
	const suite = createApiHarness(eventBusView(bus));
	const independentExtension = createApiHarness(eventBusView(bus));
	await piStuffUi(suite.api);
	const suiteCoordinator = getCommandDialogCoordinator(suite.api);
	const externalCoordinator = getCommandDialogCoordinator(independentExtension.api);
	const ui = new UiHarness();
	const ctx = createContext(ui);
	await suite.start(ctx);
	const normalFooter = ui.footerWrites.at(-1);
	if (!normalFooter) throw new Error("Expected the normal Suite footer");

	expect(externalCoordinator).toBe(suiteCoordinator);
	let viewContext: CommandDialogViewContext | undefined;
	const shown = externalCoordinator.show(ctx, {
		priority: "normal",
		create: (context) => {
			viewContext = context;
			return new TestComponent("independent extension");
		},
	});
	if (!viewContext) throw new Error("Expected the independent extension dialog to mount");
	viewContext.close();
	await shown;

	expect(ui.footerWrites.at(-1)).toBe(normalFooter);
});

test("is a WeakMap singleton for one Extension event bus and ignores non-TUI contexts", async () => {
	const events = new EventBusHarness();
	const first = createApiHarness(events);
	const second = createApiHarness(events);
	const other = createApiHarness(new EventBusHarness());
	const coordinator = getCommandDialogCoordinator(first.api);

	expect(getCommandDialogCoordinator(second.api)).toBe(coordinator);
	expect(getCommandDialogCoordinator(other.api)).not.toBe(coordinator);
	const firstCoordinatorHandlerCount = first.shutdownHandlers.length;
	const secondCoordinatorHandlerCount = second.shutdownHandlers.length;
	expect(firstCoordinatorHandlerCount).toBeGreaterThan(0);
	expect(secondCoordinatorHandlerCount).toBeGreaterThan(0);
	await piStuffUi(first.api);
	const installedHandlerCount = first.shutdownHandlers.length;
	expect(installedHandlerCount).toBeGreaterThan(firstCoordinatorHandlerCount);
	await piStuffUi(first.api);
	expect(first.shutdownHandlers).toHaveLength(installedHandlerCount);

	const ui = new UiHarness();
	const result = await coordinator.show(createContext(ui, "rpc"), {
		priority: "normal",
		create: () => new TestComponent("never mounted"),
	});
	expect(result).toBeUndefined();
	expect(ui.hostCalls).toHaveLength(0);
});

test("starts a reload generation with fresh chrome and a newly bound shutdown lifecycle", async () => {
	const events = new EventBusHarness();
	const first = createApiHarness(events);
	await piStuffUi(first.api);
	const coordinator = getCommandDialogCoordinator(first.api);
	const oldChromeWrites: boolean[] = [];
	const unregisterOld = coordinator.registerChrome("todo", {
		setSuppressed: (suppressed) => oldChromeWrites.push(suppressed),
	});
	await first.shutdown(createContext(new UiHarness()));

	const reloaded = createApiHarness(events);
	await piStuffUi(reloaded.api);
	const reloadedCoordinator = getCommandDialogCoordinator(reloaded.api);
	expect(reloadedCoordinator).not.toBe(coordinator);
	const newChromeWrites: boolean[] = [];
	reloadedCoordinator.registerChrome("todo", {
		setSuppressed: (suppressed) => newChromeWrites.push(suppressed),
	});
	unregisterOld();

	const ui = new UiHarness();
	let viewContext: CommandDialogViewContext | undefined;
	const shown = reloadedCoordinator.show(createContext(ui), {
		priority: "normal",
		create: (context) => {
			viewContext = context;
			return new TestComponent("reloaded");
		},
	});
	expect(oldChromeWrites).toEqual([]);
	expect(newChromeWrites).toEqual([true]);
	if (!viewContext) throw new Error("Expected reloaded view context");
	viewContext.close();
	await shown;
	await drainMicrotasks();
	expect(newChromeWrites).toEqual([true, false]);
});

test("shares one /ui registry across distinct Package APIs in one Host generation", async () => {
	const events = new EventBusHarness();
	const toolsApi = createApiHarness(eventBusView(events));
	const uiApi = createApiHarness(eventBusView(events));
	const toolsRegistry = ensureUiSettingsCommand(toolsApi.api);
	toolsRegistry.register({
		description: "Timer",
		get: () => "true",
		id: "toolRunningTimer",
		label: "Tool running timer",
		order: 50,
		set: async () => {},
		subscribe: () => () => {},
		values: ["true", "false"],
	});
	const uiRegistry = ensureUiSettingsCommand(uiApi.api);
	uiRegistry.register({
		description: "Statusline",
		get: () => "true",
		id: "statusline",
		label: "Statusline",
		order: 10,
		set: async () => {},
		subscribe: () => () => {},
		values: ["true", "false"],
	});

	expect(uiRegistry).toBe(toolsRegistry);
	expect(uiRegistry.list().map((setting) => setting.id)).toEqual(["statusline", "toolRunningTimer"]);
	expect(toolsApi.registeredCommands).toEqual(["ui"]);
	expect(uiApi.registeredCommands).toEqual([]);
});

test("owns one non-overlay host and restores the draft, footer, working row, and chrome", async () => {
	const { coordinator, ctx, ui } = await installedCommandDialogHarness();
	const normalFooter = ui.footerWrites.at(-1);
	if (!normalFooter) throw new Error("Expected the normal Suite footer");
	const chromeWrites: boolean[] = [];
	const unregister = coordinator.registerChrome("todo", {
		setSuppressed: (suppressed) => chromeWrites.push(suppressed),
	});
	let viewContext: CommandDialogViewContext<string> | undefined;
	const component = new TestComponent("normal");

	const resultPromise = coordinator.show<string>(ctx, {
		priority: "normal",
		create: (context) => {
			viewContext = context;
			return component;
		},
	});

	expect(ui.hostCalls).toHaveLength(1);
	expect(ui.hostCalls[0]?.options).toEqual({ overlay: false });
	expect(ui.editorWrites).toEqual([""]);
	expect(ui.workingWrites).toEqual([false]);
	expect(chromeWrites).toEqual([true]);
	const footerFactory = ui.footerWrites[1];
	expect(footerFactory).toBeTypeOf("function");
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	expect(footerFactory?.(ui.tui, ui.theme, {} as never).render(80)).toEqual([]);
	expect(ui.currentHost.render(80)).toEqual(["normal"]);
	expect(ui.renderRequests).toEqual([undefined]);

	const mountedContext = viewContext;
	if (!mountedContext) throw new Error("Expected the normal view to mount");
	expect(mountedContext.tui).toBe(ui.tui);
	expect(mountedContext.theme).toBe(ui.theme);
	expect(mountedContext.keybindings).toBe(ui.keybindings);
	mountedContext.requestRender(true);
	expect(ui.renderRequests.at(-1)).toBe(true);
	mountedContext.close("accepted");
	expect(await resultPromise).toBe("accepted");
	await drainMicrotasks();

	expect(mountedContext.signal.aborted).toBe(true);
	expect(component.disposeCalls).toBe(1);
	expect(ui.hostCalls[0]?.doneCalls).toBe(1);
	expect(ui.footerWrites.at(-1)).toBe(normalFooter);
	expect(ui.workingWrites).toEqual([false, true]);
	expect(ui.editorWrites).toEqual(["", "saved draft"]);
	expect(chromeWrites).toEqual([true, false]);
	expect(ui.forbiddenCalls).toEqual([]);

	mountedContext.close("late");
	expect(ui.hostCalls[0]?.doneCalls).toBe(1);
	unregister();
});

test("keeps shared chrome adapter registrations independent", async () => {
	const { coordinator, ctx } = commandDialogHarness();
	const writes: boolean[] = [];
	const chrome = { setSuppressed: (suppressed: boolean) => writes.push(suppressed) };
	const unregisterTodo = coordinator.registerChrome("todo", chrome);
	const unregisterAgents = coordinator.registerChrome("agents", chrome);
	let viewContext: CommandDialogViewContext | undefined;
	const shown = coordinator.show(ctx, {
		priority: "normal",
		create: (context) => {
			viewContext = context;
			return new TestComponent("shared chrome");
		},
	});

	expect(writes).toEqual([true, true]);
	unregisterTodo();
	unregisterAgents();
	expect(writes).toEqual([true, true, false, false]);
	if (!viewContext) throw new Error("Expected the command dialog to mount");
	viewContext.close();
	await shown;
});

test("does not restore an already submitted slash command when the caller opts out", async () => {
	const api = createApiHarness();
	await piStuffUi(api.api);
	const coordinator = getCommandDialogCoordinator(api.api);
	const ui = new UiHarness();
	ui.editorText = "/ctx";
	const ctx = createContext(ui);
	await api.start(ctx);
	let viewContext: CommandDialogViewContext | undefined;

	const shown = coordinator.show(
		ctx,
		{
			priority: "normal",
			create: (context) => {
				viewContext = context;
				return new TestComponent("command dialog");
			},
		},
		{ restoreDraft: false },
	);
	if (!viewContext) throw new Error("Expected the command dialog to mount");
	viewContext.close();
	await shown;

	expect(ui.editorText).toBe("");
	expect(ui.editorWrites).toEqual([""]);
});

test("forwards host focus to the active dialog component", async () => {
	const { coordinator, ctx, ui } = await installedCommandDialogHarness();
	let viewContext: CommandDialogViewContext | undefined;
	const component = new FocusableTestComponent("input dialog");

	const shown = coordinator.show(ctx, {
		priority: "normal",
		create: (context) => {
			viewContext = context;
			return component;
		},
	});
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const host = ui.currentHost as CommandDialogComponent & { focused: boolean };
	host.focused = true;
	expect(component.focused).toBeTrue();
	host.focused = false;
	expect(component.focused).toBeFalse();

	if (!viewContext) throw new Error("Expected the dialog to mount");
	viewContext.close();
	await shown;
});

test("restores the Suite-owned working visibility that preceded the dialog", async () => {
	const { coordinator, ctx, ui } = await installedCommandDialogHarness();
	coordinator.setWorkingVisible(ctx, false);
	let viewContext: CommandDialogViewContext | undefined;

	const shown = coordinator.show(ctx, {
		priority: "normal",
		create: (context) => {
			viewContext = context;
			return new TestComponent("normal");
		},
	});
	if (!viewContext) throw new Error("Expected the dialog to mount");
	viewContext.close();
	await shown;

	expect(ui.workingWrites.at(-1)).toBe(false);
});

test("restores footer and working updates made while the dialog owns Pi UI", async () => {
	const { coordinator, ctx, ui } = await installedCommandDialogHarness();
	const initialFooter = ui.footerWrites.at(-1);
	if (!initialFooter) throw new Error("Expected the initial Suite footer");
	let viewContext: CommandDialogViewContext | undefined;
	const shown = coordinator.show(ctx, {
		priority: "normal",
		create: (context) => {
			viewContext = context;
			return new TestComponent("normal");
		},
	});
	if (!viewContext) throw new Error("Expected the dialog to mount");
	const writesWhileOwned = ui.footerWrites.length;
	const updatedFooter: FooterFactory = () => new TestComponent("updated footer");

	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	(
		coordinator as typeof coordinator & {
			installFooter(context: ExtensionContext, factory: NonNullable<FooterFactory>): void;
		}
	).installFooter(ctx, updatedFooter);
	coordinator.setWorkingVisible(ctx, false);

	expect(ui.footerWrites).toHaveLength(writesWhileOwned);
	viewContext.close();
	await shown;

	const restoredFooter = ui.footerWrites.at(-1);
	expect(restoredFooter).not.toBe(initialFooter);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	expect(restoredFooter?.(ui.tui, ui.theme, {} as never).render(80)).toEqual(["updated footer"]);
	expect(ui.workingWrites).toEqual([false, false]);
});

test("restores the Suite footer when Pi supplies a fresh UI context wrapper", async () => {
	const api = createApiHarness();
	await piStuffUi(api.api);
	const coordinator = getCommandDialogCoordinator(api.api);
	const ui = new UiHarness();
	const startupContext = createContext(ui);
	await api.start(startupContext);
	const normalFooter = ui.footerWrites.at(-1);
	if (!normalFooter) throw new Error("Expected the normal Suite footer");
	// SAFETY: this test fixture implements the exact Host surface exercised by this case.
	const commandContext = {
		...startupContext,
		ui: new Proxy(startupContext.ui, {}),
	} as ExtensionContext;
	let viewContext: CommandDialogViewContext | undefined;

	const shown = coordinator.show(commandContext, {
		priority: "normal",
		create: (context) => {
			viewContext = context;
			return new TestComponent("normal");
		},
	});
	if (!viewContext) throw new Error("Expected the dialog to mount");
	viewContext.close();
	await shown;

	expect(ui.footerWrites.at(-1)).toBe(normalFooter);
});

test("settles the final view only after host chrome and the saved draft are restored", async () => {
	const api = createApiHarness();
	const coordinator = getCommandDialogCoordinator(api.api);
	const ui = new UiHarness();
	let viewContext: CommandDialogViewContext | undefined;
	const shown = coordinator.show(createContext(ui), {
		priority: "normal",
		create: (context) => {
			viewContext = context;
			return new TestComponent("normal");
		},
	});
	const continued = shown.then(() => ui.setEditorText("next draft"));

	if (!viewContext) throw new Error("Expected the normal view to mount");
	viewContext.close();
	await continued;

	expect(ui.editorText).toBe("next draft");
	expect(ui.editorWrites).toEqual(["", "saved draft", "next draft"]);
	expect(ui.footerWrites.at(-1)).toBeUndefined();
	expect(ui.workingWrites).toEqual([false, true]);
});
