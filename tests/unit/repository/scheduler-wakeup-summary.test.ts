import { test } from "bun:test";
import assert from "node:assert/strict";
import { summarizeSchedulerWakeups } from "../../../scripts/scheduler-wakeup-summary.js";

const line = (time: string, event: string, payload: string) => ` task-1 [001] .... ${time}: ${event}: ${payload}`;
const fork = (time: string, pid: number, childPid: number) =>
	line(time, "sched_process_fork", `comm=pi pid=${pid} child_comm=worker child_pid=${childPid}`);
const forkWithComm = (time: string, comm: string, pid: number, childPid: number) =>
	line(time, "sched_process_fork", `comm=${comm} pid=${pid} child_comm=worker child_pid=${childPid}`);
const exit = (time: string, pid: number) =>
	line(time, "sched_process_exit", `comm=pi pid=${pid} prio=120 group_dead=true`);
const wake = (time: string, pid: number, event = "sched_wakeup") =>
	line(time, event, `comm=pi pid=${pid} prio=120 target_cpu=001`);

test("counts wakee payloads across descendants, including a child after root exit", () => {
	const trace = [
		fork("1.000", 20, 100),
		fork("1.001", 100, 101),
		fork("1.002", 100, 102),
		wake("1.003", 100),
		wake("1.004", 101),
		wake("1.005", 102, "sched_wakeup_new"),
		exit("1.006", 100),
		wake("1.007", 101),
		exit("1.008", 101),
		exit("1.009", 102),
	].join("\n");
	assert.deepEqual(summarizeSchedulerWakeups(trace, 100), {
		rootPid: 100,
		taskGenerations: [
			{ generation: 1, pid: 100 },
			{ generation: 2, pid: 101 },
			{ generation: 3, pid: 102 },
		],
		totalBirths: 3,
		totalExits: 3,
		wakeups: 3,
		wakeupsNew: 1,
	});
});

test("rejects malformed or incomplete traces and nonleader exec", () => {
	const complete = [fork("1.000", 20, 100), exit("1.001", 100)].join("\n");
	for (const trace of [
		complete.replace("child_pid=100", "child_pid=nope"),
		"sched_wakeup: comm=pi pid=100 prio=120 target_cpu=001",
		complete.replace("1.001", "0.999"),
		complete.replace("prio=120", "prio=bad"),
		complete.replace("prio=120", "prio=999999999999999999999"),
		complete.replace("group_dead=true", "group_dead=1"),
		`${complete}\n${exit("1.002", 100)}`,
		[fork("1.000", 20, 100), fork("1.001", 100, 101), exit("1.002", 100)].join("\n"),
		complete.replace("child_pid=100", "child_pid=100 ignored=true"),
		[fork("1.000", 20, 100), wake("1.001", 100).replace("target_cpu=001", "target_cpu=bad"), exit("1.002", 100)].join(
			"\n",
		),
		fork("1.000", 20, 101),
		fork("1.000", 20, 100),
		[fork("1.000", 20, 100), fork("1.001", 20, 100), exit("1.002", 100)].join("\n"),
		[fork("1.000", 20, 100), exit("1.001", 100), fork("1.002", 20, 100), exit("1.003", 100)].join("\n"),
		[fork("1.000", 20, 100), wake("1.001", 100), exit("1.002", 100)].slice(0, 2).join("\n"),
		[
			fork("1.000", 20, 100),
			line("1.001", "sched_process_exec", "filename=worker pid=101 old_pid=100"),
			exit("1.002", 100),
		].join("\n"),
	])
		assert.throws(() => summarizeSchedulerWakeups(trace, 100));
});

test("does not count an unrelated waker and rejects PID reuse while active", () => {
	const trace = [fork("1.000", 20, 100), wake("1.001", 200), exit("1.002", 100)].join("\n");
	assert.equal(summarizeSchedulerWakeups(trace, 100).wakeups, 0);
	assert.throws(() => summarizeSchedulerWakeups([fork("1.000", 20, 100), fork("1.001", 20, 100)].join("\n"), 100));
});

test("allows ordinary exec and ignores a reused PID outside the owned tree", () => {
	const trace = [
		fork("1.000", 20, 100),
		line("1.001", "sched_process_exec", "filename=worker pid=100 old_pid=100"),
		fork("1.002", 100, 101),
		exit("1.003", 101),
		fork("1.004", 20, 101),
		wake("1.005", 101),
		exit("1.006", 100),
	].join("\n");
	assert.equal(summarizeSchedulerWakeups(trace, 100).wakeups, 0);
});

test("follows a child after root exit and rejects misleading payloads", () => {
	const trace = [
		forkWithComm("1.000", "helper pid=777", 20, 100),
		fork("1.001", 100, 101),
		exit("1.002", 100),
		wake("1.003", 101).replace("comm=pi", "comm=helper pid=777"),
		fork("1.004", 101, 102),
		exit("1.005", 101),
		exit("1.006", 102),
	].join("\n");
	assert.equal(summarizeSchedulerWakeups(trace, 100).wakeups, 1);
	assert.throws(() => summarizeSchedulerWakeups("", 0));
});

test("counts kernel exit-cleanup wakeups and separates owned PID generations", () => {
	const trace = [
		fork("1.000", 20, 100),
		fork("1.001", 100, 101),
		exit("1.002", 101),
		wake("1.003", 101),
		fork("1.004", 100, 101),
		wake("1.005", 101),
		exit("1.006", 101),
		exit("1.007", 100),
		wake("1.008", 100),
	].join("\n");
	const summary = summarizeSchedulerWakeups(trace, 100);
	assert.equal(summary.wakeups, 3);
	assert.equal(summary.totalBirths, 3);
	assert.equal(summary.totalExits, 3);
});
