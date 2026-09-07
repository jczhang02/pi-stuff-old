import { writeFile } from "node:fs/promises";
import { armUiPtyOwnerWatchdog } from "../../scripts/ui-pty-owner-watchdog.js";

const [recordPathArgument, socketArgument, watchdogTmuxBinary] = Bun.argv.slice(2);
if (!recordPathArgument || !socketArgument) throw new Error("record path and tmux socket are required");
const recordPath = recordPathArgument;
const socket = socketArgument;

const watchdog = await armUiPtyOwnerWatchdog(socket, watchdogTmuxBinary ?? "tmux");
const started = Bun.spawnSync(
	[
		"tmux",
		"-S",
		socket,
		"-f",
		"/dev/null",
		"new-session",
		"-d",
		"-s",
		"orphan-test",
		"/bin/sh",
		"-c",
		"exec sleep 30",
	],
	{ stderr: "pipe", stdout: "pipe" },
);
if (started.exitCode !== 0) throw new Error(started.stderr.toString() || "tmux failed to start");

function tmuxValue(format: string): number {
	const result = Bun.spawnSync(["tmux", "-S", socket, "display-message", "-p", format], {
		stderr: "pipe",
		stdout: "pipe",
	});
	if (result.exitCode !== 0) throw new Error(result.stderr.toString() || `tmux could not read ${format}`);
	const value = Number(result.stdout.toString().trim());
	if (!Number.isSafeInteger(value) || value <= 1) throw new Error(`invalid tmux process id: ${String(value)}`);
	return value;
}

await writeFile(
	recordPath,
	`${JSON.stringify({
		ownerPid: process.pid,
		panePid: tmuxValue("#{pane_pid}"),
		serverPid: tmuxValue("#{pid}"),
		watchdogPid: watchdog.pid,
	})}\n`,
	{ mode: 0o600 },
);

setInterval(() => {}, 10_000);
