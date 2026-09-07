import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isJsonInputObject } from "../../../packages/pi-stuff/src/shared/json-value.js";
import { isRuntimeString } from "../../../packages/pi-stuff/src/shared/runtime-type.js";
import { readStatus } from "../../../packages/pi-stuff/src/subagents/src/shared/utils.js";
import { createRpcTransport } from "../../../scripts/magic-context-real-rpc.js";
import { disableSessionNamingForTest } from "../../../scripts/session-naming-test-settings.js";
import { verifyPiHostVersion } from "../../../scripts/verify-pi-host-provenance.js";

const piBinary = process.env["PI_BIN"] ?? "/opt/pi-coding-agent/pi";
const suite = resolve(import.meta.dir, "../../../packages/pi-stuff/index.ts");
const provider = resolve(import.meta.dir, "../../fixtures/isolated-resume-provider.ts");

async function waitUntil(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(50);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

async function prepareRepository(root: string): Promise<void> {
	const repo = join(root, "repo");
	const agent = join(root, "agent");
	await Promise.all([
		mkdir(join(repo, "sub"), { recursive: true }),
		mkdir(join(agent, "agents"), { recursive: true }),
		mkdir(join(root, "runtime"), { mode: 0o700 }),
		mkdir(join(root, "evidence")),
	]);
	await writeFile(join(repo, "sub", "original.txt"), "ORIGINAL_SHARED_CHECKOUT\n");
	for (const args of [
		["init", "--quiet"],
		["config", "user.email", "test@example.invalid"],
		["config", "user.name", "Pi Test"],
		["add", "."],
		["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "fixture"],
	]) {
		const result = Bun.spawnSync(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
	}
	await writeFile(join(agent, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
	await disableSessionNamingForTest(agent);
	await writeFile(
		join(agent, "agents", "isolated-resume.md"),
		`---\nname: isolated-resume\ndescription: isolated resume fixture\nmodel: pi-stuff-isolated-resume/fixture-model\ntools: bash\nsubagentOnlyExtensions: ${provider}\ninheritProjectContext: false\ninheritSkills: false\n---\nResume the task.\n`,
	);
}

function openParent(root: string, sessionFile?: string) {
	const command = [
		piBinary,
		"--offline",
		"--approve",
		"--mode",
		"rpc",
		"--no-extensions",
		"--no-skills",
		"--no-context-files",
		"--extension",
		suite,
		"--extension",
		provider,
		"--provider",
		"pi-stuff-isolated-resume",
		"--model",
		"fixture-model",
		"--session-dir",
		join(root, "sessions"),
	];
	if (sessionFile) command.push("--session", sessionFile);
	const environment = {
		...process.env,
		HOME: root,
		PI_CODING_AGENT_DIR: join(root, "agent"),
		PI_SUBAGENT_PI_BINARY: piBinary,
		PI_STUFF_RESUME_EVIDENCE: join(root, "evidence"),
		PI_SUBAGENTS_WORKTREE_DIR: join(root, "worktrees"),
		XDG_RUNTIME_DIR: join(root, "runtime"),
		XDG_CONFIG_HOME: join(root, "config"),
		XDG_CACHE_HOME: join(root, "cache"),
		XDG_STATE_HOME: join(root, "state"),
		PI_STUFF_AGENT_PATH: undefined,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
	};
	return createRpcTransport(command, join(root, "repo", "sub"), environment);
}

for (const foreground of [false, true]) {
	test(`real Pi ${foreground ? "foreground" : "background"} isolation survives pause and cold-parent resume`, async () => {
		await verifyPiHostVersion(piBinary);
		const root = await mkdtemp(join(tmpdir(), "pi-isolated-resume-"));
		await prepareRepository(root);
		let rpc = await openParent(root);
		let passed = false;
		try {
			const start = rpc.promptAndWait(`START ${foreground ? "foreground" : "background"}`, 60_000);
			const launchedFile = join(root, "evidence", "launch-cwd.txt");
			await waitUntil(() => Bun.file(launchedFile).exists(), "the child's first file effect");
			const launchCwd = (await readFile(launchedFile, "utf8")).trim();
			expect(launchCwd.startsWith(join(root, "worktrees", "pi-worktree-"))).toBe(true);
			expect(launchCwd.endsWith("/sub")).toBe(true);
			const statusFile = [
				...new Bun.Glob("**/{async-subagent-runs,foreground-runs}/*/status.json").scanSync(join(root, "runtime")),
			][0];
			if (!statusFile) throw new Error("Missing canonical runner status");
			const statusPath = join(root, "runtime", statusFile);
			const status = readStatus(dirname(statusPath));
			if (!status?.pid) throw new Error("Missing live runner identity");
			process.kill(status.pid, "SIGUSR2");
			await waitUntil(() => {
				const current = readStatus(dirname(statusPath));
				return (
					current?.state === "paused" &&
					(foreground
						? current.steps?.[0]?.terminalOutcome?.continuation?.resumeSupported === true
						: current.processTerminal?.resumeDisposition === "resumable")
				);
			}, "canonical resumable pause");
			await start;
			const state = await rpc.send({ type: "get_state" });
			if (!isJsonInputObject(state.data) || !isRuntimeString(state.data["sessionFile"]))
				throw new Error("Missing parent Session");
			await rpc.stop();
			rpc = await openParent(root, state.data["sessionFile"]);
			await rpc.promptAndWait(`RESUME ${basename(dirname(statusPath))}`, 30_000);
			await rpc.waitFor(
				(record) =>
					record.type === "message_end" && JSON.stringify(record).includes("PARENT_INTEGRATED_RETAINED_WORK"),
				{ timeoutMs: 30_000 },
			);
			expect((await readFile(join(launchCwd, "resume-cwd.txt"), "utf8")).trim()).toBe(launchCwd);
			expect(await readFile(join(launchCwd, "retained.txt"), "utf8")).toBe("RETAINED_FROM_LAUNCH");
			expect(await Bun.file(join(root, "repo", "sub", "retained.txt")).exists()).toBe(false);
			expect(await readFile(join(root, "repo", "sub", "original.txt"), "utf8")).toBe("ORIGINAL_SHARED_CHECKOUT\n");
			passed = true;
		} finally {
			await rpc.stop();
			await writeFile(join(root, "rpc.jsonl"), rpc.records.map((record) => JSON.stringify(record)).join("\n"));
			if (passed) {
				expect(
					rpc.records.filter((record) => record.type === "extension_error"),
					root,
				).toEqual([]);
				await rm(root, { recursive: true, force: true });
			} else console.error(`Retained isolated-resume diagnostics: ${root}`);
		}
	}, 120_000);
}
