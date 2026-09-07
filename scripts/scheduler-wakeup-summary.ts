import assert from "node:assert/strict";

// Linux sched tracepoint print formats; comm is at most TASK_COMM_LEN - 1 bytes.
const FORK = /^comm=(.{0,15}) pid=(\d+) child_comm=(.{0,15}) child_pid=(\d+)$/;
const WAKEUP = /^comm=(.{0,15}) pid=(\d+) prio=(-?\d+) target_cpu=(\d+)$/;
const EXIT = /^comm=(.{0,15}) pid=(\d+) prio=(-?\d+)(?: group_dead=(?:true|false))?$/;
const EXEC = /^filename=(.*) pid=(\d+) old_pid=(\d+)$/;
const EVENT = /^.*-\d+\s+\[\d+\]\s+\S+\s+(\d+\.\d+):\s+(\w+):\s+(.*)$/;

function integer(value: string | undefined, minimum: number): number {
	const result = Number(value);
	assert(Number.isSafeInteger(result) && result >= minimum, "Invalid scheduler integer");
	return result;
}

/** Counts the supplied window; caller must validate loss counters and capture through owned-task reaping. */
export function summarizeSchedulerWakeups(traceText: string, rootPid: number) {
	assert(Number.isSafeInteger(rootPid) && rootPid > 0, "Invalid root PID");
	// Exit precedes kernel cleanup. Retain ownership until a later fork reuses the PID.
	const exited = new Map<number, boolean>();
	const taskGenerations: { generation: number; pid: number }[] = [];
	let rootBorn = false;
	let totalExits = 0;
	let wakeups = 0;
	let wakeupsNew = 0;
	let previousTimestamp = -Infinity;

	for (const line of traceText.split(/\r?\n/)) {
		if (!line.trim() || line.trimStart().startsWith("#")) continue;
		const record = line.match(EVENT);
		assert(record, "Malformed trace record");
		const timestamp = Number(record[1]);
		assert(Number.isFinite(timestamp) && timestamp >= previousTimestamp, "Invalid timestamp");
		previousTimestamp = timestamp;
		const event = record[2];
		const payload = record[3] ?? "";

		if (event === "sched_process_fork") {
			const fields = payload.match(FORK);
			assert(fields, "Malformed sched_process_fork");
			const parentPid = integer(fields[2], 1);
			const childPid = integer(fields[4], 1);
			assert(parentPid !== childPid && exited.get(childPid) !== false, "Active PID collision");
			assert(exited.get(parentPid) !== true, "Exited task forked");
			exited.delete(childPid);
			if (childPid === rootPid) {
				assert(!rootBorn, "Ambiguous root fork");
				rootBorn = true;
			} else if (!exited.has(parentPid)) continue;
			exited.set(childPid, false);
			taskGenerations.push({ generation: taskGenerations.length + 1, pid: childPid });
		} else if (event === "sched_process_exit") {
			const fields = payload.match(EXIT);
			assert(fields, "Malformed sched_process_exit");
			const pid = integer(fields[2], 1);
			integer(fields[3], -1);
			assert(pid !== rootPid || rootBorn, "Root exited before birth");
			if (!exited.has(pid)) continue;
			assert(!exited.get(pid), "Duplicate owned task exit");
			exited.set(pid, true);
			totalExits++;
		} else if (event === "sched_wakeup" || event === "sched_wakeup_new") {
			const fields = payload.match(WAKEUP);
			assert(fields, "Malformed scheduler wakeup");
			const pid = integer(fields[2], 1);
			integer(fields[3], -1);
			integer(fields[4], 0);
			assert(pid !== rootPid || rootBorn, "Root woke before birth");
			if (exited.has(pid)) {
				if (event === "sched_wakeup_new") wakeupsNew++;
				else wakeups++;
			}
		} else if (event === "sched_process_exec") {
			const fields = payload.match(EXEC);
			assert(fields, "Malformed sched_process_exec");
			const pid = integer(fields[2], 1);
			const oldPid = integer(fields[3], 1);
			assert(pid === oldPid || (!exited.has(pid) && !exited.has(oldPid)), "Owned nonleader exec is unsupported");
		} else throw new Error(`Unexpected scheduler event: ${event}`);
	}

	assert(rootBorn && exited.get(rootPid) === true, "Root fork/exit is incomplete");
	assert(totalExits === taskGenerations.length, "Owned task exit is incomplete");
	return { rootPid, taskGenerations, totalBirths: taskGenerations.length, totalExits, wakeups, wakeupsNew };
}
