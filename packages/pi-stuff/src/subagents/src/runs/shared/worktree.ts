import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isJsonInputObject, type JsonValue, parseJsonValue } from "../../../../shared/json-value.js";
import { isRuntimeObject, isRuntimeString } from "../../../../shared/runtime-type.js";

export interface WorktreeSetup {
	cwd: string;
	worktrees: WorktreeInfo[];
	baseCommit: string;
}

interface WorktreeInfo {
	path: string;
	agentCwd: string;
	branch: string;
	index: number;
	nodeModulesLinked: boolean;
	syntheticPaths: string[];
}

/** Map a task cwd from the repository into its corresponding worktree. */
export function resolveWorktreeTaskCwd(worktree: WorktreeInfo | undefined, repoRoot: string, taskCwd: string): string {
	if (!worktree) throw new Error("worktree isolation is missing the task worktree");
	const relative = path.relative(path.resolve(repoRoot), path.resolve(taskCwd));
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`worktree isolation cannot run task cwd outside the launch directory: ${taskCwd}`);
	}
	return path.resolve(worktree.path, relative);
}

export interface WorktreeDiff {
	index: number;
	agent: string;
	branch: string;
	diffStat: string;
	filesChanged: number;
	insertions: number;
	deletions: number;
	patchPath: string;
	error?: string;
}

export interface WorktreeCleanupTask {
	index: number;
	path: string;
	branch: string;
	outcome: "removed" | "retained" | "partial";
	reason: "clean" | "changes" | "commits" | "git-check-failed" | "worktree-removal-failed" | "branch-removal-failed";
	message: string;
	worktreeRemoved: boolean;
	branchRemoved: boolean;
	errors?: string[];
}

export interface WorktreeCleanupReport {
	state: "complete" | "partial";
	tasks: WorktreeCleanupTask[];
	pruned: boolean;
	errors?: string[];
}

interface WorktreeSetupHookConfig {
	hookPath: string;
	timeoutMs?: number;
}

interface CreateWorktreesOptions {
	agents?: string[];
	setupHook?: WorktreeSetupHookConfig;
	baseDir?: string;
}

interface ResolvedWorktreeSetupHook {
	hookPath: string;
	timeoutMs?: number;
}

interface WorktreeSetupHookInput {
	version: 1;
	repoRoot: string;
	worktreePath: string;
	agentCwd: string;
	branch: string;
	index: number;
	runId: string;
	baseCommit: string;
	agent?: string;
}

interface WorktreeSetupHookOutput {
	syntheticPaths?: string[];
}

interface GitResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

interface RepoState {
	toplevel: string;
	cwdRelative: string;
	baseCommit: string;
}

function runGit(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
	};
}

function runGitChecked(cwd: string, args: string[]): string {
	const result = runGit(cwd, args);
	if (result.status !== 0) {
		const command = `git -C ${cwd} ${args.join(" ")}`;
		const message = result.stderr.trim() || result.stdout.trim() || `${command} failed`;
		throw new Error(message);
	}
	return result.stdout;
}

function resolveRepoState(cwd: string): RepoState {
	const cwdRelative = resolveRepoCwdRelative(cwd);
	const toplevel = runGitChecked(cwd, ["rev-parse", "--show-toplevel"]).trim();

	const status = runGitChecked(toplevel, ["status", "--porcelain"]);
	if (status.trim().length > 0) {
		throw new Error("worktree isolation requires a clean git working tree. Commit or stash changes first.");
	}

	const baseCommit = runGitChecked(toplevel, ["rev-parse", "HEAD"]).trim();
	return { toplevel, cwdRelative, baseCommit };
}

function safePatchAgentName(agent: string): string {
	return agent.replace(/[^\w.-]/g, "_");
}

function buildWorktreeBranch(runId: string, index: number): string {
	return `pi-parallel-${runId}-${index}`;
}

function resolveWorktreeBaseDir(configuredBaseDir: string | undefined, repoRoot: string): string {
	const rawBaseDir = configuredBaseDir ?? process.env["PI_SUBAGENTS_WORKTREE_DIR"];
	if (rawBaseDir === undefined) return os.tmpdir();

	const trimmed = rawBaseDir.trim();
	if (!trimmed) throw new Error("worktree base directory cannot be empty");

	const expanded = trimmed.startsWith("~/") ? path.join(os.homedir(), trimmed.slice(2)) : trimmed;
	const resolved = path.isAbsolute(expanded) ? expanded : path.resolve(repoRoot, expanded);
	try {
		fs.mkdirSync(resolved, { recursive: true });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`failed to create worktree base directory ${resolved}: ${message}`);
	}
	return resolved;
}

function buildWorktreePath(baseDir: string, runId: string, index: number): string {
	return path.join(baseDir, `pi-worktree-${runId}-${index}`);
}

function resolveRepoCwdRelative(cwd: string): string {
	const repoCheck = runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
	if (repoCheck.status !== 0 || repoCheck.stdout.trim() !== "true") {
		throw new Error("worktree isolation requires a git repository");
	}
	const rawPrefix = runGitChecked(cwd, ["rev-parse", "--show-prefix"]).trim();
	const normalizedPrefix = rawPrefix ? path.normalize(rawPrefix.replace(/[\\/]+$/, "")) : "";
	return normalizedPrefix === "." ? "" : normalizedPrefix;
}

function linkNodeModulesIfPresent(toplevel: string, worktreePath: string): boolean {
	const nodeModulesPath = path.join(toplevel, "node_modules");
	const nodeModulesLinkPath = path.join(worktreePath, "node_modules");
	if (!fs.existsSync(nodeModulesPath) || fs.existsSync(nodeModulesLinkPath)) return false;
	try {
		fs.symlinkSync(nodeModulesPath, nodeModulesLinkPath);
		return true;
	} catch {
		// Symlink creation is optional (e.g., unsupported filesystems on CI runners).
		return false;
	}
}

function parseHookTimeout(timeoutMs: number | undefined): number | undefined {
	if (timeoutMs === undefined) return undefined;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("worktree setup hook timeout must be an integer greater than 0");
	}
	return timeoutMs;
}

function resolveWorktreeSetupHook(
	repoRoot: string,
	config: WorktreeSetupHookConfig | undefined,
): ResolvedWorktreeSetupHook | undefined {
	if (!config) return undefined;
	const hookPath = config.hookPath.trim();
	if (!hookPath) {
		throw new Error("worktree setup hook path cannot be empty");
	}

	const expandedHookPath = hookPath.startsWith("~/") ? path.join(os.homedir(), hookPath.slice(2)) : hookPath;
	let resolvedPath: string;
	if (path.isAbsolute(expandedHookPath)) {
		resolvedPath = expandedHookPath;
	} else if (expandedHookPath.includes("/") || expandedHookPath.includes("\\")) {
		resolvedPath = path.resolve(repoRoot, expandedHookPath);
	} else {
		throw new Error("worktree setup hook must be an absolute path or a repo-relative path");
	}

	if (!fs.existsSync(resolvedPath)) {
		throw new Error(`worktree setup hook not found: ${resolvedPath}`);
	}
	if (fs.statSync(resolvedPath).isDirectory()) {
		throw new Error(`worktree setup hook must be a file, got directory: ${resolvedPath}`);
	}

	const timeoutMs = parseHookTimeout(config.timeoutMs);
	return timeoutMs === undefined ? { hookPath: resolvedPath } : { hookPath: resolvedPath, timeoutMs };
}

function normalizeSyntheticPath(worktreePath: string, rawPath: string): string {
	const trimmed = rawPath.trim();
	if (!trimmed) throw new Error("synthetic path cannot be empty");
	if (path.isAbsolute(trimmed)) throw new Error(`synthetic path must be relative: ${rawPath}`);

	const resolved = path.resolve(worktreePath, trimmed);
	const relative = path.relative(worktreePath, resolved);
	if (!relative || relative === ".") {
		throw new Error(`synthetic path cannot target the worktree root: ${rawPath}`);
	}
	if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
		throw new Error(`synthetic path escapes the worktree root: ${rawPath}`);
	}
	return path.normalize(relative);
}

function hasTrackedEntries(worktreePath: string, relativePath: string): boolean {
	const result = runGit(worktreePath, ["ls-files", "--", relativePath]);
	return result.status === 0 && result.stdout.trim().length > 0;
}

function parseWorktreeSetupHookOutput(rawStdout: string): WorktreeSetupHookOutput {
	const trimmed = rawStdout.trim();
	if (!trimmed) {
		throw new Error("worktree setup hook returned empty stdout; expected JSON object");
	}
	let parsed: JsonValue;
	try {
		parsed = parseJsonValue(trimmed);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`worktree setup hook returned invalid JSON: ${message}`);
	}
	if (!isJsonInputObject(parsed)) {
		throw new Error("worktree setup hook stdout must be a JSON object");
	}
	const syntheticPaths = parsed["syntheticPaths"];
	if (syntheticPaths === undefined) return {};
	if (!Array.isArray(syntheticPaths)) {
		throw new Error("worktree setup hook output field 'syntheticPaths' must be an array of relative paths");
	}
	if (!syntheticPaths.every(isRuntimeString)) {
		throw new Error("worktree setup hook output field 'syntheticPaths' must contain only strings");
	}
	return { syntheticPaths };
}

function runWorktreeSetupHook(hook: ResolvedWorktreeSetupHook, input: WorktreeSetupHookInput): string[] {
	const result = spawnSync(hook.hookPath, [], {
		cwd: input.worktreePath,
		encoding: "utf-8",
		input: JSON.stringify(input),
		timeout: hook.timeoutMs,
		shell: false,
	});

	if (result.error) {
		const code = "code" in result.error ? result.error.code : undefined;
		if (code === "ETIMEDOUT") {
			throw new Error(`worktree setup hook timed out after ${hook.timeoutMs}ms`);
		}
		throw new Error(`worktree setup hook failed: ${result.error.message}`);
	}

	if (result.status !== 0) {
		const details = result.stderr.trim() || result.stdout.trim() || "no output";
		throw new Error(`worktree setup hook failed with exit code ${result.status}: ${details}`);
	}

	const output = parseWorktreeSetupHookOutput(result.stdout);
	if (output.syntheticPaths === undefined) return [];

	const uniquePaths = new Set<string>();
	for (const candidate of output.syntheticPaths) {
		const normalizedPath = normalizeSyntheticPath(input.worktreePath, candidate);
		if (hasTrackedEntries(input.worktreePath, normalizedPath)) {
			throw new Error(`worktree setup hook cannot mark tracked paths as synthetic: ${normalizedPath}`);
		}
		uniquePaths.add(normalizedPath);
	}
	return [...uniquePaths];
}

function createSingleWorktree(
	toplevel: string,
	cwdRelative: string,
	runId: string,
	index: number,
	baseCommit: string,
	setupHook: ResolvedWorktreeSetupHook | undefined,
	agent: string | undefined,
	baseDir: string,
): WorktreeInfo {
	const branch = buildWorktreeBranch(runId, index);
	const worktreePath = buildWorktreePath(baseDir, runId, index);
	const add = runGit(toplevel, ["worktree", "add", worktreePath, "-b", branch, "HEAD"]);
	if (add.status !== 0) {
		const message = add.stderr.trim() || add.stdout.trim() || `failed to create worktree ${worktreePath}`;
		throw new Error(message);
	}

	const agentCwd = cwdRelative ? path.join(worktreePath, cwdRelative) : worktreePath;
	let nodeModulesLinked = false;
	const syntheticPaths: string[] = [];
	try {
		nodeModulesLinked = linkNodeModulesIfPresent(toplevel, worktreePath);
		if (nodeModulesLinked) syntheticPaths.push("node_modules");

		if (setupHook) {
			const hookInput: WorktreeSetupHookInput = {
				version: 1,
				repoRoot: toplevel,
				worktreePath,
				agentCwd,
				branch,
				index,
				runId,
				baseCommit,
			};
			const hookSyntheticPaths = runWorktreeSetupHook(
				setupHook,
				agent === undefined ? hookInput : { ...hookInput, agent },
			);
			syntheticPaths.push(...hookSyntheticPaths);
		}

		return {
			path: worktreePath,
			agentCwd,
			branch,
			index,
			nodeModulesLinked,
			syntheticPaths,
		};
	} catch (error) {
		const cleanup = cleanupSingleWorktree(
			toplevel,
			{
				path: worktreePath,
				agentCwd,
				branch,
				index,
				nodeModulesLinked,
				syntheticPaths,
			},
			baseCommit,
		);
		if (cleanup.outcome !== "removed") {
			const originalMessage = error instanceof Error ? error.message : String(error);
			throw new Error(`${originalMessage}\n${cleanup.message}`);
		}
		throw error;
	}
}

function removeSyntheticPath(worktree: WorktreeInfo, syntheticPath: string): void {
	const resolved = path.resolve(worktree.path, syntheticPath);
	const relative = path.relative(worktree.path, resolved);
	if (
		!relative ||
		relative === "." ||
		relative === ".." ||
		relative.startsWith(`..${path.sep}`) ||
		path.isAbsolute(relative)
	) {
		return;
	}

	let ancestor = worktree.path;
	const components = relative.split(path.sep);
	for (const component of components.slice(0, -1)) {
		ancestor = path.join(ancestor, component);
		let ancestorStat: fs.Stats;
		try {
			ancestorStat = fs.lstatSync(ancestor);
		} catch (error) {
			const code = error && isRuntimeObject(error) && "code" in error ? error.code : undefined;
			if (code === "ENOENT") return;
			throw error;
		}
		if (ancestorStat.isSymbolicLink()) {
			throw new Error(
				`Refusing to remove synthetic path '${syntheticPath}' through symbolic-link ancestor '${ancestor}'.`,
			);
		}
		if (!ancestorStat.isDirectory()) return;
	}

	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(resolved);
	} catch (error) {
		const code = error && isRuntimeObject(error) && "code" in error ? error.code : undefined;
		if (code === "ENOENT") return;
		throw error;
	}

	if (stat.isSymbolicLink()) {
		fs.unlinkSync(resolved);
		return;
	}
	if (stat.isDirectory()) {
		fs.rmSync(resolved, { recursive: true, force: true });
		return;
	}
	fs.rmSync(resolved, { force: true });
}

function removeSyntheticPathsBeforeDiff(worktree: WorktreeInfo): void {
	if (worktree.syntheticPaths.length === 0) return;
	const seen = new Set<string>();
	for (const syntheticPath of worktree.syntheticPaths) {
		if (seen.has(syntheticPath)) continue;
		seen.add(syntheticPath);
		removeSyntheticPath(worktree, syntheticPath);
	}
}

function emptyDiff(index: number, agent: string, branch: string, patchPath: string, error?: string): WorktreeDiff {
	const diff: WorktreeDiff = {
		index,
		agent,
		branch,
		diffStat: "",
		filesChanged: 0,
		insertions: 0,
		deletions: 0,
		patchPath,
	};
	if (error) diff.error = error;
	return diff;
}

function parseNumstat(numstat: string) {
	const lines = numstat
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	let filesChanged = 0;
	let insertions = 0;
	let deletions = 0;

	for (const line of lines) {
		const [rawInsertions, rawDeletions] = line.split("\t");
		if (rawInsertions === undefined || rawDeletions === undefined) continue;
		filesChanged++;
		if (/^\d+$/.test(rawInsertions)) insertions += parseInt(rawInsertions, 10);
		if (/^\d+$/.test(rawDeletions)) deletions += parseInt(rawDeletions, 10);
	}

	return { filesChanged, insertions, deletions };
}

function captureWorktreeDiff(
	setup: WorktreeSetup,
	worktree: WorktreeInfo,
	agent: string,
	patchPath: string,
): WorktreeDiff {
	removeSyntheticPathsBeforeDiff(worktree);
	runGitChecked(worktree.path, ["add", "-A"]);
	const diffStat = runGitChecked(worktree.path, ["diff", "--cached", "--stat", setup.baseCommit]).trim();
	const patch = runGitChecked(worktree.path, ["diff", "--cached", setup.baseCommit]);
	const numstat = runGitChecked(worktree.path, ["diff", "--cached", "--numstat", setup.baseCommit]);
	fs.writeFileSync(patchPath, patch, "utf-8");

	if (!patch.trim()) {
		return emptyDiff(worktree.index, agent, worktree.branch, patchPath);
	}

	const parsed = parseNumstat(numstat);
	return {
		index: worktree.index,
		agent,
		branch: worktree.branch,
		diffStat,
		filesChanged: parsed.filesChanged,
		insertions: parsed.insertions,
		deletions: parsed.deletions,
		patchPath,
	};
}

function writeEmptyPatch(patchPath: string): void {
	try {
		fs.writeFileSync(patchPath, "", "utf-8");
	} catch {
		// Diff artifact writing is best-effort in error paths.
	}
}

function gitFailureMessage(result: GitResult): string {
	return result.stderr.trim() || result.stdout.trim() || "Git command failed without an error message";
}

function retainedWorktree(
	worktree: WorktreeInfo,
	reason: "changes" | "commits" | "git-check-failed" | "worktree-removal-failed",
	message: string,
	error?: string,
): WorktreeCleanupTask {
	const task: WorktreeCleanupTask = {
		index: worktree.index,
		path: worktree.path,
		branch: worktree.branch,
		outcome: "retained",
		reason,
		message,
		worktreeRemoved: false,
		branchRemoved: false,
	};
	if (error) task.errors = [error];
	return task;
}

function cleanupSingleWorktree(repoCwd: string, worktree: WorktreeInfo, baseCommit: string): WorktreeCleanupTask {
	const status = runGit(worktree.path, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"]);
	if (status.status !== 0) {
		const error = `Git status check failed: ${gitFailureMessage(status)}`;
		return retainedWorktree(
			worktree,
			"git-check-failed",
			`Retained because Git could not verify the worktree state. Inspect ${worktree.path} manually.`,
			error,
		);
	}
	if (status.stdout.trim().length > 0) {
		return retainedWorktree(
			worktree,
			"changes",
			`Retained because tracked, staged, or untracked changes exist at ${worktree.path}.`,
		);
	}

	const head = runGit(worktree.path, ["rev-parse", "HEAD"]);
	if (head.status !== 0) {
		const error = `Git HEAD check failed: ${gitFailureMessage(head)}`;
		return retainedWorktree(
			worktree,
			"git-check-failed",
			`Retained because Git could not verify the worktree commit. Inspect ${worktree.path} manually.`,
			error,
		);
	}
	if (head.stdout.trim() !== baseCommit) {
		return retainedWorktree(worktree, "commits", `Retained because the Agent created commits on ${worktree.branch}.`);
	}

	const remove = runGit(repoCwd, ["worktree", "remove", worktree.path]);
	if (remove.status !== 0) {
		const error = `Worktree removal failed: ${gitFailureMessage(remove)}`;
		return retainedWorktree(
			worktree,
			"worktree-removal-failed",
			`Retained because the clean worktree could not be removed safely. Inspect ${worktree.path} manually.`,
			error,
		);
	}

	const removeBranch = runGit(repoCwd, ["branch", "-d", worktree.branch]);
	if (removeBranch.status !== 0) {
		const error = `Branch removal failed: ${gitFailureMessage(removeBranch)}`;
		return {
			index: worktree.index,
			path: worktree.path,
			branch: worktree.branch,
			outcome: "partial",
			reason: "branch-removal-failed",
			message: `Removed the clean worktree, but retained branch ${worktree.branch} because Git would not delete it safely.`,
			worktreeRemoved: true,
			branchRemoved: false,
			errors: [error],
		};
	}

	return {
		index: worktree.index,
		path: worktree.path,
		branch: worktree.branch,
		outcome: "removed",
		reason: "clean",
		message: "Removed after verifying that the worktree was clean and had no Agent commits.",
		worktreeRemoved: true,
		branchRemoved: true,
	};
}

function hasWorktreeChanges(diff: WorktreeDiff): boolean {
	return diff.filesChanged > 0 || diff.insertions > 0 || diff.deletions > 0 || diff.diffStat.trim().length > 0;
}

export function createWorktrees(
	cwd: string,
	runId: string,
	count: number,
	options?: CreateWorktreesOptions,
): WorktreeSetup {
	const repo = resolveRepoState(cwd);
	const setupHook = resolveWorktreeSetupHook(repo.toplevel, options?.setupHook);
	const baseDir = resolveWorktreeBaseDir(options?.baseDir, repo.toplevel);
	const worktrees: WorktreeInfo[] = [];

	try {
		for (let index = 0; index < count; index++) {
			worktrees.push(
				createSingleWorktree(
					repo.toplevel,
					repo.cwdRelative,
					runId,
					index,
					repo.baseCommit,
					setupHook,
					options?.agents?.[index],
					baseDir,
				),
			);
		}
	} catch (error) {
		cleanupWorktrees({
			cwd: repo.toplevel,
			worktrees,
			baseCommit: repo.baseCommit,
		});
		throw error;
	}

	return {
		cwd: repo.toplevel,
		worktrees,
		baseCommit: repo.baseCommit,
	};
}

export function diffWorktrees(setup: WorktreeSetup, agents: string[], diffsDir: string): WorktreeDiff[] {
	try {
		fs.mkdirSync(diffsDir, { recursive: true });
	} catch {
		// Returning no diffs is safer than failing the whole command on artifact-dir issues.
		return [];
	}

	const diffs: WorktreeDiff[] = [];
	for (const [index, worktree] of setup.worktrees.entries()) {
		const agent = agents[index] ?? `task-${index + 1}`;
		const patchPath = path.join(diffsDir, `task-${index}-${safePatchAgentName(agent)}.patch`);
		try {
			diffs.push(captureWorktreeDiff(setup, worktree, agent, patchPath));
		} catch (error) {
			// Preserve execution flow while retaining the failed capture as handoff evidence.
			writeEmptyPatch(patchPath);
			diffs.push(
				emptyDiff(index, agent, worktree.branch, patchPath, error instanceof Error ? error.message : String(error)),
			);
		}
	}

	return diffs;
}

export function cleanupWorktrees(setup: WorktreeSetup): WorktreeCleanupReport {
	const tasks: WorktreeCleanupTask[] = [];
	for (let index = setup.worktrees.length - 1; index >= 0; index--) {
		const worktree = setup.worktrees[index];
		if (!worktree) continue;
		tasks.push(cleanupSingleWorktree(setup.cwd, worktree, setup.baseCommit));
	}
	tasks.sort((left, right) => left.index - right.index);
	const errors: string[] = [];
	let pruned = false;
	const allRemoved = tasks.every((task) => task.worktreeRemoved && task.branchRemoved);
	if (allRemoved) {
		try {
			runGitChecked(setup.cwd, ["worktree", "prune"]);
			pruned = true;
		} catch (error) {
			errors.push(`worktree prune failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	const state = allRemoved && pruned ? "complete" : "partial";
	const report: WorktreeCleanupReport = {
		state,
		tasks,
		pruned,
	};
	if (errors.length) report.errors = errors;
	return report;
}

export function formatWorktreeDiffSummary(diffs: WorktreeDiff[]): string {
	const changed = diffs.filter(hasWorktreeChanges);
	if (changed.length === 0) return "";

	const lines: string[] = ["=== Worktree Changes ===", ""];
	for (const diff of changed) {
		lines.push(
			`--- Task ${diff.index + 1} (${diff.agent}): ${diff.filesChanged} files changed, +${diff.insertions} -${diff.deletions} ---`,
		);
		if (diff.diffStat.trim().length > 0) {
			lines.push(diff.diffStat);
		}
		lines.push("");
	}

	const firstChanged = changed[0];
	if (!firstChanged) return "";
	const patchesDir = path.dirname(firstChanged.patchPath);
	lines.push(`Full patches: ${patchesDir}`);
	return lines.join("\n").trimEnd();
}
