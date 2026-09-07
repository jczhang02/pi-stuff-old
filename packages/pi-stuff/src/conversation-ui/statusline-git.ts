import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sanitizeOneLine } from "./terminal-text.ts";

const GIT_STATUS_TIMEOUT_MS = 2_000;

export interface GitChangeCounts {
	readonly ahead?: number;
	readonly behind?: number;
	readonly conflicted?: number;
	readonly staged: number;
	readonly unstaged: number;
	readonly untracked: number;
}

export interface GitChangeCountsSource {
	get(cwd?: string, branch?: string): GitChangeCounts | undefined;
	subscribe(listener: () => void): () => void;
}

type GitStatusHost = Pick<ExtensionAPI, "exec">;

/**
 * Mutable Git summary refreshed by the integration layer after accepted Host
 * lifecycle events. Construction and session startup remain free of subprocess
 * work.
 */
export class GitStatusSource implements GitChangeCountsSource {
	private counts: GitChangeCounts | undefined;
	private disposed = false;
	private generation = 0;
	private readonly listeners = new Set<() => void>();
	private measuredBranch: string | undefined;
	private measuredCwd: string | undefined;
	private refreshPromise: Promise<void> | undefined;
	private requestedCwd: string | undefined;

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.generation += 1;
		this.requestedCwd = undefined;
		this.listeners.clear();
	}

	get(cwd?: string, branch?: string): GitChangeCounts | undefined {
		if (cwd !== undefined && cwd !== this.measuredCwd) return undefined;
		if (branch !== undefined && branch !== this.measuredBranch) return undefined;
		return this.counts;
	}

	refresh(pi: GitStatusHost, cwd: string): Promise<void> {
		if (this.disposed) return Promise.resolve();
		this.requestedCwd = cwd;
		if (this.refreshPromise) return this.refreshPromise;
		const refresh = this.drainRefreshes(pi);
		const completion = refresh.finally(() => {
			if (this.refreshPromise === completion) this.refreshPromise = undefined;
		});
		this.refreshPromise = completion;
		return completion;
	}

	private async drainRefreshes(pi: GitStatusHost): Promise<void> {
		while (!this.disposed && this.requestedCwd !== undefined) {
			const cwd = this.requestedCwd;
			this.requestedCwd = undefined;
			await this.performRefresh(pi, cwd);
		}
	}

	private async performRefresh(pi: GitStatusHost, cwd: string): Promise<void> {
		const generation = ++this.generation;
		let next: GitChangeCounts | undefined;
		let nextBranch: string | undefined;
		try {
			const result = await pi.exec(
				"git",
				["--no-optional-locks", "status", "--porcelain=v1", "-z", "--branch", "--untracked-files=normal"],
				{ cwd, timeout: GIT_STATUS_TIMEOUT_MS },
			);
			if (!result.killed && result.code === 0) {
				next = parseGitStatusPorcelain(result.stdout);
				nextBranch = parseGitBranchPorcelain(result.stdout);
			}
		} catch {
			// Missing Git and a non-repository cwd are ordinary Statusline states.
			next = undefined;
		}
		if (this.disposed || generation !== this.generation) return;
		this.set(next, next ? cwd : undefined, nextBranch);
	}

	subscribe(listener: () => void): () => void {
		if (this.disposed) return () => {};
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private set(next: GitChangeCounts | undefined, measuredCwd?: string, measuredBranch?: string): void {
		if (
			sameGitCounts(this.counts, next) &&
			this.measuredCwd === measuredCwd &&
			this.measuredBranch === measuredBranch
		) {
			return;
		}
		this.counts = next;
		this.measuredCwd = measuredCwd;
		this.measuredBranch = measuredBranch;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				// Presentation observers are recoverable and independent.
			}
		}
	}
}

/** Interpret NUL-delimited `git status --porcelain=v1 -z` output. */
export function parseGitStatusPorcelain(output: string): GitChangeCounts {
	let ahead = 0;
	let behind = 0;
	let conflicted = 0;
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	const records = output.split("\0");
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index] ?? "";
		if (record.startsWith("## ")) {
			ahead = parseGitTrackingCount(record, "ahead");
			behind = parseGitTrackingCount(record, "behind");
			continue;
		}
		if (record.length < 3) continue;
		const indexStatus = record[0] ?? " ";
		const worktreeStatus = record[1] ?? " ";
		if (indexStatus === "!" && worktreeStatus === "!") continue;

		if (isGitConflict(indexStatus, worktreeStatus)) {
			conflicted += 1;
		} else if (indexStatus === "?" && worktreeStatus === "?") {
			untracked += 1;
		} else {
			if (indexStatus !== " ") staged += 1;
			if (worktreeStatus !== " ") unstaged += 1;
		}

		// Rename/copy records carry a second NUL-delimited path with no status.
		if (/[RC]/u.test(indexStatus) || /[RC]/u.test(worktreeStatus)) index += 1;
	}
	return { ahead, behind, conflicted, staged, unstaged, untracked };
}

function parseGitTrackingCount(header: string, label: "ahead" | "behind"): number {
	const match = header.match(new RegExp(`\\b${label} (\\d+)(?:[,\\]]|$)`, "u"));
	return match?.[1] ? Number.parseInt(match[1], 10) : 0;
}

function isGitConflict(indexStatus: string, worktreeStatus: string): boolean {
	return ["DD", "AU", "UD", "UA", "DU", "AA", "UU"].includes(`${indexStatus}${worktreeStatus}`);
}

function parseGitBranchPorcelain(output: string): string | undefined {
	const header = output.split("\0", 1)[0];
	if (!header?.startsWith("## ")) return undefined;
	const value = header.slice(3);
	for (const prefix of ["No commits yet on ", "Initial commit on "]) {
		if (value.startsWith(prefix)) return sanitizeOneLine(value.slice(prefix.length)) || undefined;
	}
	if (value === "HEAD (no branch)") return "detached";
	const upstream = value.indexOf("...");
	return sanitizeOneLine(upstream >= 0 ? value.slice(0, upstream) : value) || undefined;
}

function sameGitCounts(left: GitChangeCounts | undefined, right: GitChangeCounts | undefined): boolean {
	return (
		left === right ||
		(left !== undefined &&
			right !== undefined &&
			(left.ahead ?? 0) === (right.ahead ?? 0) &&
			(left.behind ?? 0) === (right.behind ?? 0) &&
			(left.conflicted ?? 0) === (right.conflicted ?? 0) &&
			left.staged === right.staged &&
			left.unstaged === right.unstaged &&
			left.untracked === right.untracked)
	);
}
