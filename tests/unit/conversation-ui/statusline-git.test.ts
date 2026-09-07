import { expect, test } from "bun:test";
import {
	context,
	type ExtensionAPI,
	GitStatusSource,
	homedir,
	join,
	parseGitStatusPorcelain,
	type ReadonlyFooterDataProvider,
	StatuslineController,
	theme,
	tuiHarness,
	ValueSource,
	withFormerFallbackOverride,
} from "../../ui/statusline-fixtures.js";

test("parses a bounded Git refresh and isolates listeners", async () => {
	const porcelain =
		"## main...origin/main [ahead 2, behind 1]\0?? new.ts\0 M changed.ts\0D  gone.ts\0R  renamed.ts\0old.ts\0UU conflict.ts\0!! ignored.ts\0";
	expect(parseGitStatusPorcelain(porcelain)).toEqual({
		ahead: 2,
		behind: 1,
		conflicted: 1,
		staged: 2,
		unstaged: 1,
		untracked: 1,
	});
	let resolveExec: ((value: { code: number; killed: boolean; stderr: string; stdout: string }) => void) | undefined;
	let execCalls = 0;
	const fakeApi = {
		exec: () => {
			execCalls += 1;
			return new Promise<Awaited<ReturnType<ExtensionAPI["exec"]>>>((resolve) => {
				resolveExec = resolve;
			});
		},
	};
	const source = new GitStatusSource();
	let healthyNotifications = 0;
	source.subscribe(() => {
		throw new Error("observer failed");
	});
	source.subscribe(() => {
		healthyNotifications += 1;
	});

	const first = source.refresh(fakeApi, "/workspace");
	expect(execCalls).toBe(1);
	if (!resolveExec) throw new Error("Expected the Git fixture command to start");
	resolveExec({ code: 0, killed: false, stderr: "", stdout: porcelain });
	await first;

	expect(source.get()).toEqual({
		ahead: 2,
		behind: 1,
		conflicted: 1,
		staged: 2,
		unstaged: 1,
		untracked: 1,
	});
	expect(healthyNotifications).toBe(1);
});

test("coalesces refresh bursts into one trailing snapshot without losing the newest Git state", async () => {
	const resolvers: Array<(value: { code: number; killed: boolean; stderr: string; stdout: string }) => void> = [];
	const fakeApi = {
		exec: () =>
			new Promise<{ code: number; killed: boolean; stderr: string; stdout: string }>((resolve) => {
				resolvers.push(resolve);
			}),
	};
	const source = new GitStatusSource();

	const first = source.refresh(fakeApi, "/workspace");
	const trailing = source.refresh(fakeApi, "/workspace");
	expect(trailing).toBe(first);
	expect(resolvers).toHaveLength(1);
	resolvers[0]?.({ code: 0, killed: false, stderr: "", stdout: "## main\0 M old.ts\0" });
	await Bun.sleep(0);
	expect(resolvers).toHaveLength(2);
	resolvers[1]?.({
		code: 0,
		killed: false,
		stderr: "",
		stdout: "## main...origin/main [ahead 1]\0 M first.ts\0 M second.ts\0",
	});
	await Promise.all([first, trailing]);

	expect(source.get("/workspace", "main")).toEqual({
		ahead: 1,
		behind: 0,
		conflicted: 0,
		staged: 0,
		unstaged: 2,
		untracked: 0,
	});
});

test("drops an in-flight Git result after the presentation is disposed", async () => {
	let resolveExec: ((value: { code: number; killed: boolean; stderr: string; stdout: string }) => void) | undefined;
	const fakeApi = {
		exec: () =>
			new Promise<{ code: number; killed: boolean; stderr: string; stdout: string }>((resolve) => {
				resolveExec = resolve;
			}),
	};
	const source = new GitStatusSource();
	let notifications = 0;
	source.subscribe(() => {
		notifications += 1;
	});

	const refresh = source.refresh(fakeApi, "/workspace");
	source.dispose();
	if (!resolveExec) throw new Error("Expected the Git fixture command to start");
	resolveExec({ code: 0, killed: false, stderr: "", stdout: "## main\0 M changed.ts\0" });
	await refresh;

	expect(source.get()).toBeUndefined();
	expect(notifications).toBe(0);
});

test("drains a cwd replacement without exposing the prior snapshot as current", async () => {
	const resolvers: Array<(value: { code: number; killed: boolean; stderr: string; stdout: string }) => void> = [];
	const fakeApi = {
		exec: () =>
			new Promise<{ code: number; killed: boolean; stderr: string; stdout: string }>((resolve) => {
				resolvers.push(resolve);
			}),
	};
	const source = new GitStatusSource();

	const first = source.refresh(fakeApi, "/workspace/old");
	const latest = source.refresh(fakeApi, "/workspace/new");
	resolvers[0]?.({ code: 0, killed: false, stderr: "", stdout: "## old\0 M old.ts\0" });
	await Bun.sleep(0);
	expect(source.get("/workspace/new", "new")).toBeUndefined();
	resolvers[1]?.({ code: 0, killed: false, stderr: "", stdout: "## new\0 M first.ts\0 M second.ts\0" });
	await Promise.all([first, latest]);

	expect(source.get("/workspace/old", "old")).toBeUndefined();
	expect(source.get("/workspace/new", "new")?.unstaged).toBe(2);
});

test("binds measured counts to the matching branch without dropping a fresh snapshot", async () => {
	let porcelain = "## old-branch\0 M old-branch.ts\0";
	const fakeApi = {
		exec: async () => ({ code: 0, killed: false, stderr: "", stdout: porcelain }),
		getCommands: () => [],
		getThinkingLevel: () => "medium" as const,
	};
	const source = new GitStatusSource();
	const cwd = join(homedir(), "dev", "pi-stuff");
	await source.refresh(fakeApi, cwd);
	let branch = "old-branch";
	let notifyBranchChange: (() => void) | undefined;
	// SAFETY: this test controls the fixture or result and exercises every member of the asserted contract.
	const data = {
		getAvailableProviderCount: () => 1,
		getExtensionStatuses: () => new Map<string, string>(),
		getGitBranch: () => branch,
		onBranchChange: (listener: () => void) => {
			notifyBranchChange = listener;
			return () => {};
		},
	} as ReadonlyFooterDataProvider;
	const controller = new StatuslineController(fakeApi, {
		enabled: new ValueSource(true),
		gitChanges: source,
	});
	const component = controller.createFooter(context({}), tuiHarness().tui, theme, data);

	expect(withFormerFallbackOverride(() => component.render(120).join("\n"))).toContain(" old-branch 󰏫1");
	branch = "new-branch";
	notifyBranchChange?.();
	const changed = withFormerFallbackOverride(() => component.render(120).join("\n"));
	expect(changed).toContain("new-branch");
	expect(changed).not.toContain("new-branch *1");

	porcelain = "## new-branch\0 M first.ts\0 M second.ts\0";
	await source.refresh(fakeApi, cwd);
	notifyBranchChange?.();
	const settled = withFormerFallbackOverride(() => component.render(120).join("\n"));
	expect(settled).toContain(" new-branch 󰏫2");
});
