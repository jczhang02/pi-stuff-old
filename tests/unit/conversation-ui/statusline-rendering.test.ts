import { expect, test } from "bun:test";
import {
	api,
	CodexStatusValueSource,
	context,
	createExtensionApi,
	footerData,
	type GitChangeCounts,
	getCodexStatusChannel,
	getContextStatusChannel,
	getGoalStatusChannel,
	messageEntries,
	preferences,
	StatuslineController,
	type Theme,
	theme,
	tuiHarness,
	ValueSource,
	visibleWidth,
	withFormerFallbackOverride,
} from "../../ui/statusline-fixtures.js";

test("status channels support events-only Host adapters", () => {
	const { events } = createExtensionApi();
	const host = { events };
	getCodexStatusChannel(host).publish({ fastEnabled: true });
	getGoalStatusChannel(host).publish({ status: "active", timeUsedSeconds: 2, tokensUsed: 1 });
	expect(getCodexStatusChannel(host).source.getSnapshot()).toEqual({ fastEnabled: true });
	expect(getGoalStatusChannel(host).source.getSnapshot()).toEqual({
		status: "active",
		timeUsedSeconds: 2,
		tokensUsed: 1,
	});
});

test("runs the Goal clock only while an active Goal is visible", () => {
	const { events } = createExtensionApi();
	const goal = getGoalStatusChannel({ events });
	const enabled = new ValueSource(true);
	const intervals: number[] = [];
	let cancellations = 0;
	let tick: (() => void) | undefined;
	const controller = new StatuslineController(api(), {
		enabled,
		goalStatus: goal.source,
		repeat: (callback, intervalMs) => {
			intervals.push(intervalMs);
			tick = callback;
			let active = true;
			return () => {
				if (!active) return;
				active = false;
				cancellations += 1;
			};
		},
	});
	const harness = tuiHarness();
	const component = controller.createFooter(context({}), harness.tui, theme, footerData("main"));

	goal.publish({ activeStartedAt: 1, status: "active", timeUsedSeconds: 0, tokensUsed: 0 });
	expect(intervals).toEqual([1_000]);
	const rendersBeforeTick = harness.requests.length;
	tick?.();
	expect(harness.requests).toHaveLength(rendersBeforeTick + 1);

	goal.publish({ status: "paused", timeUsedSeconds: 1, tokensUsed: 0 });
	expect(cancellations).toBe(1);
	goal.publish({ activeStartedAt: 2, status: "active", timeUsedSeconds: 1, tokensUsed: 0 });
	controller.setSuppressed(true);
	expect(cancellations).toBe(2);
	controller.setSuppressed(false);
	enabled.set(false);
	expect(cancellations).toBe(3);
	enabled.set(true);
	component.dispose();
	expect(cancellations).toBe(4);

	controller.createFooter(context({}), tuiHarness().tui, theme, footerData("main"));
	controller.dispose();
	expect(cancellations).toBe(5);
});

test("renders cache hit rate and observed Codex weekly and Fast state", () => {
	const codexStatus = new CodexStatusValueSource({ fastEnabled: true, weeklyRemainingPercent: 63.4 });
	const controller = new StatuslineController(api(), {
		codexStatus,
		enabled: new ValueSource(true),
	});
	const harness = tuiHarness();
	const component = controller.createFooter(
		context({ provider: "openai-codex", subscription: true }),
		harness.tui,
		theme,
		footerData("main"),
	);

	const active = withFormerFallbackOverride(() => component.render(160).join("\n"));
	expect(active).toContain("󰆼 99.9%");
	expect(active).toContain("󰊚 63%");
	expect(active).toContain(" fast");
	expect(active.indexOf(" med")).toBeLessThan(active.indexOf(" fast"));
	expect(active.indexOf(" fast")).toBeLessThan(active.indexOf("󰉋 pi-stuff"));
	expect(active.indexOf("󰆼 99.9%")).toBeLessThan(active.indexOf("󰊚 63%"));
	expect(active).not.toContain("18k");
	expect(active).not.toContain("$0.42");

	const rendersBeforeUpdate = harness.requests.length;
	codexStatus.set({ fastEnabled: false, weeklyRemainingPercent: 62.6 });
	const inactive = withFormerFallbackOverride(() => component.render(160).join("\n"));
	expect(inactive).toContain("󰊚 63%");
	expect(inactive).not.toContain(" fast");
	expect(harness.requests.length).toBeGreaterThan(rendersBeforeUpdate);
});

test("includes input and cache writes in the cache hit denominator", () => {
	const controller = new StatuslineController(api(), { enabled: new ValueSource(true) });
	const component = controller.createFooter(
		context({ branch: messageEntries("Cache denominator", 60, 0, 20, 20), reasoning: false }),
		tuiHarness().tui,
		theme,
		footerData("main"),
	);

	expect(withFormerFallbackOverride(() => component.render(120).join("\n"))).toContain("󰆼 60%");
});

test("hides Codex weekly, Fast, and cost when no observer data exists", () => {
	const controller = new StatuslineController(api(), { enabled: new ValueSource(true) });
	const component = controller.createFooter(
		context({ provider: "openai-codex", subscription: false }),
		tuiHarness().tui,
		theme,
		footerData("main"),
	);

	const rendered = component.render(160).join("\n");
	expect(rendered).not.toContain("󰊚");
	expect(rendered).not.toContain("fast");
	expect(rendered).not.toContain("$");
});

test("renders the accepted Nerd icon-led one-row status despite the former fallback override", () => {
	withFormerFallbackOverride(() => {
		const enabled = new ValueSource(true);
		const git = new ValueSource<GitChangeCounts | undefined>({ staged: 12, unstaged: 3, untracked: 1 });
		const controller = new StatuslineController(api(), { enabled, gitChanges: git });
		const { tui } = tuiHarness();
		const component = controller.createFooter(
			context({ modelName: "Claude Sonnet 4.5" }),
			tui,
			theme,
			footerData(
				"main",
				new Map([
					["codex-goal", "goal:UI"],
					["mcp", "mcp:2"],
					["loadout", "load:full"],
					["agents", "agents:3"],
				]),
			),
		);

		expect(component.render(160)).toEqual([
			"󱙺 anthropic/sonnet-4.5 ·  med · 󰉋 pi-stuff ·  main 12 󰏫3 󰝒1 · 󰌨 42.4% · 󰆼 99.9% ·  $0.42",
			" Implement the accepted Pi Stuff statusline.",
		]);
	});
});

test("aligns Nerd prompt text for Latin, CJK, and emoji first characters", () => {
	withFormerFallbackOverride(() => {
		const controller = new StatuslineController(api(), {
			preferences: preferences(),
		});
		const latin = controller.createFooter(
			context({ branch: messageEntries("Implement the footer.") }),
			tuiHarness().tui,
			theme,
			footerData("main"),
		);
		const cjk = controller.createFooter(
			context({ branch: messageEntries("中文状态栏需要视觉对齐。") }),
			tuiHarness().tui,
			theme,
			footerData("main"),
		);
		const emoji = controller.createFooter(
			context({ branch: messageEntries("🚀 Ship the aligned footer.") }),
			tuiHarness().tui,
			theme,
			footerData("main"),
		);

		expect(latin.render(120)[0]).toStartWith("󱙺 ");
		expect(latin.render(120)[1]).toStartWith(" Implement");
		expect(cjk.render(120)[1]).toStartWith(" 中文");
		expect(emoji.render(120)[1]).toStartWith(" 🚀 Ship");
		expect(visibleWidth(" ")).toBe(2);
		expect(visibleWidth(" 中")).toBe(4);
	});
});

test("applies density and prompt preferences immediately", () => {
	withFormerFallbackOverride(() => {
		const preferenceSource = preferences({ density: "compact", latestPrompt: false });
		const controller = new StatuslineController(api(), { preferences: preferenceSource });
		const harness = tuiHarness();
		const component = controller.createFooter(
			context({}),
			harness.tui,
			theme,
			footerData("main", new Map([["goal", "goal:UI"]])),
		);

		const compact = component.render(160).join("\n");
		expect(compact).toContain("󱙺 sonnet-4.5");
		expect(compact).not.toContain("Implement the accepted");
		expect(compact).not.toContain("󰆼");
		expect(compact).not.toContain("$0.42");
		expect(compact).not.toContain("goal:UI");

		preferenceSource.set({ density: "full", enabled: true, latestPrompt: true });
		const full = component.render(160).join("\n");
		expect(full).toContain("󰉋 pi-stuff");
		expect(full).toContain(" Implement the accepted Pi Stuff statusline.");
		expect(full).toContain("󰆼 99.9%");
		expect(full).not.toContain("goal:UI");
		expect(harness.requests.length).toBeGreaterThan(0);
	});
});

test("shows Git conflicts and upstream divergence without another probe", () => {
	withFormerFallbackOverride(() => {
		const git = new ValueSource<GitChangeCounts | undefined>({
			ahead: 2,
			behind: 1,
			conflicted: 2,
			staged: 1,
			unstaged: 0,
			untracked: 0,
		});
		const controller = new StatuslineController(api(), { enabled: new ValueSource(true), gitChanges: git });
		const component = controller.createFooter(context({}), tuiHarness().tui, theme, footerData("main"));
		const rendered = component.render(160).join("\n");

		expect(rendered).toContain(" main 2 1 2 1");
	});
});

test("maps the accepted icon grammar onto Pi semantic theme tokens", () => {
	withFormerFallbackOverride(() => {
		const colored = new Map<string, string[]>();
		// SAFETY: this test fixture implements the exact Host surface exercised by this case.
		const recordingTheme = {
			bold: (text: string) => text,
			fg: (color: string, text: string) => {
				const values = colored.get(color) ?? [];
				values.push(text);
				colored.set(color, values);
				return text;
			},
		} as Theme;
		const git = new ValueSource<GitChangeCounts | undefined>({ staged: 12, unstaged: 3, untracked: 1 });
		const controller = new StatuslineController(api(), { enabled: new ValueSource(true), gitChanges: git });
		const component = controller.createFooter(
			context({ modelName: "Claude Sonnet 4.5" }),
			tuiHarness().tui,
			recordingTheme,
			footerData("main", new Map([["goal", "goal:UI"]])),
		);

		component.render(160);
		expect(colored.get("accent")).toEqual(expect.arrayContaining(["󱙺 anthropic/sonnet-4.5", "󰉋"]));
		expect(colored.get("accent")).not.toContain("");
		expect(colored.get("thinkingMedium")).toContain("");
		expect(colored.get("warning")).toEqual(expect.arrayContaining(["", "󰏫3", ""]));
		expect(colored.get("success")).toContain("12");
		expect(colored.get("dim")).toEqual(expect.arrayContaining(["󰌨", " · "]));
		expect(colored.get("muted")).toEqual(
			expect.arrayContaining(["", "med", "󰝒1", "󰆼", "Implement the accepted Pi Stuff statusline."]),
		);
		expect([...colored.values()].flat()).not.toContain("goal:UI");
		expect(colored.get("text")).toEqual(expect.arrayContaining(["pi-stuff", "main", "42.4%", "99.9%", "$0.42"]));
	});
});

test("drops complete low-priority segments instead of wrapping or fusing them", () => {
	withFormerFallbackOverride(() => {
		const git = new ValueSource<GitChangeCounts | undefined>({ staged: 12, unstaged: 3, untracked: 1 });
		const controller = new StatuslineController(api(), { enabled: new ValueSource(true), gitChanges: git });
		const component = controller.createFooter(
			context({}),
			tuiHarness().tui,
			theme,
			footerData(
				"main",
				new Map([
					["goal", "goal:UI"],
					["mcp", "mcp:2"],
					["loadout", "load:full"],
				]),
			),
		);

		const lines = component.render(64);
		const rendered = lines.join("\n");
		expect(rendered).toContain("sonnet-4.5");
		expect(rendered).toMatch(/󰌨 42(?:\.4)?%/u);
		expect(rendered).toContain(" main");
		expect(rendered).not.toMatch(/[󰏫󰝒]\d+[^\n]*…/u);
		expect(rendered).not.toContain("AC");
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
	});
});

test("falls back to the complete model marker instead of clipping a field fragment", () => {
	withFormerFallbackOverride(() => {
		const controller = new StatuslineController(api(), {
			preferences: preferences({ latestPrompt: false }),
		});
		const component = controller.createFooter(
			context({ modelId: "an-extraordinarily-long-model-identity", reasoning: false }),
			tuiHarness().tui,
			theme,
			footerData(""),
		);

		expect(component.render(3)).toEqual(["󱙺"]);
		expect(component.render(1)).toEqual(["󱙺"]);
	});
});

test("renders an explicit unknown Context while hiding zero-value optional segments", () => {
	withFormerFallbackOverride(() => {
		const controller = new StatuslineController(api("off"), { enabled: new ValueSource(true) });
		const component = controller.createFooter(
			context({
				branch: messageEntries("Optional fields are absent.", 0, 0, 0, 0),
				contextPercent: null,
				reasoning: false,
			}),
			tuiHarness().tui,
			theme,
			footerData("main"),
		);
		const rendered = component.render(160).join("\n");
		expect(rendered).not.toContain("");
		expect(rendered).toContain("󰌨 ?");
		expect(rendered).not.toContain("󰆼");
		expect(rendered).not.toContain("$");
	});
});

test("retains model and Context before lower-priority fields at narrow widths", () => {
	withFormerFallbackOverride(() => {
		const git = new ValueSource<GitChangeCounts | undefined>({ staged: 12, unstaged: 3, untracked: 1 });
		const controller = new StatuslineController(api(), { enabled: new ValueSource(true), gitChanges: git });
		const component = controller.createFooter(
			context({}),
			tuiHarness().tui,
			theme,
			footerData(
				"main",
				new Map([
					["goal", "goal:UI"],
					["mcp", "mcp:2"],
					["loadout", "load:full"],
				]),
			),
		);

		for (const width of [48, 32, 24]) {
			const lines = component.render(width);
			const rendered = lines.join("\n");
			expect(rendered).toContain("sonnet");
			expect(rendered).toMatch(/42(?:\.4)?%/u);
			expect(lines).toHaveLength(2);
			expect(lines[1]?.startsWith("")).toBe(true);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		expect(component.render(48).join("\n")).toContain("Implement the accepted");
		expect(component.render(32).join("\n")).toContain("Implement the");
	});
});

test("keeps full Git detail wide and removes lower-priority Git fields atomically when narrow", () => {
	withFormerFallbackOverride(() => {
		const git = new ValueSource<GitChangeCounts | undefined>({
			ahead: 2,
			behind: 1,
			conflicted: 2,
			staged: 12,
			unstaged: 3,
			untracked: 1,
		});
		const controller = new StatuslineController(api(), { enabled: new ValueSource(true), gitChanges: git });
		const component = controller.createFooter(
			context({
				branch: messageEntries("Long identity probe", 0, 0),
				modelId: "ultra-long-provider-model-family-2026",
				modelName: "ultra-long-provider-model-family-2026",
				reasoning: false,
			}),
			tuiHarness().tui,
			theme,
			footerData("feature/a-very-long-branch-name"),
		);

		const wide = component.render(400).join("\n");
		for (const marker of ["2", "12", "󰏫3", "󰝒1", "2", "1"]) expect(wide).toContain(marker);

		for (const width of [64, 48, 32, 24]) {
			const lines = component.render(width);
			const rendered = lines.join("\n");
			expect(rendered).toContain("ultra");
			expect(rendered).toMatch(/42(?:\.4)?%/u);
			expect(rendered).not.toMatch(/(?:!|\+|~|\?)…/u);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

test("keeps the semantic Git projection coherent when Context is intentionally hidden", () => {
	withFormerFallbackOverride(() => {
		const git = new ValueSource<GitChangeCounts | undefined>({
			ahead: 2,
			behind: 1,
			conflicted: 2,
			staged: 12,
			unstaged: 3,
			untracked: 1,
		});
		const controller = new StatuslineController(api(), { enabled: new ValueSource(true), gitChanges: git });
		const component = controller.createFooter(
			context({
				branch: messageEntries("Semantic Git projection", 0, 0),
				modelId: "ultra-long-provider-model-family-2026",
				modelName: "ultra-long-provider-model-family-2026",
				reasoning: false,
			}),
			tuiHarness().tui,
			theme,
			footerData(
				`feature/${"a-very-long-branch-component-".repeat(6)}`,
				new Map([["compact-policy", "hide-context"]]),
			),
		);

		const wide = component.render(600).join("\n");
		for (const marker of ["2", "12", "󰏫3", "󰝒1", "2", "1"]) expect(wide).toContain(marker);
		expect(wide).not.toContain("42.4%");

		for (const width of [100, 64, 48, 32, 24]) {
			const lines = component.render(width);
			const rendered = lines.join("\n");
			expect(rendered).toContain("ultra");
			expect(rendered).not.toContain("42.4%");
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});
});

test("keeps Context percentage without exposing token-window counts", () => {
	withFormerFallbackOverride(() => {
		for (const contextWindow of [0, Number.NaN]) {
			const controller = new StatuslineController(api(), { enabled: new ValueSource(true) });
			const component = controller.createFooter(
				context({ branch: messageEntries("Context fallback", 0, 0), contextWindow, reasoning: false }),
				tuiHarness().tui,
				theme,
				footerData("main"),
			);
			const rendered = component.render(100).join("\n");
			expect(rendered).toContain("󰌨 42.4%");
			expect(rendered).not.toContain("200k");
		}
	});
});

test("uses the Context projection snapshot instead of stale Host usage during recovery", () => {
	withFormerFallbackOverride(() => {
		const { events } = createExtensionApi();
		const contextStatus = getContextStatusChannel({ events });
		const controller = new StatuslineController(api(), {
			contextStatus: contextStatus.source,
			enabled: new ValueSource(true),
		});
		const component = controller.createFooter(
			context({ contextPercent: 42.4, reasoning: false }),
			tuiHarness().tui,
			theme,
			footerData("main"),
		);

		contextStatus.publish({ state: "recovering", phase: "compacting" });
		let rendered = component.render(100).join("\n");
		expect(rendered).toContain("󰌨 recovering: compacting");
		expect(rendered).not.toContain("42.4%");

		contextStatus.publish({ state: "validated", tokens: 50_000, contextWindow: 200_000 });
		rendered = component.render(100).join("\n");
		expect(rendered).toContain("󰌨 25%");
		expect(rendered).not.toContain("42.4%");

		contextStatus.clear();
		expect(component.render(100).join("\n")).toContain("󰌨 42.4%");
	});
});

test("renders explicit unknown Context when Host usage throws", () => {
	withFormerFallbackOverride(() => {
		const { events } = createExtensionApi();
		const contextStatus = getContextStatusChannel({ events });
		const controller = new StatuslineController(api(), {
			contextStatus: contextStatus.source,
			enabled: new ValueSource(true),
		});
		const throwingContext = {
			...context({ contextPercent: 42.4, reasoning: false }),
			getContextUsage: () => {
				throw new Error("usage unavailable");
			},
		};
		const component = controller.createFooter(throwingContext, tuiHarness().tui, theme, footerData("main"));

		contextStatus.publish({ state: "unknown" });
		let rendered = component.render(100).join("\n");
		expect(rendered).toContain("󰌨 unknown");
		expect(rendered).not.toContain("42.4%");

		contextStatus.clear();
		rendered = component.render(100).join("\n");
		expect(rendered).not.toContain("󰌨");
	});
});
