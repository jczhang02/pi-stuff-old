import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readlinkSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rmdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { parseJsonValue } from "../packages/pi-stuff/src/shared/json-value.js";
import { summarizeSchedulerWakeups } from "./scheduler-wakeup-summary.js";

const { values } = parseArgs({
	options: {
		uid: { type: "string" },
		gid: { type: "string" },
		output: { type: "string" },
		package: { type: "string" },
	},
	strict: true,
	allowPositionals: false,
});
assert(process.env["GITHUB_ACTIONS"] === "true" && process.env["RUNNER_ENVIRONMENT"] === "github-hosted");
assert(process.getuid?.() === 0, "Run only with existing ephemeral-runner tracing authority");
assert(values.uid && /^[1-9]\d*$/.test(values.uid) && values.gid && /^\d+$/.test(values.gid));
assert(values.output, "An output file is required");
const pi = process.env["PI_BIN"];
const helper = process.env["PI_STUFF_CODE_MODE_HOST"];
assert(pi && helper, "Certified Pi and Code Mode executables must already be prepared");
const traceRoot = "/sys/kernel/tracing";
const instance = join(traceRoot, "instances", `pi-stuff-workload-${process.pid}`);
const repository = resolve(import.meta.dir, "..");
const packageDirectory = resolve(values.package ?? join(repository, "packages/pi-stuff"));
const packageGit = (...args: string[]) =>
	command(
		"setpriv",
		`--reuid=${values.uid}`,
		`--regid=${values.gid}`,
		"--clear-groups",
		"git",
		"-C",
		packageDirectory,
		...args,
	);
assert.equal(packageGit("rev-parse", "--show-prefix"), "packages/pi-stuff/");
assert.equal(packageGit("status", "--porcelain", "--untracked-files=all", "--", "."), "");
const packageCommit = packageGit("rev-parse", "HEAD");
const events = ["sched_wakeup", "sched_wakeup_new", "sched_process_fork", "sched_process_exit", "sched_process_exec"];
const scenarios = [
	["raw", "--repeat-tool"],
	["suite", "--suite", "--repeat-tool"],
	["foreground", "--suite", "--agent", "foreground", "--repeat-tool"],
	["background", "--suite", "--agent", "background"],
	["context", "--suite", "--context"],
	["goal", "--suite", "--goal"],
	["ledger", "--suite", "--code-mode", "--ledger", "--repeat-tool"],
];
const sampleSchema = Type.Object({
	directory: Type.String(),
	seededSession: Type.Boolean(),
	reapedChildProcesses: Type.Integer({ minimum: 0 }),
});

function command(...args: string[]) {
	const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
	assert.equal(result.exitCode, 0, result.stderr.toString());
	return result.stdout.toString().trim();
}

async function assertNoLoss() {
	const cpus = await readdir(join(instance, "per_cpu"));
	assert(cpus.length > 0, "Missing per-CPU loss counters");
	for (const cpu of cpus) {
		const stats = await readFile(join(instance, "per_cpu", cpu, "stats"), "utf8");
		const counters = [...stats.matchAll(/^(overrun|commit overrun|dropped events):\s*(\d+)$/gm)];
		assert.equal(counters.length, 3, "Incomplete loss counters");
		assert(
			counters.every((counter) => Number(counter[2]) === 0),
			"Lost scheduler events",
		);
	}
}

async function measure(args: string[], pi: string, helper: string) {
	const [name, ...options] = args;
	assert(name);
	const capture = await mkdtemp(join(tmpdir(), "pi-stuff-scheduler-"));
	// Only the offline workload runs as the normal runner user, inside its existing isolation boundary.
	command("chown", `${values.uid}:${values.gid}`, capture);
	await writeFile(join(instance, "trace"), "");
	await writeFile(join(instance, "tracing_on"), "1");
	const child = Bun.spawn(
		[
			"timeout",
			"90s",
			"setpriv",
			`--reuid=${values.uid}`,
			`--regid=${values.gid}`,
			"--clear-groups",
			"unshare",
			"--user",
			"--map-root-user",
			"--net",
			"--pid",
			"--fork",
			"--kill-child",
			"--mount-proc",
			"setsid",
			"sh",
			"-c",
			'"$@"; exit $?',
			"psyon-pid-init",
			process.execPath,
			join(repository, "scripts/benchmark-responsiveness.ts"),
			"--diagnostic",
			"--pi",
			pi,
			"--package",
			packageDirectory,
			...options,
		],
		{
			cwd: repository,
			env: {
				PATH: process.env["PATH"],
				LANG: "C.UTF-8",
				TERM: "xterm-256color",
				TMPDIR: capture,
				PSYON_PARENT_NETNS: readlinkSync("/proc/self/ns/net"),
				PI_STUFF_CODE_MODE_HOST: helper,
				PI_STUFF_UI_PTY_ARTIFACT_DIR: process.env["PI_STUFF_UI_PTY_ARTIFACT_DIR"],
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	await writeFile(join(instance, "tracing_on"), "0");
	await writeFile(join(capture, "observer.stdout"), stdout);
	await writeFile(join(capture, "observer.stderr"), stderr);
	await assertNoLoss();
	const trace = await readFile(join(instance, "trace"), "utf8");
	assert.equal(exitCode, 0, `${name}: ${stderr}`);
	const sample = parseJsonValue(stdout);
	assert(Check(sampleSchema, sample), "Missing complete observer result");
	assert.equal(resolve(sample.directory, ".."), capture, "Unexpected observer evidence directory");
	const staged = (await readdir(sample.directory)).filter((entry) => entry.startsWith("pi-host-"));
	assert.equal(staged.length, 1);
	const binary = join(sample.directory, staged[0] ?? "", "pi");
	// Namespace-local fixture PIDs cannot seed a host-kernel trace. The unique staged executable identifies execs.
	const execs = trace.split("\n").flatMap((line) => {
		const fields = / sched_process_exec: filename=(.*) pid=(\d+) old_pid=(\d+)$/.exec(line);
		return fields?.[1] === binary ? [Number(fields[2])] : [];
	});
	assert.equal(execs.length, 1 + Number(sample.seededSession) + sample.reapedChildProcesses, "Unexpected Pi execs");
	const rootPid = execs[Number(sample.seededSession)];
	assert(rootPid);
	const summary = summarizeSchedulerWakeups(trace, rootPid);
	assert(
		execs
			.slice(Number(sample.seededSession))
			.every((pid) => summary.taskGenerations.some((task) => task.pid === pid)),
	);
	for (const task of summary.taskGenerations)
		assert(!existsSync(`/proc/${task.pid}`), "An observed task survived the namespace boundary");
	const evidence = await readFile(join(sample.directory, "evidence.json"), "utf8");
	return {
		name,
		purpose: "scheduler-diagnosis",
		certification: false,
		lostEvents: 0,
		...summary,
		sample,
		traceSha256: createHash("sha256").update(trace).digest("hex"),
		evidenceSha256: createHash("sha256").update(evidence).digest("hex"),
	};
}

let mounted = false;
let created = false;
try {
	if (Bun.spawnSync(["mountpoint", "-q", traceRoot]).exitCode !== 0) {
		command("mount", "-t", "tracefs", "tracefs", traceRoot);
		mounted = true;
	}
	await mkdir(instance);
	created = true;
	await writeFile(join(instance, "tracing_on"), "0");
	await writeFile(join(instance, "trace_clock"), "global");
	await writeFile(join(instance, "buffer_size_kb"), "65536");
	for (const option of ["context-info", "irq-info"]) await writeFile(join(instance, "options", option), "1");
	const formats = await Promise.all(
		events.map((event) => readFile(join(instance, "events/sched", event, "format"), "utf8")),
	);
	for (const event of events) await writeFile(join(instance, "events/sched", event, "enable"), "1");
	const kernel = command("uname", "-r");
	const samples = [];
	for (const scenario of scenarios) {
		const sample = await measure(scenario, pi, helper);
		samples.push(sample);
		await writeFile(values.output, JSON.stringify({ packageCommit, kernel, formats, samples }, null, 2));
		console.log(JSON.stringify(sample));
	}
} finally {
	if (created) {
		await writeFile(join(instance, "tracing_on"), "0");
		await rmdir(instance);
	}
	if (mounted) command("umount", traceRoot);
}
