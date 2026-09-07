import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";

const SELECTED = ["packages/pi-stuff", "package.json", "bun.lock", "patches"];

export type FrozenEvaluationSource = {
	revision: string;
	treeSha: string;
	snapshotSha256: string;
	packageDirectory: string;
	directory: string;
	source: "main" | "worktree";
	dirty: boolean;
};

async function git(root: string, args: string[], env?: Record<string, string>): Promise<string> {
	const result = Bun.spawnSync(["git", ...args], {
		cwd: root,
		env: { ...process.env, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim() || `git ${args.join(" ")} failed`);
	return result.stdout.toString().trim();
}

function under(path: string, root: string): boolean {
	const rel = relative(root, path);
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep));
}

async function validateTree(root: string, tree: string): Promise<void> {
	const raw = Bun.spawnSync(["git", "ls-tree", "-r", "-z", tree, "--", ...SELECTED], {
		cwd: root,
		stdout: "pipe",
		stderr: "pipe",
	});
	if (raw.exitCode !== 0) throw new Error(raw.stderr.toString().trim());
	const staging = resolve(root);
	const links = new Map<string, string>();
	for (const record of raw.stdout.toString().split("\0")) {
		if (!record) continue;
		const tab = record.indexOf("\t");
		const fields = record.slice(0, tab).split(" ");
		const mode = fields[0];
		const object = fields[2];
		if (!mode || !object) continue;
		const path = record.slice(tab + 1);
		if (path.split("/").some((part) => /^(?:\.env(?:\..*)?|\.cache|cache|credentials?|secrets?)$/i.test(part))) {
			throw new Error(`private path is not allowed in evaluation source: ${path}`);
		}
		if (mode === "120000") links.set(path, (await git(root, ["cat-file", "blob", object])).trim());
	}
	for (const [path, target] of links) {
		let linkTarget = target;
		if (linkTarget.startsWith("/")) throw new Error(`absolute symlink is not allowed: ${path} -> ${linkTarget}`);
		let current = path;
		const seen = new Set<string>();
		while (true) {
			const next = resolve(dirname(resolve(staging, current)), linkTarget);
			if (!under(next, staging)) throw new Error(`symlink escapes evaluation staging: ${path} -> ${linkTarget}`);
			const nextRelative = relative(staging, next).split(sep).join("/");
			const nextTarget = links.get(nextRelative);
			if (nextTarget === undefined) break;
			if (seen.has(nextRelative)) throw new Error(`symlink cycle in evaluation source: ${path}`);
			seen.add(nextRelative);
			current = nextRelative;
			linkTarget = nextTarget;
			if (linkTarget.startsWith("/"))
				throw new Error(`absolute symlink is not allowed: ${current} -> ${linkTarget}`);
		}
	}
}

export async function freezeEvaluationSource(
	repositoryRoot: string,
	destination: string,
	worktree?: string,
): Promise<FrozenEvaluationSource> {
	const root = await realpath(repositoryRoot);
	const directory = resolve(destination);
	const sourceRoot = worktree ? await realpath(worktree) : root;
	const common = await realpath(resolve(root, await git(root, ["rev-parse", "--git-common-dir"])));
	const sourceCommon = await realpath(resolve(sourceRoot, await git(sourceRoot, ["rev-parse", "--git-common-dir"])));
	if (common !== sourceCommon) throw new Error("evaluation worktree belongs to a different Git repository");
	if (worktree) {
		const listed = (await git(root, ["worktree", "list", "--porcelain", "-z"]))
			.split("\0")
			.filter((field) => field.startsWith("worktree "))
			.map((field) => field.slice("worktree ".length));
		if (!listed.some((path) => path === sourceRoot))
			throw new Error("evaluation worktree is not registered with this Git repository");
	}
	await mkdir(directory, { recursive: true });
	if (
		(await stat(directory)).isDirectory() &&
		(await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: directory, dot: true }))).length
	) {
		throw new Error("evaluation destination must be empty");
	}

	const revision = await git(sourceRoot, ["rev-parse", worktree ? "HEAD" : "refs/heads/main"]);
	const dirty = Boolean(
		worktree && (await git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...SELECTED])),
	);
	let treeSha = await git(root, ["rev-parse", `${revision}^{tree}`]);
	let indexFile: string | undefined;
	try {
		if (worktree) {
			indexFile = join(await mkdtemp(join(tmpdir(), "pi-stuff-index-")), "index");
			const env = { GIT_INDEX_FILE: indexFile };
			await git(sourceRoot, ["read-tree", "--empty"], env);
			const existing: string[] = [];
			for (const path of SELECTED) {
				if (
					await stat(join(sourceRoot, path)).then(
						() => true,
						() => false,
					)
				)
					existing.push(path);
			}
			if (!existing.length) throw new Error("evaluation source contains no selected files");
			await git(sourceRoot, ["add", "--all", "--", ...existing], env);
			treeSha = await git(sourceRoot, ["write-tree"], env);
		}
		await validateTree(sourceRoot, treeSha);
		const archive = join(await mkdtemp(join(tmpdir(), "pi-stuff-archive-")), "source.tar");
		try {
			const selected: string[] = [];
			for (const path of SELECTED) {
				const probe = Bun.spawnSync(["git", "cat-file", "-e", `${treeSha}:${path}`], {
					cwd: sourceRoot,
					stderr: "ignore",
				});
				if (probe.exitCode === 0) selected.push(path);
			}
			if (selected.length === 0) throw new Error("evaluation source contains no selected files");
			const result = Bun.spawnSync(
				[
					"git",
					"archive",
					"--format=tar",
					"--output",
					archive,
					treeSha,
					...selected,
					":(exclude)**/node_modules/**",
				],
				{ cwd: sourceRoot, stderr: "pipe" },
			);
			if (result.exitCode !== 0) throw new Error(result.stderr.toString().trim());
			const extract = Bun.spawnSync(["tar", "-xf", archive, "-C", directory, "--no-same-owner"], { stderr: "pipe" });
			if (extract.exitCode !== 0) throw new Error(extract.stderr.toString().trim());
			const bytes = await Bun.file(archive).arrayBuffer();
			const snapshotSha256 = createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
			return {
				revision,
				treeSha,
				snapshotSha256,
				packageDirectory: join(directory, "packages/pi-stuff"),
				directory,
				source: worktree ? "worktree" : "main",
				dirty,
			};
		} finally {
			await rm(dirname(archive), { recursive: true, force: true });
		}
	} finally {
		if (indexFile) await rm(dirname(indexFile), { recursive: true, force: true });
	}
}
