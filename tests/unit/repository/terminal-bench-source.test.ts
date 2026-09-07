import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freezeEvaluationSource } from "../../../scripts/terminal-bench/source.js";

const roots: string[] = [];
afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function run(root: string, ...args: string[]): Promise<void> {
	const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
	if (result.exitCode) throw new Error(result.stderr.toString());
}

async function repo(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "terminal-bench-source-"));
	roots.push(root);
	await run(root, "init", "-b", "main");
	await run(root, "config", "user.email", "test@example.com");
	await run(root, "config", "user.name", "Test");
	await mkdir(join(root, "packages/pi-stuff/src"), { recursive: true });
	await mkdir(join(root, "patches"));
	await writeFile(join(root, "packages/pi-stuff/src/index.ts"), "export const value = 1;\n");
	await writeFile(join(root, "package.json"), '{"name":"fixture"}\n');
	await writeFile(join(root, "bun.lock"), "lock-v1\n");
	await writeFile(join(root, "patches/fix.patch"), "patch\n");
	await writeFile(join(root, "docs.txt"), "exclude\n");
	await run(root, "add", ".");
	await run(root, "commit", "-m", "initial");
	return root;
}

test("freezes committed main and excludes unrelated files", async () => {
	const root = await repo();
	await writeFile(join(root, "packages/pi-stuff/src/index.ts"), "working tree\n");
	const destination = join(root, "snapshot");
	const result = await freezeEvaluationSource(root, destination);
	expect(result.source).toBe("main");
	expect(result.dirty).toBe(false);
	expect(await readFile(join(destination, "packages/pi-stuff/src/index.ts"), "utf8")).toBe(
		"export const value = 1;\n",
	);
	expect(await Bun.file(join(destination, "docs.txt")).exists()).toBe(false);
});

test("freezes registered worktree changes, deletions, and untracked Package source", async () => {
	const root = await repo();
	const worktree = join(root, "worktree with spaces");
	await run(root, "worktree", "add", "-b", "candidate", worktree);
	await writeFile(join(worktree, "packages/pi-stuff/src/index.ts"), "changed\n");
	await writeFile(join(worktree, "packages/pi-stuff/src/new.ts"), "new\n");
	await run(worktree, "rm", "bun.lock");
	const destination = join(root, "snapshot");
	const result = await freezeEvaluationSource(root, destination, worktree);
	expect(result.source).toBe("worktree");
	expect(result.dirty).toBe(true);
	expect(await readFile(join(destination, "packages/pi-stuff/src/new.ts"), "utf8")).toBe("new\n");
	expect(await Bun.file(join(destination, "bun.lock")).exists()).toBe(false);
});

test("snapshot is stable after source edits and rejects escaping symlinks", async () => {
	const root = await repo();
	const worktree = join(root, "worktree-escape");
	await run(root, "worktree", "add", worktree);
	await Bun.write(join(worktree, "packages/pi-stuff/src/new.ts"), "before\n");
	const destination = join(root, "snapshot");
	const result = await freezeEvaluationSource(root, destination, worktree);
	await Bun.write(join(worktree, "packages/pi-stuff/src/new.ts"), "after\n");
	expect(await readFile(join(result.packageDirectory, "src/new.ts"), "utf8")).toBe("before\n");
	await symlink("../../../../outside", join(worktree, "packages/pi-stuff/src/escape"));
	await run(worktree, "add", "packages/pi-stuff/src/escape");
	await run(worktree, "commit", "-m", "escape");
	const rejected = join(root, "rejected");
	await expect(freezeEvaluationSource(root, rejected, worktree)).rejects.toThrow("symlink escapes");
});

test("rejects tracked secrets and absolute symlinks before extraction", async () => {
	const root = await repo();
	const secret = join(root, "packages/pi-stuff/.env");
	await Bun.write(secret, "PRIVATE=fixture");
	await run(root, "add", "--force", "packages/pi-stuff/.env");
	await run(root, "commit", "-m", "private fixture");
	await expect(freezeEvaluationSource(root, join(root, "private-snapshot"))).rejects.toThrow("private path");
	await run(root, "rm", "packages/pi-stuff/.env");
	await symlink(join(root, "package.json"), join(root, "packages/pi-stuff/absolute"));
	await run(root, "add", "packages/pi-stuff/absolute");
	await run(root, "commit", "-m", "absolute link fixture");
	await expect(freezeEvaluationSource(root, join(root, "absolute-snapshot"))).rejects.toThrow("absolute symlink");
});
