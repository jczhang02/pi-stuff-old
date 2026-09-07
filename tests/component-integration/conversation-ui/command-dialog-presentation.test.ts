import { expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import {
	createApiHarness,
	createContext,
	createDeferred,
	createFooterData,
	DiagnosticChannel,
	drainMicrotasks,
	EventBusHarness,
	type ExtensionContext,
	eventBusView,
	type FooterFactory,
	getCodexStatusChannel,
	getCommandDialogCoordinator,
	getGoalStatusChannel,
	homedir,
	installUiSessionPresentation,
	join,
	piStuffCodex,
	piStuffUi,
	settleAgentRun,
	UiHarness,
	UiSettingsStore,
	waitUntil,
} from "../../ui/command-dialog-coordinator-fixtures.js";

test("installs one UI lifecycle across per-extension event API wrappers", async () => {
	const bus = new EventBusHarness();
	const first = createApiHarness(eventBusView(bus));
	const duplicate = createApiHarness(eventBusView(bus));

	await piStuffUi(first.api);
	await piStuffUi(duplicate.api);

	expect(first.registeredCommands).toEqual(["ui", "diagnostics"]);
	expect(first.sessionHandlers).toHaveLength(2);
	expect(duplicate.registeredCommands).toEqual([]);
	expect(duplicate.sessionHandlers).toHaveLength(0);
});

test("observes late Codex status publication through one shared channel", async () => {
	const events = new EventBusHarness();
	const uiApi = createApiHarness(eventBusView(events));
	await piStuffUi(uiApi.api);
	const ui = new UiHarness();
	const ctx = createContext(ui, "tui", {
		contextUsage: { contextWindow: 200_000, percent: 42.4, tokens: 84_800 },
		modelId: "gpt-5.6-sol",
		provider: "openai-codex",
	});
	await uiApi.start(ctx);

	const factory = ui.footerWrites.at(-1);
	if (!factory) throw new Error("Expected the Suite footer factory");
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const footer = factory(ui.tui, ui.theme, createFooterData("main") as never);
	const initial = footer.render(120).join("\n");
	expect(initial).not.toContain("weekly");
	expect(initial).not.toContain("fast");

	const codexApi = createApiHarness(eventBusView(events));
	const uiChannel = getCodexStatusChannel(uiApi.api);
	const codexChannel = getCodexStatusChannel(codexApi.api);
	expect(codexChannel).toBe(uiChannel);
	const rendersBeforePublish = ui.renderRequests.length;
	codexChannel.publish({ fastEnabled: true, weeklyRemainingPercent: 72.4 });
	const active = footer.render(120).join("\n");
	expect(active).toContain("med ·");
	expect(active).toContain("fast ·");
	expect(active).toContain("72%");
	expect(ui.renderRequests.length).toBeGreaterThan(rendersBeforePublish);

	const rendersBeforeClear = ui.renderRequests.length;
	codexChannel.clear();
	const cleared = footer.render(120).join("\n");
	expect(cleared).not.toContain("weekly");
	expect(cleared).not.toContain("fast");
	expect(ui.renderRequests.length).toBeGreaterThan(rendersBeforeClear);

	footer.dispose?.();
	const rendersAfterDispose = ui.renderRequests.length;
	codexChannel.publish({ fastEnabled: true, weeklyRemainingPercent: 71 });
	expect(ui.renderRequests).toHaveLength(rendersAfterDispose);
});

test("refreshes Codex weekly usage after completed direct-user work without opening /codex", async () => {
	const events = new EventBusHarness();
	const uiApi = createApiHarness(eventBusView(events));
	const codexApi = createApiHarness(eventBusView(events));
	await piStuffUi(uiApi.api);
	await piStuffCodex(codexApi.api);
	const controller = new AbortController();
	const ctx = createContext(new UiHarness(), "tui", {
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		model: {
			api: "openai-responses",
			baseUrl: "https://chatgpt.com/backend-api",
			id: "gpt-5.6-sol",
			input: ["text"],
			provider: "openai-codex",
		} as ExtensionContext["model"],
		modelRegistry: {
			getApiKeyAndHeaders: async () => ({
				apiKey: "test-token",
				headers: { "chatgpt-account-id": "account-42" },
				ok: true,
			}),
		},
		signal: controller.signal,
	});
	let fetchCalls = 0;
	let usedPercent = 18;
	let deferredFetch: Promise<Response> | undefined;
	let failNextFetch = false;
	let codexShutdown = false;
	const usageResponse = (used: number): Response =>
		new Response(JSON.stringify({ rate_limit: { secondary: { used_percent: used, window_minutes: 10_080 } } }), {
			status: 200,
		});
	const originalFetch = globalThis.fetch;
	globalThis.fetch = Object.assign(
		async (_input: string | URL | Request, _init?: RequestInit) => {
			fetchCalls += 1;
			if (deferredFetch) {
				const pending = deferredFetch;
				deferredFetch = undefined;
				return pending;
			}
			if (failNextFetch) {
				failNextFetch = false;
				throw new Error("usage unavailable");
			}
			return usageResponse(usedPercent);
		},
		{ preconnect: originalFetch.preconnect },
	);

	try {
		await uiApi.start(ctx);
		await codexApi.start(ctx);
		const status = getCodexStatusChannel(uiApi.api).source;
		expect(status.getSnapshot().weeklyRemainingPercent).toBeUndefined();
		expect(fetchCalls).toBe(0);

		await settleAgentRun(uiApi, ctx, "extension", "automatic");
		expect(fetchCalls).toBe(0);
		const codexModel = ctx.model;
		Object.assign(ctx, { model: { id: "claude", provider: "anthropic" } });
		await settleAgentRun(uiApi, ctx, "interactive", "non-Codex request");
		expect(fetchCalls).toBe(0);
		Object.assign(ctx, { hasUI: false, model: codexModel });
		await settleAgentRun(uiApi, ctx, "interactive", "non-UI request");
		expect(fetchCalls).toBe(0);
		Object.assign(ctx, { hasUI: true });

		await settleAgentRun(uiApi, ctx, "interactive", "first direct request");
		await waitUntil(() => status.getSnapshot().weeklyRemainingPercent === 82);
		expect(fetchCalls).toBe(1);

		const heldFetch = createDeferred<Response>();
		deferredFetch = heldFetch.promise;
		await settleAgentRun(uiApi, ctx, "interactive", "second direct request");
		await waitUntil(() => fetchCalls === 2);
		usedPercent = 45;
		await settleAgentRun(uiApi, ctx, "interactive", "queued direct request");
		await settleAgentRun(uiApi, ctx, "interactive", "newest queued direct request");
		expect(fetchCalls).toBe(2);
		heldFetch.resolve(usageResponse(31));
		await waitUntil(() => status.getSnapshot().weeklyRemainingPercent === 55);
		expect(fetchCalls).toBe(3);

		failNextFetch = true;
		await settleAgentRun(uiApi, ctx, "interactive", "failed refresh");
		await waitUntil(() => fetchCalls === 4);
		await drainMicrotasks();
		expect(status.getSnapshot().weeklyRemainingPercent).toBe(55);

		usedPercent = 50;
		await settleAgentRun(uiApi, ctx, "interactive", "recovered refresh");
		await waitUntil(() => status.getSnapshot().weeklyRemainingPercent === 50);
		expect(fetchCalls).toBe(5);

		const lateFetch = createDeferred<Response>();
		deferredFetch = lateFetch.promise;
		await settleAgentRun(uiApi, ctx, "interactive", "shutdown refresh");
		await waitUntil(() => fetchCalls === 6);
		await codexApi.shutdown(ctx);
		codexShutdown = true;
		lateFetch.resolve(usageResponse(60));
		await drainMicrotasks();
		expect(status.getSnapshot().weeklyRemainingPercent).toBeUndefined();
		await settleAgentRun(uiApi, ctx, "interactive", "after shutdown");
		expect(fetchCalls).toBe(6);
	} finally {
		controller.abort();
		globalThis.fetch = originalFetch;
		await uiApi.shutdown(ctx);
		if (!codexShutdown) await codexApi.shutdown(ctx);
	}
});

test("shows live Goal state conditionally in the shared Statusline", async () => {
	const events = new EventBusHarness();
	const uiApi = createApiHarness(eventBusView(events));
	await piStuffUi(uiApi.api);
	const ui = new UiHarness();
	const ctx = createContext(ui, "tui", {
		contextUsage: { contextWindow: 200_000, percent: 42.4, tokens: 84_800 },
		modelId: "gpt-5.6-sol",
	});
	await uiApi.start(ctx);

	const factory = ui.footerWrites.at(-1);
	if (!factory) throw new Error("Expected the Suite footer factory");
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const footer = factory(ui.tui, ui.theme, createFooterData("main") as never);
	expect(footer.render(120).join("\n")).not.toContain("goal");

	const goalApi = createApiHarness(eventBusView(events));
	const uiChannel = getGoalStatusChannel(uiApi.api);
	const goalChannel = getGoalStatusChannel(goalApi.api);
	expect(goalChannel).toBe(uiChannel);

	const rendersBeforeActive = ui.renderRequests.length;
	const activeStartedAt = Date.now();
	goalChannel.publish({
		activeStartedAt,
		status: "active",
		timeUsedSeconds: 13 * 60,
		tokenBudget: 12_000,
		tokensUsed: 1_250,
	});
	expect(goalChannel.source.getSnapshot()).toEqual({
		activeStartedAt,
		status: "active",
		timeUsedSeconds: 13 * 60,
		tokenBudget: 12_000,
		tokensUsed: 1_250,
	});
	expect(footer.render(120).join("\n")).toContain(" goal 1.3k/12k 13m");
	expect(ui.renderRequests.length).toBeGreaterThan(rendersBeforeActive);

	goalChannel.publish({ status: "paused", timeUsedSeconds: 13 * 60, tokensUsed: 1_250 });
	expect(footer.render(120).join("\n")).toContain(" goal paused 13m");
	goalChannel.publish({
		status: "budget_limited",
		timeUsedSeconds: 13 * 60,
		tokenBudget: 12_000,
		tokensUsed: 12_000,
	});
	expect(footer.render(120).join("\n")).toContain(" goal budget 12k/12k 13m");
	goalChannel.publish({ status: "usage_limited", timeUsedSeconds: 13 * 60, tokensUsed: 1_250 });
	expect(footer.render(120).join("\n")).toContain(" goal usage 13m");
	goalChannel.publish({ status: "blocked", timeUsedSeconds: 13 * 60, tokensUsed: 1_250 });
	expect(footer.render(120).join("\n")).toContain(" goal blocked 13m");
	goalChannel.publish({ status: "complete", timeUsedSeconds: 13 * 60, tokensUsed: 0 });
	expect(footer.render(120).join("\n")).toContain(" goal complete 13m");

	const rendersBeforeClear = ui.renderRequests.length;
	goalChannel.clear();
	expect(goalChannel.source.getSnapshot()).toBeUndefined();
	expect(footer.render(120).join("\n")).not.toContain("goal");
	expect(ui.renderRequests.length).toBeGreaterThan(rendersBeforeClear);

	footer.dispose?.();
	const rendersAfterDispose = ui.renderRequests.length;
	goalChannel.publish({ status: "blocked", timeUsedSeconds: 13 * 60, tokensUsed: 1_250 });
	expect(ui.renderRequests).toHaveLength(rendersAfterDispose);
});

test("installs the accepted Statusline, Welcome header, and editor decorator", async () => {
	const api = createApiHarness();
	await piStuffUi(api.api);
	const ui = new UiHarness();
	const ctx = createContext(ui, "tui", {
		contextUsage: { contextWindow: 200_000, percent: 42.4, tokens: 84_800 },
		cwd: join(homedir(), "dev", "pi-stuff"),
		modelId: "gpt-5.6-sol",
	});
	await api.start(ctx);
	expect(api.execCalls).toEqual([]);

	const factory = ui.footerWrites.at(-1);
	if (!factory) throw new Error("Expected the Suite footer factory");
	const footerData = createFooterData("main");
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const footer = factory(ui.tui, ui.theme, footerData as never);
	const statusline = footer.render(100).join("\n");
	for (const expected of ["gpt-5.6-sol", "med", "pi-stuff", "main", "42.4%"]) {
		expect(statusline).toContain(expected);
	}
	expect(statusline).not.toContain("$0.00");
	expect(ui.headerWrites.at(-1)).toBeTypeOf("function");
	expect(ui.getEditorComponent()).toBeTypeOf("function");
});

test("lets Fleetview replace Footer row 2 in place and restores the exact prompt row", async () => {
	const api = createApiHarness();
	await piStuffUi(api.api);
	const coordinator = getCommandDialogCoordinator(api.api);
	const ui = new UiHarness();
	const ctx = createContext(ui, "tui", { modelId: "gpt-5.6-sol" });
	await api.start(ctx);
	expect(coordinator.hasInstalledFooter?.(ctx)).toBe(true);

	let managing = false;
	const hint = "↑/↓ select · Enter view · Esc return";
	const main = "● main";
	const prompt = "prompt";
	const reviewer = "○ reviewer  3s";

	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	(
		coordinator as typeof coordinator & {
			installFooter(context: ExtensionContext, factory: NonNullable<FooterFactory>): void;
		}
	).installFooter(ctx, () => ({
		invalidate: () => {},
		render: () => ["status", prompt],
	}));
	const initialFactory = ui.footerWrites.at(-1);
	if (!initialFactory) throw new Error("Expected the primary Suite Footer");
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const initialLines = initialFactory(ui.tui, ui.theme, createFooterData("main") as never).render(100);
	expect(initialLines).toEqual(["status", prompt]);
	const unregister = coordinator.registerFooterTail?.("fleetview-fixture", () => ({
		get replacesBaseRow2() {
			return managing;
		},
		invalidate: () => {},
		render: () => [...(managing ? [hint] : []), main, reviewer],
	}));
	const stackedFactory = ui.footerWrites.at(-1);
	if (!stackedFactory) throw new Error("Expected the stacked Suite Footer");
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const idle = stackedFactory(ui.tui, ui.theme, createFooterData("main") as never).render(100);

	expect(idle[0]).toBe("status");
	expect(idle[1]).toBe(prompt);
	expect(idle.at(-2)).toBe(main);
	expect(idle.at(-1)).toBe(reviewer);
	const idleMainIndex = idle.indexOf(main);

	managing = true;
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const active = stackedFactory(ui.tui, ui.theme, createFooterData("main") as never).render(100);
	expect(active[0]).toBe("status");
	expect(active[1]).toBe(hint);
	expect(active).not.toContain(prompt);
	expect(active.indexOf(main)).toBe(idleMainIndex);

	managing = false;
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	const restored = stackedFactory(ui.tui, ui.theme, createFooterData("main") as never).render(100);
	expect(restored[1]).toBe(prompt);
	expect(restored).not.toContain(hint);

	unregister?.();
	const statusOnlyFactory = ui.footerWrites.at(-1);
	if (!statusOnlyFactory) throw new Error("Expected the restored primary Footer");
	// SAFETY: this test double implements the exact Pi members exercised by this case; unused Host members are intentionally erased.
	expect(statusOnlyFactory(ui.tui, ui.theme, createFooterData("main") as never).render(100)).not.toContain(main);
});

test("uses the logical Footer row-2 slot with Statusline and latest Prompt independently disabled", async () => {
	const api = createApiHarness();
	await piStuffUi(api.api);
	const coordinator = getCommandDialogCoordinator(api.api);
	const ui = new UiHarness();
	const ctx = createContext(ui);
	await api.start(ctx);
	const installFooter =
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		(
			coordinator as typeof coordinator & {
				installFooter(context: ExtensionContext, factory: NonNullable<FooterFactory>): void;
			}
		).installFooter.bind(coordinator);
	let managing = false;
	const unregister = coordinator.registerFooterTail?.("fleetview-fixture", () => ({
		get replacesBaseRow2() {
			return managing;
		},
		invalidate: () => {},
		render: () => [...(managing ? ["controls"] : []), "● main"],
	}));

	for (const baseRows of [["status", "prompt"], ["status"], []] as const) {
		installFooter(ctx, () => ({
			invalidate: () => {},
			render: () => [...baseRows],
		}));
		const factory = ui.footerWrites.at(-1);
		if (!factory) throw new Error("Expected a composed Footer");
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		const component = factory(ui.tui, ui.theme, {} as never);

		managing = false;
		expect(component.render(80)).toEqual([...baseRows, "● main"]);
		managing = true;
		expect(component.render(80)).toEqual([...baseRows.slice(0, 1), "controls", "● main"]);
	}
	unregister?.();
});

test("does not probe Git while Statusline is disabled", async () => {
	const api = createApiHarness();
	const ui = new UiHarness();
	const ctx = createContext(ui);
	const settings = UiSettingsStore.memory();
	const coordinator = {
		installFooter: (_ctx: ExtensionContext, factory: FooterFactory) => ui.setFooter(factory),
		registerChrome: () => () => {},
		setWorkingVisible: () => {},
		show: async () => undefined,
		whenIdle: async () => {},
	};
	const presentation = installUiSessionPresentation(
		api.api,
		ctx,
		settings,
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		coordinator as never,
		new DiagnosticChannel(),
	);
	if (!presentation) throw new Error("Expected a TUI presentation");

	await Effect.runPromise(settings.set("statusline", false));
	presentation.refreshGit();
	expect(api.execCalls).toHaveLength(0);

	await Effect.runPromise(settings.set("statusline", true));
	presentation.refreshGit();
	expect(api.execCalls).toHaveLength(1);
	presentation.dispose();
});
