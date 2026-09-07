import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CERTIFIED_PI_VERSION } from "../../../scripts/pi-host-contract.ts";

const runner = resolve(import.meta.dirname, "../../../scripts/run-isolated-tests.ts");

test("test preview selects files without executing them and rejects empty selections", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-test-command-"));
	try {
		await mkdir(join(cwd, "tests"));
		await writeFile(join(cwd, "tests/sentinel.test.ts"), 'throw new Error("scenario executed");\n');
		await mkdir(join(cwd, "tests/unit/goal"), { recursive: true });
		await writeFile(join(cwd, "tests/unit/goal/command.node.ts"), 'throw new Error("Node scenario executed");\n');
		await mkdir(join(cwd, "tests/component-integration/goal"), { recursive: true });
		await writeFile(
			join(cwd, "tests/component-integration/goal/goal-runtime.test.mjs"),
			'throw new Error("smoke executed");\n',
		);
		const all = Bun.spawnSync([process.execPath, runner, "--list"], { cwd });
		expect(all.stdout.toString()).toContain("tests/unit/goal/command.node.ts");
		expect(all.stdout.toString()).toContain("tests/component-integration/goal/goal-runtime.test.mjs");
		const preview = Bun.spawnSync([process.execPath, runner, "--list", "--file", "sentinel"], { cwd });
		expect(preview.exitCode).toBe(0);
		expect(preview.stdout.toString()).toContain("tests/sentinel.test.ts");
		expect(preview.stderr.toString()).not.toContain("scenario executed");
		await mkdir(join(cwd, "tests/acceptance/example"), { recursive: true });
		await writeFile(
			join(cwd, "tests/acceptance/example/environment.test.ts"),
			'throw new Error("scenario executed");',
		);
		await mkdir(join(cwd, "tests/system-integration/subagents"), { recursive: true });
		await writeFile(
			join(cwd, "tests/system-integration/subagents/process-controls-recovery.test.ts"),
			'throw new Error("scenario executed");',
		);
		for (const selector of ["environment", "process-controls-recovery"]) {
			const report = join(cwd, `${selector}.json`);
			const unavailable = Bun.spawnSync([process.execPath, runner, "--file", selector, "--output", report], {
				cwd,
				env: { ...process.env, PI_BIN: join(cwd, "missing-pi") },
			});
			expect(unavailable.exitCode).not.toBe(0);
			expect(unavailable.stderr.toString()).toContain("Test preflight failed");
			expect(unavailable.stderr.toString()).not.toContain("scenario executed");
			expect(JSON.parse(await readFile(report, "utf8"))).toMatchObject({ status: "preflight-failed", results: [] });
		}
		for (const args of [["--unknown"], ["--file", "missing"]]) {
			const result = Bun.spawnSync([process.execPath, runner, ...args], { cwd });
			expect(result.exitCode).not.toBe(0);
			expect(result.stderr.toString()).not.toContain("scenario executed");
		}
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("the runner passes the installed Pi instead of a development SDK CLI", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "pi-stuff-test-path-"));
	try {
		const pi = join(cwd, "installed-pi");
		await symlink(pi, join(cwd, "pi"));
		await writeFile(pi, `#!/bin/sh\nprintf '%s\\n' '${CERTIFIED_PI_VERSION}'\n`);
		await chmod(pi, 0o755);
		const sdkBin = join(cwd, "node_modules/.bin");
		await mkdir(sdkBin, { recursive: true });
		await symlink(pi, join(sdkBin, "pi"));
		await mkdir(join(cwd, "tests/acceptance/example"), { recursive: true });
		await writeFile(
			join(cwd, "tests/acceptance/example/environment.test.ts"),
			`import { expect, test } from "bun:test"; test("selected Pi", () => expect(process.env.PI_BIN).toBe(${JSON.stringify(join(cwd, "pi"))}));`,
		);
		const result = Bun.spawnSync([process.execPath, runner], {
			cwd,
			env: { ...process.env, PI_BIN: undefined, PATH: `${sdkBin}:${cwd}:${process.env["PATH"] ?? ""}` },
		});
		expect(result.exitCode).toBe(0);
		const missing = Bun.spawnSync(
			[
				process.execPath,
				"-e",
				`import { resolvePiBinary } from ${JSON.stringify(resolve(import.meta.dirname, "../../../scripts/installed-tools.ts"))}; resolvePiBinary();`,
			],
			{ cwd, env: { ...process.env, PI_BIN: undefined, PATH: sdkBin } },
		);
		expect(missing.exitCode).not.toBe(0);
		expect(missing.stderr.toString()).toContain("Pi is missing");
		await mkdir(join(cwd, "tests/unit/example"), { recursive: true });
		await writeFile(
			join(cwd, "tests/unit/example/pure.test.ts"),
			'import { test } from "bun:test"; test("pure", () => {});',
		);
		const pure = Bun.spawnSync([process.execPath, runner, "--level", "unit"], {
			cwd,
			env: { ...process.env, PI_BIN: undefined, PATH: sdkBin },
		});
		expect(pure.exitCode).toBe(0);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
