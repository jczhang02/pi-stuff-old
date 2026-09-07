import { expect, test } from "bun:test";
import {
	api,
	type BooleanValueSource,
	context,
	footerData,
	type GitChangeCounts,
	homedir,
	join,
	messageEntries,
	type ReadonlyFooterDataProvider,
	type SessionEntry,
	StatuslineController,
	theme,
	trackedSession,
	tuiHarness,
	turnEntries,
	usage,
	ValueSource,
	visibleWidth,
	withFormerFallbackOverride,
} from "../../ui/statusline-fixtures.js";

test("renders one ordered status row and exactly one bounded prompt row", () => {
	const enabled = new ValueSource(true);
	const git = new ValueSource<GitChangeCounts | undefined>({ staged: 12, unstaged: 3, untracked: 1 });
	const controller = new StatuslineController(api(), { enabled, gitChanges: git });
	const { tui } = tuiHarness();
	const component = controller.createFooter(
		context({}),
		tui,
		theme,
		footerData(
			"main",
			new Map([
				["goal", "goal:UI"],
				["mcp", "mcp:2"],
				["loadout", "load:full"],
				["agents", "agents:3"],
			]),
		),
	);

	const lines = withFormerFallbackOverride(() => component.render(120));
	expect(lines).toEqual([
		"󱙺 anthropic/sonnet-4.5 ·  med · 󰉋 pi-stuff ·  main 12 󰏫3 󰝒1 · 󰌨 42.4% · 󰆼 99.9% ·  $0.42",
		" Implement the accepted Pi Stuff statusline.",
	]);
	expect(lines.join("\n")).not.toMatch(/agents:3|goal:UI|mcp:2|load:full/u);

	const longPrompt = "请实现已经确认的状态栏，并验证中文宽字符和非常长的输入。".repeat(20);
	const longComponent = controller.createFooter(
		context({ branch: messageEntries(longPrompt) }),
		tui,
		theme,
		footerData("main"),
	);
	const narrow = withFormerFallbackOverride(() => longComponent.render(64));
	expect(narrow).toHaveLength(2);
	for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
});

test("reduces persisted skill expansion to the user prompt and a compact skill badge", () => {
	const skillPath = join(homedir(), ".agents", "skills", "tdd", "SKILL.md");
	const expandedPrompt = [
		`<skill name="tdd" location="${skillPath}">`,
		`References are relative to ${join(homedir(), ".agents", "skills", "tdd")}.`,
		"# Test-Driven Development",
		"User: fix auth test",
		"</skill>",
	].join("\n");
	const controller = new StatuslineController(api(), { enabled: new ValueSource(true) });
	const component = controller.createFooter(
		context({ branch: messageEntries(expandedPrompt, 0, 0) }),
		tuiHarness().tui,
		theme,
		footerData("main"),
	);

	const rendered = withFormerFallbackOverride(() => component.render(96).join("\n"));
	expect(rendered).toContain("fix auth test [skill:tdd]");
	for (const privateExpansion of ["<skill", "location=", skillPath, "References are relative to"]) {
		expect(rendered).not.toContain(privateExpansion);
	}
});

test("restores inline and multiple raw skill commands as responsive badges", () => {
	const rawPrompt = "please use /skill:tdd /skill:review /skill:triage /skill:prototype today /skill:missing";
	const controller = new StatuslineController(api("medium", ["tdd", "review", "triage", "prototype"]), {
		enabled: new ValueSource(true),
	});
	const component = controller.createFooter(
		context({ branch: messageEntries(rawPrompt, 0, 0) }),
		tuiHarness().tui,
		theme,
		footerData("main"),
	);

	const wide = withFormerFallbackOverride(() => component.render(120).join("\n"));
	expect(wide).toContain("please use today /skill:missing [skills:tdd,review,triage,prototype]");
	for (const recognized of ["tdd", "review", "triage", "prototype"]) {
		expect(wide).not.toContain(`/skill:${recognized}`);
	}
	const narrow = withFormerFallbackOverride(() => component.render(64).join("\n"));
	expect(narrow).toContain("[skills:4]");
	expect(narrow).not.toContain("tdd,review,triage,prototype");
});

test("keeps the user suffix when an expanded skill body exceeds the display safety cap", () => {
	const expandedPrompt = `<skill name="huge" location="/private/huge/SKILL.md">\n${"x".repeat(20_000)}\n</skill>\n\nDO_THE_USER_TASK`;
	const controller = new StatuslineController(api(), { enabled: new ValueSource(true) });
	const component = controller.createFooter(
		context({ branch: messageEntries(expandedPrompt, 0, 0) }),
		tuiHarness().tui,
		theme,
		footerData("main"),
	);

	const rendered = withFormerFallbackOverride(() => component.render(96).join("\n"));
	expect(rendered).toContain("DO_THE_USER_TASK [skill:huge]");
	expect(rendered).not.toContain("/private/");
});

test("reserves the skill badge when a medium-width prompt is bounded to one row", () => {
	const expandedPrompt = `<skill name="tdd" location="/private/tdd/SKILL.md">\nbody\n</skill>\n\n${"LONGWORD ".repeat(80)}`;
	const controller = new StatuslineController(api(), { enabled: new ValueSource(true) });
	const component = controller.createFooter(
		context({ branch: messageEntries(expandedPrompt, 0, 0) }),
		tuiHarness().tui,
		theme,
		footerData("main"),
	);

	const lines = withFormerFallbackOverride(() => component.render(48));
	expect(lines.filter((line) => line.includes("LONGWORD") || line.includes("[skill:tdd]"))).toHaveLength(1);
	expect(lines.join("\n")).toContain("[skill:tdd]");
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(48);
});

test("omits a meaningless prompt ellipsis before a long skill badge", () => {
	const skill = `review-${"x".repeat(24)}`;
	const expandedPrompt = `<skill name="${skill}" location="/private/review/SKILL.md">\nbody\n</skill>\n\n${"检查🙂超长路径 ".repeat(40)}`;
	const controller = new StatuslineController(api(), { enabled: new ValueSource(true) });
	const component = controller.createFooter(
		context({ branch: messageEntries(expandedPrompt, 0, 0) }),
		tuiHarness().tui,
		theme,
		footerData("main"),
	);

	for (const width of [100, 64, 48, 32, 24]) {
		const lines = withFormerFallbackOverride(() => component.render(width));
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(lines.join("\n")).not.toMatch(/…\s+\[skill:/u);
	}

	const narrowPrompt = withFormerFallbackOverride(() => component.render(48).join("\n"));
	expect(narrowPrompt).toContain(`[skill:${skill}]`);
	expect(narrowPrompt).not.toContain("检查…");
});

test("matches the old footer usage accounting by ignoring aborted turns and compaction metadata", () => {
	const [user, assistant] = turnEntries("aborted", "Retry the interrupted task", null, 18_000, 0.42);
	if (assistant.type !== "message" || assistant.message.role !== "assistant") {
		throw new Error("Expected assistant fixture entry");
	}
	assistant.message.stopReason = "aborted";
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const compaction = {
		firstKeptEntryId: user.id,
		id: "aborted-compaction",
		parentId: assistant.id,
		summary: "Interrupted turn summary",
		timestamp: "2026-08-03T00:00:02Z",
		tokensBefore: 10_000,
		type: "compaction",
		usage: usage(9_000, 0.21),
	} as SessionEntry;
	const controller = new StatuslineController(api(), { enabled: new ValueSource(true) });
	const component = controller.createFooter(
		context({ branch: [user, assistant, compaction] }),
		tuiHarness().tui,
		theme,
		footerData("main"),
	);

	const rendered = withFormerFallbackOverride(() => component.render(120).join("\n"));
	expect(rendered).not.toContain("cache");
	expect(rendered).not.toContain("$0.");
});

test("caches exact usage by settled Session leaf and defers changed leaves until Host idle", () => {
	const [rootUser, rootAssistant] = turnEntries("root", "Root prompt", null, 100, 0.1);
	const [mainUser, mainAssistant] = turnEntries("main", "Main branch prompt", rootAssistant.id, 200, 0.2);
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const compaction = {
		firstKeptEntryId: mainUser.id,
		id: "main-compaction",
		parentId: mainAssistant.id,
		summary: "Compacted main branch",
		timestamp: "2026-08-03T00:00:02Z",
		tokensBefore: 10_000,
		type: "compaction",
		usage: usage(50, 0.05),
	} as SessionEntry;
	const [alternateUser, alternateAssistant] = turnEntries(
		"alternate",
		"Alternate branch prompt",
		rootAssistant.id,
		300,
		0.3,
	);
	const session = trackedSession(
		[rootUser, rootAssistant, mainUser, mainAssistant, compaction, alternateUser, alternateAssistant],
		compaction.id,
	);
	let idle = true;
	const statuslineContext = context({ idle: () => idle, sessionManager: session.manager });
	const readContextUsage = statuslineContext.getContextUsage;
	let contextUsageReads = 0;
	Object.assign(statuslineContext, {
		getContextUsage: () => {
			contextUsageReads += 1;
			return readContextUsage();
		},
	});
	const controller = new StatuslineController(api(), { enabled: new ValueSource(true) });
	const component = controller.createFooter(statuslineContext, tuiHarness().tui, theme, footerData("main"));

	const main = component.render(120).join("\n");
	expect(main).toContain("93.8%");
	expect(main).toContain("$0.30");
	expect(main).toContain("Main branch prompt");
	expect(session.reads.branches).toBe(0);
	expect(contextUsageReads).toBe(1);
	const readsAfterFirstRender = session.reads.entries;

	component.render(80);
	component.render(120);
	expect(session.reads.entries).toBe(readsAfterFirstRender);
	expect(session.reads.branches).toBe(0);
	expect(contextUsageReads).toBe(1);

	session.setLeaf(alternateAssistant.id);
	idle = false;
	const alternate = component.render(120).join("\n");
	expect(alternate).toContain("95.2%");
	expect(alternate).toContain("$0.40");
	expect(alternate).toContain("Alternate branch prompt");
	expect(session.reads.entries).toBe(readsAfterFirstRender + 2);
	expect(contextUsageReads).toBe(1);
	idle = true;
	component.render(120);
	expect(contextUsageReads).toBe(2);

	const readsAfterAlternateBranch = session.reads.entries;
	session.setLeaf(compaction.id);
	idle = false;
	expect(component.render(120).join("\n")).toContain("Main branch prompt");
	expect(session.reads.entries).toBe(readsAfterAlternateBranch);
	expect(contextUsageReads).toBe(2);
	idle = true;
	component.render(120);
	expect(contextUsageReads).toBe(3);
});

test("omits cost for OAuth subscription models even when the catalogue reports rates", () => {
	const controller = new StatuslineController(api(), { enabled: new ValueSource(true) });
	const component = controller.createFooter(
		context({ metered: true, subscription: true }),
		tuiHarness().tui,
		theme,
		footerData("main"),
	);
	const rendered = component.render(100).join("\n");
	expect(rendered).not.toContain("$");
	expect(rendered).not.toMatch(/\bsub\b/iu);
	expect(rendered).toContain("99.9%");
});

test("omits cost for Kimi Coding subscription models that use API-key authentication", () => {
	const controller = new StatuslineController(api(), { enabled: new ValueSource(true) });
	const component = controller.createFooter(
		context({ metered: true, provider: "kimi-coding", subscription: false }),
		tuiHarness().tui,
		theme,
		footerData("main"),
	);
	const rendered = component.render(100).join("\n");
	expect(rendered).not.toContain("$");
	expect(rendered).toContain("99.9%");
});

test("removes every row for settings, Command Dialog, and autocomplete suppression", () => {
	const enabled = new ValueSource(true);
	const autocomplete = new ValueSource(false);
	const controller = new StatuslineController(api(), { autocompleteVisible: autocomplete, enabled });
	const harness = tuiHarness();
	const component = controller.createFooter(context({}), harness.tui, theme, footerData("main"));
	expect(component.render(100)).not.toEqual([]);
	expect(controller.isEnabled()).toBe(true);

	controller.setSuppressed(true);
	expect(component.render(100)).toEqual([]);
	controller.setSuppressed(false);
	autocomplete.set(true);
	expect(component.render(100)).toEqual([]);
	autocomplete.set(false);
	enabled.set(false);
	expect(controller.isEnabled()).toBe(false);
	expect(component.render(100)).toEqual([]);
	expect(harness.requests.length).toBeGreaterThanOrEqual(5);

	const requestsBeforeDispose = harness.requests.length;
	component.dispose();
	enabled.set(true);
	expect(harness.requests).toHaveLength(requestsBeforeDispose);
	expect(component.render(100)).toEqual([]);
});

test("strips terminal and bidi controls from every dynamic field", () => {
	const injected = "前\u001b]0;OWNED_TITLE\u0007后\u009b31m红\u202eABC";
	const controller = new StatuslineController(api("medium"), {
		// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
		enabled: new ValueSource(true) as BooleanValueSource,
	});
	const component = controller.createFooter(
		context({
			branch: messageEntries(`${injected} 请验证中文`),
			cwd: join(homedir(), injected, "project"),
			modelId: injected,
		}),
		tuiHarness().tui,
		theme,
		footerData(injected, new Map([["goal", injected]])),
	);
	const lines = component.render(64);
	const rendered = lines.join("\n");
	expect(rendered).not.toContain("OWNED_TITLE");
	expect(rendered).not.toContain("\u001b[31m");
	expect(rendered).not.toContain("\u009b");
	expect(rendered).not.toContain("\u202e");
	expect(rendered).toContain("前后红");
	for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(64);
});

test("isolates recoverable renderer, source-listener, and unsubscribe failures", () => {
	let enabledListener: (() => void) | undefined;
	const enabled: BooleanValueSource = {
		get: () => true,
		subscribe: (listener) => {
			enabledListener = listener;
			return () => {
				throw new Error("enabled unsubscribe failed");
			};
		},
	};
	let branchListener: (() => void) | undefined;
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const data = {
		getAvailableProviderCount: () => 1,
		getExtensionStatuses: () => new Map<string, string>(),
		getGitBranch: () => "main",
		onBranchChange: (listener: () => void) => {
			branchListener = listener;
			return () => {
				throw new Error("branch unsubscribe failed");
			};
		},
	} as ReadonlyFooterDataProvider;
	const controller = new StatuslineController(api(), { enabled });
	let healthyRenders = 0;
	controller.registerRenderer({
		requestRender: () => {
			throw new Error("renderer failed");
		},
	});
	controller.registerRenderer({ requestRender: () => (healthyRenders += 1) });
	const component = controller.createFooter(
		context({}),
		{
			requestRender: () => {
				throw new Error("TUI render failed");
			},
		},
		theme,
		data,
	);

	expect(() => controller.setSuppressed(true)).not.toThrow();
	expect(healthyRenders).toBe(1);
	expect(() => enabledListener?.()).not.toThrow();
	expect(() => branchListener?.()).not.toThrow();
	expect(() => component.dispose()).not.toThrow();
});
