import { execFile, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { runtimeErrorCode } from "../../../shared/runtime-type.ts";

export type ProcessKillFn = (pid: number, signal?: NodeJS.Signals | 0) => boolean;

export interface ProcessStartIdentityPollOptions {
	readonly read?: (pid: number) => string | undefined;
	readonly timeoutMs?: number;
	readonly intervalMs?: number;
}

export interface ProcessIdentityGroupSnapshot {
	readonly processStartIdentity: string;
	readonly processGroupId: number;
}

/**
 * Stable identity for the current operating-system boot. A differing value is
 * positive proof that no process recorded during the previous boot can still
 * exist, even when its transient runtime directory has been cleared.
 */
export function readSystemBootIdentity(): string | undefined {
	if (process.platform === "linux") {
		try {
			return normalizedBootIdentity("linux", fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf-8"));
		} catch {
			return undefined;
		}
	}
	// Node exposes no stable, side-effect-free boot identifier on the supported
	// BSD hosts. Stay conservative there instead of spawning during Extension
	// startup or deriving an unstable value from wall-clock uptime.
	return undefined;
}

/** Read process birth identity and PGID from one Linux procfs record. */
export function readProcessIdentityGroupSnapshot(pid: number): ProcessIdentityGroupSnapshot | undefined {
	if (process.platform === "linux") {
		try {
			return parseLinuxProcessIdentity(fs.readFileSync(`/proc/${pid}/stat`, "utf-8"));
		} catch {
			return undefined;
		}
	}
	if (process.platform !== "darwin" && process.platform !== "freebsd") return undefined;
	const result = spawnSync("/bin/ps", ["-o", "lstart=", "-o", "pgid=", "-p", String(pid)], {
		encoding: "utf-8",
		maxBuffer: 64 * 1024,
	});
	const output = result.status === 0 ? result.stdout.trim() : "";
	const match = /^(.*?)\s+(\d+)$/u.exec(output);
	if (!match?.[1] || !match[2]) return undefined;
	const processGroupId = Number(match[2]);
	if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0) return undefined;
	return { processStartIdentity: `${process.platform}:${match[1]}`, processGroupId };
}

/** Stable OS process-birth identity used together with a PID to reject PID reuse. */
export function readProcessStartIdentity(pid: number): string | undefined {
	return readProcessIdentityGroupSnapshot(pid)?.processStartIdentity;
}

/** Host-side process identity lookup that never blocks input/rendering on procfs or `ps`. */
export async function readProcessStartIdentityAsync(pid: number): Promise<string | undefined> {
	if (process.platform === "linux") {
		try {
			const stat = await fs.promises.readFile(`/proc/${pid}/stat`, "utf-8");
			return parseLinuxProcessIdentity(stat)?.processStartIdentity;
		} catch {
			return undefined;
		}
	}
	if (process.platform !== "darwin" && process.platform !== "freebsd") return undefined;
	return new Promise((resolve) => {
		execFile(
			"/bin/ps",
			["-o", "lstart=", "-p", String(pid)],
			{ encoding: "utf-8", maxBuffer: 64 * 1024, timeout: 2_000 },
			(error, stdout) => {
				if (error) return resolve(undefined);
				const identity = stdout.trim();
				resolve(identity ? `${process.platform}:${identity}` : undefined);
			},
		);
	});
}

export function probeProcessLiveness(pid: number, kill: ProcessKillFn = process.kill): boolean | undefined {
	try {
		kill(pid, 0);
		return true;
	} catch (error) {
		return runtimeErrorCode(error) === "ESRCH" ? false : undefined;
	}
}

/** Treat permission denial as evidence that the process exists. */
export function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return runtimeErrorCode(error) === "EPERM";
	}
}

export function identityBoundProcessLiveness(
	pid: number,
	expectedIdentity: string | undefined,
	liveness: boolean | undefined,
): boolean | undefined {
	if (liveness !== true) return liveness;
	if (!expectedIdentity) return undefined;
	const currentIdentity = readProcessStartIdentity(pid);
	return currentIdentity ? currentIdentity === expectedIdentity : undefined;
}

function parseLinuxProcessIdentity(stat: string): ProcessIdentityGroupSnapshot | undefined {
	const commandEnd = stat.lastIndexOf(")");
	if (commandEnd === -1) return undefined;
	const fields = stat
		.slice(commandEnd + 1)
		.trim()
		.split(/\s+/u);
	const processGroupId = Number(fields[2]);
	const startTicks = fields[19];
	if (!Number.isSafeInteger(processGroupId) || processGroupId <= 0 || !startTicks) return undefined;
	return { processStartIdentity: `linux:${startTicks}`, processGroupId };
}

function normalizedBootIdentity(platform: string, value: string): string | undefined {
	const normalized = value.trim().replace(/\s+/gu, " ");
	return normalized.length > 0 && normalized.length <= 512 ? `${platform}:${normalized}` : undefined;
}
