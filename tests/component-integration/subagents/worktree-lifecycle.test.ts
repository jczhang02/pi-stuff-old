import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { persistRecoveries } from "../../../packages/pi-stuff/src/subagents/src/runs/background/async-execution.js";
import { runConfiguredBackground } from "../../../packages/pi-stuff/src/subagents/src/runs/background/subagent-runner.js";
import {
	cleanupWorktrees,
	createWorktrees,
	diffWorktrees,
	resolveWorktreeTaskCwd,
} from "../../../packages/pi-stuff/src/subagents/src/runs/shared/worktree.js";

interface TestRepository {
	root: string;
	repo: string;
	worktreesDir: string;
}

const temporaryRoots = new Set<string>();

afterEach(() => {
	for (const root of temporaryRoots) {
		fs.rmSync(root, { recursive: true, force: true });
	}
	temporaryRoots.clear();
});

function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	if (result.status !== 0) {
		throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`);
	}
	return result.stdout.trim();
}

function branchExists(repo: string, branch: string): boolean {
	const result = spawnSync("git", ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
		encoding: "utf-8",
	});
	return result.status === 0;
}

function onlyItem<T>(items: readonly T[]): T {
	const item = items[0];
	if (!item) throw new Error("expected one item");
	return item;
}

function createRepository(): TestRepository {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-stuff-worktree-lifecycle-"));
	temporaryRoots.add(root);
	const repo = path.join(root, "repo");
	const worktreesDir = path.join(root, "worktrees");
	fs.mkdirSync(repo, { recursive: true });
	fs.mkdirSync(worktreesDir, { recursive: true });
	git(repo, ["init", "--quiet"]);
	git(repo, ["config", "user.name", "Pi Stuff Test"]);
	git(repo, ["config", "user.email", "pi-stuff@example.invalid"]);
	git(repo, ["config", "commit.gpgSign", "false"]);
	fs.writeFileSync(path.join(repo, ".gitignore"), "ignored-output.txt\n", "utf-8");
	fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n", "utf-8");
	fs.mkdirSync(path.join(repo, "sub"));
	fs.writeFileSync(path.join(repo, "sub", ".keep"), "base\n", "utf-8");
	fs.mkdirSync(path.join(repo, "sibling"));
	fs.writeFileSync(path.join(repo, "sibling", ".keep"), "base\n", "utf-8");
	git(repo, ["add", ".gitignore", "tracked.txt", "sub/.keep", "sibling/.keep"]);
	git(repo, ["commit", "--quiet", "-m", "base"]);
	return { root, repo, worktreesDir };
}

test("maps nested task directories into the matching retained worktree", () => {
	const fixture = createRepository();
	const setup = createWorktrees(fixture.repo, "nested", 1, { baseDir: fixture.worktreesDir });
	const worktree = onlyItem(setup.worktrees);

	expect(resolveWorktreeTaskCwd(worktree, fixture.repo, path.join(fixture.repo, "sub"))).toBe(
		path.join(worktree.path, "sub"),
	);
	expect(resolveWorktreeTaskCwd(worktree, fixture.repo, path.join(fixture.repo, "sibling"))).toBe(
		path.join(worktree.path, "sibling"),
	);
	expect(() => resolveWorktreeTaskCwd(worktree, fixture.repo, fixture.root)).toThrow("outside the launch directory");

	cleanupWorktrees(setup);
});

test("production runner executes file effects in the retained nested worktree", async () => {
	const fixture = createRepository();
	const writer = path.join(fixture.repo, "writer.ts");
	fs.writeFileSync(
		writer,
		'#!/usr/bin/env bun\nconst fs = await import("node:fs");\nconst name = process.env["RUNNER_PHASE"] === "resume" ? "resume-cwd.txt" : "runner-cwd.txt";\nfs.writeFileSync(name, process.cwd());\nprocess.stdout.write(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"RUNNER_CWD_RETAINED"}],stopReason:"stop",timestamp:Date.now()}})+"\\n", () => process.exit(0));\n',
		{ mode: 0o700 },
	);
	git(fixture.repo, ["add", "writer.ts"]);
	git(fixture.repo, ["commit", "--quiet", "-m", "writer"]);
	const asyncDir = path.join(fixture.root, "runner-async");
	const resultPath = path.join(asyncDir, "result.json");
	const taskCwd = path.join(fixture.repo, "sub");
	const task = {
		agent: "worker",
		task: "write cwd",
		cwd: taskCwd,
		inheritProjectContext: true,
		inheritSkills: false,
		systemPromptMode: "append" as const,
	};
	const descriptor = {
		version: 2 as const,
		sourceRunId: "runner-cwd",
		childIndex: 0,
		agent: "worker",
		cwd: taskCwd,
		systemPromptMode: "append" as const,
		inheritProjectContext: true,
		inheritSkills: false,
		maxSubagentDepth: 1,
	};
	fs.mkdirSync(asyncDir);
	persistRecoveries(asyncDir, [descriptor]);
	const previousBinary = process.env["PI_SUBAGENT_PI_BINARY"];
	const previousWorktreeDir = process.env["PI_SUBAGENTS_WORKTREE_DIR"];
	process.env["PI_SUBAGENT_PI_BINARY"] = writer;
	process.env["PI_SUBAGENTS_WORKTREE_DIR"] = fixture.worktreesDir;
	try {
		await runConfiguredBackground({
			version: 2,
			id: "runner-cwd",
			cwd: path.join(fixture.repo, "sub"),
			asyncDir,
			resultPath,
			work: { mode: "parallel", group: { tasks: [task], concurrency: 1, worktree: true } },
		});
	} finally {
		if (previousBinary === undefined) delete process.env["PI_SUBAGENT_PI_BINARY"];
		else process.env["PI_SUBAGENT_PI_BINARY"] = previousBinary;
		if (previousWorktreeDir === undefined) delete process.env["PI_SUBAGENTS_WORKTREE_DIR"];
		else process.env["PI_SUBAGENTS_WORKTREE_DIR"] = previousWorktreeDir;
	}
	const completion = JSON.parse(fs.readFileSync(resultPath, "utf8"));
	expect(completion.results[0]?.output).toContain("RUNNER_CWD_RETAINED");
	const persistedCwd = JSON.parse(fs.readFileSync(path.join(asyncDir, "recovery-descriptor.json"), "utf8")).cwd;
	const firstEffect = path.join(persistedCwd, "runner-cwd.txt");
	const resumed = Bun.spawnSync([writer], { cwd: persistedCwd, env: { ...process.env, RUNNER_PHASE: "resume" } });
	expect(resumed.exitCode).toBe(0);
	const retained = path.join(persistedCwd, "runner-cwd.txt");
	expect(fs.readFileSync(retained, "utf8")).toContain("pi-worktree-runner-cwd-0/sub");
	expect(fs.readFileSync(path.join(persistedCwd, "resume-cwd.txt"), "utf8")).toBe(
		fs.readFileSync(firstEffect, "utf8"),
	);
	expect(persistedCwd).toBe(path.join(fixture.worktreesDir, "pi-worktree-runner-cwd-0", "sub"));
});

test("turns a missing recovery descriptor into a failed result and cleans the created worktree", async () => {
	const fixture = createRepository();
	const asyncDir = path.join(fixture.root, "missing-descriptor-async");
	const resultPath = path.join(asyncDir, "result.json");
	fs.mkdirSync(asyncDir);
	const previousWorktreeDir = process.env["PI_SUBAGENTS_WORKTREE_DIR"];
	process.env["PI_SUBAGENTS_WORKTREE_DIR"] = fixture.worktreesDir;
	try {
		await runConfiguredBackground({
			version: 2,
			id: "missing-descriptor",
			cwd: fixture.repo,
			asyncDir,
			resultPath,
			work: {
				mode: "parallel",
				group: {
					tasks: [
						{
							agent: "worker",
							task: "must not execute",
							cwd: fixture.repo,
							inheritProjectContext: false,
							inheritSkills: false,
						},
					],
					concurrency: 1,
					worktree: true,
				},
			},
		});
	} finally {
		if (previousWorktreeDir === undefined) delete process.env["PI_SUBAGENTS_WORKTREE_DIR"];
		else process.env["PI_SUBAGENTS_WORKTREE_DIR"] = previousWorktreeDir;
	}
	const completion = JSON.parse(fs.readFileSync(resultPath, "utf8"));
	expect(completion.results[0]?.success).toBe(false);
	expect(completion.results[0]?.output).toContain("recovery-descriptor.json");
	expect(fs.readdirSync(fixture.worktreesDir)).toEqual([]);
});

test("removes only a verified clean worktree at the base commit", () => {
	const fixture = createRepository();
	const setup = createWorktrees(fixture.repo, "clean", 1, { baseDir: fixture.worktreesDir });
	const worktree = onlyItem(setup.worktrees);

	const report = cleanupWorktrees(setup);

	expect(report.state).toBe("complete");
	expect(report.pruned).toBe(true);
	expect(report.tasks[0]).toMatchObject({
		outcome: "removed",
		reason: "clean",
		worktreeRemoved: true,
		branchRemoved: true,
	});
	expect(fs.existsSync(worktree.path)).toBe(false);
	expect(branchExists(fixture.repo, worktree.branch)).toBe(false);
});

test("retains tracked modifications with an understandable status", () => {
	const fixture = createRepository();
	const setup = createWorktrees(fixture.repo, "tracked", 1, { baseDir: fixture.worktreesDir });
	const worktree = onlyItem(setup.worktrees);
	fs.appendFileSync(path.join(worktree.path, "tracked.txt"), "Agent edit\n", "utf-8");
	const diffs = diffWorktrees(setup, ["worker"], path.join(fixture.root, "diffs"));

	const report = cleanupWorktrees(setup);

	expect(diffs[0]?.filesChanged).toBe(1);
	expect(report.state).toBe("partial");
	expect(report.tasks[0]).toMatchObject({
		outcome: "retained",
		reason: "changes",
		worktreeRemoved: false,
		branchRemoved: false,
	});
	expect(report.tasks[0]?.message).toContain("tracked, staged, or untracked changes");
	expect(fs.readFileSync(path.join(worktree.path, "tracked.txt"), "utf-8")).toContain("Agent edit");
	expect(branchExists(fixture.repo, worktree.branch)).toBe(true);
});

test("retains untracked files instead of force-removing user data", () => {
	const fixture = createRepository();
	const setup = createWorktrees(fixture.repo, "untracked", 1, { baseDir: fixture.worktreesDir });
	const worktree = onlyItem(setup.worktrees);
	const untrackedPath = path.join(worktree.path, "agent-output.txt");
	fs.writeFileSync(untrackedPath, "keep me\n", "utf-8");

	const report = cleanupWorktrees(setup);

	expect(report.tasks[0]).toMatchObject({ outcome: "retained", reason: "changes" });
	expect(fs.readFileSync(untrackedPath, "utf-8")).toBe("keep me\n");
	expect(branchExists(fixture.repo, worktree.branch)).toBe(true);
});

test("retains ignored untracked files instead of treating them as disposable", () => {
	const fixture = createRepository();
	const setup = createWorktrees(fixture.repo, "ignored", 1, { baseDir: fixture.worktreesDir });
	const worktree = onlyItem(setup.worktrees);
	const ignoredPath = path.join(worktree.path, "ignored-output.txt");
	fs.writeFileSync(ignoredPath, "keep ignored output\n", "utf-8");

	const report = cleanupWorktrees(setup);

	expect(report.tasks[0]).toMatchObject({ outcome: "retained", reason: "changes" });
	expect(fs.readFileSync(ignoredPath, "utf-8")).toBe("keep ignored output\n");
	expect(branchExists(fixture.repo, worktree.branch)).toBe(true);
});

test("retains a clean worktree when the Agent created a commit", () => {
	const fixture = createRepository();
	const setup = createWorktrees(fixture.repo, "committed", 1, { baseDir: fixture.worktreesDir });
	const worktree = onlyItem(setup.worktrees);
	fs.appendFileSync(path.join(worktree.path, "tracked.txt"), "committed Agent edit\n", "utf-8");
	git(worktree.path, ["add", "tracked.txt"]);
	git(worktree.path, ["commit", "--quiet", "-m", "Agent commit"]);

	const report = cleanupWorktrees(setup);

	expect(report.tasks[0]).toMatchObject({
		outcome: "retained",
		reason: "commits",
		worktreeRemoved: false,
		branchRemoved: false,
	});
	expect(report.tasks[0]?.message).toContain("Agent created commits");
	expect(fs.existsSync(worktree.path)).toBe(true);
	expect(branchExists(fixture.repo, worktree.branch)).toBe(true);
});

test("retains the directory and branch when Git cannot verify state", () => {
	const fixture = createRepository();
	const setup = createWorktrees(fixture.repo, "unknown", 1, { baseDir: fixture.worktreesDir });
	const worktree = onlyItem(setup.worktrees);
	fs.writeFileSync(path.join(worktree.path, ".git"), "gitdir: /definitely/missing/pi-stuff-worktree\n", "utf-8");

	const report = cleanupWorktrees(setup);

	expect(report.state).toBe("partial");
	expect(report.pruned).toBe(false);
	expect(report.tasks[0]).toMatchObject({
		outcome: "retained",
		reason: "git-check-failed",
		worktreeRemoved: false,
		branchRemoved: false,
	});
	expect(report.tasks[0]?.message).toContain("could not verify");
	expect(report.tasks[0]?.errors?.[0]).toContain("Git status check failed");
	expect(fs.existsSync(worktree.path)).toBe(true);
	expect(branchExists(fixture.repo, worktree.branch)).toBe(true);
});

test("does not destroy hook output when worktree setup fails", () => {
	const fixture = createRepository();
	const hookPath = path.join(fixture.root, "failing-hook.sh");
	fs.writeFileSync(
		hookPath,
		"#!/bin/sh\nprintf 'preserve hook output\\n' > agent-hook-output.txt\nprintf 'setup failed\\n' >&2\nexit 7\n",
		"utf-8",
	);
	fs.chmodSync(hookPath, 0o755);

	let setupError: unknown;
	try {
		createWorktrees(fixture.repo, "hook-failure", 1, {
			baseDir: fixture.worktreesDir,
			setupHook: { hookPath },
		});
	} catch (error) {
		setupError = error;
	}

	const retainedPath = path.join(fixture.worktreesDir, "pi-worktree-hook-failure-0");
	expect(setupError).toBeInstanceOf(Error);
	expect(String(setupError)).toContain("Retained because tracked, staged, or untracked changes exist");
	expect(fs.readFileSync(path.join(retainedPath, "agent-hook-output.txt"), "utf-8")).toBe("preserve hook output\n");
	expect(branchExists(fixture.repo, "pi-parallel-hook-failure-0")).toBe(true);
});

test("refuses to remove a synthetic path through a symlinked ancestor", () => {
	const fixture = createRepository();
	const hookPath = path.join(fixture.root, "synthetic-hook.sh");
	fs.writeFileSync(
		hookPath,
		'#!/bin/sh\nmkdir -p cache/output\nprintf \'{"syntheticPaths":["cache/output"]}\\n\'\n',
		"utf-8",
	);
	fs.chmodSync(hookPath, 0o755);
	const setup = createWorktrees(fixture.repo, "synthetic-symlink", 1, {
		baseDir: fixture.worktreesDir,
		setupHook: { hookPath },
	});
	const worktree = onlyItem(setup.worktrees);
	const outside = path.join(fixture.root, "outside");
	const outsideOutput = path.join(outside, "output");
	fs.mkdirSync(outsideOutput, { recursive: true });
	const sentinel = path.join(outsideOutput, "keep.txt");
	fs.writeFileSync(sentinel, "must survive\n", "utf-8");
	fs.rmSync(path.join(worktree.path, "cache"), { recursive: true, force: true });
	fs.symlinkSync(outside, path.join(worktree.path, "cache"), "dir");

	const [diff] = diffWorktrees(setup, ["worker"], path.join(fixture.root, "diffs"));

	expect(diff?.error).toContain("symbolic-link ancestor");
	expect(fs.readFileSync(sentinel, "utf-8")).toBe("must survive\n");
	const report = cleanupWorktrees(setup);
	expect(report.tasks[0]).toMatchObject({ outcome: "retained", reason: "changes" });
	expect(fs.readFileSync(sentinel, "utf-8")).toBe("must survive\n");
});
