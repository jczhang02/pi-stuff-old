import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { readProcessStartIdentityAsync } from "../packages/pi-stuff/src/subagents/src/shared/process-identity.js";

const COUNTER = Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER });
const IO_SCHEMA = Type.Object({
	rchar: COUNTER,
	wchar: COUNTER,
	syscr: COUNTER,
	syscw: COUNTER,
	read_bytes: COUNTER,
	write_bytes: COUNTER,
	cancelled_write_bytes: COUNTER,
});
// The session bus works when the manager's private socket cannot resolve its peer PID in a PID namespace.
const SYSTEMCTL = ["env", "-u", "XDG_RUNTIME_DIR", "systemctl", "--user"];

function counters(text: string): Record<string, number> {
	return Object.fromEntries(
		text
			.trim()
			.split("\n")
			.map((line) => {
				const [key, value] = line.split(/:\s*|\s+/u);
				return [key, Number(value)];
			}),
	);
}

async function members(cgroup: string): Promise<number[]> {
	const text = await readFile(`/sys/fs/cgroup${cgroup}/cgroup.procs`, "utf8");
	const pids = text.trim().split(/\s+/u).map(Number);
	assert(Check(Type.Array(Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER })), pids));
	return [...new Set(pids)].sort((a, b) => a - b);
}

async function readProcess(pid: number, cgroup: string) {
	const processStartIdentity = await readProcessStartIdentityAsync(pid);
	assert(processStartIdentity, "Resource process birth identity is missing");
	const [membership, ioText, memoryText] = await Promise.all(
		["cgroup", "io", "smaps_rollup"].map((file) => readFile(`/proc/${String(pid)}/${file}`, "utf8")),
	);
	assert.equal(membership?.trim(), `0::${cgroup}`, "Resource process left the owned scope");
	assert(ioText && memoryText, "Process resource counters are missing");
	const io = counters(ioText);
	assert(Check(IO_SCHEMA, io), "Invalid process I/O counters");
	const rssBytes = Number(/^Rss:\s+(\d+) kB$/mu.exec(memoryText)?.[1]) * 1_024;
	assert(Check(COUNTER, rssBytes) && rssBytes > 0, "Invalid process RSS");
	assert.equal(await readProcessStartIdentityAsync(pid), processStartIdentity, "Resource process identity changed");
	return { pid, processStartIdentity, rssBytes, io };
}

/** Owns only one synthetic Host scope; observer, tmux and Provider remain outside it. */
export class HostResourceScope {
	private readonly unit: string;

	constructor(unit: string) {
		this.unit = unit;
	}

	command(command: readonly string[]): string[] {
		const busAddress = process.env["DBUS_SESSION_BUS_ADDRESS"];
		assert(busAddress, "Resource scope requires a configured user session bus");
		return [
			"env",
			"-u",
			"XDG_RUNTIME_DIR",
			`DBUS_SESSION_BUS_ADDRESS=${busAddress}`,
			"systemd-run",
			"--user",
			"--scope",
			"--quiet",
			"--collect",
			"--expand-environment=no",
			`--unit=${this.unit}`,
			"--property=MemoryAccounting=yes",
			"--property=RuntimeMaxSec=90",
			// Pi retains its isolated environment; only the native launcher sees the user bus.
			"env",
			"-u",
			"DBUS_SESSION_BUS_ADDRESS",
			...command,
		];
	}

	async read(parentPid: number) {
		const readStartedMs = performance.now();
		const cgroup = this.systemctl("show", "--property=ControlGroup", "--value");
		assert(cgroup.startsWith("/") && cgroup.endsWith(`/${this.unit}`), "Unexpected resource scope");
		const pids = await members(cgroup);
		assert(pids.includes(parentPid), "Parent is not in the owned resource scope");
		const processes = await Promise.all(pids.map((pid) => readProcess(pid, cgroup)));
		assert.deepEqual(await members(cgroup), pids, "Scope membership changed during resource observation");
		const [cpuText, currentText] = await Promise.all(
			["cpu.stat", "memory.current"].map((file) => readFile(`/sys/fs/cgroup${cgroup}/${file}`, "utf8")),
		);
		// Read the cumulative peak last so it cannot appear lower than the earlier current value.
		const peakText = await readFile(`/sys/fs/cgroup${cgroup}/memory.peak`, "utf8");
		assert(cpuText && currentText && peakText, "Resource counters are missing");
		const cpu = counters(cpuText);
		assert(Check(Type.Object({ usage_usec: COUNTER, user_usec: COUNTER, system_usec: COUNTER }), cpu));
		const memoryCurrentChargedBytes = Number(currentText);
		const memoryPeakChargedBytes = Number(peakText);
		assert(Check(COUNTER, memoryCurrentChargedBytes) && Check(COUNTER, memoryPeakChargedBytes));
		assert(
			cpu.usage_usec > 0 && memoryCurrentChargedBytes > 0 && memoryPeakChargedBytes >= memoryCurrentChargedBytes,
		);
		return {
			unit: this.unit,
			boundary: "after-observation-before-host-shutdown",
			readStartedMs,
			readCompletedMs: performance.now(),
			cpuUs: { total: cpu.usage_usec, user: cpu.user_usec, system: cpu.system_usec },
			memoryCurrentChargedBytes,
			memoryPeakChargedBytes,
			rssSnapshotBytes: processes.reduce((sum, process) => sum + process.rssBytes, 0),
			processes,
		};
	}

	stop(): void {
		// An already-unloaded scope is valid; verify inactivity even if stop reports that it no longer exists.
		Bun.spawnSync([...SYSTEMCTL, "stop", this.unit], { timeout: 10_000 });
		assert.equal(
			this.systemctl("show", "--property=ActiveState", "--value"),
			"inactive",
			"Resource scope remains active",
		);
	}

	private systemctl(...args: string[]): string {
		const result = Bun.spawnSync([...SYSTEMCTL, ...args, this.unit], { timeout: 10_000 });
		assert.equal(result.exitCode, 0, result.stderr.toString());
		return result.stdout.toString().trim();
	}
}
