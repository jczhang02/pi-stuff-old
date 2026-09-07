import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { buildVerificationPlan, selectAffectedTests } from "../../../scripts/verification-plan.ts";

function git(root: string, args: string[]): string {
	const result = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], { cwd: root });
	if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	return result.stdout.toString().trim();
}
async function put(root: string, path: string, text: string): Promise<void> {
	await mkdir(dirname(join(root, path)), { recursive: true });
	await writeFile(join(root, path), text);
}
async function repo(): Promise<{ root: string; base: string }> {
	const root = await mkdtemp(join(tmpdir(), "pi-stuff-plan-"));
	await mkdir(join(root, "tests/unit/alpha"), { recursive: true });
	await writeFile(
		join(root, "tests/unit/alpha/alpha.test.ts"),
		'import { test } from "bun:test"; test("alpha", () => {});\n',
	);
	await writeFile(join(root, "README.md"), "one\n");
	await put(root, "packages/pi-stuff/suite.json", JSON.stringify({ capabilities: ["alpha", "beta", "gamma"] }));
	await put(root, "packages/pi-stuff/src/alpha/value.ts", "export const value = 1;");
	await put(root, "packages/pi-stuff/src/beta/use.ts", 'import "../alpha/value.js";');
	await put(root, "tests/helpers/bridge.ts", 'export * from "../../packages/pi-stuff/src/beta/use.js";');
	await put(root, "tests/unit/beta/beta.test.ts", 'import "../../helpers/bridge.js";');
	await put(root, "tests/unit/gamma/gamma.test.ts", "// unrelated");
	git(root, ["init", "-q"]);
	git(root, ["config", "user.email", "test@example.invalid"]);
	git(root, ["config", "user.name", "test"]);
	git(root, ["add", "."]);
	git(root, ["commit", "-qm", "initial"]);
	const base = git(root, ["rev-parse", "HEAD"]);
	return { root, base };
}

describe("verification plan", () => {
	test("pure metadata changes require no tests", async () => {
		const { root, base } = await repo();
		try {
			await writeFile(join(root, "README.md"), "two\n");
			const plan = buildVerificationPlan(root, { VERIFY_BASE: base });
			expect(plan.mode).toBe("none");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("invalid base falls back to all tests", async () => {
		const { root } = await repo();
		try {
			const plan = buildVerificationPlan(root, { VERIFY_BASE: "bad-base" });
			expect(plan.mode).toBe("all");
			expect(plan.reason).toContain("invalid");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("local scope unions committed, staged, unstaged, and untracked paths", async () => {
		const { root, base } = await repo();
		try {
			await writeFile(join(root, "committed.ts"), "export const committed = 1;\n");
			Bun.spawnSync(["git", "add", "committed.ts"], { cwd: root });
			Bun.spawnSync(["git", "commit", "-qm", "change"], { cwd: root });
			await writeFile(join(root, "committed.ts"), "export const committed = 2;\n");
			await writeFile(join(root, "untracked.ts"), "export const untracked = 1;\n");
			const plan = buildVerificationPlan(root, { VERIFY_BASE: base });
			expect(plan.changedFiles).toEqual(["committed.ts", "untracked.ts"]);
			expect(plan.mode).toBe("all");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("removed executable markdown is not metadata-only", async () => {
		const { root, base } = await repo();
		try {
			await writeFile(join(root, "README.md"), "~~~bash\necho unsafe\n~~~\n");
			Bun.spawnSync(["git", "add", "README.md"], { cwd: root });
			Bun.spawnSync(["git", "commit", "-qm", "docs"], { cwd: root });
			Bun.spawnSync(["git", "rm", "-q", "README.md"], { cwd: root });
			const plan = buildVerificationPlan(root, { VERIFY_BASE: base });
			expect(plan.mode).toBe("all");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

test("Capability selection follows side-effect imports and transitive test helpers", async () => {
	const { root, base } = await repo();
	try {
		await put(root, "packages/pi-stuff/src/alpha/value.ts", "export const value = 2;");
		const selected = buildVerificationPlan(root, { VERIFY_BASE: "HEAD" });
		expect(selected.mode).toBe("selected");
		expect(selected.files).toEqual(["tests/unit/alpha/alpha.test.ts", "tests/unit/beta/beta.test.ts"]);
		expect(selected.acceptanceMatrix).toBe("representative");
		await put(root, "packages/pi-stuff/src/alpha/width.ts", "export const width = 1;");
		const dimensionChange = buildVerificationPlan(root, { VERIFY_BASE: "HEAD" });
		expect(dimensionChange.mode).toBe("selected");
		expect(dimensionChange.acceptanceMatrix).toBe("full");
		await put(root, "mystery.txt", "unknown");
		expect(buildVerificationPlan(root, { VERIFY_BASE: base }).mode).toBe("all");
		await rm(join(root, "mystery.txt"));
		await put(root, "README.md", "```custom\nrun it\n```");
		expect(buildVerificationPlan(root, { VERIFY_BASE: base }).mode).toBe("all");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("local range retains staged edits undone in worktree and committed paths", async () => {
	const { root, base } = await repo();
	try {
		await put(root, "committed.md", "prose");
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "committed"]);
		await put(root, "README.md", "staged");
		git(root, ["add", "README.md"]);
		await put(root, "README.md", "one\n");
		await put(root, "unstaged.md", "new");
		git(root, ["add", "unstaged.md"]);
		await put(root, "untracked.md", "new");
		expect(buildVerificationPlan(root, { VERIFY_BASE: base }).changedFiles).toEqual([
			"README.md",
			"committed.md",
			"unstaged.md",
			"untracked.md",
		]);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("CI ranges fail closed, while push and PR use committed changes", async () => {
	const { root, base } = await repo();
	try {
		const ci = { VERIFICATION_PLAN_CI: "1", GITHUB_EVENT_NAME: "push", CI_BASE_SHA: base };
		expect(buildVerificationPlan(root, { VERIFY_BASE: base }).mode).toBe("all");
		await put(root, "README.md", "pure prose");
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "docs"]);
		const head = git(root, ["rev-parse", "HEAD"]);
		expect(buildVerificationPlan(root, ci).mode).toBe("all");
		for (const event of ["push", "pull_request"])
			expect(buildVerificationPlan(root, { ...ci, GITHUB_EVENT_NAME: event, CI_HEAD_SHA: head }).mode).toBe("none");
		expect(
			buildVerificationPlan(root, { ...ci, GITHUB_EVENT_NAME: "workflow_dispatch", CI_HEAD_SHA: head }).mode,
		).toBe("all");
		await put(root, ".beads/executable.sh", "echo hello");
		expect(buildVerificationPlan(root, { VERIFY_BASE: base }).mode).toBe("all");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
test("planner help and invalid arguments leave no artifact", async () => {
	const { root } = await repo();
	try {
		const script = resolve("scripts/verification-plan.ts");
		for (const [args, status] of [
			[["--help"], 0],
			[["--unknown"], 1],
		] as const) {
			const result = Bun.spawnSync([process.execPath, script, ...args], { cwd: root });
			expect(result.exitCode).toBe(status);
			expect(await Bun.file(join(root, ".artifacts/verification-plan.json")).exists()).toBe(false);
		}
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("script helpers participate in reverse selection without unrelated opaque imports widening it", async () => {
	const { root } = await repo();
	try {
		await put(root, "scripts/detached-process.ts", 'export * from "../packages/pi-stuff/src/alpha/value.js";');
		await put(root, "tests/unit/gamma/gamma.test.ts", 'import "../../../scripts/detached-process.js";');
		await put(root, "tests/unit/delta/delta.test.ts", "// unrelated");
		await put(root, "scripts/unrelated.ts", "import(await process.env.UNRELATED_MODULE ?? './missing.js');");
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "shared helper"]);
		await put(root, "packages/pi-stuff/src/alpha/value.ts", "export const value = 2;");
		const selected = buildVerificationPlan(root, { VERIFY_BASE: "HEAD" });
		expect(selected.mode).toBe("selected");
		expect(selected.files).toEqual([
			"tests/unit/alpha/alpha.test.ts",
			"tests/unit/beta/beta.test.ts",
			"tests/unit/gamma/gamma.test.ts",
		]);
		expect(selected.acceptanceMatrix).toBe("representative");
		await put(root, "scripts/unrelated.ts", "import(await process.env.UNRELATED_MODULE ?? './changed.js');\n");
		expect(buildVerificationPlan(root, { VERIFY_BASE: "HEAD" }).mode).toBe("all");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("an unbounded dynamic consumer cannot hide impact on another Capability", async () => {
	const { root } = await repo();
	try {
		await put(
			root,
			"packages/pi-stuff/src/gamma/consumer.ts",
			'export const load = () => import(process.env.MODULE_PATH ?? "./module.ts");',
		);
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "dynamic consumer"]);
		await put(root, "packages/pi-stuff/src/alpha/value.ts", "export const value = 2;");
		expect(buildVerificationPlan(root, { VERIFY_BASE: "HEAD" }).mode).toBe("all");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("declared dynamic dependencies expire when their importing source changes", async () => {
	const { root } = await repo();
	try {
		const file = "packages/pi-stuff/src/gamma/consumer.ts";
		const source = "export const load = () => import(process.env.MODULE_PATH);";
		await put(root, file, source);
		await put(
			root,
			"config/verification-dependencies.json",
			JSON.stringify({
				[file]: {
					sha256: createHash("sha256").update(source).digest("hex"),
					dependencies: [],
					reason: "Fixture external dependency",
				},
			}),
		);
		git(root, ["add", "."]);
		git(root, ["commit", "-qm", "declared external dependency"]);
		await put(root, "packages/pi-stuff/src/alpha/value.ts", "export const value = 2;");
		expect(buildVerificationPlan(root, { VERIFY_BASE: "HEAD" }).mode).toBe("selected");
		await put(root, file, `${source}\n`);
		expect(buildVerificationPlan(root, { VERIFY_BASE: "HEAD" }).mode).toBe("all");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("the real repository selects Todo contracts without unrelated Acceptance", () => {
	const selection = selectAffectedTests(resolve(import.meta.dirname, "../../.."), [
		"packages/pi-stuff/src/todo/todo.ts",
	]);
	expect(selection.reason).toBe("selected changed Capability(s): todo");
	expect(selection.files).toContain("tests/acceptance/todo/todo-host.test.ts");
	expect(selection.files).toContain("tests/system/repository/suite-host.test.ts");
	expect(selection.files).not.toContain("tests/acceptance/code-mode/tui-offline.test.ts");
	expect(selectAffectedTests(process.cwd(), ["scripts/detached-process.ts"]).reason).toContain(
		"shared infrastructure",
	);
});

test("scheduled omission requires same-head full-run evidence, while manual verification stays full", async () => {
	const { root, base } = await repo();
	try {
		const env = { VERIFICATION_PLAN_CI: "1", GITHUB_EVENT_NAME: "schedule", CI_SCHEDULE_SKIP: "1" };
		expect(buildVerificationPlan(root, env).mode).toBe("all");
		const proven = { ...env, CI_PREVIOUS_FULL_SHA: base, CI_PREVIOUS_FULL_RUN: "123" };
		const plan = buildVerificationPlan(root, proven);
		expect(plan.mode).toBe("none");
		expect(plan.changedFiles).toEqual([]);
		expect(plan.previousFullRun).toBe(123);
		expect(buildVerificationPlan(root, { ...proven, GITHUB_EVENT_NAME: "workflow_dispatch" }).mode).toBe("all");
		expect(buildVerificationPlan(root, { ...proven, CI_PREVIOUS_FULL_SHA: "a".repeat(40) }).mode).toBe("all");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
